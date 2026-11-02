// Pure, device-side primitives for Package C recovery. This module is not
// imported by app.js until the separately approved C3 wiring slice.

export const POSTGRES_TIMESTAMP_CONSERVATIVE_LIMIT_SECONDS = 8_000_000_000;
// Conservative only: C2 must verify the real TO_TIMESTAMP/Postgres boundary.

const FIRST_2000_SECOND = 946684800;
const ONE_DAY_SECONDS = 86400;
const ZERO_HASH = "0".repeat(64);
const UPLOADED_OR_LATER = new Set(["uploaded", "classified", "rebuilt", "synced", "verified", "completed"]);

export class RecoveryPreconditionError extends Error {
  constructor(message = "Recovery preservation preconditions are not satisfied.") {
    super(message);
    this.name = "RecoveryPreconditionError";
  }
}

export class RecoveryCollisionError extends Error {
  constructor(message = "Recovery plan no longer matches the preserved local state.") {
    super(message);
    this.name = "RecoveryCollisionError";
  }
}

export class RecoverySessionChangedError extends Error {
  constructor(message = "Recovery stopped because the signed-in session changed.") {
    super(message);
    this.name = "RecoverySessionChangedError";
  }
}

export function buildCanonical(record, id, confirmedAt, prevHash) {
  return [
    id,
    record.transaction_type,
    record.normalized_label,
    record.amount_minor,
    record.currency,
    record.counterparty,
    record.business_type_id,
    record.country,
    record.source_account,
    record.destination_account,
    record.reversed_entry_hash,
    record.reversed_transaction_type,
    confirmedAt,
    prevHash
  ].map((value) => value == null ? "" : String(value)).join("|");
}

// receivedBoundSeconds is the receipt time used to compute the contract's
// upper bound. The following 24 hours distinguish a merely future timestamp
// from one past the day-after-receipt bound.
export function classifyDate(confirmedAt, { receivedBoundSeconds } = {}) {
  if (typeof confirmedAt !== "number" || !confirmedAt || !Number.isFinite(confirmedAt)
    || Math.abs(confirmedAt) > POSTGRES_TIMESTAMP_CONSERVATIVE_LIMIT_SECONDS) {
    return "unrepresentable";
  }
  if (confirmedAt < FIRST_2000_SECOND) return "before_2000";
  if (typeof receivedBoundSeconds === "number" && Number.isFinite(receivedBoundSeconds)) {
    if (confirmedAt > receivedBoundSeconds + ONE_DAY_SECONDS) return "after_receipt_bound";
    if (confirmedAt > receivedBoundSeconds) return "future";
  }
  return "ok";
}

function recordsFrom(localState) {
  return localState?.localRecords || localState?.records || localState?.stores?.records || [];
}

function queueFrom(localState) {
  return localState?.localQueue || localState?.syncQueue || localState?.stores?.syncQueue || [];
}

function settingValue(localState, key) {
  if (localState?.settings && !Array.isArray(localState.settings)) return localState.settings[key];
  const rows = Array.isArray(localState?.settings) ? localState.settings : localState?.stores?.settings;
  return Array.isArray(rows) ? rows.find((row) => row?.key === key)?.value : undefined;
}

function queueHasForkHistory(entry) {
  const values = [entry?.status, entry?.last_error, entry?.error_code, entry?.rejection_code, entry?.failure_reason,
    ...(Array.isArray(entry?.history) ? entry.history.flatMap((item) => [item?.status, item?.code, item?.error]) : [])];
  return values.some((value) => /fork_(?:id_conflict|continuity)|hash_mismatch/i.test(String(value || "")));
}

export function detectSuspect(localState) {
  const records = recordsFrom(localState);
  const queue = queueFrom(localState);
  const deviceIdentity = String(localState?.deviceIdentity || settingValue(localState, "device_identity") || "");
  const reasons = [];
  if (records.some((row) => row?.importedFromServer && row?.device_identity === deviceIdentity)) {
    reasons.push("own_imported_copy");
  }
  const own = records.filter((row) => !row?.importedFromServer && (!deviceIdentity || row?.device_identity === deviceIdentity));
  const seenIds = new Set();
  const ownHashById = new Map();
  let previous = null;
  for (const row of own) {
    const idKey = String(row?.id);
    if (seenIds.has(idKey)) reasons.push("own_id_duplicate");
    seenIds.add(idKey);
    ownHashById.set(idKey, String(row?.entry_hash || ""));
    if (previous && row?.prev_entry_hash !== previous?.entry_hash) reasons.push("hash_chain_break");
    previous = row;
  }
  for (const entry of queue) {
    const idKey = String(entry?.entry_id ?? entry?.entry_payload?.id ?? "");
    const hash = String(entry?.entry_hash || entry?.entry_payload?.entry_hash || "");
    if (idKey && ownHashById.has(idKey) && ownHashById.get(idKey) !== hash) reasons.push("own_id_duplicate");
  }
  if (settingValue(localState, "fork_recovery_pending")) reasons.push("fork_recovery_pending");
  if (queue.some(queueHasForkHistory)) reasons.push("queue_fork_rejection");
  const uniqueReasons = [...new Set(reasons)];
  return { suspect: uniqueReasons.length > 0, reasons: uniqueReasons };
}

function serverId(row) {
  return Number(row?.entry_id ?? row?.id);
}

function localId(row) {
  return Number(row?.id);
}

function serverHash(row) {
  return String(row?.entry_hash || "");
}

function rowIdentity(row) {
  return String(row?.device_identity || "");
}

async function verifyLocalRow(row, deps, canonicalId = row?.id) {
  try {
    if (!row?.entry_hash || !row?.signature) return { valid: false, reason: "missing_hash_or_signature" };
    const computed = await deps.sha256(buildCanonical(row, canonicalId, row.confirmed_at, row.prev_entry_hash));
    if (computed !== row.entry_hash) return { valid: false, reason: "hash_mismatch" };
    if (!(await deps.verifySignature(row.entry_hash, row.signature))) return { valid: false, reason: "signature_invalid" };
    return { valid: true };
  } catch {
    return { valid: false, reason: "signature_invalid" };
  }
}

export async function classifyRecords({
  localRecords = [], localQueue = [], serverRecords = [], serverHead = null, deviceIdentity,
  receivedBoundSeconds
}, deps) {
  const accepted = [];
  const R = [];
  const xValid = [];
  const xInvalid = [];
  const unexplained = [];
  const dateChecks = [];
  const ownServer = serverRecords.filter((row) => rowIdentity(row) === String(deviceIdentity));
  const serverById = new Map(ownServer.map((row) => [serverId(row), row]));
  const queueByHash = new Map(localQueue.map((item) => [String(item?.entry_hash || item?.entry_payload?.entry_hash || ""), item]));

  for (const [originalOrder, row] of localRecords.entries()) {
    if (row?.importedFromServer && rowIdentity(row) === String(deviceIdentity)) {
      const trueId = Number(row.server_entry_id ?? row.id);
      const match = serverById.get(trueId);
      const proof = match && serverHash(match) === serverHash(row) ? await verifyLocalRow(row, deps, trueId) : null;
      if (proof?.valid) R.push({ record: row, serverRecord: match, trueId, original_order: originalOrder });
      else unexplained.push({ record: row, reason: proof?.reason || "own_import_not_server_matched", original_order: originalOrder });
      continue;
    }
    if (row?.importedFromServer) continue;
    if (rowIdentity(row) !== String(deviceIdentity)) {
      const item = { record: row, queueEntry: queueByHash.get(serverHash(row)), reason: "wrong_device_identity" };
      item.original_order = originalOrder;
      xInvalid.push(item);
      unexplained.push(item);
      continue;
    }
    const match = serverById.get(localId(row));
    if (match && serverHash(match) === serverHash(row)) {
      accepted.push({ record: row, serverRecord: match, original_order: originalOrder });
    }
  }

  const alreadyHandled = new Set([
    ...accepted.map((item) => item.record), ...R.map((item) => item.record),
    ...xInvalid.map((item) => item.record)
  ]);
  const candidates = localRecords.filter((row) => !row?.importedFromServer && !alreadyHandled.has(row));
  const validByHash = new Map();
  const invalidHashes = new Set(xInvalid.map((item) => serverHash(item.record)).filter(Boolean));

  for (const row of candidates) {
    const originalOrder = localRecords.indexOf(row);
    const dateCheck = classifyDate(row.confirmed_at, { receivedBoundSeconds });
    dateChecks.push({ entry_hash: row.entry_hash, date_check: dateCheck });
    const queueEntry = queueByHash.get(serverHash(row));
    const proof = await verifyLocalRow(row, deps);
    if (!proof.valid) {
      const item = { record: row, queueEntry, reason: proof.reason, date_check: dateCheck, not_replaceable: true, original_order: originalOrder };
      xInvalid.push(item);
      unexplained.push(item);
      invalidHashes.add(serverHash(row));
      continue;
    }
    const collision = serverById.get(localId(row));
    const parent = validByHash.get(String(row.prev_entry_hash || ""));
    const chainsOnInvalid = invalidHashes.has(String(row.prev_entry_hash || ""));
    const predecessor = serverById.get(localId(row) - 1);
    const collisionHasKnownAnchor = Boolean(collision && serverHash(collision) !== serverHash(row)
      && ((localId(row) === 1 && row.prev_entry_hash === ZERO_HASH)
        || (predecessor && serverHash(predecessor) === row.prev_entry_hash)));
    const matchesPattern = collisionHasKnownAnchor || Boolean(parent);
    if (!matchesPattern || chainsOnInvalid) {
      const item = {
        record: row, queueEntry, date_check: dateCheck, not_replaceable: true,
        reason: chainsOnInvalid ? "chains_on_invalid_row" : "failure_pattern_unexplained",
        original_order: originalOrder
      };
      unexplained.push(item);
      invalidHashes.add(serverHash(row));
      continue;
    }
    const item = {
      record: row,
      queueEntry,
      date_check: dateCheck,
      not_replaceable: dateCheck === "unrepresentable",
      anchor: parent ? "x_valid_parent" : "server_id_collision",
      original_order: originalOrder
    };
    xValid.push(item);
    validByHash.set(serverHash(row), item);
  }

  // A supplied head is a classification input even if its record is not in
  // the page; retaining the reference makes the returned result auditable.
  return { accepted, R, xValid, xInvalid, unexplained, dateChecks, serverHead };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
  });
}

function isPrivateMaterial(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if ((value.type === "private" && value.algorithm) || (value.kty && typeof value.d === "string")) return true;
  return Object.entries(value).some(([key, child]) => /private[_-]?key/i.test(key) || isPrivateMaterial(child, seen));
}

function deepEqual(left, right, seen = new WeakMap()) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (seen.get(left) === right) return true;
  seen.set(left, right);
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key], seen));
}

export async function takeSnapshot(db, { deviceIdentity, publicKeyFingerprint, appVersion, recoveryId } = {}) {
  const tx = db.transaction(["records", "syncQueue", "settings", "recoverySnapshots"], "readwrite");
  const txDone = transactionDone(tx);
  const snapshotStore = tx.objectStore("recoverySnapshots");
  const settings = tx.objectStore("settings");
  const recoveryState = await requestResult(settings.get("recovery_state"));
  const resolvedRecoveryId = recoveryId || recoveryState?.value?.recovery_id;
  if (!resolvedRecoveryId) {
    tx.abort();
    await txDone.catch(() => {});
    throw new Error("A recovery id is required before snapshotting.");
  }
  let snapshot = await requestResult(snapshotStore.get(resolvedRecoveryId));
  if (snapshot) {
    if (String(snapshot.device_identity || "") !== String(deviceIdentity || "")) {
      tx.abort();
      await txDone.catch(() => {});
      throw new RecoveryCollisionError("Recovery snapshot belongs to a different device identity.");
    }
  } else {
    const [records, queue, pendingMarker] = await Promise.all([
      requestResult(tx.objectStore("records").getAll()),
      requestResult(tx.objectStore("syncQueue").getAll()),
      requestResult(settings.get("fork_recovery_pending"))
    ]);
    const ownRecords = records.filter((row) => row?.device_identity === deviceIdentity);
    const ownHashes = new Set(ownRecords.map((row) => row?.entry_hash).filter(Boolean));
    const ownQueue = queue.filter((item) => item?.device_identity === deviceIdentity
      || ownHashes.has(item?.entry_hash) || ownHashes.has(item?.entry_payload?.entry_hash));
    snapshot = {
      recovery_id: resolvedRecoveryId,
      device_identity: deviceIdentity,
      public_key_fingerprint: publicKeyFingerprint,
      app_version: appVersion,
      records: ownRecords,
      queue: ownQueue,
      classification_inputs: {
        fork_recovery_pending: pendingMarker?.value ?? null,
        recovery_state: recoveryState?.value ?? null
      },
      read_back_verified: false,
      outcomes: {}
    };
    if (isPrivateMaterial(snapshot)) {
      tx.abort();
      await txDone.catch(() => {});
      throw new Error("Snapshot contains prohibited key material.");
    }
    snapshotStore.add(snapshot);
  }
  if (isPrivateMaterial(snapshot)) {
    tx.abort();
    await txDone.catch(() => {});
    throw new Error("Snapshot contains prohibited key material.");
  }
  await txDone;

  const readTx = db.transaction("recoverySnapshots", "readonly");
  const readDone = transactionDone(readTx);
  const stored = await requestResult(readTx.objectStore("recoverySnapshots").get(resolvedRecoveryId));
  await readDone;
  const originalForComparison = { ...snapshot, read_back_verified: false };
  const storedForComparison = stored && { ...stored, read_back_verified: false };
  if (!stored || !deepEqual(originalForComparison, storedForComparison) || isPrivateMaterial(stored)) {
    throw new Error("Snapshot read-back verification failed.");
  }
  if (String(stored.device_identity || "") !== String(deviceIdentity || "")) {
    throw new RecoveryCollisionError("Recovery snapshot belongs to a different device identity.");
  }
  if (stored.read_back_verified === true) return stored;

  const completeTx = db.transaction("recoverySnapshots", "readwrite");
  const completeDone = transactionDone(completeTx);
  const completeStore = completeTx.objectStore("recoverySnapshots");
  const latest = await requestResult(completeStore.get(resolvedRecoveryId));
  if (!latest || isPrivateMaterial(latest)
    || String(latest.device_identity || "") !== String(deviceIdentity || "")) {
    completeTx.abort();
    await completeDone.catch(() => {});
    throw new RecoveryCollisionError("Recovery snapshot changed during verification.");
  }
  if (latest.read_back_verified !== true) {
    await requestResult(completeStore.put({ ...latest, read_back_verified: true }));
  }
  await completeDone;
  return latest.read_back_verified === true ? latest : { ...latest, read_back_verified: true };
}

function headId(serverHead) {
  return Number(serverHead?.entry_id ?? serverHead?.id ?? 0);
}

function headHash(serverHead) {
  return String(serverHead?.entry_hash || ZERO_HASH);
}

export async function planReplacements({ xValid = [], R = [], serverHead, recoveryId, localQueue = [], receivedBoundSeconds }, deps) {
  const ordered = [...xValid].sort((left, right) => (
    Number(left?.original_order ?? 0) - Number(right?.original_order ?? 0)
  ));
  const xHashes = new Set(ordered.map((item) => serverHash(item.record)));
  const replacementByOriginalHash = new Map();
  const items = [];
  let nextId = headId(serverHead) + 1;
  let previousHash = headHash(serverHead);

  for (const source of ordered) {
    const original = source.record;
    const dateCheck = source.date_check || classifyDate(original.confirmed_at, { receivedBoundSeconds });
    let notReplaceable = Boolean(source.not_replaceable || dateCheck === "unrepresentable");
    let reason = notReplaceable ? "unrepresentable_date" : null;
    let reversedHash = original.reversed_entry_hash;
    if (!notReplaceable && reversedHash && xHashes.has(reversedHash)) {
      if (!replacementByOriginalHash.has(reversedHash)) {
        notReplaceable = true;
        reason = "reversal_target_not_replaceable";
      } else {
        reversedHash = replacementByOriginalHash.get(reversedHash);
      }
    }
    if (notReplaceable) {
      items.push({ original, replacement: null, date_check: dateCheck, not_replaceable: true, reason });
      continue;
    }
    const replacement = {
      ...original,
      id: nextId,
      confirmed_at: original.confirmed_at,
      prev_entry_hash: previousHash,
      reversed_entry_hash: reversedHash
    };
    replacement.entry_hash = await deps.sha256(buildCanonical(replacement, nextId, original.confirmed_at, previousHash));
    replacement.signature = await deps.sign(replacement.entry_hash);
    const queueEntry = {
      entry_id: replacement.id,
      entry_hash: replacement.entry_hash,
      device_identity: replacement.device_identity,
      status: "queued",
      attempt_count: 0,
      queued_at: deps.now(),
      entry_payload: replacement
    };
    items.push({ original, replacement, queueEntry, date_check: dateCheck, not_replaceable: false });
    replacementByOriginalHash.set(original.entry_hash, replacement.entry_hash);
    previousHash = replacement.entry_hash;
    nextId += 1;
  }
  return {
    recovery_id: recoveryId,
    server_head: serverHead,
    items,
    r_copies: R,
    original_queue: localQueue,
    replacement_hashes: Object.fromEntries(replacementByOriginalHash)
  };
}

function queueMatchesOriginal(queueItem, original) {
  const queueHash = String(queueItem?.entry_hash || queueItem?.entry_payload?.entry_hash || "");
  const queueId = Number(queueItem?.entry_id ?? queueItem?.entry_payload?.id);
  const queueDevice = String(queueItem?.device_identity || queueItem?.entry_payload?.device_identity || "");
  return queueHash === String(original?.entry_hash || "")
    && queueId === Number(original?.id)
    && queueDevice === String(original?.device_identity || "");
}

function replacementSignature(items = []) {
  return items.map((item) => ({
    original_hash: String(item?.original?.entry_hash || ""),
    replacement_hash: item?.replacement ? String(item.replacement.entry_hash || "") : null
  }));
}

function recordMatches(row, expected) {
  return Boolean(row && expected
    && String(row.entry_hash || "") === String(expected.entry_hash || "")
    && String(row.device_identity || "") === String(expected.device_identity || ""));
}

function isValidSessionGuard(guard) {
  const owns = (key) => Object.prototype.hasOwnProperty.call(guard, key);
  return Boolean(guard && typeof guard === "object" && !Array.isArray(guard)
    && owns("sessionGeneration") && owns("wipeEpoch") && owns("boundAccount") && owns("authToken")
    && Number.isSafeInteger(guard.sessionGeneration) && guard.sessionGeneration >= 0
    && Number.isSafeInteger(guard.wipeEpoch) && guard.wipeEpoch >= 0
    && typeof guard.boundAccount === "string" && guard.boundAccount.length > 0
    && typeof guard.authToken === "string" && guard.authToken.length > 0
    && (!Object.prototype.hasOwnProperty.call(guard, "authTokenExpiresAt")
      || typeof guard.authTokenExpiresAt === "string"));
}

function storedSessionMatchesGuard(values, guard) {
  const expiresAtMs = new Date(values.get("auth_token_expires_at")).getTime();
  return Number(values.get("session_generation") || 0) === Number(guard.sessionGeneration || 0)
    && Number(values.get("wipe_epoch") || 0) === Number(guard.wipeEpoch || 0)
    && values.get("signed_out") !== true
    && values.get("wipe_pending") !== true
    && String(values.get("bound_account") || "") === String(guard.boundAccount || "")
    && String(values.get("auth_token") || "") === String(guard.authToken || "")
    && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
}

// The caller must capture one sessionGuard before starting asynchronous work
// and carry it unchanged. Never capture a fresh guard after an await to
// authorize a response produced for an older session.
export function applyRebuild(db, plan, state = {}, deps = {}) {
  const suppliedSessionGuard = deps?.sessionGuard;
  if (!isValidSessionGuard(suppliedSessionGuard)) {
    return Promise.reject(new RecoverySessionChangedError());
  }
  const sessionGuard = {
    sessionGeneration: suppliedSessionGuard.sessionGeneration,
    wipeEpoch: suppliedSessionGuard.wipeEpoch,
    boundAccount: suppliedSessionGuard.boundAccount,
    authToken: suppliedSessionGuard.authToken,
    ...(Object.prototype.hasOwnProperty.call(suppliedSessionGuard, "authTokenExpiresAt")
      ? { authTokenExpiresAt: suppliedSessionGuard.authTokenExpiresAt }
      : {})
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["settings", "records", "syncQueue", "recoverySnapshots", "recoveryWork"], "readwrite");
    const settings = tx.objectStore("settings");
    const snapshots = tx.objectStore("recoverySnapshots");
    const recoveryId = plan?.recovery_id || state?.recovery_id;
    let startedMutations = false;
    let failure = null;
    const fail = (error) => {
      failure = error;
      try { tx.abort(); } catch { /* transaction already inactive */ }
    };
    const inspectPreservationState = () => {
      const stateRequest = settings.get("recovery_state");
      stateRequest.onerror = () => fail(stateRequest.error || new RecoveryPreconditionError());
      stateRequest.onsuccess = () => {
      const durableState = stateRequest.result?.value;
      if (!durableState || durableState.recovery_id !== recoveryId
        || !UPLOADED_OR_LATER.has(durableState.state) || durableState.remote_ack !== true) {
        fail(new RecoveryPreconditionError());
        return;
      }
      const snapshotRequest = snapshots.get(recoveryId);
      snapshotRequest.onerror = () => fail(snapshotRequest.error || new RecoveryPreconditionError());
      snapshotRequest.onsuccess = () => {
        const snapshot = snapshotRequest.result;
        if (!snapshot?.read_back_verified) {
          fail(new RecoveryPreconditionError());
          return;
        }
        const workStore = tx.objectStore("recoveryWork");
        const workRequest = workStore.get(recoveryId);
        workRequest.onerror = () => fail(workRequest.error || new Error("Could not inspect recovery work."));
        workRequest.onsuccess = () => {
          try {
            const existingWork = workRequest.result;
            if (existingWork && !deepEqual(replacementSignature(existingWork.items), replacementSignature(plan.items))) {
              fail(new RecoveryCollisionError("A different replacement plan is already persisted for this recovery id."));
              return;
            }
            const effectiveItems = existingWork?.items || plan.items || [];
            const effectiveRCopies = existingWork?.r_copies || plan.r_copies || [];
            const records = tx.objectStore("records");
            const queue = tx.objectStore("syncQueue");
            const recordsRequest = records.getAll();
            const queueRequest = queue.getAll();
            let currentRecords;
            let currentQueue;
            const inspect = () => {
              if (!currentRecords || !currentQueue) return;
              try {
                const recordById = new Map(currentRecords.map((row) => [Number(row.id), row]));
                const replaceable = effectiveItems.filter((item) => item.replacement);
                const originals = effectiveItems.map((item) => item.original);
                const replacementHashes = new Set(replaceable.map((item) => String(item.replacement.entry_hash || "")));
                const restored = effectiveRCopies.map((item) => {
                  const copy = item.record || item;
                  return { source: copy, destination: {
                    ...copy, id: Number(item.trueId ?? copy.server_entry_id), importedFromServer: false, restoredOwn: true
                  } };
                });
                const destinations = [
                  ...restored.map((item) => item.destination),
                  ...replaceable.map((item) => item.replacement)
                ];
                const intendedById = new Map();
                for (const destination of destinations) {
                  const prior = intendedById.get(Number(destination.id));
                  if (prior && !recordMatches(prior, destination)) {
                    throw new RecoveryCollisionError("The recovery plan contains conflicting destination rows.");
                  }
                  intendedById.set(Number(destination.id), destination);
                }
                const sourceRows = [...originals, ...restored.map((item) => item.source)];
                const isApplied = Boolean(existingWork)
                  && destinations.every((destination) => recordMatches(recordById.get(Number(destination.id)), destination))
                  && sourceRows.every((source) => {
                    const intended = intendedById.get(Number(source.id));
                    const current = recordById.get(Number(source.id));
                    return intended ? recordMatches(current, intended) : !current;
                  })
                  && replaceable.every((item) => currentQueue.some((queued) => (
                    String(queued?.entry_hash || queued?.entry_payload?.entry_hash || "")
                      === String(item.replacement.entry_hash || "")
                  )))
                  && originals.every((original) => !currentQueue.some((queued) => queueMatchesOriginal(queued, original)));
                if (isApplied) return;

                for (const source of sourceRows) {
                  const current = recordById.get(Number(source.id));
                  if (!recordMatches(current, source)) {
                    throw new RecoveryCollisionError("A recovery source row is missing or changed.");
                  }
                  const preserved = Array.isArray(snapshot.records)
                    ? snapshot.records.find((row) => Number(row.id) === Number(source.id))
                    : null;
                  if (!recordMatches(preserved, source)) {
                    throw new RecoveryCollisionError("A recovery source row does not match the immutable snapshot.");
                  }
                }
                const removableById = new Map(sourceRows.map((source) => [Number(source.id), source]));
                for (const destination of destinations) {
                  const occupant = recordById.get(Number(destination.id));
                  if (!occupant || recordMatches(occupant, destination)) continue;
                  const removable = removableById.get(Number(destination.id));
                  if (!recordMatches(occupant, removable)) {
                    throw new RecoveryCollisionError("A recovery destination is occupied by an unrelated row.");
                  }
                }

                const work = existingWork || {
                  recovery_id: recoveryId,
                  server_head: plan.server_head,
                  items: plan.items,
                  r_copies: plan.r_copies || [],
                  replacement_hashes: plan.replacement_hashes,
                  persisted_before_rebuild: true
                };
                if (isPrivateMaterial(work)) throw new Error("Recovery work contains prohibited key material.");
                snapshots.put({
                  ...snapshot,
                  outcomes: {
                    ...(snapshot.outcomes || {}),
                    ...Object.fromEntries(effectiveRCopies.map((item) => {
                      const record = item.record || item;
                      return [record.entry_hash, { outcome: "restored", true_id: Number(item.trueId ?? record.server_entry_id) }];
                    })),
                    ...Object.fromEntries(effectiveItems.map((item) => [item.original.entry_hash, item.replacement
                      ? { outcome: "replaced", replacement_hash: item.replacement.entry_hash }
                      : { outcome: "unresolved", reason: item.reason }]))
                  }
                });
                if (!existingWork) workStore.add(work);
                startedMutations = true;

                for (const queued of currentQueue) {
                  if (!replacementHashes.has(String(queued?.entry_hash || queued?.entry_payload?.entry_hash || ""))
                    && originals.some((original) => queueMatchesOriginal(queued, original))) {
                    queue.delete(queued.queue_id);
                  }
                }
                for (const source of sourceRows) records.delete(source.id);
                for (const destination of destinations) records.put(destination);
                for (const item of replaceable) {
                  const alreadyQueued = currentQueue.some((queued) => (
                    String(queued?.entry_hash || queued?.entry_payload?.entry_hash || "")
                      === String(item.replacement.entry_hash || "")
                  ));
                  if (!alreadyQueued) queue.add(item.queueEntry);
                }
              } catch (error) {
                fail(error);
              }
            };
            recordsRequest.onerror = () => fail(recordsRequest.error || new Error("Could not inspect recovery records."));
            queueRequest.onerror = () => fail(queueRequest.error || new Error("Could not inspect recovery queue."));
            recordsRequest.onsuccess = () => { currentRecords = recordsRequest.result || []; inspect(); };
            queueRequest.onsuccess = () => { currentQueue = queueRequest.result || []; inspect(); };
          } catch (error) {
            fail(error);
          }
        };
      };
      };
    };
    const guardKeys = [
      "session_generation", "wipe_epoch", "signed_out", "wipe_pending",
      "bound_account", "auth_token", "auth_token_expires_at"
    ];
    const guardValues = new Map();
    for (const key of guardKeys) {
      const request = settings.get(key);
      request.onerror = () => fail(request.error || new RecoverySessionChangedError());
      request.onsuccess = () => {
        guardValues.set(key, request.result?.value);
        if (guardValues.size !== guardKeys.length) return;
        if (!storedSessionMatchesGuard(guardValues, sessionGuard)) {
          fail(new RecoverySessionChangedError());
          return;
        }
        inspectPreservationState();
      };
    }
    tx.oncomplete = () => resolve({ applied: true, recovery_id: recoveryId });
    tx.onerror = () => { /* onabort supplies the stable error */ };
    tx.onabort = () => reject(failure || tx.error || (startedMutations
      ? new Error("Recovery rebuild transaction aborted.")
      : new RecoveryPreconditionError()));
  });
}
