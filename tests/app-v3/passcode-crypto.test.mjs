import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PASSCODE_KDF_VERSION,
  PASSCODE_PBKDF2_ITERATIONS,
  legacyHashPin,
  hashPin,
  createPinSalt,
  hexToBytes,
  bytesToHex,
  hashPasscodeWithPbkdf2
} from "../../app-v3/passcode-crypto.js";

test("KDF constants are locked", () => {
  assert.equal(PASSCODE_KDF_VERSION, "pbkdf2-sha256-v1");
  assert.equal(PASSCODE_PBKDF2_ITERATIONS, 210000);
});

test("legacyHashPin is deterministic and pin-sensitive", () => {
  assert.equal(legacyHashPin("1234"), legacyHashPin("1234"));
  assert.notEqual(legacyHashPin("1234"), legacyHashPin("1235"));
  assert.equal(typeof legacyHashPin("1234"), "string");
});

test("hashPin returns deterministic 64-char hex, salt-sensitive", async () => {
  const first = await hashPin("1234", "aabb");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await hashPin("1234", "aabb"), first);
  assert.notEqual(await hashPin("1234", "ccdd"), first);
  assert.notEqual(await hashPin("9999", "aabb"), first);
});

test("createPinSalt returns unique 32-char hex", () => {
  const salt = createPinSalt();
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.notEqual(createPinSalt(), salt);
});

test("hexToBytes/bytesToHex round-trip", () => {
  const hex = "00ff10ab";
  assert.equal(bytesToHex(hexToBytes(hex)), hex);
  assert.deepEqual(Array.from(hexToBytes("00ff")), [0, 255]);
  assert.equal(bytesToHex(new Uint8Array([0, 15, 255])), "000fff");
  assert.equal(bytesToHex(null), "");
});

test("hexToBytes ignores a trailing odd nibble", () => {
  assert.equal(hexToBytes("abc").length, 1);
  assert.equal(hexToBytes("").length, 0);
});

test("hashPasscodeWithPbkdf2 is deterministic, salt- and iteration-sensitive", async () => {
  const salt = "00112233445566778899aabbccddeeff";
  const first = await hashPasscodeWithPbkdf2("123456", salt, 1000);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await hashPasscodeWithPbkdf2("123456", salt, 1000), first);
  assert.notEqual(await hashPasscodeWithPbkdf2("123456", salt, 2000), first);
  assert.notEqual(await hashPasscodeWithPbkdf2("123456", "ffeeddccbbaa99887766554433221100", 1000), first);
  assert.notEqual(await hashPasscodeWithPbkdf2("654321", salt, 1000), first);
});
