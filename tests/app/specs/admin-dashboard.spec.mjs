import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { API_BASE, routeAdminConfig, seedOwner, withDb } from "./admin-helpers.mjs";

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
  "GET /admin/v2/overview",
  "GET /admin/v2/timeseries",
  "GET /admin/v2/breakdown",
  "GET /admin/v2/exclusions",
  "GET /admin/v2/status"
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
  // The first reads after a fresh database may find the figures still building (503) and ask again.
  const ok = (part) => (r) => r.url().includes(part) && r.status() === 200;
  const all = target.waitForResponse(ok("/admin/v2/overview?range=all"));
  const period = target.waitForResponse(ok("/admin/v2/overview?range=90d"));
  const exclusions = target.waitForResponse(ok("/admin/v2/exclusions"));
  await target.click("#signin-submit");
  await expect(target.locator("#dashboard-screen")).toBeVisible();
  return { all: await (await all).json(), period: await (await period).json(), exclusions: await (await exclusions).json() };
}

async function choosePeriod(target, value) {
  const response = target.waitForResponse((r) => r.url().includes(`/admin/v2/overview?range=${value}`));
  await target.selectOption("#period-select", value);
  return (await response).json();
}

const external = (body, key) => String(body.metrics.find((m) => m.key === key).external);

async function kpisMatch(target, all, period, value) {
  await expect(target.locator("#kpi-external-value")).toHaveText(external(all, "accounts_registered"));
  await expect(target.locator("#kpi-external-sub")).toHaveText("Not affected by the period");
  await expect(target.locator("#kpi-new-value")).toHaveText(external(period, "accounts_registered"));
  await expect(target.locator("#kpi-new-sub")).toHaveText({ "30d": "Last 30 days", "90d": "Last 90 days", "12m": "Last 12 months", all: "All time" }[value]);
  await expect(target.locator("#kpi-submitting-value")).toHaveText(external(period, "accounts_submitting_records"));
  await expect(target.locator("#kpi-submitting-sub")).toHaveText({ "30d": "Last 30 days", "90d": "Last 90 days", "12m": "Last 12 months", all: "All time" }[value]);
  await expect(target.locator("#kpi-records-value")).toHaveText(external(period, "records_recorded"));
}

const CORS = { "access-control-allow-origin": APP_URL, "content-type": "application/json" };

test.beforeAll(async ({ browser }) => {
  owner = await seedOwner();
  // Two accounts with no exclusion row: registered users under the exclusion model.
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

test("1. sign-in needs email and password; a wrong password gives one generic error and no figures", async () => {
  await openPage(page);
  await expect(page.locator("#signin-email")).toHaveAttribute("autocomplete", "username");
  await expect(page.locator("#signin-password")).toHaveAttribute("autocomplete", "current-password");

  const loginsBefore = requests.filter((r) => r.url.includes("/admin/auth/login")).length;
  await page.fill("#signin-email", owner.email);
  await page.click("#signin-submit");
  await expect(page.locator("#signin-error")).toHaveText("Enter your email and password.");
  expect(requests.filter((r) => r.url.includes("/admin/auth/login")).length, "no login without a password").toBe(loginsBefore);

  await page.fill("#signin-password", "wrong-password");
  const response = page.waitForResponse((r) => r.url().includes("/admin/auth/login"));
  await page.click("#signin-submit");
  const loginResponse = await response;
  expect(loginResponse.status()).toBe(401);
  expect(loginResponse.request().postDataJSON()).toEqual({ email: owner.email, password: "wrong-password" });
  await expect(page.locator("#signin-error")).toHaveText("Sign-in failed. Check your details and try again.");
  await expect(page.locator("#signin-error")).toHaveAttribute("role", "alert");
  await expect(page.locator("#dashboard-screen")).toBeHidden();
  await expect(page.locator("#kpi-external-value")).toHaveText("—");
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

test("3. the four headline figures show the API values with their distinct labels and footer", async () => {
  const { all, period } = firstReading;
  expect(all.api_version).toBe(3);
  expect(period.range).toBe("90d");
  await kpisMatch(page, all, period, "90d");
  await expect(page.locator(".kpis > .kpi .kpi-label")).toContainText([
    "Registered accounts — all time", "New accounts — selected period",
    "Accounts with recorded activity — selected period", "Records recorded — selected period"
  ]);
  await expect(page.locator(".kpis")).not.toContainText(/retention|verified people/i);
  await expect(page.locator("#kpi-submitting-def")).toHaveText(all.metrics.find((m) => m.key === "accounts_submitting_records").definition);
  await expect(page.locator("#kpi-records .kpi-label")).toContainText("Records recorded");
  await expect(page.locator("#kpi-records-def")).toContainText("calendar date recorded on the device");
  await expect(page.locator("#kpi-records-undated")).toHaveText(/records have no usable recorded date and are not placed in any month/);
  await expect(page.locator("#growth-records_recorded h3")).toHaveText("Records recorded");
  await expect(page.locator("#operator-label")).toHaveCount(0);
  await expect(page.locator('#tabs a[data-tab="reports"]')).toHaveCount(0);
  await expect(page.locator("#footer-note")).toHaveText("Operator-generated internal metrics. Aggregate counts only. Not a user-record attestation.");
  await expect(page.locator("#activation-note")).toContainText("cannot be computed by the server");
});

test("4. changing the period re-fetches the activity figures only", async () => {
  const all = firstReading.all;
  for (const value of ["30d", "12m", "all", "90d"]) {
    const before = requests.length;
    const body = await choosePeriod(page, value);
    expect(body.range).toBe(value);
    await kpisMatch(page, all, value === "all" ? all : body, value);
    const added = requests.slice(before).map((r) => new URL(r.url).pathname).filter((path) => path.startsWith("/admin/"));
    expect(added.every((path) => path === "/admin/v2/overview"), `${value}: ${added.join(",")}`).toBe(true);
  }
});

test("5. the exclusions line and the Settings counts come from the exclusions summary", async () => {
  const { exclusions } = firstReading;
  expect(exclusions.api_version).toBe(3);
  const changed = exclusions.exclusions_last_changed;
  await expect(page.locator("#dash-exclusions-changed")).toHaveText(changed ? "2026-10-26 23:03 EDT" : "never");
  await page.click('#tabs a[data-tab="settings"]');
  await expect(page.locator("#settings-exclusions")).toBeVisible();
  await expect(page.locator("#count-total")).toHaveText(String(exclusions.accounts.total));
  await expect(page.locator("#count-excluded")).toHaveText(String(exclusions.accounts.excluded));
  await expect(page.locator("#count-external")).toHaveText(String(exclusions.accounts.external));
  await page.click('#tabs a[data-tab="dashboard"]');
  await expect(page.locator("#dashboard-screen")).toBeVisible();
});

test("6. a 503 shows the unavailable message with no figures and no zeros", async () => {
  await page.route(`${API_BASE}/admin/v2/overview?range=12m`, (route) => route.fulfill({
    status: 503,
    headers: CORS,
    body: JSON.stringify({ error: "metrics_unavailable", api_version: 3, as_of: null, stale: true })
  }));
  await page.selectOption("#period-select", "12m");
  await expect(page.locator("#dash-unavailable")).toBeVisible();
  await expect(page.locator("#dash-status")).toHaveText("Unavailable");
  for (const id of ["#kpi-external-value", "#kpi-new-value", "#kpi-submitting-value", "#kpi-records-value"]) await expect(page.locator(id)).toHaveText("—");
  await page.unroute(`${API_BASE}/admin/v2/overview?range=12m`);
  await choosePeriod(page, "90d");
  await expect(page.locator("#dash-unavailable")).toBeHidden();
});

test("7. the as-of time and the stale flag are shown", async () => {
  const asOf = "2026-10-27T03:00:00.000Z";
  await page.route(`${API_BASE}/admin/v2/overview?range=12m`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, stale: true, as_of: asOf }) });
  });
  await page.selectOption("#period-select", "12m");
  await expect(page.locator("#dash-as-of")).toHaveText("2026-10-26 23:00 EDT");
  await expect(page.locator("#dash-stale")).toBeVisible();
  await expect(page.locator("#dash-status")).toHaveText("May be out of date");
  await page.unroute(`${API_BASE}/admin/v2/overview?range=12m`);
  const fresh = await choosePeriod(page, "90d");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short"
  }).formatToParts(new Date(fresh.as_of)).map((part) => [part.type, part.value]));
  await expect(page.locator("#dash-as-of")).toHaveText(`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`);
  await expect(page.locator("#dash-stale")).toBeVisible({ visible: Boolean(fresh.stale) });
  await expect(page.locator("#dash-status")).toHaveText(fresh.stale ? "May be out of date" : "Current");
});

test("7a. displayed timestamps use New York EST/EDT, including both DST fallback offsets", async () => {
  for (const [range, asOf, expected] of [
    ["30d", "2026-01-15T17:30:00.000Z", "2026-01-15 12:30 EST"],
    ["12m", "2026-07-15T16:30:00.000Z", "2026-07-15 12:30 EDT"],
    ["all", "2026-11-01T04:30:00.000Z", "2026-11-01 00:30 EDT"],
    ["90d", "2026-11-01T06:30:00.000Z", "2026-11-01 01:30 EST"]
  ]) {
    const path = `${API_BASE}/admin/v2/overview?range=${range}`;
    await page.route(path, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, body: JSON.stringify({ ...body, as_of: asOf }) });
    });
    await page.selectOption("#period-select", range);
    await expect(page.locator("#dash-as-of")).toHaveText(expected);
    await expect(page.locator("#dash-as-of")).not.toContainText("UTC");
    await expect(page.locator("#dashboard-screen")).not.toContainText("UTC");
    await page.unroute(path);
  }
});

test("8. a revoked session returns to sign-in and removes every figure", async () => {
  await withDb((db) => db.query(
    "UPDATE admin_sessions SET revoked_at = NOW() WHERE admin_user_id = $1 AND revoked_at IS NULL",
    [owner.id]
  ));
  await page.selectOption("#period-select", "all");
  await expect(page.locator("#signin-screen")).toBeVisible();
  await expect(page.locator("#signin-error")).toHaveText(SESSION_ENDED);
  await expect(page.locator("#dashboard-screen")).toBeHidden();
  await expect(page.locator("#kpi-external-value")).toHaveText("—");
  await expect(page.locator("#admin-email")).toHaveText("");
  await expect(page.locator("#dash-exclusions-changed")).toHaveText("—");
  await expect(page.locator("#aud-country .bar-row, #aud-country .withheld")).toHaveCount(0);
});

test("8b. Operator detail shows every metric in three columns matching the API", async () => {
  const reading = await signIn(page);
  const detail = page.waitForResponse((r) => r.url().includes("/admin/v2/overview?range=90d"));
  await page.evaluate(() => { location.hash = "#settings/detail"; });
  const body = await (await detail).json();
  await expect(page.locator("#settings-detail")).toBeVisible();
  await expect(page.locator("#settings-detail")).not.toContainText("Never for sharing");
  await expect(page.locator("#detail-table thead th")).toHaveText(["Measure", "Registered users", "Excluded", "All"]);
  await expect(page.locator("#detail-table tbody tr")).toHaveCount(body.metrics.length);
  for (const metric of body.metrics) {
    const row = page.locator(`#detail-table tbody tr[data-metric-key="${metric.key}"]`);
    await expect(row.locator(".metric-name")).toHaveText(metric.name);
    for (const col of ["external", "excluded", "total"]) {
      await expect(row.locator(`td[data-col="${col}"]`), `${metric.key} ${col}`).toHaveText(String(metric[col]));
    }
  }
  expect(reading.all.metrics.length).toBe(body.metrics.length);
  await page.evaluate(() => { location.hash = "#dashboard"; });
  await expect(page.locator("#dashboard-screen")).toBeVisible();
});

test("9. sign out calls logout, removes the figures, and a reload shows only sign-in", async () => {
  await expect(page.locator("#kpi-external-value")).not.toHaveText("—");
  const logout = page.waitForRequest((r) => r.url().includes("/admin/auth/logout") && r.method() === "POST");
  const logoutResponse = page.waitForResponse((r) => r.url().includes("/admin/auth/logout") && r.request().method() === "POST");
  await page.click("#signout-button");
  expect((await logout).headers().authorization).toMatch(/^Bearer /);
  await expect(page.locator("#signin-screen")).toBeVisible();
  await expect(page.locator("#kpi-external-value")).toHaveText("—");
  await expect(page.locator("#admin-email")).toHaveText("");
  const response = await logoutResponse;
  expect(response.status(), "logout response status").toBeGreaterThanOrEqual(200);
  expect(response.status(), "logout response status").toBeLessThan(300);

  const revoked = await withDb((db) => db.query(
    "SELECT COUNT(*)::int AS open FROM admin_sessions WHERE admin_user_id = $1 AND revoked_at IS NULL",
    [owner.id]
  ));
  expect(revoked.rows[0].open, "logout revoked the server session").toBe(0);

  await page.reload();
  await expect(page.locator("#signin-screen")).toBeVisible();
  await expect(page.locator("#dashboard-screen")).toBeHidden();
  await expect(page.locator("#kpi-external-value")).toHaveText("—");
});

test("10. the page makes no request outside the allow-list", async () => {
  expect(requests.length).toBeGreaterThan(0);
  for (const { method, url } of requests) {
    const parsed = new URL(url);
    if (parsed.origin === APP_URL) {
      expect(parsed.pathname, `same-origin ${url}`).toMatch(/^\/admin\/(index\.html|admin\.js|admin\.css|config\.js|catalog-labels\.js|favicon\.ico)?$/);
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
    await target.click("#signin-submit");
    await expect(target.locator("#signin-error")).toHaveText("Too many sign-in attempts. Wait 15 minutes, then try again.");
    await expect(target.locator("#dashboard-screen")).toBeHidden();
  } finally {
    await other.close();
  }
});

// Tests 14 onward use a separate browser with served API responses, so they spend no real sign-ins.
const SERVED_AS_OF = new Date(Date.now() - 60_000).toISOString();
const SERVED_CHANGED = "2026-10-27T03:03:00.000Z";
function sampleOverview(range, registered = 1) {
  const bases = { accounts_registered: "account_created", records_recorded: "recorded", accounts_submitting_records: "recorded", devices_active: "none" };
  const row = (key, name, external, pit = false) => ({ key, name, definition: `${name} definition.`, date_basis: bases[key], point_in_time: pit, range_ignored: pit, external, excluded: 2, total: external + 2 });
  return {
    api_version: 3, audience: "operator_only", suppression: "none", range, as_of: SERVED_AS_OF, stale: false,
    metrics: [
      row("accounts_registered", "Accounts registered", registered),
      row("records_recorded", "Records recorded", 7),
      row("accounts_submitting_records", "Accounts submitting records", 4),
      row("devices_active", "Devices in ACTIVE registration status", 9, true)
    ]
  };
}
function sampleVersion2Overview(range) {
  const row = (key, name, external, pit = false) => ({
    key, name, definition: `${name} definition.`, point_in_time: pit, range_ignored: pit,
    external, excluded: 2, total: external + 2
  });
  return {
    api_version: 2, audience: "operator_only", suppression: "none", range, as_of: SERVED_AS_OF, stale: false,
    metrics: [
      row("accounts_registered", "Accounts registered", 1),
      row("records_received", "Records received", 7),
      row("accounts_submitting_records", "Accounts submitting records", 4),
      row("devices_active", "Devices in ACTIVE registration status", 9, true)
    ]
  };
}
function sampleSeries(metric, bucket, periods) {
  const out = [];
  for (let i = periods - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(2026, 9 - (bucket === "month" ? i : 0), bucket === "month" ? 1 : 26 - i * 7));
    out.push({ period_start: d.toISOString().slice(0, 10), partial: i === 0, external: periods - i, excluded: 1, total: periods - i + 1 });
  }
  return { api_version: 3, audience: "operator_only", suppression: "none", metric: { key: metric, date_basis: metric === "accounts_registered" ? "account_created" : "recorded" }, bucket, periods: out, as_of: SERVED_AS_OF, stale: false };
}
function sampleBreakdown(dimension, result = { status: "published", cells: dimension === "sector"
  ? [{ category: "trade_retail", count: 7 }]
  : dimension === "country"
    ? [{ category: "NG", count: 7 }]
    : [{ category: "ng_market_trader", count: 7 }, { category: "other", count: 5 }], total: ["country", "sector"].includes(dimension) ? 7 : 12 }, k = 5) {
  return {
    api_version: 3, audience: "owner_only", release_status: "single_reading", suppression: "owner_view_top_10", minimum_cell_size: k,
    scope: "external_only", range: "all_time", as_of: SERVED_AS_OF, stale: false, dimension, dimension_label: dimension,
    statements: ["Counts all accounts except those the owner has identified as internal test, demonstration or administrator accounts.", "The 10 largest categories with 2 or more users are shown. Smaller categories and all remaining categories are combined in 'Other'.", `${dimension === "country" ? "Country" : dimension === "sector" ? "Sector" : "Business type"} is the stored code. Provenance statement.`],
    result
  };
}
const SAMPLE_EXCLUSIONS = { api_version: 3, accounts: { external: 12, excluded: 3, total: 15 }, exclusions_last_changed: SERVED_CHANGED, accounts_created_since: 2, audience: "operator_only", suppression: "none", definitions: {}, as_of: SERVED_AS_OF };
const SAMPLE_STATUS = { api_version: 3, audience: "operator_only", suppression: "none", as_of: SERVED_AS_OF, stale: false, built_at: SERVED_AS_OF, build_ms: 30, out_of_range: 2, invalidations: 1, last_attempt_at: SERVED_AS_OF, last_failure_at: null, row_counts: { metrics_daily_rollup: 1, metrics_snapshot: 1 }, sector_assignment: { catalog: 9, user_selected: 3, reviewed_rule: 0, fallback: 4, catalog_mismatches: 0 } };

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
    if (url.pathname === "/admin/v2/exclusions") return send(200, SAMPLE_EXCLUSIONS);
    if (url.pathname === "/admin/v2/overview") return send(200, sampleOverview(url.searchParams.get("range")));
    if (url.pathname === "/admin/v2/timeseries") return send(200, sampleSeries(url.searchParams.get("metric"), url.searchParams.get("bucket"), Number(url.searchParams.get("periods"))));
    if (url.pathname === "/admin/v2/breakdown") return send(200, sampleBreakdown(url.searchParams.get("dimension")));
    if (url.pathname === "/admin/v2/status") return send(200, SAMPLE_STATUS);
    return send(404, {});
  });
  await target.goto(PAGE);
  return { ctx, target };
}

async function servedSignIn(target, { expectDashboard = true } = {}) {
  await target.fill("#signin-email", "owner@example.test");
  await target.fill("#signin-password", "x");
  await target.click("#signin-submit");
  if (expectDashboard) await expect(target.locator("#dashboard-screen")).toBeVisible();
}

test("D11h. headline label scopes stay below their names and keep their info controls aligned", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async () => undefined);
  try {
    await servedSignIn(target);
    for (const width of [1280, 768, 375]) {
      await target.setViewportSize({ width, height: 800 });
      for (const id of ["#kpi-external", "#kpi-new", "#kpi-submitting", "#kpi-records"]) {
        const card = target.locator(id);
        const label = card.locator(".kpi-label");
        const copy = card.locator(".kpi-copy");
        const name = card.locator(".kpi-name");
        const scope = card.locator(".kpi-scope");
        const info = card.locator("details.info > summary");
        const [labelBox, copyBox, nameBox, scopeBox, infoBox] = await Promise.all([
          label.boundingBox(), copy.boundingBox(), name.boundingBox(), scope.boundingBox(), info.boundingBox()
        ]);
        expect(labelBox, `${width}px ${id} label box`).not.toBeNull();
        expect(copyBox, `${width}px ${id} copy box`).not.toBeNull();
        expect(nameBox, `${width}px ${id} name box`).not.toBeNull();
        expect(scopeBox, `${width}px ${id} scope box`).not.toBeNull();
        expect(infoBox, `${width}px ${id} info box`).not.toBeNull();
        const nameTextRight = await name.evaluate((el) => {
          const text = el.firstChild;
          if (!text) throw new Error("headline name has no text node");
          const range = document.createRange();
          range.selectNodeContents(text);
          return range.getBoundingClientRect().right;
        });
        const circleLeft = infoBox.x + (infoBox.width - 20) / 2;
        expect(circleLeft - nameTextRight, `${width}px ${id} name text has space before its info circle`).toBeGreaterThanOrEqual(8);
        expect(infoBox.x + infoBox.width, `${width}px ${id} info right edge stays inside label`).toBeLessThanOrEqual(labelBox.x + labelBox.width + 0.5);
        expect(infoBox.x, `${width}px ${id} info left edge stays inside copy`).toBeGreaterThanOrEqual(copyBox.x);
        expect(scopeBox.y, `${width}px ${id} scope below name`).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);
        const nameLineHeight = await name.evaluate((el) => {
          const style = getComputedStyle(el);
          return Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
        });
        const infoCentre = infoBox.y + infoBox.height / 2;
        expect(infoCentre, `${width}px ${id} info centre is in name's first line`).toBeGreaterThanOrEqual(nameBox.y);
        expect(infoCentre, `${width}px ${id} info centre is in name's first line`).toBeLessThanOrEqual(nameBox.y + nameLineHeight);
      }
      const overflow = await target.locator(".kpi-label, .kpi-name, .kpi-scope, .kpi-value, .kpi-sub").evaluateAll((els) => els.map((el) => ({
        label: `${el.closest(".kpi")?.id || el.className} ${el.className}`,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth
      })));
      for (const element of overflow) expect(element.scrollWidth, `${width}px ${element.label}`).toBeLessThanOrEqual(element.clientWidth);
    }
  } finally {
    await ctx.close();
  }
});

test("D11i. headline values align only in the four-column layout and shared info geometry stays intact", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async () => undefined);
  try {
    await servedSignIn(target);
    await target.setViewportSize({ width: 1280, height: 800 });
    const valueBoxes = await target.locator(".kpis > .kpi .kpi-value").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
    expect(valueBoxes).toHaveLength(4);
    for (const box of valueBoxes.slice(1)) expect(Math.abs(box.y - valueBoxes[0].y), "1280px KPI value alignment").toBeLessThanOrEqual(1);

    const audienceSummaryMargins = await target.locator("#aud-country details.info > summary").evaluate((el) => {
      const style = getComputedStyle(el);
      return { top: style.marginTop, left: style.marginLeft };
    });
    expect(audienceSummaryMargins).toEqual({ top: "-12px", left: "-10px" });
    const audienceHeading = await target.locator("#aud-country h3").boundingBox();
    expect(audienceHeading, "1280px Audience country heading").not.toBeNull();
    expect(audienceHeading.height, "1280px Audience country heading height").toBeLessThanOrEqual(32);

    for (const width of [768, 375]) {
      await target.setViewportSize({ width, height: 800 });
      const [copyBox, nameBox, scopeBox] = await Promise.all([
        target.locator("#kpi-external .kpi-copy").boundingBox(),
        target.locator("#kpi-external .kpi-name").boundingBox(),
        target.locator("#kpi-external .kpi-scope").boundingBox()
      ]);
      expect(copyBox, `${width}px copy box`).not.toBeNull();
      expect(nameBox, `${width}px name box`).not.toBeNull();
      expect(scopeBox, `${width}px scope box`).not.toBeNull();
      expect(copyBox.height, `${width}px no reserved KPI copy height`).toBeLessThanOrEqual(nameBox.height + scopeBox.height + 2);
    }
  } finally {
    await ctx.close();
  }
});

test("D13a. opened headline definitions remain inside each card without narrowing its label", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async () => undefined);
  try {
    await servedSignIn(target);
    const ids = ["#kpi-external", "#kpi-new", "#kpi-submitting", "#kpi-records"];
    for (const width of [1280, 768, 375]) {
      await target.setViewportSize({ width, height: 800 });
      for (const id of ids) {
        const card = target.locator(id);
        const copy = card.locator(".kpi-copy");
        const name = card.locator(".kpi-name");
        const summary = card.locator(".kpi-label > details.info > summary");
        const before = await Promise.all([card.boundingBox(), copy.boundingBox(), summary.boundingBox(), name.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getClientRects().length;
        })]);
        await summary.focus();
        await summary.press("Space");
        const definition = card.locator(".kpi-label > details.info[open] > p");
        await expect(definition).toBeVisible();
        const [cardBox, definitionBox, openCopy, openLines, overflow] = await Promise.all([
          card.boundingBox(), definition.boundingBox(), copy.boundingBox(), name.evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getClientRects().length;
          }),
          target.evaluate(() => ({
            page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
            label: Array.from(document.querySelectorAll(".kpi-label, .kpi")).map((el) => [el.scrollWidth, el.clientWidth])
          }))
        ]);
        expect(cardBox, `${width}px ${id} card`).not.toBeNull();
        expect(definitionBox, `${width}px ${id} definition`).not.toBeNull();
        expect(openCopy, `${width}px ${id} open copy`).not.toBeNull();
        expect(definitionBox.x, `${width}px ${id} definition left`).toBeGreaterThanOrEqual(cardBox.x);
        expect(definitionBox.x + definitionBox.width, `${width}px ${id} definition right`).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5);
        expect(definitionBox.y + definitionBox.height, `${width}px ${id} definition bottom`).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
        expect(openLines, `${width}px ${id} name lines`).toBeLessThanOrEqual(before[3]);
        expect(openCopy.width, `${width}px ${id} copy width`).toBeGreaterThanOrEqual(before[1].width - 0.5);
        if (width === 375) expect(definitionBox.width, `${id} readable definition`).toBeGreaterThanOrEqual(120);
        expect(overflow.page[0], `${width}px page overflow`).toBeLessThanOrEqual(overflow.page[1]);
        for (const [scrollWidth, clientWidth] of overflow.label) expect(scrollWidth, `${width}px ${id} label overflow`).toBeLessThanOrEqual(clientWidth);
        await summary.press("Enter");
        await expect(definition).toBeHidden();
        const after = await Promise.all([card.boundingBox(), copy.boundingBox(), summary.boundingBox()]);
        for (const [label, beforeBox, afterBox] of [["copy", before[1], after[1]], ["summary", before[2], after[2]]]) {
          const beforeRelative = [beforeBox.x - before[0].x, beforeBox.y - before[0].y, beforeBox.width, beforeBox.height];
          const afterRelative = [afterBox.x - after[0].x, afterBox.y - after[0].y, afterBox.width, afterBox.height];
          for (let index = 0; index < beforeRelative.length; index += 1) {
            expect(Math.abs(afterRelative[index] - beforeRelative[index]), `${width}px ${id} closed ${label} relative geometry`).toBeLessThanOrEqual(0.5);
          }
        }
      }
    }
    await target.setViewportSize({ width: 375, height: 800 });
    for (const id of ids) await target.locator(`${id} .kpi-label > details.info > summary`).click();
    const allOpenOverflow = await target.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(allOpenOverflow[0], "375px all-open page overflow").toBeLessThanOrEqual(allOpenOverflow[1]);
  } finally {
    await ctx.close();
  }
});

test("D13b. every successful displayed response contributes to stale status", async ({ browser }) => {
  const cases = [
    ["growth accounts_registered", ({ url, send }) => url.pathname === "/admin/v2/timeseries" && url.searchParams.get("metric") === "accounts_registered" ? send(200, { ...sampleSeries("accounts_registered", "month", 12), stale: true }) : undefined, null],
    ["growth records_recorded", ({ url, send }) => url.pathname === "/admin/v2/timeseries" && url.searchParams.get("metric") === "records_recorded" ? send(200, { ...sampleSeries("records_recorded", "month", 12), stale: true }) : undefined, null],
    ["audience breakdown", ({ url, send }) => url.pathname === "/admin/v2/breakdown" && url.searchParams.get("dimension") === "country" ? send(200, { ...sampleBreakdown("country"), stale: true }) : undefined, null],
    ["activity all-time while 12m is fresh", ({ url, send }) => url.pathname === "/admin/v2/overview" && url.searchParams.get("range") === "all" ? send(200, { ...sampleOverview("all"), stale: true }) : undefined, "12m"],
    ["activity all period", ({ url, send }) => url.pathname === "/admin/v2/overview" && url.searchParams.get("range") === "all" ? send(200, { ...sampleOverview("all"), stale: true }) : undefined, "all"],
    ["all fresh", () => undefined, null, "Current"]
  ];
  for (const [name, handle, period, expected = "May be out of date"] of cases) {
    const { ctx, target } = await servedPage(browser, handle);
    try {
      await servedSignIn(target);
      if (period) await target.selectOption("#period-select", period);
      await expect(target.locator("#dash-status"), name).toHaveText(expected);
      await expect(target.locator("#dash-stale"), name).toBeVisible({ visible: expected === "May be out of date" });
    } finally {
      await ctx.close();
    }
  }
});

test("D13c. stale status observes precedence, reloads, and activity race guards", async ({ browser }) => {
  const staleAndFailed = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname === "/admin/v2/overview" && url.searchParams.get("range") === "all") return send(200, { ...sampleOverview("all"), stale: true });
    if (url.pathname === "/admin/v2/breakdown" && url.searchParams.get("dimension") === "country") return send(503, { error: "unavailable" });
    return undefined;
  });
  try {
    await servedSignIn(staleAndFailed.target);
    await expect(staleAndFailed.target.locator("#dash-status")).toHaveText("Unavailable");
    await expect(staleAndFailed.target.locator("#dash-stale")).toBeHidden();
  } finally { await staleAndFailed.ctx.close(); }

  const release = gate();
  const staleAndLoading = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname === "/admin/v2/overview" && url.searchParams.get("range") === "all") return send(200, { ...sampleOverview("all"), stale: true });
    if (url.pathname === "/admin/v2/timeseries") { await release.promise; return send(200, sampleSeries(url.searchParams.get("metric"), "month", 12)); }
    return undefined;
  });
  try {
    await servedSignIn(staleAndLoading.target);
    await expect(staleAndLoading.target.locator("#dash-status")).toHaveText("Updating…");
    await expect(staleAndLoading.target.locator("#dash-stale")).toBeVisible();
    release.open();
    await expect(staleAndLoading.target.locator("#dash-status")).toHaveText("May be out of date");
  } finally { await staleAndLoading.ctx.close(); }

  let stale = true;
  const reload = await servedPage(browser, async ({ url, send }) => url.pathname === "/admin/v2/overview" ? send(200, { ...sampleOverview(url.searchParams.get("range")), stale }) : undefined);
  try {
    await servedSignIn(reload.target);
    await expect(reload.target.locator("#dash-status")).toHaveText("May be out of date");
    stale = false;
    await reload.target.click("#reload-figures");
    await expect(reload.target.locator("#dash-status")).toHaveText("Current");
    await expect(reload.target.locator("#dash-stale")).toBeHidden();
  } finally { await reload.ctx.close(); }

  const delayed = gate();
  const superseded = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname === "/admin/v2/overview" && url.searchParams.get("range") === "12m") { await delayed.promise; return send(200, { ...sampleOverview("12m"), stale: true }); }
    return undefined;
  });
  try {
    await servedSignIn(superseded.target);
    await superseded.target.selectOption("#period-select", "12m");
    await superseded.target.selectOption("#period-select", "90d");
    await expect(superseded.target.locator("#dash-status")).toHaveText("Current");
    delayed.open();
    await expect(superseded.target.locator("#dash-status")).toHaveText("Current");
    await expect(superseded.target.locator("#dash-stale")).toBeHidden();
  } finally { await superseded.ctx.close(); }
});

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

test("14. a late response for an ended session changes nothing in the new session", async ({ browser }) => {
  const release = gate();
  const { ctx, target } = await servedPage(browser, async ({ url, bearer, send }) => {
    if (bearer !== "token-1") return undefined;
    if (url.pathname === "/admin/v2/exclusions") { await release.promise; return send(401, { error: "unauthorized" }); }
    if (url.pathname === "/admin/v2/overview") { await release.promise; return send(200, sampleOverview(url.searchParams.get("range"), 999)); }
    return undefined;
  });
  try {
    await servedSignIn(target);
    await target.click("#signout-button");
    await expect(target.locator("#signin-screen")).toBeVisible();
    await servedSignIn(target);
    await expect(target.locator("#kpi-external-value")).toHaveText("1");
    const late = Promise.all([
      target.waitForResponse((r) => r.url().includes("/v2/exclusions") && r.status() === 401),
      target.waitForResponse((r) => r.url().includes("/v2/overview") && r.request().headers().authorization === "Bearer token-1")
    ]);
    release.open();
    await late;
    await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(target.locator("#dashboard-screen")).toBeVisible();
    await expect(target.locator("#signin-screen")).toBeHidden();
    await expect(target.locator("#kpi-external-value")).toHaveText("1");
    await expect(target.locator("#dash-exclusions-changed")).toHaveText("2026-10-26 23:03 EDT");
  } finally {
    await ctx.close();
  }
});

test("14b. a late network failure for an ended session changes nothing in the new session", async ({ browser }) => {
  const release = gate();
  const { ctx, target } = await servedPage(browser, async ({ url, bearer, abort }) => {
    if (bearer !== "token-1") return undefined;
    if (url.pathname === "/admin/v2/exclusions" || url.pathname === "/admin/v2/overview") {
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
    await expect(target.locator("#kpi-external-value")).toHaveText("1");
    await expect(target.locator("#dash-exclusions-changed")).toHaveText("2026-10-26 23:03 EDT");
    let failed = 0;
    const late = new Promise((resolve) => {
      target.on("requestfailed", (r) => {
        if (/\/v2\/(exclusions|overview)/.test(r.url()) && ++failed === 3) resolve();
      });
    });
    release.open();
    await late;
    await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(target.locator("#dash-exclusions-changed")).toHaveText("2026-10-26 23:03 EDT");
    await expect(target.locator("#dash-unavailable")).toBeHidden();
    await expect(target.locator("#kpi-external-value")).toHaveText("1");
  } finally {
    await ctx.close();
  }
});

test("15. if the exclusions summary cannot be loaded, the page says so and shows no counts", async ({ browser }) => {
  for (const failure of ["status", "network"]) {
    const { ctx, target } = await servedPage(browser, async ({ url, send, abort }) => {
      if (url.pathname !== "/admin/v2/exclusions") return undefined;
      if (failure === "status") return send(500, { error: "internal" });
      return abort();
    });
    try {
      await servedSignIn(target);
      await expect(target.locator("#kpi-external-value")).toHaveText("1");
      await expect(target.locator("#dash-exclusions-changed"), failure).toHaveText("—");
      await target.click('#tabs a[data-tab="settings"]');
      await expect(target.locator("#exclusions-changed-note"), failure).toHaveText("The exclusion counts could not be loaded.");
      for (const id of ["#count-total", "#count-excluded", "#count-external", "#count-created-since"]) await expect(target.locator(id)).toHaveText("—");
    } finally {
      await ctx.close();
    }
  }
});

test("16. while a new period loads, and if it fails, no figures from the old period remain", async ({ browser }) => {
  const release = gate();
  const { ctx, target } = await servedPage(browser, async ({ url, abort }) => {
    if (url.pathname === "/admin/v2/overview" && url.searchParams.get("range") === "12m") {
      await release.promise;
      return abort();
    }
    return undefined;
  });
  try {
    await servedSignIn(target);
    await expect(target.locator("#kpi-records-value")).toHaveText("7");
    await target.selectOption("#period-select", "12m");
    await expect(target.locator("#kpi-records-value"), "old figures removed while loading").toHaveText("—");
    await expect(target.locator("#kpi-external-sub")).toHaveText("Not affected by the period");
    release.open();
    await expect(target.locator("#dash-unavailable")).toBeVisible();
    await expect(target.locator("#kpi-records-value")).toHaveText("—");
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
      await expect(target.locator("#kpi-external-value")).toHaveText("—");
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
    await expect(target.locator("#kpi-external-value")).toHaveText("—");
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
    await expect(target.locator("#kpi-external-value")).toHaveText("—");
    await expect(target.locator("#signin-error")).toHaveText("Ending the session on the server…");
    // A new sign-in cannot start while the logout is unanswered.
    await expect(target.locator("#signin-submit")).toBeDisabled();
    await target.fill("#signin-email", "owner@example.test");
    await target.fill("#signin-password", "x");
    await target.locator("#signin-password").press("Enter");
    await expect(target.locator("#dashboard-screen")).toBeHidden();
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
    await servedSignIn(target, { expectDashboard: false });
    await expect(target.locator("#denied-screen")).toBeVisible();
    await expect(target.locator("#denied-message")).toHaveText("This account (viewer@example.test) does not have owner access. The admin figures are owner only, so none are shown.");
    await expect(target.locator("#dashboard-screen")).toBeHidden();
    await expect(target.locator("#operator-label")).toBeHidden();
    await expect(target.locator("#kpi-external-value")).toHaveText("—");
    const box = await target.locator("#denied-signout").boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    await target.click("#denied-signout");
    await expect(target.locator("#signin-screen")).toBeVisible();
    await expect(target.locator("#denied-screen")).toBeHidden();
    await expect(target.locator("#signin-error")).toHaveText("");
    expect(asked.filter((p) => /v2|metrics|classification/.test(p)), "no figures requested").toEqual([]);
    expect(asked).toContain("/admin/auth/logout");
  } finally {
    await ctx.close();
  }
});

test("21b. a 403 from the figures shows access denied with no figures", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname === "/admin/v2/overview") return send(403, { error: "Insufficient admin role." });
    return undefined;
  });
  try {
    await servedSignIn(target, { expectDashboard: false });
    await expect(target.locator("#denied-screen")).toBeVisible();
    await expect(target.locator("#denied-message")).toHaveText("The server refused this account access to the admin figures. No figures are shown.");
    await expect(target.locator("#dashboard-screen")).toBeHidden();
    await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(target.locator("#kpi-external-value")).toHaveText("—");
    await expect(target.locator("#aud-country .bar-row")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("12. phone width: no sideways scroll and 44px touch targets on every screen", async ({ browser }) => {
  const phone = await browser.newContext({ baseURL: APP_URL, viewport: { width: 375, height: 740 } });
  const target = await phone.newPage();
  try {
    await routeAdminConfig(target);
    // Serve fixed figures so this check needs no further sign-in.
    await target.route(`${API_BASE}/admin/**`, (route) => {
      const url = new URL(route.request().url());
      const q = url.searchParams;
      const bodies = {
        "/admin/auth/login": { token: "test-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        "/admin/auth/me": { email: "a-rather-long-owner-address-for-wrapping@example.test", role: "owner" },
        "/admin/v2/exclusions": SAMPLE_EXCLUSIONS,
        "/admin/v2/status": SAMPLE_STATUS,
        "/admin/v2/overview": sampleOverview(q.get("range")),
        "/admin/v2/timeseries": sampleSeries(q.get("metric"), q.get("bucket"), Number(q.get("periods"))),
        "/admin/v2/breakdown": sampleBreakdown(q.get("dimension"))
      };
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: { ...CORS, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST" } });
      }
      return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(bodies[url.pathname] || {}) });
    });
    await target.goto(PAGE);
    const noSideways = () => target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noSideways(), "sign-in screen").toBe(true);
    await target.fill("#signin-email", "owner@example.test");
    await target.fill("#signin-password", "x");
    await target.click("#signin-submit");
    await expect(target.locator("#aud-country .bar-row").first()).toBeVisible();
    await expect(target.locator("#growth-records_recorded svg")).toBeVisible();
    expect(await noSideways(), "dashboard").toBe(true);
    const tall = async (selectors) => {
      for (const selector of selectors) {
        for (const box of await target.locator(selector).evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().toJSON()))) {
          expect(box.height, `${selector} height`).toBeGreaterThanOrEqual(44);
          expect(box.width, `${selector} width`).toBeGreaterThanOrEqual(44);
        }
      }
    };
    await tall(["#signout-button", "#period-select", "#growth-bucket", "#tabs a", "details.info > summary", ".series-details > summary"]);
    for (const hash of ["#settings/exclusions", "#settings/quality", "#settings/detail", "#settings/methodology"]) {
      await target.evaluate((h) => { location.hash = h; }, hash);
      await target.waitForTimeout(150);
      expect(await noSideways(), hash).toBe(true);
    }
    await target.evaluate(() => { location.hash = "#settings/detail"; });
    await expect(target.locator("#detail-table tbody tr").first()).toBeVisible();
    expect(await noSideways(), "operator detail with figures").toBe(true);
    await tall([".subtabs a", "#detail-range"]);
    await target.evaluate(() => { location.hash = "#settings/exclusions"; });
    await tall(["#exclude-phone", "#exclude-action", "#exclude-preview"]);
    await target.evaluate(() => { location.hash = "#settings/quality"; });
    await tall(["#refresh-button"]);
    await target.click("#signout-button");
    await expect(target.locator("#signin-screen")).toBeVisible();
    expect(await noSideways(), "sign-in after sign out").toBe(true);
    for (const selector of ["#signin-email", "#signin-password", "#signin-submit"]) {
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
  const catchAll = main.routes.findIndex((r) => r.src === "/(.*)" && r.dest);
  expect(block, "main site has a 404 route for /admin").toBeGreaterThanOrEqual(0);
  expect(block, "the 404 route comes before the catch-all").toBeLessThan(catchAll);
});

// ---- B2: version safety, charts, audience, settings ----------------------------------

test("D1. an older server or a different version shows no figures, only the out-of-step notice", async ({ browser }) => {
  for (const [label, answer] of [
    ["older server: no /admin/v2 routes", ({ send }) => send(404, { message: "Route GET:/admin/v2/overview not found" })],
    ["retired route", ({ send }) => send(410, { error: "client_outdated", api_version: 1 })],
    ["realistic version-2 response", ({ url, send }) => send(200, sampleVersion2Overview(url.searchParams.get("range")))],
    ["version missing", ({ url, send }) => { const body = sampleOverview(url.searchParams.get("range")); delete body.api_version; return send(200, body); }],
    ["recorded figure with no basis", ({ url, send }) => {
      const body = sampleOverview(url.searchParams.get("range"));
      delete body.metrics.find((item) => item.key === "records_recorded").date_basis;
      return send(200, body);
    }],
    ["recorded figure with the wrong basis", ({ url, send }) => {
      const body = sampleOverview(url.searchParams.get("range"));
      body.metrics.find((item) => item.key === "records_recorded").date_basis = "server_issued";
      return send(200, body);
    }]
  ]) {
    const { ctx, target } = await servedPage(browser, async (ctxArgs) => (ctxArgs.url.pathname === "/admin/v2/overview" ? answer(ctxArgs) : undefined));
    try {
      await servedSignIn(target);
      await expect(target.locator("#version-mismatch"), label).toBeVisible();
      await expect(target.locator("#version-mismatch")).toHaveText("This page and the server are out of step. Reload the page. No figures are shown.");
      await expect(target.locator("#dash-status")).toHaveText("Unavailable");
      await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
      for (const id of ["#kpi-external-value", "#kpi-submitting-value", "#kpi-records-value", "#dash-exclusions-changed"]) await expect(target.locator(id), `${label} ${id}`).toHaveText("—");
      await expect(target.locator(".bar-row, .chart svg")).toHaveCount(0);
      await target.selectOption("#period-select", "12m");
      await target.evaluate(() => { location.hash = "#settings/detail"; });
      await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
      await expect(target.locator("#detail-table tbody tr")).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  }
});

test("D1a. a version-3 timeseries metric with no date basis shows no figures", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname !== "/admin/v2/timeseries") return undefined;
    const body = sampleSeries(url.searchParams.get("metric"), url.searchParams.get("bucket"), Number(url.searchParams.get("periods")));
    delete body.metric.date_basis;
    return send(200, body);
  });
  try {
    await servedSignIn(target);
    await expect(target.locator("#version-mismatch")).toBeVisible();
    await expect(target.locator("#version-mismatch")).toHaveText("This page and the server are out of step. Reload the page. No figures are shown.");
    await expect(target.locator("#dash-status")).toHaveText("Unavailable");
    for (const id of ["#kpi-external-value", "#kpi-submitting-value", "#kpi-records-value"]) {
      await expect(target.locator(id)).toHaveText("—");
    }
    await expect(target.locator(".bar-row, .chart svg")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("D2. growth charts mark only the current period as in progress, in chart and table", async ({ browser }) => {
  const asked = [];
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    asked.push(url.pathname + url.search);
    if (url.pathname !== "/admin/v2/timeseries") return undefined;
    // One empty month, so zero bars are checked too.
    const data = sampleSeries(url.searchParams.get("metric"), url.searchParams.get("bucket"), Number(url.searchParams.get("periods")));
    data.periods[1] = { ...data.periods[1], external: 0, total: data.periods[1].excluded };
    return send(200, data);
  });
  try {
    await servedSignIn(target);
    for (const metric of ["accounts_registered", "records_recorded"]) {
      const panel = target.locator(`#growth-${metric}`);
      await expect(panel.locator("rect.bar")).toHaveCount(12);
      await expect(panel.locator("rect.bar.partial")).toHaveCount(1);
      await expect(panel.locator("rect.bar").last()).toHaveClass(/partial/);
      await expect(panel.locator("tbody tr")).toHaveCount(12);
      await expect(panel.locator("thead th")).toHaveText(["Month starting", metric === "accounts_registered" ? "New accounts" : "Records recorded"]);
      await expect(panel.locator("tbody tr").last().locator("td").first()).toContainText("in progress");
      await expect(panel.locator("tbody tr td:first-child", { hasText: "in progress" })).toHaveCount(1);
      await expect(panel.locator("tbody tr").first().locator("td.num")).toHaveText("1");
      await expect(panel).toContainText("does not mean a decline");
      // The current period is filled (lighter, dashed edge), never drawn as an empty outline.
      const partialStyle = await panel.locator("rect.bar.partial").evaluate((bar) => {
        const style = getComputedStyle(bar);
        return { fill: style.fill, opacity: Number(style.fillOpacity), dash: style.strokeDasharray };
      });
      expect(partialStyle.fill).not.toBe("none");
      expect(partialStyle.opacity).toBeGreaterThan(0.2);
      expect(partialStyle.opacity).toBeLessThan(1);
      expect(partialStyle.dash).not.toBe("none");
      // Every non-zero bar carries its number, matching the table; zero bars carry none.
      const tableValues = await panel.locator("tbody tr").evaluateAll((rows) => rows.map((row) => [row.dataset.period, row.querySelector("td.num").textContent]));
      const printed = await panel.locator("text.value").evaluateAll((labels) => labels.map((label) => [label.dataset.period, label.textContent]));
      expect(printed).toEqual(tableValues.filter(([, value]) => value !== "0"));
      expect(printed.some(([period]) => period === tableValues.at(-1)[0])).toBe(tableValues.at(-1)[1] !== "0");
    }
    await target.selectOption("#growth-bucket", "week");
    await expect(target.locator("#growth-records_recorded rect.bar")).toHaveCount(26);
    await expect(target.locator("#growth-records_recorded rect.bar.partial")).toHaveCount(1);
    expect(asked).toContain("/admin/v2/timeseries?metric=records_recorded&bucket=week&periods=26");
  } finally {
    await ctx.close();
  }
});

test("D3. audience bars show labelled categories; withheld reasons are distinct and never zero", async ({ browser }) => {
  const results = {
    country: sampleBreakdown("country", { status: "withheld", reason: "total_below_minimum", total: { status: "fewer_than_k" } }, 10),
    sector: sampleBreakdown("sector", { status: "withheld", reason: "valid_codes_below_half", total: { status: "published", value: 12 } }, 10),
    business_type: sampleBreakdown("business_type", { status: "withheld", reason: "business_profiles_below_half", total: { status: "published", value: 12 } }, 10)
  };
  const withheld = await servedPage(browser, async ({ url, send }) => (url.pathname === "/admin/v2/breakdown" ? send(200, results[url.searchParams.get("dimension")]) : undefined));
  try {
    await servedSignIn(withheld.target);
    await expect(withheld.target.locator("#aud-country .withheld")).toHaveText("Withheld — fewer than 10 registered accounts in total.");
    await expect(withheld.target.locator("#aud-sector .withheld")).toHaveText("Withheld — fewer than half of registered accounts have a valid profile sector code.");
    await expect(withheld.target.locator("#aud-business_type .withheld")).toHaveText("Withheld — fewer than half of registered accounts have a business profile.");
    for (const dimension of ["country", "sector", "business_type"]) {
      await expect(withheld.target.locator(`#aud-${dimension} .bar-row`)).toHaveCount(0);
      await expect(withheld.target.locator(`#aud-${dimension} .breakdown-body`)).not.toContainText(/\b0\b/);
    }
  } finally {
    await withheld.ctx.close();
  }
  const published = await servedPage(browser, async () => undefined);
  try {
    await servedSignIn(published.target);
    const t = published.target;
    await expect(t.locator("#aud-country .bar-row .bar-label")).toHaveText(["Nigeria (NG)"]);
    await expect(t.locator("#aud-sector .bar-row .bar-label")).toHaveText(["Trade & Retail"]);
    await expect(t.locator("#aud-business_type .bar-row .bar-label")).toHaveText(["Market Trader (NG)", "Other (combined)"]);
    await expect(t.locator("#aud-country .bar-row .bar-count")).toHaveText(["7"]);
    await expect(t.locator("#aud-country")).toContainText("Showing the 10 largest categories that have 2 or more users.");
    await expect(t.locator("#aud-country")).toContainText("Owner view only. These counts include small groups and are not for external publication or sharing.");
    await expect(t.locator("#aud-country")).toContainText("Total registered accounts: 7");
    await expect(t.locator("#audience-title")).toHaveText("Audience — current profiles of registered accounts");
    await expect(t.locator("#dashboard-screen")).toContainText("not affected by the period");
    const widths = await t.locator("#aud-country .fill").evaluateAll((els) => els.map((e) => e.style.width));
    expect(widths).toEqual(["100%"]);
    await t.locator("#aud-country details.info > summary").click();
    await expect(t.locator("#aud-country .dim-statement")).toHaveText("Country is the stored code. Provenance statement.");
  } finally {
    await published.ctx.close();
  }
});

test("D3a. country bars show top-policy categories in count order and label missing or invalid codes", async ({ browser }) => {
  const results = {
    country: sampleBreakdown("country", { status: "published", cells: [
      { category: "US", count: 3 }, { category: "GB", count: 2 },
      { category: "NG", count: 2 }, { category: "no_valid_code", count: 1 }
    ], total: 8 }),
    sector: sampleBreakdown("sector"),
    business_type: sampleBreakdown("business_type")
  };
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => (
    url.pathname === "/admin/v2/breakdown" ? send(200, results[url.searchParams.get("dimension")]) : undefined
  ));
  try {
    await servedSignIn(target);
    await expect(target.locator("#aud-country .bar-row .bar-label")).toHaveText([
      "United States (US)", "United Kingdom (GB)", "Nigeria (NG)", "No country"
    ]);
    await expect(target.locator("#aud-country")).toContainText("Showing the 10 largest categories that have 2 or more users.");
  } finally {
    await ctx.close();
  }
});

test("D4. the period changes only the activity figures; audience and growth are not re-fetched", async ({ browser }) => {
  const asked = [];
  const { ctx, target } = await servedPage(browser, async ({ url }) => { asked.push(url.pathname); return undefined; });
  try {
    await servedSignIn(target);
    await expect(target.locator("#aud-country .bar-row").first()).toBeVisible();
    const before = asked.length;
    await target.selectOption("#period-select", "30d");
    await expect(target.locator("#kpi-external-sub")).toHaveText("Not affected by the period");
    await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(asked.slice(before)).toEqual(["/admin/v2/overview", "/admin/v2/overview"]);
  } finally {
    await ctx.close();
  }
});

test("D5. rebuild asks first and reports rebuilt, already rebuilding, limit, failure and unconfirmed distinctly", async ({ browser }) => {
  const outcomes = [
    [(send) => send(200, { ...SAMPLE_STATUS, rebuilt: true, built_at: "2026-10-28T01:02:00.000Z", as_of: "2026-10-28T01:02:00.000Z" }), "Rebuilt. Figures as of 2026-10-27 21:02 EDT."],
    [(send) => send(200, { ...SAMPLE_STATUS, rebuilt: false, reason: "in_progress" }), "Already rebuilding. Check again shortly."],
    [(send) => send(429, { error: "Too Many Requests" }), "Refresh limit reached (6 per hour)."],
    [(send) => send(200, { ...SAMPLE_STATUS, rebuilt: false, reason: "failed" }), "Rebuild failed."],
    [(send) => send(500, { error: "internal", api_version: 3 }), "Rebuild failed."],
    [(send, abort) => abort(), "Outcome unconfirmed — reload the status to see whether the figures were rebuilt."]
  ];
  let index = 0;
  const refreshes = [];
  const { ctx, target } = await servedPage(browser, async ({ url, send, abort }) => {
    if (url.pathname !== "/admin/v2/refresh") return undefined;
    refreshes.push(index);
    return outcomes[index][0](send, abort);
  });
  try {
    await servedSignIn(target);
    await target.evaluate(() => { location.hash = "#settings/quality"; });
    await expect(target.locator("#q-out-of-range")).toHaveText("2");
    await expect(target.locator("div:has(> #q-out-of-range) > dt")).toHaveText("Source rows outside the rollup date range");
    await expect(target.locator("#settings-quality")).toContainText("It is a count of rows, not of accounts or records.");
    await expect(target.locator("#settings-quality")).not.toContainText(/records outside the range/i);
    await target.click("#refresh-button");
    await expect(target.locator("#refresh-confirm")).toBeVisible();
    await target.click("#refresh-cancel");
    expect(refreshes).toEqual([]);
    for (index = 0; index < outcomes.length; index += 1) {
      await target.click("#refresh-button");
      await target.click("#refresh-go");
      await expect(target.locator("#refresh-message"), String(index)).toHaveText(outcomes[index][1]);
      await expect(target.locator("#refresh-button")).toBeEnabled();
    }
    expect(refreshes).toEqual([0, 1, 2, 3, 4, 5]);
  } finally {
    await ctx.close();
  }
});

test("D6. methodology carries the API definitions, the statements and the activation note", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async () => undefined);
  try {
    await servedSignIn(target);
    const chartNote = target.locator("section", { has: target.locator("#growth-title") }).locator(":scope > p.muted");
    await expect(chartNote).not.toContainText("counted when the server receives");
    await expect(chartNote).toContainText("Records are placed in the month they were recorded on the device.");
    await expect(chartNote).toContainText("Activity on a phone that has not synced is not seen until it syncs.");
    await expect(target.locator("#dashboard-screen")).not.toContainText("counted when the server receives");
    await target.evaluate(() => { location.hash = "#settings/methodology"; });
    const timing = target.locator("#settings-methodology h3", { hasText: "Timing" }).locator("xpath=following-sibling::p[1]");
    await expect(timing).toContainText("Activity on a phone that has not synced is not seen until it syncs.");
    await expect(target.locator("#method-definitions dt")).toHaveText(["Accounts registered", "Records recorded", "Accounts submitting records", "Devices in ACTIVE registration status"]);
    await expect(target.locator("#method-definitions dd").first()).toHaveText("Accounts registered definition.");
    await expect(target.locator("#method-statements li", { hasText: "Counts all accounts except" })).toHaveCount(1);
    await expect(target.locator("#method-statements li", { hasText: "Provenance statement." })).toHaveCount(3);
    await expect(target.locator("#activation-note")).toBeVisible();
    await expect(target.locator("#settings-methodology")).toContainText("Payment, records or activity are not required.");
  } finally {
    await ctx.close();
  }
});

test("D7. headline info tips open to one short definition", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async () => undefined);
  try {
    await servedSignIn(target);
    await expect(target.locator("#kpi-submitting-def")).toBeHidden();
    await target.locator("#kpi-submitting details.info > summary").click();
    await expect(target.locator("#kpi-submitting-def")).toHaveText("Accounts submitting records definition.");
    await expect(target.locator("#kpi-external-def")).toContainText("Payment, records or activity are not required.");
  } finally {
    await ctx.close();
  }
});

test("D8. business-type labels match the app catalog", async () => {
  const { buildCatalogLabelsSource } = await import("../../../tools/admin/build-catalog-labels.mjs");
  const current = await readFile(ADMIN_DIR + "catalog-labels.js", "utf8");
  expect(current, "run node tools/admin/build-catalog-labels.mjs").toBe(buildCatalogLabelsSource());
});

test("D9. figures still being built (503) are asked for once more and then shown", async ({ browser }) => {
  const seen = {};
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname !== "/admin/v2/overview") return undefined;
    const key = url.searchParams.get("range");
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] === 1) return send(503, { error: "metrics_unavailable", api_version: 3, as_of: null, stale: true });
    return undefined;
  });
  try {
    await servedSignIn(target);
    await expect(target.locator("#kpi-external-value")).toHaveText("1", { timeout: 5000 });
    await expect(target.locator("#dash-unavailable")).toBeHidden();
    expect(seen).toEqual({ all: 2, "90d": 2 });
  } finally {
    await ctx.close();
  }
});

test("D10. an older exclusions or status answer never replaces a newer one in the same session", async ({ browser }) => {
  const firstExclusions = gate();
  const firstStatus = gate();
  let exclusionCalls = 0;
  let statusCalls = 0;
  const NEWER = "2026-10-28T02:10:00.000Z";
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname === "/admin/v2/exclusions") {
      exclusionCalls += 1;
      if (exclusionCalls === 1) { await firstExclusions.promise; return send(200, SAMPLE_EXCLUSIONS); }
      return send(200, { ...SAMPLE_EXCLUSIONS, accounts: { external: 11, excluded: 4, total: 15 }, exclusions_last_changed: NEWER });
    }
    if (url.pathname === "/admin/v2/status") {
      statusCalls += 1;
      if (statusCalls === 1) { await firstStatus.promise; return send(200, SAMPLE_STATUS); }
      return send(200, { ...SAMPLE_STATUS, built_at: NEWER, as_of: NEWER });
    }
    if (url.pathname === "/admin/v2/refresh") return send(200, { ...SAMPLE_STATUS, rebuilt: true, built_at: NEWER, as_of: NEWER });
    return undefined;
  });
  try {
    await servedSignIn(target);
    // The dashboard's exclusions request is held; opening Settings asks again and gets the newer answer.
    await target.evaluate(() => { location.hash = "#settings/exclusions"; });
    await expect(target.locator("#count-external")).toHaveText("11");
    const oldExclusions = target.waitForResponse((r) => r.url().includes("/v2/exclusions") && exclusionCalls === 2);
    firstExclusions.open();
    await oldExclusions;
    await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(target.locator("#count-external")).toHaveText("11");
    await expect(target.locator("#count-excluded")).toHaveText("4");
    await expect(target.locator("#dash-exclusions-changed")).toHaveText("2026-10-27 22:10 EDT");

    // The Quality tab's status request is held; a completed rebuild asks again and gets the newer answer.
    await target.evaluate(() => { location.hash = "#settings/quality"; });
    await expect.poll(() => statusCalls).toBe(1);
    await target.click("#refresh-button");
    await target.click("#refresh-go");
    await expect(target.locator("#q-built-at")).toHaveText("2026-10-27 22:10 EDT");
    const oldStatus = target.waitForResponse((r) => r.url().includes("/v2/status") && statusCalls === 2);
    firstStatus.open();
    await oldStatus;
    await target.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(target.locator("#q-built-at")).toHaveText("2026-10-27 22:10 EDT");
  } finally {
    await ctx.close();
  }
});

test("D11. sector categories: every business in a sector, no business profile apart, defaults counted only in Data quality", async ({ browser }) => {
  const results = {
    sector: sampleBreakdown("sector", { status: "published", cells: [
      { category: "trade_retail", count: 3 }, { category: "agriculture", count: 2 },
      { category: "transport_logistics", count: 2 }, { category: "no_business_profile", count: 1 }
    ], total: 8 }),
    business_type: sampleBreakdown("business_type", { status: "published", cells: [
      { category: "no_business_profile", count: 6 }, { category: "no_valid_code", count: 5 }, { category: "unlisted", count: 5 }
    ], total: 16 }),
    country: sampleBreakdown("country", { status: "withheld", reason: "business_profiles_below_half", total: { status: "published", value: 12 } })
  };
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => (url.pathname === "/admin/v2/breakdown" ? send(200, results[url.searchParams.get("dimension")]) : undefined));
  try {
    await servedSignIn(target);
    await expect(target.locator("#aud-sector .bar-row .bar-label")).toHaveText(["Trade & Retail", "Agriculture, Livestock & Fishing", "Transport & Logistics", "No business profile"]);
    await expect(target.locator("#aud-sector")).toContainText("Showing the 10 largest categories that have 2 or more users.");
    await expect(target.locator("#aud-business_type .bar-row .bar-label")).toHaveText(["No business profile", "No business type", "Not listed in the catalog"]);
    await expect(target.locator("#aud-country .withheld")).toHaveText("Withheld — fewer than half of registered accounts have a business profile.");
    await expect(target.locator("#dashboard-screen")).not.toContainText(/not yet categori[sz]ed|by default/i);

    await target.evaluate(() => { location.hash = "#settings/quality"; });
    for (const [id, value] of [["q-sector-catalog", "9"], ["q-sector-user", "3"], ["q-sector-rule", "0"], ["q-sector-fallback", "4"], ["q-sector-mismatch", "0"]]) {
      await expect(target.locator(`#${id}`)).toHaveText(value);
    }
    await expect(target.locator("div:has(> #q-sector-fallback) > dt")).toHaveText("Registered-user business profiles: Other business by default (not confirmed)");

    // The "not an official classification" explanation appears once, in Methodology.
    const mentions = await target.evaluate(() => document.body.textContent.split("not an official industry classification").length - 1);
    expect(mentions).toBe(1);
    await expect(target.locator("#settings-methodology")).toContainText("not an official industry classification");
    await expect(target.locator("#settings-methodology")).toContainText("Country, sector and business type use the same owner-view policy: the 10 largest categories with 2 or more users are shown, and smaller or remaining categories are combined as \"Other\". Withheld figures are never shown as zero.");
  } finally {
    await ctx.close();
  }
});

test("D11a. reload re-reads dashboard figures without rebuilding, and its controls fit a phone viewport", async ({ browser }) => {
  const asked = [];
  const { ctx, target } = await servedPage(browser, async ({ url }) => { asked.push(url.pathname); return undefined; });
  try {
    await servedSignIn(target);
    await expect(target.locator("#dash-status")).toHaveText("Current");
    const before = asked.length;
    await target.click("#reload-figures");
    await expect(target.locator("#reload-figures")).toBeEnabled();
    const reread = asked.slice(before);
    expect(reread.filter((path) => path === "/admin/v2/overview")).toHaveLength(2);
    expect(reread.filter((path) => path === "/admin/v2/timeseries")).toHaveLength(2);
    expect(reread.filter((path) => path === "/admin/v2/breakdown")).toHaveLength(3);
    expect(reread).not.toContain("/admin/v2/refresh");
    await target.setViewportSize({ width: 375, height: 800 });
    expect(await target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await target.locator("#dash-status").focus();
    await expect(target.locator("#dash-status")).toBeFocused();
    await target.locator("#reload-figures").focus();
    await expect(target.locator("#reload-figures")).toBeFocused();
  } finally {
    await ctx.close();
  }
});

test("D11b. a failed activity figure remains unavailable when only growth reloads", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname === "/admin/v2/overview" && url.searchParams.get("range") === "12m") {
      return send(503, { error: "metrics_unavailable", api_version: 3, as_of: null, stale: true });
    }
    return undefined;
  });
  try {
    await servedSignIn(target);
    await target.selectOption("#period-select", "12m");
    await expect(target.locator("#dash-unavailable")).toBeVisible();
    await expect(target.locator("#dash-status")).toHaveText("Unavailable");
    await target.selectOption("#growth-bucket", "week");
    await expect(target.locator("#dash-unavailable")).toBeVisible();
    await expect(target.locator("#dash-status")).toHaveText("Unavailable");
  } finally {
    await ctx.close();
  }
});

test("D11g. an unavailable activity overview does not claim that normal growth figures are absent", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname === "/admin/v2/overview" && url.searchParams.get("range") === "12m") {
      return send(503, { error: "metrics_unavailable", api_version: 3, as_of: null, stale: true });
    }
    return undefined;
  });
  try {
    await servedSignIn(target);
    await target.selectOption("#period-select", "12m");
    await expect(target.locator("#dash-unavailable")).toHaveText("Activity figures are unavailable right now. None are shown.");
    await expect(target.locator("#dash-status")).toHaveText("Unavailable");
    for (const id of ["#kpi-external-value", "#kpi-new-value", "#kpi-submitting-value", "#kpi-records-value"]) await expect(target.locator(id)).toHaveText("—");
    await expect(target.locator("#growth-accounts_registered svg")).toBeVisible();
    await expect(target.locator("#growth-records_recorded svg")).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test("D11c. a growth failure survives an activity-only reload until growth succeeds", async ({ browser }) => {
  let failWeek = true;
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    if (failWeek && url.pathname === "/admin/v2/timeseries" && url.searchParams.get("bucket") === "week") {
      return send(503, { error: "metrics_unavailable", api_version: 3, as_of: null, stale: true });
    }
    return undefined;
  });
  try {
    await servedSignIn(target);
    await target.selectOption("#growth-bucket", "week");
    await expect(target.locator("#growth-accounts_registered .withheld")).toHaveText("Unavailable right now.");
    await expect(target.locator("#dash-status")).toHaveText("Unavailable");
    await target.selectOption("#period-select", "12m");
    await expect(target.locator("#dash-status")).toHaveText("Unavailable");
    await expect(target.locator("#growth-records_recorded .withheld")).toHaveText("Unavailable right now.");
    failWeek = false;
    await target.selectOption("#growth-bucket", "month");
    await expect(target.locator("#growth-accounts_registered .withheld")).toHaveCount(0);
    await expect(target.locator("#dash-status")).toHaveText("Current");
  } finally {
    await ctx.close();
  }
});

test("D11d. audience loading keeps the chip updating until every figure settles", async ({ browser }) => {
  const release = gate();
  let delayAudience = false;
  const { ctx, target } = await servedPage(browser, async ({ url }) => {
    if (delayAudience && url.pathname === "/admin/v2/breakdown") await release.promise;
    return undefined;
  });
  try {
    await servedSignIn(target);
    delayAudience = true;
    await target.click("#reload-figures");
    await expect(target.locator("#kpi-records-value")).toHaveText("7");
    await expect(target.locator("#dash-status")).toHaveText("Updating…");
    release.open();
    await expect(target.locator("#reload-figures")).toBeEnabled();
    await expect(target.locator("#dash-status")).toHaveText("Current");
  } finally {
    await ctx.close();
  }
});

test("D11e. a stale activity figure stays stale when only growth reloads", async ({ browser }) => {
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname === "/admin/v2/overview" && url.searchParams.get("range") === "12m") {
      return send(200, { ...sampleOverview("12m"), stale: true });
    }
    return undefined;
  });
  try {
    await servedSignIn(target);
    await target.selectOption("#period-select", "12m");
    await expect(target.locator("#dash-stale")).toBeVisible();
    await expect(target.locator("#dash-status")).toHaveText("May be out of date");
    await target.selectOption("#growth-bucket", "week");
    await expect(target.locator("#dash-status")).toHaveText("May be out of date");
  } finally {
    await ctx.close();
  }
});

test("D11f. a superseded activity response cannot change the chip or figures", async ({ browser }) => {
  const release = gate();
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => {
    if (url.pathname === "/admin/v2/overview" && url.searchParams.get("range") === "12m") {
      await release.promise;
      return send(200, { ...sampleOverview("12m", 999), stale: true });
    }
    return undefined;
  });
  try {
    await servedSignIn(target);
    await target.selectOption("#period-select", "12m");
    await target.selectOption("#period-select", "90d");
    await expect(target.locator("#kpi-new-value")).toHaveText("1");
    await expect(target.locator("#dash-status")).toHaveText("Current");
    release.open();
    await expect(target.locator("#kpi-new-value")).toHaveText("1");
    await expect(target.locator("#dash-status")).toHaveText("Current");
  } finally {
    await ctx.close();
  }
});

test("D12. an older server without sector counts shows dashes, never zeros", async ({ browser }) => {
  const { sector_assignment: _omit, ...older } = SAMPLE_STATUS;
  const { ctx, target } = await servedPage(browser, async ({ url, send }) => (url.pathname === "/admin/v2/status" ? send(200, older) : undefined));
  try {
    await servedSignIn(target);
    await target.evaluate(() => { location.hash = "#settings/quality"; });
    await expect(target.locator("#q-out-of-range")).toHaveText("2");
    for (const id of ["q-sector-catalog", "q-sector-user", "q-sector-rule", "q-sector-fallback", "q-sector-mismatch"]) {
      await expect(target.locator(`#${id}`)).toHaveText("—");
    }
  } finally {
    await ctx.close();
  }
});
