import crypto from "node:crypto";
import { config } from "./config.js";

export const ATTESTATION_SCOPE = "single_device";
export const ATTESTATION_SCOPE_DESCRIPTION = "This report reflects records from a single device only.";
export const ACCOUNT_DEVICES_ATTESTATION_SCOPE = "account_devices";
export const ACCOUNT_DEVICES_ATTESTATION_SCOPE_DESCRIPTION = "This report reflects records from device identities linked to the authenticated account. The report device fingerprint identifies the device that generated the report; each ledger row identifies the device used to record that entry.";
export const ATTESTATION_SIGNATURE_ALGORITHM = "ECDSA_P256_SHA256_P1363";
export const LEGACY_ATTESTATION_SIGNATURE_ALGORITHM = "HMAC_SHA256_LEGACY";

let cachedKeyMaterial = null;
let warnedAboutEphemeralKey = false;

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

function buildKeyMaterial(privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
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
    privateKey,
    publicKey,
    publicJwk,
    publicKeySpkiPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    kid
  };
}

function getKeyMaterial() {
  if (cachedKeyMaterial) return cachedKeyMaterial;

  if (config.serverAttestationPrivateKeyPem) {
    cachedKeyMaterial = buildKeyMaterial(
      crypto.createPrivateKey({
        key: config.serverAttestationPrivateKeyPem,
        format: "pem"
      })
    );
    return cachedKeyMaterial;
  }

  if (config.nodeEnv === "production") {
    throw new Error("SERVER_ATTESTATION_PRIVATE_KEY_PEM is required in production.");
  }

  if (!warnedAboutEphemeralKey) {
    console.warn("SERVER_ATTESTATION_PRIVATE_KEY_PEM is not set; using an ephemeral development attestation key.");
    warnedAboutEphemeralKey = true;
  }

  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  cachedKeyMaterial = buildKeyMaterial(privateKey);
  return cachedKeyMaterial;
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
  const signature = crypto.sign("sha256", Buffer.from(payload, "utf8"), {
    key: getKeyMaterial().privateKey,
    dsaEncoding: "ieee-p1363"
  });
  return signature.toString("base64");
}

export function verifyAttestationPayload(payload, signatureBase64) {
  try {
    const signature = Buffer.from(String(signatureBase64 || ""), "base64");
    return crypto.verify("sha256", Buffer.from(payload, "utf8"), {
      key: getKeyMaterial().publicKey,
      dsaEncoding: "ieee-p1363"
    }, signature);
  } catch (error) {
    return false;
  }
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
    server_signature: signAttestationPayload(attestationPayload)
  };
}

export function exportPublishedVerificationKey() {
  const material = getKeyMaterial();
  return {
    version: 1,
    verification_key_url: getVerificationKeyUrl(),
    signature_algorithm: ATTESTATION_SIGNATURE_ALGORITHM,
    signature_encoding: "base64-raw-p1363",
    public_key_spki_pem: material.publicKeySpkiPem,
    keys: [
      {
        ...material.publicJwk,
        kid: material.kid
      }
    ]
  };
}

export function getVerificationKeyMetadata() {
  const material = getKeyMaterial();
  return {
    verification_key_url: getVerificationKeyUrl(),
    signature_algorithm: ATTESTATION_SIGNATURE_ALGORITHM,
    verification_key_kid: material.kid
  };
}
