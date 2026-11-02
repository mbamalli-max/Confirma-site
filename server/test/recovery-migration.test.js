import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { config } from "../src/config.js";
import { assertLocalTestDatabase, createStageDatabase } from "./helpers/db.js";

assertLocalTestDatabase(config.databaseUrl);

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("recovery migration applies through the real runner over populated history without changing a row", async () => {
  const stage = await createStageDatabase(22, {
    databaseUrl: config.databaseUrl,
    databaseSsl: config.databaseSsl,
    freshSchema: true
  });
  try {
    const user = (await stage.pool.query(
      `INSERT INTO users (phone_number, email) VALUES ('+12025550111', 'recovery-migration@example.test') RETURNING id`
    )).rows[0];
    await stage.pool.query(
      `
        INSERT INTO device_identities (device_identity, public_key, user_id, status)
        VALUES ('migration-device', '{}', $1, 'FORKED')
      `,
      [user.id]
    );
    await stage.pool.query(
      `
        INSERT INTO ledger_entries (
          device_identity, entry_id, entry_hash, prev_entry_hash, signature,
          confirmed_at, payload
        ) VALUES ('migration-device', 1, $1, $2, 'signature', NOW(), $3::jsonb)
      `,
      ["a".repeat(64), "0".repeat(64), JSON.stringify({ marker: "existing" })]
    );
    await stage.pool.query(
      `
        INSERT INTO ledger_integrity_events (device_identity, entry_id, kind, detail)
        VALUES ('migration-device', 1, 'fork_id_conflict', $1::jsonb)
      `,
      [JSON.stringify({ received_entry_hash: "b".repeat(64) })]
    );
    const beforeRows = (await stage.pool.query(
      `
        SELECT
          (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.device_identity) FROM device_identities d) AS devices,
          (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.device_identity, e.entry_id) FROM ledger_entries e) AS entries,
          (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM ledger_integrity_events i) AS integrity
      `
    )).rows[0];
    const integrityCheckBefore = (await stage.pool.query(
      `
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'ledger_integrity_events'::regclass AND contype = 'c'
      `
    )).rows.map((row) => row.definition).sort();

    await stage.runMigrations(23);

    const afterRows = (await stage.pool.query(
      `
        SELECT
          (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.device_identity) FROM device_identities d) AS devices,
          (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.device_identity, e.entry_id) FROM ledger_entries e) AS entries,
          (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM ledger_integrity_events i) AS integrity
      `
    )).rows[0];
    assert.equal(digest(afterRows), digest(beforeRows));

    const tables = (await stage.pool.query(
      `
        SELECT relname FROM pg_class
        WHERE relname = ANY($1::text[]) AND relkind = 'r'
        ORDER BY relname
      `,
      [["ledger_recoveries", "recovery_audit_events", "recovery_parts", "recovery_reservations", "recovery_sessions"]]
    )).rows.map((row) => row.relname);
    assert.deepEqual(tables, [
      "ledger_recoveries",
      "recovery_audit_events",
      "recovery_parts",
      "recovery_reservations",
      "recovery_sessions"
    ]);
    const signedIdColumns = (await stage.pool.query(
      `
        SELECT table_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'original_signed_id'
          AND table_name = ANY($1::text[])
        ORDER BY table_name
      `,
      [["ledger_recoveries", "recovery_reservations"]]
    )).rows;
    assert.deepEqual(signedIdColumns, [
      { table_name: "ledger_recoveries", is_nullable: "NO" },
      { table_name: "recovery_reservations", is_nullable: "NO" }
    ]);

    const integrityCheckAfter = (await stage.pool.query(
      `
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'ledger_integrity_events'::regclass AND contype = 'c'
      `
    )).rows.map((row) => row.definition).sort();
    assert.deepEqual(integrityCheckAfter, integrityCheckBefore);
    const ledgerForeignKeys = (await stage.pool.query(
      `
        SELECT conname
        FROM pg_constraint
        WHERE contype = 'f'
          AND (
            conrelid IN (
              'recovery_sessions'::regclass, 'recovery_parts'::regclass,
              'recovery_reservations'::regclass, 'ledger_recoveries'::regclass,
              'recovery_audit_events'::regclass
            )
            AND confrelid = 'ledger_entries'::regclass
          )
      `
    )).rows;
    assert.deepEqual(ledgerForeignKeys, []);
    const reservationUniqueDefinitions = (await stage.pool.query(
      `
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'recovery_reservations'::regclass AND contype = 'u'
        ORDER BY definition
      `
    )).rows.map((row) => row.definition);
    assert.equal(reservationUniqueDefinitions.length, 3);
    assert.ok(reservationUniqueDefinitions.some((definition) => definition.includes("device_identity, original_entry_hash")));
    assert.ok(reservationUniqueDefinitions.some((definition) => definition.includes("device_identity, planned_entry_id")));
    assert.ok(reservationUniqueDefinitions.some((definition) => definition.includes("device_identity, planned_entry_hash")));
    const activeIndex = (await stage.pool.query(
      `
        SELECT indexdef FROM pg_indexes
        WHERE indexname = 'idx_recovery_sessions_one_active_device'
      `
    )).rows[0].indexdef;
    assert.match(activeIndex, /UNIQUE INDEX/);
    assert.match(activeIndex, /state.*open.*uploaded.*planned.*syncing/);
    await stage.runMigrations(23);
    assert.equal((await stage.pool.query("SELECT COUNT(*)::int AS n FROM recovery_sessions")).rows[0].n, 0);
  } finally {
    await stage.drop();
  }
});
