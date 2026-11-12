import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const expectedHeaders = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://api.konfirmata.com; media-src 'self' blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"
};
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const config = JSON.parse(read("vercel.json"));
const baselineRoutes = JSON.parse(read("tests/app/fixtures/vercel-routes-baseline.json"));
check(!Object.hasOwn(config, "headers"), "vercel.json must not retain top-level headers");
check(Array.isArray(config.routes), "vercel.json must contain routes");
const [policyRoute, swRoute, ...remainingRoutes] = config.routes || [];
check(policyRoute?.src === "/(.*)" && policyRoute?.continue === true, "first route must be the continuing policy route");
check(JSON.stringify(policyRoute?.headers) === JSON.stringify(expectedHeaders), "policy route headers differ from the approved values");
check(swRoute?.src === "/app/sw\\.js" && swRoute?.continue === true, "second route must continue the service worker request");
check(JSON.stringify(swRoute?.headers) === JSON.stringify({ "Service-Worker-Allowed": "/app" }), "service worker route headers differ");
check(JSON.stringify(remainingRoutes) === JSON.stringify(baselineRoutes), "non-header routes differ from origin/main baseline");
check(!expectedHeaders["Content-Security-Policy"].includes("cdnjs"), "CSP must not permit cdnjs");

const index = read("app-v3/index.html");
const sw = read("app-v3/sw.js");
check(!index.includes("cdnjs"), "index.html still references cdnjs");
check(/<script src="vendor\/chart\.umd\.js" integrity="(sha384-[^"]+)"?><\/script>/.test(index), "index.html must load the vendored Chart.js with integrity");
check(sw.includes('"/app/vendor/chart.umd.js"'), "service worker must precache Chart.js");
const sri = index.match(/vendor\/chart\.umd\.js" integrity="(sha384-[^"]+)"/u)?.[1];
const actualSri = `sha384-${createHash("sha384").update(readFileSync(resolve(root, "app-v3/vendor/chart.umd.js"))).digest("base64")}`;
check(sri === actualSri, "vendored Chart.js sha384 does not match index.html SRI");

if (failures.length) {
  console.error(`Vercel configuration check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("Vercel configuration check passed.");
