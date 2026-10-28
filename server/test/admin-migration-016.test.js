import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readOverview, rebuildRollups } from "../src/admin-metrics.js";
import { closeAdminPools } from "../src/admin-db.js";
import { getPool, query } from "../src/db.js";
import { prepareAdminTestDatabase, seedAdmin } from "./helpers/admin.js";

// Migration 016 (exclusion model) applied to a database shaped like production before it:
// built by 009–012 with old-model rollups and classification rows already present.

const migration = (name) => new URL(`../migrations/${name}`, import.meta.url);
const MIGRATION_016 = migration("016_admin_exclusion_model.sql");

async function rebuildOldShape() {
  // Recreate the pre-016 tables and constraints exactly as 011 and 012 define them.
  await query(`DROP TABLE IF EXISTS metrics_dimension_snapshot, metrics_snapshot, metrics_daily_rollup, metrics_rollup_state CASCADE`);
  await prepareAdminTestDatabase({
    migrations: [
      migration("009_admin_backend.sql"),
      migration("010_account_classification.sql"),
      migration("011_admin_metrics_rollup.sql"),
      migration("012_admin_dimension_snapshot.sql")
    ]
  });
  const constraints = await query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'account_classification'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%reason_code%'
  `);
  for (const { conname } of constraints.rows) {
    await query(`ALTER TABLE account_classification DROP CONSTRAINT "${conname}"`);
  }
  await query(`DELETE FROM account_classification WHERE reason_code = 'OPERATOR_ADMIN_ACCOUNT'`);
  await query(`
    ALTER TABLE account_classification ADD CONSTRAINT legacy_reason_rule
    CHECK (reason_code IN ('OPERATOR_TEST_ACCOUNT', 'OPERATOR_DEMO_ACCOUNT', 'OWNER_CLASSIFIED_EXTERNAL', 'CORRECTION'))
  `);
  // Production may carry names other than the defaults; 016 must find the rules by content.
  const rollupChecks = await query(`
    SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
    WHERE contype = 'c' AND conrelid IN ('metrics_daily_rollup'::regclass, 'metrics_snapshot'::regclass, 'metrics_dimension_snapshot'::regclass)
      AND (pg_get_constraintdef(oid) LIKE '%bucket%' OR pg_get_constraintdef(oid) LIKE '%dimension%')
  `);
  for (const [index, { tbl, conname }] of rollupChecks.rows.entries()) {
    await query(`ALTER TABLE ${tbl} RENAME CONSTRAINT "${conname}" TO "legacy_rule_${index}"`);
  }
}

async function violates(sql, params = []) {
  try {
    await query(sql, params);
    return false;
  } catch (error) {
    assert.equal(error.code, "23514", error.message);
    return true;
  }
}

let owner;
const users = {};

before(async () => {
  await query(`TRUNCATE admin_audit_log, admin_classification_confirmations, account_classification, admin_sessions, admin_users, attestations, ledger_entries, device_identities, users RESTART IDENTITY CASCADE`).catch(() => {});
  await rebuildOldShape();
  owner = await seedAdmin("owner");
  for (const name of ["none", "external", "demo", "test", "corrected"]) {
    users[name] = (await query(
      `INSERT INTO users (phone_number, email) VALUES ($1, $2) RETURNING id`,
      [`+1555010${Object.keys(users).length}000`, `migration-${name}@example.test`]
    )).rows[0].id;
  }
  await query(`INSERT INTO account_classification (user_id, classification, reason_code, classified_by) VALUES
    ($1, 'EXTERNAL', 'OWNER_CLASSIFIED_EXTERNAL', $4),
    ($2, 'DEMO', 'OPERATOR_DEMO_ACCOUNT', $4),
    ($3, 'INTERNAL_TEST', 'OPERATOR_TEST_ACCOUNT', $4),
    ($5, 'EXTERNAL', 'CORRECTION', $4)`, [users.external, users.demo, users.test, owner.id, users.corrected]);
  // Old-model rollups, as a production database holds them before 016.
  await query(`INSERT INTO metrics_daily_rollup (metric_date, metric_key, bucket, count) VALUES
    (CURRENT_DATE, 'accounts_registered', 'external', 1),
    (CURRENT_DATE, 'accounts_registered', 'internal_demo', 2),
    (CURRENT_DATE, 'accounts_registered', 'unclassified', 1)`);
  await query(`INSERT INTO metrics_snapshot (metric_key, bucket, count) VALUES
    ('accounts_all', 'external', 1), ('accounts_all', 'internal_demo', 2), ('accounts_all', 'unclassified', 1)`);
  await query(`INSERT INTO metrics_dimension_snapshot (dimension, category, count) VALUES ('country', 'US', 1)`);
  await query(`UPDATE metrics_rollup_state SET built_at = NOW(), stale = FALSE, build_ms = 5 WHERE id = TRUE`);
});

after(async () => {
  try {
    await query(`TRUNCATE admin_audit_log, admin_classification_confirmations, account_classification, admin_sessions, admin_users, metrics_dimension_snapshot, metrics_daily_rollup, metrics_snapshot, users RESTART IDENTITY CASCADE`);
  } finally {
    await closeAdminPools();
    await getPool().end();
  }
});

test("M1: the old shape rejects the new bucket before 016 (the fixture is genuinely pre-016)", async () => {
  assert.equal(await violates(`INSERT INTO metrics_snapshot (metric_key, bucket, count) VALUES ('probe', 'excluded', 1)`), true);
});

test("M2: 016 clears old-model rollups, marks them unbuilt and keeps classification rows", async () => {
  await query(await readFile(MIGRATION_016, "utf8"));
  for (const table of ["metrics_daily_rollup", "metrics_snapshot", "metrics_dimension_snapshot"]) {
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count, 0, table);
  }
  const state = (await query(`SELECT built_at, stale FROM metrics_rollup_state WHERE id = TRUE`)).rows[0];
  assert.equal(state.built_at, null);
  assert.equal(state.stale, true);
  const rows = (await query(`SELECT classification FROM account_classification ORDER BY classification`)).rows;
  assert.deepEqual(rows.map(({ classification }) => classification), ["DEMO", "EXTERNAL", "EXTERNAL", "INTERNAL_TEST"]);
  const reasons = (await query(`SELECT reason_code FROM account_classification ORDER BY reason_code`)).rows;
  assert.deepEqual(reasons.map(({ reason_code }) => reason_code), ["CORRECTION", "OPERATOR_DEMO_ACCOUNT", "OPERATOR_TEST_ACCOUNT", "OWNER_CLASSIFIED_EXTERNAL"]);
});

test("M3: after 016 the old buckets are refused and the new ones accepted", async () => {
  for (const table of ["metrics_daily_rollup", "metrics_snapshot"]) {
    const columns = table === "metrics_daily_rollup" ? "(metric_date, metric_key, bucket, count)" : "(metric_key, bucket, count)";
    const values = (bucket) => table === "metrics_daily_rollup" ? `(CURRENT_DATE, 'probe', '${bucket}', 1)` : `('probe', '${bucket}', 1)`;
    // A server still running pre-016 code writes these; it must fail, never mix models.
    assert.equal(await violates(`INSERT INTO ${table} ${columns} VALUES ${values("unclassified")}`), true, table);
    assert.equal(await violates(`INSERT INTO ${table} ${columns} VALUES ${values("internal_demo")}`), true, table);
    assert.equal(await violates(`INSERT INTO ${table} ${columns} VALUES ${values("excluded")}`), false, table);
    await query(`DELETE FROM ${table} WHERE metric_key = 'probe'`);
  }
  assert.equal(await violates(`INSERT INTO metrics_dimension_snapshot (dimension, category, count) VALUES ('business_type', 'probe', 1)`), false);
  assert.equal(await violates(`INSERT INTO metrics_dimension_snapshot (dimension, category, count) VALUES ('region', 'probe', 1)`), true);
  await query(`DELETE FROM metrics_dimension_snapshot WHERE category = 'probe'`);
  assert.equal(await violates(
    `INSERT INTO account_classification (user_id, classification, reason_code, classified_by) VALUES ($1, 'INTERNAL_TEST', 'OPERATOR_ADMIN_ACCOUNT', $2)`,
    [users.none, owner.id]
  ), false);
  await query(`DELETE FROM account_classification WHERE user_id = $1`, [users.none]);
});

test("M4: running 016 again changes nothing and fails nothing", async () => {
  await query(await readFile(MIGRATION_016, "utf8"));
  const checks = await query(`
    SELECT conrelid::regclass::text AS tbl, COUNT(*)::int AS count FROM pg_constraint
    WHERE contype = 'c' AND conrelid IN ('metrics_daily_rollup'::regclass, 'metrics_snapshot'::regclass, 'metrics_dimension_snapshot'::regclass, 'account_classification'::regclass)
      AND (pg_get_constraintdef(oid) LIKE '%bucket%' OR pg_get_constraintdef(oid) LIKE '%dimension%' OR pg_get_constraintdef(oid) LIKE '%reason_code%')
    GROUP BY 1 ORDER BY 1
  `);
  assert.deepEqual(checks.rows.map(({ tbl, count }) => [tbl, count]), [
    ["account_classification", 1], ["metrics_daily_rollup", 1], ["metrics_dimension_snapshot", 1], ["metrics_snapshot", 1]
  ]);
});

test("M5: the first rebuild after 016 counts under the exclusion rule", async () => {
  const result = await rebuildRollups();
  assert.equal(result.rebuilt, true);
  const registered = (await readOverview({ range: "all" })).metrics.find(({ key }) => key === "accounts_registered");
  // none (no row), external and corrected count as External; demo and test are excluded.
  assert.deepEqual([registered.external, registered.excluded, registered.total], [3, 2, 5]);
});

test("M6: running 016 again after the rebuild keeps the rebuilt figures", async () => {
  const counts = async () => {
    const out = [];
    for (const table of ["metrics_daily_rollup", "metrics_snapshot", "metrics_dimension_snapshot"]) {
      out.push((await query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count);
    }
    return out;
  };
  const state = async () => (await query(`SELECT built_at, stale, invalidations FROM metrics_rollup_state WHERE id = TRUE`)).rows[0];
  const beforeCounts = await counts();
  const beforeState = await state();
  assert.ok(beforeCounts.every((count) => count > 0), String(beforeCounts));
  assert.notEqual(beforeState.built_at, null);
  await query(await readFile(MIGRATION_016, "utf8"));
  assert.deepEqual(await counts(), beforeCounts);
  assert.deepEqual(await state(), beforeState);
  const registered = (await readOverview({ range: "all" })).metrics.find(({ key }) => key === "accounts_registered");
  assert.deepEqual([registered.external, registered.excluded, registered.total], [3, 2, 5]);
});

test("M7: a database holding an old rule beside the new ones is repaired, not skipped", async () => {
  // e.g. an interrupted manual repair: the new rule exists, but an old one still refuses 'excluded'.
  await query(`ALTER TABLE metrics_snapshot ADD CONSTRAINT leftover_rule
    CHECK (bucket IN ('external', 'internal_demo', 'unclassified')) NOT VALID`);
  assert.equal(await violates(`INSERT INTO metrics_snapshot (metric_key, bucket, count) VALUES ('probe', 'excluded', 1)`), true);
  await query(await readFile(MIGRATION_016, "utf8"));
  const leftover = await query(`SELECT 1 FROM pg_constraint WHERE conname = 'leftover_rule'`);
  assert.equal(leftover.rowCount, 0);
  const state = (await query(`SELECT built_at, stale FROM metrics_rollup_state WHERE id = TRUE`)).rows[0];
  assert.equal(state.built_at, null);
  assert.equal(state.stale, true);
  assert.equal((await rebuildRollups()).rebuilt, true);
  const registered = (await readOverview({ range: "all" })).metrics.find(({ key }) => key === "accounts_registered");
  assert.deepEqual([registered.external, registered.excluded, registered.total], [3, 2, 5]);
});
