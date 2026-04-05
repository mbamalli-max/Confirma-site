ALTER TABLE profiles ADD COLUMN IF NOT EXISTS operating_region CHAR(2);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS language VARCHAR(10) DEFAULT 'en';

-- Backfill: existing country becomes operating_region
UPDATE profiles SET operating_region = country WHERE operating_region IS NULL AND country IS NOT NULL;
