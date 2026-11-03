import { expect, test } from "@playwright/test";
import { canonicalJson } from "../../../app-v3/recovery-client.js";
import {
  APP_API_URL,
  deleteLocalSettings,
  deviceStatusForIdentity,
  ensureCaptureScreen,
  ledgerEntriesForDevice,
  nextAccount,
  openVerification,
  readLocalState,
  recoveryPartsForSession,
  recoverySessionsForDevice,
  requestCode,
  restoreThroughUi,
  revokeOnServer,
  signInThroughUi,
  verifyWithCode,
  writeLocalState
} from "./helpers.mjs";

test.use({ serviceWorkers: "block" });

const ZERO_HASH = "0".repeat(64);
const SERVER_TIMEOUT = { timeout: 90_000 };
const STARTUP_WAIT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 20_000;
const PART_TIMEOUT_MS = 45_000;
const TIMEOUT_RETRY_MS = 5 * 60 * 1000;
const UNAVAILABLE_RETRY_MS = 15 * 60 * 1000;

async function confirmRecord(page, amount) {
  await ensureCaptureScreen(page, { timeout: 10_000 });
  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill(String(amount));
  await page.locator("#prepare-confirmation").click();
  await expect(page.locator("#confirm-append")).toBeEnabled();
  const response = page.waitForResponse((candidate) => (
    candidate.url().includes("/sync/entries") && candidate.request().method() === "POST"
  ), SERVER_TIMEOUT);
  await page.locator("#confirm-append").click();
  expect((await response).status()).toBe(200);
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length, SERVER_TIMEOUT).toBe(0);
}

async function installDamagedShape(page, label) {
  return page.evaluate(async ({ label, zeroHash }) => {
    const open = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const read = db.transaction(["settings", "records"], "readonly");
    const settingsRequest = read.objectStore("settings").getAll();
    const recordsRequest = read.objectStore("records").getAll();
    const [settingsRows, records] = await Promise.all([
      new Promise((resolve, reject) => {
        settingsRequest.onsuccess = () => resolve(settingsRequest.result || []);
        settingsRequest.onerror = () => reject(settingsRequest.error);
      }),
      new Promise((resolve, reject) => {
        recordsRequest.onsuccess = () => resolve(recordsRequest.result || []);
        recordsRequest.onerror = () => reject(recordsRequest.error);
      })
    ]);
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
    const accepted = records
      .filter((row) => !row.importedFromServer && row.device_identity === settings.device_identity)
      .sort((left, right) => Number(left.id) - Number(right.id));
    if (!accepted.length) throw new Error("accepted fixture chain missing");
    const imported = accepted.map((record) => ({
      ...record,
      id: 1_000_000_000 + Number(record.id),
      server_entry_id: Number(record.id),
      importedFromServer: true
    }));
    const record = {
      ...accepted[0],
      id: 1,
      transaction_type: "sale",
      normalized_label: label,
      amount_minor: 911_000,
      confirmed_at: Math.floor(Date.now() / 1000) - 120,
      prev_entry_hash: zeroHash,
      reversed_entry_hash: null,
      reversed_transaction_type: null,
      importedFromServer: false,
      evidence_level: "device_signed"
    };
    delete record.server_entry_id;
    delete record.restoredOwn;
    delete record.restoreVerified;
    const canonical = [
      record.id, record.transaction_type, record.normalized_label, record.amount_minor,
      record.currency, record.counterparty, record.business_type_id, record.country,
      record.source_account, record.destination_account, record.reversed_entry_hash,
      record.reversed_transaction_type, record.confirmed_at, record.prev_entry_hash
    ].map((value) => value == null ? "" : String(value)).join("|");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    record.entry_hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      settings.device_private_key,
      new TextEncoder().encode(record.entry_hash)
    );
    record.signature = btoa(String.fromCharCode(...new Uint8Array(signature)));

    const write = db.transaction(
      ["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"],
      "readwrite"
    );
    const settingsStore = write.objectStore("settings");
    ["fork_recovery_pending", "fork_recovery_skips", "recovery_state", "recovery_history"]
      .forEach((key) => settingsStore.delete(key));
    ["records", "syncQueue", "recoverySnapshots", "recoveryWork"]
      .forEach((name) => write.objectStore(name).clear());
    imported.forEach((item) => write.objectStore("records").put(item));
    write.objectStore("records").put(record);
    write.objectStore("syncQueue").add({
      entry_id: record.id,
      entry_hash: record.entry_hash,
      device_identity: record.device_identity,
      status: "queued",
      attempt_count: 0,
      queued_at: Date.now(),
      entry_payload: record
    });
    await new Promise((resolve, reject) => {
      write.oncomplete = resolve;
      write.onabort = () => reject(write.error || new Error("damage fixture write aborted"));
      write.onerror = () => reject(write.error);
    });
    db.close();
    return {
      deviceIdentity: settings.device_identity,
      rejectedHash: record.entry_hash,
      rejectedConfirmedAt: record.confirmed_at,
      rejectedLabel: record.normalized_label
    };
  }, { label, zeroHash: ZERO_HASH });
}

async function sendQueuedOnce(page) {
  return page.evaluate(async (apiUrl) => {
    const open = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction(["settings", "syncQueue"], "readonly");
    const settingsRequest = tx.objectStore("settings").getAll();
    const queueRequest = tx.objectStore("syncQueue").getAll();
    const [settingsRows, queue] = await Promise.all([
      new Promise((resolve, reject) => {
        settingsRequest.onsuccess = () => resolve(settingsRequest.result || []);
        settingsRequest.onerror = () => reject(settingsRequest.error);
      }),
      new Promise((resolve, reject) => {
        queueRequest.onsuccess = () => resolve(queueRequest.result || []);
        queueRequest.onerror = () => reject(queueRequest.error);
      })
    ]);
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
    const response = await fetch(`${apiUrl}/sync/entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.auth_token}`,
        "Content-Type": "application/json",
        "X-Device-Identity": settings.device_identity
      },
      body: JSON.stringify({
        device_identity: settings.device_identity,
        public_key: settings.device_public_key,
        entries: queue.map((item) => item.entry_payload)
      })
    });
    const body = await response.json();
    db.close();
    return { status: response.status, code: body.code || body.error || "" };
  }, APP_API_URL);
}

async function setupDamagedDevice(page, label, amount) {
  const account = await signInThroughUi(page, nextAccount(label));
  await confirmRecord(page, amount);
  const fixture = await installDamagedShape(page, `${label}_rejected`);
  expect(await sendQueuedOnce(page)).toEqual({ status: 409, code: "ledger_fork_conflict" });
  expect(deviceStatusForIdentity(fixture.deviceIdentity)?.status).toBe("FORKED");
  return { ...fixture, account };
}

async function waitForRecoveryCompleted(page) {
  let matched = null;
  await expect.poll(async () => {
    const local = await readLocalState(page);
    const recovery = local.settings.recovery_state;
    if (recovery?.state === "completed") matched = local;
    return recovery?.state || "none";
  }, SERVER_TIMEOUT).toBe("completed");
  return matched;
}

function preservedBytes(local) {
  return canonicalJson({
    records: local.stores.records,
    queue: local.stores.syncQueue,
    snapshots: local.stores.recoverySnapshots
  });
}

function replacementBytes(local) {
  const recoveryId = local.settings.recovery_state?.recovery_id;
  const work = local.stores.recoveryWork.find((item) => item.recovery_id === recoveryId);
  return work
    ? canonicalJson((work.items || []).filter((item) => item.replacement).map((item) => item.replacement))
    : null;
}

function holdRoute() {
  let seenResolve;
  let releaseResolve;
  const seen = new Promise((resolve) => { seenResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const state = { count: 0, outstanding: 0, bodies: [] };
  return {
    state,
    seen,
    release: () => releaseResolve(),
    handler: async (route) => {
      state.count += 1;
      state.outstanding += 1;
      state.bodies.push(route.request().postData() || "");
      seenResolve();
      await release;
      try {
        await route.abort("aborted");
      } catch {
        // The page's AbortController can finish the request before the held
        // Playwright route is released.
      } finally {
        state.outstanding -= 1;
      }
    }
  };
}

function pauseAndContinueRoute() {
  let seenResolve;
  let releaseResolve;
  const seen = new Promise((resolve) => { seenResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const state = { count: 0 };
  return {
    state,
    seen,
    release: () => releaseResolve(),
    handler: async (route) => {
      state.count += 1;
      seenResolve();
      await release;
      await route.continue();
    }
  };
}

async function expireDamagedSession(page, fixture, { dropProfile = false } = {}) {
  await revokeOnServer(page, fixture.account.token);
  await writeLocalState(page, {
    auth_token_expires_at: new Date(Date.now() - 60_000).toISOString(),
    signed_out: false
  });
  if (dropProfile) await deleteLocalSettings(page, ["profile"]);
}

async function signInSameAccountThroughOtp(page, account) {
  await openVerification(page, account);
  const code = await requestCode(page);
  const response = await verifyWithCode(page, code);
  expect(response.status()).toBe(200);
  return response.json();
}

function expectRecoveredRecordExactlyOnce(fixture) {
  const recovered = ledgerEntriesForDevice(fixture.deviceIdentity)
    .filter((row) => row.payload?.normalized_label === fixture.rejectedLabel);
  expect(recovered).toHaveLength(1);
  expect(Number(recovered[0].payload.confirmed_at)).toBe(Number(fixture.rejectedConfirmedAt));
}

test("C5 T-S1/T-S2: a never-answering session request releases startup UI, aborts, and retries only on a later open", async ({ page }) => {
  test.slow();
  const fixture = await setupDamagedDevice(page, "c5-session-timeout", 9101);
  const before = await readLocalState(page);
  const beforeRecordsQueue = canonicalJson({ records: before.stores.records, queue: before.stores.syncQueue });
  const held = holdRoute();
  let ordinarySyncRequests = 0;
  let recoveryRequests = 0;
  const recoveryPaths = [];
  const acknowledgedPartBodies = [];
  const replacementSyncBodies = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/recovery/")) {
      recoveryRequests += 1;
      recoveryPaths.push(pathname);
    }
    if (pathname.includes("/parts/") && request.method() === "PUT") acknowledgedPartBodies.push(request.postData() || "");
    if (pathname === "/sync/entries" && request.method() === "POST") {
      ordinarySyncRequests += 1;
      replacementSyncBodies.push(request.postData() || "");
    }
  });
  await page.clock.install();
  await page.route("**/recovery/sessions", held.handler);
  const reload = page.reload();
  await held.seen;
  expect(held.state.count).toBeGreaterThan(0);
  expect(held.state.outstanding).toBe(1);

  await page.clock.fastForward(STARTUP_WAIT_MS + 1);
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect(page.locator("#recovery-hold-banner")).toContainText("saved records are being preserved");
  await page.locator("#nav-settings-v2").click();
  await expect(page.locator("#screen-settings.active")).toBeVisible();
  await expect(page.locator("#settings-logout-v2")).toBeEnabled();
  expect(ordinarySyncRequests).toBe(0);
  expect(recoveryRequests).toBe(1);
  const during = await readLocalState(page);
  expect(during.settings.recovery_state.state).toBe("snapshotted");
  expect(during.settings.recovery_state.escalated).toBeUndefined();
  expect(canonicalJson({ records: during.stores.records, queue: during.stores.syncQueue })).toBe(beforeRecordsQueue);
  const duringPreservedBytes = preservedBytes(during);

  const aborted = page.waitForEvent("requestfailed", (request) => (
    new URL(request.url()).pathname === "/recovery/sessions"
  ));
  await page.clock.fastForward(REQUEST_TIMEOUT_MS);
  await aborted;
  await reload;
  held.release();
  await page.unroute("**/recovery/sessions", held.handler);
  const timedOut = await readLocalState(page);
  expect(timedOut.settings.recovery_state).toEqual(expect.objectContaining({
    state: "snapshotted",
    last_attempt_at: expect.any(Number),
    next_attempt_after: expect.any(Number)
  }));
  expect(timedOut.settings.recovery_state.next_attempt_after - timedOut.settings.recovery_state.last_attempt_at)
    .toBe(TIMEOUT_RETRY_MS);
  expect(timedOut.settings.recovery_state.completion).toBeUndefined();
  expect(preservedBytes(timedOut)).toBe(duringPreservedBytes);

  const requestCountAtTimeout = recoveryRequests;
  await page.clock.fastForward(TIMEOUT_RETRY_MS + 1);
  expect(recoveryRequests).toBe(requestCountAtTimeout);
  let firstPersistedReplacementBytes = null;
  const capturePersistedReplacement = async (route) => {
    const entries = route.request().postDataJSON()?.entries || [];
    if (entries.length && firstPersistedReplacementBytes == null) {
      firstPersistedReplacementBytes = replacementBytes(await readLocalState(page));
    }
    await route.continue();
  };
  await page.route("**/sync/entries", capturePersistedReplacement);
  await page.reload();
  const completed = await waitForRecoveryCompleted(page);
  await page.unroute("**/sync/entries", capturePersistedReplacement);
  expect(completed.settings.recovery_state.recovery_id).toBe(timedOut.settings.recovery_state.recovery_id);
  expect(completed.settings.recovery_state.completion?.accounted_for).toBe(true);
  // The snapshot's preserved content is create-once; its per-item `outcomes` and
  // verification flag are filled in as the rebuild proceeds, so compare the raw
  // preserved fields, not the whole record.
  const rawSnapshots = (local) => local.stores.recoverySnapshots.map((snapshot) => ({
    recovery_id: snapshot.recovery_id,
    device_identity: snapshot.device_identity,
    records: snapshot.records,
    queue: snapshot.queue,
    classification_inputs: snapshot.classification_inputs
  }));
  expect(rawSnapshots(completed)).toEqual(rawSnapshots(timedOut));
  expect(acknowledgedPartBodies.length).toBeGreaterThan(0);
  expect(new Set(acknowledgedPartBodies).size).toBe(acknowledgedPartBodies.length);
  expect(replacementSyncBodies.length).toBe(1);
  expect(firstPersistedReplacementBytes).not.toBeNull();
  expect(replacementBytes(completed)).toBe(firstPersistedReplacementBytes);
  const sessionPath = "/recovery/sessions";
  const recoveryId = completed.settings.recovery_state.recovery_id;
  // Three session posts: the aborted (never-answered) first attempt, then the normal
  // flow's create at upload and its idempotent re-post at the `uploaded` step. The
  // single server-side session asserted below shows none of them created a second incident.
  expect(recoveryPaths.filter((path) => path === sessionPath)).toHaveLength(3);
  expect(recoveryPaths.filter((path) => path.includes("/parts/"))).toHaveLength(1);
  expect(recoveryPaths.filter((path) => path === `/recovery/sessions/${recoveryId}/plan`)).toHaveLength(1);
  expect(recoveryPaths.filter((path) => path === `/recovery/sessions/${recoveryId}/complete`)).toHaveLength(1);
  expect(ledgerEntriesForDevice(fixture.deviceIdentity)).toHaveLength(2);
  expect(recoverySessionsForDevice(fixture.deviceIdentity)).toHaveLength(1);
});

test("C5 T-S3: a never-answering part upload preserves its checkpoint and retries identical bytes", async ({ page }) => {
  test.slow();
  const fixture = await setupDamagedDevice(page, "c5-part-timeout", 9102);
  const held = holdRoute();
  const partBodies = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("/parts/") && request.method() === "PUT") {
      partBodies.push(request.postData() || "");
    }
  });
  await page.clock.install();
  await page.route("**/recovery/sessions/*/parts/*", held.handler);
  const reload = page.reload();
  await held.seen;
  expect(held.state.count).toBeGreaterThan(0);
  expect(held.state.outstanding).toBe(1);
  const checkpoint = await readLocalState(page);
  expect(checkpoint.settings.recovery_state.state).toBe("snapshotted");
  const snapshotBytes = canonicalJson(checkpoint.stores.recoverySnapshots);
  const firstBody = held.state.bodies[0];

  const aborted = page.waitForEvent("requestfailed", (request) => (
    new URL(request.url()).pathname.includes("/parts/")
  ));
  await page.clock.fastForward(PART_TIMEOUT_MS + STARTUP_WAIT_MS + 1);
  await aborted;
  await reload;
  held.release();
  await page.unroute("**/recovery/sessions/*/parts/*", held.handler);
  const timedOut = await readLocalState(page);
  expect(timedOut.settings.recovery_state.state).toBe("snapshotted");
  expect(timedOut.settings.recovery_state.completion).toBeUndefined();
  expect(canonicalJson(timedOut.stores.recoverySnapshots)).toBe(snapshotBytes);
  expect(timedOut.settings.recovery_state.next_attempt_after - timedOut.settings.recovery_state.last_attempt_at)
    .toBe(TIMEOUT_RETRY_MS);

  await page.clock.fastForward(TIMEOUT_RETRY_MS + 1);
  await page.reload();
  const completed = await waitForRecoveryCompleted(page);
  expect(partBodies.length).toBeGreaterThan(1);
  expect(partBodies[0]).toBe(firstBody);
  expect(partBodies[1]).toBe(firstBody);
  expect(recoveryPartsForSession(completed.settings.recovery_state.recovery_id)).toHaveLength(1);
  expect(completed.settings.recovery_state.completion?.accounted_for).toBe(true);
  expect(ledgerEntriesForDevice(fixture.deviceIdentity)).toHaveLength(2);
});

test("C5 T-S4: recovery_not_enabled preserves the hold and retries only after the availability interval", async ({ page }) => {
  test.slow();
  const fixture = await setupDamagedDevice(page, "c5-not-enabled", 9103);
  let sessionAttempts = 0;
  let allSessionRequests = 0;
  const sessionRecoveryIds = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/recovery/sessions") {
      allSessionRequests += 1;
      sessionRecoveryIds.push(request.postDataJSON()?.recovery_id);
    }
  });
  const notEnabled = async (route) => {
    sessionAttempts += 1;
    // The exact server default-off contract is covered by recovery-rollout.test.js;
    // this interception isolates the app's response to that contract.
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "recovery_not_enabled", code: "recovery_not_enabled" })
    });
  };
  await page.clock.install();
  await page.route("**/recovery/sessions", notEnabled);
  await page.reload();
  await expect(page.locator("#recovery-hold-banner")).toContainText(
    "Repair for this device is waiting to be turned on. Your saved records are being preserved."
  );
  expect(sessionAttempts).toBe(1);
  const waiting = await readLocalState(page);
  expect(waiting.settings.recovery_state).toEqual(expect.objectContaining({
    state: "snapshotted",
    availability: "waiting",
    unavailable_at: expect.any(Number),
    last_attempt_at: expect.any(Number),
    next_attempt_after: expect.any(Number)
  }));
  expect(waiting.settings.recovery_state.next_attempt_after - waiting.settings.recovery_state.last_attempt_at)
    .toBe(UNAVAILABLE_RETRY_MS);
  expect(waiting.settings.recovery_state.completion).toBeUndefined();
  expect(waiting.settings.fork_recovery_pending).toBeDefined();
  const waitingBytes = preservedBytes(waiting);

  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  expect(sessionAttempts).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.clock.runFor(100);
  expect(sessionAttempts).toBe(1);
  const suppressed = await readLocalState(page);
  expect(preservedBytes(suppressed)).toBe(waitingBytes);
  expect(suppressed.settings.recovery_state.state).toBe("snapshotted");
  expect(suppressed.settings.fork_recovery_pending).toEqual(waiting.settings.fork_recovery_pending);

  await page.unroute("**/recovery/sessions", notEnabled);
  await page.clock.fastForward(UNAVAILABLE_RETRY_MS + 1);
  expect(sessionAttempts).toBe(1);
  await page.reload();
  const completed = await waitForRecoveryCompleted(page);
  expect(completed.settings.recovery_state.completion?.accounted_for).toBe(true);
  expect(completed.settings.recovery_state.availability).toBeUndefined();
  expect(completed.settings.recovery_state.unavailable_at).toBeUndefined();
  expect(completed.settings.fork_recovery_pending).toBeUndefined();
  // One refused attempt, then the normal recovery flow's two session posts (create at
  // upload, then the idempotent re-post at the `uploaded` step that returns the head),
  // all for the SAME recovery id: the refusal created no second incident.
  expect(sessionAttempts).toBe(1);
  expect(allSessionRequests).toBe(3);
  expect(new Set(sessionRecoveryIds).size).toBe(1);
  expect(ledgerEntriesForDevice(fixture.deviceIdentity)).toHaveLength(2);
});

test("C5 T-S5: a healthy device bypasses the bounded wait without recovery traffic or state writes", async ({ page }) => {
  await signInThroughUi(page, nextAccount("c5-healthy"));
  await confirmRecord(page, 9104);
  await page.addInitScript(() => {
    window.__c5StartupWaitFired = 0;
    window.__c5RecoveryStateWrites = 0;
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => originalSetTimeout.call(window, () => {
      if (delay === 3000) window.__c5StartupWaitFired += 1;
      callback(...args);
    }, delay);
    const originalPut = IDBObjectStore.prototype.put;
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.put = function patchedPut(value, key) {
      if (this.name === "settings" && value?.key === "recovery_state") window.__c5RecoveryStateWrites += 1;
      return originalPut.call(this, value, key);
    };
    IDBObjectStore.prototype.add = function patchedAdd(value, key) {
      if (this.name === "settings" && value?.key === "recovery_state") window.__c5RecoveryStateWrites += 1;
      return originalAdd.call(this, value, key);
    };
  });
  let recoveryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
  });
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  expect(await page.evaluate(() => window.__c5StartupWaitFired)).toBe(0);
  expect(await page.evaluate(() => window.__c5RecoveryStateWrites)).toBe(0);
  expect(recoveryRequests).toBe(0);
  const local = await readLocalState(page);
  expect(local.settings.recovery_state).toBeUndefined();
  expect(await page.locator("#recovery-hold-banner").count()).toBe(0);
});

// C5 T-S6 is the existing real-server recovery coverage in recovery-c3.spec.mjs
// and recovery-c4.spec.mjs. serve-api.mjs explicitly sets RECOVERY_MODE=all so
// those unchanged end-to-end cases continue to exercise enabled recovery.

test("C5 T-S7: same-account OTP sign-in resumes an expired device recovery without reload", async ({ page }) => {
  test.slow();
  const fixture = await setupDamagedDevice(page, "c5-signin-otp", 9107);
  let recoveryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
  });

  await expireDamagedSession(page, fixture);
  await page.reload();
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  await expect(page.locator("#recovery-hold-banner")).toContainText("saved records are being preserved");
  expect(recoveryRequests).toBe(0);

  const paused = pauseAndContinueRoute();
  const replacementSyncBytes = [];
  await page.route("**/recovery/sessions", paused.handler);
  const captureReplacementBytes = async (route) => {
    const entries = route.request().postDataJSON()?.entries || [];
    if (entries.length) replacementSyncBytes.push(replacementBytes(await readLocalState(page)));
    await route.continue();
  };
  await page.route("**/sync/entries", captureReplacementBytes);

  await signInSameAccountThroughOtp(page, fixture.account);
  await paused.seen;
  expect(paused.state.count).toBeGreaterThan(0);
  expect(recoveryRequests).toBeGreaterThan(0);
  paused.release();

  const completed = await waitForRecoveryCompleted(page);
  await expect(page.locator("#screen-settings.active")).toBeVisible();
  expect(completed.settings.recovery_state.completion?.accounted_for).toBe(true);
  expect(replacementSyncBytes).toHaveLength(1);
  expect(replacementSyncBytes[0]).not.toBeNull();
  expect(replacementBytes(completed)).toBe(replacementSyncBytes[0]);
  expectRecoveredRecordExactlyOnce(fixture);
  expect(recoverySessionsForDevice(fixture.deviceIdentity)).toHaveLength(1);

  await page.unroute("**/sync/entries", captureReplacementBytes);
  await page.unroute("**/recovery/sessions", paused.handler);
});

test("C5 T-S8: restore-account sign-in resumes an expired device recovery without reload", async ({ page }) => {
  test.slow();
  const fixture = await setupDamagedDevice(page, "c5-signin-restore", 9108);
  let recoveryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
  });

  await expireDamagedSession(page, fixture, { dropProfile: true });
  await page.reload();
  await expect(page.locator("#screen-onboarding.active")).toBeVisible();
  await expect(page.locator("#recovery-hold-banner")).toContainText("saved records are being preserved");
  expect(recoveryRequests).toBe(0);

  const paused = pauseAndContinueRoute();
  await page.route("**/recovery/sessions", paused.handler);
  await restoreThroughUi(page, fixture.account);
  await paused.seen;
  expect(paused.state.count).toBeGreaterThan(0);
  expect(recoveryRequests).toBeGreaterThan(0);
  paused.release();

  const completed = await waitForRecoveryCompleted(page);
  await expect(page.locator("#screen-capture.active")).toBeVisible();
  expect(completed.settings.recovery_state.completion?.accounted_for).toBe(true);
  expectRecoveredRecordExactlyOnce(fixture);
  expect(recoverySessionsForDevice(fixture.deviceIdentity)).toHaveLength(1);
  await page.unroute("**/recovery/sessions", paused.handler);
});

test("C5 T-S9: same-account sign-in respects a real recovery availability cooldown", async ({ page }) => {
  test.slow();
  const fixture = await setupDamagedDevice(page, "c5-signin-cooldown", 9109);
  let sessionAttempts = 0;
  let recoveryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
  });
  const notEnabled = async (route) => {
    sessionAttempts += 1;
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "recovery_not_enabled", code: "recovery_not_enabled" })
    });
  };

  await page.clock.install();
  await page.route("**/recovery/sessions", notEnabled);
  await page.reload();
  await expect(page.locator("#recovery-hold-banner")).toContainText("waiting to be turned on");
  expect(sessionAttempts).toBe(1);
  const waiting = await readLocalState(page);
  expect(waiting.settings.recovery_state.next_attempt_after - waiting.settings.recovery_state.last_attempt_at)
    .toBe(UNAVAILABLE_RETRY_MS);

  await expireDamagedSession(page, fixture);
  await page.reload();
  const requestsBeforeSignIn = recoveryRequests;
  await signInSameAccountThroughOtp(page, fixture.account);
  await expect(page.locator("#screen-settings.active")).toBeVisible();
  expect(sessionAttempts).toBe(1);
  expect(recoveryRequests).toBe(requestsBeforeSignIn);
  const afterSignIn = await readLocalState(page);
  expect(afterSignIn.settings.recovery_state.next_attempt_after)
    .toBe(waiting.settings.recovery_state.next_attempt_after);
  expect(preservedBytes(afterSignIn)).toBe(preservedBytes(waiting));

  await page.unroute("**/recovery/sessions", notEnabled);
  await page.clock.fastForward(UNAVAILABLE_RETRY_MS + 1);
  expect(recoveryRequests).toBe(requestsBeforeSignIn);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const completed = await waitForRecoveryCompleted(page);
  expect(recoveryRequests).toBeGreaterThan(requestsBeforeSignIn);
  expect(completed.settings.recovery_state.completion?.accounted_for).toBe(true);
  expectRecoveredRecordExactlyOnce(fixture);
  expect(recoverySessionsForDevice(fixture.deviceIdentity)).toHaveLength(1);
});

test("C5 T-S10: a healthy sign-in has no recovery request, state write, banner, or startup wait", async ({ page }) => {
  await page.addInitScript(() => {
    window.__c5HealthySignInRecoveryWrites = 0;
    window.__c5HealthySignInStartupWaits = 0;
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => originalSetTimeout.call(window, () => {
      if (delay === 3000) window.__c5HealthySignInStartupWaits += 1;
      callback(...args);
    }, delay);
    const originalPut = IDBObjectStore.prototype.put;
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.put = function patchedPut(value, key) {
      if (this.name === "settings" && value?.key === "recovery_state") {
        window.__c5HealthySignInRecoveryWrites += 1;
      }
      return originalPut.call(this, value, key);
    };
    IDBObjectStore.prototype.add = function patchedAdd(value, key) {
      if (this.name === "settings" && value?.key === "recovery_state") {
        window.__c5HealthySignInRecoveryWrites += 1;
      }
      return originalAdd.call(this, value, key);
    };
  });
  let recoveryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
  });

  await signInThroughUi(page, nextAccount("c5-signin-healthy"));
  expect(recoveryRequests).toBe(0);
  expect(await page.evaluate(() => window.__c5HealthySignInRecoveryWrites)).toBe(0);
  expect(await page.evaluate(() => window.__c5HealthySignInStartupWaits)).toBe(0);
  expect((await readLocalState(page)).settings.recovery_state).toBeUndefined();
  expect(await page.locator("#recovery-hold-banner").count()).toBe(0);
});

test("C5 T-S11: a different-account UI sign-in leaves held recovery evidence untouched", async ({ page, browser }, testInfo) => {
  test.slow();
  const fixture = await setupDamagedDevice(page, "c5-signin-account-a", 9111);
  const otherContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL || process.env.APP_TEST_URL || "http://127.0.0.1:5500",
    serviceWorkers: "block"
  });
  const otherPage = await otherContext.newPage();
  try {
    const otherAccount = await signInThroughUi(otherPage, nextAccount("c5-signin-account-b"));
    let recoveryRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
    });

    await expireDamagedSession(page, fixture);
    await page.reload();
    await expect(page.locator("#recovery-hold-banner")).toContainText("saved records are being preserved");
    expect(recoveryRequests).toBe(0);
    const before = await readLocalState(page);
    const bannerBefore = await page.locator("#recovery-hold-banner").textContent();

    await openVerification(page, otherAccount);
    const code = await requestCode(page);
    const injectedResponse = async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(otherAccount.responseBody)
    });
    await page.route("**/auth/otp/verify", injectedResponse);
    const response = await verifyWithCode(page, code);
    expect(response.status()).toBe(200);
    await expect(page.locator("#signed-out-pending")).toContainText("another account");
    await page.unroute("**/auth/otp/verify", injectedResponse);

    const after = await readLocalState(page);
    expect(recoveryRequests).toBe(0);
    expect(after.settings.bound_account).toBe(before.settings.bound_account);
    expect(after.settings.recovery_state).toEqual(before.settings.recovery_state);
    expect(after.settings.fork_recovery_pending).toEqual(before.settings.fork_recovery_pending);
    expect(after.stores.records).toEqual(before.stores.records);
    expect(after.stores.syncQueue).toEqual(before.stores.syncQueue);
    expect(after.stores.recoverySnapshots).toEqual(before.stores.recoverySnapshots);
    expect(after.stores.recoveryWork).toEqual(before.stores.recoveryWork);
    expect(await page.locator("#recovery-hold-banner").textContent()).toBe(bannerBefore);
    expect(recoverySessionsForDevice(fixture.deviceIdentity)).toHaveLength(0);
  } finally {
    await otherContext.close();
  }
});
