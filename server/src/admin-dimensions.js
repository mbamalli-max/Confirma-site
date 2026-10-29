import { BUSINESS_TYPE_CATALOG, SECTOR_IDS, UNLISTED_BUSINESS_TYPE_ID } from "./business-catalog.js";

// Konfirmata's own sector categories (decisions U1–U5, 2026-10-28); one list for app, server and admin.
export { SECTOR_IDS };

export const COUNTRY_CODES = Object.freeze(["AF","AX","AL","DZ","AS","AD","AO","AI","AQ","AG","AR","AM","AW","AU","AT","AZ","BS","BH","BD","BB","BY","BE","BZ","BJ","BM","BT","BO","BA","BW","BV","BR","IO","VG","BN","BG","BF","BI","KH","CM","CA","CV","BQ","KY","CF","TD","CL","CN","CX","CC","CO","KM","CG","CD","CK","CR","CI","HR","CU","CW","CY","CZ","DK","DJ","DM","DO","EC","EG","SV","GQ","ER","EE","SZ","ET","FK","FO","FJ","FI","FR","GF","PF","TF","GA","GM","GE","DE","GH","GI","GR","GL","GD","GP","GU","GT","GG","GN","GW","GY","HT","HM","HN","HK","HU","IS","IN","ID","IR","IQ","IE","IM","IL","IT","JM","JP","JE","JO","KZ","KE","KI","KW","KG","LA","LV","LB","LS","LR","LY","LI","LT","LU","MO","MG","MW","MY","MV","ML","MT","MH","MQ","MR","MU","YT","MX","FM","MD","MC","MN","ME","MS","MA","MZ","MM","NA","NR","NP","NL","NC","NZ","NI","NE","NG","NU","NF","KP","MK","MP","NO","OM","PK","PW","PS","PA","PG","PY","PE","PH","PN","PL","PT","PR","QA","RE","RO","RU","RW","WS","SM","ST","SA","SN","RS","SC","SL","SG","SX","SK","SI","SB","SO","ZA","GS","KR","SS","ES","LK","BL","SH","KN","LC","MF","PM","VC","SD","SR","SJ","SE","CH","SY","TW","TJ","TZ","TH","TL","TG","TK","TO","TT","TN","TR","TM","TC","TV","UM","VI","UG","UA","AE","GB","US","UY","UZ","VU","VA","VE","VN","WF","EH","YE","ZM","ZW"]);

export const NO_VALID_CODE = "no_valid_code";

// The account has no business profile (no business type, sector or description): no sector exists to
// count. Kept apart from every sector, including "Other business".
export const NO_BUSINESS_PROFILE = "no_business_profile";

// Listed business type -> sector, as two aligned arrays for SQL unnest().
export const CATALOG_TYPE_IDS = Object.freeze(Object.keys(BUSINESS_TYPE_CATALOG).sort());
export const CATALOG_TYPE_SECTORS = Object.freeze(CATALOG_TYPE_IDS.map((id) => BUSINESS_TYPE_CATALOG[id].sector_id));

// Business types: the catalog IDs the server accepts, plus "unlisted" (the app's "my business
// isn't listed" choice). The free-text description of an unlisted business is never read here.
export const BUSINESS_TYPE_IDS = Object.freeze([
  ...Object.keys(BUSINESS_TYPE_CATALOG).sort(),
  UNLISTED_BUSINESS_TYPE_ID
]);
