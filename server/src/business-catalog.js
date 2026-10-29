// Business type -> sector/country map for profile validation on the server.
// Must match app-v3/catalog-data.js exactly (checked by test/profile-business.test.js).
// The server deploys from server/ and cannot import the app catalog directly.
// Sectors are Konfirmata’s own operational categories, not an official industry classification.

export const UNLISTED_BUSINESS_TYPE_ID = "unlisted";

// "other_activity" ("Other business") is both a person’s "none of these fit" choice and the
// server’s fallback when it cannot tell; profiles.sector_source tells the two apart.
export const OTHER_SECTOR_ID = "other_activity";

export const SECTOR_IDS = Object.freeze(["trade_retail","food_hospitality","agriculture","transport_logistics","skilled_construction","personal_professional","digital_online","other_activity"]);

export const BUSINESS_TYPE_CATALOG = Object.freeze({
  "ng_market_trader": {
    "sector_id": "trade_retail",
    "country": "NG",
    "suggestion_group": "trade_retail"
  },
  "ng_provision_shop": {
    "sector_id": "trade_retail",
    "country": "NG",
    "suggestion_group": "trade_retail"
  },
  "ng_food_vendor": {
    "sector_id": "food_hospitality",
    "country": "NG",
    "suggestion_group": "food_hospitality"
  },
  "ng_transport_worker": {
    "sector_id": "transport_logistics",
    "country": "NG",
    "suggestion_group": "transport_logistics"
  },
  "ng_artisan": {
    "sector_id": "skilled_construction",
    "country": "NG",
    "suggestion_group": "skilled_construction"
  },
  "ng_service_provider": {
    "sector_id": "personal_professional",
    "country": "NG",
    "suggestion_group": "personal_professional"
  },
  "ng_online_seller": {
    "sector_id": "digital_online",
    "country": "NG",
    "suggestion_group": "digital_online"
  },
  "ng_kiosk_phone_business": {
    "sector_id": "trade_retail",
    "country": "NG",
    "suggestion_group": "digital_online"
  },
  "ng_fashion_tailor": {
    "sector_id": "skilled_construction",
    "country": "NG",
    "suggestion_group": "personal_professional"
  },
  "ng_okada_keke_rider": {
    "sector_id": "transport_logistics",
    "country": "NG",
    "suggestion_group": "transport_logistics"
  },
  "us_retail": {
    "sector_id": "trade_retail",
    "country": "US",
    "suggestion_group": "trade_retail"
  },
  "us_food_service": {
    "sector_id": "food_hospitality",
    "country": "US",
    "suggestion_group": "food_hospitality"
  },
  "us_logistics": {
    "sector_id": "transport_logistics",
    "country": "US",
    "suggestion_group": "transport_logistics"
  },
  "us_contractor": {
    "sector_id": "skilled_construction",
    "country": "US",
    "suggestion_group": "skilled_construction"
  },
  "us_beauty_services": {
    "sector_id": "personal_professional",
    "country": "US",
    "suggestion_group": "personal_professional"
  },
  "us_digital_business": {
    "sector_id": "digital_online",
    "country": "US",
    "suggestion_group": "digital_online"
  },
  "us_personal_services_side_hustle": {
    "sector_id": "personal_professional",
    "country": "US",
    "suggestion_group": "personal_professional"
  },
  "global_trade_retail": {
    "sector_id": "trade_retail",
    "country": "GLOBAL",
    "suggestion_group": "trade_retail"
  },
  "global_food_hospitality": {
    "sector_id": "food_hospitality",
    "country": "GLOBAL",
    "suggestion_group": "food_hospitality"
  },
  "global_transport_logistics": {
    "sector_id": "transport_logistics",
    "country": "GLOBAL",
    "suggestion_group": "transport_logistics"
  },
  "global_skilled_construction": {
    "sector_id": "skilled_construction",
    "country": "GLOBAL",
    "suggestion_group": "skilled_construction"
  },
  "global_personal_professional": {
    "sector_id": "personal_professional",
    "country": "GLOBAL",
    "suggestion_group": "personal_professional"
  },
  "global_digital_online": {
    "sector_id": "digital_online",
    "country": "GLOBAL",
    "suggestion_group": "digital_online"
  },
  "global_document_services": {
    "sector_id": "personal_professional",
    "country": "GLOBAL",
    "suggestion_group": "personal_professional"
  },
  "global_tutoring": {
    "sector_id": "personal_professional",
    "country": "GLOBAL",
    "suggestion_group": "personal_professional"
  },
  "global_device_repair": {
    "sector_id": "skilled_construction",
    "country": "GLOBAL",
    "suggestion_group": "skilled_construction"
  }
});
