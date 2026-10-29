import crypto from "node:crypto";
import { config } from "./config.js";

export const ATTESTATION_SCOPE = "single_device";
export const ATTESTATION_SCOPE_DESCRIPTION = "This report reflects records from a single device only.";
export const ACCOUNT_DEVICES_ATTESTATION_SCOPE = "account_devices";
export const ACCOUNT_DEVICES_ATTESTATION_SCOPE_DESCRIPTION = "This report reflects records from device identities linked to the authenticated account. The report device fingerprint identifies the device that generated the report; each ledger row identifies the device used to record that entry.";
export const ATTESTATION_SIGNATURE_ALGORITHM = "ECDSA_P256_SHA256_P1363";

let cachedKeyMaterial = null;
let cachedKeyRingFingerprint = null;
let warnedAboutEphemeralKey = false;

export const OFFLINE_VERIFICATION_LIMITATION = "Anyone holding a report can check its signature against the keys listed here. For a report signed by a retired key, that check shows only that the retired key signed it. A report's own date is written by whoever signs it, and a retired key may have been exposed, so it cannot prove when the report was issued. To confirm a report signed by a retired key, look it up at konfirmata.com/verify/<report id>, which checks Konfirmata's own issuance record. Reports signed by the active key are not affected.";

function canonicalizeVerificationJwk(jwk) {
  return JSON.stringify({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    use: "sig",
    alg: "ES256",
    key_ops: ["verify"],
    ext: true
  });
}

function getVerificationKeyUrl() {
  return config.verificationKeyUrl || `${config.verifyBaseUrl}/.well-known/verification-key.json`;
}

function buildPublicKeyMaterial(publicKey) {
  if (publicKey.asymmetricKeyType !== "ec"
      || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("Attestation keys must use EC P-256.");
  }
  const jwk = publicKey.export({ format: "jwk" });
  const publicJwk = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
    use: "sig",
    alg: "ES256",
    key_ops: ["verify"],
    ext: true
  };
  const kid = crypto
    .createHash("sha256")
    .update(canonicalizeVerificationJwk(publicJwk))
    .digest("hex")
    .slice(0, 16);
  return {
    publicKey,
    publicJwk,
    publicKeySpkiPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    kid
  };
}

function buildActiveKeyMaterial(privateKey) {
  return {
    ...buildPublicKeyMaterial(crypto.createPublicKey(privateKey)),
    privateKey,
    status: "active",
    retiredAt: null
  };
}

function buildRetiredKeyMaterial(entry) {
  return {
    ...buildPublicKeyMaterial(crypto.createPublicKey({
      key: entry.public_key_spki_pem,
      format: "pem",
      type: "spki"
    })),
    privateKey: null,
    status: "retired",
    retiredAt: entry.retired_at
  };
}

function keyRingFingerprint() {
  return JSON.stringify({
    active: config.serverAttestationPrivateKeyPem || "",
    retired: config.serverAttestationRetiredKeys || []
  });
}

function getKeyRing() {
  const fingerprint = keyRingFingerprint();
  if (cachedKeyMaterial && cachedKeyRingFingerprint === fingerprint) return cachedKeyMaterial;

  let active;
  if (config.serverAttestationPrivateKeyPem) {
    active = buildActiveKeyMaterial(
      crypto.createPrivateKey({
        key: config.serverAttestationPrivateKeyPem,
        format: "pem"
      })
    );
  } else {
    if (config.nodeEnv === "production") {
      throw new Error("SERVER_ATTESTATION_PRIVATE_KEY_PEM is required in production.");
    }

    if (!warnedAboutEphemeralKey) {
      console.warn("SERVER_ATTESTATION_PRIVATE_KEY_PEM is not set; using an ephemeral development attestation key.");
      warnedAboutEphemeralKey = true;
    }

    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    active = buildActiveKeyMaterial(privateKey);
  }

  const retired = (config.serverAttestationRetiredKeys || []).map(buildRetiredKeyMaterial);
  cachedKeyMaterial = { active, retired, all: [active, ...retired] };
  cachedKeyRingFingerprint = fingerprint;
  return cachedKeyMaterial;
}

function decodeSignature(signatureBase64) {
  const value = String(signatureBase64 || "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const signature = Buffer.from(value, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== value) return null;
  return signature;
}

function signatureMatches(payload, signature, key) {
  try {
    return crypto.verify("sha256", Buffer.from(String(payload), "utf8"), {
      key: key.publicKey,
      dsaEncoding: "ieee-p1363"
    }, signature);
  } catch {
    return false;
  }
}

export function signatureMatchesPublicKey(payload, signatureBase64, publicKeyPem) {
  try {
    const signature = decodeSignature(signatureBase64);
    if (!signature) return false;
    const publicKey = buildPublicKeyMaterial(crypto.createPublicKey({
      key: publicKeyPem,
      format: "pem",
      type: "spki"
    }));
    return signatureMatches(payload, signature, publicKey);
  } catch {
    return false;
  }
}

export function buildAttestationPayload(fields) {
  return JSON.stringify({
    vt_id: String(fields.vt_id || ""),
    device_fingerprint: String(fields.device_fingerprint || ""),
    ledger_root_hash: String(fields.ledger_root_hash || ""),
    entry_count: Number(fields.entry_count || 0),
    window_start: new Date(fields.window_start).toISOString(),
    window_end: new Date(fields.window_end).toISOString(),
    issued_at: new Date(fields.issued_at).toISOString(),
    status: String(fields.status || "VALID"),
    attestation_scope: String(fields.attestation_scope || ATTESTATION_SCOPE),
    scope_description: String(fields.scope_description || ATTESTATION_SCOPE_DESCRIPTION)
  });
}

export function signAttestationPayload(payload) {
  const active = getKeyRing().active;
  const signature = crypto.sign("sha256", Buffer.from(payload, "utf8"), {
    key: active.privateKey,
    dsaEncoding: "ieee-p1363"
  });
  return { signature: signature.toString("base64"), kid: active.kid };
}

export function verifyAttestationPayload(payload, signatureBase64) {
  const signature = decodeSignature(signatureBase64);
  return Boolean(signature && signatureMatches(payload, signature, getKeyRing().active));
}

export function verifyAttestationSignature(payload, signatureBase64, { kid = null, issuedAt } = {}) {
  const failure = { ok: false, kid: null, key_status: null };
  const signature = decodeSignature(signatureBase64);
  if (issuedAt === null || issuedAt === undefined || typeof issuedAt === "boolean") return failure;
  const issuedAtMs = new Date(issuedAt).getTime();
  if (!signature || !Number.isFinite(issuedAtMs)) return failure;

  const ring = getKeyRing();
  const requestedKid = String(kid || "").trim();
  const candidates = requestedKid
    ? ring.all.filter((key) => key.kid === requestedKid)
    : ring.all;
  if (!candidates.length) return failure;

  for (const key of candidates) {
    if (!signatureMatches(payload, signature, key)) {
      if (requestedKid) {
        return { ok: false, kid: key.kid, key_status: key.status };
      }
      continue;
    }
    const beforeRetirement = key.status === "active"
      || issuedAtMs < new Date(key.retiredAt).getTime();
    return { ok: beforeRetirement, kid: key.kid, key_status: key.status };
  }
  return failure;
}

export function findSigningKey(payload, signatureBase64) {
  const signature = decodeSignature(signatureBase64);
  if (!signature) return null;
  const match = getKeyRing().all.find((key) => signatureMatches(payload, signature, key));
  return match?.kid || null;
}

export function getVerificationKeyKid(publicKeyPem) {
  return buildPublicKeyMaterial(crypto.createPublicKey({
    key: publicKeyPem,
    format: "pem",
    type: "spki"
  })).kid;
}

export function buildAttestationEnvelope(fields) {
  const vtId = String(fields.vt_id || "");
  const deviceIdentity = String(fields.device_identity || "");
  const issuedAtIso = new Date(fields.issued_at).toISOString();
  const windowStartIso = new Date(fields.window_start).toISOString();
  const windowEndIso = new Date(fields.window_end).toISOString();
  const deviceFingerprint = String(fields.device_fingerprint || deviceIdentity.slice(0, 8));
  const verifyUrl = String(fields.verify_url || `${config.verifyBaseUrl}/verify/${vtId}`);
  const attestationScope = String(fields.attestation_scope || ATTESTATION_SCOPE);
  const scopeDescription = String(fields.scope_description || ATTESTATION_SCOPE_DESCRIPTION);
  const attestationPayload = buildAttestationPayload({
    vt_id: vtId,
    device_fingerprint: deviceFingerprint,
    ledger_root_hash: fields.ledger_root_hash,
    entry_count: fields.entry_count,
    window_start: windowStartIso,
    window_end: windowEndIso,
    issued_at: issuedAtIso,
    status: fields.status || "VALID",
    attestation_scope: attestationScope,
    scope_description: scopeDescription
  });
  const signed = signAttestationPayload(attestationPayload);
  return {
    vt_id: vtId,
    device_identity: deviceIdentity,
    device_fingerprint: deviceFingerprint,
    ledger_root_hash: String(fields.ledger_root_hash || ""),
    entry_count: Number(fields.entry_count || 0),
    window_start: windowStartIso,
    window_end: windowEndIso,
    issued_at: issuedAtIso,
    status: String(fields.status || "VALID"),
    attestation_scope: attestationScope,
    scope_description: scopeDescription,
    verify_url: verifyUrl,
    verification_key_url: getVerificationKeyUrl(),
    signature_algorithm: ATTESTATION_SIGNATURE_ALGORITHM,
    attestation_payload: attestationPayload,
    server_signature: signed.signature,
    signing_kid: signed.kid
  };
}

export function exportPublishedVerificationKey() {
  const ring = getKeyRing();
  const material = ring.active;
  return {
    version: 1,
    verification_key_url: getVerificationKeyUrl(),
    signature_algorithm: ATTESTATION_SIGNATURE_ALGORITHM,
    signature_encoding: "base64-raw-p1363",
    public_key_spki_pem: material.publicKeySpkiPem,
    keys: ring.all.map((key) => ({
      ...key.publicJwk,
      kid: key.kid,
      status: key.status,
      ...(key.status === "retired" ? { not_after: key.retiredAt } : {})
    })),
    notes: OFFLINE_VERIFICATION_LIMITATION
  };
}

export function getVerificationKeyMetadata() {
  const material = getKeyRing().active;
  return {
    verification_key_url: getVerificationKeyUrl(),
    signature_algorithm: ATTESTATION_SIGNATURE_ALGORITHM,
    verification_key_kid: material.kid
  };
}
