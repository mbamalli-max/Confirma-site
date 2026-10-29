import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  config,
  parseServerAttestationRetiredKeys,
  validateRuntimeConfig
} from "../src/config.js";
import {
  buildAttestationPayload,
  exportPublishedVerificationKey,
  findSigningKey,
  getVerificationKeyKid,
  signAttestationPayload,
  verifyAttestationSignature
} from "../src/attestation-signing.js";

const originalConfig = { ...config };
after(() => Object.assign(config, originalConfig));

function keyPairPem() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

const keyA = keyPairPem();
const keyB = keyPairPem();
const keyC = keyPairPem();
const now = new Date();
const retirement = new Date(now.getTime() + 30 * 60 * 1000);

function retiredConfig(publicPem, retiredAt = retirement) {
  return JSON.stringify([{
    public_key_spki_pem: publicPem,
    retired_at: retiredAt.toISOString()
  }]);
}

function useRing(activePrivatePem, retiredRaw = "", parseNow = now) {
  config.nodeEnv = "production";
  config.serverAttestationPrivateKeyPem = activePrivatePem;
  config.serverAttestationRetiredKeysRaw = retiredRaw;
  config.serverAttestationRetiredKeys = parseServerAttestationRetiredKeys(retiredRaw, {
    activePrivateKeyPem: activePrivatePem,
    now: parseNow
  });
}

function payload(overrides = {}) {
  return buildAttestationPayload({
    vt_id: "rotation-unit-vt",
    device_fingerprint: "device01",
    ledger_root_hash: "sha256:unit-root",
    entry_count: 2,
    window_start: "2026-10-01T00:00:00.000Z",
    window_end: "2026-10-02T00:00:00.000Z",
    issued_at: "2026-10-02T01:00:00.000Z",
    status: "VALID",
    attestation_scope: "single_device",
    scope_description: "Unit test scope",
    ...overrides
  });
}

function strictValidation(raw, activePrivatePem = keyB.privatePem) {
  Object.assign(config, {
    nodeEnv: "production",
    jwtSecret: "j".repeat(32),
    serverReceiptSecret: "r".repeat(32),
    adminJwtSecret: "a".repeat(32),
    adminTotpEncKey: "1".repeat(64),
    adminJwtExpiry: "1h",
    adminKAnonThreshold: 5,
    adminIpAllowlist: "",
    trustProxy: false,
    serverAttestationPrivateKeyPem: activePrivatePem,
    serverAttestationRetiredKeysRaw: raw,
    allowDevOtp: true,
    smsProviderEnabled: false
  });
  validateRuntimeConfig();
  return config.serverAttestationRetiredKeys;
}

function assertNonEchoingFailure(raw, activePrivatePem = keyB.privatePem) {
  assert.throws(
    () => strictValidation(raw, activePrivatePem),
    (error) => {
      assert.equal(error.message.includes(raw), false);
      assert.equal(error.message.includes(keyA.privatePem), false);
      assert.equal(error.message.includes(keyA.publicPem), false);
      return true;
    }
  );
}

test("U1: strict config accepts planned and past retirements and rejects unsafe entries", () => {
  const planned = strictValidation(retiredConfig(keyA.publicPem, retirement));
  assert.equal(planned.length, 1);
  assert.equal(planned[0].retired_at, retirement.toISOString());

  const pastRetirement = new Date(now.getTime() - 30 * 60 * 1000);
  assert.equal(strictValidation(retiredConfig(keyA.publicPem, pastRetirement)).length, 1);

  assertNonEchoingFailure(retiredConfig(keyA.publicPem, new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000)));
  assertNonEchoingFailure(JSON.stringify([{ public_key_spki_pem: keyA.publicPem, retired_at: "not-a-time" }]));
  assertNonEchoingFailure(retiredConfig(keyA.publicPem, new Date("2025-12-31T23:59:59.999Z")));
  assertNonEchoingFailure(JSON.stringify([{ public_key_spki_pem: keyA.privatePem, retired_at: retirement.toISOString() }]));
  assertNonEchoingFailure(retiredConfig(keyB.publicPem));
  assertNonEchoingFailure(JSON.stringify([
    { public_key_spki_pem: keyA.publicPem, retired_at: retirement.toISOString() },
    { public_key_spki_pem: keyA.publicPem, retired_at: retirement.toISOString() }
  ]));
});

test("U2: retired-key acceptance is strictly before the retirement boundary with and without kid", () => {
  useRing(keyA.privatePem);
  const signedPayload = payload();
  const signedByA = signAttestationPayload(signedPayload);
  useRing(keyB.privatePem, retiredConfig(keyA.publicPem));

  for (const kid of [signedByA.kid, null]) {
    assert.equal(verifyAttestationSignature(signedPayload, signedByA.signature, {
      kid, issuedAt: new Date(retirement.getTime() - 1)
    }).ok, true);
    assert.equal(verifyAttestationSignature(signedPayload, signedByA.signature, {
      kid, issuedAt: retirement
    }).ok, false);
    assert.equal(verifyAttestationSignature(signedPayload, signedByA.signature, {
      kid, issuedAt: new Date(retirement.getTime() + 1)
    }).ok, false);
  }
});

test("U3: a stored kid selects exactly one key and a legacy row can use the active key", () => {
  useRing(keyA.privatePem);
  const signedPayload = payload();
  const signedByA = signAttestationPayload(signedPayload);
  useRing(keyB.privatePem, retiredConfig(keyA.publicPem));
  const signedByB = signAttestationPayload(signedPayload);

  assert.equal(verifyAttestationSignature(signedPayload, signedByB.signature, {
    kid: signedByA.kid, issuedAt: now
  }).ok, false);
  assert.equal(verifyAttestationSignature(signedPayload, signedByA.signature, {
    kid: signedByB.kid, issuedAt: now
  }).ok, false);
  assert.equal(verifyAttestationSignature(signedPayload, signedByB.signature, {
    kid: "unknown-kid", issuedAt: now
  }).ok, false);
  assert.deepEqual(verifyAttestationSignature(signedPayload, signedByB.signature, {
    kid: null, issuedAt: now
  }), { ok: true, kid: signedByB.kid, key_status: "active" });
});

test("U4: payload-declared dates never override the stored issuance time", () => {
  useRing(keyA.privatePem);
  const payloadClaimingOldDate = payload({ issued_at: new Date(retirement.getTime() - 60_000) });
  const signedByA = signAttestationPayload(payloadClaimingOldDate);
  useRing(keyB.privatePem, retiredConfig(keyA.publicPem));
  assert.equal(verifyAttestationSignature(payloadClaimingOldDate, signedByA.signature, {
    kid: signedByA.kid,
    issuedAt: new Date(retirement.getTime() + 1)
  }).ok, false);
});

test("U5: published verification file orders and labels keys without private material", () => {
  useRing(keyB.privatePem, retiredConfig(keyA.publicPem));
  const published = exportPublishedVerificationKey();
  assert.equal(published.version, 1);
  assert.equal(published.keys[0].status, "active");
  assert.equal(published.keys[1].status, "retired");
  assert.equal(published.keys[1].not_after, retirement.toISOString());
  assert.equal(published.public_key_spki_pem, keyB.publicPem);
  const serialized = JSON.stringify(published);
  assert.equal(serialized.includes("PRIVATE"), false);
  assert.equal(serialized.includes('"d":'), false);
  assert.equal(serialized.includes("d:"), false);

  useRing(keyB.privatePem);
  const single = exportPublishedVerificationKey();
  assert.equal(single.keys.length, 1);
  assert.equal(single.keys[0].status, "active");
  assert.equal(single.keys[0].kid, getVerificationKeyKid(keyB.publicPem));
  assert.equal(single.public_key_spki_pem, keyB.publicPem);
});

test("U6: findSigningKey identifies either configured key and rejects tampering", () => {
  useRing(keyA.privatePem);
  const signedPayload = payload();
  const signedByA = signAttestationPayload(signedPayload);
  useRing(keyB.privatePem, retiredConfig(keyA.publicPem));
  const signedByB = signAttestationPayload(signedPayload);

  assert.equal(findSigningKey(signedPayload, signedByA.signature), signedByA.kid);
  assert.equal(findSigningKey(signedPayload, signedByB.signature), signedByB.kid);
  assert.equal(findSigningKey(`${signedPayload}tampered`, signedByA.signature), null);
  assert.notEqual(signedByA.kid, getVerificationKeyKid(keyC.publicPem));
});
