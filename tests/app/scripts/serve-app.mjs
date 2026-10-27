import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalUrl } from "./local-only.mjs";

const url = assertLocalUrl("APP_TEST_URL", process.env.APP_TEST_URL || "http://127.0.0.1:5500");
const root = resolve(fileURLToPath(new URL("../../../app-v3/", import.meta.url)));
const adminRoot = resolve(fileURLToPath(new URL("../../../admin/", import.meta.url)));
const apiOrigin = new URL(process.env.APP_TEST_API_URL || "http://127.0.0.1:8787").origin;
// The admin page gets the headers from admin/vercel.json, with the API address
// pointed at the local test API, so the browser enforces the real policy in tests.
const adminHeaders = Object.fromEntries(
  JSON.parse(readFileSync(resolve(adminRoot, "vercel.json"), "utf8"))
    .headers.find((rule) => rule.source === "/(.*)").headers
    .map(({ key, value }) => [key, value.replace("https://api.konfirmata.com", apiOrigin)])
);
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain" };

createServer(async (request, response) => {
  const requestPath = new URL(request.url, url).pathname;
  if (requestPath === "/admin" || requestPath.startsWith("/admin/")) {
    const relative = requestPath.replace(/^\/admin\/?/, "") || "index.html";
    const path = resolve(adminRoot, relative);
    if (path !== adminRoot && !path.startsWith(`${adminRoot}${sep}`)) return response.writeHead(403).end();
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error("not a file");
      response.writeHead(200, { ...adminHeaders, "content-type": mime[extname(path)] || "text/plain" });
      return createReadStream(path).pipe(response);
    } catch {
      return response.writeHead(404, adminHeaders).end();
    }
  }
  const pathname = requestPath
    .replace(/^\/app(?:\/|$)/, "")
    .replace(/^\/+/, "") || "index.html";
  const path = resolve(root, pathname);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return response.writeHead(403).end();
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": mime[extname(path)] || "application/octet-stream" });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
}).listen(Number(url.port || 5500), url.hostname);
