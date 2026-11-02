import crypto from "node:crypto";
import { authenticateRequest } from "../auth-utils.js";
import { config } from "../config.js";
import { verifyEntrySignature } from "../crypto-verify.js";
import { withTransaction } from "../db.js";
import { computeLedgerEntryHash } from "../ledger-canonical.js";

const EMPTY_HASH = "0".repeat(64);
const ACTIVE_STATES = new Set(["open", "uploaded", "planned", "syncing"]);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_CHECKS = new Set(["ok", "before_2000", "future", "after_receipt_bound"]);
const FIRST_2000_SECOND = 946684800;
const ONE_DAY_SECONDS = 86400;
const POSTGRES_TIMESTAMP_CONSERVATIVE_LIMIT_SECONDS = 8_000_000_000;
// C1 planReplacements spreads the preserved original and changes only these
// five keys. id selects the new server slot; prev_entry_hash attaches the new
// chain; entry_hash/signature authenticate those changes; reversed_entry_hash
// may only remap a recovered reversal to its target's replacement hash. Every
// other key, including local/provenance metadata, must remain exactly equal.
const REPLACEMENT_ALLOWED_CHANGE_FIELDS = new Set([
  "id",
  "prev_entry_hash",
  "entry_hash",
  "signature",
  "reversed_entry_hash"
]);
const ORIGINAL_LOCAL_PROVENANCE_FIELDS = new Set([
  "evidence_level",
  "importedFromServer",
  "restoredOwn",
  "server_entry_id",
  "restoreVerified"
]);

function routeError(statusCode, code, options = {}) {
  return Object.assign(new Error(code), { statusCode, code, ...options });
}

function sendRouteError(reply, error) {
  if (error.retryAfter) reply.header("Retry-After", String(error.retryAfter));
  if (error.responseBody) return reply.code(error.statusCode || 500).send(error.responseBody);
  return reply.code(error.statusCode || 500).send({
    error: error.code || "recovery_failed",
    code: error.code || "recovery_failed"
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isHash(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// Identity terms used throughout recovery:
// - raw local id: original.id exactly as stored on the device; a C1 Class R
//   imported copy can use a synthetic 1000000000+n id.
// - signed/server id: the id hashed into entry_hash and used by the accepted
//   server ledger. It is server_entry_id only when importedFromServer === true,
//   and otherwise it is id.
// These helpers create projections only. They never mutate uploaded evidence.
function originalIdentity(original) {
  if (!isPlainObject(original) || !isSafePositiveInteger(original.id)) {
    return { reason: "original_local_id_invalid" };
  }
  const rawLocalId = original.id;
  if (original.importedFromServer === true) {
    if (!isSafePositiveInteger(original.server_entry_id)) {
      return { reason: "original_signed_id_invalid" };
    }
    return { rawLocalId, signedId: original.server_entry_id, importedFromServer: true };
  }
  if (Object.hasOwn(original, "server_entry_id") && original.server_entry_id !== rawLocalId) {
    return { reason: "original_signed_id_mismatch" };
  }
  return { rawLocalId, signedId: rawLocalId, importedFromServer: false };
}

function canonicalOriginalProjection(original, { omitLocalProvenance = false } = {}) {
  const identity = originalIdentity(original);
  if (identity.reason) return { identity, projected: null };
  const projected = { ...original, id: identity.signedId };
  if (omitLocalProvenance) {
    for (const field of ORIGINAL_LOCAL_PROVENANCE_FIELDS) delete projected[field];
  }
  return { identity, projected };
}

// Deterministic JSON used for part and manifest hashes: object keys are sorted
// recursively, array order is preserved, and JSON scalar spelling is standard.
export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw routeError(400, "invalid_json_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  throw routeError(400, "invalid_json_value");
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function recoveryPartSha256({ records, queue }) {
  return sha256Canonical({ records, queue });
}

function leaseIntervalSql() {
  return `${config.recoveryLeaseSeconds} seconds`;
}

async function lockOwnedDevice(client, deviceIdentity, accountId) {
  const result = await client.query(
    `
      SELECT device_identity, user_id, status, revoked_at, public_key
      FROM device_identities
      WHERE device_identity = $1
      LIMIT 1
      FOR UPDATE
    `,
    [deviceIdentity]
  );
  const device = result.rows[0];
  if (!device) {
    throw routeError(401, "device_not_registered", {
      responseBody: { error: "Device not registered. Complete OTP verification first." }
    });
  }
  if (device.user_id !== accountId) {
    throw routeError(403, "device_wrong_account", {
      responseBody: { error: "Device belongs to another account." }
    });
  }
  if (device.revoked_at) {
    throw routeError(401, "device_revoked", { responseBody: { error: "device_revoked" } });
  }
  return device;
}

async function ledgerHead(client, deviceIdentity) {
  const result = await client.query(
    `
      SELECT entry_id, entry_hash
      FROM ledger_entries
      WHERE device_identity = $1
      ORDER BY entry_id DESC
      LIMIT 1
    `,
    [deviceIdentity]
  );
  const row = result.rows[0];
  return row
    ? { entry_id: Number(row.entry_id), entry_hash: row.entry_hash }
    : { entry_id: 0, entry_hash: EMPTY_HASH };
}

async function lockOwnedSession(client, recoveryId, auth) {
  const result = await client.query(
    `
      SELECT *
      FROM recovery_sessions
      WHERE recovery_id = $1
      LIMIT 1
      FOR UPDATE
    `,
    [recoveryId]
  );
  const session = result.rows[0];
  if (!session) throw routeError(404, "recovery_session_not_found");
  if (session.device_identity !== auth.device_identity || session.user_id !== auth.account_id) {
    throw routeError(403, "recovery_session_forbidden");
  }
  return session;
}

function assertMutableSession(session) {
  if (!ACTIVE_STATES.has(session.state)) throw routeError(409, "recovery_session_closed");
}

function validateSessionBody(body) {
  if (!hasExactKeys(body, ["recovery_id", "device_identity", "app_version", "local_summary"])) {
    throw routeError(400, "invalid_recovery_session");
  }
  if (!isUuid(body.recovery_id)
      || typeof body.device_identity !== "string"
      || !body.device_identity.trim()
      || typeof body.app_version !== "string"
      || !body.app_version.trim()
      || body.app_version.length > 128
      || !isPlainObject(body.local_summary)) {
    throw routeError(400, "invalid_recovery_session");
  }
}

/*
Part upload contract (unknown/missing top-level fields are rejected):
{
  sha256, part_count,
  part_hashes: [{ part_no: 0..part_count-1, sha256 }],
  records: [signed ledger originals],
  queue: [{ ..., entry_payload: signed ledger original }]
}
Every upload repeats the same complete declaration. sha256 covers canonical
JSON of {records, queue} only. Planning is disabled until all declared hashes
have been received and revalidated from recovery_parts.
*/
function validatePartBody(body) {
  if (!hasExactKeys(body, ["sha256", "part_count", "part_hashes", "records", "queue"])
      || !isHash(body.sha256)
      || !isSafePositiveInteger(body.part_count)
      || body.part_count > config.recoveryMaxParts
      || !Array.isArray(body.part_hashes)
      || !Array.isArray(body.records)
      || !Array.isArray(body.queue)) {
    throw routeError(400, "invalid_recovery_part");
  }
  const declared = validatePartHashDeclaration(body.part_count, body.part_hashes);
  validateStoredPartPayload({ records: body.records, queue: body.queue });
  return declared;
}

function validatePartHashDeclaration(partCount, partHashes) {
  if (partHashes.length !== partCount) throw routeError(400, "invalid_recovery_part_declaration");
  const declared = new Map();
  for (const part of partHashes) {
    if (!hasExactKeys(part, ["part_no", "sha256"])
        || !Number.isSafeInteger(part.part_no)
        || part.part_no < 0
        || part.part_no >= partCount
        || !isHash(part.sha256)
        || declared.has(part.part_no)) {
      throw routeError(400, "invalid_recovery_part_declaration");
    }
    declared.set(part.part_no, part.sha256);
  }
  for (let partNo = 0; partNo < partCount; partNo += 1) {
    if (!declared.has(partNo)) throw routeError(400, "invalid_recovery_part_declaration");
  }
  return [...declared.entries()]
    .sort(([left], [right]) => left - right)
    .map(([part_no, sha256]) => ({ part_no, sha256 }));
}

function validateStoredOriginal(entry) {
  if (!isPlainObject(entry)
      || !isSafePositiveInteger(entry.id)
      || !isHash(entry.entry_hash)
      || !isHash(entry.prev_entry_hash)
      || (entry.reversed_entry_hash != null && !isHash(entry.reversed_entry_hash))
      || typeof entry.signature !== "string"
      || entry.signature.length === 0
      || typeof entry.device_identity !== "string"
      || entry.device_identity.length === 0) {
    throw routeError(400, "invalid_recovery_part_payload");
  }
  canonicalJson(entry);
}

function queueOriginal(queueItem) {
  if (!isPlainObject(queueItem) || !isPlainObject(queueItem.entry_payload)) {
    throw routeError(400, "invalid_recovery_part_payload");
  }
  validateStoredOriginal(queueItem.entry_payload);
  return queueItem.entry_payload;
}

function validateStoredPartPayload(payload) {
  if (!hasExactKeys(payload, ["records", "queue"])
      || !Array.isArray(payload.records)
      || !Array.isArray(payload.queue)) {
    throw routeError(400, "invalid_recovery_part_payload");
  }
  for (const record of payload.records) validateStoredOriginal(record);
  for (const queueItem of payload.queue) queueOriginal(queueItem);
  return payload;
}

function classifyOriginalDate(confirmedAt, receivedBoundSeconds) {
  if (typeof confirmedAt !== "number"
      || !confirmedAt
      || !Number.isFinite(confirmedAt)
      || Math.abs(confirmedAt) > POSTGRES_TIMESTAMP_CONSERVATIVE_LIMIT_SECONDS) {
    return "unrepresentable";
  }
  if (confirmedAt < FIRST_2000_SECOND) return "before_2000";
  if (confirmedAt > Number(receivedBoundSeconds) + ONE_DAY_SECONDS) return "after_receipt_bound";
  if (confirmedAt > Number(receivedBoundSeconds)) return "future";
  return "ok";
}

function validateReplacement(value) {
  if (!hasExactKeys(value, [
    "original_entry_hash",
    "original_local_id",
    "original_signed_id",
    "planned_entry_id",
    "planned_entry_hash",
    "date_check"
  ])) return false;
  return isHash(value.original_entry_hash)
    && isSafePositiveInteger(value.original_local_id)
    && isSafePositiveInteger(value.original_signed_id)
    && isSafePositiveInteger(value.planned_entry_id)
    && isHash(value.planned_entry_hash)
    && DATE_CHECKS.has(value.date_check);
}

function validatePlanBody(body) {
  if (!hasExactKeys(body, ["replacements"])
      || !Array.isArray(body.replacements)
      || body.replacements.length > config.recoveryMaxPlanReplacements
      || !body.replacements.every(validateReplacement)) {
    throw routeError(400, "invalid_recovery_plan");
  }
  const originals = new Set(body.replacements.map((item) => item.original_entry_hash));
  const ids = new Set(body.replacements.map((item) => item.planned_entry_id));
  const hashes = new Set(body.replacements.map((item) => item.planned_entry_hash));
  if (originals.size !== body.replacements.length
      || ids.size !== body.replacements.length
      || hashes.size !== body.replacements.length) {
    throw routeError(400, "duplicate_recovery_plan_item");
  }
}

/*
Completion manifest schema (all fields required; unknown fields are rejected):
{
  parts: [{ part_no: non-negative integer, sha256: 64-char lowercase hex }],
  items: [{
    original_entry_hash: 64-char lowercase hex,
    original_local_id: positive safe integer,
    original_signed_id: positive safe integer,
    original_confirmed_at: any JSON scalar/object/array (preserved exactly),
    disposition: "accepted" | "replaced" | "unexplained" | "unrepresentable",
    date_check: null | "ok" | "before_2000" | "future" |
      "after_receipt_bound" | "unrepresentable",
    replacement_entry_id: null | positive safe integer,
    replacement_entry_hash: null | 64-char lowercase hex
  }],
  rejected_entry_hashes: [64-char lowercase hex],
  own_imported: [{ entry_id: positive safe integer, entry_hash: 64-char lowercase hex }]
}
For "replaced", both replacement fields and a representable date_check are
required. For every other disposition both replacement fields must be null.
"unrepresentable" requires its matching date_check; accepted items use null.
*/
export function validateRecoveryManifest(manifest) {
  if (!hasExactKeys(manifest, ["parts", "items", "rejected_entry_hashes", "own_imported"])
      || !Array.isArray(manifest.parts)
      || !Array.isArray(manifest.items)
      || !Array.isArray(manifest.rejected_entry_hashes)
      || !Array.isArray(manifest.own_imported)
      || manifest.parts.length === 0) {
    throw routeError(400, "invalid_recovery_manifest");
  }

  const partNumbers = new Set();
  for (const part of manifest.parts) {
    if (!hasExactKeys(part, ["part_no", "sha256"])
        || !Number.isSafeInteger(part.part_no)
        || part.part_no < 0
        || part.part_no >= config.recoveryMaxParts
        || !isHash(part.sha256)
        || partNumbers.has(part.part_no)) {
      throw routeError(400, "invalid_recovery_manifest");
    }
    partNumbers.add(part.part_no);
  }

  const originalHashes = new Set();
  for (const item of manifest.items) {
    if (!hasExactKeys(item, [
      "original_entry_hash",
      "original_local_id",
      "original_signed_id",
      "original_confirmed_at",
      "disposition",
      "date_check",
      "replacement_entry_id",
      "replacement_entry_hash"
    ])
        || !isHash(item.original_entry_hash)
        || !isSafePositiveInteger(item.original_local_id)
        || !isSafePositiveInteger(item.original_signed_id)
        || originalHashes.has(item.original_entry_hash)
        || !["accepted", "replaced", "unexplained", "unrepresentable"].includes(item.disposition)) {
      throw routeError(400, "invalid_recovery_manifest");
    }
    canonicalJson(item.original_confirmed_at);
    originalHashes.add(item.original_entry_hash);
    if (item.disposition === "replaced") {
      if (!DATE_CHECKS.has(item.date_check)
          || !isSafePositiveInteger(item.replacement_entry_id)
          || !isHash(item.replacement_entry_hash)
          || typeof item.original_confirmed_at !== "number"
          || !Number.isFinite(item.original_confirmed_at)) {
        throw routeError(400, "invalid_recovery_manifest");
      }
    } else if (item.replacement_entry_id !== null || item.replacement_entry_hash !== null) {
      throw routeError(400, "invalid_recovery_manifest");
    } else if (item.disposition === "accepted" && item.date_check !== null) {
      throw routeError(400, "invalid_recovery_manifest");
    } else if (item.disposition === "unrepresentable" && item.date_check !== "unrepresentable") {
      throw routeError(400, "invalid_recovery_manifest");
    } else if (item.disposition === "unexplained"
        && item.date_check !== null
        && item.date_check !== "unrepresentable"
        && !DATE_CHECKS.has(item.date_check)) {
      throw routeError(400, "invalid_recovery_manifest");
    }
  }

  const rejected = new Set();
  for (const hash of manifest.rejected_entry_hashes) {
    if (!isHash(hash) || rejected.has(hash)) throw routeError(400, "invalid_recovery_manifest");
    rejected.add(hash);
  }
  const reportedRejected = new Set(
    manifest.items.filter((item) => item.disposition !== "accepted").map((item) => item.original_entry_hash)
  );
  if (rejected.size !== reportedRejected.size
      || [...rejected].some((hash) => !reportedRejected.has(hash))) {
    throw routeError(400, "invalid_recovery_manifest");
  }

  const importedKeys = new Set();
  for (const imported of manifest.own_imported) {
    const key = `${imported?.entry_id}:${imported?.entry_hash}`;
    if (!hasExactKeys(imported, ["entry_id", "entry_hash"])
        || !isSafePositiveInteger(imported.entry_id)
        || !isHash(imported.entry_hash)
        || importedKeys.has(key)) {
      throw routeError(400, "invalid_recovery_manifest");
    }
    importedKeys.add(key);
  }
  return manifest;
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

async function loadCompletePreservation(client, session) {
  const declared = session.declared_part_hashes;
  if (!isSafePositiveInteger(Number(session.declared_part_count)) || !Array.isArray(declared)) {
    throw routeError(409, "recovery_preservation_incomplete");
  }
  const normalized = validatePartHashDeclaration(Number(session.declared_part_count), declared);
  const rows = (await client.query(
    `SELECT part_no, sha256, payload FROM recovery_parts WHERE recovery_id = $1 ORDER BY part_no`,
    [session.recovery_id]
  )).rows;
  if (rows.length !== normalized.length) throw routeError(409, "recovery_preservation_incomplete");
  for (let index = 0; index < normalized.length; index += 1) {
    const row = rows[index];
    if (Number(row.part_no) !== normalized[index].part_no || row.sha256 !== normalized[index].sha256) {
      throw routeError(409, "recovery_preservation_incomplete");
    }
    validateStoredPartPayload(row.payload);
    const storedPayloadDigest = recoveryPartSha256(row.payload);
    if (storedPayloadDigest !== row.sha256 || storedPayloadDigest !== normalized[index].sha256) {
      throw routeError(409, "stored_part_digest_mismatch");
    }
  }
  return rows;
}

async function verifyPartManifest(client, recoveryId, manifest) {
  const session = (await client.query(
    `SELECT * FROM recovery_sessions WHERE recovery_id = $1`,
    [recoveryId]
  )).rows[0];
  const rows = await loadCompletePreservation(client, session);
  if (rows.length !== manifest.parts.length) throw routeError(409, "recovery_part_manifest_mismatch");
  const expected = new Map(manifest.parts.map((part) => [part.part_no, part.sha256]));
  for (const row of rows) {
    if (expected.get(Number(row.part_no)) !== row.sha256) {
      throw routeError(409, "recovery_part_manifest_mismatch");
    }
    validateStoredPartPayload(row.payload);
  }
  const declared = session?.declared_part_hashes;
  if (Number(session?.declared_part_count) !== rows.length
      || canonicalJson(declared) !== canonicalJson(manifest.parts)) {
    throw routeError(409, "recovery_part_manifest_mismatch");
  }
  return rows;
}

function collectUploadedOriginals(partRows) {
  const originals = new Map();
  for (const row of partRows) {
    const payload = validateStoredPartPayload(row.payload);
    const entries = [
      ...payload.records.map((entry) => ({ entry, source: "records" })),
      ...payload.queue.map((queueItem) => ({ entry: queueOriginal(queueItem), source: "queue" }))
    ];
    for (const { entry, source } of entries) {
      const { identity, projected } = canonicalOriginalProjection(entry, { omitLocalProvenance: true });
      const comparison = projected ? canonicalJson(projected) : null;
      const provenance = {
        source,
        raw_local_id: identity.rawLocalId ?? entry.id,
        signed_id: identity.signedId ?? null,
        imported_from_server: entry.importedFromServer === true,
        evidence_level: typeof entry.evidence_level === "string" ? entry.evidence_level : null,
        restored_own: entry.restoredOwn === true,
        restore_verified: entry.restoreVerified === true
      };
      const existing = originals.get(entry.entry_hash);
      if (!existing) {
        originals.set(entry.entry_hash, {
          entry,
          copies: [entry],
          provenances: [provenance],
          comparison,
          conflicting_copy: false
        });
      } else {
        existing.copies.push(entry);
        existing.provenances.push(provenance);
        if (!comparison || existing.comparison !== comparison) existing.conflicting_copy = true;
      }
    }
  }
  return originals;
}

function verifyOriginalCryptography(original, device) {
  if (!original) return "manifest_item_not_uploaded";
  if (original.device_identity !== device.device_identity) return "original_wrong_device_identity";
  const { identity, projected } = canonicalOriginalProjection(original);
  if (identity.reason) return identity.reason;
  if (computeLedgerEntryHash(projected) !== original.entry_hash) return "original_hash_mismatch";
  if (!verifyEntrySignature(device.public_key, original.entry_hash, original.signature)) {
    return "original_signature_invalid";
  }
  return null;
}

function analyzeOriginals(originals, ledgerRows, device) {
  const ledgerById = new Map(ledgerRows.map((row) => [Number(row.entry_id), row]));
  const analysis = new Map();
  for (const [hash, uploaded] of originals) {
    let verificationReason = uploaded.conflicting_copy ? "uploaded_original_conflict" : null;
    if (!verificationReason) {
      for (const copy of uploaded.copies) {
        verificationReason = verifyOriginalCryptography(copy, device);
        if (verificationReason) break;
      }
    }
    const identities = uploaded.copies.map(originalIdentity);
    const firstIdentity = identities[0];
    analysis.set(hash, {
      entry: uploaded.entry,
      rawLocalIds: new Set(identities.map((identity) => identity.rawLocalId).filter(isSafePositiveInteger)),
      signedId: firstIdentity?.signedId ?? null,
      verificationReason,
      reproducedDefect: false
    });
  }

  const eligible = new Set();
  for (const [hash, item] of analysis) {
    const collision = ledgerById.get(Number(item.signedId));
    if (!item.verificationReason && collision && collision.entry_hash !== hash) eligible.add(hash);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [hash, item] of analysis) {
      if (!item.verificationReason && !eligible.has(hash) && eligible.has(item.entry.prev_entry_hash)) {
        eligible.add(hash);
        changed = true;
      }
    }
  }
  for (const [hash, item] of analysis) item.reproducedDefect = eligible.has(hash);
  return analysis;
}

function jsonExactlyEqual(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function replacementContentReason(original, replacement, replacementByOriginal, device) {
  if (!replacement || !isPlainObject(replacement.payload)) return "reported_item_not_replaced";
  const payload = replacement.payload;
  if (payload.device_identity !== device.device_identity) return "replacement_content_mismatch";
  if (computeLedgerEntryHash(payload) !== replacement.entry_hash
      || !verifyEntrySignature(device.public_key, replacement.entry_hash, replacement.signature)) {
    return "replacement_signature_invalid";
  }
  const contentKeys = new Set([...Object.keys(original), ...Object.keys(payload)]);
  for (const field of contentKeys) {
    if (REPLACEMENT_ALLOWED_CHANGE_FIELDS.has(field)) continue;
    if (!Object.hasOwn(original, field)
        || !Object.hasOwn(payload, field)
        || !jsonExactlyEqual(payload[field], original[field])) {
      return "replacement_content_mismatch";
    }
  }
  let expectedReversal = original.reversed_entry_hash;
  if (expectedReversal && replacementByOriginal.has(expectedReversal)) {
    expectedReversal = replacementByOriginal.get(expectedReversal);
  }
  if (payload.reversed_entry_hash !== expectedReversal) return "replacement_reversal_mismatch";
  return null;
}

function reservationMatches(item, reservation) {
  return reservation
    && reservation.status === "accepted"
    && Number(reservation.original_local_id) === item.original_local_id
    && Number(reservation.original_signed_id) === item.original_signed_id
    && Number(reservation.planned_entry_id) === item.replacement_entry_id
    && reservation.planned_entry_hash === item.replacement_entry_hash
    && reservation.date_check === item.date_check;
}

async function recordStoredPartDigestMismatch(client, session, manifest, manifestHash) {
  const reasons = ["stored_part_digest_mismatch"];
  if (!config.recoveryAutoclear) reasons.push("autoclear_disabled");
  const reconciliation = {
    all_items_reported_by_device_accounted_for: false,
    reported_items: manifest.items.length,
    accepted_items: 0,
    replacement_mappings: 0,
    unexplained_items: manifest.items.length,
    unrepresentable_items: 0,
    local_provenance_differences: [],
    date_exceptions: { before_2000: 0, future: 0, after_receipt_bound: 0 }
  };
  await client.query(
    `
      UPDATE recovery_sessions
      SET state = 'escalated', manifest_hash = $2, manifest = $3::jsonb,
          outcome = 'not_cleared', outcome_reasons = $4::jsonb,
          reconciliation_result = $5::jsonb, completed_at = clock_timestamp()
      WHERE recovery_id = $1
    `,
    [
      session.recovery_id,
      manifestHash,
      JSON.stringify(manifest),
      JSON.stringify(reasons),
      JSON.stringify(reconciliation)
    ]
  );
  await client.query(
    `
      INSERT INTO recovery_audit_events (device_identity, recovery_id, kind, detail, created_at)
      VALUES ($1, $2, 'recovery_unresolved', $3::jsonb, clock_timestamp())
    `,
    [session.device_identity, session.recovery_id, JSON.stringify({
      manifest_hash: manifestHash,
      reasons,
      ...reconciliation
    })]
  );
  return { outcome: "not_cleared", reasons };
}

async function completeRecovery(client, session, device, manifest, manifestHash) {
  let partRows;
  try {
    partRows = await verifyPartManifest(client, session.recovery_id, manifest);
  } catch (error) {
    if (error.code === "stored_part_digest_mismatch") {
      return recordStoredPartDigestMismatch(client, session, manifest, manifestHash);
    }
    throw error;
  }
  const reasons = [];
  const rejected = new Set(manifest.rejected_entry_hashes);
  const ledgerRows = (await client.query(
    `
      SELECT entry_id, entry_hash, prev_entry_hash, signature, confirmed_at,
             EXTRACT(EPOCH FROM confirmed_at)::text AS confirmed_epoch, payload
      FROM ledger_entries
      WHERE device_identity = $1
      ORDER BY entry_id
    `,
    [session.device_identity]
  )).rows;
  const byId = new Map(ledgerRows.map((row) => [Number(row.entry_id), row]));
  const ledgerHashes = new Set(ledgerRows.map((row) => row.entry_hash));
  const uploadedOriginals = collectUploadedOriginals(partRows);
  const originalAnalysis = analyzeOriginals(uploadedOriginals, ledgerRows, device);
  const manifestByOriginal = new Map(manifest.items.map((item) => [item.original_entry_hash, item]));
  const replacementByOriginal = new Map(manifest.items
    .filter((item) => item.disposition === "replaced")
    .map((item) => [item.original_entry_hash, item.replacement_entry_hash]));

  if (uploadedOriginals.size === 0) addReason(reasons, "empty_recovery_backup");
  for (const hash of uploadedOriginals.keys()) {
    if (!manifestByOriginal.has(hash)) addReason(reasons, "uploaded_item_omitted");
  }
  for (const hash of manifestByOriginal.keys()) {
    if (!uploadedOriginals.has(hash)) addReason(reasons, "manifest_item_not_uploaded");
  }

  const reservations = (await client.query(
    `SELECT * FROM recovery_reservations WHERE recovery_id = $1 ORDER BY planned_entry_id FOR UPDATE`,
    [session.recovery_id]
  )).rows;
  const reservationByOriginal = new Map(reservations.map((row) => [row.original_entry_hash, row]));
  const verifiedMappings = [];

  for (const item of manifest.items) {
    const itemReasons = [];
    const uploaded = uploadedOriginals.get(item.original_entry_hash);
    const original = uploaded?.entry;
    const analysis = originalAnalysis.get(item.original_entry_hash);
    if (!original) {
      itemReasons.push("manifest_item_not_uploaded");
    } else {
      if (analysis?.verificationReason) itemReasons.push(analysis.verificationReason);
      if (!analysis?.rawLocalIds.has(item.original_local_id)) itemReasons.push("original_local_id_mismatch");
      if (analysis?.signedId !== item.original_signed_id) itemReasons.push("original_signed_id_mismatch");
      if (!jsonExactlyEqual(original.confirmed_at, item.original_confirmed_at)) {
        itemReasons.push("original_confirmed_at_mismatch");
      }
    }

    if (item.disposition === "accepted") {
      const row = byId.get(item.original_signed_id);
      if (!row || row.entry_hash !== item.original_entry_hash) itemReasons.push("reported_item_not_accepted");
    } else if (item.disposition === "unexplained") {
      itemReasons.push("unexplained_items");
    } else if (item.disposition === "unrepresentable") {
      if (original
          && (classifyOriginalDate(original.confirmed_at, session.received_bound_seconds) !== "unrepresentable"
            || item.date_check !== "unrepresentable")) {
        itemReasons.push("date_check_mismatch");
      }
      itemReasons.push("unrepresentable_items");
    } else {
      const computedDateCheck = original
        ? classifyOriginalDate(original.confirmed_at, session.received_bound_seconds)
        : null;
      if (!analysis?.reproducedDefect) itemReasons.push("original_defect_pattern_unverified");
      if (computedDateCheck === "unrepresentable") itemReasons.push("unrepresentable_items");
      if (computedDateCheck !== item.date_check) itemReasons.push("date_check_mismatch");

      const reservation = reservationByOriginal.get(item.original_entry_hash);
      const replacement = byId.get(item.replacement_entry_id);
      const confirmedMatches = replacement
        && typeof item.original_confirmed_at === "number"
        && Math.abs(Number(replacement.confirmed_epoch) - item.original_confirmed_at) < 0.000001;
      if (!reservationMatches(item, reservation)
          || !replacement
          || replacement.entry_hash !== item.replacement_entry_hash
          || !confirmedMatches
          || ledgerHashes.has(item.original_entry_hash)) {
        itemReasons.push("reported_item_not_replaced");
      }
      if (original && replacement) {
        const contentReason = replacementContentReason(
          original, replacement, replacementByOriginal, device
        );
        if (contentReason) itemReasons.push(contentReason);
      }
      if (itemReasons.length === 0) verifiedMappings.push({ item, reservation });
    }
    for (const reason of itemReasons) addReason(reasons, reason);
  }

  let expectedId = 1;
  let expectedPrevHash = EMPTY_HASH;
  for (const row of ledgerRows) {
    const entryId = Number(row.entry_id);
    const payload = row.payload;
    if (entryId !== expectedId
        || row.prev_entry_hash !== expectedPrevHash
        || !isPlainObject(payload)
        || Number(payload.id) !== entryId
        || payload.entry_hash !== row.entry_hash
        || payload.prev_entry_hash !== row.prev_entry_hash
        || payload.signature !== row.signature
        || computeLedgerEntryHash(payload) !== row.entry_hash) {
      addReason(reasons, "ledger_chain_invalid");
      break;
    }
    expectedId += 1;
    expectedPrevHash = row.entry_hash;
  }

  const integrityEvents = (await client.query(
    `SELECT id, kind, detail FROM ledger_integrity_events WHERE device_identity = $1 ORDER BY id`,
    [session.device_identity]
  )).rows;
  for (const event of integrityEvents) {
    const id = Number(event.id);
    if (id > Number(session.integrity_hwm)) {
      addReason(reasons, "integrity_event_after_hwm");
    } else if (event.kind !== "fork_id_conflict") {
      addReason(reasons, "ineligible_integrity_event");
    } else if (!rejected.has(String(event.detail?.received_entry_hash || ""))) {
      addReason(reasons, "unmatched_fork_conflict");
    }
  }

  const acceptedItems = new Set(
    manifest.items
      .filter((item) => item.disposition === "accepted")
      .map((item) => `${item.original_signed_id}:${item.original_entry_hash}`)
  );
  const importedMatch = manifest.own_imported.some((item) => {
    const row = byId.get(item.entry_id);
    return row?.entry_hash === item.entry_hash && acceptedItems.has(`${item.entry_id}:${item.entry_hash}`);
  });
  if (!importedMatch) addReason(reasons, "missing_own_imported_match");
  if (device.status !== "FORKED") addReason(reasons, "device_not_forked");

  for (const { item, reservation } of verifiedMappings) {
    const inserted = await client.query(
      `
        INSERT INTO ledger_recoveries (
          device_identity, original_entry_hash, original_local_id, original_signed_id,
          original_confirmed_at, date_check, replacement_entry_id,
          replacement_entry_hash, recovery_id, recovered_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, clock_timestamp())
        ON CONFLICT (device_identity, original_entry_hash) DO NOTHING
        RETURNING original_entry_hash
      `,
      [
        session.device_identity,
        item.original_entry_hash,
        item.original_local_id,
        item.original_signed_id,
        JSON.stringify(item.original_confirmed_at),
        reservation.date_check,
        item.replacement_entry_id,
        item.replacement_entry_hash,
        session.recovery_id
      ]
    );
    if (!inserted.rowCount) {
      const existing = (await client.query(
        `
          SELECT original_local_id, original_signed_id, original_confirmed_at, date_check,
                 replacement_entry_id, replacement_entry_hash, recovery_id
          FROM ledger_recoveries
          WHERE device_identity = $1 AND original_entry_hash = $2
        `,
        [session.device_identity, item.original_entry_hash]
      )).rows[0];
      if (!existing
          || Number(existing.original_local_id) !== item.original_local_id
          || Number(existing.original_signed_id) !== item.original_signed_id
          || canonicalJson(existing.original_confirmed_at) !== canonicalJson(item.original_confirmed_at)
          || existing.date_check !== item.date_check
          || Number(existing.replacement_entry_id) !== item.replacement_entry_id
          || existing.replacement_entry_hash !== item.replacement_entry_hash
          || existing.recovery_id !== session.recovery_id) {
        addReason(reasons, "recovery_mapping_conflict");
      }
    }
  }

  const allReportedAccounted = reasons.length === 0;
  if (!config.recoveryAutoclear) addReason(reasons, "autoclear_disabled");
  const cleared = allReportedAccounted && config.recoveryAutoclear;
  const outcome = cleared ? "cleared" : "not_cleared";
  const unresolved = !allReportedAccounted;
  const reconciliation = {
    all_items_reported_by_device_accounted_for: allReportedAccounted,
    reported_items: manifest.items.length,
    accepted_items: manifest.items.filter((item) => item.disposition === "accepted").length,
    replacement_mappings: verifiedMappings.length,
    unexplained_items: manifest.items.filter((item) => item.disposition === "unexplained").length,
    unrepresentable_items: manifest.items.filter((item) => item.disposition === "unrepresentable").length,
    local_provenance_differences: [...uploadedOriginals.entries()]
      .filter(([, uploaded]) => uploaded.provenances.length > 1)
      .map(([original_entry_hash, uploaded]) => ({
        original_entry_hash,
        copies: uploaded.provenances
      })),
    date_exceptions: {
      before_2000: manifest.items.filter((item) => item.date_check === "before_2000").length,
      future: manifest.items.filter((item) => item.date_check === "future").length,
      after_receipt_bound: manifest.items.filter((item) => item.date_check === "after_receipt_bound").length
    }
  };

  await client.query(
    `
      UPDATE recovery_sessions
      SET state = $2,
          manifest_hash = $3,
          manifest = $4::jsonb,
          outcome = $5,
          outcome_reasons = $6::jsonb,
          reconciliation_result = $7::jsonb,
          completed_at = clock_timestamp()
      WHERE recovery_id = $1
    `,
    [
      session.recovery_id,
      unresolved ? "escalated" : "completed",
      manifestHash,
      JSON.stringify(manifest),
      outcome,
      JSON.stringify(reasons),
      JSON.stringify(reconciliation)
    ]
  );

  const auditKind = cleared
    ? "recovery_completed_cleared"
    : (unresolved ? "recovery_unresolved" : "recovery_completed_not_cleared");
  await client.query(
    `
      INSERT INTO recovery_audit_events (device_identity, recovery_id, kind, detail, created_at)
      VALUES ($1, $2, $3, $4::jsonb, clock_timestamp())
    `,
    [session.device_identity, session.recovery_id, auditKind, JSON.stringify({
      manifest_hash: manifestHash,
      reasons,
      ...reconciliation
    })]
  );

  if (cleared) {
    const clearedDevice = await client.query(
      `
        UPDATE device_identities
        SET status = 'ACTIVE', updated_at = NOW()
        WHERE device_identity = $1 AND status = 'FORKED'
      `,
      [session.device_identity]
    );
    if (clearedDevice.rowCount !== 1) throw routeError(409, "device_status_changed");
  }

  return { outcome, reasons };
}

export async function registerRecoveryRoutes(app) {
  app.post("/recovery/sessions", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    bodyLimit: config.recoveryPartBodyLimitBytes
  }, async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;
    try {
      validateSessionBody(request.body);
      const body = request.body;
      if (body.device_identity !== auth.device_identity) {
        throw routeError(403, "device_mismatch", {
          responseBody: { error: "Device does not match this session." }
        });
      }
      const result = await withTransaction(async (client) => {
        // Takeover uses the completion/integrity order: advisory lock first,
        // then the device row, then recovery-session/reservation rows.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`ledger-integrity:${body.device_identity}`]
        );
        await lockOwnedDevice(client, body.device_identity, auth.account_id);
        const existing = (await client.query(
          `SELECT * FROM recovery_sessions WHERE recovery_id = $1 LIMIT 1 FOR UPDATE`,
          [body.recovery_id]
        )).rows[0];
        if (existing) {
          if (existing.device_identity !== body.device_identity || existing.user_id !== auth.account_id) {
            throw routeError(409, "recovery_id_conflict");
          }
          return {
            recovery_id: existing.recovery_id,
            state: existing.state,
            received_bound_seconds: Number(existing.received_bound_seconds),
            head: await ledgerHead(client, body.device_identity)
          };
        }

        const active = (await client.query(
          `
            SELECT *, lease_expires_at > clock_timestamp() AS lease_unexpired
            FROM recovery_sessions
            WHERE device_identity = $1
              AND state IN ('open', 'uploaded', 'planned', 'syncing')
            LIMIT 1
            FOR UPDATE
          `,
          [body.device_identity]
        )).rows[0];
        if (active && active.lease_unexpired) {
          throw routeError(409, "recovery_session_active", { retryAfter: config.recoveryRetryAfterSeconds });
        }
        if (active) {
          await client.query(`UPDATE recovery_sessions SET state = 'superseded' WHERE recovery_id = $1`, [active.recovery_id]);
        }

        const integrityHwm = (await client.query(
          `SELECT COALESCE(MAX(id), 0)::bigint AS hwm FROM ledger_integrity_events WHERE device_identity = $1`,
          [body.device_identity]
        )).rows[0].hwm;
        await client.query(
          `
            INSERT INTO recovery_sessions (
              recovery_id, device_identity, user_id, state, app_version,
              local_summary, integrity_hwm, received_bound_seconds,
              lease_expires_at, started_at
            ) VALUES ($1, $2, $3, 'open', $4, $5::jsonb, $6,
              FLOOR(EXTRACT(EPOCH FROM clock_timestamp()))::bigint,
              clock_timestamp() + $7::interval, clock_timestamp())
          `,
          [
            body.recovery_id,
            body.device_identity,
            auth.account_id,
            body.app_version.trim(),
            JSON.stringify(body.local_summary),
            integrityHwm,
            leaseIntervalSql()
          ]
        );
        if (active) {
          const reconciled = await client.query(
            `
              UPDATE recovery_reservations AS reservation
              SET status = 'accepted', accepted_at = COALESCE(accepted_at, clock_timestamp())
              WHERE reservation.recovery_id = $1
                AND reservation.status = 'reserved'
                AND EXISTS (
                  SELECT 1 FROM ledger_entries AS entry
                  WHERE entry.device_identity = reservation.device_identity
                    AND entry.entry_id = reservation.planned_entry_id
                    AND entry.entry_hash = reservation.planned_entry_hash
                )
              RETURNING original_entry_hash
            `,
            [active.recovery_id]
          );
          const adopted = await client.query(
            `
              UPDATE recovery_reservations
              SET recovery_id = $2
              WHERE recovery_id = $1 AND status = 'accepted'
              RETURNING original_entry_hash
            `,
            [active.recovery_id, body.recovery_id]
          );
          const released = await client.query(
            `
              UPDATE recovery_reservations
              SET status = 'released'
              WHERE recovery_id = $1 AND status = 'reserved'
              RETURNING original_entry_hash
            `,
            [active.recovery_id]
          );
          await client.query(
            `
              INSERT INTO recovery_audit_events (device_identity, recovery_id, kind, detail, created_at)
              VALUES ($1, $2, 'recovery_lease_superseded', $3::jsonb, clock_timestamp())
            `,
            [body.device_identity, active.recovery_id, JSON.stringify({
              superseded_by: body.recovery_id,
              reconciled_from_ledger: reconciled.rowCount,
              adopted_accepted: adopted.rowCount,
              released_absent: released.rowCount
            })]
          );
        }
        await client.query(
          `
            INSERT INTO recovery_audit_events (device_identity, recovery_id, kind, detail, created_at)
            VALUES ($1, $2, 'recovery_started', $3::jsonb, clock_timestamp())
          `,
          [body.device_identity, body.recovery_id, JSON.stringify({ integrity_hwm: Number(integrityHwm) })]
        );
        const created = (await client.query(
          `SELECT received_bound_seconds FROM recovery_sessions WHERE recovery_id = $1`,
          [body.recovery_id]
        )).rows[0];
        return {
          recovery_id: body.recovery_id,
          state: "open",
          received_bound_seconds: Number(created.received_bound_seconds),
          head: await ledgerHead(client, body.device_identity)
        };
      });
      return reply.send(result);
    } catch (error) {
      if (error.code === "23505") return sendRouteError(reply, routeError(409, "recovery_id_conflict"));
      return sendRouteError(reply, error);
    }
  });

  app.put("/recovery/sessions/:id/parts/:n", {
    config: { rateLimit: { max: 180, timeWindow: "1 minute" } },
    bodyLimit: config.recoveryPartBodyLimitBytes
  }, async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;
    try {
      const recoveryId = String(request.params.id || "");
      const partText = String(request.params.n || "");
      const partNo = /^\d+$/.test(partText) ? Number(partText) : -1;
      if (!isUuid(recoveryId)
          || !Number.isSafeInteger(partNo)
          || partNo < 0
          || partNo >= config.recoveryMaxParts) {
        throw routeError(400, "invalid_recovery_part_number");
      }
      const declaredParts = validatePartBody(request.body);
      if (partNo >= request.body.part_count
          || declaredParts[partNo]?.sha256 !== request.body.sha256) {
        throw routeError(400, "recovery_part_declaration_mismatch");
      }
      const payload = { records: request.body.records, queue: request.body.queue };
      if (recoveryPartSha256(payload) !== request.body.sha256) throw routeError(400, "recovery_part_hash_mismatch");
      const result = await withTransaction(async (client) => {
        await lockOwnedDevice(client, auth.device_identity, auth.account_id);
        const session = await lockOwnedSession(client, recoveryId, auth);
        assertMutableSession(session);
        if (session.declared_part_count !== null
            && (Number(session.declared_part_count) !== request.body.part_count
              || canonicalJson(session.declared_part_hashes) !== canonicalJson(declaredParts))) {
          throw routeError(409, "recovery_part_declaration_conflict");
        }
        const existing = (await client.query(
          `SELECT sha256, payload = $3::jsonb AS same_payload FROM recovery_parts WHERE recovery_id = $1 AND part_no = $2`,
          [recoveryId, partNo, JSON.stringify(payload)]
        )).rows[0];
        if (existing && (existing.sha256 !== request.body.sha256 || !existing.same_payload)) {
          throw routeError(409, "recovery_part_conflict");
        }
        if (!existing) {
          await client.query(
            `INSERT INTO recovery_parts (recovery_id, part_no, sha256, payload) VALUES ($1, $2, $3, $4::jsonb)`,
            [recoveryId, partNo, request.body.sha256, JSON.stringify(payload)]
          );
        }
        const received = (await client.query(
          `SELECT part_no, sha256 FROM recovery_parts WHERE recovery_id = $1 ORDER BY part_no`,
          [recoveryId]
        )).rows;
        const preservationComplete = received.length === request.body.part_count
          && received.every((row, index) => (
            Number(row.part_no) === index && row.sha256 === declaredParts[index].sha256
          ));
        await client.query(
          `
            UPDATE recovery_sessions
            SET declared_part_count = $2,
                declared_part_hashes = $3::jsonb,
                state = CASE WHEN $4::boolean AND state = 'open' THEN 'uploaded' ELSE state END,
                lease_expires_at = clock_timestamp() + $5::interval
            WHERE recovery_id = $1
          `,
          [
            recoveryId,
            request.body.part_count,
            JSON.stringify(declaredParts),
            preservationComplete,
            leaseIntervalSql()
          ]
        );
        return {
          n: partNo,
          sha256: request.body.sha256,
          preservation_complete: preservationComplete
        };
      });
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });

  app.post("/recovery/sessions/:id/plan", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;
    try {
      const recoveryId = String(request.params.id || "");
      if (!isUuid(recoveryId)) throw routeError(400, "invalid_recovery_id");
      validatePlanBody(request.body);
      const replacements = request.body.replacements;
      const result = await withTransaction(async (client) => {
        const device = await lockOwnedDevice(client, auth.device_identity, auth.account_id);
        const session = await lockOwnedSession(client, recoveryId, auth);
        assertMutableSession(session);
        const otherActive = (await client.query(
          `
            SELECT 1 FROM recovery_sessions
            WHERE device_identity = $1 AND recovery_id <> $2
              AND state IN ('open', 'uploaded', 'planned', 'syncing')
            LIMIT 1
          `,
          [session.device_identity, recoveryId]
        )).rows[0];
        if (otherActive) throw routeError(409, "recovery_session_active");

        // Revalidate stored bytes on every plan call, including an idempotent
        // resend, before consulting or returning any reservation mapping.
        const partRows = await loadCompletePreservation(client, session);

        const ownRows = (await client.query(
          `SELECT * FROM recovery_reservations WHERE recovery_id = $1 ORDER BY planned_entry_id FOR UPDATE`,
          [recoveryId]
        )).rows;
        const exact = replacements.length > 0 && replacements.every((item) => ownRows.some((row) => (
          row.original_entry_hash === item.original_entry_hash
          && Number(row.original_local_id) === item.original_local_id
          && Number(row.original_signed_id) === item.original_signed_id
          && Number(row.planned_entry_id) === item.planned_entry_id
          && row.planned_entry_hash === item.planned_entry_hash
          && row.date_check === item.date_check
          && (row.status === "reserved" || row.status === "accepted")
        )));
        const emptyExact = replacements.length === 0
          && (session.state === "planned" || session.state === "syncing")
          && ownRows.every((row) => row.status === "accepted");
        if (emptyExact || exact) {
          await client.query(
            `UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() + $2::interval WHERE recovery_id = $1`,
            [recoveryId, leaseIntervalSql()]
          );
          return { recovery_id: recoveryId, reserved: replacements.length, idempotent: true };
        }
        if (session.state === "planned" || session.state === "syncing") throw routeError(409, "recovery_plan_conflict");

        const uploadedOriginals = collectUploadedOriginals(partRows);
        const ledgerRows = (await client.query(
          `SELECT entry_id, entry_hash FROM ledger_entries WHERE device_identity = $1 ORDER BY entry_id`,
          [session.device_identity]
        )).rows;
        const analysis = analyzeOriginals(uploadedOriginals, ledgerRows, device);
        for (const item of replacements) {
          const original = analysis.get(item.original_entry_hash);
          if (!original
              || original.verificationReason
              || !original.reproducedDefect
              || !original.rawLocalIds.has(item.original_local_id)
              || original.signedId !== item.original_signed_id) {
            throw routeError(409, "recovery_plan_original_unverified");
          }
          const computedDateCheck = classifyOriginalDate(
            original.entry.confirmed_at,
            session.received_bound_seconds
          );
          if (computedDateCheck === "unrepresentable") {
            throw routeError(409, "recovery_plan_unrepresentable_original");
          }
          if (computedDateCheck !== item.date_check) {
            throw routeError(409, "recovery_plan_date_check_mismatch");
          }
        }

        const head = await ledgerHead(client, session.device_identity);
        for (let index = 0; index < replacements.length; index += 1) {
          if (replacements[index].planned_entry_id !== head.entry_id + index + 1) {
            throw routeError(409, "recovery_plan_not_contiguous");
          }
        }

        if (replacements.length) {
          const plannedIds = replacements.map((item) => item.planned_entry_id);
          const plannedHashes = replacements.map((item) => item.planned_entry_hash);
          const ledgerCollision = (await client.query(
            `
              SELECT 1 FROM ledger_entries
              WHERE (device_identity = $1 AND entry_id = ANY($2::bigint[]))
                 OR entry_hash = ANY($3::text[])
              LIMIT 1
            `,
            [session.device_identity, plannedIds, plannedHashes]
          )).rows[0];
          if (ledgerCollision) throw routeError(409, "recovery_plan_ledger_collision");

          const allReservations = (await client.query(
            `SELECT * FROM recovery_reservations WHERE device_identity = $1 FOR UPDATE`,
            [session.device_identity]
          )).rows;
          for (const item of replacements) {
            const original = allReservations.find((row) => row.original_entry_hash === item.original_entry_hash);
            if (original && original.status !== "released") throw routeError(409, "recovery_original_already_reserved");
            const plannedCollision = allReservations.find((row) => (
              Number(row.planned_entry_id) === item.planned_entry_id
              || row.planned_entry_hash === item.planned_entry_hash
            ));
            if (plannedCollision && plannedCollision.original_entry_hash !== item.original_entry_hash) {
              throw routeError(409, "recovery_plan_reservation_collision");
            }
          }

          for (const item of replacements) {
            const updated = await client.query(
              `
                UPDATE recovery_reservations
                SET original_local_id = $3, original_signed_id = $4,
                    planned_entry_id = $5, planned_entry_hash = $6,
                    recovery_id = $7, status = 'reserved', date_check = $8,
                    reserved_at = clock_timestamp(), accepted_at = NULL
                WHERE device_identity = $1 AND original_entry_hash = $2 AND status = 'released'
              `,
              [
                session.device_identity,
                item.original_entry_hash,
                item.original_local_id,
                item.original_signed_id,
                item.planned_entry_id,
                item.planned_entry_hash,
                recoveryId,
                item.date_check
              ]
            );
            if (!updated.rowCount) {
              await client.query(
                `
                  INSERT INTO recovery_reservations (
                    device_identity, original_entry_hash, original_local_id, original_signed_id,
                    planned_entry_id, planned_entry_hash, recovery_id, status, date_check
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8)
                `,
                [
                  session.device_identity,
                  item.original_entry_hash,
                  item.original_local_id,
                  item.original_signed_id,
                  item.planned_entry_id,
                  item.planned_entry_hash,
                  recoveryId,
                  item.date_check
                ]
              );
            }
          }
        }

        await client.query(
          `
            UPDATE recovery_sessions
            SET state = 'planned', lease_expires_at = clock_timestamp() + $2::interval
            WHERE recovery_id = $1
          `,
          [recoveryId, leaseIntervalSql()]
        );
        await client.query(
          `
            INSERT INTO recovery_audit_events (device_identity, recovery_id, kind, detail, created_at)
            VALUES ($1, $2, 'recovery_planned', $3::jsonb, clock_timestamp())
          `,
          [session.device_identity, recoveryId, JSON.stringify({ replacements: replacements.length })]
        );
        return { recovery_id: recoveryId, reserved: replacements.length, idempotent: false };
      });
      return reply.send(result);
    } catch (error) {
      if (error.code === "23505") return sendRouteError(reply, routeError(409, "recovery_plan_collision"));
      return sendRouteError(reply, error);
    }
  });

  app.post("/recovery/sessions/:id/complete", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const auth = await authenticateRequest(request, reply);
    if (!auth) return reply;
    try {
      const recoveryId = String(request.params.id || "");
      if (!isUuid(recoveryId)
          || !hasExactKeys(request.body, ["manifest", "manifest_hash"])
          || !isHash(request.body.manifest_hash)) {
        throw routeError(400, "invalid_recovery_completion");
      }
      const manifest = validateRecoveryManifest(request.body.manifest);
      const manifestHash = sha256Canonical(manifest);
      if (manifestHash !== request.body.manifest_hash) throw routeError(400, "recovery_manifest_hash_mismatch");

      const preliminary = await withTransaction(async (client) => {
        const row = (await client.query(
          `SELECT device_identity, user_id FROM recovery_sessions WHERE recovery_id = $1 LIMIT 1`,
          [recoveryId]
        )).rows[0];
        if (!row) throw routeError(404, "recovery_session_not_found");
        if (row.device_identity !== auth.device_identity || row.user_id !== auth.account_id) {
          throw routeError(403, "recovery_session_forbidden");
        }
        return row;
      });

      const result = await withTransaction(async (client) => {
        // Fixed RC3 order: device advisory lock, device row, then recovery tables.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`ledger-integrity:${preliminary.device_identity}`]
        );
        const device = await lockOwnedDevice(client, preliminary.device_identity, auth.account_id);
        const session = await lockOwnedSession(client, recoveryId, auth);
        if (session.outcome) {
          if (session.manifest_hash !== manifestHash) throw routeError(409, "recovery_completion_conflict");
          return { outcome: session.outcome, reasons: session.outcome_reasons || [] };
        }
        assertMutableSession(session);
        return completeRecovery(client, session, device, manifest, manifestHash);
      });
      return reply.send(result);
    } catch (error) {
      return sendRouteError(reply, error);
    }
  });
}
