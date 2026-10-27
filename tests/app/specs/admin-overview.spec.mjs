import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { API_BASE, routeAdminConfig, seedOwner, totpToken, withDb } from "./admin-helpers.mjs";

const ADMIN_DIR = fileURLToPath(new URL("../../../admin/", import.meta.url));
const ROOT_VERCEL = fileURLToPath(new URL("../../../vercel.json", import.meta.url));
const APP_URL = process.env.APP_TEST_URL || "http://127.0.0.1:5500";
const PAGE = "/admin/index.html";

// The admin login route allows 5 attempts per 15 minutes per address, so the
// tests share one signed-in page and sign in only three times in total.
test.describe.configure({ mode: "serial" });

const ALLOWED_API = new Set([
  "POST /admin/auth/login",
  "POST /admin/auth/logout",
  "GET /admin/auth/me",
  "GET /admin/metrics/overview",
  "GET /admin/classification/summary"
]);
const SESSION_ENDED = "Your session has ended. Sign in again.";
const NOT_ALLOWED_WORDS = [/transaction/i, /activated/i, /verifications?/i];

let owner;
let context;
let page;
const requests = [];

async function openPage(target) {
  await routeAdminConfig(target);
  target.on("request", (request) => requests.push({ method: request.method(), url: request.url() }));
  await target.goto(PAGE);
}

async function signIn(target) {
  await target.fill("#signin-email", owner.email);
  await target.fill("#signin-password", owner.password);
  await target.fill("#signin-totp", totpToken(owner.totpSecret));
  const overview = target.waitForResponse((r) => r.url().includes("/admin/metrics/overview"));
  const summary = target.waitForResponse((r) => r.url().includes("/admin/classification/summary"));
  await target.click("#signin-submit");
  await expect(target.locator("#overview-screen")).toBeVisible();
  return { overview: await (await overview).json(), summary: await (await summary).json() };
}

async function chooseRange(target, value) {
  const response = target.waitForResponse((r) => r.url().includes(`/admin/metrics/overview?range=${value}`));
  await target.selectOption("#range-select", value);
  return (await response).json();
}

async function tilesMatch(target, body) {
  await expect(target.locator("article.metric-tile")).toHaveCount(body.metrics.length);
  for (const metric of body.metrics) {
    const tile = target.locator(`article.metric-tile[data-metric-key="${metric.key}"]`);
    await expect(tile.locator(".metric-name")).toHaveText(metric.name);
    await expect(tile.locator(".metric-definition")).toHaveText(metric.definition);
    await expect(tile.locator("th")).toHaveText(["External", "Internal / demo", "Unclassified", "Total"]);
    for (const col of ["external", "internal_demo", "unclassified", "total"]) {
      await expect(tile.locator(`td[data-col="${col}"]`), `${metric.key} ${col}`).toHaveText(String(metric[col]));
    }
  }
}

const CORS = { "access-control-allow-origin": APP_URL, "content-type": "application/json" };

test.beforeAll(async ({ browser }) => {
  owner = await seedOwner();
  // Two unclassified accounts so the provisional count is never zero by accident.
  await withDb((db) => db.query(
    `INSERT INTO users (phone_number, email)
     SELECT '+1555010' || lpad(g::text, 4, '0') || floor(random() * 1000)::int, 'admin-overview-' || g || '-' || md5(random()::text) || '@example.test'
     FROM generate_series(1, 2) g`
  ));
  context = await browser.newContext({ baseURL: APP_URL });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("1. sign-in needs all three fields; a wrong code gives one generic error and no figures", async () => {
  await openPage(page);
  await expect(page.locator("#signin-email")).toHaveAttribute("autocomplete", "username");
  await expect(page.locator("#signin-password")).toHaveAttribute("autocomplete", "current-password");
  await expect(page.locator("#signin-totp")).toHaveAttribute("autocomplete", "one-time-code");
  await expect(page.locator("#signin-totp")).toHaveAttribute("inputmode", "numeric");

  const loginsBefore = requests.filter((r) => r.url.includes("/admin/auth/login")).length;
  await page.fill("#signin-email", owner.email);
  await page.fill("#signin-password", owner.password);
  await page.click("#signin-submit");
  await expect(page.locator("#signin-error")).not.toHaveText("");
  expect(requests.filter((r) => r.url.includes("/admin/auth/login")).length, "no login without a code").toBe(loginsBefore);

  const good = totpToken(owner.totpSecret);
  const wrong = String((Number(good) + 500_000) % 1_000_000).padStart(6, "0");
  await page.fill("#signin-totp", wrong);
  const response = page.waitForResponse((r) => r.url().includes("/admin/auth/login"));
  await page.click("#signin-submit");
  expect((await response).status()).toBe(401);
  await expect(page.locator("#signin-error")).toHaveText("Sign-in failed. Check your details and try again.");
  await expect(page.locator("#signin-error")).toHaveAttribute("role", "alert");
  await expect(page.locator("#overview-screen")).toBeHidden();
  await expect(page.locator("article.metric-tile")).toHaveCount(0);
});

let firstReading;

test("2. after sign-in nothing is kept in browser storage", async () => {
  firstReading = await signIn(page);
  await expect(page.locator("#admin-email")).toHaveText(owner.email);
  await expect(page.locator("#session-expiry")).not.toHaveText("");
  const stored = await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    indexedDb: indexedDB.databases ? (await indexedDB.databases()).length : 0,
    cookie: document.cookie
  }));
  expect(stored).toEqual({ local: 0, session: 0, indexedDb: 0, cookie: "" });
  expect(await context.cookies()).toEqual([]);
});

test("3. every metric renders with its API name, definition and four columns", async () => {
  const body = firstReading.overview;
  expect(body.range).toBe("30d");
  expect(body.metrics.length).toBeGreaterThan(0);
  await tilesMatch(page, body);
  await expect(page.locator("#operator-label")).toHaveText("Operator view — owner only. Not for sharing or export.");
  await expect(page.locator("#footer-note")).toHaveText("Operator-generated internal metrics. Aggregate counts only. Not a user-record attestation.");
  await expect(page.locator("#activation-note")).toContainText("cannot be computed by the server");
});

test("4. changing the range re-fetches; point-in-time tiles say the range does not apply", async () => {
  for (const [value, label] of [["90d", "Last 90 days"], ["12m", "Last 12 months"], ["all", "All time"], ["30d", "Last 30 days"]]) {
    const body = await chooseRange(page, value);
    expect(body.range).toBe(value);
    await tilesMatch(page, body);
    for (const metric of body.metrics) {
      const scope = page.locator(`article.metric-tile[data-metric-key="${metric.key}"] .metric-scope`);
      await expect(scope).toHaveText(metric.point_in_time ? "Point-in-time — the range does not apply" : label);
    }
  }
});

test("5. the provisional banner shows the exact unclassified count", async () => {
  const unclassified = firstReading.summary.accounts.unclassified;
  expect(unclassified, "the shared test database holds unclassified accounts").toBeGreaterThan(0);
  await expect(page.locator("#provisional-banner")).toHaveText(
    `PROVISIONAL — ${unclassified} ${unclassified === 1 ? "account" : "accounts"} unclassified`
  );
});

test("6. a 503 shows the unavailable message with no tiles and no zeros", async () => {
  await page.route(`${API_BASE}/admin/metrics/overview?range=90d`, (route) => route.fulfill({
    status: 503,
    headers: CORS,
    body: JSON.stringify({ error: "metrics_unavailable", provisional: true, as_of: null, stale: true })
  }));
  await page.selectOption("#range-select", "90d");
  await expect(page.locator("#metrics-unavailable")).toBeVisible();
  await expect(page.locator("article.metric-tile")).toHaveCount(0);
  await expect(page.locator("#metric-grid")).not.toContainText("0");
  await page.unroute(`${API_BASE}/admin/metrics/overview?range=90d`);
  await chooseRange(page, "30d");
  await expect(page.locator("#metrics-unavailable")).toBeHidden();
});

test("7. the as-of time and the stale flag are shown", async () => {
  const asOf = "2026-10-27T03:00:00.000Z";
  await page.route(`${API_BASE}/admin/metrics/overview?range=12m`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, stale: true, as_of: asOf }) });
  });
  await page.selectOption("#range-select", "12m");
  await expect(page.locator("#as-of")).toHaveText("2026-10-27 03:00 UTC");
  await expect(page.locator("#stale-note")).toBeVisible();
  await page.unroute(`${API_BASE}/admin/metrics/overview?range=12m`);
  const fresh = await chooseRange(page, "30d");
  await expect(page.locator("#as-of")).toHaveText(`${fresh.as_of.slice(0, 10)} ${fresh.as_of.slice(11, 16)} UTC`);
  await expect(page.locator("#stale-note")).toBeVisible({ visible: Boolean(fresh.stale) });
});

test("8. a revoked session returns to sign-in and removes every figure", async () => {
  await withDb((db) => db.query(
    "UPDATE admin_sessions SET revoked_at = NOW() WHERE admin_user_id = $1 AND revoked_at IS NULL",
    [owner.id]
  ));
  await page.selectOption("#range-select", "all");
  await expect(page.locator("#signin-screen")).toBeVisible();
  await expect(page.locator("#signin-error")).toHaveText(SESSION_ENDED);
  await expect(page.locator("#overview-screen")).toBeHidden();
  await expect(page.locator("article.metric-tile")).toHaveCount(0);
  await expect(page.locator("#admin-email")).toHaveText("");
  await expect(page.locator("#provisional-banner")).toBeHidden();
});

test("8b. with every account classified the provisional banner is hidden", async () => {
  const inserted = await withDb(async (db) => {
    const result = await db.query(
      `INSERT INTO account_classification (user_id, classification, reason_code, classified_by)
       SELECT id, 'INTERNAL_TEST', 'OPERATOR_TEST_ACCOUNT', $1 FROM users
       WHERE id NOT IN (SELECT user_id FROM account_classification)
       RETURNING user_id`,
      [owner.id]
    );
    return result.rows.map((row) => row.user_id);
  });
  try {
    const reading = await signIn(page);
    expect(reading.summary.accounts.unclassified).toBe(0);
    await expect(page.locator("#provisional-banner")).toBeHidden();
    await expect(page.locator("article.metric-tile").first()).toBeVisible();
  } finally {
    await withDb((db) => db.query("DELETE FROM account_classification WHERE user_id = ANY($1::uuid[])", [inserted]));
  }
});

test("9. sign out calls logout, removes the figures, and a reload shows only sign-in", async () => {
  await expect(page.locator("article.metric-tile").first()).toBeVisible();
  const logout = page.waitForRequest((r) => r.url().includes("/admin/auth/logout") && r.method() === "POST");
  await page.click("#signout-button");
  expect((await logout).headers().authorization).toMatch(/^Bearer /);
  await expect(page.locator("#signin-screen")).toBeVisible();
  await expect(page.locator("article.metric-tile")).toHaveCount(0);
  await expect(page.locator("#admin-email")).toHaveText("");

  const revoked = await withDb((db) => db.query(
    "SELECT COUNT(*)::int AS open FROM admin_sessions WHERE admin_user_id = $1 AND revoked_at IS NULL",
    [owner.id]
  ));
  expect(revoked.rows[0].open, "logout revoked the server session").toBe(0);

  await page.reload();
  await expect(page.locator("#signin-screen")).toBeVisible();
  await expect(page.locator("#overview-screen")).toBeHidden();
  await expect(page.locator("article.metric-tile")).toHaveCount(0);
});

test("10. the page makes no request outside the allow-list", async () => {
  expect(requests.length).toBeGreaterThan(0);
  for (const { method, url } of requests) {
    const parsed = new URL(url);
    if (parsed.origin === APP_URL) {
      expect(parsed.pathname, `same-origin ${url}`).toMatch(/^\/admin\/(index\.html|admin\.js|admin\.css|config\.js|favicon\.ico)?$/);
      continue;
    }
    expect(parsed.origin, `origin of ${url}`).toBe(API_BASE);
    expect(ALLOWED_API.has(`${method} ${parsed.pathname}`), `${method} ${parsed.pathname}`).toBe(true);
  }
});

test("11. no disallowed wording in the admin files", async () => {
  for (const name of await readdir(ADMIN_DIR)) {
    if (!/\.(html|js|mjs|css|json|txt)$/.test(name)) continue;
    const text = await readFile(ADMIN_DIR + name, "utf8");
    for (const word of NOT_ALLOWED_WORDS) expect(text, `${name} contains ${word}`).not.toMatch(word);
  }
});

test("1b. a rate-limited sign-in says to wait", async ({ browser }) => {
  const other = await browser.newContext({ baseURL: APP_URL });
  const target = await other.newPage();
  try {
    await routeAdminConfig(target);
    await target.route(`${API_BASE}/admin/auth/login`, (route) => route.fulfill({
      status: 429, headers: CORS, body: JSON.stringify({ error: "Too Many Requests" })
    }));
    await target.goto(PAGE);
    await target.fill("#signin-email", "owner@example.test");
    await target.fill("#signin-password", "x");
    await target.fill("#signin-totp", "123456");
    await target.click("#signin-submit");
    await expect(target.locator("#signin-error")).toHaveText("Too many sign-in attempts. Wait 15 minutes, then try again.");
    await expect(target.locator("#overview-screen")).toBeHidden();
  } finally {
    await other.close();
  }
});

// Tests 14–17 use a separate browser with served API responses, so they spend no real sign-ins.
function sampleOverview(range, name = "Accounts registered") {
  return {
    range, provisional: true, as_of: "2026-10-27T04:00:00.000Z", stale: false,
    metrics: [{ key: "accounts_registered", name, definition: "Accounts created in the period.",
      point_in_time: false, range_ignored: false, external: 1, internal_demo: 2, unclassified: 3, total: 6 }]
  };
}

async function servedPage(browser, handle) {
  const ctx = await browser.newContext({ baseURL: APP_URL });
  const target = await ctx.newPage();
  await routeAdminConfig(target);
  let logins = 0;
  await target.route(`${API_BASE}/admin/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const bearer = (request.headers().authorization || "").replace(/^Bearer /, "");
    // Both resolve to true so the caller knows the request has been answered.
    const send = (status, body) => route.fulfill({ status, headers: CORS, body: JSON.stringify(body) }).then(() => true);
    const abort = () => route.abort().then(() => true);
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST" } });
    }
    if (url.pathname === "/admin/auth/login") {
      logins += 1;
      return send(200, { token: `token-${logins}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (await handle({ url, bearer, send, abort })) return;
    if (url.pathname === "/admin/auth/me") return send(200, { email: "owner@example.test", role: "owner" });
    if (url.pathname === "/admin/auth/logout") return send(200, { ok: true });
    if (url.pathname === "/admin/classification/summary") return send(200, { accounts: { external: 1, internal_demo: 2, unclassified: 3, total: 6 } });
    if (url.pathname === "/admin/metrics/overview") return send(200, sampleOverview(url.searchParams.get("range")));
    return send(404, {});
  });
  await target.goto(PAGE);
  return { ctx, target };
}

async function servedSignIn(target, { expectOverview = true } = {}) {
  await target.fill("#signin-email", "owner@example.test");
  await target.fill("#signin-password", "x");
  await target.fill("#signin-totp", "123456");
  await target.click("#signin-submit");
  if (expectOverview) await expect(target.locator("#overview-screen")).toBeVisible();
}

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

test("14. a late response for an ended session changes nothing in the new session", async ({ browser }) => {
  const release = gate();
  const { ctx, target } = await servedPage(browser, async ({ url, bearer, send }) => {
    if (bearer !== "token-1") return undefined;
    if (url.pathname === "/admin/classification/summary") { await release.promise; return send(401, { error: "unauthorized" }); }
    if (url.pathname === "/admin/metrics/overview") { await release.promise; return send(200, sampleOverview("30d", "OLD SESSION FIGURE")); }
    return undefined;
  });
  try {
    await servedSignIn(target);
    await target.click("#signout-button");
    await expect(target.locator("#signin-screen")).toBeVisible();
    await servedSignIn(target);
    await expect(target.locator("article.metric-tile .metric-name")).toHaveText(["Accounts registered"]);
    const late = Promise.all([
      target.waitForResponse((r) => r.url().includes("/classification/summary") && r.status() === 401),
      target.waitForResponse((r) => r.url().includes("/metrics/overview") && r.request().headers().authorization === "Bearer token-1")
    ]);
    release.open();
    await late;
    await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(target.locator("#overview-screen")).toBeVisible();
    await expect(target.locator("#signin-screen")).toBeHidden();
    await expect(target.locator("article.metric-tile .metric-name")).toHaveText(["Accounts registered"]);
    await expect(target.locator("#provisional-banner")).toHaveText("PROVISIONAL — 3 accounts unclassified");
  } finally {
    await ctx.close();
  }
});

test("14b. a late network failure for an ended session changes nothing in the new session", async ({ browser }) => {
  const release = gate();
  const { ctx, target } = await servedPage(browser, async ({ url, bearer, abort }) => {
    if (bearer !== "token-1") return undefined;
    if (url.pathname === "/admin/classification/summary" || url.pathname === "/admin/metrics/overview") {
      await release.promise;
      return abort();
    }
    return undefined;
  });
  try {
    await servedSignIn(target);
    await target.click("#signout-button");
    await expect(target.locator("#signin-screen")).toBeVisible();
    await servedSignIn(target);
    await expect(target.locator("article.metric-tile .metric-name")).toHaveText(["Accounts registered"]);
    await expect(target.locator("#provisional-banner")).toHaveText("PROVISIONAL — 3 accounts unclassified");
    let failed = 0;
    const late = new Promise((resolve) => {
      target.on("requestfailed", (r) => {
        if (/\/(classification\/summary|metrics\/overview)/.test(r.url()) && ++failed === 2) resolve();
      });
    });
    release.open();
    await late;
    await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(target.locator("#provisional-banner")).toHaveText("PROVISIONAL — 3 accounts unclassified");
    await expect(target.locator("#metrics-unavailable")).toBeHidden();
    await expect(target.locator("article.metric-tile .metric-name")).toHaveText(["Accounts registered"]);
  } finally {
    await ctx.close();
  }
});

test("15. if the unclassified count cannot be loaded, the provisional warning still shows", async ({ browser }) => {
  for (const failure of ["status", "network", "shape"]) {
    const { ctx, target } = await servedPage(browser, async ({ url, send, abort }) => {
      if (url.pathname !== "/admin/classification/summary") return undefined;
      if (failure === "status") return send(500, { error: "internal" });
      if (failure === "network") return abort();
      return send(200, { accounts: { unclassified: "unknown" } });
    });
    try {
      await servedSignIn(target);
      await expect(target.locator("#provisional-banner"), failure).toHaveText("PROVISIONAL — the unclassified account count could not be loaded");
      await expect(target.locator("article.metric-tile")).toHaveCount(1);
    } finally {
      await ctx.close();
    }
  }
});

test("16. while a new range loads, and if it fails, no figures from the old range remain", async ({ browser }) => {
  const release = gate();
  const { ctx, target } = await servedPage(browser, async ({ url, abort }) => {
    if (url.pathname === "/admin/metrics/overview" && url.searchParams.get("range") === "90d") {
      await release.promise;
      return abort();
    }
    return undefined;
  });
  try {
    await servedSignIn(target);
    await expect(target.locator("article.metric-tile")).toHaveCount(1);
    await target.selectOption("#range-select", "90d");
    await expect(target.locator("article.metric-tile"), "old figures removed while loading").toHaveCount(0);
    await expect(target.locator("#as-of")).toHaveText("");
    release.open();
    await expect(target.locator("#metrics-unavailable")).toBeVisible();
    await expect(target.locator("article.metric-tile")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("17. sign-out clears the page at once and says so when the server does not confirm", async ({ browser }) => {
  for (const outcome of [500, "network", 200]) {
    const release = gate();
    const { ctx, target } = await servedPage(browser, async ({ url, send, abort }) => {
      if (url.pathname !== "/admin/auth/logout") return undefined;
      await release.promise;
      if (outcome === "network") return abort();
      return send(outcome, outcome === 200 ? { ok: true } : { error: "internal" });
    });
    try {
      await servedSignIn(target);
      await target.click("#signout-button");
      await expect(target.locator("#signin-screen"), `${outcome}: cleared before the server answers`).toBeVisible();
      await expect(target.locator("article.metric-tile")).toHaveCount(0);
      await expect(target.locator("#admin-email")).toHaveText("");
      const answered = target.waitForEvent(outcome === "network" ? "requestfailed" : "requestfinished", (r) => r.url().includes("/admin/auth/logout"));
      release.open();
      await answered;
      if (outcome === 200) {
        await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
        await expect(target.locator("#signin-error")).toHaveText("");
      } else {
        await expect(target.locator("#signin-error"), String(outcome)).toContainText("the server did not confirm the session was ended");
        await expect(target.locator("#signin-error")).toContainText("It stops working by");
      }
    } finally {
      await ctx.close();
    }
  }
});

test("18. an unconfirmed sign-out can be retried with the old token, which is never stored", async ({ browser }) => {
  const outcomes = [500, "network", 200];
  const bearers = [];
  const { ctx, target } = await servedPage(browser, async ({ url, bearer, send, abort }) => {
    if (url.pathname !== "/admin/auth/logout") return undefined;
    bearers.push(bearer);
    const outcome = outcomes.shift();
    if (outcome === "network") return abort();
    return send(outcome, outcome === 200 ? { ok: true } : { error: "internal" });
  });
  try {
    await servedSignIn(target);
    await target.click("#signout-button");
    const retry = target.locator("#signout-retry");
    await expect(retry).toBeVisible();
    await expect(target.locator("#signin-error")).toContainText("the server did not confirm the session was ended");
    await expect(target.locator("#signin-error")).toContainText("If this page is reloaded, sign-out can no longer be retried.");
    const stored = await target.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      indexedDb: indexedDB.databases ? (await indexedDB.databases()).length : 0,
      cookie: document.cookie
    }));
    expect(stored).toEqual({ local: 0, session: 0, indexedDb: 0, cookie: "" });
    await expect(target.locator("article.metric-tile")).toHaveCount(0);
    await retry.click();
    await expect(target.locator("#signin-error")).toContainText("The server still did not confirm the session was ended.");
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(target.locator("#signin-error")).toHaveText("Signed out. The server confirmed the session has ended.");
    await expect(retry).toBeHidden();
    expect(bearers).toEqual(["token-1", "token-1", "token-1"]);
  } finally {
    await ctx.close();
  }
});

test("19. a new sign-in or a reload drops the unconfirmed sign-out", async ({ browser }) => {
  const bearers = [];
  const { ctx, target } = await servedPage(browser, async ({ url, bearer, send }) => {
    if (url.pathname !== "/admin/auth/logout") return undefined;
    bearers.push(bearer);
    return bearer === "token-1" ? send(500, { error: "internal" }) : send(200, { ok: true });
  });
  try {
    await servedSignIn(target);
    await target.click("#signout-button");
    await expect(target.locator("#signout-retry")).toBeVisible();
    // Retry button meets the touch-target size.
    const box = await target.locator("#signout-retry").boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    await servedSignIn(target);
    await target.click("#signout-button");
    await expect(target.locator("#signin-screen")).toBeVisible();
    await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(target.locator("#signout-retry")).toBeHidden();
    await expect(target.locator("#signin-error")).toHaveText("");
    expect(bearers, "the old token is not sent again after a new sign-in").toEqual(["token-1", "token-2"]);
  } finally {
    await ctx.close();
  }
  const reload = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname !== "/admin/auth/logout") return undefined;
    return send(500, { error: "internal" });
  });
  try {
    await servedSignIn(reload.target);
    await reload.target.click("#signout-button");
    await expect(reload.target.locator("#signout-retry")).toBeVisible();
    await reload.target.reload();
    await expect(reload.target.locator("#signin-screen")).toBeVisible();
    await expect(reload.target.locator("#signout-retry")).toBeHidden();
    await expect(reload.target.locator("#signin-error")).toHaveText("");
  } finally {
    await reload.ctx.close();
  }
});

test("20. a hanging logout holds sign-in, then times out into the retry state", async ({ browser }) => {
  const hang = gate();
  const bearers = [];
  let logouts = 0;
  const { ctx, target } = await servedPage(browser, async ({ url, bearer, send }) => {
    if (url.pathname !== "/admin/auth/logout") return undefined;
    bearers.push(bearer);
    logouts += 1;
    if (logouts === 1) { await hang.promise; return send(200, { ok: true }).catch(() => true); }
    return send(200, { ok: true });
  });
  try {
    await servedSignIn(target);
    await target.click("#signout-button");
    await expect(target.locator("#signin-screen")).toBeVisible();
    await expect(target.locator("article.metric-tile")).toHaveCount(0);
    await expect(target.locator("#signin-error")).toHaveText("Ending the session on the server…");
    // A new sign-in cannot start while the logout is unanswered.
    await expect(target.locator("#signin-submit")).toBeDisabled();
    await target.fill("#signin-email", "owner@example.test");
    await target.fill("#signin-password", "x");
    await target.fill("#signin-totp", "123456");
    await target.locator("#signin-totp").press("Enter");
    await expect(target.locator("#overview-screen")).toBeHidden();
    // After the time limit the logout counts as unconfirmed and can be retried.
    await expect(target.locator("#signin-error")).toContainText("the server did not confirm the session was ended", { timeout: 5000 });
    await expect(target.locator("#signout-retry")).toBeVisible();
    await expect(target.locator("#signin-submit")).toBeEnabled();
    await target.click("#signout-retry");
    await expect(target.locator("#signin-error")).toHaveText("Signed out. The server confirmed the session has ended.");
    expect(bearers).toEqual(["token-1", "token-1"]);
  } finally {
    hang.open();
    await ctx.close();
  }
});

test("21. a non-owner sign-in shows access denied and requests no figures", async ({ browser }) => {
  const asked = [];
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    asked.push(url.pathname);
    if (url.pathname === "/admin/auth/me") return send(200, { email: "viewer@example.test", role: "viewer" });
    return undefined;
  });
  try {
    await servedSignIn(target, { expectOverview: false });
    await expect(target.locator("#denied-screen")).toBeVisible();
    await expect(target.locator("#denied-message")).toHaveText("This account (viewer@example.test) does not have owner access. The Overview is owner only, so no figures are shown.");
    await expect(target.locator("#overview-screen")).toBeHidden();
    await expect(target.locator("#operator-label")).toBeHidden();
    await expect(target.locator("article.metric-tile")).toHaveCount(0);
    const box = await target.locator("#denied-signout").boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    await target.click("#denied-signout");
    await expect(target.locator("#signin-screen")).toBeVisible();
    await expect(target.locator("#denied-screen")).toBeHidden();
    await expect(target.locator("#signin-error")).toHaveText("");
    expect(asked.filter((p) => /metrics|classification/.test(p)), "no figures requested").toEqual([]);
    expect(asked).toContain("/admin/auth/logout");
  } finally {
    await ctx.close();
  }
});

test("21b. a 403 from the figures shows access denied with no figures", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname === "/admin/metrics/overview") return send(403, { error: "Insufficient admin role." });
    return undefined;
  });
  try {
    await servedSignIn(target, { expectOverview: false });
    await expect(target.locator("#denied-screen")).toBeVisible();
    await expect(target.locator("#denied-message")).toHaveText("The server refused this account access to the Overview. No figures are shown.");
    await expect(target.locator("#overview-screen")).toBeHidden();
    await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(target.locator("article.metric-tile")).toHaveCount(0);
    await expect(target.locator("#provisional-banner")).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test("12. phone width: no sideways scroll and 44px touch targets", async ({ browser }) => {
  const phone = await browser.newContext({ baseURL: APP_URL, viewport: { width: 375, height: 740 } });
  const target = await phone.newPage();
  try {
    await routeAdminConfig(target);
    // Serve fixed figures so this check needs no further sign-in.
    await target.route(`${API_BASE}/admin/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      const bodies = {
        "/admin/auth/login": { token: "test-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        "/admin/auth/me": { email: "a-rather-long-owner-address-for-wrapping@example.test", role: "owner" },
        "/admin/classification/summary": { accounts: { external: 0, internal_demo: 0, unclassified: 12, total: 12 }, provisional: true },
        "/admin/metrics/overview": firstReading.overview
      };
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST" } });
      }
      return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(bodies[path] || {}) });
    });
    await target.goto(PAGE);
    const noSideways = () => target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noSideways(), "sign-in screen").toBe(true);
    await target.fill("#signin-email", "owner@example.test");
    await target.fill("#signin-password", "x");
    await target.fill("#signin-totp", "123456");
    await target.click("#signin-submit");
    await expect(target.locator("article.metric-tile").first()).toBeVisible();
    expect(await noSideways(), "overview screen").toBe(true);
    for (const selector of ["#signout-button", "#range-select"]) {
      const box = await target.locator(selector).boundingBox();
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(44);
      expect(box.width, `${selector} width`).toBeGreaterThanOrEqual(44);
    }
    await target.click("#signout-button");
    await expect(target.locator("#signin-screen")).toBeVisible();
    expect(await noSideways(), "sign-in after sign out").toBe(true);
    for (const selector of ["#signin-email", "#signin-password", "#signin-totp", "#signin-submit"]) {
      const box = await target.locator(selector).boundingBox();
      expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(44);
    }
  } finally {
    await phone.close();
  }
});

test("13. the admin site sends strict headers and the main site refuses /admin", async () => {
  const admin = JSON.parse(await readFile(ADMIN_DIR + "vercel.json", "utf8"));
  const rule = admin.headers.find((entry) => entry.source === "/(.*)");
  expect(rule, "a header rule for every path").toBeTruthy();
  const headers = Object.fromEntries(rule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
  const csp = headers["content-security-policy"];
  for (const directive of [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src https://api.konfirmata.com",
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
  ]) expect(csp, directive).toContain(directive);
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["x-robots-tag"]).toMatch(/noindex/);

  const html = await readFile(ADMIN_DIR + "index.html", "utf8");
  expect(html, "no inline script").not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
  expect(html, "no inline style").not.toMatch(/<style|\sstyle=/i);
  const config = await readFile(ADMIN_DIR + "config.js", "utf8");
  expect(config.trim()).toBe('export const API_BASE = "https://api.konfirmata.com";');

  const main = JSON.parse(await readFile(ROOT_VERCEL, "utf8"));
  const block = main.routes.findIndex((r) => r.src === "/admin(/.*)?" && r.status === 404);
  const catchAll = main.routes.findIndex((r) => r.src === "/(.*)");
  expect(block, "main site has a 404 route for /admin").toBeGreaterThanOrEqual(0);
  expect(block, "the 404 route comes before the catch-all").toBeLessThan(catchAll);
});
