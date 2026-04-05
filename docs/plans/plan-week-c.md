# plan-week-c — Attestation Service + vt_id + Verification Portal
**Date:** 2026-03-27
**Depends on:** plan-week-b.md (server running, JWT auth working, sync working)

---

## Goal

A loan officer scans a QR code from a user's Confirma export.
The portal returns `VALID`. This is the first moment the product thesis is fully demonstrable.

---

## Non-Negotiables

- `vt_id` must be 128-bit random hex — never sequential, never guessable
- Attestation payload must be HMAC-signed by the server using `SERVER_RECEIPT_SECRET`
- `GET /verify/:vt_id` must be public (no auth), rate-limited, return NO PII
- Confirmation flow is never gated by attestation — ledger writes remain free and local-first
- PWA export language only upgrades to "bank-verifiable" after this endpoint is live

---

## Schema Addition

Add to `server/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS attestations (
  vt_id            TEXT PRIMARY KEY,
  device_identity  TEXT NOT NULL REFERENCES device_identities(device_identity),
  phone_number     TEXT NOT NULL REFERENCES users(phone_number),
  ledger_root_hash TEXT NOT NULL,
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  entry_count      INTEGER NOT NULL,
  server_signature TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'VALID',
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attestations_device
  ON attestations (device_identity, issued_at DESC);
```

Run against Railway:
```bash
cd server
node -e "
import('./src/db.js').then(({ query }) =>
  query(\`CREATE TABLE IF NOT EXISTS attestations (
    vt_id TEXT PRIMARY KEY,
    device_identity TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    ledger_root_hash TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    entry_count INTEGER NOT NULL,
    server_signature TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'VALID',
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )\`).then(() => { console.log('done'); process.exit(0); })
)
"
```

---

## Server Routes

### POST /attest

**File:** `server/src/routes/attest.js`
**Auth:** JWT Bearer token required.

**Request body:**
```json
{
  "device_identity": "<32-char hex>",
  "window_days": 30
}
```

**Logic (in order):**
1. Authenticate JWT, extract `phone_number`
2. Validate `device_identity` belongs to this `phone_number` — `SELECT phone_number FROM device_identities WHERE device_identity = $1` → reject 403 if mismatch
3. Check `status = 'ACTIVE'` — reject 403 with `"Device is not active"` if FORKED or REVOKED
4. Query `ledger_entries` WHERE `device_identity = $1 AND confirmed_at >= NOW() - ($2 || ' days')::interval ORDER BY entry_id ASC`
5. If zero entries → `400 { error: "No entries in this window" }`
6. `ledger_root_hash` = `entry_hash` of the last row returned
7. `window_start` = `confirmed_at` of the first row; `window_end` = `confirmed_at` of the last row
8. `vt_id` = `crypto.randomBytes(16).toString("hex")`
9. `server_signature` = `HMAC-SHA256(SERVER_RECEIPT_SECRET, [vt_id, device_identity, ledger_root_hash, window_start.toISOString(), window_end.toISOString()].join("||"))`
10. INSERT into `attestations`
11. Return:

```json
{
  "ok": true,
  "vt_id": "a3f1c8d200112233445566778899aabb",
  "ledger_root_hash": "<64-char hex>",
  "window_start": "2026-01-01T00:00:00.000Z",
  "window_end": "2026-03-27T00:00:00.000Z",
  "entry_count": 47,
  "issued_at": "2026-03-27T22:00:00.000Z",
  "verify_url": "https://confirma-site.vercel.app/verify/a3f1c8d200112233445566778899aabb"
}
```

---

### GET /verify/:vt_id

**Auth:** None (public endpoint).
**Rate limit:** 100 requests/minute per IP via `@fastify/rate-limit`.

**Logic:**
1. Look up `vt_id` in `attestations` — if not found → `{ "status": "UNKNOWN" }`
2. Re-verify `server_signature` using same HMAC logic — if tampered → `{ "status": "INVALID" }`
3. Look up `key_rotation_events` count for `device_identity`
4. Look up `device_identities.status` for current fork/revoke state
5. Derive `fork_status`: `NORMAL` if device is ACTIVE, else `FORKED` or `REVOKED`

**Response — NO PII (no phone number, device_identity truncated to 8 chars):**
```json
{
  "status": "VALID",
  "attested_at": "2026-03-27T22:00:00.000Z",
  "device_fingerprint": "a3f1c8d2",
  "ledger_root_hash": "<64-char hex>",
  "window_start": "2026-01-01T00:00:00.000Z",
  "window_end": "2026-03-27T00:00:00.000Z",
  "entry_count": 47,
  "key_rotation_events": 0,
  "fork_status": "NORMAL"
}
```

---

## Register Routes in server.js

In `server/server.js`, add after existing route registrations:

```js
import { registerAttestRoutes } from "./src/routes/attest.js";
// ...
await registerAttestRoutes(app);
```

---

## npm Package

```bash
cd server && npm install @fastify/rate-limit
```

---

## PWA Export Changes (`app-v3/app.js`)

**Find:** the export button handler (search `export-button-v2` or `exportLedger`).

**Changes:**
1. Before generating export output, call `POST /attest` if `state.authToken` and `state.deviceIdentity` are set:
   ```js
   const attestation = await postJson(state.syncApiBaseUrl, "/attest", {
     device_identity: state.deviceIdentity,
     window_days: 90
   }, state.authToken).catch(() => null);
   ```
2. If attestation succeeds, save to IndexedDB:
   ```js
   await saveSetting("last_vt_id", attestation.vt_id);
   await saveSetting("last_verify_url", attestation.verify_url);
   ```
3. In the export text/JSON, add `vt_id` and `verify_url` fields
4. Generate QR code using qrcode.js:
   ```js
   const qrDataUrl = await QRCode.toDataURL(attestation.verify_url);
   ```
   Include `qrDataUrl` in the export (as an `<img>` tag or data URL)
5. Update attestation language in export from:
   `"Device-signed on this device. Server attestation coming."`
   to:
   `"Device-signed and server-attested. Verify at " + attestation.verify_url`

**Add to `app-v3/index.html`** (before closing `</body>`):
```html
<script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
```

---

## Verification Portal (`website-v2/verify.html`)

Static single-page app. Matches Forest & Parchment design.

**Behavior:**
- Extract `vt_id` from `window.location.pathname` (last path segment)
- On load: `fetch("https://[SERVER_URL]/verify/" + vt_id)`
- Render status badge: VALID = `#52B788` green, FORKED/REVOKED = `#B42318` red, UNKNOWN = `#6B7C6B` grey
- Show: attested_at (formatted), window range, entry count, key rotation count, fork status
- If network error: show "Unable to reach verification server"

**Add to `vercel.json`:**
```json
{ "source": "/verify/:vt_id", "destination": "/verify.html" }
```

---

## Implementation Order

1. `npm install @fastify/rate-limit` in server/
2. Run `attestations` table migration on Railway
3. Write `server/src/routes/attest.js`
4. Register in `server/server.js`
5. Test `POST /attest` → confirm `vt_id` returned
6. Test `GET /verify/:vt_id` → confirm `VALID` with no PII
7. Test `GET /verify/nonexistent` → confirm `UNKNOWN`
8. Add qrcode.js to `app-v3/index.html`
9. Update export function in `app-v3/app.js`
10. Create `website-v2/verify.html`
11. Update `vercel.json`
12. Deploy — confirm full loop: confirm → sync → attest → QR → portal VALID

---

## Week C Deliverable Checklist

- [ ] `POST /attest` returns `vt_id` for authenticated, synced, ACTIVE device
- [ ] `POST /attest` rejects FORKED device with 403
- [ ] `GET /verify/:vt_id` returns `VALID` with no PII (phone number absent, device_identity truncated)
- [ ] `GET /verify/:vt_id` rate-limited (100 req/min)
- [ ] `GET /verify/nonexistent` returns `{ "status": "UNKNOWN" }`
- [ ] PWA export includes `vt_id` field, `verify_url`, and QR code image
- [ ] Export language says "bank-verifiable" / "server-attested"
- [ ] `verify.html` renders VALID correctly (green badge, metadata)
- [ ] `verify.html` renders UNKNOWN correctly (grey badge)
- [ ] `vercel.json` has `/verify/:vt_id` route
- [ ] All existing sync and auth routes still respond correctly (no regression)
