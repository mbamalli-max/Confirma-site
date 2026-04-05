# Technical Architecture Specification (TAS)
**Project:** Confirma (brand rename pending)
**Patent:** USPTO Provisional 63/987,858
**Version:** 2.0 — updated post Phase 1.5D
**Date:** 2026-03-28

---

## §1. System Overview

Confirma is a financial identity infrastructure that converts informal business activity into cryptographically verifiable ledger records. The output is a bank-usable identity: a signed, server-attested transaction history that a loan officer can verify independently.

**Core thesis:** Ledger formation is always free. Payment gates only verified PDF export.

**Stack:**
- PWA: Vanilla JS, IndexedDB, WebCrypto P-256 — served at `confirma-site.vercel.app/app`
- Server: Fastify/Node.js on Railway — `confirma-site-production.up.railway.app`
- Database: Railway PostgreSQL
- Website: Static HTML/CSS (Forest & Parchment) — `confirma-site.vercel.app`
- Verification portal: Static page at `confirma-site.vercel.app/verify/:vt_id`

---

## §2. Design System

**Theme:** Forest & Parchment

| Token | Value |
|-------|-------|
| Primary dark | `#1B2F1F` |
| Primary mid | `#2D6A4F` |
| Primary light | `#52B788` |
| CTA orange | `#E8944A` |
| Background | `#F5F0E8` warm parchment |
| Error red | `#B42318` |
| Heading font | Calistoga (Google Fonts) |
| Body font | Inter (Google Fonts) |

Design reference: `website-v2/get-the-app.html`

---

## §3. Protected Functions — Absolute Constraint

These form the integrity core. No code outside them may write to the IndexedDB records store or call `appendLedgerRecord()` directly. Violating this causes ledger drift — a security failure.

| Function | Location | Rule |
|----------|----------|------|
| `confirmationTransition()` | `app-v3/app.js` | Only entry point to ledger writes |
| `appendLedgerRecord()` | `app-v3/app.js` | The ledger write itself |
| `getRecords()` | `app-v3/app.js` | Canonical read path |
| IndexedDB `records` store `.add()` | `app-v3/app.js` | Never called from outside confirmationTransition |

Payment, sync, attestation, and export code must treat the ledger as read-only.

---

## §4. PWA Architecture

### 4.1 File Layout

```
app-v3/
├── index.html          # Shell, screens, CDN imports
├── app.js              # All state, UI, and ledger logic
├── styles.css          # Forest & Parchment design system
├── syncWorker.js       # HTTP client (postJson, requestOtpCode, verifyOtpCode)
├── sw.js               # Service worker, cache strategy
├── manifest.json       # PWA manifest (name, icons, start_url: /app)
└── icons/              # icon.svg, icon-mask.svg
```

Served at `/app` via Vercel `routes` config pointing to `app-v3/index.html`.
Base href set to `/app/` so relative asset paths resolve correctly.

### 4.2 Screen Flow

```
Onboarding (5 steps) → Record → Dashboard → History → Settings → Export
                                                          ↓
                                                   OTP screen (phone verify)
```

### 4.3 State Management

All state lives in `state` object in `app.js`. Persisted to IndexedDB:
- `settings` store: `auth_token`, `auth_token_expires_at`, `device_identity`, `last_vt_id`, `last_verify_url`, `phone_country`
- `profile` store: `phone_number`, `operating_region`, `language`, `identity_status`, `identity_anchor`
- `records` store: all ledger entries (append-only, protected)
- `sync_queue` store: entries pending server sync

### 4.4 Global Availability Model

Konfirmata exposes a global country selector at onboarding. Users may select any country from the ISO 3166-1 alpha-2 list, even when some region-specific capabilities are not yet available there.

Country handling is explicitly separated into three independent dimensions:

1. `phone_country`
   - Derived from the phone number prefix during OTP verification.
   - Used only for phone parsing and normalization.

2. `operating_region`
   - Chosen by the user during onboarding.
   - Defines business context, default currency, and region-specific capability flags.

3. `language`
   - Chosen independently from country.
   - Defines UI language and voice recognition configuration.

Example valid state:
- `phone_country = NG`
- `operating_region = US`
- `language = en`

At launch, English is the default language. Countries without a dedicated language pack must still onboard successfully and use English plus the English Layer C voice mapping by default.

### 4.5 Country Selector and Language Handling

Implementation requirements:
- Country selector must use the full ISO 3166-1 alpha-2 list.
- Country selection sets `operating_region` only.
- Phone parsing determines `phone_country` separately.
- Language selector is separate from country.
- The app must not auto-switch language from country selection.
- Lack of a local language pack must never hide a country.

### 4.6 Capability Separation

Country selection must not be used to infer:
- payment availability
- report generation eligibility
- feature access

Instead:
- capability flags are derived from `operating_region`
- unsupported features must be explicitly disabled or marked "Coming soon"
- unsupported regions should display: "Some features are not yet available in your region"

Example policy:

```js
if (operating_region !== "NG") {
  hidePaystackTiers();
  enableFreeExportOnly();
}
```

### 4.7 WebCrypto

- **Algorithm:** ECDSA P-256 (non-extractable private key in IndexedDB)
- **Device identity:** first 16 bytes of SHA-256(public_key_jwk_string), hex-encoded
- **Canonical signing string:**
  ```
  id|transaction_type|normalized_label|amount_minor|currency|counterparty|
  business_type_id|country|source_account|destination_account|
  reversed_entry_hash|reversed_transaction_type|confirmed_at|prev_entry_hash
  ```
- **Signature format:** base64-encoded IEEE P1363 (raw r||s, 64 bytes)
- **Keypair generated after phone OTP verification** — phone is the recovery anchor

### 4.8 OTP Flow

1. User enters phone number
2. App calls `POST /auth/otp/request` via `syncApiBaseUrl`
3. Phone number normalized from `phone_country` before sending: Nigeria `08099840666` → `+2348099840666`, US `2678867271` → `+12678867271`
4. Server returns `dev_code` if `ALLOW_DEV_OTP=true` (dev/staging), otherwise sends SMS via Termii
5. Dev code shown in helper text below phone input
6. User enters code → `POST /auth/otp/verify` → JWT `auth_token` returned
7. Token saved to IndexedDB, keypair generated, identity status set to `verified_server`

### 4.9 Sync Flow

1. Entry confirmed via `confirmationTransition()` → signed → added to `sync_queue`
2. `flushSyncQueue()` called after confirmation and on app load
3. `POST /sync/entries` with Bearer JWT, array of signed entries
4. Server verifies signatures, checks hash chain, returns HMAC receipt
5. On `409 FORKED`: device marked FORKED locally, sync blocked

### 4.10 Export Flow

1. User taps Export → export screen rendered
2. If authenticated: `POST /attest` called (best-effort, non-blocking)
3. On attestation success: `vt_id`, `verify_url`, QR code data URL saved and appended to export
4. Export language: "Device-signed and server-attested. Verify at [verify_url]"
5. On attestation failure: export completes without attestation silently

---

## §5. Server Architecture

### 5.1 Runtime

- **Framework:** Fastify with `@fastify/cors`, `@fastify/rate-limit`
- **Entry point:** `server/server.js`
- **Port:** Assigned by Railway (`PORT` env var), defaults to 8787 locally
- **Host:** `0.0.0.0`
- **DB driver:** `pg` (PostgreSQL) with SSL (`DATABASE_SSL=true`)

### 5.2 Route Table

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| `GET` | `/health` | None | Liveness — returns `{ok: true}` |
| `POST` | `/auth/otp/request` | None | Request OTP, rate-limited 5/hr per phone |
| `POST` | `/auth/otp/verify` | None | Verify OTP → JWT auth_token |
| `POST` | `/sync/entries` | Bearer JWT | Upload signed entries, fork detection |
| `POST` | `/identity/rotate` | Bearer JWT | OTP-verified key rotation |
| `POST` | `/attest` | Bearer JWT | Issue vt_id attestation certificate |
| `GET` | `/verify/:vt_id` | None | Public verification, rate-limited 100/min/IP |
| `POST` | `/payment/webhook` | Paystack sig | Paystack charge.success handler |
| `POST` | `/payment/generate-pdf` | Bearer JWT | Generate server-side verified PDF |

### 5.3 Database Schema

```sql
-- Identity
users (id, phone_number, created_at)
device_identities (id, user_id, device_identity, public_key_jwk,
                   status [ACTIVE|FORKED|REVOKED], registered_at)
key_rotation_events (id, user_id, old_device_identity, new_device_identity,
                     rotated_at, otp_verified)

-- Ledger
ledger_entries (id, user_id, device_identity, entry_hash, prev_entry_hash,
                signature, public_key_jwk, confirmed_at, synced_at,
                transaction_type, amount_minor, currency, label, country)

-- Auth
otp_challenges (id, phone_number, otp_hash, expires_at, verified_at,
                created_at)

-- Attestation
attestations (id, vt_id, user_id, device_identity, ledger_root_hash,
              entry_count, window_start, window_end, window_days,
              fork_status, key_rotation_events, server_signature,
              attested_at, verify_url)

-- Payments
payments (id, user_id, paystack_reference, amount, currency, tier,
          status, pdf_generated, created_at)
```

### 5.4 Cryptographic Operations

| Operation | Algorithm | Key |
|-----------|-----------|-----|
| Entry signature verification | ECDSA P-256, IEEE P1363 | User's public key (stored at registration) |
| HMAC receipt (sync) | HMAC-SHA256 | `SERVER_RECEIPT_SECRET` |
| JWT issuance/verification | HS256 | `JWT_SECRET` |
| Attestation server signature | HMAC-SHA256 | `SERVER_RECEIPT_SECRET` |
| vt_id generation | `crypto.randomBytes(16).toString('hex')` | — |
| Paystack webhook verification | HMAC-SHA512 | `PAYSTACK_SECRET_KEY` |

### 5.5 Fork Detection

On `POST /sync/entries`:
1. Last stored entry for device fetched from DB
2. `prev_entry_hash` of incoming entry must match `entry_hash` of stored entry
3. Mismatch → device status set to `FORKED`, sync rejected `409`
4. FORKED devices cannot sync; key rotation required to recover

### 5.6 Environment Variables

```
HOST=0.0.0.0
PORT=8787
DATABASE_URL=postgresql://...
DATABASE_SSL=true
JWT_SECRET=<256-bit hex>
SERVER_RECEIPT_SECRET=<256-bit hex>
JWT_EXPIRY=30d
OTP_TTL_MINUTES=10
OTP_RATE_LIMIT_PER_HOUR=5
ALLOW_DEV_OTP=true          # set false in production
TERMII_API_KEY=<key>        # SMS delivery
TERMII_SENDER_ID=Confirma
PAYSTACK_SECRET_KEY=<key>   # payment webhook + verification
PAYSTACK_PUBLIC_KEY=<key>   # frontend Paystack inline
RESEND_API_KEY=<key>        # email delivery
VERIFY_BASE_URL=https://confirma-site.vercel.app
```

---

## §6. Attestation System

### 6.1 Flow

```
User exports → POST /attest (JWT auth)
             → Server queries ledger_entries for device in window
             → Computes ledger_root_hash (entry_hash of last entry)
             → Generates vt_id = crypto.randomBytes(16).toString('hex')
             → Computes server_signature = HMAC-SHA256(fields joined by '||')
             → Stores in attestations table
             → Returns { vt_id, verify_url, ledger_root_hash, entry_count, ... }
```

### 6.2 Verification Portal

- Static page at `website-v2/verify.html` served at `/verify/:vt_id`
- Extracts `vt_id` from `window.location.pathname` (last path segment)
- Calls `GET /verify/:vt_id` on load
- Renders badge: VALID = `#52B788`, FORKED/REVOKED = `#B42318`, UNKNOWN = `#6B7C6B`
- Displays: `attested_at`, window range, `entry_count`, `key_rotation_events`, `fork_status`
- Shows `device_fingerprint` truncated to 8 chars (no PII, no phone number)
- Network error → "Unable to reach verification server"

---

## §7. Payment & PDF System

### 7.1 Paystack Tiers (Operating Region = NG only)

| Tier | Price | Window |
|------|-------|--------|
| Bronze | ₦500 | 30 days |
| Silver | ₦1,500 | 90 days |
| Gold | ₦2,500 | Full history |

Paystack tiers must be derived from `operating_region`, not `phone_country`.

- `operating_region = NG`: show Paystack tiers
- all other regions: hide Paystack tiers, keep free export available, and show an explicit unsupported-region message instead of crashing

### 7.2 Webhook Flow

```
Paystack charge.success
  → POST /payment/webhook
  → HMAC-SHA512 verify (x-paystack-signature header) FIRST — reject if invalid
  → Upsert payments row
  → POST /attest (internal)
  → Generate PDF via pdfkit
  → Send email via Resend
```

### 7.3 PDF Contents

Server-generated via `pdfkit`:
- Business name, date range, entry count
- Full entry list (date, label, amount, type)
- `ledger_root_hash`, `vt_id`, QR code pointing to verify URL
- Device fingerprint (8 chars, no PII)
- Patent notice (USPTO Provisional 63/987,858)

### 7.4 Loan Readiness Banner

- Location: **dashboard screen only** (never export screen)
- Bronze trigger: streak ≥ 30 days — links to export screen
- Silver trigger: streak ≥ 90 days — links to export screen

---

## §8. Deployment

### 8.1 Vercel (Frontend)

| Path | Source | Notes |
|------|--------|-------|
| `/` | `website-v2/index.html` | Marketing site |
| `/about`, `/banks`, etc. | `website-v2/*.html` | Via catch-all route |
| `/app` | `app-v3/index.html` | PWA, base href `/app/` |
| `/app/*` | `app-v3/*` | Static assets |
| `/verify/:vt_id` | `website-v2/verify.html` | Verification portal |

Routing via `vercel.json` `routes` array (not `rewrites` — static files take precedence).

### 8.2 Railway (Backend)

- **Service:** Confirma-site (root directory: `server/`)
- **DB:** Postgres--o2d (same project, private networking)
- **Public domain:** `confirma-site-production.up.railway.app`
- **Deployment:** Auto-deploy on push to `main` via GitHub connection

### 8.3 Repository

- **GitHub:** `mbamalli-max/Confirma-site`
- **Branch:** `main` (protected — never push secrets)
- **Excluded from git:** `server/.env`, `server/node_modules/`, `.DS_Store`

---

## §9. Security Constraints

1. **Webhook HMAC verified before any action** — never trust unverified Paystack payloads
2. **PDF generated server-side only** — never client-side (no jsPDF)
3. **vt_id is `crypto.randomBytes(16)`** — never sequential, never `Math.random()`
4. **GET /verify/:vt_id returns no PII** — no `phone_number`, `device_identity` truncated to 8 chars
5. **Rate limiting:** OTP = 5/hr per phone, verify endpoint = 100/min per IP
6. **ALLOW_DEV_OTP must be false in production** before real user onboarding
7. **Payment gate is strictly pre-PDF** — never pre-confirmation. `confirmationTransition()` must never be gated by payment.
8. **Country selection is global** — do not block onboarding for unsupported regions
9. **Capability flags derive from `operating_region` only** — never from `phone_country`
10. **Language is independent** — default to English when no local language pack exists

---

## §10. Outstanding Work

### Operational (go-live blockers)
- [ ] Set `PAYSTACK_SECRET_KEY` + `PAYSTACK_PUBLIC_KEY` in Railway + app-v3/app.js
- [ ] Set `TERMII_API_KEY` in Railway (enables real SMS OTP)
- [ ] Set `RESEND_API_KEY` in Railway (enables email delivery)
- [ ] Set `ALLOW_DEV_OTP=false` in Railway for production
- [ ] Run one live Paystack payment → verify PDF generated + email delivered
- [ ] QR scan → verify portal shows VALID

### UX (in progress)
- [ ] Phone number normalization: Nigeria `08099840666` → `+2348099840666`, US `2678867271` → `+12678867271`
- [ ] Replace the limited country selector with the full ISO 3166-1 alpha-2 list
- [ ] Add a separate language selector with English default
- [ ] Store `operating_region` independently from `phone_country`
- [ ] Country-aware state/region placeholder in onboarding
- [ ] Export screen: hide Paystack tiers whenever `operating_region !== NG`

### Identity (pending decision)
- [ ] Brand rename (name TBD) — rename prompt and manual infra steps documented
- [ ] Domain registration for new brand email

### Phase 2 (evidence-gated)
- [ ] Android Native — triggered only when MFI pilot requires hardware-backed attestation
- [ ] Kotlin + Jetpack Compose, Android Keystore StrongBox, Vosk offline voice, Protobuf signing

---

## §11. TAS Change Log

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-22 | Initial spec, Phases 0–1.5A |
| 1.5 | 2026-03-25 | Phase 1.5B complete — sync server, fork detection |
| 2.0 | 2026-03-28 | Phases 1.5C + 1.5D complete — attestation, Paystack PDF, deployment to Vercel + Railway |
| 2.1 | 2026-04-04 | Global availability model added — full country selector, decoupled `phone_country` / `operating_region` / `language`, region capability rules |
