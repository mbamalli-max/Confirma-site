import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import Fastify from "fastify";
import { issueAuthToken } from "../../src/auth-utils.js";
import { config } from "../../src/config.js";
import { query } from "../../src/db.js";
import { computeLedgerEntryHash } from "../../src/ledger-canonical.js";
import { recoveryPartSha256, registerRecoveryRoutes } from "../../src/routes/recovery.js";
import { registerSyncRoutes } from "../../src/routes/sync.js";

export const EMPTY_HASH = "0".repeat(64);

export async function applyRecoveryMigrations() {
  await query(await readFile(new URL("../../schema.sql", import.meta.url), "utf8"));
  const directory = new URL("../../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of names) await query(await readFile(new URL(name, directory), "utf8"));
}

export async function resetRecoveryDatabase() {
  await query("TRUNCATE recovery_audit_events, ledger_integrity_events, users RESTART IDENTITY CASCADE");
}

export async function buildRecoveryApp({ logger = false } = {}) {
  const app = Fastify({ logger });
  await registerSyncRoutes(app);
  await registerRecoveryRoutes(app);
  await app.ready();
  return app;
}

function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    publicKey: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y })
  };
}

export async function seedRecoveryDevice({ accountClaim = true, status = "FORKED", userId = null } = {}) {
  const suffix = crypto.randomBytes(6).toString("hex");
  let ownerId = userId;
  let phone;
  if (!ownerId) {
    phone = `+1202${crypto.randomInt(1_000_000, 9_999_999)}`;
    ownerId = (await query(
      `INSERT INTO users (phone_number, email) VALUES ($1, $2) RETURNING id`,
      [phone, `recovery-${suffix}@example.test`]
    )).rows[0].id;
  } else {
    phone = (await query("SELECT phone_number FROM users WHERE id = $1", [ownerId])).rows[0].phone_number;
  }
  const keys = keyPair();
  const deviceIdentity = crypto.randomBytes(16).toString("hex");
  await query(
    `
      INSERT INTO device_identities (device_identity, public_key, phone_number, user_id, status)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [deviceIdentity, keys.publicKey, phone, ownerId, status]
  );
  const sessionId = crypto.randomUUID();
  await query(
    `INSERT INTO user_sessions (id, user_id, device_identity) VALUES ($1, $2, $3)`,
    [sessionId, ownerId, deviceIdentity]
  );
  const claims = { sid: sessionId, ...(accountClaim ? { account_id: ownerId } : {}) };
  const token = issueAuthToken(phone, deviceIdentity, claims);
  return {
    userId: ownerId,
    phone,
    deviceIdentity,
    privateKey: keys.privateKey,
    sessionId,
    token,
    headers: { authorization: `Bearer ${token}`, "x-device-identity": deviceIdentity },
    head: { id: 0, hash: EMPTY_HASH }
  };
}

export function ledgerEntry(device, fields = {}) {
  const id = fields.id ?? device.head.id + 1;
  const entry = {
    transaction_type: "sale",
    normalized_label: `recovery-${id}-${device.deviceIdentity.slice(0, 8)}`,
    amount_minor: 1000 + id,
    currency: "NGN",
    counterparty: null,
    business_type_id: "ng_market_trader",
    country: "NG",
    source_account: null,
    destination_account: null,
    reversed_entry_hash: null,
    reversed_transaction_type: null,
    device_identity: device.deviceIdentity,
    ...fields,
    id,
    confirmed_at: fields.confirmed_at ?? 1793000000 + id,
    prev_entry_hash: fields.prev_entry_hash ?? device.head.hash
  };
  return signLedgerEntry(device, entry);
}

export function signLedgerEntry(device, entry) {
  entry.entry_hash = computeLedgerEntryHash(entry);
  entry.signature = crypto.sign(
    "sha256",
    Buffer.from(entry.entry_hash, "utf8"),
    { key: device.privateKey, dsaEncoding: "ieee-p1363" }
  ).toString("base64");
  return entry;
}

export function recoveryPartDeclaration(parts) {
  const part_hashes = parts.map((part, part_no) => ({
    part_no,
    sha256: recoveryPartSha256(part)
  }));
  return { part_count: parts.length, part_hashes };
}

export async function uploadRecoveryParts(app, device, recoveryId, parts) {
  const declaration = recoveryPartDeclaration(parts);
  const responses = [];
  for (let partNo = 0; partNo < parts.length; partNo += 1) {
    responses.push(await app.inject({
      method: "PUT",
      url: `/recovery/sessions/${recoveryId}/parts/${partNo}`,
      headers: device.headers,
      payload: {
        sha256: declaration.part_hashes[partNo].sha256,
        ...declaration,
        ...parts[partNo]
      }
    }));
  }
  return { declaration, responses };
}

export function advanceHead(device, entry) {
  device.head = { id: entry.id, hash: entry.entry_hash };
}

export async function syncEntries(app, device, entries) {
  return app.inject({
    method: "POST",
    url: "/sync/entries",
    headers: device.headers,
    payload: { device_identity: device.deviceIdentity, entries }
  });
}

export async function createRecovery(app, device, recoveryId = crypto.randomUUID()) {
  const response = await app.inject({
    method: "POST",
    url: "/recovery/sessions",
    headers: device.headers,
    payload: {
      recovery_id: recoveryId,
      device_identity: device.deviceIdentity,
      app_version: "recovery-test",
      local_summary: { records: 1, queue: 0 }
    }
  });
  return { recoveryId, response };
}

export function setRecoveryAutoclear(value) {
  config.recoveryAutoclear = value;
}
