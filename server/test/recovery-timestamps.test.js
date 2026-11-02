import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { assertLocalTestDatabase } from "./helpers/db.js";
import {
  applyRecoveryMigrations,
  buildRecoveryApp,
  ledgerEntry,
  resetRecoveryDatabase,
  seedRecoveryDevice,
  signLedgerEntry,
  syncEntries
} from "./helpers/recovery.js";

assertLocalTestDatabase(config.databaseUrl);
const CONSERVATIVE_LIMIT = 8_000_000_000;
let app;

before(async () => {
  config.jwtSecret = config.jwtSecret || "recovery-timestamp-test-secret";
  config.serverReceiptSecret = config.serverReceiptSecret || "recovery-timestamp-receipt-secret";
  await applyRecoveryMigrations();
  app = await buildRecoveryApp();
});

beforeEach(resetRecoveryDatabase);

after(async () => {
  await app.close();
  await getPool().end();
});

async function syncTimestamp(rawValue, { missing = false } = {}) {
  const device = await seedRecoveryDevice({ status: "ACTIVE" });
  const entry = ledgerEntry(device, { confirmed_at: 1 });
  if (missing) delete entry.confirmed_at;
  else entry.confirmed_at = rawValue;
  signLedgerEntry(device, entry);
  const response = await syncEntries(app, device, [entry]);
  assert.equal(response.statusCode, 200, response.body);
  return Number((await query(
    `SELECT EXTRACT(EPOCH FROM confirmed_at)::text AS epoch
     FROM ledger_entries WHERE device_identity = $1 AND entry_id = 1`,
    [device.deviceIdentity]
  )).rows[0].epoch);
}

test("the real sync TO_TIMESTAMP path documents falsy-to-epoch behavior and representable values", async (t) => {
  // /sync/entries intentionally retains its existing Number(value || 0)
  // semantics. Recovery must classify every case below as unrepresentable so
  // it never substitutes epoch zero for the preserved raw original.
  for (const current of [
    { name: "numeric zero", value: 0 },
    { name: "missing", value: undefined, missing: true },
    { name: "empty string", value: "" },
    { name: "false", value: false },
    { name: "null", value: null }
  ]) {
    await t.test(current.name, async () => {
      assert.equal(await syncTimestamp(current.value, { missing: current.missing }), 0);
    });
  }

  for (const seconds of [-1, 1_000_000_000, -CONSERVATIVE_LIMIT, CONSERVATIVE_LIMIT]) {
    await t.test(String(seconds), async () => {
      assert.equal(await syncTimestamp(seconds), seconds);
      const direct = Number((await query(
        "SELECT EXTRACT(EPOCH FROM TO_TIMESTAMP($1))::text AS epoch",
        [seconds]
      )).rows[0].epoch);
      assert.equal(direct, seconds);
    });
  }
});

async function timestampAccepted(seconds) {
  try {
    await query("SELECT TO_TIMESTAMP($1)::text AS rendered", [seconds]);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, code: error.code, message: String(error.message || "") };
  }
}

async function greatestAcceptedMagnitude(sign) {
  let acceptedMagnitude = 0;
  let rejectedMagnitude = 1;
  while ((await timestampAccepted(sign * rejectedMagnitude)).accepted) {
    acceptedMagnitude = rejectedMagnitude;
    rejectedMagnitude *= 2;
    assert.ok(Number.isSafeInteger(rejectedMagnitude), "Postgres timestamp boundary must fit safe integer seconds");
  }
  while (rejectedMagnitude - acceptedMagnitude > 1) {
    const middle = Math.floor((acceptedMagnitude + rejectedMagnitude) / 2);
    if ((await timestampAccepted(sign * middle)).accepted) acceptedMagnitude = middle;
    else rejectedMagnitude = middle;
  }
  return sign > 0 ? acceptedMagnitude : -acceptedMagnitude;
}

test("discover and record the actual Postgres TO_TIMESTAMP integer-second bounds", async (t) => {
  const minimum = await greatestAcceptedMagnitude(-1);
  const maximum = await greatestAcceptedMagnitude(1);
  const below = await timestampAccepted(minimum - 1);
  const above = await timestampAccepted(maximum + 1);

  assert.ok(minimum < -CONSERVATIVE_LIMIT);
  assert.ok(maximum > CONSERVATIVE_LIMIT);
  assert.equal(below.accepted, false);
  assert.equal(above.accepted, false);
  assert.equal(below.code, "22008");
  assert.equal(above.code, "22008");
  assert.match(below.message, /timestamp out of range/i);
  assert.match(above.message, /timestamp out of range/i);
  t.diagnostic(JSON.stringify({
    postgres_to_timestamp_min_integer_seconds: minimum,
    postgres_to_timestamp_max_integer_seconds: maximum,
    failing_sqlstate: "22008",
    failing_error: "timestamp out of range",
    conservative_limit_seconds: CONSERVATIVE_LIMIT
  }));
});
