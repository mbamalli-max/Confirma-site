BEGIN;

CREATE TABLE IF NOT EXISTS otp_verify_failures (
  id BIGSERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,
  channel TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_verify_failures_identifier_channel_failed_at
  ON otp_verify_failures (identifier, channel, failed_at);

COMMIT;
