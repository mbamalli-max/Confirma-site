import { adminReadQuery, rebuildQuery, withRebuildTransaction } from "./admin-db.js";

export const METRICS_REBUILD_LOCK_KEY = 7300311;

const PERIOD_METRICS = Object.freeze([
  {
    key: "accounts_registered",
    name: "Accounts registered",
    definition: "Accounts created in the period."
  },
  {
    key: "records_received",
    name: "Records received",
    definition: "Records received and stored by the server in the period, by the time the server received them. Device-reported record times are not used."
  },
  {
    key: "attestations_issued",
    name: "Attestations issued",
    definition: "Attestations issued by the server in the period. Lookups of an attestation by a third party are not recorded and are not counted."
  }
]);

const POINT_METRICS = Object.freeze([
  {
    key: "accounts_phone_verified",
    name: "Accounts with a verified phone number",
    definition: "Accounts whose phone number has been verified. A point-in-time figure."
  },
  {
    key: "accounts_email_verified",
    name: "Accounts with a verified email address",
    definition: "Accounts whose email address has been verified. A point-in-time figure."
  },
  {
    key: "devices_active",
    name: "Active devices",
    definition: "Devices currently in ACTIVE status. A point-in-time figure, not a period count."
  },
  {
    key: "accounts_with_records",
    name: "Accounts with at least one record",
    definition: "Accounts with one or more records received, all time."
  },
  {
    key: "accounts_with_3plus_records",
    name: "Accounts with three or more records",
    definition: "Accounts with three or more records received, all time. This is not the activation metric: the export step of activation is not observable by the server."
  }
]);

export const METRIC_DEFINITIONS = Object.freeze([...PERIOD_METRICS, ...POINT_METRICS]);
export const PERIOD_METRIC_KEYS = Object.freeze(PERIOD_METRICS.map(({ key }) => key));
export const OVERVIEW_RANGES = Object.freeze(["30d", "90d", "12m", "all"]);

const EMPTY_COUNTS = Object.freeze({
  external: 0,
  internal_demo: 0,
  unclassified: 0,
  total: 0
});

class RebuildInProgress extends Error {}
let rebuildInProgress = false;

function countsFromRows(rows) {
  const counts = { ...EMPTY_COUNTS };
  for (const row of rows) {
    if (Object.hasOwn(counts, row.bucket)) counts[row.bucket] = Number(row.count || 0);
  }
  counts.total = counts.external + counts.internal_demo + counts.unclassified;
  return counts;
}

function groupRows(rows, keyFor) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

async function recordFailure() {
  await rebuildQuery(
    `UPDATE metrics_rollup_state SET last_failure_at = clock_timestamp() WHERE id = TRUE`
  );
}

async function performRebuild({ automatic }) {
  try {
    return await withRebuildTransaction(async (client) => {
      const lock = await client.query(
        `SELECT pg_try_advisory_xact_lock($1) AS acquired`,
        [METRICS_REBUILD_LOCK_KEY]
      );
      if (!lock.rows[0]?.acquired) throw new RebuildInProgress("Metrics rebuild already running.");

      const started = await client.query(`SELECT clock_timestamp() AS started_at`);
      const startedAt = started.rows[0].started_at;

      await client.query(`DELETE FROM metrics_daily_rollup`);
      await client.query(`
        INSERT INTO metrics_daily_rollup (metric_date, metric_key, bucket, count)
        WITH metric_rows AS (
          SELECT
            (account.created_at AT TIME ZONE 'UTC')::date AS metric_date,
            'accounts_registered'::text AS metric_key,
            account.id AS user_id
          FROM users account

          UNION ALL

          SELECT
            (entry.synced_at AT TIME ZONE 'UTC')::date AS metric_date,
            'records_received'::text AS metric_key,
            account.id AS user_id
          FROM ledger_entries entry
          INNER JOIN device_identities device
            ON device.device_identity = entry.device_identity
          INNER JOIN users account
            ON account.phone_number = device.phone_number

          UNION ALL

          SELECT
            (attestation.issued_at AT TIME ZONE 'UTC')::date AS metric_date,
            'attestations_issued'::text AS metric_key,
            account.id AS user_id
          FROM attestations attestation
          INNER JOIN users account
            ON account.phone_number = attestation.phone_number
          WHERE attestation.status = 'VALID'
        ), classified AS (
          SELECT
            metric.metric_date,
            metric.metric_key,
            CASE
              WHEN classification.classification = 'EXTERNAL' THEN 'external'
              WHEN classification.classification IN ('INTERNAL_TEST', 'DEMO') THEN 'internal_demo'
              ELSE 'unclassified'
            END AS bucket
          FROM metric_rows metric
          LEFT JOIN account_classification classification
            ON classification.user_id = metric.user_id
          WHERE metric.metric_date >= DATE '2000-01-01'
            AND metric.metric_date <= (clock_timestamp() AT TIME ZONE 'UTC')::date + 1
        )
        SELECT metric_date, metric_key, bucket, COUNT(*)::int
        FROM classified
        GROUP BY metric_date, metric_key, bucket
      `);

      await client.query(`DELETE FROM metrics_snapshot`);
      await client.query(`
        INSERT INTO metrics_snapshot (metric_key, bucket, count)
        WITH account_record_counts AS (
          SELECT account.id AS user_id, COUNT(entry.entry_id)::int AS record_count
          FROM users account
          LEFT JOIN device_identities device
            ON device.phone_number = account.phone_number
          LEFT JOIN ledger_entries entry
            ON entry.device_identity = device.device_identity
          GROUP BY account.id
        ), snapshot_rows AS (
          SELECT 'accounts_phone_verified'::text AS metric_key, account.id AS user_id
          FROM users account
          WHERE account.phone_verified

          UNION ALL

          SELECT 'accounts_email_verified'::text AS metric_key, account.id AS user_id
          FROM users account
          WHERE account.email_verified

          UNION ALL

          SELECT 'devices_active'::text AS metric_key, account.id AS user_id
          FROM device_identities device
          INNER JOIN users account ON account.phone_number = device.phone_number
          WHERE device.status = 'ACTIVE'

          UNION ALL

          SELECT 'accounts_with_records'::text AS metric_key, records.user_id
          FROM account_record_counts records
          WHERE records.record_count >= 1

          UNION ALL

          SELECT 'accounts_with_3plus_records'::text AS metric_key, records.user_id
          FROM account_record_counts records
          WHERE records.record_count >= 3

          UNION ALL

          SELECT 'accounts_all'::text AS metric_key, account.id AS user_id
          FROM users account
        ), classified AS (
          SELECT
            snapshot.metric_key,
            CASE
              WHEN classification.classification = 'EXTERNAL' THEN 'external'
              WHEN classification.classification IN ('INTERNAL_TEST', 'DEMO') THEN 'internal_demo'
              ELSE 'unclassified'
            END AS bucket
          FROM snapshot_rows snapshot
          LEFT JOIN account_classification classification
            ON classification.user_id = snapshot.user_id
        )
        SELECT metric_key, bucket, COUNT(*)::int
        FROM classified
        GROUP BY metric_key, bucket
      `);

      const state = await client.query(
        `
          UPDATE metrics_rollup_state
          SET
            built_at = clock_timestamp(),
            stale = FALSE,
            build_ms = GREATEST(
              0,
              FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - $1::timestamptz)) * 1000)::int
            ),
            out_of_range = (
              SELECT COUNT(*)::int
              FROM (
                SELECT (account.created_at AT TIME ZONE 'UTC')::date AS metric_date
                FROM users account
                UNION ALL
                SELECT (entry.synced_at AT TIME ZONE 'UTC')::date
                FROM ledger_entries entry
                UNION ALL
                SELECT (attestation.issued_at AT TIME ZONE 'UTC')::date
                FROM attestations attestation
                WHERE attestation.status = 'VALID'
              ) dated
              WHERE dated.metric_date < DATE '2000-01-01'
                 OR dated.metric_date > (clock_timestamp() AT TIME ZONE 'UTC')::date + 1
            )
          WHERE id = TRUE
          RETURNING built_at, build_ms, out_of_range
        `,
        [startedAt]
      );
      return { rebuilt: true, automatic, ...state.rows[0] };
    });
  } catch (error) {
    if (error instanceof RebuildInProgress) {
      return { rebuilt: false, reason: "in_progress" };
    }
    try {
      await recordFailure();
    } catch {
      // Preserve the bounded, non-sensitive rebuild result even if failure recording also fails.
    }
    if (error?.code === "40001") return { rebuilt: false, reason: "superseded" };
    return { rebuilt: false, reason: "failed" };
  }
}

export async function rebuildRollups({ automatic = false } = {}) {
  if (rebuildInProgress) return { rebuilt: false, reason: "in_progress" };
  rebuildInProgress = true;
  try {
    return await performRebuild({ automatic });
  } finally {
    rebuildInProgress = false;
  }
}

export async function ensureFreshRollups() {
  if (rebuildInProgress) return { rebuilt: false, reason: "in_progress" };
  const due = await adminReadQuery(`
    SELECT (
      (stale OR built_at IS NULL OR built_at < clock_timestamp() - INTERVAL '15 minutes')
      AND (last_attempt_at IS NULL OR last_attempt_at < clock_timestamp() - INTERVAL '60 seconds')
    ) AS due
    FROM metrics_rollup_state
    WHERE id = TRUE
  `);
  if (!due.rows[0]?.due) return { rebuilt: false, reason: "fresh_or_throttled" };
  if (rebuildInProgress) return { rebuilt: false, reason: "in_progress" };

  rebuildInProgress = true;
  try {
    const claimed = await rebuildQuery(`
      UPDATE metrics_rollup_state
      SET last_attempt_at = clock_timestamp()
      WHERE id = TRUE
        AND (stale OR built_at IS NULL OR built_at < clock_timestamp() - INTERVAL '15 minutes')
        AND (last_attempt_at IS NULL OR last_attempt_at < clock_timestamp() - INTERVAL '60 seconds')
      RETURNING TRUE AS claimed
    `);
    if (!claimed.rowCount) return { rebuilt: false, reason: "fresh_or_throttled" };
    return await performRebuild({ automatic: true });
  } finally {
    rebuildInProgress = false;
  }
}

export async function readRollupState() {
  const result = await adminReadQuery(`
    SELECT
      built_at,
      (stale OR built_at IS NULL OR built_at < clock_timestamp() - INTERVAL '15 minutes') AS stale,
      build_ms,
      out_of_range,
      invalidations,
      last_attempt_at,
      last_failure_at,
      clock_timestamp() AS checked_at,
      clock_timestamp() + INTERVAL '60 seconds' AS cache_valid_until
    FROM metrics_rollup_state
    WHERE id = TRUE
  `);
  return result.rows[0];
}

export async function readProvisional() {
  const result = await adminReadQuery(`
    SELECT COALESCE(SUM(count), 0)::int > 0 AS provisional
    FROM metrics_snapshot
    WHERE metric_key = 'accounts_all' AND bucket = 'unclassified'
  `);
  return result.rows[0]?.provisional === true;
}

export async function readOverview({ range }) {
  if (!OVERVIEW_RANGES.includes(range)) throw new Error("Invalid overview range.");
  const starts = {
    "30d": `(clock_timestamp() AT TIME ZONE 'UTC')::date - 29`,
    "90d": `(clock_timestamp() AT TIME ZONE 'UTC')::date - 89`,
    "12m": `(date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '11 months')::date`,
    all: `DATE '2000-01-01'`
  };
  const [daily, snapshot, provisional] = await Promise.all([
    adminReadQuery(`
      SELECT metric_key, bucket, SUM(count)::int AS count
      FROM metrics_daily_rollup
      WHERE metric_date >= ${starts[range]}
      GROUP BY metric_key, bucket
    `),
    adminReadQuery(`SELECT metric_key, bucket, count FROM metrics_snapshot`),
    readProvisional()
  ]);
  const dailyByMetric = groupRows(daily.rows, (row) => row.metric_key);
  const snapshotByMetric = groupRows(snapshot.rows, (row) => row.metric_key);
  const metrics = METRIC_DEFINITIONS.map((definition) => {
    const pointInTime = POINT_METRICS.some(({ key }) => key === definition.key);
    return {
      ...definition,
      point_in_time: pointInTime,
      range_ignored: pointInTime,
      ...countsFromRows((pointInTime ? snapshotByMetric : dailyByMetric).get(definition.key) || [])
    };
  });
  return { range, metrics, provisional };
}

export async function readTimeseries({ metric, bucket, periods }) {
  if (!PERIOD_METRIC_KEYS.includes(metric)) throw new Error("Invalid time-series metric.");
  if (!new Set(["week", "month"]).has(bucket)) throw new Error("Invalid time-series bucket.");
  const amount = Number(periods);
  const max = bucket === "week" ? 26 : 24;
  if (!Number.isInteger(amount) || amount < 1 || amount > max) {
    throw new Error("Invalid time-series period count.");
  }
  const result = await adminReadQuery(
    `
      WITH bounds AS (
        SELECT date_trunc($2, clock_timestamp() AT TIME ZONE 'UTC')::date AS current_start
      ), period_starts AS (
        SELECT generate_series(
          bounds.current_start - (($3::int - 1) * ('1 ' || $2)::interval),
          bounds.current_start,
          ('1 ' || $2)::interval
        )::date AS period_start,
        bounds.current_start
        FROM bounds
      ), totals AS (
        SELECT
          date_trunc($2, metric_date::timestamp)::date AS period_start,
          bucket,
          SUM(count)::int AS count
        FROM metrics_daily_rollup
        WHERE metric_key = $1
        GROUP BY date_trunc($2, metric_date::timestamp)::date, bucket
      )
      SELECT
        periods.period_start,
        (periods.period_start = periods.current_start) AS partial,
        bucket.bucket,
        COALESCE(totals.count, 0)::int AS count
      FROM period_starts periods
      CROSS JOIN (VALUES ('external'), ('internal_demo'), ('unclassified')) AS bucket(bucket)
      LEFT JOIN totals
        ON totals.period_start = periods.period_start AND totals.bucket = bucket.bucket
      ORDER BY periods.period_start, bucket.bucket
    `,
    [metric, bucket, amount]
  );
  const grouped = groupRows(result.rows, (row) => String(row.period_start));
  const outputPeriods = [...grouped.values()].map((rows) => ({
    period_start: new Date(rows[0].period_start).toISOString().slice(0, 10),
    partial: rows[0].partial,
    ...countsFromRows(rows)
  }));
  return {
    metric,
    bucket,
    periods: outputPeriods,
    provisional: await readProvisional()
  };
}

export async function readStatus() {
  const [state, rows, provisional] = await Promise.all([
    readRollupState(),
    adminReadQuery(`
      SELECT
        (SELECT COUNT(*)::int FROM metrics_daily_rollup) AS daily_rollup_rows,
        (SELECT COUNT(*)::int FROM metrics_snapshot) AS snapshot_rows
    `),
    readProvisional()
  ]);
  return { ...state, ...rows.rows[0], provisional };
}
