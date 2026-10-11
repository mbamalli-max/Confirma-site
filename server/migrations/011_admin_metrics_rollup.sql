CREATE TABLE IF NOT EXISTS metrics_daily_rollup (
  metric_date DATE NOT NULL,
  metric_key  TEXT NOT NULL,
  bucket      TEXT NOT NULL CHECK (bucket IN ('external', 'internal_demo', 'unclassified')),
  count       INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (metric_date, metric_key, bucket)
);

CREATE TABLE IF NOT EXISTS metrics_snapshot (
  metric_key TEXT NOT NULL,
  bucket     TEXT NOT NULL CHECK (bucket IN ('external', 'internal_demo', 'unclassified')),
  count      INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (metric_key, bucket)
);

CREATE TABLE IF NOT EXISTS metrics_rollup_state (
  id              BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  built_at        TIMESTAMPTZ,
  stale           BOOLEAN NOT NULL DEFAULT TRUE,
  build_ms        INTEGER,
  out_of_range    INTEGER NOT NULL DEFAULT 0,
  invalidations   BIGINT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ
);

INSERT INTO metrics_rollup_state (id) VALUES (TRUE) ON CONFLICT DO NOTHING;
