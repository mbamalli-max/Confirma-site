-- Every business profile in a sector (decisions U1–U5, 2026-10-28).
-- Sectors are Konfirmata's own operational categories. A business profile (a business type, a
-- sector or an unlisted description) always has one sector; an account with no business profile
-- has none. sector_source records how the sector was set: catalog, user, rule or fallback.
--
-- Forward only and safe to run again: every update touches only rows that differ, the guards are
-- re-created with their current rule on every run (so a same-named stale rule is replaced), and
-- derived figures are invalidated only on the first run or when a row changed.
-- Ledger entries (signed payloads carrying their own sector), attestations, payments and reports
-- are never touched.

-- Recorded before the column is added: the first run always invalidates the breakdown figures,
-- because the counting rule changes with this release even where no row changes.
DROP TABLE IF EXISTS pg_temp.sector_first_run_017;
CREATE TEMP TABLE sector_first_run_017 ON COMMIT DROP AS
  SELECT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'profiles' AND column_name = 'sector_source'
  ) AS first_run;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sector_source TEXT;

DROP TABLE IF EXISTS pg_temp.sector_catalog_017;
-- Frozen copy of server/src/business-catalog.js at this release (test: admin-migration-017).
CREATE TEMP TABLE sector_catalog_017 (business_type_id TEXT PRIMARY KEY, sector_id TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO sector_catalog_017 (business_type_id, sector_id) VALUES
    ('ng_market_trader', 'trade_retail'),
    ('ng_provision_shop', 'trade_retail'),
    ('ng_food_vendor', 'food_hospitality'),
    ('ng_transport_worker', 'transport_logistics'),
    ('ng_artisan', 'skilled_construction'),
    ('ng_service_provider', 'personal_professional'),
    ('ng_online_seller', 'digital_online'),
    ('ng_kiosk_phone_business', 'trade_retail'),
    ('ng_fashion_tailor', 'skilled_construction'),
    ('ng_okada_keke_rider', 'transport_logistics'),
    ('us_retail', 'trade_retail'),
    ('us_food_service', 'food_hospitality'),
    ('us_logistics', 'transport_logistics'),
    ('us_contractor', 'skilled_construction'),
    ('us_beauty_services', 'personal_professional'),
    ('us_digital_business', 'digital_online'),
    ('us_personal_services_side_hustle', 'personal_professional'),
    ('global_trade_retail', 'trade_retail'),
    ('global_food_hospitality', 'food_hospitality'),
    ('global_transport_logistics', 'transport_logistics'),
    ('global_skilled_construction', 'skilled_construction'),
    ('global_personal_professional', 'personal_professional'),
    ('global_digital_online', 'digital_online'),
    ('global_document_services', 'personal_professional'),
    ('global_tutoring', 'personal_professional'),
    ('global_device_repair', 'skilled_construction');

DO $$
DECLARE
  changed integer := 0;
  n integer;
  first_run boolean;
  guard text;
BEGIN
  SELECT f.first_run INTO first_run FROM sector_first_run_017 f;

  -- The guards are dropped first so the backfill can repair any partly applied state, then
  -- re-created below with their current rule.
  FOREACH guard IN ARRAY ARRAY[
    'profiles_sector_id_valid', 'profiles_sector_source_valid', 'profiles_sector_source_pairing',
    'profiles_fallback_is_other', 'profiles_business_has_sector'
  ] LOOP
    EXECUTE format('ALTER TABLE profiles DROP CONSTRAINT IF EXISTS %I', guard);
  END LOOP;

  -- 1. Listed catalog types take the catalog sector (rules K1/K2 move kiosk and tailor).
  UPDATE profiles p
  SET sector_id = c.sector_id, sector_source = 'catalog'
  FROM sector_catalog_017 c
  WHERE BTRIM(p.business_type_id) = c.business_type_id
    AND (p.sector_id IS DISTINCT FROM c.sector_id OR p.sector_source IS DISTINCT FROM 'catalog');
  GET DIAGNOSTICS n = ROW_COUNT; changed := changed + n;

  -- 2. Other business profiles (unlisted, legacy sector-only, unknown type). Same rule as
  --    effectiveSector() in server/src/sector-assignment.js:
  --    a valid sector stored without provenance is the person's legacy choice: 'user'.
  UPDATE profiles p
  SET sector_source = 'user'
  WHERE NOT EXISTS (SELECT 1 FROM sector_catalog_017 c WHERE c.business_type_id = BTRIM(COALESCE(p.business_type_id, '')))
    AND p.sector_id IN ('trade_retail', 'food_hospitality', 'agriculture', 'transport_logistics', 'skilled_construction', 'personal_professional', 'digital_online', 'other_activity')
    AND p.sector_source IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; changed := changed + n;

  --    Anything else that is not a valid sector chosen by the person or a reviewed rule ('user' /
  --    'rule'): "Other business", marked as a fallback (not the person's choice).
  UPDATE profiles p
  SET sector_id = 'other_activity', sector_source = 'fallback'
  WHERE NOT EXISTS (SELECT 1 FROM sector_catalog_017 c WHERE c.business_type_id = BTRIM(COALESCE(p.business_type_id, '')))
    AND (
      NULLIF(BTRIM(COALESCE(p.business_type_id, '')), '') IS NOT NULL
      OR NULLIF(BTRIM(COALESCE(p.sector_id, '')), '') IS NOT NULL
      OR NULLIF(BTRIM(COALESCE(p.business_description, '')), '') IS NOT NULL
    )
    AND NOT COALESCE(p.sector_id IN ('trade_retail', 'food_hospitality', 'agriculture', 'transport_logistics', 'skilled_construction', 'personal_professional', 'digital_online', 'other_activity') AND p.sector_source IN ('user', 'rule'), FALSE)
    AND (p.sector_id IS DISTINCT FROM 'other_activity' OR p.sector_source IS DISTINCT FROM 'fallback');
  GET DIAGNOSTICS n = ROW_COUNT; changed := changed + n;

  -- 3. Rows that are not business profiles (e.g. phone-only rows from the free report) hold no sector.
  UPDATE profiles p
  SET sector_id = NULL, sector_source = NULL
  WHERE NULLIF(BTRIM(COALESCE(p.business_type_id, '')), '') IS NULL
    AND NULLIF(BTRIM(COALESCE(p.sector_id, '')), '') IS NULL
    AND NULLIF(BTRIM(COALESCE(p.business_description, '')), '') IS NULL
    AND (p.sector_id IS NOT NULL OR p.sector_source IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT; changed := changed + n;

  -- 4. Guards, re-created with their current rule.
  ALTER TABLE profiles ADD CONSTRAINT profiles_sector_id_valid
    CHECK (sector_id IS NULL OR sector_id IN ('trade_retail', 'food_hospitality', 'agriculture', 'transport_logistics', 'skilled_construction', 'personal_professional', 'digital_online', 'other_activity'));
  ALTER TABLE profiles ADD CONSTRAINT profiles_sector_source_valid
    CHECK (sector_source IS NULL OR sector_source IN ('catalog', 'user', 'rule', 'fallback'));
  ALTER TABLE profiles ADD CONSTRAINT profiles_sector_source_pairing
    CHECK ((sector_id IS NULL) = (sector_source IS NULL));
  ALTER TABLE profiles ADD CONSTRAINT profiles_fallback_is_other
    CHECK (sector_source IS DISTINCT FROM 'fallback' OR sector_id = 'other_activity');
  ALTER TABLE profiles ADD CONSTRAINT profiles_business_has_sector
    CHECK (
      sector_id IS NOT NULL
      OR (NULLIF(BTRIM(COALESCE(business_type_id, '')), '') IS NULL
          AND NULLIF(BTRIM(COALESCE(business_description, '')), '') IS NULL)
    );

  -- 5. Breakdown figures were built under the old sector rule: remove them and mark the state
  --    unbuilt so the first read rebuilds (the 016 pattern). A rerun with no row change keeps them.
  IF first_run OR changed > 0 THEN
    DELETE FROM metrics_dimension_snapshot;
    UPDATE metrics_rollup_state
    SET built_at = NULL, stale = TRUE, build_ms = NULL, out_of_range = 0, invalidations = invalidations + 1
    WHERE id = TRUE;
  END IF;
END $$;
