import crypto from "node:crypto";

export function verifyEntrySignature(publicKeyString, entryHash, signatureBase64) {
  try {
    const jwk = JSON.parse(publicKeyString);
    const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
    const signatureBuffer = Buffer.from(signatureBase64, "base64");
    const dataBuffer = Buffer.from(entryHash, "utf8");

    return crypto.verify(
      "sha256",
      dataBuffer,
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      signatureBuffer
    );
  } catch (e) {
    return false;
  }
}
