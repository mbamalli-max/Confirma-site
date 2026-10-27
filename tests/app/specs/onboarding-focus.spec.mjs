import { expect, test } from "@playwright/test";
import { installIdbFault } from "./helpers.mjs";

test.beforeEach(async ({ page }) => {
  await installIdbFault(page);
});

test("32 step autofocus does not steal focus after a field is focused before its frame", async ({ page }) => {
  await page.goto("/");
  await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#operating-region-grid").getByRole("button", { name: /Nigeria/ }).click();
  await page.locator("#sector-grid").getByRole("button", { name: /Trade & Retail/ }).click();
  await page.locator("#business-grid").getByRole("button", { name: /Market Trader/ }).click();

  // Hold the entry rAF until email focus and input have both occurred. This
  // makes the pre-frame user interaction deterministic rather than timing it
  // against Playwright's command scheduling.
  await page.evaluate(() => {
    const original = window.requestAnimationFrame.bind(window);
    const callbacks = [];
    window.__releaseOnboardingFocusFrame = () => {
      window.requestAnimationFrame = original;
      callbacks.splice(0).forEach((callback) => original(callback));
    };
    window.requestAnimationFrame = (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    };
  });
  await page.locator("#onboarding-next").click();
  const email = page.locator("#onboarding-email");
  await email.focus();
  await email.pressSequentially("focused-first@example.test");
  await page.evaluate(() => window.__releaseOnboardingFocusFrame());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  await expect(email).toHaveValue("focused-first@example.test");
  await expect(page.locator("#onboarding-name")).toHaveValue("");
  await expect(email).toBeFocused();
});
