import { requireAdmin } from "../../admin-auth-utils.js";
import { config } from "../../config.js";
import { discloseBreakdown, discloseCount, discloseSubset } from "../../admin-disclosure.js";
import { COUNTRY_CODES, NO_VALID_CODE, SECTOR_IDS } from "../../admin-dimensions.js";
import {
  METRIC_DEFINITIONS,
  ensureFreshRollups,
  readDimensionSnapshot,
  readRollupState,
  readSuppressedOverview
} from "../../admin-metrics.js";
import { enforceAdminIpAllowlist } from "./auth.js";

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
  country: {
    label: "Profile country code",
    categories: COUNTRY_CODES,
    statement: "Country is the two-letter code stored on the account profile. It may have been chosen by the account holder or filled in from the country of the account's phone number. It is not checked."
  },
  sector: {
    label: "Profile sector code",
    categories: SECTOR_IDS,
    statement: "Sector is the code stored on the account profile from the account holder's selection in the app. It is not checked."
  }
});

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function responseStatements({ provisional, k, dimension, residual }) {
  const statements = [
    "Counts only accounts the operator has classified as external. Internal, demonstration and unclassified accounts are excluded.",
    "Classification is the operator's own entry. It is not an independent confirmation."
  ];
  if (provisional) {
    statements.push("Provisional: some accounts have not yet been classified, so these figures may change.");
  }
  statements.push(
    `Figures based on fewer than ${k} accounts are reported as 'fewer than ${k}' or withheld.`,
    "All time, as of the time shown. Records and attestations with a server timestamp before 1 January 2000 or later than the day after the figures were built are not counted.",
    `Single reading. Not cleared for repeated release: comparing two readings taken at different times can reveal a change affecting fewer than ${k} accounts.`
  );
  if (dimension) statements.push(DIMENSIONS[dimension].statement);
  if (residual) statements.push("'Other' combines two or more categories that are not shown separately.");
  return statements;
}

function labels(state, provisional, options = {}) {
  const effectiveProvisional = !state?.built_at || Boolean(provisional);
  const k = config.adminKAnonThreshold;
  return {
    audience: "owner_only",
    release_status: "single_reading",
    suppression: "minimum_cell_size",
    minimum_cell_size: k,
    scope: "external_only",
    range: "all_time",
    provisional: effectiveProvisional,
    as_of: iso(state?.built_at),
    stale: Boolean(state?.stale),
    statements: responseStatements({ provisional: effectiveProvisional, k, ...options })
  };
}

function unavailable(reply, state, options = {}) {
  return reply.code(503).send({ error: "metrics_unavailable", ...labels(state, true, options) });
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
  app.get("/admin/suppressed/overview", { preHandler: OWNER_ONLY }, async (request, reply) => {
    if (!hasOnlyQueryKeys(request.query, []) || Object.keys(request.query || {}).length) {
      return reply.code(400).send({ error: "invalid_query" });
    }
    await ensureFreshRollups();
    const state = await readRollupState();
    if (!state?.built_at) return unavailable(reply, state);

    const raw = await readSuppressedOverview();
    return reply.send({
      ...labels(state, raw.provisional),
      metrics: discloseOverview(raw, config.adminKAnonThreshold)
    });
  });

  app.get("/admin/suppressed/breakdown", { preHandler: OWNER_ONLY }, async (request, reply) => {
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
    const noValidCode = cells.find(({ category }) => category === NO_VALID_CODE)?.count || 0;
    const validCodes = total - noValidCode;
    let result;
    if (validCodes * 2 < total) {
      result = {
        status: "withheld",
        reason: "valid_codes_below_half",
        total: discloseCount(total, total, config.adminKAnonThreshold)
      };
    } else {
      result = discloseBreakdown(
        cells,
        config.adminKAnonThreshold,
        DIMENSIONS[dimension].categories.length + 1
      );
    }
    const residual = result.status === "published"
      && result.cells.some(({ category }) => category === "other");
    return reply.send({
      ...labels(state, raw.provisional, { dimension, residual }),
      dimension,
      dimension_label: DIMENSIONS[dimension].label,
      result
    });
  });
}
