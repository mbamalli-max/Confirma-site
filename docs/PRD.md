# Product Requirements Document (PRD)
**Project:** Konfirmata
**Patent:** USPTO Provisional 63/987,858
**Version:** 3.5.6
**Date:** 2026-05-18

---

## §1. Product Overview

Konfirmata is a mobile-first Progressive Web App (PWA) that helps users create user-confirmed, tamper-evident business activity records whose integrity, sequence, and device origin can be cryptographically verified. It is designed for small business operators, traders, and informal economy participants who need durable, portable records of their business activity but have no access to traditional bookkeeping infrastructure.

### Core Thesis

> Ledger formation and verified report export are free. There are no paid tiers, payment gates, ad unlocks, or scoring features in the current product.

The app captures daily transactions via voice, text, or visual selection. Every record is cryptographically signed using a device-bound keypair and linked into an append-only hash chain. The free text export embeds the device public key together with per-entry verification data so a technically capable third party can verify entry integrity offline from the file itself. Authenticated users can also generate a free server-attested PDF report with a QR code, public verification URL, canonical attestation payload, server signature, and verification key URL. The verified report covers server-synced records from device identities linked to the account, and each ledger row identifies the device that recorded the entry.

### Value Proposition

| For the user | For the institution |
|---|---|
| Free, structured record of every transaction | Cryptographically signed ledger they can verify |
| No app store required (PWA) | Tamper-evidence via hash chain + ECDSA |
| Works offline, syncs when connected | Immutable history with fork detection |
| Voice-first capture in < 5 seconds | Free server-attested PDF with QR verification |

---

## §2. User Personas

### Primary: Informal Business Operator
- **Context**: Market trader, food vendor, artisan, transport operator, online seller
- **Region**: Nigeria (primary), United States, global expansion
- **Device**: Android smartphone (primary), iOS
- **Literacy**: Functional — can read labels and tap buttons
- **Technical literacy**: Low — no prior bookkeeping experience
- **Pain point**: Lacks durable records of business activity that can be reviewed by formal institutions
- **Goal**: Build a verifiable transaction history for documentation continuity and institutional review

### Secondary: Lending Officer / Underwriter
- **Context**: Financial institution, development program, NGO, or other formal reviewer
- **Use case**: Receives a Konfirmata Verified Report PDF from an applicant, participant, or business owner
- **Need**: Verify that the history is genuine, untampered, and attributable to a specific device
- **Interaction**: Scans QR code on PDF → verification portal shows VALID/FORKED/REVOKED

### Tertiary: Developer / Integration Partner
- **Context**: Fintech, research, or program partner building on top of Konfirmata's attestation API
- **Need**: Programmatic access to attestation status, ledger integrity fields, and verification metadata

---

## §3. Global Availability Model

Konfirmata supports a global country selector at onboarding. Users may select any country from the ISO 3166-1 alpha-2 list. Country selection does not imply full feature parity across all regions.

Country handling is explicitly separated into three independent dimensions:

### 3.1 Three Dimensions

| Dimension | Field | Source | Governs |
|---|---|---|---|
| Phone country | `phone_country` (stored as `country`) | Derived from phone prefix at OTP | Phone number normalization only |
| Operating region | `operating_region` | Selected by user at onboarding | Currency, capability flags, business context |
| Language | `language` | Selected independently | UI language, voice recognition locale |

**Example valid state:**
```
phone_country   = NG
operating_region = US
language        = en
```

This is valid and fully supported. A Nigerian phone number holder operating a US-based business uses USD and sees US capability flags.

### 3.2 Capability Flags (derived from operating_region)

| operating_region | Text export | Verifiable PDF export | Notes |
|---|---|---|---|
| All regions | Available | Available when authenticated and server-synced | Currency and label recommendations follow operating region |

Policy:
```js
enableTextExport();
enableVerifiedPdfExportWhenAuthenticated();
```

### 3.3 Currency Derivation

Currency is derived from `operating_region`, never from `phone_country`.

| operating_region | Currency |
|---|---|
| NG | NGN (₦) |
| US | USD ($) |
| GB | GBP (£) |
| GH | GHS (₵) |
| KE | KES (KSh) |
| ZA | ZAR (R) |
| CA | CAD (CA$) |
| AU | AUD (A$) |
| DE, FR, EU | EUR (€) |
| IN | INR (₹) |
| All others | USD ($) |

### 3.4 UI/UX Constraints

- Country selector is a searchable input that filters the full 249-country ISO list in real time. There is no alphabetical scroll grid.
- Phone country (Step 1) is pre-selected based on device locale (`Intl.DateTimeFormat().resolvedOptions().locale`). User can override.
- No country is hidden because a feature is unsupported there.
- Unsupported localizations fall back to English; they do not block onboarding or export.
- Language selector is separate from country.
- Default language is English.
- The app must not auto-switch language based on country selection.
- Lack of a local language pack must never hide a country.

---

## §4. Screen Inventory

### 4.1 Onboarding (6 steps)

**Trigger:** First launch with no existing profile.

| Step | Screen element | Data collected |
|---|---|---|
| 1 | Phone country — searchable input filtering 249 ISO countries; device locale pre-selects default | `profile.country`, `state.authPhoneCountry` |
| 2 | Operating region selector ("Where does your business operate?") with explicit continue CTA after selection | `profile.operating_region` |
| 3 | Sector grid (6 sectors) | `profile.sector_id` |
| 4 | Business type grid (filtered by sector) | `profile.business_type_id` |
| 5 | Preferred labels grid (visual quick-picks for this business type) | `profile.preferred_labels` |
| 6 | Profile details (name, phone, email, region, birth year, gender) | `profile.display_name` and optional fields |

**Validation:** `business_type_id` and `display_name` are required. All other fields are optional.

**Navigation behavior:** The restore-account link appears at the top of the first country step before the country list. Selecting a phone country advances to the operating-region step. Operating-region selection can advance by tapping a country card and also exposes a "Continue with selected country" button so the flow remains recoverable after stale-shell or service-worker updates.

**Post-onboarding:** Profile saved to IndexedDB. Device trust state loaded. If phone unverified, OTP screen available in Settings.

**Re-entry:** "Change business profile" in Settings resets onboarding. Ledger is preserved.

#### Voice Navigation

Every onboarding step exposes an optional mic icon. The interaction pattern mirrors transaction confirmation:

1. User taps mic → microphone activates
2. User speaks their choice (e.g., "Nigeria", "food vendor", "Rice")
3. Transcript is fuzzy-matched against the available options for that step
4. On a match, the option is auto-selected and the app reads it back via TTS:
   - Country / region / sector / business type: **"You selected [Name]."**
   - Label (multi-select): **"You added [Label]. [N] selected so far."**
   - Name field (profile step): **"Your name is set to [Name]."**
5. User taps "Continue" to advance, or taps mic again to retry

Voice uses the same locale (`getVoiceLocale()`), TTS engine (`speakConfirmationCopy()`), and mic-permission error handling as the transaction voice capture flow. No new permissions or browser capabilities are required.

### 4.2 Transaction Capture

**Purpose:** Primary recording interface. The app spends most time here.

**Input methods (4):**

1. **Voice** — Web Speech API. User speaks: "Sold rice for 15,000". Live interim transcript shown while listening; parser fires only on final result. NLP parser handles standard phrasing, `5k`/`thousand` amounts, amount-before-label, quantity prefixes ("3 bags of rice" → label "rice"), and Pidgin placeholder ("I sell am for 3000" → sale, empty label). Voice corrections auto-applied before parsing (see §8).
2. **Text** — Natural language text field. "Paid transport 2000" → fills action, label, amount.
3. **Visual quick-picks** — Labeled cards ranked by preference + usage history. Tap to select.
4. **Label modal** — Full label browser with 4 modes: **Search** (text filter), **Speak** (voice label search — offers "Use as custom label" when no strong match found), **Browse** (all labels ranked), **Custom** (free-text, learned for future ranking).

**Form fields:**
- Action (sale, purchase, payment, receipt, transfer_in, transfer_out)
- Label (from quick-picks or search)
- Amount (number, in major units, currency-aware step)
- Counterparty (optional free text)
- Source account / Destination account (transfer actions only)

**Recent records panel:** Last 5 confirmed transactions displayed below the form.

**Daily reminder:** Banner shown if 0 records today. Auto-dismissed on first record.

### 4.3 Confirmation

**Purpose:** Gate every ledger append with explicit user review.

- Displays human-readable summary ("You sold Rice for ₦150.00")
- Text-to-speech reads confirmation aloud
- "Confirm and append" button — disabled during in-flight state
- "Go back" button — returns to capture without appending
- No bypass path exists. Every record must pass through this screen.

### 4.4 Dashboard

**Purpose:** Visual summary of business performance.

**Metric cards:**
- Today's sales
- Monthly sales
- Monthly expenses
- Monthly cash flow (sales − expenses)

**Chart (Chart.js):**
- Toggle: 7 days / 30 days
- Stacked bars: sales (green `#52b788`) and expenses (orange `#E8944A`)
- Currency-formatted tooltips

**Streak & tier row:**
- 🥇 Gold: ≥ 180 consecutive days
- 🥈 Silver: ≥ 90 consecutive days
- 🥉 Bronze: ≥ 30 consecutive days
- 🆕 New: < 30 days
- Progress bar toward 180 days

**Consistency banner:**
- Bronze (≥ 30 days): "You're Bronze tier. Consider exporting a report."
- Silver (≥ 90 days): "You're Silver tier. Consider exporting your full-history report."
- Links to Export screen.

**Privacy toggle:** Eye icon (👁️ / 🙈) hides/reveals all monetary amounts via CSS class on `document.body`. Resets to visible on logout.

**Daily reminder banner:** Shown if reminder is enabled in Settings and no records have been created today. Dismissible per session. Not a push notification — banner only.

### 4.5 History

**Purpose:** Full append-only ledger view.

- Reverse-chronological list of all confirmed records
- Each card: label, type, amount, timestamp, counterparty, reversal status
- "Reverse" button on eligible records — creates a reversal entry (non-destructive)
- Reversal records reference original via `reversed_entry_hash`
- Reversed transactions excluded from operational metrics

### 4.6 Settings

**Sections:**

- **Profile summary**: name, country, sector, business type
- **Trust & device**: phone anchor status, device key status, fingerprint, sync status, queue count, recovery contact
- **Preferences**: daily reminder toggle, privacy mode toggle
- **App Passcode**: create/update/remove alphanumeric passcode lock
- **Actions**: Set up phone verification, Change business profile, Open export

### 4.7 Export

**Free text export:**
- Plain text file download (`.txt`)
- Contains: header metadata, records available on the current device, evidence summary, ledger root hash, device fingerprint, embedded ECDSA P-256 public key, and local-device scope note
- Appends `DEVICE PUBLIC KEY (ECDSA P-256)` section after integrity data
- Public key is Base64-encoded SPKI format, suitable for OpenSSL, WebCrypto, and other standard P-256 verification tools
- If authenticated: `POST /attest` called with `window_days: 0` (best-effort, non-blocking) — on success, `vt_id`, `verify_url`, and QR code data URL are appended to the export
- On attestation failure: export completes silently without attestation block
- On public key retrieval failure: export still completes and prints `Public Key: Not available — key storage error`

**Verified PDF export:**
- Server-generated via pdfkit
- Available for authenticated users at no charge
- Calls `POST /report/generate-pdf` with `window_days: 0`
- Contains: business cover page (masked PII), activity summary, monthly cash flow view, full account-device ledger, device column per row, evidence summary, QR code + verify URL, attestation payload, server signature, verification key URL, and patent notice
- Mixed-currency reports show activity totals and ledger totals per currency without conversion or combination
- Server sends the PDF as a direct download response and attempts email delivery when a recovery email and `RESEND_API_KEY` are available

**Scope disclaimer** (both export types):
> The local text export reflects records available on this device. The verified PDF report reflects server-synced records from device identities linked to this account, and each ledger row identifies the device used for that entry.

### 4.8 OTP / Phone Verification

**Purpose:** Anchor device to a phone number. Gates device keypair generation and server sync.

**Flow:**
1. Enter phone number
2. Request OTP → server sends email (or dev_code if `ALLOW_DEV_OTP=true`)
3. Enter 6-digit code
4. On success: JWT issued, device keypair generated, identity status → `verified_server`

### 4.9 Passcode Lock

- Optional alphanumeric passcode (minimum 8 characters, must contain at least one letter and one number)
- Shown as full-screen overlay on app launch when enabled
- Hash stored in profile using PBKDF2-SHA256 (210,000 iterations) with per-device salt
- "Forgot passcode" recovery flow sends reset link via email
- Separate from phone OTP — local-device protection only
- Remove passcode option available in Settings

### 4.10 Additional Screens and Overlays

Beyond the 5 bottom-tab screens, the following overlays and modal screens exist:

| Screen / Modal | Trigger | Purpose |
|---|---|---|
| `#pin-lock-screen` | App launch if PIN enabled | Full-screen passcode gate |
| `#screen-otp` | "Set up phone verification" in Settings | OTP phone anchor flow |
| `#pin-confirm-modal` | Sensitive actions (e.g. remove PIN) | Confirm current PIN before proceeding |
| `#pin-forgot-modal` | "Forgot PIN" in PIN entry | Email-based recovery |
| `#change-confirm-modal` | "Change business profile" in Settings | Confirm profile reset (ledger preserved) |
| `#restore-modal` | Account recovery in Settings | Restore from another device |
| `#revoke-old-devices-modal` | Device management in Settings | Revoke prior devices |
| `#selector-modal` | Label picker during capture | 4-mode label selector (Search / Speak / Browse / Custom) |

---

## §5. Transaction Record Model

### 5.1 Fields

| Field | Type | Source | Required |
|---|---|---|---|
| `transaction_type` | string | action selection | Yes |
| `label` | string | label picker | Yes |
| `normalized_label` | string | derived | Yes |
| `amount_minor` | integer | amount input × 100 | Yes |
| `currency` | string | from operating_region | Yes |
| `counterparty` | string | free text | No |
| `source_account` | string | transfer only | Conditional |
| `destination_account` | string | transfer only | Conditional |
| `reversed_entry_hash` | string | reversal only | Conditional |
| `reversed_transaction_type` | string | reversal only | Conditional |
| `input_mode` | string | voice/text/visual/reversal | Yes |
| `business_type_id` | string | from profile | Yes |
| `sector_id` | string | from profile | Yes |
| `country` | string | from profile | Yes |
| `confirmed_at` | integer | Unix seconds at confirmation | Yes |
| `prev_entry_hash` | string | previous record's entry_hash | Yes |
| `entry_hash` | string | SHA-256 of canonical string | Yes |
| `signature` | string | ECDSA P-256, base64 | Yes (if key exists) |
| `evidence_level` | string | assigned at creation/sync | Yes |
| `public_key_fingerprint` | string | first 16 chars of key hash | No |

### 5.2 Transaction Types

| Type | Meaning | Effect on metrics |
|---|---|---|
| `sale` | Revenue from selling goods/services | + Sales |
| `purchase` | Buying stock or goods | + Expenses |
| `payment` | Paying for services or overhead | + Expenses |
| `receipt` | Receiving money (non-sale) | Neutral |
| `transfer_in` | Money moving into a wallet/account | Neutral |
| `transfer_out` | Money moving out of a wallet/account | Neutral |
| `reversal` | Reverses a prior entry | − of original |

### 5.3 Amount Constraints

| Currency | Minor unit | Max amount |
|---|---|---|
| NGN | Kobo (1/100 ₦) | ₦10,000,000 |
| USD | Cent (1/100 $) | $100,000 |
| Others | 1/100 of major | Equivalent of $100,000 |

---

## §6. Evidence Hierarchy

Every ledger entry carries an `evidence_level` field tracking its trust tier.

| Level | Value | Meaning |
|---|---|---|
| 0 | `self_reported` | Entry created before phone verification or signing |
| 1 | `device_signed` | Entry signed with device ECDSA key, not yet server-synced |
| 2 | `server_attested` | Entry synced and verified by server (signature validated, hash chain intact) |
| 3 | `corroborated` | Entry matched against an external data source (future) |

**Assignment rules:**
- New records: `device_signed` if keypair exists, otherwise `self_reported`
- After successful sync: upgraded to `server_attested` (local + server)
- Server always sets `server_attested` on INSERT (entries passed signature verification)
- `corroborated` requires integration layer (Phase 2)

**Report surfacing:**
- Text export includes evidence summary block
- PDF cover page includes evidence summary section
- Example: "145 of 150 entries (97%) have server attestation."

---

## §7. Anomaly Detection

### 7.1 Detected Anomaly Types

| Type | Trigger | Threshold |
|---|---|---|
| `volume_spike` | Entries per hour > p95 × 3 | Minimum 50 entries |
| `repeated_amount` | 8+ identical amounts within 5 minutes | 8 occurrences |
| `future_timestamp` | confirmed_at > current time + 2 minutes | 2 minutes |
| `hash_fork` | Duplicate prev_entry_hash detected locally | Any occurrence |

### 7.2 Lifecycle

- Detected on new entry creation
- Stored in IndexedDB `anomaly_log` with `reviewed: false`
- UI banner shown until user opens the review panel
- Auto-marked reviewed after 5 seconds in the review panel
- Anomalies are **informational only** — they do not block entry creation or sync

---

## §8. Voice Correction System

Konfirmata learns from the user's manual corrections to voice transcripts, on-device. When a voice transcript is wrong, the user corrects it. The system saves the (raw → corrected) pair and applies it automatically to future transcripts.

### 8.1 How It Works

1. Speech recognition produces a raw transcript
2. `applyVoiceCorrections(transcript)` runs before NLP parsing — replaces known wrong patterns with learned corrections, ordered by usage frequency (most-used first)
3. User manually edits any remaining errors in the capture form
4. If the edited result differs from the original transcript, `saveVoiceCorrection(raw, corrected)` stores the pair and increments its usage counter
5. Next time the same or similar raw phrase appears, the correction applies automatically

### 8.2 Storage

- IndexedDB store: `voice_corrections`
- Fields: `raw` (primary key), `corrected`, `count` (usage frequency), `created_at`
- Corrections sorted descending by `count` so the most reliable fixes apply first

### 8.3 Settings UI

- Settings screen exposes a "Voice corrections" panel
- Shows all learned corrections with usage counts
- User can delete individual corrections
- Empty state: "Konfirmata will learn from manual voice fixes on this device."

### 8.4 Scope

- **Device-local only** — corrections are not synced to the server, not backed up
- Language-agnostic — corrections apply as string substitution regardless of locale
- No minimum threshold — a correction is applied from the first time it is saved
- Cleared on full app data reset (IndexedDB wipe)

---

## §9. Label System

### 9.1 Sectors (6)

1. Trade & Retail
2. Food & Hospitality
3. Transport & Logistics
4. Skilled Work & Construction
5. Personal & Professional Services
6. Digital & Online Business

### 9.2 Business Types (23 across NG + US + global fallback)

**Nigeria (10):**
Market Trader, Provision Shop, Food Vendor, Transport Operator, Artisan, Service Provider, Online Seller, Kiosk/Phone Business, Fashion Tailor, Okada/Keke Operator

**United States (7):**
Retail, Food Service, Logistics, Contractor, Beauty Services, Digital Business, Personal Services / Side Hustle

**Global fallback (6):**
Retail / Trading, Food & Hospitality, Transport & Logistics, Skilled Work / Construction, Personal / Professional Services, Digital / Online Business

### 9.3 Label Ranking Algorithm

Scoring factors (applied per query match):

| Factor | Points |
|---|---|
| Exact normalized match | +40 |
| Synonym match | +30 |
| Token match (query token found in label tokens) | +20 |
| Close spelling match (Levenshtein distance ≤ 2, token ≥ 4 chars) | +18 |
| Preferred label (selected at onboarding) | +18 |
| Partial/substring match | +16 |
| Phonetic match (Soundex) | +12 |
| Business type match | +12 |
| Sector match | +8 |
| Country match | +6 |
| Usage history boost | +min(count, 8) |

Results sorted by score descending, then alphabetically. Default limit: 12.

---

## §10. Availability Model

### 10.1 Free Access (all regions)

- Unlimited transaction recording
- Unlimited local text exports
- Free verified PDF report generation for authenticated users with server-synced records
- Device signing, server sync, public attestation, and public verification page

### 10.2 No Monetization in Current Product

The current app has no paid tiers, no payment checkout, no payment processor integration in the user flow, no rewarded ads, no upgrade prompts, and no scoring feature. Trust tiers such as Bronze, Silver, and Gold are consistency/maturity indicators only; they are not commercial product tiers.

### 10.3 Gate Rule

> No commercial gate may block ledger formation, sync, text export, or verified PDF report generation. `confirmationTransition()` must never require payment or ad completion.

---

## §11. Export & Attestation

### 11.1 Free Text Export

- Available to all users, all regions
- Plain `.txt` file downloaded to device
- Contains local-device record ledger, evidence summary, and local export scope note
- Phone and email shown unmasked (user's own data)
- Embeds the signing device public key as Base64 SPKI in a `DEVICE PUBLIC KEY (ECDSA P-256)` section after integrity data
- Appends a per-entry verification bundle: `entry_hash`, `prev_entry_hash`, `signature_base64`, `signature_message_utf8`, and `canonical_payload_utf8`
- Supports offline third-party verification from the export file plus the embedded device public key
- If authenticated, attempts a best-effort single-device public attestation via `POST /attest` with `window_days: 0`
- If the public key cannot be read from local key storage, the export must continue and show `Public Key: Not available — key storage error`
- Filename: `konfirmata-export-{timestamp}.txt`

### 11.2 Verified PDF

- Available to authenticated users at no charge
- Server-generated PDF via `POST /report/generate-pdf`
- Client sends `window_days: 0` to request full account-device history
- Filename: `konfirmata-verified-report-{YYYY-MM-DD}.pdf`
- PDF contains: cover page (masked phone/email), activity summary, monthly cash flow view, full account-device ledger appendix, evidence summary, attestation payload, ECDSA attestation signature, verification key URL, QR code, verify URL, patent notice
- Ledger rows include a device fingerprint column so institutions can see which account-linked device recorded each entry
- Ledger references prefix the per-device entry id with the short device code to avoid duplicate-looking ids in multi-device reports
- Mixed-currency reports show totals per currency without conversion or combination
- Direct download is returned in the API response; email delivery is best-effort when an email address and `RESEND_API_KEY` are available

### 11.3 Attestation Scopes

- `POST /attest` issues a `single_device` attestation for the requesting device. This is used by local text export and lightweight verification flows.
- `POST /report/generate-pdf` issues an `account_devices` attestation. This report includes all server-synced ledger entries from device identities linked to the authenticated account, ordered oldest to newest.
- Account-device reports compute `ledger_root_hash` from the ordered tuple `device_identity:entry_id:entry_hash` for each included row.

### 11.4 Verification Portal

- Static page at `/verify/:vt_id`
- Calls `GET /verify/:vt_id` on load
- Displays: validity badge (VALID / FORKED / REVOKED / UNKNOWN), attestation date, entry count, window range, key rotation events, fork status, device fingerprint (8 chars)
- Exposes ledger root hash, report device fingerprint, attestation scope, attestation payload, server signature, signature algorithm, and verification key URL for independent validation tools
- Returns **no PII** — phone number never exposed, device identity truncated
- Supports both `single_device` and `account_devices` attestation scopes

### 11.5 Client Fallback PDF

`buildClientVerifiablePdfReport()` in `app-v3/app.js` renders a PDF on the device using jsPDF. It is a fallback path only and is never the institutional-grade verified report.

- **Trigger:** invoked from `claimFreeReport()` when `POST /report/generate-pdf` either (a) returns HTTP 404 (server PDF route unavailable) or (b) fails with no HTTP status — i.e. the device is offline or the server is unreachable. Other HTTP failures (401, 403, 5xx, status 0) do not trigger it.
- **Attestation:** the fallback still attempts a single-device `POST /attest`. When that succeeds, the PDF embeds a single-device `vt_id`, verify URL, and signature. When it fails, the PDF carries no attestation.
- **Not equivalent to the server report:** the fallback is never the account-level server-attested report. It is titled "Konfirmata Activity Export - Device-Generated Fallback", uses the filename `konfirmata-activity-export-fallback-{YYYY-MM-DD}.pdf`, and carries a prominent notice stating it is a device-generated fallback and not the `POST /report/generate-pdf` report.
- **Boundary disclaimer:** the transaction-boundary disclaimer is retained in full.

---

## §12. Security & Privacy Constraints

1. **Append-only ledger**: No deletion. Amendment via reversal records only.
2. **Confirmation gate**: Every record requires explicit user confirmation. No bypass.
3. **No monetization gate**: `confirmationTransition()`, sync, text export, and verified PDF export are not gated by payment, ads, or paid tier state.
4. **Country selection is global**: No country blocks onboarding.
5. **Capability flags from operating_region only**: Never inferred from `phone_country`.
6. **Language is independent**: Defaults to English when no local pack exists.
7. **Device PII not leaked in reports**: `device_identity` truncated to 8 chars in verification portal.
8. **Phone/email masked in institution-facing PDF**: `maskPhone()` + `maskEmail()` applied to cover page.
9. **User export unmasked**: User's own data export shows full contact details.
10. **Verified PDF report is free**: no lifetime claim flag, paid-tier state, payment reference, or ad state may be required to generate it.
11. **Rate limits**: OTP = 5/hr per phone, verify portal = 100/min per IP, OTP verify = 5 failures per 15 min.
12. **CORS allowlist**: Only konfirmata.com and localhost in dev. No wildcard.
13. **JWT secrets required**: Server refuses to boot in production without `JWT_SECRET` and `SERVER_RECEIPT_SECRET`.
14. **No payment webhook in active product flow**: payment-provider webhooks must not be required for report generation.
15. **Verified report is server-generated; client PDF is a labeled fallback**: The institutional-grade verified report is generated only by `POST /report/generate-pdf` and carries an `account_devices` server attestation. A client-rendered PDF (jsPDF) is permitted *only* as a fallback when the server PDF route is unavailable (triggered on HTTP 404 or offline/network-unreachable failure; other HTTP errors do not trigger it). The fallback PDF must be visibly labeled as a device-generated fallback copy, must use a distinct title and filename from the server report, must not be presented as equivalent to it, and must retain the transaction-boundary disclaimer. When the fallback embeds a single-device `/attest` ticket it may state that, but must not claim account-level server attestation. See §11.5.
16. **vt_id is `crypto.randomBytes(16)`**: Never sequential, never `Math.random()`.
17. **Dev OTP hard-blocked in production**: `ALLOW_DEV_OTP=true` is prohibited when `DATABASE_SSL=true`. Server refuses to start if both flags are active simultaneously.

---

## §13. Acceptance Tests

### Global Availability
1. User selects Kenya → onboarding completes → amounts shown in KES
2. User selects Germany → onboarding completes → text export and verified PDF export remain available when authenticated
3. Language defaults to English for any country without a language pack
4. Phone prefix independent of operating_region
5. Currency follows operating_region, not phone_country

### Ledger Integrity
6. Verified PDF report with `window_days: 0` returns full account-device history for the authenticated account
7. Duplicate entry_hash INSERT fails at DB level (replay protection)
8. Fork detected → device marked FORKED → sync blocked → rotation required to recover

### Security
9. User A cannot rotate User B's device (IDOR protection)
10. Revoked device cannot re-register via sync
11. OTP brute force blocked after 5 failures in 15 minutes
12. Expired JWT rejected before API calls (client-side check + server validation)

### Reports
13. Verified PDF shows masked phone (`+234****5678`) and masked email (`j***e@domain.com`)
14. Free text export shows unmasked contact with privacy note header
15. Free text export includes `DEVICE PUBLIC KEY (ECDSA P-256)` after integrity data
16. Each exported ledger entry includes `entry_hash`, `prev_entry_hash`, `signature_base64`, `signature_message_utf8`, and `canonical_payload_utf8`
17. Embedded public key is valid Base64 SPKI and corresponds to the existing device fingerprint
18. Verified PDF includes attestation payload, ECDSA attestation signature, verification key URL, QR code, and `account_devices` scope
19. Verified PDF transaction ledger includes the device fingerprint column and all included account-device rows
20. Verification portal shows VALID for untampered attestation, FORKED for compromised device, and displays attestation details for institutional cross-checking

### Monetization Boundary
21. No user-facing payment, premium upgrade, scoring, or rewarded-ad path appears in the app
22. Verified PDF generation succeeds without payment-provider keys or payment reference
23. Trust tiers remain consistency/maturity indicators only

---

## §14. Outstanding Work

### Go-Live Blockers
- [ ] Set `TERMII_API_KEY` in Railway (real SMS OTP)
- [ ] Set `RESEND_API_KEY` in Railway (email delivery)
- [x] `ALLOW_DEV_OTP` hard-blocked when `DATABASE_SSL=true` — enforced at server boot (2026-04-11)
- [ ] Set `ALLOW_DEV_OTP=false` in Railway for production
- [x] QR scan → verify portal shows VALID — confirmed 2026-05-11 via smoke test; `GET /verify/:vt_id` returned `status: VALID`, `fork_status: NORMAL`, `signature_algorithm: ECDSA_P256_SHA256_P1363`
- [x] Per-entry offline verification fields live in production — `prev_entry_hash`, `signature_base64`, `signature_message_utf8`, `canonical_payload_utf8` confirmed present in text export 2026-05-11 (commit 6a62ddc)
- [x] PDF footer confirmed carrying `attestation_payload`, `server_signature`, `signature_algorithm`, `verification_key_url` — smoke test 2026-05-11
- [x] Account-device verified PDF deployed — confirmed 2026-05-17 with `account_devices` attestation scope, full-history `window_days: 0`, device column in the ledger, and 12 entries shown in the user-generated report

### UX (In Progress)
- [x] Phone normalization implemented and wired into the OTP and account-restore flows for NG, US, GH, KE, and ZA (`normalizePhoneNumber` in `app-v3/app.js`); e.g. NG `08099840666` → `+2348099840666`, US `2678867271` → `+12678867271`
- [x] Searchable country selector with locale auto-detection (2026-04-11)
- [x] Onboarding country-grid recovery shipped in production; operating-region step now has an explicit continue path (2026-05-10)
- [x] Restore-account link moved above the country list (2026-05-17)
- [x] Trusted-device restore copy softened: older active sign-ins are grouped as earlier active sessions with a revoke-earlier action (2026-05-17)
- [x] Language selector UI present in Settings (`#settings-language-select`); `SUPPORTED_LANGUAGES` is currently English-only, so the control offers a single option until additional language packs are added
- [ ] Country-aware state/region placeholder in onboarding step 6

### Identity
- [x] Brand finalized as Konfirmata
- [ ] Domain registration for new brand email

### Phase 2 (Evidence-Gated)
- [ ] Integration layer for corroboration (bank statement matching, mobile money data)
- [ ] Android Native — triggered only when MFI pilot requires hardware-backed attestation
- [ ] Device compromise propagation (revocation impact on reports)
