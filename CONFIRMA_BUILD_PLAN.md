# Confirma — Master Build Plan
**Patent:** USPTO Provisional 63/987,858
**Stack:** Vanilla JS PWA + Fastify/Node.js + Railway PostgreSQL
**Strategy:** PWA-first, server-anchored. Android/iOS deferred until MFI pilots require hardware attestation.
**Last updated:** 2026-03-28

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
| `POST /auth/otp/verify` | Verify OTP → JWT `auth_token` | ✅ Live |
| `POST /identity/register` | Register device identity with server | ✅ Live |
| `POST /identity/rotate` | OTP-verified key rotation | ✅ Live |
| `POST /sync/entries` | Upload signed entries, fork detection | ✅ Live |
| `POST /attest` | Issue vt_id attestation (JWT auth) | ✅ Live |
| `GET /verify/:vt_id` | Public verification endpoint (rate-limited) | ✅ Live |
| `POST /payment/webhook` | Paystack webhook (HMAC-SHA512 verified) | ✅ Live |
| `POST /payment/generate-pdf` | Generate verified report PDF (JWT auth) | ✅ Live |

**Schema tables:** `users`, `device_identities`, `ledger_entries`, `key_rotation_events`, `otp_challenges`, `attestations`, `payments`

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

### Pending UX Items
- [ ] Brand rename (template prompt saved — run when name is chosen)
- [ ] Client-side accent/dialect learning: Personal correction dictionary (user says X → ASR returns Y → user corrects to Z → store mapping). Build from user behavior, apply corrections before parsing. Zero cost, immediate value. (~1 day effort)

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
