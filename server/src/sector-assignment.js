// One rule for a business profile's sector, used by profile saves, profile reads (restore) and the
// admin analytics build. Sectors are Konfirmata's own operational categories (decisions U1–U5,
// 2026-10-28): every business profile is in exactly one sector; an account with no business
// profile has none.
//
// Precedence: 1 listed catalog type -> catalog sector; 2 the person's own choice (or a legacy
// sector-only profile); 3 a reviewed rule (applied by a forward migration); 4 otherwise
// "Other business" marked as a fallback.
import {
  BUSINESS_TYPE_CATALOG,
  OTHER_SECTOR_ID,
  SECTOR_IDS,
  UNLISTED_BUSINESS_TYPE_ID
} from "./business-catalog.js";

export const SECTOR_SOURCES = Object.freeze(["catalog", "user", "rule", "fallback"]);
const CHOSEN_SOURCES = new Set(["user", "rule"]);

const FALLBACK = Object.freeze({ sectorId: OTHER_SECTOR_ID, source: "fallback" });

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function isSectorId(value) {
  return typeof value === "string" && SECTOR_IDS.includes(value);
}

export function catalogSector(businessTypeId) {
  const id = text(businessTypeId);
  return id && Object.hasOwn(BUSINESS_TYPE_CATALOG, id) ? BUSINESS_TYPE_CATALOG[id].sector_id : null;
}

// A row holding only phone/name (e.g. created by the free-report route) is not a business profile:
// the app stores the person's display name as business_name.
export function hasBusinessProfile(row) {
  return Boolean(row) && Boolean(text(row.business_type_id) || text(row.sector_id) || text(row.business_description));
}

// The sector a stored profile counts under, or null when there is no business profile.
export function effectiveSector(row) {
  if (!hasBusinessProfile(row)) return null;
  const fromCatalog = catalogSector(row.business_type_id);
  if (fromCatalog) return { sectorId: fromCatalog, source: "catalog" };
  // A fallback is always "Other business". A sector chosen by the person or a reviewed rule is kept.
  // A sector stored without provenance predates migration 017: a legacy sector-only choice. Anything
  // else (a "catalog" source left on a type that is no longer listed, an unknown source, an invalid
  // sector) is not trusted and counts as the fallback. Migration 017 and the analytics build apply
  // exactly this rule.
  if (isSectorId(row.sector_id)) {
    if (CHOSEN_SOURCES.has(row.sector_source)) return { sectorId: row.sector_id, source: row.sector_source };
    if (row.sector_source === null || row.sector_source === undefined) return { sectorId: row.sector_id, source: "user" };
  }
  return FALLBACK;
}

// Complete = nothing more to ask: a listed type, or an unlisted description with a sector chosen by
// the person (or matched by a reviewed rule). Fallback and legacy sector-only profiles are incomplete.
export function isProfileComplete(row) {
  const assigned = effectiveSector(row);
  if (!assigned) return false;
  if (assigned.source === "catalog") return true;
  if (assigned.source === "fallback") return false;
  return text(row.business_type_id) === UNLISTED_BUSINESS_TYPE_ID && Boolean(text(row.business_description));
}

// Reads the sector sent by the app. Absent, null or blank means "not sent" (older apps send null for
// unlisted businesses). Anything else must be a known sector id.
export function readRequestedSector(body) {
  if (!Object.hasOwn(body, "sector_id")) return { requested: null };
  const value = body.sector_id;
  if (value === null || value === undefined) return { requested: null };
  if (typeof value !== "string") return { error: "Unknown business sector." };
  const trimmed = value.trim();
  if (!trimmed) return { requested: null };
  if (!isSectorId(trimmed)) return { error: "Unknown business sector." };
  return { requested: trimmed };
}

// The sector to store on save for a non-catalog profile (unlisted, or legacy with no type).
// `stored` is the current row (or null). A sector the server or person already assigned is never
// erased by a client that does not send one.
export function resolveNonCatalogSector({ requested, confirmed, stored }) {
  const storedAssignment = stored && !catalogSector(stored.business_type_id) ? effectiveSector(stored) : null;
  if (requested) {
    // Echoing the stored sector back does not turn a fallback into the person's choice; the app
    // marks a deliberate choice with sector_confirmed: true.
    if (!confirmed && storedAssignment && storedAssignment.sectorId === requested) return storedAssignment;
    return { sectorId: requested, source: "user" };
  }
  if (storedAssignment) return storedAssignment;
  // No sector sent and none stored (or the stored one belonged to a listed type the person left):
  // the previous catalog sector is not carried over as if confirmed.
  return FALLBACK;
}
