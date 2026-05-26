async function sha256(input) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const PASSCODE_KDF_VERSION = "pbkdf2-sha256-v1";
export const PASSCODE_PBKDF2_ITERATIONS = 210000;

export function legacyHashPin(pin) {
  let hash = 0;
  for (let index = 0; index < pin.length; index += 1) {
    hash = ((hash << 5) - hash) + pin.charCodeAt(index);
    hash |= 0;
  }
  return String(hash);
}

export async function hashPin(pin, salt) {
  return sha256(`${pin}${salt}`);
}

export function createPinSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const value = String(hex || "");
  const bytes = new Uint8Array(Math.floor(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, (index * 2) + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes) {
  return Array.from(bytes || []).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashPasscodeWithPbkdf2(passcode, salt, iterations = PASSCODE_PBKDF2_ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(passcode || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(salt),
      iterations
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(derivedBits));
}
