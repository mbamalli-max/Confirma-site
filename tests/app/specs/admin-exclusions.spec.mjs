import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { API_BASE, mintSession, seedOwner, withDb } from "./admin-helpers.mjs";

// Settings › Exclusions (A1 tool adapted in B2), navigation and the website look.
// Sign-in is answered with a genuine minted session (see mintSession), so every
// classification request below reaches the real server unless a test says otherwise.

const ADMIN_DIR = fileURLToPath(new URL("../../../admin/", import.meta.url));
const APP_URL = process.env.APP_TEST_URL || "http://127.0.0.1:5500";
const PAGE = "/admin/index.html";
const CORS = { "access-control-allow-origin": APP_URL, "content-type": "application/json" };
const PREFLIGHT = { ...CORS, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST" };
const UNCONFIRMED = "Outcome unconfirmed — the change may or may not have been saved. Preview the same account again to see its current status.";

test.describe.configure({ mode: "serial" });

let owner;

test.beforeAll(async () => {
  owner = await seedOwner("classify-owner@example.test");
});

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

let phoneSerial = 0;
async function seedAccount() {
  phoneSerial += 1;
  const phone = `+1555${String(Date.now()).slice(-5)}${String(phoneSerial).padStart(2, "0")}`;
  const result = await withDb((db) => db.query(
    "INSERT INTO users (phone_number, email) VALUES ($1, $2) RETURNING id",
    [phone, `classify-${phoneSerial}-${Date.now()}@example.test`]
  ));
  return { phone, id: result.rows[0].id };
}

async function savedClass(userId) {
  const result = await withDb((db) => db.query(
    "SELECT classification, reason_code FROM account_classification WHERE user_id = $1", [userId]
  ));
  return result.rows[0] || null;
}

// Opens the page signed in as the owner. extra(page) may add routes; routes added
// later take precedence over the login route.
async function ownerPage(browser, { extra, configExtra = "", viewport } = {}) {
  const ctx = await browser.newContext({ baseURL: APP_URL, ...(viewport ? { viewport } : {}) });
  const page = await ctx.newPage();
  const sent = [];
  page.on("request", (request) => sent.push({ method: request.method(), url: request.url(), body: request.postData() || "" }));
  await page.route("**/admin/config.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `export const API_BASE = "${API_BASE}";\nexport const LOGOUT_TIMEOUT_MS = 1500;\n${configExtra}`
  }));
  await page.route(`${API_BASE}/admin/auth/login`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: PREFLIGHT });
    return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(await mintSession(owner)) });
  });
  if (extra) await extra(page);
  await page.goto(PAGE);
  await signIn(page);
  return { ctx, page, sent };
}

async function signIn(page) {
  await page.fill("#signin-email", owner.email);
  await page.fill("#signin-password", "x");
  await page.fill("#signin-totp", "123456");
  await page.click("#signin-submit");
  await expect(page.locator("#app-shell")).toBeVisible();
}

async function openClassify(page) {
  await page.click('#tabs a[data-tab="settings"]');
  await expect(page.locator("#settings-exclusions")).toBeVisible();
  await expect(page.locator("#count-total")).not.toHaveText("—");
}

async function preview(page, phone, action) {
  await page.fill("#exclude-phone", phone);
  await page.selectOption("#exclude-action", action);
  await page.click("#exclude-preview");
}

async function progress(page) {
  const read = async (id) => Number(await page.locator(id).textContent());
  return { external: await read("#count-external"), excluded: await read("#count-excluded"), total: await read("#count-total") };
}

// Answers one endpoint itself; everything else goes to the real server.
function serve(path, handler) {
  return (page) => page.route(`${API_BASE}${path}`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: PREFLIGHT });
    return handler(route);
  });
}

const PREVIEW_OK = {
  account: { created_on: "2026-09-14", confirmed_records: 0 },
  current_classification: null, target_classification: "INTERNAL_TEST",
  reason_code: "OPERATOR_TEST_ACCOUNT", confirmation_token: "a".repeat(64),
  expires_at: new Date(Date.now() + 300_000).toISOString()
};

test("C1. the action list offers the three exclusions and restore; an incomplete form sends nothing", async ({ browser }) => {
  const { ctx, page, sent } = await ownerPage(browser);
  try {
    await openClassify(page);
    const options = await page.locator("#exclude-action option").evaluateAll((list) => list.map((o) => [o.value, o.textContent]).filter(([v]) => v));
    expect(options).toEqual([
      ["EXCLUDE_TEST", "Exclude — internal test account"],
      ["EXCLUDE_DEMO", "Exclude — demo account"],
      ["EXCLUDE_ADMIN", "Exclude — administrator's own app account"],
      ["RESTORE", "Restore — count as External"]
    ]);
    await page.fill("#exclude-phone", "+15550000000");
    await page.click("#exclude-preview");
    await expect(page.locator("#exclude-message")).toHaveText("Enter the phone number and choose an action.");
    await page.fill("#exclude-phone", "");
    await page.selectOption("#exclude-action", "EXCLUDE_TEST");
    await page.click("#exclude-preview");
    await expect(page.locator("#exclude-message")).toHaveText("Enter the phone number and choose an action.");
    expect(sent.filter((r) => r.url.includes("/classification/preview"))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("C2. the typed number is cleared and kept nowhere; it is sent only to the preview request", async ({ browser }) => {
  const account = { phone: "+15557771234" };
  const { ctx, page, sent } = await ownerPage(browser, { extra: serve("/admin/classification/preview", (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(PREVIEW_OK) })) });
  try {
    await openClassify(page);
    await preview(page, account.phone, "EXCLUDE_TEST");
    await expect(page.locator("#exclude-confirm")).toBeVisible();
    await expect(page.locator("#exclude-phone")).toHaveValue("");
    const digits = account.phone.slice(1);
    const kept = await page.evaluate(async (needle) => ({
      dom: document.documentElement.outerHTML.includes(needle)
        || [...document.querySelectorAll("input")].some((i) => i.value.includes(needle)),
      url: location.href.includes(needle),
      local: localStorage.length, session: sessionStorage.length,
      indexedDb: indexedDB.databases ? (await indexedDB.databases()).length : 0,
      cookie: document.cookie
    }), digits);
    expect(kept).toEqual({ dom: false, url: false, local: 0, session: 0, indexedDb: 0, cookie: "" });
    const carrying = sent.filter((r) => r.url.includes(digits) || r.body.includes(digits));
    expect(carrying.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["POST /admin/classification/preview"]);
    await page.click("#exclude-cancel");
    await expect(page.locator("#exclude-message")).toHaveText("Cancelled. Nothing was changed.");
  } finally {
    await ctx.close();
  }
});

test("C3. an account with no row and no records is External; excluding it moves it, restoring brings it back", async ({ browser }) => {
  const account = await seedAccount();
  const { ctx, page } = await ownerPage(browser);
  try {
    const api = async (method, path) => {
      const { token } = await mintSession(owner);
      const res = await fetch(API_BASE + path, { method, headers: { Authorization: `Bearer ${token}` } });
      return res.json();
    };
    const figure = (body, key) => body.metrics.find((m) => m.key === key);
    await api("POST", "/admin/v2/refresh");
    const before = await api("GET", "/admin/v2/overview?range=all");
    await openClassify(page);
    const start = await progress(page);
    await preview(page, account.phone, "EXCLUDE_TEST");
    await expect(page.locator("#preview-records")).toHaveText("0");
    await expect(page.locator("#preview-current")).toHaveText("External");
    await expect(page.locator("#preview-target")).toHaveText("Excluded — internal test");
    await expect(page.locator("#preview-reason")).toHaveText("Internal test account");
    await page.click("#exclude-confirm-button");
    await expect(page.locator("#exclude-message")).toHaveText("Saved: Excluded — internal test. Figures update when they are next rebuilt.");
    expect(await savedClass(account.id)).toEqual({ classification: "INTERNAL_TEST", reason_code: "OPERATOR_TEST_ACCOUNT" });
    await expect.poll(() => progress(page)).toEqual({ external: start.external - 1, excluded: start.excluded + 1, total: start.total });
    await expect(page.locator("#exclusions-changed-note")).toContainText("Exclusions last changed");
    await api("POST", "/admin/v2/refresh");
    const after = await api("GET", "/admin/v2/overview?range=all");
    expect(figure(after, "accounts_registered").external).toBe(figure(before, "accounts_registered").external - 1);
    expect(figure(after, "accounts_registered").total).toBe(figure(before, "accounts_registered").total);
    expect(figure(after, "accounts_with_records").external, "records are not involved").toBe(figure(before, "accounts_with_records").external);
    await preview(page, account.phone, "RESTORE");
    await expect(page.locator("#preview-target")).toHaveText("External");
    await page.click("#exclude-confirm-button");
    await expect(page.locator("#exclude-message")).toHaveText("Saved: External. Figures update when they are next rebuilt.");
    expect(await savedClass(account.id)).toBeNull();
    await expect.poll(() => progress(page)).toEqual(start);
  } finally {
    await ctx.close();
  }
});

test("C4. demo and administrator exclusions are saved with their own reasons", async ({ browser }) => {
  const account = await seedAccount();
  const { ctx, page } = await ownerPage(browser);
  try {
    await openClassify(page);
    await preview(page, account.phone, "EXCLUDE_DEMO");
    await page.click("#exclude-confirm-button");
    await expect(page.locator("#exclude-message")).toHaveText("Saved: Excluded — demo. Figures update when they are next rebuilt.");
    expect(await savedClass(account.id)).toEqual({ classification: "DEMO", reason_code: "OPERATOR_DEMO_ACCOUNT" });
    await preview(page, account.phone, "EXCLUDE_ADMIN");
    await expect(page.locator("#preview-current")).toHaveText("Excluded — demo");
    await expect(page.locator("#preview-reason")).toHaveText("Administrator's own app account");
    await page.click("#exclude-confirm-button");
    await expect(page.locator("#exclude-message")).toHaveText("Saved: Excluded — internal test. Figures update when they are next rebuilt.");
    expect(await savedClass(account.id)).toEqual({ classification: "INTERNAL_TEST", reason_code: "OPERATOR_ADMIN_ACCOUNT" });
  } finally {
    await ctx.close();
  }
});

test("C5. a number with no account gives the generic message and no details", async ({ browser }) => {
  const { ctx, page } = await ownerPage(browser, {
    extra: serve("/admin/classification/preview", (route) => route.fulfill({ status: 404, headers: CORS, body: JSON.stringify({ error: "No matching account." }) }))
  });
  try {
    await openClassify(page);
    await preview(page, "+19990000000", "EXCLUDE_TEST");
    await expect(page.locator("#exclude-message")).toHaveText("No account has exactly that number. Use the number as registered, with its country code.");
    await expect(page.locator("#exclude-confirm")).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test("C6. state changed, used confirmation and rate limit each say what to do; nothing can be confirmed", async ({ browser }) => {
  for (const [status, body, message] of [
    [409, { error: "state_changed" }, "The account's status changed since the preview. Nothing was changed. Preview again."],
    [409, { error: "confirmation_invalid" }, "This confirmation has expired or was already used. Preview again."]
  ]) {
    const { ctx, page } = await ownerPage(browser, {
      extra: async (p) => {
        await serve("/admin/classification/preview", (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(PREVIEW_OK) }))(p);
        await serve("/admin/classification/apply", (route) => route.fulfill({ status, headers: CORS, body: JSON.stringify(body) }))(p);
      }
    });
    try {
      await openClassify(page);
      await preview(page, "+15550000001", "EXCLUDE_TEST");
      await page.click("#exclude-confirm-button");
      await expect(page.locator("#exclude-message")).toHaveText(message);
      await expect(page.locator("#exclude-confirm")).toBeHidden();
      await expect(page.locator("#exclude-unconfirmed")).toBeHidden();
    } finally {
      await ctx.close();
    }
  }
  const limited = await ownerPage(browser, {
    extra: serve("/admin/classification/preview", (route) => route.fulfill({ status: 429, headers: CORS, body: "{}" }))
  });
  try {
    await openClassify(limited.page);
    await preview(limited.page, "+15550000002", "EXCLUDE_TEST");
    await expect(limited.page.locator("#exclude-message")).toHaveText("Too many lookups. Wait 15 minutes, then try again.");
  } finally {
    await limited.ctx.close();
  }
});

test("C6c. a malformed preview reply offers nothing to confirm", async ({ browser }) => {
  for (const body of [{ account: { created_on: "2026-09-14" } }, { ...PREVIEW_OK, confirmation_token: "not-a-token" }, null]) {
    const { ctx, page, sent } = await ownerPage(browser, {
      extra: serve("/admin/classification/preview", (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(body) }))
    });
    try {
      await openClassify(page);
      await preview(page, "+15550000006", "EXCLUDE_TEST");
      await expect(page.locator("#exclude-message")).toHaveText("The lookup did not complete. Nothing was changed. Try again.");
      await expect(page.locator("#exclude-confirm")).toBeHidden();
      expect(sent.filter((r) => r.url.includes("/classification/apply"))).toEqual([]);
    } finally {
      await ctx.close();
    }
  }
});

test("C6b. a preview not confirmed in time expires on the page", async ({ browser }) => {
  const { ctx, page, sent } = await ownerPage(browser, {
    configExtra: "export const CLASSIFY_PREVIEW_MS = 1500;",
    extra: serve("/admin/classification/preview", (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(PREVIEW_OK) }))
  });
  try {
    await openClassify(page);
    await preview(page, "+15550000003", "EXCLUDE_TEST");
    await expect(page.locator("#exclude-confirm")).toBeVisible();
    await expect(page.locator("#exclude-message")).toHaveText("This confirmation expired. Nothing was changed. Preview again.", { timeout: 5000 });
    await expect(page.locator("#exclude-confirm")).toBeHidden();
    expect(sent.filter((r) => r.url.includes("/classification/apply"))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("C7. signing out during a preview drops it; it cannot be confirmed afterwards", async ({ browser }) => {
  const account = { phone: "+15557771235" };
  const { ctx, page, sent } = await ownerPage(browser, { extra: serve("/admin/classification/preview", (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(PREVIEW_OK) })) });
  try {
    await openClassify(page);
    await preview(page, account.phone, "EXCLUDE_TEST");
    await expect(page.locator("#exclude-confirm")).toBeVisible();
    await page.click("#signout-button");
    await expect(page.locator("#signin-screen")).toBeVisible();
    await signIn(page);
    await openClassify(page);
    await expect(page.locator("#exclude-confirm")).toBeHidden();
    await expect(page.locator("#exclude-message")).toHaveText("");
    expect(sent.filter((r) => r.url.includes("/classification/apply"))).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test("C8. a saved change whose response is lost shows outcome unconfirmed; a fresh preview settles it", async ({ browser }) => {
  const account = await seedAccount();
  const { ctx, page, sent } = await ownerPage(browser, {
    // The server receives and saves the change; the browser never sees the answer.
    extra: serve("/admin/classification/apply", async (route) => {
      await route.fetch();
      return route.abort();
    })
  });
  try {
    await openClassify(page);
    await preview(page, account.phone, "EXCLUDE_TEST");
    await page.click("#exclude-confirm-button");
    await expect(page.locator("#exclude-unconfirmed")).toBeVisible();
    await expect(page.locator("#exclude-unconfirmed")).toHaveText(UNCONFIRMED);
    await expect(page.locator("#exclude-message")).toHaveText("");
    await expect(page.locator("#settings-exclusions")).not.toContainText(/failed/i);
    await expect(page.locator("#exclude-confirm")).toBeHidden();
    expect((await savedClass(account.id)).classification, "the server did save it").toBe("INTERNAL_TEST");
    expect(sent.filter((r) => r.method === "POST" && r.url.includes("/classification/apply"))).toHaveLength(1);
    await preview(page, account.phone, "EXCLUDE_TEST");
    await expect(page.locator("#preview-current")).toHaveText("Excluded — internal test");
    await expect(page.locator("#exclude-unconfirmed")).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test("C8b. late preview and confirmation responses change nothing after sign-out or a new sign-in", async ({ browser }) => {
  for (const which of ["preview", "apply"]) {
    const account = which === "apply" ? await seedAccount() : { phone: "+15557771236" };
    const hold = gate();
    const arrived = gate();
    const { ctx, page } = await ownerPage(browser, {
      extra: serve(`/admin/classification/${which}`, async (route) => {
        // preview: answered here; apply: the real server answers, held back from the page.
        const response = which === "apply" ? await route.fetch() : null;
        arrived.open();
        await hold.promise;
        return (response
          ? route.fulfill({ response })
          : route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(PREVIEW_OK) })).catch(() => {});
      })
    });
    try {
      await openClassify(page);
      await preview(page, account.phone, "EXCLUDE_TEST");
      if (which === "apply") {
        await expect(page.locator("#exclude-confirm")).toBeVisible();
        await page.click("#exclude-confirm-button");
      }
      await arrived.promise;
      await page.click("#signout-button");
      await expect(page.locator("#signin-screen")).toBeVisible();
      await signIn(page);
      await openClassify(page);
      hold.open();
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
      await expect(page.locator("#exclude-confirm"), which).toBeHidden();
      await expect(page.locator("#exclude-message"), which).toHaveText("");
      await expect(page.locator("#exclude-unconfirmed"), which).toBeHidden();
      await expect(page.locator("#signin-screen")).toBeHidden();
    } finally {
      hold.open();
      await ctx.close();
    }
  }
});

test("C8c. a confirmation that times out is unconfirmed, and a double click sends one confirmation", async ({ browser }) => {
  const applies = [];
  const release = gate();
  const { ctx, page } = await ownerPage(browser, {
    extra: async (p) => {
      await serve("/admin/classification/preview", (route) => route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(PREVIEW_OK) }))(p);
      await serve("/admin/classification/apply", async (route) => {
        applies.push(route.request().postData());
        await release.promise;
        return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify({ applied: true, classification: "INTERNAL_TEST" }) }).catch(() => {});
      })(p);
    }
  });
  try {
    await openClassify(page);
    await preview(page, "+15550000004", "EXCLUDE_TEST");
    await page.locator("#exclude-confirm-button").dblclick();
    await expect(page.locator("#exclude-unconfirmed")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("#exclude-message")).toHaveText("");
    expect(applies).toHaveLength(1);
    expect(JSON.parse(applies[0])).toEqual({ confirmation_token: "a".repeat(64) });
  } finally {
    release.open();
    await ctx.close();
  }
});

test("C9. the classify flow uses only the allowed requests", async ({ browser }) => {
  const account = await seedAccount();
  const allowed = new Set([
    "POST /admin/auth/login", "POST /admin/auth/logout", "GET /admin/auth/me",
    "GET /admin/v2/overview", "GET /admin/v2/timeseries", "GET /admin/v2/breakdown", "GET /admin/v2/exclusions",
    "POST /admin/classification/preview", "POST /admin/classification/apply"
  ]);
  const { ctx, page, sent } = await ownerPage(browser);
  try {
    await openClassify(page);
    await preview(page, account.phone, "EXCLUDE_DEMO");
    await page.click("#exclude-confirm-button");
    await expect(page.locator("#exclude-message")).toContainText("Saved: Excluded — demo");
    await page.click("#signout-button");
    await expect(page.locator("#signin-screen")).toBeVisible();
    for (const r of sent) {
      const url = new URL(r.url);
      if (r.method === "OPTIONS") continue;
      if (url.origin === APP_URL) { expect(url.pathname.startsWith("/admin/"), r.url).toBe(true); continue; }
      expect(allowed.has(`${r.method} ${url.pathname}`), `${r.method} ${r.url}`).toBe(true);
    }
  } finally {
    await ctx.close();
  }
});

test("C10. tabs and settings sections switch without reloading; sign-out hides everything; Back shows no figures", async ({ browser }) => {
  const { ctx, page } = await ownerPage(browser);
  try {
    await page.evaluate(() => { window.__sameDocument = true; });
    for (const tab of ["reports", "settings", "dashboard"]) {
      await page.click(`#tabs a[data-tab="${tab}"]`);
      await expect(page.locator(`#${tab}-screen`)).toBeVisible();
      await expect(page.locator(`#tabs a[data-tab="${tab}"]`)).toHaveAttribute("aria-current", "page");
      for (const other of ["dashboard", "reports", "settings"].filter((t) => t !== tab)) await expect(page.locator(`#${other}-screen`)).toBeHidden();
    }
    await page.click('#tabs a[data-tab="settings"]');
    for (const sub of ["quality", "detail", "methodology", "exclusions"]) {
      await page.click(`.subtabs a[data-sub="${sub}"]`);
      await expect(page.locator(`#settings-${sub}`)).toBeVisible();
      for (const other of ["exclusions", "quality", "detail", "methodology"].filter((t) => t !== sub)) await expect(page.locator(`#settings-${other}`)).toBeHidden();
    }
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
    await page.click("#signout-button");
    await expect(page.locator("#signin-screen")).toBeVisible();
    await expect(page.locator("#app-shell")).toBeHidden();
    await expect(page.locator("#kpi-external-value")).toHaveText("—");
    await expect(page.locator("#count-total")).toHaveText("—");
    await expect(page.locator("#detail-table tbody tr")).toHaveCount(0);
    await page.goBack();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
    await expect(page.locator("#app-shell")).toBeHidden();
    await expect(page.locator("#kpi-external-value")).toHaveText("—");
  } finally {
    await ctx.close();
  }
});

function luminance([r, g, b]) {
  const c = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const rgb = (text) => text.match(/\d+/g).slice(0, 3).map(Number);

test("C11. the website look: colours, type and contrast", async ({ browser }) => {
  const { ctx, page } = await ownerPage(browser);
  try {
    await expect(page.locator("#kpi-external-value")).not.toHaveText("—");
    const style = await page.evaluate(() => {
      const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
      return {
        header: css("#brand-bar", "backgroundColor"),
        body: css("body", "backgroundColor"),
        h1: css("#dashboard-screen h1", "fontFamily"),
        kpi: css(".kpi-value", "fontVariantNumeric"),
        kpiFont: css(".kpi-value", "fontFamily")
      };
    });
    expect(style.header).toBe("rgb(26, 60, 52)");
    expect(style.body).toBe("rgb(247, 243, 238)");
    expect(style.h1).toMatch(/^Georgia/);
    expect(style.kpi).toContain("tabular-nums");
    expect(style.kpiFont).toMatch(/Helvetica/);
    const paper = [247, 243, 238];
    const white = [255, 255, 255];
    const pairs = [
      ["#brand-bar .brand", [26, 60, 52]],
      ["#operator-label", paper],
      [".fresh", paper],
      [".kpi-sub", white],
      [".kpi-label", white],
      [".kpi-value", white],
      ["#footer-note", paper],
      ['#tabs a[aria-current="page"]', [26, 60, 52]],
      ['#tabs a:not([aria-current])', white]
    ];
    for (const [selector, background] of pairs) {
      const color = rgb(await page.locator(selector).first().evaluate((el) => getComputedStyle(el).color));
      expect(contrast(color, background), selector).toBeGreaterThanOrEqual(4.5);
    }
  } finally {
    await ctx.close();
  }
});

test("C12. wording guard for the classify tool", async () => {
  const banned = [/verified customer/i, /active users?/i, /transactions?/i, /activated/i];
  for (const name of await readdir(ADMIN_DIR)) {
    if (!/\.(html|js|css)$/.test(name)) continue;
    const text = await readFile(ADMIN_DIR + name, "utf8");
    for (const pattern of banned) expect(text, `${name} ${pattern}`).not.toMatch(pattern);
  }
  const html = await readFile(ADMIN_DIR + "index.html", "utf8");
  expect(html).toContain("External means every app account except those you exclude here. Payment, records or activity are not required.");
  expect(html).toContain("Exclusion is the owner's own entry; it is not an independent confirmation");
  expect(html).not.toMatch(/unclassified|provisional/i);
});
