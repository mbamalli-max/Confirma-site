import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { issueAuthToken } from "../src/auth-utils.js";
import { buildLedgerHashCanonicalString, computeLedgerEntryHash } from "../src/ledger-canonical.js";
import { registerSyncRoutes } from "../src/routes/sync.js";
import { registerAttestRoutes } from "../src/routes/attest.js";
import { registerPaymentRoutes } from "../src/routes/payment.js";
import { appSourceAtRevision, extractHasherSources, hasherFromSources, loadAppHasher, sha256Hex } from "../scripts/generate-ledger-hash-vectors.mjs";
import { registerIdentityRoutes } from "../src/routes/identity.js";
import { assertLocalTestDatabase } from "./helpers/db.js";
import { auditLedgerHashes } from "../scripts/audit-ledger-hashes.mjs";

// T4: the server accepts a record only when its fields hash to the signed
// entry_hash, and a rejected conflicting submission is recorded durably.
// FORKED means a conflicting submission was detected; not that the chain is corrupt.

assertLocalTestDatabase(config.databaseUrl);
const vectors = JSON.parse(await readFile(new URL("./fixtures/ledger-hash-vectors.json", import.meta.url), "utf8"));
const app = Fastify({ logger: false });
const EMPTY_HASH = "0".repeat(64);
const ALLOWED_DETAIL_KEYS = new Set([
  "stored_entry_hash", "received_entry_hash", "expected_prev_entry_hash", "received_prev_entry_hash", "computed_entry_hash"
]);

async function applyAllMigrations() {
  await query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of names) await query(await readFile(new URL(name, directory), "utf8"));
  await query("ALTER TABLE attestations ADD COLUMN IF NOT EXISTS attestation_scope TEXT");
  await query("ALTER TABLE attestations ADD COLUMN IF NOT EXISTS scope_description TEXT");
}

async function resetDatabase() {
  await query(`
    TRUNCATE ledger_integrity_events, payments, attestations, ledger_entries, key_rotation_events,
      user_sessions, device_identities, profiles, users RESTART IDENTITY CASCADE
  `);
}

function deviceKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return { privateKey, publicKeyJson: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }) };
}

async function addDevice(phone, userId, label) {
  const keys = deviceKeys();
  const deviceIdentity = crypto.randomBytes(16).toString("hex");
  await query(
    `INSERT INTO device_identities (device_identity, public_key, phone_number, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [deviceIdentity, keys.publicKeyJson, phone]
  );
  const sessionId = crypto.randomUUID();
  await query(
    `INSERT INTO user_sessions (id, user_id, device_identity, created_at) VALUES ($1, $2, $3, NOW())`,
    [sessionId, userId, deviceIdentity]
  );
  const token = issueAuthToken(phone, deviceIdentity, { sid: sessionId });
  return {
    label,
    phone,
    deviceIdentity,
    keys,
    head: { id: 0, hash: EMPTY_HASH },
    headers: { authorization: `Bearer ${token}`, "x-device-identity": deviceIdentity }
  };
}

async function seedAccount() {
  const suffix = crypto.randomBytes(5).toString("hex");
  const phone = `+1202${crypto.randomInt(1_000_000, 9_999_999)}`;
  const user = (await query(
    `INSERT INTO users (phone_number, email, email_verified) VALUES ($1, $2, TRUE) RETURNING id`,
    [phone, `binding-${suffix}@example.test`]
  )).rows[0];
  const device = await addDevice(phone, user.id, "primary");
  return { ...device, userId: user.id };
}

function signHash(device, entryHash) {
  return crypto.sign("sha256", Buffer.from(entryHash, "utf8"), { key: device.keys.privateKey, dsaEncoding: "ieee-p1363" })
    .toString("base64");
}

// A genuine entry exactly as the app builds it: fields → canonical hash → signature.
function genuineEntry(device, fields = {}) {
  const id = device.head.id + 1;
  const entry = {
    transaction_type: "sale",
    // Unique per device: ledger_entries has a global unique index on entry_hash.
    normalized_label: `item ${id} ${device.deviceIdentity.slice(0, 8)}`,
    label: `Item ${id}`,
    amount_minor: 1000 * id,
    currency: "NGN",
    counterparty: null,
    business_type_id: "ng_market_trader",
    country: "NG",
    sector_id: "trade_retail",
    ...fields,
    id,
    confirmed_at: 1793000000 + id,
    prev_entry_hash: device.head.hash
  };
  entry.entry_hash = computeLedgerEntryHash(entry);
  entry.signature = signHash(device, entry.entry_hash);
  return entry;
}

function advance(device, entry) {
  device.head = { id: entry.id, hash: entry.entry_hash };
}

async function sync(device, entries) {
  return app.inject({
    method: "POST",
    url: "/sync/entries",
    headers: device.headers,
    payload: { device_identity: device.deviceIdentity, entries }
  });
}

async function syncGenuine(device, fields) {
  const entry = genuineEntry(device, fields);
  const response = await sync(device, [entry]);
  assert.equal(response.statusCode, 200, response.body);
  advance(device, entry);
  return { entry, response };
}

async function events(deviceIdentity) {
  return (await query(
    "SELECT kind, entry_id, detail FROM ledger_integrity_events WHERE device_identity = $1 ORDER BY id",
    [deviceIdentity]
  )).rows;
}

async function deviceRow(deviceIdentity) {
  return (await query("SELECT * FROM device_identities WHERE device_identity = $1", [deviceIdentity])).rows[0];
}

async function storedEntries(deviceIdentity) {
  return (await query(
    "SELECT entry_id, entry_hash, payload FROM ledger_entries WHERE device_identity = $1 ORDER BY entry_id",
    [deviceIdentity]
  )).rows;
}

async function historyFingerprint() {
  const tables = ["ledger_entries", "attestations", "payments"];
  const parts = [];
  for (const table of tables) {
    const rows = (await query(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY 1`)).rows.map((r) => r.row);
    parts.push(`${table}:${rows.join("\n")}`);
  }
  return crypto.createHash("sha256").update(parts.join("\n--\n")).digest("hex");
}

before(async () => {
  config.jwtSecret = config.jwtSecret || "ledger-hash-binding-test-secret";
  config.serverReceiptSecret = config.serverReceiptSecret || "ledger-hash-binding-receipt-secret";
  config.resendApiKey = "";
  await applyAllMigrations();
  // No rate-limit plugin: the per-route limits stay inactive, so no 429 can come from them.
  await registerSyncRoutes(app);
  await registerAttestRoutes(app);
  await registerPaymentRoutes(app);
  await registerIdentityRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  await resetDatabase();
});

after(async () => {
  await app.close();
  await getPool().end();
});

test("H1: the server's hash form equals each recorded app version's own code, checked against git", async () => {
  assert.deepEqual(vectors.sources.map((source) => source.rev), ["96b0d74", "96a7b22", "a3d6c25"]);
  assert.equal(new Set(vectors.sources.map((source) => source.app_js_sha256)).size, 3, "three distinct app sources");
  let gitAvailable = true;
  for (const source of vectors.sources) {
    let gitSource = null;
    try { gitSource = appSourceAtRevision(source.rev); } catch { gitAvailable = false; }
    if (gitSource !== null) {
      assert.equal(sha256Hex(gitSource), source.app_js_sha256, `${source.rev}: app.js matches git`);
      assert.deepEqual(extractHasherSources(gitSource), {
        canonical_source: source.canonical_source,
        sha256_source: source.sha256_source
      }, `${source.rev}: extracted functions match git`);
    }
    const hasher = hasherFromSources(source);
    for (const vector of vectors.vectors) {
      const { id, confirmed_at: confirmedAt, prev_entry_hash: prevHash } = vector.entry;
      const canonical = hasher.buildLedgerHashCanonicalString(vector.entry, id, confirmedAt, prevHash);
      assert.equal(canonical, vector.canonical, `${source.rev}: ${vector.name}`);
      assert.equal(await hasher.sha256(canonical), vector.entry_hash, `${source.rev} hash: ${vector.name}`);
    }
  }
  assert.ok(gitAvailable, "git history is needed to prove provenance in this repository");
  // The server, and the app as it is in this working tree, agree with every vector.
  const workingApp = loadAppHasher(await readFile(new URL("../../app-v3/app.js", import.meta.url), "utf8"));
  for (const vector of vectors.vectors) {
    assert.equal(buildLedgerHashCanonicalString(vector.entry), vector.canonical, vector.name);
    assert.equal(computeLedgerEntryHash(vector.entry), vector.entry_hash, vector.name);
    const { id, confirmed_at: confirmedAt, prev_entry_hash: prevHash } = vector.entry;
    assert.equal(workingApp.buildLedgerHashCanonicalString(vector.entry, id, confirmedAt, prevHash), vector.canonical);
  }
});

test("H11: the documented pipe-join collision is reproduced, not hidden", () => {
  const [a, b] = ["pipe collision A (known limitation)", "pipe collision B (known limitation)"]
    .map((name) => vectors.vectors.find((vector) => vector.name === name));
  assert.notDeepEqual(a.entry, b.entry);
  assert.equal(a.canonical, b.canonical);
  assert.equal(computeLedgerEntryHash(a.entry), computeLedgerEntryHash(b.entry));
});

test("H2: a genuine entry syncs and its stored payload equals the sent fields", async () => {
  const device = await seedAccount();
  const { entry, response } = await syncGenuine(device);
  assert.equal(response.json().synced_count, 1);
  assert.equal(response.json().fork_status, "NORMAL");
  const [stored] = await storedEntries(device.deviceIdentity);
  assert.equal(stored.entry_hash, entry.entry_hash);
  assert.deepEqual(stored.payload, entry);
  assert.deepEqual(await events(device.deviceIdentity), []);
});

for (const [field, value] of [
  ["amount_minor", 999999],
  ["normalized_label", "something else"],
  ["transaction_type", "purchase"],
  ["counterparty", "Someone"],
  ["confirmed_at", 1793999999]
]) {
  test(`H3: changing ${field} under the original hash and signature is rejected and recorded`, async () => {
    const device = await seedAccount();
    await syncGenuine(device);
    const tampered = { ...genuineEntry(device), [field]: value };
    const response = await sync(device, [tampered]);
    assert.equal(response.statusCode, 400, response.body);
    assert.deepEqual(response.json(), { error: "entry_hash_mismatch" });
    assert.equal((await storedEntries(device.deviceIdentity)).length, 1);
    const recorded = await events(device.deviceIdentity);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].kind, "hash_mismatch");
    assert.equal(Number(recorded[0].entry_id), tampered.id);
    assert.equal(recorded[0].detail.received_entry_hash, tampered.entry_hash);
    assert.equal(recorded[0].detail.computed_entry_hash, computeLedgerEntryHash(tampered));
    // A hash mismatch is not a fork.
    assert.equal((await deviceRow(device.deviceIdentity)).status, "ACTIVE");
  });
}

test("H3b: the recompute runs before signature verification (a tampered entry with a bad signature is a mismatch)", async () => {
  const device = await seedAccount();
  const tampered = { ...genuineEntry(device), amount_minor: 5, signature: Buffer.alloc(64, 7).toString("base64") };
  const response = await sync(device, [tampered]);
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(response.json(), { error: "entry_hash_mismatch" });
  // And a genuine entry with a bad signature is still refused by the signature check.
  const badSignature = { ...genuineEntry(device), signature: Buffer.alloc(64, 9).toString("base64") };
  const signatureResponse = await sync(device, [badSignature]);
  assert.equal(signatureResponse.statusCode, 400, signatureResponse.body);
  assert.match(signatureResponse.json().error, /Signature verification failed/);
});

test("H4: fields outside the hash (label, sector_id) are not bound", async () => {
  const device = await seedAccount();
  const entry = { ...genuineEntry(device), label: "A different display label", sector_id: "food_hospitality" };
  const response = await sync(device, [entry]);
  assert.equal(response.statusCode, 200, response.body);
  const [stored] = await storedEntries(device.deviceIdentity);
  assert.equal(stored.payload.label, "A different display label");
});

test("H5: an identical resend is idempotent; the same id with another hash is a conflicting submission", async () => {
  const device = await seedAccount();
  const { entry } = await syncGenuine(device);
  const resend = await sync(device, [{ ...entry, label: "changed on resend" }]);
  assert.equal(resend.statusCode, 200, resend.body);
  assert.equal(resend.json().synced_count, 0);
  const [stored] = await storedEntries(device.deviceIdentity);
  assert.deepEqual(stored.payload, entry, "a duplicate never re-stores its payload");

  device.head = { id: 0, hash: EMPTY_HASH };
  const conflicting = genuineEntry(device, { normalized_label: "another first entry" });
  const response = await sync(device, [conflicting]);
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error, /Fork detected for an existing entry id/);
  const recorded = await events(device.deviceIdentity);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, "fork_id_conflict");
  assert.equal(recorded[0].detail.stored_entry_hash, entry.entry_hash);
  assert.equal((await deviceRow(device.deviceIdentity)).status, "FORKED");
});

test("H6: a continuity break is recorded and FORKED survives the rejected batch; /verify shows it", async () => {
  const device = await seedAccount();
  await syncGenuine(device);
  const attest = await app.inject({
    method: "POST",
    url: "/attest",
    headers: device.headers,
    payload: { device_identity: device.deviceIdentity, window_days: 0 }
  });
  assert.equal(attest.statusCode, 200, attest.body);

  const broken = genuineEntry({ ...device, head: { id: device.head.id, hash: "9".repeat(64) } });
  const response = await sync(device, [broken]);
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error, /Hash chain continuity failed/);
  assert.equal((await storedEntries(device.deviceIdentity)).length, 1, "nothing from the rejected batch is stored");
  const recorded = await events(device.deviceIdentity);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, "fork_continuity");
  assert.equal(recorded[0].detail.expected_prev_entry_hash, device.head.hash);
  assert.equal(recorded[0].detail.received_prev_entry_hash, "9".repeat(64));
  assert.equal((await deviceRow(device.deviceIdentity)).status, "FORKED");
  const verify = await app.inject({ method: "GET", url: `/verify/${attest.json().vt_id}` });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().status, "VALID", "earlier attestations stay valid");
  assert.equal(verify.json().fork_status, "FORKED");
});

test("H7/H7b: after a conflict, valid records still sync but FORKED stays and new reports are refused", async () => {
  const device = await seedAccount();
  await syncGenuine(device);
  const broken = genuineEntry({ ...device, head: { id: device.head.id, hash: "8".repeat(64) } });
  assert.equal((await sync(device, [broken])).statusCode, 409);

  const { response } = await syncGenuine(device);
  assert.equal(response.json().synced_count, 1);
  assert.equal(response.json().fork_status, "FORKED");
  assert.equal((await deviceRow(device.deviceIdentity)).status, "FORKED");

  const attest = await app.inject({
    method: "POST", url: "/attest", headers: device.headers,
    payload: { device_identity: device.deviceIdentity, window_days: 0 }
  });
  assert.equal(attest.statusCode, 403, attest.body);
  assert.match(attest.json().error, /Device is not active/);
  const report = await app.inject({
    method: "POST", url: "/report/generate-pdf", headers: device.headers, payload: { window_days: 0 }
  });
  assert.notEqual(report.statusCode, 200, report.body);
  assert.match(report.body, /Device is not active/);

  // Another active device of the same account is unaffected.
  const other = await addDevice(device.phone, device.userId, "second");
  await syncGenuine(other);
  const otherAttest = await app.inject({
    method: "POST", url: "/attest", headers: other.headers,
    payload: { device_identity: other.deviceIdentity, window_days: 0 }
  });
  assert.equal(otherAttest.statusCode, 200, otherAttest.body);
});

test("H7c: the FORKED update changes only status; a revoked device is refused before any chain check", async () => {
  const device = await seedAccount();
  await syncGenuine(device);
  const before = await deviceRow(device.deviceIdentity);
  const broken = genuineEntry({ ...device, head: { id: device.head.id, hash: "7".repeat(64) } });
  assert.equal((await sync(device, [broken])).statusCode, 409);
  const afterRow = await deviceRow(device.deviceIdentity);
  for (const column of ["revoked_at", "phone_number", "public_key", "receipt_counter", "last_synced_entry_id", "rotated_to", "created_at"]) {
    assert.deepEqual(afterRow[column], before[column], column);
  }
  assert.equal(afterRow.status, "FORKED");

  const revoked = await seedAccount();
  await syncGenuine(revoked);
  await query("UPDATE device_identities SET revoked_at = NOW() WHERE device_identity = $1", [revoked.deviceIdentity]);
  const revokedBroken = genuineEntry({ ...revoked, head: { id: revoked.head.id, hash: "6".repeat(64) } });
  const response = await sync(revoked, [revokedBroken]);
  assert.equal(response.statusCode, 401, response.body);
  // Refused before any chain check: by the session guard (session_invalid) or the route (device_revoked).
  assert.match(response.json().error, /session_invalid|device_revoked/);
  assert.deepEqual(await events(revoked.deviceIdentity), []);
});

test("H8: five sequential mismatches in a minute record one event", async () => {
  const device = await seedAccount();
  for (let index = 0; index < 5; index += 1) {
    const response = await sync(device, [{ ...genuineEntry(device), amount_minor: 10 + index }]);
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal((await events(device.deviceIdentity)).length, 1);
});

test("H8b: five overlapping mismatches for one device record one event (the device lock holds)", async () => {
  const device = await seedAccount();
  const blocker = await getPool().connect();
  let requests = [];
  try {
    // Hold inserts on the event table so every failing request reaches the insert at once.
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE ledger_integrity_events IN SHARE MODE");
    requests = Array.from({ length: 5 }, (_, index) => sync(device, [{ ...genuineEntry(device), amount_minor: 20 + index }]));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = (await query(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type IN ('Lock', 'Advisory')
           AND (query ILIKE '%ledger_integrity_events%' OR query ILIKE '%pg_advisory_xact_lock%')`
      )).rows[0].n;
      if (waiting >= 5) break;
      if (Date.now() > deadline) throw new Error(`only ${waiting} requests reached the event step`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await blocker.query("COMMIT");
  } finally {
    blocker.release();
  }
  const responses = await Promise.all(requests);
  for (const response of responses) assert.equal(response.statusCode, 400, response.body);
  assert.equal((await events(device.deviceIdentity)).length, 1);
});

test("H9: integrity event details hold hashes and ids only", async () => {
  const device = await seedAccount();
  await syncGenuine(device, { counterparty: "Private Person", normalized_label: "private label" });
  await sync(device, [{ ...genuineEntry(device), amount_minor: 4242 }]);
  const conflict = await seedAccount();
  await syncGenuine(conflict);
  await sync(conflict, [genuineEntry({ ...conflict, head: { id: conflict.head.id, hash: "5".repeat(64) } })]);
  const rows = (await query("SELECT detail::text AS text, detail FROM ledger_integrity_events")).rows;
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    for (const key of Object.keys(row.detail)) assert.ok(ALLOWED_DETAIL_KEYS.has(key), key);
    assert.doesNotMatch(row.text, /4242|Private Person|private label|\+1202|NGN/);
  }
});

test("H10: migration 020 follows 019, applies once over populated pre-020 history without changing it, and reruns", async () => {
  const names = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  assert.equal(names.at(-1), "020_ledger_integrity_events.sql");
  assert.equal(names.at(-2), "019_otp_verify_failures.sql");
  const device = await seedAccount();
  await syncGenuine(device);
  await syncGenuine(device);
  await query("DROP TABLE ledger_integrity_events"); // the database as it is before 020
  try {
    const before = await historyFingerprint();
    const sql = await readFile(new URL("../migrations/020_ledger_integrity_events.sql", import.meta.url), "utf8");
    await query(sql);
    assert.equal(await historyFingerprint(), before, "first application changes no history");
    assert.equal((await query("SELECT to_regclass('ledger_integrity_events') AS t")).rows[0].t, "ledger_integrity_events");
    await query(sql);
    assert.equal(await historyFingerprint(), before, "rerun is a no-op");
  } finally {
    await applyAllMigrations();
  }
});

test("H12: the pre-deploy audit counts matches, mismatches and unparseable rows, read-only", async () => {
  const device = await seedAccount();
  await syncGenuine(device);
  await syncGenuine(device);
  // An altered stored payload (never produced by the route) and an unparseable one.
  await query(
    `UPDATE ledger_entries SET payload = jsonb_set(payload, '{amount_minor}', '1') WHERE device_identity = $1 AND entry_id = 2`,
    [device.deviceIdentity]
  );
  await query(
    `INSERT INTO ledger_entries (device_identity, entry_id, entry_hash, prev_entry_hash, signature, confirmed_at, payload)
     VALUES ($1, 3, $2, $3, 'sig', NOW(), '["not", "an", "object"]'::jsonb)`,
    [device.deviceIdentity, "4".repeat(64), device.head.hash]
  );
  const before = await historyFingerprint();
  const counts = await auditLedgerHashes(getPool());
  assert.deepEqual(counts, { total: 3, match: 1, mismatch: 1, unparseable: 1 });
  assert.equal(await historyFingerprint(), before);
});

test("H13: two overlapping syncs of the same records both succeed once, with no false conflict", async () => {
  const device = await seedAccount();
  const first = genuineEntry(device);
  advance(device, first);
  const second = genuineEntry(device);
  const blocker = await getPool().connect();
  let requests = [];
  try {
    // Hold inserts so both requests reach the write together unless the device lock serializes them.
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE ledger_entries IN SHARE MODE");
    requests = [sync(device, [first, second]), sync(device, [first, second])];
    const deadline = Date.now() + 10_000;
    for (;;) {
      const waiting = (await query(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
      )).rows[0].n;
      if (waiting >= 2) break;
      if (Date.now() > deadline) throw new Error(`only ${waiting} requests waiting`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await blocker.query("COMMIT");
  } finally {
    blocker.release();
  }
  const responses = await Promise.all(requests);
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(responses.map((response) => response.json().synced_count).sort(), [0, 2]);
  assert.equal((await storedEntries(device.deviceIdentity)).length, 2);
  assert.deepEqual(await events(device.deviceIdentity), []);
  assert.equal((await deviceRow(device.deviceIdentity)).status, "ACTIVE");
  const counters = responses.map((response) => response.json().receipt_counter).sort();
  assert.deepEqual(counters, [1, 2], "receipt counters are not reused");
});

test("H14: a session can only submit records for its own device", async () => {
  const device = await seedAccount();
  await syncGenuine(device);
  const other = await addDevice(device.phone, device.userId, "second");
  const response = await app.inject({
    method: "POST",
    url: "/sync/entries",
    headers: other.headers,
    payload: {
      device_identity: device.deviceIdentity,
      entries: [genuineEntry({ ...device, head: { id: device.head.id, hash: "3".repeat(64) } })]
    }
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(await events(device.deviceIdentity), []);
  assert.equal((await deviceRow(device.deviceIdentity)).status, "ACTIVE");
});

test("H15: if the integrity record can't be written, the rejection fails closed (503) and nothing is claimed", async () => {
  const device = await seedAccount();
  await syncGenuine(device);
  await query("ALTER TABLE ledger_integrity_events RENAME TO ledger_integrity_events_hidden");
  try {
    const mismatch = await sync(device, [{ ...genuineEntry(device), amount_minor: 77 }]);
    assert.equal(mismatch.statusCode, 503, mismatch.body);
    assert.deepEqual(mismatch.json(), { error: "integrity_record_unavailable" });
    const fork = await sync(device, [genuineEntry({ ...device, head: { id: device.head.id, hash: "2".repeat(64) } })]);
    assert.equal(fork.statusCode, 503, fork.body);
  } finally {
    await query("ALTER TABLE ledger_integrity_events_hidden RENAME TO ledger_integrity_events");
  }
  assert.equal((await storedEntries(device.deviceIdentity)).length, 1, "the rejected batches stored nothing");
});

test("H16: rotating a FORKED device keeps its marker, and a rotated device is not reactivated by a sync", async () => {
  const device = await seedAccount();
  await syncGenuine(device);
  assert.equal((await sync(device, [genuineEntry({ ...device, head: { id: device.head.id, hash: "1".repeat(64) } })])).statusCode, 409);
  assert.equal((await deviceRow(device.deviceIdentity)).status, "FORKED");

  const challenge = await app.inject({
    method: "POST", url: "/identity/rotate/challenge", headers: device.headers,
    payload: { old_device_identity: device.deviceIdentity }
  });
  assert.equal(challenge.statusCode, 200, challenge.body);
  const fresh = deviceKeys();
  const newDeviceIdentity = crypto.randomBytes(16).toString("hex");
  const nonce = challenge.json().challenge_nonce;
  const message = `${nonce}|${newDeviceIdentity}|${fresh.publicKeyJson}`;
  const signature = crypto.sign("sha256", Buffer.from(message, "utf8"), { key: device.keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  const rotate = await app.inject({
    method: "POST", url: "/identity/rotate", headers: device.headers,
    payload: {
      old_device_identity: device.deviceIdentity,
      new_device_identity: newDeviceIdentity,
      new_public_key: fresh.publicKeyJson,
      challenge_nonce: nonce,
      challenge_signature: signature
    }
  });
  assert.equal(rotate.statusCode, 200, rotate.body);
  const oldRow = await deviceRow(device.deviceIdentity);
  assert.equal(oldRow.status, "FORKED", "rotation does not erase the conflict marker");
  assert.equal(oldRow.rotated_to, newDeviceIdentity);

  const rotated = await seedAccount();
  await syncGenuine(rotated);
  await query("UPDATE device_identities SET status = 'ROTATED' WHERE device_identity = $1", [rotated.deviceIdentity]);
  await syncGenuine(rotated);
  assert.equal((await deviceRow(rotated.deviceIdentity)).status, "ROTATED");
});
