import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { recoveryPartSha256 } from "../src/routes/recovery.js";
import { assertLocalTestDatabase } from "./helpers/db.js";
import {
  advanceHead,
  applyRecoveryMigrations,
  buildRecoveryApp,
  createRecovery,
  ledgerEntry,
  recoveryPartDeclaration,
  resetRecoveryDatabase,
  seedRecoveryDevice,
  setRecoveryAutoclear,
  signLedgerEntry,
  syncEntries,
  uploadRecoveryParts
} from "./helpers/recovery.js";

assertLocalTestDatabase(config.databaseUrl);
let app;

async function uploadPart(device, recoveryId, partNo, payload) {
  const declaration = recoveryPartDeclaration([payload]);
  return app.inject({
    method: "PUT",
    url: `/recovery/sessions/${recoveryId}/parts/${partNo}`,
    headers: device.headers,
    payload: { sha256: recoveryPartSha256(payload), ...declaration, ...payload }
  });
}

async function plan(device, recoveryId, replacements) {
  return app.inject({
    method: "POST",
    url: `/recovery/sessions/${recoveryId}/plan`,
    headers: device.headers,
    payload: { replacements }
  });
}

async function plannedRecovery(count = 1) {
  const device = await seedRecoveryDevice();
  const collision = ledgerEntry(device, { normalized_label: "accepted collision" });
  assert.equal((await syncEntries(app, device, [collision])).statusCode, 200);
  advanceHead(device, collision);
  const originals = [];
  let originalHead = { id: 0, hash: "0".repeat(64) };
  for (let index = 0; index < count; index += 1) {
    const original = ledgerEntry({ ...device, head: originalHead }, {
      id: index + 1,
      prev_entry_hash: originalHead.hash,
      normalized_label: `rejected original ${index}`
    });
    originals.push(original);
    originalHead = { id: original.id, hash: original.entry_hash };
  }
  const { recoveryId } = await createRecovery(app, device);
  const preserved = { records: [collision, ...originals], queue: [] };
  const uploaded = await uploadRecoveryParts(app, device, recoveryId, [preserved]);
  assert.ok(uploaded.responses.every((response) => response.statusCode === 200));

  const replacements = [];
  let replacementHead = { ...device.head };
  for (const original of originals) {
    const replacement = ledgerEntry({ ...device, head: replacementHead }, {
      ...original,
      id: replacementHead.id + 1,
      prev_entry_hash: replacementHead.hash
    });
    replacements.push(replacement);
    replacementHead = { id: replacement.id, hash: replacement.entry_hash };
  }
  const reservationPlan = replacements.map((entry, index) => ({
    original_entry_hash: originals[index].entry_hash,
    original_local_id: originals[index].id,
    original_signed_id: originals[index].id,
    planned_entry_id: entry.id,
    planned_entry_hash: entry.entry_hash,
    date_check: "ok"
  }));
  assert.equal((await plan(device, recoveryId, reservationPlan)).statusCode, 200);
  return { device, collision, originals, replacements, reservationPlan, recoveryId, preserved };
}

before(async () => {
  config.jwtSecret = config.jwtSecret || "recovery-routes-test-secret";
  config.serverReceiptSecret = config.serverReceiptSecret || "recovery-routes-receipt-secret";
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

test("recovery auth accepts legacy and account tokens and preserves every ordinary session boundary", async () => {
  const legacy = await seedRecoveryDevice({ accountClaim: false });
  const current = await seedRecoveryDevice({ accountClaim: true });
  assert.equal((await createRecovery(app, legacy)).response.statusCode, 200);
  assert.equal((await createRecovery(app, current)).response.statusCode, 200);

  const expired = await seedRecoveryDevice();
  const expiredToken = jwt.sign(
    { sid: expired.sessionId, account_id: expired.userId, device_identity: expired.deviceIdentity },
    config.jwtSecret,
    { expiresIn: -1 }
  );
  const expiredResponse = await app.inject({
    method: "POST",
    url: "/recovery/sessions",
    headers: { authorization: `Bearer ${expiredToken}`, "x-device-identity": expired.deviceIdentity },
    payload: {
      recovery_id: crypto.randomUUID(), device_identity: expired.deviceIdentity,
      app_version: "test", local_summary: {}
    }
  });
  assert.equal(expiredResponse.statusCode, 401);

  const revoked = await seedRecoveryDevice();
  await query("UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1", [revoked.sessionId]);
  assert.equal((await createRecovery(app, revoked)).response.statusCode, 401);

  const wrongAccount = await seedRecoveryDevice();
  const another = await seedRecoveryDevice();
  const wrongAccountToken = jwt.sign(
    {
      sid: wrongAccount.sessionId,
      account_id: another.userId,
      device_identity: wrongAccount.deviceIdentity
    },
    config.jwtSecret,
    { expiresIn: "1h" }
  );
  const wrongAccountResponse = await app.inject({
    method: "POST",
    url: "/recovery/sessions",
    headers: { authorization: `Bearer ${wrongAccountToken}`, "x-device-identity": wrongAccount.deviceIdentity },
    payload: {
      recovery_id: crypto.randomUUID(), device_identity: wrongAccount.deviceIdentity,
      app_version: "test", local_summary: {}
    }
  });
  assert.equal(wrongAccountResponse.statusCode, 401);

  const wrongDevice = await seedRecoveryDevice();
  assert.equal((await app.inject({
    method: "POST",
    url: "/recovery/sessions",
    headers: { ...wrongDevice.headers, "x-device-identity": current.deviceIdentity },
    payload: {
      recovery_id: crypto.randomUUID(), device_identity: wrongDevice.deviceIdentity,
      app_version: "test", local_summary: {}
    }
  })).statusCode, 401);
});

test("session and part writes are idempotent, bounded, and never return holding-area contents", async () => {
  const device = await seedRecoveryDevice();
  const recoveryId = crypto.randomUUID();
  const first = await createRecovery(app, device, recoveryId);
  const second = await createRecovery(app, device, recoveryId);
  assert.equal(first.response.statusCode, 200);
  assert.equal(second.response.statusCode, 200);
  assert.deepEqual(second.response.json(), first.response.json());
  assert.equal((await createRecovery(app, device)).response.statusCode, 409);

  const privateMarker = `private-${crypto.randomUUID()}`;
  const rawDates = [null, "", 0, "not-a-number", 1e20];
  const originals = rawDates.map((confirmedAt, index) => {
    const entry = ledgerEntry(device, {
      id: index + 2,
      confirmed_at: 1,
      prev_entry_hash: "0".repeat(64),
      normalized_label: `${privateMarker}-${index}`
    });
    entry.confirmed_at = confirmedAt;
    return signLedgerEntry(device, entry);
  });
  const part = {
    records: [ledgerEntry(device, { normalized_label: privateMarker }), ...originals],
    queue: []
  };
  const stored = await uploadPart(device, recoveryId, 0, part);
  assert.equal(stored.statusCode, 200);
  assert.doesNotMatch(stored.body, new RegExp(privateMarker));
  assert.equal((await uploadPart(device, recoveryId, 0, part)).statusCode, 200);

  const heldPart = (await query(
    "SELECT payload, sha256 FROM recovery_parts WHERE recovery_id = $1 AND part_no = 0",
    [recoveryId]
  )).rows[0];
  const held = heldPart.payload;
  assert.equal(held.records.length, rawDates.length + 1);
  for (let index = 0; index < rawDates.length; index += 1) {
    assert.equal(held.records[index + 1].confirmed_at, rawDates[index]);
  }

  const changedEntry = ledgerEntry(device, { normalized_label: "different" });
  const changed = { records: [changedEntry], queue: [] };
  const changedDeclaration = recoveryPartDeclaration([changed]);
  const changedSameSizeDeclaration = await app.inject({
    method: "PUT",
    url: `/recovery/sessions/${recoveryId}/parts/0`,
    headers: device.headers,
    payload: { sha256: recoveryPartSha256(changed), ...changedDeclaration, ...changed }
  });
  assert.equal(changedSameSizeDeclaration.statusCode, 409);
  assert.equal(changedSameSizeDeclaration.json().code, "recovery_part_declaration_conflict");

  const changedDifferentDeclaration = await app.inject({
    method: "PUT",
    url: `/recovery/sessions/${recoveryId}/parts/0`,
    headers: device.headers,
    payload: {
      sha256: recoveryPartSha256(changed),
      part_count: 2,
      part_hashes: [
        { part_no: 0, sha256: recoveryPartSha256(changed) },
        { part_no: 1, sha256: recoveryPartSha256(part) }
      ],
      ...changed
    }
  });
  assert.equal(changedDifferentDeclaration.statusCode, 409);
  assert.equal(changedDifferentDeclaration.json().code, "recovery_part_declaration_conflict");
  const heldAfterChangedUploads = (await query(
    "SELECT payload, sha256 FROM recovery_parts WHERE recovery_id = $1 AND part_no = 0",
    [recoveryId]
  )).rows[0];
  assert.deepEqual(
    Buffer.from(JSON.stringify(heldAfterChangedUploads.payload)),
    Buffer.from(JSON.stringify(heldPart.payload))
  );
  assert.deepEqual(Buffer.from(heldAfterChangedUploads.sha256), Buffer.from(heldPart.sha256));
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM recovery_parts WHERE recovery_id = $1",
    [recoveryId]
  )).rows[0].n, 1);

  // A valid public request cannot both change the payload and retain its SHA-256
  // declaration. Simulate persistence tampering to cover that defensive branch.
  await query(
    "UPDATE recovery_parts SET payload = $2::jsonb WHERE recovery_id = $1 AND part_no = 0",
    [recoveryId, JSON.stringify(changed)]
  );
  const payloadConflict = await uploadPart(device, recoveryId, 0, part);
  assert.equal(payloadConflict.statusCode, 409);
  assert.equal(payloadConflict.json().code, "recovery_part_conflict");

  assert.equal((await uploadPart(device, recoveryId, config.recoveryMaxParts, part)).statusCode, 400);

  const oversized = { records: [{ marker: "x".repeat(config.recoveryPartBodyLimitBytes) }], queue: [] };
  const tooLarge = await uploadPart(device, recoveryId, 1, oversized);
  assert.equal(tooLarge.statusCode, 413);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM recovery_parts")).rows[0].n, 1);
});

test("plan is all-or-nothing, contiguous, unique, and an identical resend is a no-op", async () => {
  const device = await seedRecoveryDevice();
  const accepted = ledgerEntry(device);
  assert.equal((await syncEntries(app, device, [accepted])).statusCode, 200);
  advanceHead(device, accepted);
  const { recoveryId } = await createRecovery(app, device);
  const firstOriginal = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1, prev_entry_hash: "0".repeat(64), normalized_label: "first rejected"
  });
  const secondOriginal = ledgerEntry({ ...device, head: { id: 1, hash: firstOriginal.entry_hash } }, {
    id: 2, prev_entry_hash: firstOriginal.entry_hash, normalized_label: "second rejected"
  });
  assert.equal((await uploadPart(device, recoveryId, 0, {
    records: [accepted, firstOriginal, secondOriginal], queue: []
  })).statusCode, 200);
  const first = ledgerEntry(device);
  const second = ledgerEntry({ ...device, head: { id: first.id, hash: first.entry_hash } });
  const replacements = [first, second].map((entry, index) => ({
    original_entry_hash: [firstOriginal, secondOriginal][index].entry_hash,
    original_local_id: index + 1,
    original_signed_id: index + 1,
    planned_entry_id: entry.id,
    planned_entry_hash: entry.entry_hash,
    date_check: "ok"
  }));
  const planned = await plan(device, recoveryId, replacements);
  assert.equal(planned.statusCode, 200);
  assert.equal(planned.json().idempotent, false);
  assert.equal((await plan(device, recoveryId, replacements)).json().idempotent, true);

  const rows = (await query(
    "SELECT original_entry_hash, planned_entry_id FROM recovery_reservations ORDER BY planned_entry_id"
  )).rows;
  assert.equal(rows.length, 2);
  const changedPlan = replacements.map((replacement, index) => ({
    ...replacement,
    planned_entry_id: replacement.planned_entry_id + (index === 0 ? 2 : 0)
  }));
  assert.equal((await plan(device, recoveryId, changedPlan)).statusCode, 409);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM recovery_reservations")).rows[0].n, 2);
});

test("planning is refused until every declared signed-backup part is acknowledged", async () => {
  const device = await seedRecoveryDevice();
  const { recoveryId } = await createRecovery(app, device);
  const original = ledgerEntry(device);
  const parts = [{ records: [original], queue: [] }, { records: [], queue: [] }];
  const declaration = recoveryPartDeclaration(parts);
  const first = await app.inject({
    method: "PUT",
    url: `/recovery/sessions/${recoveryId}/parts/0`,
    headers: device.headers,
    payload: {
      sha256: declaration.part_hashes[0].sha256,
      ...declaration,
      ...parts[0]
    }
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().preservation_complete, false);
  const refused = await plan(device, recoveryId, []);
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, "recovery_preservation_incomplete");
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM recovery_reservations")).rows[0].n, 0);

  const malformed = await app.inject({
    method: "PUT",
    url: `/recovery/sessions/${recoveryId}/parts/1`,
    headers: device.headers,
    payload: {
      sha256: declaration.part_hashes[1].sha256,
      ...declaration,
      records: ["not-an-entry"],
      queue: []
    }
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().code, "invalid_recovery_part_payload");
});

test("active recovery preflights the whole sync batch, accepts only reservations, and keeps resends idempotent", async () => {
  const device = await seedRecoveryDevice();
  const firstOriginal = ledgerEntry(device, { id: 1, normalized_label: "first original" });
  const collision = ledgerEntry(device, { id: 1, normalized_label: "accepted collision" });
  assert.equal((await syncEntries(app, device, [collision])).statusCode, 200);
  advanceHead(device, collision);
  const { recoveryId } = await createRecovery(app, device);
  const secondOriginal = ledgerEntry({ ...device, head: { id: 1, hash: firstOriginal.entry_hash } }, {
    id: 2, prev_entry_hash: firstOriginal.entry_hash, normalized_label: "second original"
  });
  assert.equal((await uploadPart(device, recoveryId, 0, {
    records: [firstOriginal, secondOriginal], queue: []
  })).statusCode, 200);
  const first = ledgerEntry(device);
  const nextDevice = { ...device, head: { id: first.id, hash: first.entry_hash } };
  const second = ledgerEntry(nextDevice);
  const replacements = [first, second].map((entry, index) => ({
    original_entry_hash: [firstOriginal, secondOriginal][index].entry_hash,
    original_local_id: index + 1,
    original_signed_id: index + 1,
    planned_entry_id: entry.id,
    planned_entry_hash: entry.entry_hash,
    date_check: "ok"
  }));
  assert.equal((await plan(device, recoveryId, replacements)).statusCode, 200);

  const unplanned = ledgerEntry(device, { normalized_label: "unplanned" });
  const refused = await syncEntries(app, device, [first, unplanned]);
  assert.equal(refused.statusCode, 503);
  assert.deepEqual(refused.json(), { error: "recovery_in_progress", code: "recovery_in_progress" });
  assert.ok(refused.headers["retry-after"]);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM ledger_entries")).rows[0].n, 1);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM ledger_integrity_events")).rows[0].n, 0);

  assert.equal((await syncEntries(app, device, [first])).statusCode, 200);
  const partialRetry = await syncEntries(app, device, [first, second]);
  assert.equal(partialRetry.statusCode, 200);
  assert.equal(partialRetry.json().synced_count, 1);
  const resend = await syncEntries(app, device, [first, second]);
  assert.equal(resend.statusCode, 200);
  assert.equal(resend.json().synced_count, 0);
  const statuses = (await query(
    "SELECT status FROM recovery_reservations ORDER BY planned_entry_id"
  )).rows.map((row) => row.status);
  assert.deepEqual(statuses, ["accepted", "accepted"]);
});

test("ordinary sync is unchanged only when no unsettled recovery session exists", async () => {
  const device = await seedRecoveryDevice();
  const ordinary = ledgerEntry(device);
  assert.equal((await syncEntries(app, device, [ordinary])).statusCode, 200);
  advanceHead(device, ordinary);

  const { recoveryId } = await createRecovery(app, device);
  await query(
    "UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE recovery_id = $1",
    [recoveryId]
  );
  const afterExpiry = ledgerEntry(device);
  const fenced = await syncEntries(app, device, [afterExpiry]);
  assert.equal(fenced.statusCode, 503);
  assert.equal(fenced.json().code, "recovery_in_progress");
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE device_identity = $1",
    [device.deviceIdentity]
  )).rows[0].n, 1);

  await query("UPDATE recovery_sessions SET state = 'superseded' WHERE recovery_id = $1", [recoveryId]);
  const ordinaryAgain = await syncEntries(app, device, [afterExpiry]);
  assert.equal(ordinaryAgain.statusCode, 200);
  assert.equal(ordinaryAgain.json().synced_count, 1);
});

test("a superseding session releases unsent reservations and adopts accepted ones", async () => {
  const device = await seedRecoveryDevice();
  const collision = ledgerEntry(device, { normalized_label: "accepted collision" });
  assert.equal((await syncEntries(app, device, [collision])).statusCode, 200);
  advanceHead(device, collision);
  const firstSession = await createRecovery(app, device);
  const firstOriginal = ledgerEntry({ ...device, head: { id: 0, hash: "0".repeat(64) } }, {
    id: 1, prev_entry_hash: "0".repeat(64), normalized_label: "first rejected"
  });
  const secondOriginal = ledgerEntry({ ...device, head: { id: 1, hash: firstOriginal.entry_hash } }, {
    id: 2, prev_entry_hash: firstOriginal.entry_hash, normalized_label: "second rejected"
  });
  const preserved = { records: [collision, firstOriginal, secondOriginal], queue: [] };
  assert.equal((await uploadPart(device, firstSession.recoveryId, 0, preserved)).statusCode, 200);
  const first = ledgerEntry(device);
  const second = ledgerEntry({ ...device, head: { id: first.id, hash: first.entry_hash } });
  assert.equal((await plan(device, firstSession.recoveryId, [first, second].map((entry, index) => ({
    original_entry_hash: [firstOriginal, secondOriginal][index].entry_hash,
    original_local_id: index + 1,
    original_signed_id: index + 1,
    planned_entry_id: entry.id,
    planned_entry_hash: entry.entry_hash,
    date_check: "ok"
  })))).statusCode, 200);
  assert.equal((await syncEntries(app, device, [first])).statusCode, 200);
  await query(
    "UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE recovery_id = $1",
    [firstSession.recoveryId]
  );
  const next = await createRecovery(app, device);
  assert.equal(next.response.statusCode, 200);
  const reservations = (await query(
    "SELECT recovery_id, status FROM recovery_reservations ORDER BY planned_entry_id"
  )).rows;
  assert.deepEqual(reservations.map((row) => row.status), ["accepted", "released"]);
  assert.equal(reservations[0].recovery_id, next.recoveryId);
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM recovery_audit_events WHERE kind = 'recovery_lease_superseded'"
  )).rows[0].n, 1);

  assert.equal((await uploadPart(device, next.recoveryId, 0, preserved)).statusCode, 200);
  const replanned = await plan(device, next.recoveryId, [{
    original_entry_hash: secondOriginal.entry_hash,
    original_local_id: 2,
    original_signed_id: 2,
    planned_entry_id: second.id,
    planned_entry_hash: second.entry_hash,
    date_check: "ok"
  }]);
  assert.equal(replanned.statusCode, 200);
  const adopted = (await query(
    "SELECT recovery_id, status FROM recovery_reservations ORDER BY planned_entry_id"
  )).rows;
  assert.deepEqual(adopted.map((row) => row.status), ["accepted", "reserved"]);
  assert.ok(adopted.every((row) => row.recovery_id === next.recoveryId));
});

test("a delayed reserved replacement remains fenced, accepted, and tracked after lease expiry", async () => {
  const fixture = await plannedRecovery();
  await query(
    "UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() - INTERVAL '25 hours' WHERE recovery_id = $1",
    [fixture.recoveryId]
  );
  const delayed = await syncEntries(app, fixture.device, fixture.replacements);
  assert.equal(delayed.statusCode, 200);
  assert.equal((await query(
    "SELECT status FROM recovery_reservations WHERE recovery_id = $1",
    [fixture.recoveryId]
  )).rows[0].status, "accepted");
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE device_identity = $1",
    [fixture.device.deviceIdentity]
  )).rows[0].n, 2);
});

test("delayed sync after expiry, takeover, and lost-ack retry preserve one accepted replacement", async () => {
  const fixture = await plannedRecovery();
  await query(
    "UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE recovery_id = $1",
    [fixture.recoveryId]
  );
  assert.equal((await syncEntries(app, fixture.device, fixture.replacements)).statusCode, 200);
  const takeover = await createRecovery(app, fixture.device);
  assert.equal(takeover.response.statusCode, 200);
  const retry = await syncEntries(app, fixture.device, fixture.replacements);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().synced_count, 0);
  const reservation = (await query(
    "SELECT recovery_id, status FROM recovery_reservations WHERE original_entry_hash = $1",
    [fixture.originals[0].entry_hash]
  )).rows[0];
  assert.equal(reservation.recovery_id, takeover.recoveryId);
  assert.equal(reservation.status, "accepted");
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE device_identity = $1 AND entry_id > 1",
    [fixture.device.deviceIdentity]
  )).rows[0].n, 1);
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE entry_hash = $1",
    [fixture.originals[0].entry_hash]
  )).rows[0].n, 0);
});

test("takeover reconciles a reserved row whose exact planned bytes already exist before releasing anything", async () => {
  const fixture = await plannedRecovery();
  assert.equal((await syncEntries(app, fixture.device, fixture.replacements)).statusCode, 200);
  // Simulate the pre-fix inconsistent state reproduced by the independent
  // review: ledger insert committed while reservation tracking stayed reserved.
  await query(
    `UPDATE recovery_reservations SET status = 'reserved', accepted_at = NULL
     WHERE recovery_id = $1`,
    [fixture.recoveryId]
  );
  await query(
    "UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE recovery_id = $1",
    [fixture.recoveryId]
  );
  const takeover = await createRecovery(app, fixture.device);
  assert.equal(takeover.response.statusCode, 200);
  const reservation = (await query(
    "SELECT recovery_id, status, accepted_at FROM recovery_reservations"
  )).rows[0];
  assert.equal(reservation.recovery_id, takeover.recoveryId);
  assert.equal(reservation.status, "accepted");
  assert.ok(reservation.accepted_at);
  const audit = (await query(
    "SELECT detail FROM recovery_audit_events WHERE kind = 'recovery_lease_superseded'"
  )).rows[0].detail;
  assert.equal(audit.reconciled_from_ledger, 1);
  assert.equal(audit.released_absent, 0);
});

test("partial acceptance is reconciled before takeover releases only absent planned bytes", async () => {
  const fixture = await plannedRecovery(2);
  assert.equal((await syncEntries(app, fixture.device, [fixture.replacements[0]])).statusCode, 200);
  await query(
    "UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE recovery_id = $1",
    [fixture.recoveryId]
  );
  const takeover = await createRecovery(app, fixture.device);
  assert.equal(takeover.response.statusCode, 200);
  const rows = (await query(
    "SELECT recovery_id, status FROM recovery_reservations ORDER BY original_local_id"
  )).rows;
  assert.deepEqual(rows.map((row) => row.status), ["accepted", "released"]);
  assert.equal(rows[0].recovery_id, takeover.recoveryId);
  const audit = (await query(
    "SELECT detail FROM recovery_audit_events WHERE kind = 'recovery_lease_superseded'"
  )).rows[0].detail;
  assert.equal(audit.adopted_accepted, 1);
  assert.equal(audit.released_absent, 1);
});

test("old planned bytes are refused after takeover replans the original to different bytes", async () => {
  const fixture = await plannedRecovery();
  await query(
    "UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE recovery_id = $1",
    [fixture.recoveryId]
  );
  const takeover = await createRecovery(app, fixture.device);
  assert.equal(takeover.response.statusCode, 200);
  assert.equal((await uploadPart(
    fixture.device, takeover.recoveryId, 0, fixture.preserved
  )).statusCode, 200);
  const replannedBytes = ledgerEntry(fixture.device, {
    ...fixture.originals[0],
    id: 2,
    prev_entry_hash: fixture.collision.entry_hash,
    normalized_label: "different planned bytes"
  });
  const wrongDatePlan = await plan(fixture.device, takeover.recoveryId, [{
    original_entry_hash: fixture.originals[0].entry_hash,
    original_local_id: fixture.originals[0].id,
    original_signed_id: fixture.originals[0].id,
    planned_entry_id: replannedBytes.id,
    planned_entry_hash: replannedBytes.entry_hash,
    date_check: "future"
  }]);
  assert.equal(wrongDatePlan.statusCode, 409);
  assert.equal(wrongDatePlan.json().code, "recovery_plan_date_check_mismatch");
  assert.equal((await plan(fixture.device, takeover.recoveryId, [{
    original_entry_hash: fixture.originals[0].entry_hash,
    original_local_id: fixture.originals[0].id,
    original_signed_id: fixture.originals[0].id,
    planned_entry_id: replannedBytes.id,
    planned_entry_hash: replannedBytes.entry_hash,
    date_check: "ok"
  }])).statusCode, 200);

  const oldBytes = await syncEntries(app, fixture.device, fixture.replacements);
  assert.equal(oldBytes.statusCode, 503);
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM ledger_entries WHERE device_identity = $1",
    [fixture.device.deviceIdentity]
  )).rows[0].n, 1);
  assert.equal((await syncEntries(app, fixture.device, [replannedBytes])).statusCode, 200);
});

test("two takeover sessions racing under the device lock leave one unsettled owner", async () => {
  const fixture = await plannedRecovery();
  await query(
    "UPDATE recovery_sessions SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE recovery_id = $1",
    [fixture.recoveryId]
  );
  const [left, right] = await Promise.all([
    createRecovery(app, fixture.device),
    createRecovery(app, fixture.device)
  ]);
  assert.deepEqual([left.response.statusCode, right.response.statusCode].sort(), [200, 409]);
  assert.equal((await query(
    "SELECT COUNT(*)::int AS n FROM recovery_sessions WHERE device_identity = $1 AND state IN ('open','uploaded','planned','syncing')",
    [fixture.device.deviceIdentity]
  )).rows[0].n, 1);
});
