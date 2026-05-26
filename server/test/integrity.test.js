import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyEntrySignature } from "../src/crypto-verify.js";
import {
  buildAttestationPayload,
  signAttestationPayload,
  verifyAttestationPayload,
} from "../src/attestation-signing.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    publicJwkStr: JSON.stringify({
      kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y,
      use: "sig", alg: "ES256", key_ops: ["verify"], ext: true,
    }),
  };
}

function signHash(privateKey, hashString) {
  return crypto
    .sign("sha256", Buffer.from(hashString, "utf8"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    })
    .toString("base64");
}

// Mirror of sync.js chain-check loop — no DB, no import from src/routes/sync.js
function validateChain(entries) {
  const EMPTY = "0".repeat(64);
  let expectedPrev = EMPTY;
  for (const e of entries) {
    if (e.prev_entry_hash !== expectedPrev) return false;
    expectedPrev = e.entry_hash;
  }
  return true;
}

const H1 = crypto.createHash("sha256").update("entry-1").digest("hex");
const H2 = crypto.createHash("sha256").update("entry-2").digest("hex");
const H3 = crypto.createHash("sha256").update("entry-3").digest("hex");
const EMPTY_HASH = "0".repeat(64);

const PAYLOAD_FIELDS = {
  vt_id: "test-vt-001",
  device_fingerprint: "fp001",
  ledger_root_hash: H1,
  entry_count: 3,
  window_start: new Date("2026-01-01T00:00:00.000Z"),
  window_end: new Date("2026-01-31T00:00:00.000Z"),
  issued_at: new Date("2026-02-01T00:00:00.000Z"),
  status: "VALID",
  attestation_scope: "single_device",
  scope_description: "Test scope",
};

// ── A: verifyEntrySignature ───────────────────────────────────────────────────

test("A1: verifyEntrySignature returns true for a valid signature", () => {
  const { privateKey, publicJwkStr } = makeKeypair();
  const sig = signHash(privateKey, H1);
  assert.equal(verifyEntrySignature(publicJwkStr, H1, sig), true);
});

test("A2: verifyEntrySignature returns false for a tampered hash", () => {
  const { privateKey, publicJwkStr } = makeKeypair();
  const sig = signHash(privateKey, H1);
  assert.equal(verifyEntrySignature(publicJwkStr, H1 + "x", sig), false);
});

test("A3: verifyEntrySignature returns false for a tampered signature", () => {
  const { privateKey, publicJwkStr } = makeKeypair();
  const sig = signHash(privateKey, H1);
  const buf = Buffer.from(sig, "base64");
  buf[0] ^= 0xff;
  assert.equal(verifyEntrySignature(publicJwkStr, H1, buf.toString("base64")), false);
});

test("A4: verifyEntrySignature returns false for invalid public key JSON", () => {
  const { privateKey } = makeKeypair();
  const sig = signHash(privateKey, H1);
  assert.equal(verifyEntrySignature("not-valid-json{{", H1, sig), false);
});

// ── B: hash-chain continuity invariant ───────────────────────────────────────

test("B1: hash-chain single entry with prev_hash = EMPTY_HASH passes", () => {
  assert.equal(
    validateChain([{ prev_entry_hash: EMPTY_HASH, entry_hash: H1 }]),
    true
  );
});

test("B2: hash-chain two-entry sequence passes when hashes are contiguous", () => {
  assert.equal(
    validateChain([
      { prev_entry_hash: EMPTY_HASH, entry_hash: H1 },
      { prev_entry_hash: H1, entry_hash: H2 },
    ]),
    true
  );
});

test("B3: hash-chain break is detected when prev_hash does not match", () => {
  assert.equal(
    validateChain([
      { prev_entry_hash: EMPTY_HASH, entry_hash: H1 },
      { prev_entry_hash: H3, entry_hash: H2 }, // H3 ≠ H1 → break
    ]),
    false
  );
});

// ── C: buildAttestationPayload ────────────────────────────────────────────────

test("C1: buildAttestationPayload includes all required fields", () => {
  const parsed = JSON.parse(buildAttestationPayload(PAYLOAD_FIELDS));
  const required = [
    "vt_id", "device_fingerprint", "ledger_root_hash", "entry_count",
    "window_start", "window_end", "issued_at", "status",
    "attestation_scope", "scope_description",
  ];
  for (const key of required) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed, key),
      `expected field missing: ${key}`
    );
  }
});

test("C2: buildAttestationPayload coerces Date fields to ISO 8601 strings", () => {
  const parsed = JSON.parse(buildAttestationPayload(PAYLOAD_FIELDS));
  assert.equal(parsed.window_start, "2026-01-01T00:00:00.000Z");
  assert.equal(parsed.window_end, "2026-01-31T00:00:00.000Z");
  assert.equal(parsed.issued_at, "2026-02-01T00:00:00.000Z");
});

// ── D: attestation sign / verify round-trip ───────────────────────────────────

test("D1: attestation sign/verify round-trip returns true", () => {
  const payload = buildAttestationPayload(PAYLOAD_FIELDS);
  const sig = signAttestationPayload(payload);
  assert.equal(verifyAttestationPayload(payload, sig), true);
});

test("D2: attestation verify returns false for a tampered payload", () => {
  const payload = buildAttestationPayload(PAYLOAD_FIELDS);
  const sig = signAttestationPayload(payload);
  const tampered = payload.replace('"VALID"', '"TAMPERED"');
  assert.equal(verifyAttestationPayload(tampered, sig), false);
});
