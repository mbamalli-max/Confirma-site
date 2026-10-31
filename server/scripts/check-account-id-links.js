#!/usr/bin/env node

// Read-only M1a rollout diagnostic. Deliberately prints aggregate counts only.
import { getPool } from "../src/db.js";

const tables = [
  "device_identities",
  "key_rotation_events",
  "attestations",
  "payments",
  "rotation_challenges"
];

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    for (const table of tables) {
      const result = await client.query(`
        SELECT
          COUNT(*)::bigint AS total_rows,
          COUNT(*) FILTER (WHERE link.user_id IS NULL)::bigint AS null_user_id_rows,
          COUNT(*) FILTER (WHERE link.user_id IS NOT NULL AND owner.phone_number IS DISTINCT FROM link.phone_number)::bigint AS phone_mismatch_rows,
          COUNT(*) FILTER (WHERE phone_owner.id IS NULL)::bigint AS orphaned_phone_rows
        FROM ${table} AS link
        LEFT JOIN users AS owner ON owner.id = link.user_id
        LEFT JOIN users AS phone_owner ON phone_owner.phone_number = link.phone_number
      `);
      const row = result.rows[0];
      console.log(`${table}: total=${row.total_rows} null_user_id=${row.null_user_id_rows} phone_mismatch=${row.phone_mismatch_rows} orphaned_phone=${row.orphaned_phone_rows}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Account-ID link check failed.", error.message);
  process.exitCode = 1;
});
