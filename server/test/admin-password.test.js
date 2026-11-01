import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as database from "../src/db.js";
import { getPool, query } from "../src/db.js";
import {
  hashAdminPassword,
  validateAdminPassword,
  verifyAdminPassword
} from "../src/admin-auth-utils.js";
import { resetAdminPassword } from "../src/admin-password.js";
import {
  TEST_ADMIN_PASSWORD,
  buildApp,
  createSession,
  prepareAdminTestDatabase,
  seedAdmin
} from "./helpers/admin.js";
import { config } from "../src/config.js";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function login(app, email, password) {
  return app.inject({
    method: "POST",
    url: "/admin/auth/login",
    remoteAddress: "198.51.100.80",
    payload: { email, password }
  });
}

async function lockAdminRow(adminId) {
  const client = await getPool().connect();
  await client.query("BEGIN");
  await client.query("SELECT id FROM admin_users WHERE id = $1 FOR UPDATE", [adminId]);
  const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  return { client, pid };
}

async function waitForAdminRowLockWaiters(blockerPid, expectedCount) {
  const deadline = Date.now() + 5_000;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const result = await query(
      `
        WITH RECURSIVE blocking_chain AS (
          SELECT
            activity.pid AS waiter_pid,
            blocker.pid AS blocker_pid,
            ARRAY[activity.pid, blocker.pid] AS path
          FROM pg_stat_activity AS activity
          CROSS JOIN LATERAL unnest(pg_blocking_pids(activity.pid)) AS blocker(pid)
          WHERE activity.datname = current_database()
            AND activity.pid <> pg_backend_pid()
            AND activity.wait_event_type = 'Lock'
            AND activity.query ILIKE '%admin_users%'
            AND activity.query ILIKE '%FOR UPDATE%'

          UNION ALL

          SELECT
            chain.waiter_pid,
            blocker.pid AS blocker_pid,
            chain.path || blocker.pid
          FROM blocking_chain AS chain
          CROSS JOIN LATERAL unnest(pg_blocking_pids(chain.blocker_pid)) AS blocker(pid)
          WHERE NOT blocker.pid = ANY(chain.path)
        )
        SELECT DISTINCT activity.pid, activity.query
        FROM pg_stat_activity AS activity
        INNER JOIN blocking_chain AS chain ON chain.waiter_pid = activity.pid
        WHERE chain.blocker_pid = $1
      `,
      [blockerPid]
    );
    lastCount = result.rows.length;
    if (lastCount === expectedCount) return;
    if (lastCount > expectedCount) {
      throw new Error(`Expected ${expectedCount} admin row-lock waiters, found ${lastCount}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expectedCount} admin row-lock waiters; last observed ${lastCount}.`);
}

async function resetInHeldTransaction(client, adminId, passwordHash, reason = "operator_script") {
  await client.query(
    `
      UPDATE admin_users
      SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = NOW()
      WHERE id = $1
    `,
    [adminId, passwordHash]
  );
  await client.query(
    `
      UPDATE admin_sessions
      SET revoked_at = COALESCE(revoked_at, NOW())
      WHERE admin_user_id = $1
    `,
    [adminId]
  );
  await client.query(
    `
      INSERT INTO admin_audit_log (admin_user_id, action, subject_type, subject_id, reason)
      VALUES (NULL, 'admin.password.reset', 'admin_user', $1, $2)
    `,
    [adminId, reason]
  );
}

async function activeSessionCount(adminId) {
  return (await query(
    "SELECT COUNT(*)::int AS count FROM admin_sessions WHERE admin_user_id = $1 AND revoked_at IS NULL",
    [adminId]
  )).rows[0].count;
}

function runScriptWithoutTty() {
  const child = spawn(process.execPath, ["scripts/reset-admin-password.js"], {
    cwd: serverDir,
    env: { ...process.env }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return once(child, "close").then(([code]) => ({ code, stderr }));
}

before(async () => {
  await prepareAdminTestDatabase({ migrations: [new URL("../migrations/009_admin_backend.sql", import.meta.url)] });
  config.adminJwtSecret = crypto.randomBytes(32).toString("hex");
  config.adminJwtExpiry = "1h";
});

beforeEach(async () => {
  await query("TRUNCATE admin_audit_log, admin_sessions, admin_users RESTART IDENTITY CASCADE");
});

after(async () => {
  await getPool().end();
});

test("reset replaces the password, revokes only that admin's sessions, and records safe audit data", async () => {
  const app = await buildApp();
  const admin = await seedAdmin("owner");
  const other = await seedAdmin("viewer");
  const oldSession = await createSession(admin);
  const otherSession = await createSession(other);
  const oldHash = (await query("SELECT password_hash FROM admin_users WHERE id = $1", [admin.id])).rows[0].password_hash;
  const newPassword = "new operator password";
  try {
    await resetAdminPassword(database, { email: admin.email, passwordHash: await hashAdminPassword(newPassword), reason: "operator_script" });
    assert.equal((await login(app, admin.email, TEST_ADMIN_PASSWORD)).statusCode, 401);
    assert.equal((await login(app, admin.email, newPassword)).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/admin/auth/me", headers: { authorization: `Bearer ${oldSession.token}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/admin/auth/me", headers: { authorization: `Bearer ${otherSession.token}` } })).statusCode, 200);
    const stored = (await query("SELECT password_hash, failed_login_count, locked_until FROM admin_users WHERE id = $1", [admin.id])).rows[0];
    assert.notEqual(stored.password_hash, oldHash);
    assert.match(stored.password_hash, /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/i);
    assert.equal(stored.failed_login_count, 0);
    assert.equal(stored.locked_until, null);
    const audit = (await query("SELECT row_to_json(row_value)::text AS value FROM admin_audit_log row_value WHERE action = 'admin.password.reset'", [])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].value.includes(newPassword), false);
    assert.equal(audit[0].value.includes(stored.password_hash), false);
    assert.equal(audit[0].value.includes(oldHash), false);
  } finally {
    await app.close();
  }
});

test("reset permits a previously locked admin to sign in", async () => {
  const app = await buildApp();
  const admin = await seedAdmin();
  const password = "eight888";
  await query("UPDATE admin_users SET failed_login_count = 10, locked_until = NOW() + INTERVAL '15 minutes' WHERE id = $1", [admin.id]);
  try {
    await resetAdminPassword(database, { email: admin.email, passwordHash: await hashAdminPassword(password) });
    assert.equal((await login(app, admin.email, password)).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("reset refuses unknown and non-active admins without changing rows", async () => {
  const admin = await seedAdmin();
  const hash = await hashAdminPassword("eight888");
  await assert.rejects(resetAdminPassword(database, { email: "missing@example.test", passwordHash: hash }), /could not be completed/);
  await query("UPDATE admin_users SET status = 'DISABLED' WHERE id = $1", [admin.id]);
  const before = await query("SELECT password_hash, failed_login_count, locked_until, status FROM admin_users WHERE id = $1", [admin.id]);
  await assert.rejects(resetAdminPassword(database, { email: admin.email, passwordHash: hash }), /could not be completed/);
  const after = await query("SELECT password_hash, failed_login_count, locked_until, status FROM admin_users WHERE id = $1", [admin.id]);
  assert.deepEqual(after.rows, [{ ...before.rows[0] }]);
  assert.equal((await query("SELECT COUNT(*)::int AS count FROM admin_audit_log")).rows[0].count, 0);
});

test("password rules have exact bounds and do not reject existing short passwords at login", async () => {
  assert.equal(validateAdminPassword("1234567"), false);
  assert.equal(validateAdminPassword("12345678"), true);
  assert.equal(validateAdminPassword("a".repeat(256)), true);
  assert.equal(validateAdminPassword("a".repeat(257)), false);
  assert.equal(validateAdminPassword("        "), false);
  const app = await buildApp();
  const admin = await seedAdmin();
  const shortPassword = "123456";
  await query("UPDATE admin_users SET password_hash = $2 WHERE id = $1", [admin.id, await hashAdminPassword(shortPassword)]);
  try {
    assert.equal((await login(app, admin.email, shortPassword)).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("each reset uses a distinct scrypt salt", async () => {
  const admin = await seedAdmin();
  const password = "same new password";
  await resetAdminPassword(database, { email: admin.email, passwordHash: await hashAdminPassword(password) });
  const first = (await query("SELECT password_hash FROM admin_users WHERE id = $1", [admin.id])).rows[0].password_hash;
  await resetAdminPassword(database, { email: admin.email, passwordHash: await hashAdminPassword(password) });
  const second = (await query("SELECT password_hash FROM admin_users WHERE id = $1", [admin.id])).rows[0].password_hash;
  assert.notEqual(first, second);
  assert.equal(await verifyAdminPassword(password, second), true);
});

test("a reset rolls back when audit or session revocation fails", async () => {
  const admin = await seedAdmin();
  const session = await createSession(admin);
  const original = (await query("SELECT password_hash FROM admin_users WHERE id = $1", [admin.id])).rows[0].password_hash;
  const failRevocation = {
    withTransaction: (run) => database.withTransaction((client) => run({
      ...client,
      query: (text, values) => /UPDATE admin_sessions/.test(text) ? Promise.reject(new Error("forced revoke failure")) : client.query(text, values)
    }))
  };
  await assert.rejects(resetAdminPassword(failRevocation, { email: admin.email, passwordHash: await hashAdminPassword("eight888") }), /forced revoke failure/);
  assert.equal((await query("SELECT password_hash FROM admin_users WHERE id = $1", [admin.id])).rows[0].password_hash, original);
  assert.equal((await query("SELECT revoked_at FROM admin_sessions WHERE jti = $1", [session.jti])).rows[0].revoked_at, null);

  await query("ALTER TABLE admin_audit_log ADD CONSTRAINT admin_password_reset_reject_audit CHECK (false) NOT VALID");
  try {
    await assert.rejects(resetAdminPassword(database, { email: admin.email, passwordHash: await hashAdminPassword("another88") }));
  } finally {
    await query("ALTER TABLE admin_audit_log DROP CONSTRAINT admin_password_reset_reject_audit");
  }
  assert.equal((await query("SELECT password_hash FROM admin_users WHERE id = $1", [admin.id])).rows[0].password_hash, original);
  assert.equal((await query("SELECT revoked_at FROM admin_sessions WHERE jti = $1", [session.jti])).rows[0].revoked_at, null);
});

test("reset script refuses a non-interactive invocation before database access", async () => {
  const result = await runScriptWithoutTty();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /interactive terminal/);
  assert.equal((await query("SELECT COUNT(*)::int AS count FROM admin_users")).rows[0].count, 0);
});

test("a reset rejects an old-password login that already verified before the admin row lock", async () => {
  const app = await buildApp();
  const admin = await seedAdmin();
  const existingSession = await createSession(admin);
  const newPassword = "replacement password";
  const holder = await lockAdminRow(admin.id);
  let pendingLogin;
  let committed = false;
  try {
    // The observed wait proves scrypt verified the old hash before this request
    // reached its SELECT ... FOR UPDATE recheck.
    pendingLogin = login(app, admin.email, TEST_ADMIN_PASSWORD);
    await waitForAdminRowLockWaiters(holder.pid, 1);
    await resetInHeldTransaction(holder.client, admin.id, await hashAdminPassword(newPassword));
    await holder.client.query("COMMIT");
    committed = true;

    const response = await pendingLogin;
    assert.equal(response.statusCode, 401, response.body);
    assert.deepEqual(response.json(), { error: "Invalid admin credentials." });
    assert.equal(await activeSessionCount(admin.id), 0);
    assert.equal((await query(
      "SELECT COUNT(*)::int AS count FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'admin.login.success'",
      [admin.id]
    )).rows[0].count, 0);
    assert.notEqual((await query("SELECT revoked_at FROM admin_sessions WHERE jti = $1", [existingSession.jti])).rows[0].revoked_at, null);
  } finally {
    if (!committed) await holder.client.query("ROLLBACK").catch(() => {});
    await pendingLogin?.catch(() => {});
    holder.client.release();
    await app.close();
  }
});

test("the new password after a reset creates exactly one active session", async () => {
  const app = await buildApp();
  const admin = await seedAdmin();
  const newPassword = "replacement password";
  try {
    await resetAdminPassword(database, { email: admin.email, passwordHash: await hashAdminPassword(newPassword) });
    const response = await login(app, admin.email, newPassword);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await activeSessionCount(admin.id), 1);
  } finally {
    await app.close();
  }
});

test("overlapping resets serialize, revoke sessions, and record both resets", async () => {
  const admin = await seedAdmin();
  await createSession(admin);
  const firstHash = await hashAdminPassword("first replacement password");
  const secondHash = await hashAdminPassword("second replacement password");
  const holder = await lockAdminRow(admin.id);
  let firstReset;
  let secondReset;
  let committed = false;
  try {
    firstReset = resetAdminPassword(database, { email: admin.email, passwordHash: firstHash, reason: "first" });
    secondReset = resetAdminPassword(database, { email: admin.email, passwordHash: secondHash, reason: "second" });
    await waitForAdminRowLockWaiters(holder.pid, 2);
    await holder.client.query("COMMIT");
    committed = true;
    await Promise.all([firstReset, secondReset]);

    const storedHash = (await query("SELECT password_hash FROM admin_users WHERE id = $1", [admin.id])).rows[0].password_hash;
    assert.ok([firstHash, secondHash].includes(storedHash));
    assert.equal(await activeSessionCount(admin.id), 0);
    assert.equal((await query(
      "SELECT COUNT(*)::int AS count FROM admin_audit_log WHERE action = 'admin.password.reset' AND subject_id = $1",
      [admin.id]
    )).rows[0].count, 2);
  } finally {
    if (!committed) await holder.client.query("ROLLBACK").catch(() => {});
    await Promise.allSettled([firstReset, secondReset].filter(Boolean));
    holder.client.release();
  }
});

test("a concurrent reset clears a lockout and rejects the login that verified before it", async () => {
  const app = await buildApp();
  const admin = await seedAdmin();
  const newPassword = "replacement password";
  const holder = await lockAdminRow(admin.id);
  let pendingLogin;
  let pendingReset;
  let committed = false;
  try {
    // This request reads an unlocked row and verifies the old password, then
    // blocks at the transactional recheck while the lockout is made durable.
    pendingLogin = login(app, admin.email, TEST_ADMIN_PASSWORD);
    await waitForAdminRowLockWaiters(holder.pid, 1);
    pendingReset = resetAdminPassword(database, {
      email: admin.email,
      passwordHash: await hashAdminPassword(newPassword)
    });
    await waitForAdminRowLockWaiters(holder.pid, 2);
    await holder.client.query(
      "UPDATE admin_users SET failed_login_count = 10, locked_until = NOW() + INTERVAL '15 minutes' WHERE id = $1",
      [admin.id]
    );
    await holder.client.query("COMMIT");
    committed = true;

    const [loginResponse] = await Promise.all([pendingLogin, pendingReset]);
    assert.equal(loginResponse.statusCode, 401, loginResponse.body);
    assert.deepEqual(loginResponse.json(), { error: "Invalid admin credentials." });
    assert.equal(await activeSessionCount(admin.id), 0);
    const row = (await query("SELECT failed_login_count, locked_until FROM admin_users WHERE id = $1", [admin.id])).rows[0];
    assert.equal(row.failed_login_count, 0);
    assert.equal(row.locked_until, null);
    assert.equal((await login(app, admin.email, newPassword)).statusCode, 200);
  } finally {
    if (!committed) await holder.client.query("ROLLBACK").catch(() => {});
    await Promise.allSettled([pendingLogin, pendingReset].filter(Boolean));
    holder.client.release();
    await app.close();
  }
});
