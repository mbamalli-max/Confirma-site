# Confirma — Master Build Plan
**Patent:** USPTO Provisional 63/987,858
**Stack:** Vanilla JS PWA + Fastify/Node.js + Railway PostgreSQL
**Strategy:** PWA-first, server-anchored. Android/iOS deferred until MFI pilots require hardware attestation.
**Last updated:** 2026-03-29 (Phase 1.6C + Phase S2 security complete, device recovery live)

---

## Live Deployment

| Service | URL | Host |
|---------|-----|------|
| Marketing website | https://confirma-site.vercel.app | Vercel |
| PWA (installable) | https://confirma-site.vercel.app/app | Vercel |
| Verification portal | https://confirma-site.vercel.app/verify/:vt_id | Vercel |
| Sync server + API | https://confirma-site-production.up.railway.app | Railway |
| PostgreSQL | centerbeam.proxy.rlwy.net:43983 | Railway |
| GitHub repo | github.com/mbamalli-max/Confirma-site | GitHub |

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

**Environment variables (Railway):**
- `DATABASE_URL`, `DATABASE_SSL`, `HOST`, `PORT`
- `JWT_SECRET`, `SERVER_RECEIPT_SECRET`, `JWT_EXPIRY`
- `OTP_TTL_MINUTES`, `OTP_RATE_LIMIT_PER_HOUR`, `ALLOW_DEV_OTP`
- `PAYSTACK_SECRET_KEY` (not yet set to live key)
- `RESEND_API_KEY` (not yet set)
- `TERMII_API_KEY`, `TERMII_SENDER_ID` (not yet set)

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
- [ ] Set `RESEND_API_KEY` in Railway + verify sender domain
- [ ] Set `TERMII_API_KEY` in Railway (for real SMS OTP instead of dev codes)
- [ ] Set `ALLOW_DEV_OTP=false` in Railway for production

### Manual QA (not yet done)
- [ ] One live Paystack payment → PDF downloads → email arrives
- [ ] QR code from PDF scans → verify portal shows VALID
- [ ] 30-day streak → Bronze banner appears on dashboard
- [ ] Free export still works without payment
- [ ] Confirmation flow untouched — no payment gate

### Pending UX + Config + Testing Items
- [ ] **Forgot PIN recovery flow** — OTP reset if phone verified; else wipe + re-onboard (prompt 1 pending)
- [ ] **End-to-end device recovery test** — New device → restore from phone → pull records → see revocation prompt
- [ ] **CSP headers** — Add strict Content-Security-Policy via `vercel.json` (5 min task, high security impact)
- [ ] **Subresource Integrity (SRI)** — Add `integrity="sha384-..."` to Chart.js and QRCode.js CDN tags (5 min task)
- [ ] **Remove sync server URL from Settings UI** — Replace `https://confirma-site-production.up.railway.app` with "Connected / Last synced X min ago"
- [ ] **Short device ID only** — Settings shows first 8 chars of fingerprint as "Device ID"; hide full device_identity
- [ ] **Voice recording end-to-end test** — Nigerian English + US English; confirm correction dictionary triggers on manual edits
- [ ] **Accessibility audit for US users** — Screen reader end-to-end test, VoiceOver (iOS) + TalkBack (Android)
- [ ] **Brand rename** — Template prompt saved; run when name is chosen (Credentia or final decision)
- [ ] **AdSense account setup** — Publisher ID inserted into ad slots (replace house ads with real network)
- [ ] **Direct ad sales** — Approach Nigerian MFIs, banks, B2B SaaS for ₦20–50 CPM placements
- [ ] **Plan upgrade flow** — Wire `state.profile.plan` to Paystack subscription product (basic / pro)
- [ ] **Rewarded ad** — Replace house ad modal with real video ad network (AdMob web SDK or IronSource)

---

## Security Roadmap

### ✅ Current Security Posture
- ECDSA P-256 keypair per device (non-extractable, stored in IndexedDB)
- Append-only hash chain with server-side fork detection
- OTP phone verification → JWT auth
- HMAC-SHA256 server signatures on attestations
- Paystack HMAC-SHA512 webhook verification

### 🔲 Phase S1 — Quick Wins (< 1 day each)
- [ ] **CSP headers** — Add strict Content-Security-Policy via `vercel.json`. Prevents XSS from exfiltrating keys or records. Highest ROI security change available.
- [ ] **Subresource Integrity (SRI)** — Add `integrity="sha384-..."` to Chart.js and QRCode.js CDN tags. A compromised CDN response undoes all other security measures.
- [ ] **Remove server URL from Settings** — Replace `https://confirma-site-production.up.railway.app` display with "Connected / Last synced X min ago". No user needs the raw URL.
- [ ] **Short public key fingerprint only** — Show first 8 chars (`eda069ca`) as "Device ID" in Settings. Hide full 32-char device identity — internal value, no UX purpose.

### ✅ Phase S2 — Core Security Features (COMPLETE)
- [x] **PIN / Biometric Lock** — 6-digit PIN (PBKDF2 hash in IndexedDB). Disabling or changing PIN requires current PIN confirmation. Auto-lock after 5 min inactivity. WebAuthn progressive enhancement deferred.
  - ✅ Fixed PIN toggle security: disabling PIN now requires current PIN entry first
- [x] **Device Revocation** — `POST /identity/revoke` (OTP-authenticated). Revoked `device_identity` rejected on all sync/attest calls. UI in Settings: "Revoke a lost device". Auto-prompt after restore if >1 active device detected.
- [x] **Adaptive Anomaly Detection** — Warn (never block) on suspicious patterns. Wired from `confirmAppend()` post-append. `confirmed_at` normalised to ms internally. Thresholds scale with user's baseline (p95 hourly count × 3, floor 20). Local `anomaly_log` store + "Security alerts" review panel in Settings.
- [ ] **Forgot PIN Recovery** — OTP reset if phone verified on device; else wipe + re-onboard (pending Codex prompt 1)
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
