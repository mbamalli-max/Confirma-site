// Business-type search for the onboarding picker.
//
// Pilot country rule: only the selected country's types and GLOBAL types are searchable, and an alias
// tagged for one country is searchable only there. Results are suggestions; nothing is auto-selected.
//
// Ranking, best first: exact name > name prefix > alias (exact or prefix) > close spelling.
// Within a tier, the selected country's own types come before GLOBAL types.
import { BUSINESS_TYPES } from "./catalog-data.js";
import { BUSINESS_ALIASES } from "./business-aliases.js";
import { normalizeSearchText } from "./business-text.js";

export const UNLISTED_BUSINESS_TYPE_ID = "unlisted";
export const MATCH_TIERS = Object.freeze({ EXACT_NAME: 0, NAME_PREFIX: 1, ALIAS: 2, CLOSE_SPELLING: 3 });

export function eligibleBusinessTypes(region, types = BUSINESS_TYPES) {
  return types.filter((item) => item.country === region || item.country === "GLOBAL");
}

// Pilot: aliases tagged for a pan-African region are future scope and never searchable, even if shipped.
const PILOT_ALIAS_TAGS = new Set(["any", "NG", "US"]);

function eligibleAliases(region, typeIds, aliases) {
  return aliases.filter((entry) => typeIds.has(entry.type_id)
    && PILOT_ALIAS_TAGS.has(entry.used_in)
    && (entry.used_in === "any" || entry.used_in === region));
}

function tokens(text) {
  return text ? text.split(" ") : [];
}

// A phrase matches by prefix when it starts with the query, or when the query's words each start a
// word of the phrase in order ("doc print" -> "document print services").
function prefixMatches(phrase, query) {
  if (phrase.startsWith(query)) return true;
  const words = tokens(phrase);
  const parts = tokens(query);
  let from = 0;
  for (const part of parts) {
    const index = words.findIndex((word, position) => position >= from && word.startsWith(part));
    if (index < 0) return false;
    from = index + 1;
  }
  return parts.length > 0;
}

export function editDistance(a, b, limit = Infinity) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

function allowedEdits(query) {
  const length = query.replace(/ /g, "").length;
  if (length >= 8) return 2;
  if (length >= 4) return 1;
  return 0;
}

function closeSpelling(phrase, query) {
  const limit = allowedEdits(query);
  if (!limit) return false;
  if (editDistance(phrase, query, limit) <= limit) return true;
  // A one-word query may be a misspelling of one word in a longer phrase.
  if (!query.includes(" ")) {
    return tokens(phrase).some((word) => word.length >= 3 && editDistance(word, query, limit) <= limit);
  }
  return false;
}

/**
 * @returns {{ query: string, results: Array<{ type: object, tier: number, matchedAlias: string|null }> }}
 */
export function searchBusinessTypes(rawQuery, { region, types = BUSINESS_TYPES, aliases = BUSINESS_ALIASES } = {}) {
  const query = normalizeSearchText(rawQuery);
  if (!query) return { query, results: [] };

  const candidates = eligibleBusinessTypes(region, types);
  const typeIds = new Set(candidates.map((item) => item.id));
  const aliasesByType = new Map();
  for (const entry of eligibleAliases(region, typeIds, aliases)) {
    const list = aliasesByType.get(entry.type_id) || [];
    list.push({ alias: entry.alias, normalised: entry.normalised || normalizeSearchText(entry.alias) });
    aliasesByType.set(entry.type_id, list);
  }

  const results = [];
  for (const type of candidates) {
    const name = normalizeSearchText(type.name);
    const typeAliases = aliasesByType.get(type.id) || [];
    let tier = null;
    let matchedAlias = null;
    if (name === query) tier = MATCH_TIERS.EXACT_NAME;
    else if (prefixMatches(name, query)) tier = MATCH_TIERS.NAME_PREFIX;
    else {
      const aliasHit = typeAliases.find((entry) => entry.normalised === query)
        || typeAliases.find((entry) => prefixMatches(entry.normalised, query));
      if (aliasHit) {
        tier = MATCH_TIERS.ALIAS;
        matchedAlias = aliasHit.alias;
      } else if (closeSpelling(name, query)) {
        tier = MATCH_TIERS.CLOSE_SPELLING;
      } else {
        const closeAlias = typeAliases.find((entry) => closeSpelling(entry.normalised, query));
        if (closeAlias) {
          tier = MATCH_TIERS.CLOSE_SPELLING;
          matchedAlias = closeAlias.alias;
        }
      }
    }
    if (tier !== null) results.push({ type, tier, matchedAlias });
  }

  const order = new Map(candidates.map((item, index) => [item.id, index]));
  results.sort((a, b) => a.tier - b.tier
    || Number(a.type.country === "GLOBAL") - Number(b.type.country === "GLOBAL")
    || order.get(a.type.id) - order.get(b.type.id));
  return { query, results };
}

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/g;
export const BUSINESS_DESCRIPTION_MIN = 3;
export const BUSINESS_DESCRIPTION_MAX = 60;

// Same rule as the server: strip control characters, trim, count characters (not UTF-16 units).
export function cleanBusinessDescription(value) {
  return String(value ?? "").replace(CONTROL_CHARACTERS, "").trim();
}

export function businessDescriptionError(value) {
  const length = [...cleanBusinessDescription(value)].length;
  if (length < BUSINESS_DESCRIPTION_MIN || length > BUSINESS_DESCRIPTION_MAX) {
    return `Describe your business in ${BUSINESS_DESCRIPTION_MIN} to ${BUSINESS_DESCRIPTION_MAX} characters.`;
  }
  return "";
}
