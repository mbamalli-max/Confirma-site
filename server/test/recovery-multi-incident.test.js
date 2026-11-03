import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { canonicalJson, recoveryPartSha256 } from "../src/routes/recovery.js";
import { assertLocalTestDatabase } from "./helpers/db.js";
import {
  EMPTY_HASH,
  advanceHead,
  applyRecoveryMigrations,
  buildRecoveryApp,
  createRecovery,
  ledgerEntry,
  resetRecoveryDatabase,
  seedRecoveryDevice,
  setRecoveryAutoclear,
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

async function prepareIncident(device, acceptedRecords, original) {
  await query(
    "UPDATE device_identities SET status = 'FORKED' WHERE device_identity = $1",
    [device.deviceIdentity]
  );
  const event = (await query(
    `
      INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
      VALUES ($1, $2, 'fork_id_conflict', $3::jsonb)
      RETURNING id
    `,
    [device.deviceIdentity, original.id, JSON.stringify({ received_entry_hash: original.entry_hash })]
  )).rows[0];
  const { recoveryId, response } = await createRecovery(app, device);
  assert.equal(response.statusCode, 200);
  await query(
    "UPDATE recovery_sessions SET received_bound_seconds = $2 WHERE recovery_id = $1",
    [recoveryId, original.confirmed_at + 3600]
  );
  const payload = { records: [...acceptedRecords, original], queue: [] };
  const uploaded = await uploadRecoveryParts(app, device, recoveryId, [payload]);
  assert.equal(uploaded.responses[0].statusCode, 200);

  const replacement = ledgerEntry(device, {
    ...original,
    id: device.head.id + 1,
    prev_entry_hash: device.head.hash
  });
  const reservation = {
    original_entry_hash: original.entry_hash,
    original_local_id: original.id,
    original_signed_id: original.id,
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
  advanceHead(device, replacement);

  const manifest = {
    parts: [{ part_no: 0, sha256: recoveryPartSha256(payload) }],
    items: [
      ...acceptedRecords.map((entry) => ({
        original_entry_hash: entry.entry_hash,
        original_local_id: entry.id,
        original_signed_id: entry.id,
        original_confirmed_at: entry.confirmed_at,
        disposition: "accepted",
        date_check: null,
        replacement_entry_id: null,
        replacement_entry_hash: null
      })),
      {
        original_entry_hash: original.entry_hash,
        original_local_id: original.id,
        original_signed_id: original.id,
        original_confirmed_at: original.confirmed_at,
        disposition: "replaced",
        date_check: "ok",
        replacement_entry_id: replacement.id,
        replacement_entry_hash: replacement.entry_hash
      }
    ],
    rejected_entry_hashes: [original.entry_hash],
    own_imported: [{ entry_id: acceptedRecords[0].id, entry_hash: acceptedRecords[0].entry_hash }]
  };
  return { eventId: Number(event.id), recoveryId, original, replacement, manifest };
}

async function prepareTwoIncidents() {
  setRecoveryAutoclear(true);
  const device = await seedRecoveryDevice({ status: "FORKED" });
  const accepted = ledgerEntry(device, { normalized_label: `accepted-${crypto.randomUUID()}` });
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);

  const firstOriginal = ledgerEntry({ ...device, head: { id: 0, hash: EMPTY_HASH } }, {
    id: 1,
    prev_entry_hash: EMPTY_HASH,
    normalized_label: `first-rejected-${crypto.randomUUID()}`
  });
  const first = await prepareIncident(device, [accepted], firstOriginal);
  const firstCompletion = await complete(device, first.recoveryId, first.manifest);
  assert.equal(firstCompletion.statusCode, 200);
  assert.deepEqual(firstCompletion.json(), { outcome: "cleared", reasons: [], accounted_for: true });

  const secondOriginal = ledgerEntry({
    ...device,
    head: { id: firstOriginal.id, hash: firstOriginal.entry_hash }
  }, {
    id: 2,
    prev_entry_hash: firstOriginal.entry_hash,
    normalized_label: `second-rejected-${crypto.randomUUID()}`
  });
  const second = await prepareIncident(device, [accepted, first.replacement], secondOriginal);
  return { device, accepted, first, second };
}

async function assertUnmatched(fixture) {
  const response = await complete(
    fixture.device,
    fixture.second.recoveryId,
    fixture.second.manifest
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().outcome, "not_cleared");
  assert.equal(response.json().accounted_for, false);
  assert.ok(response.json().reasons.includes("unmatched_fork_conflict"));
  assert.equal((await query(
    "SELECT status FROM device_identities WHERE device_identity = $1",
    [fixture.device.deviceIdentity]
  )).rows[0].status, "FORKED");
  return response;
}

before(async () => {
  config.jwtSecret = config.jwtSecret || "recovery-multi-incident-test-secret";
  config.serverReceiptSecret = config.serverReceiptSecret || "recovery-multi-incident-receipt-secret";
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

test("a completed accounted incident satisfies its old conflict during a later recovery", async () => {
  const fixture = await prepareTwoIncidents();
  const completed = await complete(
    fixture.device,
    fixture.second.recoveryId,
    fixture.second.manifest
  );
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(completed.json(), { outcome: "cleared", reasons: [], accounted_for: true });
  assert.ok(!completed.json().reasons.includes("unmatched_fork_conflict"));

  const ledger = (await query(
    `
      SELECT entry_id, entry_hash, prev_entry_hash
      FROM ledger_entries
      WHERE device_identity = $1
      ORDER BY entry_id
    `,
    [fixture.device.deviceIdentity]
  )).rows;
  assert.deepEqual(ledger.map((row) => Number(row.entry_id)), [1, 2, 3]);
  assert.deepEqual(ledger.map((row) => row.entry_hash), [
    fixture.accepted.entry_hash,
    fixture.first.replacement.entry_hash,
    fixture.second.replacement.entry_hash
  ]);
  assert.deepEqual(ledger.map((row) => row.prev_entry_hash), [
    EMPTY_HASH,
    fixture.accepted.entry_hash,
    fixture.first.replacement.entry_hash
  ]);
  assert.equal(new Set(ledger.map((row) => row.entry_hash)).size, ledger.length);

  const mappings = (await query(
    `
      SELECT original_entry_hash, replacement_entry_id, replacement_entry_hash, recovery_id
      FROM ledger_recoveries
      WHERE device_identity = $1
      ORDER BY replacement_entry_id
    `,
    [fixture.device.deviceIdentity]
  )).rows;
  assert.deepEqual(mappings.map((row) => row.original_entry_hash), [
    fixture.first.original.entry_hash,
    fixture.second.original.entry_hash
  ]);
  assert.deepEqual(mappings.map((row) => row.recovery_id), [
    fixture.first.recoveryId,
    fixture.second.recoveryId
  ]);

  const repeated = await complete(
    fixture.device,
    fixture.second.recoveryId,
    fixture.second.manifest
  );
  assert.equal(repeated.statusCode, 200);
  assert.deepEqual(repeated.json(), completed.json());
  assert.equal((await query(
    `
      SELECT COUNT(*)::int AS n
      FROM recovery_audit_events
      WHERE recovery_id = $1 AND kind = 'recovery_completed_cleared'
    `,
    [fixture.second.recoveryId]
  )).rows[0].n, 1);
});

test("old conflicts without every prior-recovery proof remain unmatched", async (t) => {
  await t.test("N-1: an escalated, unaccounted prior session does not qualify", async () => {
    await resetRecoveryDatabase();
    const fixture = await prepareTwoIncidents();
    await query(
      `
        UPDATE recovery_sessions
        SET state = 'escalated', outcome = 'not_cleared',
            outcome_reasons = '["unmatched_fork_conflict"]'::jsonb,
            reconciliation_result = jsonb_set(
              reconciliation_result,
              '{all_items_reported_by_device_accounted_for}',
              'false'::jsonb
            )
        WHERE recovery_id = $1
      `,
      [fixture.first.recoveryId]
    );
    await assertUnmatched(fixture);
  });

  await t.test("N-1: persisted accounting false does not qualify even with completed state", async () => {
    await resetRecoveryDatabase();
    const fixture = await prepareTwoIncidents();
    await query(
      `
        UPDATE recovery_sessions
        SET reconciliation_result = jsonb_set(
          reconciliation_result,
          '{all_items_reported_by_device_accounted_for}',
          'false'::jsonb
        )
        WHERE recovery_id = $1
      `,
      [fixture.first.recoveryId]
    );
    await assertUnmatched(fixture);
  });

  await t.test("N-2: a missing mapped replacement does not qualify", async () => {
    await resetRecoveryDatabase();
    const fixture = await prepareTwoIncidents();
    await query(
      "DELETE FROM ledger_entries WHERE device_identity = $1 AND entry_id = $2",
      [fixture.device.deviceIdentity, fixture.first.replacement.id]
    );
    await assertUnmatched(fixture);
  });

  for (const mismatch of ["entry id", "entry hash"]) {
    await t.test(`N-3: a mapped replacement with a mismatched ${mismatch} does not qualify`, async () => {
      await resetRecoveryDatabase();
      const fixture = await prepareTwoIncidents();
      if (mismatch === "entry id") {
        await query(
          "UPDATE ledger_recoveries SET replacement_entry_id = 999 WHERE recovery_id = $1",
          [fixture.first.recoveryId]
        );
      } else {
        await query(
          "UPDATE ledger_recoveries SET replacement_entry_hash = $2 WHERE recovery_id = $1",
          [fixture.first.recoveryId, "e".repeat(64)]
        );
      }
      await assertUnmatched(fixture);
    });
  }

  await t.test("N-4: a qualifying mapping for another device does not qualify", async () => {
    await resetRecoveryDatabase();
    const fixture = await prepareTwoIncidents();
    await query("DELETE FROM ledger_recoveries WHERE recovery_id = $1", [fixture.first.recoveryId]);

    const otherDevice = await seedRecoveryDevice({
      userId: fixture.device.userId,
      status: "ACTIVE"
    });
    const otherReplacement = ledgerEntry(otherDevice, {
      normalized_label: `other-device-${crypto.randomUUID()}`
    });
    assert.equal((await syncEntries(app, otherDevice, [otherReplacement])).statusCode, 200);
    const { recoveryId: otherRecoveryId, response } = await createRecovery(app, otherDevice);
    assert.equal(response.statusCode, 200);
    await query(
      `
        UPDATE recovery_sessions
        SET state = 'completed', outcome = 'not_cleared', outcome_reasons = '[]'::jsonb,
            reconciliation_result = '{"all_items_reported_by_device_accounted_for": true}'::jsonb,
            completed_at = clock_timestamp()
        WHERE recovery_id = $1
      `,
      [otherRecoveryId]
    );
    await query(
      `
        INSERT INTO ledger_recoveries (
          device_identity, original_entry_hash, original_local_id, original_signed_id,
          original_confirmed_at, date_check, replacement_entry_id,
          replacement_entry_hash, recovery_id
        ) VALUES ($1, $2, $3, $3, $4::jsonb, 'ok', $5, $6, $7)
      `,
      [
        otherDevice.deviceIdentity,
        fixture.first.original.entry_hash,
        fixture.first.original.id,
        JSON.stringify(fixture.first.original.confirmed_at),
        otherReplacement.id,
        otherReplacement.entry_hash,
        otherRecoveryId
      ]
    );
    await assertUnmatched(fixture);
  });

  await t.test("N-5: an old conflict with no mapping does not qualify", async () => {
    await resetRecoveryDatabase();
    const fixture = await prepareTwoIncidents();
    await query("DELETE FROM ledger_recoveries WHERE recovery_id = $1", [fixture.first.recoveryId]);
    await assertUnmatched(fixture);
  });

  await t.test("N-6: an event after the current high-water mark still blocks", async () => {
    await resetRecoveryDatabase();
    const fixture = await prepareTwoIncidents();
    await query(
      `
        INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
        VALUES ($1, $2, 'fork_id_conflict', $3::jsonb)
      `,
      [
        fixture.device.deviceIdentity,
        fixture.second.original.id,
        JSON.stringify({ received_entry_hash: fixture.second.original.entry_hash })
      ]
    );
    const response = await complete(
      fixture.device,
      fixture.second.recoveryId,
      fixture.second.manifest
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().outcome, "not_cleared");
    assert.equal(response.json().accounted_for, false);
    assert.ok(response.json().reasons.includes("integrity_event_after_hwm"));
    assert.equal((await query(
      "SELECT status FROM device_identities WHERE device_identity = $1",
      [fixture.device.deviceIdentity]
    )).rows[0].status, "FORKED");
  });

  await t.test("N-7: a mapping attributed to the current session does not qualify", async () => {
    await resetRecoveryDatabase();
    const fixture = await prepareTwoIncidents();
    await query(
      "UPDATE ledger_recoveries SET recovery_id = $2 WHERE recovery_id = $1",
      [fixture.first.recoveryId, fixture.second.recoveryId]
    );
    await assertUnmatched(fixture);
  });

  await t.test("N-7: a prior session that is not completed does not qualify", async () => {
    await resetRecoveryDatabase();
    const fixture = await prepareTwoIncidents();
    await query(
      "UPDATE recovery_sessions SET state = 'superseded' WHERE recovery_id = $1",
      [fixture.first.recoveryId]
    );
    await assertUnmatched(fixture);
  });

  await t.test("a prior session attributed to another account does not qualify", async () => {
    await resetRecoveryDatabase();
    const fixture = await prepareTwoIncidents();
    const otherAccountDevice = await seedRecoveryDevice({ status: "ACTIVE" });
    await query(
      "UPDATE recovery_sessions SET user_id = $2 WHERE recovery_id = $1",
      [fixture.first.recoveryId, otherAccountDevice.userId]
    );
    await assertUnmatched(fixture);
  });
});
