import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCaptureScreen, nextAccount, readLocalState, signInThroughUi } from "./helpers.mjs";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const APP_URL = process.env.APP_TEST_OLD_APP_URL || "http://127.0.0.1:5501";
const apiOrigin = new URL(process.env.APP_TEST_API_URL || "http://127.0.0.1:8787").origin;
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const route = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8")).routes.find((item) => item.src === "/(.*)" && item.continue === true);
if (!route?.headers) throw new Error("missing continuing app header route");
const appHeaders = Object.fromEntries(Object.entries(route.headers).map(([key, value]) => [key, value.replace("https://api.konfirmata.com", apiOrigin)]));
let oldRoot, server;
let mode = "old";

const appFile = (path) => path === "/app" || path === "/app/" ? "index.html" : path.replace(/^\/app\//, "");

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
      reject(new Error("main-frame navigation did not settle within 30 seconds"));
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
  const directory = await mkdtemp(join(tmpdir(), "confirma-upgrade-v48-"));
  const archive = join(directory, "app-v3.tar");
  execFileSync("git", ["archive", "-o", archive, "218deea56445919fc5e1020f5f29ac31b6bf8ffe", "app-v3"], { cwd: root });
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
  if (path !== "/app" && !path.startsWith("/app/")) return response.writeHead(404).end();
  const headers = { ...appHeaders };
  if (path === "/app/sw.js") {
    headers["Service-Worker-Allowed"] = "/app";
    headers["Cache-Control"] = "no-store";
  }
  return sendFile(response, mode === "old" ? oldRoot : resolve(root, "app-v3"), appFile(path), headers);
}

async function createConfirmedRecord(page, label) {
  await page.goto("/app");
  await waitForNavigationQuiet(page);
  await signInThroughUi(page, nextAccount(label));
  await appendConfirmedRecord(page);
}

async function appendConfirmedRecord(page) {
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
      try { return context.getImageData(0, 0, canvas.width, canvas.height).data.some((value) => value !== 0); }
      catch { return false; }
    })).toBe(true);
  }).toPass({ timeout: 20_000 });
}

async function serviceWorkerState(page) {
  return page.evaluate(async () => ({
    cacheNames: await caches.keys(),
    controller: navigator.serviceWorker.controller?.scriptURL || null
  }));
}

async function updateToCandidate(page) {
  mode = "candidate";
  await expect(async () => {
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/app");
      await registration?.update();
    });
    await page.reload();
    await waitForNavigationQuiet(page);
    await expect.poll(() => serviceWorkerState(page), { timeout: 20_000 }).toEqual({
      cacheNames: ["konfirmata-cache-v49"],
      controller: `${new URL(APP_URL).origin}/app/sw.js`
    });
  }).toPass({ timeout: 45_000 });
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

test("U1: a v48 install upgrades to v49 without losing session, records or offline", async ({ browser }) => {
  test.slow();
  mode = "old";
  const context = await browser.newContext({ baseURL: APP_URL });
  const page = await context.newPage();
  const summary = { cacheNames: { before: null, after: null, offline: null }, controllerScript: { before: null, after: null }, records: { before: 0, after: 0, offline: 0, afterSync: 0 }, offline: false };
  try {
    await createConfirmedRecord(page, "upgrade-v48-v49");
    await expect.poll(() => serviceWorkerState(page), { timeout: 20_000 }).toEqual({
      cacheNames: ["konfirmata-cache-v48"],
      controller: `${new URL(APP_URL).origin}/app/sw.js`
    });
    await expectChart(page);
    const beforeState = await readLocalState(page);
    const beforeIds = beforeState.stores.records.filter((record) => record.confirmation_state === "confirmed").map((record) => record.id);
    expect(beforeIds.length).toBeGreaterThan(0);
    const beforeWorker = await serviceWorkerState(page);
    summary.cacheNames.before = beforeWorker.cacheNames;
    summary.controllerScript.before = beforeWorker.controller;
    summary.records.before = beforeIds.length;

    await updateToCandidate(page);
    await expect(page.locator("#screen-onboarding.active, #screen-otp.active")).toHaveCount(0);
    await ensureCaptureScreen(page, { timeout: 10_000 });
    const afterState = await readLocalState(page);
    const afterIds = afterState.stores.records.filter((record) => record.confirmation_state === "confirmed").map((record) => record.id);
    expect(afterIds).toEqual(beforeIds);
    await expectChart(page);
    await page.locator("#nav-settings-v2").click();
    await expect(page.locator("#settings-change-phone")).toBeVisible();
    const afterWorker = await serviceWorkerState(page);
    summary.cacheNames.after = afterWorker.cacheNames;
    summary.controllerScript.after = afterWorker.controller;
    summary.records.after = afterIds.length;

    await context.setOffline(true);
    await page.reload();
    await waitForNavigationQuiet(page);
    await ensureCaptureScreen(page, { timeout: 10_000 });
    const offlineState = await readLocalState(page);
    const offlineIds = offlineState.stores.records.filter((record) => record.confirmation_state === "confirmed").map((record) => record.id);
    expect(offlineIds).toEqual(beforeIds);
    await expectChart(page);
    const offlineWorker = await serviceWorkerState(page);
    expect(offlineWorker.cacheNames).toEqual(["konfirmata-cache-v49"]);
    expect(offlineWorker.controller).toBe(`${new URL(APP_URL).origin}/app/sw.js`);
    summary.cacheNames.offline = offlineWorker.cacheNames;
    summary.records.offline = offlineIds.length;
    summary.offline = true;
    await context.setOffline(false);

    await appendConfirmedRecord(page);
    await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length, {
      message: "the record confirmed after upgrade is synced without further user action",
      timeout: 15_000
    }).toBe(0);
    summary.records.afterSync = (await readLocalState(page)).stores.records.filter((record) => record.confirmation_state === "confirmed").length;
  } finally {
    test.info().annotations.push({ type: "upgrade-v48-v49", description: JSON.stringify(summary) });
    await context.setOffline(false);
    await context.close();
  }
});
