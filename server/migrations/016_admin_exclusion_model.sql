-- Exclusion-based External model (decisions E1–E3, 2026-10-28).
-- External = every app account except those the owner has excluded as internal test, demo or
-- the administrator's own app account. Forward only; earlier migrations are unchanged.
--
-- Safe to run again: each step runs only while any pre-016 rule is still present, so a rerun
-- after the figures have been rebuilt changes nothing and keeps the rebuilt figures, while a
-- database holding a mix of old and new rules is still repaired.

DO $$
DECLARE
  c record;
  reason_current boolean;
  buckets_current boolean;
  dimension_current boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'account_classification'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%reason_code%'
      AND pg_get_constraintdef(oid) LIKE '%OPERATOR_ADMIN_ACCOUNT%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'account_classification'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%reason_code%'
      AND pg_get_constraintdef(oid) NOT LIKE '%OPERATOR_ADMIN_ACCOUNT%'
  ) INTO reason_current;

  SELECT (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid IN ('metrics_daily_rollup'::regclass, 'metrics_snapshot'::regclass) AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%bucket%'
      AND pg_get_constraintdef(oid) LIKE '%''excluded''%'
      AND pg_get_constraintdef(oid) NOT LIKE '%unclassified%'
  ) = 2
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid IN ('metrics_daily_rollup'::regclass, 'metrics_snapshot'::regclass) AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%bucket%'
      AND pg_get_constraintdef(oid) NOT LIKE '%''excluded''%'
  ) INTO buckets_current;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'metrics_dimension_snapshot'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%dimension%'
      AND pg_get_constraintdef(oid) LIKE '%business_type%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'metrics_dimension_snapshot'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%dimension%'
      AND pg_get_constraintdef(oid) NOT LIKE '%business_type%'
  ) INTO dimension_current;

  -- 1. New reason code for the administrator's own app accounts (class INTERNAL_TEST).
  --    Existing CHECK names are read from pg_constraint, not assumed.
  IF NOT reason_current THEN
    FOR c IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'account_classification'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%reason_code%'
    LOOP
      EXECUTE format('ALTER TABLE account_classification DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE account_classification ADD CONSTRAINT account_classification_reason_code_check
      CHECK (reason_code IN ('OPERATOR_TEST_ACCOUNT', 'OPERATOR_DEMO_ACCOUNT', 'OPERATOR_ADMIN_ACCOUNT',
                             'OWNER_CLASSIFIED_EXTERNAL', 'CORRECTION'));
  END IF;

  IF NOT (buckets_current AND dimension_current) THEN
    -- 2. Rollups are derived data built under the old three-bucket rule. Remove them and mark
    --    the state unbuilt, so nothing built under the old rule is ever read under the new one.
    --    The first read after deploy rebuilds; until then the API answers 503 metrics_unavailable.
    DELETE FROM metrics_daily_rollup;
    DELETE FROM metrics_snapshot;
    DELETE FROM metrics_dimension_snapshot;
    UPDATE metrics_rollup_state
    SET built_at = NULL, stale = TRUE, build_ms = NULL, out_of_range = 0, invalidations = invalidations + 1
    WHERE id = TRUE;

    -- 3. Two buckets (external, excluded) and a business_type dimension.
    FOR c IN
      SELECT conrelid::regclass::text AS tbl, conname FROM pg_constraint
      WHERE contype = 'c'
        AND (
          (conrelid IN ('metrics_daily_rollup'::regclass, 'metrics_snapshot'::regclass)
            AND pg_get_constraintdef(oid) LIKE '%bucket%')
          OR (conrelid = 'metrics_dimension_snapshot'::regclass
            AND pg_get_constraintdef(oid) LIKE '%dimension%')
        )
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
    END LOOP;
    ALTER TABLE metrics_daily_rollup ADD CONSTRAINT metrics_daily_rollup_bucket_check
      CHECK (bucket IN ('external', 'excluded'));
    ALTER TABLE metrics_snapshot ADD CONSTRAINT metrics_snapshot_bucket_check
      CHECK (bucket IN ('external', 'excluded'));
    ALTER TABLE metrics_dimension_snapshot ADD CONSTRAINT metrics_dimension_snapshot_dimension_check
      CHECK (dimension IN ('country', 'sector', 'business_type'));
  END IF;
END $$;
