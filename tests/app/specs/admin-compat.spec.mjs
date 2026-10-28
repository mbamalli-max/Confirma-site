import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { API_BASE, mintSession, seedOwner } from "./admin-helpers.mjs";

// Deploy-order compatibility: the admin page that is live today (commit ea16b36, before the
// exclusion model) talking to the new server, whose old read routes answer 410 client_outdated.
// This is an open tab, or Railway deploying before Vercel. It must show no figures, never
// new-model numbers under old labels. The old files are read from git, not from this branch.
const LIVE_COMMIT = "ea16b36";
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const oldFile = (name) => execFileSync("git", ["show", `${LIVE_COMMIT}:admin/${name}`], { cwd: REPO, encoding: "utf8" });

const APP_URL = process.env.APP_TEST_URL || "http://127.0.0.1:5500";
const CORS = { "access-control-allow-origin": APP_URL, "content-type": "application/json" };
const PREFLIGHT = { ...CORS, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST" };

// The old page document is served by the test (route.fulfill), which Chrome treats as a
// non-local page and so blocks its calls to the local test API ("local network access").
// A real browser loading the real page is not affected; this check is off for this file only.
test.use({ launchOptions: { args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults"] } });

let owner;
test.beforeAll(async () => {
  owner = await seedOwner("compat-owner@example.test");
});

test("X1. the pre-exclusion page against the new server shows no figures", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: APP_URL });
  const page = await ctx.newPage();
  const statuses = [];
  page.on("response", (r) => { if (r.url().startsWith(API_BASE) && r.request().method() !== "OPTIONS") statuses.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  try {
    await page.route("**/admin/config.js", (route) => route.fulfill({
      contentType: "text/javascript", body: `export const API_BASE = "${API_BASE}";\nexport const LOGOUT_TIMEOUT_MS = 1500;`
    }));
    await page.route(`${API_BASE}/admin/auth/login`, async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: PREFLIGHT });
      return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(await mintSession(owner)) });
    });
    for (const [name, type] of [["index.html", "text/html"], ["admin.js", "text/javascript"], ["admin.css", "text/css"]]) {
      const body = oldFile(name);
      await page.route(`**/admin/${name}`, async (route) => {
        const response = await route.fetch();
        return route.fulfill({ response, body, contentType: type });
      });
    }
    await page.goto("/admin/index.html");
    await page.fill("#signin-email", owner.email);
    await page.fill("#signin-password", "x");
    await page.fill("#signin-totp", "123456");
    await page.click("#signin-submit");
    await expect(page.locator("#metrics-unavailable")).toBeVisible();
    await expect(page.locator("article.metric-tile")).toHaveCount(0);
    await expect(page.locator("#provisional-banner")).toHaveText("PROVISIONAL — the unclassified account count could not be loaded");
    expect(statuses).toContain("410 /admin/metrics/overview");
    expect(statuses).toContain("410 /admin/classification/summary");
    expect(statuses.filter((s) => s.startsWith("200 /admin/metrics") || s.startsWith("200 /admin/classification/summary"))).toEqual([]);
  } finally {
    await ctx.close();
  }
});
