import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { closeAdminPools, getAdminReadPool } from "../src/admin-db.js";
import { METRIC_DEFINITIONS, rebuildRollups } from "../src/admin-metrics.js";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import {
  ADMIN_ORIGIN,
  buildApp,
  createSession,
  prepareAdminTestDatabase,
  seedAdmin
} from "./helpers/admin.js";

let classifierId;

function auth(session) {
  return { authorization: `Bearer ${session.token}` };
}

async function resetState() {
  await query(`
    TRUNCATE
      admin_audit_log,
      admin_classification_confirmations,
      account_classification,
      admin_sessions,
      admin_users,
      metrics_dimension_snapshot,
      metrics_daily_rollup,
      metrics_snapshot,
      attestations,
      ledger_entries,
      device_identities,
      users
    RESTART IDENTITY CASCADE
  `);
  await query(`
    UPDATE metrics_rollup_state
    SET built_at = NULL, stale = TRUE, build_ms = NULL, out_of_range = 0,
        invalidations = 0, last_attempt_at = NULL, last_failure_at = NULL
    WHERE id = TRUE
  `);
  classifierId = (await seedAdmin("owner")).id;
}

async function seedAccount({
  classification = "EXTERNAL",
  country = "US",
  sector = "trade_retail",
  phoneVerified = false,
  emailVerified = false,
  records = [],
  attestations = [],
  active = true,
  createdAt = new Date(),
  phone,
  email,
  name = null,
  businessName = null
} = {}) {
  const accountPhone = phone || `+1555${crypto.randomInt(1_000_000, 9_999_999)}`;
  const userResult = await query(`
    INSERT INTO users (phone_number, email, phone_verified, email_verified, created_at)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [accountPhone, email || `${crypto.randomUUID()}@example.test`, phoneVerified, emailVerified, createdAt]);
  const userId = userResult.rows[0].id;
  await query(`
    INSERT INTO profiles (user_id, operating_region, sector_id, name, business_name)
    VALUES ($1, $2, $3, $4, $5)
  `, [userId, country, sector, name, businessName]);
  const deviceIdentity = `device-${crypto.randomUUID()}`;
  await query(`
    INSERT INTO device_identities (device_identity, public_key, phone_number, status)
    VALUES ($1, 'test-key', $2, $3)
  `, [deviceIdentity, accountPhone, active ? "ACTIVE" : "REVOKED"]);
  for (let index = 0; index < records.length; index += 1) {
    await query(`
      INSERT INTO ledger_entries (
        device_identity, entry_id, entry_hash, prev_entry_hash,
        signature, confirmed_at, synced_at, payload
      ) VALUES ($1, $2, $3, $4, 'test', $5, $5, '{}'::jsonb)
    `, [
      deviceIdentity,
      index + 1,
      crypto.randomBytes(32).toString("hex"),
      index ? crypto.randomBytes(32).toString("hex") : "0".repeat(64),
      records[index]
    ]);
  }
  for (const issuedAt of attestations) {
    await query(`
      INSERT INTO attestations (
        vt_id, device_identity, phone_number, ledger_root_hash,
        window_start, window_end, entry_count, server_signature, status, issued_at
      ) VALUES ($1, $2, $3, $4, $5, $5, 1, 'test-signature', 'VALID', $5)
    `, [
      `vt-${crypto.randomUUID()}`,
      deviceIdentity,
      accountPhone,
      crypto.randomBytes(32).toString("hex"),
      issuedAt
    ]);
  }
  if (classification) {
    await query(`
      INSERT INTO account_classification (user_id, classification, reason_code, classified_by)
      VALUES ($1, $2, 'CORRECTION', $3)
    `, [userId, classification, classifierId]);
  }
  return userId;
}

function metric(body, key) {
  return body.metrics.find((item) => item.key === key).disclosure;
}

async function ownerRequest(app, url) {
  const owner = await seedAdmin("owner");
  const session = await createSession(owner);
  return app.inject({ method: "GET", url, headers: auth(session) });
}

async function suppressedResponses(app) {
  return Promise.all([
    ownerRequest(app, "/admin/suppressed/overview"),
    ownerRequest(app, "/admin/suppressed/breakdown?dimension=country"),
    ownerRequest(app, "/admin/suppressed/breakdown?dimension=sector")
  ]);
}

function withoutContext(body) {
  const copy = structuredClone(body);
  delete copy.as_of;
  delete copy.provisional;
  copy.statements = copy.statements.filter((statement) => !statement.startsWith("Provisional:"));
  return copy;
}

function allKeys(value, output = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, output);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    output.add(key);
    allKeys(child, output);
  }
  return output;
}

function recordPoolStatements(pool) {
  const statements = [];
  const originalQuery = pool.query;
  pool.query = async function recordedQuery(text, ...args) {
    const result = await originalQuery.call(this, text, ...args);
    statements.push({
      text: typeof text === "string" ? text : text?.text || "",
      fields: (result?.fields || []).map(({ name: field }) => field)
    });
    return result;
  };
  return {
    statements,
    restore() { pool.query = originalQuery; }
  };
}

before(async () => {
  await prepareAdminTestDatabase({
    migrations: [
      new URL("../migrations/009_admin_backend.sql", import.meta.url),
      new URL("../migrations/010_account_classification.sql", import.meta.url),
      new URL("../migrations/011_admin_metrics_rollup.sql", import.meta.url),
      new URL("../migrations/012_admin_dimension_snapshot.sql", import.meta.url)
    ]
  });
  config.adminJwtSecret = crypto.randomBytes(32).toString("hex");
  config.adminTotpEncKey = crypto.randomBytes(32).toString("hex");
  config.adminTotpEncKeyBytes = null;
  config.adminJwtExpiry = "1h";
  config.adminKAnonThreshold = 5;
});

beforeEach(async () => {
  config.adminCorsOrigins = ADMIN_ORIGIN;
  config.adminIpAllowlist = "";
  config.adminKAnonThreshold = 5;
  await resetState();
});

after(async () => {
  await closeAdminPools();
  await getPool().end();
});

test("suppressed routes admit only owners and reject unsupported queries", async () => {
  await rebuildRollups();
  const app = await buildApp();
  const viewer = await seedAdmin("viewer");
  const owner = await seedAdmin("owner");
  const viewerSession = await createSession(viewer);
  const ownerSession = await createSession(owner);
  try {
    for (const url of [
      "/admin/suppressed/overview",
      "/admin/suppressed/breakdown?dimension=country"
    ]) {
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
      assert.equal((await app.inject({ method: "GET", url, headers: auth(viewerSession) })).statusCode, 403);
      const response = await app.inject({ method: "GET", url, headers: auth(ownerSession) });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().audience, "owner_only");
      assert.equal(response.json().release_status, "single_reading");
      assert.match(response.body, /Not cleared for repeated release/);
    }
    for (const url of [
      "/admin/suppressed/overview?range=all",
      "/admin/suppressed/breakdown",
      "/admin/suppressed/breakdown?dimension=country&dimension=sector",
      "/admin/suppressed/breakdown?dimension=country&range=all"
    ]) {
      assert.equal((await app.inject({ method: "GET", url, headers: auth(ownerSession) })).statusCode, 400);
    }
  } finally {
    await app.close();
  }
});

test("overview applies subset and eligible-event contributor rules", async () => {
  const now = new Date();
  for (let index = 0; index < 10; index += 1) {
    await seedAccount({
      phoneVerified: index < 8,
      records: index < 2 ? Array.from({ length: 250 }, () => now) : []
    });
  }
  await rebuildRollups();
  const app = await buildApp();
  const owner = await seedAdmin("owner");
  const session = await createSession(owner);
  try {
    const response = await app.inject({ method: "GET", url: "/admin/suppressed/overview", headers: auth(session) });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(metric(response.json(), "accounts_registered"), { status: "published", value: 10 });
    assert.deepEqual(metric(response.json(), "accounts_phone_verified"), { status: "withheld" });
    assert.deepEqual(metric(response.json(), "records_received"), { status: "fewer_than_k" });
    assert.equal(response.body.includes("contributors_records_received"), false);
  } finally {
    await app.close();
  }
});

test("out-of-range events do not qualify as contributors", async () => {
  const old = new Date("1999-12-31T00:00:00Z");
  const now = new Date();
  for (let index = 0; index < 6; index += 1) {
    await seedAccount({ records: [index < 4 ? old : now] });
  }
  await rebuildRollups();
  const contributor = await query(`
    SELECT count FROM metrics_snapshot
    WHERE metric_key = 'contributors_records_received' AND bucket = 'external'
  `);
  assert.equal(contributor.rows[0].count, 2);
  const daily = await query(`
    SELECT COALESCE(SUM(count), 0)::int AS count FROM metrics_daily_rollup
    WHERE metric_key = 'records_received' AND bucket = 'external'
  `);
  assert.equal(daily.rows[0].count, 2);
});

test("dimension rebuild normalizes unknown values and country coverage is a gate", async () => {
  for (let index = 0; index < 10; index += 1) {
    await seedAccount({
      country: index < 4 ? "US" : "ZZ",
      sector: index === 0 ? "<script>secret-marker" : "trade_retail"
    });
  }
  await rebuildRollups();
  const rows = await query(`SELECT dimension, category, count FROM metrics_dimension_snapshot ORDER BY 1, 2`);
  const serializedRows = JSON.stringify(rows.rows);
  assert.equal(serializedRows.includes("ZZ"), false);
  assert.equal(serializedRows.includes("secret-marker"), false);
  assert.ok(rows.rows.some(({ category }) => category === "no_valid_code"));

  const app = await buildApp();
  const owner = await seedAdmin("owner");
  const session = await createSession(owner);
  try {
    const response = await app.inject({ method: "GET", url: "/admin/suppressed/breakdown?dimension=country", headers: auth(session) });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().result, {
      status: "withheld",
      reason: "valid_codes_below_half",
      total: { status: "published", value: 10 }
    });
    assert.equal(response.body.includes("ZZ"), false);
  } finally {
    await app.close();
  }
});

test("country breakdown combines small cells without naming them", async () => {
  for (const [country, count] of [["US", 12], ["GB", 7], ["NG", 3], ["GH", 2]]) {
    for (let index = 0; index < count; index += 1) await seedAccount({ country });
  }
  await rebuildRollups();
  const app = await buildApp();
  const owner = await seedAdmin("owner");
  const session = await createSession(owner);
  try {
    const response = await app.inject({ method: "GET", url: "/admin/suppressed/breakdown?dimension=country", headers: auth(session) });
    assert.deepEqual(response.json().result, {
      status: "published",
      cells: [
        { category: "US", count: 12 },
        { category: "GB", count: 7 },
        { category: "other", count: 5 }
      ],
      total: 24
    });
    assert.equal(response.body.includes('"NG"'), false);
    assert.equal(response.body.includes('"GH"'), false);
  } finally {
    await app.close();
  }
});

test("2: suppressed responses carry owner-only single-reading labels and no shareable claim", async () => {
  await seedAccount();
  await rebuildRollups();
  const app = await buildApp();
  try {
    for (const response of await suppressedResponses(app)) {
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().audience, "owner_only");
      assert.equal(response.json().release_status, "single_reading");
      assert.match(response.body, /Single reading\. Not cleared for repeated release/);
      assert.equal(response.body.toLowerCase().includes("shareable"), false);
      assert.equal(response.headers["cache-control"], "no-store");
    }
    for (const path of [
      "/admin/suppressed/overview",
      "/admin/suppressed/breakdown?dimension=country",
      "/admin/suppressed/breakdown?dimension=sector"
    ]) assert.equal(path.includes("shareable"), false);
    const sources = await Promise.all([
      "../src/admin-disclosure.js",
      "../src/admin-dimensions.js",
      "../src/admin-metrics.js",
      "../src/routes/admin/suppressed.js"
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
    assert.equal(sources.join("\n").toLowerCase().includes("shareable"), false);
  } finally { await app.close(); }
});

test("3: suppressed routes refuse an address outside the admin allow-list", async () => {
  await rebuildRollups();
  const app = await buildApp();
  const owner = await seedAdmin("owner");
  const session = await createSession(owner);
  config.adminIpAllowlist = "203.0.113.10";
  try {
    for (const url of [
      "/admin/suppressed/overview",
      "/admin/suppressed/breakdown?dimension=country"
    ]) {
      const response = await app.inject({
        method: "GET", url, headers: auth(session), remoteAddress: "198.51.100.20"
      });
      assert.equal(response.statusCode, 403);
    }
  } finally { await app.close(); }
});

test("4: overview rejects every query parameter and breakdown rejects every non-dimension parameter", async () => {
  await rebuildRollups();
  const app = await buildApp();
  const owner = await seedAdmin("owner");
  const session = await createSession(owner);
  try {
    for (const queryString of ["dimension=country", "range=all", "unknown=value"]) {
      assert.equal((await app.inject({ method: "GET", url: `/admin/suppressed/overview?${queryString}`, headers: auth(session) })).statusCode, 400);
    }
    for (const extra of ["range=all", "metric=accounts_registered", "unknown=value"]) {
      assert.equal((await app.inject({ method: "GET", url: `/admin/suppressed/breakdown?dimension=country&${extra}`, headers: auth(session) })).statusCode, 400);
    }
  } finally { await app.close(); }
});

test("5: breakdown rejects a missing, repeated, or unsupported dimension", async () => {
  await rebuildRollups();
  const app = await buildApp();
  const owner = await seedAdmin("owner");
  const session = await createSession(owner);
  try {
    for (const url of [
      "/admin/suppressed/breakdown",
      "/admin/suppressed/breakdown?dimension=country&dimension=sector",
      "/admin/suppressed/breakdown?dimension=location",
      "/admin/suppressed/breakdown?dimension="
    ]) assert.equal((await app.inject({ method: "GET", url, headers: auth(session) })).statusCode, 400);
  } finally { await app.close(); }
});

test("6: four External accounts suppress registration and every other overview metric", async () => {
  for (let index = 0; index < 4; index += 1) await seedAccount({ phoneVerified: true, records: [new Date()] });
  await rebuildRollups();
  const app = await buildApp();
  try {
    const body = (await ownerRequest(app, "/admin/suppressed/overview")).json();
    assert.deepEqual(metric(body, "accounts_registered"), { status: "fewer_than_k" });
    for (const item of body.metrics.filter(({ key }) => key !== "accounts_registered")) {
      assert.ok(["withheld", "fewer_than_k"].includes(item.disclosure.status));
      assert.equal(Object.hasOwn(item.disclosure, "value"), false);
    }
  } finally { await app.close(); }
});

test("7: phone subset withholds 18 of 20 and publishes 20 of 20 and 12 of 20", async () => {
  const readCase = async (verified) => {
    await resetState();
    for (let index = 0; index < 20; index += 1) await seedAccount({ phoneVerified: index < verified });
    await rebuildRollups();
    const app = await buildApp();
    try { return metric((await ownerRequest(app, "/admin/suppressed/overview")).json(), "accounts_phone_verified"); }
    finally { await app.close(); }
  };
  assert.deepEqual(await readCase(18), { status: "withheld" });
  assert.deepEqual(await readCase(20), { status: "published", value: 20 });
  assert.deepEqual(await readCase(12), { status: "published", value: 12 });
});

test("8: identical record volume is suppressed for two contributors and published for six", async () => {
  const now = new Date();
  const readCase = async (contributors) => {
    await resetState();
    for (let index = 0; index < 10; index += 1) {
      const recordCount = index < contributors
        ? Math.floor(500 / contributors) + (index < 500 % contributors ? 1 : 0)
        : 0;
      await seedAccount({ records: Array.from({ length: recordCount }, () => now) });
    }
    await rebuildRollups();
    const app = await buildApp();
    try { return metric((await ownerRequest(app, "/admin/suppressed/overview")).json(), "records_received"); }
    finally { await app.close(); }
  };
  assert.deepEqual(await readCase(2), { status: "fewer_than_k" });
  assert.deepEqual(await readCase(6), { status: "published", value: 500 });
});

test("8a: overview event disclosure uses eligible contributors and eligible event totals", async () => {
  const old = new Date("1999-06-01T00:00:00Z");
  const now = new Date();
  const future = new Date();
  future.setUTCFullYear(future.getUTCFullYear() + 10);
  const ids = [];
  for (let index = 0; index < 6; index += 1) {
    ids.push(await seedAccount({
      records: [index < 4 ? old : now],
      attestations: [index < 3 ? old : (index === 3 ? future : now)]
    }));
  }
  await rebuildRollups();
  let app = await buildApp();
  try {
    const body = (await ownerRequest(app, "/admin/suppressed/overview")).json();
    assert.deepEqual(metric(body, "records_received"), { status: "fewer_than_k" });
    assert.deepEqual(metric(body, "attestations_issued"), { status: "fewer_than_k" });
  } finally { await app.close(); }

  for (let index = 0; index < 3; index += 1) {
    const device = await query(`SELECT device_identity FROM device_identities WHERE phone_number = (SELECT phone_number FROM users WHERE id = $1)`, [ids[index]]);
    await query(`
      INSERT INTO ledger_entries (device_identity, entry_id, entry_hash, prev_entry_hash, signature, confirmed_at, synced_at, payload)
      VALUES ($1, 2, $2, $3, 'test', $4, $4, '{}'::jsonb)
    `, [device.rows[0].device_identity, crypto.randomBytes(32).toString("hex"), "0".repeat(64), now]);
    const phone = await query(`SELECT phone_number FROM users WHERE id = $1`, [ids[index]]);
    await query(`
      INSERT INTO attestations (vt_id, device_identity, phone_number, ledger_root_hash, window_start, window_end, entry_count, server_signature, status, issued_at)
      VALUES ($1, $2, $3, $4, $5, $5, 1, 'test', 'VALID', $5)
    `, [`vt-${crypto.randomUUID()}`, device.rows[0].device_identity, phone.rows[0].phone_number, crypto.randomBytes(32).toString("hex"), now]);
  }
  await rebuildRollups();
  app = await buildApp();
  try {
    const body = (await ownerRequest(app, "/admin/suppressed/overview")).json();
    assert.deepEqual(metric(body, "records_received"), { status: "published", value: 5 });
    assert.deepEqual(metric(body, "attestations_issued"), { status: "published", value: 5 });
  } finally { await app.close(); }
});

test("8b: every seeded rebuild keeps event totals zero with zero contributors and contributors at most totals", async () => {
  const cases = [
    [],
    [{ records: [new Date()] }],
    [{ attestations: [new Date()] }, { records: [new Date(), new Date()] }]
  ];
  for (const accounts of cases) {
    await resetState();
    for (const account of accounts) await seedAccount(account);
    await rebuildRollups();
    for (const [eventKey, contributorKey] of [
      ["records_received", "contributors_records_received"],
      ["attestations_issued", "contributors_attestations_issued"]
    ]) {
      const values = await query(`
        SELECT
          COALESCE((SELECT count FROM metrics_snapshot WHERE metric_key = $1 AND bucket = 'external'), 0)::int AS contributors,
          COALESCE((SELECT SUM(count) FROM metrics_daily_rollup WHERE metric_key = $2 AND bucket = 'external'), 0)::int AS events
      `, [contributorKey, eventKey]);
      const { contributors, events } = values.rows[0];
      if (contributors === 0) assert.equal(events, 0);
      assert.ok(contributors <= events);
    }
  }
});

test("9: excluded account groups do not change External overview metrics or breakdown results", async () => {
  const now = new Date();
  for (let index = 0; index < 12; index += 1) {
    await seedAccount({
      country: index < 7 ? "US" : "GB",
      sector: index < 7 ? "trade_retail" : "food_hospitality",
      phoneVerified: index < 6,
      emailVerified: index >= 6,
      records: [now, now, now],
      attestations: [now]
    });
  }
  await rebuildRollups();
  const app = await buildApp();
  try {
    const base = (await suppressedResponses(app)).map((response) => withoutContext(response.json()));
    for (const [classification, amount] of [["INTERNAL_TEST", 7], ["DEMO", 4], [null, 3]]) {
      for (let index = 0; index < amount; index += 1) {
        await seedAccount({ classification, country: "NG", sector: "services", records: [now], attestations: [now] });
      }
      await rebuildRollups();
      const current = (await suppressedResponses(app)).map((response) => withoutContext(response.json()));
      assert.deepEqual(current[0].metrics, base[0].metrics);
      assert.deepEqual(current[1].result, base[1].result);
      assert.deepEqual(current[2].result, base[2].result);
    }
  } finally { await app.close(); }
});

test("9a: response keys explicitly exclude internal, demo, unclassified, and total account fields", async () => {
  for (let index = 0; index < 6; index += 1) await seedAccount();
  await rebuildRollups();
  const app = await buildApp();
  const allowed = new Set([
    "audience", "release_status", "suppression", "minimum_cell_size", "scope", "range",
    "provisional", "as_of", "stale", "statements", "metrics", "key", "definition",
    "disclosure", "status", "value", "dimension", "dimension_label", "result", "reason",
    "total", "cells", "category", "count"
  ]);
  try {
    for (const response of await suppressedResponses(app)) {
      for (const key of allKeys(response.json())) assert.equal(allowed.has(key), true, `unexpected response key ${key}`);
      for (const forbidden of ["internal", "internal_demo", "demo", "unclassified", "accounts_total"]) {
        assert.equal(allKeys(response.json()).has(forbidden), false);
      }
    }
  } finally { await app.close(); }
});

test("9b: reclassifying a populated account changes raw External rollups and published disclosures", async () => {
  const now = new Date();
  for (let index = 0; index < 20; index += 1) {
    await seedAccount({
      phoneVerified: index < 8,
      emailVerified: index < 8,
      records: index < 8 ? [now, now, now] : [],
      attestations: index < 8 ? [now] : [],
      active: index < 8
    });
  }
  const added = await seedAccount({ classification: "INTERNAL_TEST", phoneVerified: true, records: [now, now, now], active: false });
  await rebuildRollups();
  const rawBefore = await query(`SELECT metric_key, count FROM metrics_snapshot WHERE bucket = 'external'`);
  const dailyBefore = await query(`
    SELECT metric_key, COALESCE(SUM(count), 0)::int AS count
    FROM metrics_daily_rollup
    WHERE bucket = 'external' AND metric_key IN ('records_received', 'attestations_issued')
    GROUP BY metric_key
  `);
  let app = await buildApp();
  let before;
  try { before = (await ownerRequest(app, "/admin/suppressed/overview")).json(); }
  finally { await app.close(); }

  await query(`UPDATE account_classification SET classification = 'EXTERNAL' WHERE user_id = $1`, [added]);
  await rebuildRollups();
  const rawAfter = await query(`SELECT metric_key, count FROM metrics_snapshot WHERE bucket = 'external'`);
  const dailyAfter = await query(`
    SELECT metric_key, COALESCE(SUM(count), 0)::int AS count
    FROM metrics_daily_rollup
    WHERE bucket = 'external' AND metric_key IN ('records_received', 'attestations_issued')
    GROUP BY metric_key
  `);
  const beforeMap = Object.fromEntries(rawBefore.rows.map(({ metric_key, count }) => [metric_key, count]));
  const afterMap = Object.fromEntries(rawAfter.rows.map(({ metric_key, count }) => [metric_key, count]));
  const dailyBeforeMap = Object.fromEntries(dailyBefore.rows.map(({ metric_key, count }) => [metric_key, count]));
  const dailyAfterMap = Object.fromEntries(dailyAfter.rows.map(({ metric_key, count }) => [metric_key, count]));
  for (const key of ["accounts_all", "accounts_phone_verified", "accounts_with_records", "contributors_records_received"]) {
    assert.equal(afterMap[key], beforeMap[key] + 1);
  }
  assert.equal(dailyAfterMap.records_received, dailyBeforeMap.records_received + 3);

  app = await buildApp();
  try {
    const afterBody = (await ownerRequest(app, "/admin/suppressed/overview")).json();
    for (const item of before.metrics) {
      const current = afterBody.metrics.find(({ key }) => key === item.key);
      assert.equal(current.disclosure.status, item.disclosure.status);
      if (current.disclosure.status === "published") {
        const expectedRaw = current.key === "accounts_registered"
          ? afterMap.accounts_all
          : ["records_received", "attestations_issued"].includes(current.key)
            ? dailyAfterMap[current.key]
            : afterMap[current.key];
        assert.equal(current.disclosure.value, expectedRaw);
      }
    }
  } finally { await app.close(); }
});

test("10: an External account created in 1999 is included in accounts_registered", async () => {
  for (let index = 0; index < 5; index += 1) await seedAccount({ createdAt: new Date("1999-06-01T00:00:00Z") });
  await rebuildRollups();
  const app = await buildApp();
  try {
    assert.deepEqual(metric((await ownerRequest(app, "/admin/suppressed/overview")).json(), "accounts_registered"), { status: "published", value: 5 });
  } finally { await app.close(); }
});

test("11: provisional and its statement appear only while an account is unclassified", async () => {
  await seedAccount({ classification: null });
  await rebuildRollups();
  let app = await buildApp();
  try {
    for (const response of await suppressedResponses(app)) {
      assert.equal(response.json().provisional, true);
      assert.ok(response.json().statements.some((statement) => statement.startsWith("Provisional:")));
    }
  } finally { await app.close(); }
  await resetState();
  await seedAccount();
  await rebuildRollups();
  app = await buildApp();
  try {
    for (const response of await suppressedResponses(app)) {
      assert.equal(response.json().provisional, false);
      assert.equal(response.json().statements.some((statement) => statement.startsWith("Provisional:")), false);
    }
  } finally { await app.close(); }
});

test("12: never-built and failed rebuilds return 503 and provisional true on both routes", async () => {
  await query(`
    ALTER TABLE metrics_rollup_state
    ADD CONSTRAINT suppressed_test_reject_build CHECK (stale OR build_ms < 0) NOT VALID
  `);
  const app = await buildApp();
  try {
    for (const url of [
      "/admin/suppressed/overview",
      "/admin/suppressed/breakdown?dimension=country"
    ]) {
      const response = await ownerRequest(app, url);
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().provisional, true);
    }
  } finally {
    await app.close();
    await query(`ALTER TABLE metrics_rollup_state DROP CONSTRAINT suppressed_test_reject_build`);
  }
});

test("13: overview definitions are verbatim and response keys, labels, and statements avoid banned words", async () => {
  for (let index = 0; index < 5; index += 1) await seedAccount();
  await rebuildRollups();
  const app = await buildApp();
  try {
    const responses = await suppressedResponses(app);
    assert.deepEqual(responses[0].json().metrics.map(({ key, definition }) => ({ key, definition })),
      METRIC_DEFINITIONS.map(({ key, definition }) => ({ key, definition })));
    for (const response of responses) {
      const body = response.json();
      const testedText = JSON.stringify({
        keys: [...allKeys(body)],
        labels: [body.dimension_label],
        statements: body.statements
      });
      assert.equal(/transactions?|verifications?/i.test(testedText), false);
    }
  } finally { await app.close(); }
});

test("15: a lone small country causes the smallest publishable country to join the residual", async () => {
  for (const [country, count] of [["US", 12], ["GB", 7], ["NG", 3]]) {
    for (let index = 0; index < count; index += 1) await seedAccount({ country });
  }
  await rebuildRollups();
  const app = await buildApp();
  try {
    assert.deepEqual((await ownerRequest(app, "/admin/suppressed/breakdown?dimension=country")).json().result, {
      status: "published",
      cells: [{ category: "US", count: 12 }, { category: "other", count: 10 }],
      total: 22
    });
  } finally { await app.close(); }
});

test("16: an unsafe 6 and 3 country breakdown is withheld without cells", async () => {
  for (const [country, count] of [["US", 6], ["GB", 3]]) {
    for (let index = 0; index < count; index += 1) await seedAccount({ country });
  }
  await rebuildRollups();
  const app = await buildApp();
  try {
    const result = (await ownerRequest(app, "/admin/suppressed/breakdown?dimension=country")).json().result;
    assert.equal(result.status, "withheld");
    assert.equal(result.reason, "residual_unsafe");
    assert.equal(Object.hasOwn(result, "cells"), false);
  } finally { await app.close(); }
});

test("16a: the sector route enforces the residual ceiling and also permits a safe residual", async () => {
  const sectors = [
    "trade_retail", "food_hospitality", "transport_logistics",
    "skilled_construction", "personal_professional", "digital_online"
  ];
  for (let sectorIndex = 0; sectorIndex < sectors.length; sectorIndex += 1) {
    const count = sectorIndex === 0 ? 9 : 4;
    for (let index = 0; index < count; index += 1) await seedAccount({ sector: sectors[sectorIndex] });
  }
  for (let index = 0; index < 4; index += 1) await seedAccount({ sector: "not-valid" });
  await rebuildRollups();
  let app = await buildApp();
  try {
    const result = (await ownerRequest(app, "/admin/suppressed/breakdown?dimension=sector")).json().result;
    assert.equal(result.status, "withheld");
    assert.equal(result.reason, "residual_unsafe");
    assert.equal(Object.hasOwn(result, "cells"), false);
  } finally { await app.close(); }

  await resetState();
  for (const [sector, count] of [["trade_retail", 12], ["food_hospitality", 7], ["transport_logistics", 3], ["skilled_construction", 2]]) {
    for (let index = 0; index < count; index += 1) await seedAccount({ sector });
  }
  await rebuildRollups();
  app = await buildApp();
  try {
    assert.deepEqual((await ownerRequest(app, "/admin/suppressed/breakdown?dimension=sector")).json().result, {
      status: "published",
      cells: [
        { category: "trade_retail", count: 12 },
        { category: "food_hospitality", count: 7 },
        { category: "other", count: 5 }
      ],
      total: 24
    });
  } finally { await app.close(); }
});

test("16b: the country route uses the country universe for a 9 and six 4s shape", async () => {
  const countries = ["US", "GB", "NG", "GH", "CA", "DE", "FR"];
  for (let countryIndex = 0; countryIndex < countries.length; countryIndex += 1) {
    const count = countryIndex === 0 ? 9 : 4;
    for (let index = 0; index < count; index += 1) await seedAccount({ country: countries[countryIndex] });
  }
  await rebuildRollups();
  const app = await buildApp();
  try {
    assert.deepEqual((await ownerRequest(app, "/admin/suppressed/breakdown?dimension=country")).json().result, {
      status: "published",
      cells: [{ category: "US", count: 9 }, { category: "other", count: 24 }],
      total: 33
    });
  } finally { await app.close(); }
});

test("17: invalid stored sector and country markers become no_valid_code and never leave the route", async () => {
  await seedAccount({ sector: "<script>secret-marker", country: "ZZ" });
  for (let index = 0; index < 5; index += 1) await seedAccount();
  await rebuildRollups();
  const stored = JSON.stringify((await query(`SELECT dimension, category, count FROM metrics_dimension_snapshot`)).rows);
  assert.equal(stored.includes("secret-marker"), false);
  assert.equal(stored.includes("ZZ"), false);
  assert.match(stored, /no_valid_code/);
  const app = await buildApp();
  try {
    for (const response of await suppressedResponses(app)) {
      assert.equal(response.body.includes("secret-marker"), false);
      assert.equal(response.body.includes('"ZZ"'), false);
    }
  } finally { await app.close(); }
});

test("18: country coverage failure reveals no count of accounts with or without a valid code", async () => {
  for (let index = 0; index < 10; index += 1) await seedAccount({ country: index < 4 ? "US" : "ZZ" });
  await rebuildRollups();
  const app = await buildApp();
  try {
    const result = (await ownerRequest(app, "/admin/suppressed/breakdown?dimension=country")).json().result;
    assert.deepEqual(result, {
      status: "withheld",
      reason: "valid_codes_below_half",
      total: { status: "published", value: 10 }
    });
    assert.equal(Object.hasOwn(result, "cells"), false);
    assert.equal(Object.hasOwn(result, "valid_codes"), false);
    assert.equal(Object.hasOwn(result, "no_valid_code"), false);
  } finally { await app.close(); }
});

test("18a: a profile country code is counted normally and carries the exact provenance wording", async () => {
  for (let index = 0; index < 5; index += 1) await seedAccount({ country: "NG" });
  await rebuildRollups();
  const app = await buildApp();
  try {
    const response = await ownerRequest(app, "/admin/suppressed/breakdown?dimension=country");
    const body = response.json();
    assert.equal(body.dimension_label, "Profile country code");
    assert.deepEqual(body.result.cells, [{ category: "NG", count: 5 }]);
    assert.ok(body.statements.includes("Country is the two-letter code stored on the account profile. It may have been chosen by the account holder or filled in from the country of the account's phone number. It is not checked."));
    for (const wording of ["location", "based in", "operates in", "stated"]) assert.equal(response.body.toLowerCase().includes(wording), false);
  } finally { await app.close(); }
});

test("19: excluded groups neither enter dimension snapshots nor alter breakdowns", async () => {
  for (let index = 0; index < 6; index += 1) await seedAccount({ country: "US", sector: "trade_retail" });
  await rebuildRollups();
  const app = await buildApp();
  try {
    const base = (await suppressedResponses(app)).slice(1).map((response) => response.json().result);
    for (const classification of ["INTERNAL_TEST", "DEMO", null]) {
      await seedAccount({ classification, country: "GB", sector: "agriculture" });
    }
    await rebuildRollups();
    const rows = await query(`SELECT dimension, SUM(count)::int AS count FROM metrics_dimension_snapshot GROUP BY dimension`);
    assert.deepEqual(Object.fromEntries(rows.rows.map(({ dimension, count }) => [dimension, count])), { country: 6, sector: 6 });
    const current = (await suppressedResponses(app)).slice(1).map((response) => response.json().result);
    assert.deepEqual(current, base);
  } finally { await app.close(); }
});

test("20: reclassification marks rollups stale and rebuilt breakdowns reflect the move out of External", async () => {
  const movedPhone = "+15551234567";
  await seedAccount({ country: "US", phone: movedPhone });
  for (let index = 0; index < 5; index += 1) await seedAccount({ country: "US" });
  for (let index = 0; index < 6; index += 1) await seedAccount({ country: "GB" });
  await rebuildRollups();
  const app = await buildApp();
  try {
    const owner = await seedAdmin("owner");
    const session = await createSession(owner);
    const preview = await app.inject({
      method: "POST",
      url: "/admin/classification/preview",
      headers: auth(session),
      payload: {
        phone_number: movedPhone,
        classification: "INTERNAL_TEST",
        reason_code: "OPERATOR_TEST_ACCOUNT"
      }
    });
    assert.equal(preview.statusCode, 200);
    const applied = await app.inject({
      method: "POST",
      url: "/admin/classification/apply",
      headers: auth(session),
      payload: { confirmation_token: preview.json().confirmation_token }
    });
    assert.equal(applied.statusCode, 200);
    assert.equal((await query(`SELECT stale FROM metrics_rollup_state WHERE id = TRUE`)).rows[0].stale, true);
    await rebuildRollups();
    assert.deepEqual((await ownerRequest(app, "/admin/suppressed/breakdown?dimension=country")).json().result, {
      status: "published",
      cells: [{ category: "GB", count: 6 }, { category: "US", count: 5 }],
      total: 11
    });
  } finally { await app.close(); }
});

test("21: distinctive account identifiers never appear in either suppressed route", async () => {
  const markers = [
    "+15559876543",
    "distinctive-983746@example.test",
    "Distinctive Name 837465",
    "Distinctive Business 746583"
  ];
  await seedAccount({ phone: markers[0], email: markers[1], name: markers[2], businessName: markers[3] });
  for (let index = 0; index < 5; index += 1) await seedAccount();
  await rebuildRollups();
  const app = await buildApp();
  try {
    for (const response of await suppressedResponses(app)) {
      for (const marker of markers) {
        assert.equal(response.body.includes(marker), false);
        const digits = marker.replace(/\D/g, "");
        if (digits) assert.equal(response.body.includes(digits), false);
      }
    }
  } finally { await app.close(); }
});

test("22: suppressed route statements return only explicitly allowed aggregate fields", async () => {
  for (let index = 0; index < 6; index += 1) await seedAccount();
  await rebuildRollups();
  const recorder = recordPoolStatements(getAdminReadPool());
  const app = await buildApp();
  try {
    for (const response of await suppressedResponses(app)) assert.equal(response.statusCode, 200);
    const allowed = new Set([
      "due", "built_at", "stale", "build_ms", "out_of_range", "invalidations",
      "last_attempt_at", "last_failure_at", "checked_at", "cache_valid_until",
      "metric_key", "count", "provisional", "category"
    ]);
    const forbidden = new Set([
      "operating_region", "country", "sector_id", "business_type_id", "email",
      "phone_number", "name", "business_name", "id", "user_id", "device_identity"
    ]);
    for (const statement of recorder.statements) {
      for (const field of statement.fields) {
        assert.equal(forbidden.has(field), false, `forbidden result field ${field}`);
        assert.equal(allowed.has(field), true, `unexpected result field ${field}`);
      }
    }
  } finally {
    recorder.restore();
    await app.close();
  }
});

test("23: threshold 10 does not publish a breakdown cell of 7", async () => {
  config.adminKAnonThreshold = 10;
  for (let index = 0; index < 7; index += 1) await seedAccount({ country: "US" });
  for (let index = 0; index < 13; index += 1) await seedAccount({ country: "GB" });
  await rebuildRollups();
  const app = await buildApp();
  try {
    const response = await ownerRequest(app, "/admin/suppressed/breakdown?dimension=country");
    assert.equal(response.body.includes('"category":"US","count":7'), false);
    assert.equal(response.json().result.cells?.some(({ category }) => category === "US") || false, false);
  } finally { await app.close(); }
});

test("23a: threshold wording and labels follow 10 and the default without a hard-coded route sentence", async () => {
  for (let index = 0; index < 10; index += 1) await seedAccount();
  await rebuildRollups();
  config.adminKAnonThreshold = 10;
  let app = await buildApp();
  try {
    for (const response of await suppressedResponses(app)) {
      const body = response.json();
      assert.equal(body.minimum_cell_size, 10);
      assert.ok(body.statements.some((statement) => statement.includes("fewer than 10")));
      assert.equal(body.statements.some((statement) => statement.includes("fewer than 5")), false);
    }
  } finally { await app.close(); }
  config.adminKAnonThreshold = 5;
  app = await buildApp();
  try {
    for (const response of await suppressedResponses(app)) {
      assert.ok(response.json().statements.some((statement) => statement.includes("fewer than 5")));
    }
  } finally { await app.close(); }
  const source = await readFile(new URL("../src/routes/admin/suppressed.js", import.meta.url), "utf8");
  assert.equal(source.includes("fewer than 5"), false);
});

test("24: contributor internals and accounts_all stay absent from every 3a response", async () => {
  for (let index = 0; index < 6; index += 1) await seedAccount({ records: [new Date()], attestations: [new Date()] });
  await rebuildRollups();
  const app = await buildApp();
  const owner = await seedAdmin("owner");
  const session = await createSession(owner);
  try {
    for (const url of [
      "/admin/metrics/overview?range=all",
      "/admin/metrics/timeseries?metric=records_received&bucket=week&periods=1",
      "/admin/metrics/timeseries?metric=attestations_issued&bucket=month&periods=1"
    ]) {
      const response = await app.inject({ method: "GET", url, headers: auth(session) });
      assert.equal(response.statusCode, 200);
      for (const key of [
        "accounts_all", "contributors_records_received",
        "contributors_attestations_issued", "contributors_devices_active"
      ]) assert.equal(response.body.includes(key), false);
    }
  } finally { await app.close(); }
});
