import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../src/config.js";
import { getPool } from "../src/db.js";
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
  instrumentApplicationPool,
  resetTestDatabase
} from "./helpers/db.js";

// This guard intentionally runs before a pool is created or any SQL is issued.
assertLocalTestDatabase(config.databaseUrl);

const INVALID_SESSION_REPLY = { error: "session_invalid" };
const MISSING_TOKEN_REPLY = { error: "token_missing" };
const DEVICE_MISMATCH_REPLY = { error: "device_mismatch" };
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
  const response = await app.inject({
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
  assert.equal(response.statusCode, 200, response.body);
  return { email, phone, deviceIdentity, ...response.json() };
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
    [jwt.sign({ phone_number: second.phone, sid: firstSid }, config.jwtSecret, { expiresIn: "30d" }), "bound-device"],
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
