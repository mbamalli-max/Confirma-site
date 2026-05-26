-- Columns previously only added by runtime schema-ensure; now in the migration path.
ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan_activated_at TIMESTAMPTZ;

-- Backfill: existing profiles get phone_number from users (no-op on fresh installs)
UPDATE profiles p
SET phone_number = u.phone_number
FROM users u
WHERE p.user_id = u.id
  AND (p.phone_number IS NULL OR p.phone_number <> u.phone_number);
