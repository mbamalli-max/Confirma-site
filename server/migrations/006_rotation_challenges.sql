CREATE TABLE IF NOT EXISTS rotation_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT NOT NULL,
  old_device_identity TEXT NOT NULL,
  challenge_nonce TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rotation_challenges_lookup
  ON rotation_challenges (challenge_nonce);

CREATE INDEX IF NOT EXISTS idx_rotation_challenges_cleanup
  ON rotation_challenges (expires_at);
