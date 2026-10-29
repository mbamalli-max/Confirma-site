import { requireAdmin } from "../../admin-auth-utils.js";
import { config } from "../../config.js";
import { discloseAllCells, discloseBreakdown, discloseCount, discloseSubset } from "../../admin-disclosure.js";
import { BUSINESS_TYPE_IDS, COUNTRY_CODES, NO_BUSINESS_PROFILE, NO_VALID_CODE, SECTOR_IDS } from "../../admin-dimensions.js";
import {
  METRIC_DEFINITIONS,
  ensureFreshRollups,
  readDimensionSnapshot,
  readRollupState,
  readSuppressedOverview
} from "../../admin-metrics.js";
import { enforceAdminIpAllowlist } from "./auth.js";
import { API_VERSION, RETIRED_ROUTES, registerRetiredRoutes } from "./metrics.js";

const OWNER_ONLY = [enforceAdminIpAllowlist, requireAdmin(["owner"])];
export const SUPPRESSED_OVERVIEW_METRIC_KEYS = Object.freeze([
  "accounts_registered",
  "records_received",
  "attestations_issued",
  "accounts_phone_verified",
  "accounts_email_verified",
  "devices_active",
  "accounts_with_records",
  "accounts_with_3plus_records"
]);
const DIMENSIONS = Object.freeze({
  // residuals: the non-category cells this dimension can report; they count in the universe size.
  country: {
    smallCells: "shown",
    label: "Profile country code",
    categories: COUNTRY_CODES,
    residuals: [NO_VALID_CODE],
    statement: "Country is the two-letter code stored on the account profile. It may have been chosen by the account holder or filled in from the country of the account's phone number. It is not checked."
  },
  sector: {
    smallCells: "shown",
    label: "Business sector",
    categories: SECTOR_IDS,
    residuals: [NO_BUSINESS_PROFILE],
    statement: "Sector is Konfirmata's category for the business. For a business type in the catalog it comes from the catalog; otherwise it is the sector the account holder chose, or 'Other business' when no sector could be determined. Accounts without a business profile are shown separately. The server does not verify the account's actual business."
  },
  business_type: {
    smallCells: "combined",
    label: "Profile business type",
    categories: BUSINESS_TYPE_IDS,
    residuals: [NO_VALID_CODE, NO_BUSINESS_PROFILE],
    statement: "Business type is the catalog type stored on the account profile from the account holder's choice in the app, or 'unlisted' when they chose 'my business isn't listed'. The server validates the type against its catalog; it does not verify the account's actual business. Free-text business descriptions are not used."
  }
});

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function responseStatements({ k, dimension, residual }) {
  const statements = [
    "Counts all accounts except those the owner has identified as internal test, demonstration or administrator accounts.",
    "Identification is the owner's own entry. It is not an independent confirmation."
  ];
  if (dimension && DIMENSIONS[dimension].smallCells === "shown") {
    statements.push(`Every ${dimension} is shown with its exact count, including small counts.`);
  } else {
    statements.push(
      `Figures based on fewer than ${k} accounts are reported as 'fewer than ${k}' or withheld.`,
      `Single reading. Not cleared for repeated release: comparing two readings taken at different times can reveal a change affecting fewer than ${k} accounts.`
    );
  }
  statements.push("All time, as of the time shown. Records and attestations with a server timestamp before 1 January 2000 or later than the day after the figures were built are not counted.");
  if (dimension) statements.push(DIMENSIONS[dimension].statement);
  if (residual) statements.push("'Other' combines two or more categories that are not shown separately.");
  return statements;
}

function labels(state, options = {}) {
  const k = config.adminKAnonThreshold;
  return {
    api_version: API_VERSION,
    audience: "owner_only",
    release_status: "single_reading",
    suppression: options.dimension && DIMENSIONS[options.dimension].smallCells === "shown" ? "none" : "minimum_cell_size",
    minimum_cell_size: k,
    scope: "external_only",
    range: "all_time",
    as_of: iso(state?.built_at),
    stale: Boolean(state?.stale),
    statements: responseStatements({ k, ...options })
  };
}

function unavailable(reply, state, options = {}) {
  return reply.code(503).send({ error: "metrics_unavailable", ...labels(state, options) });
}

function hasOnlyQueryKeys(query, allowed) {
  const keys = Object.keys(query || {});
  return keys.every((key) => allowed.includes(key));
}

function discloseOverview(raw, k) {
  const snapshot = raw.snapshot;
  const daily = raw.daily;
  const accountTotal = snapshot.accounts_all || 0;
  const results = {};
  results.accounts_registered = discloseCount(accountTotal, accountTotal, k);

  const subset = (key, value, parentValue, parentResult) => {
    results[key] = parentResult.status === "published"
      ? discloseSubset(value, parentValue, k)
      : { status: "withheld" };
  };
  subset(
    "accounts_phone_verified",
    snapshot.accounts_phone_verified || 0,
    accountTotal,
    results.accounts_registered
  );
  subset(
    "accounts_email_verified",
    snapshot.accounts_email_verified || 0,
    accountTotal,
    results.accounts_registered
  );
  subset(
    "accounts_with_records",
    snapshot.accounts_with_records || 0,
    accountTotal,
    results.accounts_registered
  );
  subset(
    "accounts_with_3plus_records",
    snapshot.accounts_with_3plus_records || 0,
    snapshot.accounts_with_records || 0,
    results.accounts_with_records
  );
  results.records_received = discloseCount(
    daily.records_received || 0,
    snapshot.contributors_records_received || 0,
    k
  );
  results.attestations_issued = discloseCount(
    daily.attestations_issued || 0,
    snapshot.contributors_attestations_issued || 0,
    k
  );
  results.devices_active = discloseCount(
    snapshot.devices_active || 0,
    snapshot.contributors_devices_active || 0,
    k
  );

  return SUPPRESSED_OVERVIEW_METRIC_KEYS.map((key) => {
    const { definition } = METRIC_DEFINITIONS.find((item) => item.key === key);
    return { key, definition, disclosure: results[key] };
  });
}

export async function registerAdminSuppressedRoutes(app) {
  registerRetiredRoutes(app, RETIRED_ROUTES.filter(([, url]) => url.startsWith("/admin/suppressed/")));

  app.get("/admin/v2/suppressed/overview", { preHandler: OWNER_ONLY }, async (request, reply) => {
    if (!hasOnlyQueryKeys(request.query, []) || Object.keys(request.query || {}).length) {
      return reply.code(400).send({ error: "invalid_query" });
    }
    await ensureFreshRollups();
    const state = await readRollupState();
    if (!state?.built_at) return unavailable(reply, state);

    const raw = await readSuppressedOverview();
    return reply.send({
      ...labels(state),
      metrics: discloseOverview(raw, config.adminKAnonThreshold)
    });
  });

  app.get("/admin/v2/breakdown", { preHandler: OWNER_ONLY }, async (request, reply) => {
    const query = request.query || {};
    if (!hasOnlyQueryKeys(query, ["dimension"])
        || Object.keys(query).length !== 1
        || typeof query.dimension !== "string"
        || !Object.hasOwn(DIMENSIONS, query.dimension)) {
      return reply.code(400).send({ error: "invalid_dimension" });
    }
    const dimension = query.dimension;
    await ensureFreshRollups();
    const state = await readRollupState();
    if (!state?.built_at) return unavailable(reply, state, { dimension });

    const [cells, raw] = await Promise.all([
      readDimensionSnapshot(dimension),
      readSuppressedOverview()
    ]);
    const total = raw.snapshot.accounts_all || 0;
    const countOf = (category) => cells.find((cell) => cell.category === category)?.count || 0;
    const noBusinessProfile = countOf(NO_BUSINESS_PROFILE);
    const withCode = total - noBusinessProfile - countOf(NO_VALID_CODE);
    let result;
    if (DIMENSIONS[dimension].residuals.includes(NO_BUSINESS_PROFILE)
        && (total - noBusinessProfile) * 2 < total) {
      result = {
        status: "withheld",
        reason: "business_profiles_below_half",
        total: discloseCount(total, total, config.adminKAnonThreshold)
      };
    } else if (withCode * 2 < total) {
      result = {
        status: "withheld",
        reason: "valid_codes_below_half",
        total: discloseCount(total, total, config.adminKAnonThreshold)
      };
    } else {
      result = DIMENSIONS[dimension].smallCells === "shown"
        ? discloseAllCells(cells, config.adminKAnonThreshold)
        : discloseBreakdown(
          cells,
          config.adminKAnonThreshold,
          DIMENSIONS[dimension].categories.length + DIMENSIONS[dimension].residuals.length
        );
    }
    const residual = result.status === "published"
      && result.cells.some(({ category }) => category === "other");
    return reply.send({
      ...labels(state, { dimension, residual }),
      dimension,
      dimension_label: DIMENSIONS[dimension].label,
      result
    });
  });
}
