const RECOVERY_STATE_KEY = "recovery_state";
const RECOVERY_PENDING_KEY = "fork_recovery_pending";
const RECOVERY_HISTORY_KEY = "recovery_history";
const ZERO_HASH = "0".repeat(64);

// Three identical completed incidents are the bounded automatic-recovery limit;
// a fourth matching detection is held for review without creating a server session.
export const MAX_CONSECUTIVE_IDENTICAL_RECOVERIES = 3;

export const RECOVERY_STATES = Object.freeze([
  "suspect",
  "snapshotted",
  "uploaded",
  "classified",
  "rebuilt",
  "synced",
  "verified",
  "completed",
  "escalated"
]);

const ACTIVE_RECOVERY_STATES = new Set(RECOVERY_STATES.filter((value) => value !== "completed"));

export class RecoveryStateChangedError extends Error {
  constructor(message = "Recovery stopped because its saved state changed.") {
    super(message);
    this.name = "RecoveryStateChangedError";
  }
}

export class RecoveryGuardError extends Error {
  constructor(message = "Recovery stopped because the signed-in session changed.") {
    super(message);
    this.name = "RecoveryGuardError";
  }
}

export class RecoveryPlanChangedError extends Error {
  constructor(message = "Recovery stopped because its saved replacement plan changed.") {
    super(message);
    this.name = "RecoveryPlanChangedError";
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// This deliberately mirrors server/src/routes/recovery.js byte for byte:
// recursively sorted object keys, preserved array order and standard JSON
// scalar spelling. Undefined and non-finite values fail closed.
export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid_json_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  throw new Error("invalid_json_value");
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Canonical(value) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function buildDetectionFingerprint({ reasons = [], entryHashes = [] } = {}) {
  const sortedUnique = (values) => [...new Set((values || []).map(String).filter(Boolean))].sort();
  return sha256Canonical({
    reasons: sortedUnique(reasons),
    entry_hashes: sortedUnique(entryHashes)
  });
}

export function consecutiveCompletedRecoveryCount(history, currentCompleted, detectionFingerprint) {
  const incidents = [
    ...(Array.isArray(history) ? history : []),
    ...(currentCompleted ? [currentCompleted] : [])
  ];
  let count = 0;
  for (let index = incidents.length - 1; index >= 0; index -= 1) {
    const incident = incidents[index];
    if (incident?.state !== "completed" || incident?.detection_fingerprint !== detectionFingerprint) break;
    count += 1;
  }
  return count;
}

export async function recoveryPartSha256({ records, queue }) {
  return sha256Canonical({ records, queue });
}

export function isRecoveryStateActive(value) {
  return Boolean(value && ACTIVE_RECOVERY_STATES.has(value.state));
}

export function recoveryResponseAllowsUnlock(response) {
  return response?.accounted_for === true;
}

export async function readRecoveryState(db) {
  const transaction = db.transaction("settings", "readonly");
  const done = transactionDone(transaction);
  const row = await requestResult(transaction.objectStore("settings").get(RECOVERY_STATE_KEY));
  await done;
  return row?.value || null;
}

export async function readRecoverySnapshot(db, recoveryId) {
  const transaction = db.transaction("recoverySnapshots", "readonly");
  const done = transactionDone(transaction);
  const value = await requestResult(transaction.objectStore("recoverySnapshots").get(recoveryId));
  await done;
  return value || null;
}

export async function readRecoveryWork(db, recoveryId) {
  const transaction = db.transaction("recoveryWork", "readonly");
  const done = transactionDone(transaction);
  const value = await requestResult(transaction.objectStore("recoveryWork").get(recoveryId));
  await done;
  return value || null;
}

function validGuard(guard) {
  return Boolean(guard
    && Number.isSafeInteger(guard.sessionGeneration)
    && guard.sessionGeneration >= 0
    && Number.isSafeInteger(guard.wipeEpoch)
    && guard.wipeEpoch >= 0
    && typeof guard.boundAccount === "string"
    && guard.boundAccount.length > 0
    && typeof guard.authToken === "string"
    && guard.authToken.length > 0);
}

function guardMatches(values, guard) {
  const expiry = new Date(values.get("auth_token_expires_at")).getTime();
  return validGuard(guard)
    && Number(values.get("session_generation") || 0) === guard.sessionGeneration
    && Number(values.get("wipe_epoch") || 0) === guard.wipeEpoch
    && values.get("signed_out") !== true
    && values.get("wipe_pending") !== true
    && String(values.get("bound_account") || "") === guard.boundAccount
    && String(values.get("auth_token") || "") === guard.authToken
    && Number.isFinite(expiry)
    && expiry > Date.now();
}

async function readGuardValues(settings) {
  const keys = [
    "session_generation",
    "wipe_epoch",
    "signed_out",
    "wipe_pending",
    "bound_account",
    "auth_token",
    "auth_token_expires_at"
  ];
  const rows = await Promise.all(keys.map((key) => requestResult(settings.get(key))));
  return new Map(keys.map((key, index) => [key, rows[index]?.value]));
}

function abortWith(transaction, error) {
  try {
    transaction.abort();
  } catch {
    // The transaction can already be inactive after a storage failure.
  }
  return error;
}

export async function beginRecoveryState(db, {
  recoveryId,
  deviceIdentity,
  boundAccount,
  reasons,
  detectionFingerprint = "",
  expectedCompletedState = null,
  guard,
  startedAt = Date.now()
}) {
  if (!validGuard(guard)) throw new RecoveryGuardError();
  const transaction = db.transaction("settings", "readwrite");
  const done = transactionDone(transaction);
  const settings = transaction.objectStore("settings");
  let failure = null;
  try {
    const [values, existingRow, pendingRow, historyRow] = await Promise.all([
      readGuardValues(settings),
      requestResult(settings.get(RECOVERY_STATE_KEY)),
      requestResult(settings.get(RECOVERY_PENDING_KEY)),
      requestResult(settings.get(RECOVERY_HISTORY_KEY))
    ]);
    if (!guardMatches(values, guard)) throw new RecoveryGuardError();
    const existing = existingRow?.value;
    if (existing) {
      if (existing.device_identity !== deviceIdentity || existing.bound_account !== boundAccount) {
        throw new RecoveryStateChangedError();
      }
      const replacingExpectedCompleted = Boolean(
        expectedCompletedState
        && existing.recovery_id === expectedCompletedState.recovery_id
        && existing.state === "completed"
        && expectedCompletedState.state === "completed"
      );
      if (!replacingExpectedCompleted) {
        await done;
        return existing;
      }
      const history = historyRow?.value == null ? [] : historyRow.value;
      if (!Array.isArray(history) || history.some((incident) => incident?.recovery_id === existing.recovery_id)) {
        throw new RecoveryStateChangedError("Recovery history no longer matches the completed incident.");
      }
      if (!recoveryId || recoveryId === existing.recovery_id
        || history.some((incident) => incident?.recovery_id === recoveryId)) {
        throw new RecoveryStateChangedError("A fresh recovery id is required for a new incident.");
      }
      const repeatedCount = consecutiveCompletedRecoveryCount(history, existing, detectionFingerprint);
      const next = {
        recovery_id: recoveryId,
        state: repeatedCount >= MAX_CONSECUTIVE_IDENTICAL_RECOVERIES ? "escalated" : "suspect",
        started_at: startedAt,
        device_identity: deviceIdentity,
        bound_account: boundAccount,
        detection_fingerprint: detectionFingerprint,
        cursor: null,
        attempts: 0,
        remote_ack: false
      };
      settings.put({ key: RECOVERY_HISTORY_KEY, value: [...history, existing] });
      settings.put({ key: RECOVERY_STATE_KEY, value: next });
      if (!pendingRow?.value) {
        settings.put({
          key: RECOVERY_PENDING_KEY,
          value: {
            cases: [{
              source: "local_detection",
              reasons: [...new Set((reasons || []).map(String))],
              received_at: startedAt
            }],
            updated_at: startedAt
          }
        });
      }
      await done;
      return next;
    }
    if (expectedCompletedState) throw new RecoveryStateChangedError();
    const next = {
      recovery_id: recoveryId,
      state: "suspect",
      started_at: startedAt,
      device_identity: deviceIdentity,
      bound_account: boundAccount,
      detection_fingerprint: detectionFingerprint,
      cursor: null,
      attempts: 0,
      remote_ack: false
    };
    settings.add({ key: RECOVERY_STATE_KEY, value: next });
    if (!pendingRow?.value) {
      settings.put({
        key: RECOVERY_PENDING_KEY,
        value: {
          cases: [{
            source: "local_detection",
            reasons: [...new Set((reasons || []).map(String))],
            received_at: startedAt
          }],
          updated_at: startedAt
        }
      });
    }
    await done;
    return next;
  } catch (error) {
    failure = error;
    abortWith(transaction, error);
    await done.catch(() => {});
    throw failure;
  }
}

export async function transitionRecoveryState(db, {
  recoveryId,
  expectedStates,
  nextState,
  guard,
  patch = {},
  removePending = false
}) {
  if (!RECOVERY_STATES.includes(nextState)) throw new RecoveryStateChangedError();
  if (!validGuard(guard)) throw new RecoveryGuardError();
  const expected = new Set(Array.isArray(expectedStates) ? expectedStates : [expectedStates]);
  const transaction = db.transaction("settings", "readwrite");
  const done = transactionDone(transaction);
  const settings = transaction.objectStore("settings");
  try {
    const [values, row] = await Promise.all([
      readGuardValues(settings),
      requestResult(settings.get(RECOVERY_STATE_KEY))
    ]);
    if (!guardMatches(values, guard)) throw new RecoveryGuardError();
    const current = row?.value;
    if (!current || current.recovery_id !== recoveryId || !expected.has(current.state)) {
      throw new RecoveryStateChangedError();
    }
    const next = { ...current, ...patch, state: nextState };
    settings.put({ key: RECOVERY_STATE_KEY, value: next });
    if (removePending) settings.delete(RECOVERY_PENDING_KEY);
    await done;
    return next;
  } catch (error) {
    abortWith(transaction, error);
    await done.catch(() => {});
    throw error;
  }
}

export async function deferRecoveryRetry(db, {
  recoveryId,
  guard,
  attemptedAt = Date.now(),
  delayMs,
  availabilityWaiting = false
}) {
  if (!validGuard(guard)) throw new RecoveryGuardError();
  if (!Number.isFinite(attemptedAt) || !Number.isFinite(delayMs) || delayMs <= 0) {
    throw new RecoveryStateChangedError("Recovery retry timing is invalid.");
  }
  const transaction = db.transaction("settings", "readwrite");
  const done = transactionDone(transaction);
  const settings = transaction.objectStore("settings");
  try {
    const [values, row] = await Promise.all([
      readGuardValues(settings),
      requestResult(settings.get(RECOVERY_STATE_KEY))
    ]);
    if (!guardMatches(values, guard)) throw new RecoveryGuardError();
    const current = row?.value;
    if (!current || current.recovery_id !== recoveryId || !isRecoveryStateActive(current)) {
      throw new RecoveryStateChangedError();
    }
    const next = {
      ...current,
      last_attempt_at: attemptedAt,
      next_attempt_after: attemptedAt + delayMs,
      ...(availabilityWaiting ? { availability: "waiting", unavailable_at: attemptedAt } : {})
    };
    settings.put({ key: RECOVERY_STATE_KEY, value: next });
    await done;
    return next;
  } catch (error) {
    abortWith(transaction, error);
    await done.catch(() => {});
    throw error;
  }
}

export async function clearRecoveryRetry(db, { recoveryId, guard }) {
  if (!validGuard(guard)) throw new RecoveryGuardError();
  const transaction = db.transaction("settings", "readwrite");
  const done = transactionDone(transaction);
  const settings = transaction.objectStore("settings");
  try {
    const [values, row] = await Promise.all([
      readGuardValues(settings),
      requestResult(settings.get(RECOVERY_STATE_KEY))
    ]);
    if (!guardMatches(values, guard)) throw new RecoveryGuardError();
    const current = row?.value;
    if (!current || current.recovery_id !== recoveryId || !isRecoveryStateActive(current)) {
      throw new RecoveryStateChangedError();
    }
    if (!["availability", "unavailable_at", "last_attempt_at", "next_attempt_after"]
      .some((key) => Object.hasOwn(current, key))) {
      await done;
      return current;
    }
    const next = { ...current };
    delete next.availability;
    delete next.unavailable_at;
    delete next.last_attempt_at;
    delete next.next_attempt_after;
    settings.put({ key: RECOVERY_STATE_KEY, value: next });
    await done;
    return next;
  } catch (error) {
    abortWith(transaction, error);
    await done.catch(() => {});
    throw error;
  }
}

function payloadBytes(payload) {
  return new TextEncoder().encode(canonicalJson(payload)).byteLength;
}

// Parts retain the exact snapshot objects. The conservative payload target
// leaves room for the declaration repeated in the HTTP body under C2's 512 KB
// route limit.
export async function buildRecoveryParts(snapshot, { maxPayloadBytes = 256 * 1024, maxParts = 128 } = {}) {
  const parts = [];
  let current = { records: [], queue: [] };
  const pushCurrent = () => {
    if (!current.records.length && !current.queue.length && parts.length) return;
    parts.push(current);
    current = { records: [], queue: [] };
  };
  const append = (kind, value) => {
    const candidate = { records: [...current.records], queue: [...current.queue] };
    candidate[kind].push(value);
    if ((current.records.length || current.queue.length) && payloadBytes(candidate) > maxPayloadBytes) {
      pushCurrent();
      current[kind].push(value);
    } else {
      current = candidate;
    }
    if (payloadBytes(current) > maxPayloadBytes) {
      throw new Error("A recovery item is too large to preserve safely.");
    }
  };
  for (const record of snapshot?.records || []) append("records", record);
  for (const queueItem of snapshot?.queue || []) append("queue", queueItem);
  pushCurrent();
  if (parts.length > maxParts) throw new Error("The recovery snapshot needs too many upload parts.");
  return Promise.all(parts.map(async (payload, partNo) => ({
    part_no: partNo,
    sha256: await recoveryPartSha256(payload),
    records: payload.records,
    queue: payload.queue
  })));
}

export function partDeclaration(parts) {
  return parts.map((part) => ({ part_no: part.part_no, sha256: part.sha256 }));
}

function signedOriginalId(record) {
  return Number(record?.importedFromServer === true ? record?.server_entry_id : record?.id);
}

function rawLocalId(record) {
  return Number(record?.id);
}

function manifestBase(record, disposition, dateCheck, replacement = null) {
  const item = {
    original_entry_hash: String(record?.entry_hash || ""),
    original_local_id: rawLocalId(record),
    original_signed_id: signedOriginalId(record),
    disposition,
    date_check: dateCheck,
    replacement_entry_id: replacement ? Number(replacement.id) : null,
    replacement_entry_hash: replacement ? String(replacement.entry_hash || "") : null
  };
  // P3's wire contract distinguishes a truly absent property from every JSON
  // value. Never add undefined, null, zero or another substitute.
  if (Object.hasOwn(record || {}, "confirmed_at")) {
    item.original_confirmed_at = record.confirmed_at;
  }
  return item;
}

function sourceRecord(item) {
  return item?.record || item?.original || item;
}

function uniqueByHash(items) {
  const output = [];
  const seen = new Set();
  for (const item of items) {
    const record = sourceRecord(item);
    const hash = String(record?.entry_hash || "");
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    output.push(item);
  }
  return output;
}

export function buildCompletionManifest({ snapshot, classification, plan, parts }) {
  const byHash = new Map();
  const set = (record, disposition, dateCheck, replacement = null) => {
    if (!record?.entry_hash || byHash.has(record.entry_hash)) return;
    byHash.set(record.entry_hash, manifestBase(record, disposition, dateCheck, replacement));
  };

  for (const item of classification?.accepted || []) set(sourceRecord(item), "accepted", null);
  for (const item of classification?.R || []) set(sourceRecord(item), "accepted", null);
  for (const item of plan?.items || []) {
    const record = item.original;
    if (item.replacement) set(record, "replaced", item.date_check, item.replacement);
    else if (item.date_check === "unrepresentable") set(record, "unrepresentable", "unrepresentable");
    else set(record, "unexplained", item.date_check || null);
  }
  for (const item of uniqueByHash([
    ...(classification?.xInvalid || []),
    ...(classification?.unexplained || [])
  ])) {
    const record = sourceRecord(item);
    set(record, "unexplained", item?.date_check || null);
  }

  // Every uploaded original must be present, including a preserved queue-only
  // item. Unknown items fail closed as unexplained instead of being omitted.
  const uploaded = [
    ...(snapshot?.records || []),
    ...(snapshot?.queue || []).map((item) => item?.entry_payload).filter(Boolean)
  ];
  for (const record of uploaded) set(record, "unexplained", null);

  const items = [...byHash.values()];
  const rejectedEntryHashes = items
    .filter((item) => item.disposition !== "accepted")
    .map((item) => item.original_entry_hash);
  const ownImported = uniqueByHash(classification?.R || []).map((item) => {
    const record = sourceRecord(item);
    return { entry_id: signedOriginalId(record), entry_hash: String(record.entry_hash || "") };
  });
  return {
    parts: partDeclaration(parts),
    items,
    rejected_entry_hashes: rejectedEntryHashes,
    own_imported: ownImported
  };
}

export function buildPlanRequest(plan) {
  return {
    replacements: (plan?.items || []).filter((item) => item.replacement).map((item) => ({
      original_entry_hash: String(item.original.entry_hash || ""),
      original_local_id: rawLocalId(item.original),
      original_signed_id: signedOriginalId(item.original),
      planned_entry_id: Number(item.replacement.id),
      planned_entry_hash: String(item.replacement.entry_hash || ""),
      date_check: item.date_check
    }))
  };
}

function planSignature(plan) {
  return (plan?.items || []).map((item) => ({
    original_entry_hash: String(item?.original?.entry_hash || ""),
    replacement_entry_hash: item?.replacement ? String(item.replacement.entry_hash || "") : null
  }));
}

export async function persistRecoveryPlan(db, {
  recoveryId,
  plan,
  manifest,
  parts,
  guard
}) {
  if (!validGuard(guard)) throw new RecoveryGuardError();
  const manifestHash = await sha256Canonical(manifest);
  const transaction = db.transaction(["settings", "recoveryWork"], "readwrite");
  const done = transactionDone(transaction);
  const settings = transaction.objectStore("settings");
  const workStore = transaction.objectStore("recoveryWork");
  try {
    const [values, stateRow, existing] = await Promise.all([
      readGuardValues(settings),
      requestResult(settings.get(RECOVERY_STATE_KEY)),
      requestResult(workStore.get(recoveryId))
    ]);
    if (!guardMatches(values, guard)) throw new RecoveryGuardError();
    const current = stateRow?.value;
    if (!current || current.recovery_id !== recoveryId || !["uploaded", "classified"].includes(current.state)) {
      throw new RecoveryStateChangedError();
    }
    if (existing && canonicalJson(planSignature(existing)) !== canonicalJson(planSignature(plan))) {
      throw new RecoveryPlanChangedError();
    }
    const work = existing || {
      ...plan,
      manifest,
      parts: partDeclaration(parts),
      persisted_before_plan: true,
      plan_attempt: Number(current.attempts || 0)
    };
    if (!existing) workStore.add(work);
    settings.put({
      key: RECOVERY_STATE_KEY,
      value: {
        ...current,
        state: "classified",
        cursor: {
          ...(current.cursor || {}),
          replacement_count: buildPlanRequest(work).replacements.length,
          manifest_hash: manifestHash
        }
      }
    });
    await done;
    return work;
  } catch (error) {
    abortWith(transaction, error);
    await done.catch(() => {});
    throw error;
  }
}

export async function replaceRecoveryPlanAfterHeadMove(db, {
  recoveryId,
  previousWork,
  plan,
  manifest,
  parts,
  guard,
  maxAttempts = 3
}) {
  if (!validGuard(guard)) throw new RecoveryGuardError();
  const manifestHash = await sha256Canonical(manifest);
  const transaction = db.transaction(["settings", "recoveryWork"], "readwrite");
  const done = transactionDone(transaction);
  const settings = transaction.objectStore("settings");
  const workStore = transaction.objectStore("recoveryWork");
  try {
    const [values, stateRow, stored] = await Promise.all([
      readGuardValues(settings),
      requestResult(settings.get(RECOVERY_STATE_KEY)),
      requestResult(workStore.get(recoveryId))
    ]);
    if (!guardMatches(values, guard)) throw new RecoveryGuardError();
    const current = stateRow?.value;
    if (!current || current.recovery_id !== recoveryId || current.state !== "classified") {
      throw new RecoveryStateChangedError();
    }
    if (!stored || canonicalJson(planSignature(stored)) !== canonicalJson(planSignature(previousWork))) {
      throw new RecoveryPlanChangedError();
    }
    const attempts = Number(current.attempts || 0) + 1;
    if (attempts >= maxAttempts) throw new RecoveryPlanChangedError("Recovery reached its safe head-move limit.");
    const nextWork = {
      ...plan,
      manifest,
      parts: partDeclaration(parts),
      persisted_before_plan: true,
      plan_attempt: attempts
    };
    workStore.put(nextWork);
    settings.put({
      key: RECOVERY_STATE_KEY,
      value: {
        ...current,
        attempts,
        cursor: {
          ...(current.cursor || {}),
          replacement_count: buildPlanRequest(nextWork).replacements.length,
          manifest_hash: manifestHash
        }
      }
    });
    await done;
    return nextWork;
  } catch (error) {
    abortWith(transaction, error);
    await done.catch(() => {});
    throw error;
  }
}

export async function markRecoverySynced(db, { recoveryId, work, guard, receipt = "" }) {
  if (!validGuard(guard)) throw new RecoveryGuardError();
  const transaction = db.transaction(["settings", "records", "syncQueue"], "readwrite");
  const done = transactionDone(transaction);
  const settings = transaction.objectStore("settings");
  const records = transaction.objectStore("records");
  const queue = transaction.objectStore("syncQueue");
  const replacements = (work?.items || []).filter((item) => item.replacement).map((item) => item.replacement);
  try {
    const [values, stateRow, queueRows, storedRows] = await Promise.all([
      readGuardValues(settings),
      requestResult(settings.get(RECOVERY_STATE_KEY)),
      requestResult(queue.getAll()),
      Promise.all(replacements.map((replacement) => requestResult(records.get(replacement.id))))
    ]);
    if (!guardMatches(values, guard)) throw new RecoveryGuardError();
    const current = stateRow?.value;
    if (!current || current.recovery_id !== recoveryId || current.state !== "rebuilt") {
      throw new RecoveryStateChangedError();
    }
    for (let index = 0; index < replacements.length; index += 1) {
      const replacement = replacements[index];
      const stored = storedRows[index];
      if (!stored || stored.entry_hash !== replacement.entry_hash) throw new RecoveryPlanChangedError();
      records.put({
        ...stored,
        evidence_level: "server_attested",
        server_entry_id: stored.server_entry_id || stored.id
      });
    }
    const replacementHashes = new Set(replacements.map((item) => item.entry_hash));
    for (const queued of queueRows || []) {
      const hash = queued?.entry_hash || queued?.entry_payload?.entry_hash;
      if (replacementHashes.has(hash)) queue.delete(queued.queue_id);
    }
    const completedAt = new Date().toISOString();
    settings.put({ key: "last_sync_at", value: completedAt });
    settings.put({ key: "last_sync_receipt", value: receipt });
    settings.put({
      key: RECOVERY_STATE_KEY,
      value: { ...current, state: "synced", cursor: { ...(current.cursor || {}), synced_at: completedAt } }
    });
    await done;
    return true;
  } catch (error) {
    abortWith(transaction, error);
    await done.catch(() => {});
    throw error;
  }
}

export function verifyServerChain({ records, deviceIdentity, expectedHead }) {
  const own = (records || [])
    .filter((record) => String(record?.device_identity || "") === String(deviceIdentity || ""))
    .sort((left, right) => Number(left.entry_id ?? left.id) - Number(right.entry_id ?? right.id));
  let expectedId = 1;
  let previousHash = ZERO_HASH;
  for (const record of own) {
    const id = Number(record.entry_id ?? record.id);
    if (id !== expectedId || String(record.prev_entry_hash || "") !== previousHash) return false;
    previousHash = String(record.entry_hash || "");
    expectedId += 1;
  }
  const actualHead = own.length
    ? { entry_id: Number(own.at(-1).entry_id ?? own.at(-1).id), entry_hash: String(own.at(-1).entry_hash || "") }
    : { entry_id: 0, entry_hash: ZERO_HASH };
  return actualHead.entry_id === Number(expectedHead?.entry_id ?? expectedHead?.id ?? 0)
    && actualHead.entry_hash === String(expectedHead?.entry_hash || ZERO_HASH);
}

export function expectedRecoveryHead(work) {
  const replacements = (work?.items || []).filter((item) => item.replacement);
  if (replacements.length) {
    const last = replacements.at(-1).replacement;
    return { entry_id: Number(last.id), entry_hash: String(last.entry_hash || "") };
  }
  return {
    entry_id: Number(work?.server_head?.entry_id ?? work?.server_head?.id ?? 0),
    entry_hash: String(work?.server_head?.entry_hash || ZERO_HASH)
  };
}

export function isPermanentRecoveryRefusal(error) {
  const code = String(error?.payload?.error || error?.payload?.code || "");
  return new Set([
    "invalid_recovery_session",
    "recovery_id_conflict",
    "recovery_part_declaration_conflict",
    "recovery_part_conflict",
    "recovery_part_hash_mismatch",
    "recovery_part_declaration_mismatch",
    "stored_part_digest_mismatch",
    "invalid_recovery_plan",
    "duplicate_recovery_plan_item",
    "recovery_plan_original_unverified",
    "recovery_plan_unrepresentable_original",
    "recovery_plan_date_check_mismatch",
    "recovery_plan_ledger_collision",
    "recovery_plan_reservation_collision",
    "recovery_original_already_reserved",
    "recovery_plan_conflict",
    "invalid_recovery_manifest",
    "recovery_manifest_hash_mismatch",
    "recovery_part_manifest_mismatch",
    "recovery_completion_conflict",
    "device_status_changed"
  ]).has(code);
}

export function isHeadMoveRefusal(error) {
  const code = String(error?.payload?.error || error?.payload?.code || "");
  return code === "recovery_plan_not_contiguous";
}
