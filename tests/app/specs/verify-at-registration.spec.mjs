import { expect, test } from "@playwright/test";
import {
  APP_API_URL,
  completeOnboarding,
  nextAccount,
  profileRowForEmail,
  requestCode,
  seedUnverifiedProfile,
  signInThroughUi,
  userCountForEmail,
  verifyWithCode
} from "./helpers.mjs";

const SERVER_TIMEOUT = { timeout: 20_000 };

test("registration requires a valid phone number and email before it can continue", async ({ page }) => {
  const account = nextAccount("registration-required");
  await page.goto("/");
  await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#operating-region-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#sector-grid").getByRole("button", { name: /Trade & Retail/ }).click();
  await page.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();
  await page.locator("#onboarding-next").click();
  await page.locator("#onboarding-name").fill(account.name);
  await page.locator("#onboarding-email").fill(account.email);
  await expect(page.locator("#finish-onboarding")).toBeDisabled();
  await page.locator("#onboarding-phone").fill("123");
  await expect(page.locator("#finish-onboarding")).toBeDisabled();
  await page.locator("#onboarding-phone").fill(account.phone);
  await page.locator("#onboarding-email").fill("");
  await expect(page.locator("#finish-onboarding")).toBeDisabled();
  await page.locator("#onboarding-email").fill("not-an-email");
  await expect(page.locator("#finish-onboarding")).toBeDisabled();
  await page.locator("#onboarding-email").fill(account.email);
  await expect(page.locator("#finish-onboarding")).toBeEnabled();
});

test("onboarding verification creates the account and opens Record", async ({ page }) => {
  const account = nextAccount("registration-success");
  await completeOnboarding(page, account, { leaveAtOtp: true });
  await expect(page.locator("#otp-screen-title")).toContainText("Finish registration");
  const code = await requestCode(page);
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  await expect(page.locator("#screen-capture.active")).toBeVisible(SERVER_TIMEOUT);
  expect(profileRowForEmail(account.email)).not.toBeNull();
  await expect(page.locator("#registration-verify-banner")).toBeHidden();
});

test("a verified user changing their business profile finishes on Record without OTP", async ({ page }) => {
  await signInThroughUi(page, nextAccount("registration-change-profile"));
  await page.locator("#nav-record-v2").click();
  await page.locator("#change-profile").click();
  await page.locator("#confirm-change-profile").click();
  await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#operating-region-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#sector-grid").getByRole("button", { name: /Trade & Retail/ }).click();
  await page.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();
  await page.locator("#onboarding-next").click();
  await page.locator("#finish-onboarding").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect(page.locator("#screen-otp.active")).toHaveCount(0);
});

test("a wrong registration code keeps the person on verification", async ({ page }) => {
  await completeOnboarding(page, nextAccount("registration-wrong-code"), { leaveAtOtp: true });
  const code = await requestCode(page);
  await page.locator("#otp-code-input").fill(code === "000000" ? "111111" : "000000");
  await page.locator("#otp-verify-code").click();
  await expect(page.locator("#otp-error-text")).toContainText(/OTP verification failed|Incorrect code/, SERVER_TIMEOUT);
  await expect(page.locator("#screen-otp.active")).toBeVisible();
});

test("an unreachable API explains that registration needs one connection", async ({ page }) => {
  await completeOnboarding(page, nextAccount("registration-offline"), { leaveAtOtp: true });
  await page.route(`${APP_API_URL}/auth/otp/request`, (route) => route.abort("connectionrefused"));
  await page.locator("#otp-request-code").click();
  await expect(page.locator("#otp-error-text")).toContainText("A connection is needed once to finish registration");
  await expect(page.locator("#screen-otp.active")).toBeVisible();
});

test("an existing email restores its account instead of creating another", async ({ page, browser }, testInfo) => {
  const account = await signInThroughUi(page, nextAccount("registration-existing"));
  const originalUserCount = userCountForEmail(account.email);
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const fresh = await context.newPage();
  try {
    await completeOnboarding(fresh, { ...account, name: "new local name" }, { leaveAtOtp: true });
    await expect(fresh.locator("#otp-screen-copy")).toContainText("restores that account");
    const code = await requestCode(fresh);
    const response = await verifyWithCode(fresh, code);
    expect(response.status()).toBe(200);
    await expect(fresh.locator("#screen-capture.active")).toBeVisible(SERVER_TIMEOUT);
    expect(userCountForEmail(account.email)).toBe(originalUserCount);
  } finally {
    await context.close();
  }
});

test("a phone linked to another account returns to onboarding for correction", async ({ page, browser }, testInfo) => {
  const existing = await signInThroughUi(page, nextAccount("registration-phone-conflict"));
  const conflicting = { ...nextAccount("registration-phone-conflict-new"), phone: existing.phone };
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const fresh = await context.newPage();
  try {
    await completeOnboarding(fresh, conflicting, { leaveAtOtp: true });
    const code = await requestCode(fresh);
    const response = await verifyWithCode(fresh, code);
    expect(response.status()).toBe(409);
    await expect(fresh.locator("#otp-error-text")).toHaveText(
      "This phone number is already linked to another account. Use that account's email to restore it, or change the phone number."
    );
    await expect(fresh.locator("#otp-back")).toHaveText("Back to edit");
    await fresh.locator("#otp-back").click();
    await expect(fresh.locator("#screen-onboarding.active")).toBeVisible();
    await expect(fresh.locator("#onboarding-phone")).toHaveValue(conflicting.phone);
  } finally {
    await context.close();
  }
});

test("an existing local-only profile shows a verification banner without blocking recording", async ({ page }) => {
  const account = nextAccount("registration-banner");
  await seedUnverifiedProfile(page, account);
  await expect(page.locator("#registration-verify-banner")).toBeVisible();
  await page.locator("#quick-text-input-v2").fill("Sold rice for 2500");
  await expect(page.locator("#quick-text-submit")).toBeEnabled();
  await page.locator("#registration-verify-now").click();
  await expect(page.locator("#screen-otp.active")).toBeVisible();
  await page.locator("#otp-back").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
});

test("Settings still opens email verification", async ({ page }) => {
  await seedUnverifiedProfile(page, nextAccount("registration-settings"));
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-open-trust-v3").click();
  await expect(page.locator("#screen-otp.active")).toBeVisible();
});

test("a rate-limited request from Settings keeps its error visible", async ({ page }) => {
  await seedUnverifiedProfile(page, nextAccount("registration-settings-rate-limit"));
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-open-trust-v3").click();
  await page.route(`${APP_API_URL}/auth/otp/request`, (route) => route.fulfill({
    status: 429,
    contentType: "application/json",
    body: JSON.stringify({ error: "OTP request limit reached for this email address." })
  }));
  await page.locator("#otp-request-code").click();
  await expect(page.locator("#otp-error-text")).toHaveText("OTP request limit reached for this email address.");
  await expect(page.locator("#screen-otp.active")).toBeVisible();
});
