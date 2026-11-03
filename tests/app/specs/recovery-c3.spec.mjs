import { webcrypto } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  canonicalJson as clientCanonicalJson,
  buildCompletionManifest,
  buildPlanRequest,
  recoveryPartSha256 as clientPartSha256,
  recoveryResponseAllowsUnlock,
  sha256Canonical
} from "../../../app-v3/recovery-client.js";
import {
  canonicalJson as serverCanonicalJson,
  recoveryPartSha256 as serverPartSha256,
  validateRecoveryManifest
} from "../../../server/src/routes/recovery.js";
import {
  APP_API_URL,
  deviceStatusForIdentity,
  ensureCaptureScreen,
  ledgerEntriesForDevice,
  ledgerIntegrityEventsForDevice,
  nextAccount,
  putStoreValue,
  readLocalState,
  signInThroughUi,
  writeLocalState
} from "./helpers.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const ZERO_HASH = "0".repeat(64);
const SERVER_TIMEOUT = { timeout: 90_000 };

function syntheticRecord(id, overrides = {}) {
  return {
    id,
    transaction_type: "sale",
    normalized_label: `recovery_fixture_${id}`,
    amount_minor: id * 100,
    currency: "NGN",
    counterparty: null,
    business_type_id: "ng_market_trader",
    country: "NG",
    source_account: null,
    destination_account: null,
    reversed_entry_hash: null,
    reversed_transaction_type: null,
    confirmed_at: 1_790_000_000 + id,
    prev_entry_hash: ZERO_HASH,
    entry_hash: String(id).padStart(64, "a").slice(-64),
    signature: "fixture-signature",
    device_identity: "a".repeat(32),
    ...overrides
  };
}

test("I3/I6/R-C: client/server canonical hashes agree and a missing date stays omitted end to end", async () => {
  const missingDate = syntheticRecord(1);
  delete missingDate.confirmed_at;
  const parts = [{ part_no: 0, sha256: "b".repeat(64), records: [missingDate], queue: [] }];
  const classification = {
    accepted: [], R: [], xInvalid: [], unexplained: [],
    xValid: [{ record: missingDate, date_check: "unrepresentable", not_replaceable: true }]
  };
  const plan = {
    items: [{ original: missingDate, replacement: null, date_check: "unrepresentable", not_replaceable: true }]
  };
  const manifest = buildCompletionManifest({
    snapshot: { records: [missingDate], queue: [] }, classification, plan, parts
  });
  const transmitted = JSON.parse(JSON.stringify(manifest));
  const item = transmitted.items[0];

  expect(Object.hasOwn(item, "original_confirmed_at")).toBe(false);
  expect(item.disposition).toBe("unrepresentable");
  expect(item.date_check).toBe("unrepresentable");
  expect(validateRecoveryManifest(transmitted)).toEqual(transmitted);
  expect(await sha256Canonical(manifest)).toBe(await sha256Canonical(transmitted));
  expect(clientCanonicalJson(transmitted)).toBe(serverCanonicalJson(transmitted));

  const payload = { records: [missingDate], queue: [] };
  expect(await clientPartSha256(payload)).toBe(serverPartSha256(payload));
});

test("I6: finite out-of-range dates and exact first replacement bytes are never substituted", async () => {
  const original = syntheticRecord(1, { confirmed_at: 8_000_000_000 });
  const replacement = syntheticRecord(2, {
    confirmed_at: original.confirmed_at,
    prev_entry_hash: "c".repeat(64),
    entry_hash: "d".repeat(64)
  });
  const plan = {
    items: [{ original, replacement, date_check: "after_receipt_bound" }]
  };
  const manifest = buildCompletionManifest({
    snapshot: { records: [original], queue: [] },
    classification: { accepted: [], R: [], xInvalid: [], unexplained: [] },
    plan,
    parts: [{ part_no: 0, sha256: "e".repeat(64) }]
  });
  const request = buildPlanRequest(plan);

  expect(manifest.items[0].original_confirmed_at).toBe(8_000_000_000);
  expect(manifest.items[0].replacement_entry_hash).toBe(replacement.entry_hash);
  expect(request.replacements[0]).toEqual({
    original_entry_hash: original.entry_hash,
    original_local_id: 1,
    original_signed_id: 1,
    planned_entry_id: 2,
    planned_entry_hash: replacement.entry_hash,
    date_check: "after_receipt_bound"
  });
});

test("I10: hold unlocks only for an explicit accounted_for true", () => {
  expect(recoveryResponseAllowsUnlock({ outcome: "not_cleared", accounted_for: true })).toBe(true);
  expect(recoveryResponseAllowsUnlock({ outcome: "not_cleared", accounted_for: false })).toBe(false);
  expect(recoveryResponseAllowsUnlock({ outcome: "not_cleared" })).toBe(false);
  expect(recoveryResponseAllowsUnlock({
    outcome: "not_cleared",
    reasons: ["autoclear_disabled", "device_active_nothing_to_clear"]
  })).toBe(false);
});

test("I2/I11: guarded checkpoints survive reopen, reuse first work bytes and refuse a session race", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-client.js");
    const name = `c3-checkpoint-${crypto.randomUUID()}`;
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("settings", { keyPath: "key" });
        db.createObjectStore("records", { keyPath: "id" });
        db.createObjectStore("syncQueue", { keyPath: "queue_id", autoIncrement: true });
        db.createObjectStore("recoverySnapshots", { keyPath: "recovery_id" });
        db.createObjectStore("recoveryWork", { keyPath: "recovery_id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const txDone = (tx) => new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("aborted"));
      tx.onerror = () => reject(tx.error);
    });
    let db = await open();
    const expires = new Date(Date.now() + 60_000).toISOString();
    let tx = db.transaction("settings", "readwrite");
    for (const [key, value] of Object.entries({
      session_generation: 3,
      wipe_epoch: 4,
      signed_out: false,
      wipe_pending: false,
      bound_account: "account-a",
      auth_token: "token-a",
      auth_token_expires_at: expires
    })) tx.objectStore("settings").put({ key, value });
    await txDone(tx);
    const guard = {
      sessionGeneration: 3,
      wipeEpoch: 4,
      boundAccount: "account-a",
      authToken: "token-a",
      authTokenExpiresAt: expires
    };
    const recoveryId = crypto.randomUUID();
    await recovery.beginRecoveryState(db, {
      recoveryId,
      deviceIdentity: "device-a",
      boundAccount: "account-a",
      reasons: ["fixture"],
      guard
    });
    await recovery.transitionRecoveryState(db, {
      recoveryId, expectedStates: "suspect", nextState: "uploaded", guard,
      patch: { remote_ack: true }
    });
    const original = {
      id: 1, entry_hash: "a".repeat(64), confirmed_at: 1_790_000_001,
      device_identity: "device-a"
    };
    const replacement = {
      ...original, id: 2, entry_hash: "b".repeat(64), prev_entry_hash: "c".repeat(64)
    };
    const plan = {
      recovery_id: recoveryId,
      server_head: { entry_id: 1, entry_hash: "c".repeat(64) },
      items: [{ original, replacement, queueEntry: {
        entry_id: 2, entry_hash: replacement.entry_hash, device_identity: "device-a",
        entry_payload: replacement
      }, date_check: "ok" }],
      r_copies: [],
      replacement_hashes: { [original.entry_hash]: replacement.entry_hash }
    };
    const manifest = {
      parts: [{ part_no: 0, sha256: "d".repeat(64) }], items: [], rejected_entry_hashes: [], own_imported: []
    };
    await recovery.persistRecoveryPlan(db, {
      recoveryId, plan, manifest,
      parts: [{ part_no: 0, sha256: "d".repeat(64) }], guard
    });
    const first = await recovery.readRecoveryWork(db, recoveryId);
    db.close();
    db = await open();
    const reopened = await recovery.readRecoveryWork(db, recoveryId);

    const refusals = [];
    const races = [
      ["signed_out", true, false],
      ["wipe_pending", true, false],
      ["session_generation", 4, 3],
      ["wipe_epoch", 5, 4],
      ["bound_account", "account-b", "account-a"],
      ["auth_token", "token-b", "token-a"],
      ["auth_token_expires_at", new Date(Date.now() - 1_000).toISOString(), expires]
    ];
    for (const [key, racedValue, restoredValue] of races) {
      tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({ key, value: racedValue });
      await txDone(tx);
      try {
        await recovery.transitionRecoveryState(db, {
          recoveryId, expectedStates: "classified", nextState: "rebuilt", guard
        });
      } catch (error) {
        if (error?.name === "RecoveryGuardError") refusals.push(key);
      }
      tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({ key, value: restoredValue });
      await txDone(tx);
    }
    const after = await recovery.readRecoveryState(db);
    db.close();
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = resolve;
    });
    return {
      same: recovery.canonicalJson(first) === recovery.canonicalJson(reopened),
      refusals,
      state: after.state,
      replacementHashSame: first.items[0].replacement.entry_hash === reopened.items[0].replacement.entry_hash
    };
  });

  expect(result).toEqual({
    same: true,
    refusals: [
      "signed_out", "wipe_pending", "session_generation", "wipe_epoch",
      "bound_account", "auth_token", "auth_token_expires_at"
    ],
    state: "classified",
    replacementHashSame: true
  });
});

test("I7: verification requires one contiguous device chain ending at the planned head", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { verifyServerChain } = await import("/app/recovery-client.js");
    const rows = [
      { entry_id: 1, entry_hash: "a".repeat(64), prev_entry_hash: "0".repeat(64), device_identity: "device-a" },
      { entry_id: 2, entry_hash: "b".repeat(64), prev_entry_hash: "a".repeat(64), device_identity: "device-a" }
    ];
    return {
      valid: verifyServerChain({ records: rows, deviceIdentity: "device-a", expectedHead: {
        entry_id: 2, entry_hash: "b".repeat(64)
      } }),
      gap: verifyServerChain({ records: [{ ...rows[1], entry_id: 3 }], deviceIdentity: "device-a", expectedHead: {
        entry_id: 3, entry_hash: "b".repeat(64)
      } }),
      moved: verifyServerChain({ records: rows, deviceIdentity: "device-a", expectedHead: {
        entry_id: 1, entry_hash: "a".repeat(64)
      } })
    };
  });
  expect(result).toEqual({ valid: true, gap: false, moved: false });
});

test("blocked v5 to v6 upgrade asks for other Konfirmata tabs to close and then retries", async ({ page, context }) => {
  await page.goto("/app/styles.css");
  await page.evaluate(async () => {
    const request = indexedDB.open("confirma-v3-db", 5);
    window.__blockedDb = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("settings", { keyPath: "key" });
        db.createObjectStore("records", { keyPath: "id" });
        db.createObjectStore("customLabels", { keyPath: "id" });
        db.createObjectStore("usage", { keyPath: "normalized_label" });
        db.createObjectStore("syncQueue", { keyPath: "queue_id", autoIncrement: true });
        db.createObjectStore("voiceCorrections", { keyPath: "raw" });
        db.createObjectStore("anomaly_log", { keyPath: "id", autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });
  const target = await context.newPage();
  try {
    await target.goto("/");
    await expect(target.locator("#recovery-hold-banner")).toHaveText(
      "Close other Konfirmata tabs so this update can finish. We'll retry automatically."
    );
    await page.evaluate(() => window.__blockedDb.close());
    await expect.poll(() => target.evaluate(async () => {
      const request = indexedDB.open("confirma-v3-db");
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const version = db.version;
      db.close();
      return version;
    })).toBe(6);
  } finally {
    await target.close();
  }
});

test("I11: the per-device Web Lock admits only one recovery runner across two tabs", async ({ page, context }) => {
  await page.goto("/app/styles.css");
  const second = await context.newPage();
  await second.goto("/app/styles.css");
  try {
    await page.evaluate(() => {
      window.__c3LockStarted = false;
      window.__c3LockPromise = navigator.locks.request("confirma-recovery:fixture-device", async () => {
        window.__c3LockStarted = true;
        await new Promise((resolve) => { window.__releaseC3Lock = resolve; });
      });
    });
    await expect.poll(() => page.evaluate(() => window.__c3LockStarted)).toBe(true);
    const acquired = await second.evaluate(() => navigator.locks.request(
      "confirma-recovery:fixture-device",
      { ifAvailable: true },
      (lock) => Boolean(lock)
    ));
    expect(acquired).toBe(false);
    await page.evaluate(() => window.__releaseC3Lock());
    await page.evaluate(() => window.__c3LockPromise);
  } finally {
    await second.close();
  }
});

async function confirmOneRecord(page, amount) {
  await ensureCaptureScreen(page);
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

async function installDamagedShape(page, { withRejected = true, missingDate = false } = {}) {
  return page.evaluate(async ({ withRejected, missingDate }) => {
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
    const accepted = records.find((row) => !row.importedFromServer && row.device_identity === settings.device_identity);
    if (!accepted) throw new Error("accepted fixture row missing");
    const imported = {
      ...accepted,
      id: 1_000_000_001,
      server_entry_id: accepted.id,
      importedFromServer: true
    };
    let rejected = null;
    let signingKeyMatchesStoredPublicKey = null;
    if (withRejected) {
      rejected = {
        ...accepted,
        id: 1,
        normalized_label: "synthetic_rejected_fixture",
        amount_minor: Number(accepted.amount_minor) + 100,
        prev_entry_hash: "0".repeat(64),
        importedFromServer: false,
        evidence_level: "device_signed"
      };
      delete rejected.server_entry_id;
      if (missingDate) delete rejected.confirmed_at;
      const canonical = [
        rejected.id, rejected.transaction_type, rejected.normalized_label, rejected.amount_minor,
        rejected.currency, rejected.counterparty, rejected.business_type_id, rejected.country,
        rejected.source_account, rejected.destination_account, rejected.reversed_entry_hash,
        rejected.reversed_transaction_type, rejected.confirmed_at, rejected.prev_entry_hash
      ].map((value) => value == null ? "" : String(value)).join("|");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      rejected.entry_hash = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: { name: "SHA-256" } },
        settings.device_private_key,
        new TextEncoder().encode(rejected.entry_hash)
      );
      rejected.signature = btoa(String.fromCharCode(...new Uint8Array(signature)));
      const publicKey = await crypto.subtle.importKey(
        "jwk",
        JSON.parse(settings.device_public_key),
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["verify"]
      );
      signingKeyMatchesStoredPublicKey = await crypto.subtle.verify(
        { name: "ECDSA", hash: { name: "SHA-256" } },
        publicKey,
        signature,
        new TextEncoder().encode(rejected.entry_hash)
      );
    }
    const write = db.transaction(["settings", "records", "syncQueue"], "readwrite");
    write.objectStore("records").clear();
    write.objectStore("syncQueue").clear();
    write.objectStore("records").put(imported);
    if (rejected) {
      write.objectStore("records").put(rejected);
      write.objectStore("syncQueue").add({
        entry_id: rejected.id,
        entry_hash: rejected.entry_hash,
        device_identity: rejected.device_identity,
        status: "queued",
        attempt_count: 0,
        queued_at: Date.now(),
        entry_payload: rejected
      });
    }
    await new Promise((resolve, reject) => {
      write.oncomplete = resolve;
      write.onabort = () => reject(write.error || new Error("fixture write aborted"));
      write.onerror = () => reject(write.error);
    });
    db.close();
    return {
      hasRejected: Boolean(rejected),
      originalConfirmedAt: accepted.confirmed_at,
      rejectedConfirmedAtPresent: rejected ? Object.hasOwn(rejected, "confirmed_at") : null,
      signingKeyMatchesStoredPublicKey
    };
  }, { withRejected, missingDate });
}

async function setRecoverySigningKeyAvailable(page, available) {
  return page.evaluate(async (shouldRestore) => {
    const backupKey = "c3_fixture_device_private_key";
    const open = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction("settings", "readwrite");
    const settings = tx.objectStore("settings");
    const sourceKey = shouldRestore ? backupKey : "device_private_key";
    const destinationKey = shouldRestore ? "device_private_key" : backupKey;
    const request = settings.get(sourceKey);
    request.onsuccess = () => {
      if (!request.result?.value) {
        tx.abort();
        return;
      }
      settings.put({ key: destinationKey, value: request.result.value });
      settings.delete(sourceKey);
    };
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("fixture signing key move aborted"));
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, available);
}

async function sendRejectedOnce(page) {
  return page.evaluate(async (apiUrl) => {
    const open = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction(["settings", "syncQueue"], "readonly");
    const settingsRequest = tx.objectStore("settings").getAll();
    const queueRequest = tx.objectStore("syncQueue").getAll();
    const settingsRows = await new Promise((resolve, reject) => {
      settingsRequest.onsuccess = () => resolve(settingsRequest.result || []);
      settingsRequest.onerror = () => reject(settingsRequest.error);
    });
    const queue = await new Promise((resolve, reject) => {
      queueRequest.onsuccess = () => resolve(queueRequest.result || []);
      queueRequest.onerror = () => reject(queueRequest.error);
    });
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
    const response = await fetch(`${apiUrl}/sync/entries`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.auth_token}`,
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

async function startServerRecoveryFence(page) {
  return page.evaluate(async (apiUrl) => {
    const open = indexedDB.open("confirma-v3-db");
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const request = db.transaction("settings", "readonly").objectStore("settings").getAll();
    const rows = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const response = await fetch(`${apiUrl}/recovery/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.auth_token}`,
        "X-Device-Identity": settings.device_identity
      },
      body: JSON.stringify({
        recovery_id: crypto.randomUUID(),
        device_identity: settings.device_identity,
        app_version: "c3-fence-test",
        local_summary: { fixture: true }
      })
    });
    db.close();
    return response.status;
  }, APP_API_URL);
}

async function waitForRecoveryTerminal(page) {
  await expect.poll(async () => {
    const value = (await readLocalState(page)).settings.recovery_state;
    return value?.state || "none";
  }, SERVER_TIMEOUT).toMatch(/^(completed|escalated)$/);
  return readLocalState(page);
}

test("I1/I2/I4/I5/I6/I9/I11: real C2 FORKED recovery resumes upload, plan and sync interruptions", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("c3-forked"));
  await confirmOneRecord(page, 7101);
  const before = await readLocalState(page);
  const deviceIdentity = before.settings.device_identity;
  const original = before.stores.records.find((row) => !row.importedFromServer);
  const fixture = await installDamagedShape(page, { withRejected: true });
  expect(fixture.signingKeyMatchesStoredPublicKey).toBe(true);
  expect(await sendRejectedOnce(page)).toEqual({ status: 409, code: "ledger_fork_conflict" });
  expect(deviceStatusForIdentity(deviceIdentity)?.status).toBe("FORKED");

  // A genuinely unavailable signing key must keep the existing fork hold in
  // place without starting, escalating or unlocking recovery. Restore the
  // exact same CryptoKey before continuing; never create a new identity.
  await setRecoverySigningKeyAvailable(page, false);
  const beforeSigningBlockedReload = await readLocalState(page);
  const blockedRecoveryRequests = [];
  const observeBlockedRequest = (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) blockedRecoveryRequests.push(request.url());
  };
  page.on("request", observeBlockedRequest);
  await page.reload();
  await expect(page.locator("#recovery-hold-banner")).toHaveText(
    "We're repairing a syncing problem. Your saved records are being preserved."
  );
  const signingBlocked = await readLocalState(page);
  expect(signingBlocked.settings.recovery_state).toBeUndefined();
  expect(blockedRecoveryRequests).toEqual([]);
  expect(signingBlocked.stores.records).toEqual(beforeSigningBlockedReload.stores.records);
  expect(signingBlocked.stores.syncQueue).toEqual(beforeSigningBlockedReload.stores.syncQueue);
  expect(signingBlocked.stores.records.some((row) => row.importedFromServer)).toBe(true);
  expect(signingBlocked.stores.syncQueue).toHaveLength(1);
  expect(deviceStatusForIdentity(deviceIdentity)?.status).toBe("FORKED");

  await ensureCaptureScreen(page);
  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill("7102");
  await page.locator("#prepare-confirmation").click();
  await expect(page.locator("#capture-error")).toContainText(
    "Finish device key setup before confirming a new record."
  );
  await expect(page.locator("#screen-confirm.active")).toHaveCount(0);
  await expect(page.locator("#screen-confirm")).toBeHidden();
  const afterBlockedConfirmation = await readLocalState(page);
  expect(afterBlockedConfirmation.stores.records).toEqual(beforeSigningBlockedReload.stores.records);
  expect(afterBlockedConfirmation.stores.syncQueue).toEqual(beforeSigningBlockedReload.stores.syncQueue);
  // The held-draft path requires a present signing key and is covered by
  // "restore chain R12-R14 and held-draft retention: unsafe confirmation writes only account-bound drafts".
  expect((afterBlockedConfirmation.settings.held_drafts || [])
    .some((draft) => draft.amount_minor === 710200)).toBe(false);
  expect(afterBlockedConfirmation.settings.recovery_state).toBeUndefined();
  expect(blockedRecoveryRequests).toEqual([]);
  page.off("request", observeBlockedRequest);
  await setRecoverySigningKeyAvailable(page, true);

  // Keep the part endpoint unavailable until the assertions are done; a one-shot
  // 503 lets the app retry and complete inside the same page session, which made
  // the intermediate "snapshotted" state a race (it failed once in the full run).
  let partRequestsRefused = 0;
  let partsBlocked = true;
  await page.route("**/recovery/sessions/*/parts/*", async (route) => {
    if (partsBlocked) {
      partRequestsRefused += 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"temporary"}' });
      return;
    }
    await route.continue();
  });
  await page.reload();
  await expect.poll(() => partRequestsRefused, SERVER_TIMEOUT).toBeGreaterThan(0);
  await expect.poll(async () => (await readLocalState(page)).settings.recovery_state?.state, SERVER_TIMEOUT)
    .toBe("snapshotted");
  expect((await readLocalState(page)).stores.recoverySnapshots).toHaveLength(1);
  partsBlocked = false;
  await page.unroute("**/recovery/sessions/*/parts/*");

  // Keep the plan endpoint unavailable until the assertions below are done. A
  // one-shot 503 lets the app retry and finish inside the same page session,
  // which makes the intermediate "classified" state a race instead of a contract.
  let planRequestsRefused = 0;
  let planBlocked = true;
  await page.route("**/recovery/sessions/*/plan", async (route) => {
    if (planBlocked) {
      planRequestsRefused += 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"temporary"}' });
      return;
    }
    await route.continue();
  });
  await page.reload();
  await expect.poll(() => planRequestsRefused, SERVER_TIMEOUT).toBeGreaterThan(0);
  await expect.poll(async () => (await readLocalState(page)).settings.recovery_state?.state, SERVER_TIMEOUT)
    .toBe("classified");
  const planned = await readLocalState(page);
  expect(planned.stores.recoveryWork).toHaveLength(1);
  expect(planned.stores.recoveryWork[0].persisted_before_plan).toBe(true);
  expect(planned.stores.recoveryWork[0].items.filter((item) => item.replacement)).toHaveLength(1);
  planBlocked = false;
  await page.unroute("**/recovery/sessions/*/plan");

  const integrityEventsBeforeFence = ledgerIntegrityEventsForDevice(deviceIdentity);
  let syncFailed = 0;
  let fencedAtFirst503;
  await page.route("**/sync/entries", async (route) => {
    if (syncFailed === 0) {
      fencedAtFirst503 = {
        local: await readLocalState(page),
        deviceStatus: deviceStatusForIdentity(deviceIdentity),
        integrityEvents: ledgerIntegrityEventsForDevice(deviceIdentity)
      };
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"recovery_in_progress","code":"recovery_in_progress"}'
      });
      syncFailed += 1;
      return;
    }
    await route.continue();
  });
  await page.reload();
  await expect.poll(() => syncFailed, SERVER_TIMEOUT).toBe(1);
  expect(fencedAtFirst503, "state was not captured before serving the first 503").toBeDefined();
  const fenced = fencedAtFirst503.local;
  expect(fenced.stores.syncQueue).toHaveLength(1);
  expect(fenced.settings.fork_recovery_pending).toBeDefined();
  expect(fencedAtFirst503.deviceStatus?.status).toBe("FORKED");
  expect(fencedAtFirst503.integrityEvents, "the recovery fence recorded a new integrity fork event")
    .toEqual(integrityEventsBeforeFence);
  await page.unroute("**/sync/entries");

  // Retries are event-driven (next open or the `online` event), not timer-driven, so
  // after the injected 503 fence is lifted the supported retry is the `online` event.
  // The 503 fence sets no retry interval; no internal recovery function is called. No
  // reload: the completion notice is held in memory for the session that finishes the
  // repair, and the terminal state below is the durable proof.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const after = await waitForRecoveryTerminal(page);
  expect(after.settings.recovery_state.state).toBe("completed");
  expect(after.settings.recovery_state.completion).toEqual(expect.objectContaining({
    outcome: "not_cleared",
    accounted_for: true
  }));
  expect(after.settings.fork_recovery_pending).toBeUndefined();
  expect(deviceStatusForIdentity(deviceIdentity)?.status).toBe("FORKED");
  const ledger = ledgerEntriesForDevice(deviceIdentity);
  expect(ledger).toHaveLength(2);
  expect(Number(ledger[1].entry_id)).toBe(2);
  expect(ledger[1].prev_entry_hash).toBe(ledger[0].entry_hash);
  const preservedRejected = after.stores.recoverySnapshots[0].records.find((row) => row.id === 1);
  expect(Number(ledger[1].payload.confirmed_at)).toBe(Number(preservedRejected.confirmed_at));
  expect(Number(after.stores.records.find((row) => row.id === 2)?.confirmed_at))
    .toBe(Number(preservedRejected.confirmed_at));
  expect(ledger.filter((row) => row.entry_hash === original.entry_hash)).toHaveLength(1);
  await expect(page.locator("#recovery-hold-banner")).toContainText("items this device reported were accounted for");
});

test("I8/I10: healthy open performs no recovery request or recovery-state write and shows no banner", async ({ page }) => {
  let recoveryRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests += 1;
  });
  await page.addInitScript(() => {
    window.__c3RecoveryStateWrites = 0;
    const originalPut = IDBObjectStore.prototype.put;
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.put = function patchedPut(value, key) {
      if (this.name === "settings" && value?.key === "recovery_state") window.__c3RecoveryStateWrites += 1;
      return originalPut.call(this, value, key);
    };
    IDBObjectStore.prototype.add = function patchedAdd(value, key) {
      if (this.name === "settings" && value?.key === "recovery_state") window.__c3RecoveryStateWrites += 1;
      return originalAdd.call(this, value, key);
    };
  });
  await page.goto("/");
  expect(recoveryRequests).toBe(0);
  expect(await page.evaluate(() => window.__c3RecoveryStateWrites)).toBe(0);
  expect(await page.locator("#recovery-hold-banner").count()).toBe(0);
});

test("I8/auth: a fork marker tied only to malformed queue junk does not bypass refused-session sign-out", async ({ page }) => {
  const account = await signInThroughUi(page, nextAccount("c3-junk-queue-auth"));
  await putStoreValue(page, "syncQueue", { entry_payload: { id: 93 }, queued_at: Date.now() });
  await writeLocalState(page, {
    fork_recovery_pending: {
      cases: [{
        source: "sync_rejection",
        integrity_kind: "fork_continuity",
        queue: [{ entry_id: undefined, entry_hash: undefined }],
        received_at: Date.now()
      }],
      updated_at: Date.now()
    }
  });

  const recoveryRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/recovery/")) recoveryRequests.push(request.url());
  });
  await page.route("**/sync/entries", (route) => route.continue({
    headers: { ...route.request().headers(), "x-device-identity": "wrong-device" }
  }));
  await page.route("**/auth/logout", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: '{"error":"auth_unavailable"}'
  }));

  await page.reload();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
  const after = await readLocalState(page);
  expect(after.settings.recovery_state).toBeUndefined();
  expect(recoveryRequests).toEqual([]);
  expect(after.settings.pending_revocations).toEqual(expect.arrayContaining([
    expect.objectContaining({ token: account.token, reason: "device_mismatch" })
  ]));
  expect(await page.locator("#recovery-hold-banner").count()).toBe(0);
  await page.unroute("**/sync/entries");
  await page.unroute("**/auth/logout");
});

test("I9: real recovery_in_progress fence keeps the ordinary queue and never records a fork", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("c3-sync-fence"));
  const local = await readLocalState(page);
  const deviceIdentity = local.settings.device_identity;
  expect(await startServerRecoveryFence(page)).toBe(200);

  await page.locator("#quick-label-grid button").first().click();
  await page.locator("#amount-input-v2").fill("7401");
  await page.locator("#prepare-confirmation").click();
  const response = page.waitForResponse((candidate) => (
    candidate.url().includes("/sync/entries") && candidate.request().method() === "POST"
  ), SERVER_TIMEOUT);
  await page.locator("#confirm-append").click();
  expect((await response).status()).toBe(503);

  await expect.poll(async () => (await readLocalState(page)).stores.syncQueue.length, SERVER_TIMEOUT).toBe(1);
  const after = await readLocalState(page);
  expect(after.settings.fork_recovery_pending).toBeUndefined();
  expect(ledgerEntriesForDevice(deviceIdentity)).toHaveLength(0);
  expect(ledgerIntegrityEventsForDevice(deviceIdentity)).toEqual([]);
  expect(deviceStatusForIdentity(deviceIdentity)?.status).toBe("ACTIVE");
});

test("remove-local-data explicitly warns about and atomically wipes recovery material", async ({ page }) => {
  await page.goto("/");
  await putStoreValue(page, "recoverySnapshots", {
    recovery_id: "00000000-0000-4000-8000-000000000001",
    device_identity: "fixture-device",
    records: [],
    queue: [],
    read_back_verified: true
  });
  await putStoreValue(page, "recoveryWork", {
    recovery_id: "00000000-0000-4000-8000-000000000001",
    items: []
  });
  await writeLocalState(page, {
    bound_account: "fixture-account",
    signed_out: true,
    recovery_state: {
      recovery_id: "00000000-0000-4000-8000-000000000001",
      state: "escalated",
      device_identity: "fixture-device",
      bound_account: "fixture-account"
    }
  });
  await page.reload();
  await expect(page.locator("#screen-signed-out.active")).toBeVisible();
  await page.locator("#signed-out-remove-data").click();
  await expect(page.locator("#remove-local-data-copy")).toContainText(
    "Recovery material for a syncing repair is also stored on this device"
  );
  await page.locator("#remove-local-data-confirmation").fill("REMOVE");
  await page.locator("#remove-local-data-confirm").click();
  await expect(page.getByRole("heading", { name: "Choose your phone country" })).toBeVisible();
  const after = await readLocalState(page);
  expect(after.stores.recoverySnapshots).toEqual([]);
  expect(after.stores.recoveryWork).toEqual([]);
  expect(after.settings.recovery_state).toBeUndefined();
});

test("I8/I12: ACTIVE imported-own repair stays ACTIVE, lifts the hold and leaves held drafts as drafts", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("c3-active"));
  await confirmOneRecord(page, 7201);
  const before = await readLocalState(page);
  const deviceIdentity = before.settings.device_identity;
  await installDamagedShape(page, { withRejected: false });
  await writeLocalState(page, { held_drafts: [{
    confirmation_state: "held_draft",
    bound_account: before.settings.bound_account,
    draft_attempt_id: "c3-held-draft-fixture",
    amount_minor: 720200
  }] });
  expect(deviceStatusForIdentity(deviceIdentity)?.status).toBe("ACTIVE");

  await page.reload();
  const after = await waitForRecoveryTerminal(page);
  expect(after.settings.recovery_state.state).toBe("completed");
  expect(after.settings.recovery_state.completion).toEqual(expect.objectContaining({
    outcome: "not_cleared",
    accounted_for: true
  }));
  expect(deviceStatusForIdentity(deviceIdentity)?.status).toBe("ACTIVE");
  expect(after.stores.records.some((row) => row.id === 1 && row.importedFromServer === false)).toBe(true);
  expect(after.settings.held_drafts).toEqual([expect.objectContaining({
    confirmation_state: "held_draft",
    draft_attempt_id: "c3-held-draft-fixture"
  })]);
  expect(after.stores.records.some((row) => row.draft_attempt_id === "c3-held-draft-fixture")).toBe(false);
  expect(after.settings.fork_recovery_pending).toBeUndefined();
});

test("I2/I11: three server-head moves escalate without applying or discarding the first preserved plan", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("c3-head-move"));
  await confirmOneRecord(page, 7251);
  const before = await readLocalState(page);
  const deviceIdentity = before.settings.device_identity;
  const fixture = await installDamagedShape(page, { withRejected: true });
  expect(fixture.signingKeyMatchesStoredPublicKey).toBe(true);
  let planRequests = 0;
  await page.route("**/recovery/sessions/*/plan", async (route) => {
    planRequests += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: '{"error":"recovery_plan_not_contiguous"}'
    });
  });

  await page.reload();
  const after = await waitForRecoveryTerminal(page);
  expect(after.settings.recovery_state.state).toBe("escalated");
  expect(planRequests).toBe(3);
  expect(after.stores.recoverySnapshots).toHaveLength(1);
  expect(after.stores.recoveryWork).toHaveLength(1);
  expect(after.stores.recoveryWork[0].persisted_before_plan).toBe(true);
  expect(after.stores.recoveryWork[0].plan_attempt).toBe(2);
  expect(after.stores.records.some((row) => row.importedFromServer)).toBe(true);
  expect(after.stores.syncQueue).toHaveLength(1);
  expect(ledgerEntriesForDevice(deviceIdentity)).toHaveLength(1);
  expect(deviceStatusForIdentity(deviceIdentity)?.status).toBe("ACTIVE");
  await page.unroute("**/recovery/sessions/*/plan");
});

test("I2/I6: ACTIVE missing-date item is preserved, reported without substitution and remains held", async ({ page }) => {
  test.slow();
  await signInThroughUi(page, nextAccount("c3-active-unaccounted"));
  await confirmOneRecord(page, 7301);
  const before = await readLocalState(page);
  const deviceIdentity = before.settings.device_identity;
  const fixture = await installDamagedShape(page, { withRejected: true, missingDate: true });
  expect(fixture.rejectedConfirmedAtPresent).toBe(false);

  await page.reload();
  const after = await waitForRecoveryTerminal(page);
  expect(after.settings.recovery_state.state).toBe("escalated");
  expect(after.settings.recovery_state.completion).toEqual(expect.objectContaining({ accounted_for: false }));
  expect(after.settings.fork_recovery_pending).toBeDefined();
  expect(deviceStatusForIdentity(deviceIdentity)?.status).toBe("ACTIVE");
  const snapshot = after.stores.recoverySnapshots[0];
  const preserved = snapshot.records.find((row) => row.id === 1);
  expect(Object.hasOwn(preserved, "confirmed_at")).toBe(false);
  expect(ledgerEntriesForDevice(deviceIdentity)).toHaveLength(1);
  await expect(page.locator("#recovery-hold-banner")).toHaveText(
    "Your records are preserved. We need to finish repairing this on our side."
  );
});
