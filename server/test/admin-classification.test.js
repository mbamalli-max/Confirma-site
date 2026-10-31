import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { countByClassification } from "../src/admin-classification.js";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import {
  ADMIN_ORIGIN,
  assertDisposableTestDatabase,
  buildApp,
  createSession,
  prepareAdminTestDatabase,
  rejectAuditInserts,
  seedAdmin
} from "./helpers/admin.js";

const FORMATTED_PHONE = "+1 (202) 555-0143";

function authHeader(session) {
  return { authorization: `Bearer ${session.token}` };
}

async function seedUser({ phone = `+1555${crypto.randomInt(1_000_000, 9_999_999)}`, records = 0 } = {}) {
  const userResult = await query(
    `INSERT INTO users (phone_number, phone_verified) VALUES ($1, TRUE) RETURNING id, phone_number, created_at`,
    [phone]
  );
  const user = userResult.rows[0];
  if (records > 0) {
    const deviceIdentity = `device-${crypto.randomUUID()}`;
    await query(
      `INSERT INTO device_identities (device_identity, public_key, phone_number, user_id) VALUES ($1, $2, $3, $4)`,
      [deviceIdentity, "synthetic-test-key", phone, user.id]
    );
    for (let entryId = 1; entryId <= records; entryId += 1) {
      await query(
        `
          INSERT INTO ledger_entries (
            device_identity, entry_id, entry_hash, prev_entry_hash,
            signature, confirmed_at, payload
          )
          VALUES ($1, $2, $3, $4, $5, NOW(), $6)
        `,
        [
          deviceIdentity,
          entryId,
          crypto.createHash("sha256").update(`${deviceIdentity}:${entryId}`).digest("hex"),
          entryId === 1 ? "0".repeat(64) : crypto.createHash("sha256").update(`${deviceIdentity}:${entryId - 1}`).digest("hex"),
          "synthetic-signature",
          JSON.stringify({ synthetic: true })
        ]
      );
    }
  }
  return user;
}

async function classify(userId, adminId, classification, reasonCode = "CORRECTION") {
  await query(
    `
      INSERT INTO account_classification (user_id, classification, reason_code, classified_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id) DO UPDATE SET
        classification = EXCLUDED.classification,
        reason_code = EXCLUDED.reason_code,
        classified_by = EXCLUDED.classified_by,
        updated_at = NOW()
    `,
    [userId, classification, reasonCode, adminId]
  );
}

async function ownerAccess() {
  const owner = await seedAdmin("owner");
  const session = await createSession(owner);
  return { owner, session, headers: authHeader(session) };
}

async function preview(app, headers, phone, classification, reasonCode, remoteAddress) {
  return app.inject({
    method: "POST",
    url: "/admin/classification/preview",
    headers,
    ...(remoteAddress ? { remoteAddress } : {}),
    payload: {
      phone_number: phone,
      classification,
      reason_code: reasonCode
    }
  });
}

async function applyToken(app, headers, confirmationToken) {
  return app.inject({
    method: "POST",
    url: "/admin/classification/apply",
    headers,
    payload: { confirmation_token: confirmationToken }
  });
}

async function waitForDatabaseCondition(statement, params = [], timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await query(statement, params);
    if (result.rows[0]?.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for database condition.");
}

async function assertPromisesPending(promises) {
  const settled = promises.map(() => false);
  promises.forEach((promise, index) => {
    promise.then(
      () => { settled[index] = true; },
      () => { settled[index] = true; }
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(settled, promises.map(() => false));
}

before(async () => {
  await prepareAdminTestDatabase({
    migrations: [
      new URL("../migrations/009_admin_backend.sql", import.meta.url),
      new URL("../migrations/010_account_classification.sql", import.meta.url),
      new URL("../migrations/011_admin_metrics_rollup.sql", import.meta.url),
      new URL("../migrations/012_admin_dimension_snapshot.sql", import.meta.url),
      new URL("../migrations/016_admin_exclusion_model.sql", import.meta.url),
      new URL("../migrations/017_sector_assignment.sql", import.meta.url)
    ]
  });
  config.adminJwtSecret = crypto.randomBytes(32).toString("hex");
  config.adminTotpEncKey = crypto.randomBytes(32).toString("hex");
  config.adminTotpEncKeyBytes = null;
  config.adminJwtExpiry = "1h";
  config.adminIpAllowlist = "";
  config.trustProxy = undefined;
});

beforeEach(async () => {
  config.adminCorsOrigins = ADMIN_ORIGIN;
  config.adminIpAllowlist = "";
  config.trustProxy = undefined;
  config.adminJwtExpiry = "1h";
  await query(`
    TRUNCATE
      admin_audit_log,
      admin_classification_confirmations,
      account_classification,
      admin_sessions,
      admin_users,
      ledger_entries,
      device_identities,
      users
    RESTART IDENTITY CASCADE
  `);
});

after(async () => {
  await getPool().end();
});

test("1: an account with no classification row is External (exclusion model, E1)", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  await seedUser({ records: 2 });
  await seedUser();
  try {
    const response = await app.inject({ method: "GET", url: "/admin/v2/exclusions", headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().api_version, 2);
    assert.deepEqual(response.json().accounts, { external: 2, excluded: 0, total: 2 });
    assert.equal(response.json().exclusions_last_changed, null);
    assert.equal(response.json().accounts_created_since, null);
    assert.equal(Object.hasOwn(response.json(), "provisional"), false);
  } finally {
    await app.close();
  }
});

test("2: internal test, demo and administrator accounts are excluded; an EXTERNAL row counts once", async () => {
  const app = await buildApp();
  const { owner, headers } = await ownerAccess();
  const users = await Promise.all([seedUser(), seedUser(), seedUser(), seedUser(), seedUser()]);
  await classify(users[0].id, owner.id, "EXTERNAL", "OWNER_CLASSIFIED_EXTERNAL");
  await classify(users[1].id, owner.id, "INTERNAL_TEST", "OPERATOR_TEST_ACCOUNT");
  await classify(users[2].id, owner.id, "DEMO", "OPERATOR_DEMO_ACCOUNT");
  await classify(users[3].id, owner.id, "INTERNAL_TEST", "OPERATOR_ADMIN_ACCOUNT");
  try {
    const response = await app.inject({ method: "GET", url: "/admin/v2/exclusions", headers });
    assert.deepEqual(response.json().accounts, { external: 2, excluded: 3, total: 5 });
  } finally {
    await app.close();
  }
});

test("3: the primitive returns a reconciled External / excluded split", async () => {
  const owner = await seedAdmin("owner");
  const users = await Promise.all([seedUser(), seedUser(), seedUser(), seedUser()]);
  await classify(users[0].id, owner.id, "EXTERNAL", "OWNER_CLASSIFIED_EXTERNAL");
  await classify(users[1].id, owner.id, "INTERNAL_TEST", "OPERATOR_TEST_ACCOUNT");
  await classify(users[2].id, owner.id, "DEMO", "OPERATOR_DEMO_ACCOUNT");
  const counts = await countByClassification(query, {
    fromSql: "users account",
    userIdColumn: "account.id",
    whereSql: "TRUE",
    params: []
  });
  assert.deepEqual(counts, { external: 2, excluded: 2, total: 4 });
  assert.equal(counts.total, counts.external + counts.excluded);
});

test("4: the primitive returns all three zero-valued keys with no rows", async () => {
  assert.deepEqual(await countByClassification(query, {
    fromSql: "users account",
    userIdColumn: "account.id",
    whereSql: "TRUE",
    params: []
  }), { external: 0, excluded: 0, total: 0 });
});

test("5: the primitive can split child rows through a supplied user id column", async () => {
  const owner = await seedAdmin("owner");
  const external = await seedUser({ records: 2 });
  const internal = await seedUser({ records: 1 });
  const unreviewed = await seedUser({ records: 1 });
  await classify(external.id, owner.id, "EXTERNAL", "OWNER_CLASSIFIED_EXTERNAL");
  await classify(internal.id, owner.id, "DEMO", "OPERATOR_DEMO_ACCOUNT");
  assert.ok(unreviewed.id);
  const counts = await countByClassification(query, {
    fromSql: "ledger_entries entry INNER JOIN device_identities device ON device.device_identity = entry.device_identity INNER JOIN users account ON account.phone_number = device.phone_number",
    userIdColumn: "account.id",
    whereSql: "entry.confirmed_at >= $1",
    params: [new Date(0)]
  });
  assert.deepEqual(counts, { external: 3, excluded: 1, total: 4 });
});

test("5a: exclusions last changed follows the latest successful set or clear, including clearing the last row", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const first = await seedUser();
  try {
    const token = (await preview(app, headers, first.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    assert.equal((await applyToken(app, headers, token)).statusCode, 200);
    const afterSet = (await app.inject({ method: "GET", url: "/admin/v2/exclusions", headers })).json();
    assert.match(afterSet.exclusions_last_changed, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(afterSet.accounts_created_since, 0);
    const later = await seedUser();
    await query(`UPDATE users SET created_at = NOW() + INTERVAL '1 minute' WHERE id = $1`, [later.id]);
    assert.equal((await app.inject({ method: "GET", url: "/admin/v2/exclusions", headers })).json().accounts_created_since, 1);

    const clearToken = (await preview(app, headers, first.phone_number, null, "CORRECTION")).json().confirmation_token;
    assert.equal((await applyToken(app, headers, clearToken)).statusCode, 200);
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification`)).rows[0].count, 0);
    const afterClear = (await app.inject({ method: "GET", url: "/admin/v2/exclusions", headers })).json();
    assert.ok(new Date(afterClear.exclusions_last_changed) >= new Date(afterSet.exclusions_last_changed));
    assert.equal(afterClear.accounts.excluded, 0);
    // A successful preview alone, a miss and a rejected apply do not move the time.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await preview(app, headers, first.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).statusCode, 200);
    await preview(app, headers, "+19990000000", "DEMO", "OPERATOR_DEMO_ACCOUNT");
    await applyToken(app, headers, "f".repeat(64));
    assert.equal((await app.inject({ method: "GET", url: "/admin/v2/exclusions", headers })).json().exclusions_last_changed, afterClear.exclusions_last_changed);
  } finally {
    await app.close();
  }
});

test("5b: the administrator-account reason is valid only with INTERNAL_TEST", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  try {
    assert.equal((await preview(app, headers, user.phone_number, "INTERNAL_TEST", "OPERATOR_ADMIN_ACCOUNT")).statusCode, 200);
    for (const target of ["DEMO", "EXTERNAL", null]) {
      assert.equal((await preview(app, headers, user.phone_number, target, "OPERATOR_ADMIN_ACCOUNT")).statusCode, 400, String(target));
    }
  } finally {
    await app.close();
  }
});

test("5c: the retired summary route answers 410 client_outdated", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  try {
    const response = await app.inject({ method: "GET", url: "/admin/classification/summary", headers });
    assert.equal(response.statusCode, 410);
    assert.deepEqual(response.json(), { error: "client_outdated", api_version: 2 });
  } finally {
    await app.close();
  }
});

test("6: all classification routes enforce unauthenticated, viewer, and owner access", async () => {
  const app = await buildApp();
  const viewer = await seedAdmin("viewer");
  const viewerSession = await createSession(viewer);
  const { headers: ownerHeaders } = await ownerAccess();
  const routes = [
    { method: "POST", url: "/admin/classification/preview", payload: {} },
    { method: "POST", url: "/admin/classification/apply", payload: {} },
    { method: "GET", url: "/admin/v2/exclusions" }
  ];
  try {
    for (const route of routes) {
      assert.equal((await app.inject(route)).statusCode, 401, `${route.url} unauthenticated`);
      assert.equal((await app.inject({ ...route, headers: authHeader(viewerSession) })).statusCode, 403, `${route.url} viewer`);
      assert.notEqual((await app.inject({ ...route, headers: ownerHeaders })).statusCode, 403, `${route.url} owner`);
    }
  } finally {
    await app.close();
  }
});

test("7: preview then apply sets a classification with one preview and one set audit", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser({ records: 2 });
  try {
    const previewResponse = await preview(app, headers, user.phone_number, "INTERNAL_TEST", "OPERATOR_TEST_ACCOUNT");
    assert.equal(previewResponse.statusCode, 200);
    assert.equal(previewResponse.json().account.confirmed_records, 2);
    const applied = await applyToken(app, headers, previewResponse.json().confirmation_token);
    assert.equal(applied.statusCode, 200);
    assert.deepEqual(applied.json(), { applied: true, previous_classification: null, classification: "INTERNAL_TEST" });
    assert.equal((await query(`SELECT classification FROM account_classification WHERE user_id = $1`, [user.id])).rows[0].classification, "INTERNAL_TEST");
    const audit = await query(`SELECT action, COUNT(*)::int AS count FROM admin_audit_log GROUP BY action ORDER BY action`);
    assert.deepEqual(audit.rows, [
      { action: "admin.classification.preview", count: 1 },
      { action: "admin.classification.set", count: 1 }
    ]);
  } finally {
    await app.close();
  }
});

test("8: preview alone creates no classification row", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  try {
    assert.equal((await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).statusCode, 200);
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification`)).rows[0].count, 0);
  } finally {
    await app.close();
  }
});

test("9: apply rejects a phone and classification instead of providing a single-step mutation", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/admin/classification/apply",
      headers,
      payload: { phone_number: user.phone_number, classification: "EXTERNAL", reason_code: "OWNER_CLASSIFIED_EXTERNAL" }
    });
    assert.equal(response.statusCode, 400);
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification`)).rows[0].count, 0);
  } finally {
    await app.close();
  }
});

test("10: a confirmation token can be used only once", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  try {
    const token = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    assert.equal((await applyToken(app, headers, token)).statusCode, 200);
    const second = await applyToken(app, headers, token);
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error, "confirmation_invalid");
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification`)).rows[0].count, 1);
  } finally {
    await app.close();
  }
});

test("11: an expired confirmation token is rejected without changing classification", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  try {
    const token = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    await query(`UPDATE admin_classification_confirmations SET expires_at = NOW() - INTERVAL '1 second'`);
    const response = await applyToken(app, headers, token);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "confirmation_invalid");
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification`)).rows[0].count, 0);
  } finally {
    await app.close();
  }
});

test("11a: database expiry is enforced when the application clock is ten minutes behind", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  const originalDateNow = Date.now;
  try {
    const token = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    await query(`UPDATE admin_classification_confirmations SET expires_at = clock_timestamp() - INTERVAL '1 second'`);
    Date.now = () => originalDateNow() - 10 * 60_000;
    const response = await applyToken(app, headers, token);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "confirmation_invalid");
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification`)).rows[0].count, 0);
  } finally {
    Date.now = originalDateNow;
    await app.close();
  }
});

test("11b: database-valid confirmation is accepted when the application clock is ten minutes ahead", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  const originalDateNow = Date.now;
  try {
    const token = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    Date.now = () => originalDateNow() + 10 * 60_000;
    const response = await applyToken(app, headers, token);
    assert.equal(response.statusCode, 200);
    assert.equal((await query(`SELECT classification FROM account_classification WHERE user_id = $1`, [user.id])).rows[0].classification, "DEMO");
  } finally {
    Date.now = originalDateNow;
    await app.close();
  }
});

test("11c: confirmation expiring while apply waits on the account lock is rejected", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  const token = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await query(
    `UPDATE admin_classification_confirmations SET expires_at = clock_timestamp() + INTERVAL '1 second' WHERE token_hash = $1`,
    [hash]
  );
  const holder = await getPool().connect();
  let holderFinished = false;
  let applyPromise;
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [user.id]);
    applyPromise = applyToken(app, headers, token);
    await assertPromisesPending([applyPromise]);
    await waitForDatabaseCondition(
      `SELECT clock_timestamp() > expires_at AS ready FROM admin_classification_confirmations WHERE token_hash = $1`,
      [hash]
    );
    await holder.query("COMMIT");
    holderFinished = true;
    const response = await applyPromise;
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "confirmation_invalid");
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification WHERE user_id = $1`, [user.id])).rows[0].count, 0);
    assert.equal((await query(
      `SELECT COUNT(*)::int AS count FROM admin_audit_log WHERE subject_id = $1 AND action IN ('admin.classification.set', 'admin.classification.clear')`,
      [user.id]
    )).rows[0].count, 0);
  } finally {
    if (!holderFinished) await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    if (applyPromise) await Promise.allSettled([applyPromise]);
    await app.close();
  }
});

test("11d: two tokens blocked on the same account produce one winner and one stale rejection", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  const firstToken = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
  const secondToken = (await preview(app, headers, user.phone_number, "EXTERNAL", "OWNER_CLASSIFIED_EXTERNAL")).json().confirmation_token;
  const holder = await getPool().connect();
  let holderFinished = false;
  let applies = [];
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [user.id]);
    applies = [applyToken(app, headers, firstToken), applyToken(app, headers, secondToken)];
    await assertPromisesPending(applies);
    await holder.query("COMMIT");
    holderFinished = true;
    const responses = await Promise.all(applies);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    const rejected = responses.find((response) => response.statusCode === 409);
    const winnerIndex = responses.findIndex((response) => response.statusCode === 200);
    assert.equal(rejected.json().error, "state_changed");
    assert.equal(
      (await query(`SELECT classification FROM account_classification WHERE user_id = $1`, [user.id])).rows[0].classification,
      ["DEMO", "EXTERNAL"][winnerIndex]
    );
    const audit = await query(
      `SELECT action, COUNT(*)::int AS count FROM admin_audit_log WHERE subject_id = $1 AND action IN ('admin.classification.set', 'admin.classification.apply_rejected') GROUP BY action ORDER BY action`,
      [user.id]
    );
    assert.deepEqual(audit.rows, [
      { action: "admin.classification.apply_rejected", count: 1 },
      { action: "admin.classification.set", count: 1 }
    ]);
    assert.equal((await query(
      `SELECT COUNT(*)::int AS count FROM admin_classification_confirmations WHERE user_id = $1 AND used_at IS NOT NULL`,
      [user.id]
    )).rows[0].count, 2);
  } finally {
    if (!holderFinished) await holder.query("ROLLBACK").catch(() => {});
    holder.release();
    if (applies.length) await Promise.allSettled(applies);
    await app.close();
  }
});

test("11e: twenty concurrent two-token races each produce exactly one winner", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  try {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const user = await seedUser();
      const remoteAddress = `198.51.100.${iteration + 1}`;
      const firstToken = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT", remoteAddress)).json().confirmation_token;
      const secondToken = (await preview(app, headers, user.phone_number, "EXTERNAL", "OWNER_CLASSIFIED_EXTERNAL", remoteAddress)).json().confirmation_token;
      const responses = await Promise.all([
        applyToken(app, headers, firstToken),
        applyToken(app, headers, secondToken)
      ]);
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409], `iteration ${iteration}`);
      assert.equal(responses.find((response) => response.statusCode === 409).json().error, "state_changed");
      const winnerIndex = responses.findIndex((response) => response.statusCode === 200);
      assert.equal(
        (await query(`SELECT classification FROM account_classification WHERE user_id = $1`, [user.id])).rows[0].classification,
        ["DEMO", "EXTERNAL"][winnerIndex]
      );
      assert.equal((await query(
        `SELECT COUNT(*)::int AS count FROM admin_classification_confirmations WHERE user_id = $1 AND used_at IS NOT NULL`,
        [user.id]
      )).rows[0].count, 2);
    }
  } finally {
    await app.close();
  }
});

test("11f: applying the same token concurrently succeeds exactly once", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  try {
    const token = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    const responses = await Promise.all([applyToken(app, headers, token), applyToken(app, headers, token)]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    assert.equal(responses.find((response) => response.statusCode === 409).json().error, "confirmation_invalid");
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification WHERE user_id = $1`, [user.id])).rows[0].count, 1);
  } finally {
    await app.close();
  }
});

test("11g: apply rejects a confirmation whose account was deleted after preview", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  try {
    const token = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    await query(`DELETE FROM users WHERE id = $1`, [user.id]);
    const response = await applyToken(app, headers, token);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "confirmation_invalid");
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification WHERE user_id = $1`, [user.id])).rows[0].count, 0);
  } finally {
    await app.close();
  }
});

test("12: a confirmation token belongs only to the owner who previewed it", async () => {
  const app = await buildApp();
  const first = await ownerAccess();
  const second = await ownerAccess();
  const user = await seedUser();
  try {
    const token = (await preview(app, first.headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    const response = await applyToken(app, second.headers, token);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "confirmation_invalid");
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification`)).rows[0].count, 0);
  } finally {
    await app.close();
  }
});

test("13: apply rejects and consumes a preview when current classification changed", async () => {
  const app = await buildApp();
  const { owner, headers } = await ownerAccess();
  const user = await seedUser();
  try {
    const token = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    await classify(user.id, owner.id, "EXTERNAL", "OWNER_CLASSIFIED_EXTERNAL");
    const response = await applyToken(app, headers, token);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error, "state_changed");
    assert.equal((await query(`SELECT classification FROM account_classification WHERE user_id = $1`, [user.id])).rows[0].classification, "EXTERNAL");
    assert.ok((await query(`SELECT used_at FROM admin_classification_confirmations`)).rows[0].used_at);
  } finally {
    await app.close();
  }
});

test("14: CORRECTION reclassifies an account and reports its previous value", async () => {
  const app = await buildApp();
  const { owner, headers } = await ownerAccess();
  const user = await seedUser();
  await classify(user.id, owner.id, "DEMO", "OPERATOR_DEMO_ACCOUNT");
  try {
    const token = (await preview(app, headers, user.phone_number, "EXTERNAL", "CORRECTION")).json().confirmation_token;
    const response = await applyToken(app, headers, token);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { applied: true, previous_classification: "DEMO", classification: "EXTERNAL" });
  } finally {
    await app.close();
  }
});

test("15: CORRECTION can clear a classification back to unclassified", async () => {
  const app = await buildApp();
  const { owner, headers } = await ownerAccess();
  const user = await seedUser();
  await classify(user.id, owner.id, "DEMO", "OPERATOR_DEMO_ACCOUNT");
  try {
    const token = (await preview(app, headers, user.phone_number, null, "CORRECTION")).json().confirmation_token;
    const response = await applyToken(app, headers, token);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { applied: true, previous_classification: "DEMO", classification: null });
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification`)).rows[0].count, 0);
  } finally {
    await app.close();
  }
});

test("16: invalid preview inputs return 400 before lookup or audit", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const cases = [
    { phone_number: "+15550000001", classification: "UNKNOWN", reason_code: "CORRECTION" },
    { phone_number: "+15550000001", classification: "DEMO", reason_code: "UNKNOWN" },
    { phone_number: "+15550000001", classification: "DEMO", reason_code: "OPERATOR_TEST_ACCOUNT" },
    { phone_number: "+15550000001", classification: null, reason_code: "OWNER_CLASSIFIED_EXTERNAL" },
    { classification: "DEMO", reason_code: "OPERATOR_DEMO_ACCOUNT" }
  ];
  try {
    for (const payload of cases) {
      const response = await app.inject({ method: "POST", url: "/admin/classification/preview", headers, payload });
      assert.equal(response.statusCode, 400);
    }
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM admin_audit_log`)).rows[0].count, 0);
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM admin_classification_confirmations`)).rows[0].count, 0);
  } finally {
    await app.close();
  }
});

test("17: an unknown phone returns 404 with one identifier-free miss audit", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  try {
    const response = await preview(app, headers, "+15550000001", "DEMO", "OPERATOR_DEMO_ACCOUNT");
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: "No matching account." });
    const audit = (await query(`SELECT action, subject_type, subject_id, reason FROM admin_audit_log`)).rows;
    assert.deepEqual(audit, [{ action: "admin.classification.miss", subject_type: null, subject_id: null, reason: null }]);
  } finally {
    await app.close();
  }
});

test("18: prefix, missing-leading-plus, and trailing-digit near misses do not match", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  await seedUser({ phone: "+15551234567" });
  try {
    for (const phone of ["+1555123456", "15551234567", "+155512345670"]) {
      assert.equal((await preview(app, headers, phone, "DEMO", "OPERATOR_DEMO_ACCOUNT")).statusCode, 404);
    }
  } finally {
    await app.close();
  }
});

test("19: email and identifier fields are never treated as lookup keys", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  try {
    for (const payload of [
      { email: "person@example.test", classification: "DEMO", reason_code: "OPERATOR_DEMO_ACCOUNT" },
      { identifier: "+15551234567", classification: "DEMO", reason_code: "OPERATOR_DEMO_ACCOUNT" }
    ]) {
      assert.equal((await app.inject({ method: "POST", url: "/admin/classification/preview", headers, payload })).statusCode, 400);
    }
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM admin_audit_log`)).rows[0].count, 0);
  } finally {
    await app.close();
  }
});

test("20: a formatted phone is retained in none of the classification or audit columns", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser({ phone: FORMATTED_PHONE });
  try {
    const token = (await preview(app, headers, user.phone_number, "INTERNAL_TEST", "OPERATOR_TEST_ACCOUNT")).json().confirmation_token;
    assert.equal((await applyToken(app, headers, token)).statusCode, 200);
    const stored = await query(`
      SELECT row_to_json(row_value)::text AS value FROM account_classification row_value
      UNION ALL
      SELECT row_to_json(row_value)::text AS value FROM admin_classification_confirmations row_value
      UNION ALL
      SELECT row_to_json(row_value)::text AS value FROM admin_audit_log row_value
    `);
    const combined = stored.rows.map((row) => row.value).join("\n");
    for (const forbidden of [FORMATTED_PHONE, "12025550143", "5550143"]) {
      assert.equal(combined.includes(forbidden), false, forbidden);
    }
  } finally {
    await app.close();
  }
});

test("21: slice audit reasons are null or assembled only from enumerated values", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  try {
    const token = (await preview(app, headers, user.phone_number, "EXTERNAL", "OWNER_CLASSIFIED_EXTERNAL")).json().confirmation_token;
    await applyToken(app, headers, token);
    await preview(app, headers, "+15550000009", "DEMO", "OPERATOR_DEMO_ACCOUNT");
    const reasons = (await query(`SELECT reason FROM admin_audit_log WHERE action LIKE 'admin.classification.%'`)).rows;
    const pattern = /^(UNCLASSIFIED|EXTERNAL|INTERNAL_TEST|DEMO) -> (UNCLASSIFIED|EXTERNAL|INTERNAL_TEST|DEMO); [A-Z_]+$/;
    for (const { reason } of reasons) assert.ok(reason === null || pattern.test(reason), String(reason));
  } finally {
    await app.close();
  }
});

test("22: responses do not echo the phone and only the token hash is stored", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser({ phone: FORMATTED_PHONE });
  try {
    const previewResponse = await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT");
    const token = previewResponse.json().confirmation_token;
    const applyResponse = await applyToken(app, headers, token);
    const summaryResponse = await app.inject({ method: "GET", url: "/admin/v2/exclusions", headers });
    const combined = [previewResponse.body, applyResponse.body, summaryResponse.body].join("\n");
    for (const forbidden of [FORMATTED_PHONE, "12025550143", "5550143"]) {
      assert.equal(combined.includes(forbidden), false, forbidden);
    }
    const stored = (await query(`SELECT token_hash FROM admin_classification_confirmations`)).rows[0].token_hash;
    assert.match(stored, /^[0-9a-f]{64}$/);
    assert.notEqual(stored, token);
    assert.equal(stored, crypto.createHash("sha256").update(token).digest("hex"));
  } finally {
    await app.close();
  }
});

test("23: a capturing logger receives no phone number", async () => {
  const lines = [];
  const app = await buildApp({ logger: { level: "info", stream: { write: (line) => lines.push(String(line)) } } });
  const { headers } = await ownerAccess();
  const user = await seedUser({ phone: FORMATTED_PHONE });
  try {
    const token = (await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    await applyToken(app, headers, token);
    const logs = lines.join("\n");
    assert.equal(logs.includes(FORMATTED_PHONE), false);
    assert.equal(logs.includes("12025550143"), false);
    assert.equal(logs.includes("5550143"), false);
  } finally {
    await app.close();
  }
});

test("24: audit failures roll back preview and apply state atomically", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const first = await seedUser();
  const second = await seedUser();
  try {
    await rejectAuditInserts(async () => {
      assert.equal((await preview(app, headers, first.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).statusCode, 500);
    });
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM admin_classification_confirmations`)).rows[0].count, 0);

    const token = (await preview(app, headers, second.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT")).json().confirmation_token;
    await rejectAuditInserts(async () => {
      assert.equal((await applyToken(app, headers, token)).statusCode, 500);
    });
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM account_classification WHERE user_id = $1`, [second.id])).rows[0].count, 0);
    assert.equal((await query(`SELECT used_at FROM admin_classification_confirmations WHERE user_id = $1`, [second.id])).rows[0].used_at, null);
  } finally {
    await app.close();
  }
});

test("25: the exclusions summary labels its unsuppressed operator-only exception", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  try {
    const body = (await app.inject({ method: "GET", url: "/admin/v2/exclusions", headers })).json();
    assert.equal(body.audience, "operator_only");
    assert.equal(body.suppression, "none");
  } finally {
    await app.close();
  }
});

test("26: every classification response is no-store and exposes no forbidden record fields", async () => {
  const app = await buildApp();
  const { headers } = await ownerAccess();
  const user = await seedUser();
  try {
    const previewResponse = await preview(app, headers, user.phone_number, "DEMO", "OPERATOR_DEMO_ACCOUNT");
    const responses = [
      previewResponse,
      await applyToken(app, headers, previewResponse.json().confirmation_token),
      await app.inject({ method: "GET", url: "/admin/v2/exclusions", headers })
    ];
    for (const response of responses) {
      assert.equal(response.headers["cache-control"], "no-store");
      const body = response.body.toLowerCase();
      for (const forbidden of ["payload", "otp_hash", "signature", "public_key"]) {
        assert.equal(body.includes(forbidden), false, forbidden);
      }
    }
  } finally {
    await app.close();
  }
});

test("27: the disposable database guard rejects remote and non-test URLs without disclosure", () => {
  const urls = [
    "postgresql://user:secret@db.example.test/production_test",
    "postgresql://user:secret@localhost/production"
  ];
  for (const url of urls) {
    assert.throws(() => assertDisposableTestDatabase(url), (error) => {
      assert.equal(error.message.includes(url), false);
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
  }
});

test("28: prepare rejects a non-disposable URL before executing any statement", async () => {
  const statements = [];
  await assert.rejects(prepareAdminTestDatabase({
    migrations: [new URL("../migrations/009_admin_backend.sql", import.meta.url)],
    databaseUrl: "postgresql://user:secret@db.example.test/production",
    executor: async (statement) => statements.push(statement)
  }));
  assert.deepEqual(statements, []);
});

test("29: the auth suite prepares its guarded database before direct setup SQL", async () => {
  const source = await readFile(new URL("./admin-auth.test.js", import.meta.url), "utf8");
  const beforeBody = source.match(/before\(async \(\) => \{([\s\S]*?)\n\}\);/)?.[1] || "";
  assert.match(beforeBody, /^\s*await prepareAdminTestDatabase\(/);
  const preparedAt = beforeBody.indexOf("prepareAdminTestDatabase");
  const directQueryAt = beforeBody.indexOf("query(");
  const migrationReadAt = beforeBody.indexOf("readFile(");
  assert.ok(directQueryAt === -1 || directQueryAt > preparedAt);
  assert.ok(migrationReadAt === -1 || migrationReadAt > preparedAt);
});
