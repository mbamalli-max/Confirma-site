import { expect, test } from "@playwright/test";
import {
  APP_API_URL,
  completeOnboarding,
  nextAccount,
  openSignedOutVerification,
  readLocalState,
  readStoredProfile,
  removeLocalData,
  requestCode,
  restoreThroughUi,
  signInThroughUi,
  verifyWithCode,
  writeLocalState
} from "./helpers.mjs";

async function reachProfileStep(page) {
  await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#operating-region-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#sector-grid").getByRole("button", { name: /Trade & Retail/ }).click();
  await page.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();
  await page.locator("#onboarding-next").click();
  await expect(page.getByRole("heading", { name: "About you" })).toBeVisible();
}

async function changeBusinessProfile(page) {
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-change-profile-v2").click();
  await page.locator("#confirm-change-profile").click();
  await reachProfileStep(page);
}

test("new user phone stays editable and is saved during onboarding", async ({ page }) => {
  const account = nextAccount("readonly-new");
  await page.goto("/");
  await reachProfileStep(page);
  await expect(page.locator("#onboarding-phone")).toBeEditable();
  await page.locator("#onboarding-name").fill(account.name);
  await page.locator("#onboarding-phone").fill(account.phone);
  await page.locator("#onboarding-email").fill(account.email);
  await page.locator("#finish-onboarding").click();
  await expect(page.locator("#screen-otp.active")).toBeVisible();
  await expect.poll(async () => (await readStoredProfile(page))?.phone_number).toBe(`+234${account.phone.slice(1)}`);
});

test("linked account locks its stored phone through Change business profile and reload", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("readonly-linked"));
  await changeBusinessProfile(page);
  await expect(page.locator("#onboarding-phone")).toHaveValue(account.phone);
  await expect(page.locator("#onboarding-phone")).toHaveAttribute("readonly", "");
  await expect(page.locator("#onboarding-phone-readonly-note")).toHaveText("Phone number changes aren't available yet.");
  await page.reload();
  await expect(page.locator("#onboarding-phone")).toHaveValue(account.phone);
  await expect(page.locator("#onboarding-phone")).toHaveAttribute("readonly", "");
});

test("linked signed-out and expired sessions retain the phone lock", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("readonly-signed-out"));
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-logout-v2").click();
  await openSignedOutVerification(page, account);
  await expect(page.locator("#otp-phone-input")).toHaveAttribute("readonly", "");
  await page.reload();
  await openSignedOutVerification(page, account);
  await expect(page.locator("#otp-phone-input")).toHaveAttribute("readonly", "");

  const code = await requestCode(page);
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  await expect(page.locator("#screen-settings.active")).toBeVisible();
  await writeLocalState(page, { auth_token_expires_at: new Date(Date.now() - 60_000).toISOString(), signed_out: false });
  await page.reload();
  await changeBusinessProfile(page);
  await expect(page.locator("#onboarding-phone")).toHaveAttribute("readonly", "");
});

test("script-mutated linked phone cannot be saved or sent as a different number", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("readonly-bypass"));
  await changeBusinessProfile(page);
  await page.locator("#onboarding-phone").evaluate((input) => { input.value = "08030000000"; });
  await page.locator("#onboarding-name").fill(`${account.name} updated`);
  await page.locator("#finish-onboarding").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect.poll(async () => (await readStoredProfile(page))?.phone_number).toBe(`+234${account.phone.slice(1)}`);
});

test("email sign-in still succeeds after sign-out", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("readonly-email"));
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-logout-v2").click();
  await openSignedOutVerification(page, account);
  const code = await requestCode(page);
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  await expect(page.locator("#screen-settings.active")).toBeVisible();
});

test("fresh-device restore locks the restored account phone", async ({ page, browser }, testInfo) => {
  const account = await signInThroughUi(page, nextAccount("readonly-restore"));
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const fresh = await context.newPage();
  try {
    await fresh.goto("/");
    await writeLocalState(fresh, { sync_api_base_url: APP_API_URL });
    await fresh.reload();
    await restoreThroughUi(fresh, account);
    await expect(fresh.locator("#screen-capture.active")).toBeVisible();
    await fresh.locator("#nav-settings-v2").click();
    await fresh.locator("#settings-change-profile-v2").click();
    await fresh.locator("#confirm-change-profile").click();
    await reachProfileStep(fresh);
    await expect(fresh.locator("#onboarding-phone")).toHaveValue(account.phone);
    await expect(fresh.locator("#onboarding-phone")).toHaveAttribute("readonly", "");
  } finally {
    await context.close();
  }
});

test("Remove local data clears the phone binding for a fresh registration", async ({ page }) => {
  await signInThroughUi(page, nextAccount("readonly-wipe"));
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-logout-v2").click();
  await removeLocalData(page);
  await expect(page.locator("#screen-onboarding.active")).toBeVisible();
  await expect(page.locator("#onboarding-phone")).toBeEditable();
  const state = await readLocalState(page);
  expect(state.settings.bound_account).toBeUndefined();
  expect(state.settings.bound_phone_number).toBeUndefined();
});
