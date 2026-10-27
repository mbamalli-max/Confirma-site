import * as config from "./config.js";

const API_BASE = config.API_BASE;
// How long a logout request may take before it counts as unconfirmed.
const LOGOUT_TIMEOUT_MS = Number(config.LOGOUT_TIMEOUT_MS) > 0 ? Number(config.LOGOUT_TIMEOUT_MS) : 10000;

let token = null;
let expiresAt = null;
let expiryTimer = null;
// Bumped on every sign-in and sign-out. A response that comes back after the
// session it was sent for has ended must not change the page.
let session = 0;

const $ = (id) => document.getElementById(id);
const COLS = ["external", "internal_demo", "unclassified", "total"];
const HEADS = ["External", "Internal / demo", "Unclassified", "Total"];
const RANGE_TEXT = { "30d": "Last 30 days", "90d": "Last 90 days", "12m": "Last 12 months", all: "All time" };

class SessionEnded extends Error {}

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

function clearFigures() {
  $("metric-grid").replaceChildren();
  $("as-of").textContent = "";
  $("admin-email").textContent = "";
  $("session-expiry").textContent = "";
  $("provisional-banner").textContent = "";
  $("provisional-banner").hidden = true;
  $("stale-note").hidden = true;
  $("metrics-unavailable").hidden = true;
}

function showSignin(message) {
  session += 1;
  token = null;
  expiresAt = null;
  if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = null; }
  clearFigures();
  $("overview-screen").hidden = true;
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
  session += 1; // anything still in flight for the overview is ignored
  clearFigures();
  $("signin-screen").hidden = true;
  $("overview-screen").hidden = true;
  $("denied-screen").hidden = false;
  $("denied-message").textContent = message;
}

async function authed(method, path) {
  const mine = session;
  let r;
  try {
    r = await api(method, path);
  } catch (e) {
    // A network failure from an ended session must not change the page either.
    if (mine !== session) throw new SessionEnded();
    throw e;
  }
  // Sent for a session that has since ended: ignore it, whatever it says.
  if (mine !== session) throw new SessionEnded();
  if (r.status === 401) { endSession(); throw new SessionEnded(); }
  if (r.status === 403) {
    showDenied("The server refused this account access to the Overview. No figures are shown.");
    throw new SessionEnded();
  }
  return r;
}

// "2026-10-27T04:10:00.000Z" -> "2026-10-27 04:10 UTC"; anything unexpected is shown as sent.
function formatUtc(value) {
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? `${text.slice(0, 10)} ${text.slice(11, 16)} UTC` : text;
}

function scopeText(metric, range) {
  if (metric.point_in_time) return "Point-in-time — the range does not apply";
  return RANGE_TEXT[range] || String(range);
}

function renderTile(metric, range) {
  const art = document.createElement("article");
  art.className = "metric-tile";
  art.dataset.metricKey = String(metric.key);
  const h = document.createElement("h2");
  h.className = "metric-name";
  h.textContent = metric.name;
  const def = document.createElement("p");
  def.className = "metric-definition";
  def.textContent = metric.definition;
  const scope = document.createElement("p");
  scope.className = "metric-scope";
  scope.textContent = scopeText(metric, range);
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  HEADS.forEach((t) => { const th = document.createElement("th"); th.scope = "col"; th.textContent = t; hr.append(th); });
  thead.append(hr);
  const tbody = document.createElement("tbody");
  const br = document.createElement("tr");
  COLS.forEach((c) => {
    const td = document.createElement("td");
    td.dataset.col = c;
    const v = metric[c];
    td.textContent = v === null || v === undefined ? "—" : String(v);
    br.append(td);
  });
  tbody.append(br);
  table.append(thead, tbody);
  art.append(h, def, scope, table);
  return art;
}

let metricsRequest = 0;

async function loadMetrics() {
  const range = $("range-select").value;
  const requestId = ++metricsRequest;
  const grid = $("metric-grid");
  // Remove the previous range's figures before asking for the new ones, so they
  // can never sit under a range they do not belong to.
  grid.replaceChildren();
  $("stale-note").hidden = true;
  $("as-of").textContent = "";
  $("metrics-unavailable").hidden = true;
  let r;
  try {
    r = await authed("GET", `/admin/metrics/overview?range=${encodeURIComponent(range)}`);
  } catch (e) {
    if (e instanceof SessionEnded) return;
    if (requestId === metricsRequest) $("metrics-unavailable").hidden = false;
    return;
  }
  // A newer range request has started; only the latest one may draw figures.
  if (requestId !== metricsRequest) return;
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.metrics)) {
    $("metrics-unavailable").hidden = false;
    return;
  }
  $("metrics-unavailable").hidden = true;
  $("as-of").textContent = r.data.as_of ? formatUtc(r.data.as_of) : "";
  $("stale-note").hidden = !r.data.stale;
  r.data.metrics.forEach((m) => grid.append(renderTile(m, r.data.range || range)));
}

async function loadSummary() {
  const banner = $("provisional-banner");
  let r;
  try {
    r = await authed("GET", "/admin/classification/summary");
  } catch (e) {
    if (e instanceof SessionEnded) return;
    r = null;
  }
  const raw = r && r.status === 200 && r.data && r.data.accounts ? r.data.accounts.unclassified : undefined;
  const n = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
  if (n === null) {
    // Without a count the figures cannot be shown as final: warn rather than hide the warning.
    banner.textContent = "PROVISIONAL — the unclassified account count could not be loaded";
    banner.hidden = false;
  } else if (n > 0) {
    banner.textContent = `PROVISIONAL — ${n} ${n === 1 ? "account" : "accounts"} unclassified`;
    banner.hidden = false;
  } else {
    banner.textContent = "";
    banner.hidden = true;
  }
}

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
  $("signin-form").reset();
  scheduleExpiry();
  // Check the role before showing anything labelled owner only.
  err.textContent = "Checking access…";
  let me;
  try {
    me = await authed("GET", "/admin/auth/me");
  } catch (e) {
    if (e instanceof SessionEnded) return;
    me = null; // unknown role: the figures routes still refuse a non-owner (403)
  }
  err.textContent = "";
  const shown = me && me.status === 200 && me.data ? String(me.data.email || "") : "";
  if (me && me.status === 200 && me.data && me.data.role !== "owner") {
    showDenied(`This account (${shown}) does not have owner access. The Overview is owner only, so no figures are shown.`);
    return;
  }
  $("signin-screen").hidden = true;
  $("overview-screen").hidden = false;
  $("admin-email").textContent = shown;
  $("session-expiry").textContent = expiresAt ? new Date(expiresAt).toLocaleString() : "";
  await Promise.all([loadSummary(), loadMetrics()]);
}

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

$("signin-form").addEventListener("submit", onSubmit);
$("signout-button").addEventListener("click", onSignout);
$("signout-retry").addEventListener("click", onRetrySignout);
$("denied-signout").addEventListener("click", onSignout);
$("range-select").addEventListener("change", () => {
  if (!token) return;
  loadMetrics();
});
