# Confirma — Go-Live Checklist

**Status:** Phase 1.5D complete. Ready for go-live configuration and manual QA.

---

## Pre-Launch Configuration

### Environment Setup

- [ ] **Paystack Live Keys**
  - [ ] Obtain live `sk_live_...` and `pk_live_...` from Paystack dashboard
  - [ ] Set `PAYSTACK_SECRET_KEY=sk_live_...` in `server/.env`
  - [ ] Replace `PAYSTACK_PUBLIC_KEY` placeholder in `app-v3/app.js` line 12 with live key
  - [ ] Test: webhook signature validation works with live key

- [ ] **Resend Email API**
  - [ ] Create Resend account and get API key
  - [ ] Set `RESEND_API_KEY=re_...` in `server/.env`
  - [ ] Verify `from: "Confirma <reports@confirma.app>"` domain is verified in Resend
  - [ ] Test: send a test email from Node.js script

- [ ] **Verification Portal URL**
  - [ ] Confirm `VERIFY_BASE_URL` in `server/src/routes/attest.js` line 9 points to production Vercel URL (e.g., `https://confirma-site.vercel.app`)
  - [ ] Confirm `VERIFY_BASE_URL` in `server/src/routes/payment.js` line 9 is same
  - [ ] Test: generated verify URLs are correct

### Database Migrations

- [ ] **Attestations Table** — Already exists on Railway (created during Week C)
- [ ] **Payments Table** — Already exists on Railway (created during Week D)
- [ ] **Verify indexes exist:**
  - `idx_attestations_device`
  - `idx_payments_phone`

### Deployment

- [ ] **Server (Railway)**
  - [ ] Push latest `server/` code to production branch
  - [ ] Verify all environment variables are set in Railway dashboard
  - [ ] Server boots without errors: `npm run dev` or production process manager
  - [ ] Health check passes: `GET /health` → `{ "ok": true }`

- [ ] **PWA (Vercel)**
  - [ ] Push latest `app-v3/` code (HTML, CSS, JS, SW)
  - [ ] Verify Paystack script loads: `https://js.paystack.co/v2/inline.js`
  - [ ] Verify qrcode.js loads: `https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js`

- [ ] **Verification Portal (Vercel)**
  - [ ] Push `website-v2/verify.html` and updated `vercel.json`
  - [ ] Test portal access: `https://confirma-site.vercel.app/verify/test-vt-id`

---

## Manual QA

### Test User Setup

- [ ] **Create test user account**
  - Phone: +1 (US) or +234 (NG) test number
  - Region: Choose one
  - Business type: Any

- [ ] **Generate 30+ days of confirmed entries**
  - Record 3–5 transactions per day for 31 days
  - Ensures Bronze tier (30 days) and Silver tier (90 days) banners can be tested
  - Use realistic amounts and labels (food, transport, etc.)

### Free Export (Baseline)

- [ ] **Plain-text export works (no payment)**
  - [ ] Tap "Export" → "Generate export"
  - [ ] File downloads successfully as `.txt`
  - [ ] Contains: entries, ledger root hash, verification status
  - [ ] Verification status says: "Device-signed and server-attested. Verify at..." (if 30+ days)

### Paystack Payment Flow

- [ ] **Payment UI appears correctly**
  - [ ] Export screen shows "Verified Report (PDF)" section with 3 tier buttons
  - [ ] Buttons show: ₦500 (30 days), ₦1,500 (90 days), ₦2,500 (Full history)

- [ ] **Bronze Tier (30 days, ₦500)**
  - [ ] Click "₦500 — 30 days" → Paystack popup opens
  - [ ] Use Paystack test card (provided in Paystack docs)
  - [ ] Payment succeeds → popup closes → "Generating your verified report..." appears
  - [ ] PDF downloads automatically (check Downloads folder)
  - [ ] Check browser console for no errors

- [ ] **Silver Tier (90 days, ₦1,500) — only testable with 90+ day streak**
  - [ ] Repeat with 90-day streak
  - [ ] Verify same flow
  - [ ] PDF downloads

- [ ] **Gold Tier (Full history, ₦2,500)**
  - [ ] Click "₦2,500 — Full history"
  - [ ] Payment succeeds
  - [ ] PDF downloads with all entries (not windowed)

### PDF Content Verification

For each downloaded PDF:

- [ ] **Cover Page**
  - [ ] Title: "Confirma Verified Report"
  - [ ] Business name/display_name visible
  - [ ] Phone number shown
  - [ ] Report date range: "01/01/2026 to 03/27/2026" (example)
  - [ ] Device fingerprint: 8 hex chars (e.g., "a3f1c8d2")
  - [ ] Entry count: matches actual confirmed entries
  - [ ] Verification ticket (vt_id): 32 hex chars
  - [ ] Status badge: Green "VALID" indicator
  - [ ] QR code: visible and scannable
  - [ ] Verification URL below QR: clickable link

- [ ] **Entry List Pages**
  - [ ] Table headers: ID, Type, Label, Amount, Date, Signed
  - [ ] All entries listed (oldest to newest)
  - [ ] Amounts formatted correctly (₦X,XXX.XX)
  - [ ] Dates human-readable
  - [ ] "Signed: Yes" for confirmed entries
  - [ ] Page breaks every ~30 rows
  - [ ] Running total at bottom of each page

- [ ] **Integrity Footer**
  - [ ] Ledger Root Hash: full 64-char hex string
  - [ ] Server Signature: HMAC hex string
  - [ ] Attestation Timestamp: ISO date + time
  - [ ] Device Fingerprint: 8 chars
  - [ ] Key Rotation Events: count (0 if no rotations)
  - [ ] Verification Ticket (vt_id): matches cover
  - [ ] Verification URL: clickable, matches cover
  - [ ] Patent notice visible and readable

### Email Delivery

- [ ] **Email arrives within 2 minutes**
  - [ ] Check inbox of email associated with payment
  - [ ] Subject: "Your Confirma Verified Report"
  - [ ] Body mentions vt_id and verification URL
  - [ ] PDF attachment present and opens correctly
  - [ ] Check spam folder if not in inbox

### Verification Portal (QR Scan)

- [ ] **Scan QR from PDF**
  - [ ] Phone camera → opens portal link
  - [ ] Browser shows: `https://confirma-site.vercel.app/verify/[vt_id]`

- [ ] **Portal page loads and displays**
  - [ ] Status badge: Green "VALID"
  - [ ] Attested at: ISO date (matches PDF)
  - [ ] Device fingerprint: 8 chars (matches PDF)
  - [ ] Window range: start date to end date
  - [ ] Entry count: matches PDF
  - [ ] Key rotation events: count matches
  - [ ] Fork status: "NORMAL"
  - [ ] **Important:** No phone number field visible anywhere

- [ ] **Test unknown vt_id**
  - [ ] Manually navigate to: `https://confirma-site.vercel.app/verify/unknownvtid12345`
  - [ ] Shows grey "UNKNOWN" badge
  - [ ] No crash or error

### Loan Readiness Banner

- [ ] **With 30-day streak**
  - [ ] Dashboard screen loads
  - [ ] Banner appears (yellow/green box below chart)
  - [ ] Shows 🥉 Bronze icon
  - [ ] Text: "You have 30 days of verified history. Generate your Verified Report to share with lenders."
  - [ ] Button: "Get Verified Report" → navigates to export screen

- [ ] **With 90-day streak**
  - [ ] Dashboard reloads (or refresh after 90 entries)
  - [ ] Banner shows 🥈 Silver icon
  - [ ] Text: "You have 90 days of verified history. Your Verified Report is ready. Share it with lenders."
  - [ ] Button still works

- [ ] **With < 30 days**
  - [ ] Banner hidden (not visible)

### Regression Tests

- [ ] **Free export still works** — Plain-text export unaffected by payment changes
- [ ] **Confirmation flow untouched** — Tapping "Confirm" on new entry still works, no payment gate
- [ ] **Sync works** — New entries sync to server without payment involvement
- [ ] **Phone verification works** — OTP flow unaffected
- [ ] **Device key rotation works** — If tested, key rotation does not interfere

---

## Known Limitations (Document for Support)

- [ ] Paystack test key vs. live key require manual config change
- [ ] Email delivery is best-effort (failed emails don't gate PDF download)
- [ ] QR code is static URL — no expiration on verification links (intentional for long-term proof)
- [ ] Android native app not yet available — PWA is primary interface

---

## Post-Launch Monitoring

- [ ] **Check server logs daily for first week**
  - Payment webhook errors
  - PDF generation failures
  - Email delivery failures

- [ ] **Monitor Railway PostgreSQL**
  - Payments table growing as expected
  - Attestations table entries match payments

- [ ] **Test Paystack webhooks**
  - Confirm webhook hits server correctly
  - Payment records stored with correct metadata
  - Check server logs: "Payment webhook processing failed" or similar errors

---

## Rollback Plan

If critical issue found:

1. Revert `server/src/routes/payment.js` to previous commit
2. Revert `app-v3/` Paystack changes
3. Redeploy to Vercel and Railway
4. Free export will still work (unaffected by payment route removal)
5. Users can still access attestation portal (/verify endpoints)

---

## Sign-Off

- [ ] All items completed
- [ ] No regressions detected
- [ ] Ready to announce go-live to first users

**Date Completed:** _______________
**Tested By:** _______________
**Approval:** _______________
