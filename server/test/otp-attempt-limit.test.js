import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { config } from "../src/config.js";
import { getPool } from "../src/db.js";
import { hashOtp, normalizeEmail } from "../src/auth-utils.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import {
  assertLocalTestDatabase,
  createTestPool,
  getBackendPid,
  resetTestDatabase,
  waitForBackendsBlockedBy
} from "./helpers/db.js";

assertLocalTestDatabase(config.databaseUrl);

const LOCK_MESSAGE = "Too many failed attempts. Try again in 15 minutes.";
const FAILURE_MESSAGE = "OTP verification failed.";
const appPool = getPool();
appPool.options.max = Math.max(appPool.options.max || 10, 25);
const database = createTestPool(config.databaseUrl, config.databaseSsl);
const app = Fastify({ logger: false });

config.allowDevOtp = true;
config.resendApiKey = "";
config.jwtSecret = config.jwtSecret || "otp-attempt-limit-test-secret";

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function testIdentity(prefix) {
  const suffix = unique(prefix);
  return {
    email: `${suffix}@example.test`,
    phone: `+1202${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
    deviceIdentity: `device-${suffix}`
  };
}

async function requestCode(identity, targetApp = app) {
  const response = await targetApp.inject({
    method: "POST",
    url: "/auth/otp/request",
    payload: {
      channel: "email",
      email: identity.email,
      phone_number: identity.phone
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.json().dev_code, /^\d{6}$/);
  return response.json().dev_code;
}

function verify(identity, code, targetApp = app) {
  return targetApp.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: {
      channel: "email",
      email: identity.email,
      phone_number: identity.phone,
      code,
      device_identity: identity.deviceIdentity,
      public_key: `public-key-${identity.deviceIdentity}`
    }
  });
}

function wrongCodeFor(code) {
  return code === "000000" ? "000001" : "000000";
}

async function expectWrong(identity, wrongCode, targetApp = app) {
  const response = await verify(identity, wrongCode, targetApp);
  assert.equal(response.statusCode, 401, response.body);
  assert.deepEqual(response.json(), { error: FAILURE_MESSAGE });
}

async function failureCount(identity, channel = "email") {
  const result = await database.query(
    `
      SELECT COUNT(*)::int AS count
      FROM otp_verify_failures
      WHERE identifier = $1 AND channel = $2
    `,
    [normalizeEmail(identity.email), channel]
  );
  return result.rows[0].count;
}

async function lockIdentifier(client, identity, channel = "email") {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`${channel}:${normalizeEmail(identity.email)}`]
  );
}

before(async () => {
  const migrationSql = await readFile(
    new URL("../migrations/019_otp_verify_failures.sql", import.meta.url),
    "utf8"
  );
  await database.query(migrationSql);
  await registerAuthRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  config.smsProviderEnabled = false;
  await resetTestDatabase(database);
});

after(async () => {
  try {
    await app.close();
  } finally {
    try {
      await appPool.end();
    } finally {
      await database.end();
    }
  }
});

test("O1: correct code on the first try succeeds", async () => {
  const identity = testIdentity("first");
  const code = await requestCode(identity);
  const response = await verify(identity, code);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().ok, true);
  assert.equal(await failureCount(identity), 0);
});

test("O2: four wrong guesses followed by the correct code succeed", async () => {
  const identity = testIdentity("four");
  const code = await requestCode(identity);
  const wrongCode = wrongCodeFor(code);
  for (let attempt = 0; attempt < 4; attempt += 1) await expectWrong(identity, wrongCode);
  const response = await verify(identity, code);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(await failureCount(identity), 4);
});

test("O3: five wrong guesses lock the correct sixth attempt without issuing a session", async () => {
  const identity = testIdentity("five");
  const code = await requestCode(identity);
  const wrongCode = wrongCodeFor(code);
  for (let attempt = 0; attempt < 5; attempt += 1) await expectWrong(identity, wrongCode);
  const response = await verify(identity, code);
  assert.equal(response.statusCode, 429, response.body);
  assert.deepEqual(response.json(), { error: LOCK_MESSAGE });
  const sessions = await database.query(
    "SELECT COUNT(*)::int AS count FROM user_sessions WHERE device_identity = $1",
    [identity.deviceIdentity]
  );
  assert.equal(sessions.rows[0].count, 0);
});

test("O4: requesting a new code does not reset five failures", async () => {
  const identity = testIdentity("replacement");
  const firstCode = await requestCode(identity);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expectWrong(identity, wrongCodeFor(firstCode));
  }
  const secondCode = await requestCode(identity);
  const response = await verify(identity, secondCode);
  assert.equal(response.statusCode, 429, response.body);
  assert.deepEqual(response.json(), { error: LOCK_MESSAGE });
});

test("O5: failures older than fifteen minutes do not count", async () => {
  const identity = testIdentity("expired-lock");
  const code = await requestCode(identity);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expectWrong(identity, wrongCodeFor(code));
  }
  await database.query(
    `
      UPDATE otp_verify_failures
      SET failed_at = clock_timestamp() - INTERVAL '15 minutes 1 second'
      WHERE identifier = $1 AND channel = 'email'
    `,
    [normalizeEmail(identity.email)]
  );
  const response = await verify(identity, code);
  assert.equal(response.statusCode, 200, response.body);
});

test("O6: failure limits are isolated by identifier and channel", async () => {
  const identityA = testIdentity("isolation-a");
  const identityB = testIdentity("isolation-b");
  const codeA = await requestCode(identityA);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expectWrong(identityA, wrongCodeFor(codeA));
  }
  const codeB = await requestCode(identityB);
  assert.equal((await verify(identityB, codeB)).statusCode, 200);

  const identityC = testIdentity("isolation-channel");
  await database.query(
    `
      INSERT INTO otp_verify_failures (identifier, channel)
      SELECT $1, 'sms' FROM generate_series(1, 5)
    `,
    [normalizeEmail(identityC.email)]
  );
  const codeC = await requestCode(identityC);
  assert.equal((await verify(identityC, codeC)).statusCode, 200);
});

test("O7/O7b: ten overlapping guesses produce exactly five failures and five account locks", async () => {
  let hookArrivals = 0;
  let releaseHook;
  const hookGate = new Promise((resolve) => { releaseHook = resolve; });
  const concurrencyApp = Fastify({ logger: false });
  let blocker;
  let blockerOpen = false;
  let requests = [];
  let queuedBehindLock;
  let markAllReachedHook;
  const allReachedHook = new Promise((resolve) => { markAllReachedHook = resolve; });
  try {
    await registerAuthRoutes(concurrencyApp, {
      afterOtpFailureLimitCheck: async () => {
        hookArrivals += 1;
        if (hookArrivals === 10) {
          markAllReachedHook("hook");
          releaseHook();
        }
        await hookGate;
      }
    });
    await concurrencyApp.ready();

    const identity = testIdentity("concurrent");
    const code = await requestCode(identity, concurrencyApp);
    blocker = await database.connect();
    await blocker.query("BEGIN");
    blockerOpen = true;
    const blockerPid = await getBackendPid(blocker);
    await lockIdentifier(blocker, identity);
    requests = Array.from({ length: 10 }, () => (
      verify(identity, wrongCodeFor(code), concurrencyApp)
    ));

    queuedBehindLock = waitForBackendsBlockedBy(
      database,
      blockerPid,
      Array.from({ length: 10 }, () => /pg_advisory_xact_lock/),
      5000
    ).then(() => "locked").catch(() => "not-locked");
    await Promise.race([queuedBehindLock, allReachedHook]);
    await blocker.query("COMMIT");
    blockerOpen = false;
    releaseHook();

    const responses = await Promise.all(requests);
    const unauthorized = responses.filter((response) => response.statusCode === 401);
    const locked = responses.filter((response) => response.statusCode === 429);
    assert.equal(unauthorized.length, 5, responses.map((response) => response.body).join("\n"));
    assert.equal(locked.length, 5, responses.map((response) => response.body).join("\n"));
    for (const response of locked) assert.deepEqual(response.json(), { error: LOCK_MESSAGE });
    assert.equal(await failureCount(identity), 5);

    const correct = await verify(identity, code, concurrencyApp);
    assert.equal(correct.statusCode, 429, correct.body);
    assert.deepEqual(correct.json(), { error: LOCK_MESSAGE });
  } finally {
    releaseHook();
    try {
      if (blockerOpen) await blocker?.query("ROLLBACK");
    } finally {
      try {
        await Promise.allSettled(requests);
        await queuedBehindLock;
      } finally {
        try {
          await concurrencyApp.close();
        } finally {
          blocker?.release();
        }
      }
    }
  }
});

test("O10: expiry is judged using database time captured after the advisory lock", async () => {
  const identity = testIdentity("post-lock-time");
  const code = await requestCode(identity);
  await database.query(
    `
      UPDATE otp_challenges
      SET expires_at = clock_timestamp() + INTERVAL '100 milliseconds'
      WHERE identifier = $1 AND channel = 'email'
    `,
    [normalizeEmail(identity.email)]
  );

  const blocker = await database.connect();
  let blockerOpen = false;
  let pending;
  try {
    await blocker.query("BEGIN");
    blockerOpen = true;
    const blockerPid = await getBackendPid(blocker);
    await lockIdentifier(blocker, identity);
    pending = verify(identity, code);
    await waitForBackendsBlockedBy(database, blockerPid, [/pg_advisory_xact_lock/]);
    await blocker.query("SELECT pg_sleep(0.2)");
    await blocker.query("COMMIT");
    blockerOpen = false;
    const response = await pending;
    assert.equal(response.statusCode, 401, response.body);
    assert.deepEqual(response.json(), { error: FAILURE_MESSAGE });
    assert.equal(await failureCount(identity), 0);
    const challenge = await database.query(
      "SELECT verified_at FROM otp_challenges WHERE identifier = $1",
      [normalizeEmail(identity.email)]
    );
    assert.equal(challenge.rows[0].verified_at, null);
  } finally {
    try {
      if (blockerOpen) await blocker.query("ROLLBACK");
    } finally {
      try {
        await pending?.catch(() => {});
      } finally {
        blocker.release();
      }
    }
  }
});

test("O11: a failure returned as 401 is committed and visible to another connection", async () => {
  const identity = testIdentity("durable");
  const code = await requestCode(identity);
  await expectWrong(identity, wrongCodeFor(code));
  const observer = await database.connect();
  try {
    const result = await observer.query(
      `
        SELECT COUNT(*)::int AS count
        FROM otp_verify_failures
        WHERE identifier = $1 AND channel = 'email'
      `,
      [normalizeEmail(identity.email)]
    );
    assert.equal(result.rows[0].count, 1);
  } finally {
    observer.release();
  }
});

test("O8: locked and matching-expired attempts do not add failures", async () => {
  const lockedIdentity = testIdentity("no-failure-locked");
  const lockedCode = await requestCode(lockedIdentity);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expectWrong(lockedIdentity, wrongCodeFor(lockedCode));
  }
  const locked = await verify(lockedIdentity, wrongCodeFor(lockedCode));
  assert.equal(locked.statusCode, 429, locked.body);
  assert.deepEqual(locked.json(), { error: LOCK_MESSAGE });
  assert.equal(await failureCount(lockedIdentity), 5);

  const expiredIdentity = testIdentity("no-failure-expired");
  const expiredCode = await requestCode(expiredIdentity);
  await database.query(
    "UPDATE otp_challenges SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE identifier = $1",
    [normalizeEmail(expiredIdentity.email)]
  );
  const expired = await verify(expiredIdentity, expiredCode);
  assert.equal(expired.statusCode, 401, expired.body);
  assert.deepEqual(expired.json(), { error: FAILURE_MESSAGE });
  assert.equal(await failureCount(expiredIdentity), 0);
});

test("O9: migration 019 follows 018, reruns safely, and does not change otp_challenges", async () => {
  const identity = testIdentity("migration");
  const code = "123456";
  await database.query(
    `
      INSERT INTO otp_challenges (phone_number, identifier, channel, otp_hash, expires_at, failed_at)
      VALUES ($1, $2, 'email', $3, clock_timestamp() + INTERVAL '10 minutes', clock_timestamp())
    `,
    [identity.phone, normalizeEmail(identity.email), hashOtp(identity.email, code, "email")]
  );
  const beforeResult = await database.query(
    "SELECT jsonb_agg(to_jsonb(challenge) ORDER BY id)::text AS rows FROM otp_challenges AS challenge"
  );

  await database.query("DROP TABLE otp_verify_failures");
  const migration018 = await readFile(
    new URL("../migrations/018_attestation_signing_kid.sql", import.meta.url),
    "utf8"
  );
  const migration019 = await readFile(
    new URL("../migrations/019_otp_verify_failures.sql", import.meta.url),
    "utf8"
  );
  await database.query(migration018);
  await database.query(migration019);
  await database.query(migration019);

  const afterResult = await database.query(
    "SELECT jsonb_agg(to_jsonb(challenge) ORDER BY id)::text AS rows FROM otp_challenges AS challenge"
  );
  assert.equal(afterResult.rows[0].rows, beforeResult.rows[0].rows);
  const shape = await database.query(
    `
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'otp_verify_failures'
      ORDER BY ordinal_position
    `
  );
  assert.deepEqual(shape.rows.map(({ column_name, is_nullable }) => ({ column_name, is_nullable })), [
    { column_name: "id", is_nullable: "NO" },
    { column_name: "identifier", is_nullable: "NO" },
    { column_name: "channel", is_nullable: "NO" },
    { column_name: "failed_at", is_nullable: "NO" }
  ]);
  assert.match(shape.rows.find((column) => column.column_name === "failed_at").column_default, /now\(\)/i);
  const index = await database.query(
    `
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'idx_otp_verify_failures_identifier_channel_failed_at'
    `
  );
  assert.match(index.rows[0].indexdef, /\(identifier, channel, failed_at\)/);
});
