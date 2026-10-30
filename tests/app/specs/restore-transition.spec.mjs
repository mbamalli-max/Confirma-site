import { expect, test } from "@playwright/test";
import {
  APP_API_URL,
  nextAccount,
  paceOtp,
  restoreThroughUi,
  signInThroughUi,
  writeLocalState
} from "./helpers.mjs";

const SERVER_TIMEOUT = { timeout: 20_000 };

async function openFreshRestorePage(browser, testInfo, { sampleTransition = false } = {}) {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    serviceWorkers: "block"
  });
  const page = await context.newPage();

  await page.route(`${APP_API_URL}/**`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fallback();
  });

  if (sampleTransition) {
    await page.addInitScript(() => {
      const state = {
        verifyClicked: false,
        samples: []
      };
      window.__restoreTransitionSampler = state;
      const sample = (source) => {
        if (!state.verifyClicked) return;
        const onboardingActive = document.querySelector("#screen-onboarding")?.classList.contains("active") === true;
        const restoreHidden = document.querySelector("#restore-modal")?.hasAttribute("hidden") === true;
        state.samples.push({ source, uncovered: onboardingActive && restoreHidden });
      };
      document.addEventListener("click", (event) => {
        if (!event.target.closest?.("#restore-verify-code")) return;
        state.verifyClicked = true;
        sample("verify-click");
      }, true);
      new MutationObserver(() => sample("mutation")).observe(document, {
        attributes: true,
        childList: true,
        subtree: true
      });
      const sampleAnimationFrame = () => {
        sample("animation-frame");
        requestAnimationFrame(sampleAnimationFrame);
      };
      requestAnimationFrame(sampleAnimationFrame);
    });
  }

  await page.goto("/");
  await writeLocalState(page, { sync_api_base_url: APP_API_URL });
  await page.reload();
  return { context, page };
}

async function fillRestoreCode(page, account) {
  await page.locator("#restore-account-link").click();
  await page.locator("#restore-email-input").fill(account.email);
  await paceOtp("request", 4);
  await page.locator("#restore-send-code").click();
  await expect(page.locator("#restore-helper-text")).toContainText("Development code:", { timeout: 70_000 });
  const code = (await page.locator("#restore-helper-text").textContent())?.match(/Development code:\s*(\d{6})/)?.[1];
  if (!code) throw new Error("local API did not expose its development restore code");
  await page.locator("#restore-code-input").fill(code);
  await paceOtp("verify", 8);
  return code;
}

test("RT1: restore never uncovers onboarding before capture is active", async ({ page, browser }, testInfo) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("restore-transition"));
  const { context, page: fresh } = await openFreshRestorePage(browser, testInfo, { sampleTransition: true });

  try {
    await restoreThroughUi(fresh, account);
    await expect(fresh.locator("#screen-capture.active")).toBeVisible(SERVER_TIMEOUT);
    await fresh.waitForTimeout(1_000);

    const sampler = await fresh.evaluate(() => window.__restoreTransitionSampler);
    expect(sampler.verifyClicked).toBe(true);
    expect(sampler.samples.filter((sample) => sample.uncovered)).toEqual([]);
    await expect(fresh.locator("#restore-modal")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("RT2: verify button shows a busy state while restore runs", async ({ page, browser }, testInfo) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("restore-busy"));
  const { context, page: fresh } = await openFreshRestorePage(browser, testInfo);

  try {
    await fillRestoreCode(fresh, account);
    const verifyButton = fresh.locator("#restore-verify-code");
    await verifyButton.click();
    await expect(verifyButton).toBeDisabled();
    await expect(verifyButton).toHaveText("Restoring your account…");
    await expect(fresh.locator("#screen-capture.active")).toBeVisible(SERVER_TIMEOUT);
    await expect(fresh.locator("#restore-modal")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("RT3: a failed restore resets the verify button and keeps the dialog open", async ({ page, browser }, testInfo) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("restore-error"));
  const { context, page: fresh } = await openFreshRestorePage(browser, testInfo);

  try {
    const code = await fillRestoreCode(fresh, account);
    const wrongCode = code === "000000" ? "111111" : "000000";
    await fresh.locator("#restore-code-input").fill(wrongCode);
    const verifyButton = fresh.locator("#restore-verify-code");
    await verifyButton.click();

    await expect(fresh.locator("#restore-error-text")).toBeVisible(SERVER_TIMEOUT);
    await expect(verifyButton).toBeEnabled();
    await expect(verifyButton).toHaveText("Verify and restore");
    await expect(fresh.locator("#restore-modal")).toBeVisible();
    await expect(fresh.locator("#screen-capture")).not.toHaveClass(/\bactive\b/);
  } finally {
    await context.close();
  }
});
