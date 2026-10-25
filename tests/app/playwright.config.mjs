import { defineConfig } from "@playwright/test";

const appUrl = process.env.APP_TEST_URL || "http://127.0.0.1:5500";
const apiUrl = (process.env.APP_TEST_API_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");

export default defineConfig({
  testDir: "./specs",
  timeout: 180_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  globalSetup: "./scripts/global-setup.mjs",
  globalTeardown: "./scripts/global-teardown.mjs",
  use: {
    baseURL: appUrl,
    browserName: "chromium",
    headless: true
  },
  webServer: [
    {
      command: "node ./scripts/serve-app.mjs",
      url: appUrl,
      reuseExistingServer: true,
      timeout: 15_000
    },
    {
      command: "node ./scripts/serve-api.mjs",
      // The API root deliberately has no response.  Readiness is always the
      // local server's health endpoint, including when APP_TEST_API_URL is set.
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 20_000
    }
  ]
});
