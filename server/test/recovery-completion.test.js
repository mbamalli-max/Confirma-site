import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { canonicalJson, recoveryPartSha256 } from "../src/routes/recovery.js";
import { purgeRecoveryPayloads } from "../scripts/purge-recovery-payloads.mjs";
import { assertLocalTestDatabase, waitForBackendsBlockedBy } from "./helpers/db.js";
import {
  advanceHead,
  applyRecoveryMigrations,
  buildRecoveryApp,
  createRecovery,
  ledgerEntry,
  resetRecoveryDatabase,
  seedRecoveryDevice,
  setRecoveryAutoclear,
  signLedgerEntry,
  syncEntries,
  uploadRecoveryParts
} from "./helpers/recovery.js";

assertLocalTestDatabase(config.databaseUrl);
let app;

function manifestHash(manifest) {
  return crypto.createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");
}

async function complete(device, recoveryId, manifest) {
  return app.inject({
    method: "POST",
    url: `/recovery/sessions/${recoveryId}/complete`,
    headers: device.headers,
    payload: { manifest, manifest_hash: manifestHash(manifest) }
  });
}

function c1ImportedCopy(record, index = 0) {
  const operatingRegion = record.operating_region || record.country;
  return {
    id: 1000000000 + index + 1,
    server_entry_id: record.id,
    importedFromServer: true,
    device_identity: record.device_identity,
    transaction_type: record.transaction_type,
    label: record.label || "Imported record",
    normalized_label: record.normalized_label,
    amount_minor: record.amount_minor,
    currency: record.currency,
    counterparty: record.counterparty ?? null,
    source_account: record.source_account ?? null,
    destination_account: record.destination_account ?? null,
    input_mode: record.input_mode || "server_restore",
    confirmation_state: "confirmed",
    business_type_id: record.business_type_id ?? null,
    sector_id: record.sector_id ?? null,
    country: operatingRegion,
    operating_region: operatingRegion,
    reversed_entry_hash: record.reversed_entry_hash ?? null,
    reversed_transaction_type: record.reversed_transaction_type ?? null,
    confirmed_at: record.confirmed_at,
    prev_entry_hash: record.prev_entry_hash,
    entry_hash: record.entry_hash,
    signature: record.signature,
    public_key_fingerprint: record.public_key_fingerprint ?? null
  };
}

async function buildC1ShapeRecovery({ mutateImported = null, includeAcceptedCopies = true } = {}) {
  setRecoveryAutoclear(true);
  const device = await seedRecoveryDevice();
  const accepted = ledgerEntry(device, {
    label: "Accepted local record",
    input_mode: "manual",
    confirmation_state: "confirmed",
    sector_id: "retail",
    operating_region: "NG",
    public_key_fingerprint: "test-fingerprint",
    evidence_level: "device_signed"
  });
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);
  const imported = c1ImportedCopy(accepted);
  if (mutateImported) mutateImported(imported);
  const acceptedLocalCopy = {
    ...structuredClone(accepted),
    evidence_level: "server_attested",
    server_entry_id: accepted.id
  };
  const rejected = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1,
    prev_entry_hash: "0".repeat(64),
    label: "Rejected local record",
    normalized_label: `rejected-c1-${crypto.randomUUID()}`,
    input_mode: "manual",
    confirmation_state: "confirmed",
    sector_id: "retail",
    operating_region: "NG"
  });
  await query(
    `INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
     VALUES ($1, 1, 'fork_id_conflict', $2::jsonb)`,
    [device.deviceIdentity, JSON.stringify({ received_entry_hash: rejected.entry_hash })]
  );
  const { recoveryId } = await createRecovery(app, device);
  await query(
    "UPDATE recovery_sessions SET received_bound_seconds = $2 WHERE recovery_id = $1",
    [recoveryId, rejected.confirmed_at + 3600]
  );
  const payload = {
    records: [imported, ...(includeAcceptedCopies ? [acceptedLocalCopy] : []), rejected],
    queue: [...(includeAcceptedCopies ? [accepted] : []), rejected].map((entry) => ({
      entry_id: entry.id,
      entry_hash: entry.entry_hash,
      device_identity: entry.device_identity,
      status: "queued",
      entry_payload: structuredClone(entry)
    }))
  };
  const uploaded = await uploadRecoveryParts(app, device, recoveryId, [payload]);
  assert.equal(uploaded.responses[0].statusCode, 200);
  const storedBefore = (await query(
    "SELECT payload::text AS payload_text FROM recovery_parts WHERE recovery_id = $1 AND part_no = 0",
    [recoveryId]
  )).rows[0].payload_text;
  const replacement = ledgerEntry(device, {
    ...rejected,
    id: 2,
    prev_entry_hash: accepted.entry_hash
  });
  const reservation = {
    original_entry_hash: rejected.entry_hash,
    original_local_id: rejected.id,
    original_signed_id: rejected.id,
    planned_entry_id: replacement.id,
    planned_entry_hash: replacement.entry_hash,
    date_check: "ok"
  };
  const planned = await app.inject({
    method: "POST",
    url: `/recovery/sessions/${recoveryId}/plan`,
    headers: device.headers,
    payload: { replacements: [reservation] }
  });
  assert.equal(planned.statusCode, 200);
  assert.equal((await syncEntries(app, device, [replacement])).statusCode, 200);
  const manifest = {
    parts: [{ part_no: 0, sha256: recoveryPartSha256(payload) }],
    items: [
      {
        original_entry_hash: accepted.entry_hash,
        original_local_id: imported.id,
        original_signed_id: accepted.id,
        original_confirmed_at: imported.confirmed_at,
        disposition: "accepted",
        date_check: null,
        replacement_entry_id: null,
        replacement_entry_hash: null
      },
      {
        original_entry_hash: rejected.entry_hash,
        original_local_id: rejected.id,
        original_signed_id: rejected.id,
        original_confirmed_at: rejected.confirmed_at,
        disposition: "replaced",
        date_check: "ok",
        replacement_entry_id: replacement.id,
        replacement_entry_hash: replacement.entry_hash
      }
    ],
    rejected_entry_hashes: [rejected.entry_hash],
    own_imported: [{ entry_id: accepted.id, entry_hash: accepted.entry_hash }]
  };
  return {
    device, recoveryId, accepted, imported, rejected, replacement,
    manifest, storedBefore
  };
}

async function buildValidRecovery({
  autoclear = false,
  deviceStatus = "FORKED",
  dateCheck = "ok",
  confirmedAt = 1793000200,
  mutateOriginal = null,
  replacementOverrides = {},
  uploadedExtras = null,
  expectedPlanStatus = 200
} = {}) {
  setRecoveryAutoclear(autoclear);
  const device = await seedRecoveryDevice({ status: deviceStatus });
  const accepted = ledgerEntry(device, { confirmed_at: 1793000100 });
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);
  const rejected = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1,
    confirmed_at: confirmedAt,
    label: "Preserved recovery label",
    normalized_label: `rejected-${crypto.randomUUID()}`,
    sector_id: "retail",
    input_mode: "manual",
    prev_entry_hash: "0".repeat(64)
  });
  if (mutateOriginal) mutateOriginal(rejected, device);
  const rejectedHash = rejected.entry_hash;
  await query(
    `
      INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
      VALUES ($1, 1, 'fork_id_conflict', $2::jsonb)
    `,
    [device.deviceIdentity, JSON.stringify({ received_entry_hash: rejectedHash, stored_entry_hash: accepted.entry_hash })]
  );
  const { recoveryId, response } = await createRecovery(app, device);
  assert.equal(response.statusCode, 200);
  const receivedBound = dateCheck === "future"
    ? confirmedAt - 3600
    : (dateCheck === "after_receipt_bound" ? confirmedAt - 2 * 86400 : confirmedAt + 3600);
  await query(
    "UPDATE recovery_sessions SET received_bound_seconds = $2 WHERE recovery_id = $1",
    [recoveryId, receivedBound]
  );
  const extras = uploadedExtras ? uploadedExtras(device, { accepted, rejected }) : {};
  const partPayload = {
    records: [accepted, rejected, ...(extras.records || [])],
    queue: extras.queue || []
  };
  const partSha = recoveryPartSha256(partPayload);
  const { responses: [partResponse] } = await uploadRecoveryParts(
    app, device, recoveryId, [partPayload]
  );
  assert.equal(partResponse.statusCode, 200);
  const replacement = ledgerEntry(device, {
    ...rejected,
    id: device.head.id + 1,
    prev_entry_hash: device.head.hash,
    confirmed_at: confirmedAt,
    ...replacementOverrides
  });
  const reservation = {
    original_entry_hash: rejectedHash,
    original_local_id: 1,
    original_signed_id: 1,
    planned_entry_id: replacement.id,
    planned_entry_hash: replacement.entry_hash,
    date_check: dateCheck
  };
  const planned = await app.inject({
    method: "POST",
    url: `/recovery/sessions/${recoveryId}/plan`,
    headers: device.headers,
    payload: { replacements: [reservation] }
  });
  assert.equal(planned.statusCode, expectedPlanStatus);
  if (planned.statusCode === 200) {
    assert.equal((await syncEntries(app, device, [replacement])).statusCode, 200);
  }
  const manifest = {
    parts: [{ part_no: 0, sha256: partSha }],
    items: [
      {
        original_entry_hash: accepted.entry_hash,
        original_local_id: accepted.id,
        original_signed_id: accepted.id,
        original_confirmed_at: accepted.confirmed_at,
        disposition: "accepted",
        date_check: null,
        replacement_entry_id: null,
        replacement_entry_hash: null
      },
      {
        original_entry_hash: rejectedHash,
        original_local_id: 1,
        original_signed_id: 1,
        original_confirmed_at: confirmedAt,
        disposition: "replaced",
        date_check: dateCheck,
        replacement_entry_id: replacement.id,
        replacement_entry_hash: replacement.entry_hash
      }
    ],
    rejected_entry_hashes: [rejectedHash],
    own_imported: [{ entry_id: accepted.id, entry_hash: accepted.entry_hash }]
  };
  return {
    device, accepted, rejected, rejectedHash, recoveryId, replacement, manifest, partSha, planned
  };
}

async function buildMissingConfirmedAtRecovery({ autoclear = true } = {}) {
  setRecoveryAutoclear(autoclear);
  const device = await seedRecoveryDevice();
  const accepted = ledgerEntry(device, { confirmed_at: 1793000100 });
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);
  const original = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1,
    prev_entry_hash: "0".repeat(64),
    normalized_label: `missing-confirmed-at-${crypto.randomUUID()}`
  });
  delete original.confirmed_at;
  signLedgerEntry(device, original);
  assert.equal(Object.hasOwn(original, "confirmed_at"), false);
  await query(
    `INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
     VALUES ($1, 1, 'fork_id_conflict', $2::jsonb)`,
    [device.deviceIdentity, JSON.stringify({
      received_entry_hash: original.entry_hash,
      stored_entry_hash: accepted.entry_hash
    })]
  );
  const { recoveryId, response } = await createRecovery(app, device);
  assert.equal(response.statusCode, 200);
  const payload = { records: [accepted, original], queue: [] };
  const uploaded = await uploadRecoveryParts(app, device, recoveryId, [payload]);
  assert.equal(uploaded.responses[0].statusCode, 200);
  const storedBefore = (await query(
    "SELECT payload::text AS payload_text FROM recovery_parts WHERE recovery_id = $1 AND part_no = 0",
    [recoveryId]
  )).rows[0].payload_text;
  const manifest = {
    parts: [{ part_no: 0, sha256: recoveryPartSha256(payload) }],
    items: [
      {
        original_entry_hash: accepted.entry_hash,
        original_local_id: accepted.id,
        original_signed_id: accepted.id,
        original_confirmed_at: accepted.confirmed_at,
        disposition: "accepted",
        date_check: null,
        replacement_entry_id: null,
        replacement_entry_hash: null
      },
      {
        original_entry_hash: original.entry_hash,
        original_local_id: original.id,
        original_signed_id: original.id,
        disposition: "unrepresentable",
        date_check: "unrepresentable",
        replacement_entry_id: null,
        replacement_entry_hash: null
      }
    ],
    rejected_entry_hashes: [original.entry_hash],
    own_imported: [{ entry_id: accepted.id, entry_hash: accepted.entry_hash }]
  };
  return { device, accepted, original, recoveryId, manifest, storedBefore };
}

before(async () => {
  config.jwtSecret = config.jwtSecret || "recovery-completion-test-secret";
  config.serverReceiptSecret = config.serverReceiptSecret || "recovery-completion-receipt-secret";
  await applyRecoveryMigrations();
  app = await buildRecoveryApp();
});

beforeEach(async () => {
  setRecoveryAutoclear(false);
  await resetRecoveryDatabase();
});

after(async () => {
  await app.close();
  await getPool().end();
});

test("autoclear off verifies and maps everything but returns a durable, idempotent not_cleared outcome", async () => {
  const fixture = await buildValidRecovery({ autoclear: false });
  const first = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), {
    outcome: "not_cleared",
    reasons: ["autoclear_disabled"],
    accounted_for: true
  });
  assert.equal((await query(
    "SELECT status FROM device_identities WHERE device_identity = $1",
    [fixture.device.deviceIdentity]
  )).rows[0].status, "FORKED");
  const mapping = (await query("SELECT * FROM ledger_recoveries")).rows[0];
  assert.equal(mapping.original_entry_hash, fixture.rejectedHash);
  assert.equal(mapping.date_check, "ok");
  const session = (await query(
    "SELECT outcome, outcome_reasons, reconciliation_result FROM recovery_sessions WHERE recovery_id = $1",
    [fixture.recoveryId]
  )).rows[0];
  assert.equal(session.outcome, "not_cleared");
  assert.equal(session.reconciliation_result.all_items_reported_by_device_accounted_for, true);

  const repeated = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
  assert.deepEqual(repeated.json(), first.json());
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM recovery_audit_events WHERE kind = 'recovery_completed_not_cleared'"
  )).rows[0].n, 1);
});

test("autoclear on clears exactly a valid FORKED device and recovery-start audit rows do not block it", async () => {
  const fixture = await buildValidRecovery({ autoclear: true });
  const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { outcome: "cleared", reasons: [], accounted_for: true });
  assert.equal((await query(
    "SELECT status FROM device_identities WHERE device_identity = $1",
    [fixture.device.deviceIdentity]
  )).rows[0].status, "ACTIVE");
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM recovery_audit_events WHERE kind = 'recovery_started'"
  )).rows[0].n, 1);
});

test("an ACTIVE device completes accounted without a device-row write or clear", async () => {
  const fixture = await buildValidRecovery({ autoclear: false, deviceStatus: "ACTIVE" });
  const blocker = await getPool().connect();
  let completion;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`ledger-integrity:${fixture.device.deviceIdentity}`]
    );
    const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    completion = complete(fixture.device, fixture.recoveryId, fixture.manifest);
    await waitForBackendsBlockedBy(getPool(), blockerPid, [/pg_advisory_xact_lock/]);
    const beforeDecision = (await query(
      `SELECT status, updated_at::text AS updated_at, xmin::text AS row_version
       FROM device_identities WHERE device_identity = $1`,
      [fixture.device.deviceIdentity]
    )).rows[0];
    await blocker.query("COMMIT");

    const response = await completion;
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      outcome: "not_cleared",
      reasons: ["device_active_nothing_to_clear", "autoclear_disabled"],
      accounted_for: true
    });
    const afterDecision = (await query(
      `SELECT status, updated_at::text AS updated_at, xmin::text AS row_version
       FROM device_identities WHERE device_identity = $1`,
      [fixture.device.deviceIdentity]
    )).rows[0];
    assert.deepEqual(afterDecision, beforeDecision);
    assert.equal(afterDecision.status, "ACTIVE");
    const session = (await query(
      `SELECT state, reconciliation_result
       FROM recovery_sessions WHERE recovery_id = $1`,
      [fixture.recoveryId]
    )).rows[0];
    assert.equal(session.state, "completed");
    assert.equal(session.reconciliation_result.all_items_reported_by_device_accounted_for, true);
    assert.equal((await query(
      `SELECT COUNT(*)::int AS n FROM recovery_audit_events
       WHERE recovery_id = $1 AND kind = 'recovery_completed_not_cleared'`,
      [fixture.recoveryId]
    )).rows[0].n, 1);

    const repeated = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
    assert.deepEqual(repeated.json(), response.json());
  } catch (error) {
    await blocker.query("ROLLBACK").catch(() => {});
    if (completion) await completion.catch(() => {});
    throw error;
  } finally {
    blocker.release();
  }
});

test("an ACTIVE device stays not_cleared when autoclear is enabled", async () => {
  const originalAutoclear = config.recoveryAutoclear;
  try {
    const fixture = await buildValidRecovery({ autoclear: true, deviceStatus: "ACTIVE" });
    const blocker = await getPool().connect();
    let completion;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`ledger-integrity:${fixture.device.deviceIdentity}`]
      );
      const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      completion = complete(fixture.device, fixture.recoveryId, fixture.manifest);
      await waitForBackendsBlockedBy(getPool(), blockerPid, [/pg_advisory_xact_lock/]);
      const beforeDecision = (await query(
        `SELECT status, updated_at::text AS updated_at, xmin::text AS row_version
         FROM device_identities WHERE device_identity = $1`,
        [fixture.device.deviceIdentity]
      )).rows[0];
      await blocker.query("COMMIT");

      const response = await completion;
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().accounted_for, true);
      assert.equal(response.json().outcome, "not_cleared");
      assert.ok(response.json().reasons.includes("device_active_nothing_to_clear"));
      assert.ok(!response.json().reasons.includes("autoclear_disabled"));

      const afterDecision = (await query(
        `SELECT status, updated_at::text AS updated_at, xmin::text AS row_version
         FROM device_identities WHERE device_identity = $1`,
        [fixture.device.deviceIdentity]
      )).rows[0];
      assert.deepEqual(afterDecision, beforeDecision);
      assert.equal(afterDecision.status, "ACTIVE");
      assert.equal((await query(
        "SELECT state FROM recovery_sessions WHERE recovery_id = $1",
        [fixture.recoveryId]
      )).rows[0].state, "completed");
      assert.equal((await query(
        `SELECT COUNT(*)::int AS n FROM recovery_audit_events
         WHERE recovery_id = $1 AND kind = 'recovery_completed_cleared'`,
        [fixture.recoveryId]
      )).rows[0].n, 0);
    } catch (error) {
      await blocker.query("ROLLBACK").catch(() => {});
      if (completion) await completion.catch(() => {});
      throw error;
    } finally {
      blocker.release();
    }
  } finally {
    setRecoveryAutoclear(originalAutoclear);
  }
});

test("an ACTIVE device with an unaccounted replacement escalates", async () => {
  const fixture = await buildValidRecovery({ autoclear: true, deviceStatus: "ACTIVE" });
  await query(
    `UPDATE recovery_reservations
     SET status = 'reserved', accepted_at = NULL
     WHERE recovery_id = $1`,
    [fixture.recoveryId]
  );
  const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
  await assertUnresolved(fixture, response, "reported_item_not_replaced", "ACTIVE");
  assert.ok(response.json().reasons.includes("device_active_nothing_to_clear"));
  assert.equal((await query(
    "SELECT status FROM device_identities WHERE device_identity = $1",
    [fixture.device.deviceIdentity]
  )).rows[0].status, "ACTIVE");
});

test("an ACTIVE device with an integrity event after the manifest HWM escalates", async () => {
  const fixture = await buildValidRecovery({ autoclear: true, deviceStatus: "ACTIVE" });
  await query(
    `INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
     VALUES ($1, 2, 'fork_id_conflict', $2::jsonb)`,
    [fixture.device.deviceIdentity, JSON.stringify({ received_entry_hash: fixture.rejectedHash })]
  );
  const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
  await assertUnresolved(fixture, response, "integrity_event_after_hwm", "ACTIVE");
  assert.equal((await query(
    "SELECT status FROM device_identities WHERE device_identity = $1",
    [fixture.device.deviceIdentity]
  )).rows[0].status, "ACTIVE");
});

test("a device in any other status is ineligible and not accounted", async () => {
  const fixture = await buildValidRecovery({ autoclear: true, deviceStatus: "ROTATED" });
  const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
  await assertUnresolved(fixture, response, "device_status_ineligible", "ROTATED");
  assert.equal((await query(
    "SELECT status FROM device_identities WHERE device_identity = $1",
    [fixture.device.deviceIdentity]
  )).rows[0].status, "ROTATED");
});

async function assertUnresolved(fixture, response, reason, expectedDeviceStatus = "FORKED") {
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().outcome, "not_cleared");
  assert.equal(response.json().accounted_for, false);
  assert.ok(response.json().reasons.includes(reason), response.body);
  const session = (await query(
    "SELECT state, reconciliation_result FROM recovery_sessions WHERE recovery_id = $1",
    [fixture.recoveryId]
  )).rows[0];
  assert.equal(session.state, "escalated");
  assert.equal(session.reconciliation_result.all_items_reported_by_device_accounted_for, false);
  assert.equal((await query(
    "SELECT status FROM device_identities WHERE device_identity = $1",
    [fixture.device.deviceIdentity]
  )).rows[0].status, expectedDeviceStatus);
}

test("actual C1 raw Class R identity is accepted without rewriting preserved evidence", async () => {
  const fixture = await buildC1ShapeRecovery();
  const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
  assert.deepEqual(response.json(), { outcome: "cleared", reasons: [], accounted_for: true });
  const session = (await query(
    "SELECT reconciliation_result FROM recovery_sessions WHERE recovery_id = $1",
    [fixture.recoveryId]
  )).rows[0];
  assert.equal(session.reconciliation_result.accepted_items, 1);
  assert.equal(session.reconciliation_result.replacement_mappings, 1);
  const duplicate = session.reconciliation_result.local_provenance_differences.find(
    (item) => item.original_entry_hash === fixture.rejected.entry_hash
  );
  assert.deepEqual(new Set(duplicate.copies.map((copy) => copy.source)), new Set(["records", "queue"]));
  const acceptedCopies = session.reconciliation_result.local_provenance_differences.find(
    (item) => item.original_entry_hash === fixture.accepted.entry_hash
  );
  assert.deepEqual(
    new Set(acceptedCopies.copies.map((copy) => copy.raw_local_id)),
    new Set([fixture.imported.id, fixture.accepted.id])
  );
  const storedAfter = (await query(
    "SELECT payload::text AS payload_text FROM recovery_parts WHERE recovery_id = $1 AND part_no = 0",
    [fixture.recoveryId]
  )).rows[0].payload_text;
  assert.equal(storedAfter, fixture.storedBefore);
  const mapping = (await query(
    "SELECT original_local_id, original_signed_id FROM ledger_recoveries WHERE recovery_id = $1",
    [fixture.recoveryId]
  )).rows[0];
  assert.equal(Number(mapping.original_local_id), 1);
  assert.equal(Number(mapping.original_signed_id), 1);
});

test("tampered C1 imported copies fail closed", async (t) => {
  for (const current of [
    {
      name: "changed amount",
      mutate: (entry) => { entry.amount_minor += 1; },
      reason: "original_hash_mismatch"
    },
    {
      name: "non-positive signed id",
      mutate: (entry) => { entry.server_entry_id = 0; },
      reason: "original_signed_id_invalid"
    }
  ]) {
    await t.test(current.name, async () => {
      await resetRecoveryDatabase();
      const fixture = await buildC1ShapeRecovery({
        mutateImported: current.mutate,
        includeAcceptedCopies: false
      });
      await assertUnresolved(
        fixture,
        await complete(fixture.device, fixture.recoveryId, fixture.manifest),
        current.reason
      );
      const storedAfter = (await query(
        "SELECT payload::text AS payload_text FROM recovery_parts WHERE recovery_id = $1 AND part_no = 0",
        [fixture.recoveryId]
      )).rows[0].payload_text;
      assert.equal(storedAfter, fixture.storedBefore);
    });
  }
});

test("empty uploaded backup ends unresolved and is never purge-eligible", async () => {
  setRecoveryAutoclear(true);
  const device = await seedRecoveryDevice();
  const { recoveryId } = await createRecovery(app, device);
  const payload = { records: [], queue: [] };
  const sha256 = recoveryPartSha256(payload);
  const uploaded = await uploadRecoveryParts(app, device, recoveryId, [payload]);
  assert.equal(uploaded.responses[0].statusCode, 200);
  const manifest = {
    parts: [{ part_no: 0, sha256 }],
    items: [],
    rejected_entry_hashes: [],
    own_imported: []
  };
  const response = await complete(device, recoveryId, manifest);
  await assertUnresolved({ device, recoveryId }, response, "empty_recovery_backup");
});

test("a truly missing confirmed_at round-trips without substitution and stays unresolved", async () => {
  const fixture = await buildMissingConfirmedAtRecovery();
  const serializedManifest = JSON.stringify(fixture.manifest);
  const clientManifest = JSON.parse(serializedManifest);
  const storedOriginal = JSON.parse(fixture.storedBefore).records.find(
    (record) => record.entry_hash === fixture.original.entry_hash
  );
  assert.equal(Object.hasOwn(storedOriginal, "confirmed_at"), false);
  assert.equal(Object.hasOwn(clientManifest.items[1], "original_confirmed_at"), false);
  assert.equal(manifestHash(clientManifest), manifestHash(fixture.manifest));

  const first = await complete(fixture.device, fixture.recoveryId, clientManifest);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), {
    outcome: "not_cleared",
    reasons: ["unrepresentable_items"],
    accounted_for: false
  });
  const session = (await query(
    `SELECT state, manifest_hash, manifest, reconciliation_result
     FROM recovery_sessions WHERE recovery_id = $1`,
    [fixture.recoveryId]
  )).rows[0];
  assert.equal(session.state, "escalated");
  assert.equal(session.manifest_hash, manifestHash(clientManifest));
  assert.equal(Object.hasOwn(session.manifest.items[1], "original_confirmed_at"), false);
  assert.equal(session.manifest.items[1].disposition, "unrepresentable");
  assert.equal(session.reconciliation_result.all_items_reported_by_device_accounted_for, false);
  assert.equal(session.reconciliation_result.unrepresentable_items, 1);
  assert.deepEqual(session.reconciliation_result.date_exceptions, {
    before_2000: 0,
    future: 0,
    after_receipt_bound: 0
  });
  assert.doesNotMatch(
    JSON.stringify(session.reconciliation_result),
    /original_confirmed_at|received_bound_seconds/
  );
  const audits = (await query(
    "SELECT kind, detail FROM recovery_audit_events WHERE recovery_id = $1 ORDER BY id",
    [fixture.recoveryId]
  )).rows;
  const completionAudit = audits.find((row) => row.kind === "recovery_unresolved");
  assert.equal(completionAudit.detail.unrepresentable_items, 1);
  assert.deepEqual(completionAudit.detail.date_exceptions, session.reconciliation_result.date_exceptions);
  assert.doesNotMatch(JSON.stringify(audits), /original_confirmed_at|received_bound_seconds/);
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM ledger_recoveries WHERE recovery_id = $1",
    [fixture.recoveryId]
  )).rows[0].n, 0);

  const repeated = await complete(fixture.device, fixture.recoveryId, clientManifest);
  assert.equal(repeated.statusCode, 200);
  assert.deepEqual(repeated.json(), first.json());
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM recovery_audit_events WHERE recovery_id = $1 AND kind = 'recovery_unresolved'",
    [fixture.recoveryId]
  )).rows[0].n, 1);
  const purge = await purgeRecoveryPayloads(getPool(), {
    now: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
  });
  assert.ok(!purge.recovery_ids.includes(fixture.recoveryId));
  const storedAfter = (await query(
    "SELECT payload::text AS payload_text FROM recovery_parts WHERE recovery_id = $1 AND part_no = 0",
    [fixture.recoveryId]
  )).rows[0].payload_text;
  assert.equal(storedAfter, fixture.storedBefore);
});

test("an absent manifest date mismatches an uploaded original with a date", async () => {
  const fixture = await buildValidRecovery({ autoclear: true });
  const item = fixture.manifest.items[1];
  delete item.original_confirmed_at;
  item.disposition = "unrepresentable";
  item.date_check = "unrepresentable";
  item.replacement_entry_id = null;
  item.replacement_entry_hash = null;
  const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().accounted_for, false);
  assert.ok(response.json().reasons.includes("original_confirmed_at_mismatch"));
});

test("a manifest date mismatches an uploaded original with no date", async () => {
  const fixture = await buildMissingConfirmedAtRecovery();
  fixture.manifest.items[1].original_confirmed_at = null;
  const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().accounted_for, false);
  assert.ok(response.json().reasons.includes("original_confirmed_at_mismatch"));
});

test("the absent date exception preserves every other manifest schema boundary", async () => {
  const invalidCases = [
    {
      name: "accepted",
      mutate: (manifest) => {
        manifest.items[1].disposition = "accepted";
        manifest.items[1].date_check = null;
        manifest.rejected_entry_hashes = [];
      }
    },
    {
      name: "replaced",
      mutate: (manifest) => {
        manifest.items[1].disposition = "replaced";
        manifest.items[1].date_check = "ok";
        manifest.items[1].replacement_entry_id = 2;
        manifest.items[1].replacement_entry_hash = "e".repeat(64);
      }
    },
    {
      name: "unknown key",
      mutate: (manifest) => { manifest.items[1].unexpected = true; }
    },
    {
      name: "another required key missing",
      mutate: (manifest) => { delete manifest.items[1].original_signed_id; }
    }
  ];
  for (const invalidCase of invalidCases) {
    await resetRecoveryDatabase();
    const fixture = await buildMissingConfirmedAtRecovery();
    invalidCase.mutate(fixture.manifest);
    const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
    assert.equal(response.statusCode, 400, invalidCase.name);
    assert.equal(response.json().code, "invalid_recovery_manifest", invalidCase.name);
  }

  await resetRecoveryDatabase();
  const unexplained = await buildMissingConfirmedAtRecovery();
  unexplained.manifest.items[1].disposition = "unexplained";
  unexplained.manifest.items[1].date_check = null;
  const response = await complete(unexplained.device, unexplained.recoveryId, unexplained.manifest);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().accounted_for, false);
  assert.ok(response.json().reasons.includes("unexplained_items"));
});

test("stored part bytes are re-hashed before planning and completion", async () => {
  setRecoveryAutoclear(true);
  const device = await seedRecoveryDevice();
  const accepted = ledgerEntry(device, { label: "accepted label" });
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);
  const rejected = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1,
    prev_entry_hash: "0".repeat(64),
    label: "original uncovered label",
    normalized_label: `digest-rejected-${crypto.randomUUID()}`
  });
  const { recoveryId } = await createRecovery(app, device);
  const payload = { records: [accepted, rejected], queue: [] };
  assert.equal((await uploadRecoveryParts(app, device, recoveryId, [payload])).responses[0].statusCode, 200);
  await query(
    `UPDATE recovery_parts
     SET payload = jsonb_set(payload, '{records,1,label}', to_jsonb($2::text), false)
     WHERE recovery_id = $1 AND part_no = 0`,
    [recoveryId, "tampered uncovered label"]
  );
  const damagedPayload = (await query(
    "SELECT payload::text AS payload_text, sha256 FROM recovery_parts WHERE recovery_id = $1 AND part_no = 0",
    [recoveryId]
  )).rows[0];
  assert.notEqual(recoveryPartSha256(JSON.parse(damagedPayload.payload_text)), damagedPayload.sha256);

  const replacement = ledgerEntry(device, {
    ...rejected,
    id: 2,
    prev_entry_hash: accepted.entry_hash
  });
  const refused = await app.inject({
    method: "POST",
    url: `/recovery/sessions/${recoveryId}/plan`,
    headers: device.headers,
    payload: {
      replacements: [{
        original_entry_hash: rejected.entry_hash,
        original_local_id: rejected.id,
        original_signed_id: rejected.id,
        planned_entry_id: replacement.id,
        planned_entry_hash: replacement.entry_hash,
        date_check: "ok"
      }]
    }
  });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, "stored_part_digest_mismatch");
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM recovery_reservations")).rows[0].n, 0);

  const manifest = {
    parts: [{ part_no: 0, sha256: damagedPayload.sha256 }],
    items: [
      {
        original_entry_hash: accepted.entry_hash,
        original_local_id: accepted.id,
        original_signed_id: accepted.id,
        original_confirmed_at: accepted.confirmed_at,
        disposition: "accepted",
        date_check: null,
        replacement_entry_id: null,
        replacement_entry_hash: null
      },
      {
        original_entry_hash: rejected.entry_hash,
        original_local_id: rejected.id,
        original_signed_id: rejected.id,
        original_confirmed_at: rejected.confirmed_at,
        disposition: "unexplained",
        date_check: null,
        replacement_entry_id: null,
        replacement_entry_hash: null
      }
    ],
    rejected_entry_hashes: [rejected.entry_hash],
    own_imported: [{ entry_id: accepted.id, entry_hash: accepted.entry_hash }]
  };
  const completed = await complete(device, recoveryId, manifest);
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().outcome, "not_cleared");
  assert.equal(completed.json().accounted_for, false);
  assert.ok(completed.json().reasons.includes("stored_part_digest_mismatch"));
  const repeated = await complete(device, recoveryId, manifest);
  assert.deepEqual(repeated.json(), completed.json());
  const session = (await query(
    "SELECT state, reconciliation_result FROM recovery_sessions WHERE recovery_id = $1",
    [recoveryId]
  )).rows[0];
  assert.equal(session.state, "escalated");
  assert.equal(session.reconciliation_result.all_items_reported_by_device_accounted_for, false);
  assert.equal((await query(
    "SELECT status FROM device_identities WHERE device_identity = $1",
    [device.deviceIdentity]
  )).rows[0].status, "FORKED");
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM ledger_recoveries")).rows[0].n, 0);
  const purge = await purgeRecoveryPayloads(getPool(), {
    now: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
  });
  assert.ok(!purge.recovery_ids.includes(recoveryId));
  const preservedAfter = (await query(
    "SELECT payload::text AS payload_text FROM recovery_parts WHERE recovery_id = $1 AND part_no = 0",
    [recoveryId]
  )).rows[0].payload_text;
  assert.equal(preservedAfter, damagedPayload.payload_text);
});

test("manifest originals must have been uploaded and every uploaded record must be reported", async (t) => {
  await t.test("manifest claims an original never uploaded", async () => {
    const fixture = await buildValidRecovery({ autoclear: true });
    const missingHash = "f".repeat(64);
    fixture.manifest.items.push({
      original_entry_hash: missingHash,
      original_local_id: 99,
      original_signed_id: 99,
      original_confirmed_at: 1793000999,
      disposition: "unexplained",
      date_check: null,
      replacement_entry_id: null,
      replacement_entry_hash: null
    });
    fixture.manifest.rejected_entry_hashes.push(missingHash);
    await assertUnresolved(
      fixture,
      await complete(fixture.device, fixture.recoveryId, fixture.manifest),
      "manifest_item_not_uploaded"
    );
  });

  await t.test("uploaded record omitted from manifest", async () => {
    const fixture = await buildValidRecovery({ autoclear: true });
    fixture.manifest.items = fixture.manifest.items.filter(
      (item) => item.original_entry_hash !== fixture.rejectedHash
    );
    fixture.manifest.rejected_entry_hashes = [];
    await assertUnresolved(
      fixture,
      await complete(fixture.device, fixture.recoveryId, fixture.manifest),
      "uploaded_item_omitted"
    );
  });

  await t.test("uploaded queue-only original omitted from manifest", async () => {
    let queueOnly;
    const fixture = await buildValidRecovery({
      autoclear: true,
      uploadedExtras: (device) => {
        queueOnly = ledgerEntry(device, { id: 7, normalized_label: "queue only" });
        return { queue: [{ entry_id: queueOnly.id, entry_hash: queueOnly.entry_hash, entry_payload: queueOnly }] };
      }
    });
    assert.ok(queueOnly);
    await assertUnresolved(
      fixture,
      await complete(fixture.device, fixture.recoveryId, fixture.manifest),
      "uploaded_item_omitted"
    );
  });
});

test("invalid uploaded originals are never eligible for replacement or clearing", async (t) => {
  const cases = [
    {
      name: "bad original signature",
      mutateOriginal: (entry) => { entry.signature = Buffer.alloc(64, 7).toString("base64"); },
      reason: "original_signature_invalid"
    },
    {
      name: "original hash does not recompute",
      mutateOriginal: (entry) => { entry.amount_minor += 1; },
      reason: "original_hash_mismatch"
    },
    {
      name: "wrong original device identity",
      mutateOriginal: (entry) => { entry.device_identity = `wrong-${entry.device_identity}`; },
      reason: "original_wrong_device_identity"
    },
    {
      name: "non-imported server id disagrees with signed id",
      mutateOriginal: (entry) => { entry.server_entry_id = entry.id + 1; },
      reason: "original_signed_id_mismatch"
    }
  ];
  for (const current of cases) {
    await t.test(current.name, async () => {
      await resetRecoveryDatabase();
      const fixture = await buildValidRecovery({
        autoclear: true,
        mutateOriginal: current.mutateOriginal,
        expectedPlanStatus: 409
      });
      assert.equal(fixture.planned.json().code, "recovery_plan_original_unverified");
      await assertUnresolved(
        fixture,
        await complete(fixture.device, fixture.recoveryId, fixture.manifest),
        current.reason
      );
    });
  }
});

test("replacements preserve every non-allowlisted field exactly", async (t) => {
  for (const current of [
    { name: "changed amount", overrides: { amount_minor: 999999 }, reason: "replacement_content_mismatch" },
    { name: "changed confirmed_at", overrides: { confirmed_at: 1793000201 }, reason: "reported_item_not_replaced" },
    { name: "changed label", overrides: { label: "Changed recovery label" }, reason: "replacement_content_mismatch" },
    { name: "changed sector_id", overrides: { sector_id: "hospitality" }, reason: "replacement_content_mismatch" },
    { name: "changed input_mode", overrides: { input_mode: "voice" }, reason: "replacement_content_mismatch" },
    { name: "added unknown key", overrides: { unknown_recovery_field: true }, reason: "replacement_content_mismatch" }
  ]) {
    await t.test(current.name, async () => {
      await resetRecoveryDatabase();
      const fixture = await buildValidRecovery({
        autoclear: true,
        replacementOverrides: current.overrides
      });
      await assertUnresolved(
        fixture,
        await complete(fixture.device, fixture.recoveryId, fixture.manifest),
        current.reason
      );
    });
  }
});

test("server-recomputed date_check must match both manifest and reservation", async () => {
  const fixture = await buildValidRecovery({ autoclear: true });
  fixture.manifest.items.find((item) => item.disposition === "replaced").date_check = "future";
  await assertUnresolved(
    fixture,
    await complete(fixture.device, fixture.recoveryId, fixture.manifest),
    "date_check_mismatch"
  );
});

test("a reversal of a replaced original must target that original's replacement hash", async () => {
  setRecoveryAutoclear(true);
  const device = await seedRecoveryDevice();
  const accepted = ledgerEntry(device, { normalized_label: "accepted collision" });
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);
  const firstOriginal = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1, prev_entry_hash: "0".repeat(64), normalized_label: "rejected sale"
  });
  const reversalOriginal = ledgerEntry({ ...device, head: { id: 1, hash: firstOriginal.entry_hash } }, {
    id: 2,
    prev_entry_hash: firstOriginal.entry_hash,
    transaction_type: "reversal",
    reversed_transaction_type: firstOriginal.transaction_type,
    reversed_entry_hash: firstOriginal.entry_hash,
    normalized_label: "rejected reversal"
  });
  await query(
    `INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
     VALUES ($1, 1, 'fork_id_conflict', $2::jsonb)`,
    [device.deviceIdentity, JSON.stringify({ received_entry_hash: firstOriginal.entry_hash })]
  );
  const { recoveryId } = await createRecovery(app, device);
  await query(
    "UPDATE recovery_sessions SET received_bound_seconds = $2 WHERE recovery_id = $1",
    [recoveryId, firstOriginal.confirmed_at + 3600]
  );
  const payload = { records: [accepted, firstOriginal, reversalOriginal], queue: [] };
  const uploaded = await uploadRecoveryParts(app, device, recoveryId, [payload]);
  assert.equal(uploaded.responses[0].statusCode, 200);
  const firstReplacement = ledgerEntry(device, {
    ...firstOriginal,
    id: 2,
    prev_entry_hash: accepted.entry_hash
  });
  const wrongReversal = ledgerEntry({ ...device, head: { id: 2, hash: firstReplacement.entry_hash } }, {
    ...reversalOriginal,
    id: 3,
    prev_entry_hash: firstReplacement.entry_hash,
    reversed_entry_hash: accepted.entry_hash
  });
  const planItems = [
    [firstOriginal, firstReplacement],
    [reversalOriginal, wrongReversal]
  ].map(([original, replacement]) => ({
    original_entry_hash: original.entry_hash,
    original_local_id: original.id,
    original_signed_id: original.id,
    planned_entry_id: replacement.id,
    planned_entry_hash: replacement.entry_hash,
    date_check: "ok"
  }));
  const planned = await app.inject({
    method: "POST",
    url: `/recovery/sessions/${recoveryId}/plan`,
    headers: device.headers,
    payload: { replacements: planItems }
  });
  assert.equal(planned.statusCode, 200);
  assert.equal((await syncEntries(app, device, [firstReplacement, wrongReversal])).statusCode, 200);
  const partSha = recoveryPartSha256(payload);
  const manifest = {
    parts: [{ part_no: 0, sha256: partSha }],
    items: [
      {
        original_entry_hash: accepted.entry_hash,
        original_local_id: accepted.id,
        original_signed_id: accepted.id,
        original_confirmed_at: accepted.confirmed_at,
        disposition: "accepted",
        date_check: null,
        replacement_entry_id: null,
        replacement_entry_hash: null
      },
      ...planItems.map((plannedItem, index) => ({
        original_entry_hash: plannedItem.original_entry_hash,
        original_local_id: plannedItem.original_local_id,
        original_signed_id: plannedItem.original_signed_id,
        original_confirmed_at: [firstOriginal, reversalOriginal][index].confirmed_at,
        disposition: "replaced",
        date_check: "ok",
        replacement_entry_id: plannedItem.planned_entry_id,
        replacement_entry_hash: plannedItem.planned_entry_hash
      }))
    ],
    rejected_entry_hashes: [firstOriginal.entry_hash, reversalOriginal.entry_hash],
    own_imported: [{ entry_id: accepted.id, entry_hash: accepted.entry_hash }]
  };
  await assertUnresolved(
    { device, recoveryId },
    await complete(device, recoveryId, manifest),
    "replacement_reversal_mismatch"
  );
});

test("a legitimate reversal remap is accepted", async () => {
  setRecoveryAutoclear(true);
  const device = await seedRecoveryDevice();
  const accepted = ledgerEntry(device, { normalized_label: "accepted reversal anchor" });
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);
  const firstOriginal = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1, prev_entry_hash: "0".repeat(64), normalized_label: "rejected remap sale"
  });
  const reversalOriginal = ledgerEntry({ ...device, head: { id: 1, hash: firstOriginal.entry_hash } }, {
    id: 2,
    prev_entry_hash: firstOriginal.entry_hash,
    transaction_type: "reversal",
    reversed_transaction_type: firstOriginal.transaction_type,
    reversed_entry_hash: firstOriginal.entry_hash,
    normalized_label: "rejected remap reversal"
  });
  await query(
    `INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
     VALUES ($1, 1, 'fork_id_conflict', $2::jsonb)`,
    [device.deviceIdentity, JSON.stringify({ received_entry_hash: firstOriginal.entry_hash })]
  );
  const { recoveryId } = await createRecovery(app, device);
  await query(
    "UPDATE recovery_sessions SET received_bound_seconds = $2 WHERE recovery_id = $1",
    [recoveryId, firstOriginal.confirmed_at + 3600]
  );
  const payload = { records: [accepted, firstOriginal, reversalOriginal], queue: [] };
  assert.equal((await uploadRecoveryParts(app, device, recoveryId, [payload])).responses[0].statusCode, 200);
  const firstReplacement = ledgerEntry(device, {
    ...firstOriginal,
    id: 2,
    prev_entry_hash: accepted.entry_hash
  });
  const reversalReplacement = ledgerEntry(
    { ...device, head: { id: 2, hash: firstReplacement.entry_hash } },
    {
      ...reversalOriginal,
      id: 3,
      prev_entry_hash: firstReplacement.entry_hash,
      reversed_entry_hash: firstReplacement.entry_hash
    }
  );
  const planItems = [
    [firstOriginal, firstReplacement],
    [reversalOriginal, reversalReplacement]
  ].map(([original, replacement]) => ({
    original_entry_hash: original.entry_hash,
    original_local_id: original.id,
    original_signed_id: original.id,
    planned_entry_id: replacement.id,
    planned_entry_hash: replacement.entry_hash,
    date_check: "ok"
  }));
  assert.equal((await app.inject({
    method: "POST",
    url: `/recovery/sessions/${recoveryId}/plan`,
    headers: device.headers,
    payload: { replacements: planItems }
  })).statusCode, 200);
  assert.equal((await syncEntries(app, device, [firstReplacement, reversalReplacement])).statusCode, 200);
  const manifest = {
    parts: [{ part_no: 0, sha256: recoveryPartSha256(payload) }],
    items: [
      {
        original_entry_hash: accepted.entry_hash,
        original_local_id: accepted.id,
        original_signed_id: accepted.id,
        original_confirmed_at: accepted.confirmed_at,
        disposition: "accepted",
        date_check: null,
        replacement_entry_id: null,
        replacement_entry_hash: null
      },
      ...planItems.map((item, index) => ({
        original_entry_hash: item.original_entry_hash,
        original_local_id: item.original_local_id,
        original_signed_id: item.original_signed_id,
        original_confirmed_at: [firstOriginal, reversalOriginal][index].confirmed_at,
        disposition: "replaced",
        date_check: "ok",
        replacement_entry_id: item.planned_entry_id,
        replacement_entry_hash: item.planned_entry_hash
      }))
    ],
    rejected_entry_hashes: [firstOriginal.entry_hash, reversalOriginal.entry_hash],
    own_imported: [{ entry_id: accepted.id, entry_hash: accepted.entry_hash }]
  };
  assert.deepEqual(
    (await complete(device, recoveryId, manifest)).json(),
    { outcome: "cleared", reasons: [], accounted_for: true }
  );
});

test("partial acceptance survives expiry, takeover, remaining sync, and completion", async () => {
  setRecoveryAutoclear(true);
  const device = await seedRecoveryDevice();
  const accepted = ledgerEntry(device, { normalized_label: "accepted collision" });
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);
  const firstOriginal = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1, prev_entry_hash: "0".repeat(64), normalized_label: "first rejected"
  });
  const secondOriginal = ledgerEntry({ ...device, head: { id: 1, hash: firstOriginal.entry_hash } }, {
    id: 2, prev_entry_hash: firstOriginal.entry_hash, normalized_label: "second rejected"
  });
  await query(
    `INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
     VALUES ($1, 1, 'fork_id_conflict', $2::jsonb)`,
    [device.deviceIdentity, JSON.stringify({ received_entry_hash: firstOriginal.entry_hash })]
  );
  const firstSession = await createRecovery(app, device);
  const bound = firstOriginal.confirmed_at + 3600;
  await query(
    "UPDATE recovery_sessions SET received_bound_seconds = $2 WHERE recovery_id = $1",
    [firstSession.recoveryId, bound]
  );
  const payload = { records: [accepted, firstOriginal, secondOriginal], queue: [] };
  assert.equal((await uploadRecoveryParts(
    app, device, firstSession.recoveryId, [payload]
  )).responses[0].statusCode, 200);
  const firstReplacement = ledgerEntry(device, {
    ...firstOriginal, id: 2, prev_entry_hash: accepted.entry_hash
  });
  const secondReplacement = ledgerEntry({ ...device, head: { id: 2, hash: firstReplacement.entry_hash } }, {
    ...secondOriginal, id: 3, prev_entry_hash: firstReplacement.entry_hash
  });
  const planItems = [
    [firstOriginal, firstReplacement],
    [secondOriginal, secondReplacement]
  ].map(([original, replacement]) => ({
    original_entry_hash: original.entry_hash,
    original_local_id: original.id,
    original_signed_id: original.id,
    planned_entry_id: replacement.id,
    planned_entry_hash: replacement.entry_hash,
    date_check: "ok"
  }));
  assert.equal((await app.inject({
    method: "POST",
    url: `/recovery/sessions/${firstSession.recoveryId}/plan`,
    headers: device.headers,
    payload: { replacements: planItems }
  })).statusCode, 200);
  assert.equal((await syncEntries(app, device, [firstReplacement])).statusCode, 200);
  await query(
    "UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE recovery_id = $1",
    [firstSession.recoveryId]
  );

  const takeover = await createRecovery(app, device);
  assert.equal(takeover.response.statusCode, 200);
  await query(
    "UPDATE recovery_sessions SET received_bound_seconds = $2 WHERE recovery_id = $1",
    [takeover.recoveryId, bound]
  );
  assert.equal((await uploadRecoveryParts(
    app, device, takeover.recoveryId, [payload]
  )).responses[0].statusCode, 200);
  assert.equal((await app.inject({
    method: "POST",
    url: `/recovery/sessions/${takeover.recoveryId}/plan`,
    headers: device.headers,
    payload: { replacements: [planItems[1]] }
  })).statusCode, 200);
  assert.equal((await syncEntries(app, device, [secondReplacement])).statusCode, 200);

  const manifest = {
    parts: [{ part_no: 0, sha256: recoveryPartSha256(payload) }],
    items: [
      {
        original_entry_hash: accepted.entry_hash,
        original_local_id: accepted.id,
        original_signed_id: accepted.id,
        original_confirmed_at: accepted.confirmed_at,
        disposition: "accepted",
        date_check: null,
        replacement_entry_id: null,
        replacement_entry_hash: null
      },
      ...planItems.map((plannedItem, index) => ({
        original_entry_hash: plannedItem.original_entry_hash,
        original_local_id: plannedItem.original_local_id,
        original_signed_id: plannedItem.original_signed_id,
        original_confirmed_at: [firstOriginal, secondOriginal][index].confirmed_at,
        disposition: "replaced",
        date_check: "ok",
        replacement_entry_id: plannedItem.planned_entry_id,
        replacement_entry_hash: plannedItem.planned_entry_hash
      }))
    ],
    rejected_entry_hashes: [firstOriginal.entry_hash, secondOriginal.entry_hash],
    own_imported: [{ entry_id: accepted.id, entry_hash: accepted.entry_hash }]
  };
  const completed = await complete(device, takeover.recoveryId, manifest);
  assert.deepEqual(completed.json(), { outcome: "cleared", reasons: [], accounted_for: true });
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM ledger_recoveries WHERE recovery_id = $1",
    [takeover.recoveryId]
  )).rows[0].n, 2);
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE device_identity = $1",
    [device.deviceIdentity]
  )).rows[0].n, 3);
});

test("manifest and uploaded part hashes must match before completion writes anything", async () => {
  const fixture = await buildValidRecovery({ autoclear: true });
  const badManifest = structuredClone(fixture.manifest);
  badManifest.parts[0].sha256 = "f".repeat(64);
  const response = await complete(fixture.device, fixture.recoveryId, badManifest);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, "recovery_part_manifest_mismatch");
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM ledger_recoveries")).rows[0].n, 0);
  assert.equal((await query(
    "SELECT outcome FROM recovery_sessions WHERE recovery_id = $1",
    [fixture.recoveryId]
  )).rows[0].outcome, null);
});

test("each completion proof condition fails closed with a machine reason", async (t) => {
  const cases = [
    {
      name: "reported accepted row is absent",
      mutate: async (fixture) => {
        fixture.manifest.items[0].original_entry_hash = "a".repeat(64);
        fixture.manifest.own_imported = [];
      },
      reason: "reported_item_not_accepted"
    },
    {
      name: "replacement reservation is not accepted",
      mutate: async (fixture) => {
        await query(
          "UPDATE recovery_reservations SET status = 'reserved', accepted_at = NULL WHERE recovery_id = $1",
          [fixture.recoveryId]
        );
      },
      reason: "reported_item_not_replaced"
    },
    {
      name: "ledger chain does not recompute",
      mutate: async (fixture) => {
        await query(
          "UPDATE ledger_entries SET prev_entry_hash = $2 WHERE device_identity = $1 AND entry_id = 2",
          [fixture.device.deviceIdentity, "9".repeat(64)]
        );
      },
      reason: "ledger_chain_invalid"
    },
    {
      name: "unexplained item is reported",
      mutate: async (fixture) => {
        const hash = "c".repeat(64);
        fixture.manifest.items.push({
          original_entry_hash: hash,
          original_local_id: 3,
          original_signed_id: 3,
          original_confirmed_at: 1793000300,
          disposition: "unexplained",
          date_check: null,
          replacement_entry_id: null,
          replacement_entry_hash: null
        });
        fixture.manifest.rejected_entry_hashes.push(hash);
      },
      reason: "unexplained_items"
    },
    {
      name: "unrepresentable item is reported",
      mutate: async (fixture) => {
        const hash = "d".repeat(64);
        fixture.manifest.items.push({
          original_entry_hash: hash,
          original_local_id: 3,
          original_signed_id: 3,
          original_confirmed_at: "not-a-date",
          disposition: "unrepresentable",
          date_check: "unrepresentable",
          replacement_entry_id: null,
          replacement_entry_hash: null
        });
        fixture.manifest.rejected_entry_hashes.push(hash);
      },
      reason: "unrepresentable_items"
    },
    {
      name: "own imported evidence is absent",
      mutate: async (fixture) => { fixture.manifest.own_imported = []; },
      reason: "missing_own_imported_match"
    },
    {
      name: "integrity event is newer than the high-water mark",
      mutate: async (fixture) => {
        await query(
          `
            INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
            VALUES ($1, 2, 'fork_id_conflict', $2::jsonb)
          `,
          [fixture.device.deviceIdentity, JSON.stringify({ received_entry_hash: fixture.rejectedHash })]
        );
      },
      reason: "integrity_event_after_hwm"
    }
  ];

  for (const current of cases) {
    await t.test(current.name, async () => {
      await resetRecoveryDatabase();
      const fixture = await buildValidRecovery({ autoclear: true });
      await current.mutate(fixture);
      const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().outcome, "not_cleared");
      assert.equal(response.json().accounted_for, false);
      assert.ok(response.json().reasons.includes(current.reason));
      assert.equal((await query(
        "SELECT status FROM device_identities WHERE device_identity = $1",
        [fixture.device.deviceIdentity]
      )).rows[0].status, "FORKED");
    });
  }
});

test("fork_continuity, hash_mismatch, unmatched conflicts, and events after hwm never auto-clear", async (t) => {
  for (const kind of ["fork_continuity", "hash_mismatch", "fork_id_conflict"]) {
    await t.test(kind, async () => {
      await resetRecoveryDatabase();
      const fixture = await buildValidRecovery({ autoclear: true });
      const detail = kind === "fork_id_conflict"
        ? { received_entry_hash: "e".repeat(64) }
        : { received_entry_hash: fixture.rejectedHash };
      await query(
        `
          INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
          VALUES ($1, 1, $2, $3::jsonb)
        `,
        [fixture.device.deviceIdentity, kind, JSON.stringify(detail)]
      );
      // Raise this session's bound only for the historical-event cases. This
      // distinguishes event-kind rejection from the newer-event rule.
      await query(
        `
          UPDATE recovery_sessions
          SET integrity_hwm = (SELECT MAX(id) FROM ledger_integrity_events WHERE device_identity = $2)
          WHERE recovery_id = $1
        `,
        [fixture.recoveryId, fixture.device.deviceIdentity]
      );
      const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
      assert.equal(response.json().outcome, "not_cleared");
      assert.equal(response.json().accounted_for, false);
      assert.ok(response.json().reasons.includes(
        kind === "fork_id_conflict" ? "unmatched_fork_conflict" : "ineligible_integrity_event"
      ));
    });
  }
});

test("every representable date_check and reported confirmed_at are written without substitution", async (t) => {
  for (const [dateCheck, confirmedAt] of [
    ["before_2000", 946684799],
    ["future", 1798848000],
    ["after_receipt_bound", 1893456000]
  ]) {
    await t.test(dateCheck, async () => {
      await resetRecoveryDatabase();
      const fixture = await buildValidRecovery({ autoclear: false, dateCheck, confirmedAt });
      const response = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
      assert.equal(response.statusCode, 200);
      const mapping = (await query(
        "SELECT date_check, original_confirmed_at FROM ledger_recoveries WHERE recovery_id = $1",
        [fixture.recoveryId]
      )).rows[0];
      assert.equal(mapping.date_check, dateCheck);
      assert.equal(mapping.original_confirmed_at, confirmedAt);
    });
  }
});

test("two concurrent completions serialize and commit one decision", async () => {
  const fixture = await buildValidRecovery({ autoclear: true });
  const [first, second] = await Promise.all([
    complete(fixture.device, fixture.recoveryId, fixture.manifest),
    complete(fixture.device, fixture.recoveryId, fixture.manifest)
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(first.json(), second.json());
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM ledger_recoveries")).rows[0].n, 1);
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM recovery_audit_events WHERE kind = 'recovery_completed_cleared'"
  )).rows[0].n, 1);
});

test("completion, integrity-event writing, and sync follow the lock order without deadlock", async () => {
  const fixture = await buildValidRecovery({ autoclear: true });
  const integrityWriter = await getPool().connect();
  let completions;
  try {
    await integrityWriter.query("BEGIN");
    await integrityWriter.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`ledger-integrity:${fixture.device.deviceIdentity}`]
    );
    completions = [
      complete(fixture.device, fixture.recoveryId, fixture.manifest),
      complete(fixture.device, fixture.recoveryId, fixture.manifest)
    ];

    const syncResend = await syncEntries(app, fixture.device, [fixture.replacement]);
    assert.equal(syncResend.statusCode, 200);
    await integrityWriter.query(
      `
        INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
        VALUES ($1, 2, 'fork_id_conflict', $2::jsonb)
      `,
      [fixture.device.deviceIdentity, JSON.stringify({ received_entry_hash: fixture.rejectedHash })]
    );
    await integrityWriter.query(
      `UPDATE device_identities SET status = 'FORKED', updated_at = NOW() WHERE device_identity = $1`,
      [fixture.device.deviceIdentity]
    );
    await integrityWriter.query("COMMIT");
  } catch (error) {
    await integrityWriter.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    integrityWriter.release();
  }
  const responses = await Promise.all(completions);
  for (const response of responses) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().outcome, "not_cleared");
    assert.equal(response.json().accounted_for, false);
    assert.ok(response.json().reasons.includes("integrity_event_after_hwm"));
  }
});

test("faults at each completion write boundary roll back all state and a retry succeeds", async (t) => {
  const boundaries = [
    {
      name: "mapping insert",
      install: () => query("ALTER TABLE ledger_recoveries ADD CONSTRAINT recovery_fault CHECK (false) NOT VALID"),
      remove: () => query("ALTER TABLE ledger_recoveries DROP CONSTRAINT recovery_fault")
    },
    {
      name: "session update",
      install: () => query("ALTER TABLE recovery_sessions ADD CONSTRAINT recovery_fault CHECK (outcome IS NULL) NOT VALID"),
      remove: () => query("ALTER TABLE recovery_sessions DROP CONSTRAINT recovery_fault")
    },
    {
      name: "audit insert",
      install: () => query("ALTER TABLE recovery_audit_events ADD CONSTRAINT recovery_fault CHECK (kind NOT IN ('recovery_completed_cleared')) NOT VALID"),
      remove: () => query("ALTER TABLE recovery_audit_events DROP CONSTRAINT recovery_fault")
    },
    {
      name: "flag clear",
      install: () => query("ALTER TABLE device_identities ADD CONSTRAINT recovery_fault CHECK (status <> 'ACTIVE') NOT VALID"),
      remove: () => query("ALTER TABLE device_identities DROP CONSTRAINT recovery_fault")
    }
  ];

  for (const boundary of boundaries) {
    await t.test(boundary.name, async () => {
      await resetRecoveryDatabase();
      const fixture = await buildValidRecovery({ autoclear: true });
      await boundary.install();
      try {
        const failed = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
        assert.equal(failed.statusCode, 500);
      } finally {
        await boundary.remove();
      }
      assert.equal((await query("SELECT COUNT(*)::int AS n FROM ledger_recoveries")).rows[0].n, 0);
      assert.equal((await query(
        "SELECT outcome FROM recovery_sessions WHERE recovery_id = $1",
        [fixture.recoveryId]
      )).rows[0].outcome, null);
      assert.equal((await query(
        "SELECT COUNT(*)::int AS n FROM recovery_audit_events WHERE kind LIKE 'recovery_completed%'"
      )).rows[0].n, 0);
      assert.equal((await query(
        "SELECT status FROM device_identities WHERE device_identity = $1",
        [fixture.device.deviceIdentity]
      )).rows[0].status, "FORKED");

      const retried = await complete(fixture.device, fixture.recoveryId, fixture.manifest);
      assert.equal(retried.statusCode, 200);
      assert.equal(retried.json().outcome, "cleared");
    });
  }
});
