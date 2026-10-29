import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { BUSINESS_TYPES, LAYER_B, QUICK_PICKS, SECTORS } from "../../../app-v3/catalog-data.js";
import { computeFinancialStatements } from "../../../server/src/report-statements.js";
import { ledgerEntriesForDevice, nextAccount, readLocalState, signInThroughUi } from "./helpers.mjs";

const baseline = JSON.parse(readFileSync(new URL("../fixtures/catalog-baseline-4f90cfb.json", import.meta.url), "utf8"));

// The three business types added in Part 1, each once and available everywhere (R7).
const NEW_TYPES = ["global_document_services", "global_tutoring", "global_device_repair"];
const REMOVED_TYPES = ["ng_pos_agent", "ng_document_services", "ng_tutoring", "ng_device_repair"];

// Reviewed allowlist of direct inputs that may be filed as purchases (cost of goods) for the new types.
const NEW_TYPE_PURCHASE_ALLOWLIST = new Set([
  "Paper (Ream)", "Toner/Ink", "Lamination Film", "Binding Supplies", "Photo Paper",
  "Textbooks", "Course Materials", "Stationery",
  "Spare Parts", "Screens", "Batteries", "Accessories Stock"
]);
// Sale labels that usually include money collected for someone else (pass-through) or own-money movements.
const PASS_THROUGH_PATTERN = /registration|top-?up|float|wallet|token|cac|jamb|waec|neco|\bnin\b|remittance/i;

test("catalog: integrity of every business type", () => {
  const ids = BUSINESS_TYPES.map((item) => item.id);
  expect(new Set(ids).size, "business type ids must be unique").toBe(ids.length);
  const sectorIds = new Set(SECTORS.map((item) => item.id));
  for (const item of BUSINESS_TYPES) {
    expect(sectorIds.has(item.sector_id), `${item.id} has an unknown sector`).toBe(true);
    expect(item.name && item.icon, `${item.id} needs a name and icon`).toBeTruthy();
    const picks = QUICK_PICKS[item.id];
    expect(picks, `${item.id} has no quick picks`).toBeTruthy();
    expect(picks.sell?.length > 0, `${item.id} needs at least one sale shortcut`).toBe(true);
    for (const group of ["sell", "purchase", "payment", "receipt"]) {
      expect(Array.isArray(picks[group]), `${item.id}.${group} must be a list (may be empty)`).toBe(true);
      expect(new Set(picks[group]).size, `${item.id}.${group} has duplicates`).toBe(picks[group].length);
    }
  }
  for (const id of Object.keys(QUICK_PICKS)) expect(ids.includes(id), `QUICK_PICKS.${id} has no business type`).toBe(true);
  for (const [country, types] of Object.entries(LAYER_B)) {
    for (const typeId of Object.keys(types)) {
      const type = BUSINESS_TYPES.find((item) => item.id === typeId);
      expect(type?.country, `LAYER_B.${country}.${typeId} must belong to a ${country} business type`).toBe(country);
    }
  }
});

test("catalog: held and replaced types are gone everywhere", () => {
  const catalogText = readFileSync(new URL("../../../app-v3/catalog-data.js", import.meta.url), "utf8");
  for (const id of REMOVED_TYPES) {
    expect(BUSINESS_TYPES.some((item) => item.id === id), `${id} in BUSINESS_TYPES`).toBe(false);
    expect(QUICK_PICKS[id], `${id} in QUICK_PICKS`).toBeUndefined();
    expect(catalogText.includes(id), `${id} still mentioned in catalog-data.js`).toBe(false);
  }
  for (const id of NEW_TYPES) {
    expect(BUSINESS_TYPES.find((item) => item.id === id)?.country, `${id} must be GLOBAL`).toBe("GLOBAL");
  }
});

test("catalog: new types' shortcuts are classified for the statements", () => {
  for (const id of NEW_TYPES) {
    const picks = QUICK_PICKS[id];
    // receipt is reported as other income; customer payments for the business's own work are not other income.
    expect(picks.receipt, `${id} must have no receipt shortcuts`).toEqual([]);
    for (const label of picks.purchase) {
      expect(NEW_TYPE_PURCHASE_ALLOWLIST.has(label), `${id}: "${label}" is not an approved direct input`).toBe(true);
    }
    for (const label of picks.sell) {
      expect(PASS_THROUGH_PATTERN.test(label), `${id}: "${label}" looks like a pass-through amount`).toBe(false);
    }
  }
});

// Approved sector moves (U1, rules K1/K2, 2026-10-28). Nothing else about a type may change, and its
// suggestion group stays its production sector so ledger suggestions are unchanged.
const APPROVED_SECTOR_MOVES = { ng_kiosk_phone_business: "trade_retail", ng_fashion_tailor: "skilled_construction" };

test("catalog: existing business types are unchanged from production", () => {
  for (const before of baseline.BUSINESS_TYPES) {
    const now = BUSINESS_TYPES.find((item) => item.id === before.id);
    expect(now, `${before.id} disappeared`).toBeTruthy();
    const { suggestion_group: group, ...rest } = now;
    expect(group, `${before.id} suggestion group`).toBe(before.sector_id);
    expect(rest, `${before.id} changed`).toEqual({ ...before, sector_id: APPROVED_SECTOR_MOVES[before.id] || before.sector_id });
    expect(QUICK_PICKS[before.id], `${before.id} quick picks changed`).toEqual(baseline.QUICK_PICKS[before.id]);
  }
  for (const [country, types] of Object.entries(baseline.LAYER_B)) {
    for (const [typeId, groups] of Object.entries(types)) {
      expect(LAYER_B[country]?.[typeId], `LAYER_B.${country}.${typeId} changed`).toEqual(groups);
    }
  }
});

async function openBusinessStep(page, { country, sector }) {
  await page.goto("/");
  await page.locator("#country-grid").getByRole("button", { name: country }).click();
  await page.locator("#operating-region-grid").getByRole("button", { name: country }).click();
  await page.locator("#sector-grid").getByRole("button", { name: sector }).click();
  await expect(page.getByRole("heading", { name: "Choose your business type" })).toBeVisible();
}

async function businessCards(page) {
  return page.locator("#business-grid .visual-card").evaluateAll((cards) => cards.map((card) => ({
    name: card.querySelector("strong")?.textContent.trim(),
    note: card.querySelectorAll("span")[1]?.textContent.trim()
  })));
}

function expectOwnTypesFirst(cards, ownNames) {
  const firstGlobal = cards.findIndex((card) => card.note === "Available everywhere");
  const lastOwn = Math.max(...cards.map((card, index) => (ownNames.includes(card.name) ? index : -1)));
  expect(firstGlobal, "at least one GLOBAL type is offered").toBeGreaterThanOrEqual(0);
  expect(lastOwn, "own types come before GLOBAL types").toBeLessThan(firstGlobal);
}

test("visibility: Nigeria sees its own types first, then GLOBAL types, each once", async ({ page }) => {
  await openBusinessStep(page, { country: /Nigeria/, sector: /Personal & Professional Services/ });
  const cards = await businessCards(page);
  const names = cards.map((card) => card.name);
  const ownNames = BUSINESS_TYPES.filter((item) => item.country === "NG" && item.sector_id === "personal_professional").map((item) => item.name);
  for (const own of ownNames) expect(names, `${own} offered`).toContain(own);
  expect(names).toContain("Document & Print Services");
  expect(names).toContain("Personal / Professional Services");
  expect(new Set(names).size, "no business appears twice").toBe(names.length);
  expectOwnTypesFirst(cards, ownNames);
  for (const card of cards.filter((item) => !ownNames.includes(item.name))) {
    expect(card.note, `${card.name} is labelled as available everywhere`).toBe("Available everywhere");
  }
});

test("visibility: the US now sees GLOBAL types after its own", async ({ page }) => {
  await openBusinessStep(page, { country: /United States/, sector: /Personal & Professional Services/ });
  const cards = await businessCards(page);
  const ownNames = BUSINESS_TYPES.filter((item) => item.country === "US" && item.sector_id === "personal_professional").map((item) => item.name);
  expect(cards.map((card) => card.name)).toContain("Document & Print Services");
  expectOwnTypesFirst(cards, ownNames);
});

test("visibility: a country without its own types still sees the GLOBAL list", async ({ page }) => {
  await openBusinessStep(page, { country: /Ghana/, sector: /Personal & Professional Services/ });
  const names = (await businessCards(page)).map((card) => card.name);
  const expected = BUSINESS_TYPES.filter((item) => item.country === "GLOBAL" && item.sector_id === "personal_professional").map((item) => item.name);
  expect(names.sort()).toEqual(expected.sort());
});

async function recordQuickPick(page, action, label, amount) {
  await page.locator("#primary-actions").getByRole("button", { name: new RegExp(action) }).click();
  await page.locator("#quick-label-grid button").filter({ has: page.locator("strong", { hasText: new RegExp(`\\s${label.replace(/[()]/g, "\\$&")}$`) }) }).click();
  await page.locator("#amount-input-v2").fill(String(amount));
  await page.locator("#prepare-confirmation").click();
  await page.locator("#confirm-append").click();
  await expect(page.locator("#screen-dashboard.active")).toBeVisible();
  await page.locator("#nav-record-v2").click();
}

test("statements: document services shortcuts land on the right statement lines", async ({ page }) => {
  test.slow(); // a real sign-in is needed before records can be confirmed
  await signInThroughUi(page, nextAccount("print-statements"));
  // Switch business through the real "Change business profile" path.
  await page.locator("#nav-record-v2").click();
  await page.locator("#change-profile").click();
  await page.locator("#confirm-change-profile").click();
  await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#operating-region-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#sector-grid").getByRole("button", { name: /Personal & Professional Services/ }).click();
  await page.locator("#business-grid").getByRole("button", { name: /Document & Print Services/ }).click();
  await page.locator("#onboarding-next").click();
  await page.locator("#finish-onboarding").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();

  await recordQuickPick(page, "Sell", "Photocopy", 1000);
  await recordQuickPick(page, "Buy", "Paper (Ream)", 400);
  await recordQuickPick(page, "Pay", "Shop Rent", 200);

  const records = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("confirma-v3-db");
    open.onsuccess = () => {
      const request = open.result.transaction("records").objectStore("records").getAll();
      request.onsuccess = () => resolve(request.result.map((item) => [item.label, item.transaction_type]));
      request.onerror = () => reject(request.error);
    };
  }));
  expect(records).toEqual(expect.arrayContaining([["Photocopy", "sale"], ["Paper (Ream)", "purchase"], ["Shop Rent", "payment"]]));

  // Signed-in reports are built on the server from the synced ledger, so check those figures.
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length, { timeout: 30_000 }).toBe(0);
  const deviceIdentity = (await readLocalState(page)).settings.device_identity;
  const entries = ledgerEntriesForDevice(deviceIdentity);
  expect(entries.map((entry) => [entry.payload.label, entry.payload.transaction_type]))
    .toEqual(expect.arrayContaining([["Photocopy", "sale"], ["Paper (Ream)", "purchase"], ["Shop Rent", "payment"]]));
  const { incomeStatement } = computeFinancialStatements(entries, "NGN");
  // amounts are in minor units (kobo): NGN 1,000 = 100000
  expect(incomeStatement).toEqual({
    grossRevenue: 100000, otherIncome: 0, costOfGoods: 40000, operatingExpenses: 20000, netIncome: 40000
  });
});
