import { expect, test } from "@playwright/test";
import { ledgerEntriesForDevice, nextAccount, readLocalState, signInThroughUi } from "./helpers.mjs";

async function recordFirstShortcut(page, amount) {
  await page.locator("#nav-record-v2").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill(String(amount));
  await page.locator("#prepare-confirmation").click();
  await page.locator("#confirm-append").click();
  await expect(page.locator("#screen-dashboard.active")).toBeVisible();
}

test("a record confirmed while a sync is running is synced when that sync ends", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("sync-followup"));

  // Hold the first sync request open on the server side of the browser.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let syncCalls = 0;
  await page.route("**/sync/entries", async (route) => {
    syncCalls += 1;
    if (syncCalls === 1) {
      const response = await route.fetch();
      await held;
      return route.fulfill({ response });
    }
    return route.continue();
  });

  await recordFirstShortcut(page, 1111);
  await expect.poll(() => syncCalls, { message: "the first sync started" }).toBe(1);
  await recordFirstShortcut(page, 2222);
  // The second record is queued while the first sync is still running.
  expect((await readLocalState(page)).stores.syncQueue.length).toBe(2);

  release();
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length, {
    message: "the record confirmed mid-sync is synced without any further user action",
    timeout: 15_000
  }).toBe(0);
  expect(syncCalls).toBeGreaterThanOrEqual(2);
  const amounts = ledgerEntriesForDevice((await readLocalState(page)).settings.device_identity)
    .map((entry) => Number(entry.payload.amount_minor)).sort((a, b) => a - b);
  expect(amounts).toEqual([111100, 222200]);
  expect(account.accountId).toBeTruthy();
});
