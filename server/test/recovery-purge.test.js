import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { purgeRecoveryPayloads } from "../scripts/purge-recovery-payloads.mjs";
import { assertLocalTestDatabase } from "./helpers/db.js";
import {
  applyRecoveryMigrations,
  resetRecoveryDatabase,
  seedRecoveryDevice
} from "./helpers/recovery.js";

assertLocalTestDatabase(config.databaseUrl);

before(async () => {
  config.jwtSecret = config.jwtSecret || "recovery-purge-test-secret";
  await applyRecoveryMigrations();
});

beforeEach(resetRecoveryDatabase);
after(async () => { await getPool().end(); });

test("purge is dry-run by default and execute removes only old fully-accounted payload rows", async () => {
  const device = await seedRecoveryDevice();
  const now = new Date("2026-11-01T12:00:00.000Z");
  const sessions = {
    cleared: crypto.randomUUID(),
    accountedNotCleared: crypto.randomUUID(),
    unresolved: crypto.randomUUID(),
    contentMismatch: crypto.randomUUID(),
    escalated: crypto.randomUUID(),
    recent: crypto.randomUUID()
  };
  for (const [kind, recoveryId] of Object.entries(sessions)) {
    const isRecent = kind === "recent";
    const isEscalated = kind === "escalated" || kind === "contentMismatch";
    const accounted = kind === "cleared" || kind === "accountedNotCleared" || kind === "recent";
    const outcome = kind === "cleared" ? "cleared" : "not_cleared";
    await query(
      `
        INSERT INTO recovery_sessions (
          recovery_id, device_identity, user_id, state, app_version, local_summary,
          integrity_hwm, outcome, outcome_reasons, reconciliation_result,
          lease_expires_at, started_at, completed_at
        ) VALUES (
          $1, $2, $3, $4, 'purge-test', '{}'::jsonb, 0, $5, '[]'::jsonb,
          $6::jsonb, $7::timestamptz, $7::timestamptz, $8::timestamptz
        )
      `,
      [
        recoveryId,
        device.deviceIdentity,
        device.userId,
        isEscalated ? "escalated" : "completed",
        outcome,
        JSON.stringify({ all_items_reported_by_device_accounted_for: accounted }),
        now.toISOString(),
        new Date(now.getTime() - (isRecent ? 10 : 45) * 24 * 60 * 60 * 1000).toISOString()
      ]
    );
    await query(
      `INSERT INTO recovery_parts (recovery_id, part_no, sha256, payload) VALUES ($1, 0, $2, $3::jsonb)`,
      [recoveryId, "a".repeat(64), JSON.stringify({ records: [{ private: kind }], queue: [] })]
    );
    await query(
      `
        INSERT INTO recovery_audit_events (device_identity, recovery_id, kind, detail)
        VALUES ($1, $2, 'recovery_completed_not_cleared', '{}'::jsonb)
      `,
      [device.deviceIdentity, recoveryId]
    );
  }
  await query(
    `
      INSERT INTO ledger_recoveries (
        device_identity, original_entry_hash, original_local_id, original_signed_id, original_confirmed_at,
        date_check, replacement_entry_id, replacement_entry_hash, recovery_id
      ) VALUES ($1, $2, 1, 1, '1793000000'::jsonb, 'ok', 2, $3, $4)
    `,
    [device.deviceIdentity, "b".repeat(64), "c".repeat(64), sessions.cleared]
  );

  const dryRun = await purgeRecoveryPayloads(getPool(), { now });
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.session_count, 2);
  assert.equal(dryRun.part_count, 2);
  assert.deepEqual(new Set(dryRun.recovery_ids), new Set([sessions.cleared, sessions.accountedNotCleared]));
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM recovery_parts")).rows[0].n, 6);

  const executed = await purgeRecoveryPayloads(getPool(), { execute: true, now });
  assert.equal(executed.mode, "execute");
  assert.equal(executed.part_count, 2);
  const remaining = (await query("SELECT recovery_id FROM recovery_parts ORDER BY recovery_id")).rows
    .map((row) => row.recovery_id);
  assert.deepEqual(new Set(remaining), new Set([
    sessions.unresolved, sessions.contentMismatch, sessions.escalated, sessions.recent
  ]));
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM recovery_sessions")).rows[0].n, 6);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM recovery_audit_events")).rows[0].n, 6);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM ledger_recoveries")).rows[0].n, 1);
});
