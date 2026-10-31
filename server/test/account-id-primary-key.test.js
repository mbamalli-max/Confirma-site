import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { getPool } from "../src/db.js";
import { buildAttestationEnvelope } from "../src/attestation-signing.js";
import { registerAttestRoutes } from "../src/routes/attest.js";
import { assertLocalTestDatabase, createStageDatabase } from "./helpers/db.js";

assertLocalTestDatabase(config.databaseUrl);
const runFile = promisify(execFile);
const serverDir = fileURLToPath(new URL("..", import.meta.url));
const tables = ["device_identities", "key_rotation_events", "attestations", "payments", "rotation_challenges"];
const snapshotTables = ["users", ...tables, "profiles", "otp_challenges", "user_sessions", "ledger_entries"];
let stage;
const originalAttestationConfig = {
  databaseUrl: config.databaseUrl,
  serverAttestationPrivateKeyPem: config.serverAttestationPrivateKeyPem,
  serverAttestationRetiredKeysRaw: config.serverAttestationRetiredKeysRaw,
  serverAttestationRetiredKeys: config.serverAttestationRetiredKeys
};
const { privateKey: historicalAttestationKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const query = (...args) => stage.pool.query(...args);
const run = () => stage.runMigrations(22);

async function pre022() {
  await query("TRUNCATE users RESTART IDENTITY CASCADE");
}

async function dump(table) { return (await query(`SELECT row_to_json(x)::text AS row FROM ${table} x ORDER BY ctid`)).rows.map((r) => r.row); }
async function snapshot() {
  const result = {};
  for (const table of snapshotTables) result[table] = await dump(table);
  result.catalog = (await query("SELECT c.relname,a.attname,a.attnotnull,coalesce(pg_get_expr(d.adbin,d.adrelid),'') AS default_value,coalesce(pg_get_constraintdef(k.oid),'') AS definition FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum LEFT JOIN pg_constraint k ON k.conrelid=c.oid AND a.attnum=ANY(k.conkey) WHERE c.relname=ANY($1::text[]) ORDER BY c.relname,a.attname,default_value,definition", [snapshotTables])).rows;
  result.migrations = (await query("SELECT version FROM schema_migrations ORDER BY version")).rows;
  return result;
}

async function openHistoricalVerifier() {
  const databaseUrl = config.databaseUrl;
  let app;
  let pool;
  try {
    config.databaseUrl = stage.url;
    config.serverAttestationPrivateKeyPem = historicalAttestationKey.export({ type: "pkcs8", format: "pem" }).toString();
    config.serverAttestationRetiredKeysRaw = "";
    config.serverAttestationRetiredKeys = [];
    app = Fastify({ logger: false });
    await registerAttestRoutes(app);
    await app.ready();
    pool = getPool();
  } catch (error) {
    const appToClose = app;
    const poolToEnd = pool;
    app = null;
    pool = null;
    try {
      if (appToClose) await appToClose.close();
    } finally {
      if (poolToEnd) await poolToEnd.end();
    }
    throw error;
  } finally {
    config.databaseUrl = databaseUrl;
  }

  return {
    async verify(vtId) {
      const response = await app.inject({ method: "GET", url: `/verify/${vtId}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().status, "VALID", response.body);
      return response.json();
    },
    async close() {
      const appToClose = app;
      const poolToEnd = pool;
      app = null;
      pool = null;
      try {
        if (appToClose) await appToClose.close();
      } finally {
        if (poolToEnd) await poolToEnd.end();
      }
    }
  };
}

async function seed() {
  const phone = "+15550000220";
  const owner = (await query("INSERT INTO users (phone_number,email) VALUES ($1,'m1b@example.test') RETURNING id", [phone])).rows[0];
  await query("INSERT INTO device_identities (device_identity,public_key,phone_number,user_id) VALUES ('m1b-device','m1b-key',$1,$2)", [phone, owner.id]);
  await query("INSERT INTO ledger_entries (device_identity,entry_id,entry_hash,prev_entry_hash,signature,confirmed_at,payload) VALUES ('m1b-device',1,'hash-before','0','sig-before',NOW(),'{\"kind\":\"historic\"}')");
  await query("INSERT INTO profiles (user_id,phone_number,name) VALUES ($1,$2,'Historical')", [owner.id, phone]);
  await query("INSERT INTO user_sessions (id,user_id,device_identity) VALUES ('00000000-0000-4000-8000-000000000220',$1,'m1b-device')", [owner.id]);
  await query("INSERT INTO otp_challenges (phone_number,identifier,channel,otp_hash,expires_at) VALUES ($1,'m1b@example.test','email','otp-before',NOW()+interval '1 hour')", [phone]);
  const envelope = buildAttestationEnvelope({ vt_id: "m1b-before-export", device_identity: "m1b-device", ledger_root_hash: "hash-before", entry_count: 1, window_start: new Date(Date.now() - 1000).toISOString(), window_end: new Date().toISOString(), issued_at: new Date().toISOString(), status: "VALID" });
  await query("INSERT INTO attestations (vt_id,device_identity,phone_number,user_id,ledger_root_hash,window_start,window_end,entry_count,server_signature,status,issued_at,signing_kid) VALUES ($1,'m1b-device',$2,$3,$4,$5,$6,$7,$8,'VALID',$9,$10)", [envelope.vt_id, phone, owner.id, envelope.ledger_root_hash, envelope.window_start, envelope.window_end, envelope.entry_count, envelope.server_signature, envelope.issued_at, envelope.signing_kid]);
  await query("INSERT INTO key_rotation_events (old_device_identity,new_device_identity,phone_number,user_id,rotation_receipt) VALUES ('m1b-device','m1b-next',$1,$2,'receipt-before')", [phone, owner.id]);
  await query("INSERT INTO payments (phone_number,user_id,device_identity,reference,amount_kobo,tier,window_days) VALUES ($1,$2,'m1b-device','m1b-payment',1,'basic',30)", [phone, owner.id]);
  await query("INSERT INTO rotation_challenges (phone_number,user_id,old_device_identity,challenge_nonce,expires_at) VALUES ($1,$2,'m1b-device','m1b-challenge',NOW()+interval '1 hour')", [phone, owner.id]);
  return { owner, envelope };
}

beforeEach(async () => {
  if (stage) {
    const previousStage = stage;
    stage = null;
    await previousStage.drop();
  }
  stage = await createStageDatabase(21, { databaseUrl: config.databaseUrl, databaseSsl: config.databaseSsl });
  await pre022();
});
after(async () => {
  Object.assign(config, originalAttestationConfig);
  if (stage) {
    const finalStage = stage;
    stage = null;
    await finalStage.drop();
  }
});

test("M1b real runner preserves populated M1a rows, all phone snapshots, and exports", async () => {
  config.serverAttestationPrivateKeyPem = historicalAttestationKey.export({ type: "pkcs8", format: "pem" }).toString();
  config.serverAttestationRetiredKeysRaw = "";
  config.serverAttestationRetiredKeys = [];
  let verifier;
  try {
    const { envelope } = await seed(); const before = await snapshot();
    verifier = await openHistoricalVerifier();
    const verifiedBefore = await verifier.verify(envelope.vt_id);
    assert.match((await run()).stdout, /022_account_id_primary_key/);
    const after = await snapshot();
    for (const table of snapshotTables) assert.deepEqual(after[table], before[table], table);
    const verifiedAfter = await verifier.verify(envelope.vt_id);
    assert.deepEqual(verifiedAfter, verifiedBefore, "historical verification response must survive the upgrade unchanged");
    assert.match((await run()).stdout, /No pending migrations/);
  } finally {
    const verifierToClose = verifier;
    verifier = null;
    if (verifierToClose) await verifierToClose.close();
  }
});

test("M1b refuses an unsafe migration boundary before connecting", async () => {
  const error = await runFile(process.execPath, ["migrate.js"], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: "postgresql://migration-cap.example.invalid/test_never_connect", MIGRATIONS_THROUGH: "21" }
  }).then(() => null, (value) => value);
  assert.ok(error); assert.notEqual(error.code, 0);
  assert.match(`${error.stdout}\n${error.stderr}`, /MIGRATIONS_THROUGH is permitted only for a local PostgreSQL database whose name contains 'test'/);
  assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, /ECONNREFUSED|ENOTFOUND|No pending migrations|Applied migration/);
});

test("M1b leaves an uncapped migration run unchanged", async () => {
  const { MIGRATIONS_THROUGH: ignoredBoundary, ...environment } = process.env;
  const output = await runFile(process.execPath, ["migrate.js"], {
    cwd: serverDir,
    env: { ...environment, DATABASE_URL: stage.url }
  });
  assert.match(output.stdout, /022_account_id_primary_key/);
  assert.doesNotMatch(output.stdout, /Migration boundary in force/);
});

test("M1b guards damaged users.id and M1a links without changing anything", async (t) => {
  const cases = [
    ["NULL users.id", /NULL or duplicate users\.id values/, async () => {
      // 021 normally makes id NOT NULL with a UUID default. Both are removed
      // only in this disposable stage DB so one historic row can have NULL id.
      await query("ALTER TABLE users ALTER COLUMN id DROP NOT NULL");
      await query("ALTER TABLE users ALTER COLUMN id DROP DEFAULT");
      await query("INSERT INTO users (id,phone_number) VALUES (NULL,'+15550000223')");
    }],
    ["duplicate users.id", /NULL or duplicate users\.id values/, async () => {
      // 021 child user_id FKs depend on idx_users_id_unique. Drop those
      // constraints and the index only in this disposable DB, then insert two
      // rows with the same UUID. They cannot be re-added, even NOT VALID,
      // until the duplicate is repaired because PostgreSQL requires a unique
      // referenced key when defining an FK.
      const foreignKeys = (await query("SELECT c.conrelid::regclass::text AS table_name,c.conname FROM pg_constraint c JOIN unnest(c.conkey) key(attnum) ON true JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=key.attnum WHERE c.contype='f' AND c.confrelid='users'::regclass AND a.attname='user_id' ORDER BY c.conrelid::regclass::text,c.conname")).rows;
      for (const foreignKey of foreignKeys) await query(`ALTER TABLE ${foreignKey.table_name} DROP CONSTRAINT ${foreignKey.conname}`);
      await query("DROP INDEX idx_users_id_unique");
      const duplicateId = "00000000-0000-4000-8000-000000000223";
      await query("INSERT INTO users (id,phone_number) VALUES ($1,'+15550000224'),($1,'+15550000225')", [duplicateId]);
    }],
    ["NULL", /NULL, orphaned, or phone-mismatched account links/, async () => {
      // Disable only M1a's repairing trigger so a damaged historic NULL can
      // exist; the FK allows NULL at stage 021.
      await query("ALTER TABLE device_identities DISABLE TRIGGER device_identities_account_id_link");
      try {
        await query("UPDATE device_identities SET user_id=NULL WHERE device_identity='m1b-device'");
      } finally {
        await query("ALTER TABLE device_identities ENABLE TRIGGER device_identities_account_id_link");
      }
    }],
    ["mismatch", /NULL, orphaned, or phone-mismatched account links/, async () => {
      const other = (await query("INSERT INTO users (phone_number) VALUES ('+15550000221') RETURNING id")).rows[0];
      await query("ALTER TABLE device_identities DISABLE TRIGGER device_identities_account_id_link");
      try {
        await query("UPDATE device_identities SET user_id=$1 WHERE device_identity='m1b-device'", [other.id]);
      } finally {
        await query("ALTER TABLE device_identities ENABLE TRIGGER device_identities_account_id_link");
      }
    }],
    ["orphan", /NULL, orphaned, or phone-mismatched account links/, async () => {
      // An orphan bypasses M1a's trigger, and its FK is removed to model a
      // damaged historic database.  M1a enforcement is restored before 022.
      await query("ALTER TABLE device_identities DROP CONSTRAINT device_identities_user_id_fkey");
      await query("ALTER TABLE device_identities DISABLE TRIGGER device_identities_account_id_link");
      try {
        await query("UPDATE device_identities SET user_id='00000000-0000-4000-8000-000000000221' WHERE device_identity='m1b-device'");
      } finally {
        await query("ALTER TABLE device_identities ENABLE TRIGGER device_identities_account_id_link");
      }
    }]
  ];
  for (const [label, guardMessage, corrupt] of cases) await t.test(label, async () => {
    if (stage) {
      const previousStage = stage;
      stage = null;
      await previousStage.drop();
    }
    stage = await createStageDatabase(21, { databaseUrl: config.databaseUrl, databaseSsl: config.databaseSsl });
    try {
      await seed(); await corrupt(); const before = await snapshot();
      const error = await run().then(() => null, (value) => value);
      assert.ok(error); assert.notEqual(error.code, 0); assert.match(`${error.stdout}\n${error.stderr}`, guardMessage);
      assert.deepEqual(await snapshot(), before);
    } finally {
      const damagedStage = stage;
      stage = null;
      await damagedStage.drop();
    }
  });
});

test("M1b catalog has only validated ID ownership links and nullable historical phones", async () => {
  await seed(); await run();
  assert.deepEqual((await query("SELECT a.attname FROM pg_constraint c JOIN unnest(c.conkey) k(attnum) ON true JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid='users'::regclass AND c.contype='p'")).rows.map((r) => r.attname), ["id"]);
  for (const table of tables) {
    const row = (await query("SELECT (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid=$1::regclass AND attname='user_id') nullable,(SELECT count(*)::int FROM pg_constraint c JOIN unnest(c.conkey) k(attnum) ON true JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid=$1::regclass AND c.contype='f' AND a.attname='user_id' AND c.confrelid='users'::regclass AND c.convalidated) fks,(SELECT NOT attnotnull FROM pg_attribute WHERE attrelid=$1::regclass AND attname='phone_number') phone_nullable,(SELECT count(*)::int FROM pg_constraint c JOIN unnest(c.conkey) k(attnum) ON true JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid=$1::regclass AND c.contype='f' AND a.attname='phone_number') phone_fks", [table])).rows[0];
    assert.deepEqual(row, { nullable: false, fks: 1, phone_nullable: true, phone_fks: 0 }, table);
  }
  assert.equal((await query("SELECT to_regprocedure('enforce_account_id_link()') AS fn")).rows[0].fn, null);
  await assert.rejects(query("INSERT INTO profiles (user_id) VALUES ('00000000-0000-4000-8000-000000000222')"));
  await assert.rejects(query("INSERT INTO device_identities (device_identity,public_key,user_id) VALUES ('bad-owner','key','00000000-0000-4000-8000-000000000222')"));
});

test("M1b fresh schema install matches the upgrade catalog and is idempotent", async () => {
  await seed();
  await run();
  const upgradeCatalog = (await query(`
    SELECT c.relname, a.attname, a.attnotnull, coalesce(pg_get_constraintdef(k.oid), '') AS definition
    FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_constraint k ON k.conrelid = c.oid AND a.attnum = ANY(k.conkey)
    WHERE c.relname = ANY($1::text[])
    ORDER BY c.relname, a.attname, definition
  `, [["users", ...tables]])).rows;
  const fresh = await createStageDatabase(22, {
    databaseUrl: config.databaseUrl,
    databaseSsl: config.databaseSsl,
    freshSchema: true
  });
  try {
    const freshCatalog = (await fresh.pool.query(`
      SELECT c.relname, a.attname, a.attnotnull, coalesce(pg_get_constraintdef(k.oid), '') AS definition
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      LEFT JOIN pg_constraint k ON k.conrelid = c.oid AND a.attnum = ANY(k.conkey)
      WHERE c.relname = ANY($1::text[])
      ORDER BY c.relname, a.attname, definition
    `, [["users", ...tables]])).rows;
    assert.deepEqual(freshCatalog, upgradeCatalog);
    assert.match((await fresh.runMigrations(22)).stdout, /No pending migrations/);
  } finally {
    await fresh.drop();
  }
});

test("M1b keeps a historical phone difference informational in the diagnostic", async () => {
  const { owner } = await seed(); await run();
  await query("UPDATE device_identities SET phone_number='+15550000999' WHERE device_identity='m1b-device'");
  assert.equal((await query("SELECT user_id FROM device_identities WHERE device_identity='m1b-device'")).rows[0].user_id, owner.id);
  const output = await runFile(process.execPath, ["scripts/check-account-id-links.js"], { cwd: serverDir, env: { ...process.env, DATABASE_URL: stage.url } });
  assert.match(output.stdout, /stage=post-022/); assert.match(output.stdout, /phone_difference=1 \(informational\)/);
  assert.doesNotMatch(output.stdout, /15550000999|[0-9a-f]{8}-[0-9a-f]{4}-/i);
});

test("account-id diagnostic gates pre-022 violations without disclosing phones or IDs", async () => {
  await seed();
  const clean = await runFile(process.execPath, ["scripts/check-account-id-links.js"], { cwd: serverDir, env: { ...process.env, DATABASE_URL: stage.url } });
  assert.match(clean.stdout, /stage=pre-022/);
  await query("ALTER TABLE device_identities DISABLE TRIGGER device_identities_account_id_link");
  try {
    await query("UPDATE device_identities SET user_id=NULL WHERE device_identity='m1b-device'");
  } finally {
    await query("ALTER TABLE device_identities ENABLE TRIGGER device_identities_account_id_link");
  }
  const failure = await runFile(process.execPath, ["scripts/check-account-id-links.js"], { cwd: serverDir, env: { ...process.env, DATABASE_URL: stage.url } }).then(() => null, (error) => error);
  assert.ok(failure); assert.notEqual(failure.code, 0); assert.match(failure.stdout, /null_user_id=1/);
  assert.doesNotMatch(`${failure.stdout}\n${failure.stderr}`, /15550000220|[0-9a-f]{8}-[0-9a-f]{4}-/i);
});
