CREATE TABLE IF NOT EXISTS metrics_dimension_snapshot (
  dimension TEXT NOT NULL CHECK (dimension IN ('country', 'sector')),
  category  TEXT NOT NULL,
  count     INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (dimension, category)
);
