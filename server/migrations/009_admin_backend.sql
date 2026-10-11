CREATE TABLE IF NOT EXISTS admin_users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT NOT NULL,
  password_hash      TEXT NOT NULL,
  totp_secret_enc    TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'viewer',
  status             TEXT NOT NULL DEFAULT 'ACTIVE',
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until       TIMESTAMPTZ,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email
  ON admin_users ((LOWER(email)));

CREATE TABLE IF NOT EXISTS admin_sessions (
  jti           TEXT PRIMARY KEY,
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
  ON admin_sessions (admin_user_id, issued_at DESC);

-- Append-only at the application level, trigger-enforced. A database owner or
-- superuser can still disable or remove the trigger; this is not tamper-proof.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  admin_user_id   UUID REFERENCES admin_users(id),
  action          TEXT NOT NULL,
  subject_type    TEXT,
  subject_id      TEXT,
  reason          TEXT,
  request_ip      TEXT,
  user_agent      TEXT,
  response_status INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_user
  ON admin_audit_log (admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_subject
  ON admin_audit_log (subject_id, created_at DESC);

CREATE OR REPLACE FUNCTION admin_audit_log_append_only()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only (attempted %)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_audit_log_append_only ON admin_audit_log;
CREATE TRIGGER trg_admin_audit_log_append_only
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_append_only();
