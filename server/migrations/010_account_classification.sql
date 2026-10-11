CREATE TABLE IF NOT EXISTS account_classification (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  classification TEXT NOT NULL
                 CHECK (classification IN ('EXTERNAL', 'INTERNAL_TEST', 'DEMO')),
  reason_code    TEXT NOT NULL
                 CHECK (reason_code IN ('OPERATOR_TEST_ACCOUNT', 'OPERATOR_DEMO_ACCOUNT',
                                        'OWNER_CLASSIFIED_EXTERNAL', 'CORRECTION')),
  classified_by  UUID NOT NULL REFERENCES admin_users(id),
  classified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_classification_class
  ON account_classification (classification);

CREATE TABLE IF NOT EXISTS admin_classification_confirmations (
  token_hash              TEXT PRIMARY KEY,
  admin_user_id           UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_classification   TEXT CHECK (target_classification IN ('EXTERNAL', 'INTERNAL_TEST', 'DEMO')),
  previous_classification TEXT CHECK (previous_classification IN ('EXTERNAL', 'INTERNAL_TEST', 'DEMO')),
  reason_code             TEXT NOT NULL,
  expires_at              TIMESTAMPTZ NOT NULL,
  used_at                 TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
