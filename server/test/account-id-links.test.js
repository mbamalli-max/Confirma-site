import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { buildAttestationEnvelope } from "../src/attestation-signing.js";
import { registerAttestRoutes } from "../src/routes/attest.js";
import { assertLocalTestDatabase } from "./helpers/db.js";

// This suite deliberately recreates the pre-021 shape, then leaves the shared
// local test database at the post-021 shape for the route suites.
assertLocalTestDatabase(config.databaseUrl);
const migrationUrl = new URL("../migrations/021_account_id_links.sql", import.meta.url);
const migrationSql = await readFile(migrationUrl, "utf8");
const serverDir = fileURLToPath(new URL("..", import.meta.url));
const runFile = promisify(execFile);
const verifyApp = Fastify({ logger: false });

async function pre021Shape() {
  await query("TRUNCATE rotation_challenges, users RESTART IDENTITY CASCADE");
  for (const table of ["device_identities", "key_rotation_events", "attestations", "payments", "rotation_challenges"]) {
    await query(`DROP TRIGGER IF EXISTS ${table}_account_id_link ON ${table}`);
    await query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS user_id`);
  }
  await query("DROP FUNCTION IF EXISTS enforce_account_id_link()");
}

async function apply021() {
  await query(migrationSql);
}

before(async () => {
  await pre021Shape();
  await registerAttestRoutes(verifyApp);
  await verifyApp.ready();
});

after(async () => {
  await query("TRUNCATE rotation_challenges, users RESTART IDENTITY CASCADE");
  await apply021();
  await query("INSERT INTO schema_migrations (version) VALUES (21) ON CONFLICT (version) DO NOTHING");
  await verifyApp.close();
  await getPool().end();
});

test("M1a migration refuses an unresolvable historical row without changing it", async () => {
  try {
    await query("INSERT INTO users (phone_number) VALUES ('+15559990000')");
    await query("INSERT INTO device_identities (device_identity, public_key, phone_number) VALUES ('existing-before-021', 'existing-key', '+15559990000')");
    await query("INSERT INTO key_rotation_events (old_device_identity, new_device_identity, phone_number, rotation_receipt) VALUES ('existing-before-021', 'existing-next', '+15559990000', 'existing-receipt')");
    await query("INSERT INTO attestations (vt_id, device_identity, phone_number, ledger_root_hash, window_start, window_end, entry_count, server_signature) VALUES ('existing-attestation-before-021', 'existing-before-021', '+15559990000', 'existing-hash', NOW(), NOW(), 1, 'existing-signature')");
    await query("INSERT INTO payments (phone_number, device_identity, reference, amount_kobo, tier, window_days) VALUES ('+15559990000', 'existing-before-021', 'existing-payment-before-021', 1, 'basic', 30)");
    await query(
      "INSERT INTO rotation_challenges (phone_number, old_device_identity, challenge_nonce, expires_at) VALUES ('+15559990001', 'orphan-device', 'orphan-before-021', NOW())"
    );

    const linkedTables = ["device_identities", "key_rotation_events", "attestations", "payments", "rotation_challenges"];
    const snapshotTables = ["users", ...linkedTables];
    const snapshots = Object.fromEntries(await Promise.all(snapshotTables.map(async (table) => [
      table,
      (await query(`SELECT row_to_json(row)::text AS row FROM ${table} AS row ORDER BY ctid`)).rows.map(({ row }) => row)
    ])));
    await query("DELETE FROM schema_migrations WHERE version = 21");

    const runnerError = await runFile(process.execPath, ["migrate.js"], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: config.databaseUrl }
    }).then(() => null, (error) => error);
    assert.ok(runnerError, "migrate.js must fail for an unresolvable historical owner");
    assert.notEqual(runnerError.code, 0);
    assert.match(`${runnerError.stdout || ""}\n${runnerError.stderr || ""}`, /unresolvable phone owner/);

    assert.deepEqual((await query("SELECT version FROM schema_migrations WHERE version = 21")).rows, []);
    const linkedColumns = await query(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id' AND table_name = ANY($1::text[]) ORDER BY table_name",
      [linkedTables]
    );
    assert.deepEqual(linkedColumns.rows, []);
    assert.deepEqual((await query(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%\\_account\\_id\\_link' ESCAPE '\\'"
    )).rows, []);
    assert.equal((await query("SELECT to_regprocedure('enforce_account_id_link()') AS link_function")).rows[0].link_function, null);

    for (const table of snapshotTables) {
      const after = (await query(`SELECT row_to_json(row)::text AS row FROM ${table} AS row ORDER BY ctid`)).rows.map(({ row }) => row);
      assert.deepEqual(after, snapshots[table], `${table} rows must be byte-identical after the failed runner migration`);
    }
  } finally {
    // The next test must begin with a clean pre-021 shape even if an assertion above fails.
    await query("TRUNCATE rotation_challenges, users RESTART IDENTITY CASCADE");
  }
});

test("M1a migration backfills every historical owner without modifying signed content", async () => {
  const phone = "+15550000021";
  const user = (await query("INSERT INTO users (phone_number) VALUES ($1) RETURNING id", [phone])).rows[0];
  await query("INSERT INTO device_identities (device_identity, public_key, phone_number) VALUES ('m1a-device', 'key', $1)", [phone]);
  const historical = buildAttestationEnvelope({
    vt_id: "m1a-vt",
    device_identity: "m1a-device",
    ledger_root_hash: "hash",
    entry_count: 1,
    window_start: new Date(Date.now() - 60_000).toISOString(),
    window_end: new Date().toISOString(),
    issued_at: new Date().toISOString(),
    status: "VALID"
  });
  await query("INSERT INTO attestations (vt_id, device_identity, phone_number, ledger_root_hash, window_start, window_end, entry_count, server_signature, issued_at) VALUES ($1, 'm1a-device', $2, $3, $4, $5, $6, $7, $8)", [historical.vt_id, phone, historical.ledger_root_hash, historical.window_start, historical.window_end, historical.entry_count, historical.server_signature, historical.issued_at]);
  const before = (await query("SELECT server_signature, ledger_root_hash FROM attestations WHERE vt_id = 'm1a-vt'")).rows[0];
  await apply021();
  const linked = (await query("SELECT user_id FROM attestations WHERE vt_id = 'm1a-vt'")).rows[0];
  assert.equal(linked.user_id, user.id);
  assert.deepEqual((await query("SELECT server_signature, ledger_root_hash FROM attestations WHERE vt_id = 'm1a-vt'")).rows[0], before);
  const verification = await verifyApp.inject({ method: "GET", url: "/verify/m1a-vt" });
  assert.equal(verification.statusCode, 200, verification.body);
  assert.equal(verification.json().status, "VALID");
  await query("INSERT INTO rotation_challenges (phone_number, old_device_identity, challenge_nonce, expires_at) VALUES ($1, 'm1a-device', 'old-shape-m1a', NOW() + INTERVAL '1 minute')", [phone]);
  assert.equal((await query("SELECT user_id FROM rotation_challenges WHERE challenge_nonce = 'old-shape-m1a'")).rows[0].user_id, user.id);
});

test("M1a trigger rejects unknown and conflicting owners", async () => {
  const phone = "+15550000022";
  const otherPhone = "+15550000023";
  const owner = (await query("INSERT INTO users (phone_number) VALUES ($1) RETURNING id", [phone])).rows[0];
  const other = (await query("INSERT INTO users (phone_number) VALUES ($1) RETURNING id", [otherPhone])).rows[0];
  await assert.rejects(query("INSERT INTO rotation_challenges (phone_number, user_id, old_device_identity, challenge_nonce, expires_at) VALUES ($1, $2, 'd', 'bad-pair-m1a', NOW())", [phone, other.id]));
  await assert.rejects(query("INSERT INTO rotation_challenges (phone_number, old_device_identity, challenge_nonce, expires_at) VALUES ('+15559999999', 'd', 'unknown-m1a', NOW())"));
  await query("INSERT INTO rotation_challenges (phone_number, user_id, old_device_identity, challenge_nonce, expires_at) VALUES ($1, $2, 'd', 'new-shape-m1a', NOW())", [phone, owner.id]);
});

test("M1a triggers cover all linked tables and preserve ownership on old-shape updates", async () => {
  const phone = "+15550000024";
  const otherPhone = "+15550000025";
  const owner = (await query("INSERT INTO users (phone_number) VALUES ($1) RETURNING id", [phone])).rows[0];
  const other = (await query("INSERT INTO users (phone_number) VALUES ($1) RETURNING id", [otherPhone])).rows[0];
  await query("INSERT INTO device_identities (device_identity, public_key, phone_number, user_id) VALUES ('trigger-device-m1a', 'key', $1, $2)", [phone, owner.id]);
  await query("INSERT INTO key_rotation_events (old_device_identity, new_device_identity, phone_number, user_id, rotation_receipt) VALUES ('trigger-device-m1a', 'trigger-device-next', $1, $2, 'receipt')", [phone, owner.id]);
  await query("INSERT INTO attestations (vt_id, device_identity, phone_number, user_id, ledger_root_hash, window_start, window_end, entry_count, server_signature) VALUES ('trigger-attestation-m1a', 'trigger-device-m1a', $1, $2, 'hash', NOW(), NOW(), 1, 'signature')", [phone, owner.id]);
  await query("INSERT INTO payments (phone_number, user_id, device_identity, reference, amount_kobo, tier, window_days) VALUES ($1, $2, 'trigger-device-m1a', 'trigger-payment-m1a', 1, 'basic', 30)", [phone, owner.id]);
  await query("INSERT INTO rotation_challenges (phone_number, user_id, old_device_identity, challenge_nonce, expires_at) VALUES ($1, $2, 'trigger-device-m1a', 'trigger-challenge-m1a', NOW())", [phone, owner.id]);

  const updates = [
    ["device_identities", "device_identity = 'trigger-device-m1a'"],
    ["key_rotation_events", "rotation_receipt = 'receipt'"],
    ["attestations", "vt_id = 'trigger-attestation-m1a'"],
    ["payments", "reference = 'trigger-payment-m1a'"],
    ["rotation_challenges", "challenge_nonce = 'trigger-challenge-m1a'"]
  ];
  for (const [table, where] of updates) {
    await query(`UPDATE ${table} SET user_id = NULL WHERE ${where}`);
    const row = (await query(`SELECT user_id FROM ${table} WHERE ${where}`)).rows[0];
    assert.equal(row.user_id, owner.id, `${table} old-shape update should resolve its owner`);
  }

  const triggers = await query(
    "SELECT tgname FROM pg_trigger WHERE tgname = ANY($1::text[]) AND NOT tgisinternal ORDER BY tgname",
    [["device_identities_account_id_link", "key_rotation_events_account_id_link", "attestations_account_id_link", "payments_account_id_link", "rotation_challenges_account_id_link"]]
  );
  assert.deepEqual(triggers.rows.map((row) => row.tgname), [
    "attestations_account_id_link", "device_identities_account_id_link", "key_rotation_events_account_id_link", "payments_account_id_link", "rotation_challenges_account_id_link"
  ]);
  await assert.rejects(query("UPDATE rotation_challenges SET phone_number = $1, user_id = NULL WHERE challenge_nonce = 'trigger-challenge-m1a'", [otherPhone]));
  await assert.rejects(query("UPDATE rotation_challenges SET user_id = $1 WHERE challenge_nonce = 'trigger-challenge-m1a'", [other.id]));
  await assert.rejects(query("UPDATE rotation_challenges SET user_id = '00000000-0000-0000-0000-000000000001' WHERE challenge_nonce = 'trigger-challenge-m1a'"));
});
