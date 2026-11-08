import { expect, test } from "@playwright/test";
import { completeOnboarding, nextAccount } from "./helpers.mjs";

async function installQuickLabelRenderHold(page) {
  await page.addInitScript(() => {
    window.__quickLabelRenderHold = { armed: false, held: false, release: null };
    const originalGetAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function patchedGetAll(...args) {
      if (this.name !== "usage" || !window.__quickLabelRenderHold.armed) {
        return originalGetAll.apply(this, args);
      }
      window.__quickLabelRenderHold.armed = false;
      const request = originalGetAll.apply(this, args);
      const heldRequest = { onsuccess: null, onerror: null, result: undefined, error: null };
      request.onsuccess = () => {
        const release = () => {
          window.__quickLabelRenderHold.held = false;
          heldRequest.result = request.result;
          heldRequest.onsuccess?.call(heldRequest, new Event("success"));
        };
        window.__quickLabelRenderHold.held = true;
        window.__quickLabelRenderHold.release = release;
      };
      request.onerror = () => {
        heldRequest.error = request.error;
        heldRequest.onerror?.call(heldRequest, new Event("error"));
      };
      return heldRequest;
    };
  });
}

async function armQuickLabelRenderHold(page) {
  await page.evaluate(() => { window.__quickLabelRenderHold.armed = true; });
}

async function waitForQuickLabelRenderHold(page) {
  await page.waitForFunction(() => window.__quickLabelRenderHold.held);
}

async function releaseQuickLabelRenderHold(page) {
  await page.evaluate(() => window.__quickLabelRenderHold.release?.());
}

async function seedRecords(page, records) {
  await page.evaluate(async (items) => {
    const request = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      items.forEach((item) => tx.objectStore("records").put(item));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, records);
  await page.reload();
}

async function customLabelCount(page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const count = await new Promise((resolve, reject) => {
      const tx = db.transaction("customLabels", "readonly");
      const request = tx.objectStore("customLabels").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  });
}

test("history chips select action and label without filling details, and keyboard activation works", async ({ page }) => {
  await completeOnboarding(page, nextAccount("quick-transactions"));
  const confirmedAt = Math.floor(Date.now() / 1000);
  await seedRecords(page, [1, 2].map((id) => ({ id, entry_hash: `quick-${id}`, transaction_type: "sale", label: "Rice bags", normalized_label: "rice_bags", amount_minor: 100, confirmed_at: confirmedAt - id })));
  const chip = page.getByRole("button", { name: "Sell, Rice bags" });
  await expect(chip).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await chip.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#primary-actions").getByRole("button", { name: /Sell/ })).toHaveClass(/active/);
  await expect(page.locator("#selected-label-chip")).toContainText("Rice bags selected");
  await expect(page.locator("#amount-input-v2")).toBeFocused();
  await expect(page.locator("#amount-input-v2")).toBeInViewport();
  await expect(page.locator("#amount-input-v2")).toHaveValue("");
  await expect(page.locator("#counterparty-input-v2")).toHaveValue("");
});

test("a typed label's outflow chip never persists another custom label", async ({ page }) => {
  await completeOnboarding(page, nextAccount("quick-transactions"));
  await page.locator("#open-selector").click();
  await page.locator('[data-mode="other"]').click();
  await page.locator("#custom-label-input").fill("Typed quick expense");
  await page.locator("#save-custom-label").click();
  const beforeTaps = await customLabelCount(page);
  const confirmedAt = Math.floor(Date.now() / 1000);
  await seedRecords(page, [1, 2].map((id) => ({ id, entry_hash: `typed-quick-${id}`, transaction_type: "purchase", label: "Typed quick expense", normalized_label: "typed_quick_expense", amount_minor: 100, confirmed_at: confirmedAt - id })));
  const chip = page.getByRole("button", { name: "Buy, Typed quick expense" });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator("#selected-label-chip")).toContainText("Typed quick expense selected");
  await chip.click();
  await expect(page.locator("#selected-label-chip")).toContainText("Typed quick expense selected");
  expect(await customLabelCount(page)).toBe(beforeTaps);
});

test("new users see fallback chips and narrow screens do not overflow", async ({ page }) => {
  await completeOnboarding(page, nextAccount("quick-transactions"));
  await expect(page.locator("#quick-transactions-inflow button").first()).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a shortcut tap does not duplicate the label grid", async ({ page }) => {
  await completeOnboarding(page, nextAccount("quick-transactions-no-duplicate-grid"));
  const confirmedAt = Math.floor(Date.now() / 1000);
  await seedRecords(page, [1, 2].flatMap((id) => [
    { id: id * 10, entry_hash: `no-duplicate-sell-${id}`, transaction_type: "sale", label: "Rice bags", normalized_label: "rice_bags", amount_minor: 100, confirmed_at: confirmedAt - id },
    { id: id * 10 + 1, entry_hash: `no-duplicate-buy-${id}`, transaction_type: "purchase", label: "Sugar", normalized_label: "sugar", amount_minor: 100, confirmed_at: confirmedAt - id }
  ]));

  await expect(page.getByRole("button", { name: "Sell, Rice bags" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Buy, Sugar" })).toBeVisible();

  for (const { action, chip } of [
    { action: "Sell", chip: "Sell, Rice bags" },
    { action: "Buy", chip: "Buy, Sugar" }
  ]) {
    await page.locator("#primary-actions").getByRole("button", { name: action }).click();
    const gridItems = page.locator("#quick-label-grid .ranked-item");
    const browseItems = page.locator("#browse-results > *");
    await expect(gridItems.first()).toBeVisible();
    const initialGridCount = await gridItems.count();
    const initialBrowseCount = await browseItems.count();

    await page.getByRole("button", { name: chip }).click();
    await expect(gridItems).toHaveCount(initialGridCount);
    await page.waitForTimeout(100);
    await expect(gridItems).toHaveCount(initialGridCount);
    await expect(browseItems).toHaveCount(initialBrowseCount);

    const labelNames = await gridItems.locator("strong").allTextContents();
    expect(new Set(labelNames).size).toBe(labelNames.length);
  }
});

test("a regular action supersedes a delayed shortcut", async ({ page }) => {
  await installQuickLabelRenderHold(page);
  await completeOnboarding(page, nextAccount("quick-transactions-race-action"));
  const confirmedAt = Math.floor(Date.now() / 1000);
  await seedRecords(page, [1, 2].map((id) => ({ id, entry_hash: `race-action-${id}`, transaction_type: "sale", label: "Rice bags", normalized_label: "rice_bags", amount_minor: 100, confirmed_at: confirmedAt - id })));
  await expect(page.getByRole("button", { name: "Sell, Rice bags" })).toBeVisible();
  await armQuickLabelRenderHold(page);
  await page.getByRole("button", { name: "Sell, Rice bags" }).click();
  await waitForQuickLabelRenderHold(page);
  await page.locator("#primary-actions").getByRole("button", { name: /Buy/ }).click();
  await releaseQuickLabelRenderHold(page);
  await expect(page.locator("#primary-actions").getByRole("button", { name: /Buy/ })).toHaveClass(/active/);
  await expect(page.locator("#selected-label-chip")).toHaveText("No label selected yet.");
  await expect(page.locator("#amount-input-v2")).not.toBeFocused();
});

test("the newer delayed shortcut wins and focuses Amount once", async ({ page }) => {
  await installQuickLabelRenderHold(page);
  await completeOnboarding(page, nextAccount("quick-transactions-race-shortcut"));
  const confirmedAt = Math.floor(Date.now() / 1000);
  await seedRecords(page, [1, 2].flatMap((id) => [
    { id: id * 10, entry_hash: `race-sell-${id}`, transaction_type: "sale", label: "Rice bags", normalized_label: "rice_bags", amount_minor: 100, confirmed_at: confirmedAt - id },
    { id: id * 10 + 1, entry_hash: `race-buy-${id}`, transaction_type: "purchase", label: "Sugar", normalized_label: "sugar", amount_minor: 100, confirmed_at: confirmedAt - id }
  ]));
  await expect(page.getByRole("button", { name: "Sell, Rice bags" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Buy, Sugar" })).toBeVisible();
  await page.evaluate(() => {
    window.__quickAmountFocuses = 0;
    document.getElementById("amount-input-v2").addEventListener("focus", () => { window.__quickAmountFocuses += 1; });
  });
  await armQuickLabelRenderHold(page);
  await page.getByRole("button", { name: "Sell, Rice bags" }).click();
  await waitForQuickLabelRenderHold(page);
  await page.getByRole("button", { name: "Buy, Sugar" }).click();
  await expect(page.locator("#amount-input-v2")).toBeFocused();
  await releaseQuickLabelRenderHold(page);
  await expect(page.locator("#primary-actions").getByRole("button", { name: /Buy/ })).toHaveClass(/active/);
  await expect(page.locator("#selected-label-chip")).toContainText("Sugar selected");
  await expect(page.locator("#amount-input-v2")).toBeFocused();
  expect(await page.evaluate(() => window.__quickAmountFocuses)).toBe(1);
});

test("a regular grid label supersedes a delayed shortcut", async ({ page }) => {
  await installQuickLabelRenderHold(page);
  await completeOnboarding(page, nextAccount("quick-transactions-race-grid"));
  const confirmedAt = Math.floor(Date.now() / 1000);
  await seedRecords(page, [1, 2].map((id) => ({ id, entry_hash: `race-grid-${id}`, transaction_type: "sale", label: "Rice bags", normalized_label: "rice_bags", amount_minor: 100, confirmed_at: confirmedAt - id })));
  await expect(page.getByRole("button", { name: "Sell, Rice bags" })).toBeVisible();
  const gridLabel = page.locator("#quick-label-grid button").filter({ hasNotText: "Rice bags" }).first();
  const gridLabelText = (await gridLabel.locator("strong").innerText()).replace(/^\S+\s+/, "");
  const gridLabelHandle = await gridLabel.elementHandle();
  await armQuickLabelRenderHold(page);
  await page.getByRole("button", { name: "Sell, Rice bags" }).click();
  await waitForQuickLabelRenderHold(page);
  await gridLabelHandle.evaluate((button) => button.click());
  await releaseQuickLabelRenderHold(page);
  await expect(page.locator("#selected-label-chip")).toContainText(`${gridLabelText} selected`);
  await expect(page.locator("#amount-input-v2")).not.toBeFocused();
});
