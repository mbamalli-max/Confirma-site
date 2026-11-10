import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { getPool } from "../src/db.js";
import { computeLedgerEntryHash } from "../src/ledger-canonical.js";
import { registerAccountRoutes } from "../src/routes/account.js";
import { registerAdminClassificationRoutes } from "../src/routes/admin/classification.js";
import { registerAttestRoutes } from "../src/routes/attest.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerIdentityRoutes } from "../src/routes/identity.js";
import { recoveryPartSha256, registerRecoveryRoutes } from "../src/routes/recovery.js";
import { registerSyncRoutes } from "../src/routes/sync.js";
import { createSession, seedAdmin } from "./helpers/admin.js";
import { assertLocalTestDatabase, createTestPool, resetTestDatabase } from "./helpers/db.js";
import { createRecovery, recoveryPartDeclaration, uploadRecoveryParts } from "./helpers/recovery.js";

assertLocalTestDatabase(config.databaseUrl);
const database = createTestPool(config.databaseUrl, config.databaseSsl);
let app; const codes = [];

function keys() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  return { privateKey: pair.privateKey, publicKey: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }) };
}
function headers(token, device) { return { authorization: `Bearer ${token}`, "x-device-identity": device }; }
function entry(device, fields = {}) {
  const value = {
    id: fields.id ?? 1, transaction_type: "sale", label: "Phone journey sale", normalized_label: `phone-journey-${fields.id ?? 1}`,
    amount_minor: 100, currency: "NGN", counterparty: null, business_type_id: "ng_market_trader", country: "NG", sector_id: "trade_retail",
    confirmed_at: 1793000000 + (fields.id ?? 1), prev_entry_hash: fields.prev_entry_hash ?? "0".repeat(64), ...fields
  };
  value.entry_hash = computeLedgerEntryHash(value);
  value.signature = crypto.sign("sha256", Buffer.from(value.entry_hash), { key: device.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  return value;
}
async function signIn(email, phone, device, publicKey) {
  const requested = await app.inject({ method: "POST", url: "/auth/otp/request", payload: { channel: "email", email, phone_number: phone } });
  assert.equal(requested.statusCode, 200, requested.body);
  assert.equal(requested.json().channel, "email");
  assert.ok(requested.json().dev_code, "email OTP request returns the development code in this test configuration");
  const response = await app.inject({ method: "POST", url: "/auth/otp/verify", payload: { channel: "email", email, phone_number: phone, code: requested.json().dev_code, device_identity: device, public_key: publicKey } });
  assert.equal(response.statusCode, 200, response.body);
  const verified = response.json();
  assert.equal(verified.ok, true);
  assert.equal(verified.channel, "email");
  assert.equal(verified.phone_number, phone);
  assert.ok(verified.account_id);
  assert.ok(verified.auth_token);
  return verified;
}
async function change(account, token, target) {
  const requested = await app.inject({ method: "POST", url: "/account/phone-change/request", headers: headers(token, account.device), payload: { new_phone_number: target } });
  assert.equal(requested.statusCode, 200, requested.body);
  assert.equal(requested.json().ok, true);
  assert.equal(requested.json().ttl_minutes, 10);
  const response = await app.inject({ method: "POST", url: "/account/phone-change/confirm", headers: headers(token, account.device), payload: { new_phone_number: target, code: codes.at(-1) } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  assert.equal(response.json().phone_number, target);
  assert.equal(response.json().phone_verified, false);
}

before(async () => {
  config.allowDevOtp = true; config.resendApiKey = ""; config.jwtSecret = "phone-change-journey-test-secret";
  config.serverReceiptSecret = "phone-change-journey-receipt-secret"; config.adminJwtSecret = crypto.randomBytes(32).toString("hex");
  config.adminTotpEncKey = crypto.randomBytes(32).toString("hex"); config.adminTotpEncKeyBytes = null; config.adminIpAllowlist = "";
  const signing = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  config.serverAttestationPrivateKeyPem = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(); config.serverAttestationRetiredKeys = [];
  app = Fastify({ logger: false });
  await registerAuthRoutes(app);
  await registerAccountRoutes(app, { sendPhoneChangeEmail: async (_email, code) => codes.push(code), sendPhoneChangeNotice: async () => {} });
  await registerSyncRoutes(app); await registerAttestRoutes(app); await registerIdentityRoutes(app); await registerRecoveryRoutes(app); await registerAdminClassificationRoutes(app);
  await app.ready();
});
beforeEach(async () => { await resetTestDatabase(database); codes.length = 0; config.recoveryMode = "all"; config.recoveryAllowedDevices = new Set(); config.adminIpAllowlist = ""; });
after(async () => { await app.close(); await database.end(); await getPool().end(); });

test("post-change journey keeps account-ID routes, history, recovery, classification, and session boundaries intact", async () => {
  const oldPhone = "+2348030000801"; const newPhone = "+2348030000802"; const email = `phone-journey-${crypto.randomUUID()}@example.test`;
  const a = { device: `journey-a-${crypto.randomUUID()}`, ...keys() }; const b = { device: `journey-b-${crypto.randomUUID()}`, ...keys() };
  const aLogin = await signIn(email, oldPhone, a.device, a.publicKey);
  const bLogin = await signIn(email, oldPhone, b.device, b.publicKey);
  const account = { id: aLogin.account_id, device: a.device };
  const bAuth = headers(bLogin.auth_token, b.device);
  const savedProfile = await app.inject({
    method: "POST",
    url: "/profile",
    headers: headers(aLogin.auth_token, a.device),
    payload: {
      // Match the app's ordinary profile-sync shape so this journey owns a real profile row.
      name: "Journey Owner", business_name: "Journey Owner", country: "NG", operating_region: "NG", language: "en",
      business_type_id: "ng_market_trader", sector_id: "trade_retail", preferred_labels: [], email
    }
  });
  assert.equal(savedProfile.statusCode, 200, savedProfile.body);
  // account.js:516: ordinary saves return { ok: true }; profile is returned by GET /profile (account.js:364-376).
  assert.equal(savedProfile.json().ok, true);
  const savedProfileRead = await app.inject({ method: "GET", url: "/profile", headers: headers(aLogin.auth_token, a.device) });
  assert.equal(savedProfileRead.statusCode, 200, savedProfileRead.body);
  assert.equal(savedProfileRead.json().profile.phone, oldPhone);

  const before = entry(a);
  const beforeSync = await app.inject({ method: "POST", url: "/sync/entries", headers: headers(aLogin.auth_token, a.device), payload: { device_identity: a.device, entries: [before] } });
  assert.equal(beforeSync.statusCode, 200, beforeSync.body);
  assert.equal(beforeSync.json().synced_count, 1);
  const beforeAttest = await app.inject({ method: "POST", url: "/attest", headers: headers(aLogin.auth_token, a.device), payload: { device_identity: a.device, window_days: 0 } });
  assert.equal(beforeAttest.statusCode, 200, beforeAttest.body);
  assert.equal(beforeAttest.json().ok, true);
  assert.ok(beforeAttest.json().vt_id);
  assert.equal((await database.query("SELECT phone_number FROM attestations WHERE vt_id=$1", [beforeAttest.json().vt_id])).rows[0].phone_number, oldPhone);

  // A pre-change receipt is an immutable snapshot; the post-change rotation below must not rewrite it.
  await database.query("INSERT INTO key_rotation_events (old_device_identity,new_device_identity,phone_number,user_id,rotation_receipt) VALUES ($1,$2,$3,$4,'before-change-receipt')", [a.device, b.device, oldPhone, account.id]);
  const receiptBefore = (await database.query("SELECT row_to_json(x)::text AS row FROM key_rotation_events x WHERE rotation_receipt='before-change-receipt'", [])).rows[0].row;
  const recoveryDevice = { userId: account.id, phone: oldPhone, deviceIdentity: b.device, privateKey: b.privateKey, token: bLogin.auth_token, headers: bAuth, head: { id: 0, hash: "0".repeat(64) } };
  await database.query("UPDATE device_identities SET status='FORKED' WHERE device_identity=$1", [b.device]);
  const recovery = await createRecovery(app, recoveryDevice);
  assert.equal(recovery.response.statusCode, 200, recovery.response.body);
  assert.equal(recovery.response.json().recovery_id, recovery.recoveryId);
  assert.equal(recovery.response.json().state, "open");
  const recoveryPayload = { records: [], queue: [] };
  const uploaded = await uploadRecoveryParts(app, recoveryDevice, recovery.recoveryId, [recoveryPayload]);
  assert.ok(uploaded.responses.every((response) => response.statusCode === 200));
  assert.equal(uploaded.responses[0].json().n, 0);
  assert.equal(uploaded.responses[0].json().preservation_complete, true);

  await change(account, aLogin.auth_token, newPhone);
  const profile = await app.inject({ method: "GET", url: "/profile", headers: bAuth });
  assert.equal(profile.statusCode, 200, profile.body); assert.equal(profile.json().profile.phone, newPhone); assert.equal(profile.json().profile.phone_verified, false);
  assert.equal((await app.inject({ method: "GET", url: "/records", headers: bAuth })).statusCode, 200);
  const legacyToken = jwt.sign({ phone_number: oldPhone, sid: jwt.decode(bLogin.auth_token).sid }, config.jwtSecret, { expiresIn: "1h" });
  assert.equal((await app.inject({ method: "GET", url: "/profile", headers: headers(legacyToken, b.device) })).statusCode, 200, "legacy phone claim is not an ownership key");

  const restoreDevice = `journey-email-${crypto.randomUUID()}`;
  const signInAgain = await signIn(email, newPhone, restoreDevice, "journey-email-key");
  assert.equal(signInAgain.phone_number, newPhone, "email sign-in returns the current phone");
  const restored = await app.inject({ method: "GET", url: "/profile", headers: headers(signInAgain.auth_token, restoreDevice) });
  // The app's restore path is an authenticated profile read, not a phone lookup.
  assert.equal(restored.statusCode, 200, restored.body); assert.equal(restored.json().profile.phone, newPhone);

  const resumed = await createRecovery(app, recoveryDevice, recovery.recoveryId);
  assert.equal(resumed.response.statusCode, 200, resumed.response.body);
  assert.equal(resumed.response.json().recovery_id, recovery.recoveryId);
  const continued = await app.inject({ method: "PUT", url: `/recovery/sessions/${recovery.recoveryId}/parts/0`, headers: bAuth, payload: { sha256: recoveryPartSha256(recoveryPayload), ...recoveryPartDeclaration([recoveryPayload]), ...recoveryPayload } });
  assert.equal(continued.statusCode, 200, continued.body);
  assert.equal(continued.json().preservation_complete, true);
  // The journey subsequently demonstrates ordinary B work; retire the test's completed/idempotent recovery fixture.
  await database.query("UPDATE recovery_sessions SET state='superseded' WHERE recovery_id=$1", [recovery.recoveryId]);

  // Restore B to ACTIVE for ordinary sync/attestation; its recovery session remains usable after the change.
  await database.query("UPDATE device_identities SET status='ACTIVE' WHERE device_identity=$1", [b.device]);
  // Entry hashes are globally replay-protected, so B's first chain entry must
  // represent distinct business content from A's pre-change entry.
  const after = entry(b, {
    id: 1,
    label: "Phone journey post-change sale",
    normalized_label: "phone-journey-post-change-1",
    confirmed_at: 1793000101
  });
  const afterSync = await app.inject({ method: "POST", url: "/sync/entries", headers: bAuth, payload: { device_identity: b.device, entries: [after] } });
  assert.equal(afterSync.statusCode, 200, afterSync.body);
  assert.equal(afterSync.json().synced_count, 1);
  const afterAttest = await app.inject({ method: "POST", url: "/attest", headers: bAuth, payload: { device_identity: b.device, window_days: 0 } });
  assert.equal(afterAttest.statusCode, 200, afterAttest.body);
  assert.ok(afterAttest.json().vt_id);
  for (const vtId of [beforeAttest.json().vt_id, afterAttest.json().vt_id]) {
    const verified = await app.inject({ method: "GET", url: `/verify/${vtId}` });
    assert.equal(verified.statusCode, 200, verified.body);
    assert.equal(verified.json().status, "VALID");
  }
  assert.equal((await database.query("SELECT phone_number FROM attestations WHERE vt_id=$1", [beforeAttest.json().vt_id])).rows[0].phone_number, oldPhone);

  const rotate = await app.inject({ method: "POST", url: "/identity/rotate/challenge", headers: bAuth, payload: { old_device_identity: b.device } });
  assert.equal(rotate.statusCode, 200, rotate.body);
  assert.ok(rotate.json().challenge_nonce);
  const newDevice = `journey-rotated-${crypto.randomUUID()}`; const newKeys = keys(); const nonce = rotate.json().challenge_nonce;
  const signature = crypto.sign("sha256", Buffer.from(`${nonce}|${newDevice}|${newKeys.publicKey}`), { key: b.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  const rotation = await app.inject({ method: "POST", url: "/identity/rotate", headers: bAuth, payload: { old_device_identity: b.device, new_device_identity: newDevice, new_public_key: newKeys.publicKey, challenge_nonce: nonce, challenge_signature: signature } });
  assert.equal(rotation.statusCode, 200, rotation.body);
  assert.equal(rotation.json().new_device_identity, newDevice);
  assert.equal((await database.query("SELECT phone_number FROM key_rotation_events WHERE old_device_identity=$1 ORDER BY id DESC LIMIT 1", [b.device])).rows[0].phone_number, newPhone);
  assert.equal((await database.query("SELECT row_to_json(x)::text AS row FROM key_rotation_events x WHERE rotation_receipt='before-change-receipt'", [])).rows[0].row, receiptBefore);

  const admin = await seedAdmin("owner"); const adminSession = await createSession(admin);
  const previewNew = await app.inject({ method: "POST", url: "/admin/classification/preview", headers: { authorization: `Bearer ${adminSession.token}` }, payload: { phone_number: newPhone, classification: "EXTERNAL", reason_code: "OWNER_CLASSIFIED_EXTERNAL" } });
  assert.equal(previewNew.statusCode, 200, previewNew.body);
  assert.equal(previewNew.json().target_classification, "EXTERNAL");
  assert.ok(previewNew.json().confirmation_token);
  const previewOld = await app.inject({ method: "POST", url: "/admin/classification/preview", headers: { authorization: `Bearer ${adminSession.token}` }, payload: { phone_number: oldPhone, classification: "EXTERNAL", reason_code: "OWNER_CLASSIFIED_EXTERNAL" } });
  assert.equal(previewOld.statusCode, 404, previewOld.body);

  const newcomer = await signIn(`new-${crypto.randomUUID()}@example.test`, oldPhone, `journey-new-${crypto.randomUUID()}`, "journey-new-key");
  assert.ok(newcomer.account_id);
  assert.equal((await app.inject({ method: "POST", url: "/auth/logout", headers: bAuth })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: "/profile", headers: headers(aLogin.auth_token, a.device) })).statusCode, 200, "logout on B leaves A working");
  assert.equal((await app.inject({ method: "POST", url: "/auth/logout-all", headers: headers(aLogin.auth_token, a.device) })).statusCode, 204);
  assert.equal((await app.inject({ method: "GET", url: "/profile", headers: bAuth })).statusCode, 401, "logout-all revokes B");
});
