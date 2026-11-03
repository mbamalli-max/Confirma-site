import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  METRIC_DEFINITIONS,
  METRICS_REBUILD_LOCK_KEY,
  ROLLUP_BASIS_MARKER,
  ensureFreshRollups,
  readOverview,
  readRollupState,
  readStatus,
  readTimeseries,
  rebuildRollups
} from "../src/admin-metrics.js";
import {
  adminReadQuery,
  closeAdminPools,
  getAdminReadPool,
  getRebuildPool
} from "../src/admin-db.js";
import { config } from "../src/config.js";
import { getPool, query } from "../src/db.js";
import { clearMetricsCache } from "../src/routes/admin/metrics.js";
import {
  ADMIN_ORIGIN,
  buildApp,
  createSession,
  prepareAdminTestDatabase,
  seedAdmin,
  storedSectorColumns
} from "./helpers/admin.js";

function headers(session) {
  return { authorization: `Bearer ${session.token}` };
}

async function ownerAccess(app) {
  const owner = await seedAdmin("owner");
  const session = await createSession(owner);
  return { app, owner, session, headers: headers(session) };
}

async function seedUser({
  classification = null,
  createdAt = new Date(),
  phone = `+1555${crypto.randomInt(1_000_000, 9_999_999)}`,
  email = `${crypto.randomUUID()}@example.test`,
  name = null,
  businessName = null,
  businessType = null,
  phoneVerified = false,
  emailVerified = false,
  deviceStatus = "ACTIVE",
  records = [],
  attestations = []
} = {}) {
  const inserted = await query(
    `
      INSERT INTO users (phone_number, email, phone_verified, email_verified, created_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, phone_number
    `,
    [phone, email, phoneVerified, emailVerified, createdAt]
  );
  const user = inserted.rows[0];
  if (name || businessName || businessType) {
    await query(
      `INSERT INTO profiles (user_id, name, business_name, business_type_id, sector_id, sector_source) VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, name, businessName, businessType, ...storedSectorColumns({ businessType })]
    );
  }
  const deviceIdentity = `device-${crypto.randomUUID()}`;
  await query(
    `
      INSERT INTO device_identities (device_identity, public_key, phone_number, user_id, status)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [deviceIdentity, "synthetic-key", phone, user.id, deviceStatus]
  );
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    await query(
      `
        INSERT INTO ledger_entries (
          device_identity, entry_id, entry_hash, prev_entry_hash,
          signature, confirmed_at, synced_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        deviceIdentity,
        index + 1,
        crypto.randomBytes(32).toString("hex"),
        index === 0 ? "0".repeat(64) : crypto.randomBytes(32).toString("hex"),
        "synthetic-signature",
        Object.hasOwn(record, "confirmedAt") ? record.confirmedAt : record.syncedAt,
        record.syncedAt,
        { synthetic: true }
      ]
    );
  }
  for (let index = 0; index < attestations.length; index += 1) {
    const issuedAt = attestations[index];
    await query(
      `
        INSERT INTO attestations (
          vt_id, device_identity, phone_number, user_id, ledger_root_hash,
          window_start, window_end, entry_count, server_signature, status, issued_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'VALID', $10)
      `,
      [
        `vt-${crypto.randomUUID()}`,
        deviceIdentity,
        phone,
        user.id,
        crypto.randomBytes(32).toString("hex"),
        issuedAt,
        issuedAt,
        1,
        "synthetic-server-signature",
        issuedAt
      ]
    );
  }
  if (classification) {
    const admin = await seedAdmin("owner");
    await query(
      `
        INSERT INTO account_classification (user_id, classification, reason_code, classified_by)
        VALUES ($1, $2, 'CORRECTION', $3)
      `,
      [user.id, classification, admin.id]
    );
  }
  return { ...user, deviceIdentity };
}

function metric(body, key) {
  return body.metrics.find((item) => item.key === key);
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
  clearMetricsCache();
}

async function seedFreshReceiptBasisRollups() {
  // Start with the unaffected v2 figures/dimensions, then replace every record-derived row
  // with the receipt-date keys and calculations produced by the old code. The marker is absent.
  await rebuildRollups();
  await query(`DELETE FROM metrics_daily_rollup WHERE metric_key IN ('records_recorded', 'records_received')`);
  await query(`
    INSERT INTO metrics_daily_rollup (metric_date, metric_key, bucket, count)
    SELECT
      (entry.synced_at AT TIME ZONE 'UTC')::date,
      'records_received',
      CASE WHEN classification.classification IN ('INTERNAL_TEST', 'DEMO') THEN 'excluded' ELSE 'external' END,
      COUNT(*)::int
    FROM ledger_entries entry
    INNER JOIN device_identities device ON device.device_identity = entry.device_identity
    INNER JOIN users account ON account.id = device.user_id
    LEFT JOIN account_classification classification ON classification.user_id = account.id
    WHERE (entry.synced_at AT TIME ZONE 'UTC')::date >= DATE '2000-01-01'
      AND (entry.synced_at AT TIME ZONE 'UTC')::date <= (clock_timestamp() AT TIME ZONE 'UTC')::date + 1
    GROUP BY 1, 3
  `);
  await query(`
    DELETE FROM metrics_snapshot
    WHERE metric_key = $1
       OR metric_key IN ('records_undated', 'contributors_records_recorded', 'contributors_records_received')
       OR metric_key LIKE 'accounts_submitting_records_%'
  `, [ROLLUP_BASIS_MARKER]);
  await query(`
    INSERT INTO metrics_snapshot (metric_key, bucket, count)
    SELECT
      'contributors_records_received',
      CASE WHEN classification.classification IN ('INTERNAL_TEST', 'DEMO') THEN 'excluded' ELSE 'external' END,
      COUNT(DISTINCT account.id)::int
    FROM ledger_entries entry
    INNER JOIN device_identities device ON device.device_identity = entry.device_identity
    INNER JOIN users account ON account.id = device.user_id
    LEFT JOIN account_classification classification ON classification.user_id = account.id
    WHERE (entry.synced_at AT TIME ZONE 'UTC')::date >= DATE '2000-01-01'
      AND (entry.synced_at AT TIME ZONE 'UTC')::date <= (clock_timestamp() AT TIME ZONE 'UTC')::date + 1
    GROUP BY 2
  `);
  await query(`
    INSERT INTO metrics_snapshot (metric_key, bucket, count)
    SELECT
      'accounts_submitting_records_' || ranges.range_key,
      CASE WHEN classification.classification IN ('INTERNAL_TEST', 'DEMO') THEN 'excluded' ELSE 'external' END,
      COUNT(DISTINCT account.id)::int
    FROM ledger_entries entry
    INNER JOIN device_identities device ON device.device_identity = entry.device_identity
    INNER JOIN users account ON account.id = device.user_id
    LEFT JOIN account_classification classification ON classification.user_id = account.id
    CROSS JOIN (VALUES
      ('30d', (clock_timestamp() AT TIME ZONE 'UTC')::date - 29),
      ('90d', (clock_timestamp() AT TIME ZONE 'UTC')::date - 89),
      ('12m', (date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '11 months')::date),
      ('all', DATE '2000-01-01')
    ) AS ranges(range_key, start_date)
    WHERE (entry.synced_at AT TIME ZONE 'UTC')::date >= ranges.start_date
      AND (entry.synced_at AT TIME ZONE 'UTC')::date <= (clock_timestamp() AT TIME ZONE 'UTC')::date + 1
    GROUP BY 1, 2
  `);
  await query(`
    UPDATE metrics_rollup_state
    SET built_at = clock_timestamp(), stale = FALSE, last_attempt_at = NULL, last_failure_at = NULL
    WHERE id = TRUE
  `);
  clearMetricsCache();
}

async function rejectStateUpdate(run) {
  await query(`UPDATE metrics_rollup_state SET stale = TRUE WHERE id = TRUE`);
  await query(`
    ALTER TABLE metrics_rollup_state
    ADD CONSTRAINT metrics_state_test_reject_build CHECK (stale OR build_ms < 0) NOT VALID
  `);
  try {
    return await run();
  } finally {
    await query(`
      ALTER TABLE metrics_rollup_state
      DROP CONSTRAINT metrics_state_test_reject_build
    `);
  }
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withinOneSecond(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Operation exceeded one second.")), 950);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function recordPoolStatements(pool) {
  const statements = [];
  const originalPoolQuery = pool.query;
  const originalConnect = pool.connect;
  const wrappedClients = new Map();

  function record(text, result) {
    statements.push({
      text: typeof text === "string" ? text : text?.text || "",
      fields: (result?.fields || []).map(({ name }) => name)
    });
  }

  pool.query = async function recordedPoolQuery(text, ...args) {
    const result = await originalPoolQuery.call(this, text, ...args);
    record(text, result);
    return result;
  };
  function wrapClient(client) {
    if (!wrappedClients.has(client)) {
      const originalClientQuery = client.query;
      wrappedClients.set(client, originalClientQuery);
      client.query = async function recordedClientQuery(text, ...queryArgs) {
        const result = await originalClientQuery.call(this, text, ...queryArgs);
        record(text, result);
        return result;
      };
    }
    return client;
  }
  pool.connect = function recordedConnect(callback) {
    if (typeof callback === "function") {
      return originalConnect.call(this, (error, client, release) => {
        callback(error, client && wrapClient(client), release);
      });
    }
    return originalConnect.call(this).then(wrapClient);
  };

  return {
    statements,
    restore() {
      pool.query = originalPoolQuery;
      pool.connect = originalConnect;
      for (const [client, originalClientQuery] of wrappedClients) {
        client.query = originalClientQuery;
      }
    }
  };
}

before(async () => {
  await prepareAdminTestDatabase({
    migrations: [
      new URL("../migrations/009_admin_backend.sql", import.meta.url),
      new URL("../migrations/010_account_classification.sql", import.meta.url),
      new URL("../migrations/011_admin_metrics_rollup.sql", import.meta.url),
      new URL("../migrations/012_admin_dimension_snapshot.sql", import.meta.url),
      new URL("../migrations/016_admin_exclusion_model.sql", import.meta.url),
      new URL("../migrations/017_sector_assignment.sql", import.meta.url),
      new URL("../migrations/023_recovery.sql", import.meta.url)
    ]
  });
  config.adminJwtSecret = crypto.randomBytes(32).toString("hex");
  config.adminTotpEncKey = crypto.randomBytes(32).toString("hex");
  config.adminTotpEncKeyBytes = null;
  config.adminJwtExpiry = "1h";
  config.adminIpAllowlist = "";
});

beforeEach(async () => {
  config.adminCorsOrigins = ADMIN_ORIGIN;
  config.adminIpAllowlist = "";
  await resetState();
});

after(async () => {
  try {
    await resetState();
  } finally {
    await closeAdminPools();
    await getPool().end();
  }
});

test("1: overview figures agree with independent source counts", async () => {
  const now = new Date();
  await seedUser({ classification: "EXTERNAL", phoneVerified: true, records: [{ syncedAt: now }], attestations: [now] });
  await seedUser({ classification: "DEMO", emailVerified: true, records: [{ syncedAt: now }, { syncedAt: now }] });
  await seedUser({ records: [{ syncedAt: now }] });
  await rebuildRollups();
  const overview = await readOverview({ range: "all" });
  assert.deepEqual(
    Object.fromEntries(METRIC_DEFINITIONS.map(({ key }) => [key, metric(overview, key).total])),
    {
      accounts_registered: 3,
      records_recorded: 4,
      attestations_issued: 1,
      accounts_submitting_records: 3,
      accounts_phone_verified: 1,
      accounts_email_verified: 1,
      devices_active: 3,
      accounts_with_records: 3,
      accounts_with_3plus_records: 0,
      accounts_setup_fields_stored: 0,
      accounts_setup_fields_with_records: 0,
      records_undated: 0
    }
  );
});

test("2: six-week and three-month series agree with the source dates", async () => {
  const now = new Date();
  await seedUser({ records: [{ syncedAt: now }], attestations: [now] });
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const weekly = await app.inject({ method: "GET", url: "/admin/v2/timeseries?metric=records_recorded&bucket=week&periods=6", headers: access.headers });
    const monthly = await app.inject({ method: "GET", url: "/admin/v2/timeseries?metric=attestations_issued&bucket=month&periods=3", headers: access.headers });
    assert.equal(weekly.json().periods.length, 6);
    assert.equal(monthly.json().periods.length, 3);
    assert.equal(weekly.json().periods.reduce((sum, item) => sum + item.total, 0), 1);
    assert.equal(monthly.json().periods.reduce((sum, item) => sum + item.total, 0), 1);
  } finally { await app.close(); }
});

test("3: every returned total reconciles to its two buckets", async () => {
  await seedUser({ records: [{ syncedAt: new Date() }] });
  await seedUser({ classification: "DEMO", records: [{ syncedAt: new Date() }] });
  await rebuildRollups();
  const overview = await readOverview({ range: "all" });
  for (const item of overview.metrics) {
    assert.equal(item.total, item.external + item.excluded);
    assert.deepEqual(Object.keys(item).filter((key) => ["external", "excluded", "internal_demo", "unclassified", "total"].includes(key)), ["external", "excluded", "total"]);
  }
});

test("4: an empty database returns every metric with three zeroes", async () => {
  await rebuildRollups();
  const overview = await readOverview({ range: "all" });
  assert.equal(overview.metrics.length, 12);
  for (const item of overview.metrics) {
    assert.deepEqual([item.external, item.excluded, item.total], [0, 0, 0]);
  }
});

test("4a: accounts submitting records counts each account once, only inside the period", async () => {
  const now = new Date();
  const old = new Date(Date.now() - 200 * 86_400_000);
  await seedUser({ records: [{ syncedAt: now }, { syncedAt: now }, { syncedAt: now }] });
  await seedUser({ records: [{ syncedAt: old }] });
  await seedUser({ classification: "INTERNAL_TEST", records: [{ syncedAt: now }] });
  await seedUser();
  await rebuildRollups();
  const counts = async (range) => {
    const item = metric(await readOverview({ range }), "accounts_submitting_records");
    return [item.external, item.excluded, item.total];
  };
  assert.deepEqual(await counts("30d"), [1, 1, 2]);
  assert.deepEqual(await counts("90d"), [1, 1, 2]);
  assert.deepEqual(await counts("12m"), [2, 1, 3]);
  assert.deepEqual(await counts("all"), [2, 1, 3]);
  const item = metric(await readOverview({ range: "30d" }), "accounts_submitting_records");
  assert.equal(item.point_in_time, false);
  assert.match(item.definition, /each counted once/);
});

test("4b: accounts submitting records is not a time-series metric", async () => {
  await rebuildRollups();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const response = await app.inject({ method: "GET", url: "/admin/v2/timeseries?metric=accounts_submitting_records&bucket=week&periods=1", headers: access.headers });
    assert.equal(response.statusCode, 400);
  } finally { await app.close(); }
});

test("4c: devices carry the registration-status name, not an activity name (D2)", () => {
  const devices = METRIC_DEFINITIONS.find(({ key }) => key === "devices_active");
  assert.equal(devices.name, "Devices in ACTIVE registration status");
  assert.match(devices.definition, /Not a count of people or of recent use/);
  for (const { name, definition } of METRIC_DEFINITIONS) {
    assert.doesNotMatch(`${name} ${definition}`, /active users?|active accounts/i);
  }
});

test("slice 3c 1: setup fields require a nonblank name and business type", async () => {
  await seedUser({ name: "Ready account", businessType: "trade_retail" });
  await seedUser({ name: "Name only" });
  await seedUser({ businessType: "type_only" });
  await seedUser();
  await seedUser({ name: "   ", businessType: "space_name" });
  await seedUser({ name: "Space type", businessType: "   " });
  await rebuildRollups();
  const overview = await readOverview({ range: "all" });
  assert.equal(metric(overview, "accounts_setup_fields_stored").total, 1);
});

test("slice 3c 2: business_name without name does not count as setup fields", async () => {
  await seedUser({ businessName: "Legacy business", businessType: "trade_retail" });
  await rebuildRollups();
  const overview = await readOverview({ range: "all" });
  assert.equal(metric(overview, "accounts_setup_fields_stored").total, 0);
  const sources = await Promise.all([
    "../src/admin-metrics.js",
    "../src/routes/admin/metrics.js",
    "../src/admin-db.js"
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  assert.equal(sources.join("\n").toLowerCase().includes("business_name"), false);
});

test("slice 3c 3: an unlisted business type counts but is never stored in a rollup or response", async () => {
  const marker = "retired_type_x";
  await seedUser({ name: "Stored fields", businessType: marker });
  await rebuildRollups();
  const overview = await readOverview({ range: "all" });
  assert.equal(metric(overview, "accounts_setup_fields_stored").total, 1);
  const rollups = await query(`
    SELECT row_to_json(rows)::text AS value
    FROM (
      SELECT metric_key, bucket, count FROM metrics_snapshot
      UNION ALL
      SELECT metric_key, bucket, count FROM metrics_daily_rollup
    ) rows
  `);
  assert.equal(JSON.stringify(rollups.rows).includes(marker), false);
  assert.equal(JSON.stringify(overview).includes(marker), false);
});

test("slice 3c 4: setup fields with records uses the all-time record count and remains a subset", async () => {
  const now = new Date();
  await seedUser({ name: "Current record", businessType: "one", records: [{ syncedAt: now }] });
  await seedUser({ name: "Old record", businessType: "two", records: [{ syncedAt: new Date("1999-01-01T00:00:00Z") }] });
  await seedUser({ name: "No record", businessType: "three" });
  await seedUser({ name: "Missing type", records: [{ syncedAt: now }] });
  await rebuildRollups();
  const overview = await readOverview({ range: "all" });
  assert.equal(metric(overview, "accounts_setup_fields_stored").total, 3);
  assert.equal(metric(overview, "accounts_setup_fields_with_records").total, 2);
  assert.equal(metric(overview, "accounts_with_records").total, 3);
});

test("slice 3c 5: setup-field subset chains hold in every bucket over thirty accounts", async () => {
  const classifications = ["EXTERNAL", "DEMO", null];
  for (const classification of classifications) {
    for (let index = 0; index < 10; index += 1) {
      await seedUser({
        classification,
        name: index < 7 ? `Account ${index}` : null,
        businessType: index < 6 ? `type_${index}` : null,
        records: index < 4 ? [{ syncedAt: new Date() }] : []
      });
    }
  }
  await rebuildRollups();
  const overview = await readOverview({ range: "all" });
  const setup = metric(overview, "accounts_setup_fields_stored");
  const setupWithRecords = metric(overview, "accounts_setup_fields_with_records");
  const allAccounts = metric(overview, "accounts_registered");
  const withRecords = metric(overview, "accounts_with_records");
  for (const bucket of ["external", "excluded", "total"]) {
    assert.ok(setupWithRecords[bucket] <= setup[bucket], bucket);
    assert.ok(setup[bucket] <= allAccounts[bucket], bucket);
    assert.ok(setupWithRecords[bucket] <= withRecords[bucket], bucket);
  }
});

test("slice 3c 6: setup-field figures use the external and excluded buckets", async () => {
  await seedUser({ classification: "EXTERNAL", name: "External", businessType: "one" });
  await seedUser({ classification: "DEMO", name: "Demo", businessType: "two" });
  await seedUser({ name: "No row", businessType: "three" });
  await rebuildRollups();
  const counts = metric(await readOverview({ range: "all" }), "accounts_setup_fields_stored");
  assert.deepEqual([counts.external, counts.excluded, counts.total], [2, 1, 3]);
});

test("slice 3c 7: operator overview exposes both point-in-time setup figures for every range", async () => {
  await seedUser({ classification: "EXTERNAL", name: "Ready", businessType: "trade_retail", records: [{ syncedAt: new Date() }] });
  await rebuildRollups();
  const app = await buildApp();
  const access = await ownerAccess(app);
  const keys = ["accounts_setup_fields_stored", "accounts_setup_fields_with_records"];
  try {
    for (const range of ["30d", "90d", "12m", "all"]) {
      const response = await app.inject({ method: "GET", url: `/admin/v2/overview?range=${range}`, headers: access.headers });
      assert.equal(response.statusCode, 200);
      for (const key of keys) {
        const actual = metric(response.json(), key);
        const expected = METRIC_DEFINITIONS.find((item) => item.key === key);
        assert.equal(actual.name, expected.name);
        assert.equal(actual.definition, expected.definition);
        assert.equal(actual.point_in_time, true);
        assert.equal(actual.range_ignored, true);
        assert.deepEqual(
          Object.keys(actual).filter((field) => ["external", "excluded", "internal_demo", "unclassified", "total"].includes(field)),
          ["external", "excluded", "total"]
        );
      }
    }
    assert.equal(METRIC_DEFINITIONS.filter(({ definition }) => definition.toLowerCase().includes("completed onboarding")).length, 1);
    assert.match(
      METRIC_DEFINITIONS.find(({ key }) => key === "accounts_setup_fields_stored").definition,
      /a proxy for completed onboarding, not a count of it/i
    );
  } finally { await app.close(); }
});

test("slice 3c 8: setup-field metrics are rejected by the time-series route", async () => {
  await rebuildRollups();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    for (const key of ["accounts_setup_fields_stored", "accounts_setup_fields_with_records"]) {
      const response = await app.inject({
        method: "GET",
        url: `/admin/v2/timeseries?metric=${key}&bucket=month&periods=1`,
        headers: access.headers
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, "point_in_time_metric");
    }
  } finally { await app.close(); }
});

test("5: an exclusion moves all historical records out of External on the next read", async () => {
  const user = await seedUser({ records: [{ syncedAt: new Date("2024-01-02T00:00:00Z") }] });
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    await rebuildRollups();
    const before = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    assert.equal(metric(before.json(), "records_recorded").external, 1);
    const preview = await app.inject({ method: "POST", url: "/admin/classification/preview", headers: access.headers, payload: { phone_number: user.phone_number, classification: "INTERNAL_TEST", reason_code: "OPERATOR_TEST_ACCOUNT" } });
    await app.inject({ method: "POST", url: "/admin/classification/apply", headers: access.headers, payload: { confirmation_token: preview.json().confirmation_token } });
    const response = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    assert.equal(metric(response.json(), "records_recorded").external, 0);
    assert.equal(metric(response.json(), "records_recorded").excluded, 1);
  } finally { await app.close(); }
});

test("6: an account with no classification row is External; payment and activity are not required", async () => {
  await seedUser({ records: [{ syncedAt: new Date() }] });
  await seedUser();
  await rebuildRollups();
  const overview = await readOverview({ range: "all" });
  assert.equal(metric(overview, "records_recorded").external, 1);
  assert.equal(metric(overview, "accounts_registered").external, 2);
  assert.equal(metric(overview, "accounts_with_records").external, 1);
  assert.equal(metric(overview, "records_recorded").excluded, 0);
  assert.equal(Object.hasOwn(overview, "provisional"), false);
});

test("7: unusable device-recorded dates are not placed in a period and are counted separately", async () => {
  // ledger_entries.confirmed_at is NOT NULL, so a null date cannot be stored; the rollup's
  // IS NULL guard is defensive only. The reachable unusable dates are the epoch value the
  // server stores when a device sends none, a pre-2000 date and a far-future date.
  await seedUser({ records: [
    { confirmedAt: new Date(0), syncedAt: new Date() },
    { confirmedAt: new Date("1999-12-31T00:00:00Z"), syncedAt: new Date() },
    { confirmedAt: new Date("2099-01-01T00:00:00Z"), syncedAt: new Date() }
  ] });
  await rebuildRollups();
  const rows = await query(`SELECT count FROM metrics_daily_rollup WHERE metric_key = 'records_recorded'`);
  assert.equal(rows.rows.reduce((sum, row) => sum + Number(row.count), 0), 0);
  const overview = await readOverview({ range: "all" });
  assert.equal(metric(overview, "records_undated").total, 3);
  assert.ok(Number((await readRollupState()).out_of_range) >= 3);
});

test("8: a record belongs to its UTC device-recorded month, not its later server receipt month", async () => {
  await seedUser({ records: [{
    confirmedAt: new Date("2026-10-15T23:30:00Z"),
    syncedAt: new Date("2026-11-03T00:30:00Z")
  }] });
  await rebuildRollups();
  const october = await query(`
    SELECT COALESCE(SUM(count), 0)::int AS count
    FROM metrics_daily_rollup
    WHERE metric_key = 'records_recorded' AND metric_date >= DATE '2026-10-01' AND metric_date < DATE '2026-11-01'
  `);
  const november = await query(`
    SELECT COALESCE(SUM(count), 0)::int AS count
    FROM metrics_daily_rollup
    WHERE metric_key = 'records_recorded' AND metric_date >= DATE '2026-11-01' AND metric_date < DATE '2026-12-01'
  `);
  assert.equal(Number(october.rows[0].count), 1);
  assert.equal(Number(november.rows[0].count), 0);
  assert.equal(metric(await readOverview({ range: "30d" }), "accounts_submitting_records").total, 1);
});

test("8a: a recovered FORKED-device replacement is an ordinary confirmed_at row and stays counted once across rebuilds", async () => {
  const user = await seedUser({
    deviceStatus: "FORKED",
    records: [{
      confirmedAt: new Date("2026-10-15T12:00:00Z"),
      syncedAt: new Date("2026-11-03T12:00:00Z")
    }]
  });
  const recoveryId = crypto.randomUUID();
  const replacement = await query(`SELECT entry_hash FROM ledger_entries WHERE device_identity = $1`, [user.deviceIdentity]);
  await query(`
    INSERT INTO recovery_sessions (
      recovery_id, device_identity, user_id, state, app_version, local_summary, lease_expires_at
    ) VALUES ($1, $2, $3, 'completed', 'test', '{}'::jsonb, NOW() - INTERVAL '1 minute')
  `, [recoveryId, user.deviceIdentity, user.id]);
  await query(`
    INSERT INTO ledger_recoveries (
      device_identity, original_entry_hash, original_local_id, original_signed_id, original_confirmed_at,
      date_check, replacement_entry_id, replacement_entry_hash, recovery_id
    ) VALUES ($1, $2, 1, 1, '"2026-10-15T12:00:00.000Z"'::jsonb, 'ok', 1, $3, $4)
  `, [user.deviceIdentity, crypto.randomBytes(32).toString("hex"), replacement.rows[0].entry_hash, recoveryId]);

  await rebuildRollups();
  await rebuildRollups();
  const october = await query(`
    SELECT COALESCE(SUM(count), 0)::int AS count
    FROM metrics_daily_rollup
    WHERE metric_key = 'records_recorded' AND metric_date = DATE '2026-10-15'
  `);
  assert.equal(Number(october.rows[0].count), 1);
  const source = await readFile(new URL("../src/admin-metrics.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ledger_recoveries|recovery_/i);
});

test("9: out-of-range device-recorded dates are excluded and counted", async () => {
  await seedUser({ records: [{ confirmedAt: new Date("1999-12-31T00:00:00Z"), syncedAt: new Date() }] });
  await rebuildRollups();
  assert.equal(metric(await readOverview({ range: "all" }), "records_recorded").total, 0);
  assert.ok(Number((await readRollupState()).out_of_range) >= 1);
});

test("10: classification apply marks stale and the next read clears it", async () => {
  const user = await seedUser();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    await rebuildRollups();
    const preview = await app.inject({ method: "POST", url: "/admin/classification/preview", headers: access.headers, payload: { phone_number: user.phone_number, classification: "DEMO", reason_code: "OPERATOR_DEMO_ACCOUNT" } });
    await app.inject({ method: "POST", url: "/admin/classification/apply", headers: access.headers, payload: { confirmation_token: preview.json().confirmation_token } });
    assert.equal((await readRollupState()).stale, true);
    await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    assert.equal((await readRollupState()).stale, false);
  } finally { await app.close(); }
});

test("11: fifteen-minute freshness uses the database clock, not Date.now", async () => {
  await rebuildRollups();
  const original = Date.now;
  try {
    Date.now = () => original() + 3_600_000;
    assert.equal((await ensureFreshRollups()).rebuilt, false);
    await query(`UPDATE metrics_rollup_state SET built_at = clock_timestamp() - INTERVAL '16 minutes', last_attempt_at = NULL`);
    Date.now = () => original() - 3_600_000;
    assert.equal((await ensureFreshRollups()).rebuilt, true);
  } finally { Date.now = original; }
});

test("12: two simultaneous stale reads start exactly one rebuild", async () => {
  await query(`UPDATE metrics_rollup_state SET stale = TRUE, last_attempt_at = NULL`);
  const results = await Promise.all([ensureFreshRollups(), ensureFreshRollups()]);
  assert.equal(results.filter((result) => result.rebuilt).length, 1);
});

test("13: an advisory lock makes a read serve existing stale figures without waiting", async () => {
  await seedUser();
  await rebuildRollups();
  await query(`UPDATE metrics_rollup_state SET stale = TRUE, last_attempt_at = NULL`);
  const client = await getPool().connect();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [METRICS_REBUILD_LOCK_KEY]);
    const response = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().stale, true);
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [METRICS_REBUILD_LOCK_KEY]);
    client.release();
    await app.close();
  }
});

test("14: a forced rebuild failure preserves the previous rollups", async () => {
  await seedUser();
  await rebuildRollups();
  const beforeRows = await query(`SELECT * FROM metrics_daily_rollup ORDER BY 1, 2, 3`);
  const result = await rejectStateUpdate(() => rebuildRollups());
  const afterRows = await query(`SELECT * FROM metrics_daily_rollup ORDER BY 1, 2, 3`);
  assert.equal(result.reason, "failed");
  assert.deepEqual(afterRows.rows, beforeRows.rows);
});

test("fix2 P1a: a fresh v2 receipt-date rollup rebuilds before recorded-date figures are served", async () => {
  const now = new Date();
  const daysAgo = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const thirteenMonthsAgo = new Date(now);
  thirteenMonthsAgo.setUTCMonth(thirteenMonthsAgo.getUTCMonth() - 13);
  for (const confirmedAt of [daysAgo(40), daysAgo(100), thirteenMonthsAgo, new Date(0)]) {
    await seedUser({ records: [{ confirmedAt, syncedAt: now }] });
  }
  await seedFreshReceiptBasisRollups();

  const oldDaily = await query(`
    SELECT COALESCE(SUM(count), 0)::int AS count
    FROM metrics_daily_rollup
    WHERE metric_key = 'records_received'
      AND metric_date >= (clock_timestamp() AT TIME ZONE 'UTC')::date - 29
  `);
  const oldSubmitters = await query(`
    SELECT metric_key, count FROM metrics_snapshot
    WHERE metric_key LIKE 'accounts_submitting_records_%' AND bucket = 'external'
  `);
  assert.equal(Number(oldDaily.rows[0].count), 4);
  assert.deepEqual(
    Object.fromEntries(oldSubmitters.rows.map(({ metric_key, count }) => [metric_key, Number(count)])),
    {
      accounts_submitting_records_30d: 4,
      accounts_submitting_records_90d: 4,
      accounts_submitting_records_12m: 4,
      accounts_submitting_records_all: 4
    }
  );
  assert.equal((await readRollupState()).basis_ready, false);

  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const response = await app.inject({ method: "GET", url: "/admin/v2/overview?range=30d", headers: access.headers });
    assert.equal(response.statusCode, 200);
    assert.equal(metric(response.json(), "records_recorded").total, 0);
    assert.equal(metric(response.json(), "accounts_submitting_records").total, 0);
    assert.equal(metric(response.json(), "records_undated").total, 1);
    assert.equal(response.body.includes("records_received"), false);
    assert.equal((await readRollupState()).basis_ready, true);

    for (const [range, expected] of [["90d", 1], ["12m", 2], ["all", 3]]) {
      const next = await app.inject({ method: "GET", url: `/admin/v2/overview?range=${range}`, headers: access.headers });
      assert.equal(metric(next.json(), "records_recorded").total, expected, range);
      assert.equal(metric(next.json(), "accounts_submitting_records").total, expected, range);
      assert.equal(metric(next.json(), "records_undated").total, 1, range);
    }
  } finally { await app.close(); }
});

test("fix2 P1b: throttled and failed old-basis rebuilds return unavailable, never old figures", async () => {
  await seedUser({ records: [{ confirmedAt: new Date(0), syncedAt: new Date() }] });
  await seedFreshReceiptBasisRollups();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    await query(`UPDATE metrics_rollup_state SET last_attempt_at = clock_timestamp() WHERE id = TRUE`);
    for (const url of [
      "/admin/v2/overview?range=30d",
      "/admin/v2/timeseries?metric=records_recorded&bucket=month&periods=1"
    ]) {
      const throttled = await app.inject({ method: "GET", url, headers: access.headers });
      assert.equal(throttled.statusCode, 503, url);
      assert.equal(throttled.json().error, "metrics_unavailable", url);
      assert.equal(throttled.body.includes("records_received"), false, url);
    }

    await query(`UPDATE metrics_rollup_state SET last_attempt_at = NULL WHERE id = TRUE`);
    await rejectStateUpdate(async () => {
      for (const url of [
        "/admin/v2/overview?range=30d",
        "/admin/v2/timeseries?metric=records_recorded&bucket=month&periods=1"
      ]) {
        const failed = await app.inject({ method: "GET", url, headers: access.headers });
        assert.equal(failed.statusCode, 503, url);
        assert.equal(failed.json().error, "metrics_unavailable", url);
        assert.equal(failed.body.includes("records_received"), false, url);
      }
    });
  } finally { await app.close(); }
});

test("fix2 P1b/P1c: an old-basis rebuild in progress makes overview and timeseries unavailable", async () => {
  await seedUser({ records: [{ confirmedAt: new Date(0), syncedAt: new Date() }] });
  await seedFreshReceiptBasisRollups();
  const holder = await getPool().connect();
  const app = await buildApp();
  const access = await ownerAccess(app);
  let rebuilding;
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ledger_entries IN ACCESS EXCLUSIVE MODE`);
    rebuilding = rebuildRollups();
    await sleep(100);
    for (const url of [
      "/admin/v2/overview?range=30d",
      "/admin/v2/timeseries?metric=records_recorded&bucket=month&periods=1"
    ]) {
      const response = await withinOneSecond(app.inject({ method: "GET", url, headers: access.headers }));
      assert.equal(response.statusCode, 503, url);
      assert.equal(response.json().error, "metrics_unavailable", url);
    }
  } finally {
    await holder.query("COMMIT").catch(() => {});
    holder.release();
    if (rebuilding) await rebuilding;
    await app.close();
  }
});

test("fix2 P1d: empty-ledger old-basis rows are unavailable until rebuilt, then zeros are real", async () => {
  await query(`
    INSERT INTO metrics_daily_rollup (metric_date, metric_key, bucket, count)
    VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date, 'records_received', 'external', 9)
  `);
  await query(`
    INSERT INTO metrics_snapshot (metric_key, bucket, count)
    VALUES ('accounts_submitting_records_30d', 'external', 1)
  `);
  await query(`
    UPDATE metrics_rollup_state
    SET built_at = clock_timestamp(), stale = FALSE, last_attempt_at = clock_timestamp()
    WHERE id = TRUE
  `);
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const unavailable = await app.inject({ method: "GET", url: "/admin/v2/overview?range=30d", headers: access.headers });
    assert.equal(unavailable.statusCode, 503);
    await query(`UPDATE metrics_rollup_state SET last_attempt_at = NULL WHERE id = TRUE`);
    const rebuilt = await app.inject({ method: "GET", url: "/admin/v2/overview?range=30d", headers: access.headers });
    assert.equal(rebuilt.statusCode, 200);
    assert.equal(metric(rebuilt.json(), "records_recorded").total, 0);
    assert.equal(metric(rebuilt.json(), "accounts_submitting_records").total, 0);
    assert.equal(metric(rebuilt.json(), "records_undated").total, 0);
    assert.equal((await readRollupState()).basis_ready, true);
  } finally { await app.close(); }
});

test("fix2 P1e: the basis marker is idempotent, hidden, and excluded from status row counts", async () => {
  await seedUser({ records: [{ syncedAt: new Date() }] });
  await rebuildRollups();
  await rebuildRollups();
  const markerRows = await query(`SELECT COUNT(*)::int AS count FROM metrics_snapshot WHERE metric_key = $1`, [ROLLUP_BASIS_MARKER]);
  assert.equal(Number(markerRows.rows[0].count), 1);

  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const responses = [];
    for (const [method, url] of [
      ["GET", "/admin/v2/overview?range=all"],
      ["GET", "/admin/v2/timeseries?metric=records_recorded&bucket=month&periods=1"],
      ["GET", "/admin/v2/suppressed/overview"],
      ["GET", "/admin/v2/breakdown?dimension=country"],
      ["GET", "/admin/v2/status"],
      ["POST", "/admin/v2/refresh"]
    ]) responses.push(await app.inject({ method, url, headers: access.headers }));
    for (const response of responses) assert.equal(response.body.includes(ROLLUP_BASIS_MARKER), false);
    const status = responses.at(-2).json();
    const nonMarkerRows = await query(`SELECT COUNT(*)::int AS count FROM metrics_snapshot WHERE metric_key <> $1`, [ROLLUP_BASIS_MARKER]);
    assert.equal(status.row_counts.metrics_snapshot, Number(nonMarkerRows.rows[0].count));
    assert.equal(Object.hasOwn(status, "basis_ready"), false);
    assert.equal(Number((await query(`SELECT COUNT(*)::int AS count FROM metrics_snapshot WHERE metric_key = $1`, [ROLLUP_BASIS_MARKER])).rows[0].count), 1);
  } finally { await app.close(); }
});

test("15: the admin read pool rejects writes", async () => {
  await assert.rejects(adminReadQuery(`INSERT INTO metrics_snapshot (metric_key, bucket, count) VALUES ('x', 'external', 0)`), /read-only/i);
});

test("16: the admin read pool cancels a five-second statement", async () => {
  await assert.rejects(adminReadQuery(`SELECT pg_sleep(5)`), /statement timeout/i);
});

test("17: ten concurrent reads never create more than two admin read connections", async () => {
  const reads = Array.from({ length: 10 }, () => adminReadQuery(`SELECT pg_sleep(0.05)`));
  await sleep(20);
  assert.ok(getAdminReadPool().totalCount <= 2);
  await Promise.all(reads);
});

test("18: fresh read endpoints do not touch raw metric source tables", async () => {
  await rebuildRollups();
  const client = await getPool().connect();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    await client.query("BEGIN");
    await client.query(`LOCK TABLE users, device_identities, ledger_entries, attestations IN ACCESS EXCLUSIVE MODE`);
    const response = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    assert.equal(response.statusCode, 200);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await app.close();
  }
});

test("19: every metrics route rejects anonymous and viewer access and admits owner", async () => {
  await rebuildRollups();
  const app = await buildApp();
  const viewer = await seedAdmin("viewer");
  const viewerSession = await createSession(viewer);
  const access = await ownerAccess(app);
  const routes = [
    { method: "GET", url: "/admin/v2/overview?range=all" },
    { method: "GET", url: "/admin/v2/timeseries?metric=records_recorded&bucket=week&periods=1" },
    { method: "POST", url: "/admin/v2/refresh" },
    { method: "GET", url: "/admin/v2/status" }
  ];
  try {
    for (const route of routes) {
      assert.equal((await app.inject(route)).statusCode, 401);
      assert.equal((await app.inject({ ...route, headers: headers(viewerSession) })).statusCode, 403);
      assert.equal((await app.inject({ ...route, headers: access.headers })).statusCode, 200);
    }
  } finally { await app.close(); }
});

test("20: every successful response carries operator labels and freshness context", async () => {
  await rebuildRollups();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    for (const route of [
      { method: "GET", url: "/admin/v2/overview?range=all" },
      { method: "GET", url: "/admin/v2/timeseries?metric=records_recorded&bucket=week&periods=1" },
      { method: "POST", url: "/admin/v2/refresh" },
      { method: "GET", url: "/admin/v2/status" }
    ]) {
      const body = (await app.inject({ ...route, headers: access.headers })).json();
      assert.equal(body.audience, "operator_only");
      assert.equal(body.suppression, "none");
      assert.equal(body.api_version, 3);
      assert.equal(Object.hasOwn(body, "provisional"), false);
      assert.ok(Object.hasOwn(body, "as_of"));
      assert.equal(typeof body.stale, "boolean");
      assert.equal(Object.hasOwn(body, "date_basis"), false);
    }
    const overview = (await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers })).json();
    assert.deepEqual(
      Object.fromEntries(overview.metrics.map(({ key, date_basis }) => [key, date_basis])),
      Object.fromEntries(METRIC_DEFINITIONS.map(({ key, date_basis }) => [key, date_basis]))
    );
    const series = (await app.inject({ method: "GET", url: "/admin/v2/timeseries?metric=records_recorded&bucket=week&periods=1", headers: access.headers })).json();
    assert.deepEqual(series.metric, { key: "records_recorded", date_basis: "recorded" });
    const definitions = METRIC_DEFINITIONS.map(({ definition }) => definition).join(" ").toLowerCase();
    assert.match(metric(overview, "records_recorded").definition, /calendar date recorded on the device/);
    assert.match(metric(overview, "accounts_submitting_records").definition, /calendar date recorded on the device/);
    assert.equal(definitions.includes("received in"), false);
  } finally { await app.close(); }
});

test("21: invalid range, metric, bucket, and period values return 400", async () => {
  await rebuildRollups();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const urls = [
      "/admin/v2/overview?range=1d",
      "/admin/v2/timeseries?metric=nope&bucket=week&periods=1",
      "/admin/v2/timeseries?metric=accounts_phone_verified&bucket=week&periods=1",
      "/admin/v2/timeseries?metric=records_recorded&bucket=day&periods=1",
      "/admin/v2/timeseries?metric=records_recorded&bucket=week&periods=27"
    ];
    for (const url of urls) assert.equal((await app.inject({ method: "GET", url, headers: access.headers })).statusCode, 400);
  } finally { await app.close(); }
});

test("22: manual refresh writes one audit row and is limited to six per hour", async () => {
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await app.inject({ method: "POST", url: "/admin/v2/refresh", headers: access.headers })).statusCode, 200);
    }
    assert.equal((await app.inject({ method: "POST", url: "/admin/v2/refresh", headers: access.headers })).statusCode, 429);
    const audits = await query(`SELECT COUNT(*)::int AS count FROM admin_audit_log WHERE action = 'admin.metrics.refresh'`);
    assert.equal(audits.rows[0].count, 6);
  } finally { await app.close(); }
});

test("23a: metrics responses disclose no account identifiers", async () => {
  const markers = [
    "+15559876543",
    "distinctive-983746@example.test",
    "Distinctive Name 837465",
    "Distinctive Business 746583"
  ];
  await seedUser({
    phone: markers[0],
    email: markers[1],
    name: markers[2],
    businessName: markers[3],
    records: [{ syncedAt: new Date() }]
  });
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const routes = [
      ...["30d", "90d", "12m", "all"].map((range) => ({ method: "GET", url: `/admin/v2/overview?range=${range}` })),
      ...["accounts_registered", "records_recorded", "attestations_issued"].flatMap((metricKey) => ["week", "month"].map((bucket) => ({
        method: "GET",
        url: `/admin/v2/timeseries?metric=${metricKey}&bucket=${bucket}&periods=1`
      }))),
      { method: "POST", url: "/admin/v2/refresh" },
      { method: "GET", url: "/admin/v2/status" }
    ];
    for (const route of routes) {
      const body = (await app.inject({ ...route, headers: access.headers })).body;
      for (const marker of markers) {
        assert.equal(body.includes(marker), false, `${route.url} disclosed ${marker}`);
        const digits = marker.replace(/\D/g, "");
        if (digits) assert.equal(body.includes(digits), false, `${route.url} disclosed digits from ${marker}`);
      }
    }
  } finally { await app.close(); }
});

test("23b: metrics queries project only aggregate and state fields", async () => {
  await seedUser({ records: [{ syncedAt: new Date() }] });
  const readRecorder = recordPoolStatements(getAdminReadPool());
  const rebuildRecorder = recordPoolStatements(getRebuildPool());
  try {
    await rebuildRollups();
    await query(`UPDATE metrics_rollup_state SET stale = TRUE, last_attempt_at = NULL WHERE id = TRUE`);
    assert.equal((await ensureFreshRollups()).rebuilt, true);
    for (const range of ["30d", "90d", "12m", "all"]) await readOverview({ range });
    for (const metricKey of ["accounts_registered", "records_recorded", "attestations_issued"]) {
      for (const bucket of ["week", "month"]) {
        await readTimeseries({ metric: metricKey, bucket, periods: 1 });
      }
    }
    await readRollupState();
    await readStatus();

    const rebuildTexts = rebuildRecorder.statements.map(({ text }) => text.toLowerCase());
    assert.ok(rebuildTexts.some((text) => /insert\s+into\s+metrics_daily_rollup/.test(text)));
    assert.ok(rebuildTexts.some((text) => /insert\s+into\s+metrics_snapshot/.test(text)));
    assert.ok(rebuildTexts.some((text) => /update\s+metrics_rollup_state[\s\S]*set[\s\S]*built_at/.test(text)));

    const allowed = new Set([
      "acquired", "started_at", "built_at", "build_ms", "out_of_range", "claimed",
      "due", "metric_key", "bucket", "count", "provisional", "period_start", "partial",
      "stale", "invalidations", "last_attempt_at", "last_failure_at", "checked_at",
      "cache_valid_until", "daily_rollup_rows", "snapshot_rows", "event_date_upper_bound",
      // Data quality: counts of External business profiles by how their sector was set.
      "catalog", "user_selected", "reviewed_rule", "fallback", "catalog_mismatches"
    ]);
    const forbidden = new Set([
      "email", "phone_number", "name", "business_name", "payload", "signature", "public_key",
      "otp_hash", "id", "user_id", "device_identity"
    ]);
    for (const statement of [...readRecorder.statements, ...rebuildRecorder.statements]) {
      for (const field of statement.fields) {
        assert.equal(forbidden.has(field), false, `forbidden result field ${field}`);
        assert.equal(allowed.has(field), true, `unexpected result field ${field}`);
      }
    }
  } finally {
    readRecorder.restore();
    rebuildRecorder.restore();
  }
});

test("23c: metrics source never references record contents", async () => {
  const source = (await Promise.all([
    readFile(new URL("../src/admin-metrics.js", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/admin/metrics.js", import.meta.url), "utf8"),
    readFile(new URL("../src/admin-db.js", import.meta.url), "utf8")
  ])).join("\n").toLowerCase();
  for (const forbidden of ["payload", "signature", "public_key", "otp_hash", "business_name"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("slice 3c 16: profile markers never appear in admin responses or rollup rows", async () => {
  const markers = [
    "slice3c-name-marker-16391",
    "slice3c-business-marker-26482",
    "slice3c-type-marker-37593"
  ];
  await seedUser({
    classification: "EXTERNAL",
    name: markers[0],
    businessName: markers[1],
    businessType: markers[2],
    records: [{ syncedAt: new Date() }]
  });
  await rebuildRollups();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const routes = [
      ...["30d", "90d", "12m", "all"].map((range) => `/admin/v2/overview?range=${range}`),
      ...["accounts_registered", "records_recorded", "attestations_issued"].flatMap((key) => [
        `/admin/v2/timeseries?metric=${key}&bucket=week&periods=1`,
        `/admin/v2/timeseries?metric=${key}&bucket=month&periods=1`
      ]),
      "/admin/v2/status",
      "/admin/v2/suppressed/overview",
      "/admin/v2/breakdown?dimension=country",
      "/admin/v2/breakdown?dimension=sector"
    ];
    for (const url of routes) {
      const body = (await app.inject({ method: "GET", url, headers: access.headers })).body;
      for (const marker of markers) assert.equal(body.includes(marker), false, `${url} disclosed ${marker}`);
    }
    const refresh = (await app.inject({ method: "POST", url: "/admin/v2/refresh", headers: access.headers })).body;
    for (const marker of markers) assert.equal(refresh.includes(marker), false, "refresh disclosed marker");
    const rollups = await query(`
      SELECT row_to_json(rows)::text AS value
      FROM (
        SELECT metric_date::text AS first, metric_key AS second, bucket AS third, count::text AS fourth
        FROM metrics_daily_rollup
        UNION ALL
        SELECT metric_key, bucket, count::text, NULL FROM metrics_snapshot
        UNION ALL
        SELECT dimension, category, count::text, NULL FROM metrics_dimension_snapshot
      ) rows
    `);
    const stored = JSON.stringify(rollups.rows);
    for (const marker of markers) assert.equal(stored.includes(marker), false, `rollup stored ${marker}`);
  } finally { await app.close(); }
});

test("slice 3c 17: rebuild and read statements return no profile-field result columns", async () => {
  await seedUser({
    classification: "EXTERNAL",
    name: "recorder-name-marker",
    businessName: "recorder-business-marker",
    businessType: "recorder-type-marker",
    records: [{ syncedAt: new Date() }]
  });
  const readRecorder = recordPoolStatements(getAdminReadPool());
  const rebuildRecorder = recordPoolStatements(getRebuildPool());
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    await rebuildRollups();
    for (const range of ["30d", "90d", "12m", "all"]) await readOverview({ range });
    for (const key of ["accounts_registered", "records_recorded", "attestations_issued"]) {
      for (const bucket of ["week", "month"]) await readTimeseries({ metric: key, bucket, periods: 1 });
    }
    await readRollupState();
    await readStatus();
    for (const url of [
      "/admin/v2/suppressed/overview",
      "/admin/v2/breakdown?dimension=country",
      "/admin/v2/breakdown?dimension=sector"
    ]) assert.equal((await app.inject({ method: "GET", url, headers: access.headers })).statusCode, 200);

    const forbidden = new Set(["name", "business_name", "business_type_id"]);
    for (const statement of [...readRecorder.statements, ...rebuildRecorder.statements]) {
      for (const field of statement.fields) {
        assert.equal(forbidden.has(field), false, `forbidden result field ${field}`);
      }
    }
  } finally {
    readRecorder.restore();
    rebuildRecorder.restore();
    await app.close();
  }
});

test("24: metrics responses contain no identifiers or sensitive keys", async () => {
  await seedUser({ records: [{ syncedAt: new Date() }] });
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const text = (await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers })).body;
    assert.equal(/\+?\d{10,15}/.test(text), false);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(text), false);
    for (const key of ["payload", "signature", "public_key", "otp_hash"]) assert.equal(text.includes(`\"${key}\"`), false);
  } finally { await app.close(); }
});

test("25: metric keys, names, and definitions avoid disallowed activity terms", () => {
  for (const definition of METRIC_DEFINITIONS) {
    const text = `${definition.key} ${definition.name} ${definition.definition}`;
    assert.equal(/transactions?|verifications?/i.test(text), false);
  }
});

test("26: rollup tables have only the migration-defined columns", async () => {
  const result = await query(`
    SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('metrics_daily_rollup', 'metrics_snapshot', 'metrics_rollup_state')
    GROUP BY table_name
  `);
  assert.deepEqual(Object.fromEntries(result.rows.map((row) => [row.table_name, row.columns])), {
    metrics_daily_rollup: ["metric_date", "metric_key", "bucket", "count"],
    metrics_rollup_state: ["id", "built_at", "stale", "build_ms", "out_of_range", "invalidations", "last_attempt_at", "last_failure_at"],
    metrics_snapshot: ["metric_key", "bucket", "count"]
  });
});

test("27: all metrics routes send Cache-Control no-store", async () => {
  await rebuildRollups();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    for (const route of [
      { method: "GET", url: "/admin/v2/overview?range=all" },
      { method: "GET", url: "/admin/v2/timeseries?metric=records_recorded&bucket=week&periods=1" },
      { method: "POST", url: "/admin/v2/refresh" },
      { method: "GET", url: "/admin/v2/status" }
    ]) assert.equal((await app.inject({ ...route, headers: access.headers })).headers["cache-control"], "no-store");
  } finally { await app.close(); }
});

test("28: cache entries are reused only while built_at is unchanged", async () => {
  await seedUser();
  await rebuildRollups();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const first = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    await query(`UPDATE metrics_daily_rollup SET count = count + 10 WHERE metric_key = 'accounts_registered'`);
    const cached = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    assert.deepEqual(cached.json(), first.json());
    await query(`UPDATE metrics_rollup_state SET built_at = clock_timestamp() + INTERVAL '1 millisecond'`);
    const changed = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    assert.notDeepEqual(changed.json(), first.json());
  } finally { await app.close(); }
});

test("29: an invalidation committed after the rebuild snapshot supersedes the rebuild", async () => {
  const user = await seedUser({ records: [{ syncedAt: new Date() }] });
  const admin = await seedAdmin("owner");
  await rebuildRollups();
  const beforeRows = await query(`SELECT * FROM metrics_daily_rollup ORDER BY 1, 2, 3`);
  const holder = await getPool().connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`INSERT INTO account_classification (user_id, classification, reason_code, classified_by) VALUES ($1, 'EXTERNAL', 'CORRECTION', $2)`, [user.id, admin.id]);
    await holder.query(`UPDATE metrics_rollup_state SET stale = TRUE, invalidations = invalidations + 1`);
    const rebuilding = rebuildRollups();
    await sleep(100);
    await holder.query("COMMIT");
    assert.equal((await rebuilding).reason, "superseded");
    assert.equal((await readRollupState()).stale, true);
    assert.deepEqual((await query(`SELECT * FROM metrics_daily_rollup ORDER BY 1, 2, 3`)).rows, beforeRows.rows);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
});

test("30: an invalidation committed before rebuild is reflected and ends fresh", async () => {
  const user = await seedUser({ records: [{ syncedAt: new Date() }] });
  const admin = await seedAdmin("owner");
  await query(`INSERT INTO account_classification (user_id, classification, reason_code, classified_by) VALUES ($1, 'EXTERNAL', 'CORRECTION', $2)`, [user.id, admin.id]);
  await query(`UPDATE metrics_rollup_state SET stale = TRUE, invalidations = invalidations + 1`);
  await rebuildRollups();
  assert.equal(metric(await readOverview({ range: "all" }), "records_recorded").external, 1);
  assert.equal((await readRollupState()).stale, false);
});

test("31: an invalidation committed after rebuild leaves state stale", async () => {
  await rebuildRollups();
  await query(`UPDATE metrics_rollup_state SET stale = TRUE, invalidations = invalidations + 1`);
  assert.equal((await readRollupState()).stale, true);
});

test("32: invalidation increments even when state is already stale", async () => {
  await query(`UPDATE metrics_rollup_state SET stale = TRUE, invalidations = invalidations + 1`);
  await query(`UPDATE metrics_rollup_state SET stale = TRUE, invalidations = invalidations + 1`);
  assert.equal(Number((await readRollupState()).invalidations), 2);
});

test("33: every figure in a rebuild comes from one repeatable-read snapshot", async () => {
  const user = await seedUser();
  const holder = await getPool().connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ledger_entries IN ACCESS EXCLUSIVE MODE`);
    await holder.query(`INSERT INTO ledger_entries (device_identity, entry_id, entry_hash, prev_entry_hash, signature, confirmed_at, synced_at, payload) VALUES ($1, 1, $2, $3, 's', clock_timestamp(), clock_timestamp(), '{}'::jsonb)`, [user.deviceIdentity, crypto.randomBytes(32).toString("hex"), "0".repeat(64)]);
    const rebuilding = rebuildRollups();
    await sleep(100);
    await holder.query("COMMIT");
    assert.equal((await rebuilding).rebuilt, true);
    const overview = await readOverview({ range: "all" });
    assert.equal(metric(overview, "records_recorded").total, 0);
    assert.equal(metric(overview, "accounts_with_records").total, 0);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
});

test("34: no prior rollup plus a rebuild failure returns 503, while status remains available", async () => {
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    await rejectStateUpdate(async () => {
      const overview = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
      const series = await app.inject({ method: "GET", url: "/admin/v2/timeseries?metric=records_recorded&bucket=week&periods=1", headers: access.headers });
      assert.equal(overview.statusCode, 503);
      assert.equal(overview.json().error, "metrics_unavailable");
      assert.equal(series.statusCode, 503);
    });
    const status = await app.inject({ method: "GET", url: "/admin/v2/status", headers: access.headers });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().built_at, null);
  } finally { await app.close(); }
});

test("35: a failed stale rebuild serves the previous figures and records failure time", async () => {
  await seedUser();
  await rebuildRollups();
  await query(`UPDATE metrics_rollup_state SET stale = TRUE, last_attempt_at = NULL`);
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    await rejectStateUpdate(async () => {
      const response = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().stale, true);
      assert.equal(metric(response.json(), "accounts_registered").total, 1);
    });
    assert.ok((await readRollupState()).last_failure_at);
  } finally { await app.close(); }
});

test("36: a failed automatic rebuild is attempted at most once per database minute", async () => {
  const original = Date.now;
  try {
    await rejectStateUpdate(async () => {
      assert.equal((await ensureFreshRollups()).reason, "failed");
      const firstAttempt = (await readRollupState()).last_attempt_at;
      Date.now = () => original() + 600_000;
      assert.equal((await ensureFreshRollups()).reason, "fresh_or_throttled");
      assert.equal(String((await readRollupState()).last_attempt_at), String(firstAttempt));
    });
  } finally { Date.now = original; }
});

test("37: status reads persisted out-of-range count after cache clear", async () => {
  await seedUser({ records: [{ syncedAt: new Date("1999-01-01T00:00:00Z") }] });
  await rebuildRollups();
  clearMetricsCache();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const status = await app.inject({ method: "GET", url: "/admin/v2/status", headers: access.headers });
    assert.ok(status.json().out_of_range >= 1);
  } finally { await app.close(); }
});

test("38: a held rebuild does not check out a main-pool connection", async () => {
  const user = await seedUser();
  const holder = await getPool().connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ledger_entries IN ACCESS EXCLUSIVE MODE`);
    const mainPoolCount = getPool().totalCount;
    const rebuilding = rebuildRollups();
    await sleep(100);
    assert.equal(getPool().totalCount, mainPoolCount);
    assert.equal(getRebuildPool().totalCount, 1);
    await holder.query("COMMIT");
    assert.equal((await rebuilding).rebuilt, true);
    assert.ok(user.id);
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    holder.release();
  }
});

test("39: metrics source contains no unicode escape used to hide an identifier", async () => {
  const source = (await Promise.all([
    readFile(new URL("../src/admin-metrics.js", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/admin/metrics.js", import.meta.url), "utf8"),
    readFile(new URL("../src/admin-db.js", import.meta.url), "utf8")
  ])).join("\n");
  assert.equal(/\\u00/i.test(source), false);
});

test("40: a manual rebuild in flight never blocks reads or a second refresh", async () => {
  await seedUser();
  await rebuildRollups();
  await query(`UPDATE metrics_rollup_state SET stale = TRUE, last_attempt_at = NULL WHERE id = TRUE`);
  const holder = await getPool().connect();
  const app = await buildApp();
  const access = await ownerAccess(app);
  let firstRefresh;
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ledger_entries IN ACCESS EXCLUSIVE MODE`);
    firstRefresh = app.inject({ method: "POST", url: "/admin/v2/refresh", headers: access.headers });
    await sleep(100);

    const overview = await withinOneSecond(app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers }));
    const series = await withinOneSecond(app.inject({ method: "GET", url: "/admin/v2/timeseries?metric=accounts_registered&bucket=week&periods=1", headers: access.headers }));
    const secondRefresh = await withinOneSecond(app.inject({ method: "POST", url: "/admin/v2/refresh", headers: access.headers }));
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.json().stale, true);
    assert.equal(metric(overview.json(), "accounts_registered").total, 1);
    assert.equal(series.statusCode, 200);
    assert.equal(series.json().stale, true);
    assert.equal(secondRefresh.json().reason, "in_progress");
  } finally {
    await holder.query("COMMIT").catch(() => {});
    holder.release();
    if (firstRefresh) await firstRefresh;
    await app.close();
  }
});

test("41: an automatic rebuild in flight never blocks a second read", async () => {
  await seedUser();
  await rebuildRollups();
  await query(`UPDATE metrics_rollup_state SET stale = TRUE, last_attempt_at = NULL WHERE id = TRUE`);
  const holder = await getPool().connect();
  const app = await buildApp();
  const access = await ownerAccess(app);
  let firstRead;
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ledger_entries IN ACCESS EXCLUSIVE MODE`);
    firstRead = app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    await sleep(100);

    const secondRead = await withinOneSecond(app.inject({ method: "GET", url: "/admin/v2/timeseries?metric=accounts_registered&bucket=month&periods=1", headers: access.headers }));
    assert.equal(secondRead.statusCode, 200);
    assert.equal(secondRead.json().stale, true);
  } finally {
    await holder.query("COMMIT").catch(() => {});
    holder.release();
    if (firstRead) await firstRead;
    await app.close();
  }
});

test("42: no prior rollup plus a rebuild in flight returns 503 without waiting", async () => {
  await seedUser();
  const holder = await getPool().connect();
  const app = await buildApp();
  const access = await ownerAccess(app);
  let firstRefresh;
  try {
    await holder.query("BEGIN");
    await holder.query(`LOCK TABLE ledger_entries IN ACCESS EXCLUSIVE MODE`);
    firstRefresh = app.inject({ method: "POST", url: "/admin/v2/refresh", headers: access.headers });
    await sleep(100);
    const response = await withinOneSecond(app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers }));
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, "metrics_unavailable");
  } finally {
    await holder.query("COMMIT").catch(() => {});
    holder.release();
    if (firstRefresh) await firstRefresh;
    await app.close();
  }
});

test("43: a fresh read issues no statement on the rebuild pool", async () => {
  await seedUser();
  await rebuildRollups();
  const recorder = recordPoolStatements(getRebuildPool());
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const response = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    assert.equal(response.statusCode, 200);
    assert.equal(recorder.statements.length, 0);
  } finally {
    recorder.restore();
    await app.close();
  }
});

test("44: invalid metrics queries do no pool work and preserve the attempt time", async () => {
  await query(`UPDATE metrics_rollup_state SET stale = TRUE, last_attempt_at = clock_timestamp() - INTERVAL '5 minutes' WHERE id = TRUE`);
  const before = await query(`SELECT last_attempt_at FROM metrics_rollup_state WHERE id = TRUE`);
  const readRecorder = recordPoolStatements(getAdminReadPool());
  const rebuildRecorder = recordPoolStatements(getRebuildPool());
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const overview = await app.inject({ method: "GET", url: "/admin/v2/overview?range=invalid", headers: access.headers });
    const series = await app.inject({ method: "GET", url: "/admin/v2/timeseries?metric=invalid&bucket=week&periods=1", headers: access.headers });
    assert.equal(overview.statusCode, 400);
    assert.equal(series.statusCode, 400);
    assert.equal(readRecorder.statements.length, 0);
    assert.equal(rebuildRecorder.statements.length, 0);
    assert.equal(String((await query(`SELECT last_attempt_at FROM metrics_rollup_state WHERE id = TRUE`)).rows[0].last_attempt_at), String(before.rows[0].last_attempt_at));
  } finally {
    readRecorder.restore();
    rebuildRecorder.restore();
    await app.close();
  }
});

test("45: an out-of-range account is counted out of range and no response is labelled provisional", async () => {
  await seedUser({ createdAt: new Date("1999-06-01T00:00:00Z") });
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    const refresh = await app.inject({ method: "POST", url: "/admin/v2/refresh", headers: access.headers });
    const overview = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
    const series = await app.inject({ method: "GET", url: "/admin/v2/timeseries?metric=accounts_registered&bucket=week&periods=1", headers: access.headers });
    const status = await app.inject({ method: "GET", url: "/admin/v2/status", headers: access.headers });
    for (const response of [refresh, overview, series, status]) {
      assert.equal(Object.hasOwn(response.json(), "provisional"), false);
      assert.equal(response.json().api_version, 3);
    }
    assert.ok(status.json().out_of_range >= 1);
    assert.equal(overview.body.includes("accounts_all"), false);
    assert.equal(series.body.includes("accounts_all"), false);
    assert.equal(overview.body.includes("accounts_submitting_records_"), false);
  } finally { await app.close(); }
});

test("46: never-built metrics return 503 with version labels after an initial rebuild failure", async () => {
  await seedUser();
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    await rejectStateUpdate(async () => {
      const overview = await app.inject({ method: "GET", url: "/admin/v2/overview?range=all", headers: access.headers });
      const series = await app.inject({ method: "GET", url: "/admin/v2/timeseries?metric=records_recorded&bucket=week&periods=1", headers: access.headers });
      const status = await app.inject({ method: "GET", url: "/admin/v2/status", headers: access.headers });
      assert.equal(status.statusCode, 200);
      assert.equal(status.json().built_at, null);
      for (const response of [overview, series]) {
        assert.equal(response.statusCode, 503);
        assert.equal(response.json().error, "metrics_unavailable");
        assert.equal(response.json().api_version, 3);
      }
    });
  } finally { await app.close(); }
});

test("47: every retired pre-exclusion read route answers 410 client_outdated", async () => {
  const app = await buildApp();
  const access = await ownerAccess(app);
  try {
    for (const [method, url] of [
      ["GET", "/admin/metrics/overview?range=all"],
      ["GET", "/admin/metrics/timeseries?metric=records_recorded&bucket=week&periods=1"],
      ["POST", "/admin/metrics/refresh"],
      ["GET", "/admin/metrics/status"],
      ["GET", "/admin/suppressed/overview"],
      ["GET", "/admin/suppressed/breakdown?dimension=country"],
      ["GET", "/admin/classification/summary"]
    ]) {
      for (const headers of [access.headers, {}]) {
        const response = await app.inject({ method, url, headers });
        assert.equal(response.statusCode, 410, `${method} ${url}`);
        assert.deepEqual(response.json(), { error: "client_outdated", api_version: 3 });
      }
    }
  } finally { await app.close(); }
});
