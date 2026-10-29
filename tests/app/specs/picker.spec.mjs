import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { BUSINESS_TYPES, QUICK_PICKS } from "../../../app-v3/catalog-data.js";
import { normalizeSearchText } from "../../../app-v3/business-text.js";
import { MATCH_TIERS, searchBusinessTypes } from "../../../app-v3/business-search.js";
import { computeFinancialStatements } from "../../../server/src/report-statements.js";
import {
  ledgerEntriesForDevice,
  nextAccount,
  profileRowForEmail,
  putStoreValue,
  readLocalState,
  readStoredProfile,
  restoreThroughUi,
  setProfileSectorForEmail,
  signInThroughUi
} from "./helpers.mjs";

// The service worker would serve cached modules and bypass the alias fixtures below.
test.use({ serviceWorkers: "block" });

// Approved SAMPLE aliases for these tests only. The real shipped list is empty until review.
const SAMPLE_ALIASES = [
  ["business centre", "global_document_services", "NG"],
  ["cyber cafe", "global_document_services", "any"],
  ["photocopy", "global_document_services", "any"],
  ["printing", "global_document_services", "any"],
  ["printer", "global_document_services", "any"],
  ["painter", "ng_artisan", "NG"],
  ["okada", "ng_okada_keke_rider", "NG"],
  ["achaba", "ng_okada_keke_rider", "NG"],
  ["ɗan kasuwa", "ng_market_trader", "NG"],
  ["corner shop", "ng_provision_shop", "any"],
  ["store", "us_retail", "US"],
  ["trotro", "global_transport_logistics", "GH"]
].map(([alias, type_id, used_in]) => ({ alias, normalised: normalizeSearchText(alias), type_id, used_in }));

async function useSampleAliases(page) {
  await page.route("**/business-aliases.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: `export const BUSINESS_ALIASES = Object.freeze(${JSON.stringify(SAMPLE_ALIASES)});`
  }));
}

async function chooseCountry(page, gridId, name) {
  const grid = page.locator(`#${gridId}`);
  const card = grid.getByRole("button", { name: new RegExp(`^\\S*\\s*${name}\\b`) });
  if (!(await card.count())) {
    await grid.getByRole("button", { name: /Other/ }).click();
    await page.locator(`#${gridId}-search`).fill(name);
  }
  await grid.getByRole("button", { name: new RegExp(name) }).first().click();
}

async function openSearchStep(page, country = "Nigeria") {
  await page.goto("/");
  await chooseCountry(page, "country-grid", "Nigeria");
  await chooseCountry(page, "operating-region-grid", country);
  await expect(page.getByRole("heading", { name: "What business do you do?" })).toBeVisible();
}

const search = (page) => page.locator("#business-search");

async function finishLocalOnboarding(page, name = "Picker test") {
  await expect(page.getByRole("heading", { name: "About you" })).toBeVisible();
  await page.locator("#onboarding-name").fill(name);
  await page.locator("#finish-onboarding").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
}
const optionNames = (page) => page.locator("#business-search-results [role=option]").evaluateAll(
  (nodes) => nodes.map((node) => node.querySelector(".option-name")?.textContent.trim())
);
const optionNotes = (page) => page.locator("#business-search-results [role=option]").evaluateAll(
  (nodes) => nodes.map((node) => node.querySelector("small")?.textContent.trim())
);
const NOT_LISTED = "My business isn't listed";

async function resultsFor(page, query) {
  await search(page).fill(query);
  const names = await optionNames(page);
  expect(names.at(-1), `"not listed" is last for ${query}`).toBe(NOT_LISTED);
  return names.slice(0, -1);
}

test("1: results update correctly on each keystroke", async ({ page }) => {
  await useSampleAliases(page);
  await openSearchStep(page);
  const expected = {
    p: ["Provision Shop", "Service Provider", "Kiosk / Phone Business", "Personal / Professional Services", "Document & Print Services", "Artisan"],
    ph: ["Kiosk / Phone Business", "Document & Print Services"],
    pho: ["Kiosk / Phone Business", "Document & Print Services"],
    phot: ["Document & Print Services"],
    photo: ["Document & Print Services"],
    photoc: ["Document & Print Services"]
  };
  await search(page).focus();
  let previousStrict = null;
  for (const character of "photoc") {
    await search(page).press(character);
    const query = await search(page).inputValue();
    const names = await optionNames(page);
    expect(names.slice(0, -1), `results for "${query}"`).toEqual(expected[query]);
    expect(names.at(-1)).toBe(NOT_LISTED);
    const notes = await optionNotes(page);
    const strict = names.slice(0, -1).filter((_, index) => !notes[index].includes("close spelling"));
    if (previousStrict) for (const name of strict) expect(previousStrict, `"${name}" was already an exact/prefix match`).toContain(name);
    previousStrict = strict;
  }
  await expect(page.locator("#business-search-status")).toHaveText("1 match");
});

test("2: ranking puts an exact match above a competing close spelling, and own country before GLOBAL", async ({ page }) => {
  await useSampleAliases(page);
  await openSearchStep(page);
  expect(await resultsFor(page, "printer")).toEqual(["Document & Print Services", "Artisan"]);
  expect((await optionNotes(page))[1]).toContain("close spelling");
  expect(await resultsFor(page, "painter")).toEqual(["Artisan", "Document & Print Services"]);
  expect((await optionNotes(page))[1]).toContain("close spelling");
  // "pro" prefixes Provision Shop and Service Provider (Nigeria) and Personal / Professional Services (GLOBAL).
  expect(await resultsFor(page, "pro")).toEqual(["Provision Shop", "Service Provider", "Personal / Professional Services"]);
});

test("2b: tier order is exact name > name prefix > alias > close spelling (search module)", () => {
  const types = [
    { id: "a", country: "NG", name: "Bread Seller" },
    { id: "b", country: "NG", name: "Bread Seller Depot" },
    { id: "c", country: "NG", name: "Bakery" },
    { id: "d", country: "NG", name: "Bred Sellar" },
    { id: "e", country: "GLOBAL", name: "Bread Seller Hub" },
    { id: "f", country: "US", name: "Bread Seller" }
  ];
  const aliases = [{ alias: "bread seller", normalised: "bread seller", type_id: "c", used_in: "NG" }];
  const { results } = searchBusinessTypes("bread seller", { region: "NG", types, aliases });
  expect(results.map((item) => [item.type.id, item.tier])).toEqual([
    ["a", MATCH_TIERS.EXACT_NAME],
    ["b", MATCH_TIERS.NAME_PREFIX],
    ["e", MATCH_TIERS.NAME_PREFIX],
    ["c", MATCH_TIERS.ALIAS],
    ["d", MATCH_TIERS.CLOSE_SPELLING]
  ]);
});

test("3: approved aliases and spelling variants find the right business", async ({ page }) => {
  await useSampleAliases(page);
  await openSearchStep(page);
  expect((await resultsFor(page, "business centre"))[0]).toBe("Document & Print Services");
  expect((await resultsFor(page, "cyber cafe"))[0]).toBe("Document & Print Services");
  expect((await resultsFor(page, "okada"))[0]).toBe("Okada / Keke Rider");
  expect((await resultsFor(page, "achaba"))[0]).toBe("Okada / Keke Rider");
  expect(await resultsFor(page, "okadda")).toEqual(["Okada / Keke Rider"]);
  expect((await optionNotes(page))[0]).toContain("close spelling");
  expect(await resultsFor(page, "ɗan kasuwa")).toEqual(["Market Trader"]);
  expect(await resultsFor(page, "dan kasuwa")).toEqual(["Market Trader"]);
});

test("4: a close spelling is only a suggestion until the user picks it", async ({ page }) => {
  await useSampleAliases(page);
  await openSearchStep(page);
  expect(await resultsFor(page, "photocpy")).toEqual(["Document & Print Services"]);
  await expect(page.locator("#business-search-results [aria-selected=true]")).toHaveCount(0);
  await search(page).press("Enter");
  await expect(page.locator(".step.active")).toHaveAttribute("data-step", "3");
  expect((await readStoredProfile(page))?.business_type_id ?? null).toBeNull();
  await search(page).press("ArrowDown");
  await search(page).press("Enter");
  await expect(page.locator(".step.active")).toHaveAttribute("data-step", "5");
});

test("5: with the real (empty) alias list, names still search and 'not listed' is offered", async ({ page }) => {
  await openSearchStep(page);
  expect((await resultsFor(page, "Document"))[0]).toBe("Document & Print Services");
  expect((await resultsFor(page, "Tutor"))[0]).toBe("Tutoring / Lessons");
  expect(await resultsFor(page, "business centre")).toEqual([]);
  await expect(page.locator("#business-search-status")).toHaveText("No matches");
});

test("6: nonsense shows 'No matches' and 'My business isn't listed'", async ({ page }) => {
  await useSampleAliases(page);
  await openSearchStep(page);
  expect(await resultsFor(page, "xqzvw")).toEqual([]);
  await expect(page.locator("#business-search-results .business-search-empty")).toHaveText("No matches");
  await expect(page.locator("#business-search-status")).toHaveText("No matches");
});

test("7: 'not listed' stays available, last, alongside matches", async ({ page }) => {
  await useSampleAliases(page);
  await openSearchStep(page);
  expect(await resultsFor(page, "printing")).toEqual(["Document & Print Services"]);
  await expect(page.locator("#business-search-results [role=option]").last()).toHaveId("business-option-unlisted");
  await expect(page.locator("#business-not-listed")).toBeVisible();
});

async function changeProfileToSearchStep(page) {
  await page.locator("#nav-record-v2").click();
  await page.locator("#change-profile").click();
  await page.locator("#confirm-change-profile").click();
  await chooseCountry(page, "country-grid", "Nigeria");
  await chooseCountry(page, "operating-region-grid", "Nigeria");
  await expect(page.getByRole("heading", { name: "What business do you do?" })).toBeVisible();
}

async function saveUnlisted(page, description) {
  await page.locator("#business-not-listed").click();
  await page.locator("#business-description").fill(description);
  await page.locator("#unlisted-continue").click();
}

async function finishProfile(page) {
  await expect(page.getByRole("heading", { name: "About you" })).toBeVisible();
  await page.locator("#finish-onboarding").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
}

const SERVER_TIMEOUT = { timeout: 20_000 };

test("8 + 9: listed -> unlisted -> listed, persisted on the server and across devices", async ({ page, browser }) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("picker-unlisted"));
  await changeProfileToSearchStep(page);

  // Refused descriptions.
  await page.locator("#business-not-listed").click();
  await page.locator("#unlisted-continue").click();
  await expect(page.locator("#business-description-error")).toHaveText("Describe your business in 3 to 60 characters.");
  await page.locator("#business-description").fill("x".repeat(61));
  await page.locator("#unlisted-continue").click();
  await expect(page.locator("#business-description-error")).toBeVisible();
  await expect(page.locator(".step.active")).toHaveAttribute("data-step", "3");

  await saveUnlisted(page, "Document courier and errands");
  await finishProfile(page);
  const local = (await readStoredProfile(page));
  expect(local).toMatchObject({ business_type_id: "unlisted", business_description: "Document courier and errands", sector_id: null, preferred_labels: [] });
  await expect.poll(() => profileRowForEmail(account.email), SERVER_TIMEOUT).toMatchObject({
    // This app version sends no sector for an unlisted business: the server files it under
    // "Other business" as a fallback (U2), never as the person's choice.
    business_type_id: "unlisted", business_description: "Document courier and errands", sector_id: "other_activity", sector_source: "fallback", preferred_labels: []
  });
  await expect(page.locator("#profile-summary")).toContainText("Document courier and errands");

  // 9: reload keeps it; a fresh device restores it.
  await page.reload();
  await expect(page.locator("#profile-summary")).toContainText("Document courier and errands");
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL, serviceWorkers: "block" });
  const second = await other.newPage();
  await second.goto("/");
  await restoreThroughUi(second, account);
  await expect(second.locator("#profile-summary")).toContainText("Document courier and errands", SERVER_TIMEOUT);
  expect((await readStoredProfile(second))).toMatchObject({ business_type_id: "unlisted", business_description: "Document courier and errands" });
  await other.close();

  // Back to a listed type: the description is cleared locally and on the server.
  await changeProfileToSearchStep(page);
  await search(page).fill("Market Trader");
  await page.locator("#business-search-results [role=option]").first().click();
  await page.locator("#onboarding-next").click();
  await finishProfile(page);
  expect((await readStoredProfile(page))).toMatchObject({ business_type_id: "ng_market_trader", sector_id: "trade_retail", business_description: "" });
  await expect.poll(() => profileRowForEmail(account.email), SERVER_TIMEOUT).toMatchObject({
    business_type_id: "ng_market_trader", sector_id: "trade_retail", sector_source: "catalog", business_description: null
  });
});

async function recordByHand(page, action, label, amount) {
  await page.locator("#primary-actions").getByRole("button", { name: new RegExp(action) }).click();
  await page.locator("#open-selector").click();
  await page.locator('[data-mode="other"]').click();
  await page.locator("#custom-label-input").fill(label);
  await page.locator("#save-custom-label").click();
  await page.locator("#amount-input-v2").fill(String(amount));
  await page.locator("#prepare-confirmation").click();
  await page.locator("#confirm-append").click();
  await expect(page.locator("#screen-dashboard.active")).toBeVisible();
  await page.locator("#nav-record-v2").click();
}

test("10: an unlisted business records by hand and the statements stay right", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("picker-statements"));
  await changeProfileToSearchStep(page);
  await saveUnlisted(page, "Document courier and errands");
  await finishProfile(page);
  await expect(page.locator("#quick-label-grid")).toBeVisible();

  await recordByHand(page, "Sell", "Courier delivery", 1000);
  await recordByHand(page, "Buy", "Envelopes", 400);
  await recordByHand(page, "Pay", "Bike fuel", 200);

  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length, { timeout: 30_000 }).toBe(0);
  const entries = ledgerEntriesForDevice((await readLocalState(page)).settings.device_identity);
  expect(entries.map((entry) => [entry.payload.label, entry.payload.transaction_type]))
    .toEqual(expect.arrayContaining([["Courier delivery", "sale"], ["Envelopes", "purchase"], ["Bike fuel", "payment"]]));
  expect(computeFinancialStatements(entries, "NGN").incomeStatement).toEqual({
    grossRevenue: 100000, otherIncome: 0, costOfGoods: 40000, operatingExpenses: 20000, netIncome: 40000
  });
});

test("11: each country searches only its own and GLOBAL types, and never says a business is unavailable", async ({ page }) => {
  await useSampleAliases(page);
  const shown = async (query) => resultsFor(page, query);

  await openSearchStep(page, "Nigeria");
  expect(await shown("store")).toEqual([]);
  expect(await shown("Retail")).toEqual(["Retail / Trading"]);
  expect(await shown("corner shop")).toEqual(["Provision Shop"]);
  expect(await shown("trotro")).toEqual([]);
  expect((await shown("business centre"))[0], "a Nigeria-tagged alias works in Nigeria").toBe("Document & Print Services");

  await openSearchStep(page, "United States");
  expect(await shown("business centre"), "a Nigeria-tagged alias on a GLOBAL type is not searched in the US").toEqual([]);
  expect(await shown("cyber cafe"), "an 'any' alias on a GLOBAL type is searched everywhere").toEqual(["Document & Print Services"]);
  expect(await shown("store")).toEqual(["Retail"]);
  expect(await shown("okada")).toEqual([]);
  expect(await shown("Market Trader")).toEqual([]);
  expect(await shown("corner shop")).toEqual([]);

  for (const country of ["Ghana", "Uganda"]) {
    await openSearchStep(page, country);
    expect(await shown("tutor")).toEqual(["Tutoring / Lessons"]);
    expect(await shown("Retail")).toEqual(["Retail / Trading"]);
    expect(await shown("Market Trader")).toEqual([]);
    expect(await shown("okada")).toEqual([]);
    expect(await shown("trotro")).toEqual([]);
    expect(await shown("business centre"), `a Nigeria-tagged alias is not searched in ${country}`).toEqual([]);
    const global = BUSINESS_TYPES.filter((item) => item.country === "GLOBAL").map((item) => item.name);
    for (const name of global) expect(await shown(name), `${country} finds ${name}`).toContain(name);
    const text = await page.locator("#screen-onboarding").innerText();
    expect(text).not.toMatch(/not available|unavailable|only in|Nigeria only|United States only/i);
    expect(await optionNotes(page)).not.toContain(expect.stringMatching(/Nigeria|United States/));
  }
});

test("12: an unlisted or unknown type keeps no old shortcut preferences", async ({ page }) => {
  await openSearchStep(page);
  await page.locator("#sector-grid").getByRole("button", { name: /Trade & Retail/ }).click();
  await page.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();
  await page.locator("#onboarding-next").click();
  await finishLocalOnboarding(page, "Labels test");
  // Seed shortcut preferences directly (choosing one during onboarding hits a separate, known reload issue).
  const kept = QUICK_PICKS.ng_market_trader.sell.slice(0, 2);
  const withLabels = async (businessTypeId) => {
    await putStoreValue(page, "settings", { ...(await readStoredProfile(page)), business_type_id: businessTypeId, preferred_labels: kept });
    await page.reload();
    await expect(page.locator("#screen-capture.active")).toBeVisible();
    await page.locator("#nav-settings-v2").click();
    await page.locator("#reminder-toggle").click();
  };

  await withLabels("ng_market_trader");
  await expect.poll(async () => (await readStoredProfile(page)).preferred_labels, { message: "an existing type keeps its shortcuts" }).toEqual(kept);

  // An unknown type id (from another catalog version) drops its labels on load; the next save persists that.
  await withLabels("ng_ghost_type");
  await expect.poll(async () => (await readStoredProfile(page)).preferred_labels).toEqual([]);

  // Choosing "not listed" also leaves no shortcuts behind.
  await withLabels("ng_market_trader");
  await changeProfileToSearchStep(page);
  await saveUnlisted(page, "Document courier and errands");
  await finishProfile(page);
  expect(await readStoredProfile(page)).toMatchObject({ business_type_id: "unlisted", preferred_labels: [] });
});

const OLD_APP_URL = process.env.APP_TEST_OLD_APP_URL || "http://127.0.0.1:5501";

// Serves app-v3 exactly as it was at a commit: 5f8307d is v36; 96a7b22 is v37, live before the
// sector-assignment release.
async function serveOldApp(commit = "5f8307d", appUrl = OLD_APP_URL) {
  const dir = mkdtempSync(path.join(tmpdir(), `konfirmata-${commit}-`));
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const archive = execFileSync("git", ["-C", repo, "archive", commit, "app-v3"]);
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  const root = path.join(dir, "app-v3");
  const url = new URL(appUrl);
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, url).pathname.replace(/^\/app(?:\/|$)/, "").replace(/^\/+/, "") || "index.html";
    const file = path.resolve(root, pathname);
    if (!file.startsWith(root)) return response.writeHead(403).end();
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(Number(url.port), url.hostname, resolve));
  return server;
}

test("13: existing profiles still work, including the v36 app holding an unlisted profile", async ({ page, browser }) => {
  test.slow();
  // Existing types show as selected when revisited.
  await openSearchStep(page);
  await page.locator("#sector-grid").getByRole("button", { name: /Food & Hospitality/ }).click();
  await page.locator("#business-grid").getByRole("button", { name: /Food Vendor/ }).click();
  await page.locator("#onboarding-back").click();
  await expect(page.locator("#business-grid .visual-card.active")).toContainText("Food Vendor");
  await page.locator("#business-grid").getByRole("button", { name: /Food Vendor/ }).click();
  await page.locator("#onboarding-next").click();
  await finishLocalOnboarding(page, "Food vendor");

  // An old sector-only profile (no type) still loads.
  await putStoreValue(page, "settings", { ...(await readStoredProfile(page)), business_type_id: null, sector_id: "food_hospitality", display_name: "Sector only" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.reload();
  await expect(page.locator("#screen-onboarding.active, #screen-capture.active")).toBeVisible();

  // The v36 app restores an unlisted profile without crashing, and its saves keep the description.
  const currentContext = await browser.newContext({ baseURL: test.info().project.use.baseURL, serviceWorkers: "block" });
  const current = await currentContext.newPage();
  current.on("pageerror", (error) => errors.push(error.message));
  const account = await signInThroughUi(current, nextAccount("picker-v36"));
  await changeProfileToSearchStep(current);
  await saveUnlisted(current, "Document courier and errands");
  await finishProfile(current);
  await currentContext.close();
  await expect.poll(() => profileRowForEmail(account.email), SERVER_TIMEOUT).toMatchObject({ business_type_id: "unlisted" });

  const oldServer = await serveOldApp();
  const oldContext = await browser.newContext({ baseURL: OLD_APP_URL, serviceWorkers: "block" });
  try {
    const old = await oldContext.newPage();
    const oldErrors = [];
    old.on("pageerror", (error) => oldErrors.push(error.message));
    await old.goto("/");
    await restoreThroughUi(old, account);
    await expect(old.locator("#screen-capture.active, #screen-settings.active, #screen-dashboard.active")).toBeVisible(SERVER_TIMEOUT);
    expect((await readStoredProfile(old)).business_type_id).toBe("unlisted");

    await old.locator("#nav-settings-v2").click();
    const language = old.locator("#settings-language-select");
    await expect(language.locator("option").first()).toBeAttached();
    const values = await language.locator("option").evaluateAll((options) => options.map((option) => option.value));
    const pushed = old.waitForResponse((response) => response.url().endsWith("/profile") && response.request().method() === "POST");
    const current = await language.inputValue();
    await language.selectOption(values.find((value) => value !== current) || values[0]);
    expect((await pushed).status()).toBe(200);
    expect(profileRowForEmail(account.email)).toMatchObject({ business_type_id: "unlisted", business_description: "Document courier and errands" });
    expect(oldErrors, "the v36 app threw no page errors").toEqual([]);
  } finally {
    await oldContext.close();
    await new Promise((resolve) => oldServer.close(resolve));
  }
  expect(errors, "the current app threw no page errors").toEqual([]);
});

// The test API allows only the current-app and old-app origins; the old-app tests run one at a time
// and each closes its server, so v37 is served on the old-app origin too.
const LIVE_V37_APP_URL = OLD_APP_URL;

test("13b (T-C1, T-C3): the live v37 app restores new sector ids and its saves never erase a chosen sector", async ({ browser }) => {
  test.slow();
  const errors = [];
  const currentContext = await browser.newContext({ baseURL: test.info().project.use.baseURL, serviceWorkers: "block" });
  const current = await currentContext.newPage();
  current.on("pageerror", (error) => errors.push(error.message));
  const account = await signInThroughUi(current, nextAccount("picker-v37"));
  await changeProfileToSearchStep(current);
  await saveUnlisted(current, "Poultry and eggs");
  await finishProfile(current);
  await currentContext.close();
  await expect.poll(() => profileRowForEmail(account.email), SERVER_TIMEOUT).toMatchObject({
    business_type_id: "unlisted", sector_id: "other_activity", sector_source: "fallback"
  });
  // As a newer app would store the person's own choice of a sector the v37 catalog does not know.
  setProfileSectorForEmail(account.email, "agriculture", "user");

  const v37Server = await serveOldApp("96a7b22", LIVE_V37_APP_URL);
  const v37Context = await browser.newContext({ baseURL: LIVE_V37_APP_URL, serviceWorkers: "block" });
  try {
    const v37 = await v37Context.newPage();
    const v37Errors = [];
    v37.on("pageerror", (error) => v37Errors.push(error.message));
    await v37.goto("/");
    await restoreThroughUi(v37, account);
    await expect(v37.locator("#screen-capture.active, #screen-settings.active, #screen-dashboard.active")).toBeVisible(SERVER_TIMEOUT);
    expect((await readStoredProfile(v37))).toMatchObject({ business_type_id: "unlisted", business_description: "Poultry and eggs" });
    await expect(v37.locator("#profile-summary")).toContainText("Poultry and eggs");

    // A v37 save (it sends sector_id: null for an unlisted business) keeps the stored choice.
    await v37.locator("#nav-settings-v2").click();
    const language = v37.locator("#settings-language-select");
    await expect(language.locator("option").first()).toBeAttached();
    const values = await language.locator("option").evaluateAll((options) => options.map((option) => option.value));
    const pushed = v37.waitForResponse((response) => response.url().endsWith("/profile") && response.request().method() === "POST");
    const chosen = await language.inputValue();
    await language.selectOption(values.find((value) => value !== chosen) || values[0]);
    const response = await pushed;
    expect(response.status()).toBe(200);
    expect(JSON.parse(response.request().postData() || "{}").sector_id ?? null, "v37 sends no sector for unlisted").toBeNull();
    expect(profileRowForEmail(account.email)).toMatchObject({
      business_type_id: "unlisted", business_description: "Poultry and eggs", sector_id: "agriculture", sector_source: "user"
    });

    // A reload restores again without errors.
    await v37.reload();
    await expect(v37.locator("#profile-summary")).toContainText("Poultry and eggs", SERVER_TIMEOUT);
    expect(v37Errors, "the live v37 app threw no page errors").toEqual([]);
  } finally {
    await v37Context.close();
    await new Promise((resolve) => v37Server.close(resolve));
  }
  expect(errors, "the current app threw no page errors").toEqual([]);
});

test("14: choosing from search fills the sector, exactly as browsing does", async ({ page, browser }) => {
  await openSearchStep(page);
  await search(page).fill("Market Trader");
  await page.locator("#business-search-results [role=option]").first().click();
  await expect(page.locator(".step.active")).toHaveAttribute("data-step", "5");
  await page.locator("#onboarding-next").click();
  await finishLocalOnboarding(page);
  const pick = ({ business_type_id, sector_id, preferred_labels, business_description }) => ({ business_type_id, sector_id, preferred_labels, business_description });
  const fromSearch = pick((await readStoredProfile(page)));

  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL, serviceWorkers: "block" });
  const browsePage = await other.newPage();
  await openSearchStep(browsePage);
  await browsePage.locator("#sector-grid").getByRole("button", { name: /Trade & Retail/ }).click();
  await browsePage.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();
  await browsePage.locator("#onboarding-next").click();
  await finishLocalOnboarding(browsePage);
  expect(pick((await readStoredProfile(browsePage)))).toEqual(fromSearch);
  expect(fromSearch).toEqual({ business_type_id: "ng_market_trader", sector_id: "trade_retail", preferred_labels: [], business_description: "" });
  await other.close();
});

test("15: phone layout: no sideways scroll, 44px targets, results scroll with the keyboard open", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await useSampleAliases(page);
  await openSearchStep(page);
  await search(page).fill("s");
  expect(await page.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(375);
  for (const locator of [search(page), page.locator("#business-not-listed"), page.locator("#business-search-results [role=option]").first(), page.locator("#business-option-unlisted")]) {
    expect((await locator.boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
  // Roughly the space left above an on-screen keyboard.
  await page.setViewportSize({ width: 375, height: 420 });
  const list = page.locator("#business-search-results");
  const sizes = await list.evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight }));
  expect(sizes.scroll, "the result list scrolls within itself").toBeGreaterThan(sizes.client);
  await page.locator("#business-option-unlisted").scrollIntoViewIfNeeded();
  await expect(page.locator("#business-option-unlisted")).toBeInViewport();
  expect(await page.evaluate(() => document.scrollingElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test("16: keyboard: arrows move, Enter selects, Escape closes, 'not listed' is reachable", async ({ page }) => {
  await useSampleAliases(page);
  await openSearchStep(page);
  await search(page).fill("pho");
  const input = search(page);
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", "business-option-0");
  await expect(page.locator("#business-option-0")).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", "business-option-1");
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", "business-option-unlisted");
  await input.press("ArrowUp");
  await expect(input).toHaveAttribute("aria-activedescendant", "business-option-1");
  await input.press("Escape");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#business-search-results")).toBeHidden();
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await input.press("ArrowUp");
  await expect(input).toHaveAttribute("aria-activedescendant", "business-option-unlisted");
  await input.press("Enter");
  await expect(page.locator("#business-description")).toBeFocused();
  await page.locator("#business-description").press("Shift+Tab");
  await expect(page.locator("#business-description")).not.toBeFocused();
  await search(page).fill("pho");
  await search(page).press("Tab");
  await expect(search(page)).not.toBeFocused();
});

test("17: screen-reader roles and states", async ({ page }) => {
  await useSampleAliases(page);
  await openSearchStep(page);
  const input = search(page);
  await expect(input).toHaveAttribute("role", "combobox");
  await expect(input).toHaveAttribute("aria-autocomplete", "list");
  await expect(input).toHaveAttribute("aria-controls", "business-search-results");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).toHaveAccessibleName(/Search business types/);
  await input.fill("tutor");
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#business-search-results")).toHaveAttribute("role", "listbox");
  await expect(page.getByRole("option", { name: /Tutoring \/ Lessons.*Available everywhere/ })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("option", { name: /My business isn't listed/ })).toBeVisible();
  await expect(page.locator("#business-search-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator("#business-search-status")).toHaveText("1 match");
  await expect(page.locator("#business-description-error")).toHaveAttribute("role", "alert");
});

test("18: every search example in the placeholder finds a match with the shipped alias list, in any country", async ({ page }) => {
  // No alias route here: this uses the real shipped business-aliases.js.
  for (const country of ["Nigeria", "United States", "Uganda"]) {
    await openSearchStep(page, country);
    const placeholder = await search(page).getAttribute("placeholder");
    const examples = placeholder.replace(/^e\.g\.\s*/, "").split(",").map((word) => word.trim()).filter(Boolean);
    expect(examples.length, `examples parsed from "${placeholder}"`).toBeGreaterThan(0);
    for (const example of examples) {
      const names = await resultsFor(page, example);
      expect(names.length, `"${example}" finds a business type in ${country}`).toBeGreaterThan(0);
    }
  }
});
