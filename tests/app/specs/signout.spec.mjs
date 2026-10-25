import { expect, test } from "@playwright/test";
import {
  APP_API_URL, armFault, armRecordWriteHold, armRestoreWriteRace, clearStore, completeOnboarding, installIdbFault, nextAccount, openSignedOutVerification, openVerification,
  preSliceAToken, putStoreValue, readLocalState, removeLocalData, requestCode,
  releaseRecordWrite, revokeOnServer, sessionState, signInThroughUi, tokenSessionId, verifyWithCode,
  userSessionCount, writeLocalState
} from "./helpers.mjs";

test.beforeEach(async ({ page }) => {
  // New Playwright contexts start empty. Keep the DB during a test so reload
  // and a second page exercise durable IndexedDB state.
  await installIdbFault(page);
});

async function signOut(page) {
  await page.locator("#settings-logout-v2").click();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
}

async function reverify(page, account, { waitForReturn = true } = {}) {
  await openSignedOutVerification(page, account);
  const code = await requestCode(page);
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  const body = await response.json();
  if (waitForReturn) await expect(page.locator("#screen-settings.active")).toBeVisible();
  return body;
}

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve };
}

function expectAccountStoresUnchanged(after, before) {
  for (const storeName of ["records", "syncQueue", "customLabels", "usage", "voiceCorrections", "anomaly_log"]) {
    expect(after.stores[storeName]).toEqual(before.stores[storeName]);
  }
}

function expectAllWipeStoresUnchanged(after, before) {
  for (const storeName of ["records", "syncQueue", "customLabels", "usage", "voiceCorrections", "anomaly_log", "settings"]) {
    expect(after.stores[storeName]).toEqual(before.stores[storeName]);
  }
}

function localConfirmedRecord(id, overrides = {}) {
  return {
    id,
    label: `local record ${id}`,
    normalized_label: `local_record_${id}`,
    transaction_type: "sale",
    amount_minor: 100,
    currency: "NGN",
    confirmed_at: Math.floor(Date.now() / 1000),
    confirmation_state: "confirmed",
    evidence_level: "device_signed",
    ...overrides
  };
}

async function openSettingsRemoval(page) {
  if (await page.locator("#screen-signed-out.active").isVisible()) {
    await page.locator("#signed-out-remove-data").click();
    await expect(page.locator("#remove-local-data-panel")).toBeVisible();
    return;
  }
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-remove-local-data").click();
  await expect(page.locator("#remove-local-data-panel")).toBeVisible();
}

async function signInWithNearExpiry(page, account, lifetimeMs = 5_000) {
  let altered = false;
  await page.route("**/auth/otp/verify", async (route) => {
    if (altered) return route.continue();
    altered = true;
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      status: response.status(),
      contentType: "application/json",
      body: JSON.stringify({ ...body, expires_at: new Date(Date.now() + lifetimeMs).toISOString() })
    });
  });
  const signedIn = await signInThroughUi(page, account);
  await page.unroute("**/auth/otp/verify");
  return signedIn;
}

async function waitForLocalSessionExpiry(page) {
  const expiresAt = (await readLocalState(page)).settings.auth_token_expires_at;
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining > 0) await page.waitForTimeout(remaining + 100);
}

test("G0 / 1 sign-out keeps records out of the DOM and sign-in locked until verification", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("one"));
  const privateLabel = "G0 private record 104729";
  await putStoreValue(page, "records", {
    id: 104729,
    label: privateLabel,
    normalized_label: privateLabel.toLowerCase(),
    transaction_type: "sale",
    amount_minor: 100,
    currency: "NGN",
    confirmed_at: Math.floor(Date.now() / 1000),
    confirmation_state: "confirmed"
  });
  await page.reload();
  await expect(page.locator("#recent-records-v2")).toContainText(privateLabel);
  await page.locator("#nav-settings-v2").click();
  await expect(page.locator("#settings-summary-v2")).toContainText(privateLabel);
  await signOut(page);
  await expect(page.locator("#signed-out-copy")).toContainText(
    "1 record on this device is not confirmed as backed up. Removing will delete it permanently."
  );
  await expect(page.locator("#signed-out-copy")).toContainText("Sign in with the email you used before to continue.");
  expect(await page.content()).not.toContain(privateLabel);
  await expect.poll(() => sessionState(account.token)?.active).toBe(false);

  await openSignedOutVerification(page, account);
  await expect(page.locator("body")).toHaveClass(/account-locked/);
  expect((await readLocalState(page)).settings.signed_out).toBe(true);
  await page.locator("#otp-back").click();
  await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/account-locked/);
  expect(await page.content()).not.toContain(privateLabel);
  for (const nav of await page.locator("[data-target-screen]").all()) {
    await nav.dispatchEvent("click");
    await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  }
  let local = await readLocalState(page);
  expect([undefined, ""]).toContain(local.settings.auth_token);
  expect(local.settings.signed_out).toBe(true);
  await page.reload();
  await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  expect((await readLocalState(page)).settings.signed_out).toBe(true);

  await openSignedOutVerification(page, account);
  await page.reload();
  await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  await expect(page.locator("#signed-out-remove-data")).toBeVisible();
  local = await readLocalState(page);
  expect(local.settings.signed_out).toBe(true);
  expect(await page.content()).not.toContain(privateLabel);
});

test("2 sign-out pauses queued sync until a same-account UI sign-in", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("two"));
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 91 }, queued_at: Date.now() });
  await signOut(page);
  expect((await readLocalState(page)).stores.syncQueue).toHaveLength(1);
  const replacement = await reverify(page, account);
  const local = await readLocalState(page);
  expect(local.settings.auth_token).toBe(replacement.auth_token);
  expect(local.settings.bound_account).toBe(account.accountId);
  expect(local.settings.signed_out).toBe(false);
  expect(sessionState(replacement.auth_token)?.active).toBe(true);
});

test("3 real B verification is refused on A, then an explicitly injected B session is discarded and revoked", async ({ page, browser }) => {
  const accountA = await signInThroughUi(page, nextAccount("three-a"));
  await putStoreValue(page, "records", { id: 303, label: "A retained record" });
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"logout_unavailable"}' }));
  await signOut(page);
  const accountBInput = nextAccount("three-b");

  await openSignedOutVerification(page, accountBInput);
  await page.unroute("**/auth/logout");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await readLocalState(page)).settings.pending_revocations || []).toEqual([]);
  await expect(page.locator("#screen-otp.active")).toBeVisible();
  const refusedCode = await requestCode(page);
  const refusedRequestCompletedAt = Date.now();
  const refusedResponse = await verifyWithCode(page, refusedCode);
  expect(refusedResponse.status()).toBe(409);
  expect(userSessionCount(accountBInput.email)).toBe(0);
  let after = await readLocalState(page);
  expect(after.settings.bound_account).toBe(accountA.accountId);
  expect(after.stores.records).toEqual(expect.arrayContaining([expect.objectContaining({ id: 303 })]));
  expect(after.settings.pending_revocations || []).toEqual([]);
  await expect(page.locator("body")).toHaveClass(/account-locked/);
  await page.locator("#otp-back").click();

  const bContext = await browser.newContext({ baseURL: process.env.APP_TEST_URL || "http://127.0.0.1:5500" });
  const bPage = await bContext.newPage();
  const accountB = await signInThroughUi(bPage, accountBInput);
  await bContext.close();
  const before = await readLocalState(page);
  // The refused request left a challenge on A's OTP screen. Wait out that
  // screen's real 60-second client cooldown, then enter it again so the app
  // renders the now-enabled Resend control.
  const clientCooldownRemaining = Math.max(0, 60_100 - (Date.now() - refusedRequestCompletedAt));
  if (clientCooldownRemaining) await page.waitForTimeout(clientCooldownRemaining);
  await openSignedOutVerification(page, accountB);
  await expect(page.locator("#otp-request-code")).toBeEnabled();
  const code = await requestCode(page);
  await page.route("**/auth/otp/verify", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accountB.responseBody) }));
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"auth_unavailable"}' }));
  await verifyWithCode(page, code);
  await expect(page.locator("#signed-out-pending")).toContainText("This device holds data for another account");
  after = await readLocalState(page);
  expect([undefined, ""]).toContain(after.settings.auth_token);
  expect(after.settings.bound_account).toBe(accountA.accountId);
  expect(after.stores.records).toEqual(before.stores.records);
  expect(after.stores.syncQueue).toEqual(before.stores.syncQueue);
  expect(after.settings.pending_revocations).toEqual(expect.arrayContaining([expect.objectContaining({ token: accountB.token, reason: "account_mismatch" })]));
  await page.unroute("**/auth/logout");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => sessionState(accountB.token)?.active).toBe(false);
  expect(sessionState(accountA.token)?.active).toBe(false);
});

test("4 offline sign-out retains its queue entry and revokes on reconnect", async ({ page, context }) => {
  const account = await signInThroughUi(page, nextAccount("four"));
  await context.setOffline(true);
  await signOut(page);
  expect((await readLocalState(page)).settings.pending_revocations).toEqual([expect.objectContaining({ token: account.token, reason: "sign_out" })]);
  expect(sessionState(account.token)?.active).toBe(true);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await readLocalState(page)).settings.pending_revocations || []).toEqual([]);
  expect(sessionState(account.token)?.active).toBe(false);
});

test("5 revocation queue only clears for 204 or real session_invalid", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("five"));
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"auth_unavailable"}' }));
  await signOut(page);
  expect((await readLocalState(page)).settings.pending_revocations).toHaveLength(1);
  await page.unroute("**/auth/logout");
  await revokeOnServer(page, account.token);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(async () => (await readLocalState(page)).settings.pending_revocations || []).toEqual([]);
  await reverify(page, account);
  await page.route("**/auth/logout", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers.authorization;
    await route.continue({ headers });
  });
  await signOut(page);
  expect((await readLocalState(page)).settings.pending_revocations).toHaveLength(1);

  // The real server uses 400 for a missing bearer on /auth/logout. Exercise a
  // 401 token_missing too so the queue rule cannot regress to "clear any 401".
  await reverify(page, account);
  await page.unroute("**/auth/logout");
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"token_missing"}' }));
  await signOut(page);
  expect((await readLocalState(page)).settings.pending_revocations).toHaveLength(2);
});

test("6 real refused sync clears session_invalid and queues device_mismatch", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("six"));
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 92 }, queued_at: Date.now() });
  await revokeOnServer(page, account.token);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  expect([undefined, ""]).toContain((await readLocalState(page)).settings.auth_token);
  const replacement = await reverify(page, account);
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 93 }, queued_at: Date.now() });
  await page.route("**/sync/entries", (route) => route.continue({ headers: { ...route.request().headers(), "x-device-identity": "wrong-device" } }));
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"auth_unavailable"}' }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  expect((await readLocalState(page)).settings.pending_revocations).toEqual(expect.arrayContaining([expect.objectContaining({ token: replacement.auth_token, reason: "device_mismatch" })]));
  await page.unroute("**/auth/logout");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => sessionState(replacement.auth_token)?.active).toBe(false);
});

test("7 held verify, profile, and sync responses released after sign-out write nothing", async ({ page }) => {
  // Three separate real UI sessions exercise three kinds of delayed response.
  const account = nextAccount("seven");
  await completeOnboarding(page, account);
  const held = deferred();
  let fetched = false;
  await page.route("**/auth/otp/verify", async (route) => {
    const response = await route.fetch(); // the server creates a real session first
    fetched = true;
    await held.promise;
    await route.fulfill({ response });
  });
  await openVerification(page, account);
  const code = await requestCode(page);
  void verifyWithCode(page, code);
  await expect.poll(() => fetched).toBe(true);
  await page.locator("#otp-back").click();
  await page.locator("#nav-settings-v2").click();
  await signOut(page);
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"auth_unavailable"}' }));
  held.resolve();
  await expect.poll(async () => (await readLocalState(page)).settings.pending_revocations || [])
    .toEqual(expect.arrayContaining([expect.objectContaining({ reason: "late_response" })]));
  const state = await readLocalState(page);
  expect(state.settings.pending_revocations).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "late_response" })]));
  const late = state.settings.pending_revocations.find((entry) => entry.reason === "late_response");
  await page.unroute("**/auth/logout");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => sessionState(late.token)?.active).toBe(false);
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();

  // A profile request starts only after a successful verification response is
  // installed. Hold its genuine server response, then sign out through UI.
  await page.unroute("**/auth/otp/verify");
  const profileHeld = deferred();
  let profileFetched = false;
  await page.route("**/profile", async (route) => {
    const response = await route.fetch();
    profileFetched = true;
    await profileHeld.promise;
    await route.fulfill({ response });
  });
  await reverify(page, account, { waitForReturn: false });
  await expect.poll(() => profileFetched).toBe(true);
  await page.locator("#otp-back").click();
  await signOut(page);
  profileHeld.resolve();
  await expect.poll(async () => [undefined, ""].includes((await readLocalState(page)).settings.auth_token)).toBe(true);

  // The request is real and authenticated; Playwright supplies the delayed
  // acknowledgement after the user action under test.
  await page.unroute("**/profile");
  await reverify(page, account);
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 700 }, queued_at: Date.now() });
  const syncHeld = deferred();
  let syncStarted = false;
  await page.route("**/sync/entries", async (route) => {
    syncStarted = true;
    await syncHeld.promise;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ synced_count: 1, server_receipt: "delayed-test-receipt" }) });
  });
  await page.reload();
  await expect.poll(() => syncStarted).toBe(true);
  await page.locator("#nav-settings-v2").click();
  await signOut(page);
  syncHeld.resolve();
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length).toBe(1);
});

test("P4 a sync response from another tab cannot recreate metadata after a wipe", async ({ page, context }) => {
  await signInThroughUi(page, nextAccount("p4-cross-tab-sync"));
  const record = localConfirmedRecord(705);
  await putStoreValue(page, "records", record);
  await putStoreValue(page, "syncQueue", {
    entry_id: record.id,
    entry_payload: record,
    queued_at: Date.now()
  });

  const pageB = await context.newPage();
  await installIdbFault(pageB);
  const syncReached = deferred();
  const releaseSync = deferred();
  await pageB.route("**/sync/entries", async (route) => {
    syncReached.resolve();
    await releaseSync.promise;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ synced_count: 1, server_receipt: "post-wipe-receipt" })
    });
  });
  await pageB.goto("/");
  await syncReached.promise;
  await expect(pageB.locator("#sync-label")).toContainText("Syncing");

  await openSettingsRemoval(page);
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();

  releaseSync.resolve();
  await expect(pageB.locator("#sync-label")).not.toContainText("Syncing");
  await pageB.reload();
  await expect(pageB.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
  const local = await readLocalState(pageB);
  expect(local.settings.last_sync_at).toBeUndefined();
  expect(local.settings.last_sync_receipt).toBeUndefined();
  expect(local.stores.records).toEqual([]);
  expect(local.stores.syncQueue).toEqual([]);
});

test("8 remove local data stops on failed online logout, then remove-anyway wipes all account state", async ({ page }) => {
  await signInThroughUi(page, nextAccount("eight"));
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 94 }, queued_at: Date.now() });
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"auth_unavailable"}' }));
  await signOut(page);
  await removeLocalData(page);
  await expect(page.locator("#remove-local-data-copy")).toHaveText(
    "1 record on this device is not confirmed as backed up. Removing will delete it permanently."
  );
  await expect(page.getByText(/Couldn't end 1 of this device's server sessions/)).toBeVisible();
  await expect(page.getByText(/1 server session for this device stay valid/)).toBeVisible();
  await removeLocalData(page, { anyway: true });
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
  const state = await readLocalState(page);
  expect(state.stores.syncQueue).toEqual([]);
  expect(state.settings.auth_token).toBeUndefined();
  expect(state.settings.bound_account).toBeUndefined();
  expect(Object.keys(state.settings).sort()).toEqual(["sync_api_base_url", "wipe_epoch"]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
});

test("F6 removal counts records not confirmed as backed up and deduplicates queue entries", async ({ page }) => {
  await completeOnboarding(page, nextAccount("fix6-count"));

  await putStoreValue(page, "records", localConfirmedRecord(6101));
  await openSettingsRemoval(page);
  await expect(page.locator("#remove-local-data-copy")).toHaveText(
    "1 record on this device is not confirmed as backed up. Removing will delete it permanently."
  );
  await page.locator("#remove-local-data-cancel").click();

  await putStoreValue(page, "syncQueue", { entry_id: 6101, entry_payload: { id: 6101 }, queued_at: Date.now() });
  await openSettingsRemoval(page);
  await expect(page.locator("#remove-local-data-copy")).toHaveText(
    "1 record on this device is not confirmed as backed up. Removing will delete it permanently."
  );
  await page.locator("#remove-local-data-cancel").click();

  await clearStore(page, "records");
  await clearStore(page, "syncQueue");
  await putStoreValue(page, "records", localConfirmedRecord(6102, { evidence_level: "server_attested", server_entry_id: 6102 }));
  await putStoreValue(page, "syncQueue", { entry_id: 6103, entry_payload: { id: 6103 }, queued_at: Date.now() });
  await openSettingsRemoval(page);
  await expect(page.locator("#remove-local-data-copy")).toHaveText(
    "1 record on this device is not confirmed as backed up. Removing will delete it permanently."
  );
  await page.locator("#remove-local-data-cancel").click();

  await clearStore(page, "records");
  await clearStore(page, "syncQueue");
  await putStoreValue(page, "records", localConfirmedRecord(6104, {
    evidence_level: null,
    server_entry_id: 44,
    importedFromServer: true
  }));
  await openSettingsRemoval(page);
  await expect(page.locator("#remove-local-data-copy")).toHaveText(
    "This removes records, device keys, and local account data from this device."
  );
  await page.locator("#remove-local-data-confirm").click();
  await expect(page.locator("#remove-local-data-error")).toHaveText('Type "REMOVE" to continue.');
});

test("F6 a higher count at final removal aborts atomically and requires REMOVE again", async ({ page }) => {
  await completeOnboarding(page, nextAccount("fix6-rise"));
  await putStoreValue(page, "records", localConfirmedRecord(6201));
  await openSettingsRemoval(page);
  await expect(page.locator("#remove-local-data-copy")).toContainText("1 record on this device");

  await putStoreValue(page, "records", localConfirmedRecord(6202));
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await expect(page.locator("#remove-local-data-copy")).toHaveText(
    "2 records on this device are not confirmed as backed up. Removing will delete them permanently."
  );
  await expect(page.locator("#remove-local-data-error")).toContainText("type REMOVE again");
  expect(await page.locator("#remove-local-data-confirmation").inputValue()).toBe("");
  let local = await readLocalState(page);
  expect(local.stores.records).toHaveLength(2);
  expect(local.settings.wipe_pending).toBe(true);

  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
  local = await readLocalState(page);
  expect(local.stores.records).toEqual([]);
});

test("F6 final in-transaction recount catches a record created during server logout", async ({ page }) => {
  await signInThroughUi(page, nextAccount("fix6-logout-window"));
  await putStoreValue(page, "records", localConfirmedRecord(6301));
  const logoutReached = deferred();
  const releaseLogout = deferred();
  await page.route("**/auth/logout", async (route) => {
    const response = await route.fetch();
    logoutReached.resolve();
    await releaseLogout.promise;
    await route.fulfill({ response });
  });
  await openSettingsRemoval(page);
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await logoutReached.promise;
  await putStoreValue(page, "records", localConfirmedRecord(6302));
  releaseLogout.resolve();

  await expect(page.locator("#remove-local-data-copy")).toHaveText(
    "2 records on this device are not confirmed as backed up. Removing will delete them permanently."
  );
  expect((await readLocalState(page)).stores.records).toHaveLength(2);
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
});

test("F6 a held confirmation in a second tab cannot recreate data after wipe", async ({ page, context }) => {
  await signInThroughUi(page, nextAccount("fix6-second-tab"));
  const pageB = await context.newPage();
  await installIdbFault(pageB);
  await pageB.goto("/");
  await expect(pageB.locator("#screen-capture.active")).toBeVisible();
  await pageB.locator("#quick-label-grid button").first().click();
  await pageB.locator("#amount-input-v2").fill("6401");
  await pageB.locator("#prepare-confirmation").click();
  await armRecordWriteHold(pageB);
  await pageB.locator("#confirm-append").click();
  await expect.poll(() => pageB.evaluate(() => window.__signoutTestFault?.recordWriteHeld)).toBe(true);

  await openSettingsRemoval(page);
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();

  const dialogPromise = pageB.waitForEvent("dialog");
  await releaseRecordWrite(pageB);
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain("record wasn't saved");
  await dialog.accept();
  const local = await readLocalState(pageB);
  expect(local.stores.records).toEqual([]);
  expect(local.stores.syncQueue).toEqual([]);
  await pageB.reload();
  await expect(pageB.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
});

test("9 existing installs classify pre-A, bind post-A on 200, retain on 503, and lock mismatch", async ({ page, browser }) => {
  const legacyContext = await browser.newContext({ baseURL: process.env.APP_TEST_URL || "http://127.0.0.1:5500" });
  const legacyPage = await legacyContext.newPage();
  await legacyPage.goto("/");
  await writeLocalState(legacyPage, { auth_token: preSliceAToken(), bound_account: "", signed_out: false, session_generation: 3 });
  await putStoreValue(legacyPage, "records", { id: 1, label: "old record" });
  await legacyPage.reload();
  await expect(legacyPage.locator("#signed-out-copy")).toHaveText("Verify your email to open the records on this device.");
  expect([undefined, ""]).toContain((await readLocalState(legacyPage)).settings.auth_token);
  expect((await readLocalState(legacyPage)).settings.signed_out).not.toBe(true);
  await legacyContext.close();
  const source = await signInThroughUi(page, nextAccount("nine"));
  await writeLocalState(page, { bound_account: "", signed_out: false, local_origin: "this_version" });
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  expect((await readLocalState(page)).settings.bound_account).toBe(source.accountId);
  await writeLocalState(page, { bound_account: "", signed_out: false, local_origin: "this_version" });
  await page.route("**/profile", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"auth_unavailable"}' }));
  await page.reload();
  await expect(page.getByText("Checking this device…")).toBeVisible();
  expect((await readLocalState(page)).settings.auth_token).toBe(source.token);
  await page.unroute("**/profile");
  const other = await browser.newContext({ baseURL: process.env.APP_TEST_URL || "http://127.0.0.1:5500" });
  const otherPage = await other.newPage();
  const otherAccount = await signInThroughUi(otherPage, nextAccount("nine-other"));
  await other.close();
  await writeLocalState(page, { auth_token: otherAccount.token, auth_token_expires_at: otherAccount.responseBody.expires_at, bound_account: "", signed_out: false });
  await page.route("**/profile", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"device_mismatch"}' }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
});

test("10 logout-all 204 revokes a same-account session on another real device", async ({ page, browser }) => {
  const account = await signInThroughUi(page, nextAccount("ten"));
  const other = await browser.newContext({ baseURL: process.env.APP_TEST_URL || "http://127.0.0.1:5500" });
  const otherPage = await other.newPage();
  await signInThroughUi(otherPage, { ...account, name: "other device" });
  const otherToken = (await readLocalState(otherPage)).settings.auth_token;
  await page.locator("#settings-logout-all-v2").click();
  await expect(page.getByText("Signed out on all devices.")).toBeVisible();
  await expect.poll(() => sessionState(otherToken)?.active).toBe(false);
  await other.close();
});

test("11 an explicitly injected late B verify after an aborted wipe is queued and revoked", async ({ page, browser }) => {
  const accountA = await signInThroughUi(page, nextAccount("eleven-a"));
  const contextB = await browser.newContext({ baseURL: process.env.APP_TEST_URL || "http://127.0.0.1:5500" });
  const pageB = await contextB.newPage();
  const accountB = await signInThroughUi(pageB, nextAccount("eleven-b"));
  await contextB.close();
  await signOut(page);
  await openSignedOutVerification(page, accountB);
  const code = await requestCode(page);
  const late = deferred();
  const verifyReached = deferred();
  await page.route("**/auth/otp/verify", async (route) => {
    verifyReached.resolve();
    await late.promise;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accountB.responseBody) });
  });
  const verification = verifyWithCode(page, code);
  await verifyReached.promise;
  await page.locator("#otp-back").click();
  const beforeGeneration = (await readLocalState(page)).settings.session_generation;
  await page.locator("#signed-out-remove-data").click();
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await armFault(page, "wipe");
  await page.locator("#remove-local-data-confirm").click();
  await expect.poll(async () => (await readLocalState(page)).settings.wipe_pending).toBe(true);
  await expect.poll(async () => (await readLocalState(page)).settings.session_generation)
    .toBe(Number(beforeGeneration || 0) + 1);
  await expect(page.locator("#remove-local-data-error")).toBeVisible();
  let heldLogoutRequests = 0;
  await page.route("**/auth/logout", (route) => {
    heldLogoutRequests += 1;
    return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"auth_unavailable"}' });
  });
  late.resolve();
  expect((await verification).status()).toBe(200);
  await expect.poll(async () => (await readLocalState(page)).settings.pending_revocations || []).toEqual(expect.arrayContaining([expect.objectContaining({ token: accountB.token, reason: "late_response" })]));
  await expect.poll(() => heldLogoutRequests).toBeGreaterThan(0);
  expect((await readLocalState(page)).settings.wipe_pending).toBe(true);
  await page.unroute("**/auth/logout");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => sessionState(accountB.token)?.active).toBe(false);
  expect(sessionState(accountA.token)?.active).toBe(false);
});

test("12 an aborted sign-out transaction reloads wholly signed-in", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("twelve"));
  const before = await readLocalState(page);
  await armFault(page, { settingKey: "signed_out" });
  await page.locator("#settings-logout-v2").click();
  await expect.poll(() => page.evaluate(() => window.__signoutTestFault?.fired)).toEqual(expect.objectContaining({
    settingKey: "signed_out",
    storeNames: ["settings"],
    keys: expect.arrayContaining(["auth_token", "auth_token_expires_at", "pending_revocations", "session_generation", "signed_out"])
  }));
  await page.reload();
  const state = await readLocalState(page);
  expect(state.settings.auth_token).toBe(account.token);
  expect(state.settings.auth_token).toBe(before.settings.auth_token);
  expect(state.settings.auth_token_expires_at).toBe(before.settings.auth_token_expires_at);
  expect(state.settings.pending_revocations || []).toEqual(before.settings.pending_revocations || []);
  expect(state.settings.session_generation).toBe(before.settings.session_generation);
  expect(state.settings.signed_out).toBe(before.settings.signed_out);
  expect(sessionState(account.token)?.active).toBe(true);
});

test("13 an aborted signed-out wipe preserves all stores and remains durably locked", async ({ page }) => {
  await signInThroughUi(page, nextAccount("thirteen"));
  await putStoreValue(page, "records", { id: 13, label: "keep" });
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 95 }, queued_at: Date.now() });
  await signOut(page);

  // Retain the early-abort case, which also leaves a durable wipe lock in
  // place. The snapshot for the retry therefore includes that intentional
  // settings change and can compare every wipe store byte-for-byte.
  await armFault(page, "wipe");
  await removeLocalData(page);
  await expect.poll(async () => (await readLocalState(page)).settings.wipe_pending).toBe(true);
  await expect(page.locator("#remove-local-data-error")).toBeVisible();
  const before = await readLocalState(page);

  await armFault(page, "wipe-after-deletes");
  await removeLocalData(page);
  await expect.poll(() => page.evaluate(() => window.__signoutTestFault?.fired)).toEqual({
    settingKey: "wipe_epoch",
    storeNames: ["records", "syncQueue", "customLabels", "usage", "voiceCorrections", "anomaly_log", "settings"],
    keys: ["sync_api_base_url", "wipe_epoch"]
  });
  const afterFailure = await readLocalState(page);
  expectAllWipeStoresUnchanged(afterFailure, before);
  expect(afterFailure.settings.wipe_pending).toBe(true);

  await page.reload();
  await expect(page.locator("#signed-out-copy")).toHaveText("Finish removing local data.");
  const after = await readLocalState(page);
  expectAllWipeStoresUnchanged(after, before);
  expect(after.settings.wipe_pending).toBe(true);
});

test("14 a held T1 refusal after T2 re-verification cannot clear T2", async ({ page }) => {
  // Only T1's returned expires_at is shortened so the real verification UI
  // becomes reachable without manufacturing application state.
  const account = await signInWithNearExpiry(page, nextAccount("fourteen"));
  const oldToken = account.token;
  const held = deferred();
  let profileStarted = false;
  await page.route("**/profile", async (route) => {
    if (route.request().headers().authorization === `Bearer ${oldToken}`) {
      profileStarted = true;
      await held.promise;
      await route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"session_invalid"}' });
      return;
    }
    await route.continue();
  });
  await page.reload();
  await expect.poll(() => profileStarted).toBe(true);
  await waitForLocalSessionExpiry(page);
  await openVerification(page, account);
  const code = await requestCode(page);
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  const t2 = await response.json();
  held.resolve();
  await expect.poll(async () => (await readLocalState(page)).settings.auth_token).toBe(t2.auth_token);
  expect((await readLocalState(page)).settings.signed_out).toBe(false);
  expect(sessionState(t2.auth_token)?.active).toBe(true);
});

test("15 an aborted Settings wipe reopens locked and a retry completes", async ({ page }) => {
  await signInThroughUi(page, nextAccount("fifteen"));
  await putStoreValue(page, "records", { id: 15, label: "keep through aborted Settings wipe" });
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 96 }, queued_at: Date.now() });

  // Keep the original early-transaction abort, then test the post-delete
  // abort against a snapshot made after the durable lock is committed.
  await armFault(page, "wipe");
  await page.locator("#settings-remove-local-data").click();
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await expect.poll(async () => (await readLocalState(page)).settings.wipe_pending).toBe(true);
  await expect(page.locator("#remove-local-data-error")).toBeVisible();
  const before = await readLocalState(page);

  await armFault(page, "wipe-after-deletes");
  await removeLocalData(page);
  await expect.poll(() => page.evaluate(() => window.__signoutTestFault?.fired)).toEqual({
    settingKey: "wipe_epoch",
    storeNames: ["records", "syncQueue", "customLabels", "usage", "voiceCorrections", "anomaly_log", "settings"],
    keys: ["sync_api_base_url", "wipe_epoch"]
  });
  const afterFailure = await readLocalState(page);
  expectAllWipeStoresUnchanged(afterFailure, before);
  expect(afterFailure.settings.wipe_pending).toBe(true);
  // Startup retries pending server revocations. Hold that unrelated write
  // across the reload comparison so it cannot change the settings snapshot.
  await page.route("**/auth/logout", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"auth_unavailable"}' }));
  await page.reload();
  await expect(page.locator("#signed-out-copy")).toHaveText("Finish removing local data.");
  const afterReload = await readLocalState(page);
  expectAllWipeStoresUnchanged(afterReload, before);
  expect(afterReload.settings.wipe_pending).toBe(true);
  await page.unroute("**/auth/logout");
  await removeLocalData(page);
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
});

test("16 logout-all 503 and a lost response never falsely confirm other devices", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("sixteen"));
  await page.route("**/auth/logout-all", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"auth_unavailable"}' }));
  await page.locator("#settings-logout-all-v2").click();
  await expect(page.locator("#settings-account-status")).toContainText("Couldn't confirm whether other devices were signed out");
  expect((await readLocalState(page)).settings.auth_token).toBe(account.token);
  await page.unroute("**/auth/logout-all");
  const accountRefusals = [];
  const logoutAllResponses = [];
  page.on("response", (response) => {
    if (response.url().includes("/auth/logout-all")) logoutAllResponses.push(response.status());
    if (response.status() === 401 && !response.url().includes("/auth/logout-all")) {
      accountRefusals.push(response.url());
    }
  });
  let upstreamCommitted = false;
  let interceptionSettled = false;
  let interceptedRequest;
  await page.route("**/auth/logout-all", async (route) => {
    try {
      interceptedRequest = route.request();
      const response = await page.request.post(`${APP_API_URL}/auth/logout-all`, {
        headers: {
          Authorization: route.request().headers().authorization,
          "x-device-identity": route.request().headers()["x-device-identity"]
        }
      });
      expect(response.status()).toBe(204);
      upstreamCommitted = true;
      // A concurrent session_invalid response may abort the intercepted fetch.
      if (interceptedRequest.failure()) return;
      try {
        await route.fulfill({ status: 504, contentType: "application/json", body: "{" });
      } catch (error) {
        if (!interceptedRequest.failure()) throw error;
      }
    } finally {
      interceptionSettled = true;
    }
  });
  await page.locator("#settings-logout-all-v2").click();
  await expect.poll(() => upstreamCommitted).toBe(true);
  await expect.poll(() => interceptionSettled).toBe(true);
  let outcome = "pending";
  await expect.poll(async () => {
    const local = await readLocalState(page);
    if (local.settings.signed_out === true && !local.settings.auth_token) {
      outcome = "signed_out";
      return outcome;
    }
    const message = await page.locator("#settings-account-status").textContent();
    if (local.settings.auth_token === account.token
      && message?.includes("Couldn't confirm whether other devices were signed out")) {
      outcome = "unconfirmed";
      return outcome;
    }
    return "pending";
  }).not.toBe("pending");
  expect(interceptedRequest).toBeTruthy();
  if (outcome === "signed_out") expect(accountRefusals.length).toBeGreaterThan(0);
  if (outcome === "unconfirmed") expect(logoutAllResponses).toContain(504);
  await expect.poll(() => sessionState(account.token)?.active).toBe(false);
  await page.unroute("**/auth/logout-all");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
});

test("17 replacement advances generation atomically and discards delayed T1 profile and sync results", async ({ page }) => {
  // The real replacement path opens after the locally stored T1 expiry.
  const account = await signInWithNearExpiry(page, nextAccount("seventeen"));
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 1700 }, queued_at: Date.now() });
  await putStoreValue(page, "records", { id: 1700, label: "T1 queued record", evidence_level: "device_signed" });
  const before = await readLocalState(page);
  const profileHeld = deferred();
  const syncHeld = deferred();
  let profileStarted = false;
  let syncStarted = false;
  await page.route("**/profile", async (route) => {
    if (route.request().headers().authorization !== `Bearer ${account.token}`) return route.continue();
    profileStarted = true;
    const response = await route.fetch();
    await profileHeld.promise;
    await route.fulfill({ response });
  });
  await page.route("**/sync/entries", async (route) => {
    if (route.request().headers().authorization !== `Bearer ${account.token}`) return route.continue();
    syncStarted = true;
    await syncHeld.promise;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ synced_count: 1, server_receipt: "old-session-ack" }) });
  });
  await page.reload();
  await expect.poll(() => profileStarted && syncStarted).toBe(true);
  await waitForLocalSessionExpiry(page);
  await openVerification(page, account);
  const code = await requestCode(page);
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  const replacement = await response.json();
  await expect(page.locator("#screen-settings.active")).toBeVisible();
  profileHeld.resolve();
  const delayedSyncResponse = page.waitForResponse((candidate) => candidate.url().includes("/sync/entries")
    && candidate.request().headers().authorization === `Bearer ${account.token}`);
  syncHeld.resolve();
  await delayedSyncResponse;
  const receiptBeforeRelease = before.settings.last_sync_receipt;
  const stableUntil = Date.now() + 500;
  await expect.poll(async () => {
    const receipt = (await readLocalState(page)).settings.last_sync_receipt;
    if (receipt !== receiptBeforeRelease) return receipt;
    return Date.now() >= stableUntil ? receiptBeforeRelease : "waiting-for-stability-window";
  }, { timeout: 1_500, intervals: [50] }).toBe(receiptBeforeRelease);
  const after = await readLocalState(page);
  expect(after.settings.auth_token).toBe(replacement.auth_token);
  expect(after.settings.session_generation).toBe(Number(before.settings.session_generation || 0) + 1);
  expect(after.stores.syncQueue).toHaveLength(1);
  expect(after.stores.records.find((record) => record.id === 1700)?.evidence_level).not.toBe("server_attested");
  expect(after.settings.last_sync_receipt).not.toBe("old-session-ack");
  await page.reload();
  const reloaded = await readLocalState(page);
  expect(reloaded.settings.auth_token).toBe(replacement.auth_token);
  expect(reloaded.settings.bound_account).toBe(account.accountId);
  expect(sessionState(tokenSessionId(replacement.auth_token))?.active).toBe(true);
});

test("R1 restore cannot rewrite server records after sign-out commits", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("restore-race"));
  await page.locator("#nav-record-v2").click();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill("2401");
  await page.locator("#prepare-confirmation").click();
  await page.locator("#confirm-append").click();
  await expect.poll(async () => {
    const local = await readLocalState(page);
    return local.stores.records[0]?.evidence_level;
  }).toBe("server_attested");
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length).toBe(0);

  await clearStore(page, "records");
  expect((await readLocalState(page)).stores.records).toEqual([]);

  const heldRecords = deferred();
  let restoreStarted = false;
  await page.route("**/records", async (route) => {
    if (route.request().headers().authorization !== `Bearer ${account.token}`) return route.continue();
    restoreStarted = true;
    const response = await route.fetch();
    await heldRecords.promise;
    await route.fulfill({ response });
  });
  await armRestoreWriteRace(page);
  await page.reload();
  await expect.poll(() => restoreStarted).toBe(true);
  heldRecords.resolve();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  const after = await readLocalState(page);
  expect(after.settings.signed_out).toBe(true);
  expect(after.stores.records).toEqual([]);
});
