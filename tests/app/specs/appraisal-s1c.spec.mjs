import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCaptureScreen, nextAccount, readLocalState, requestCode, signInThroughUi, verifyWithCode } from "./helpers.mjs";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const APP_URL = process.env.APP_TEST_OLD_APP_URL || "http://127.0.0.1:5501";
const apiOrigin = new URL(process.env.APP_TEST_API_URL || "http://127.0.0.1:8787").origin;
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const route = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8")).routes.find((item) => item.src === "/(.*)" && item.continue === true);
if (!route?.headers) throw new Error("missing continuing app header route");
const appHeaders = Object.fromEntries(Object.entries(route.headers).map(([key, value]) => [key, value.replace("https://api.konfirmata.com", apiOrigin)]));
let oldRoot, server;
const served = { mode: "candidate", omitWorkerHeader: false, cacheSuffix: "", holdWorker: null, workerRequestPending: false };

const appFile = (path) => path === "/app" || path === "/app/" ? "index.html" : path.replace(/^\/app\//, "");
const candidate = ({ suffix = "", omitWorkerHeader = false } = {}) => Object.assign(served, { mode: "candidate", cacheSuffix: suffix, omitWorkerHeader, holdWorker: null, workerRequestPending: false });
const old = () => Object.assign(served, { mode: "old", cacheSuffix: "", omitWorkerHeader: false, holdWorker: null, workerRequestPending: false });

function waitForNavigationQuiet(page, quietMs = 2_000) {
  return new Promise((resolve, reject) => {
    let quietTimer, timeoutTimer, settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer); clearTimeout(timeoutTimer);
      page.off("framenavigated", onFrameNavigated);
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      page.off("framenavigated", onFrameNavigated);
      reject(new Error(`main-frame navigation did not settle within 30 seconds`));
    };
    const startQuietPeriod = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(async () => {
        try {
          if (await page.evaluate(() => document.readyState) === "complete") finish();
          else startQuietPeriod();
        } catch {
          startQuietPeriod();
        }
      }, quietMs);
    };
    const onFrameNavigated = (frame) => {
      if (frame === page.mainFrame()) startQuietPeriod();
    };
    page.on("framenavigated", onFrameNavigated);
    timeoutTimer = setTimeout(fail, 30_000);
    startQuietPeriod();
  });
}

async function oldAppDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "confirma-s1c-v47-"));
  const archive = join(directory, "app-v3.tar");
  execFileSync("git", ["archive", "-o", archive, "origin/main", "app-v3"], { cwd: root });
  execFileSync("tar", ["-xf", archive, "-C", directory]);
  return join(directory, "app-v3");
}
async function sendFile(response, source, relative, headers = {}) {
  const file = resolve(source, relative);
  if (file !== source && !file.startsWith(`${source}${sep}`)) return response.writeHead(403, headers).end();
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    response.writeHead(200, { ...headers, "content-type": mime[extname(file)] || "application/octet-stream" });
    createReadStream(file).pipe(response);
  } catch { response.writeHead(404, headers).end(); }
}
async function serveApp(request, response) {
  const path = new URL(request.url, APP_URL).pathname;
  if (path === "/") return response.writeHead(302, { location: "/app" }).end();
  if (path === "/apple-touch-icon.png" || path === "/app-other.html") return response.writeHead(200, { "content-type": "text/html" }).end(`unrelated:${path}`);
  if (path !== "/app" && !path.startsWith("/app/")) return response.writeHead(404).end();
  const isCandidate = served.mode === "candidate";
  const headers = isCandidate ? { ...appHeaders } : {};
  if (isCandidate && path === "/app/sw.js") {
    if (!served.omitWorkerHeader) headers["Service-Worker-Allowed"] = "/app";
    headers["Cache-Control"] = "no-store";
    if (served.holdWorker) {
      served.workerRequestPending = true;
      try {
        await served.holdWorker;
      } finally {
        served.workerRequestPending = false;
      }
    }
    let worker = await readFile(resolve(root, "app-v3/sw.js"), "utf8");
    if (served.cacheSuffix) worker = worker.replace('"konfirmata-cache-v47"', `"konfirmata-cache-v47${served.cacheSuffix}"`);
    return response.writeHead(200, { ...headers, "content-type": "text/javascript" }).end(worker);
  }
  return sendFile(response, isCandidate ? resolve(root, "app-v3") : oldRoot, appFile(path), headers);
}
async function createConfirmedRecord(page, label) {
  await page.goto("/app");
  await waitForNavigationQuiet(page);
  await signInThroughUi(page, nextAccount(label));
  await ensureCaptureScreen(page, { timeout: 10_000 });
  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill("2500");
  await page.locator("#prepare-confirmation").click();
  await expect(page.locator("#screen-confirm.active")).toBeVisible();
  await page.locator("#confirm-append").click();
  await expect(page.locator("#screen-dashboard.active")).toBeVisible();
  expect((await readLocalState(page)).stores.records.some((record) => record.confirmation_state === "confirmed")).toBe(true);
}
async function expectChart(page) {
  await expect(async () => {
    if (!await page.locator("#screen-dashboard.active").isVisible()) await page.locator("#nav-dashboard-v2").click();
    await expect(page.locator("#screen-dashboard.active")).toBeVisible();
    await expect.poll(() => page.evaluate(() => typeof window.Chart)).toBe("function");
    await expect.poll(() => page.locator("#dashboard-chart").evaluate((canvas) => {
      const chart = window.Chart.getChart(canvas);
      if (!canvas.width || !canvas.height || !chart?.data?.datasets?.length) return false;
      const context = canvas.getContext("2d");
      if (!context) return false;
      try {
        return context.getImageData(0, 0, canvas.width, canvas.height).data.some((value) => value !== 0);
      } catch {
        return false;
      }
    })).toBe(true);
  }).toPass({ timeout: 20_000 });
}
async function expectControlled(page) {
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 20_000 }).toBe(true);
}
async function expectCache(page, name) {
  await expect.poll(() => page.evaluate((cacheName) => caches.has(cacheName), name), { timeout: 20_000 }).toBe(true);
}

test.beforeAll(async () => {
  oldRoot = await oldAppDirectory();
  const url = new URL(APP_URL);
  server = createServer(serveApp);
  await new Promise((done) => server.listen(Number(url.port), url.hostname, done));
});
test.afterAll(async () => {
  await new Promise((done) => server.close(done));
  await rm(resolve(oldRoot, ".."), { recursive: true, force: true });
});

test("S1c C0: a fresh /app visit is claimed without reloading typed onboarding input", async ({ browser }) => {
  candidate();
  const context = await browser.newContext({ baseURL: APP_URL });
  const page = await context.newPage();
  const account = nextAccount("s1c-fresh");
  let loads = 0;
  let releaseWorker;
  const workerReleased = new Promise((resolve) => { releaseWorker = resolve; });
  served.holdWorker = workerReleased;
  page.on("load", () => loads += 1);
  try {
    await page.goto("/app");
    await waitForNavigationQuiet(page);
    await expect.poll(() => served.workerRequestPending).toBe(true);
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistration("/app").then((registration) => Boolean(registration?.active)))).toBe(false);
    await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
    await page.locator("#operating-region-grid").getByRole("button", { name: /Nigeria/ }).click();
    await page.locator("#sector-grid").getByRole("button", { name: /Trade & Retail/ }).click();
    await page.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();
    await page.locator("#onboarding-next").click();
    await expect(page.locator("#onboarding-name")).toBeFocused();
    await page.locator("#onboarding-name").fill(account.name);
    await page.locator("#onboarding-phone").fill(account.phone);
    await page.locator("#onboarding-email").fill(account.email);
    releaseWorker();
    await expectControlled(page);
    await waitForNavigationQuiet(page);
    expect(loads).toBe(1);
    await new Promise((done) => setTimeout(done, 5_000));
    expect(loads).toBe(1);
    await expect(page.locator("#onboarding-name")).toHaveValue(account.name);
    await expect(page.locator("#onboarding-phone")).toHaveValue(account.phone);
    await expect(page.locator("#onboarding-email")).toHaveValue(account.email);
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${new URL(APP_URL).origin}/app/sw.js`);
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistration("/app").then((registration) => registration?.scope))).toBe(`${new URL(APP_URL).origin}/app`);

    await expect(page.locator("#finish-onboarding")).toBeEnabled();
    await page.locator("#finish-onboarding").click();
    await expect(page.locator("#screen-otp.active")).toBeVisible();
    const code = await requestCode(page);
    const verifyResponse = await verifyWithCode(page, code);
    expect(verifyResponse.status()).toBe(200);
    const responseBody = await verifyResponse.json();
    await expect(page.locator("#screen-capture.active")).toBeVisible();
    const local = await readLocalState(page);
    expect(local.settings.auth_token).toBe(responseBody.auth_token);
    expect(local.settings.bound_account).toBe(responseBody.account_id);
    expect(local.settings.local_origin).toBeUndefined();
  } finally { releaseWorker(); await context.close(); }
});

test("S1c C1-C4: /app is controlled, updates, reopens offline, and keeps CSP", async ({ browser }) => {
  test.slow(); candidate();
  const context = await browser.newContext({ baseURL: APP_URL });
  await context.addInitScript(() => {
    window.__s1cCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => window.__s1cCspViolations.push(event.blockedURI));
  });
  const page = await context.newPage(), requests = [];
  const responses = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", (response) => responses.push(response));
  try {
    await createConfirmedRecord(page, "s1c-current"); await waitForNavigationQuiet(page); await expectChart(page); await expectControlled(page);
    expect(responses.find((response) => new URL(response.url()).pathname === "/app")?.headers()["content-security-policy"]).toContain("script-src 'self'");
    expect(requests.some((url) => url.includes("cdnjs.cloudflare.com"))).toBe(false);
    expect(await page.evaluate(() => window.__s1cCspViolations)).toEqual([]);
    candidate({ suffix: "-s1c-test" });
    await page.evaluate(() => navigator.serviceWorker.getRegistration("/app").then((registration) => registration.update()));
    await waitForNavigationQuiet(page); await expectCache(page, "konfirmata-cache-v47-s1c-test"); await page.reload(); await waitForNavigationQuiet(page); await expectChart(page); await expectControlled(page);
    expect(await page.evaluate(() => caches.open("konfirmata-cache-v47-s1c-test").then((cache) => cache.match("/app/vendor/chart.umd.js").then(Boolean)))).toBe(true);
    await context.setOffline(true);
    for (const path of ["/app", "/app/"]) { const offline = await context.newPage(); await offline.goto(path); await waitForNavigationQuiet(offline); await expectChart(offline); await offline.close(); }
    await context.setOffline(false);
    await page.evaluate(() => { const script = document.createElement("script"); script.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"; document.head.append(script); });
    await expect.poll(() => page.evaluate(() => window.__s1cCspViolations.length)).toBeGreaterThan(0);
  } finally { await context.setOffline(false); await context.close(); }
});

test("S1c C5: an existing /app/ install upgrades once to the /app worker", async ({ browser }) => {
  test.slow(); old();
  const context = await browser.newContext({ baseURL: APP_URL }), legacy = await context.newPage();
  let loads = 0; legacy.on("load", () => loads += 1);
  const cdnRequests = []; legacy.on("request", (request) => { if (request.url().includes("cdnjs.cloudflare.com")) cdnRequests.push(request.url()); });
  try {
    await createConfirmedRecord(legacy, "s1c-v47"); await legacy.goto("/app/"); await waitForNavigationQuiet(legacy); await expectChart(legacy); await expectControlled(legacy); await expectCache(legacy, "konfirmata-cache-v47");
    expect(await legacy.evaluate(() => caches.open("konfirmata-cache-v47").then((cache) => cache.match("/app/index.html").then(async (response) => (await response.text()).includes("cdnjs.cloudflare.com"))))).toBe(true);
    const loadsBeforeUpgrade = loads;
    candidate({ suffix: "-s1c-upgrade" });
    const current = await context.newPage(); await current.goto("/app"); await Promise.all([waitForNavigationQuiet(legacy), waitForNavigationQuiet(current)]); await expectChart(current); await expectCache(current, "konfirmata-cache-v47-s1c-upgrade");
    await expect.poll(() => legacy.evaluate(async () => {
      const controller = navigator.serviceWorker.controller;
      const registrations = await navigator.serviceWorker.getRegistrations();
      return Boolean(controller && registrations.length === 1 && registrations[0].scope === `${location.origin}/app` && registrations[0].active?.scriptURL === controller.scriptURL);
    }), { timeout: 20_000 }).toBe(true);
    await waitForNavigationQuiet(legacy); await expectChart(legacy); expect(loads - loadsBeforeUpgrade).toBeLessThanOrEqual(2);
    const settledLoads = loads; await new Promise((done) => setTimeout(done, 10_000)); expect(loads).toBe(settledLoads);
    expect(await current.evaluate(() => navigator.serviceWorker.getRegistrations().then((all) => all.map((item) => item.scope)))).toEqual([`${new URL(APP_URL).origin}/app`]);
    for (const page of [current, legacy]) await expectControlled(page);
    expect(await current.evaluate(() => caches.has("konfirmata-cache-v47-s1c-upgrade"))).toBe(true);
    expect(await current.evaluate(() => caches.open("konfirmata-cache-v47-s1c-upgrade").then((cache) => cache.match("/app/vendor/chart.umd.js").then(Boolean)))).toBe(true);
    expect(await current.evaluate(() => caches.has("konfirmata-cache-v47"))).toBe(false);
    test.info().annotations.push({ type: "c5-old-cdn-requests", description: String(cdnRequests.length) });
    await context.setOffline(true);
    for (const path of ["/app", "/app/"]) { const offline = await context.newPage(); await offline.goto(path); await waitForNavigationQuiet(offline); await expectChart(offline); await offline.close(); }
    await context.setOffline(false);
  } finally { await context.setOffline(false); await context.close(); }
});

test("S1c C6: missing Service-Worker-Allowed explicitly falls back to /app/", async ({ browser }) => {
  candidate({ omitWorkerHeader: true });
  const context = await browser.newContext({ baseURL: APP_URL });
  await context.addInitScript(() => {
    window.__s1cRegistrations = [];
    const original = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = async (...args) => {
      try { const registration = await original(...args); window.__s1cRegistrations.push({ args, outcome: "fulfilled", scope: registration.scope }); return registration; }
      catch (error) { window.__s1cRegistrations.push({ args, outcome: "rejected" }); throw error; }
    };
  });
  const page = await context.newPage();
  try {
    await createConfirmedRecord(page, "s1c-no-header"); await page.goto("/app/"); await waitForNavigationQuiet(page); await expectChart(page);
    await expect.poll(() => page.evaluate(() => window.__s1cRegistrations.length)).toBeGreaterThanOrEqual(2);
    const calls = await page.evaluate(() => window.__s1cRegistrations);
    expect(calls[0]).toMatchObject({ args: ["/app/sw.js", { scope: "/app" }], outcome: "rejected" });
    expect(calls[1]).toMatchObject({ args: ["/app/sw.js"], outcome: "fulfilled", scope: `${new URL(APP_URL).origin}/app/` });
  } finally { await context.close(); }
});

test("S1c C7: unrelated prefix routes are neither activated nor served by the app cache", async ({ browser }) => {
  candidate();
  const context = await browser.newContext({ baseURL: APP_URL });
  const unrelated = [];
  for (const path of ["/apple-touch-icon.png", "/app-other.html"]) {
    const page = await context.newPage(); let loads = 0; page.on("load", () => loads += 1);
    await page.addInitScript(() => { window.__s1cMessages = []; navigator.serviceWorker.addEventListener("message", (event) => window.__s1cMessages.push(event.data)); });
    await page.goto(path); unrelated.push({ page, path, loads: () => loads });
  }
  const app = await context.newPage();
  try {
    await createConfirmedRecord(app, "s1c-unrelated"); await expectControlled(app);
    for (const item of unrelated) {
      expect(item.loads()).toBe(1); expect(await item.page.textContent("body")).toBe(`unrelated:${item.path}`);
      expect(await item.page.evaluate(() => window.__s1cMessages)).not.toContainEqual({ type: "SW_UPDATED" });
      const response = await item.page.goto(item.path); expect(response.fromServiceWorker()).toBe(false);
    }
    expect(await app.evaluate(() => caches.open("konfirmata-cache-v47").then((cache) => cache.match("/app/index.html").then((response) => response.text())))).toContain("Konfirmata");
  } finally { await context.close(); }
});
