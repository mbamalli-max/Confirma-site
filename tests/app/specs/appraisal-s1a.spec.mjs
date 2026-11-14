import { expect, test } from "@playwright/test";
import { completeOnboarding, ensureCaptureScreen, nextAccount, readLocalState, signInThroughUi } from "./helpers.mjs";

async function createConfirmedRecord(page) {
  await signInThroughUi(page, nextAccount("s1a"));
  await ensureCaptureScreen(page, { timeout: 10_000 });
  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill("2500");
  await page.locator("#prepare-confirmation").click();

  await expect(page.locator("#screen-confirm.active")).toBeVisible();
  await expect(page.locator("#screen-confirm")).not.toContainText("No path bypasses confirmation.");
  await expect(page.locator("#confirm-meta-v2")).not.toContainText("Normalized label:");
  await expect(page.locator("#confirm-append")).toHaveText("Confirm record");
  await page.locator("#confirm-append").click();
  await expect(page.locator("#screen-dashboard.active")).toBeVisible();

  const records = (await readLocalState(page)).stores.records;
  const record = records.find((candidate) => candidate.confirmation_state === "confirmed");
  expect(record).toBeTruthy();
  return record;
}

test("S1a hides diagnostic rows behind closed technical-details disclosures", async ({ page }) => {
  await createConfirmedRecord(page);

  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-trust-toggle").click();
  const settingsDetails = page.locator("#settings-technical-details");
  await expect(settingsDetails).not.toHaveAttribute("open", "");
  await expect(settingsDetails).toContainText("Verification summary");
  await expect(settingsDetails).toContainText("Phone anchor");
  await expect(settingsDetails).toContainText("Device key");
  await expect(settingsDetails).toContainText("Auth session");

  await page.locator("#settings-open-export-v2").click();
  const exportDetails = page.locator("#export-technical-details");
  await expect(exportDetails).not.toHaveAttribute("open", "");
  await expect(exportDetails).toContainText("Verification channels");
  await expect(exportDetails).toContainText("Queued sync entries");
  await expect(exportDetails).toContainText("Recovery contact");

});

test("S1a hides email-verification diagnostic rows behind a closed technical-details disclosure", async ({ page }) => {
  await completeOnboarding(page, nextAccount("s1a-otp"), { leaveAtOtp: true });

  const otpDetails = page.locator("#otp-technical-details");
  await expect(otpDetails).not.toHaveAttribute("open", "");
  await expect(otpDetails).toContainText("Email verification");
  await expect(otpDetails).toContainText("Phone on profile");
  await expect(otpDetails).toContainText("Email for delivery");
  expect(await otpDetails.evaluate((details) => {
    const email = document.getElementById("otp-email-input");
    const sendCode = document.getElementById("otp-request-code");
    const code = document.getElementById("otp-code-input");
    return [email, sendCode, code].every((element) => Boolean(element) && Boolean(element.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING));
  })).toBe(true);
});

test("S1a removes engineering copy from confirmation and record lists", async ({ page }) => {
  const record = await createConfirmedRecord(page);
  await expect(page.locator("#recent-records-v2")).toContainText(record.label);
  await expect(page.locator("#recent-records-v2")).not.toContainText(record.normalized_label);
  await page.locator("#nav-history-v2").click();
  await expect(page.locator("#history-records-v2")).toContainText(record.label);
  await expect(page.locator("#history-records-v2")).not.toContainText(record.normalized_label);
});

test("S1a uses the approved user-facing copy", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("We use this to format your phone number. Your business country can be different.")).toBeVisible();
  await expect(page.getByText("What kind of transaction is it?")).toBeAttached();
  await expect(page.getByText("Tap what the money was for.")).toBeAttached();
  await expect(page.getByText("The app is free to use.", { exact: false })).toHaveCount(1);
});

test("S1a suggests Nigeria from Africa/Lagos without selecting it or overriding the tapped country", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    serviceWorkers: "block",
    timezoneId: "Africa/Lagos"
  });
  const page = await context.newPage();
  await page.goto("/");
  const nigeria = page.locator("#country-grid .visual-card").first();
  await expect(nigeria).toContainText("Nigeria");
  await expect(nigeria).toContainText("Suggested");
  await expect(nigeria).not.toHaveClass(/active/);
  await expect(page.locator("#country-grid .visual-card.active")).toHaveCount(0);
  const ghana = page.locator("#country-grid .visual-card").filter({ hasText: "Ghana" });
  await ghana.click();
  const businessNigeria = page.locator("#operating-region-grid .visual-card").first();
  const businessGhana = page.locator("#operating-region-grid .visual-card").filter({ hasText: "Ghana" });
  await expect(businessNigeria).toContainText("Nigeria");
  await expect(businessNigeria).toContainText("Suggested");
  await expect(businessNigeria).not.toHaveClass(/active/);
  await expect(businessGhana).toHaveClass(/active/);
  await expect(page.locator("#operating-region-next")).toHaveText("Continue with Ghana");
  await context.close();
});

test("S1a leaves country order unchanged for an unmapped time zone", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    serviceWorkers: "block",
    timezoneId: "Asia/Tokyo"
  });
  const page = await context.newPage();
  await page.goto("/");
  const firstCountry = page.locator("#country-grid .visual-card").first();
  await expect(firstCountry).toContainText("United States");
  await expect(firstCountry).not.toContainText("Suggested");
  await expect(firstCountry).not.toHaveClass(/active/);
  await context.close();
});
