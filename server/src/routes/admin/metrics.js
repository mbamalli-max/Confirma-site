import { writeAuditRow, requireAdmin } from "../../admin-auth-utils.js";
import {
  METRIC_DEFINITIONS,
  OVERVIEW_RANGES,
  PERIOD_METRIC_KEYS,
  ensureFreshRollups,
  readOverview,
  readRollupState,
  readStatus,
  readTimeseries,
  rebuildRollups
} from "../../admin-metrics.js";
import { enforceAdminIpAllowlist } from "./auth.js";

const OWNER_ONLY = [enforceAdminIpAllowlist, requireAdmin(["owner"])];
const responseCache = new Map();

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

export const API_VERSION = 2;

function labels(state) {
  return {
    api_version: API_VERSION,
    audience: "operator_only",
    suppression: "none",
    as_of: iso(state?.built_at),
    stale: Boolean(state?.stale)
  };
}

// Read routes of the earlier (pre-exclusion) model. An open tab of the old page gets a clear
// refusal instead of new-model numbers under old labels; it shows them as unavailable.
export const RETIRED_ROUTES = Object.freeze([
  ["GET", "/admin/metrics/overview"],
  ["GET", "/admin/metrics/timeseries"],
  ["POST", "/admin/metrics/refresh"],
  ["GET", "/admin/metrics/status"],
  ["GET", "/admin/suppressed/overview"],
  ["GET", "/admin/suppressed/breakdown"],
  ["GET", "/admin/classification/summary"]
]);

export function registerRetiredRoutes(app, routes) {
  for (const [method, url] of routes) {
    app.route({
      method,
      url,
      handler: async (request, reply) => reply.code(410).send({ error: "client_outdated", api_version: API_VERSION })
    });
  }
}

function cacheKey(route, query, state) {
  return `${route}:${JSON.stringify(query)}:${iso(state.built_at)}`;
}

function fromCache(key, state) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (new Date(state.checked_at).getTime() >= new Date(entry.expiresAt).getTime()) {
    responseCache.delete(key);
    return null;
  }
  return entry.body;
}

function putCache(key, body, state) {
  responseCache.set(key, { body, expiresAt: state.cache_valid_until });
  return body;
}

function unavailable(reply, state) {
  return reply.code(503).send({ error: "metrics_unavailable", ...labels(state) });
}

function validTimeseriesQuery(query) {
  if (!PERIOD_METRIC_KEYS.includes(query.metric)) return false;
  if (query.bucket !== "week" && query.bucket !== "month") return false;
  if (!/^\d+$/.test(String(query.periods ?? ""))) return false;
  const periods = Number(query.periods);
  return periods >= 1 && periods <= (query.bucket === "week" ? 26 : 24);
}

export function clearMetricsCache() {
  responseCache.clear();
}

export async function registerAdminMetricsRoutes(app) {
  registerRetiredRoutes(app, RETIRED_ROUTES.filter(([, url]) => url.startsWith("/admin/metrics/")));

  app.get("/admin/v2/overview", { preHandler: OWNER_ONLY }, async (request, reply) => {
    if (!OVERVIEW_RANGES.includes(request.query?.range)) {
      return reply.code(400).send({ error: "invalid_range" });
    }
    await ensureFreshRollups();
    const state = await readRollupState();
    if (!state?.built_at) return unavailable(reply, state);

    const key = cacheKey("overview", { range: request.query.range }, state);
    const cached = fromCache(key, state);
    if (cached) return reply.send(cached);

    const overview = await readOverview({ range: request.query.range });
    return reply.send(putCache(key, { ...overview, ...labels(state) }, state));
  });

  app.get("/admin/v2/timeseries", { preHandler: OWNER_ONLY }, async (request, reply) => {
    if (!validTimeseriesQuery(request.query || {})) {
      const knownPointMetric = METRIC_DEFINITIONS.some(({ key }) => key === request.query?.metric);
      return reply.code(400).send({
        error: knownPointMetric ? "point_in_time_metric" : "invalid_timeseries_query"
      });
    }
    await ensureFreshRollups();
    const state = await readRollupState();
    if (!state?.built_at) return unavailable(reply, state);

    const query = {
      metric: request.query.metric,
      bucket: request.query.bucket,
      periods: Number(request.query.periods)
    };
    const key = cacheKey("timeseries", query, state);
    const cached = fromCache(key, state);
    if (cached) return reply.send(cached);

    const series = await readTimeseries(query);
    return reply.send(putCache(key, { ...series, ...labels(state) }, state));
  });

  app.post("/admin/v2/refresh", {
    config: { rateLimit: { max: 6, timeWindow: "1 hour" } },
    preHandler: OWNER_ONLY
  }, async (request, reply) => {
    const result = await rebuildRollups({ automatic: false });
    await writeAuditRow({
      adminUserId: request.adminUser.id,
      action: "admin.metrics.refresh",
      request,
      responseStatus: 200
    });
    const state = await readRollupState();
    return reply.send({ ...result, ...labels(state) });
  });

  app.get("/admin/v2/status", { preHandler: OWNER_ONLY }, async (request, reply) => {
    const status = await readStatus();
    return reply.send({
      built_at: iso(status.built_at),
      build_ms: status.build_ms,
      out_of_range: Number(status.out_of_range),
      invalidations: Number(status.invalidations),
      last_attempt_at: iso(status.last_attempt_at),
      last_failure_at: iso(status.last_failure_at),
      row_counts: {
        metrics_daily_rollup: Number(status.daily_rollup_rows),
        metrics_snapshot: Number(status.snapshot_rows)
      },
      // Owner-only exact counts (Settings › Data quality); never shown on the dashboard.
      sector_assignment: {
        catalog: Number(status.sector_assignment.catalog),
        user_selected: Number(status.sector_assignment.user_selected),
        reviewed_rule: Number(status.sector_assignment.reviewed_rule),
        fallback: Number(status.sector_assignment.fallback),
        catalog_mismatches: Number(status.sector_assignment.catalog_mismatches)
      },
      ...labels(status)
    });
  });
}
