import { expect, test } from "@playwright/test";

// Keep failure output structural. Fixtures deliberately contain no customer or
// credential data, and assertions never print full signed rows or signatures.

async function openApp(page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const request = indexedDB.open("confirma-v3-db", 6);
    await new Promise((resolve, reject) => {
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
  });
}

test("served module matches the app canonical bytes and classifies all date classes", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const appSource = await (await fetch("/app/app.js")).text();
    const match = appSource.match(/function buildLedgerHashCanonicalString\(record, id, confirmedAt, prevHash\) \{[\s\S]*?\n\}/);
    if (!match) throw new Error("canonical function was not found in the served app");
    const row = {
      transaction_type: "sale", normalized_label: "fixture", amount_minor: 1200, currency: "NGN",
      counterparty: null, business_type_id: "retail", country: "NG", source_account: undefined,
      destination_account: "cash", reversed_entry_hash: null, reversed_transaction_type: null
    };
    const bound = 2_000_000_000;
    return {
      appCanonicalSource: match[0],
      canonicalInputs: { row, id: 7, confirmedAt: 1_900_000_000, prevHash: "a".repeat(64) },
      recoveryCanonical: recovery.buildCanonical(row, 7, 1_900_000_000, "a".repeat(64)),
      dates: {
        ok: recovery.classifyDate(1_700_000_000, { receivedBoundSeconds: bound }),
        before: recovery.classifyDate(900_000_000, { receivedBoundSeconds: bound }),
        future: recovery.classifyDate(bound + 10, { receivedBoundSeconds: bound }),
        after: recovery.classifyDate(bound + 86401, { receivedBoundSeconds: bound }),
        missing: recovery.classifyDate(undefined, { receivedBoundSeconds: bound }),
        empty: recovery.classifyDate("", { receivedBoundSeconds: bound }),
        zero: recovery.classifyDate(0, { receivedBoundSeconds: bound }),
        nonNumeric: recovery.classifyDate("1700000000", { receivedBoundSeconds: bound }),
        nonFinite: recovery.classifyDate(Infinity, { receivedBoundSeconds: bound }),
        outOfRange: recovery.classifyDate(
          recovery.POSTGRES_TIMESTAMP_CONSERVATIVE_LIMIT_SECONDS + 1,
          { receivedBoundSeconds: bound }
        )
      }
    };
  });
  const appCanonical = Function(`${result.appCanonicalSource}; return buildLedgerHashCanonicalString;`)();
  expect(result.recoveryCanonical).toBe(appCanonical(
    result.canonicalInputs.row,
    result.canonicalInputs.id,
    result.canonicalInputs.confirmedAt,
    result.canonicalInputs.prevHash
  ));
  expect(result.dates).toEqual({
    ok: "ok", before: "before_2000", future: "future", after: "after_receipt_bound",
    missing: "unrepresentable", empty: "unrepresentable", zero: "unrepresentable",
    nonNumeric: "unrepresentable", nonFinite: "unrepresentable", outOfRange: "unrepresentable"
  });
});

test("healthy local detection is read-only while each local suspect signal is reported", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const { detectSuspect } = await import("/app/recovery-core.js");
    let writes = 0;
    const originalPut = IDBObjectStore.prototype.put;
    const originalAdd = IDBObjectStore.prototype.add;
    const originalDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.put = function (...args) { writes += 1; return originalPut.apply(this, args); };
    IDBObjectStore.prototype.add = function (...args) { writes += 1; return originalAdd.apply(this, args); };
    IDBObjectStore.prototype.delete = function (...args) { writes += 1; return originalDelete.apply(this, args); };
    try {
      const healthy = detectSuspect({ deviceIdentity: "dev", records: [
        { id: 1, entry_hash: "a", prev_entry_hash: "0", device_identity: "dev" },
        { id: 2, entry_hash: "b", prev_entry_hash: "a", device_identity: "dev" }
      ], syncQueue: [], settings: {} });
      const suspects = [
        detectSuspect({ deviceIdentity: "dev", records: [{ id: 9, importedFromServer: true, device_identity: "dev" }] }),
        detectSuspect({ deviceIdentity: "dev", records: [
          { id: 1, entry_hash: "a", device_identity: "dev" }, { id: 1, entry_hash: "b", prev_entry_hash: "x", device_identity: "dev" }
        ] }),
        detectSuspect({ deviceIdentity: "dev", settings: { fork_recovery_pending: { cases: [{}] } } }),
        detectSuspect({ deviceIdentity: "dev", syncQueue: [{ history: [{ code: "fork_id_conflict" }] }] })
      ];
      return { healthy, suspects, writes };
    } finally {
      IDBObjectStore.prototype.put = originalPut;
      IDBObjectStore.prototype.add = originalAdd;
      IDBObjectStore.prototype.delete = originalDelete;
    }
  });
  expect(result.healthy).toEqual({ suspect: false, reasons: [] });
  expect(result.writes).toBe(0);
  expect(result.suspects.every((item) => item.suspect)).toBe(true);
});

test("classification enforces R-A with real P-256 signatures", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const encoder = new TextEncoder();
    const bytesToHex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
    const fromBase64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const sha256 = async (value) => bytesToHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
    const sign = async (hash) => toBase64(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, keys.privateKey, encoder.encode(hash)
    ));
    const verifySignature = (hash, signature) => crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, keys.publicKey, fromBase64(signature), encoder.encode(hash)
    );
    const base = (id, prev, overrides = {}) => ({
      id, transaction_type: "sale", normalized_label: `fixture-${id}`, amount_minor: id * 100,
      currency: "NGN", counterparty: null, business_type_id: "retail", country: "NG",
      source_account: null, destination_account: null, reversed_entry_hash: null,
      reversed_transaction_type: null, confirmed_at: 1_700_000_000 + id, prev_entry_hash: prev,
      device_identity: "device-a", importedFromServer: false, ...overrides
    });
    const seal = async (row, canonicalId = row.id) => {
      row.entry_hash = await sha256(recovery.buildCanonical(row, canonicalId, row.confirmed_at, row.prev_entry_hash));
      row.signature = await sign(row.entry_hash);
      return row;
    };
    const server1 = await seal(base(1, "0".repeat(64)));
    const server2 = await seal(base(2, server1.entry_hash));
    const accepted = structuredClone(server2);
    const imported = await seal(base(1_000_000_001, "0".repeat(64), {
      server_entry_id: 1, importedFromServer: true, normalized_label: server1.normalized_label,
      amount_minor: server1.amount_minor, confirmed_at: server1.confirmed_at
    }), 1);
    const root = await seal(base(1, "0".repeat(64), { normalized_label: "rejected-root", amount_minor: 901 }));
    const child = await seal(base(3, root.entry_hash, { normalized_label: "rejected-child" }));
    const badSignature = await seal(base(4, child.entry_hash));
    badSignature.signature = badSignature.signature.slice(0, -4) + "AAAA";
    const altered = await seal(base(5, child.entry_hash));
    altered.amount_minor += 1;
    const wrongDevice = await seal(base(6, child.entry_hash, { device_identity: "device-b" }));
    const invalidParent = await seal(base(7, child.entry_hash));
    invalidParent.signature = "invalid";
    const invalidChild = await seal(base(8, invalidParent.entry_hash));
    const classification = await recovery.classifyRecords({
      localRecords: [imported, accepted, root, child, badSignature, altered, wrongDevice, invalidParent, invalidChild],
      localQueue: [root, child, badSignature, altered, wrongDevice, invalidParent, invalidChild].map((row, index) => ({
        queue_id: index + 1, entry_hash: row.entry_hash, entry_payload: row, status: "queued"
      })),
      serverRecords: [server1, server2], serverHead: server2, deviceIdentity: "device-a",
      receivedBoundSeconds: 1_800_000_000
    }, { sha256, verifySignature });
    return {
      accepted: classification.accepted.length,
      R: classification.R.length,
      xValid: classification.xValid.map((item) => item.record.normalized_label),
      invalidReasons: classification.xInvalid.map((item) => item.reason).sort(),
      unexplainedReasons: classification.unexplained.map((item) => item.reason).sort(),
      acceptedUnchanged: JSON.stringify(accepted) === JSON.stringify(classification.accepted[0].record)
    };
  });
  expect(result.accepted).toBe(1);
  expect(result.R).toBe(1);
  expect(result.xValid).toEqual(["rejected-root", "rejected-child"]);
  expect(result.invalidReasons).toEqual(expect.arrayContaining(["hash_mismatch", "signature_invalid", "wrong_device_identity"]));
  expect(result.unexplainedReasons).toEqual(expect.arrayContaining([
    "hash_mismatch", "signature_invalid", "wrong_device_identity", "chains_on_invalid_row"
  ]));
  expect(result.acceptedUnchanged).toBe(true);
});

test("planning preserves dates and fields, remaps reversals, and is byte-idempotent with injected deterministic signing", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const encoder = new TextEncoder();
    const sha256 = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const sign = async (hash) => `deterministic:${hash}`;
    const original = {
      id: 1, transaction_type: "sale", normalized_label: "original", amount_minor: 1234, currency: "NGN",
      counterparty: "fixture", business_type_id: "retail", country: "NG", source_account: null,
      destination_account: "cash", reversed_entry_hash: null, reversed_transaction_type: null,
      confirmed_at: 1_700_000_001, prev_entry_hash: "0".repeat(64), entry_hash: "a".repeat(64),
      signature: "old-signature", device_identity: "device-a", uncovered_fixture: "must-survive"
    };
    const reversal = {
      ...original, id: 2, transaction_type: "reversal", normalized_label: "reversal",
      confirmed_at: 1_700_000_002, prev_entry_hash: original.entry_hash, entry_hash: "b".repeat(64),
      reversed_entry_hash: original.entry_hash, reversed_transaction_type: "sale"
    };
    const unrepresentable = { ...original, id: 3, confirmed_at: 0, entry_hash: "c".repeat(64) };
    const reversalOfHeld = {
      ...reversal, id: 4, entry_hash: "d".repeat(64), reversed_entry_hash: unrepresentable.entry_hash
    };
    const input = {
      recoveryId: "recovery-plan", serverHead: { entry_id: 9, entry_hash: "9".repeat(64) },
      xValid: [
        { record: original, date_check: "ok", original_order: 0 },
        { record: reversal, date_check: "ok", original_order: 1 },
        { record: unrepresentable, date_check: "unrepresentable", not_replaceable: true, original_order: 2 },
        { record: reversalOfHeld, date_check: "ok", original_order: 3 }
      ]
    };
    const deps = { sha256, sign, now: () => 123456 };
    const first = await recovery.planReplacements(input, deps);
    const second = await recovery.planReplacements(input, deps);
    return {
      identical: JSON.stringify(first) === JSON.stringify(second),
      ids: first.items.map((item) => item.replacement?.id ?? null),
      dates: first.items.map((item) => item.replacement?.confirmed_at ?? item.original.confirmed_at),
      chain: first.items[1].replacement.prev_entry_hash === first.items[0].replacement.entry_hash,
      remapped: first.items[1].replacement.reversed_entry_hash === first.items[0].replacement.entry_hash,
      uncovered: first.items[0].replacement.uncovered_fixture,
      heldReasons: first.items.slice(2).map((item) => item.reason),
      oldSignedBytesStillPresent: original.entry_hash === "a".repeat(64) && original.signature === "old-signature"
    };
  });
  expect(result.identical).toBe(true);
  expect(result.ids).toEqual([10, 11, null, null]);
  expect(result.dates).toEqual([1_700_000_001, 1_700_000_002, 0, 1_700_000_002]);
  expect(result.chain).toBe(true);
  expect(result.remapped).toBe(true);
  expect(result.uncovered).toBe("must-survive");
  expect(result.heldReasons).toEqual(["unrepresentable_date", "reversal_target_not_replaceable"]);
  expect(result.oldSignedBytesStillPresent).toBe(true);
});

test("snapshot round-trip includes own inputs but no private key material", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const open = indexedDB.open("confirma-v3-db", 6);
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    const privateKey = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
    )).privateKey;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["records", "syncQueue", "settings", "recoverySnapshots"], "readwrite");
      ["records", "syncQueue", "recoverySnapshots"].forEach((name) => tx.objectStore(name).clear());
      tx.objectStore("records").put({ id: 1, device_identity: "device-a", entry_hash: "a" });
      tx.objectStore("records").put({ id: 2, device_identity: "device-b", entry_hash: "b" });
      tx.objectStore("syncQueue").add({ device_identity: "device-a", entry_hash: "a" });
      tx.objectStore("settings").put({ key: "device_private_key", value: privateKey });
      tx.objectStore("settings").put({ key: "recovery_state", value: { recovery_id: "snapshot-one", state: "suspect" } });
      tx.objectStore("settings").put({ key: "fork_recovery_pending", value: { cases: [{ reason: "fixture" }] } });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const snapshot = await recovery.takeSnapshot(db, {
      deviceIdentity: "device-a", publicKeyFingerprint: "fingerprint", appVersion: "c1"
    });
    const containsPrivate = (value, seen = new Set()) => {
      if (!value || typeof value !== "object" || seen.has(value)) return false;
      seen.add(value);
      if (value instanceof CryptoKey && value.type === "private") return true;
      if (value.kty && typeof value.d === "string") return true;
      return Object.entries(value).some(([key, child]) => /private[_-]?key/i.test(key) || containsPrivate(child, seen));
    };
    db.close();
    return {
      verified: snapshot.read_back_verified,
      recordCount: snapshot.records.length,
      queueCount: snapshot.queue.length,
      containsPrivate: containsPrivate(snapshot),
      markerCopied: Boolean(snapshot.classification_inputs.fork_recovery_pending)
    };
  });
  expect(result).toEqual({ verified: true, recordCount: 1, queueCount: 1, containsPrivate: false, markerCopied: true });
});

test("snapshot write failure leaves no complete snapshot", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const open = indexedDB.open("confirma-v3-db", 6);
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["settings", "recoverySnapshots"], "readwrite");
      tx.objectStore("recoverySnapshots").clear();
      tx.objectStore("settings").put({ key: "recovery_state", value: { recovery_id: "snapshot-fail", state: "suspect" } });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    const originalAdd = IDBObjectStore.prototype.add;
    let fired = false;
    IDBObjectStore.prototype.add = function (value, key) {
      const request = originalAdd.call(this, value, key);
      if (!fired && this.name === "recoverySnapshots") {
        fired = true;
        queueMicrotask(() => this.transaction.abort());
      }
      return request;
    };
    let threw = false;
    try {
      await recovery.takeSnapshot(db, { deviceIdentity: "device-a", publicKeyFingerprint: "fp", appVersion: "c1" });
    } catch { threw = true; }
    finally { IDBObjectStore.prototype.add = originalAdd; }
    const stored = await new Promise((resolve, reject) => {
      const tx = db.transaction("recoverySnapshots", "readonly");
      const get = tx.objectStore("recoverySnapshots").get("snapshot-fail");
      get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
    });
    db.close();
    return { threw, complete: stored?.read_back_verified === true };
  });
  expect(result).toEqual({ threw: true, complete: false });
});

test("RC6 refuses each missing precondition without changing records", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const openDb = async () => {
      const request = indexedDB.open("confirma-v3-db", 6);
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
    };
    const sessionGuard = {
      sessionGeneration: 7, wipeEpoch: 3, boundAccount: "account-a",
      authToken: "fixture-session-token", authTokenExpiresAt: "2999-01-01T00:00:00.000Z"
    };
    const seed = async (db, durableState, snapshot) => new Promise((resolve, reject) => {
      const tx = db.transaction(["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"], "readwrite");
      ["records", "syncQueue", "recoverySnapshots", "recoveryWork"].forEach((name) => tx.objectStore(name).clear());
      Object.entries({
        session_generation: sessionGuard.sessionGeneration, wipe_epoch: sessionGuard.wipeEpoch,
        signed_out: false, wipe_pending: false, bound_account: sessionGuard.boundAccount,
        auth_token: sessionGuard.authToken, auth_token_expires_at: sessionGuard.authTokenExpiresAt
      }).forEach(([key, value]) => tx.objectStore("settings").put({ key, value }));
      tx.objectStore("settings").put({ key: "held_drafts", value: [{ confirmation_state: "held_draft", fixture: 1 }] });
      if (durableState) tx.objectStore("settings").put({ key: "recovery_state", value: durableState });
      else tx.objectStore("settings").delete("recovery_state");
      tx.objectStore("records").put({ id: 1, entry_hash: "old", device_identity: "device-a" });
      tx.objectStore("syncQueue").add({ entry_id: 1, entry_hash: "old", device_identity: "device-a" });
      if (snapshot) tx.objectStore("recoverySnapshots").put(snapshot);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const dump = async (db) => {
      const stores = ["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"];
      const output = {};
      await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, "readonly");
        for (const name of stores) {
          const get = tx.objectStore(name).getAll(); get.onsuccess = () => { output[name] = get.result; };
        }
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      return JSON.stringify(output);
    };
    const plan = {
      recovery_id: "gate-test", server_head: { entry_id: 0, entry_hash: "0".repeat(64) }, r_copies: [],
      replacement_hashes: { old: "new" }, items: [{
        original: { id: 1, entry_hash: "old", device_identity: "device-a" },
        replacement: { id: 1, entry_hash: "new", device_identity: "device-a" },
        queueEntry: { entry_id: 1, entry_hash: "new", device_identity: "device-a" }
      }]
    };
    const cases = [
      [{ recovery_id: "gate-test", state: "snapshotted", remote_ack: true }, { recovery_id: "gate-test", read_back_verified: true }],
      [{ recovery_id: "gate-test", state: "uploaded", remote_ack: false }, { recovery_id: "gate-test", read_back_verified: true }],
      [{ recovery_id: "gate-test", state: "uploaded", remote_ack: true }, { recovery_id: "gate-test", read_back_verified: false }]
    ];
    const outcomes = [];
    for (const [durableState, snapshot] of cases) {
      const db = await openDb();
      await seed(db, durableState, snapshot);
      const before = await dump(db);
      let errorName = "";
      try { await recovery.applyRebuild(db, plan, {}, { sessionGuard }); } catch (error) { errorName = error.name; }
      const after = await dump(db);
      const held = JSON.parse(after).settings.find((row) => row.key === "held_drafts")?.value;
      outcomes.push({ errorName, unchanged: before === after, held });
      db.close();
    }
    return outcomes;
  });
  for (const outcome of result) {
    expect(outcome.errorName).toBe("RecoveryPreconditionError");
    expect(outcome.unchanged).toBe(true);
    expect(outcome.held).toEqual([{ confirmation_state: "held_draft", fixture: 1 }]);
  }
});

test("rebuild is atomic, records outcomes before removal, restores R, and leaves held drafts untouched", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const request = indexedDB.open("confirma-v3-db", 6);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const stores = ["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"];
    const sessionGuard = {
      sessionGeneration: 7, wipeEpoch: 3, boundAccount: "account-a",
      authToken: "fixture-session-token", authTokenExpiresAt: "2999-01-01T00:00:00.000Z"
    };
    const seed = () => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      ["records", "syncQueue", "recoverySnapshots", "recoveryWork"].forEach((name) => tx.objectStore(name).clear());
      Object.entries({
        session_generation: sessionGuard.sessionGeneration, wipe_epoch: sessionGuard.wipeEpoch,
        signed_out: false, wipe_pending: false, bound_account: sessionGuard.boundAccount,
        auth_token: sessionGuard.authToken, auth_token_expires_at: sessionGuard.authTokenExpiresAt
      }).forEach(([key, value]) => tx.objectStore("settings").put({ key, value }));
      tx.objectStore("settings").put({ key: "recovery_state", value: {
        recovery_id: "apply-test", state: "uploaded", remote_ack: true
      } });
      tx.objectStore("settings").put({ key: "held_drafts", value: [{ confirmation_state: "held_draft", fixture: 2 }] });
      tx.objectStore("records").put({ id: 1, entry_hash: "x", device_identity: "device-a" });
      tx.objectStore("records").put({ id: 1_000_000_001, server_entry_id: 1, entry_hash: "r", device_identity: "device-a", importedFromServer: true });
      tx.objectStore("syncQueue").add({ entry_id: 1, entry_hash: "x", device_identity: "device-a" });
      tx.objectStore("recoverySnapshots").put({
        recovery_id: "apply-test", read_back_verified: true,
        records: [
          { id: 1, entry_hash: "x", device_identity: "device-a" },
          { id: 1_000_000_001, server_entry_id: 1, entry_hash: "r", device_identity: "device-a", importedFromServer: true }
        ], outcomes: {}
      });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const dump = async () => {
      const output = {};
      await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, "readonly");
        for (const name of stores) {
          const get = tx.objectStore(name).getAll(); get.onsuccess = () => { output[name] = get.result; };
        }
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      return output;
    };
    const plan = {
      recovery_id: "apply-test", server_head: { entry_id: 1, entry_hash: "r" },
      r_copies: [{ record: { id: 1_000_000_001, server_entry_id: 1, entry_hash: "r", device_identity: "device-a", importedFromServer: true }, trueId: 1 }],
      replacement_hashes: { x: "replacement" }, items: [{
        original: { id: 1, entry_hash: "x", device_identity: "device-a" },
        replacement: { id: 2, entry_hash: "replacement", prev_entry_hash: "r", confirmed_at: 1_700_000_000, device_identity: "device-a" },
        queueEntry: { entry_id: 2, entry_hash: "replacement", device_identity: "device-a", status: "queued" }
      }]
    };
    await seed();
    await recovery.applyRebuild(db, plan, {}, { sessionGuard });
    const applied = await dump();
    await recovery.applyRebuild(db, plan, {}, { sessionGuard });
    const appliedAgain = await dump();

    await seed();
    const beforeAbort = JSON.stringify(await dump());
    const originalPut = IDBObjectStore.prototype.put;
    const originalAdd = IDBObjectStore.prototype.add;
    let armed = true;
    const abortRecoveryWorkWrite = function (write, value, key) {
      const result = write.call(this, value, key);
      if (armed && this.name === "recoveryWork") {
        armed = false;
        queueMicrotask(() => this.transaction.abort());
      }
      return result;
    };
    IDBObjectStore.prototype.put = function (value, key) {
      return abortRecoveryWorkWrite.call(this, originalPut, value, key);
    };
    IDBObjectStore.prototype.add = function (value, key) {
      return abortRecoveryWorkWrite.call(this, originalAdd, value, key);
    };
    let aborted = false;
    try { await recovery.applyRebuild(db, plan, {}, { sessionGuard }); } catch { aborted = true; }
    finally {
      IDBObjectStore.prototype.put = originalPut;
      IDBObjectStore.prototype.add = originalAdd;
    }
    const afterAbort = JSON.stringify(await dump());
    db.close();
    return {
      recordShape: applied.records.map((row) => ({ id: row.id, hash: row.entry_hash, imported: Boolean(row.importedFromServer) })),
      queueHashes: applied.syncQueue.map((row) => row.entry_hash),
      outcome: applied.recoverySnapshots[0].outcomes.x,
      exactWork: applied.recoveryWork[0].items[0].replacement.entry_hash,
      held: applied.settings.find((row) => row.key === "held_drafts").value,
      idempotent: JSON.stringify(applied) === JSON.stringify(appliedAgain),
      aborted, byteIdenticalAfterAbort: beforeAbort === afterAbort
    };
  });
  expect(result.recordShape).toEqual([{ id: 1, hash: "r", imported: false }, { id: 2, hash: "replacement", imported: false }]);
  expect(result.queueHashes).toEqual(["replacement"]);
  expect(result.outcome).toEqual({ outcome: "replaced", replacement_hash: "replacement" });
  expect(result.exactWork).toBe("replacement");
  expect(result.held).toEqual([{ confirmation_state: "held_draft", fixture: 2 }]);
  expect(result.idempotent).toBe(true);
  expect(result.aborted).toBe(true);
  expect(result.byteIdenticalAfterAbort).toBe(true);
});

test("restored R destinations match Package A provenance without mutating raw inputs and replay safely", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const request = indexedDB.open("confirma-v3-db", 6);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const stores = ["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"];
    const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
    const stable = (value) => JSON.stringify(value, (_key, nested) => (
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
        : nested
    ));
    const sessionGuard = {
      sessionGeneration: 7, wipeEpoch: 3, boundAccount: "account-a",
      authToken: "fixture-session-token", authTokenExpiresAt: "2999-01-01T00:00:00.000Z"
    };
    const imported = {
      id: 1_000_000_011, server_entry_id: 11, transaction_type: "sale",
      normalized_label: "fixture-restored", amount_minor: 1250, currency: "NGN",
      counterparty: "fixture-counterparty", business_type_id: "fixture-business",
      country: "NG", source_account: "fixture-source", destination_account: "fixture-destination",
      reversed_entry_hash: null, reversed_transaction_type: null,
      device_identity: "device-a", evidence_level: "server_attested",
      signature: "fixture-signature", entry_hash: "restored-hash",
      confirmed_at: 1_700_000_011, prev_entry_hash: "previous-hash",
      restoreVerified: true, importedFromServer: true
    };
    const original = {
      id: 12, entry_hash: "rejected-hash", prev_entry_hash: imported.entry_hash,
      confirmed_at: 1_700_000_012, device_identity: "device-a"
    };
    const replacement = {
      ...original, id: 13, entry_hash: "replacement-hash", prev_entry_hash: imported.entry_hash
    };
    const plan = {
      recovery_id: "restore-provenance-test",
      server_head: { entry_id: 11, entry_hash: imported.entry_hash },
      r_copies: [{ record: imported, trueId: imported.server_entry_id }],
      replacement_hashes: { [original.entry_hash]: replacement.entry_hash },
      items: [{
        original, replacement,
        queueEntry: {
          entry_id: replacement.id, entry_hash: replacement.entry_hash,
          device_identity: replacement.device_identity, status: "queued"
        }
      }]
    };
    const seed = () => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      for (const name of ["records", "syncQueue", "recoverySnapshots", "recoveryWork"]) {
        tx.objectStore(name).clear();
      }
      Object.entries({
        session_generation: sessionGuard.sessionGeneration, wipe_epoch: sessionGuard.wipeEpoch,
        signed_out: false, wipe_pending: false, bound_account: sessionGuard.boundAccount,
        auth_token: sessionGuard.authToken, auth_token_expires_at: sessionGuard.authTokenExpiresAt,
        recovery_state: { recovery_id: plan.recovery_id, state: "uploaded", remote_ack: true }
      }).forEach(([key, value]) => tx.objectStore("settings").put({ key, value }));
      tx.objectStore("records").put(imported);
      tx.objectStore("records").put(original);
      tx.objectStore("syncQueue").add({
        entry_id: original.id, entry_hash: original.entry_hash, device_identity: original.device_identity
      });
      tx.objectStore("recoverySnapshots").put({
        recovery_id: plan.recovery_id, device_identity: imported.device_identity, read_back_verified: true,
        records: [imported, original], queue: [], outcomes: {}
      });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const dump = () => new Promise((resolve, reject) => {
      const output = {};
      const tx = db.transaction(stores, "readonly");
      for (const name of stores) {
        const get = tx.objectStore(name).getAll(); get.onsuccess = () => { output[name] = get.result; };
      }
      tx.oncomplete = () => resolve(output); tx.onerror = () => reject(tx.error);
    });
    const putRestored = (row) => new Promise((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").put(row);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });

    await seed();
    const before = await dump();
    const planBefore = structuredClone(plan);
    const sourceBefore = structuredClone(imported);
    await recovery.applyRebuild(db, plan, {}, { sessionGuard });
    const applied = await dump();
    const restored = applied.records.find((row) => row.id === imported.server_entry_id);
    const rebuiltReplacement = applied.records.find((row) => row.id === replacement.id);
    const packageAShape = {
      ...imported, id: imported.server_entry_id, importedFromServer: false, restoredOwn: true
    };
    const normalizedRestored = structuredClone(restored);
    const normalizedImported = structuredClone(imported);
    for (const key of ["id", "importedFromServer", "restoredOwn"]) {
      delete normalizedRestored[key];
      delete normalizedImported[key];
    }
    const rawSnapshotBefore = before.recoverySnapshots[0];
    const rawSnapshotAfter = applied.recoverySnapshots[0];
    const storedWork = applied.recoveryWork[0];
    const storedWorkPlan = {
      recovery_id: storedWork.recovery_id, server_head: storedWork.server_head,
      r_copies: storedWork.r_copies, replacement_hashes: storedWork.replacement_hashes,
      items: storedWork.items
    };

    await recovery.applyRebuild(db, plan, {}, { sessionGuard });
    const replayed = await dump();

    const legacyWithoutFlag = structuredClone(restored);
    delete legacyWithoutFlag.restoredOwn;
    await putRestored(legacyWithoutFlag);
    const beforeLegacyReplay = await dump();
    let legacyReplayError = "";
    try { await recovery.applyRebuild(db, plan, {}, { sessionGuard }); }
    catch (error) { legacyReplayError = error.name; }
    const afterLegacyReplay = await dump();
    db.close();

    return {
      packageAParity: stable(restored) === stable(packageAShape),
      normalizedCopyParity: stable(normalizedRestored) === stable(normalizedImported),
      restoredFlags: restored.restoredOwn === true && restored.importedFromServer === false,
      rawSourceUnchanged: stable(imported) === stable(sourceBefore) && !owns(imported, "restoredOwn"),
      planUnchanged: stable(plan) === stable(planBefore) && !stable(plan).includes("restoredOwn"),
      snapshotRecordsUnchanged: stable(rawSnapshotBefore.records) === stable(rawSnapshotAfter.records),
      snapshotHasNoRestoredOwn: !stable(rawSnapshotAfter).includes("restoredOwn"),
      workHasNoRestoredOwn: !stable(storedWork).includes("restoredOwn"),
      storedWorkPlanExact: stable(storedWorkPlan) === stable(plan),
      replacementHasNoRestoredOwn: !owns(rebuiltReplacement, "restoredOwn"),
      datesPreserved: restored.confirmed_at === imported.confirmed_at
        && rebuiltReplacement.confirmed_at === original.confirmed_at,
      replayIdentical: stable(applied) === stable(replayed),
      replayOutcomeIdentical: stable(applied.recoverySnapshots[0].outcomes)
        === stable(replayed.recoverySnapshots[0].outcomes),
      replaySnapshotIdentical: stable(applied.recoverySnapshots) === stable(replayed.recoverySnapshots),
      replayWorkIdentical: stable(applied.recoveryWork) === stable(replayed.recoveryWork),
      legacyReplayError,
      legacyReplayIdentical: stable(beforeLegacyReplay) === stable(afterLegacyReplay),
      legacyFlagRemainsAbsent: !owns(afterLegacyReplay.records.find((row) => row.id === imported.server_entry_id), "restoredOwn")
    };
  });
  expect(result).toEqual({
    packageAParity: true,
    normalizedCopyParity: true,
    restoredFlags: true,
    rawSourceUnchanged: true,
    planUnchanged: true,
    snapshotRecordsUnchanged: true,
    snapshotHasNoRestoredOwn: true,
    workHasNoRestoredOwn: true,
    storedWorkPlanExact: true,
    replacementHasNoRestoredOwn: true,
    datesPreserved: true,
    replayIdentical: true,
    replayOutcomeIdentical: true,
    replaySnapshotIdentical: true,
    replayWorkIdentical: true,
    legacyReplayError: "",
    legacyReplayIdentical: true,
    legacyFlagRemainsAbsent: true
  });
});

test("rebuild collisions abort atomically for occupied destinations and changed sources", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const request = indexedDB.open("confirma-v3-db", 6);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const stores = ["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"];
    const sessionGuard = {
      sessionGeneration: 7, wipeEpoch: 3, boundAccount: "account-a",
      authToken: "fixture-session-token", authTokenExpiresAt: "2999-01-01T00:00:00.000Z"
    };
    const original = { id: 1, entry_hash: "original", device_identity: "device-a" };
    const imported = {
      id: 1_000_000_003, server_entry_id: 3, entry_hash: "restored", device_identity: "device-a", importedFromServer: true
    };
    const plan = {
      recovery_id: "collision-test", server_head: { entry_id: 1, entry_hash: "head" },
      r_copies: [{ record: imported, trueId: 3 }], replacement_hashes: { original: "replacement" },
      items: [{
        original,
        replacement: { id: 2, entry_hash: "replacement", device_identity: "device-a" },
        queueEntry: { entry_id: 2, entry_hash: "replacement", device_identity: "device-a" }
      }]
    };
    const dump = () => new Promise((resolve, reject) => {
      const output = {};
      const tx = db.transaction(stores, "readonly");
      for (const name of stores) {
        const get = tx.objectStore(name).getAll(); get.onsuccess = () => { output[name] = get.result; };
      }
      tx.oncomplete = () => resolve(JSON.stringify(output)); tx.onerror = () => reject(tx.error);
    });
    const seed = (mutation) => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      for (const name of ["records", "syncQueue", "recoverySnapshots", "recoveryWork"]) tx.objectStore(name).clear();
      Object.entries({
        session_generation: sessionGuard.sessionGeneration, wipe_epoch: sessionGuard.wipeEpoch,
        signed_out: false, wipe_pending: false, bound_account: sessionGuard.boundAccount,
        auth_token: sessionGuard.authToken, auth_token_expires_at: sessionGuard.authTokenExpiresAt
      }).forEach(([key, value]) => tx.objectStore("settings").put({ key, value }));
      tx.objectStore("settings").put({ key: "recovery_state", value: {
        recovery_id: plan.recovery_id, state: "uploaded", remote_ack: true
      } });
      tx.objectStore("records").put(original);
      tx.objectStore("records").put(imported);
      tx.objectStore("syncQueue").add({ entry_id: 1, entry_hash: "original", device_identity: "device-a" });
      tx.objectStore("recoverySnapshots").put({
        recovery_id: plan.recovery_id, device_identity: "device-a", read_back_verified: true,
        records: [original, imported], queue: [], outcomes: {}
      });
      mutation(tx);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const cases = [
      (tx) => tx.objectStore("records").put({ id: 2, entry_hash: "unrelated-destination", device_identity: "device-a" }),
      (tx) => tx.objectStore("records").put({ id: 1, entry_hash: "changed-source", device_identity: "device-a" }),
      (tx) => tx.objectStore("records").delete(1),
      (tx) => tx.objectStore("records").put({ id: 3, entry_hash: "unrelated-restored-destination", device_identity: "device-a" })
    ];
    const outcomes = [];
    for (const mutation of cases) {
      await seed(mutation);
      const before = await dump();
      let errorName = "";
      try { await recovery.applyRebuild(db, plan, {}, { sessionGuard }); } catch (error) { errorName = error.name; }
      const after = await dump();
      outcomes.push({ errorName, unchanged: before === after });
    }
    db.close();
    return outcomes;
  });
  expect(result).toEqual(Array.from({ length: 4 }, () => ({ errorName: "RecoveryCollisionError", unchanged: true })));
});

test("snapshots are create-once across retries, rebuilds, interrupted verification, concurrency, and identity mismatch", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const request = indexedDB.open("confirma-v3-db", 6);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const stores = ["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"];
    const sessionGuard = {
      sessionGeneration: 7, wipeEpoch: 3, boundAccount: "account-a",
      authToken: "fixture-session-token", authTokenExpiresAt: "2999-01-01T00:00:00.000Z"
    };
    const original = { id: 1, entry_hash: "snapshot-original", device_identity: "device-a" };
    const reset = (recoveryId) => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      for (const name of ["records", "syncQueue", "recoverySnapshots", "recoveryWork"]) tx.objectStore(name).clear();
      Object.entries({
        session_generation: sessionGuard.sessionGeneration, wipe_epoch: sessionGuard.wipeEpoch,
        signed_out: false, wipe_pending: false, bound_account: sessionGuard.boundAccount,
        auth_token: sessionGuard.authToken, auth_token_expires_at: sessionGuard.authTokenExpiresAt
      }).forEach(([key, value]) => tx.objectStore("settings").put({ key, value }));
      tx.objectStore("settings").put({ key: "recovery_state", value: {
        recovery_id: recoveryId, state: "suspect", remote_ack: false
      } });
      tx.objectStore("records").put(original);
      tx.objectStore("syncQueue").add({ entry_id: 1, entry_hash: original.entry_hash, device_identity: "device-a" });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    await reset("immutable-snapshot");
    const options = { deviceIdentity: "device-a", publicKeyFingerprint: "fp", appVersion: "c1" };
    const first = await recovery.takeSnapshot(db, options);
    const beforeRetry = await recovery.takeSnapshot(db, options);
    await new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put({ key: "recovery_state", value: {
        recovery_id: "immutable-snapshot", state: "uploaded", remote_ack: true
      } });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    const plan = {
      recovery_id: "immutable-snapshot", server_head: { entry_id: 1, entry_hash: "head" }, r_copies: [],
      replacement_hashes: { "snapshot-original": "snapshot-replacement" }, items: [{
        original,
        replacement: { id: 2, entry_hash: "snapshot-replacement", device_identity: "device-a" },
        queueEntry: { entry_id: 2, entry_hash: "snapshot-replacement", device_identity: "device-a" }
      }]
    };
    await recovery.applyRebuild(db, plan, {}, { sessionGuard });
    const afterRebuild = await recovery.takeSnapshot(db, options);

    await reset("interrupted-verification");
    await new Promise((resolve, reject) => {
      const tx = db.transaction("recoverySnapshots", "readwrite");
      tx.objectStore("recoverySnapshots").add({
        recovery_id: "interrupted-verification", device_identity: "device-a", records: [original], queue: [],
        classification_inputs: {}, outcomes: { preserved: true }, read_back_verified: false
      });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").clear();
      tx.objectStore("records").put({ id: 9, entry_hash: "live-row-must-not-be-captured", device_identity: "device-a" });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    const interrupted = await recovery.takeSnapshot(db, options);

    await reset("concurrent-snapshot");
    const concurrent = await Promise.all([
      recovery.takeSnapshot(db, options), recovery.takeSnapshot(db, options)
    ]);
    const storedCount = await new Promise((resolve, reject) => {
      const tx = db.transaction("recoverySnapshots", "readonly");
      const count = tx.objectStore("recoverySnapshots").count();
      count.onsuccess = () => resolve(count.result); count.onerror = () => reject(count.error);
    });
    let identityError = "";
    try { await recovery.takeSnapshot(db, { ...options, deviceIdentity: "device-b" }); }
    catch (error) { identityError = error.name; }
    db.close();
    return {
      retryExact: JSON.stringify(first) === JSON.stringify(beforeRetry),
      afterRebuildHasOriginal: afterRebuild.records.some((row) => row.entry_hash === original.entry_hash),
      afterRebuildHasReplacement: afterRebuild.records.some((row) => row.entry_hash === "snapshot-replacement"),
      interruptedVerified: interrupted.read_back_verified === true,
      interruptedPreserved: interrupted.records[0]?.entry_hash === original.entry_hash && interrupted.outcomes.preserved === true,
      concurrentSame: JSON.stringify(concurrent[0]) === JSON.stringify(concurrent[1]),
      storedCount, identityError
    };
  });
  expect(result).toEqual({
    retryExact: true, afterRebuildHasOriginal: true, afterRebuildHasReplacement: false,
    interruptedVerified: true, interruptedPreserved: true, concurrentSame: true,
    storedCount: 1, identityError: "RecoveryCollisionError"
  });
});

test("overlapping replacement ids replay as a no-op and preserve first work bytes", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const request = indexedDB.open("confirma-v3-db", 6);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const stores = ["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"];
    const sessionGuard = {
      sessionGeneration: 7, wipeEpoch: 3, boundAccount: "account-a",
      authToken: "fixture-session-token", authTokenExpiresAt: "2999-01-01T00:00:00.000Z"
    };
    const original1 = { id: 1, entry_hash: "rejected-one", device_identity: "device-a" };
    const original2 = { id: 2, entry_hash: "rejected-two", device_identity: "device-a" };
    const acceptedCopy = {
      id: 1_000_000_001, server_entry_id: 1, entry_hash: "accepted-one", device_identity: "device-a", importedFromServer: true
    };
    const plan = {
      recovery_id: "overlap-rebuild", server_head: { entry_id: 1, entry_hash: "accepted-one" },
      r_copies: [{ record: acceptedCopy, trueId: 1 }],
      replacement_hashes: { "rejected-one": "replacement-one", "rejected-two": "replacement-two" },
      items: [
        { original: original1, replacement: { ...original1, id: 2, entry_hash: "replacement-one" },
          queueEntry: { entry_id: 2, entry_hash: "replacement-one", device_identity: "device-a" } },
        { original: original2, replacement: { ...original2, id: 3, entry_hash: "replacement-two" },
          queueEntry: { entry_id: 3, entry_hash: "replacement-two", device_identity: "device-a" } }
      ]
    };
    const seed = () => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      for (const name of ["records", "syncQueue", "recoverySnapshots", "recoveryWork"]) tx.objectStore(name).clear();
      Object.entries({
        session_generation: sessionGuard.sessionGeneration, wipe_epoch: sessionGuard.wipeEpoch,
        signed_out: false, wipe_pending: false, bound_account: sessionGuard.boundAccount,
        auth_token: sessionGuard.authToken, auth_token_expires_at: sessionGuard.authTokenExpiresAt
      }).forEach(([key, value]) => tx.objectStore("settings").put({ key, value }));
      tx.objectStore("settings").put({ key: "recovery_state", value: {
        recovery_id: plan.recovery_id, state: "uploaded", remote_ack: true
      } });
      for (const row of [original1, original2, acceptedCopy]) tx.objectStore("records").put(row);
      for (const row of [original1, original2]) tx.objectStore("syncQueue").add({
        entry_id: row.id, entry_hash: row.entry_hash, device_identity: row.device_identity
      });
      tx.objectStore("recoverySnapshots").put({
        recovery_id: plan.recovery_id, device_identity: "device-a", read_back_verified: true,
        records: [original1, original2, acceptedCopy], queue: [], outcomes: {}
      });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const dump = () => new Promise((resolve, reject) => {
      const output = {};
      const tx = db.transaction(stores, "readonly");
      for (const name of stores) {
        const get = tx.objectStore(name).getAll(); get.onsuccess = () => { output[name] = get.result; };
      }
      tx.oncomplete = () => resolve(output); tx.onerror = () => reject(tx.error);
    });
    await seed();
    await recovery.applyRebuild(db, plan, {}, { sessionGuard });
    const first = await dump();
    await recovery.applyRebuild(db, plan, {}, { sessionGuard });
    const second = await dump();

    const different = structuredClone(plan);
    different.items[0].replacement.entry_hash = "different-replacement";
    different.items[0].queueEntry.entry_hash = "different-replacement";
    const beforeDifferent = JSON.stringify(await dump());
    let differentError = "";
    try { await recovery.applyRebuild(db, different, {}, { sessionGuard }); } catch (error) { differentError = error.name; }
    const afterDifferent = JSON.stringify(await dump());

    await seed();
    const beforeAbort = JSON.stringify(await dump());
    const originalAdd = IDBObjectStore.prototype.add;
    let armed = true;
    IDBObjectStore.prototype.add = function (value, key) {
      const added = originalAdd.call(this, value, key);
      if (armed && this.name === "recoveryWork") {
        armed = false;
        queueMicrotask(() => this.transaction.abort());
      }
      return added;
    };
    let aborted = false;
    try { await recovery.applyRebuild(db, plan, {}, { sessionGuard }); } catch { aborted = true; }
    finally { IDBObjectStore.prototype.add = originalAdd; }
    const afterAbort = JSON.stringify(await dump());
    await recovery.applyRebuild(db, plan, {}, { sessionGuard });
    const retried = await dump();
    db.close();
    return {
      queueHashes: first.syncQueue.map((row) => row.entry_hash).sort(),
      replayIdentical: JSON.stringify(first) === JSON.stringify(second),
      workIdentical: JSON.stringify(first.recoveryWork) === JSON.stringify(second.recoveryWork),
      differentError, differentUnchanged: beforeDifferent === afterDifferent,
      aborted, abortUnchanged: beforeAbort === afterAbort,
      retryQueueHashes: retried.syncQueue.map((row) => row.entry_hash).sort()
    };
  });
  expect(result).toEqual({
    queueHashes: ["replacement-one", "replacement-two"], replayIdentical: true, workIdentical: true,
    differentError: "RecoveryCollisionError", differentUnchanged: true,
    aborted: true, abortUnchanged: true, retryQueueHashes: ["replacement-one", "replacement-two"]
  });
});

test("rebuild session guard refuses sign-out, wipe, session, account, token, and expiry changes atomically", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const request = indexedDB.open("confirma-v3-db", 6);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const stores = ["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"];
    const sessionGuard = {
      sessionGeneration: 7, wipeEpoch: 3, boundAccount: "account-a",
      authToken: "fixture-session-token", authTokenExpiresAt: "2999-01-01T00:00:00.000Z"
    };
    const plan = {
      recovery_id: "guard-test", server_head: { entry_id: 0, entry_hash: "head" }, r_copies: [],
      replacement_hashes: { "fixture-original": "fixture-replacement" }, items: [{
        original: { id: 1, entry_hash: "fixture-original", device_identity: "device-a" },
        replacement: { id: 2, entry_hash: "fixture-replacement", device_identity: "device-a" },
        queueEntry: { entry_id: 2, entry_hash: "fixture-replacement", device_identity: "device-a" }
      }]
    };
    const baselineSettings = {
      session_generation: sessionGuard.sessionGeneration, wipe_epoch: sessionGuard.wipeEpoch,
      signed_out: false, wipe_pending: false, bound_account: sessionGuard.boundAccount,
      auth_token: sessionGuard.authToken, auth_token_expires_at: sessionGuard.authTokenExpiresAt,
      recovery_state: { recovery_id: plan.recovery_id, state: "uploaded", remote_ack: true }
    };
    const seed = (overrides = {}) => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      for (const name of stores) tx.objectStore(name).clear();
      Object.entries({ ...baselineSettings, ...overrides })
        .forEach(([key, value]) => tx.objectStore("settings").put({ key, value }));
      tx.objectStore("records").put(plan.items[0].original);
      tx.objectStore("syncQueue").add({
        entry_id: 1, entry_hash: plan.items[0].original.entry_hash, device_identity: "device-a"
      });
      tx.objectStore("recoverySnapshots").put({
        recovery_id: plan.recovery_id, device_identity: "device-a", read_back_verified: true,
        records: [plan.items[0].original], queue: [], outcomes: {}
      });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const dump = () => new Promise((resolve, reject) => {
      const output = {};
      const tx = db.transaction(stores, "readonly");
      for (const name of stores) {
        const get = tx.objectStore(name).getAll(); get.onsuccess = () => { output[name] = get.result; };
      }
      tx.oncomplete = () => resolve(JSON.stringify(output)); tx.onerror = () => reject(tx.error);
    });
    const captureGuard = () => new Promise((resolve, reject) => {
      const keys = ["session_generation", "wipe_epoch", "bound_account", "auth_token", "auth_token_expires_at"];
      const values = {};
      const tx = db.transaction("settings", "readonly");
      for (const key of keys) {
        const get = tx.objectStore("settings").get(key);
        get.onsuccess = () => { values[key] = get.result?.value; };
      }
      tx.oncomplete = () => resolve({
        sessionGeneration: values.session_generation, wipeEpoch: values.wipe_epoch,
        boundAccount: values.bound_account, authToken: values.auth_token,
        authTokenExpiresAt: values.auth_token_expires_at
      });
      tx.onerror = () => reject(tx.error);
    });
    const refuse = async (label, guard = sessionGuard) => {
      const before = await dump();
      let errorName = "";
      let safeMessage = false;
      try { await recovery.applyRebuild(db, plan, {}, { sessionGuard: guard }); }
      catch (error) {
        errorName = error.name;
        const message = String(error.message || "");
        safeMessage = ![sessionGuard.authToken, "replacement-session-token", "fixture-original"]
          .some((value) => message.includes(value));
      }
      const after = await dump();
      return { label, errorName, unchanged: before === after, safeMessage };
    };
    const outcomes = [];
    const cases = [
      ["signed_out_before_call", { signed_out: true }],
      ["wipe_pending", { wipe_pending: true }],
      ["session_generation_bump", { session_generation: sessionGuard.sessionGeneration + 1 }],
      ["wipe_epoch_change", { wipe_epoch: sessionGuard.wipeEpoch + 1 }],
      ["account_switch", { bound_account: "account-b" }],
      ["token_replaced", { auth_token: "replacement-session-token" }],
      ["token_expired", { auth_token_expires_at: "2000-01-01T00:00:00.000Z" }]
    ];
    for (const [label, overrides] of cases) {
      await seed(overrides);
      outcomes.push(await refuse(label));
    }

    await seed();
    const capturedBeforeSignOut = await captureGuard();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      Object.entries({
        signed_out: true, auth_token: "", auth_token_expires_at: "",
        session_generation: capturedBeforeSignOut.sessionGeneration + 1
      }).forEach(([key, value]) => tx.objectStore("settings").put({ key, value }));
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    outcomes.push(await refuse("sign_out_after_guard_capture", capturedBeforeSignOut));
    db.close();
    return outcomes;
  });
  expect(result).toHaveLength(8);
  for (const outcome of result) {
    expect(outcome.errorName).toBe("RecoverySessionChangedError");
    expect(outcome.unchanged).toBe(true);
    expect(outcome.safeMessage).toBe(true);
  }
});

test("rebuild session guard fails closed when missing or malformed and a matching guard rebuilds", async ({ page }) => {
  await openApp(page);
  const result = await page.evaluate(async () => {
    const recovery = await import("/app/recovery-core.js");
    const request = indexedDB.open("confirma-v3-db", 6);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const stores = ["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"];
    const sessionGuard = {
      sessionGeneration: 7, wipeEpoch: 3, boundAccount: "account-a",
      authToken: "fixture-session-token", authTokenExpiresAt: "2999-01-01T00:00:00.000Z"
    };
    const original = { id: 1, entry_hash: "fixture-original", device_identity: "device-a" };
    const replacement = { id: 2, entry_hash: "fixture-replacement", device_identity: "device-a" };
    const plan = {
      recovery_id: "guard-shape-test", server_head: { entry_id: 0, entry_hash: "head" }, r_copies: [],
      replacement_hashes: { "fixture-original": "fixture-replacement" }, items: [{
        original, replacement,
        queueEntry: { entry_id: 2, entry_hash: replacement.entry_hash, device_identity: "device-a" }
      }]
    };
    const seed = () => new Promise((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      for (const name of stores) tx.objectStore(name).clear();
      Object.entries({
        session_generation: sessionGuard.sessionGeneration, wipe_epoch: sessionGuard.wipeEpoch,
        signed_out: false, wipe_pending: false, bound_account: sessionGuard.boundAccount,
        auth_token: sessionGuard.authToken, auth_token_expires_at: sessionGuard.authTokenExpiresAt,
        recovery_state: { recovery_id: plan.recovery_id, state: "uploaded", remote_ack: true }
      }).forEach(([key, value]) => tx.objectStore("settings").put({ key, value }));
      tx.objectStore("records").put(original);
      tx.objectStore("syncQueue").add({ entry_id: 1, entry_hash: original.entry_hash, device_identity: "device-a" });
      tx.objectStore("recoverySnapshots").put({
        recovery_id: plan.recovery_id, device_identity: "device-a", read_back_verified: true,
        records: [original], queue: [], outcomes: {}
      });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    const dump = () => new Promise((resolve, reject) => {
      const output = {};
      const tx = db.transaction(stores, "readonly");
      for (const name of stores) {
        const get = tx.objectStore(name).getAll(); get.onsuccess = () => { output[name] = get.result; };
      }
      tx.oncomplete = () => resolve(output); tx.onerror = () => reject(tx.error);
    });
    const refuse = async (deps) => {
      await seed();
      const before = JSON.stringify(await dump());
      let errorName = "";
      let safeMessage = false;
      try { await recovery.applyRebuild(db, plan, {}, deps); }
      catch (error) {
        errorName = error.name;
        const message = String(error.message || "");
        safeMessage = !message.includes(sessionGuard.authToken) && !message.includes(original.entry_hash);
      }
      const after = JSON.stringify(await dump());
      return { errorName, unchanged: before === after, safeMessage };
    };
    const missing = await refuse(undefined);
    const malformed = await refuse({ sessionGuard: { ...sessionGuard, authToken: "" } });
    await seed();
    await recovery.applyRebuild(db, plan, {}, { sessionGuard });
    const applied = await dump();
    db.close();
    return {
      missing, malformed,
      matchingApplied: applied.records.some((row) => row.entry_hash === replacement.entry_hash)
        && applied.recoveryWork.length === 1,
      matchingSettingsUnchanged: applied.settings.some((row) => (
        row.key === "session_generation" && row.value === sessionGuard.sessionGeneration
      ))
    };
  });
  expect(result.missing).toEqual({
    errorName: "RecoverySessionChangedError", unchanged: true, safeMessage: true
  });
  expect(result.malformed).toEqual({
    errorName: "RecoverySessionChangedError", unchanged: true, safeMessage: true
  });
  expect(result.matchingApplied).toBe(true);
  expect(result.matchingSettingsUnchanged).toBe(true);
});

test("opening the app upgrades a populated v5 database to v6 without changing existing rows", async ({ page }) => {
  await page.route("**/app.js", (route) => route.abort());
  await page.goto("/");
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const remove = indexedDB.deleteDatabase("confirma-v3-db");
      remove.onsuccess = resolve; remove.onerror = () => reject(remove.error);
    });
    const request = indexedDB.open("confirma-v3-db", 5);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const upgradeDb = request.result;
        upgradeDb.createObjectStore("settings", { keyPath: "key" });
        upgradeDb.createObjectStore("records", { keyPath: "id" });
        upgradeDb.createObjectStore("customLabels", { keyPath: "id" });
        upgradeDb.createObjectStore("usage", { keyPath: "normalized_label" });
        upgradeDb.createObjectStore("syncQueue", { keyPath: "queue_id", autoIncrement: true });
        upgradeDb.createObjectStore("voiceCorrections", { keyPath: "raw" });
        upgradeDb.createObjectStore("anomaly_log", { keyPath: "id", autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["settings", "records", "syncQueue"], "readwrite");
      tx.objectStore("settings").put({ key: "fixture", value: "setting-preserved" });
      tx.objectStore("records").put({ id: 7, entry_hash: "record-preserved" });
      tx.objectStore("syncQueue").add({ entry_id: 7, entry_hash: "queue-preserved" });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.unroute("**/app.js");
  await page.reload();
  const result = await page.evaluate(async () => {
    const request = indexedDB.open("confirma-v3-db", 6);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const output = { version: db.version, stores: [...db.objectStoreNames] };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["settings", "records", "syncQueue"], "readonly");
      const reads = {
        setting: tx.objectStore("settings").get("fixture"),
        record: tx.objectStore("records").get(7),
        queue: tx.objectStore("syncQueue").getAll()
      };
      tx.oncomplete = () => {
        output.setting = reads.setting.result; output.record = reads.record.result; output.queue = reads.queue.result;
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return output;
  });
  expect(result.version).toBe(6);
  expect(result.stores).toEqual(expect.arrayContaining(["recoverySnapshots", "recoveryWork"]));
  expect(result.setting).toEqual({ key: "fixture", value: "setting-preserved" });
  expect(result.record).toEqual({ id: 7, entry_hash: "record-preserved" });
  expect(result.queue).toHaveLength(1);
  expect(result.queue[0]).toMatchObject({ entry_id: 7, entry_hash: "queue-preserved" });
});
