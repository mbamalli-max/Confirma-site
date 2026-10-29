import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { readDimensionSnapshot, readStatus, rebuildRollups } from "../src/admin-metrics.js";
import { closeAdminPools } from "../src/admin-db.js";
import { BUSINESS_TYPE_CATALOG } from "../src/business-catalog.js";
import { getPool, query } from "../src/db.js";
import { effectiveSector } from "../src/sector-assignment.js";
import { prepareAdminTestDatabase } from "./helpers/admin.js";

// Migration 017 (every business profile in a sector) applied to profiles shaped like production
// before it: no sector_source column, unlisted rows with no sector, a stale sector on a moved type,
// legacy sector-only rows, phone-only rows from the free report, and signed ledger entries.

const migration = (name) => new URL(`../migrations/${name}`, import.meta.url);
const MIGRATION_017 = migration("017_sector_assignment.sql");
const GUARDS = [
  "profiles_sector_id_valid",
  "profiles_sector_source_valid",
  "profiles_sector_source_pairing",
  "profiles_fallback_is_other",
  "profiles_business_has_sector"
];

// name -> profile columns before 017, and the sector/source expected after it.
const FIXTURES = {
  kiosk_old_sector: { type: "ng_kiosk_phone_business", sector: "digital_online", expect: ["trade_retail", "catalog"] },
  tailor_old_sector: { type: "ng_fashion_tailor", sector: "personal_professional", expect: ["skilled_construction", "catalog"] },
  listed_missing: { type: "ng_food_vendor", sector: null, expect: ["food_hospitality", "catalog"] },
  listed_wrong: { type: "global_tutoring", sector: "trade_retail", expect: ["personal_professional", "catalog"] },
  listed_correct: { type: "us_retail", sector: "trade_retail", expect: ["trade_retail", "catalog"] },
  unlisted_no_sector: { type: "unlisted", sector: null, description: "Poultry farm and eggs", expect: ["other_activity", "fallback"] },
  unlisted_ambiguous: { type: "unlisted", sector: null, description: "Mama Ngozi", expect: ["other_activity", "fallback"] },
  legacy_sector_only: { type: null, sector: "food_hospitality", expect: ["food_hospitality", "user"] },
  legacy_invalid_sector: { type: null, sector: "services", expect: ["other_activity", "fallback"] },
  unknown_type: { type: "ng_pos_agent", sector: null, expect: ["other_activity", "fallback"] },
  phone_only: { type: null, sector: null, expect: [null, null] },
  blank_sector_only: { type: "", sector: "", expect: [null, null] }
};

const ids = {};

async function preMigrationShape() {
  await prepareAdminTestDatabase({
    migrations: [
      migration("009_admin_backend.sql"),
      migration("010_account_classification.sql"),
      migration("011_admin_metrics_rollup.sql"),
      migration("012_admin_dimension_snapshot.sql"),
      migration("016_admin_exclusion_model.sql")
    ]
  });
  for (const name of GUARDS) await query(`ALTER TABLE profiles DROP CONSTRAINT IF EXISTS ${name}`);
  await query(`ALTER TABLE profiles DROP COLUMN IF EXISTS sector_source`);
}

// Signed records, attestations and payments: none may change (T-M2). Statement and report figures are
// computed from ledger entries, so an unchanged ledger keeps them unchanged.
async function historyFingerprint() {
  const result = await query(`
    SELECT
      (SELECT md5(string_agg(device_identity || ':' || entry_id || ':' || entry_hash || ':' || signature || ':' || payload::text, '|'
                             ORDER BY device_identity, entry_id)) FROM ledger_entries) AS ledger,
      (SELECT COUNT(*)::int FROM ledger_entries) AS ledger_rows,
      (SELECT md5(string_agg(row_to_json(a)::text, '|' ORDER BY vt_id)) FROM attestations a) AS attestations,
      (SELECT COUNT(*)::int FROM attestations) AS attestation_rows,
      (SELECT md5(string_agg(row_to_json(p)::text, '|' ORDER BY id)) FROM payments p) AS payments,
      (SELECT COUNT(*)::int FROM payments) AS payment_rows
  `);
  return result.rows[0];
}

async function sectors() {
  const result = await query(`SELECT user_id, sector_id, sector_source FROM profiles`);
  return new Map(result.rows.map((row) => [row.user_id, [row.sector_id, row.sector_source]]));
}

async function state() {
  return (await query(`SELECT built_at, stale, invalidations::int AS invalidations FROM metrics_rollup_state WHERE id = TRUE`)).rows[0];
}

before(async () => {
  await query(`TRUNCATE account_classification, metrics_dimension_snapshot, metrics_daily_rollup, metrics_snapshot, payments, attestations, ledger_entries, device_identities, users RESTART IDENTITY CASCADE`);
  await preMigrationShape();
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const phone = `+1555${crypto.randomInt(1_000_000, 9_999_999)}`;
    const userId = (await query(
      `INSERT INTO users (phone_number, email) VALUES ($1, $2) RETURNING id`,
      [phone, `m017-${name}@example.test`]
    )).rows[0].id;
    ids[name] = userId;
    await query(
      `INSERT INTO profiles (user_id, phone_number, name, business_type_id, sector_id, business_description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, phone, "Display Name", fixture.type, fixture.sector, fixture.description || null]
    );
    // Signed records carry their own copy of the sector at capture time.
    const device = `device-${crypto.randomUUID()}`;
    await query(`INSERT INTO device_identities (device_identity, public_key, phone_number, status) VALUES ($1, 'k', $2, 'ACTIVE')`, [device, phone]);
    await query(
      `INSERT INTO ledger_entries (device_identity, entry_id, entry_hash, prev_entry_hash, signature, confirmed_at, payload)
       VALUES ($1, 1, $2, $3, 'sig', NOW(), $4::jsonb)`,
      [device, crypto.randomBytes(32).toString("hex"), "0".repeat(64),
       JSON.stringify({ business_type_id: fixture.type, sector_id: fixture.sector, amount_minor: 1500 })]
    );
    const vtId = `vt-${crypto.randomUUID()}`;
    await query(
      `INSERT INTO attestations (vt_id, device_identity, phone_number, ledger_root_hash, window_start, window_end, entry_count, server_signature)
       VALUES ($1, $2, $3, $4, NOW() - INTERVAL '30 days', NOW(), 1, 'signature')`,
      [vtId, device, phone, crypto.randomBytes(32).toString("hex")]
    );
    await query(
      `INSERT INTO payments (phone_number, device_identity, reference, amount_kobo, tier, window_days, paystack_status, vt_id)
       VALUES ($1, $2, $3, 150000, 'standard', 30, 'success', $4)`,
      [phone, device, `ref-${crypto.randomUUID()}`, vtId]
    );
  }
  // Figures built under the old rule.
  await query(`INSERT INTO metrics_dimension_snapshot (dimension, category, count) VALUES ('sector', 'no_valid_code', 5)`);
  await query(`UPDATE metrics_rollup_state SET built_at = NOW(), stale = FALSE, build_ms = 5 WHERE id = TRUE`);
});

after(async () => {
  try {
    // Leave the shared test database in the post-017 shape for later suites.
    await query(await readFile(MIGRATION_017, "utf8"));
    await query(`TRUNCATE account_classification, metrics_dimension_snapshot, metrics_daily_rollup, metrics_snapshot, payments, attestations, ledger_entries, device_identities, users RESTART IDENTITY CASCADE`);
  } finally {
    await closeAdminPools();
    await getPool().end();
  }
});

test("M0: the migration's frozen catalog copy equals the server catalog", async () => {
  const sql = await readFile(MIGRATION_017, "utf8");
  const block = sql.slice(sql.indexOf("INSERT INTO sector_catalog_017"), sql.indexOf(";", sql.indexOf("INSERT INTO sector_catalog_017")));
  const pairs = Object.fromEntries([...block.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map(([, type, sector]) => [type, sector]));
  assert.deepEqual(pairs, Object.fromEntries(Object.entries(BUSINESS_TYPE_CATALOG).map(([id, entry]) => [id, entry.sector_id])));
});

test("M1 (T-S2, T-S3, T-S4, T-S5): 017 assigns every business profile a sector and leaves rows without a business alone", async () => {
  const historyBefore = await historyFingerprint();
  assert.equal(historyBefore.attestation_rows, Object.keys(FIXTURES).length);
  assert.equal(historyBefore.payment_rows, Object.keys(FIXTURES).length);
  const invalidationsBefore = (await state()).invalidations;
  await query(await readFile(MIGRATION_017, "utf8"));
  const after017 = await sectors();
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    assert.deepEqual(after017.get(ids[name]), fixture.expect, name);
  }
  // The server's own rule gives the same answer for every row.
  const rows = (await query(`SELECT user_id, business_type_id, sector_id, sector_source, business_description FROM profiles`)).rows;
  for (const row of rows) {
    const assigned = effectiveSector(row);
    assert.deepEqual(assigned ? [assigned.sectorId, assigned.source] : [null, null], [row.sector_id, row.sector_source]);
  }
  // T-M2: signed ledger records (and their own sector copies), attestations and payments are untouched.
  assert.deepEqual(await historyFingerprint(), historyBefore);
  // Old-rule figures are gone and the next read rebuilds.
  assert.equal((await query(`SELECT COUNT(*)::int AS count FROM metrics_dimension_snapshot`)).rows[0].count, 0);
  const current = await state();
  assert.equal(current.built_at, null);
  assert.equal(current.stale, true);
  assert.equal(current.invalidations, invalidationsBefore + 1);
});

test("M2 (T-M1): a rerun after the rebuild changes nothing and keeps the rebuilt figures", async () => {
  await rebuildRollups();
  const built = await state();
  const before017 = await sectors();
  const historyBefore = await historyFingerprint();
  const updatedAt = (await query(`SELECT user_id, updated_at FROM profiles ORDER BY user_id`)).rows;
  await query(await readFile(MIGRATION_017, "utf8"));
  assert.deepEqual(await sectors(), before017);
  assert.deepEqual((await query(`SELECT user_id, updated_at FROM profiles ORDER BY user_id`)).rows, updatedAt);
  assert.deepEqual(await historyFingerprint(), historyBefore);
  const again = await state();
  assert.equal(again.built_at.toISOString(), built.built_at.toISOString());
  assert.equal(again.invalidations, built.invalidations);
  assert.ok((await readDimensionSnapshot("sector")).length > 0);
});

test("M3 (T-S10): the rebuilt sector breakdown counts each External account once, by the same rule", async () => {
  const cells = Object.fromEntries((await readDimensionSnapshot("sector")).map(({ category, count }) => [category, count]));
  assert.deepEqual(cells, {
    trade_retail: 2,
    skilled_construction: 1,
    food_hospitality: 2,
    personal_professional: 1,
    other_activity: 4,
    no_business_profile: 2
  });
  const total = Object.values(cells).reduce((sum, count) => sum + count, 0);
  assert.equal(total, Object.keys(FIXTURES).length, "categories reconcile to External accounts");
  const types = await readDimensionSnapshot("business_type");
  assert.equal(types.reduce((sum, { count }) => sum + count, 0), Object.keys(FIXTURES).length);
  assert.deepEqual(types.find(({ category }) => category === "no_business_profile"), { category: "no_business_profile", count: 2 });

  const status = await readStatus();
  assert.deepEqual(
    { ...status.sector_assignment },
    { catalog: 5, user_selected: 1, reviewed_rule: 0, fallback: 4, catalog_mismatches: 0 }
  );
});

test("M4 (T-M1): a partly applied state is repaired: stale same-named guards, odd provenance, misplaced fallback", async () => {
  // Guards left behind with the right names but loose rules, as a partial or older run could leave them.
  for (const name of GUARDS) await query(`ALTER TABLE profiles DROP CONSTRAINT IF EXISTS ${name}`);
  await query(`ALTER TABLE profiles ADD CONSTRAINT profiles_sector_id_valid CHECK (sector_id IS NULL OR length(sector_id) > 0)`);
  await query(`ALTER TABLE profiles ADD CONSTRAINT profiles_sector_source_valid CHECK (sector_source IS NULL OR length(sector_source) > 0)`);
  await query(`UPDATE profiles SET sector_id = NULL, sector_source = NULL WHERE user_id = $1`, [ids.unlisted_no_sector]);
  await query(`UPDATE profiles SET sector_id = 'digital_online' WHERE user_id = $1`, [ids.kiosk_old_sector]);
  // A valid sector with a provenance the server does not know, and a fallback on a named sector.
  await query(`UPDATE profiles SET sector_source = 'guess' WHERE user_id = $1`, [ids.legacy_sector_only]);
  await query(`UPDATE profiles SET sector_id = 'trade_retail', sector_source = 'fallback' WHERE user_id = $1`, [ids.unlisted_ambiguous]);
  const before017 = await state();
  assert.equal((await readStatus()).sector_assignment.catalog_mismatches, 1, "the consistency check sees the drift");

  // The runtime rule, the analytics rule and the migration agree on every odd row.
  const odd = (await query(`SELECT user_id, business_type_id, sector_id, sector_source, business_description FROM profiles WHERE user_id = ANY($1::uuid[])`,
    [[ids.legacy_sector_only, ids.unlisted_ambiguous]])).rows;
  for (const row of odd) assert.deepEqual(effectiveSector(row), { sectorId: "other_activity", source: "fallback" });
  await rebuildRollups();
  const counted = Object.fromEntries((await readDimensionSnapshot("sector")).map(({ category, count }) => [category, count]));

  const builtBefore = await state();
  await query(await readFile(MIGRATION_017, "utf8"));
  const afterMigration = await state();
  assert.equal(afterMigration.built_at, null, "changed rows invalidate the figures");
  assert.equal(afterMigration.invalidations, builtBefore.invalidations + 1);
  const after017 = await sectors();
  assert.deepEqual(after017.get(ids.unlisted_no_sector), ["other_activity", "fallback"]);
  assert.deepEqual(after017.get(ids.kiosk_old_sector), ["trade_retail", "catalog"]);
  assert.deepEqual(after017.get(ids.legacy_sector_only), ["other_activity", "fallback"]);
  assert.deepEqual(after017.get(ids.unlisted_ambiguous), ["other_activity", "fallback"]);
  // Analytics counted the odd rows exactly where the migration put them.
  await rebuildRollups();
  const recounted = Object.fromEntries((await readDimensionSnapshot("sector")).map(({ category, count }) => [category, count]));
  assert.deepEqual(recounted, counted, "analytics already counted every odd row where the migration puts it");

  // The stale same-named guards were replaced by the current rules.
  const guards = Object.fromEntries((await query(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ANY($1::text[])`, [GUARDS]
  )).rows.map(({ conname, def }) => [conname, def]));
  assert.deepEqual(Object.keys(guards).sort(), [...GUARDS].sort());
  assert.match(guards.profiles_sector_id_valid, /other_activity/);
  assert.match(guards.profiles_sector_source_valid, /fallback/);
  for (const [sql, user, constraint] of [
    [`UPDATE profiles SET sector_id = 'not_a_sector' WHERE user_id = $1`, ids.listed_correct, "profiles_sector_id_valid"],
    [`UPDATE profiles SET sector_source = 'guess' WHERE user_id = $1`, ids.listed_correct, "profiles_sector_source_valid"],
    [`UPDATE profiles SET sector_id = 'agriculture' WHERE user_id = $1`, ids.unlisted_no_sector, "profiles_fallback_is_other"]
  ]) {
    await assert.rejects(query(sql, [user]), (error) => error.constraint === constraint, constraint);
  }
  assert.ok(before017.invalidations <= builtBefore.invalidations);
  // Restore the legacy fixture's own choice for the tests that follow.
  await query(`UPDATE profiles SET sector_id = 'food_hospitality', sector_source = 'user' WHERE user_id = $1`, [ids.legacy_sector_only]);
});

test("M5 (T-S9): a sector change reaches the breakdown only after a rebuild", async () => {
  await rebuildRollups();
  const before = Object.fromEntries((await readDimensionSnapshot("sector")).map(({ category, count }) => [category, count]));
  await query(`UPDATE profiles SET sector_id = 'agriculture', sector_source = 'user' WHERE user_id = $1`, [ids.unlisted_no_sector]);
  const stillOld = Object.fromEntries((await readDimensionSnapshot("sector")).map(({ category, count }) => [category, count]));
  assert.deepEqual(stillOld, before, "the snapshot is a single build");
  await rebuildRollups();
  const after = Object.fromEntries((await readDimensionSnapshot("sector")).map(({ category, count }) => [category, count]));
  assert.equal(after.agriculture, 1);
  assert.equal(after.other_activity, before.other_activity - 1);
});
