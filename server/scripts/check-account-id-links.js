#!/usr/bin/env node

// Read-only M1a deploy / M1b acceptance diagnostic. It deliberately prints counts only.
import { getPool } from "../src/db.js";

const tables = ["device_identities", "key_rotation_events", "attestations", "payments", "rotation_challenges"];
const asNumber = (row, key) => Number(row[key] || 0);

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const meta = (await client.query(`
      SELECT
        (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM pg_constraint c JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ordinality) ON true JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid='users'::regclass AND c.contype='p') AS primary_key,
        (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid='users'::regclass AND attname='phone_number' AND NOT attisdropped) AS phone_nullable,
        (SELECT EXISTS(SELECT 1 FROM pg_constraint c JOIN unnest(c.conkey) k(attnum) ON true JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid='users'::regclass AND c.contype IN ('p','u') AND a.attname='phone_number')) AS phone_unique,
        (SELECT EXISTS(SELECT 1 FROM pg_proc WHERE proname='enforce_account_id_link' AND pg_function_is_visible(oid))) AS link_function_present
    `)).rows[0];
    const post022 = meta.primary_key?.length === 1 && meta.primary_key[0] === "id";
    console.log(`stage=${post022 ? "post-022" : "pre-022"}`);

    const ids = (await client.query("SELECT COUNT(*) FILTER (WHERE id IS NULL)::bigint AS null_ids, COUNT(*) - COUNT(DISTINCT id)::bigint AS duplicate_ids FROM users")).rows[0];
    console.log(`users: null_id=${ids.null_ids} duplicate_id=${ids.duplicate_ids}`);
    failed ||= asNumber(ids, "null_ids") > 0 || asNumber(ids, "duplicate_ids") > 0;

    for (const table of tables) {
      const row = (await client.query(`
        SELECT COUNT(*)::bigint total_rows,
          COUNT(*) FILTER (WHERE link.user_id IS NULL)::bigint null_user_id_rows,
          COUNT(*) FILTER (WHERE link.user_id IS NOT NULL AND owner.id IS NULL)::bigint orphaned_user_id_rows,
          COUNT(*) FILTER (WHERE link.user_id IS NOT NULL AND owner.phone_number IS DISTINCT FROM link.phone_number)::bigint phone_difference_rows
        FROM ${table} link LEFT JOIN users owner ON owner.id=link.user_id
      `)).rows[0];
      console.log(`${table}: total=${row.total_rows} null_user_id=${row.null_user_id_rows} orphaned_user_id=${row.orphaned_user_id_rows} phone_difference=${row.phone_difference_rows}${post022 ? " (informational)" : ""}`);
      failed ||= asNumber(row, "null_user_id_rows") > 0 || asNumber(row, "orphaned_user_id_rows") > 0;
      if (!post022) failed ||= asNumber(row, "phone_difference_rows") > 0;
    }

    if (post022) {
      console.log(`catalog: users_pk=${meta.primary_key.join(",")} phone_nullable=${meta.phone_nullable} phone_unique=${meta.phone_unique} link_function_present=${meta.link_function_present}`);
      failed ||= meta.phone_nullable !== true || meta.phone_unique !== true || meta.link_function_present === true;
      for (const table of tables) {
        const row = (await client.query(`
          SELECT
            (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid=$1::regclass AND attname='user_id') user_id_nullable,
            (SELECT COUNT(*) FROM pg_constraint c JOIN unnest(c.conkey) k(attnum) ON true JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid=$1::regclass AND c.contype='f' AND a.attname='user_id' AND c.confrelid='users'::regclass AND c.convalidated) user_id_fks,
            (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid=$1::regclass AND attname='phone_number') phone_nullable,
            (SELECT COUNT(*) FROM pg_constraint c JOIN unnest(c.conkey) k(attnum) ON true JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid=$1::regclass AND c.contype='f' AND a.attname='phone_number' AND c.confrelid='users'::regclass) phone_fks,
            (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal AND tgname LIKE '%_account_id_link') triggers
        `, [table])).rows[0];
        console.log(`${table} catalog: user_id_nullable=${row.user_id_nullable} user_id_fks=${row.user_id_fks} phone_nullable=${row.phone_nullable} phone_fks=${row.phone_fks} triggers=${row.triggers}`);
        failed ||= row.user_id_nullable !== false || asNumber(row, "user_id_fks") !== 1 || row.phone_nullable !== true || asNumber(row, "phone_fks") !== 0 || asNumber(row, "triggers") !== 0;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Account-ID link check failed.", error.message);
  process.exitCode = 1;
});
