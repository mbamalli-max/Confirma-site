import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  issueAdminToken
} from "../src/admin-auth-utils.js";
import {
  config,
  resolveTrustProxy,
  validateRuntimeConfig
} from "../src/config.js";
import { getPool, query } from "../src/db.js";
import {
  ADMIN_ORIGIN,
  PUBLIC_ORIGINS,
  TEST_ADMIN_PASSWORD,
  TEST_TOTP_SECRET,
  buildApp,
  createSession,
  prepareAdminTestDatabase,
  rejectAuditInserts,
  seedAdmin,
  totpToken,
  wrongTotp
} from "./helpers/admin.js";

async function login(app, adminUser, overrides = {}, remoteAddress = `198.51.100.${crypto.randomInt(1, 250)}`) {
  return app.inject({
    method: "POST",
    url: "/admin/auth/login",
    remoteAddress,
    payload: {
      email: adminUser.email,
      password: TEST_ADMIN_PASSWORD,
      totp: totpToken(TEST_TOTP_SECRET),
      ...overrides
    }
  });
}

function productionConfig(overrides = {}) {
  Object.assign(config, {
    nodeEnv: "production",
    jwtSecret: crypto.randomBytes(32).toString("hex"),
    serverReceiptSecret: crypto.randomBytes(32).toString("hex"),
    serverAttestationPrivateKeyPem: "configured-for-test",
    allowDevOtp: true,
    smsProviderEnabled: false,
    adminJwtSecret: crypto.randomBytes(32).toString("hex"),
    adminTotpEncKey: crypto.randomBytes(32).toString("hex"),
    ...overrides
  });
}

async function withConfig(run) {
  const snapshot = { ...config };
  try {
    await run();
  } finally {
    Object.assign(config, snapshot);
  }
}

before(async () => {
  await prepareAdminTestDatabase({
    migrations: [new URL("../migrations/009_admin_backend.sql", import.meta.url)]
  });
  config.adminJwtSecret = crypto.randomBytes(32).toString("hex");
  config.adminTotpEncKey = crypto.randomBytes(32).toString("hex");
  config.adminJwtExpiry = "1h";
  config.adminIpAllowlist = "";
  config.trustProxy = undefined;
});

beforeEach(async () => {
  config.adminCorsOrigins = ADMIN_ORIGIN;
  config.adminIpAllowlist = "";
  config.trustProxy = undefined;
  config.adminJwtExpiry = "1h";
  await query("TRUNCATE admin_audit_log, admin_sessions, admin_users RESTART IDENTITY CASCADE");
});

after(async () => {
  await getPool().end();
});

test("1: protected admin routes reject unauthenticated requests", async () => {
  const app = await buildApp();
  try {
    for (const [method, url] of [["POST", "/admin/auth/logout"], ["GET", "/admin/auth/me"], ["GET", "/admin/audit"]]) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
    }
  } finally {
    await app.close();
  }
});

test("2: login succeeds without a bearer token when all credentials are valid", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  try {
    const response = await login(app, adminUser);
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().token);
  } finally {
    await app.close();
  }
});

test("3: an authenticated admin with an insufficient role receives 403", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin("viewer");
  const session = await createSession(adminUser);
  try {
    const response = await app.inject({
      method: "GET",
      url: "/admin/owner-only",
      headers: { authorization: `Bearer ${session.token}` }
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("4: password-only login is rejected", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  try {
    const response = await login(app, adminUser, { totp: undefined });
    assert.notEqual(response.statusCode, 200);
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("5: a wrong TOTP is rejected and increments failed_login_count", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  try {
    const response = await login(app, adminUser, { totp: wrongTotp() });
    assert.equal(response.statusCode, 401);
    const result = await query("SELECT failed_login_count FROM admin_users WHERE id = $1", [adminUser.id]);
    assert.equal(result.rows[0].failed_login_count, 1);
  } finally {
    await app.close();
  }
});

test("6: ten failures lock the admin for 15 minutes and block correct credentials", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  try {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await login(app, adminUser, { totp: wrongTotp() }, `203.0.113.${attempt}`);
      assert.equal(response.statusCode, 401);
    }
    const locked = await query("SELECT failed_login_count, locked_until FROM admin_users WHERE id = $1", [adminUser.id]);
    assert.equal(locked.rows[0].failed_login_count, 10);
    assert.ok(new Date(locked.rows[0].locked_until).getTime() > Date.now());
    const response = await login(app, adminUser, {}, "203.0.113.200");
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("6a: database lockout remains enforced when the application clock is twenty minutes ahead", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  const originalDateNow = Date.now;
  await query(
    `UPDATE admin_users SET locked_until = clock_timestamp() + INTERVAL '5 minutes' WHERE id = $1`,
    [adminUser.id]
  );
  try {
    Date.now = () => originalDateNow() + 20 * 60_000;
    const response = await login(app, adminUser);
    assert.equal(response.statusCode, 401);
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM admin_sessions WHERE admin_user_id = $1`, [adminUser.id])).rows[0].count, 0);
  } finally {
    Date.now = originalDateNow;
    await app.close();
  }
});

test("6b: elapsed database lockout permits login when the application clock is twenty minutes behind", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  const originalDateNow = Date.now;
  await query(
    `UPDATE admin_users SET locked_until = clock_timestamp() - INTERVAL '5 minutes' WHERE id = $1`,
    [adminUser.id]
  );
  try {
    Date.now = () => originalDateNow() - 20 * 60_000;
    const response = await login(app, adminUser);
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().token);
  } finally {
    Date.now = originalDateNow;
    await app.close();
  }
});

test("7: logout revokes the session jti", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  const session = await createSession(adminUser);
  try {
    const headers = { authorization: `Bearer ${session.token}` };
    assert.equal((await app.inject({ method: "POST", url: "/admin/auth/logout", headers })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/admin/auth/me", headers })).statusCode, 401);
    const audit = await query(
      `SELECT COUNT(*)::int AS count FROM admin_audit_log WHERE action = 'admin.logout'`
    );
    assert.equal(audit.rows[0].count, 1);
  } finally {
    await app.close();
  }
});

test("8: an expired admin token is rejected", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  const jti = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  const token = jwt.sign(
    {
      sub: String(adminUser.id),
      role: String(adminUser.role),
      jti,
      iat: now - 120,
      exp: now - 60
    },
    config.adminJwtSecret,
    { algorithm: "HS256" }
  );
  await query(
    `INSERT INTO admin_sessions (jti, admin_user_id, expires_at) VALUES ($1, $2, $3)`,
    [jti, adminUser.id, new Date(Date.now() + 60_000)]
  );
  try {
    const response = await app.inject({
      method: "GET",
      url: "/admin/auth/me",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("9: production config without ADMIN_JWT_SECRET is fatal", async () => {
  await withConfig(() => {
    productionConfig({ adminJwtSecret: "" });
    assert.throws(() => validateRuntimeConfig(), (error) => error.fatal === true && /ADMIN_JWT_SECRET/.test(error.message));
  });
});

test("10: production config rejects reuse of JWT_SECRET for admin JWTs", async () => {
  await withConfig(() => {
    const shared = crypto.randomBytes(32).toString("hex");
    productionConfig({ jwtSecret: shared, adminJwtSecret: shared });
    assert.throws(() => validateRuntimeConfig(), (error) => error.fatal === true && /different from JWT_SECRET/.test(error.message));
  });
});

test("10a: only a 64-hex-character ADMIN_TOTP_ENC_KEY passes production validation", async () => {
  await withConfig(() => {
    productionConfig({ adminTotpEncKey: crypto.randomBytes(32).toString("hex") });
    assert.doesNotThrow(() => validateRuntimeConfig());
    for (const invalid of ["", "a".repeat(63), "a".repeat(65), "z".repeat(32), "a".repeat(128)]) {
      productionConfig({ adminTotpEncKey: invalid });
      assert.throws(() => validateRuntimeConfig(), (error) => error.fatal === true && /ADMIN_TOTP_ENC_KEY/.test(error.message));
    }
  });
});

test("10b: TOTP encryption round-trips and GCM rejects tampering", async () => {
  await withConfig(() => {
    config.adminTotpEncKey = crypto.randomBytes(32).toString("hex");
    config.adminTotpEncKeyBytes = null;
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    assert.equal(decryptTotpSecret(encrypted), secret);
    const parts = encrypted.split("$");
    parts[3] = `${parts[3].slice(0, -2)}${parts[3].endsWith("00") ? "01" : "00"}`;
    assert.throws(() => decryptTotpSecret(parts.join("$")));
    const tagParts = encrypted.split("$");
    tagParts[2] = `${tagParts[2].slice(0, -2)}${tagParts[2].endsWith("00") ? "01" : "00"}`;
    assert.throws(() => decryptTotpSecret(tagParts.join("$")));
  });
});

test("10c: accepted ADMIN_JWT_EXPIRY strings issue one-hour tokens", async () => {
  await withConfig(() => {
    productionConfig();
    for (const expiry of ["1h", "60m", "3600s", "3600"]) {
      config.adminJwtExpiry = expiry;
      assert.doesNotThrow(() => validateRuntimeConfig(), expiry);
      const token = issueAdminToken({ id: "expiry-test", role: "viewer" }, crypto.randomUUID());
      const decoded = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      assert.equal(decoded.exp - decoded.iat, 3_600, expiry);
    }
  });
});

test("10d: overlong or unparseable ADMIN_JWT_EXPIRY strings are fatal in production", async () => {
  await withConfig(() => {
    for (const expiry of ["2h", "30d", "90m", "7200", "banana"]) {
      productionConfig({ adminJwtExpiry: expiry });
      assert.throws(
        () => validateRuntimeConfig(),
        (error) => error.fatal === true && /ADMIN_JWT_EXPIRY/.test(error.message),
        expiry
      );
    }
  });
});

test("10e: production rejects an admin allowlist when proxy trust is unset or disabled", async () => {
  await withConfig(() => {
    for (const trustProxyValue of [undefined, "", "false", "0", "no", "off"]) {
      productionConfig({
        adminIpAllowlist: "203.0.113.10",
        trustProxy: resolveTrustProxy(trustProxyValue)
      });
      assert.throws(
        () => validateRuntimeConfig(),
        (error) => error.fatal === true
          && /ADMIN_IP_ALLOWLIST/.test(error.message)
          && /TRUST_PROXY/.test(error.message),
        String(trustProxyValue)
      );
    }
  });
});

test("10f: TRUST_PROXY rejects bare true instead of trusting every peer", async () => {
  await withConfig(() => {
    productionConfig({ trustProxy: resolveTrustProxy("true") });
    assert.throws(
      () => validateRuntimeConfig(),
      (error) => error.fatal === true && /bare true is not allowed/.test(error.message)
    );
  });
});

test("12a: audit inserts succeed while updates and deletes are trigger-blocked", async () => {
  await query("INSERT INTO admin_audit_log (action) VALUES ('test.insert')");
  await assert.rejects(query("UPDATE admin_audit_log SET action = 'x'"), /append-only/);
  await assert.rejects(query("DELETE FROM admin_audit_log"), /append-only/);
  assert.equal((await query("SELECT COUNT(*)::int AS count FROM admin_audit_log")).rows[0].count, 1);
});

test("11: login success and failure each create exactly one audit row", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  try {
    assert.equal((await login(app, adminUser)).statusCode, 200);
    assert.equal((await login(app, adminUser, { totp: wrongTotp() })).statusCode, 401);
    const result = await query(
      `SELECT action, COUNT(*)::int AS count FROM admin_audit_log GROUP BY action ORDER BY action`
    );
    assert.deepEqual(result.rows, [
      { action: "admin.login.failure", count: 1 },
      { action: "admin.login.success", count: 1 }
    ]);
  } finally {
    await app.close();
  }
});

test("11a: login success rolls back session and user state when its audit insert fails", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  await query(
    `UPDATE admin_users SET failed_login_count = 4, locked_until = NULL WHERE id = $1`,
    [adminUser.id]
  );
  try {
    await rejectAuditInserts(async () => {
      const response = await login(app, adminUser);
      assert.equal(response.statusCode, 500);
    });
    const sessions = await query(
      `SELECT COUNT(*)::int AS count FROM admin_sessions WHERE admin_user_id = $1`,
      [adminUser.id]
    );
    const user = await query(
      `SELECT failed_login_count, last_login_at FROM admin_users WHERE id = $1`,
      [adminUser.id]
    );
    assert.equal(sessions.rows[0].count, 0);
    assert.equal(user.rows[0].failed_login_count, 4);
    assert.equal(user.rows[0].last_login_at, null);
  } finally {
    await app.close();
  }
});

test("11b: login failure rolls back lockout state when its audit insert fails", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  await query(
    `UPDATE admin_users SET failed_login_count = 9, locked_until = NULL WHERE id = $1`,
    [adminUser.id]
  );
  try {
    await rejectAuditInserts(async () => {
      const response = await login(app, adminUser, { totp: wrongTotp() });
      assert.equal(response.statusCode, 500);
    });
    const user = await query(
      `SELECT failed_login_count, locked_until FROM admin_users WHERE id = $1`,
      [adminUser.id]
    );
    assert.equal(user.rows[0].failed_login_count, 9);
    assert.equal(user.rows[0].locked_until, null);
  } finally {
    await app.close();
  }
});

test("11c: logout rolls back revocation when its audit insert fails", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  const session = await createSession(adminUser);
  const headers = { authorization: `Bearer ${session.token}` };
  try {
    await rejectAuditInserts(async () => {
      const response = await app.inject({ method: "POST", url: "/admin/auth/logout", headers });
      assert.equal(response.statusCode, 500);
    });
    const storedSession = await query(
      `SELECT revoked_at FROM admin_sessions WHERE jti = $1`,
      [session.jti]
    );
    assert.equal(storedSession.rows[0].revoked_at, null);
    assert.equal(
      (await app.inject({ method: "GET", url: "/admin/auth/me", headers })).statusCode,
      200
    );
  } finally {
    await app.close();
  }
});

test("12: a viewer can read only their own audit rows", async () => {
  const app = await buildApp();
  const viewer = await seedAdmin("viewer");
  const other = await seedAdmin("owner");
  const session = await createSession(viewer);
  await query(
    `INSERT INTO admin_audit_log (admin_user_id, action) VALUES ($1, 'viewer.row'), ($2, 'other.row')`,
    [viewer.id, other.id]
  );
  try {
    const response = await app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: { authorization: `Bearer ${session.token}` }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().audit.map((row) => row.action), ["viewer.row"]);
  } finally {
    await app.close();
  }
});

test("13: public-site origin is not allowed on admin preflight", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/admin/auth/login",
      headers: { origin: PUBLIC_ORIGINS[0], "access-control-request-method": "POST" }
    });
    assert.notEqual(response.headers["access-control-allow-origin"], PUBLIC_ORIGINS[0]);
  } finally {
    await app.close();
  }
});

test("14: configured admin origin is allowed on admin preflight", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/admin/auth/login",
      headers: { origin: ADMIN_ORIGIN, "access-control-request-method": "POST" }
    });
    assert.equal(response.headers["access-control-allow-origin"], ADMIN_ORIGIN);
  } finally {
    await app.close();
  }
});

test("15: unset ADMIN_CORS_ORIGINS fails closed for admin preflight", async () => {
  config.adminCorsOrigins = "";
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/admin/auth/login",
      headers: { origin: "https://untrusted.example", "access-control-request-method": "POST" }
    });
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});

test("16: public health preflight retains the public CORS origin", async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { origin: PUBLIC_ORIGINS[0], "access-control-request-method": "GET" }
    });
    assert.equal(response.headers["access-control-allow-origin"], PUBLIC_ORIGINS[0]);
  } finally {
    await app.close();
  }
});

test("16a: an untrusted peer cannot spoof an allowlisted forwarded IP when trust is unset", async () => {
  config.adminIpAllowlist = "203.0.113.10";
  const app = await buildApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      remoteAddress: "198.51.100.20",
      headers: { "x-forwarded-for": "203.0.113.10" },
      payload: {}
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("16b: configured proxy trust still rejects a forged forwarded IP from an untrusted peer", async () => {
  config.adminIpAllowlist = "203.0.113.10";
  const trustProxy = resolveTrustProxy("10.0.0.0/8");
  const app = await buildApp({ trustProxy });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      remoteAddress: "198.51.100.20",
      headers: { "x-forwarded-for": "203.0.113.10" },
      payload: {}
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("16c: a trusted proxy can forward an allowlisted client address", async () => {
  config.adminIpAllowlist = "203.0.113.10";
  const trustProxy = resolveTrustProxy("10.0.0.0/8");
  const app = await buildApp({ trustProxy });
  const adminUser = await seedAdmin();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/admin/auth/login",
      remoteAddress: "10.0.0.20",
      headers: { "x-forwarded-for": "203.0.113.10" },
      payload: {
        email: adminUser.email,
        password: TEST_ADMIN_PASSWORD,
        totp: totpToken(TEST_TOTP_SECRET)
      }
    });
    assert.equal(response.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("17: every admin response carries Cache-Control no-store", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  const session = await createSession(adminUser);
  try {
    const requests = [
      { method: "POST", url: "/admin/auth/login", payload: {} },
      { method: "POST", url: "/admin/auth/logout" },
      { method: "GET", url: "/admin/auth/me" },
      { method: "GET", url: "/admin/audit" }
    ];
    for (const request of requests) {
      const response = await app.inject({
        ...request,
        headers: { authorization: `Bearer ${session.token}` }
      });
      assert.equal(response.headers["cache-control"], "no-store", `${request.method} ${request.url}`);
    }
  } finally {
    await app.close();
  }
});

test("18: admin response bodies expose no user-record sensitive fields", async () => {
  const app = await buildApp();
  const adminUser = await seedAdmin();
  const session = await createSession(adminUser);
  try {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/admin/auth/me", headers: { authorization: `Bearer ${session.token}` } }),
      app.inject({ method: "GET", url: "/admin/audit", headers: { authorization: `Bearer ${session.token}` } })
    ]);
    for (const response of responses) {
      const body = response.body.toLowerCase();
      for (const forbidden of ["phone_number", "payload", "otp_hash", "signature", "public_key"]) {
        assert.equal(body.includes(forbidden), false, `response included ${forbidden}`);
      }
    }
  } finally {
    await app.close();
  }
});
