import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../src/config.js";
import { getPool } from "../src/db.js";
import { hashOtp } from "../src/auth-utils.js";
import { registerAccountRoutes } from "../src/routes/account.js";
import { registerAttestRoutes } from "../src/routes/attest.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerIdentityRoutes } from "../src/routes/identity.js";
import { registerPaymentRoutes } from "../src/routes/payment.js";
import { registerReadinessRoute } from "../src/routes/health.js";
import { registerSyncRoutes } from "../src/routes/sync.js";
import {
  assertLocalTestDatabase,
  createTestPool,
  getBackendPid,
  instrumentApplicationPool,
  resetTestDatabase,
  waitForBackendsBlockedBy,
  waitForValue
} from "./helpers/db.js";

// This guard intentionally runs before a pool is created or any SQL is issued.
assertLocalTestDatabase(config.databaseUrl);

const INVALID_SESSION_REPLY = { error: "session_invalid" };
const MISSING_TOKEN_REPLY = { error: "token_missing" };
const DEVICE_MISMATCH_REPLY = { error: "device_mismatch" };
const DEVICE_ACTIVITY_UPDATE = /UPDATE\s+device_identities\s+SET\s+user_id\s+=\s+user_id,\s*last_seen_at\s+=\s+NOW\(\),\s*updated_at\s+=\s+NOW\(\)\s+WHERE\s+device_identity\s+=\s+\$1/i;
const SMS_PHONE_VERIFICATION_OR_DEVICE_ACTIVITY_UPDATE = /UPDATE\s+(?:users\s+SET\s+phone_verified\s+=\s+TRUE\s+WHERE\s+phone_number\s+=\s+\$1|device_identities\s+SET\s+user_id\s+=\s+user_id,\s*last_seen_at\s+=\s+NOW\(\),\s*updated_at\s+=\s+NOW\(\)\s+WHERE\s+device_identity\s+=\s+\$1)/i;
const appPool = getPool();
const database = createTestPool(config.databaseUrl, config.databaseSsl);
const poolRecorder = instrumentApplicationPool(appPool);
const app = Fastify({ logger: false });
const registeredRoutes = new Set();

config.allowDevOtp = true;
config.resendApiKey = "";
config.jwtSecret = config.jwtSecret || "signout-sessions-test-secret";

app.addHook("onRoute", (route) => {
  for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
    registeredRoutes.add(`${method} ${route.url}`);
  }
});

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function authHeaders(token, deviceIdentity) {
  return {
    authorization: `Bearer ${token}`,
    "x-device-identity": deviceIdentity
  };
}

async function requestCode(email, phoneNumber) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/otp/request",
    payload: { channel: "email", email, phone_number: phoneNumber }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().dev_code;
}

async function signIn({ email = `${unique("account")}@example.test`, phone, deviceIdentity }) {
  const code = await requestCode(email, phone);
  const response = await verifyCode({ email, phone, deviceIdentity, code });
  assert.equal(response.statusCode, 200, response.body);
  return { email, phone, deviceIdentity, ...response.json() };
}

async function settleWithin(promises, description, timeoutMs = 5000) {
  let timeout;
  try {
    return await Promise.race([
      Promise.allSettled(promises.filter(Boolean)),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function verifyCode({ email, phone, deviceIdentity, code }) {
  return app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: {
      channel: "email",
      email,
      phone_number: phone,
      code,
      device_identity: deviceIdentity,
      public_key: `public-key-${deviceIdentity}`
    }
  });
}

async function sessionRows() {
  return (await database.query(
    `
      SELECT s.id, s.user_id, s.device_identity, s.revoked_at, u.phone_number
      FROM user_sessions s
      INNER JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at, s.id
    `
  )).rows;
}

async function sessionRow(sessionId) {
  const result = await database.query(
    `
      SELECT id, revoked_at
      FROM user_sessions
      WHERE id = $1
    `,
    [sessionId]
  );
  return result.rows[0] || null;
}

async function sessionRowsForDevice(deviceIdentity) {
  return (await database.query(
    `
      SELECT id, revoked_at
      FROM user_sessions
      WHERE device_identity = $1
      ORDER BY created_at, id
    `,
    [deviceIdentity]
  )).rows;
}

before(async () => {
  app.get("/health", async () => ({ status: "ok" }));
  registerReadinessRoute(app);
  await registerAuthRoutes(app);
  await registerAccountRoutes(app);
  await registerSyncRoutes(app);
  await registerIdentityRoutes(app);
  await registerAttestRoutes(app);
  await registerPaymentRoutes(app);
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

test("A3a: each missing device credential is rejected before its OTP challenge is consumed", async () => {
  for (const [index, [suffix, credentials]] of [
    ["none", {}],
    ["identity", { device_identity: "only-identity" }],
    ["key", { public_key: "only-key" }]
  ].entries()) {
    const phone = `+1202555021${index}`;
    const email = `${unique(`credential-${suffix}`)}@example.test`;
    const code = await requestCode(email, phone);
    const refused = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { channel: "email", email, phone_number: phone, code, ...credentials }
    });
    assert.equal(refused.statusCode, 400, refused.body);
    assert.deepEqual(refused.json(), { error: "device_identity and public_key are required." });
    const challenge = await database.query(
      "SELECT verified_at FROM otp_challenges WHERE identifier = $1",
      [email]
    );
    assert.equal(challenge.rows[0].verified_at, null);

    const retry = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: {
        channel: "email",
        email,
        phone_number: phone,
        code,
        device_identity: `retry-${suffix}`,
        public_key: `retry-key-${suffix}`
      }
    });
    assert.equal(retry.statusCode, 200, retry.body);
  }
});

test("A1/A2/A4: sign-in creates a device-bound session, returns account_id, and logout is idempotent", async () => {
  const signedIn = await signIn({
    phone: "+12025550202",
    deviceIdentity: "logout-device"
  });
  const claims = jwt.decode(signedIn.auth_token);
  assert.ok(claims.sid);
  assert.equal(signedIn.account_id, (await sessionRows())[0].user_id);
  const secondSession = await signIn({
    email: signedIn.email,
    phone: signedIn.phone,
    deviceIdentity: "logout-other-device"
  });
  assert.equal((await sessionRows()).filter((row) => row.phone_number === signedIn.phone).length, 2);

  const profile = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
  });
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().account_id, signedIn.account_id);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
    });
    assert.equal(logout.statusCode, 204, logout.body);
  }

  const refused = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
  });
  assert.equal(refused.statusCode, 401, refused.body);
  assert.deepEqual(refused.json(), INVALID_SESSION_REPLY);

  const unaffectedSession = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(secondSession.auth_token, secondSession.deviceIdentity)
  });
  assert.equal(unaffectedSession.statusCode, 200, unaffectedSession.body);
});

test("E5: signing in again on one device replaces its active session", async () => {
  const first = await signIn({ phone: "+12025550214", deviceIdentity: "replace-one-device" });
  const second = await signIn({
    email: first.email,
    phone: first.phone,
    deviceIdentity: first.deviceIdentity
  });
  const rows = await sessionRowsForDevice(first.deviceIdentity);

  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => row.revoked_at === null).length, 1);
  assert.equal(rows.find((row) => row.id === jwt.decode(first.auth_token).sid).revoked_at === null, false);
  assert.equal(rows.find((row) => row.id === jwt.decode(second.auth_token).sid).revoked_at, null);

  const oldToken = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(first.auth_token, first.deviceIdentity)
  });
  assert.equal(oldToken.statusCode, 401, oldToken.body);
  assert.deepEqual(oldToken.json(), INVALID_SESSION_REPLY);

  const newToken = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(second.auth_token, second.deviceIdentity)
  });
  assert.equal(newToken.statusCode, 200, newToken.body);
});

test("E5: sessions on separate devices for one account stay active", async () => {
  const first = await signIn({ phone: "+12025550215", deviceIdentity: "replace-device-one" });
  const second = await signIn({
    email: first.email,
    phone: first.phone,
    deviceIdentity: "replace-device-two"
  });

  for (const signedIn of [first, second]) {
    assert.equal((await sessionRowsForDevice(signedIn.deviceIdentity)).filter((row) => row.revoked_at === null).length, 1);
    const profile = await app.inject({
      method: "GET",
      url: "/profile",
      headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
    });
    assert.equal(profile.statusCode, 200, profile.body);
  }
});

test("E5: concurrent sign-ins on one device serialize and leave one active session", async () => {
  const initial = await signIn({ phone: "+12025550216", deviceIdentity: "replace-racing-device" });
  const emailCode = await requestCode(initial.email, initial.phone);
  const smsCode = "123456";
  config.smsProviderEnabled = true;
  await database.query(
    `
      INSERT INTO otp_challenges (phone_number, identifier, channel, otp_hash, expires_at)
      VALUES ($1, $1, 'sms', $2, NOW() + INTERVAL '10 minutes')
    `,
    [initial.phone, hashOtp(initial.phone, smsCode, "sms")]
  );

  const competitor = await database.connect();
  let competitorOpen = false;
  let emailVerification;
  let smsVerification;
  let raceResults;
  try {
    await competitor.query("BEGIN");
    competitorOpen = true;
    const blockerPid = await getBackendPid(competitor);
    await competitor.query(
      "SELECT device_identity FROM device_identities WHERE device_identity = $1 FOR UPDATE",
      [initial.deviceIdentity]
    );

    poolRecorder.reset();
    emailVerification = verifyCode({
      email: initial.email,
      phone: initial.phone,
      deviceIdentity: initial.deviceIdentity,
      code: emailCode
    });
    const [firstVerifierPid] = await waitForBackendsBlockedBy(database, blockerPid, [
      {
        description: "email verifier device activity update",
        pattern: DEVICE_ACTIVITY_UPDATE
      }
    ], 5000);
    smsVerification = app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: {
        channel: "sms",
        phone_number: initial.phone,
        code: smsCode,
        device_identity: initial.deviceIdentity,
        public_key: `public-key-${initial.deviceIdentity}`
      }
    });
    const [emailWaiterPid, smsWaiterPid] = await waitForBackendsBlockedBy(database, blockerPid, [
      {
        description: "email verifier device activity update",
        pattern: DEVICE_ACTIVITY_UPDATE,
        pid: firstVerifierPid
      },
      {
        description: "SMS verifier phone verification or device activity update",
        pattern: SMS_PHONE_VERIFICATION_OR_DEVICE_ACTIVITY_UPDATE
      }
    ], 5000);
    const secondRequestPid = poolRecorder.state.transactionPids.find((pid) => (
      pid !== firstVerifierPid && pid === smsWaiterPid
    ));
    assert.notEqual(emailWaiterPid, smsWaiterPid);
    for (const pid of [emailWaiterPid, smsWaiterPid]) {
      assert.ok(
        poolRecorder.state.transactionPids.includes(pid),
        `expected waiting backend ${pid} to have issued BEGIN after the recorder reset`
      );
    }
    assert.equal(emailWaiterPid, firstVerifierPid);
    assert.equal(smsWaiterPid, secondRequestPid);
  } finally {
    try {
      if (competitorOpen) await competitor.query("ROLLBACK");
    } finally {
      try {
        competitor.release();
      } finally {
        raceResults = await settleWithin(
          [emailVerification, smsVerification],
          "the concurrent sign-in requests"
        );
      }
    }
  }

  const [emailResult, smsResult] = raceResults;
  assert.equal(emailResult.status, "fulfilled", String(emailResult.reason));
  assert.equal(smsResult.status, "fulfilled", String(smsResult.reason));
  const emailResponse = emailResult.value;
  const smsResponse = smsResult.value;
  assert.equal(emailResponse.statusCode, 200, emailResponse.body);
  assert.equal(smsResponse.statusCode, 200, smsResponse.body);
  const rows = await sessionRowsForDevice(initial.deviceIdentity);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((row) => row.revoked_at === null).length, 1);
  assert.equal(rows.filter((row) => row.revoked_at !== null).length, 2);
  assert.ok(poolRecorder.state.queryTexts.some((text) => (
    /SELECT\s+device_identity\s+FROM\s+device_identities\s+WHERE\s+device_identity\s+=\s+\$1\s+FOR\s+UPDATE/i.test(text)
  )), "expected same-device sign-in to lock the device row");
});

test("E5: an old-token request racing replacement is refused after the replacement commits", async () => {
  const first = await signIn({ phone: "+12025550217", deviceIdentity: "replace-old-token" });
  const replacementCode = await requestCode(first.email, first.phone);
  const competitor = await database.connect();
  let competitorOpen = false;
  let replacementVerification;
  let duringReplacement;
  let raceResults;
  try {
    await competitor.query("BEGIN");
    competitorOpen = true;
    const blockerPid = await getBackendPid(competitor);
    await competitor.query(
      "SELECT device_identity FROM device_identities WHERE device_identity = $1 FOR UPDATE",
      [first.deviceIdentity]
    );

    poolRecorder.reset();
    replacementVerification = verifyCode({
      email: first.email,
      phone: first.phone,
      deviceIdentity: first.deviceIdentity,
      code: replacementCode
    });
    await waitForValue(
      () => poolRecorder.state.transactionPids.length,
      (count) => count > 0,
      5000
    );
    duringReplacement = app.inject({
      method: "GET",
      url: "/profile",
      headers: authHeaders(first.auth_token, first.deviceIdentity)
    });
    const waiterPids = await waitForBackendsBlockedBy(database, blockerPid, [
      { description: "replacement verifier device activity update", pattern: DEVICE_ACTIVITY_UPDATE },
      { description: "/profile guard device activity update", pattern: DEVICE_ACTIVITY_UPDATE }
    ], 5000);
    const replacementWaiterPids = waiterPids.filter((pid) => (
      poolRecorder.state.transactionPids.includes(pid)
    ));
    assert.equal(
      replacementWaiterPids.length,
      1,
      "expected exactly one waiting backend to have issued BEGIN after the recorder reset"
    );
    const replacementWaiterPid = replacementWaiterPids[0];
    const profileWaiterPid = waiterPids.find((pid) => pid !== replacementWaiterPid);
    assert.ok(
      poolRecorder.state.transactionPids.includes(replacementWaiterPid),
      `expected replacement verifier backend ${replacementWaiterPid} to have issued BEGIN after the recorder reset`
    );
    assert.ok(
      !poolRecorder.state.transactionPids.includes(profileWaiterPid),
      `expected /profile backend ${profileWaiterPid} not to have issued BEGIN after the recorder reset`
    );
    assert.notEqual(profileWaiterPid, replacementWaiterPid);
  } finally {
    try {
      if (competitorOpen) await competitor.query("ROLLBACK");
    } finally {
      try {
        competitor.release();
      } finally {
        raceResults = await settleWithin(
          [replacementVerification, duringReplacement],
          "the replacement and old-token requests"
        );
      }
    }
  }

  const [replacementResult, duringReplacementResult] = raceResults;
  assert.equal(replacementResult.status, "fulfilled", String(replacementResult.reason));
  assert.equal(duringReplacementResult.status, "fulfilled", String(duringReplacementResult.reason));
  const replacement = replacementResult.value;
  assert.equal(replacement.statusCode, 200, replacement.body);
  const replacementBody = replacement.json();
  const activeSessionRows = (await sessionRowsForDevice(first.deviceIdentity))
    .filter((row) => row.revoked_at === null);
  assert.equal(activeSessionRows.length, 1);
  assert.equal(jwt.decode(replacementBody.auth_token).sid, activeSessionRows[0].id);

  const duringReplacementResponse = duringReplacementResult.value;
  // Admitted before the replacement committed, so this request may finish.
  assert.equal(duringReplacementResponse.statusCode, 200, duringReplacementResponse.body);

  const oldRequest = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(first.auth_token, first.deviceIdentity)
  });
  assert.equal(oldRequest.statusCode, 401, oldRequest.body);
  assert.deepEqual(oldRequest.json(), INVALID_SESSION_REPLY);
  const replacementRequest = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(replacementBody.auth_token, first.deviceIdentity)
  });
  assert.equal(replacementRequest.statusCode, 200, replacementRequest.body);
});

test("E5: a failure after revocation rolls back and preserves the old session", async () => {
  const first = await signIn({ phone: "+12025550218", deviceIdentity: "replace-rollback-device" });
  const replacementCode = await requestCode(first.email, first.phone);
  const firstSessionId = jwt.decode(first.auth_token).sid;
  poolRecorder.failNextQueryMatching(/INSERT\s+INTO\s+user_sessions/i);

  const failed = await verifyCode({
    email: first.email,
    phone: first.phone,
    deviceIdentity: first.deviceIdentity,
    code: replacementCode
  });
  assert.equal(failed.statusCode, 500, failed.body);
  assert.equal(Object.hasOwn(failed.json(), "auth_token"), false);
  const rows = await sessionRowsForDevice(first.deviceIdentity);
  assert.deepEqual(rows.map((row) => row.id), [firstSessionId]);
  assert.equal(rows[0].revoked_at, null);
});

test("E5: migration 014 keeps the newest active session and adds the partial unique index", async () => {
  const migrationSql = await readFile(
    new URL("../migrations/014_one_active_session_per_device.sql", import.meta.url),
    "utf8"
  );
  const client = await database.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("DROP INDEX IF EXISTS idx_user_sessions_one_active_per_device");
    const user = await client.query(
      "INSERT INTO users (phone_number) VALUES ($1) RETURNING id",
      ["+12025550219"]
    );
    const deviceIdentity = "migration-session-device";
    await client.query(
      "INSERT INTO device_identities (device_identity, public_key, phone_number) VALUES ($1, $2, $3)",
      [deviceIdentity, "migration-public-key", "+12025550219"]
    );
    const olderId = "00000000-0000-0000-0000-000000000001";
    const newerId = "00000000-0000-0000-0000-000000000002";
    await client.query(
      `
        INSERT INTO user_sessions (id, user_id, device_identity, created_at)
        VALUES
          ($1, $3, $4, '2026-01-01T00:00:00Z'),
          ($2, $3, $4, '2026-01-01T00:00:00Z')
      `,
      [olderId, newerId, user.rows[0].id, deviceIdentity]
    );

    await client.query(migrationSql);
    const sessions = await client.query(
      `
        SELECT id, revoked_at IS NULL AS active
        FROM user_sessions
        WHERE device_identity = $1
        ORDER BY created_at, id
      `,
      [deviceIdentity]
    );
    assert.deepEqual(sessions.rows, [
      { id: olderId, active: false },
      { id: newerId, active: true }
    ]);
    const index = await client.query(
      `
        SELECT indisunique, pg_get_expr(indpred, indrelid) AS predicate
        FROM pg_index
        WHERE indexrelid = 'idx_user_sessions_one_active_per_device'::regclass
      `
    );
    assert.equal(index.rows[0].indisunique, true);
    assert.match(index.rows[0].predicate, /revoked_at IS NULL/);
    assert.match(index.rows[0].predicate, /device_identity IS NOT NULL/);
  } finally {
    if (transactionOpen) await client.query("ROLLBACK");
    client.release();
  }
});

test("A1: logout without a bearer token does not make a statement about or change a session", async () => {
  const signedIn = await signIn({ phone: "+12025550209", deviceIdentity: "missing-logout-token" });
  const sessionId = jwt.decode(signedIn.auth_token).sid;

  const response = await app.inject({ method: "POST", url: "/auth/logout" });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(response.json(), MISSING_TOKEN_REPLY);
  assert.equal((await sessionRow(sessionId)).revoked_at, null);
});

test("A3/A4: logout-all revokes only the current account's sessions", async () => {
  const email = `${unique("many-sessions")}@example.test`;
  const first = await signIn({ email, phone: "+12025550203", deviceIdentity: "all-one" });
  const second = await signIn({ email, phone: first.phone, deviceIdentity: "all-two" });
  const other = await signIn({ phone: "+12025550204", deviceIdentity: "other-device" });

  const logoutAll = await app.inject({
    method: "POST",
    url: "/auth/logout-all",
    headers: authHeaders(first.auth_token, first.deviceIdentity)
  });
  assert.equal(logoutAll.statusCode, 204, logoutAll.body);

  const rows = await sessionRows();
  assert.equal(rows.filter((row) => row.phone_number === first.phone && row.revoked_at).length, 2);
  assert.equal(rows.find((row) => row.phone_number === other.phone).revoked_at, null);
  for (const session of [first, second]) {
    const refused = await app.inject({
      method: "GET",
      url: "/profile",
      headers: authHeaders(session.auth_token, session.deviceIdentity)
    });
    assert.equal(refused.statusCode, 401, refused.body);
  }
  const otherProfile = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(other.auth_token, other.deviceIdentity)
  });
  assert.equal(otherProfile.statusCode, 200, otherProfile.body);
});

test("A3: every definitive invalid-session refusal has the session_invalid code", async () => {
  const first = await signIn({ phone: "+12025550205", deviceIdentity: "bound-device" });
  const second = await signIn({ phone: "+12025550206", deviceIdentity: "second-device" });
  const firstSid = jwt.decode(first.auth_token).sid;
  const cases = [
    [jwt.sign({ phone_number: first.phone }, config.jwtSecret, { expiresIn: "30d" }), "bound-device"],
    [jwt.sign({ phone_number: first.phone, sid: crypto.randomUUID() }, config.jwtSecret, { expiresIn: "30d" }), "bound-device"],
    [jwt.sign({ sid: firstSid, account_id: second.account_id }, config.jwtSecret, { expiresIn: "30d" }), "bound-device"],
    [jwt.sign({ phone_number: first.phone, sid: firstSid }, "wrong-signing-secret", { expiresIn: "30d" }), "bound-device"],
    [jwt.sign({ phone_number: first.phone, sid: firstSid }, config.jwtSecret, { expiresIn: -1 }), "bound-device"]
  ];

  for (const [token, deviceIdentity] of cases) {
    const response = await app.inject({
      method: "GET",
      url: "/profile",
      headers: authHeaders(token, deviceIdentity)
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.deepEqual(response.json(), INVALID_SESSION_REPLY);
  }

  // Signed sid is authoritative; stale phone claim is ignored in M1a.
  const stalePhoneProfile = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(
      jwt.sign({ phone_number: second.phone, sid: firstSid }, config.jwtSecret, { expiresIn: "30d" }),
      "bound-device"
    )
  });
  assert.equal(stalePhoneProfile.statusCode, 200, stalePhoneProfile.body);
  assert.equal(stalePhoneProfile.json().account_id, first.account_id);

  const mismatchedDevice = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(first.auth_token, "wrong-device")
  });
  assert.equal(mismatchedDevice.statusCode, 401, mismatchedDevice.body);
  assert.deepEqual(mismatchedDevice.json(), DEVICE_MISMATCH_REPLY);

  const missingDevice = await app.inject({
    method: "GET",
    url: "/profile",
    headers: { authorization: `Bearer ${first.auth_token}` }
  });
  assert.equal(missingDevice.statusCode, 401, missingDevice.body);
  assert.deepEqual(missingDevice.json(), DEVICE_MISMATCH_REPLY);

  const workingDevice = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(first.auth_token, first.deviceIdentity)
  });
  assert.equal(workingDevice.statusCode, 200, workingDevice.body);

  const legacyLogout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: authHeaders(cases[0][0], "bound-device")
  });
  assert.equal(legacyLogout.statusCode, 204, legacyLogout.body);

  for (const [token, deviceIdentity] of cases.slice(1)) {
    const invalidLogout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: authHeaders(token, deviceIdentity)
    });
    assert.equal(invalidLogout.statusCode, 401, invalidLogout.body);
    assert.deepEqual(invalidLogout.json(), INVALID_SESSION_REPLY);
  }
  assert.equal((await sessionRow(firstSid)).revoked_at, null);
});

test("A3: a guarded route distinguishes a missing token from an invalid session", async () => {
  const response = await app.inject({ method: "GET", url: "/profile" });
  assert.equal(response.statusCode, 401, response.body);
  assert.deepEqual(response.json(), MISSING_TOKEN_REPLY);
});

test("A3: a guard database failure is retryable and does not become session_invalid", async () => {
  const signedIn = await signIn({ phone: "+12025550210", deviceIdentity: "guard-query-failure" });
  poolRecorder.failNextQueryMatching(/FROM\s+user_sessions\s+s/i);

  const unavailable = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
  });
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.deepEqual(unavailable.json(), { error: "auth_unavailable" });

  const retry = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
  });
  assert.equal(retry.statusCode, 200, retry.body);
});

test("A1: a logout revocation query failure is retryable and leaves the session active", async () => {
  const signedIn = await signIn({ phone: "+12025550211", deviceIdentity: "logout-query-failure" });
  const sessionId = jwt.decode(signedIn.auth_token).sid;
  poolRecorder.failNextQueryMatching(/UPDATE\s+user_sessions\s+AS\s+s/i);

  const unavailable = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
  });
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.deepEqual(unavailable.json(), { error: "logout_unavailable" });
  assert.equal((await sessionRow(sessionId)).revoked_at, null);

  const retry = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
  });
  assert.equal(retry.statusCode, 204, retry.body);
  assert.ok((await sessionRow(sessionId)).revoked_at);
});

test("A3/A4: device revocation atomically revokes its sessions without affecting another device", async () => {
  const email = `${unique("revoke-device")}@example.test`;
  const first = await signIn({ email, phone: "+12025550212", deviceIdentity: "revoke-first-device" });
  const second = await signIn({ email, phone: first.phone, deviceIdentity: "revoke-second-device" });
  const firstSessionId = jwt.decode(first.auth_token).sid;

  poolRecorder.failNextQueryMatching(/UPDATE\s+user_sessions\s+SET\s+revoked_at/i);
  const failed = await app.inject({
    method: "POST",
    url: "/identity/revoke",
    headers: authHeaders(first.auth_token, first.deviceIdentity),
    payload: { device_identity: first.deviceIdentity }
  });
  assert.equal(failed.statusCode, 500, failed.body);
  assert.equal((await sessionRow(firstSessionId)).revoked_at, null);
  const failedDevice = await database.query(
    "SELECT revoked_at FROM device_identities WHERE device_identity = $1",
    [first.deviceIdentity]
  );
  assert.equal(failedDevice.rows[0].revoked_at, null);

  const revoked = await app.inject({
    method: "POST",
    url: "/identity/revoke",
    headers: authHeaders(first.auth_token, first.deviceIdentity),
    payload: { device_identity: first.deviceIdentity }
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.ok((await sessionRow(firstSessionId)).revoked_at);

  const refused = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(first.auth_token, first.deviceIdentity)
  });
  assert.equal(refused.statusCode, 401, refused.body);
  assert.deepEqual(refused.json(), INVALID_SESSION_REPLY);

  const unaffected = await app.inject({
    method: "GET",
    url: "/profile",
    headers: authHeaders(second.auth_token, second.deviceIdentity)
  });
  assert.equal(unaffected.statusCode, 200, unaffected.body);
});

test("A3: logout-all reports database failures as retryable", async () => {
  const signedIn = await signIn({ phone: "+12025550213", deviceIdentity: "logout-all-query-failure" });
  const sessionId = jwt.decode(signedIn.auth_token).sid;
  poolRecorder.failNextQueryMatching(/UPDATE\s+user_sessions\s+SET\s+revoked_at/i);

  const unavailable = await app.inject({
    method: "POST",
    url: "/auth/logout-all",
    headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
  });
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.deepEqual(unavailable.json(), { error: "logout_unavailable" });
  assert.equal((await sessionRow(sessionId)).revoked_at, null);
});

test("A2: a commit failure after session insertion leaves no usable session or token response", async () => {
  const email = `${unique("commit-failure")}@example.test`;
  const phone = "+12025550207";
  const code = await requestCode(email, phone);
  poolRecorder.failNextCommit();
  const response = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: {
      channel: "email",
      email,
      phone_number: phone,
      code,
      device_identity: "commit-device",
      public_key: "commit-key"
    }
  });
  assert.equal(response.statusCode, 500, response.body);
  assert.equal(Object.hasOwn(response.json(), "auth_token"), false);
  assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM user_sessions")).rows[0].count, 0);
});

test("A3/A6: every registered shared-guard route refuses a token after revocation and public routes stay public", async () => {
  const expectedRoutes = [
    "GET /health",
    "GET /ready",
    "GET /records",
    "GET /profile",
    "GET /devices",
    "GET /.well-known/verification-key.json",
    "GET /verify/:vt_id",
    "POST /auth/otp/request",
    "POST /auth/otp/verify",
    "POST /auth/logout",
    "POST /auth/logout-all",
    "POST /profile",
    "POST /sync/entries",
    "POST /identity/rotate/challenge",
    "POST /identity/rotate",
    "POST /identity/revoke",
    "POST /attest",
    "POST /report/generate-pdf",
    "HEAD /health",
    "HEAD /ready",
    "HEAD /records",
    "HEAD /profile",
    "HEAD /devices",
    "HEAD /.well-known/verification-key.json",
    "HEAD /verify/:vt_id"
  ].sort();
  assert.deepEqual([...registeredRoutes].sort(), expectedRoutes);

  const signedIn = await signIn({ phone: "+12025550208", deviceIdentity: "route-device" });
  const logout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
  });
  assert.equal(logout.statusCode, 204, logout.body);

  const guardedRoutes = [
    ["GET", "/records"],
    ["GET", "/profile"],
    ["GET", "/devices"],
    ["HEAD", "/records"],
    ["HEAD", "/profile"],
    ["HEAD", "/devices"],
    ["POST", "/auth/logout-all"],
    ["POST", "/profile"],
    ["POST", "/sync/entries"],
    ["POST", "/identity/rotate/challenge"],
    ["POST", "/identity/rotate"],
    ["POST", "/identity/revoke"],
    ["POST", "/attest"],
    ["POST", "/report/generate-pdf"]
  ];
  for (const [method, url] of guardedRoutes) {
    const response = await app.inject({
      method,
      url,
      headers: authHeaders(signedIn.auth_token, signedIn.deviceIdentity)
    });
    assert.equal(response.statusCode, 401, `${method} ${url}: ${response.body}`);
    if (method !== "HEAD") {
      assert.deepEqual(response.json(), INVALID_SESSION_REPLY);
    }
  }

  const publicRoutes = [
    ["GET", "/health"],
    ["GET", "/ready"],
    ["GET", "/.well-known/verification-key.json"],
    ["GET", "/verify/not-a-real-attestation"],
    ["HEAD", "/health"],
    ["HEAD", "/ready"],
    ["HEAD", "/.well-known/verification-key.json"],
    ["HEAD", "/verify/not-a-real-attestation"],
    ["POST", "/auth/otp/request"],
    ["POST", "/auth/otp/verify"]
  ];
  assert.deepEqual(
    publicRoutes.map(([method, url]) => `${method} ${url.replace("/not-a-real-attestation", "/:vt_id")}`).sort(),
    [
      "GET /health",
      "GET /ready",
      "GET /.well-known/verification-key.json",
      "GET /verify/:vt_id",
      "HEAD /health",
      "HEAD /ready",
      "HEAD /.well-known/verification-key.json",
      "HEAD /verify/:vt_id",
      "POST /auth/otp/request",
      "POST /auth/otp/verify"
    ].sort()
  );
  for (const [method, url] of publicRoutes) {
    const response = await app.inject({ method, url });
    assert.notEqual(response.statusCode, 401, `${method} ${url}: ${response.body}`);
  }
});
