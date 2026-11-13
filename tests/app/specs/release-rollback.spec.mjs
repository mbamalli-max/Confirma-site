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
let mode = "candidate";
const rollbackRoot = process.env.ROLLBACK_APP_DIR ? resolve(process.env.ROLLBACK_APP_DIR) : null;

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
  const directory = await mkdtemp(join(tmpdir(), "confirma-rollback-v47-"));
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
  if (path !== "/app" && !path.startsWith("/app/")) return response.writeHead(404).end();
  const source = mode === "candidate" ? resolve(root, "app-v3") : mode === "rollback" ? rollbackRoot : oldRoot;
  const headers = mode === "candidate" ? { ...appHeaders } : {};
  if (path === "/app/sw.js") {
    if (mode === "candidate") headers["Service-Worker-Allowed"] = "/app";
    if (mode === "rollback") headers["Service-Worker-Allowed"] = "/app";
    headers["Cache-Control"] = "no-store";
  }
  return sendFile(response, source, appFile(path), headers);
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
      try { return context.getImageData(0, 0, canvas.width, canvas.height).data.some((value) => value !== 0); }
      catch { return false; }
    })).toBe(true);
  }).toPass({ timeout: 20_000 });
}

async function expectControlled(page) {
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 20_000 }).toBe(true);
}

async function visibleRecordCount(page) {
  await page.locator("#nav-settings-v2").click();
  await expect(page.locator("#screen-settings.active")).toBeVisible();
  const value = await page.locator("#settings-summary-v2 .settings-row").evaluateAll((rows) => {
    const row = rows.find((item) => item.querySelector("span")?.textContent?.trim() === "Confirmed records");
    return row?.querySelector("strong")?.textContent?.trim() || "";
  });
  return Number(value);
}

async function rollbackObservation(page) {
  return page.evaluate(async () => {
    const observe = async (work) => {
      try { return { value: await work(), error: null }; }
      catch (error) { return { value: null, error: { name: error?.name || "Error", message: error?.message || String(error) } }; }
    };
    const version = (text) => text.includes("cdnjs.cloudflare.com") ? "v47"
      : text.includes("vendor/chart.umd.js") ? "v48" : null;
    const navigation = performance.getEntriesByType("navigation")[0];
    const registrations = await navigator.serviceWorker.getRegistrations();
    const servedIndex = await observe(async () => {
      const response = await fetch(location.href);
      return { version: version(await response.text()), url: response.url };
    });
    const outerHtml = document.documentElement.outerHTML;
    const workerScript = await observe(async () => {
      const response = await fetch("/app/sw.js", { cache: "no-store" });
      const text = await response.text();
      return { cacheName: text.match(/konfirmata-cache-v\d+/)?.[0] || null, url: response.url };
    });
    return {
      servedIndex,
      outerHtml: { version: version(outerHtml) },
      navigation: { workerStart: navigation?.workerStart || 0, fromServiceWorker: Boolean(navigation?.workerStart > 0) },
      workerScript,
      registrations: registrations.map((registration) => ({ scope: registration.scope, activeScriptURL: registration.active?.scriptURL || null })),
      controller: navigator.serviceWorker.controller?.scriptURL || null,
      cacheNames: await caches.keys()
    };
  });
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

test("R1: rollback from v48 to v47 keeps the app and records", async ({ browser }) => {
  test.slow();
  mode = "candidate";
  const context = await browser.newContext({ baseURL: APP_URL });
  const primary = await context.newPage();
  let loads = 0;
  primary.on("load", () => { loads += 1; });
  const summary = {
    updateError: null,
    before: null,
    after: null,
    slashPage: null,
    slashPageUpdate: null,
    offline: null,
    chartsRender: { before: false, after: false, slashPage: false },
    v48CacheExists: { before: false, after: false, slashPage: false },
    offlineReopen: { loaded: false, error: null }
  };
  try {
    await createConfirmedRecord(primary, "rollback-v48");
    await waitForNavigationQuiet(primary);
    await expectControlled(primary);
    await expect.poll(() => primary.evaluate(() => caches.has("konfirmata-cache-v48")), { timeout: 20_000 }).toBe(true);
    await expectChart(primary);
    summary.chartsRender.before = true;
    summary.v48CacheExists.before = await primary.evaluate(() => caches.has("konfirmata-cache-v48"));
    const beforeState = await readLocalState(primary);
    const beforeConfirmed = beforeState.stores.records.filter((record) => record.confirmation_state === "confirmed");
    const beforeVisibleCount = await visibleRecordCount(primary);
    await primary.locator("#nav-dashboard-v2").click();
    await expect(primary.locator("#dashboard-records-v2 .record-card").first()).toBeVisible();
    const beforeRecordText = await primary.locator("#dashboard-records-v2").textContent();
    expect(beforeVisibleCount).toBe(beforeConfirmed.length);
    summary.before = await rollbackObservation(primary);

    mode = "old";
    summary.updateError = await primary.evaluate(async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration("/app");
        if (!registration) return { name: "MissingRegistration", message: "no /app registration" };
        await registration.update();
        return null;
      } catch (error) {
        return { name: error?.name || "Error", message: error?.message || String(error) };
      }
    });
    await primary.reload();
    await waitForNavigationQuiet(primary);
    expect(loads).toBeLessThanOrEqual(4);
    await expect(primary.locator("#screen-error.active")).toHaveCount(0);
    expect(await primary.locator(".screen.active").count()).toBeGreaterThan(0);
    await expect(primary.locator("#screen-capture.active, #screen-dashboard.active")).toHaveCount(1);
    await primary.locator("#nav-dashboard-v2").click();
    await expect(primary.locator("#screen-dashboard.active")).toBeVisible();
    await expect(primary.locator("#dashboard-records-v2")).toContainText(beforeRecordText?.trim() || "");
    const afterState = await readLocalState(primary);
    const afterConfirmed = afterState.stores.records.filter((record) => record.confirmation_state === "confirmed");
    expect(afterConfirmed.map((record) => record.id)).toEqual(beforeConfirmed.map((record) => record.id));
    expect(await visibleRecordCount(primary)).toBe(beforeVisibleCount);
    expect(afterState.settings.auth_token).toBe(beforeState.settings.auth_token);
    expect(afterState.settings.bound_account).toBe(beforeState.settings.bound_account);
    await primary.locator("#nav-dashboard-v2").click();
    await expectChart(primary);
    summary.chartsRender.after = true;
    summary.v48CacheExists.after = await primary.evaluate(() => caches.has("konfirmata-cache-v48"));
    summary.after = await rollbackObservation(primary);

    const slash = await context.newPage();
    await slash.goto("/app/");
    await waitForNavigationQuiet(slash);
    await expect(slash.locator("#screen-error.active")).toHaveCount(0);
    expect(await slash.locator(".screen.active").count()).toBeGreaterThan(0);
    await expect(slash.locator("#screen-capture.active, #screen-dashboard.active")).toHaveCount(1);
    summary.slashPageUpdate = await slash.evaluate(async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration("/app");
        if (!registration) return { name: "MissingRegistration", message: "no /app registration" };
        await registration.update();
        return null;
      } catch (error) {
        return { name: error?.name || "Error", message: error?.message || String(error) };
      }
    });
    await slash.locator("#nav-dashboard-v2").click();
    await expect(slash.locator("#screen-dashboard.active")).toBeVisible();
    await expect(slash.locator("#dashboard-records-v2")).toContainText(beforeRecordText?.trim() || "");
    expect(await visibleRecordCount(slash)).toBe(beforeVisibleCount);
    expect((await readLocalState(slash)).settings.auth_token).toBe(beforeState.settings.auth_token);
    await slash.locator("#nav-dashboard-v2").click();
    await expectChart(slash);
    summary.chartsRender.slashPage = true;
    summary.v48CacheExists.slashPage = await slash.evaluate(() => caches.has("konfirmata-cache-v48"));
    summary.slashPage = await rollbackObservation(slash);
    expect(loads).toBeLessThanOrEqual(4);

    await context.setOffline(true);
    const offline = await context.newPage();
    try {
      await offline.goto("/app/");
      await waitForNavigationQuiet(offline);
      summary.offlineReopen.loaded = await offline.locator("#screen-dashboard.active").isVisible();
      summary.offline = await rollbackObservation(offline);
    } catch (error) {
      summary.offlineReopen.error = error?.message || String(error);
    } finally {
      await offline.close();
      await context.setOffline(false);
    }
  } finally {
    console.log(JSON.stringify({ rollback: summary }));
    for (const [type, value] of Object.entries(summary)) test.info().annotations.push({ type: `rollback-${type}`, description: JSON.stringify(value) });
    await context.setOffline(false);
    await context.close();
  }
});

test("R2: roll-forward rollback from v48 takes control cleanly", async ({ browser }) => {
  test.slow();
  if (!rollbackRoot) throw new Error("R2 requires ROLLBACK_APP_DIR to be set to the absolute v49 app-v3 directory");
  mode = "candidate";
  const context = await browser.newContext({ baseURL: APP_URL });
  const primary = await context.newPage();
  let loads = 0;
  primary.on("load", () => { loads += 1; });
  const summary = {
    updateError: null,
    before: null,
    after: null,
    slashPage: null,
    offlineApp: null,
    offlineSlashPage: null,
    chartsRender: { before: false, after: false, slashPage: false, offlineApp: false, offlineSlashPage: false },
    buildProof: { before: null, after: null, slashPage: null, offlineApp: null, offlineSlashPage: null }
  };
  const readBuildProof = (page) => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/app");
    const cacheNames = await caches.keys();
    const cacheKeyPaths = await Promise.all(cacheNames.map(async (name) => {
      const cache = await caches.open(name);
      return (await cache.keys()).map((request) => new URL(request.url).pathname);
    }));
    const appScript = await fetch("/app/app.js");
    const html = document.documentElement.outerHTML;
    const navigation = performance.getEntriesByType("navigation")[0];
    return {
      controller: navigator.serviceWorker.controller?.scriptURL || null,
      active: registration?.active ? { scriptURL: registration.active.scriptURL, state: registration.active.state } : null,
      cacheNames,
      cacheKeyPaths: cacheKeyPaths.flat(),
      html: {
        hasRollbackMarker: html.includes("Keep the primary row simple: Sell, Buy, Pay, Receive."),
        hasV48Marker: html.includes("What kind of transaction is it?")
      },
      appScript: { hasV48Suggestion: (await appScript.text()).includes("TIME_ZONE_COUNTRY_SUGGESTIONS") },
      navigation: { workerStart: navigation?.workerStart || 0, fromServiceWorker: Boolean(navigation?.workerStart > 0) }
    };
  });
  const expectV49Control = async (page, { offline = false } = {}) => {
    await expect.poll(() => readBuildProof(page), { timeout: 30_000 }).toMatchObject({
      controller: `${new URL(APP_URL).origin}/app/sw.js`,
      active: { scriptURL: `${new URL(APP_URL).origin}/app/sw.js`, state: "activated" },
      cacheNames: ["konfirmata-cache-v49"],
      html: { hasRollbackMarker: true, hasV48Marker: false },
      appScript: { hasV48Suggestion: false }
    });
    const proof = await readBuildProof(page);
    expect(proof.controller).not.toBeNull();
    expect(proof.active).toEqual({ scriptURL: proof.controller, state: "activated" });
    expect(proof.cacheNames).toEqual(["konfirmata-cache-v49"]);
    expect(proof.cacheKeyPaths).not.toContain("/app/icons/icon-192.png");
    expect(proof.html).toEqual({ hasRollbackMarker: true, hasV48Marker: false });
    expect(proof.appScript).toEqual({ hasV48Suggestion: false });
    if (offline) {
      expect(proof.navigation.workerStart).toBeGreaterThan(0);
      expect(proof.navigation.fromServiceWorker).toBe(true);
    }
    return proof;
  };
  const expectV48Build = async (page) => {
    const proof = await readBuildProof(page);
    expect(proof.html).toEqual({ hasRollbackMarker: false, hasV48Marker: true });
    expect(proof.appScript).toEqual({ hasV48Suggestion: true });
    return proof;
  };
  const expectV49WorkerScript = async (page) => {
    await expect.poll(() => page.evaluate(async () => {
      const response = await fetch("/app/sw.js", { cache: "no-store" });
      const text = await response.text();
      return {
        servedVersion: text.match(/konfirmata-cache-v\d+/)?.[0] || null,
        controller: navigator.serviceWorker.controller?.scriptURL || null
      };
    }), { timeout: 30_000 }).toEqual({
      servedVersion: "konfirmata-cache-v49",
      controller: `${new URL(APP_URL).origin}/app/sw.js`
    });
  };
  const expectR2App = async (page, beforeState, beforeConfirmed, beforeVisibleCount, beforeRecordText) => {
    await expectControlled(page);
    await expect(page.locator("#screen-error.active")).toHaveCount(0);
    expect(await page.locator(".screen.active").count()).toBeGreaterThan(0);
    await page.locator("#nav-dashboard-v2").click();
    await expect(page.locator("#screen-dashboard.active")).toBeVisible();
    await expect(page.locator("#dashboard-records-v2")).toContainText(beforeRecordText?.trim() || "");
    const state = await readLocalState(page);
    expect(state.stores.records.filter((record) => record.confirmation_state === "confirmed").map((record) => record.id)).toEqual(beforeConfirmed.map((record) => record.id));
    expect(await visibleRecordCount(page)).toBe(beforeVisibleCount);
    expect(state.settings.auth_token).toBe(beforeState.settings.auth_token);
    expect(state.settings.bound_account).toBe(beforeState.settings.bound_account);
    await page.locator("#nav-dashboard-v2").click();
    await expectChart(page);
    expect(await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      return registrations.map((registration) => registration.scope);
    })).toEqual([`${new URL(APP_URL).origin}/app`]);
  };
  try {
    await createConfirmedRecord(primary, "rollback-v48-to-v49");
    await waitForNavigationQuiet(primary);
    await expectControlled(primary);
    await expect.poll(() => primary.evaluate(() => caches.has("konfirmata-cache-v48")), { timeout: 20_000 }).toBe(true);
    await expectChart(primary);
    summary.chartsRender.before = true;
    const beforeState = await readLocalState(primary);
    const beforeConfirmed = beforeState.stores.records.filter((record) => record.confirmation_state === "confirmed");
    const beforeVisibleCount = await visibleRecordCount(primary);
    await primary.locator("#nav-dashboard-v2").click();
    await expect(primary.locator("#dashboard-records-v2 .record-card").first()).toBeVisible();
    const beforeRecordText = await primary.locator("#dashboard-records-v2").textContent();
    expect(beforeVisibleCount).toBe(beforeConfirmed.length);
    summary.buildProof.before = await expectV48Build(primary);
    summary.before = await rollbackObservation(primary);

    mode = "rollback";
    summary.updateError = await primary.evaluate(async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration("/app");
        if (!registration) return { name: "MissingRegistration", message: "no /app registration" };
        await registration.update();
        return null;
      } catch (error) {
        return { name: error?.name || "Error", message: error?.message || String(error) };
      }
    });
    expect(summary.updateError).toBeNull();
    await expectV49WorkerScript(primary);
    await waitForNavigationQuiet(primary);
    await expectR2App(primary, beforeState, beforeConfirmed, beforeVisibleCount, beforeRecordText);
    summary.buildProof.after = await expectV49Control(primary);
    summary.chartsRender.after = true;
    summary.after = await rollbackObservation(primary);
    expect(loads).toBeLessThanOrEqual(4);
    const settledLoads = loads;
    await new Promise((done) => setTimeout(done, 5_000));
    expect(loads).toBe(settledLoads);

    const slash = await context.newPage();
    await slash.goto("/app/");
    await waitForNavigationQuiet(slash);
    await expectR2App(slash, beforeState, beforeConfirmed, beforeVisibleCount, beforeRecordText);
    summary.buildProof.slashPage = await expectV49Control(slash);
    summary.chartsRender.slashPage = true;
    summary.slashPage = await rollbackObservation(slash);

    await context.setOffline(true);
    const offlineApp = await context.newPage();
    try {
      await offlineApp.goto("/app");
      await waitForNavigationQuiet(offlineApp);
      await expectR2App(offlineApp, beforeState, beforeConfirmed, beforeVisibleCount, beforeRecordText);
      summary.buildProof.offlineApp = await expectV49Control(offlineApp, { offline: true });
      summary.chartsRender.offlineApp = true;
      summary.offlineApp = await rollbackObservation(offlineApp);
    } finally {
      await offlineApp.close();
    }
    const offlineSlash = await context.newPage();
    try {
      await offlineSlash.goto("/app/");
      await waitForNavigationQuiet(offlineSlash);
      await expectR2App(offlineSlash, beforeState, beforeConfirmed, beforeVisibleCount, beforeRecordText);
      summary.buildProof.offlineSlashPage = await expectV49Control(offlineSlash, { offline: true });
      summary.chartsRender.offlineSlashPage = true;
      summary.offlineSlashPage = await rollbackObservation(offlineSlash);
    } finally {
      await offlineSlash.close();
      await context.setOffline(false);
    }
  } finally {
    console.log(JSON.stringify({ rollback: summary }));
    for (const [type, value] of Object.entries(summary)) test.info().annotations.push({ type: `rollback-r2-${type}`, description: JSON.stringify(value) });
    await context.setOffline(false);
    await context.close();
  }
});
