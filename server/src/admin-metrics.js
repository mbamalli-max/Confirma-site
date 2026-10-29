import { adminReadQuery, rebuildQuery, withRebuildTransaction } from "./admin-db.js";
import {
  BUSINESS_TYPE_IDS,
  CATALOG_TYPE_IDS,
  CATALOG_TYPE_SECTORS,
  COUNTRY_CODES,
  NO_BUSINESS_PROFILE,
  NO_VALID_CODE,
  SECTOR_IDS
} from "./admin-dimensions.js";
import { OTHER_SECTOR_ID } from "./business-catalog.js";

// Same test as hasBusinessProfile() in sector-assignment.js: a business type, sector or description.
const BUSINESS_PROFILE_SQL = `(
  NULLIF(BTRIM(COALESCE(profile.business_type_id, '')), '') IS NOT NULL
  OR NULLIF(BTRIM(COALESCE(profile.sector_id, '')), '') IS NOT NULL
  OR NULLIF(BTRIM(COALESCE(profile.business_description, '')), '') IS NOT NULL
)`;

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
    name: "Devices in ACTIVE registration status",
    definition: "Devices whose registration is currently in ACTIVE status. A point-in-time figure. Not a count of people or of recent use."
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
  },
  {
    key: "accounts_setup_fields_stored",
    name: "Accounts with required setup fields stored",
    definition: "Accounts whose stored profile holds a display name and a business type, the two fields the app requires before its setup can be finished. A proxy for completed onboarding, not a count of it: the server does not record a completion event, and these fields can reach the server without one. Accounts whose profile has not reached the server are not counted. A point-in-time figure with no date. This is not the activation metric."
  },
  {
    key: "accounts_setup_fields_with_records",
    name: "Accounts with required setup fields stored and at least one record",
    definition: "Accounts counted as having the required setup fields stored that also have one or more records received, all time. A point-in-time figure."
  }
]);

// Distinct accounts in a period cannot be summed from daily counts, so this one is computed
// for each overview range when the figures are built (decision D4, M3).
const SUBMITTER_METRIC = Object.freeze({
  key: "accounts_submitting_records",
  name: "Accounts submitting records",
  definition: "Accounts with one or more records received by the server in the period, each counted once, by the time the server received the records. The period is measured up to the time the figures were built."
});

export const METRIC_DEFINITIONS = Object.freeze([...PERIOD_METRICS, SUBMITTER_METRIC, ...POINT_METRICS]);
export const PERIOD_METRIC_KEYS = Object.freeze(PERIOD_METRICS.map(({ key }) => key));
export const OVERVIEW_RANGES = Object.freeze(["30d", "90d", "12m", "all"]);

// Exclusion model (decision E1): every account is External unless the owner has excluded it.
export const BUCKETS = Object.freeze(["external", "excluded"]);
const EMPTY_COUNTS = Object.freeze({
  external: 0,
  excluded: 0,
  total: 0
});

class RebuildInProgress extends Error {}
let rebuildInProgress = false;

function eligibleEventDateSql(expression, parameter) {
  return `${expression} >= DATE '2000-01-01' AND ${expression} <= ${parameter}::date`;
}

function countsFromRows(rows) {
  const counts = { ...EMPTY_COUNTS };
  for (const row of rows) {
    if (Object.hasOwn(counts, row.bucket)) counts[row.bucket] = Number(row.count || 0);
  }
  counts.total = counts.external + counts.excluded;
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

      const started = await client.query(`
        SELECT captured_at AS started_at,
               (captured_at AT TIME ZONE 'UTC')::date + 1 AS event_date_upper_bound
        FROM (SELECT clock_timestamp() AS captured_at) captured
      `);
      const startedAt = started.rows[0].started_at;
      const eventDateUpperBound = started.rows[0].event_date_upper_bound;

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
              WHEN classification.classification IN ('INTERNAL_TEST', 'DEMO') THEN 'excluded'
              ELSE 'external'
            END AS bucket
          FROM metric_rows metric
          LEFT JOIN account_classification classification
            ON classification.user_id = metric.user_id
          WHERE ${eligibleEventDateSql("metric.metric_date", "$1")}
        )
        SELECT metric_date, metric_key, bucket, COUNT(*)::int
        FROM classified
        GROUP BY metric_date, metric_key, bucket
      `, [eventDateUpperBound]);

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
        ), account_setup_fields AS (
          SELECT DISTINCT profile.user_id
          FROM profiles profile
          WHERE BTRIM(COALESCE(profile.name, '')) <> ''
            AND BTRIM(COALESCE(profile.business_type_id, '')) <> ''
        ), eligible_event_rows AS (
          SELECT
            'contributors_records_received'::text AS metric_key,
            account.id AS user_id,
            (entry.synced_at AT TIME ZONE 'UTC')::date AS event_date
          FROM ledger_entries entry
          INNER JOIN device_identities device
            ON device.device_identity = entry.device_identity
          INNER JOIN users account
            ON account.phone_number = device.phone_number

          UNION ALL

          SELECT
            'contributors_attestations_issued'::text AS metric_key,
            account.id AS user_id,
            (attestation.issued_at AT TIME ZONE 'UTC')::date AS event_date
          FROM attestations attestation
          INNER JOIN users account
            ON account.phone_number = attestation.phone_number
          WHERE attestation.status = 'VALID'
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

          SELECT 'accounts_setup_fields_stored'::text AS metric_key, setup.user_id
          FROM account_setup_fields setup

          UNION ALL

          SELECT 'accounts_setup_fields_with_records'::text AS metric_key, setup.user_id
          FROM account_setup_fields setup
          INNER JOIN account_record_counts records ON records.user_id = setup.user_id
          WHERE records.record_count >= 1

          UNION ALL

          SELECT 'accounts_all'::text AS metric_key, account.id AS user_id
          FROM users account

          UNION ALL

          SELECT DISTINCT event.metric_key, event.user_id
          FROM eligible_event_rows event
          WHERE ${eligibleEventDateSql("event.event_date", "$1")}

          UNION ALL

          SELECT DISTINCT 'contributors_devices_active'::text AS metric_key, account.id AS user_id
          FROM device_identities device
          INNER JOIN users account ON account.phone_number = device.phone_number
          WHERE device.status = 'ACTIVE'

          UNION ALL

          -- M3: distinct accounts with records received in each overview range, measured up
          -- to the build time ($2). Range starts match readOverview's.
          SELECT DISTINCT 'accounts_submitting_records_' || ranges.range_key AS metric_key, event.user_id
          FROM eligible_event_rows event
          CROSS JOIN (VALUES
            ('30d', ($2::timestamptz AT TIME ZONE 'UTC')::date - 29),
            ('90d', ($2::timestamptz AT TIME ZONE 'UTC')::date - 89),
            ('12m', (date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC') - INTERVAL '11 months')::date),
            ('all', DATE '2000-01-01')
          ) AS ranges(range_key, start_date)
          WHERE event.metric_key = 'contributors_records_received'
            AND ${eligibleEventDateSql("event.event_date", "$1")}
            AND event.event_date >= ranges.start_date
        ), classified AS (
          SELECT
            snapshot.metric_key,
            CASE
              WHEN classification.classification IN ('INTERNAL_TEST', 'DEMO') THEN 'excluded'
              ELSE 'external'
            END AS bucket
          FROM snapshot_rows snapshot
          LEFT JOIN account_classification classification
            ON classification.user_id = snapshot.user_id
        )
        SELECT metric_key, bucket, COUNT(*)::int
        FROM classified
        GROUP BY metric_key, bucket
      `, [eventDateUpperBound, startedAt]);

      await client.query(`DELETE FROM metrics_dimension_snapshot`);
      await client.query(`
        INSERT INTO metrics_dimension_snapshot (dimension, category, count)
        WITH external_accounts AS (
          -- Every account the owner has not excluded (decision E1).
          SELECT account.id AS user_id
          FROM users account
          LEFT JOIN account_classification classification
            ON classification.user_id = account.id
          WHERE classification.classification IS NULL
             OR classification.classification NOT IN ('INTERNAL_TEST', 'DEMO')
        ), dimension_rows AS (
          SELECT
            'country'::text AS dimension,
            CASE
              WHEN BTRIM(profile.operating_region::text) = ANY($1::text[])
                THEN BTRIM(profile.operating_region::text)
              ELSE $3::text
            END AS category
          FROM external_accounts account
          LEFT JOIN profiles profile ON profile.user_id = account.user_id

          UNION ALL

          -- Same rule as effectiveSector() in sector-assignment.js: a listed type counts under its
          -- catalog sector; otherwise a sector chosen by the person or a reviewed rule (or a legacy
          -- sector with no provenance); anything else counts as Other business (fallback); no
          -- business profile is its own category.
          SELECT
            'sector'::text AS dimension,
            CASE
              WHEN profile.user_id IS NULL OR NOT ${BUSINESS_PROFILE_SQL} THEN $7::text
              WHEN catalog.sector_id IS NOT NULL THEN catalog.sector_id
              WHEN profile.sector_id = ANY($2::text[])
                AND (profile.sector_source IS NULL OR profile.sector_source IN ('user', 'rule')) THEN profile.sector_id
              ELSE $8::text
            END AS category
          FROM external_accounts account
          LEFT JOIN profiles profile ON profile.user_id = account.user_id
          LEFT JOIN unnest($5::text[], $6::text[]) AS catalog(business_type_id, sector_id)
            ON catalog.business_type_id = BTRIM(profile.business_type_id)

          UNION ALL

          -- Catalog business type IDs and "unlisted" only; free-text descriptions are not read.
          SELECT
            'business_type'::text AS dimension,
            CASE
              WHEN profile.user_id IS NULL OR NOT ${BUSINESS_PROFILE_SQL} THEN $7::text
              WHEN profile.business_type_id = ANY($4::text[]) THEN profile.business_type_id
              ELSE $3::text
            END AS category
          FROM external_accounts account
          LEFT JOIN profiles profile ON profile.user_id = account.user_id
        )
        SELECT dimension, category, COUNT(*)::int
        FROM dimension_rows
        GROUP BY dimension, category
      `, [
        COUNTRY_CODES,
        SECTOR_IDS,
        NO_VALID_CODE,
        BUSINESS_TYPE_IDS,
        CATALOG_TYPE_IDS,
        CATALOG_TYPE_SECTORS,
        NO_BUSINESS_PROFILE,
        OTHER_SECTOR_ID
      ]);

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
              WHERE NOT (${eligibleEventDateSql("dated.metric_date", "$2")})
            )
          WHERE id = TRUE
          RETURNING built_at, build_ms, out_of_range
        `,
        [startedAt, eventDateUpperBound]
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

export async function readSuppressedOverview() {
  const [daily, snapshot] = await Promise.all([
    adminReadQuery(`
      SELECT metric_key, COALESCE(SUM(count), 0)::int AS count
      FROM metrics_daily_rollup
      WHERE bucket = 'external'
      GROUP BY metric_key
    `),
    adminReadQuery(`
      SELECT metric_key, count
      FROM metrics_snapshot
      WHERE bucket = 'external'
    `)
  ]);
  return {
    daily: Object.fromEntries(daily.rows.map((row) => [row.metric_key, Number(row.count)])),
    snapshot: Object.fromEntries(snapshot.rows.map((row) => [row.metric_key, Number(row.count)]))
  };
}

export async function readDimensionSnapshot(dimension) {
  const allowedByDimension = { country: COUNTRY_CODES, sector: SECTOR_IDS, business_type: BUSINESS_TYPE_IDS };
  if (!Object.hasOwn(allowedByDimension, dimension)) {
    throw new Error("Invalid dimension.");
  }
  const allowed = allowedByDimension[dimension];
  const result = await adminReadQuery(
    `
      SELECT category, count
      FROM metrics_dimension_snapshot
      WHERE dimension = $1
        AND (category = ANY($2::text[]) OR category = $3 OR category = $4)
      ORDER BY category
    `,
    [dimension, allowed, NO_VALID_CODE, NO_BUSINESS_PROFILE]
  );
  return result.rows.map(({ category, count }) => ({ category, count: Number(count) }));
}

export async function readOverview({ range }) {
  if (!OVERVIEW_RANGES.includes(range)) throw new Error("Invalid overview range.");
  const starts = {
    "30d": `(clock_timestamp() AT TIME ZONE 'UTC')::date - 29`,
    "90d": `(clock_timestamp() AT TIME ZONE 'UTC')::date - 89`,
    "12m": `(date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '11 months')::date`,
    all: `DATE '2000-01-01'`
  };
  const [daily, snapshot] = await Promise.all([
    adminReadQuery(`
      SELECT metric_key, bucket, SUM(count)::int AS count
      FROM metrics_daily_rollup
      WHERE metric_date >= ${starts[range]}
      GROUP BY metric_key, bucket
    `),
    adminReadQuery(`SELECT metric_key, bucket, count FROM metrics_snapshot`)
  ]);
  const dailyByMetric = groupRows(daily.rows, (row) => row.metric_key);
  const snapshotByMetric = groupRows(snapshot.rows, (row) => row.metric_key);
  const metrics = METRIC_DEFINITIONS.map((definition) => {
    const pointInTime = POINT_METRICS.some(({ key }) => key === definition.key);
    const rows = definition.key === SUBMITTER_METRIC.key
      ? snapshotByMetric.get(`${SUBMITTER_METRIC.key}_${range}`)
      : (pointInTime ? snapshotByMetric : dailyByMetric).get(definition.key);
    return {
      ...definition,
      point_in_time: pointInTime,
      range_ignored: pointInTime,
      ...countsFromRows(rows || [])
    };
  });
  return { range, metrics };
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
      CROSS JOIN (VALUES ('external'), ('excluded')) AS bucket(bucket)
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
    periods: outputPeriods
  };
}

// Owner-only Data quality: how External business profiles got their sector (counts only), and how
// many listed profiles store a sector that disagrees with the catalog (expected 0). Read live.
export async function readSectorAssignment() {
  const result = await adminReadQuery(`
    WITH external_profiles AS (
      SELECT profile.*
      FROM users account
      LEFT JOIN account_classification classification ON classification.user_id = account.id
      INNER JOIN profiles profile ON profile.user_id = account.id
      WHERE (classification.classification IS NULL
             OR classification.classification NOT IN ('INTERNAL_TEST', 'DEMO'))
        AND ${BUSINESS_PROFILE_SQL}
    )
    SELECT
      COUNT(*) FILTER (WHERE catalog.sector_id IS NOT NULL)::int AS catalog,
      COUNT(*) FILTER (WHERE catalog.sector_id IS NULL AND profile.sector_id = ANY($3::text[])
        AND (profile.sector_source = 'user' OR profile.sector_source IS NULL))::int AS user_selected,
      COUNT(*) FILTER (WHERE catalog.sector_id IS NULL AND profile.sector_id = ANY($3::text[])
        AND profile.sector_source = 'rule')::int AS reviewed_rule,
      COUNT(*) FILTER (WHERE catalog.sector_id IS NULL AND NOT COALESCE(
        profile.sector_id = ANY($3::text[])
        AND (profile.sector_source IS NULL OR profile.sector_source IN ('user', 'rule')),
        FALSE
      ))::int AS fallback,
      (
        SELECT COUNT(*)::int
        FROM profiles listed
        INNER JOIN unnest($1::text[], $2::text[]) AS map(business_type_id, sector_id)
          ON map.business_type_id = BTRIM(listed.business_type_id)
        WHERE listed.sector_id IS DISTINCT FROM map.sector_id
           OR listed.sector_source IS DISTINCT FROM 'catalog'
      ) AS catalog_mismatches
    FROM external_profiles profile
    LEFT JOIN unnest($1::text[], $2::text[]) AS catalog(business_type_id, sector_id)
      ON catalog.business_type_id = BTRIM(profile.business_type_id)
  `, [CATALOG_TYPE_IDS, CATALOG_TYPE_SECTORS, SECTOR_IDS]);
  return result.rows[0];
}

export async function readStatus() {
  const [state, rows, sectors] = await Promise.all([
    readRollupState(),
    adminReadQuery(`
      SELECT
        (SELECT COUNT(*)::int FROM metrics_daily_rollup) AS daily_rollup_rows,
        (SELECT COUNT(*)::int FROM metrics_snapshot) AS snapshot_rows
    `),
    readSectorAssignment()
  ]);
  return { ...state, ...rows.rows[0], sector_assignment: sectors };
}
