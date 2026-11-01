import { expect, test } from "@playwright/test";
import {
  APP_API_URL,
  armFault,
  armRecordWriteHold,
  clearStore,
  deviceStatusForIdentity,
  installIdbFault,
  ledgerEntriesForDevice,
  ledgerIntegrityEventsForDevice,
  nextAccount,
  nextLedgerAppendInput,
  putStoreValue,
  readLocalState,
  releaseRecordWrite,
  requestCode,
  restoreThroughUi,
  signInThroughUi,
  openSignedOutVerification,
  verifyWithCode,
  writeLocalState
} from "./helpers.mjs";

const SERVER_TIMEOUT = { timeout: 30_000 };
const RECORD_NAV_TIMEOUT = 5_000;
const DRAFT_PROOF_TIMEOUT = 180_000;
const ZERO_HASH = "0".repeat(64);

// Failure output is retained by CI, so treat it as a hostile sink: never let
// credentials, OTPs, account identifiers, or record contents reach it.
function redact(value) {
  return String(value ?? "")
    .replace(/\b\d{6}\b/g, "[code]")
    .replace(/\bAuthorization\s*[:=]?\s*(?:Bearer\s+)?[^\s,;]+/gi, "[token]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "[token]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/[A-Fa-f0-9+/=_-]{32,}/g, "[hex]")
    .slice(0, 200);
}

function assertRedaction() {
  const secret = "123456 Bearer top-secret Authorization: other-secret "
    + "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature user@example.test " + "a".repeat(64);
  const result = redact(secret);
  for (const unsafe of ["123456", "top-secret", "other-secret", "eyJ", "user@example.test", "a".repeat(64)]) {
    if (result.includes(unsafe)) throw new Error("restore diagnostic redaction self-test failed");
  }
}
assertRedaction();

function ownRecords(local) {
  return local.stores.records.filter((record) => !record.importedFromServer)
    .sort((left, right) => left.id - right.id);
}

function localRowDump(local) {
  return local.stores.records
    .sort((left, right) => Number(left.id) - Number(right.id))
    .map((record) => ({
      id: record.id,
      importedFromServer: Boolean(record.importedFromServer),
      device_identity_present: Boolean(record.device_identity),
      hash_prefix: String(record.entry_hash || "").slice(0, 12)
    }));
}

function evidence(local, deviceIdentity) {
  const entries = ledgerEntriesForDevice(deviceIdentity).map((entry) => ({ entry_id: entry.entry_id, hash_prefix: String(entry.entry_hash || "").slice(0, 12) }));
  const events = ledgerIntegrityEventsForDevice(deviceIdentity).map((event) => ({ entry_id: event.entry_id, kind: redact(event.kind), detail: redact(event.detail) }));
  return `device_present=${Boolean(deviceIdentity)}; local_rows=${JSON.stringify(localRowDump(local))}; `
    + `server_entries=${JSON.stringify(entries)}; integrity_events=${JSON.stringify(events)}; `
    + `device_status=${JSON.stringify(deviceStatusForIdentity(deviceIdentity))}`;
}

function stable(value) {
  return JSON.parse(JSON.stringify(value));
}

function settingPresenceSnapshot(settings) {
  const length = (key) => String(settings[key] ?? "").length;
  return {
    auth_token: { present: Boolean(settings.auth_token), length: length("auth_token") },
    session_generation: { present: settings.session_generation != null, length: length("session_generation") },
    bound_account: { present: Boolean(settings.bound_account), length: length("bound_account") },
    sync_api_base_url: { present: Boolean(settings.sync_api_base_url), length: length("sync_api_base_url") },
    signed_out: { present: settings.signed_out != null, value: Boolean(settings.signed_out) },
    wipe_pending: { present: settings.wipe_pending != null, value: Boolean(settings.wipe_pending) },
    device_identity: { present: Boolean(settings.device_identity), length: length("device_identity") }
  };
}

function attachRestoreWireDiagnostics(page, firstDeviceIdentity) {
  const consoleMessages = [];
  const failedRequests = [];
  const responses = [];
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: redact(message.text()) }));
  page.on("pageerror", (error) => consoleMessages.push({ type: "pageerror", text: redact(error.message) }));
  page.on("requestfailed", (request) => failedRequests.push({
    path: new URL(request.url()).pathname, method: request.method(), failure: redact(request.failure()?.errorText || "unknown")
  }));
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (/\/(?:auth\/|records|profile|sync(?:\/|$))/.test(path)) {
      const item = { path, status: response.status(), method: response.request().method() };
      if (path === "/records") {
        if (response.ok()) {
          const body = await response.json().catch(() => null);
          const records = Array.isArray(body?.records) ? body.records : [];
          item.record_count = records.length;
          item.first_device_record_count = records.filter((row) => row.device_identity === firstDeviceIdentity).length;
        } else {
          const body = await response.json().catch(() => null);
          const candidate = body?.error ?? body?.code;
          item.error_code = /^[A-Za-z0-9_-]{1,64}$/.test(String(candidate || "")) ? candidate : "[omitted]";
        }
      }
      responses.push(item);
    }
  });
  return async () => {
    const [local, visible] = await Promise.all([
      readLocalState(page).catch(() => ({ settings: {} })),
      page.evaluate(() => ({
        restore_step: document.querySelector("#restore-code-input")?.offsetParent ? "code_entry"
          : document.querySelector("#restore-modal")?.offsetParent ? "request"
            : document.querySelector("#screen-capture.active") ? "done" : "none",
        code_field_filled: Boolean(document.querySelector("#restore-code-input")?.value),
        alerts: [...document.querySelectorAll("[role=alert]")]
          .filter((element) => !element.hidden && getComputedStyle(element).display !== "none")
          .map((element) => element.textContent?.trim() || "")
      })).catch(() => ({ restore_step: "unavailable", code_field_filled: false, alerts: ["unavailable"] }))
    ]);
    const safeRestoreDiagnostics = await page.evaluate(() => window.__confirmaRestoreDiagnostics || null).catch(() => null);
    const safeValues = (input) => {
      if (input == null || typeof input !== "object") return redact(input);
      if (Array.isArray(input)) return input.map(safeValues);
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [redact(key), safeValues(value)]));
    };
    return {
      console_messages: consoleMessages,
      failed_requests: failedRequests,
      response_log: responses,
      visible_restore_dialog: { ...visible, alerts: visible.alerts.map(redact) },
      settings_presence: settingPresenceSnapshot(local.settings || {}),
      confirma_restore_diagnostics: safeValues(safeRestoreDiagnostics)
    };
  };
}

function earliestRestoreFailure(diagnostics) {
  const responses = diagnostics.response_log || [];
  const statusFor = (path) => responses.find((item) => item.path === path && item.method === "POST")?.status;
  for (const [label, path] of [["code request", "/auth/otp/request"], ["code verify", "/auth/otp/verify"]]) {
    const status = statusFor(path);
    if (status == null || status < 200 || status >= 300) return `${label}: ${status == null ? "not observed" : `status ${status}`}`;
  }
  const settings = diagnostics.settings_presence || {};
  if (!settings.auth_token?.present || settings.signed_out?.value) return "session established: auth token absent or signed out";
  const profile = responses.find((item) => item.path === "/profile");
  if (!profile || profile.status < 200 || profile.status >= 300) return `profile handling: ${profile ? `status ${profile.status}` : "not observed"}`;
  const records = responses.find((item) => item.path === "/records" && item.method === "GET");
  if (!records) return "GET /records: not requested";
  return "GET /records: requested";
}

function importedOwnCopy(record, id) {
  return { ...stable(record), id, server_entry_id: record.id, importedFromServer: true };
}

function collision(record, id, hash = "f".repeat(64)) {
  return { ...stable(record), id, entry_hash: hash, prev_entry_hash: "e".repeat(64), importedFromServer: false };
}

async function createSyncedChain(page, label, amounts = [6501, 6502]) {
  await signInThroughUi(page, nextAccount(label));
  const deviceIdentity = (await readLocalState(page)).settings.device_identity;
  for (const amount of amounts) await confirmRecord(page, amount, { waitForSync: true });
  await waitForSyncedRecords(page, deviceIdentity, amounts.length);
  return { deviceIdentity, originals: ownRecords(await readLocalState(page)) };
}

function heldDrafts(local) {
  return local.settings.held_drafts || [];
}

async function verifyOwnRows(page, local) {
  return page.evaluate(async ({ rows, publicKey }) => {
    const toBytes = (base64) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const key = await crypto.subtle.importKey("jwk", JSON.parse(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return Promise.all(rows.map(async (row) => {
      const canonical = [row.id, row.transaction_type, row.normalized_label, row.amount_minor, row.currency,
        row.counterparty, row.business_type_id, row.country, row.source_account, row.destination_account,
        row.reversed_entry_hash, row.reversed_transaction_type, row.confirmed_at, row.prev_entry_hash]
        .map((value) => value == null ? "" : String(value)).join("|");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const signatureValid = await crypto.subtle.verify({ name: "ECDSA", hash: { name: "SHA-256" } }, key,
        toBytes(row.signature), new TextEncoder().encode(row.entry_hash));
      return { hash, stored: row.entry_hash, signatureValid };
    }));
  }, { rows: ownRecords(local), publicKey: local.settings.device_public_key });
}

async function confirmRecord(page, amount, { waitForSync = false, expectPaused = false, expectSaveFailure = false } = {}) {
  const captureScreen = page.locator("#screen-capture.active");
  if (!(await captureScreen.isVisible())) {
    const recordNavigation = page.locator("#nav-record-v2");
    await expect(recordNavigation, "cannot record: capture is inactive and Record navigation is unavailable")
      .toBeVisible({ timeout: RECORD_NAV_TIMEOUT });
    await recordNavigation.click({ timeout: RECORD_NAV_TIMEOUT });
    await expect(captureScreen, "Record navigation did not return to the capture screen")
      .toBeVisible({ timeout: RECORD_NAV_TIMEOUT });
  }
  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill(String(amount));
  await page.locator("#prepare-confirmation").click();
  await expect(page.locator("#confirm-append")).toBeEnabled();
  const syncResponse = waitForSync
    ? page.waitForResponse((response) => response.url().includes("/sync/entries") && response.request().method() === "POST", SERVER_TIMEOUT)
    : null;
  if (expectSaveFailure) page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#confirm-append").click();
  if (expectPaused) {
    await expect(page.locator("#screen-capture.active")).toBeVisible();
    await expect(page.locator("#capture-error")).toContainText("temporarily paused");
    await expect.poll(async () => heldDrafts(await readLocalState(page)).some((draft) => (
      draft.confirmation_state === "held_draft" && draft.amount_minor === amount * 100
    )), SERVER_TIMEOUT).toBe(true);
  } else if (expectSaveFailure) {
    await expect(page.locator("#screen-capture.active")).toBeVisible();
    await expect(page.locator("#capture-error")).toContainText("not saved");
  } else {
    await expect(page.locator("#screen-dashboard.active")).toBeVisible();
  }
  if (syncResponse) await syncResponse;
}

async function waitForSyncedRecords(page, deviceIdentity, count) {
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length, SERVER_TIMEOUT).toBe(0);
  await expect.poll(() => ledgerEntriesForDevice(deviceIdentity).length, SERVER_TIMEOUT).toBe(count);
}

async function waitForStableLocalRows(page) {
  let prior = null;
  await expect.poll(async () => {
    const rows = localRowDump(await readLocalState(page));
    const snapshot = JSON.stringify(rows);
    const stable = snapshot === prior;
    prior = snapshot;
    return stable ? snapshot : "changing";
  }, SERVER_TIMEOUT).not.toBe("changing");
}

async function waitForImportedRecords(page, sourceDeviceIdentity, count) {
  try {
    await expect.poll(async () => (await readLocalState(page)).stores.records
      .filter((record) => record.importedFromServer), SERVER_TIMEOUT).toHaveLength(count);
  } catch (error) {
    const local = await readLocalState(page);
    throw new Error(`${redact(error.message)}\nrestore import failed: ${evidence(local, sourceDeviceIdentity)}`);
  }
}

async function reloadThroughStartupRestore(page) {
  const recordsResponse = page.waitForResponse((response) => (
    response.url().includes("/records") && response.request().method() === "GET"
  ), SERVER_TIMEOUT);
  await page.reload();
  const response = await recordsResponse;
  expect(response.status(), "startup restore GET /records failed").toBe(200);
  await waitForStableLocalRows(page);
}

function expectUnchangedOriginals(before, after, message) {
  const originalIds = new Set(before.map((record) => record.id));
  expect(after.filter((record) => originalIds.has(record.id)).sort((left, right) => left.id - right.id)
    .map(({ id, entry_hash, signature }) => ({ id, entry_hash, signature })), message)
    .toEqual(before.map(({ id, entry_hash, signature }) => ({ id, entry_hash, signature })));
}

function expectOneContinuousServerChain(deviceIdentity, count, message) {
  const entries = ledgerEntriesForDevice(deviceIdentity);
  expect(entries.length, message).toBe(count);
  entries.forEach((entry, index) => {
    const entryEvidence = `entry_id=${entry.entry_id}; hash_prefix=${String(entry.entry_hash || "").slice(0, 12)}; prev_hash_prefix=${String(entry.prev_entry_hash || "").slice(0, 12)}`;
    expect(Number(entry.entry_id), `${message}; ${entryEvidence}`).toBe(index + 1);
    expect(entry.prev_entry_hash, `${message}; ${entryEvidence}`)
      .toBe(index === 0 ? ZERO_HASH : entries[index - 1].entry_hash);
  });
}

async function openFreshRestorePage(browser, testInfo) {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto("/");
  await writeLocalState(page, { sync_api_base_url: APP_API_URL });
  await page.reload();
  return { context, page };
}

test("restore chain R1: startup reload keeps its signed chain before recording again", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("restore-chain-same-device"));
  const deviceIdentity = (await readLocalState(page)).settings.device_identity;

  await confirmRecord(page, 6101, { waitForSync: true });
  await confirmRecord(page, 6102, { waitForSync: true });
  await waitForSyncedRecords(page, deviceIdentity, 2);
  const originals = ownRecords(await readLocalState(page));

  await reloadThroughStartupRestore(page);

  // Wait for the normal sync request before asserting. On the suspected build
  // it is the request that records fork_id_conflict, rather than just a local
  // id-reset observation.
  await confirmRecord(page, 6103, { waitForSync: true });
  const after = await readLocalState(page);
  const own = ownRecords(after);
  const diagnostic = evidence(after, deviceIdentity);
  expect(own.at(-1)?.id, `next own id must continue this device chain: ${diagnostic}`).toBe(3);
  expect(own.at(-1)?.prev_entry_hash, `next own record must point to this device head: ${diagnostic}`).toBe(originals.at(-1)?.entry_hash);
  expectUnchangedOriginals(originals, after.stores.records, `startup reload rewrote original records: ${diagnostic}`);
  expectOneContinuousServerChain(deviceIdentity, 3, diagnostic);
  expect(ledgerIntegrityEventsForDevice(deviceIdentity), diagnostic).toEqual([]);
  expect(deviceStatusForIdentity(deviceIdentity)?.status, diagnostic).toBe("ACTIVE");
});

test("restore chain R2: repeated startup reloads keep the device chain before recording", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("restore-chain-twice"));
  const deviceIdentity = (await readLocalState(page)).settings.device_identity;
  await confirmRecord(page, 6201, { waitForSync: true });
  await confirmRecord(page, 6202, { waitForSync: true });
  await waitForSyncedRecords(page, deviceIdentity, 2);
  const originals = ownRecords(await readLocalState(page));
  const restoredStates = [];

  for (let reloadNumber = 1; reloadNumber <= 2; reloadNumber += 1) {
    await reloadThroughStartupRestore(page);
    restoredStates.push(await readLocalState(page));
  }

  await confirmRecord(page, 6203, { waitForSync: true });
  await waitForSyncedRecords(page, deviceIdentity, 3);
  // Variant: a further ordinary app open after record three has reached the
  // server must not retrospectively alter the completed chain either.
  await reloadThroughStartupRestore(page);
  const after = await readLocalState(page);
  const own = ownRecords(after);
  const diagnostic = evidence(after, deviceIdentity);
  expect(own.some((record) => record.id === 3), `reloads must not reset the next own id: ${diagnostic}`).toBe(true);
  expect(own.find((record) => record.id === 3)?.prev_entry_hash, `reloads must retain the prior own hash: ${diagnostic}`).toBe(originals.at(-1)?.entry_hash);
  restoredStates.forEach((restored, index) => {
    expectUnchangedOriginals(originals, restored.stores.records,
      `reload ${index + 1} rewrote original records: ${diagnostic}`);
  });
  expectUnchangedOriginals(originals, after.stores.records, `post-record reload rewrote original records: ${diagnostic}`);
  expectOneContinuousServerChain(deviceIdentity, 3, diagnostic);
  expect(ledgerIntegrityEventsForDevice(deviceIdentity), diagnostic).toEqual([]);
  expect(deviceStatusForIdentity(deviceIdentity)?.status, diagnostic).toBe("ACTIVE");
});

test("restore chain R3: a genuinely new device imports history without joining the old device chain", async ({ page, browser }, testInfo) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("restore-chain-new-device"));
  const firstDevice = (await readLocalState(page)).settings.device_identity;
  await confirmRecord(page, 6301);
  await confirmRecord(page, 6302);
  await waitForSyncedRecords(page, firstDevice, 2);
  const firstEntries = ledgerEntriesForDevice(firstDevice);

  const { context, page: second } = await openFreshRestorePage(browser, testInfo);
  try {
    await restoreThroughUi(second, account);
    await expect(second.locator("#screen-capture.active")).toBeVisible(SERVER_TIMEOUT);
    const restored = await readLocalState(second);
    const secondDevice = restored.settings.device_identity;
    const imported = restored.stores.records.filter((record) => record.importedFromServer);
    expect(secondDevice).not.toBe(firstDevice);
    expect(imported.length, `new-device restore did not retain imported rows: ${JSON.stringify(localRowDump(restored))}`).toBe(2);
    expect(imported.every((record) => record.device_identity === firstDevice), JSON.stringify(localRowDump(restored))).toBe(true);

    await confirmRecord(second, 6303);
    await waitForSyncedRecords(second, secondDevice, 1);
    const after = await readLocalState(second);
    const own = ownRecords(after);
    const secondDiagnostic = evidence(after, secondDevice);
    expect(own).toHaveLength(1);
    expect(own[0].id, secondDiagnostic).toBe(1);
    expect(own[0].prev_entry_hash, secondDiagnostic).toBe(ZERO_HASH);
    expectOneContinuousServerChain(secondDevice, 1, secondDiagnostic);
    expect(ledgerEntriesForDevice(firstDevice), `first-device entries changed: ${secondDiagnostic}`).toEqual(firstEntries);
    expect(ledgerIntegrityEventsForDevice(firstDevice), `first device: ${secondDiagnostic}`).toEqual([]);
    expect(ledgerIntegrityEventsForDevice(secondDevice), secondDiagnostic).toEqual([]);
    expect(deviceStatusForIdentity(firstDevice)?.status, `first device: ${secondDiagnostic}`).toBe("ACTIVE");
    expect(deviceStatusForIdentity(secondDevice)?.status, secondDiagnostic).toBe("ACTIVE");
  } finally {
    await context.close();
  }
});

test("restore chain R3b: a new device imports history after the first device has reloaded", async ({ page, browser }, testInfo) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("restore-chain-new-device-after-reload"));
  const firstDevice = (await readLocalState(page)).settings.device_identity;
  await confirmRecord(page, 6351, { waitForSync: true });
  await confirmRecord(page, 6352, { waitForSync: true });
  await waitForSyncedRecords(page, firstDevice, 2);
  const firstEntries = ledgerEntriesForDevice(firstDevice);
  await reloadThroughStartupRestore(page);

  const { context, page: second } = await openFreshRestorePage(browser, testInfo);
  try {
    await restoreThroughUi(second, account);
    await expect(second.locator("#screen-capture.active")).toBeVisible(SERVER_TIMEOUT);
    const restored = await readLocalState(second);
    const secondDevice = restored.settings.device_identity;
    const imported = restored.stores.records.filter((record) => record.importedFromServer);
    expect(secondDevice).not.toBe(firstDevice);
    expect(imported.length, `new-device restore did not retain imported rows: ${JSON.stringify(localRowDump(restored))}`).toBe(2);
    expect(imported.every((record) => record.device_identity === firstDevice), JSON.stringify(localRowDump(restored))).toBe(true);

    await confirmRecord(second, 6353, { waitForSync: true });
    await waitForSyncedRecords(second, secondDevice, 1);
    const after = await readLocalState(second);
    const own = ownRecords(after);
    const diagnostic = evidence(after, secondDevice);
    expect(own).toHaveLength(1);
    expect(own[0].id, diagnostic).toBe(1);
    expect(own[0].prev_entry_hash, diagnostic).toBe(ZERO_HASH);
    expectOneContinuousServerChain(secondDevice, 1, diagnostic);
    expect(ledgerEntriesForDevice(firstDevice), `first-device entries changed: ${diagnostic}`).toEqual(firstEntries);
    expect(ledgerIntegrityEventsForDevice(firstDevice), `first device: ${diagnostic}`).toEqual([]);
    expect(ledgerIntegrityEventsForDevice(secondDevice), diagnostic).toEqual([]);
    expect(deviceStatusForIdentity(firstDevice)?.status, `first device: ${diagnostic}`).toBe("ACTIVE");
    expect(deviceStatusForIdentity(secondDevice)?.status, diagnostic).toBe("ACTIVE");
  } finally {
    await context.close();
  }
});

test("restore chain R4 diagnostic: dump local rows after startup reload", async ({ page }) => {
  await signInThroughUi(page, nextAccount("restore-chain-dump"));
  await confirmRecord(page, 6401, { waitForSync: true });
  const deviceIdentity = (await readLocalState(page)).settings.device_identity;
  await waitForSyncedRecords(page, deviceIdentity, 1);
  await reloadThroughStartupRestore(page);
  const local = await readLocalState(page);
  const next = await nextLedgerAppendInput(page);
  // Intentionally logged even on a passing run: the test report and failure
  // output must show whether the merge replaced a local row with an import.
  console.log(`restore-chain local row dump: ${JSON.stringify({ rows: localRowDump(local), next_record: next })}`);
});

test("restore chain R5/R11: an old imported copy is repaired as the original signed own row", async ({ page }) => {
  test.slow();
  const { deviceIdentity, originals } = await createSyncedChain(page, "restore-chain-repair");
  const beforeQueue = stable((await readLocalState(page)).stores.syncQueue);
  await clearStore(page, "records");
  for (const [index, record] of originals.entries()) await putStoreValue(page, "records", importedOwnCopy(record, 80_000 + index));

  await reloadThroughStartupRestore(page);
  const local = await readLocalState(page);
  const repaired = ownRecords(local);
  expect(repaired.map((row) => row.id)).toEqual(originals.map((row) => row.id));
  expect(repaired.every((row) => row.restoredOwn === true && row.importedFromServer === false)).toBe(true);
  expect(repaired.map(({ entry_hash, signature }) => ({ entry_hash, signature }))).toEqual(originals.map(({ entry_hash, signature }) => ({ entry_hash, signature })));
  expect(await verifyOwnRows(page, local)).toEqual(repaired.map((row) => ({ hash: row.entry_hash, stored: row.entry_hash, signatureValid: true })));
  expect(local.stores.syncQueue).toEqual(beforeQueue);
  expect(local.settings.fork_recovery_pending).toBeUndefined();
  await confirmRecord(page, 6503, { waitForSync: true });
  expect(ownRecords(await readLocalState(page)).at(-1).id).toBe(3);
  expect(ledgerIntegrityEventsForDevice(deviceIdentity)).toEqual([]);
  expect(deviceStatusForIdentity(deviceIdentity)?.status).toBe("ACTIVE");
});

test("restore chain P2: earlier-dated other-device imports receive fresh local ids and remain idempotent", async ({ page }) => {
  test.slow();
  const { originals } = await createSyncedChain(page, "restore-chain-import-id-allocation", [6511]);
  const originalOwn = stable(ownRecords(await readLocalState(page)));
  const originalQueue = stable((await readLocalState(page)).stores.syncQueue);
  const otherDeviceIdentity = "other-device-import-id-allocation";
  const otherRows = [
    { entry_id: 901, entry_hash: "a".repeat(64), confirmed_at: 200, label: "other-later" },
    { entry_id: 902, entry_hash: "b".repeat(64), confirmed_at: 100, label: "other-earlier" }
  ];
  const syntheticRow = (row) => ({
    device_identity: otherDeviceIdentity,
    transaction_type: "sale",
    normalized_label: row.label,
    amount_minor: 100,
    currency: "NGN",
    prev_entry_hash: ZERO_HASH,
    signature: null,
    ...row
  });
  let responseRows = [otherRows[0]];
  await page.route("**/records", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.records = [...responseRows.map(syntheticRow), ...(body.records || [])];
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  try {
    await reloadThroughStartupRestore(page);
    const first = await readLocalState(page);
    const firstImports = first.stores.records.filter((record) => record.importedFromServer && record.device_identity === otherDeviceIdentity);
    expect(firstImports).toHaveLength(1);
    expect(ownRecords(first)).toEqual(originalOwn);
    expect(first.stores.syncQueue).toEqual(originalQueue);

    // The second transport response is server-time ordered, so the newly
    // received record appears before the retained imported display copy.
    responseRows = [otherRows[1], otherRows[0]];
    await reloadThroughStartupRestore(page);
    const second = await readLocalState(page);
    const secondImports = second.stores.records.filter((record) => record.importedFromServer && record.device_identity === otherDeviceIdentity);
    expect(secondImports).toHaveLength(2);
    expect(new Set(secondImports.map((record) => record.id)).size).toBe(2);
    expect(secondImports.map((record) => record.entry_hash).sort()).toEqual(otherRows.map((row) => row.entry_hash).sort());
    expect(ownRecords(second)).toEqual(originalOwn);
    expect(second.stores.syncQueue).toEqual(originalQueue);

    const beforeRepeat = stable(second.stores.records);
    await reloadThroughStartupRestore(page);
    const repeated = await readLocalState(page);
    expect(repeated.stores.records).toEqual(beforeRepeat);
    expect(repeated.stores.syncQueue).toEqual(originalQueue);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("restore chain P2: invalid own signatures defer imported-copy repair", async ({ page }) => {
  test.slow();
  const { originals } = await createSyncedChain(page, "restore-chain-invalid-signatures", [6521]);
  const original = originals[0];
  const differentKeySignature = await page.evaluate(async (entryHash) => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: { name: "SHA-256" } }, keyPair.privateKey, new TextEncoder().encode(entryHash));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }, original.entry_hash);
  const invalidSignatures = [
    ["garbage", "not-a-valid-signature"],
    ["different-key", differentKeySignature],
    ["truncated-base64", original.signature.slice(0, -1)]
  ];

  for (const [variant, signature] of invalidSignatures) {
    await clearStore(page, "records");
    await clearStore(page, "syncQueue");
    await putStoreValue(page, "records", importedOwnCopy(original, 84_000));
    const before = stable(await readLocalState(page));
    await page.route("**/records", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const own = body.records?.find((row) => row.device_identity === original.device_identity && Number(row.entry_id) === Number(original.id));
      if (own) own.signature = signature;
      await route.fulfill({ response, body: JSON.stringify(body) });
    });
    try {
      await reloadThroughStartupRestore(page);
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
    const after = await readLocalState(page);
    expect(after.stores.records, `${variant} signature changed records`).toEqual(before.stores.records);
    expect(after.stores.syncQueue, `${variant} signature changed queue`).toEqual(before.stores.syncQueue);
    expect(after.stores.records.some((record) => record.importedFromServer && record.entry_hash === original.entry_hash), `${variant} signature must retain imported copy`).toBe(true);
    expect(after.settings.fork_recovery_pending?.cases, `${variant} signature must defer recovery`).toEqual(expect.arrayContaining([
      expect.objectContaining({ entry_id: original.id, entry_hash: original.entry_hash, reason: "hash_or_signature_unverified" })
    ]));
  }
});

test("restore chain R6/R6b: every repair collision is deferred without changing ledger or queue bytes", async ({ page }) => {
  test.slow();
  const { originals } = await createSyncedChain(page, "restore-chain-collisions", [6601]);
  const original = originals[0];
  await clearStore(page, "records");
  const copy = importedOwnCopy(original, 81_000);
  const conflicting = collision(original, original.id);
  await putStoreValue(page, "records", copy);
  await putStoreValue(page, "records", conflicting);
  const queued = { entry_id: original.id, entry_hash: "d".repeat(64), status: "queued", entry_payload: collision(original, original.id, "d".repeat(64)) };
  await putStoreValue(page, "syncQueue", queued);
  const before = stable(await readLocalState(page));
  await reloadThroughStartupRestore(page);
  const after = await readLocalState(page);
  expect(after.stores.records).toEqual(before.stores.records);
  expect(after.stores.syncQueue).toEqual(before.stores.syncQueue);
  expect(after.settings.fork_recovery_pending.cases).toEqual(expect.arrayContaining([
    expect.objectContaining({ entry_id: original.id, entry_hash: original.entry_hash })
  ]));

  // Missing-own, hash-under-another-id, and queue-only collisions use the same
  // fail-closed transaction; preserve a byte-for-byte snapshot for each.
  for (const variant of ["missing", "hash", "queue", "verification", "signature-missing"]) {
    await clearStore(page, "records");
    await clearStore(page, "syncQueue");
    if (variant === "missing") await putStoreValue(page, "records", collision(original, original.id));
    if (variant === "hash") await putStoreValue(page, "records", collision(original, 91_000, original.entry_hash));
    if (variant === "queue") await putStoreValue(page, "syncQueue", { ...queued, entry_hash: "c".repeat(64) });
    if (variant === "verification") await putStoreValue(page, "records", importedOwnCopy(original, 82_000));
    if (variant === "signature-missing") await putStoreValue(page, "records", importedOwnCopy(original, 83_000));
    if (variant === "verification" || variant === "signature-missing") {
      await page.route("**/records", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const own = body.records?.find((row) => row.device_identity === originals[0].device_identity);
        if (own && variant === "verification") own.entry_hash = "a".repeat(64);
        if (own && variant === "signature-missing") own.signature = null;
        await route.fulfill({ response, body: JSON.stringify(body) });
      });
    }
    const snapshot = stable(await readLocalState(page));
    await reloadThroughStartupRestore(page);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    const result = await readLocalState(page);
    expect(result.stores.records, `${variant} collision changed records`).toEqual(snapshot.stores.records);
    expect(result.stores.syncQueue, `${variant} collision changed queue`).toEqual(snapshot.stores.syncQueue);
    expect(result.settings.fork_recovery_pending?.cases, `${variant} must retain the recovery evidence`).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: variant === "verification" || variant === "signature-missing" ? "hash_or_signature_unverified" : "collision" })
    ]));
  }
});

test("restore chain R7: pending queue is preserved byte-for-byte across reload before sync resumes", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("restore-chain-pending"));
  const firstIdentity = (await readLocalState(page)).settings.device_identity;
  let releaseSyncRequest;
  let syncRequestHeld;
  const syncHeld = new Promise((resolve) => { syncRequestHeld = resolve; });
  const syncReleased = new Promise((resolve) => { releaseSyncRequest = resolve; });
  const heldSyncHandlers = [];
  await page.route("**/sync/entries", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const heldSyncHandler = (async () => {
      syncRequestHeld();
      await syncReleased;
      await route.continue();
    })();
    heldSyncHandlers.push(heldSyncHandler);
    await heldSyncHandler;
  });
  await confirmRecord(page, 6701);
  await syncHeld;
  const pending = stable(await readLocalState(page));
  await reloadThroughStartupRestore(page);
  expect((await readLocalState(page)).stores.syncQueue).toEqual(pending.stores.syncQueue);
  releaseSyncRequest();
  await Promise.all(heldSyncHandlers);
  await page.unroute("**/sync/entries");
  await waitForSyncedRecords(page, firstIdentity, 1);
});

test("restore chain R8-R10: accepted first-device records restore once and never become heads", async ({ page, browser }, testInfo) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("restore-chain-cross-device"));
  const firstIdentity = (await readLocalState(page)).settings.device_identity;
  await confirmRecord(page, 6701, { waitForSync: true });
  // Do not open the restoring device until both independently observable
  // acceptance conditions hold: no local work remains and exactly one ledger row exists.
  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length, SERVER_TIMEOUT).toBe(0);
  await expect.poll(() => ledgerEntriesForDevice(firstIdentity).length, SERVER_TIMEOUT).toBe(1);
  const accepted = ledgerEntriesForDevice(firstIdentity);
  expect(accepted, "first device must have one server-accepted row before restore").toHaveLength(1);
  const { context, page: second } = await openFreshRestorePage(browser, testInfo);
  try {
    const restoreWireDiagnostics = attachRestoreWireDiagnostics(second, firstIdentity);
    // Register before the UI action: if /records is absent or defective this
    // test must fail with its wire evidence instead of polling it away.
    const restoreStartedAt = Date.now();
    let restoreClickAt = null;
    let recordsResponseAt = null;
    // Arm the wait only at the Restore click: code request and OTP pacing come
    // first and may legitimately take longer than the response window.
    let recordsResponse = null;
    let response;
    try {
      await restoreThroughUi(second, account, { onRestoreClick: () => {
        restoreClickAt = Date.now();
        recordsResponse = second.waitForResponse((candidate) => (
          candidate.url().includes("/records") && candidate.request().method() === "GET"
        ), SERVER_TIMEOUT).then((candidate) => { recordsResponseAt = Date.now(); return candidate; });
        recordsResponse.catch(() => {});
      } });
      response = await recordsResponse;
    } catch (error) {
      const diagnostics = await restoreWireDiagnostics();
      throw new Error(`${redact(error.message)}\nrestore wire failure: earliest=${earliestRestoreFailure(diagnostics)}; safe_evidence=${JSON.stringify(diagnostics)}`);
    }
    const responseBody = await response.json().catch(() => null);
    const responseRecords = Array.isArray(responseBody?.records) ? responseBody.records : [];
    const responseSummary = {
      status: response.status(), count: responseRecords.length,
      first_device_record_count: responseRecords.filter((row) => row.device_identity === firstIdentity).length
    };
    const serverBeforeImport = ledgerEntriesForDevice(firstIdentity);
    const expected = accepted[0];
    const firstDeviceResponseRows = responseRecords.filter((row) => row.device_identity === firstIdentity);
    const safeDiagnostics = await restoreWireDiagnostics();
    expect(response.status(), `restore /records did not return 200: ${JSON.stringify(responseSummary)}; diagnostics=${JSON.stringify(safeDiagnostics)}`).toBe(200);
    expect(firstDeviceResponseRows.length === 1 && Number(firstDeviceResponseRows[0]?.entry_id) === Number(expected.entry_id)
      && firstDeviceResponseRows[0]?.entry_hash === expected.entry_hash && firstDeviceResponseRows[0]?.device_identity === firstIdentity,
    `restore /records did not contain exactly the accepted first-device row: ${JSON.stringify(responseSummary)}; diagnostics=${JSON.stringify(safeDiagnostics)}`).toBe(true);
    expect(serverBeforeImport.some((entry) => Number(entry.entry_id) === Number(expected.entry_id) && entry.entry_hash === expected.entry_hash),
      `server acceptance changed before import: response=${JSON.stringify(responseSummary)}; diagnostics=${JSON.stringify(safeDiagnostics)}`).toBe(true);
    const immediateRows = (await readLocalState(second)).stores.records;
    const immediateReadSawImport = immediateRows.some((record) => record.importedFromServer
      && record.device_identity === firstIdentity && Number(record.server_entry_id) === Number(expected.entry_id));
    let importAppearedAt = null;
    try {
      await expect.poll(async () => {
        const row = (await readLocalState(second)).stores.records.find((record) => record.importedFromServer
          && record.device_identity === firstIdentity && Number(record.server_entry_id) === Number(expected.entry_id));
        if (row && !importAppearedAt) importAppearedAt = Date.now();
        return Boolean(row && Number(row.server_entry_id) === Number(expected.entry_id) && row.entry_hash === expected.entry_hash);
      }, SERVER_TIMEOUT).toBe(true);
    } catch (error) {
      const local = await readLocalState(second);
      throw new Error(`${redact(error.message)}\nimport timing failure: response=${JSON.stringify(responseSummary)}; `
        + `server_entry_count=${serverBeforeImport.length}; local_rows=${JSON.stringify(localRowDump(local))}; `
        + `diagnostics=${JSON.stringify(await restoreWireDiagnostics())}`);
    }
    const timing = {
      restore_started_at: restoreStartedAt,
      restore_click_at: restoreClickAt,
      records_response_at: recordsResponseAt,
      local_import_first_appeared_at: importAppearedAt,
      immediate_read_would_have_seen_import: immediateReadSawImport
    };
    console.log(`restore-chain R8-R10 timing evidence: ${JSON.stringify(timing)}`);
    await waitForImportedRecords(second, firstIdentity, 1);
    const restored = await readLocalState(second);
    const imports = restored.stores.records.filter((row) => row.importedFromServer);
    expect(imports, `pending-row restore did not import exactly once: ${evidence(restored, firstIdentity)}`).toHaveLength(1);
    expect((await nextLedgerAppendInput(second)).id).toBe(1);
    await confirmRecord(second, 6702, { waitForSync: true });
    for (let index = 0; index < 3; index += 1) await reloadThroughStartupRestore(second);
    const secondIdentity = (await readLocalState(second)).settings.device_identity;
    expect(ledgerEntriesForDevice(firstIdentity)).toHaveLength(1);
    expect(ledgerEntriesForDevice(secondIdentity)).toHaveLength(1);
  } finally { await context.close(); }
});

test("restore chain R12-R14 and held-draft retention: unsafe confirmation writes only account-bound drafts", async ({ page }) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("restore-chain-held"));
  const identity = (await readLocalState(page)).settings.device_identity;
  await writeLocalState(page, { fork_recovery_pending: { cases: [{ source: "test" }] } });
  const before = await readLocalState(page);
  await confirmRecord(page, 6801, { expectPaused: true });
  const held = await readLocalState(page);
  expect(held.stores.records).toEqual(before.stores.records);
  expect(held.stores.syncQueue).toEqual(before.stores.syncQueue);
  expect(heldDrafts(held)).toHaveLength(1);
  expect(heldDrafts(held)[0]).toMatchObject({ amount_minor: 6801 * 100, confirmation_state: "held_draft", bound_account: account.accountId });
  expect(heldDrafts(held)[0]).toHaveProperty("confirmation_attempted_at");
  for (const forbidden of ["id", "entry_hash", "signature", "confirmed_at"]) expect(heldDrafts(held)[0]).not.toHaveProperty(forbidden);
  await expect(page.locator("#capture-error")).toContainText("temporarily paused");
  expect(ledgerEntriesForDevice(identity)).toEqual([]);
  // A full pre-existing collection must remain intact: no slice(-50) loss.
  const drafts = Array.from({ length: 59 }, (_, index) => ({ confirmation_state: "held_draft", bound_account: account.accountId, ordinal: index }));
  await writeLocalState(page, { held_drafts: drafts });
  await confirmRecord(page, 6802, { expectPaused: true });
  expect(heldDrafts(await readLocalState(page))).toHaveLength(60);
});

test("restore chain draft proof: sixty drafts survive reload and same-account return in order", async ({ page }) => {
  test.slow();
  test.setTimeout(DRAFT_PROOF_TIMEOUT);
  const account = await signInThroughUi(page, nextAccount("restore-chain-sixty-drafts"));
  const seeded = Array.from({ length: 59 }, (_, ordinal) => ({
    confirmation_state: "held_draft", bound_account: account.accountId, ordinal,
    label: `seed-${ordinal}`, amount_minor: 70_000 + ordinal, confirmation_attempted_at: 1_000 + ordinal
  }));
  await writeLocalState(page, { fork_recovery_pending: { cases: [{ source: "test" }] }, held_drafts: seeded });
  await confirmRecord(page, 7100, { expectPaused: true });
  const expected = stable(heldDrafts(await readLocalState(page)));
  expect(expected).toHaveLength(60);
  await page.reload();
  expect(heldDrafts(await readLocalState(page))).toEqual(expected);
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-logout-v2").click();
  await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  expect(heldDrafts(await readLocalState(page))).toEqual(expected);
  await openSignedOutVerification(page, account);
  const code = await requestCode(page);
  await verifyWithCode(page, code);
  // Same-account verification deliberately resumes Settings, the screen from
  // which sign-out began. Assert the signed-in session rather than its route.
  await expect(page.locator("#screen-signed-out.active")).toBeHidden();
  await expect(page.locator("#settings-logout-v2")).toBeVisible();
  const returned = await readLocalState(page);
  expect(returned.settings.bound_account).toBe(account.accountId);
  expect(returned.settings.auth_token).toBeTruthy();
  expect(heldDrafts(returned)).toEqual(expected);
});

test("restore chain draft proof: retries dedupe, while a cleared identical entry is new", async ({ page }) => {
  test.slow();
  test.setTimeout(DRAFT_PROOF_TIMEOUT);
  const account = await signInThroughUi(page, nextAccount("restore-chain-draft-dedupe"));
  await writeLocalState(page, { fork_recovery_pending: { cases: [{ source: "test" }] } });
  await confirmRecord(page, 7201, { expectPaused: true });
  const first = stable(heldDrafts(await readLocalState(page)));
  await page.locator("#prepare-confirmation").click();
  await page.locator("#confirm-append").click();
  await expect.poll(async () => heldDrafts(await readLocalState(page)).length, SERVER_TIMEOUT).toBe(1);
  expect(heldDrafts(await readLocalState(page))[0].draft_attempt_id).toBe(first[0].draft_attempt_id);
  // Clear acknowledges the prior attempt. Entering the exact same fields now
  // creates a deliberately distinct attempt identity.
  await page.locator("#amount-input-v2").fill("");
  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill("7201");
  await page.locator("#prepare-confirmation").click();
  await page.locator("#confirm-append").click();
  await expect.poll(async () => heldDrafts(await readLocalState(page)).length, SERVER_TIMEOUT).toBe(2);
  const drafts = heldDrafts(await readLocalState(page));
  expect(drafts.map((draft) => draft.bound_account)).toEqual([account.accountId, account.accountId]);
  expect(drafts[1].draft_attempt_id).not.toBe(drafts[0].draft_attempt_id);
});

test("restore chain draft proof: failed draft writes never claim success", async ({ page }) => {
  test.slow();
  test.setTimeout(DRAFT_PROOF_TIMEOUT);
  await installIdbFault(page);
  await signInThroughUi(page, nextAccount("restore-chain-draft-fault"));
  await writeLocalState(page, { fork_recovery_pending: { cases: [{ source: "test" }] } });
  for (const mode of ["write-failure", "transaction-abort", "tab-close"]) {
    const fault = { settingKey: "held_drafts", mode };
    await armFault(page, fault);
    await confirmRecord(page, 7301, { expectSaveFailure: true });
    await expect(page.locator("#screen-capture.active")).toBeVisible();
    await expect(page.locator("#capture-error")).toContainText("not saved");
    await expect(page.locator("#capture-error")).not.toContainText("saved as a draft");
    expect((await page.locator("#amount-input-v2").inputValue())).toBe("7301");
    expect(heldDrafts(await readLocalState(page))).toHaveLength(0);
    expect(await page.evaluate(() => window.__signoutTestFault?.fired?.mode)).toBe(mode);
    // confirmRecord leaves the failed attempt on Capture. Reload before the
    // next fault to start from a fresh capture screen; entering confirmation
    // here would hide the bottom navigation needed by the next iteration.
    if (mode !== "tab-close") {
      await page.reload();
      await expect(page.locator("#screen-capture.active")).toBeVisible();
    }
  }
});

test("restore chain R16: held drafts remain locked after sign-out and are counted and wiped as local data", async ({ page }) => {
  test.slow();
  const account = await signInThroughUi(page, nextAccount("restore-chain-draft-lock"));
  await writeLocalState(page, {
    fork_recovery_pending: { cases: [{ source: "test" }] },
    held_drafts: [{ confirmation_state: "held_draft", bound_account: account.accountId, amount_minor: 6811, confirmation_attempted_at: Date.now() }]
  });
  await page.locator("#nav-settings-v2").click();
  await page.locator("#settings-logout-v2").click();
  await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("6811");
  const locked = await readLocalState(page);
  expect(heldDrafts(locked)).toHaveLength(1);
  expect(heldDrafts(locked)[0].bound_account).toBe(account.accountId);
  await page.locator("#signed-out-remove-data").click();
  await expect(page.locator("#remove-local-data-copy")).toContainText("held draft");
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await expect.poll(async () => heldDrafts(await readLocalState(page)).length).toBe(0);
});

test("restore chain R15/R15b: only the server integrity code creates a local pause", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("restore-chain-rejection"));
  const outcomes = [
    [{ status: 409, body: {} }, false],
    [{ status: 409, body: { code: "other_conflict" } }, false],
    [{ status: 400, body: { code: "hash_mismatch" } }, false],
    [{ status: 503, body: {} }, false],
    [{ status: 409, body: { code: "ledger_fork_conflict", integrity_kind: "fork_id_conflict" } }, true]
  ];
  for (const [response, shouldPause] of outcomes) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/sync/entries", (route) => route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) }));
    await confirmRecord(page, 6900 + response.status + (shouldPause ? 1 : 0));
    const queueBeforeMarker = stable((await readLocalState(page)).stores.syncQueue);
    await expect.poll(async () => Boolean((await readLocalState(page)).settings.fork_recovery_pending), SERVER_TIMEOUT).toBe(shouldPause);
    expect((await readLocalState(page)).stores.syncQueue).toEqual(queueBeforeMarker);
    if (shouldPause) break;
  }
  const paused = await readLocalState(page);
  expect(paused.settings.fork_recovery_pending.cases.at(-1)).toMatchObject({ source: "sync_rejection", integrity_kind: "fork_id_conflict" });
});

test("restore chain R17: a concurrent marker change turns an in-flight save into a held draft", async ({ page, context }) => {
  test.slow();
  await installIdbFault(page);
  await signInThroughUi(page, nextAccount("restore-chain-atomic"));
  const second = await context.newPage();
  try {
    await second.goto("/");
    await armRecordWriteHold(page);
    const confirm = confirmRecord(page, 7001, { expectPaused: true });
    await expect.poll(() => page.evaluate(() => window.__signoutTestFault?.recordWriteHeld)).toBe(true);
    await writeLocalState(second, { fork_recovery_pending: { cases: [{ source: "second_tab" }] } });
    await releaseRecordWrite(page);
    await confirm;
    const local = await readLocalState(page);
    expect(ownRecords(local)).toHaveLength(0);
    expect(local.stores.syncQueue).toHaveLength(0);
    expect(heldDrafts(local)).toHaveLength(1);
  } finally { await second.close(); }
});
