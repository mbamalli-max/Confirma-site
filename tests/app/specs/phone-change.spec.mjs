import { expect, test } from "@playwright/test";
import {
  APP_API_URL,
  nextAccount,
  readLocalState,
  readStoredProfile,
  restoreThroughUi,
  signInThroughUi,
  writeLocalState
} from "./helpers.mjs";

async function openPhoneChange(page) {
  await page.locator("#nav-settings-v2").click();
  await expect(page.locator("#settings-change-phone")).toBeVisible();
  await page.locator("#settings-change-phone").click();
  await expect(page.locator("#phone-change-modal")).toBeVisible();
  await expect(page.locator("#phone-change-number-input")).toBeFocused();
}

async function requestPhoneCode(page, phoneDigits) {
  await page.locator("#phone-change-number-input").fill(phoneDigits);
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/account/phone-change/request") && response.request().method() === "POST");
  await page.locator("#phone-change-send-code").click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.delivery).toBe("development");
  expect(body.dev_code).toMatch(/^\d{6}$/);
  await expect(page.locator("#phone-change-code-step")).toBeVisible();
  await expect(page.locator("#phone-change-code-input")).toBeFocused();
  return body.dev_code;
}

async function confirmPhoneChange(page, code) {
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/account/phone-change/confirm") && response.request().method() === "POST");
  await page.locator("#phone-change-code-input").fill(code);
  await page.locator("#phone-change-confirm").click();
  return responsePromise;
}

test("changes a phone number through Settings and marks the new number unverified", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("phone-change-journey"));
  const replacement = "+2348030000711";
  await openPhoneChange(page);
  const code = await requestPhoneCode(page, replacement);
  const response = await confirmPhoneChange(page, code);
  expect(response.status()).toBe(200);
  await expect(page.locator("#phone-change-success-step")).toBeVisible();
  await expect(page.locator("#phone-change-success")).toHaveText("Your phone number is now +234***0711. It isn't verified.");
  await expect(page.locator("#phone-change-done")).toBeFocused();
  const stored = await readStoredProfile(page);
  expect(stored.phone_number).toBe(replacement);
  expect(stored.phone_verified).toBe(false);
  expect((await readLocalState(page)).settings.bound_phone_number).toBe(replacement);
  expect(account.accountId).toBeTruthy();
});

test("phone change uses the Nigerian dial code for local input and rejects a zero-prefixed international input", async ({ page }) => {
  await signInThroughUi(page, nextAccount("phone-change-local-number"));
  await openPhoneChange(page);
  await expect(page.locator("#phone-change-country-prefix")).toHaveText("+234");
  const request = page.waitForRequest(`${APP_API_URL}/account/phone-change/request`);
  await page.locator("#phone-change-number-input").fill("08031234567");
  await page.locator("#phone-change-send-code").click();
  expect(JSON.parse((await request).postData() || "{}").new_phone_number).toBe("+2348031234567");

  await page.locator("#phone-change-number-input").fill("+08031234567");
  await page.locator("#phone-change-resend").click();
  await expect(page.locator("#phone-change-error")).toHaveText("Enter an international phone number with 7 to 15 digits.");
});

test("Settings requires a verified email before it offers phone change", async ({ page }) => {
  await signInThroughUi(page, nextAccount("phone-change-no-email"));
  await page.route(`${APP_API_URL}/profile`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.profile.email_verified = false;
    await route.fulfill({ response, body: JSON.stringify(body), contentType: "application/json" });
  });
  await page.reload();
  await page.locator("#nav-settings-v2").click();
  await expect(page.locator("#settings-change-phone")).toHaveCount(0);
  await expect(page.locator("#settings-profile-v2")).toContainText("A verified email is needed to change your number.");
});

test("Settings reports a phone number already in use", async ({ page, browser }, testInfo) => {
  const owner = await signInThroughUi(page, nextAccount("phone-change-owner"));
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const other = await context.newPage();
  try {
    const occupied = await signInThroughUi(other, nextAccount("phone-change-occupied"));
    await openPhoneChange(page);
    await page.locator("#phone-change-number-input").fill(occupied.phone.replace(/^0/, "234"));
    await page.locator("#phone-change-send-code").click();
    await expect(page.locator("#phone-change-error")).toHaveText("This phone number is already linked to another account.");
    expect(owner.accountId).toBeTruthy();
  } finally {
    await context.close();
  }
});

test("wrong codes show guesses left and lock the account after five guesses", async ({ page }) => {
  await signInThroughUi(page, nextAccount("phone-change-guesses"));
  await openPhoneChange(page);
  await requestPhoneCode(page, "+2348030000721");
  for (let attempt = 4; attempt >= 0; attempt -= 1) {
    await page.locator("#phone-change-code-input").fill("000000");
    await page.locator("#phone-change-confirm").click();
    await expect(page.locator("#phone-change-error")).toHaveText(`That code is incorrect or has expired. ${attempt} guess${attempt === 1 ? "" : "es"} left.`);
  }
  await page.locator("#phone-change-code-input").fill("111111");
  await page.locator("#phone-change-confirm").click();
  await expect(page.locator("#phone-change-error")).toContainText("Too many attempts. Try again after");
});

test("rate-limited phone-change requests show when to try again", async ({ page }) => {
  await signInThroughUi(page, nextAccount("phone-change-rate"));
  await openPhoneChange(page);
  await page.route(`${APP_API_URL}/account/phone-change/request`, (route) => route.fulfill({
    status: 429,
    contentType: "application/json",
    body: JSON.stringify({ error: "Too many phone-change attempts. Try again later.", retry_after: 61 })
  }));
  await page.locator("#phone-change-number-input").fill("2348030000731");
  await page.locator("#phone-change-send-code").click();
  await expect(page.locator("#phone-change-error")).toHaveText("Too many attempts. Try again after 2 minutes.");
});

test("a different phone prefix does not change the business region, currency, or records", async ({ page }) => {
  await signInThroughUi(page, nextAccount("phone-change-prefix"));
  const before = await readStoredProfile(page);
  const beforeState = await readLocalState(page);
  await openPhoneChange(page);
  const code = await requestPhoneCode(page, "+12025550741");
  expect((await confirmPhoneChange(page, code)).status()).toBe(200);
  const after = await readStoredProfile(page);
  const afterState = await readLocalState(page);
  expect(after.operating_region).toBe(before.operating_region);
  expect(after.country).toBe(before.country);
  expect(afterState.stores.records).toEqual(beforeState.stores.records);
  await page.locator("#phone-change-done").click();
  await expect(page.locator("#settings-summary-v2")).toContainText("NGN");
});

test("offline and an older server's 404 both show the temporary-unavailable guidance", async ({ page }) => {
  await signInThroughUi(page, nextAccount("phone-change-offline"));
  await openPhoneChange(page);
  await page.context().setOffline(true);
  await page.locator("#phone-change-number-input").fill("2348030000741");
  await page.locator("#phone-change-send-code").click();
  await expect(page.locator("#phone-change-error")).toHaveText("Changing your number needs a connection.");
  await page.context().setOffline(false);

  const code = await requestPhoneCode(page, "+2348030000741");
  await page.route(`${APP_API_URL}/account/phone-change/request`, (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) }));
  await page.locator("#phone-change-resend").click();
  await expect(page.locator("#phone-change-error")).toHaveText("The server is temporarily unavailable. Please try again later.");
  await page.unroute(`${APP_API_URL}/account/phone-change/request`);
  await page.route(`${APP_API_URL}/account/phone-change/confirm`, (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) }));
  await page.locator("#phone-change-code-input").fill(code);
  await page.locator("#phone-change-confirm").click();
  await expect(page.locator("#phone-change-error")).toHaveText("The server is temporarily unavailable. Please try again later.");
});

test("a second signed-in device applies the new phone on its next profile sync without signing out", async ({ page, browser }, testInfo) => {
  const account = await signInThroughUi(page, nextAccount("phone-change-second-device"));
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const second = await context.newPage();
  try {
    await second.goto("/");
    await writeLocalState(second, { sync_api_base_url: APP_API_URL });
    await second.reload();
    await restoreThroughUi(second, account);
    await expect(second.locator("#screen-capture.active")).toBeVisible();
    const secondBefore = await readLocalState(second);
    const replacement = "+2348030000751";
    await openPhoneChange(page);
    const code = await requestPhoneCode(page, replacement);
    expect((await confirmPhoneChange(page, code)).status()).toBe(200);

    await second.reload();
    await expect(second.locator("#screen-capture.active")).toBeVisible();
    await expect.poll(async () => (await readLocalState(second)).settings.bound_phone_number).toBe(replacement);
    const secondAfter = await readLocalState(second);
    expect(secondAfter.settings.auth_token).toBe(secondBefore.settings.auth_token);
    expect((await readStoredProfile(second)).phone_number).toBe(replacement);
    expect(secondAfter.settings.bound_phone_number).toBe(replacement);
  } finally {
    await context.close();
  }
});
