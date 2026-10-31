import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../src/config.js";
import { buildAttestationEnvelope } from "../src/attestation-signing.js";
import { getPool } from "../src/db.js";
import { computeLedgerEntryHash } from "../src/ledger-canonical.js";
import { registerAccountRoutes } from "../src/routes/account.js";
import { registerAttestRoutes } from "../src/routes/attest.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerIdentityRoutes } from "../src/routes/identity.js";
import { registerSyncRoutes } from "../src/routes/sync.js";
import { assertLocalTestDatabase, createTestPool, resetTestDatabase } from "./helpers/db.js";

assertLocalTestDatabase(config.databaseUrl);
const appPool = getPool();
const database = createTestPool(config.databaseUrl, config.databaseSsl);
const app = Fastify({ logger: false });
const migrationSql = await readFile(new URL("../migrations/021_account_id_links.sql", import.meta.url), "utf8");

config.allowDevOtp = true;
config.resendApiKey = "";
config.jwtSecret = config.jwtSecret || "account-id-auth-test-secret";
config.serverReceiptSecret = config.serverReceiptSecret || "account-id-auth-receipt-secret";

// This suite verifies the full issue/store/verify round trip, so it must not
// rely on a process-local development key.
const originalAttestationConfig = {
  serverAttestationPrivateKeyPem: config.serverAttestationPrivateKeyPem,
  serverAttestationRetiredKeysRaw: config.serverAttestationRetiredKeysRaw,
  serverAttestationRetiredKeys: config.serverAttestationRetiredKeys
};
const { privateKey: attestationPrivateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
config.serverAttestationPrivateKeyPem = attestationPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();
config.serverAttestationRetiredKeysRaw = "";
config.serverAttestationRetiredKeys = [];

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function headers(token, deviceIdentity) {
  return { authorization: `Bearer ${token}`, ...(deviceIdentity ? { "x-device-identity": deviceIdentity } : {}) };
}

async function signIn({ phone, deviceIdentity, email = `${unique("account")}@example.test`, publicKey = `key-${deviceIdentity}` }) {
  const requested = await app.inject({ method: "POST", url: "/auth/otp/request", payload: { channel: "email", email, phone_number: phone } });
  assert.equal(requested.statusCode, 200, requested.body);
  const response = await app.inject({
    method: "POST", url: "/auth/otp/verify",
    payload: { channel: "email", email, phone_number: phone, code: requested.json().dev_code, device_identity: deviceIdentity, public_key: publicKey }
  });
  assert.equal(response.statusCode, 200, response.body);
  return { phone, email, deviceIdentity, publicKey, ...response.json() };
}

function tokenFor(signedIn, claims = {}, expiresIn = "30d") {
  return jwt.sign({ phone_number: signedIn.phone, sid: jwt.decode(signedIn.auth_token).sid, ...claims }, config.jwtSecret, { expiresIn });
}

async function sessionCount() {
  return Number((await database.query("SELECT COUNT(*)::int AS count FROM user_sessions")).rows[0].count);
}

function deviceKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, publicKey: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }) };
}

function signedEntry(deviceIdentity, privateKey) {
  const entry = {
    id: 1, transaction_type: "sale", label: "Legacy sale", normalized_label: `legacy-${deviceIdentity}`,
    amount_minor: 100, currency: "NGN", counterparty: null, business_type_id: "ng_market_trader",
    country: "NG", sector_id: "trade_retail", confirmed_at: 1793000001,
    prev_entry_hash: "0".repeat(64)
  };
  entry.entry_hash = computeLedgerEntryHash(entry);
  entry.signature = crypto.sign("sha256", Buffer.from(entry.entry_hash, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  return entry;
}

before(async () => {
  // This suite intentionally runs on the post-021 shape even when invoked alone.
  await database.query(migrationSql);
  await registerAuthRoutes(app);
  await registerAccountRoutes(app);
  await registerSyncRoutes(app);
  await registerAttestRoutes(app);
  await registerIdentityRoutes(app);
  await app.ready();
});

beforeEach(async () => resetTestDatabase(database));

after(async () => {
  try {
    await app.close();
    await appPool.end();
    await database.end();
  } finally {
    Object.assign(config, originalAttestationConfig);
  }
});

test("M1a auth matrix accepts account and legacy tokens, but preserves every session boundary", async () => {
  const signedIn = await signIn({ phone: "+12025550301", deviceIdentity: "m1a-auth-device" });
  const accountId = signedIn.account_id;
  const legacy = tokenFor(signedIn, { phone_number: "+12025559999" });
  const originalExpiry = jwt.decode(legacy).exp;
  const sessionsBefore = await sessionCount();
  const saved = await app.inject({ method: "POST", url: "/profile", headers: headers(signedIn.auth_token, signedIn.deviceIdentity), payload: {} });
  assert.equal(saved.statusCode, 200, saved.body);

  for (const token of [signedIn.auth_token, legacy]) {
    const response = await app.inject({ method: "GET", url: "/profile", headers: headers(token, signedIn.deviceIdentity) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().account_id, accountId);
    assert.equal(response.json().profile.phone, signedIn.phone, "database phone must replace a stale claim");
  }
  assert.equal(jwt.decode(legacy).exp, originalExpiry, "requests must not refresh a legacy token");
  assert.equal(await sessionCount(), sessionsBefore, "requests must not create sessions");

  const invalidCases = [
    [tokenFor(signedIn, { account_id: crypto.randomUUID() }), signedIn.deviceIdentity],
    [tokenFor(signedIn, {}, -1), signedIn.deviceIdentity],
    [signedIn.auth_token, "wrong-device-header"]
  ];
  await database.query("UPDATE device_identities SET revoked_at = NOW() WHERE device_identity = $1", [signedIn.deviceIdentity]);
  invalidCases.push([signedIn.auth_token, signedIn.deviceIdentity]);
  for (const [token, deviceIdentity] of invalidCases) {
    const response = await app.inject({ method: "GET", url: "/profile", headers: headers(token, deviceIdentity) });
    assert.equal(response.statusCode, 401, response.body);
  }
  await database.query("UPDATE device_identities SET revoked_at = NULL WHERE device_identity = $1", [signedIn.deviceIdentity]);
  await database.query("UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1", [jwt.decode(signedIn.auth_token).sid]);
  const revoked = await app.inject({ method: "GET", url: "/profile", headers: headers(signedIn.auth_token, signedIn.deviceIdentity) });
  assert.equal(revoked.statusCode, 401, revoked.body);
});

test("M1a registerDevice cannot transfer an existing device or reset its state", async () => {
  const first = await signIn({ phone: "+12025550302", deviceIdentity: "m1a-shared-device", publicKey: "original-key" });
  await database.query("UPDATE device_identities SET status = 'FORKED', revoked_at = NOW() WHERE device_identity = $1", [first.deviceIdentity]);
  const secondEmail = `${unique("second-account")}@example.test`;
  const requested = await app.inject({ method: "POST", url: "/auth/otp/request", payload: { channel: "email", email: secondEmail, phone_number: "+12025550303" } });
  const refused = await app.inject({
    method: "POST", url: "/auth/otp/verify",
    payload: { channel: "email", email: secondEmail, phone_number: "+12025550303", code: requested.json().dev_code, device_identity: first.deviceIdentity, public_key: "replacement-key" }
  });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.deepEqual((await database.query("SELECT public_key, status, revoked_at IS NOT NULL AS revoked FROM device_identities WHERE device_identity = $1", [first.deviceIdentity])).rows[0], {
    public_key: "original-key", status: "FORKED", revoked: true
  });
});

test("M1a logout accepts stale legacy and account tokens without a device header, but refuses an account mismatch", async () => {
  const first = await signIn({ phone: "+12025550304", deviceIdentity: "m1a-logout-one" });
  const second = await signIn({ phone: first.phone, email: first.email, deviceIdentity: "m1a-logout-two" });
  for (const claims of [{ phone_number: "+12025559998" }, { phone_number: "+12025559997", account_id: first.account_id }]) {
    const token = tokenFor(first, claims);
    const response = await app.inject({ method: "POST", url: "/auth/logout", headers: headers(token) });
    assert.equal(response.statusCode, 204, response.body);
  }
  const firstSession = (await database.query("SELECT revoked_at FROM user_sessions WHERE id = $1", [jwt.decode(first.auth_token).sid])).rows[0];
  const secondSession = (await database.query("SELECT revoked_at FROM user_sessions WHERE id = $1", [jwt.decode(second.auth_token).sid])).rows[0];
  assert.ok(firstSession.revoked_at);
  assert.equal(secondSession.revoked_at, null);
  const mismatch = await app.inject({ method: "POST", url: "/auth/logout", headers: headers(tokenFor(second, { account_id: crypto.randomUUID() })) });
  assert.equal(mismatch.statusCode, 401, mismatch.body);
  assert.equal((await database.query("SELECT revoked_at FROM user_sessions WHERE id = $1", [jwt.decode(second.auth_token).sid])).rows[0].revoked_at, null);
});

test("M1a ownership checks refuse another account's device for sync and attest", async () => {
  const owner = await signIn({ phone: "+12025550305", deviceIdentity: "m1a-owner-device" });
  const other = await signIn({ phone: "+12025550306", deviceIdentity: "m1a-other-device" });
  const sync = await app.inject({ method: "POST", url: "/sync/entries", headers: headers(other.auth_token, other.deviceIdentity), payload: { device_identity: owner.deviceIdentity, entries: [{}] } });
  assert.equal(sync.statusCode, 403, sync.body);
  const attest = await app.inject({ method: "POST", url: "/attest", headers: headers(other.auth_token, other.deviceIdentity), payload: { device_identity: owner.deviceIdentity, window_days: 0 } });
  assert.equal(attest.statusCode, 403, attest.body);
});

test("M1a current-app request shapes still sign in, sync, attest, records, profile, and logout with account and legacy tokens", async () => {
  for (const [label, phone, tokenForRequest] of [
    ["account", "+12025550307", (signedIn) => signedIn.auth_token],
    ["legacy", "+12025550308", (signedIn) => tokenFor(signedIn)]
  ]) {
    const keys = deviceKeys();
    const signedIn = await signIn({ phone, deviceIdentity: `m1a-${label}-app-device`, publicKey: keys.publicKey });
    const token = tokenForRequest(signedIn);
    const auth = headers(token, signedIn.deviceIdentity);
    const sync = await app.inject({ method: "POST", url: "/sync/entries", headers: auth, payload: { device_identity: signedIn.deviceIdentity, entries: [signedEntry(signedIn.deviceIdentity, keys.privateKey)] } });
    assert.equal(sync.statusCode, 200, `${label}: ${sync.body}`);
    const attest = await app.inject({ method: "POST", url: "/attest", headers: auth, payload: { device_identity: signedIn.deviceIdentity, window_days: 0 } });
    assert.equal(attest.statusCode, 200, `${label}: ${attest.body}`);
    const issuedAttestation = attest.json();
    assert.deepEqual(
      (await database.query(
        "SELECT status, server_signature, user_id FROM attestations WHERE vt_id = $1",
        [issuedAttestation.vt_id]
      )).rows[0],
      {
        status: "VALID",
        server_signature: issuedAttestation.server_signature,
        user_id: signedIn.account_id
      },
      `${label}: stored attestation must retain its signature, valid status, and account owner`
    );
    for (const url of ["/records", "/profile"]) {
      const response = await app.inject({ method: "GET", url, headers: auth });
      assert.equal(response.statusCode, 200, `${label}: ${response.body}`);
    }
    const verified = await app.inject({ method: "GET", url: `/verify/${issuedAttestation.vt_id}` });
    assert.equal(verified.statusCode, 200, `${label}: ${verified.body}`);
    assert.equal(verified.json().status, "VALID");
    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: headers(token) });
    assert.equal(logout.statusCode, 204, `${label}: ${logout.body}`);
  }
});

test("M1a post-migration triggers link the exact phone-only writes from the pre-M1a server", async () => {
  const phone = "+12025550309";
  const initial = await signIn({ phone, deviceIdentity: "m1a-old-write-session-device" });
  const legacyKeys = deviceKeys();
  const legacyDevice = "m1a-old-write-device";
  const legacyAttestation = "m1a-old-write-attestation";
  const legacyChallenge = "m1a-old-write-challenge";
  const legacyEnvelope = buildAttestationEnvelope({
    vt_id: legacyAttestation,
    device_identity: legacyDevice,
    ledger_root_hash: "old-write-hash",
    entry_count: 1,
    window_start: new Date(Date.now() - 60_000).toISOString(),
    window_end: new Date().toISOString(),
    issued_at: new Date().toISOString(),
    status: "VALID"
  });

  // ca4c7dd server/src/routes/auth.js:226-238 (registerDevice INSERT).
  await database.query(
    "INSERT INTO device_identities (device_identity, public_key, phone_number, status, last_seen_at) VALUES ($1, $2, $3, 'ACTIVE', NOW())",
    [legacyDevice, legacyKeys.publicKey, phone]
  );
  // ca4c7dd server/src/routes/auth.js:215-222 (registerDevice last_seen refresh).
  await database.query(
    "UPDATE device_identities SET last_seen_at = NOW(), updated_at = NOW() WHERE device_identity = $1",
    [legacyDevice]
  );
  // ca4c7dd server/src/routes/attest.js:100-117.
  await database.query(
    "INSERT INTO attestations (vt_id, device_identity, phone_number, ledger_root_hash, window_start, window_end, entry_count, server_signature, status, issued_at, signing_kid) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    [
      legacyEnvelope.vt_id,
      legacyEnvelope.device_identity,
      phone,
      legacyEnvelope.ledger_root_hash,
      legacyEnvelope.window_start,
      legacyEnvelope.window_end,
      legacyEnvelope.entry_count,
      legacyEnvelope.server_signature,
      legacyEnvelope.status,
      legacyEnvelope.issued_at,
      legacyEnvelope.signing_kid
    ]
  );
  // ca4c7dd server/src/routes/identity.js:164-176.
  await database.query(
    "INSERT INTO key_rotation_events (old_device_identity, new_device_identity, phone_number, otp_verified_at, rotation_receipt) VALUES ($1, $2, $3, NOW(), 'old-write-receipt')",
    [legacyDevice, "m1a-old-write-next-device", phone]
  );
  // ca4c7dd server/src/routes/identity.js:35-41.
  await database.query(
    "INSERT INTO rotation_challenges (phone_number, old_device_identity, challenge_nonce, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')",
    [phone, legacyDevice, legacyChallenge]
  );

  const linkedRows = await database.query(
    `SELECT 'device' AS kind, user_id FROM device_identities WHERE device_identity = $1
     UNION ALL SELECT 'attestation', user_id FROM attestations WHERE vt_id = $2
     UNION ALL SELECT 'rotation', user_id FROM key_rotation_events WHERE rotation_receipt = 'old-write-receipt'
     UNION ALL SELECT 'challenge', user_id FROM rotation_challenges WHERE challenge_nonce = $3
     ORDER BY kind`,
    [legacyDevice, legacyAttestation, legacyChallenge]
  );
  assert.deepEqual(linkedRows.rows.map((row) => row.user_id), Array(4).fill(initial.account_id));

  const legacySession = await signIn({ phone, email: initial.email, deviceIdentity: legacyDevice, publicKey: legacyKeys.publicKey });
  const auth = headers(legacySession.auth_token, legacyDevice);
  const devices = await app.inject({ method: "GET", url: "/devices", headers: auth });
  assert.equal(devices.statusCode, 200, devices.body);
  assert.ok(devices.json().devices.some((device) => device.device_identity === legacyDevice));
  const ownerChecked = await app.inject({ method: "POST", url: "/attest", headers: auth, payload: { device_identity: legacyDevice, window_days: 0 } });
  assert.equal(ownerChecked.statusCode, 400, ownerChecked.body);
  assert.equal(ownerChecked.json().error, "No entries in this window.");
  const verified = await app.inject({ method: "GET", url: `/verify/${legacyAttestation}` });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().key_rotation_events, 1);
  const challenge = await app.inject({ method: "POST", url: "/identity/rotate/challenge", headers: auth, payload: { old_device_identity: legacyDevice } });
  assert.equal(challenge.statusCode, 200, challenge.body);
  assert.equal((await database.query("SELECT user_id FROM rotation_challenges WHERE challenge_nonce = $1", [challenge.json().challenge_nonce])).rows[0].user_id, initial.account_id);
});
