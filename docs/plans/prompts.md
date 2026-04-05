# Confirma — Sequenced Build Prompts
**Workflow:** Claude Code plans and verifies. Codex executes.
**Rule:** Never open a new module in Codex without reading the plan first.
**Master reference:** `CONFIRMA_BUILD_PLAN.md` at project root.

---

## How to Use This File

Each prompt is labeled by tool:
- **[CLAUDE CODE]** — planning, reading, verification. Paste into a Claude Code session.
- **[CODEX]** — code generation only. Paste directly. Codex reads the plan file first, then implements.

Work through steps in order. Do not skip verification steps. Do not start the next phase until the current phase checklist passes.

---

## ✅ Phases 0, 1.5A, 1.5B, 1.5C, 1.5D — COMPLETE

All core attestation and payment infrastructure is live and tested.

---

## Current Position: Go-Live Setup + Manual QA

Remaining work before production launch:

### Short-Term Identity Model

- Phone number remains the backend identity anchor for device registration, sync, attestation, payments, and device revocation.
- Email OTP exists now as the truthful temporary access, verification, and recovery channel while SMS delivery is disabled.
- First-time server-backed activation still requires a valid phone number on the profile. Email alone must not create a partial sync identity.
- Existing phone-anchored accounts with a stored email can restore cleanly by email on a new device.
- A true email-first primary identity later would require moving ownership and foreign-key relationships away from `phone_number` across `users`, `device_identities`, `attestations`, and related server flows.

### STEP 1 — Set Environment Variables [MANUAL]

1. Set in `server/.env`:
   - `PAYSTACK_SECRET_KEY=sk_live_xxxx...` (from Paystack dashboard)
   - `RESEND_API_KEY=re_xxxx...` (from Resend)
2. Set in `app-v3/app.js` line 12:
   - Replace `PAYSTACK_PUBLIC_KEY` placeholder with live key from Paystack dashboard
   - OR move to runtime config if preferred
3. Ensure `VERIFY_BASE_URL` in `server/src/routes/attest.js` and `payment.js` points to production Vercel URL

### STEP 2 — Live Paystack Test [MANUAL QA]

1. Open PWA at production URL
2. Create test device + entries (30+ days streak to unlock Silver tier)
3. Navigate to export screen → "Verified Report (PDF)" section
4. Click "₦1,500 — 90 days" (Silver tier)
5. Complete Paystack payment (use test card from Paystack docs)
6. Verify:
   - PDF downloads successfully
   - PDF contains: cover with business info, vt_id, QR code
   - Entry list table is paginated and readable
   - Integrity footer shows root hash, server signature, patent notice
   - Email arrives (check spam folder)
   - QR code redirects to /verify/:vt_id portal → shows "VALID" badge

### STEP 3 — Verify Portal QR Scan [MANUAL QA]

1. Print or screenshot QR code from generated PDF
2. Scan with phone QR scanner → should redirect to `https://confirma-site.vercel.app/verify/[vt_id]`
3. Verify portal loads:
   - Green "VALID" badge
   - Shows attested_at, window range, entry count, key rotation count
   - No phone_number exposed (only 8-char device fingerprint)

### STEP 4 — Loan Readiness Banner [MANUAL QA]

1. Dashboard screen with 30+ day streak visible
2. Banner appears with 🥉 Bronze tier icon
3. Banner shows "You have XX days of verified history"
4. Click "Get Verified Report" → navigates to export screen
5. Repeat with 90+ day streak → banner shows 🥈 Silver tier

---

## Archived: Phase 1.5B→1.5D Build Steps

These are kept for reference but are now complete.

### STEP 1 — Verify Phase 1.5B End-to-End [CLAUDE CODE]

```
Read the following files in order:
- CONFIRMA_BUILD_PLAN.md (sections: Server Architecture, PWA Crypto, Phase 1.5B)
- server/server.js
- server/src/routes/auth.js
- server/src/routes/sync.js
- server/src/routes/identity.js
- server/src/crypto-verify.js
- app-v3/syncWorker.js

Then read docs/plans/plan-week-b.md.

Verify the implementation matches the plan. Report pass/fail for each:
1. JWT Bearer auth on POST /sync/entries
2. Signature verification uses P-256 ECDSA with IEEE P1363 encoding (dsaEncoding: "ieee-p1363")
3. Hash chain continuity: prev_entry_hash of incoming entry must match entry_hash of last stored entry
4. Fork detection: mismatch marks device FORKED and rejects with 409
5. HMAC receipt returned using SERVER_RECEIPT_SECRET
6. server.js registers all three route files (auth, sync, identity)

Report only. Do not fix.
```

---

## ✅ Phase 1.5C — Attestation Service (COMPLETE)

### STEP 2 — Implement Attestation Routes [CODEX]

```
Read docs/plans/plan-week-c.md fully before writing any code.
Read server/src/routes/sync.js to understand the existing route pattern.
Read server/src/auth-utils.js to understand buildReceiptSignature() and getBearerToken().
Read server/src/db.js to understand query() and withTransaction().

Then implement exactly as specified in plan-week-c.md:

1. Run the attestations table migration on Railway (use the migration script in the plan)
2. Add the attestations table DDL to server/schema.sql
3. Create server/src/routes/attest.js with:
   - POST /attest (JWT auth required, issues vt_id)
   - GET /verify/:vt_id (public, rate-limited via @fastify/rate-limit at 100 req/min per IP)
4. Install: cd server && npm install @fastify/rate-limit
5. Register routes in server/server.js

Constraints:
- vt_id must be crypto.randomBytes(16).toString("hex") — never Math.random() or sequential
- server_signature must use HMAC-SHA256 with SERVER_RECEIPT_SECRET
- GET /verify/:vt_id must return NO PII: no phone_number field, device_identity truncated to 8 chars
- Do not modify any existing routes (auth.js, sync.js, identity.js)
- Do not touch confirmationTransition(), appendLedgerRecord(), or any IndexedDB write path
```

### STEP 3 — Verify Attestation Routes [CLAUDE CODE]

```
Read server/src/routes/attest.js.
Read docs/plans/plan-week-c.md.

Verify against the plan. Report pass/fail for each:
1. vt_id generated with crypto.randomBytes(16).toString("hex")
2. server_signature is HMAC-SHA256 using SERVER_RECEIPT_SECRET with fields joined by "||"
3. GET /verify/:vt_id response contains NO phone_number field
4. GET /verify/:vt_id device_fingerprint is truncated to 8 chars (not full device_identity)
5. Rate limiting applied to GET /verify/:vt_id only — not to POST /attest
6. POST /attest rejects a device whose status is not ACTIVE (FORKED/REVOKED → 403)
7. POST /attest validates that device_identity belongs to the authenticated phone_number
8. ledger_root_hash is the entry_hash of the LAST entry in the window (not a hash-of-hashes)
9. window_start and window_end derived from actual confirmed_at timestamps in ledger_entries

Report only. Do not fix.
```

### STEP 4 — Update PWA Export [CODEX]

```
Read docs/plans/plan-week-c.md section "PWA Export Changes".
Read app-v3/app.js — find the export button handler (search for "export-button-v2" and the function that builds the export payload).
Read app-v3/syncWorker.js to understand postJson().

Then implement exactly as specified in plan-week-c.md:

1. Add qrcode.js CDN to app-v3/index.html before closing </body>:
   <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>

2. In the export function in app-v3/app.js:
   - After existing sync check, call POST /attest if state.authToken and state.deviceIdentity exist
   - Save vt_id and verify_url to IndexedDB settings on success
   - Add vt_id, verify_url, and QR code data URL to the export output
   - Update attestation language as specified in the plan

Constraints:
- Do not modify confirmationTransition(), appendLedgerRecord(), or getRecords()
- The POST /attest call must not block or gate the export if it fails — catch errors and export without attestation if server is unavailable
- Do not change the export data structure for fields that already exist
```

### STEP 5 — Build Verification Portal [CODEX]

```
Read docs/plans/plan-week-c.md section "Verification Portal".
Read website-v2/get-the-app.html fully — understand the Forest & Parchment design system:
  - CSS classes, color variables, font stack (Calistoga headings, Inter body)
  - Header/footer/shell patterns
  - Button styles (.btn, .btn-primary)
Read vercel.json to understand existing routing.

Then:

1. Create website-v2/verify.html — a static page that:
   - Extracts vt_id from window.location.pathname (last path segment)
   - On load, calls GET [server_url]/verify/[vt_id] via fetch
   - Renders a status badge: VALID = green (#52B788), FORKED/REVOKED = red (#B42318), UNKNOWN = grey (#6B7C6B)
   - Shows: attested_at (human-readable date), window range, entry count, key_rotation_events count, fork_status
   - Shows "Unable to reach verification server" on network error
   - Matches website-v2 Forest & Parchment design exactly

2. Add to vercel.json routes array:
   { "source": "/verify/:vt_id", "destination": "/verify.html" }

The server URL should be read from a config constant at the top of verify.html — set to the Railway server URL.
```

### STEP 6 — End-to-End Week C Verification [CLAUDE CODE]

```
Read docs/plans/plan-week-c.md section "Week C Deliverable Checklist".

Check each item by reading the relevant files:
- server/src/routes/attest.js — POST /attest and GET /verify/:vt_id present
- server/server.js — attest routes registered
- server/schema.sql — attestations table present
- app-v3/index.html — qrcode.js script tag present
- app-v3/app.js — export function calls POST /attest, includes vt_id and QR code
- website-v2/verify.html — exists and matches Forest & Parchment design
- vercel.json — /verify/:vt_id route present

Then start the server (npm run dev) and test:
- POST /attest with a valid JWT → confirm vt_id in response
- GET /verify/[that vt_id] → confirm VALID, no phone_number in response
- GET /verify/nonexistent → confirm { "status": "UNKNOWN" }

Report pass/fail for every checklist item. If anything fails, identify the exact file and line number.
```

---

## ✅ Phase 1.5D — Verified Reports + Paystack (COMPLETE)

### STEP 7 — Plan Week D [CLAUDE CODE]

```
Read CONFIRMA_BUILD_PLAN.md section "Phase 1.5D".
Read docs/plans/plan-week-c.md to understand the attestation data shape (vt_id, ledger_root_hash, entry_count, verify_url).
Read app-v3/app.js — find the export screen and dashboard screen (search for "screen-export" and "screen-dashboard").
Read server/src/routes/attest.js to understand what data is available post-attestation.

Produce docs/plans/plan-week-d.md covering:

1. Paystack inline JS integration:
   - Which screen shows the payment button (export screen, before PDF download)
   - Three tiers: ₦500 (30-day window), ₦1,500 (90-day window), ₦2,500 (full history)
   - Paystack public key config location
   - What happens after payment success (trigger POST /attest → POST /payment/generate-pdf)

2. Server-side PDF spec using pdfkit:
   - Fields to include: business name, date range, entry count, full entry list, ledger_root_hash, vt_id, QR code, device fingerprint (8 chars), patent notice
   - Page layout and section order
   - Where to serve the PDF (download endpoint vs base64 in response)

3. Paystack webhook:
   - POST /payment/webhook route
   - Verification: HMAC-SHA512 with Paystack secret key (header: x-paystack-signature)
   - On confirmed charge.success: trigger attestation + PDF generation

4. Loan readiness banner:
   - Placement: dashboard screen, between metric grid and chart (never export screen)
   - Bronze trigger: streak >= 30 days — "You have 30 days of verified history. Generate your Verified Report."
   - Silver trigger: streak >= 90 days — "You have 90 days of verified history. Your Verified Report is ready."
   - Banner links to export screen

5. Email delivery via Resend.com:
   - Triggered after PDF generated
   - Contains download link or PDF attachment
   - From address and template

Cross-reference constraint: TAS §13.6 — payment gate is strictly pre-PDF, never pre-confirmation.
confirmationTransition() must never be gated by payment. Ledger formation is always free.
```

### STEP 8 — Implement Paystack + PDF [CODEX]

```
Read docs/plans/plan-week-d.md fully before writing any code.
Read server/src/routes/attest.js to understand the attestation data shape.
Read app-v3/app.js — find the export screen handler and dashboard screen handler.

Then implement exactly as specified in plan-week-d.md:

1. Install server dependencies: npm install pdfkit resend
2. Create server/src/routes/payment.js with:
   - POST /payment/webhook (HMAC-SHA512 Paystack verification first — reject without verifying)
   - POST /payment/generate-pdf (JWT auth, generates and returns PDF)
3. Register payment routes in server/server.js
4. Add Paystack inline script to app-v3/index.html
5. Add payment tier buttons to the export screen in app-v3/app.js
6. Add loan readiness banner to the dashboard screen in app-v3/app.js

Constraints:
- Webhook HMAC must be verified BEFORE any action — never trust unverified webhooks
- PDF must be generated server-side only — never client-side
- confirmationTransition() must NOT be gated or modified
- appendLedgerRecord() must NOT be gated or modified
- getRecords() must NOT be modified
- Loan readiness banner goes on the dashboard, not the export screen
```

### STEP 9 — Verify Week D [CLAUDE CODE]

```
Read server/src/routes/payment.js.
Read app-v3/app.js — the export screen and dashboard screen sections.
Read docs/plans/plan-week-d.md.

Verify and report pass/fail for each:
1. Paystack webhook: HMAC-SHA512 signature verified using x-paystack-signature header BEFORE any processing
2. PDF generated server-side only (pdfkit in Node.js) — no jsPDF or client-side generation
3. PDF contains: full entry list, attested ledger_root_hash, vt_id, QR code, device fingerprint (8 chars)
4. confirmationTransition() is unmodified — not gated by payment
5. appendLedgerRecord() is unmodified — not gated by payment
6. Loan readiness banner is on the DASHBOARD screen, not the export screen
7. Banner fires at streak >= 30 (Bronze) and streak >= 90 (Silver)
8. Free export (without PDF) remains available — no paywall on basic ledger access

Report only. Do not fix.
```

---

## Phase 2 — Android Native (Evidence-Gated)

### Trigger Check — Run Only When Evidence Exists [CLAUDE CODE]

Only proceed when at least one trigger condition from CONFIRMA_BUILD_PLAN.md is met. Fill in [TRIGGER] below:

```
Read CONFIRMA_BUILD_PLAN.md section "Phase 2 — Android Native".

We have received the following trigger evidence: [TRIGGER — describe the MFI requirement or field data].

Produce docs/plans/plan-phase2-android.md covering:
1. Kotlin + Jetpack Compose project setup — module structure, build.gradle dependencies
2. Android Keystore StrongBox keypair: non-exportable P-256 key, survives app reinstall, private key never leaves hardware
3. Vosk offline voice recognition: 4 language models (English, Hausa, Yoruba, Pidgin), model download on first launch, fallback to Web Speech API if unavailable
4. Kotest property test suite: idempotence of confirmationTransition, monotonic ID progression, append-only invariant on records store, signature verification round-trip
5. Protobuf canonical serialization: replaces JS pipe-delimited string for canonical entry hash input — define .proto schema for SignedEntryV1
6. Migration path: UnsignedEntryV0 (legacy JS records) → SignedEntryV1 (Protobuf) — server must accept both formats during transition window

Cross-reference constraint: all Kotest property tests must pass before any module is considered complete.
```

---

## General Rules for Every Session

1. **Always read the plan file first.** If the plan for the current week does not exist, stop and ask Claude Code to produce it.
2. **Never modify protected functions.** If any session touches `confirmationTransition()`, `appendLedgerRecord()`, `getRecords()`, or the IndexedDB records write path — revert and re-run.
3. **Crypto changes need manual review.** After any session touching keypair gen, entry signing, receipt signing, or hash computation — run the Claude Code verification step before proceeding.
4. **One week at a time.** Do not start Week D until the Week C checklist passes. Do not start Week C until the 1.5B end-to-end checklist passes.
5. **Minimal diffs.** Each Codex session should only touch files named in the plan. If it suggests changes outside scope — reject them and rerun with the scope constraint explicit in the prompt.
6. **Verification is not optional.** Every implementation step has a paired verification step. Do not skip.
