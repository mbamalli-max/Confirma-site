import * as config from "./config.js";
import { BUSINESS_TYPE_LABELS, SECTOR_LABELS } from "./catalog-labels.js";

const API_BASE = config.API_BASE;
// How long a logout request may take before it counts as unconfirmed.
const LOGOUT_TIMEOUT_MS = Number(config.LOGOUT_TIMEOUT_MS) > 0 ? Number(config.LOGOUT_TIMEOUT_MS) : 10000;
// Exclusion requests use the same limit; a timed-out confirmation is "outcome unconfirmed".
const WRITE_TIMEOUT_MS = LOGOUT_TIMEOUT_MS;
// The server keeps a preview's confirmation for 5 minutes; the page stops offering it a little sooner.
const PREVIEW_LIFETIME_MS = Number(config.CLASSIFY_PREVIEW_MS) > 0 ? Number(config.CLASSIFY_PREVIEW_MS) : 5 * 60 * 1000 - 5000;
// How long to wait before asking once more for figures that are still being built.
const UNAVAILABLE_RETRY_MS = Number(config.UNAVAILABLE_RETRY_MS) >= 0 && config.UNAVAILABLE_RETRY_MS !== undefined ? Number(config.UNAVAILABLE_RETRY_MS) : 1500;
// The figure routes this page understands (server slice B1).
const API_VERSION = 2;
const TABS = ["dashboard", "settings"];
const SUBTABS = ["exclusions", "quality", "detail", "methodology"];
const DIMENSIONS = ["country", "sector", "business_type"];

let token = null;
let expiresAt = null;
let expiryTimer = null;
// Bumped on every sign-in and sign-out. A response that comes back after the
// session it was sent for has ended must not change the page.
let session = 0;
// True only while the owner's signed-in view is showing.
let ownerView = false;
// Set when a figure response is not the version this page understands.
let outOfStep = false;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const SVG_NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

class SessionEnded extends Error {}
class OutOfStep extends Error {}

async function api(method, path, body, bearer = token, timeoutMs = 0) {
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body) headers["Content-Type"] = "application/json";
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(API_BASE + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      signal: controller ? controller.signal : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function authed(method, path, body, timeoutMs = 0) {
  const mine = session;
  let r;
  try {
    r = await api(method, path, body, token, timeoutMs);
  } catch (e) {
    // A network failure from an ended session must not change the page either.
    if (mine !== session) throw new SessionEnded();
    throw e;
  }
  // Sent for a session that has since ended: ignore it, whatever it says.
  if (mine !== session) throw new SessionEnded();
  if (r.status === 401) { endSession(); throw new SessionEnded(); }
  if (r.status === 403) {
    showDenied("The server refused this account access to the admin figures. No figures are shown.");
    throw new SessionEnded();
  }
  return r;
}

// Figure routes: the answer must come from the version of the server this page was built for.
// A missing route (older server), a retired route (410) or a different version shows no figures.
async function v2(method, path, body) {
  let r = await authed(method, path, body);
  // While figures are being built (for example the first read after a deploy, when one
  // request starts the build and the others find it running), the server answers 503.
  // Reads wait briefly and ask once more; a still-missing answer shows as unavailable.
  if (r.status === 503 && method === "GET") {
    const mine = session;
    await new Promise((resolve) => setTimeout(resolve, UNAVAILABLE_RETRY_MS));
    if (mine !== session) throw new SessionEnded();
    r = await authed(method, path, body);
  }
  // Once any answer was out of step, no later answer may draw figures either.
  if (outOfStep) throw new OutOfStep();
  const versionOk = r.data && r.data.api_version === API_VERSION;
  if (r.status === 404 || r.status === 410 || ((r.status === 200 || r.status === 503) && !versionOk)) {
    showOutOfStep();
    throw new OutOfStep();
  }
  return r;
}

function showOutOfStep() {
  outOfStep = true;
  clearFigures();
  $("version-mismatch").hidden = false;
}

// "2026-10-27T04:10:00.000Z" -> "2026-10-27 04:10 UTC"; anything unexpected is shown as sent.
function formatUtc(value) {
  if (!value) return "—";
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? `${text.slice(0, 10)} ${text.slice(11, 16)} UTC` : text;
}

const regionNames = (() => {
  try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; }
})();

function categoryLabel(dimension, category) {
  if (category === "other") return "Other (combined)";
  if (category === "no_business_profile") return "No business profile";
  if (category === "no_valid_code") return dimension === "business_type" ? "No business type" : "No valid code";
  if (dimension === "country") {
    let name = null;
    try { name = regionNames ? regionNames.of(category) : null; } catch { name = null; }
    return name && name !== category ? `${name} (${category})` : category;
  }
  if (dimension === "sector") return SECTOR_LABELS[category] || category;
  return BUSINESS_TYPE_LABELS[category] || category;
}

// ---- Clearing --------------------------------------------------------------------

function clearDashboard() {
  for (const id of ["kpi-external-value", "kpi-submitting-value", "kpi-records-value"]) $(id).textContent = "—";
  $("kpi-external-sub").textContent = "";
  $("dash-as-of").textContent = "—";
  $("dash-exclusions-changed").textContent = "—";
  $("dash-stale").hidden = true;
  $("dash-unavailable").hidden = true;
  for (const metric of ["accounts_registered", "records_received"]) {
    document.querySelector(`#growth-${metric} .chart-body`).replaceChildren();
  }
  for (const dimension of DIMENSIONS) {
    document.querySelector(`#aud-${dimension} .breakdown-body`).replaceChildren();
    document.querySelector(`#aud-${dimension} .dim-statement`).textContent = "";
  }
}

function clearSettingsFigures() {
  for (const id of ["count-total", "count-excluded", "count-external", "count-created-since"]) $(id).textContent = "—";
  $("exclusions-changed-note").textContent = "";
  for (const id of ["q-built-at", "q-stale", "q-last-attempt", "q-last-failure", "q-out-of-range"]) $(id).textContent = "—";
  $("refresh-message").textContent = "";
  $("refresh-confirm").hidden = true;
  $("detail-table").tBodies[0].replaceChildren();
  $("detail-unavailable").hidden = true;
  $("method-statements").replaceChildren();
  $("method-definitions").replaceChildren();
}

function clearFigures() {
  clearDashboard();
  clearSettingsFigures();
  $("admin-email").textContent = "";
  $("session-expiry").textContent = "";
}

// ---- Screens ---------------------------------------------------------------------

function showSignin(message) {
  session += 1;
  token = null;
  expiresAt = null;
  ownerView = false;
  outOfStep = false;
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
  resetExclusions();
  clearFigures();
  // A new session starts from the default views.
  $("period-select").value = "90d";
  $("growth-bucket").value = "month";
  $("detail-range").value = "90d";
  $("version-mismatch").hidden = true;
  $("app-shell").hidden = true;
  $("denied-screen").hidden = true;
  $("signin-screen").hidden = false;
  $("signin-form").reset();
  $("signin-submit").disabled = false;
  $("signin-error").textContent = message || "";
}

function endSession() {
  showSignin("Your session has ended. Sign in again.");
}

// Signed in, but not as the owner. The API withholds the figures; the page says
// so plainly instead of showing an empty owner-only view. Sign out still works.
function showDenied(message) {
  session += 1; // anything still in flight is ignored
  ownerView = false;
  resetExclusions();
  clearFigures();
  $("signin-screen").hidden = true;
  $("app-shell").hidden = true;
  $("denied-screen").hidden = false;
  $("denied-message").textContent = message;
}

// ---- Navigation -------------------------------------------------------------------

function routeFromHash() {
  const [tab, sub] = location.hash.replace(/^#/, "").split("/");
  return {
    tab: TABS.includes(tab) ? tab : "dashboard",
    sub: SUBTABS.includes(sub) ? sub : "exclusions",
  };
}

function showRoute() {
  const { tab, sub } = routeFromHash();
  for (const name of TABS) $(`${name}-screen`).hidden = name !== tab;
  for (const link of document.querySelectorAll("#tabs a")) {
    if (link.dataset.tab === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (tab !== "settings") return;
  for (const name of SUBTABS) $(`settings-${name}`).hidden = name !== sub;
  for (const link of document.querySelectorAll(".subtabs a")) {
    if (link.dataset.sub === sub) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (outOfStep) return;
  if (sub === "exclusions") loadExclusions();
  if (sub === "quality") loadStatus();
  if (sub === "detail") loadDetail();
  if (sub === "methodology") loadMethodology();
}

// ---- Dashboard ---------------------------------------------------------------------

let activityRequest = 0;
let growthRequest = 0;

function figure(body, key) {
  return body && Array.isArray(body.metrics) ? body.metrics.find((m) => m.key === key) : null;
}

async function loadActivity() {
  const period = $("period-select").value;
  const requestId = ++activityRequest;
  for (const id of ["kpi-external-value", "kpi-submitting-value", "kpi-records-value"]) $(id).textContent = "—";
  $("kpi-external-sub").textContent = "";
  let all;
  let inPeriod;
  try {
    [all, inPeriod] = await Promise.all([
      v2("GET", "/admin/v2/overview?range=all"),
      period === "all" ? null : v2("GET", `/admin/v2/overview?range=${encodeURIComponent(period)}`),
    ]);
  } catch (e) {
    if (e instanceof SessionEnded || e instanceof OutOfStep) return;
    if (requestId === activityRequest) $("dash-unavailable").hidden = false;
    return;
  }
  if (requestId !== activityRequest) return;
  inPeriod = inPeriod || all;
  if (all.status !== 200 || inPeriod.status !== 200) {
    $("dash-unavailable").hidden = false;
    return;
  }
  $("dash-unavailable").hidden = true;
  $("dash-as-of").textContent = formatUtc(inPeriod.data.as_of);
  $("dash-stale").hidden = !inPeriod.data.stale;
  const allAccounts = figure(all.data, "accounts_registered");
  const newAccounts = figure(inPeriod.data, "accounts_registered");
  const submitting = figure(inPeriod.data, "accounts_submitting_records");
  const records = figure(inPeriod.data, "records_received");
  if (allAccounts) $("kpi-external-value").textContent = String(allAccounts.external);
  if (newAccounts && period !== "all") $("kpi-external-sub").textContent = `+${newAccounts.external} in the period`;
  if (submitting) {
    $("kpi-submitting-value").textContent = String(submitting.external);
    $("kpi-submitting-def").textContent = submitting.definition;
  }
  if (records) {
    $("kpi-records-value").textContent = String(records.external);
    $("kpi-records-def").textContent = records.definition;
  }
}

function periodLabel(start, bucket) {
  const date = new Date(`${start}T00:00:00Z`);
  const month = date.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return bucket === "month" ? month : `${date.getUTCDate()} ${month}`;
}

function renderSeries(container, metric, data) {
  const periods = Array.isArray(data.periods) ? data.periods : [];
  const bucket = data.bucket === "week" ? "week" : "month";
  const width = 640;
  const height = 200;
  const top = 26; // room for the value printed above the tallest bar
  const bottom = 28;
  const plot = height - top - bottom;
  const max = Math.max(1, ...periods.map((p) => Number(p.external) || 0));
  const slot = width / Math.max(1, periods.length);
  const barWidth = Math.max(4, slot * 0.6);
  const title = metric === "accounts_registered" ? "New External accounts" : "Records received from External accounts";
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": `chart-title-${metric}` });
  const titleNode = svg("title", { id: `chart-title-${metric}` });
  titleNode.textContent = `${title}, ${bucket === "month" ? "monthly" : "weekly"}. Figures are in the table below the chart.`;
  chart.append(titleNode);
  chart.append(svg("line", { x1: 0, y1: top + plot, x2: width, y2: top + plot, class: "axis" }));
  const labelEvery = periods.length > 13 ? 4 : 1;
  periods.forEach((p, index) => {
    const value = Number(p.external) || 0;
    const barHeight = Math.round((value / max) * plot);
    const x = index * slot + (slot - barWidth) / 2;
    const bar = svg("rect", {
      x: x.toFixed(1), y: top + plot - barHeight, width: barWidth.toFixed(1), height: Math.max(barHeight, value ? 1 : 0),
      class: `bar bar-${metric}${p.partial ? " partial" : ""}`,
    });
    bar.dataset.period = p.period_start;
    chart.append(bar);
    if (value > 0) {
      const count = svg("text", { x: (index * slot + slot / 2).toFixed(1), y: top + plot - Math.max(barHeight, 1) - 6, "text-anchor": "middle", class: "value" });
      count.textContent = String(value);
      count.dataset.period = p.period_start;
      chart.append(count);
    }
    if (index % labelEvery === 0 || p.partial) {
      const label = svg("text", { x: (index * slot + slot / 2).toFixed(1), y: height - 8, "text-anchor": "middle", class: "tick" });
      label.textContent = `${periodLabel(p.period_start, bucket)}${p.partial ? "*" : ""}`;
      chart.append(label);
    }
  });
  const table = el("table", "series-table");
  const head = el("tr");
  head.append(el("th", "", bucket === "month" ? "Month starting" : "Week starting"), el("th", "", "External"));
  table.append(el("thead"));
  table.tHead.append(head);
  const body = el("tbody");
  for (const p of periods) {
    const row = el("tr");
    row.dataset.period = p.period_start;
    row.append(el("td", "", p.partial ? `${p.period_start} — in progress` : p.period_start), el("td", "num", String(p.external)));
    body.append(row);
  }
  table.append(body);
  const details = el("details", "series-details");
  details.append(el("summary", "", "Show the figures"), table);
  const note = el("p", "muted", "* In progress — the current " + (bucket === "month" ? "month" : "week") + " is not complete, so its lower figure does not mean a decline.");
  container.replaceChildren(chart, note, details);
}

async function loadGrowth() {
  const bucket = $("growth-bucket").value === "week" ? "week" : "month";
  const periods = bucket === "week" ? 26 : 12;
  const requestId = ++growthRequest;
  const metrics = ["accounts_registered", "records_received"];
  for (const metric of metrics) document.querySelector(`#growth-${metric} .chart-body`).replaceChildren();
  let responses;
  try {
    responses = await Promise.all(metrics.map((metric) =>
      v2("GET", `/admin/v2/timeseries?metric=${metric}&bucket=${bucket}&periods=${periods}`)));
  } catch (e) {
    if (e instanceof SessionEnded || e instanceof OutOfStep) return;
    if (requestId === growthRequest) {
      for (const metric of metrics) document.querySelector(`#growth-${metric} .chart-body`).replaceChildren(el("p", "withheld", "Unavailable right now."));
    }
    return;
  }
  if (requestId !== growthRequest) return;
  metrics.forEach((metric, index) => {
    const container = document.querySelector(`#growth-${metric} .chart-body`);
    const r = responses[index];
    if (r.status !== 200 || !Array.isArray(r.data.periods)) {
      container.replaceChildren(el("p", "withheld", "Unavailable right now."));
      return;
    }
    renderSeries(container, metric, r.data);
  });
}

function withheldText(result, k, dimension) {
  const noun = { country: "profile country", sector: "profile sector", business_type: "profile business type" }[dimension];
  if (result.reason === "total_below_minimum") return `Withheld — fewer than ${k} External accounts in total.`;
  if (result.reason === "business_profiles_below_half") return "Withheld — fewer than half of External accounts have a business profile.";
  if (result.reason === "valid_codes_below_half") return `Withheld — fewer than half of External accounts have a valid ${noun} code.`;
  if (result.reason === "residual_unsafe") return "Withheld — the categories are too small to show or group safely.";
  return "Withheld.";
}

function renderBreakdown(panel, dimension, data) {
  const body = panel.querySelector(".breakdown-body");
  const statement = (data.statements || []).find((s) => /^(Country|Sector|Business type) is/.test(s));
  panel.querySelector(".dim-statement").textContent = statement || "";
  const result = data.result || {};
  if (result.status !== "published" || !Array.isArray(result.cells)) {
    const p = el("p", "withheld", withheldText(result, data.minimum_cell_size, dimension));
    p.dataset.reason = result.reason || "";
    body.replaceChildren(p);
    return;
  }
  const cells = dimension === "sector"
    ? [...result.cells].sort((left, right) => right.count - left.count
      || categoryLabel(dimension, left.category).localeCompare(categoryLabel(dimension, right.category), "en"))
    : result.cells;
  const max = Math.max(1, ...cells.map((c) => c.count));
  const list = el("div", "bars");
  for (const cell of cells) {
    const row = el("div", "bar-row");
    row.dataset.category = cell.category;
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = `${Math.round((cell.count / max) * 100)}%`;
    track.append(fill);
    row.append(el("span", "bar-label", categoryLabel(dimension, cell.category)), track, el("span", "bar-count", String(cell.count)));
    list.append(row);
  }
  const notes = [];
  if (result.cells.some((c) => c.category === "other")) notes.push(el("p", "muted", "Other combines two or more categories that are too small to show separately."));
  body.replaceChildren(list, ...notes, el("p", "muted", `Total External accounts: ${result.total}`));
}

let audienceRequest = 0;

async function loadAudience() {
  const requestId = ++audienceRequest;
  for (const dimension of DIMENSIONS) document.querySelector(`#aud-${dimension} .breakdown-body`).replaceChildren();
  let responses;
  try {
    responses = await Promise.all(DIMENSIONS.map((d) => v2("GET", `/admin/v2/breakdown?dimension=${d}`)));
  } catch (e) {
    if (e instanceof SessionEnded || e instanceof OutOfStep) return;
    if (requestId === audienceRequest) {
      for (const d of DIMENSIONS) document.querySelector(`#aud-${d} .breakdown-body`).replaceChildren(el("p", "withheld", "Unavailable right now."));
    }
    return;
  }
  if (requestId !== audienceRequest) return;
  DIMENSIONS.forEach((dimension, index) => {
    const panel = $(`aud-${dimension}`);
    const r = responses[index];
    if (r.status !== 200) {
      panel.querySelector(".breakdown-body").replaceChildren(el("p", "withheld", "Unavailable right now."));
      return;
    }
    renderBreakdown(panel, dimension, r.data);
  });
}

// Several actions reload these two panels; only the latest request may draw.
let exclusionStateRequest = 0;
async function loadExclusionState() {
  const requestId = ++exclusionStateRequest;
  let r;
  try {
    r = await v2("GET", "/admin/v2/exclusions");
  } catch (e) {
    if (e instanceof SessionEnded || e instanceof OutOfStep) return null;
    r = null;
  }
  if (requestId !== exclusionStateRequest) return null;
  const ok = r && r.status === 200 && r.data && r.data.accounts;
  const changed = ok ? (r.data.exclusions_last_changed ? formatUtc(r.data.exclusions_last_changed) : "never") : "—";
  $("dash-exclusions-changed").textContent = changed;
  for (const [id, value] of [
    ["count-total", ok ? r.data.accounts.total : null],
    ["count-excluded", ok ? r.data.accounts.excluded : null],
    ["count-external", ok ? r.data.accounts.external : null],
    ["count-created-since", ok ? r.data.accounts_created_since : null],
  ]) $(id).textContent = Number.isInteger(value) ? String(value) : "—";
  $("exclusions-changed-note").textContent = !ok
    ? "The exclusion counts could not be loaded."
    : r.data.exclusions_last_changed
      ? `Exclusions last changed ${changed}. Accounts are External unless you exclude them.`
      : "No exclusions have been made yet. Accounts are External unless you exclude them.";
  return ok ? r.data : null;
}

function loadDashboard() {
  if (outOfStep) return;
  loadActivity();
  loadGrowth();
  loadAudience();
  loadExclusionState();
}

// ---- Settings: data quality, operator detail, methodology --------------------------

let statusRequest = 0;
async function loadStatus() {
  const requestId = ++statusRequest;
  let r;
  try {
    r = await v2("GET", "/admin/v2/status");
  } catch (e) {
    if (e instanceof SessionEnded || e instanceof OutOfStep) return;
    r = null;
  }
  if (requestId !== statusRequest) return;
  const ok = r && r.status === 200;
  $("q-built-at").textContent = ok ? formatUtc(r.data.built_at) : "—";
  $("q-stale").textContent = ok ? (r.data.stale ? "Yes" : "No") : "—";
  $("q-last-attempt").textContent = ok ? formatUtc(r.data.last_attempt_at) : "—";
  $("q-last-failure").textContent = ok ? (r.data.last_failure_at ? formatUtc(r.data.last_failure_at) : "None") : "—";
  $("q-out-of-range").textContent = ok && Number.isInteger(r.data.out_of_range) ? String(r.data.out_of_range) : "—";
  const sectors = ok && r.data.sector_assignment && typeof r.data.sector_assignment === "object" ? r.data.sector_assignment : {};
  for (const [id, key] of [
    ["q-sector-catalog", "catalog"],
    ["q-sector-user", "user_selected"],
    ["q-sector-rule", "reviewed_rule"],
    ["q-sector-fallback", "fallback"],
    ["q-sector-mismatch", "catalog_mismatches"]
  ]) {
    $(id).textContent = Number.isInteger(sectors[key]) ? String(sectors[key]) : "—";
  }
}

let refreshBusy = false;

async function onRefreshGo() {
  if (refreshBusy) return;
  refreshBusy = true;
  $("refresh-confirm").hidden = true;
  $("refresh-button").disabled = true;
  const msg = $("refresh-message");
  msg.textContent = "Rebuilding…";
  let r;
  try {
    r = await v2("POST", "/admin/v2/refresh", undefined);
  } catch (e) {
    refreshBusy = false;
    $("refresh-button").disabled = false;
    if (e instanceof SessionEnded || e instanceof OutOfStep) return;
    msg.textContent = "Outcome unconfirmed — reload the status to see whether the figures were rebuilt.";
    return;
  }
  refreshBusy = false;
  $("refresh-button").disabled = false;
  if (r.status === 200 && r.data && r.data.rebuilt === true) {
    msg.textContent = `Rebuilt. Figures as of ${formatUtc(r.data.as_of || r.data.built_at)}.`;
    loadStatus();
    loadDashboard();
  } else if (r.status === 200 && r.data && r.data.reason === "in_progress") {
    msg.textContent = "Already rebuilding. Check again shortly.";
  } else if (r.status === 200 && r.data && r.data.reason === "superseded") {
    msg.textContent = "A newer change superseded this rebuild. Check again shortly.";
  } else if (r.status === 429) {
    msg.textContent = "Refresh limit reached (6 per hour).";
  } else {
    msg.textContent = "Rebuild failed.";
    loadStatus();
  }
}

let detailRequest = 0;

async function loadDetail() {
  const range = $("detail-range").value;
  const requestId = ++detailRequest;
  const body = $("detail-table").tBodies[0];
  body.replaceChildren();
  $("detail-unavailable").hidden = true;
  let r;
  try {
    r = await v2("GET", `/admin/v2/overview?range=${encodeURIComponent(range)}`);
  } catch (e) {
    if (e instanceof SessionEnded || e instanceof OutOfStep) return;
    if (requestId === detailRequest) $("detail-unavailable").hidden = false;
    return;
  }
  if (requestId !== detailRequest) return;
  if (r.status !== 200 || !Array.isArray(r.data.metrics)) {
    $("detail-unavailable").hidden = false;
    return;
  }
  for (const m of r.data.metrics) {
    const row = el("tr");
    row.dataset.metricKey = m.key;
    const name = el("th");
    name.scope = "row";
    name.append(el("span", "metric-name", m.name));
    if (m.point_in_time) name.append(el("span", "metric-scope", " · point-in-time"));
    row.append(name);
    for (const col of ["external", "excluded", "total"]) {
      const cell = el("td", "num", String(m[col]));
      cell.dataset.col = col;
      row.append(cell);
    }
    body.append(row);
  }
}

async function loadMethodology() {
  let overview;
  let breakdowns;
  try {
    [overview, ...breakdowns] = await Promise.all([
      v2("GET", "/admin/v2/overview?range=all"),
      ...DIMENSIONS.map((d) => v2("GET", `/admin/v2/breakdown?dimension=${d}`)),
    ]);
  } catch (e) {
    if (e instanceof SessionEnded || e instanceof OutOfStep) return;
    return;
  }
  const defs = $("method-definitions");
  defs.replaceChildren();
  if (overview.status === 200 && Array.isArray(overview.data.metrics)) {
    for (const m of overview.data.metrics) defs.append(el("dt", "", m.name), el("dd", "", m.definition));
  }
  const statements = new Set();
  for (const b of breakdowns) if (b.status === 200) (b.data.statements || []).forEach((s) => statements.add(s));
  $("method-statements").replaceChildren(...[...statements].map((s) => el("li", "", s)));
}

// ---- Settings: exclusions (owner tool) ---------------------------------------------
// One account at a time: preview with the phone number, then confirm. The number is
// sent in the preview request only and is never kept, shown or stored.

const ACTIONS = {
  EXCLUDE_TEST: { classification: "INTERNAL_TEST", reason: "OPERATOR_TEST_ACCOUNT" },
  EXCLUDE_DEMO: { classification: "DEMO", reason: "OPERATOR_DEMO_ACCOUNT" },
  EXCLUDE_ADMIN: { classification: "INTERNAL_TEST", reason: "OPERATOR_ADMIN_ACCOUNT" },
  RESTORE: { classification: null, reason: "CORRECTION" },
};
const REASON_TEXT = {
  OPERATOR_TEST_ACCOUNT: "Internal test account",
  OPERATOR_DEMO_ACCOUNT: "Demo account",
  OPERATOR_ADMIN_ACCOUNT: "Administrator's own app account",
  OWNER_CLASSIFIED_EXTERNAL: "Marked External",
  CORRECTION: "Correction",
};

function statusText(classification) {
  if (classification === "INTERNAL_TEST") return "Excluded — internal test";
  if (classification === "DEMO") return "Excluded — demo";
  return "External";
}

// Bumped by every new preview, cancel, expiry and session change: a response for
// an earlier round changes nothing.
let excludeRound = 0;
let pendingPreview = null; // { token, deadline, timer } for the preview on screen
let excludeBusy = false;   // a preview or confirmation request is in flight

function setExcludeBusy(busy) {
  excludeBusy = busy;
  $("exclude-preview").disabled = busy;
  $("exclude-confirm-button").disabled = busy;
  $("exclude-cancel").disabled = busy;
}

function dropPending() {
  if (pendingPreview && pendingPreview.timer) clearInterval(pendingPreview.timer);
  pendingPreview = null;
  $("exclude-confirm").hidden = true;
}

function resetExclusions() {
  excludeRound += 1;
  dropPending();
  setExcludeBusy(false);
  $("exclude-form").reset();
  $("exclude-message").textContent = "";
  $("exclude-unconfirmed").hidden = true;
}

function validPreview(data) {
  return Boolean(data && data.account && typeof data.confirmation_token === "string"
    && /^[0-9a-f]{64}$/.test(data.confirmation_token));
}

function tickPreview() {
  if (!pendingPreview) return;
  const left = pendingPreview.deadline - Date.now();
  if (left <= 0) {
    excludeRound += 1;
    dropPending();
    $("exclude-message").textContent = "This confirmation expired. Nothing was changed. Preview again.";
    return;
  }
  const seconds = Math.ceil(left / 1000);
  $("preview-countdown").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function showPreview(data) {
  $("preview-created").textContent = String(data.account.created_on ?? "—");
  $("preview-records").textContent = String(data.account.confirmed_records ?? "—");
  $("preview-current").textContent = statusText(data.current_classification);
  $("preview-target").textContent = statusText(data.target_classification);
  $("preview-reason").textContent = REASON_TEXT[data.reason_code] || String(data.reason_code);
  // A fresh preview shows the account's saved state, which settles any unconfirmed outcome.
  $("exclude-unconfirmed").hidden = true;
  $("exclude-message").textContent = "";
  pendingPreview = { token: data.confirmation_token, deadline: Date.now() + PREVIEW_LIFETIME_MS, timer: null };
  pendingPreview.timer = setInterval(tickPreview, 1000);
  tickPreview();
  $("exclude-confirm").hidden = false;
  $("exclude-confirm-button").focus();
}

async function onPreview(ev) {
  ev.preventDefault();
  if (excludeBusy || !ownerView) return;
  const msg = $("exclude-message");
  const phone = $("exclude-phone").value.trim();
  const action = ACTIONS[$("exclude-action").value];
  if (!phone || !action) {
    msg.textContent = "Enter the phone number and choose an action.";
    return;
  }
  // Sent once, in this request only; the field is emptied straight away.
  $("exclude-phone").value = "";
  dropPending();
  const round = ++excludeRound;
  setExcludeBusy(true);
  msg.textContent = "Looking up the account…";
  let r;
  try {
    r = await authed("POST", "/admin/classification/preview", {
      phone_number: phone,
      classification: action.classification,
      reason_code: action.reason,
    }, WRITE_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof SessionEnded || round !== excludeRound) return;
    setExcludeBusy(false);
    msg.textContent = "The lookup did not complete. Nothing was changed. Try again.";
    return;
  }
  if (round !== excludeRound) return;
  setExcludeBusy(false);
  if (r.status === 200 && validPreview(r.data)) {
    showPreview(r.data);
    return;
  }
  msg.textContent = r.status === 404
    ? "No account has exactly that number. Use the number as registered, with its country code."
    : r.status === 429
      ? "Too many lookups. Wait 15 minutes, then try again."
      : r.status === 400
        ? "That request was not accepted. Choose the action again."
        : "The lookup did not complete. Nothing was changed. Try again.";
}

function outcomeUnconfirmed() {
  $("exclude-message").textContent = "";
  $("exclude-unconfirmed").hidden = false;
  loadExclusionState();
}

async function onConfirm() {
  if (!pendingPreview || excludeBusy || !ownerView) return;
  const confirmation = pendingPreview.token;
  const round = excludeRound;
  // Single use: dropped before sending, so it can never be sent twice.
  dropPending();
  setExcludeBusy(true);
  const msg = $("exclude-message");
  msg.textContent = "Saving…";
  let r;
  try {
    r = await authed("POST", "/admin/classification/apply", { confirmation_token: confirmation }, WRITE_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof SessionEnded || round !== excludeRound) return;
    // Network failure or time limit: the server may have saved the change.
    setExcludeBusy(false);
    outcomeUnconfirmed();
    return;
  }
  if (round !== excludeRound) return;
  setExcludeBusy(false);
  if (r.status === 200 && r.data && r.data.applied === true) {
    msg.textContent = r.data.classification
      ? `Saved: ${statusText(r.data.classification)}. Figures update when they are next rebuilt.`
      : "Saved: External. Figures update when they are next rebuilt.";
    loadExclusionState();
    return;
  }
  if (r.status === 409) {
    msg.textContent = r.data && r.data.error === "state_changed"
      ? "The account's status changed since the preview. Nothing was changed. Preview again."
      : "This confirmation has expired or was already used. Preview again.";
    return;
  }
  if (r.status === 400 || r.status === 429) {
    msg.textContent = "The confirmation was not accepted. Nothing was changed. Preview again.";
    return;
  }
  outcomeUnconfirmed();
}

function onCancel() {
  if (excludeBusy) return;
  excludeRound += 1;
  dropPending();
  $("exclude-message").textContent = "Cancelled. Nothing was changed.";
}

async function loadExclusions() {
  await loadExclusionState();
}

// ---- Sign-in -------------------------------------------------------------------------

function scheduleExpiry() {
  if (expiryTimer) clearTimeout(expiryTimer);
  const ms = expiresAt ? new Date(expiresAt).getTime() - Date.now() : NaN;
  if (!Number.isFinite(ms)) return;
  expiryTimer = setTimeout(endSession, Math.max(0, Math.min(ms, 2147483647)));
}

async function onSubmit(ev) {
  ev.preventDefault();
  const email = $("signin-email").value.trim();
  const password = $("signin-password").value;
  const totp = $("signin-totp").value.trim();
  const err = $("signin-error");
  // Sign-in waits while an earlier sign-out is still being sent.
  if (logoutPending) return;
  if (!email || !password || !/^\d{6}$/.test(totp)) {
    err.textContent = "Enter your email, password and the 6-digit code.";
    return;
  }
  $("signin-submit").disabled = true;
  err.textContent = "";
  let r;
  try {
    r = await api("POST", "/admin/auth/login", { email, password, totp });
  } catch {
    r = null;
  }
  if (!r || r.status !== 200) $("signin-submit").disabled = false;
  if (!r) {
    err.textContent = "Sign-in failed. Check your details and try again.";
    return;
  }
  if (r.status !== 200 || !r.data || !r.data.token) {
    $("signin-submit").disabled = false;
    err.textContent = r.status === 400
      ? "Enter your email, password and the 6-digit code."
      : r.status === 429
        ? "Too many sign-in attempts. Wait 15 minutes, then try again."
        : "Sign-in failed. Check your details and try again.";
    return;
  }
  // A new session unlocks the page, so the old token is no longer kept.
  dropUnconfirmed();
  session += 1;
  token = r.data.token;
  expiresAt = r.data.expires_at || null;
  outOfStep = false;
  $("version-mismatch").hidden = true;
  $("signin-form").reset();
  scheduleExpiry();
  // Check the role before showing anything labelled owner only.
  err.textContent = "Checking access…";
  let me;
  try {
    me = await authed("GET", "/admin/auth/me");
  } catch (e) {
    if (e instanceof SessionEnded) return;
    me = null; // unknown role: the figure routes still refuse a non-owner (403)
  }
  err.textContent = "";
  const shown = me && me.status === 200 && me.data ? String(me.data.email || "") : "";
  if (me && me.status === 200 && me.data && me.data.role !== "owner") {
    showDenied(`This account (${shown}) does not have owner access. The admin figures are owner only, so none are shown.`);
    return;
  }
  ownerView = true;
  $("signin-screen").hidden = true;
  $("app-shell").hidden = false;
  $("admin-email").textContent = shown;
  $("session-expiry").textContent = expiresAt ? new Date(expiresAt).toLocaleString() : "";
  showRoute();
  loadDashboard();
}

// ---- Sign-out ------------------------------------------------------------------------

// A sign-out the server did not confirm. Its token is kept in memory only, and
// only so that sign-out can be retried while the page stays locked. It is
// dropped on a confirmed retry, on a new sign-in, or when it expires.
let unconfirmed = null;
// True while a logout request is in flight. Sign-in and retry wait for it, so a
// failed or timed-out logout is always reported on the locked page.
let logoutPending = false;

function holdForLogout(message) {
  logoutPending = true;
  $("signin-submit").disabled = true;
  $("signout-retry").disabled = true;
  $("signin-error").textContent = message;
}

function releaseAfterLogout() {
  logoutPending = false;
  $("signin-submit").disabled = false;
  $("signout-retry").disabled = false;
  $("signin-error").textContent = "";
}

function dropUnconfirmed() {
  if (unconfirmed && unconfirmed.timer) clearTimeout(unconfirmed.timer);
  unconfirmed = null;
  $("signout-retry").hidden = true;
  $("signout-retry").disabled = false;
}

function untilText(endsAt) {
  return endsAt ? ` It stops working by ${new Date(endsAt).toLocaleString()}.` : "";
}

async function sendLogout(bearer) {
  try {
    const r = await api("POST", "/admin/auth/logout", undefined, bearer, LOGOUT_TIMEOUT_MS);
    return r.status === 200;
  } catch {
    return false;
  }
}

function rememberUnconfirmed(ending, endsAt) {
  dropUnconfirmed();
  const entry = { token: ending, endsAt, timer: null };
  const ms = endsAt ? new Date(endsAt).getTime() - Date.now() : NaN;
  if (Number.isFinite(ms)) {
    entry.timer = setTimeout(() => {
      if (unconfirmed !== entry) return;
      dropUnconfirmed();
      $("signin-error").textContent = "The earlier session has now expired.";
    }, Math.max(0, Math.min(ms, 2147483647)));
  }
  unconfirmed = entry;
  $("signout-retry").hidden = false;
  $("signin-error").textContent =
    `Signed out on this device, but the server did not confirm the session was ended.${untilText(endsAt)}` +
    " Try sign-out again. If this page is reloaded, sign-out can no longer be retried.";
}

async function onSignout() {
  const ending = token;
  const endsAt = expiresAt;
  // Clear the page first; the server is told afterwards.
  showSignin("");
  if (!ending) return;
  holdForLogout("Ending the session on the server…");
  const confirmed = await sendLogout(ending);
  releaseAfterLogout();
  if (!confirmed) rememberUnconfirmed(ending, endsAt);
}

async function onRetrySignout() {
  const entry = unconfirmed;
  if (!entry || logoutPending) return;
  holdForLogout("Trying sign-out again…");
  const confirmed = await sendLogout(entry.token);
  const expired = unconfirmed !== entry;
  releaseAfterLogout();
  if (expired) {
    // It expired while the retry was in flight.
    $("signin-error").textContent = "The earlier session has now expired.";
    return;
  }
  if (confirmed) {
    dropUnconfirmed();
    $("signin-error").textContent = "Signed out. The server confirmed the session has ended.";
  } else {
    $("signin-error").textContent =
      `The server still did not confirm the session was ended.${untilText(entry.endsAt)} Try sign-out again.`;
  }
}

// ---- Wiring --------------------------------------------------------------------------

window.addEventListener("hashchange", () => {
  if (ownerView) showRoute();
});
$("period-select").addEventListener("change", () => { if (ownerView && !outOfStep) loadActivity(); });
$("growth-bucket").addEventListener("change", () => { if (ownerView && !outOfStep) loadGrowth(); });
$("detail-range").addEventListener("change", () => { if (ownerView && !outOfStep) loadDetail(); });
$("refresh-button").addEventListener("click", () => {
  if (!refreshBusy) { $("refresh-confirm").hidden = false; $("refresh-message").textContent = ""; }
});
$("refresh-cancel").addEventListener("click", () => { $("refresh-confirm").hidden = true; });
$("refresh-go").addEventListener("click", onRefreshGo);
$("exclude-form").addEventListener("submit", onPreview);
$("exclude-confirm-button").addEventListener("click", onConfirm);
$("exclude-cancel").addEventListener("click", onCancel);
$("signin-form").addEventListener("submit", onSubmit);
$("signout-button").addEventListener("click", onSignout);
$("signout-retry").addEventListener("click", onRetrySignout);
$("denied-signout").addEventListener("click", onSignout);
