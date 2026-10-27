import { expect, test } from "@playwright/test";
import {
  armFault, completeOnboarding, deleteLocalSettings, installIdbFault, nextAccount, openVerification,
  putStoreValue, readLocalState, readStoredProfile, requestCode, revokeOnServer, sessionState, signInThroughUi,
  verifyWithCode, writeLocalState
} from "./helpers.mjs";

test.beforeEach(async ({ page }) => {
  await installIdbFault(page);
});

async function seedLegacyInstall(page, account, id = 901) {
  await page.goto("/");
  await putStoreValue(page, "settings", {
    key: "profile",
    display_name: account.name,
    email: account.email,
    phone_number: account.phone ? `+234${account.phone.replace(/^0/, "")}` : `+234803${String(id).padStart(7, "0").slice(-7)}`,
    phone_country: "NG",
    country: "NG",
    operating_region: "NG",
    language: "en",
    sector_id: "trade_retail",
    business_type_id: "market_trader"
  });
  await putStoreValue(page, "records", {
    id,
    label: "private legacy record",
    normalized_label: "private legacy record",
    transaction_type: "sale",
    amount_minor: 2500,
    currency: "NGN",
    confirmed_at: Math.floor(Date.now() / 1000),
    confirmation_state: "confirmed"
  });
  await putStoreValue(page, "syncQueue", { entry_payload: { id }, queued_at: Date.now() });
  await page.reload();
}

function signedOutCopy(page) {
  return page.locator("#signed-out-copy");
}

test("S7 a fresh install and allowlisted onboarding preference stay in onboarding", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
  let state = await readLocalState(page);
  expect(Object.keys(state.settings).sort()).toEqual(["sync_api_base_url"]);

  await page.locator("#country-grid").getByRole("button", { name: /Nigeria/ }).click();
  await expect.poll(async () => (await readLocalState(page)).settings.auth_phone_country).toBe("NG");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
  state = await readLocalState(page);
  expect(Object.keys(state.settings).sort()).toEqual(["auth_phone_country", "sync_api_base_url"]);
  expect(state.settings.local_origin).toBeUndefined();
});

test("S8 the first profile and origin marker commit together and reopen local records", async ({ page }) => {
  const account = nextAccount("s8");
  await completeOnboarding(page, account);
  await putStoreValue(page, "records", {
    id: 801,
    label: "S8 retained sale",
    normalized_label: "s8 retained sale",
    transaction_type: "sale",
    amount_minor: 1000,
    currency: "NGN",
    confirmed_at: Math.floor(Date.now() / 1000),
    confirmation_state: "confirmed"
  });
  let state = await readLocalState(page);
  expect(state.settings.local_origin).toBe("this_version");
  expect(state.settings.bound_account).toBeUndefined();
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect(page.locator("#recent-records-v2")).toContainText("S8 retained sale");
  state = await readLocalState(page);
  expect(state.settings.local_origin).toBe("this_version");
  expect(state.settings.signed_out).not.toBe(true);

  await openVerification(page, account);
  const code = await requestCode(page);
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  const body = await response.json();
  await expect(page.locator("#screen-settings.active")).toBeVisible();
  state = await readLocalState(page);
  expect(state.settings.bound_account).toBe(body.account_id);
  expect(state.settings.local_origin).toBeUndefined();
  expect(state.stores.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 801 })]));
  expect(sessionState(body.auth_token)?.active).toBe(true);
});

test("S8 an aborted binding transaction preserves the marker and leaves nothing bound", async ({ page }) => {
  const account = nextAccount("s8-abort");
  await completeOnboarding(page, account);
  await openVerification(page, account);
  const code = await requestCode(page);
  await armFault(page, "binding");
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  const state = await readLocalState(page);
  expect(state.settings.local_origin).toBe("this_version");
  expect(state.settings.bound_account).toBeUndefined();
  expect(state.settings.auth_token).toBeUndefined();
});

test("onboarding does not mark an install that became non-empty before its first profile write", async ({ page }) => {
  await page.goto("/");
  await putStoreValue(page, "records", { id: 811, label: "pre-existing record" });
  await completeOnboarding(page, nextAccount("non-empty-onboarding"), { navigate: false });
  const state = await readLocalState(page);
  expect(state.settings.local_origin).toBeUndefined();
  expect(state.stores.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 811 })]));
});

test("marker guards never let local origin override signed_out, wipe_pending, or a binding", async ({ page }) => {
  await page.goto("/");
  await writeLocalState(page, { local_origin: "this_version", signed_out: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  expect((await readLocalState(page)).settings.local_origin).toBeUndefined();

  await writeLocalState(page, { local_origin: "this_version", signed_out: false, wipe_pending: true });
  await page.reload();
  await expect(signedOutCopy(page)).toHaveText("Finish removing local data.");
  expect((await readLocalState(page)).settings.local_origin).toBeUndefined();

  await writeLocalState(page, {
    local_origin: "this_version",
    wipe_pending: false,
    bound_account: "00000000-0000-4000-8000-000000000001"
  });
  await page.reload();
  await expect(page.locator("#signed-out-pending")).toHaveText("Sign in to the same account to open the records on this device.");
  expect((await readLocalState(page)).settings.local_origin).toBeUndefined();
});

test("S9 legacy unbound data stays hidden and offers count-only consent choices", async ({ page }) => {
  await seedLegacyInstall(page, { name: "Legacy business", email: "legacy@example.test" });

  await expect(signedOutCopy(page)).toHaveText("Verify your email to open the records on this device.");
  await expect(page.getByText("private legacy record")).toHaveCount(0);
  expect((await readLocalState(page)).settings.signed_out).not.toBe(true);
  await page.locator("#signed-out-sign-in").click();
  await expect(page.getByText("This device has 1 record made before sign-in.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(signedOutCopy(page)).toHaveText("Verify your email to open the records on this device.");
  expect((await readLocalState(page)).settings.legacy_claim_consent).toBeUndefined();
});

test("S9 Remove deletes the legacy install and returns to onboarding", async ({ page }) => {
  await seedLegacyInstall(page, { name: "Remove legacy", email: "remove-legacy@example.test" }, 905);
  await page.locator("#signed-out-remove-data").click();
  await expect(page.locator("#remove-local-data-copy")).toHaveText(
    "1 record on this device is not confirmed as backed up. Removing will delete it permanently."
  );
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
  const state = await readLocalState(page);
  expect(state.stores.records).toEqual([]);
  expect(state.stores.syncQueue).toEqual([]);
  expect(Object.keys(state.settings).sort()).toEqual(["sync_api_base_url", "wipe_epoch"]);
});

test("S9 consent binds atomically and a successful real verify reopens the same record", async ({ page }) => {
  const account = nextAccount("s9-keep");
  await seedLegacyInstall(page, account, 902);
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#signed-out-sign-in").click();
  await expect(page.locator("#screen-otp.active")).toBeVisible();
  await page.locator("#otp-email-input").fill(account.email);
  const code = await requestCode(page);
  expect((await readLocalState(page)).settings.legacy_claim_consent).toEqual({
    channel: "email",
    identifier: account.email
  });
  let releaseVerify;
  const verifyGate = new Promise((resolve) => { releaseVerify = resolve; });
  let verifyFetched = false;
  const prematureAccountRequests = [];
  page.on("request", (request) => {
    if (/\/(?:sync|profile|records|restore)/.test(new URL(request.url()).pathname)) {
      prematureAccountRequests.push(request.url());
    }
  });
  await page.route("**/auth/otp/verify", async (route) => {
    const serverResponse = await route.fetch();
    verifyFetched = true;
    await verifyGate;
    await route.fulfill({ response: serverResponse });
  });
  const responsePromise = verifyWithCode(page, code);
  await expect.poll(() => verifyFetched).toBe(true);
  expect(prematureAccountRequests).toEqual([]);
  expect((await readLocalState(page)).settings.bound_account).toBeUndefined();
  releaseVerify();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const body = await response.json();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect(page.locator("#recent-records-v2")).toContainText("private legacy record");
  const state = await readLocalState(page);
  expect(state.settings.bound_account).toBe(body.account_id);
  expect(state.settings.auth_token).toBe(body.auth_token);
  expect(state.settings.legacy_claim_consent).toBeUndefined();
  expect(state.settings.local_origin).toBeUndefined();
  expect(state.stores.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 902 })]));
  expect(sessionState(body.auth_token)?.active).toBe(true);
});

test("S9 a 503 verify failure preserves the record, lock, and consent", async ({ page }) => {
  const account = nextAccount("s9-503");
  await seedLegacyInstall(page, account, 906);
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#otp-email-input").fill(account.email);
  const code = await requestCode(page);
  await page.route("**/auth/otp/verify", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: '{"error":"auth_unavailable"}'
  }));
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(503);
  await expect(page.locator("#otp-error-text")).toBeVisible();
  const state = await readLocalState(page);
  expect(state.settings.legacy_claim_consent).toEqual({ channel: "email", identifier: account.email });
  expect(state.settings.bound_account).toBeUndefined();
  expect(state.settings.auth_token).toBeUndefined();
  expect(state.stores.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 906 })]));
  await expect(page.getByText("private legacy record")).toHaveCount(0);
});

test("S9 aborting the binding transaction leaves consent stored and the install unbound", async ({ page }) => {
  const account = nextAccount("s9-abort");
  await seedLegacyInstall(page, account, 908);
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#otp-email-input").fill(account.email);
  const code = await requestCode(page);
  await armFault(page, "binding");
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  await page.reload();
  await expect(signedOutCopy(page)).toHaveText("Verify your email to open the records on this device.");
  const state = await readLocalState(page);
  expect(state.settings.bound_account).toBeUndefined();
  expect(state.settings.auth_token).toBeUndefined();
  expect(state.settings.legacy_claim_consent).toEqual({ channel: "email", identifier: account.email });
  expect(state.stores.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 908 })]));
});

test("S9 changing the consent identifier reopens the choice before another code request", async ({ page }) => {
  const account = nextAccount("s9-consent-x");
  const other = nextAccount("s9-consent-y");
  await seedLegacyInstall(page, account, 907);
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#otp-email-input").fill(account.email);
  await requestCode(page);
  await page.locator("#otp-email-input").fill(other.email);
  await page.locator("#otp-request-code").evaluate((button) => { button.disabled = false; });
  let requested = false;
  page.on("request", (request) => {
    if (request.url().includes("/auth/otp/request")) requested = true;
  });
  await page.locator("#otp-request-code").click();
  await expect(page.getByText("This device has 1 record made before sign-in.", { exact: false })).toBeVisible();
  expect(requested).toBe(false);
  expect((await readLocalState(page)).settings.legacy_claim_consent).toEqual({
    channel: "email",
    identifier: account.email
  });
});

test("pre-A token with legacy data is cleared without creating signed_out and falls through to S9", async ({ page }) => {
  const account = nextAccount("pre-a-legacy");
  await seedLegacyInstall(page, account, 909);
  // A JWT-shaped token without sid is unusable after Slice A.
  await writeLocalState(page, { auth_token: "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.signature" });
  await page.reload();
  await expect(signedOutCopy(page)).toHaveText("Verify your email to open the records on this device.");
  const state = await readLocalState(page);
  expect(state.settings.auth_token).toBeUndefined();
  expect(state.settings.signed_out).not.toBe(true);
  expect(state.stores.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 909 })]));
  await page.locator("#signed-out-sign-in").click();
  await expect(page.getByText("This device has 1 record made before sign-in.", { exact: false })).toBeVisible();
});

test("S9 sends no account request from background triggers or reload", async ({ page, context }) => {
  await seedLegacyInstall(page, nextAccount("s9-traffic"), 910);
  const observed = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/(?:sync|profile|records|restore)(?:\/|$)/.test(path)) observed.push(path);
    if (request.headers().authorization) observed.push(`auth:${path}`);
  });
  await context.setOffline(true);
  await context.setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.reload();
  await expect(signedOutCopy(page)).toHaveText("Verify your email to open the records on this device.");
  expect(observed).toEqual([]);
});

test("S9 a returned session without matching consent is queued and never installed", async ({ page }) => {
  const account = nextAccount("s9-no-consent");
  await seedLegacyInstall(page, account, 903);
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#otp-email-input").fill(account.email);
  const code = await requestCode(page);
  await writeLocalState(page, { legacy_claim_consent: true });
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  const body = await response.json();
  await expect(signedOutCopy(page)).toHaveText("Verify your email to open the records on this device.");
  const state = await readLocalState(page);
  expect(state.settings.bound_account).toBeUndefined();
  expect(state.settings.auth_token).toBeUndefined();
  expect(state.stores.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 903 })]));
  await expect.poll(() => sessionState(body.auth_token)?.active).toBe(false);
});

test("S9 a failed no-consent logout survives reload and retries without leaking the token", async ({ page }) => {
  const account = nextAccount("s9-logout-retry");
  await seedLegacyInstall(page, account, 904);
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#otp-email-input").fill(account.email);
  const code = await requestCode(page);
  await deleteLocalSettings(page, ["legacy_claim_consent"]);
  const accountRequests = [];
  page.on("request", (request) => {
    if (/\/(?:sync|profile|records|restore)/.test(new URL(request.url()).pathname)) accountRequests.push(request);
  });
  await page.route("**/auth/logout", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: '{"error":"auth_unavailable"}'
  }));
  const response = await verifyWithCode(page, code);
  const body = await response.json();
  await expect.poll(async () => (await readLocalState(page)).settings.pending_revocations || [])
    .toEqual(expect.arrayContaining([expect.objectContaining({ token: body.auth_token, reason: "legacy_no_consent" })]));
  expect(sessionState(body.auth_token)?.active).toBe(true);
  expect(accountRequests).toEqual([]);
  await page.reload();
  await expect(signedOutCopy(page)).toHaveText("Verify your email to open the records on this device.");
  expect((await readLocalState(page)).settings.pending_revocations).toEqual(
    expect.arrayContaining([expect.objectContaining({ token: body.auth_token, reason: "legacy_no_consent" })])
  );
  await page.unroute("**/auth/logout");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await readLocalState(page)).settings.pending_revocations || []).toEqual([]);
  expect(sessionState(body.auth_token)?.active).toBe(false);
});

test("S4 legacy keeps a live token profile-only until a second matching profile check binds", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("s4-legacy"));
  await putStoreValue(page, "records", {
    id: 401,
    label: "S4 hidden record",
    normalized_label: "s4 hidden record",
    transaction_type: "sale",
    amount_minor: 5000,
    currency: "NGN",
    confirmed_at: Math.floor(Date.now() / 1000),
    confirmation_state: "confirmed"
  });
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 401 }, queued_at: Date.now() });
  await writeLocalState(page, { bound_account: "", signed_out: false });
  await page.reload();
  await expect(page.getByText("Records made before sign-in are locked on this device.")).toBeVisible();
  await expect(page.getByText("S4 hidden record")).toHaveCount(0);
  let state = await readLocalState(page);
  expect(state.settings.bound_account).toBe("");
  expect(state.settings.auth_token).toBe(account.token);
  await page.locator("#signed-out-sign-in").click();
  await expect(page.getByText("This device has 1 record made before sign-in.", { exact: false })).toBeVisible();
  await page.locator("#signed-out-sign-in").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect(page.locator("#recent-records-v2")).toContainText("S4 hidden record");
  state = await readLocalState(page);
  expect(state.settings.bound_account).toBe(account.accountId);
  expect(state.settings.auth_token).toBe(account.token);
  expect(sessionState(account.token)?.active).toBe(true);
});

test("S4 pending blocks token use from every real background trigger", async ({ page, context }) => {
  const account = await signInThroughUi(page, nextAccount("s4-traffic"));
  await page.clock.install();
  await putStoreValue(page, "records", { id: 402, label: "S4 traffic record" });
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 402 }, queued_at: Date.now() });
  await writeLocalState(page, { bound_account: "", signed_out: false });
  const observed = [];
  page.on("request", (request) => observed.push({
    path: new URL(request.url()).pathname,
    authorization: request.headers().authorization || ""
  }));
  await page.reload();
  await expect(page.getByText("Records made before sign-in are locked on this device.")).toBeVisible();
  await context.setOffline(true);
  await context.setOffline(false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(300_000);
  await page.locator("#signed-out-sign-in").click();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.reload();
  await expect(page.getByText("Records made before sign-in are locked on this device.")).toBeVisible();

  expect(observed.filter((request) => /\/(?:sync|records)(?:\/|$)/.test(request.path))).toEqual([]);
  const withToken = observed.filter((request) => request.authorization === `Bearer ${account.token}`);
  expect(withToken.length).toBeGreaterThan(0);
  expect(withToken.every((request) => request.path === "/profile")).toBe(true);
});

test("S4 Keep rechecks the profile and refuses a session revoked after the first check", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("s4-revoked"));
  await putStoreValue(page, "records", { id: 403, label: "S4 revoke record" });
  await writeLocalState(page, { bound_account: "", signed_out: false });
  await page.reload();
  await page.locator("#signed-out-sign-in").click();
  await revokeOnServer(page, account.token);
  const refusedProfile = page.waitForResponse((response) => {
    const request = response.request();
    return new URL(response.url()).pathname === "/profile" && request.method() === "GET";
  });
  await page.locator("#signed-out-sign-in").click();
  const response = await refusedProfile;
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ error: "session_invalid" });
  await expect.poll(async () => [undefined, ""].includes((await readLocalState(page)).settings.auth_token)).toBe(true);
  const state = await readLocalState(page);
  expect(state.settings.bound_account).toBe("");
  expect(state.stores.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 403 })]));
});

test("S6 a bound install without a token stays locked until the same account verifies", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("s6"));
  await putStoreValue(page, "records", { id: 601, label: "S6 retained record" });
  await deleteLocalSettings(page, ["auth_token", "auth_token_expires_at"]);
  await page.reload();
  await expect(page.getByText("Sign in to the same account to open the records on this device.")).toBeVisible();
  await expect(page.getByText("S6 retained record")).toHaveCount(0);
  await page.locator("#signed-out-sign-in").click();
  await page.locator("#otp-email-input").fill(account.email);
  const code = await requestCode(page);
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  await expect(page.locator("#screen-settings.active")).toBeVisible();
  const state = await readLocalState(page);
  expect(state.settings.bound_account).toBe(account.accountId);
  expect(state.settings.auth_token).toBeTruthy();
  expect(state.stores.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 601 })]));
});

async function dropStoredDisplayName(page) {
  const profile = await readStoredProfile(page);
  expect(profile?.display_name).toBeTruthy();
  await putStoreValue(page, "settings", { ...profile, key: "profile", display_name: "" });
}

async function visibleAndFieldText(page) {
  return page.evaluate(() => [
    document.body.innerText,
    ...[...document.querySelectorAll("input, textarea, select")].map((element) => element.value || "")
  ].join("\n"));
}

test("S5 without a display name: a revoked session locks before any account field is rendered", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("s5-noname-revoked"));
  await dropStoredDisplayName(page);
  await revokeOnServer(page, account.token);
  expect(sessionState(account.token)?.active).toBe(false);
  // Without the startup session check no /profile request is made at all.
  const profileCheck = page.waitForResponse((response) => response.url().endsWith("/profile") && response.request().method() === "GET", { timeout: 15_000 });
  await page.reload();
  expect((await profileCheck).status()).toBe(401);
  await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  await expect(page.locator("#screen-onboarding.active")).toHaveCount(0);
  const text = await visibleAndFieldText(page);
  expect(text.includes(account.email), "account email must not be rendered").toBe(false);
  expect(text.includes(account.phone), "account phone must not be rendered").toBe(false);
  const local = await readLocalState(page);
  expect(local.settings.auth_token || "").toBe("");
  expect(local.settings.signed_out).toBe(true);
});

test("S5 without a display name: a valid session checks the server, then opens the profile step", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("s5-noname-valid"));
  await dropStoredDisplayName(page);
  // Without the startup session check no /profile request is made at all.
  const profileCheck = page.waitForResponse((response) => response.url().endsWith("/profile") && response.request().method() === "GET", { timeout: 15_000 });
  await page.reload();
  expect((await profileCheck).status()).toBe(200);
  await expect(page.locator("#screen-onboarding.active")).toBeVisible();
  await expect(page.locator("#onboarding-step-copy")).toHaveText("Step 6 of 6");
  const local = await readLocalState(page);
  expect(local.settings.auth_token).toBe(account.token);
  expect(local.settings.signed_out).not.toBe(true);
  expect(sessionState(account.token)?.active).toBe(true);
});
