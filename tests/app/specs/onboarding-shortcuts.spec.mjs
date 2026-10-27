import { expect, test } from "@playwright/test";
import { readLocalState, readStoredProfile } from "./helpers.mjs";

test("a shortcut chosen during first onboarding survives reload without signing the device out", async ({ page }) => {
  await page.goto("/");
  await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#operating-region-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#sector-grid").getByRole("button", { name: /Trade & Retail/ }).click();
  await page.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();
  const shortcut = page.locator("#common-label-grid button").first();
  const label = (await shortcut.locator("strong").textContent()).replace(/^\S+\s/u, "").trim();
  await shortcut.click();
  await expect(shortcut).toHaveClass(/active/);
  expect(await readStoredProfile(page), "nothing is stored before onboarding finishes").toBeUndefined();

  await page.locator("#onboarding-next").click();
  await page.locator("#onboarding-name").fill("Shortcut test");
  await page.locator("#finish-onboarding").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  const local = await readLocalState(page);
  expect(local.settings.local_origin).toBe("this_version");
  expect((await readStoredProfile(page)).preferred_labels).toEqual([label]);

  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect(page.locator("#screen-signed-out")).not.toHaveClass(/active/);
  expect((await readStoredProfile(page)).preferred_labels).toEqual([label]);
});

test("changing a shortcut after onboarding is still saved straight away", async ({ page }) => {
  await page.goto("/");
  await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#operating-region-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#sector-grid").getByRole("button", { name: /Trade & Retail/ }).click();
  await page.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();
  await page.locator("#onboarding-next").click();
  await page.locator("#onboarding-name").fill("Shortcut test");
  await page.locator("#finish-onboarding").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  expect((await readStoredProfile(page)).preferred_labels).toEqual([]);

  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-preferred-edit-v2").click();
  await page.locator("#settings-preferred-grid button").first().click();
  await expect.poll(async () => (await readStoredProfile(page)).preferred_labels.length).toBe(1);
});
