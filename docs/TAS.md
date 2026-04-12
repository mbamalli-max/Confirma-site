# Technical Architecture Specification (TAS)
**Project:** Konfirmata
**Patent:** USPTO Provisional 63/987,858
**Version:** 3.1
**Date:** 2026-04-11

---

## §1. System Overview

Konfirmata is a financial identity infrastructure that converts informal business activity into cryptographically verifiable ledger records. The output is a bank-usable identity: a signed, server-attested transaction history that a loan officer can verify independently.

**Core thesis:** Ledger formation is always free. Payment gates only verified PDF export.

### Stack

| Layer | Technology | Host |
|---|---|---|
| PWA | Vanilla JS, IndexedDB, WebCrypto P-256 | Vercel (`/app`) |
| Server | Fastify/Node.js, ESM | Railway |
| Database | PostgreSQL | Railway |
| Marketing site | Static HTML/CSS | Vercel (`/`) |
| Verification portal | Static page | Vercel (`/verify/:vt_id`) |
| Email delivery | Resend | SaaS |
| SMS delivery | Termii (stub) | SaaS |
| Payment processing | Paystack | SaaS (NG only) |

---

## §2. Design System — Forest & Parchment

| Token | Value | Usage |
|---|---|---|
| Primary dark | `#1B2F1F` | Topbar, primary buttons, headings |
| Primary mid | `#2D6A4F` | Secondary emphasis |
| Primary light | `#52B788` | Sales chart bars, success states |
| CTA orange | `#E8944A` | Expenses chart bars, CTAs |
| Background | `#F5F0E8` | Warm parchment, page background |
| Error red | `#B42318` | Error states, FORKED/REVOKED badge |
| Muted text | `#6B7C6B` | Disclaimers, secondary labels |
| Heading font | Calistoga (Google Fonts) | H1, H2 |
| Body font | Inter (Google Fonts) | All body text |

Design reference: `website-v2/get-the-app.html`

---

## §3. Protected Functions — Absolute Constraint

These form the integrity core. No code outside them may write to the IndexedDB `records` store or call `appendLedgerRecord()` directly. Violating this causes ledger drift — a security failure.

| Function | File | Rule |
|---|---|---|
| `confirmationTransition()` | `app-v3/app.js` | Only entry point to ledger writes |
| `appendLedgerRecord()` | `app-v3/app.js` | The ledger write itself |
| `getRecords()` | `app-v3/app.js` | Canonical read path |
| IndexedDB `records` store `.add()` | `app-v3/app.js` | Never called from outside `confirmationTransition` |

Payment, sync, attestation, and export code must treat the ledger as read-only.

---

## §4. PWA Architecture

### 4.1 File Layout

```
app-v3/
├── index.html          # Shell, all screens, CDN imports (Chart.js, QRCode)
├── app.js              # All state, UI, ledger, crypto, sync, export logic
├── styles.css          # Forest & Parchment design system
├── syncWorker.js       # HTTP client (postJson, requestOtpCode, verifyOtpCode, syncQueuedEntries)
├── sw.js               # Service worker — cache-first strategy, SKIP_WAITING pattern
├── manifest.json       # PWA manifest (name, icons, start_url: /app)
└── icons/
    ├── icon.svg
    └── icon-mask.svg
```

Served at `/app` via Vercel `routes` config pointing to `app-v3/index.html`.
Base href set to `/app/` so relative asset paths resolve correctly.

### 4.2 Screen Flow

```
Onboarding (6 steps) → Capture → Confirm → Capture
                                      ↓
                              Dashboard / History / Settings / Export
                                                        ↓
                                               OTP screen (phone verify)
```

Navigation via bottom tab bar: Record | Dashboard | History | Settings | Export

### 4.3 State Management

All mutable state lives in `state` object in `app.js`. Persisted to IndexedDB:

**`settings` store** (key-value):
- `auth_token` — JWT string
- `auth_token_expires_at` — ISO timestamp
- `device_identity` — first 32 hex chars of SHA-256(public_key_jwk)
- `device_public_key` — JWK JSON string
- `last_vt_id` — most recent attestation ID
- `last_verify_url` — most recent verification URL
- `auth_phone_country` — phone country code (for dial prefix)
- `last_sync_at` — ISO timestamp
- `last_sync_receipt` — HMAC receipt from last sync

**`profile` store** (key-value, keyed by `"profile"`):
- `phone_number` — E.164 format
- `country` — ISO alpha-2 (phone_country semantically)
- `operating_region` — ISO alpha-2 (capability and currency source)
- `language` — BCP-47 tag (default `"en"`)
- `display_name` — user/business name
- `business_name` — same as display_name
- `business_type_id` — e.g. `"ng_market_trader"`
- `sector_id` — e.g. `"trade_retail"`
- `preferred_labels` — array of label display names
- `identity_status` — `"unverified"` | `"verified_local"` | `"verified_server"`
- `identity_anchor` — phone number used as OTP anchor
- `email` — optional recovery email
- `region` — free text state/city
- `birth_year` — optional integer
- `gender` — optional string

**`records` store** (keyPath: `"id"`, autoIncrement: false):
- Full ledger entry objects (see §4.6 for schema)
- Append-only. Never mutated after append except `evidence_level` upgrade.

**`sync_queue` store** (keyPath: `"queue_id"`, autoIncrement: true):
- Pending entries awaiting server sync

**`anomaly_log` store** (keyPath: `"id"`, autoIncrement: true):
- Detected anomalies with `reviewed` boolean

**`usage` store** (keyPath: `"normalized_label"`):
- Per-label usage frequency for ranking

**`customLabels` store** (keyPath: `"id"`):
- User-created custom labels

**`voice_corrections` store** (keyPath: `"raw"`):
- `raw` — original voice transcript fragment (primary key)
- `corrected` — user-provided replacement
- `count` — times this correction has been applied (usage frequency)
- `created_at` — Unix ms timestamp

### 4.4 Global Availability Model

Three independent dimensions (see PRD §3 for full spec):
- `phone_country` — from phone prefix — governs dial codes only
- `operating_region` — user-selected at onboarding — governs currency, capabilities
- `language` — user-selected in Settings — governs UI locale and voice

**Onboarding steps 1 and 2 are separate country selectors, both implemented as searchable input + filtered list (not visual grids).**
Step 1 sets `phone_country` — pre-populated from `Intl.DateTimeFormat().resolvedOptions().locale` region segment (e.g. `en-NG` → Nigeria). User can override.
Step 2 sets `operating_region`. They may differ.

**`REGION_CURRENCY_MAP`** maps ISO alpha-2 → ISO 4217 currency code.
**`PAID_REPORT_REGIONS`** is a `Set` — currently `new Set(["NG"])`.
**`supportsPaidReports(region)`** returns `PAID_REPORT_REGIONS.has(region)`.
**`getActiveCurrency()`** returns `getCurrencyForRegion(state.profile?.operating_region || state.profile?.country)`.

### 4.5 Capability Separation

Country selection **must not** infer payment availability, report eligibility, or feature access.
Capability flags are derived exclusively from `operating_region`.

```js
if (operating_region !== "NG") {
  hidePaystackTiers();
  enableFreeExportOnly();
  // Show: "Some features are not yet available in your region"
}
```

### 4.6 Ledger Entry Schema (IndexedDB)

```js
{
  // Identity
  id: Number,                      // Auto-incrementing per device, starts at 1
  transaction_type: String,        // sale | purchase | payment | receipt | reversal | transfer_in | transfer_out
  label: String,                   // Display label
  normalized_label: String,        // Lowercase, searchable
  amount_minor: Number,            // Integer, minor units (kobo or cents)
  currency: String,                // ISO 4217 from operating_region
  counterparty: String,            // Optional
  source_account: String,          // Transfer only
  destination_account: String,     // Transfer only
  reversed_entry_hash: String,     // Reversal only
  reversed_transaction_type: String, // Reversal only
  input_mode: String,              // voice | text | visual | reversal
  confirmation_state: String,      // confirmed (always by append time)
  business_type_id: String,
  sector_id: String,
  country: String,                 // operating_region at time of record

  // Cryptographic
  confirmed_at: Number,            // Unix timestamp seconds
  prev_entry_hash: String,         // entry_hash of prior record, or "0".repeat(64)
  entry_hash: String,              // SHA-256 of canonical string
  signature: String,               // base64 IEEE P1363 ECDSA signature, or null
  public_key_fingerprint: String,  // first 16 hex chars of SHA-256(canonical_jwk)
  evidence_level: String,          // self_reported | device_signed | server_attested | corroborated
}
```

### 4.7 Canonical Signing String

Used for both `entry_hash` computation and ECDSA signing:

```
{transaction_type}|{label}|{amount_minor}|{currency}|{counterparty}|
{business_type_id}|{country}|{source_account}|{destination_account}|
{reversed_entry_hash}|{reversed_transaction_type}|{confirmed_at}|{prev_entry_hash}
```

Missing optional fields represented as empty string. Pipe `|` separator.

### 4.8 WebCrypto Operations

**Keypair generation:**
```js
const keyPair = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  false,          // non-extractable — private key cannot be exported (XSS protection)
  ["sign", "verify"]
);
// Public key can still be exported: crypto.subtle.exportKey("jwk", keyPair.publicKey)
```

**Public key canonicalization:**
```js
const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const canonical = JSON.stringify({
  key_ops: jwk.key_ops || ["verify"],
  ext: Boolean(jwk.ext),
  kty: jwk.kty,
  crv: jwk.crv,
  x: jwk.x,
  y: jwk.y
});
```

**Device identity derivation:**
```js
const hash = await sha256(canonicalJwkString);
const device_identity = hash.slice(0, 32);       // 32 hex chars = 16 bytes
const public_key_fingerprint = hash.slice(0, 16); // 16 hex chars = 8 bytes
```

**Entry signing:**
```js
const signatureBuffer = await crypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  privateKey,
  hexToBytes(entryHash)
);
const signature = bytesToBase64(new Uint8Array(signatureBuffer)); // IEEE P1363 (raw r||s)
```

### 4.9 OTP Flow

1. User enters phone number
2. `requestOtpCode()` → `POST /auth/otp/request`
3. Phone normalized from `phone_country`: NG `08099840666` → `+2348099840666`, US `2678867271` → `+12678867271`
4. Server rate-checks (5/hr), generates 6-digit code, stores `SHA-256("{phone}:{code}")` with TTL
5. If `ALLOW_DEV_OTP=true`: `dev_code` returned in response (shown in UI helper text)
6. If production: code delivered via email (Resend) or SMS (Termii, when enabled)
7. User enters code → `POST /auth/otp/verify` → JWT `auth_token` returned
8. Client saves token + expiry to IndexedDB settings
9. `isAuthTokenValid()` used before all auth-requiring API calls
10. On success: keypair generated, `identity_status = "verified_server"`, first sync queued

### 4.10 Sync Flow

1. Entry confirmed via `confirmationTransition()` → signed → added to `sync_queue`
2. `flushSyncQueue()` called on: app load, post-confirmation, `window.online` event
3. `POST /sync/entries` with Bearer JWT + array of signed entries (batch up to 25)
4. Server verifies signatures, checks hash chain, detects forks, issues HMAC receipt
5. On success: remove from queue, upgrade `evidence_level` to `server_attested`, save receipt
6. On `409 FORKED`: device marked FORKED locally, sync permanently blocked
7. On `401`: prompt re-authentication

### 4.11 Export Flow

**Free text:**
1. User taps Export → `generateExport()` called
2. All records loaded from IndexedDB
3. Build header (metadata), rows (records), evidence summary, footer
4. Download as `.txt` Blob

**Paid PDF:**
1. Paystack payment confirmed → webhook → `POST /payment/generate-pdf` (internal)
2. Server fetches ledger entries for window, generates attestation
3. `buildVerifiedReportPdf()` renders PDF via pdfkit
4. PDF emailed via Resend, also returned in response

### 4.12 Service Worker

**Cache name:** `confirma-cache-v3`

**Cached files:**
- `/app/index.html`
- `/app/app.js`
- `/app/styles.css`
- `/app/syncWorker.js`
- `/app/manifest.json`
- `/app/icons/icon.svg`

**Install:** Cache all files. Does NOT call `skipWaiting()` immediately.

**Message listener:**
```js
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
```

**Activate:** Delete old cache names, claim clients.

**Fetch:** Cache-first for navigation (returns `index.html`), cache-first for all assets.

**Update flow:**
1. New SW detected → `registration.waiting` exists
2. UI shows update banner (`sw-update-banner`)
3. User clicks "Update" → `registration.waiting.postMessage({ type: "SKIP_WAITING" })`
4. `controllerchange` event fires → `window.location.reload()`

### 4.13 Voice Input System

#### Natural Language Parsing

Function: `parseNaturalTransaction(input)` (~line 4129 in `app.js`)

Parses free-text or voice transcripts into structured transaction fields before populating the capture form.

Supported patterns (regex):

| Phrase pattern | Inferred type | Extracted fields |
|---|---|---|
| "sold [item] for [amount]" | `sale` (income) | label: item, amount |
| "sell [item] for [amount]" | `sale` (income) | label: item, amount |
| "bought [item] for [amount]" | `purchase` (expense) | label: item, amount |
| "received [amount] from [party]" | `receipt` (income) | amount, counterparty: party |
| "paid [amount] to [party]" | `payment` (expense) | amount, counterparty: party |

Amount normalization: strips currency symbols (₦, $, NGN, USD), removes commas, converts k-suffixes (`"75k"` → `75000`).

Applied after `applyVoiceCorrections()` and before field population.

#### Voice Locale

Function: `getVoiceLocale()` (~line 5740 in `app.js`)

Returns the BCP-47 language tag for `SpeechRecognition.lang`:

| Condition | Locale returned |
|---|---|
| `operating_region = "NG"` (non-Safari) | `"en-NG"` |
| Safari (any region) | `"en-US"` — Safari workaround: `en-NG` causes recognition failure on iOS |
| All others | `"en-US"` |

#### Voice Correction System

Core functions in `app.js`:

| Function | ~Line | Description |
|---|---|---|
| `getVoiceCorrectionsStore(mode)` | 2577 | Opens `voice_corrections` IndexedDB store in given mode |
| `getVoiceCorrections()` | 2581 | Returns all corrections sorted by `count` descending |
| `applyVoiceCorrections(transcript)` | 2605 | Applies all corrections to a raw transcript string |
| `applyVoiceCorrectionEntry(t, raw, corrected)` | 2599 | Applies one correction via word-boundary regex |
| `saveVoiceCorrection(raw, corrected)` | 2622 | Upserts correction, increments `count` |
| `deleteVoiceCorrection(raw)` | 2648 | Removes correction by `raw` primary key |
| `renderVoiceCorrectionsSettings()` | 2662 | Renders Settings panel UI with correction list |

**Voice pipeline order:**
1. `SpeechRecognition` → raw transcript
2. `applyVoiceCorrections(raw)` → corrected transcript
3. `parseNaturalTransaction(corrected)` → structured fields
4. User reviews in capture form, can edit manually
5. If user edit differs from raw: `saveVoiceCorrection(raw, userEdit)` — correction stored

**Isolation:** Not synced. Not backed up. Cleared on IndexedDB reset.

---

## §5. Server Architecture

### 5.1 Runtime

- **Framework:** Fastify 5.x with `@fastify/cors`, `@fastify/rate-limit`
- **Entry point:** `server/server.js`
- **Port:** `process.env.PORT || 8080`
- **Host:** `0.0.0.0`
- **DB driver:** `pg` (PostgreSQL pool)
- **SSL:** `DATABASE_SSL=true` for Railway

### 5.2 Route Table

| Method | Route | Auth | Rate limit | Purpose |
|---|---|---|---|---|
| `GET` | `/health` | None | None | Liveness — returns `{ ok: true }` |
| `POST` | `/auth/otp/request` | None | 5/hr per phone | Request OTP, email or SMS delivery |
| `POST` | `/auth/otp/verify` | None | 5 failures/15min | Verify OTP → JWT auth_token |
| `POST` | `/sync/entries` | Bearer JWT | — | Upload signed entries, fork detection |
| `POST` | `/identity/rotate` | Bearer JWT | — | OTP-verified key rotation |
| `POST` | `/identity/revoke` | Bearer JWT | — | Revoke a device identity |
| `POST` | `/attest` | Bearer JWT | — | Issue vt_id attestation certificate |
| `GET` | `/verify/:vt_id` | None | 100/min per IP | Public verification endpoint |
| `GET` | `/profile` | Bearer JWT | — | Fetch user profile |
| `POST` | `/profile` | Bearer JWT | — | Upsert user profile |
| `GET` | `/devices` | Bearer JWT | — | List devices for account |
| `POST` | `/payment/webhook` | Paystack HMAC-SHA512 | — | Paystack charge.success handler |
| `POST` | `/payment/generate-pdf` | Bearer JWT | — | Generate server-side verified PDF |

### 5.3 Database Schema

```sql
-- Users (one per phone number)
CREATE TABLE users (
  phone_number TEXT PRIMARY KEY,
  email TEXT,
  email_verified BOOLEAN DEFAULT FALSE,
  phone_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Device identities (one per keypair)
CREATE TABLE device_identities (
  device_identity TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,                -- JWK JSON string
  phone_number TEXT NOT NULL REFERENCES users(phone_number),
  status TEXT DEFAULT 'ACTIVE',           -- ACTIVE | ROTATED | FORKED | REVOKED
  rotated_to TEXT,                        -- new device_identity after rotation
  revoked_at TIMESTAMPTZ,                 -- set on revocation
  receipt_counter BIGINT DEFAULT 0,       -- increments per sync
  last_synced_entry_id BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ledger entries (append-only)
CREATE TABLE ledger_entries (
  device_identity TEXT NOT NULL,
  entry_id BIGINT NOT NULL,
  entry_hash TEXT NOT NULL,
  prev_entry_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  public_key_fingerprint TEXT,
  confirmed_at TIMESTAMPTZ NOT NULL,
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  payload JSONB NOT NULL,                 -- full record object (denormalized)
  evidence_level VARCHAR(20) DEFAULT 'self_reported',
  corroboration_flags JSONB DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ DEFAULT NOW(),        -- server-side arrival timestamp, independent of client clock
  PRIMARY KEY (device_identity, entry_id)
);
-- Note: received_at backfilled from synced_at for pre-migration rows (migration 005)

CREATE UNIQUE INDEX idx_ledger_entries_entry_hash_unique
  ON ledger_entries (entry_hash);         -- replay protection
CREATE INDEX idx_ledger_entries_device_synced
  ON ledger_entries (device_identity, synced_at DESC);

-- Key rotation audit trail
CREATE TABLE key_rotation_events (
  id BIGSERIAL PRIMARY KEY,
  old_device_identity TEXT NOT NULL,
  new_device_identity TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  otp_verified_at TIMESTAMPTZ DEFAULT NOW(),
  rotation_receipt TEXT NOT NULL          -- HMAC proof of rotation
);

-- OTP challenges (transient)
CREATE TABLE otp_challenges (
  id BIGSERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,              -- phone or email
  channel TEXT NOT NULL DEFAULT 'email', -- sms | email
  otp_hash TEXT NOT NULL,               -- SHA-256("{identifier}:{code}")
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ                  -- set on failed attempt (rate limiting)
);

CREATE INDEX idx_otp_challenges_identifier_created
  ON otp_challenges (identifier, channel, created_at DESC);

-- User profiles
CREATE TABLE profiles (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(phone_number),
  phone_number TEXT,
  name TEXT,
  business_name TEXT,
  country CHAR(2),                       -- phone_country semantically
  operating_region CHAR(2),              -- capability and currency source
  language VARCHAR(10) DEFAULT 'en',
  business_type_id TEXT,
  sector_id TEXT,
  preferred_labels JSONB,
  email TEXT,
  plan TEXT,
  plan_activated_at TIMESTAMPTZ,
  passcode_hint TEXT,
  free_report_used BOOLEAN DEFAULT FALSE
);

-- Attestations
CREATE TABLE attestations (
  id BIGSERIAL PRIMARY KEY,
  vt_id TEXT UNIQUE NOT NULL,            -- crypto.randomBytes(16).toString('hex')
  device_identity TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  ledger_root_hash TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  window_days INTEGER NOT NULL,
  fork_status TEXT DEFAULT 'NORMAL',     -- NORMAL | FORKED
  key_rotation_events INTEGER DEFAULT 0,
  server_signature TEXT NOT NULL,        -- HMAC-SHA256 of attestation fields
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  verify_url TEXT,
  entries JSONB,                         -- snapshot of entries for PDF generation
  status TEXT DEFAULT 'VALID'            -- VALID | REVOKED
);

CREATE INDEX idx_attestations_device ON attestations (device_identity, issued_at DESC);

-- Payments
CREATE TABLE payments (
  id BIGSERIAL PRIMARY KEY,
  phone_number TEXT NOT NULL,
  device_identity TEXT NOT NULL,
  paystack_reference TEXT UNIQUE NOT NULL,
  amount_kobo INTEGER NOT NULL,
  tier TEXT NOT NULL,                    -- bronze | silver | gold
  window_days INTEGER NOT NULL,
  paystack_status TEXT DEFAULT 'pending',
  pdf_generated BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Schema migrations tracker
CREATE TABLE schema_migrations (
  version INT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 5.4 Cryptographic Operations

| Operation | Algorithm | Key |
|---|---|---|
| Entry signature verification | ECDSA P-256, IEEE P1363 | User's public key (JWK, stored at registration) |
| HMAC sync receipt | HMAC-SHA256 | `SERVER_RECEIPT_SECRET` |
| JWT issuance/verification | HS256 | `JWT_SECRET` |
| Attestation server signature | HMAC-SHA256 | `SERVER_RECEIPT_SECRET` |
| OTP hash | SHA-256(`"{identifier}:{code}"`) | — |
| vt_id generation | `crypto.randomBytes(16).toString('hex')` | — |
| Paystack webhook verification | HMAC-SHA512 | `PAYSTACK_SECRET_KEY` |

### 5.5 Fork Detection

On `POST /sync/entries`:
1. Last stored entry for device fetched from DB
2. `prev_entry_hash` of first incoming entry must equal `entry_hash` of last stored entry
3. Mismatch → device status set to `FORKED`, sync rejected `409`
4. `409` response: `{ error: "fork_detected", fork_status: "FORKED" }`
5. FORKED devices cannot sync. Key rotation (OTP-verified) required to recover.

### 5.6 OTP Verification Rate Limiting

- Count `failed_at` records per `identifier+channel` in last 15 minutes
- If count ≥ 5: return `429 { error: "Too many failed attempts. Try again in 15 minutes." }`
- On failed verification: `UPDATE otp_challenges SET failed_at = NOW() WHERE id = $1`
- OTP hash comparison uses `crypto.timingSafeEqual` (timing-attack protection)

### 5.7 CORS Configuration

Allowlist only:
```js
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : ["https://konfirmata.com", "https://www.konfirmata.com"];

if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push(
    "http://localhost:3000", "http://localhost:5173",
    "http://localhost:5500", "http://127.0.0.1:5500"
  );
}
```

Methods: `GET, POST, OPTIONS`
Headers: `Content-Type, Authorization, X-Device-Identity`

### 5.8 Environment Variables

```
HOST=0.0.0.0
PORT=8080
DATABASE_URL=postgresql://...
DATABASE_SSL=true
JWT_SECRET=<256-bit hex — REQUIRED>
SERVER_RECEIPT_SECRET=<256-bit hex — REQUIRED>
JWT_EXPIRY=30d
OTP_TTL_MINUTES=10
OTP_RATE_LIMIT_PER_HOUR=5
OTP_DEFAULT_CHANNEL=email
ALLOW_DEV_OTP=true              # set false in production
SMS_PROVIDER_ENABLED=false      # stub, not yet implemented
TERMII_API_KEY=<key>            # SMS delivery (Termii)
TERMII_SENDER_ID=Konfirmata
RESEND_API_KEY=<key>            # email delivery
RESEND_FROM_EMAIL=Konfirmata <noreply@konfirmata.com>
PAYSTACK_SECRET_KEY=<key>       # webhook HMAC + verification
PAYSTACK_PUBLIC_KEY=<key>       # frontend Paystack Inline
VERIFY_BASE_URL=https://konfirmata.com
CORS_ORIGINS=https://konfirmata.com,https://www.konfirmata.com
```

Server refuses to boot in production if `JWT_SECRET` or `SERVER_RECEIPT_SECRET` are empty.

---

## §6. Attestation System

### 6.1 Issue Flow

```
POST /attest (Bearer JWT)
  → Auth validated
  → Device verified (ACTIVE, not REVOKED)
  → Query ledger_entries for device in window [NOW - window_days, NOW]
  → ledger_root_hash = entry_hash of last entry in window
  → entry_count = COUNT(entries)
  → vt_id = crypto.randomBytes(16).toString('hex')
  → server_signature = HMAC-SHA256(vt_id || phone || device_identity ||
                                   ledger_root_hash || entry_count ||
                                   window_start || window_end, SERVER_RECEIPT_SECRET)
  → INSERT INTO attestations
  → Return { vt_id, verify_url, ledger_root_hash, entry_count, window_start,
             window_end, fork_status, issued_at, attestation_scope: "single_device",
             scope_description: "This report reflects records from a single device only." }
```

### 6.2 Verification Flow

```
GET /verify/:vt_id (public, rate-limited 100/min/IP)
  → Fetch attestation from DB
  → Recompute HMAC-SHA256 with stored fields
  → Compare with stored server_signature
  → If match: status = VALID
  → If mismatch: status = UNKNOWN
  → If device FORKED/REVOKED: fork_status reflects actual status
  → Return {
      vt_id, attested_at, window_start, window_end, entry_count,
      fork_status, device_fingerprint (8 chars only), key_rotation_events,
      attestation_scope: "single_device",
      scope_description: "...",
      status: "VALID" | "FORKED" | "REVOKED" | "UNKNOWN"
    }
```

No PII returned. `phone_number` never in response. `device_identity` truncated to 8 chars.

### 6.3 Verification Portal

Static page at `website-v2/verify.html`, served at `/verify/:vt_id`

- Extracts `vt_id` from `window.location.pathname` (last segment)
- Calls `GET /verify/:vt_id` on load
- Badge colors: VALID = `#52B788`, FORKED/REVOKED = `#B42318`, UNKNOWN = `#6B7C6B`
- Displays: `attested_at`, window range, `entry_count`, `key_rotation_events`, `fork_status`, `device_fingerprint` (8 chars), scope description

---

## §7. Payment & PDF System

### 7.1 Paystack Tiers (operating_region = NG only)

| Tier | Price | Window |
|---|---|---|
| Bronze | ₦500 | 30 days |
| Silver | ₦1,500 | 90 days |
| Gold | ₦2,500 | Full history (`window_days = 0`) |

Tier button labels dynamically show actual days of transaction history (e.g., "Gold — 347 days").

### 7.2 Webhook Flow

```
POST /payment/webhook (Paystack charge.success)
  → Verify x-paystack-signature HMAC-SHA512 FIRST — reject 400 if invalid
  → Upsert payments row (idempotent via ON CONFLICT on paystack_reference)
  → Call POST /attest (internal, pass db client for transaction threading)
  → generateVerifiedReport(attestation, profile, db)
  → buildVerifiedReportPdf({ attestation, businessName, phoneNumber, email, tier, ... })
  → Send PDF via Resend email
  → Update payments.pdf_generated = TRUE
```

### 7.3 Free Report Claim

```
POST /payment/generate-pdf { free_claim: true }
  → Wrap in withTransaction
  → UPDATE profiles SET free_report_used = TRUE
    WHERE phone_number = $1
    AND COALESCE(free_report_used, FALSE) = FALSE
  → If rowCount === 0: 403 { error: "Free report already claimed." }
  → Generate PDF (same as paid, within same transaction)
  → Return PDF as download or email
```

Race-condition protected: claim-first pattern means two concurrent requests cannot both succeed.

### 7.4 PDF Contents

Server-generated via pdfkit:

**Cover page:**
- Business name
- Masked phone (`maskPhone()`) and email (`maskEmail()`)
- Report date range
- Tier label
- Entry count
- Evidence summary ("145 of 150 entries server-attested")
- Status badge: VALID

**Income statement:**
- Total income (sales + receipts)
- Total expenses (payments + purchases)
- Net cash flow
- Grouped by month

**Monthly cash flow:**
- Month-by-month bar breakdown

**Transaction ledger (appendix):**
- All entries in window: date, label, type, amount
- Currency formatted per profile currency

**Footer:**
- `ledger_root_hash`
- `vt_id`
- QR code pointing to `verify_url`
- Device fingerprint (8 chars)
- `attestation_scope: "single_device"` disclaimer
- Patent notice: USPTO Provisional 63/987,858

### 7.5 Masking Policy

| Export type | Phone | Email |
|---|---|---|
| User's own text export | Full (unmasked) | Full (unmasked) |
| Lender-facing PDF | `maskPhone()` | `maskEmail()` |
| Verification portal | Not shown | Not shown |

`maskPhone("+2348031234567")` → `"+234****4567"`
`maskEmail("john.doe@example.com")` → `"j***e@example.com"`

### 7.6 Rewarded Export Flow

Users have a fixed monthly quota of free text exports. When exhausted, they can watch a rewarded ad to unlock one additional export for that calendar month.

**Quota functions (all in `app.js`):**

| Function | Description |
|---|---|
| `getMonthlyFreeExportCount()` | Returns free text exports used this calendar month (IndexedDB settings) |
| `getRewardedExportCount()` | Returns ad-unlocked exports remaining this month |
| `hasFreeExportQuota()` | `true` if free or rewarded quota remains |
| `shouldOfferRewardedExport()` | `true` when free quota exhausted and rewarded ad is available |
| `refreshRewardedExportState()` | Updates UI to show rewarded button when applicable |
| `unlockRewardedExport()` | Increments rewarded count after successful ad completion |

**Flow:**
1. User taps Export → `hasFreeExportQuota()` checked
2. Quota exhausted → `shouldOfferRewardedExport()` checked
3. Rewarded available → ad modal shown (`rewarded-ad-modal` with countdown timer)
4. Ad countdown completes → `unlockRewardedExport()` → export proceeds
5. No rewarded available → error shown, export blocked

**UI elements:** `rewarded-export-wrap`, `rewarded-export-button`, `rewarded-ad-modal`, `rewarded-ad-slot`, `rewarded-ad-countdown`, `rewarded-ad-complete`

**Constraint:** This system is client-side only. The server does not track export counts — quota is stored in IndexedDB `settings`.

---

## §8. Migration System

### 8.1 Runner

`server/migrate.js` — standalone Node.js script:
- Connects via `getPool()` from `server/src/db.js`
- Ensures `schema_migrations` table exists
- Reads all `server/migrations/*.sql` files sorted by numeric prefix
- Applies each unapplied version in a transaction (BEGIN → SQL → INSERT version → COMMIT)
- Comment-only migrations (like the baseline) are detected and skipped safely
- Logs each applied migration, exits cleanly via `pool.end()`

**Usage:** `node server/migrate.js`

### 8.2 Migration Files

| File | Version | Description |
|---|---|---|
| `001_baseline.sql` | 1 | No-op marker — baseline schema as of 2026-04-04 |
| `002_replay_protection.sql` | 2 | `UNIQUE INDEX` on `ledger_entries(entry_hash)` |
| `003_country_region_language.sql` | 3 | `operating_region`, `language` columns on profiles + backfill |
| `004_evidence_hierarchy.sql` | 4 | `evidence_level`, `corroboration_flags` columns on ledger_entries + backfill |
| `005_received_at.sql` | 5 | `received_at TIMESTAMPTZ` column on ledger_entries; backfills from `synced_at` |

### 8.3 Schema Guards (in account.js)

`ensureAccountRecoverySchema()` runs on first request to `/profile` routes. It applies `ADD COLUMN IF NOT EXISTS` for all profile columns — a safety net for databases that predate the migration runner. It is idempotent and safe to run repeatedly.

---

## §9. Device Lifecycle

### 9.1 States

```
(new) → ACTIVE → ROTATED (old device after rotation)
               → FORKED  (hash chain mismatch detected)
               → REVOKED (manual revocation)
```

### 9.2 Registration

1. Client generates ECDSA P-256 keypair after OTP verification
2. First `/sync/entries` call includes `device_identity` and `public_key` (JWK)
3. Server upserts `device_identities` row with `status = 'ACTIVE'`
4. Ownership check: if device exists and `phone_number` differs → `403`

### 9.3 Rotation (OTP-verified)

1. Client generates new keypair
2. `POST /identity/rotate` with `old_device_identity`, `new_device_identity`, `new_public_key`
3. Server verifies old device belongs to `auth.phone_number`
4. Sets old device `status = 'ROTATED'`, `rotated_to = new_device_identity`
5. Creates new device record `status = 'ACTIVE'`
6. Creates `key_rotation_events` row
7. Returns `rotation_receipt` (HMAC proof)
8. Attestations show `key_rotation_events` count for auditor awareness

### 9.4 Revocation

1. `POST /identity/revoke` with `device_identity`
2. Server verifies ownership
3. Sets `revoked_at = NOW()` on device
4. Revoked device cannot sync (checked in `/sync/entries`)
5. Historical ledger entries preserved (read-only)

### 9.5 Fork Recovery

1. Device marked `FORKED` after hash chain mismatch on sync
2. Client receives `409 FORKED` and sets local device state to FORKED
3. No further sync possible from FORKED device
4. Recovery path: OTP-verified key rotation to new device

---

## §10. Evidence Hierarchy

### 10.1 Levels

| Value | Tier | Assigned when |
|---|---|---|
| `self_reported` | 0 | Record created before keypair exists |
| `device_signed` | 1 | Record signed with ECDSA key, not yet synced |
| `server_attested` | 2 | Synced and verified by server |
| `corroborated` | 3 | Matched against external data source (Phase 2) |

### 10.2 Assignment Logic

**Client side (`appendLedgerRecord`):**
```js
evidence_level: signature ? "device_signed" : "self_reported"
```

**Client side (post-sync upgrade):**
```js
await markRecordsEvidenceLevel(syncedIds, "server_attested");
```

**Server side (`/sync/entries` INSERT):**
```sql
evidence_level = 'server_attested'
```
All entries received by server have passed signature verification.

**Migration backfill:**
- Entries with non-empty signature → `device_signed`
- Entries with `synced_at IS NOT NULL` → `server_attested`

### 10.3 Report Surfacing

Text export and PDF cover page both include:
```
=== Evidence Summary ===
Total entries: 150
  Server-attested: 145
  Device-signed: 5
  Self-reported: 0

145 of 150 entries (97%) have server attestation.
```

---

## §11. Financial Statements

Computed in `buildFinancialStatements(records, currency)` / `computeFinancialStatements(entries, currency)`.

### 11.1 Metrics

| Metric | Calculation |
|---|---|
| Today's sales | Sum of `sale` records with `confirmed_at` on current date |
| Monthly sales | Sum of `sale` records in current calendar month |
| Monthly expenses | Sum of `payment` + `purchase` in current month |
| Cash flow | Monthly sales − Monthly expenses |
| Streak | Consecutive days (backward from today) with ≥ 1 record |

**Timestamp resolution:** `getRecordConfirmedAtMs(record)` resolves entry timestamps for date range calculations. It uses `confirmed_at` with fallback to `created_at` when `confirmed_at` is absent. Values < 1e12 are treated as Unix seconds and multiplied by 1000; values ≥ 1e12 are treated as milliseconds. Records with neither field are excluded from date range.

### 11.2 Reversal Handling

Reversed transactions (those whose `entry_hash` appears in any reversal's `reversed_entry_hash`) are excluded from all metric calculations. Reversal records themselves subtract from the original transaction type.

### 11.3 Tier Assignment

| Streak | Tier |
|---|---|
| ≥ 180 days | 🥇 Gold |
| ≥ 90 days | 🥈 Silver |
| ≥ 30 days | 🥉 Bronze |
| < 30 days | 🆕 New |

---

## §12. Label System

### 12.1 Ranking Algorithm (`rankLabels()`)

Scoring per candidate label against query:

| Signal | Score |
|---|---|
| Exact normalized match | +40 |
| Synonym match (label catalog) | +30 |
| Partial/substring match | +16 |
| Business type match | +12 |
| Sector match | +8 |
| Country match | +6 |
| Usage history boost | min(count, 8) |
| Preferred label (onboarding selection) | +18 |

Sort: score descending → display_name ascending. Default limit: 12.

### 12.2 Confidence Calculation

With query: `min(score / 50, 0.99)`
Without query: composite of business/sector/country match + history/preferred boosts

### 12.3 Reason Labels

- `"Exact match"` — normalized exact match
- `"Synonym match"` — known synonym in label catalog
- `"Related match"` — partial match
- `"Picked during onboarding"` — in preferred_labels
- `"Recommended for this business"` — business/sector/country match only

---

## §13. Deployment

### 13.1 Vercel (Frontend)

| Path | Source | Notes |
|---|---|---|
| `/` | `website-v2/index.html` | Marketing site |
| `/about`, `/banks`, etc. | `website-v2/*.html` | Via catch-all route |
| `/app` | `app-v3/index.html` | PWA, base href `/app/` |
| `/app/*` | `app-v3/*` | Static assets |
| `/verify/:vt_id` | `website-v2/verify.html` | Verification portal |

Routing via `vercel.json` `routes` array (not `rewrites`).

### 13.2 Railway (Backend)

- **Service:** Root directory: `server/`
- **DB:** PostgreSQL, private networking within Railway project
- **Public domain:** Railway-generated or custom
- **Deployment:** Auto-deploy on push to `main` via GitHub connection

### 13.3 Repository

- **GitHub:** `mbamalli-max/Confirma-site`
- **Default branch:** `main`
- **Excluded from git:** `server/.env`, `server/node_modules/`, `.DS_Store`

---

## §14. Security Constraints

1. **Webhook HMAC verified before any action** — reject Paystack payloads before processing if HMAC-SHA512 invalid
2. **PDF generated server-side only** — never client-side
3. **vt_id is `crypto.randomBytes(16)`** — never sequential, never `Math.random()`
4. **GET /verify/:vt_id returns no PII** — no phone_number, device_identity truncated to 8 chars
5. **Rate limiting:** OTP request = 5/hr per phone, OTP verify = 5 failures/15min, verify portal = 100/min per IP
6. **ALLOW_DEV_OTP must be false in production** before real user onboarding
7. **Payment gate is strictly pre-PDF** — never pre-confirmation. `confirmationTransition()` must never be gated
8. **Country selection is global** — do not block onboarding for unsupported regions
9. **Capability flags derive from `operating_region` only** — never from `phone_country`
10. **Language is independent** — default to English when no local pack exists
11. **IDOR protection on device rotation** — ownership verified before transaction
12. **IDOR protection on sync** — device ownership + revocation checked before upsert
13. **OTP timing-safe comparison** — `crypto.timingSafeEqual` used, not `!==`
14. **Race condition protection on free report** — claim-first transaction, not check-then-claim
15. **window_days capped at 365** — no unbounded DB query via user input
16. **CORS allowlist** — no wildcard origin
17. **JWT secrets required** — server exits on boot if `JWT_SECRET` or `SERVER_RECEIPT_SECRET` empty
18. **Replay protection** — `UNIQUE INDEX` on `ledger_entries(entry_hash)`
19. **Phone/email masked in lender PDF** — full PII only in user's own text export
20. **Free report server-enforced** — `free_report_used` flag in DB, not only in localStorage
21. **`ALLOW_DEV_OTP` hard-blocked in production** — server calls `process.exit(1)` at startup if both `DATABASE_SSL=true` and `ALLOW_DEV_OTP=true` are set simultaneously. Prevents OTP bypass against a production database.

---

## §15. TAS Change Log

| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-03-22 | Initial spec, Phases 0–1.5A |
| 1.5 | 2026-03-25 | Phase 1.5B complete — sync server, fork detection |
| 2.0 | 2026-03-28 | Phases 1.5C + 1.5D complete — attestation, Paystack PDF, deployment |
| 2.1 | 2026-04-04 | Global availability model — full country selector, decoupled dimensions |
| 3.0 | 2026-04-04 | Full rewrite — 17-task security hardening complete: IDOR, OTP, race conditions, CORS, JWT secrets, masking, replay protection, evidence hierarchy, schema migrations, device scope labels |
| 3.1 | 2026-04-11 | **New sections:** §4.13 Voice Input System (NLP parsing, voice locale, voice correction system); §7.6 Rewarded Export Flow. **Schema:** `received_at TIMESTAMPTZ` on ledger_entries (migration 005); `voice_corrections` IndexedDB store documented. **Security:** SC-21 ALLOW_DEV_OTP hard-block; `extractable: false` corrected in §4.8 keypair snippet. **Onboarding:** country selector updated to searchable input with locale auto-detection. **Financial statements:** `getRecordConfirmedAtMs` `created_at` fallback documented. |
