import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { config, parseServerAttestationRetiredKeys } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { issueAuthToken } from "../src/auth-utils.js";
import {
  ATTESTATION_SCOPE,
  ATTESTATION_SCOPE_DESCRIPTION,
  buildAttestationEnvelope,
  buildAttestationPayload,
  getVerificationKeyKid,
  signAttestationPayload
} from "../src/attestation-signing.js";
import { registerAttestRoutes } from "../src/routes/attest.js";
import { registerPaymentRoutes } from "../src/routes/payment.js";
import { auditAttestationKeys } from "../scripts/audit-attestation-keys.mjs";
import { assertLocalTestDatabase } from "./helpers/db.js";

assertLocalTestDatabase(config.databaseUrl);

const execFileAsync = promisify(execFile);
const originalConfig = { ...config };
const app = Fastify({ logger: false });

function keyPairPem() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

const keyA = keyPairPem();
const keyB = keyPairPem();
const kidA = getVerificationKeyKid(keyA.publicPem);
const kidB = getVerificationKeyKid(keyB.publicPem);

function retiredRaw(retiredAt) {
  return JSON.stringify([{
    public_key_spki_pem: keyA.publicPem,
    retired_at: new Date(retiredAt).toISOString()
  }]);
}

function useRing(activePrivatePem, retired = "") {
  config.nodeEnv = "test";
  config.serverAttestationPrivateKeyPem = activePrivatePem;
  config.serverAttestationRetiredKeysRaw = retired;
  config.serverAttestationRetiredKeys = parseServerAttestationRetiredKeys(retired, {
    activePrivateKeyPem: activePrivatePem
  });
}

async function applySchemaBefore018() {
  await query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
  const migrationsDirectory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+.*\.sql$/.test(name) && name < "018_attestation_signing_kid.sql")
    .sort();
  for (const name of names) {
    await query(await readFile(new URL(name, migrationsDirectory), "utf8"));
  }
  await query("ALTER TABLE attestations ADD COLUMN IF NOT EXISTS attestation_scope TEXT");
  await query("ALTER TABLE attestations ADD COLUMN IF NOT EXISTS scope_description TEXT");
  await query("ALTER TABLE attestations DROP COLUMN IF EXISTS signing_kid");
}

async function resetDatabase() {
  await query(`
    TRUNCATE payments, attestations, ledger_entries, key_rotation_events,
      user_sessions, device_identities, profiles, users RESTART IDENTITY CASCADE
  `);
}

async function seedAccount() {
  const suffix = crypto.randomBytes(5).toString("hex");
  const phone = `+1202${crypto.randomInt(1_000_000, 9_999_999)}`;
  const email = `rotation-${suffix}@example.test`;
  const deviceIdentity = `rotation-device-${suffix}`;
  const user = (await query(
    `INSERT INTO users (phone_number, email, email_verified) VALUES ($1, $2, TRUE) RETURNING id`,
    [phone, email]
  )).rows[0];
  await query(
    `INSERT INTO device_identities (device_identity, public_key, phone_number, status)
     VALUES ($1, 'test-device-public-key', $2, 'ACTIVE')`,
    [deviceIdentity, phone]
  );
  const confirmedAt = new Date(Date.now() - 60_000);
  await query(
    `INSERT INTO ledger_entries
       (device_identity, entry_id, entry_hash, prev_entry_hash, signature, confirmed_at, payload)
     VALUES ($1, 1, $2, $3, 'device-signature', $4, $5::jsonb)`,
    [deviceIdentity, crypto.randomBytes(32).toString("hex"), "0".repeat(64), confirmedAt,
      JSON.stringify({ amount_minor: 12500, currency: "NGN", type: "sale" })]
  );
  const sessionId = crypto.randomUUID();
  await query(
    `INSERT INTO user_sessions (id, user_id, device_identity, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [sessionId, user.id, deviceIdentity]
  );
  const token = issueAuthToken(phone, deviceIdentity, { sid: sessionId });
  return {
    phone,
    deviceIdentity,
    headers: {
      authorization: `Bearer ${token}`,
      "x-device-identity": deviceIdentity
    }
  };
}

async function issueThroughAttest(account) {
  const response = await app.inject({
    method: "POST",
    url: "/attest",
    headers: account.headers,
    payload: { device_identity: account.deviceIdentity, window_days: 0 }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function verify(vtId) {
  const response = await app.inject({ method: "GET", url: `/verify/${vtId}` });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

function makeFields(account, { vtId = `rotation-${crypto.randomUUID()}`, issuedAt = new Date() } = {}) {
  return {
    vt_id: vtId,
    device_identity: account.deviceIdentity,
    ledger_root_hash: `sha256:${crypto.randomBytes(32).toString("hex")}`,
    entry_count: 1,
    window_start: new Date(new Date(issuedAt).getTime() - 60_000),
    window_end: new Date(issuedAt),
    issued_at: new Date(issuedAt),
    status: "VALID",
    attestation_scope: ATTESTATION_SCOPE,
    scope_description: ATTESTATION_SCOPE_DESCRIPTION
  };
}

async function insertEnvelope(account, envelope, signingKid = envelope.signing_kid) {
  await query(
    `INSERT INTO attestations
       (vt_id, device_identity, phone_number, ledger_root_hash, window_start, window_end,
        entry_count, server_signature, status, issued_at, attestation_scope, scope_description, signing_kid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [envelope.vt_id, account.deviceIdentity, account.phone, envelope.ledger_root_hash,
      envelope.window_start, envelope.window_end, envelope.entry_count, envelope.server_signature,
      envelope.status, envelope.issued_at, envelope.attestation_scope, envelope.scope_description, signingKid]
  );
}

function signatureVerifies(publicPem, payload, signature) {
  return crypto.verify("sha256", Buffer.from(payload, "utf8"), {
    key: publicPem,
    dsaEncoding: "ieee-p1363"
  }, Buffer.from(signature, "base64"));
}

async function historyFingerprint() {
  const result = await query(`
    SELECT
      (SELECT md5(COALESCE(string_agg(row_to_json(l)::text, '|' ORDER BY device_identity, entry_id), ''))
       FROM ledger_entries l) AS ledger,
      (SELECT md5(COALESCE(string_agg(
        jsonb_build_object(
          'vt_id', a.vt_id, 'device_identity', a.device_identity, 'phone_number', a.phone_number,
          'ledger_root_hash', a.ledger_root_hash, 'window_start', a.window_start,
          'window_end', a.window_end, 'entry_count', a.entry_count,
          'server_signature', a.server_signature, 'status', a.status, 'issued_at', a.issued_at,
          'attestation_scope', a.attestation_scope, 'scope_description', a.scope_description
        )::text, '|' ORDER BY a.vt_id), '')) FROM attestations a) AS attestations,
      (SELECT md5(COALESCE(string_agg(row_to_json(p)::text, '|' ORDER BY id), ''))
       FROM payments p) AS payments
  `);
  return result.rows[0];
}

before(async () => {
  config.jwtSecret = config.jwtSecret || "attestation-rotation-route-test-secret";
  config.serverReceiptSecret = config.serverReceiptSecret || "attestation-route-receipt-secret";
  config.resendApiKey = "";
  config.allowDevOtp = true;
  await applySchemaBefore018();
  await app.register(rateLimit, { global: false });
  await registerAttestRoutes(app);
  await registerPaymentRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  await resetDatabase();
  useRing(keyA.privatePem);
});

after(async () => {
  try {
    await query(await readFile(new URL("../migrations/018_attestation_signing_kid.sql", import.meta.url), "utf8"));
    await resetDatabase();
  } finally {
    Object.assign(config, originalConfig);
    await app.close();
    await getPool().end();
  }
});

test("R7: migration 018 follows 017, reruns safely, and does not rewrite historical rows", async () => {
  const sectorColumn = await query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'profiles' AND column_name = 'sector_source'
  `);
  assert.equal(sectorColumn.rowCount, 1, "migration 017 shape must exist first");
  const account = await seedAccount();
  await query(
    `INSERT INTO attestations
       (vt_id, device_identity, phone_number, ledger_root_hash, window_start, window_end,
        entry_count, server_signature, status, issued_at, attestation_scope, scope_description)
     VALUES ('migration-history-vt', $1, $2, 'history-root', NOW() - INTERVAL '1 day', NOW(),
       1, 'history-signature', 'VALID', NOW(), $3, $4)`,
    [account.deviceIdentity, account.phone, ATTESTATION_SCOPE, ATTESTATION_SCOPE_DESCRIPTION]
  );
  await query(
    `INSERT INTO payments
       (phone_number, device_identity, reference, amount_kobo, tier, window_days, paystack_status, vt_id)
     VALUES ($1, $2, 'migration-history-payment', 1000, 'free', 0, 'success', 'migration-history-vt')`,
    [account.phone, account.deviceIdentity]
  );
  const beforeFingerprint = await historyFingerprint();
  const migrationSql = await readFile(new URL("../migrations/018_attestation_signing_kid.sql", import.meta.url), "utf8");
  await query(migrationSql);
  assert.deepEqual(await historyFingerprint(), beforeFingerprint);
  assert.equal((await query("SELECT signing_kid FROM attestations WHERE vt_id = 'migration-history-vt'")).rows[0].signing_kid, null);
  await query(migrationSql);
  assert.deepEqual(await historyFingerprint(), beforeFingerprint);
});

test("R1: legacy NULL-kid rows remain valid and new /attest rows store the active kid", async () => {
  const account = await seedAccount();
  const oldEnvelope = buildAttestationEnvelope(makeFields(account, { vtId: "legacy-no-rotation" }));
  await insertEnvelope(account, oldEnvelope, null);
  const legacy = await verify(oldEnvelope.vt_id);
  assert.equal(legacy.status, "VALID");
  assert.equal(legacy.verification_key_kid, kidA);
  assert.equal(legacy.verification_key_status, "active");

  const issued = await issueThroughAttest(account);
  const stored = (await query("SELECT signing_kid FROM attestations WHERE vt_id = $1", [issued.vt_id])).rows[0];
  assert.equal(stored.signing_kid, kidA);
  assert.equal((await verify(issued.vt_id)).status, "VALID");
});

test("R2: an A-signed historical row survives rotation with a future and later a past deadline", async () => {
  const account = await seedAccount();
  const issuedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const envelope = buildAttestationEnvelope(makeFields(account, { vtId: "historical-a", issuedAt }));
  await insertEnvelope(account, envelope, kidA);

  const futureDeadline = new Date(Date.now() + 30 * 60 * 1000);
  useRing(keyB.privatePem, retiredRaw(futureDeadline));
  let result = await verify(envelope.vt_id);
  assert.deepEqual([result.status, result.verification_key_kid, result.verification_key_status], ["VALID", kidA, "retired"]);

  await query("UPDATE attestations SET signing_kid = NULL WHERE vt_id = $1", [envelope.vt_id]);
  result = await verify(envelope.vt_id);
  assert.deepEqual([result.status, result.verification_key_kid, result.verification_key_status], ["VALID", kidA, "retired"]);

  const pastDeadline = new Date(Date.now() - 60 * 60 * 1000);
  useRing(keyB.privatePem, retiredRaw(pastDeadline));
  result = await verify(envelope.vt_id);
  assert.deepEqual([result.status, result.verification_key_kid, result.verification_key_status], ["VALID", kidA, "retired"]);

  await query("UPDATE attestations SET signing_kid = $2 WHERE vt_id = $1", [envelope.vt_id, kidA]);
  assert.equal((await verify(envelope.vt_id)).status, "VALID");
});

test("R3: /attest and /report/generate-pdf use B after rotation and do not produce A signatures", async () => {
  const account = await seedAccount();
  useRing(keyB.privatePem, retiredRaw(new Date(Date.now() + 30 * 60 * 1000)));

  const issued = await issueThroughAttest(account);
  const reportResponse = await app.inject({
    method: "POST",
    url: "/report/generate-pdf",
    headers: account.headers,
    payload: { window_days: 0 }
  });
  assert.equal(reportResponse.statusCode, 200, reportResponse.body);
  const reportVtId = reportResponse.json().vt_id;
  const rows = (await query(
    "SELECT * FROM attestations WHERE vt_id = ANY($1::text[]) ORDER BY vt_id",
    [[issued.vt_id, reportVtId]]
  )).rows;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.signing_kid, kidB);
    const rebuilt = buildAttestationPayload({
      vt_id: row.vt_id,
      device_fingerprint: row.device_identity.substring(0, 8),
      ledger_root_hash: row.ledger_root_hash,
      entry_count: row.entry_count,
      window_start: row.window_start,
      window_end: row.window_end,
      issued_at: row.issued_at,
      status: row.status,
      attestation_scope: row.attestation_scope || ATTESTATION_SCOPE,
      scope_description: row.scope_description || ATTESTATION_SCOPE_DESCRIPTION
    });
    assert.equal(signatureVerifies(keyA.publicPem, rebuilt, row.server_signature), false);
    const verification = await verify(row.vt_id);
    assert.deepEqual([verification.status, verification.verification_key_kid], ["VALID", kidB]);
  }
});

test("R4: a recovered A key cannot authorize rows stored at or after its deadline", async () => {
  const account = await seedAccount();
  const deadline = new Date(Date.now() + 30 * 60 * 1000);
  for (const [suffix, signingKid, offset] of [["equal", kidA, 0], ["legacy-after", null, 1]]) {
    useRing(keyA.privatePem);
    const envelope = buildAttestationEnvelope(makeFields(account, {
      vtId: `recovered-a-${suffix}`,
      issuedAt: new Date(deadline.getTime() + offset)
    }));
    await insertEnvelope(account, envelope, signingKid);
  }
  useRing(keyB.privatePem, retiredRaw(deadline));
  assert.equal((await verify("recovered-a-equal")).status, "INVALID");
  assert.equal((await verify("recovered-a-legacy-after")).status, "INVALID");
});

test("R5: stored-content changes invalidate a signature and invented ids remain UNKNOWN", async () => {
  const account = await seedAccount();
  const issued = await issueThroughAttest(account);
  assert.equal((await verify(issued.vt_id)).status, "VALID");
  await query("UPDATE attestations SET entry_count = entry_count + 1 WHERE vt_id = $1", [issued.vt_id]);
  assert.equal((await verify(issued.vt_id)).status, "INVALID");
  assert.deepEqual(await verify("invented-rotation-vt"), { status: "UNKNOWN" });
});

test("R6: overlap audit counts A-signed NULL-kid rows and changes no database rows", async () => {
  const account = await seedAccount();
  const deadline = new Date(Date.now() + 30 * 60 * 1000);
  const fixtures = [
    ["audit-a-null-before", new Date(deadline.getTime() - 60_000), null, keyA.privatePem],
    ["audit-a-kid-before", new Date(deadline.getTime() - 30_000), kidA, keyA.privatePem],
    ["audit-a-null-after", new Date(deadline.getTime() + 1), null, keyA.privatePem],
    ["audit-b", new Date(deadline.getTime() + 2), kidB, keyB.privatePem]
  ];
  for (const [vtId, issuedAt, signingKid, privatePem] of fixtures) {
    useRing(privatePem);
    await insertEnvelope(account, buildAttestationEnvelope(makeFields(account, { vtId, issuedAt })), signingKid);
  }
  const beforeFingerprint = await historyFingerprint();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "attestation-audit-test-"));
  const publicKeyFile = path.join(temporaryDirectory, "retired-public.pem");
  await writeFile(publicKeyFile, keyA.publicPem, { mode: 0o600 });
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["scripts/audit-attestation-keys.mjs", "--retired-key-file", publicKeyFile, "--deadline", deadline.toISOString()],
      {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          DATABASE_URL: config.databaseUrl,
          DATABASE_SSL: String(config.databaseSsl),
          SERVER_ATTESTATION_PRIVATE_KEY_PEM: keyB.privatePem,
          SERVER_ATTESTATION_RETIRED_KEYS: retiredRaw(deadline)
        }
      }
    );
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), {
      retired_before_deadline: 2,
      retired_at_or_after_deadline: 1,
      active: 1,
      verified_by_neither: 0
    });
    for (const forbidden of fixtures.flatMap(([vtId]) => [vtId, account.phone])) {
      assert.equal(stdout.includes(forbidden), false);
    }
    for (const row of (await query("SELECT server_signature FROM attestations")).rows) {
      assert.equal(stdout.includes(row.server_signature), false);
    }
    assert.deepEqual(await historyFingerprint(), beforeFingerprint);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("R6b: overlap audit recognizes a supplied retired key outside the configured ring", async () => {
  const account = await seedAccount();
  const deadline = new Date(Date.now() + 30 * 60 * 1000);
  const fixtures = [
    ["audit-unconfigured-a-before", new Date(deadline.getTime() - 60_000), keyA.privatePem],
    ["audit-unconfigured-a-after", new Date(deadline.getTime() + 1), keyA.privatePem],
    ["audit-unconfigured-b", new Date(deadline.getTime() + 2), keyB.privatePem]
  ];
  for (const [vtId, issuedAt, privatePem] of fixtures) {
    useRing(privatePem);
    await insertEnvelope(account, buildAttestationEnvelope(makeFields(account, { vtId, issuedAt })), null);
  }
  useRing(keyB.privatePem);

  assert.deepEqual(await auditAttestationKeys({
    pool: getPool(),
    retiredPublicKeyPem: keyA.publicPem,
    deadline
  }), {
    retired_before_deadline: 1,
    retired_at_or_after_deadline: 1,
    active: 1,
    verified_by_neither: 0
  });
});
