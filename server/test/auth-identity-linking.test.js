import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../src/config.js";
import { getPool } from "../src/db.js";
import { hashOtp, normalizeEmail } from "../src/auth-utils.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import {
  assertLocalTestDatabase,
  createTestPool,
  getBackendPid,
  instrumentApplicationPool,
  resetTestDatabase,
  waitForBlockingRelationship,
  waitForValue
} from "./helpers/db.js";

// This guard intentionally runs before a pool is created or any SQL is issued.
assertLocalTestDatabase(config.databaseUrl);

const GENERIC_CONFLICT = "We couldn't complete sign-in with these details. If you already have an account, sign in with the email address you used before.";
const DEVICE_CONFLICT = "Device identity already registered.";
const appPool = getPool();
appPool.options.max = Math.max(appPool.options.max || 10, 25);
const database = createTestPool(config.databaseUrl, config.databaseSsl);
const poolRecorder = instrumentApplicationPool(appPool);
const app = Fastify({ logger: false });

config.allowDevOtp = true;
config.resendApiKey = "";
config.jwtSecret = config.jwtSecret || "identity-linking-test-secret";

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function requestCode(email, phoneNumber) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/otp/request",
    payload: {
      channel: "email",
      email,
      ...(phoneNumber !== undefined ? { phone_number: phoneNumber } : {})
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.match(body.dev_code, /^\d{6}$/);
  return body.dev_code;
}

async function verifyEmail(email, code, options = {}) {
  const defaultDeviceIdentity = `test-device-${normalizeEmail(email)}`;
  return app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: {
      channel: "email",
      email,
      code,
      device_identity: defaultDeviceIdentity,
      public_key: `test-key-${normalizeEmail(email)}`,
      ...options
    }
  });
}

async function insertUser(phoneNumber, email = null, emailVerified = false, phoneVerified = false) {
  const result = await database.query(
    `
      INSERT INTO users (phone_number, email, email_verified, phone_verified)
      VALUES ($1, $2, $3, $4)
      RETURNING id, phone_number, email, email_verified, phone_verified
    `,
    [phoneNumber, email, emailVerified, phoneVerified]
  );
  return result.rows[0];
}

async function insertSmsChallenge(phoneNumber, code) {
  await database.query(
    `
      INSERT INTO otp_challenges (phone_number, identifier, channel, otp_hash, expires_at)
      VALUES ($1, $1, 'sms', $2, NOW() + INTERVAL '10 minutes')
    `,
    [phoneNumber, hashOtp(phoneNumber, code, "sms")]
  );
}

async function forceCollision(insertSql, insertParams, startRequest) {
  const competitor = await database.connect();
  let transactionOpen = false;
  let shouldCommit = false;
  let preparationError = null;
  let pendingRequest;

  try {
    await competitor.query("BEGIN");
    transactionOpen = true;
    const blockerPid = await getBackendPid(competitor);
    await competitor.query(insertSql, insertParams);

    poolRecorder.reset();
    pendingRequest = startRequest();
    const requestPid = await waitForValue(
      () => poolRecorder.state.transactionPids.at(-1),
      (value) => Number.isInteger(value),
      5000
    );
    await waitForBlockingRelationship(database, requestPid, blockerPid, 5000);
    shouldCommit = true;
  } catch (error) {
    preparationError = error;
  } finally {
    if (transactionOpen) {
      try {
        await competitor.query(shouldCommit ? "COMMIT" : "ROLLBACK");
        transactionOpen = false;
      } catch (endError) {
        preparationError ||= endError;
      }
    }
    competitor.release();
  }

  if (preparationError) {
    await pendingRequest?.catch(() => {});
    throw preparationError;
  }
  return pendingRequest;
}

async function tableCounts() {
  const result = await database.query(
    `
      SELECT
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM device_identities) AS devices,
        (SELECT COUNT(*)::int FROM otp_challenges WHERE verified_at IS NOT NULL) AS consumed
    `
  );
  return result.rows[0];
}

before(async () => {
  await registerAuthRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  poolRecorder.reset();
  config.smsProviderEnabled = false;
  await resetTestDatabase(database);
});

after(async () => {
  poolRecorder.restore();
  await app.close();
  await appPool.end();
  await database.end();
});

test("1: a verified second email cannot take over an account through its unverified phone", async () => {
  const phone = "+12025550101";
  const email1 = `${unique("one")}@example.test`;
  const email2 = `${unique("two")}@example.test`;
  const code1 = await requestCode(email1, phone);
  const first = await verifyEmail(email1, code1, {
    phone_number: phone,
    device_identity: "device-one",
    public_key: "public-key-one"
  });
  assert.equal(first.statusCode, 200, first.body);

  const code2 = await requestCode(email2, phone);
  const second = await verifyEmail(email2, code2, {
    phone_number: phone,
    device_identity: "device-two",
    public_key: "public-key-two"
  });
  assert.equal(second.statusCode, 409, second.body);
  assert.deepEqual(second.json(), { error: GENERIC_CONFLICT });

  const users = await database.query("SELECT phone_number, email, email_verified FROM users");
  assert.deepEqual(users.rows, [{ phone_number: phone, email: email1, email_verified: true }]);
  const devices = await database.query("SELECT device_identity FROM device_identities ORDER BY device_identity");
  assert.deepEqual(devices.rows, [{ device_identity: "device-one" }]);
  assert.deepEqual(await tableCounts(), { users: 1, devices: 1, consumed: 2 });
});

test("2: two verified emails never merge when the second request trims to the same phone", async () => {
  const phone = "+12025550102";
  const email1 = `${unique("trim-one")}@example.test`;
  const email2 = `${unique("trim-two")}@example.test`;
  const firstCode = await requestCode(email1, phone);
  assert.equal((await verifyEmail(email1, firstCode, { phone_number: phone })).statusCode, 200);
  const secondCode = await requestCode(email2, ` ${phone} `);
  const second = await verifyEmail(email2, secondCode, { phone_number: ` ${phone} ` });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().error, GENERIC_CONFLICT);
  const users = await database.query("SELECT phone_number, email FROM users");
  assert.deepEqual(users.rows, [{ phone_number: phone, email: email1 }]);
  assert.deepEqual(await tableCounts(), { users: 1, devices: 1, consumed: 2 });
});

test("3: existing-email sign-in ignores absent, different, invalid, and another account's phone", async () => {
  const phone = "+12025550103";
  const otherPhone = "+12025550993";
  const unusedPhone = "+12025550994";
  const email = `${unique("existing")}@example.test`;
  const firstCode = await requestCode(email, phone);
  assert.equal((await verifyEmail(email, firstCode, { phone_number: phone })).statusCode, 200);
  await insertUser(otherPhone, `${unique("other")}@example.test`, true, false);

  const suppliedPhones = [undefined, unusedPhone, "invalid", otherPhone];
  for (const suppliedPhone of suppliedPhones) {
    const code = await requestCode(email, suppliedPhone);
    const response = await verifyEmail(email, code, {
      ...(suppliedPhone !== undefined ? { phone_number: suppliedPhone } : {})
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json().auth_token);
  }

  const users = await database.query("SELECT phone_number, email FROM users ORDER BY phone_number");
  assert.equal(users.rows.length, 2);
  assert.deepEqual(users.rows.find((row) => row.phone_number === phone), { phone_number: phone, email });
  assert.equal(users.rows.some((row) => row.phone_number === unusedPhone), false);
  assert.equal(users.rows.find((row) => row.phone_number === otherPhone).email.includes("other"), true);
});

test("4: a new verified email and new phone create exactly one appropriately verified account", async () => {
  const phone = "+12025550104";
  const email = `${unique("new")}@example.test`;
  const code = await requestCode(email, phone);
  const response = await verifyEmail(email, code, { phone_number: phone });
  assert.equal(response.statusCode, 200, response.body);
  const users = await database.query("SELECT phone_number, email, email_verified, phone_verified FROM users");
  assert.deepEqual(users.rows, [{ phone_number: phone, email, email_verified: true, phone_verified: false }]);
});

test("5: a new email requires a valid phone anchor at verification", async () => {
  for (const [suffix, phoneValue] of [["missing", undefined], ["invalid", "bad"]]) {
    const email = `${unique(suffix)}@example.test`;
    const code = await requestCode(email, `+12025550${suffix === "missing" ? "105" : "106"}`);
    const response = await verifyEmail(email, code, {
      ...(phoneValue !== undefined ? { phone_number: phoneValue } : {})
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.deepEqual(response.json(), {
      error: "Add a phone number to your profile before email verification can activate sync on this device.",
      code: "phone_anchor_required",
      missing: "phone_number"
    });
  }
  assert.deepEqual(await tableCounts(), { users: 0, devices: 0, consumed: 2 });
});

test("6a: twenty parallel sign-ups for one phone create one immutable account", async () => {
  const phone = "+12025550107";
  const attempts = [];
  for (let index = 0; index < 20; index += 1) {
    const email = `${unique(`parallel-${index}`)}@example.test`;
    attempts.push({ email, code: await requestCode(email, phone) });
  }

  poolRecorder.reset();
  const responses = await Promise.all(attempts.map(({ email, code }) => (
    verifyEmail(email, code, { phone_number: phone })
  )));
  assert.ok(appPool.options.max >= attempts.length);
  assert.ok(poolRecorder.state.maxActive >= 2, "expected at least two simultaneous database checkouts");
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(responses.filter((response) => response.statusCode === 409).length, 19);
  for (const response of responses.filter((item) => item.statusCode === 409)) {
    assert.deepEqual(response.json(), { error: GENERIC_CONFLICT });
  }

  const users = await database.query("SELECT phone_number, email FROM users");
  assert.equal(users.rows.length, 1);
  assert.equal(users.rows[0].phone_number, phone);
  assert.ok(attempts.some(({ email }) => email === users.rows[0].email));
  const constraints = await database.query(
    `
      SELECT indexrelid::regclass::text AS name, indisunique, indisprimary
      FROM pg_index
      WHERE indrelid = 'users'::regclass
        AND indexrelid::regclass::text IN ('users_pkey', 'idx_users_email_unique')
      ORDER BY name
    `
  );
  assert.equal(constraints.rows.length, 2);
  assert.ok(constraints.rows.every((row) => row.indisunique));
  assert.ok(constraints.rows.some((row) => row.name === "users_pkey" && row.indisprimary));
  assert.deepEqual(await tableCounts(), { users: 1, devices: 1, consumed: 20 });
});

test("6b: forced uncommitted phone collision blocks the route backend and refuses safely", async () => {
  const phone = "+12025550108";
  const email = `${unique("forced-phone")}@example.test`;
  const winnerEmail = `${unique("winner")}@example.test`;
  const code = await requestCode(email, phone);
  const response = await forceCollision(
    `INSERT INTO users (phone_number, email, email_verified) VALUES ($1, $2, TRUE)`,
    [phone, winnerEmail],
    () => verifyEmail(email, code, { phone_number: phone })
  );
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json(), { error: GENERIC_CONFLICT });
  const users = await database.query("SELECT phone_number, email FROM users");
  assert.deepEqual(users.rows, [{ phone_number: phone, email: winnerEmail }]);
  assert.deepEqual(await tableCounts(), { users: 1, devices: 0, consumed: 1 });
});

test("7: ten parallel uses of one code consume it atomically exactly once", async () => {
  const phone = "+12025550109";
  const email = `${unique("single-code")}@example.test`;
  const code = await requestCode(email, phone);
  poolRecorder.reset();
  const responses = await Promise.all(Array.from({ length: 10 }, () => (
    verifyEmail(email, code, { phone_number: phone })
  )));
  assert.ok(appPool.options.max >= responses.length);
  assert.ok(poolRecorder.state.maxActive >= 2, "expected concurrent database checkouts");
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(responses.filter((response) => response.statusCode === 401).length, 9);
  assert.equal(responses.filter((response) => response.json().auth_token).length, 1);
  assert.deepEqual(await tableCounts(), { users: 1, devices: 1, consumed: 1 });
});

test("8: a code consumed by an identity-conflict refusal cannot be replayed", async () => {
  const phone = "+12025550110";
  await insertUser(phone, `${unique("owner")}@example.test`, true, false);
  const email = `${unique("refused")}@example.test`;
  const code = await requestCode(email, phone);
  const refused = await verifyEmail(email, code, { phone_number: phone });
  assert.equal(refused.statusCode, 409, refused.body);
  const replay = await verifyEmail(email, code, { phone_number: phone });
  assert.equal(replay.statusCode, 401, replay.body);
  const challenge = await database.query("SELECT verified_at FROM otp_challenges WHERE identifier = $1", [email]);
  assert.ok(challenge.rows[0].verified_at);
});

test("9: step-two failures roll back account and device, including a forced commit failure", async () => {
  const ownerPhone = "+12025550111";
  await insertUser(ownerPhone, `${unique("device-owner")}@example.test`, true, false);
  await database.query(
    `INSERT INTO device_identities (device_identity, public_key, phone_number) VALUES ('occupied-device', 'owner-key', $1)`,
    [ownerPhone]
  );
  const email = `${unique("orphan")}@example.test`;
  const phone = "+12025550112";
  const code = await requestCode(email, phone);
  const collision = await verifyEmail(email, code, {
    phone_number: phone,
    device_identity: "occupied-device",
    public_key: "attacker-key"
  });
  assert.equal(collision.statusCode, 409, collision.body);
  assert.deepEqual(collision.json(), { error: DEVICE_CONFLICT });
  assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM users WHERE phone_number = $1 OR email = $2", [phone, email])).rows[0].count, 0);
  assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM otp_challenges WHERE identifier = $1 AND verified_at IS NOT NULL", [email])).rows[0].count, 1);
  const occupiedDevice = await database.query("SELECT phone_number, public_key FROM device_identities WHERE device_identity = 'occupied-device'");
  assert.deepEqual(occupiedDevice.rows[0], { phone_number: ownerPhone, public_key: "owner-key" });

  await resetTestDatabase(database);
  const commitEmail = `${unique("commit-failure")}@example.test`;
  const commitPhone = "+12025550113";
  const commitCode = await requestCode(commitEmail, commitPhone);
  poolRecorder.failNextCommit();
  const failedCommit = await verifyEmail(commitEmail, commitCode, {
    phone_number: commitPhone,
    device_identity: "commit-device",
    public_key: "commit-key"
  });
  assert.equal(failedCommit.statusCode, 500, failedCommit.body);
  assert.equal(Object.hasOwn(failedCommit.json(), "auth_token"), false);
  assert.deepEqual(await tableCounts(), { users: 0, devices: 0, consumed: 1 });
});

test("10: forced uncommitted email-index collision is a generic 409 with no orphan", async () => {
  const email = `${unique("forced-email")}@example.test`;
  const phone = "+12025550114";
  const winnerPhone = "+12025550115";
  const code = await requestCode(email, phone);
  const response = await forceCollision(
    `INSERT INTO users (phone_number, email, email_verified) VALUES ($1, $2, TRUE)`,
    [winnerPhone, email],
    () => verifyEmail(email, code, { phone_number: phone })
  );
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json(), { error: GENERIC_CONFLICT });
  assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM users WHERE phone_number = $1", [phone])).rows[0].count, 0);
  assert.deepEqual(await tableCounts(), { users: 1, devices: 0, consumed: 1 });
});

test("11: dormant SMS verification never sets or changes email from the request", async () => {
  config.smsProviderEnabled = true;
  const newPhone = "+12025550116";
  const requestedEmail = `${unique("sms-ignored")}@example.test`;
  await insertSmsChallenge(newPhone, "123456");
  const created = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: { channel: "sms", phone_number: newPhone, code: "123456", email: requestedEmail, device_identity: "sms-new-device", public_key: "sms-new-key" }
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal((await database.query("SELECT email FROM users WHERE phone_number = $1", [newPhone])).rows[0].email, null);

  const existingPhone = "+12025550117";
  const existingEmail = `${unique("sms-existing")}@example.test`;
  await insertUser(existingPhone, existingEmail, true, false);
  await insertSmsChallenge(existingPhone, "654321");
  const updated = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: { channel: "sms", phone_number: existingPhone, code: "654321", email: requestedEmail, device_identity: "sms-existing-device", public_key: "sms-existing-key" }
  });
  assert.equal(updated.statusCode, 200, updated.body);
  const user = await database.query("SELECT email, email_verified, phone_verified FROM users WHERE phone_number = $1", [existingPhone]);
  assert.deepEqual(user.rows[0], { email: existingEmail, email_verified: true, phone_verified: true });
});

test("12: refusal body is identical for phones with and without verified email and leaks neither identifier", async () => {
  const phoneWithEmail = "+12025550118";
  const phoneWithoutEmail = "+12025550119";
  const ownerEmail = `${unique("verified-owner")}@example.test`;
  await insertUser(phoneWithEmail, ownerEmail, true, false);
  await insertUser(phoneWithoutEmail, null, false, false);

  const bodies = [];
  for (const [phone, prefix] of [[phoneWithEmail, "with"], [phoneWithoutEmail, "without"]]) {
    const attemptedEmail = `${unique(prefix)}@example.test`;
    const code = await requestCode(attemptedEmail, phone);
    const response = await verifyEmail(attemptedEmail, code, { phone_number: phone });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.body.includes(phone), false);
    assert.equal(response.body.includes(attemptedEmail), false);
    assert.equal(response.body.includes(ownerEmail), false);
    bodies.push(response.body);
  }
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(await tableCounts(), { users: 2, devices: 0, consumed: 2 });
});

test("14: an existing-email token carries the account phone, never the supplied phone", async () => {
  const accountPhone = "+12025550120";
  const suppliedPhone = "+12025550121";
  const email = `${unique("claim")}@example.test`;
  await insertUser(accountPhone, email, true, false);
  const code = await requestCode(email, suppliedPhone);
  const response = await verifyEmail(email, code, { phone_number: suppliedPhone });
  assert.equal(response.statusCode, 200, response.body);
  const claims = jwt.decode(response.json().auth_token);
  assert.equal(claims.phone_number, accountPhone);
  assert.notEqual(claims.phone_number, suppliedPhone);
  assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM users WHERE phone_number = $1", [suppliedPhone])).rows[0].count, 0);
});

test("15a: a pre-existing foreign device causes 409 and leaves both account and device unchanged", async () => {
  const ownerPhone = "+12025550122";
  await insertUser(ownerPhone, `${unique("owner")}@example.test`, true, false);
  await database.query(
    `
      INSERT INTO device_identities (device_identity, public_key, phone_number, revoked_at)
      VALUES ('foreign-device', 'original-key', $1, NOW())
    `,
    [ownerPhone]
  );
  const phone = "+12025550123";
  const email = `${unique("foreign-collision")}@example.test`;
  const code = await requestCode(email, phone);
  const response = await verifyEmail(email, code, {
    phone_number: phone,
    device_identity: "foreign-device",
    public_key: "replacement-key"
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json(), { error: DEVICE_CONFLICT });
  assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM users WHERE phone_number = $1 OR email = $2", [phone, email])).rows[0].count, 0);
  const device = await database.query("SELECT phone_number, public_key, revoked_at IS NOT NULL AS revoked FROM device_identities WHERE device_identity = 'foreign-device'");
  assert.deepEqual(device.rows[0], { phone_number: ownerPhone, public_key: "original-key", revoked: true });
  assert.deepEqual(await tableCounts(), { users: 1, devices: 1, consumed: 1 });
});

test("15b: forced device insert collision blocks, rolls back the new account, and preserves ownership", async () => {
  const ownerPhone = "+12025550124";
  await insertUser(ownerPhone, `${unique("race-owner")}@example.test`, true, false);
  const newPhone = "+12025550125";
  const newEmail = `${unique("device-race")}@example.test`;
  const code = await requestCode(newEmail, newPhone);
  const response = await forceCollision(
    `INSERT INTO device_identities (device_identity, public_key, phone_number) VALUES ($1, $2, $3)`,
    ["racing-device", "original-race-key", ownerPhone],
    () => verifyEmail(newEmail, code, {
      phone_number: newPhone,
      device_identity: "racing-device",
      public_key: "losing-key"
    })
  );
  assert.equal(response.statusCode, 409, response.body);
  assert.deepEqual(response.json(), { error: DEVICE_CONFLICT });
  assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM users WHERE phone_number = $1 OR email = $2", [newPhone, newEmail])).rows[0].count, 0);
  const device = await database.query("SELECT phone_number, public_key FROM device_identities WHERE device_identity = 'racing-device'");
  assert.deepEqual(device.rows[0], { phone_number: ownerPhone, public_key: "original-race-key" });
  assert.deepEqual(await tableCounts(), { users: 1, devices: 1, consumed: 1 });
});

test("15c: re-verifying a known device updates activity only and issues a token after commit", async () => {
  const phone = "+12025550126";
  const email = `${unique("known-device")}@example.test`;
  await insertUser(phone, email, true, false);
  await database.query(
    `
      INSERT INTO device_identities (
        device_identity, public_key, phone_number, status, last_seen_at, updated_at, revoked_at
      ) VALUES ('known-device', 'immutable-key', $1, 'ACTIVE', '2020-01-01', '2020-01-01', '2021-01-01')
    `,
    [phone]
  );
  const fixtureDevice = await database.query(
    "SELECT revoked_at FROM device_identities WHERE device_identity = 'known-device'"
  );
  const code = await requestCode(email, "+12025550999");
  const response = await verifyEmail(email, code, {
    phone_number: "+12025550999",
    device_identity: "known-device",
    public_key: "attempted-new-key"
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.json().auth_token);
  const device = await database.query(
    `
      SELECT phone_number, public_key, revoked_at, last_seen_at, updated_at
      FROM device_identities
      WHERE device_identity = 'known-device'
    `
  );
  assert.equal(device.rows[0].phone_number, phone);
  assert.equal(device.rows[0].public_key, "immutable-key");
  assert.deepEqual(device.rows[0].revoked_at, fixtureDevice.rows[0].revoked_at);
  assert.ok(new Date(device.rows[0].last_seen_at) > new Date("2020-01-01"));
  assert.ok(new Date(device.rows[0].updated_at) > new Date("2020-01-01"));
  assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM users")).rows[0].count, 1);
});
