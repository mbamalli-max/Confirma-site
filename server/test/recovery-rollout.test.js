import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  config,
  parseRecoveryAllowedDevices,
  parseRecoveryMode
} from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { canonicalJson, recoveryPartSha256 } from "../src/routes/recovery.js";
import { assertLocalTestDatabase } from "./helpers/db.js";
import {
  advanceHead,
  applyRecoveryMigrations,
  buildRecoveryApp,
  createRecovery,
  ledgerEntry,
  resetRecoveryDatabase,
  seedRecoveryDevice,
  setRecoveryAutoclear,
  setRecoveryMode,
  syncEntries,
  uploadRecoveryParts
} from "./helpers/recovery.js";

assertLocalTestDatabase(config.databaseUrl);
let app;

function manifestHash(manifest) {
  return crypto.createHash("sha256").update(canonicalJson(manifest), "utf8").digest("hex");
}

async function plan(device, recoveryId, replacements) {
  return app.inject({
    method: "POST",
    url: `/recovery/sessions/${recoveryId}/plan`,
    headers: device.headers,
    payload: { replacements }
  });
}

async function complete(device, recoveryId, manifest) {
  return app.inject({
    method: "POST",
    url: `/recovery/sessions/${recoveryId}/complete`,
    headers: device.headers,
    payload: { manifest, manifest_hash: manifestHash(manifest) }
  });
}

// Ordinary request authentication may touch the device row (activity timestamp,
// row version), so a refusal is judged by status plus the recovery tables and the
// ledger, not by the row's updated_at / xmin.
async function deviceStatusOnly(deviceIdentity) {
  return { status: (await query(
    "SELECT status FROM device_identities WHERE device_identity = $1", [deviceIdentity]
  )).rows[0]?.status };
}

async function deviceSnapshot(deviceIdentity) {
  return (await query(
    `SELECT status, updated_at::text AS updated_at, xmin::text AS row_version
     FROM device_identities WHERE device_identity = $1`,
    [deviceIdentity]
  )).rows[0];
}

async function tableCount(table) {
  return (await query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n;
}

async function buildPlannedRecovery() {
  const device = await seedRecoveryDevice();
  const accepted = ledgerEntry(device, { normalized_label: "rollout accepted collision" });
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);

  const rejected = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1,
    prev_entry_hash: "0".repeat(64),
    normalized_label: "rollout rejected original"
  });
  const { recoveryId, response } = await createRecovery(app, device);
  assert.equal(response.statusCode, 200);
  const payload = { records: [accepted, rejected], queue: [] };
  const uploaded = await uploadRecoveryParts(app, device, recoveryId, [payload]);
  assert.equal(uploaded.responses[0].statusCode, 200);

  const replacement = ledgerEntry(device, {
    ...rejected,
    id: accepted.id + 1,
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
  assert.equal((await plan(device, recoveryId, [reservation])).statusCode, 200);
  return { device, accepted, rejected, recoveryId, payload, replacement, reservation };
}

before(async () => {
  config.jwtSecret = config.jwtSecret || "recovery-rollout-test-secret";
  config.serverReceiptSecret = config.serverReceiptSecret || "recovery-rollout-receipt-secret";
  await applyRecoveryMigrations();
  app = await buildRecoveryApp();
});

beforeEach(async () => {
  setRecoveryAutoclear(false);
  setRecoveryMode("all");
  await resetRecoveryDatabase();
});

after(async () => {
  await app.close();
  await getPool().end();
});

test("R-1: off, unset, and unrecognised modes refuse new recovery without writes", async (t) => {
  for (const [name, mode] of [
    ["off", parseRecoveryMode("off")],
    ["unset", parseRecoveryMode(undefined)],
    ["uppercase", parseRecoveryMode("ALL")],
    ["boolean-like", parseRecoveryMode("true")]
  ]) {
    await t.test(name, async () => {
      await resetRecoveryDatabase();
      const device = await seedRecoveryDevice();
      const existingEntry = ledgerEntry(device, { normalized_label: `existing-${name}` });
      assert.equal((await syncEntries(app, device, [existingEntry])).statusCode, 200);
      const beforeDevice = await deviceStatusOnly(device.deviceIdentity);
      const beforeLedger = (await query(
        `SELECT entry_id, entry_hash, payload::text AS payload, xmin::text AS row_version
         FROM ledger_entries WHERE device_identity = $1 ORDER BY entry_id`,
        [device.deviceIdentity]
      )).rows;
      setRecoveryMode(mode);

      const { response } = await createRecovery(app, device);
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.json(), {
        error: "recovery_not_enabled",
        code: "recovery_not_enabled"
      });
      assert.equal(await tableCount("recovery_sessions"), 0);
      assert.equal(await tableCount("recovery_audit_events"), 0);
      assert.equal(await tableCount("recovery_reservations"), 0);
      assert.deepEqual((await query(
        `SELECT entry_id, entry_hash, payload::text AS payload, xmin::text AS row_version
         FROM ledger_entries WHERE device_identity = $1 ORDER BY entry_id`,
        [device.deviceIdentity]
      )).rows, beforeLedger);
      assert.deepEqual(await deviceStatusOnly(device.deviceIdentity), beforeDevice);
    });
  }
});

test("R-2: allowlist admits only parsed listed devices", async () => {
  const listed = await seedRecoveryDevice();
  const unlisted = await seedRecoveryDevice();
  const parsed = parseRecoveryAllowedDevices(
    `  ${listed.deviceIdentity},, ${listed.deviceIdentity} , ${listed.deviceIdentity},   `
  );
  assert.deepEqual([...parsed], [listed.deviceIdentity]);
  setRecoveryMode("allowlist", parsed);

  assert.equal((await createRecovery(app, listed)).response.statusCode, 200);
  const refused = (await createRecovery(app, unlisted)).response;
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().code, "recovery_not_enabled");
  assert.equal(await tableCount("recovery_sessions"), 1);
});

test("R-3: all mode creates recovery sessions as before", async () => {
  setRecoveryMode("all");
  const device = await seedRecoveryDevice();
  const { recoveryId, response } = await createRecovery(app, device);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().recovery_id, recoveryId);
  assert.equal(await tableCount("recovery_sessions"), 1);
  assert.equal(await tableCount("recovery_audit_events"), 1);
});

test("R-4: an existing session finishes accounted after mode changes to off", async () => {
  setRecoveryAutoclear(true);
  setRecoveryMode("all");
  const device = await seedRecoveryDevice();
  const accepted = ledgerEntry(device, { confirmed_at: 1793000100 });
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);
  const rejected = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1,
    confirmed_at: 1793000200,
    prev_entry_hash: "0".repeat(64),
    normalized_label: "rollout completion rejected original"
  });
  await query(
    `INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
     VALUES ($1, 1, 'fork_id_conflict', $2::jsonb)`,
    [device.deviceIdentity, JSON.stringify({
      received_entry_hash: rejected.entry_hash,
      stored_entry_hash: accepted.entry_hash
    })]
  );
  const created = await createRecovery(app, device);
  assert.equal(created.response.statusCode, 200);
  await query(
    "UPDATE recovery_sessions SET received_bound_seconds = $2 WHERE recovery_id = $1",
    [created.recoveryId, rejected.confirmed_at + 3600]
  );

  setRecoveryMode("off");
  const repeated = await createRecovery(app, device, created.recoveryId);
  assert.equal(repeated.response.statusCode, 200);
  assert.equal(repeated.response.json().recovery_id, created.recoveryId);
  const refused = await createRecovery(app, device);
  assert.equal(refused.response.statusCode, 403);
  assert.equal(refused.response.json().code, "recovery_not_enabled");

  const payload = { records: [accepted, rejected], queue: [] };
  const uploaded = await uploadRecoveryParts(app, device, created.recoveryId, [payload]);
  assert.equal(uploaded.responses[0].statusCode, 200);
  const replacement = ledgerEntry(device, {
    ...rejected,
    id: accepted.id + 1,
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
  assert.equal((await plan(device, created.recoveryId, [reservation])).statusCode, 200);
  assert.equal((await syncEntries(app, device, [replacement])).statusCode, 200);

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
  const completed = await complete(device, created.recoveryId, manifest);
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(completed.json(), { outcome: "cleared", reasons: [], accounted_for: true });
  assert.equal((await query(
    "SELECT state FROM recovery_sessions WHERE recovery_id = $1",
    [created.recoveryId]
  )).rows[0].state, "completed");
});

test("R-5: off mode refuses expired-lease takeover without disturbing the fence", async () => {
  setRecoveryMode("all");
  const fixture = await buildPlannedRecovery();
  await query(
    "UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE recovery_id = $1",
    [fixture.recoveryId]
  );
  const beforeSession = (await query(
    `SELECT recovery_id, state, lease_expires_at::text AS lease_expires_at, xmin::text AS row_version
     FROM recovery_sessions WHERE recovery_id = $1`,
    [fixture.recoveryId]
  )).rows[0];
  const beforeReservations = (await query(
    `SELECT recovery_id, status, accepted_at::text AS accepted_at, xmin::text AS row_version
     FROM recovery_reservations ORDER BY original_entry_hash`
  )).rows;
  const beforeAudit = await tableCount("recovery_audit_events");
  const beforeDevice = await deviceStatusOnly(fixture.device.deviceIdentity);
  const beforeIntegrity = await tableCount("ledger_integrity_events");

  setRecoveryMode("off");
  const takeover = await createRecovery(app, fixture.device);
  assert.equal(takeover.response.statusCode, 403);
  assert.equal(takeover.response.json().code, "recovery_not_enabled");
  assert.deepEqual((await query(
    `SELECT recovery_id, state, lease_expires_at::text AS lease_expires_at, xmin::text AS row_version
     FROM recovery_sessions WHERE recovery_id = $1`,
    [fixture.recoveryId]
  )).rows[0], beforeSession);
  assert.deepEqual((await query(
    `SELECT recovery_id, status, accepted_at::text AS accepted_at, xmin::text AS row_version
     FROM recovery_reservations ORDER BY original_entry_hash`
  )).rows, beforeReservations);
  assert.equal(await tableCount("recovery_sessions"), 1);
  assert.equal(await tableCount("recovery_audit_events"), beforeAudit);
  assert.deepEqual(await deviceStatusOnly(fixture.device.deviceIdentity), beforeDevice);

  const unplanned = ledgerEntry(fixture.device, {
    id: fixture.replacement.id,
    prev_entry_hash: fixture.accepted.entry_hash,
    normalized_label: "not the reserved replacement"
  });
  const fenced = await syncEntries(app, fixture.device, [unplanned]);
  assert.equal(fenced.statusCode, 503);
  assert.equal(fenced.json().code, "recovery_in_progress");
  assert.equal(await tableCount("ledger_integrity_events"), beforeIntegrity);
});

test("R-6: rollout refusal is not an integrity event and never forks an active device", async () => {
  const device = await seedRecoveryDevice({ status: "ACTIVE" });
  const before = await deviceStatusOnly(device.deviceIdentity);
  setRecoveryMode("off");
  const { response } = await createRecovery(app, device);
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), {
    error: "recovery_not_enabled",
    code: "recovery_not_enabled"
  });
  assert.equal(await tableCount("ledger_integrity_events"), 0);
  assert.deepEqual(await deviceStatusOnly(device.deviceIdentity), before);
  assert.equal((await deviceSnapshot(device.deviceIdentity)).status, "ACTIVE");
});

test("R-7: recovery rollout config parses exact modes and a deduplicated Set", () => {
  assert.equal(parseRecoveryMode(undefined), "off");
  assert.equal(parseRecoveryMode("off"), "off");
  assert.equal(parseRecoveryMode("allowlist"), "allowlist");
  assert.equal(parseRecoveryMode("all"), "all");
  for (const value of ["", "ALL", "true", " all", "allowlist ", null]) {
    assert.equal(parseRecoveryMode(value), "off");
  }
  const devices = parseRecoveryAllowedDevices(" first, second ,, first,  third  ,");
  assert.ok(devices instanceof Set);
  assert.deepEqual([...devices], ["first", "second", "third"]);

  const previousMode = config.recoveryMode;
  const previousDevices = config.recoveryAllowedDevices;
  const restore = setRecoveryMode("allowlist", devices);
  assert.equal(config.recoveryMode, "allowlist");
  assert.deepEqual([...config.recoveryAllowedDevices], [...devices]);
  restore();
  assert.equal(config.recoveryMode, previousMode);
  assert.equal(config.recoveryAllowedDevices, previousDevices);
});
