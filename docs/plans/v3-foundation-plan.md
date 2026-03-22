# Confirma V3 Foundation Plan

Date: 2026-03-22

## Source Of Truth

- Active app: `app-v3/`
- Active runtime files:
  - `app-v3/index.html`
  - `app-v3/app.js`
  - `app-v3/styles.css`
  - `app-v3/manifest.json`
  - `app-v3/sw.js`
- Workplan reference: `Confirma_Workplan.pdf`

## Guardrails

- Preserve the current V2 interaction model and 5-tab navigation.
- Preserve confirmation-gated, append-only ledger semantics.
- Do not redesign onboarding, settings, privacy, PIN, reminder, chart, tier, or streak surfaces unless explicitly requested.
- Do not modify `appendLedgerRecord()`, `getRecords()`, `openDb()`, or any direct `.add()` call on the `records` store without explicit approval.
- Treat service worker and deploy behavior as sensitive.

## What V3 Means In Practice

Based on the current workplan, "V3" is not an Android or iOS rewrite. The next real product arc is:

1. Phase 0: Stabilize the live PWA.
2. Phase 1.5A: Device-bound signing in the PWA.
3. Phase 1.5B: Server sync, receipts, key rotation, fork detection.
4. Phase 1.5C: Attestation, `vt_id`, verification portal, QR-backed validation.
5. Phase 1.5D: Verified Reports, payments, and report delivery.

Android native remains conditional and evidence-gated after that.

## Current Audit Snapshot

Implemented already in `app-v3`:

- Country/sector/business-type onboarding
- Common transaction preference boost
- Quick-picks, browse/search labels, voice and text shortcuts
- Confirmation review before append
- Local append-only IndexedDB ledger
- Dashboard metrics, chart, tier, streak, reminder, privacy blur, PIN lock
- Export screen and basic export generation

Still missing or incomplete relative to the workplan:

- No server sync or receipt model
- No device-bound signing
- No attestation or verification portal
- No verified report workflow
- No payment gate for attested reports
- Service worker remains simple cache-first without hardening
- Confirmation path has no explicit double-submit guard
- Export is local-only and not yet trust-layer ready

## Key Constraint Mismatch

The workplan's Week A requires:

- IndexedDB version bump
- signed entry fields
- canonical-string updates tied to entry creation
- changes in the append path

That conflicts with the current guardrail that seals:

- `openDb()`
- `appendLedgerRecord()`
- `getRecords()`
- direct writes to the `records` store

So the work splits into two lanes:

## Lane 1: Safe To Start Now

These improve readiness without opening the protected ledger path:

1. Service worker hardening
   - navigation fallback
   - fault-tolerant install
   - explicit cache version bump discipline
2. Confirmation UX hardening
   - double-submit guard on confirm
   - speech synthesis on confirmation screen
3. Export honesty improvements
   - show ledger root hash directly
   - keep wording aligned with "device-verified, server attestation coming"
4. Label/context fixes
   - custom transfer labels should survive reload
5. Accessibility and polish
   - guided first-record empty state
   - search debounce
   - amount plausibility checks

## Lane 2: Requires Explicit Ledger-Path Approval

These are the real trust-layer features, but they require modifying protected functions:

1. Week A
   - OTP identity bootstrap
   - WebCrypto keypair creation
   - SignedEntryV1 schema
   - IndexedDB migration
   - canonical signing string
2. Week B
   - Fastify/Railway sync service
   - receipts
   - fork detection
   - key rotation
3. Week C
   - KMS-backed attestations
   - `vt_id`
   - verification portal
   - QR-enabled export
4. Week D
   - Paystack gate
   - verified report PDFs
   - delivery flow
   - dashboard monetization hooks

## Recommended First Build Slice

Start with a "V3 foundation" slice inside `app-v3`:

1. Harden the service worker.
2. Add confirmation submit protection.
3. Make export terminology more trust-layer accurate.
4. Fix custom transfer label persistence.
5. Add confirmation speech.

This creates a safer base while keeping the ledger write path sealed.

## Approval Boundary Before Trust Layer Work

Before Week A starts, confirm that it is acceptable to open the protected functions listed above. Without that approval, the project can prepare for V3, but it cannot become a signed or server-verifiable ledger.
