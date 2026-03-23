import crypto from "node:crypto";

export function verifyEntrySignature(publicKeyString, entryHash, signatureBase64) {
  const jwk = JSON.parse(publicKeyString);
  const publicKey = crypto.createPublicKey({
    key: jwk,
    format: "jwk"
  });

  return crypto.verify(
    "sha256",
    Buffer.from(entryHash, "hex"),
    publicKey,
    Buffer.from(signatureBase64, "base64")
  );
}
