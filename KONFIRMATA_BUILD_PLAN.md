# Konfirmata — Master Build Plan
**Patent:** USPTO Provisional 63/987,858
**Stack:** Vanilla JS PWA + Fastify/Node.js + Railway PostgreSQL
**Strategy:** PWA-first, server-anchored. Android/iOS deferred until MFI pilots require hardware attestation.
**Last updated:** 2026-03-29 (Phase 1.6D complete + auth/identity stabilization pass)

---

## Live Deployment

| Service | URL | Host |
|---------|-----|------|
| Marketing website | https://konfirmata.com | Vercel |
| PWA (installable) | https://konfirmata.com/app | Vercel |
| Verification portal | https://konfirmata.com/verify/:vt_id | Vercel |
| Sync server + API | https://api.konfirmata.com | Railway |
| PostgreSQL | centerbeam.proxy.rlwy.net:43983 | Railway |
| GitHub repo | github.com/mbamalli-max/Konfirmata-site | GitHub |

---

## Workspace Layout

| Path | Purpose |
|------|---------|
| `app-v3/` | PWA (app.js, styles.css, index.html, syncWorker.js, sw.js) |
| `server/` | Sync server (server.js entry, src/routes/, src/crypto-verify.js) |
| `website-v2/` | Marketing site (6 pages + verify.html) |
| `docs/plans/` | Per-week implementation plans |
| `docs/GO_LIVE_CHECKLIST.md` | Manual QA checklist for go-live |

**Routing (vercel.json):**
- `/app` → `app-v3/index.html` (PWA with `<base href="/app/">`)
- `/app/*` → `app-v3/*` (PWA assets)
- `/verify/:vt_id` → `website-v2/verify.html` (verification portal)
- `/*` → `website-v2/*` (marketing site)

---

## Design System

Matches `website-v2/` — Forest & Parchment:

| Token | Value |
|-------|-------|
| Primary dark | `#1B2F1F` |
| Primary mid | `#2D6A4F` |
| Primary light | `#52B788` |
| CTA orange | `#E8944A` |
| Background | `#F5F0E8` warm parchment |
| Heading font | Calistoga (Google Fonts) |
| Body font | Inter (Google Fonts) |

---

## Protected Areas — Never Touch

These functions form the integrity core. No module outside them may call `appendLedgerRecord()` or any IndexedDB `.add()` on the records store:

- `confirmationTransition()` — the only entry point to ledger writes
- `appendLedgerRecord()` — the ledger write itself
- `getRecords()` — the canonical read path
- IndexedDB records store write path

---

## Server Architecture

| Route | Purpose | Status |
|-------|---------|--------|
| `GET /health` | Liveness check | ✅ Live |
| `POST /auth/otp/request` | Send OTP (dev mode: returns `dev_code` in response) | ✅ Live |
| `POST /auth/otp/verify` | Verify OTP → JWT `auth_token`, bind to device_identity | ✅ Live |
| `POST /identity/register` | Register device identity with server | ✅ Live |
| `POST /identity/rotate` | OTP-verified key rotation | ✅ Live |
| `POST /identity/revoke` | Revoke a device by device_identity (OTP-authenticated) | ✅ Live |
| `GET /records` | Pull all synced records for authenticated user (paginated) | ✅ Live |
| `GET /profile` | Get stored user profile (name, business type, country, preferred labels) | ✅ Live |
| `POST /profile` | Upsert user profile | ✅ Live |
| `GET /devices` | List all devices for authenticated user with revoked status | ✅ Live |
| `POST /sync/entries` | Upload signed entries, fork detection | ✅ Live |
| `POST /attest` | Issue vt_id attestation (JWT auth) | ✅ Live |
| `GET /verify/:vt_id` | Public verification endpoint (rate-limited) | ✅ Live |
| `POST /payment/webhook` | Paystack webhook (HMAC-SHA512 verified) | ✅ Live |
| `POST /payment/generate-pdf` | Generate verified report PDF (JWT auth) | ✅ Live |

**Schema tables:** `users`, `device_identities`, `ledger_entries`, `key_rotation_events`, `otp_challenges`, `attestations`, `payments`, `profiles`

**Device tracking:** `device_identities.revoked_at` (TIMESTAMPTZ, nullable) — revoked devices rejected by authenticated middleware

**OTP channels:** `POST /auth/otp/request` accepts `channel: "email" | "sms"`. Email via Resend (default). SMS via Termii (only if `TERMII_API_KEY` set). Verification split: `email_verified` / `phone_verified` tracked separately.

**Identity model (enforced in code, not just described):**
- Phone = backend identity anchor (required for activation, recovery, device revocation)
- Email = temporary access/recovery channel (OTP delivery until SMS is live)
- `phone_anchor_required` enforced: first-time email activation without a phone anchor fails with explicit error — no half-activated states
- No silent partial identities
- Future email-first identity (if ever needed) requires an explicit migration — current model does not accidentally support it

**Environment variables (Railway):**
- `DATABASE_URL` (private: `postgres.railway.internal`) — ✅ switched to internal endpoint
- `DATABASE_SSL`, `HOST`, `PORT`
- `JWT_SECRET`, `SERVER_RECEIPT_SECRET`, `JWT_EXPIRY` — ✅ startup validation enforced
- `OTP_TTL_MINUTES`, `OTP_RATE_LIMIT_PER_HOUR`, `ALLOW_DEV_OTP`
- `RESEND_API_KEY` — ✅ startup validation enforced (email OTP default)
- `RESEND_FROM_EMAIL` — sender address validated at boot
- `PAYSTACK_SECRET_KEY` (not yet set to live key)
- `TERMII_API_KEY`, `TERMII_SENDER_ID` (not yet set — SMS deferred)

---

## PWA Crypto

- **Algorithm:** ECDSA P-256 (universally supported in Chrome Android)
- **Key storage:** IndexedDB `settings` store, non-extractable private key
- **Device identity:** first 16 bytes of SHA-256(public_key_jwk_string)
- **Canonical string for signing:**
  `id|transaction_type|normalized_label|amount_minor|currency|counterparty|business_type_id|country|source_account|destination_account|reversed_entry_hash|reversed_transaction_type|confirmed_at|prev_entry_hash`
- **Signature format:** base64-encoded IEEE P1363 (raw r||s, 64 bytes for P-256)
- **OTP must be verified before keypair generation** — phone number is the recovery anchor

---

## Build Phase Status

### ✅ Phase 0 — PWA Stabilisation (COMPLETE)
All critical, high, and medium fixes done. See `docs/plans/v3-foundation-plan.md`.

### ✅ Phase 1.5A — WebCrypto + Signed Entries (COMPLETE)
- P-256 keypair via `ensureDeviceKeyMaterial()` in app.js
- Every confirmed entry signed via `signEntryHash()` at confirmation time
- `signature` + `public_key_fingerprint` stored on every record
- OTP screen wired: `requestServerOtpCode()` / `verifyServerOtpCode()`
- Sync queue in IndexedDB, `flushSyncQueue()` calls `POST /sync/entries`

### ✅ Phase 1.5B — Sync Server + Fork Detection (COMPLETE)
- Fastify server boots and connects to Railway PostgreSQL
- Full OTP → JWT → sync → receipt flow implemented and verified live
- P-256 signature verification server-side via Node.js `crypto` module
- Hash chain continuity enforced; fork → device marked `FORKED`, sync rejected
- Device identity registration and key rotation endpoints

### ✅ Phase 1.5C — Attestation Service (COMPLETE)
- `attestations` table created on Railway
- `POST /attest` — JWT-authenticated, issues 128-bit `vt_id` via crypto.randomBytes
- `GET /verify/:vt_id` — public, rate-limited (100 req/min per IP), no PII exposed
- Server signature: HMAC-SHA256 with SERVER_RECEIPT_SECRET
- PWA export: calls POST /attest, includes vt_id, verify_url, QR code data URL
- Verification portal: `website-v2/verify.html` — standalone, Forest & Parchment design
- Vercel route: `/verify/:vt_id` → verify.html

### ✅ Phase 1.5D — Verified Reports + Paystack (COMPLETE)
- Paystack inline payment on export screen (₦500 / ₦1,500 / ₦2,500 tiers)
- Server-side PDF via `pdfkit` (full entry list, attested root hash, vt_id, QR)
- Webhook: `POST /payment/webhook` with HMAC-SHA512 Paystack verification
- PDF generation: `POST /payment/generate-pdf` (JWT auth, pdfkit + qrcode)
- Loan readiness banner on dashboard at 30 days (Bronze) and 90 days (Silver)
- Email delivery via Resend (best-effort, does not gate PDF download)
- `payments` table created on Railway
- Free plain-text export remains available — no paywall on basic ledger access

### ✅ Phase 1.5E — Financial Statements Export (COMPLETE)
- **Free text export** (`app-v3/app.js` → `generateExport()`): now prepends two structured sections before the raw ledger appendix:
  - **Income Statement** — Revenue (Sales), Other Receipts, Cost of Goods / Purchases, Operating Expenses, Net Income
  - **Monthly Cash Flow** — per-calendar-month table: Inflows / Outflows / Net, with a TOTAL row
- **Paid PDF** (`server/src/routes/payment.js` → `buildVerifiedReportPdf()`): two new pages inserted after the cover page:
  - Page 2: Income Statement (PDFKit two-column layout, divider lines, NET INCOME emphasized)
  - Page 3: Monthly Cash Flow (PDFKit four-column table, bold TOTAL row)
  - Transaction Ledger moved to **Appendix** (labelled "Appendix: Full Transaction Ledger")
- `computeFinancialStatements(entries, currency)` helper added server-side; `buildFinancialStatements(entries, currency)` added client-side
- **Reversal handling**: reversed entries are excluded from all totals — a reversal negates its target from its original category
- `fmt()` helper uses `Intl.NumberFormat` for "NGN 12,345.00" / "USD 12,345.00" format — no new dependencies

### ✅ Deployment & UX Polish (COMPLETE)
- Website (website-v2) deployed to Vercel as root
- PWA (app-v3) deployed at `/app` with `<base href="/app/">`
- Old `app/` directory removed from repo
- Server deployed to Railway with public domain
- OTP flow: request → dev code shown in helper text → verify → device key setup
- Country-aware phone input: Nigeria `08031234567` / US `2125551234`
- Phone normalization to E.164 before server calls
- Dynamic state/region placeholders per country
- Paystack tiers shown only for Nigeria; hidden for US ("coming soon")
- Website copy updated to match live product — no unbuilt feature claims
- All `syncApiBaseUrl` references point to Railway production URL

### ✅ Phase 1.6A — Voice Intelligence + Accessibility (COMPLETE)
- Client-side voice correction dictionary in IndexedDB (`voiceCorrections` store)
- `applyVoiceCorrections()` runs before every voice parse — learns from manual edits
- `state.lastVoiceTranscript` stored; corrections saved when user edits post-voice
- Voice Corrections section in Settings: list corrections, delete individual entries
- Accessibility: `role="alert"` + `aria-live` on all error/status containers
- `aria-label` on all icon-only buttons; `aria-describedby` on phone + amount inputs
- `lang="en"` on `<html>`; `color-scheme` meta tag for OS high-contrast support
- SpeechRecognition `onerror` now reports specific reasons (not-allowed, no-speech, etc.)
- `stopActiveRecognition()` uses `finally` block — mic always released
- `#voice-announce` hidden live region announces successful voice captures to screen readers
- Focus management: onboarding steps and modals set focus on first interactive element

### ✅ Phase 1.6B — Ad System (COMPLETE)
- Pre-session interstitial: 5s countdown, unskippable first 3s
  - Free: every 4 hours; Basic: every 12 hours; Pro: never
- In-feed native ads in ledger, history, and dashboard record lists
  - Free: every 5 records; Basic: every 10; Pro: none
- Screen banners on Dashboard, Export, and History screens
  - Free: all banners; Basic: export only; Pro: none
- Rewarded ad: watch 15s video → unlock 1 bonus export (tracked monthly in localStorage)
- House ad engine (`HOUSE_ADS` constant) — self-promotional content, AdSense-ready slots
- All ads suppressed when `state.isRecording === true`
- `state.profile.plan` controls tier: `"free"` | `"basic"` | `"pro"` (default `"free"`)

### ✅ Phase 1.6D — Auth Overhaul + Passcode Upgrade + Restore Hardening (COMPLETE)

**Auth overhaul:**
- Channel-aware OTP: `POST /auth/otp/request` accepts `channel: "email" | "sms"`
- Email OTP via Resend is the default — no SMS dependency to go live
- Split verification model: `email_verified` and `phone_verified` tracked independently
- Removed false "phone verified" state when user only completed email OTP
- Phone = identity anchor (required for activation + recovery); email = access channel
- `phone_anchor_required` enforced — no silent partial identities
- Removed client-side OTP fallback — server is sole verification authority

**Passcode system (replaces 6-digit PIN):**
- 8+ character alphanumeric passcode (PBKDF2-hashed in IndexedDB)
- Change passcode requires current passcode first
- Reset via OTP (phone-verified path) or device wipe (no phone path)
- Optional passcode hint: stored locally only, cannot equal or contain the passcode
- Hint never sent to server, never included in sync or export payloads

**Restore flow hardening:**
- Server-authoritative restore: server profile overwrites local profile on pull
- `skipPush` mechanism in `saveProfile()` — prevents local state from clobbering server data immediately after restore
- No silent data corruption on new device

**Phone prefix fix:**
- Root cause: UI rehydration was resetting `country` to US on certain flows
- Introduced `state.authPhoneCountry` + `getPhoneInputCountry()` helper
- Phone prefix persists correctly through OTP + restore flows (Nigeria stays Nigeria)

**Startup config validation:**
- Server now refuses to boot if `JWT_SECRET`, `SERVER_RECEIPT_SECRET`, `RESEND_API_KEY`, or sender email are missing
- SMS config (`TERMII_API_KEY`) does NOT block startup when SMS is intentionally disabled
- Prevents silent misconfiguration in production

**Duplicate verification bug fix:**
- `POST /auth/otp/request` and restore flow now check if channel already verified before issuing a new challenge
- No repeated OTP prompts for users who are already verified

**Stabilization pass (post-feature hardening):**
- `phone_anchor_required` path is enforced in code — first-time email activation without a phone anchor fails explicitly, no half-activated states created
- Restore flow is server-authoritative: `saveProfile()` supports a `skipPush` local-only save; restore, profile-pull, and verification-completion all use it — prevents local partial data overwriting good server data
- Passcode hints scrubbed from server profile responses and sync payloads; existing server-side hint values cleared; hints are now local-only
- Verification UI truthful: app shows distinct states (not verified / email verified / phone verified / both verified) — "phone verified" state only shows when SMS was actually completed or is supported
- `authPhoneCountry` regression-proofed: survives onboarding, restore modal, screen switches, and reloads — no silent fallback to US unless user explicitly changes it
- Dev QA helpers added: lightweight local state snapshots for manual testing of OTP request/verify, phone-anchor path, restore hydration, passcode reset/change, and country-prefix persistence — no secrets logged

---

### ✅ Phase 1.6C — Account Recovery & Device Management (COMPLETE)
- **Server:** `GET /records`, `GET /profile`, `POST /profile`, `POST /identity/revoke`, `GET /devices`
- **App:** "Restore from phone" link on onboarding → OTP → pull records + profile → repopulate IndexedDB
- **Seamless continuity:** New device → verify phone number → server recognises user → pull synced records
- **Device revocation prompt:** After restore, if >1 active device detected, prompt to revoke old device (security)
- **Trusted devices section:** Settings → list all active devices with last-seen + "Revoke" button per non-current device
- **Profiles table:** Stores name, business_name, country, business_type_id, sector_id, preferred_labels per user
- **Device identity tracking:** `device_identities.revoked_at` — revoked devices rejected by authenticated middleware on all routes
- **Imported records marker:** Records pulled from server set `importedFromServer: true`, skip anomaly checks on import
- **Private Database URL:** Updated Railway `DATABASE_URL` to use internal endpoint (`postgres.railway.internal`) — eliminates egress fees

---

## Go-Live Checklist (Remaining)

See `docs/GO_LIVE_CHECKLIST.md` for full QA steps. Summary:

### Configuration (not yet done)
- [ ] Set live `PAYSTACK_SECRET_KEY` in Railway + `PAYSTACK_PUBLIC_KEY` in app-v3/app.js
- [ ] Set `RESEND_API_KEY` in Railway + verify sender domain (email OTP is default — required for go-live)
- [ ] Set `RESEND_FROM_EMAIL` in Railway (validated at server boot)
- [ ] Set `TERMII_API_KEY` in Railway (SMS OTP — deferred, email covers launch)
- [ ] Set `ALLOW_DEV_OTP=false` in Railway for production

### Manual QA (not yet done)
- [ ] One live Paystack payment → PDF downloads → email arrives
- [ ] QR code from PDF scans → verify portal shows VALID
- [ ] 30-day streak → Bronze banner appears on dashboard
- [ ] Free export still works without payment
- [ ] Confirmation flow untouched — no payment gate

### Pending UX + Config + Testing Items
- [x] **Forgot PIN recovery flow** — OTP reset via email/SMS built; UI modal wired to `pin-forgot-*` elements
- [x] **CSP headers** — Strict `Content-Security-Policy` + `X-Frame-Options` + `X-Content-Type-Options` + `Referrer-Policy` + `Permissions-Policy` added to `vercel.json` for all routes
- [x] **Remove sync server URL from Settings UI** — Sync server row removed; users no longer see internal API URL
- [x] **Plan upgrade flow** — `state.profile.plan` now server-authoritative; Paystack `charge.success` webhook activates plan in `profiles` table; Settings shows plan label + free-only "Upgrade plan" CTA linking to Export screen
- [ ] **End-to-end device recovery test** — New device → restore from phone → pull records → see revocation prompt
- [ ] **Subresource Integrity (SRI)** — Add `integrity="sha384-..."` to Chart.js and QRCode.js CDN tags (5 min task)
- [ ] **Short device ID only** — Settings shows first 8 chars of fingerprint as "Device ID"; hide full device_identity
- [ ] **Voice recording end-to-end test** — Nigerian English + US English; confirm correction dictionary triggers on manual edits
- [ ] **Accessibility audit for US users** — Screen reader end-to-end test, VoiceOver (iOS) + TalkBack (Android)
- [ ] **AdSense account setup** — Publisher ID inserted into ad slots (replace house ads with real network)
- [ ] **Direct ad sales** — Approach Nigerian MFIs, banks, B2B SaaS for ₦20–50 CPM placements
- [ ] **Rewarded ad** — Replace house ad modal with real video ad network (AdMob web SDK or IronSource)

---

## Security Roadmap

### ✅ Current Security Posture
- ECDSA P-256 keypair per device (non-extractable, stored in IndexedDB)
- Append-only hash chain with server-side fork detection
- Channel-aware OTP (email default, SMS when Termii live) → JWT auth
- Split verification: `email_verified` / `phone_verified` — no false verification states
- HMAC-SHA256 server signatures on attestations
- Paystack HMAC-SHA512 webhook verification
- 8+ char alphanumeric passcode (PBKDF2, local-only, never transmitted)
- Adaptive anomaly detection (warn-only, user-baseline thresholds)
- Device revocation: server rejects revoked `device_identity` on all authenticated routes
- Server startup validation: refuses to boot without critical env vars
- Private Railway DB connection: internal endpoint, no egress fees

### 🔲 Phase S1 — Quick Wins (< 1 day each)
- [x] **CSP headers** — Added to `vercel.json`; see Phase 1.5F above.
- [ ] **Subresource Integrity (SRI)** — Add `integrity="sha384-..."` to Chart.js and QRCode.js CDN tags. A compromised CDN response undoes all other security measures.
- [ ] **Remove server URL from Settings** — Replace `https://api.konfirmata.com` display with "Connected / Last synced X min ago". No user needs the raw URL.
- [ ] **Short public key fingerprint only** — Show first 8 chars (`eda069ca`) as "Device ID" in Settings. Hide full 32-char device identity — internal value, no UX purpose.

### ✅ Phase S2 — Core Security Features (COMPLETE)
- [x] **Passcode Lock** — 8+ char alphanumeric passcode (PBKDF2 hash in IndexedDB). Disabling or changing passcode requires current passcode first. Optional hint (cannot equal/contain passcode, local-only, never synced). Auto-lock after 5 min inactivity. WebAuthn progressive enhancement deferred.
  - ✅ Fixed passcode toggle security: disabling passcode requires current passcode entry first
- [x] **Device Revocation** — `POST /identity/revoke` (OTP-authenticated). Revoked `device_identity` rejected on all sync/attest calls. UI in Settings: "Revoke a lost device". Auto-prompt after restore if >1 active device detected.
- [x] **Adaptive Anomaly Detection** — Warn (never block) on suspicious patterns. Wired from `confirmAppend()` post-append. `confirmed_at` normalised to ms internally. Thresholds scale with user's baseline (p95 hourly count × 3, floor 20). Local `anomaly_log` store + "Security alerts" review panel in Settings.
- [x] **Forgot Passcode Recovery** — OTP reset (email/SMS) if phone verified on device; UI wired, `pin-forgot-*` elements and server OTP flow complete
- [ ] **Session-aware Export 2FA** — Require OTP re-confirmation before Verified Report generation only if session is older than 4 hours. Avoids friction on every export.

### 🔲 Phase S3 — Compliance & Trust Layer
- [ ] **Time-limited Verify URLs** — Add `expires_at` to `attestations` table. Default: permanent (lenders reference reports months later). Opt-in expiry at generation (30d / 90d / permanent). `GET /verify/:vt_id` returns 410 GONE after expiry.
- [ ] **Signed JSON export** — Full ledger dump: every entry + signature + hash chain, signed by device key. For legal disputes and MFI submissions.
- [ ] **Passkeys (replace SMS OTP)** — WebAuthn passkeys are phishing-resistant. Defer until Termii SMS cost exceeds $10/month.
- [ ] **Encrypted records at rest** — AES-GCM on IndexedDB records store. Compliance checkbox more than practical defence at current scale (CSP + SRI solve the real XSS threat first). Revisit for MFI pilots requiring data-at-rest compliance.

### Anomaly Detection Logic (Phase S2)

**Principle: warn, never block. A false positive that stops a real transaction is worse than a missed anomaly.**

```
Flag if: current_hour_count > max(20, user_p95_hourly_count × 3)
```

`user_p95_hourly_count` = 95th percentile of hourly transaction counts over last 30 days, computed locally from IndexedDB. No server required.

- New user (no history) → threshold is 20
- Market trader who normally does 30/hour → threshold is 90
- Consultant who normally does 2/hour → threshold is 20 (floor never drops below 20)

**Additional pattern flags:**
- Same amount recorded 5+ times in under 10 minutes (copy-paste error or replay)
- Entry timestamp more than 2 minutes in the future (clock manipulation)
- `prev_entry_hash` referenced twice (fork attempt, caught client-side before sync)

**Response to flag:**
1. Does NOT block the record
2. Shows subtle warning: "Unusual activity detected — tap to review"
3. Logs to local `anomaly_log` IndexedDB store
4. After 3 unreviewed anomalies → prompt user to check recent records

---

## Phase 2 — Android Native (Evidence-Gated)

Triggered only when MFI pilot partners require hardware-backed key attestation beyond WebCrypto P-256. Not time-boxed.

Trigger conditions (any one):
1. An MFI partner formally requires Android Keystore StrongBox attestation
2. Field testing reveals WebCrypto P-256 insufficient for regulatory compliance
3. User acquisition exceeds PWA install friction threshold

Planned scope (from `docs/plans/prompts.md`):
- Kotlin + Jetpack Compose
- Android Keystore StrongBox: non-exportable P-256 key
- Vosk offline voice recognition (English, Hausa, Yoruba, Pidgin)
- Protobuf canonical serialization (SignedEntryV1)
- Migration: UnsignedEntryV0 → SignedEntryV1
- Kotest property test suite

---

## Tool Cost Reference

| Tool | Phase | Monthly |
|------|-------|---------|
| Railway (Node.js + PostgreSQL) | All | ~$5–15 |
| Termii SMS | All | ~$10 |
| Paystack | 1.5D+ | 1.5% + ₦100/txn |
| Resend (email) | 1.5D+ | Free tier |
| Vercel (site + PWA + portal) | All | Free tier |

---

## Revenue Model

| Stream | Mechanism | Status |
|--------|-----------|--------|
| Verified Report PDF | Paystack one-time (₦500–₦2,500) | ✅ Built, test keys |
| Pro subscription (no ads) | Paystack recurring — plan TBD | 🔲 Not wired |
| Ad network (free tier) | Google AdSense / house ads | ✅ House ads built |
| Direct ad placements | MFIs, fintech, B2B SaaS | 🔲 Outreach pending |
| Rewarded video ads | IronSource / AdMob Web | 🔲 House ad placeholder only |

**Target CPMs:** AdSense Nigeria ~$0.50–1 | Direct fintech placement ~$20–50 | Rewarded video ~$8–15
