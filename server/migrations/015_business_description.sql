-- Part 2 business picker: free-text description for businesses not in the catalog.
-- Additive only. business_description is set only when business_type_id = 'unlisted' (enforced by the API).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS business_description TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS classification_review TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_business_description_length'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_business_description_length
      CHECK (business_description IS NULL OR char_length(business_description) BETWEEN 3 AND 60);
  END IF;
END $$;

-- 'unlisted' and a description always come together (guards against concurrent saves too).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_unlisted_description_pairing'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_unlisted_description_pairing
      CHECK ((COALESCE(business_type_id, '') = 'unlisted') = (business_description IS NOT NULL));
  END IF;
END $$;
