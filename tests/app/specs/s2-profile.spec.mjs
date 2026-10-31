import { expect, test } from "@playwright/test";
import {
  APP_API_URL,
  deleteLocalSettings,
  deleteProfileForEmail,
  nextAccount,
  profileRegionForEmail,
  profileRowForEmail,
  putStoreValue,
  readLocalState,
  readStoredProfile,
  requestCode,
  restoreThroughUi,
  signInThroughUi,
  verifyWithCode,
  writeLocalState
} from "./helpers.mjs";

// S2: business profile completion, unlisted sector choice, country default.
// The service worker would serve cached modules and hide the app under test.
test.use({ serviceWorkers: "block" });

const SERVER_TIMEOUT = { timeout: 20_000 };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PROMPT_KEY = "profile_prompt_state";

function isProfileRequest(request, method) {
  return request.method() === method && new URL(request.url()).pathname === "/profile";
}

function trackProfilePosts(page) {
  const posts = [];
  page.on("request", (request) => {
    if (!isProfileRequest(request, "POST")) return;
    let body = {};
    try {
      body = JSON.parse(request.postData() || "{}");
    } catch {
      body = {};
    }
    posts.push(body);
  });
  return posts;
}

async function promptState(page) {
  return (await readLocalState(page)).settings[PROMPT_KEY] || null;
}

const banner = (page) => page.locator("#profile-prompt-banner");

async function chooseCountries(page) {
  await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#operating-region-grid").getByRole("button", { name: /Nigeria/ }).click();
  await expect(page.locator(".step.active")).toHaveAttribute("data-step", "3");
}

// A server answer shaped like GET /profile for the signed-in account.
function serverProfile(overrides = {}) {
  return {
    name: "S2 test business",
    business_name: "S2 test business",
    country: "NG",
    operating_region: "NG",
    language: "en",
    business_type_id: "ng_market_trader",
    sector_id: "trade_retail",
    sector_source: "catalog",
    profile_complete: true,
    business_description: "",
    preferred_labels: [],
    phone: "",
    email: "",
    email_verified: true,
    phone_verified: false,
    plan: null,
    plan_activated_at: null,
    ...overrides
  };
}

const FALLBACK_PROFILE = {
  business_type_id: "unlisted",
  business_description: "Bead making",
  sector_id: "other_activity",
  sector_source: "fallback",
  profile_complete: false
};

// Answers GET /profile with whatever `answer.current` holds; POST and every other route go to the
// real local API.
async function routeProfileGet(page, answer) {
  await page.route(`${APP_API_URL}/profile`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const current = answer.current;
    if (!current) return route.fallback();
    if (current.hold) await current.hold;
    if (current.abort) return route.abort(current.abort);
    return route.fulfill({
      status: current.status || 200,
      contentType: "application/json",
      body: typeof current.body === "string" ? current.body : JSON.stringify(current.body)
    });
  });
}

async function reloadToCapture(page) {
  const answered = page.waitForResponse((response) => isProfileRequest(response.request(), "GET"), { timeout: 15_000 }).catch(() => null);
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await answered;
}

test("T-A1, T-A2, T-K2: unlisted needs a description and a sector; no Nigerian default before a country is known", async ({ page }) => {
  const account = nextAccount("s2-unlisted-local");
  const profileRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/profile") profileRequests.push(request.method());
  });
  // T-K2: the shipped markup carries no Nigerian prefix or number.
  const html = await (await page.request.get("/index.html")).text();
  expect(html).not.toContain("+234");
  expect(html).not.toContain("08099840666");

  await page.goto("/");
  await expect(page.locator("#onboarding-step-copy")).toHaveText("Step 1 of 6");
  // Sign-in and restore screens for an unknown country, after script load.
  await page.locator("#restore-account-link").click();
  await expect(page.locator("#restore-modal")).toBeVisible();
  await expect(page.locator("#restore-country-prefix")).toHaveText("");
  await expect(page.locator("#restore-phone-input")).not.toHaveAttribute("placeholder", /0809|\+234/);
  await expect(page.locator("#otp-country-prefix")).toHaveText("");
  await expect(page.locator("#otp-phone-input")).not.toHaveAttribute("placeholder", /0809|\+234/);
  await page.locator("#restore-cancel").click();

  await chooseCountries(page);
  // T-A2: no sector choice is shown for listed types or before "isn't listed" is opened.
  await expect(page.locator("#unlisted-sector-group")).toBeHidden();

  // A description alone is not enough.
  await page.locator("#business-not-listed").click();
  const options = page.locator('#unlisted-sector-grid input[name="unlisted-sector"]');
  await expect(options).toHaveCount(8);
  await expect(page.locator("#unlisted-sector-grid").getByLabel("None of these fit")).toBeVisible();
  await expect(page.locator('#unlisted-sector-grid input:checked')).toHaveCount(0);
  await page.locator("#business-description").fill("Bead making");
  await page.locator("#unlisted-continue").click();
  await expect(page.locator("#unlisted-sector-error")).toBeVisible();
  await expect(page.locator(".step.active")).toHaveAttribute("data-step", "3");

  // A browsed sector is pre-selected.
  await page.locator("#sector-grid").getByRole("button", { name: /Food & Hospitality/ }).click();
  await expect(page.locator(".step.active")).toHaveAttribute("data-step", "4");
  await page.locator("#onboarding-back").click();
  await page.locator("#business-not-listed").click();
  await expect(page.locator("#unlisted-sector-grid").getByLabel(/Food & Hospitality/)).toBeChecked();

  // "None of these fit" is a deliberate Other business.
  await page.locator("#business-description").fill("Bead making");
  await page.locator("#unlisted-sector-grid").getByLabel("None of these fit").check();
  await page.locator("#unlisted-continue").click();
  await expect(page.locator(".step.active")).toHaveAttribute("data-step", "6");
  await page.locator("#onboarding-name").fill("Bead maker");
  await page.locator("#onboarding-phone").fill(account.phone);
  await page.locator("#onboarding-email").fill(account.email);
  await page.locator("#finish-onboarding").click();
  await expect(page.locator("#screen-otp.active")).toBeVisible();
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect(page.locator("#registration-verify-banner")).toBeVisible();
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  expect(await readStoredProfile(page)).toMatchObject({
    business_type_id: "unlisted", business_description: "Bead making", sector_id: "other_activity", sector_confirmed: true
  });
  // T-A5 (part): an unbound install never asks the server and never shows the prompt.
  await expect(banner(page)).toBeHidden();
  expect(profileRequests).toEqual([]);
});

test("T-R1, T-U1, T-R2: resend once after binding; unavailable is not missing; the server wins", async ({ page }) => {
  test.slow();
  const posts = trackProfilePosts(page);
  const account = await signInThroughUi(page, nextAccount("s2-resend"));

  // T-R1: the local listed profile reaches the server exactly once, after binding, in fill_missing mode.
  await expect.poll(() => profileRowForEmail(account.email), SERVER_TIMEOUT).toMatchObject({
    business_type_id: "ng_market_trader", sector_id: "trade_retail", sector_source: "catalog"
  });
  const fills = () => posts.filter((body) => body.mode === "fill_missing");
  expect(fills()).toHaveLength(1);
  expect(fills()[0]).toMatchObject({ business_type_id: "ng_market_trader" });
  await expect(banner(page)).toBeHidden();

  // T-U1: an unavailable answer never triggers recovery, the prompt or a local change.
  const answer = { current: null };
  await routeProfileGet(page, answer);
  await page.locator("#nav-record-v2").click();
  const scenarios = [
    { label: "timeout", abort: "timedout" },
    { label: "503", status: 503, body: { error: "unavailable" } },
    { label: "malformed JSON", body: "{\"profile\": " },
    { label: "200 without a profile key", body: { ok: true } },
    { label: "a non-object profile", body: { profile: "x" } }
  ];
  for (const scenario of scenarios) {
    answer.current = scenario;
    const before = posts.length;
    await reloadToCapture(page);
    await page.waitForTimeout(1_000);
    expect(posts.length, `${scenario.label}: no profile POST`).toBe(before);
    await expect(banner(page), `${scenario.label}: no prompt`).toBeHidden();
    expect((await readStoredProfile(page)).business_type_id, `${scenario.label}: local profile unchanged`).toBe("ng_market_trader");
  }

  // A later "missing" answer recovers normally (the server already has a business, so it wins).
  answer.current = { body: { account_id: account.accountId, profile: null } };
  const fillsBefore = fills().length;
  await reloadToCapture(page);
  await expect.poll(() => fills().length, SERVER_TIMEOUT).toBe(fillsBefore + 1);

  // T-R2: the server has a different business → no push of local business fields; the pull applies.
  answer.current = { body: { account_id: account.accountId, profile: serverProfile({ business_type_id: "ng_food_vendor", sector_id: "food_hospitality" }) } };
  const postsBefore = posts.length;
  await reloadToCapture(page);
  await expect.poll(async () => (await readStoredProfile(page)).business_type_id, SERVER_TIMEOUT).toBe("ng_food_vendor");
  await page.waitForTimeout(1_000);
  expect(posts.slice(postsBefore).filter((body) => body.mode === "fill_missing" || body.business_type_id === "ng_market_trader")).toEqual([]);

  // A present legacy sector-only server profile replaces the local business as a whole: the local
  // listed type is never paired with the server's sector.
  answer.current = { body: { account_id: account.accountId, profile: serverProfile({ business_type_id: "", sector_id: "agriculture", sector_source: "user", profile_complete: false }) } };
  await reloadToCapture(page);
  await expect.poll(async () => {
    const local = await readStoredProfile(page);
    return { type: local.business_type_id || null, sector: local.sector_id };
  }, SERVER_TIMEOUT).toEqual({ type: null, sector: "agriculture" });

  // An older server without fill_missing answers 400: treated as unavailable, one attempt, no change.
  await putStoreValue(page, "settings", { ...(await readStoredProfile(page)), business_type_id: "ng_market_trader", sector_id: "trade_retail", business_description: "" });
  answer.current = { body: { account_id: account.accountId, profile: null } };
  await page.route(`${APP_API_URL}/profile`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Unknown profile save mode." }) });
  });
  const oldServerBefore = fills().length;
  await reloadToCapture(page);
  await expect.poll(() => fills().length, SERVER_TIMEOUT).toBe(oldServerBefore + 1);
  await page.waitForTimeout(1_000);
  expect(fills().length, "no retry on the same open").toBe(oldServerBefore + 1);
  expect((await readStoredProfile(page)).business_type_id).toBe("ng_market_trader");
  await expect(banner(page)).toBeHidden();
  await page.unroute(`${APP_API_URL}/profile`);
  await routeProfileGet(page, answer);

  // A session change while the check is in flight: the late answer is discarded.
  let release;
  answer.current = { hold: new Promise((resolve) => { release = resolve; }), body: { account_id: account.accountId, profile: null } };
  const lateBefore = posts.length;
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-logout-v2").click();
  await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  release();
  await page.waitForTimeout(1_000);
  expect(posts.slice(lateBefore).filter((body) => body.mode === "fill_missing")).toEqual([]);
  await expect(banner(page)).toBeHidden();
  expect(await promptState(page), "sign-out wipes the prompt cadence").toBeNull();
});

test("T-A3, T-A4, T-A5: prompt cadence, completion stops it, protected screens and sign-out", async ({ page }) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("s2-cadence"));
  await page.locator("#nav-record-v2").click();
  const answer = { current: null };
  await routeProfileGet(page, answer);
  const t0 = Date.now();
  const at = async (offset) => page.clock.setFixedTime(new Date(t0 + offset));

  // T-A4: a complete listed profile is never prompted, and nothing is counted.
  await at(0);
  await reloadToCapture(page);
  await page.waitForTimeout(800);
  await expect(banner(page)).toBeHidden();
  expect((await promptState(page))?.eligible || 0).toBe(0);

  // Needs completion (server fallback). First eligible sign-in → shown.
  answer.current = { body: { account_id: account.accountId, profile: serverProfile(FALLBACK_PROFILE) } };
  await deleteLocalSettings(page, [PROMPT_KEY]);
  await at(0);
  await reloadToCapture(page);
  await expect(banner(page)).toBeVisible();
  await expect(page.locator("#profile-prompt-text")).toHaveText("Help us categorise your business: one question.");
  expect((await promptState(page)).eligible).toBe(1);
  await page.locator("#profile-prompt-dismiss").click();
  await expect(banner(page)).toBeHidden();

  // Opens within 20 hours count once; background sync never counts.
  await at(HOUR);
  await reloadToCapture(page);
  await page.waitForTimeout(800);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(800);
  expect((await promptState(page)).eligible).toBe(1);
  await expect(banner(page)).toBeHidden();

  // 2nd and 3rd eligible sign-ins: hidden.
  for (const [offset, count] of [[21 * HOUR, 2], [42 * HOUR, 3]]) {
    await at(offset);
    await reloadToCapture(page);
    await expect.poll(async () => (await promptState(page)).eligible).toBe(count);
    await expect(banner(page)).toBeHidden();
  }
  // 4th, but within 7 days of the last showing: hidden.
  await at(63 * HOUR);
  await reloadToCapture(page);
  await expect.poll(async () => (await promptState(page)).eligible).toBe(4);
  await expect(banner(page)).toBeHidden();
  // A return to the foreground after 7 days counts and shows it.
  await at(7 * DAY + HOUR);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(async () => (await promptState(page)).eligible).toBe(5);
  await expect(banner(page)).toBeVisible();

  // T-A4: completed on another device → it stops for good.
  answer.current = { body: { account_id: account.accountId, profile: serverProfile() } };
  await at(15 * DAY);
  await reloadToCapture(page);
  await page.waitForTimeout(800);
  await expect(banner(page)).toBeHidden();
  expect((await promptState(page)).eligible).toBe(5);

  // T-A5: never over the passcode lock.
  answer.current = { body: { account_id: account.accountId, profile: serverProfile(FALLBACK_PROFILE) } };
  const profile = await readStoredProfile(page);
  await putStoreValue(page, "settings", { ...profile, pinEnabled: true, pinHash: "s2-test-not-a-real-hash" });
  // Start the cadence again so this open is a showing: it must wait behind the lock.
  await deleteLocalSettings(page, [PROMPT_KEY]);
  await at(20 * DAY);
  await reloadToCapture(page);
  await expect(page.locator("#pin-lock-screen")).toBeVisible();
  await expect.poll(async () => (await promptState(page))?.lastShownAt).toBe(t0 + 20 * DAY);
  await page.waitForTimeout(500);
  await expect(banner(page)).toBeHidden();

  // Sign-out wipes the cadence; nothing shows on the signed-out screen.
  await putStoreValue(page, "settings", { ...profile, pinEnabled: false, pinHash: "" });
  await reloadToCapture(page);
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-logout-v2").click();
  await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  await expect(banner(page)).toBeHidden();
  expect(await promptState(page)).toBeNull();
});

test("T-N1, T-R3, T-K1: a no-profile account restores without Nigeria, is prompted, and completes", async ({ page, browser }) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("s2-noprofile"));
  await expect.poll(() => profileRowForEmail(account.email), SERVER_TIMEOUT).toMatchObject({ business_type_id: "ng_market_trader" });
  deleteProfileForEmail(account.email);
  expect(profileRowForEmail(account.email)).toBeNull();

  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, serviceWorkers: "block" });
  const fresh = await context.newPage();
  const posts = trackProfilePosts(fresh);
  await fresh.goto("/");
  await writeLocalState(fresh, { sync_api_base_url: APP_API_URL });
  await fresh.reload();
  await restoreThroughUi(fresh, account);
  await expect(fresh.locator("#screen-capture.active")).toBeVisible(SERVER_TIMEOUT);

  // T-R3: nothing to resend → no business sent; T-N1: no invented region; the prompt shows.
  await expect(banner(fresh)).toBeVisible(SERVER_TIMEOUT);
  expect(posts.filter((body) => body.mode === "fill_missing" || body.business_type_id)).toEqual([]);
  const restored = await readStoredProfile(fresh);
  expect(restored.operating_region || "").toBe("");
  expect(restored.business_type_id || null).toBeNull();
  const phoneCountryBefore = restored.phone_country || "";

  // Completing it creates a server business profile with the person's sector.
  await fresh.locator("#profile-prompt-complete").click();
  await expect(fresh.locator("#screen-onboarding.active")).toBeVisible();
  await expect(fresh.locator(".step.active")).toHaveAttribute("data-step", "3");
  await fresh.locator("#business-not-listed").click();
  await fresh.locator("#business-description").fill("Poultry and eggs");
  await fresh.locator("#unlisted-sector-grid").getByLabel(/Agriculture/).check();
  await fresh.locator("#unlisted-continue").click();
  await expect(fresh.locator(".step.active")).toHaveAttribute("data-step", "6");
  await fresh.locator("#onboarding-name").fill("Poultry farm");
  await fresh.locator("#finish-onboarding").click();
  await expect(fresh.locator("#screen-capture.active")).toBeVisible();
  await expect(banner(fresh)).toBeHidden();
  await expect.poll(() => profileRowForEmail(account.email), SERVER_TIMEOUT).toMatchObject({
    business_type_id: "unlisted", business_description: "Poultry and eggs", sector_id: "agriculture", sector_source: "user"
  });

  // T-K1: the first currency-dependent entry asks for the business country, once.
  const existing = {
    id: 999001, transaction_type: "sale", label: "Earlier sale", normalized_label: "earlier sale",
    amount_minor: 50000, currency: "NGN", confirmed_at: Math.floor(Date.now() / 1000) - 3600,
    prev_entry_hash: "0".repeat(64), entry_hash: "f".repeat(64), importedFromServer: true
  };
  await putStoreValue(fresh, "records", existing);
  await fresh.locator("#primary-actions").getByRole("button", { name: /Sell/ }).click();
  await fresh.locator("#open-selector").click();
  await fresh.locator('[data-mode="other"]').click();
  await fresh.locator("#custom-label-input").fill("Eggs");
  await fresh.locator("#save-custom-label").click();
  await fresh.locator("#amount-input-v2").fill("12");
  await fresh.locator("#prepare-confirmation").click();
  await expect(fresh.locator("#region-choice-modal")).toBeVisible();
  await expect(fresh.locator("#screen-confirm.active")).toBeHidden();
  await fresh.locator("#region-choice-select").selectOption("US");
  await fresh.locator("#region-choice-save").click();
  await expect(fresh.locator("#region-choice-modal")).toBeHidden();
  await expect(fresh.locator("#screen-confirm.active")).toBeVisible();
  await expect(fresh.locator("#confirm-meta-v2")).toContainText("$12.00");
  const chosen = await readStoredProfile(fresh);
  expect(chosen.operating_region).toBe("US");
  expect(chosen.phone_country || "", "the phone country is separate").toBe(phoneCountryBefore);
  const records = (await readLocalState(fresh)).stores.records;
  expect(records.find((record) => record.id === existing.id).currency, "existing records keep their currency").toBe("NGN");
  await expect.poll(() => profileRegionForEmail(account.email), SERVER_TIMEOUT).toMatchObject({ operating_region: "US" });

  // A known region is kept on the next open.
  await fresh.reload();
  await expect(fresh.locator("#screen-capture.active")).toBeVisible();
  await expect.poll(async () => (await readStoredProfile(fresh)).operating_region).toBe("US");
  await context.close();
});
