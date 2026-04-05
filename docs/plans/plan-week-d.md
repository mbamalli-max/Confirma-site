# plan-week-d — Verified Reports + Paystack
**Date:** 2026-03-28
**Depends on:** plan-week-c.md (attestation service live, vt_id, verify portal)

---

## Goal

A user taps "Generate Verified Report", pays via Paystack, and receives a server-generated PDF with full ledger history, attested root hash, QR code, and patent notice. This is the first revenue event.

---

## Non-Negotiables

- `confirmationTransition()` must NEVER be gated by payment — ledger writes are always free
- `appendLedgerRecord()` must NEVER be gated by payment
- `getRecords()` must NOT be modified
- Free export (plain text) remains available — no paywall on basic ledger access
- Paystack webhook HMAC-SHA512 must be verified BEFORE any action
- PDF is generated server-side only (pdfkit) — never client-side
- Payment gate is strictly pre-PDF, never pre-confirmation (TAS §13.6)

---

## 1. Paystack Inline Integration

### Placement
Export screen (`screen-export` in `app-v3/index.html`), below the existing free export button.

### Three Tiers

| Tier | Price | Window | Description |
|------|-------|--------|-------------|
| Bronze | ₦500 | 30 days | Last 30 days of confirmed entries |
| Silver | ₦1,500 | 90 days | Last 90 days of confirmed entries |
| Gold | ₦2,500 | Full history | All confirmed entries since account creation |

### HTML Addition (app-v3/index.html)

Inside `#screen-export .panel`, after the free export button and before `export-status-v2`:

```html
<div class="verified-report-section" id="verified-report-section" hidden>
  <h3>Verified Report (PDF)</h3>
  <p class="subtle">Server-attested PDF with QR code, full entry list, and integrity proof. Accepted by lenders.</p>
  <div class="payment-tiers" id="payment-tiers">
    <button class="btn btn-secondary tier-btn" data-tier="bronze" data-amount="50000" data-window="30" type="button">
      ₦500 — 30 days
    </button>
    <button class="btn btn-secondary tier-btn" data-tier="silver" data-amount="150000" data-window="90" type="button">
      ₦1,500 — 90 days
    </button>
    <button class="btn btn-primary tier-btn" data-tier="gold" data-amount="250000" data-window="0" type="button">
      ₦2,500 — Full history
    </button>
  </div>
  <p class="record-meta" id="payment-status"></p>
</div>
```

Note: Paystack amounts are in kobo (₦500 = 50000 kobo).

### Paystack Script (app-v3/index.html)

Before closing `</body>`, after qrcode.js:

```html
<script src="https://js.paystack.co/v2/inline.js"></script>
```

### Config Constant (app-v3/app.js)

Near top of file:

```js
const PAYSTACK_PUBLIC_KEY = "pk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
```

Replace with actual key from environment or config. For now, use the test key placeholder.

### Payment Flow (app-v3/app.js)

Add function `initPaystackPayment(tier, amountKobo, windowDays)`:

1. Validate `state.authToken` and `state.deviceIdentity` exist — show error if not
2. Generate a unique reference: `"cfm_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8)`
3. Initialize Paystack popup:
   ```js
   const popup = new PaystackPop();
   popup.newTransaction({
     key: PAYSTACK_PUBLIC_KEY,
     email: state.profile.email || (state.profile.phone_number + "@confirma.app"),
     amount: amountKobo,
     currency: "NGN",
     ref: reference,
     metadata: {
       custom_fields: [
         { display_name: "Phone", variable_name: "phone", value: state.profile.phone_number },
         { display_name: "Tier", variable_name: "tier", value: tier },
         { display_name: "Window Days", variable_name: "window_days", value: String(windowDays) },
         { display_name: "Device Identity", variable_name: "device_identity", value: state.deviceIdentity }
       ]
     },
     onSuccess: (transaction) => handlePaymentSuccess(transaction, windowDays),
     onCancel: () => { document.getElementById("payment-status").textContent = "Payment cancelled."; }
   });
   ```
4. `handlePaymentSuccess(transaction, windowDays)`:
   - Show "Generating your verified report..."
   - Call `POST /payment/generate-pdf` with `{ reference: transaction.reference, window_days: windowDays }`
   - On success: trigger PDF download from base64 response
   - On failure: show "Report generation failed. Contact support with reference: [ref]"

### Show/Hide Logic

In `renderExportScreen()`: show `#verified-report-section` only when `state.authToken && state.deviceIdentity` (phone verified + device registered). Hide otherwise.

Wire tier button clicks in `initApp()`:
```js
document.querySelectorAll(".tier-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    initPaystackPayment(btn.dataset.tier, Number(btn.dataset.amount), Number(btn.dataset.window));
  });
});
```

---

## 2. Server-Side PDF Generation

### Dependencies

```bash
cd server && npm install pdfkit
```

### Route File: `server/src/routes/payment.js`

#### POST /payment/generate-pdf

**Auth:** JWT Bearer token required.

**Request body:**
```json
{
  "reference": "cfm_1234567890_abc123",
  "window_days": 90
}
```

**Logic (in order):**
1. Authenticate JWT, extract `phone_number`
2. Validate `reference` is a non-empty string
3. Verify payment with Paystack API:
   ```js
   const verification = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), {
     headers: { Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY }
   });
   const result = await verification.json();
   if (!result.data || result.data.status !== "success") return reply.code(402).send({ error: "Payment not confirmed" });
   ```
4. Extract `device_identity` and `window_days` from Paystack metadata (or use request body values)
5. Validate device belongs to this phone_number (same check as POST /attest)
6. Call POST /attest logic internally (or query existing attestation) to get vt_id
7. Query ledger entries for the window (or all entries if window_days = 0)
8. Generate PDF with pdfkit
9. Return PDF as base64:
   ```json
   {
     "ok": true,
     "pdf_base64": "<base64-encoded PDF>",
     "filename": "confirma-verified-report-2026-03-28.pdf",
     "vt_id": "..."
   }
   ```

### PDF Layout (pdfkit)

Page size: A4 (595.28 x 841.89 points)

**Page 1 — Cover:**
- Title: "Confirma Verified Report" (24pt, bold)
- Subtitle: "Server-Attested Business Activity Ledger"
- Business name / display_name (if set)
- Report date range: window_start to window_end
- Generated: current date/time
- Device fingerprint: first 8 chars of device_identity
- Entry count
- Verification ticket: vt_id
- QR code image (generated server-side using `qrcode` npm package → PNG buffer → pdfkit image)
- Verification URL below QR
- Status badge: "VALID" with green indicator

**Pages 2+ — Entry List:**
- Table header: ID | Type | Label | Amount | Date | Signed
- One row per entry, from oldest to newest
- Page break every ~30 rows
- Running total at bottom of each page

**Final Page — Integrity Footer:**
- Ledger Root Hash (full 64-char hex)
- Server Signature (HMAC)
- Attestation timestamp
- Device fingerprint (8 chars)
- Key rotation events count
- Patent notice: "Protected under USPTO Provisional Application 63/987,858. Confirma Temporal Attestation System (TAS). Unauthorized reproduction of this attestation mechanism is prohibited."

### QR Code Server-Side

```bash
cd server && npm install qrcode
```

Generate QR as PNG buffer:
```js
import QRCode from "qrcode";
const qrBuffer = await QRCode.toBuffer(verifyUrl, { width: 200, margin: 1 });
```

Then embed in PDF:
```js
doc.image(qrBuffer, x, y, { width: 120 });
```

---

## 3. Paystack Webhook

### Route: POST /payment/webhook

**Auth:** HMAC-SHA512 signature verification only (no JWT).

**Logic:**
1. Read raw body (Fastify: use `request.rawBody` — register `fastify-raw-body` or use `preParsing` hook)
2. Compute HMAC-SHA512: `crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(rawBody).digest("hex")`
3. Compare with `request.headers["x-paystack-signature"]` — if mismatch, return 401 immediately. **Do NOT process unverified webhooks.**
4. Parse body JSON
5. If `event === "charge.success"`:
   - Extract reference, metadata (phone, device_identity, window_days, tier)
   - Log payment event (optional: insert into a `payments` table for audit)
   - The actual PDF generation happens client-initiated via POST /payment/generate-pdf after Paystack popup onSuccess. The webhook is a safety net / audit trail.
6. Return 200 OK (Paystack requires 200 to stop retries)

### Raw Body Setup

Option A — preParsing hook (no extra dependency):
```js
app.addHook("preParsing", async (request, reply, payload) => {
  if (request.url === "/payment/webhook" && request.method === "POST") {
    const chunks = [];
    for await (const chunk of payload) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    request.rawBody = raw;
    // Return a new readable stream for Fastify to parse
    const { Readable } = await import("node:stream");
    return Readable.from(raw);
  }
  return payload;
});
```

Option B — `@fastify/raw-body` plugin. Either approach works.

### Environment Variables (server/.env)

Add:
```
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 4. Loan Readiness Banner

### Placement

Dashboard screen (`screen-dashboard`), between the chart panel (`.chart-panel`) and the "Recent confirmed records" panel. **Never on the export screen.**

### HTML Addition (app-v3/index.html)

After `</div>` closing `.chart-panel` (after line 353), before the "Recent confirmed records" panel:

```html
<div class="panel loan-readiness-banner" id="loan-readiness-banner" hidden>
  <div class="banner-content">
    <span class="banner-icon" id="banner-tier-icon">🥉</span>
    <div>
      <strong id="banner-headline">You have 30 days of verified history.</strong>
      <p class="subtle" id="banner-subtext">Generate your Verified Report to share with lenders.</p>
    </div>
  </div>
  <button class="btn btn-primary btn-sm" id="banner-cta" type="button" data-target-screen="screen-export">Get Verified Report</button>
</div>
```

### JS Logic (app-v3/app.js)

In `renderDashboard()`, after the streak calculation (after line 779):

```js
const banner = document.getElementById("loan-readiness-banner");
if (banner && state.authToken && state.deviceIdentity) {
  if (streak >= 90) {
    document.getElementById("banner-tier-icon").textContent = "🥈";
    document.getElementById("banner-headline").textContent = "You have " + streak + " days of verified history.";
    document.getElementById("banner-subtext").textContent = "Your Verified Report is ready. Share it with lenders.";
    banner.hidden = false;
  } else if (streak >= 30) {
    document.getElementById("banner-tier-icon").textContent = "🥉";
    document.getElementById("banner-headline").textContent = "You have " + streak + " days of verified history.";
    document.getElementById("banner-subtext").textContent = "Generate your Verified Report to share with lenders.";
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
} else if (banner) {
  banner.hidden = true;
}
```

Wire the CTA button to navigate to export screen (already handled by `data-target-screen`).

### CSS Addition (app-v3/styles.css)

```css
.loan-readiness-banner {
  background: linear-gradient(135deg, #E8F5E9, #D8F3DC);
  border: 1px solid #52B788;
  border-radius: var(--r-md);
  padding: 1rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.loan-readiness-banner .banner-content {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex: 1;
}

.loan-readiness-banner .banner-icon {
  font-size: 1.5rem;
}

.loan-readiness-banner .btn-sm {
  min-height: 36px;
  padding: 0 1rem;
  font-size: 0.85rem;
  white-space: nowrap;
}
```

---

## 5. Email Delivery via Resend

### Dependency

```bash
cd server && npm install resend
```

### Implementation

In `POST /payment/generate-pdf`, after PDF is generated:

1. If user has an email address (from Paystack metadata or profile), send the PDF via Resend
2. Use Resend SDK:
   ```js
   import { Resend } from "resend";
   const resend = new Resend(process.env.RESEND_API_KEY);

   await resend.emails.send({
     from: "Confirma <reports@confirma.app>",
     to: email,
     subject: "Your Confirma Verified Report",
     html: `
       <p>Your Verified Report is attached.</p>
       <p>Verification ID: ${vtId}</p>
       <p>Verify online: <a href="${verifyUrl}">${verifyUrl}</a></p>
       <p>— Confirma</p>
     `,
     attachments: [{
       filename: filename,
       content: pdfBuffer
     }]
   });
   ```
3. Email delivery is best-effort — catch errors and still return the PDF to the client
4. Do NOT gate PDF delivery on email success

### Environment Variables (server/.env)

Add:
```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
```

---

## 6. Payments Table (Audit Trail)

### Schema Addition (server/schema.sql)

```sql
CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  phone_number TEXT NOT NULL REFERENCES users(phone_number),
  device_identity TEXT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  amount_kobo INTEGER NOT NULL,
  tier TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  paystack_status TEXT NOT NULL DEFAULT 'pending',
  vt_id TEXT REFERENCES attestations(vt_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payments_phone
  ON payments (phone_number, created_at DESC);
```

Run migration on Railway:
```bash
cd server
node -e "
import('./src/db.js').then(({ query }) =>
  query(\`CREATE TABLE IF NOT EXISTS payments (
    id BIGSERIAL PRIMARY KEY,
    phone_number TEXT NOT NULL,
    device_identity TEXT NOT NULL,
    reference TEXT UNIQUE NOT NULL,
    amount_kobo INTEGER NOT NULL,
    tier TEXT NOT NULL,
    window_days INTEGER NOT NULL,
    paystack_status TEXT NOT NULL DEFAULT 'pending',
    vt_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )\`).then(() => { console.log('done'); process.exit(0); })
)
"
```

---

## Register Routes in server.js

```js
import { registerPaymentRoutes } from "./src/routes/payment.js";
// ...
await registerPaymentRoutes(app);
```

---

## Implementation Order

1. `npm install pdfkit qrcode resend` in server/
2. Run `payments` table migration on Railway
3. Add payments table to `server/schema.sql`
4. Create `server/src/routes/payment.js` (webhook + generate-pdf)
5. Register payment routes in `server/server.js`
6. Add Paystack script + payment tiers to `app-v3/index.html`
7. Add payment flow + tier buttons to `app-v3/app.js`
8. Add loan readiness banner to `app-v3/index.html`
9. Add banner logic to `renderDashboard()` in `app-v3/app.js`
10. Add banner CSS to `app-v3/styles.css`
11. Test end-to-end: pay → attest → PDF → email

---

## Week D Deliverable Checklist

- [ ] POST /payment/webhook verifies HMAC-SHA512 BEFORE any processing
- [ ] POST /payment/generate-pdf returns server-generated PDF (pdfkit, not client-side)
- [ ] PDF contains: full entry list, attested ledger_root_hash, vt_id, QR code, device fingerprint (8 chars), patent notice
- [ ] Paystack inline popup works with three tiers (₦500, ₦1,500, ₦2,500)
- [ ] `confirmationTransition()` is unmodified — NOT gated by payment
- [ ] `appendLedgerRecord()` is unmodified — NOT gated by payment
- [ ] `getRecords()` is unmodified
- [ ] Free export (plain text) still works without payment
- [ ] Loan readiness banner is on DASHBOARD screen, not export screen
- [ ] Banner fires at streak >= 30 (Bronze) and streak >= 90 (Silver)
- [ ] Email delivery via Resend is best-effort (does not gate PDF response)
- [ ] All existing routes (auth, sync, identity, attest) still work (no regression)
