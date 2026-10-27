// Business type -> sector/country map for profile validation on the server.
// Must match app-v3/catalog-data.js exactly (checked by test/profile-business.test.js).
// The server deploys from server/ and cannot import the app catalog directly.

export const UNLISTED_BUSINESS_TYPE_ID = "unlisted";

export const SECTOR_IDS = Object.freeze(["trade_retail","food_hospitality","transport_logistics","skilled_construction","personal_professional","digital_online"]);

export const BUSINESS_TYPE_CATALOG = Object.freeze({
  "ng_market_trader": {
    "sector_id": "trade_retail",
    "country": "NG"
  },
  "ng_provision_shop": {
    "sector_id": "trade_retail",
    "country": "NG"
  },
  "ng_food_vendor": {
    "sector_id": "food_hospitality",
    "country": "NG"
  },
  "ng_transport_worker": {
    "sector_id": "transport_logistics",
    "country": "NG"
  },
  "ng_artisan": {
    "sector_id": "skilled_construction",
    "country": "NG"
  },
  "ng_service_provider": {
    "sector_id": "personal_professional",
    "country": "NG"
  },
  "ng_online_seller": {
    "sector_id": "digital_online",
    "country": "NG"
  },
  "ng_kiosk_phone_business": {
    "sector_id": "digital_online",
    "country": "NG"
  },
  "ng_fashion_tailor": {
    "sector_id": "personal_professional",
    "country": "NG"
  },
  "ng_okada_keke_rider": {
    "sector_id": "transport_logistics",
    "country": "NG"
  },
  "us_retail": {
    "sector_id": "trade_retail",
    "country": "US"
  },
  "us_food_service": {
    "sector_id": "food_hospitality",
    "country": "US"
  },
  "us_logistics": {
    "sector_id": "transport_logistics",
    "country": "US"
  },
  "us_contractor": {
    "sector_id": "skilled_construction",
    "country": "US"
  },
  "us_beauty_services": {
    "sector_id": "personal_professional",
    "country": "US"
  },
  "us_digital_business": {
    "sector_id": "digital_online",
    "country": "US"
  },
  "us_personal_services_side_hustle": {
    "sector_id": "personal_professional",
    "country": "US"
  },
  "global_trade_retail": {
    "sector_id": "trade_retail",
    "country": "GLOBAL"
  },
  "global_food_hospitality": {
    "sector_id": "food_hospitality",
    "country": "GLOBAL"
  },
  "global_transport_logistics": {
    "sector_id": "transport_logistics",
    "country": "GLOBAL"
  },
  "global_skilled_construction": {
    "sector_id": "skilled_construction",
    "country": "GLOBAL"
  },
  "global_personal_professional": {
    "sector_id": "personal_professional",
    "country": "GLOBAL"
  },
  "global_digital_online": {
    "sector_id": "digital_online",
    "country": "GLOBAL"
  },
  "global_document_services": {
    "sector_id": "personal_professional",
    "country": "GLOBAL"
  },
  "global_tutoring": {
    "sector_id": "personal_professional",
    "country": "GLOBAL"
  },
  "global_device_repair": {
    "sector_id": "skilled_construction",
    "country": "GLOBAL"
  }
});
