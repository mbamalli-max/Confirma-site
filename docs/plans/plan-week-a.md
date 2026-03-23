# Confirma Week A Plan

Date: 2026-03-22

## Purpose

Week A delivers device-bound signing in the PWA for all new confirmed entries in `app-v3/`.

This is the first trust-layer milestone from the March 2026 workplan:

- Phase 1.5A - WebCrypto Keypair + Signed Entries in PWA
- Identity root - phone number verified by OTP before keypair creation
- SignedEntryV1 - signatures added for new records only

This plan assumes Codex or Claude Code will execute implementation directly after planning. Cursor is not part of the workflow.

## Source Of Truth

- App target: `app-v3/`
- Runtime files:
  - `app-v3/index.html`
  - `app-v3/app.js`
  - `app-v3/styles.css`
  - `app-v3/manifest.json`
  - `app-v3/sw.js`
- Existing planning context:
  - `docs/plans/v3-foundation-plan.md`
- Product workplan:
  - Inline workplan provided on 2026-03-22 in this thread

## Week A Outcome

When Week A is complete:

1. The user verifies a phone number with OTP before keypair creation.
2. The app creates a device-bound WebCrypto keypair.
3. Every new confirmed entry is signed locally.
4. The public key fingerprint is visible in export output.
5. Existing historical entries remain preserved and are clearly marked as unsigned legacy entries.

## Non-Negotiables

- Preserve the V2/V3 interaction model unless a Week A requirement forces a targeted addition.
- No server sync in Week A.
- No attestation in Week A.
- No payment or report logic in Week A.
- Existing unsigned records must remain readable and exportable.
- Crypto-sensitive code gets manual review before acceptance.

## Important Boundary

Week A cannot be completed without changing currently sealed functions.

The current repo guidance previously protected:

- `openDb()`
- `appendLedgerRecord()`
- `getRecords()`
- direct writes to the `records` store

Week A requires modifying at least:

- `DB_VERSION`
- `openDb()`
- `appendLedgerRecord()`
- export rendering logic for signed vs unsigned history

So implementation should not begin until we explicitly accept that Week A is opening those boundaries on purpose.

## Current Starting State

Already present in `app-v3`:

- Phase 0 stabilization work
- onboarding with country, sector, business type, common transactions, and user details
- confirmation-gated local ledger
- append-only local records chain
- export screen
- profile object stored as a freeform entry in the `settings` store

Still absent for Week A:

- OTP screen and flow
- device keypair generation
- device identity persistence
- record signature fields
- public key fingerprint in exports
- legacy unsigned export labeling

## Week A Design Decisions

### 1. OTP Comes Before Keypair

- User must complete OTP verification before device key creation.
- Phone number becomes the identity recovery anchor.
- No signing should be enabled until the phone anchor exists.

### 2. Algorithm Choice

- Primary algorithm: WebCrypto ECDSA using P-256
- Reason: broadly supported across Chrome Android and modern browsers
- Avoid making Ed25519 the primary path in Week A

### 3. Scope Of Signing

- Sign new entries only
- Do not retroactively rewrite old records
- Old records are exported as legacy unsigned history

### 4. Device Identity

- Export public key from WebCrypto as JWK for storage in `settings`
- Compute `device_identity` from SHA-256 of the exported public key material
- Store:
  - `device_public_key`
  - `device_identity`
  - `phone_number`
  - OTP verification metadata if needed for local gating

## File-Level Plan

### `app-v3/index.html`

Add:

- `screen-otp` before normal capture flow becomes available
- phone input
- send-code action
- code verification input
- verify action
- a lightweight trust-status surface if needed for Week A only

Do not:

- redesign the whole onboarding system
- merge Week B server sync UI into Week A

### `app-v3/app.js`

Add or update:

1. OTP flow state
   - pending phone
   - OTP send state
   - OTP verified state
   - device key ready state

2. Local OTP abstraction
   - Week A should still be structured so a real SMS backend can replace a temporary development transport cleanly
   - if a real OTP provider is not yet wired, the code path should remain modular rather than hardcoding Week B assumptions everywhere

3. Key management helpers
   - `generateDeviceKeypair()`
   - public key export helper
   - fingerprint helper
   - `signEntryHash()`
   - `verifyEntrySignature()` helper for local checks and future tests

4. DB migration
   - bump `DB_VERSION` from 1 to 2
   - preserve all existing stores and records
   - continue using the `settings` store for profile and device metadata

5. Ledger payload extension
   - add signature fields for new entries only
   - preserve old entries unchanged

6. Export updates
   - include public key fingerprint
   - clearly label unsigned legacy records

### `app-v3/styles.css`

Add only minimal styling needed for:

- OTP screen
- trust-state messaging
- disabled confirmation messaging if key state is incomplete

## Required Data Additions

### Settings Store

Add keys such as:

- `device_public_key`
- `device_identity`
- `device_public_key_fingerprint`
- `otp_verified_phone`
- `key_created_at`

These remain inside the existing `settings` store and do not require a new object store.

### Record Payload

For new records only, add fields such as:

- `signature`
- `public_key_fingerprint`
- optional `signature_algorithm`
- optional `signed_entry_version`

Existing unsigned records remain valid historical records.

## Canonical Data Rules

Week A should use a single canonical basis for signing and hashing.

The repo already has the corrected hash-chain canonical string from Phase 0:

`id|transaction_type|normalized_label|amount_minor|currency|counterparty|business_type_id|country|source_account|destination_account|reversed_entry_hash|reversed_transaction_type|confirmed_at|prev_entry_hash`

Week A must not invent a conflicting serialization. Signing should be derived from a stable, explicitly documented canonical representation.

## Execution Order

1. Add plan file and confirm approval to open Week A boundaries.
2. Add OTP UI and supporting state.
3. Implement key generation and persistence.
4. Migrate IndexedDB version safely.
5. Extend append path for signatures on new entries.
6. Update export for fingerprint and unsigned legacy labeling.
7. Add tests and verification harness.
8. Manually review crypto-sensitive code.

## Testing Requirements

At minimum, Week A should verify:

1. Existing user data survives DB version upgrade.
2. Existing records remain readable after upgrade.
3. New confirmed entries contain signature metadata.
4. Signature verification passes for new entries.
5. Export distinguishes signed vs unsigned entries.
6. The app blocks signature-dependent confirmation if OTP/key state is missing.

## Property And Invariant Tests

Add test coverage for:

- monotonic IDs remain intact
- append-only record order remains intact
- hash chain continuity remains intact
- signature verification matches signed payload
- legacy unsigned records do not break export

## Manual Review Checklist

Before accepting Week A:

- Review every line touching keypair generation.
- Review every line touching signature creation.
- Review every line touching exported public key handling.
- Review DB migration carefully for data preservation.
- Review append-path changes to ensure confirmation semantics remain unchanged.

## Risks

### 1. Browser Support Drift

- WebCrypto behavior varies subtly by browser
- keep the implementation on the narrowest well-supported path

### 2. Migration Mistakes

- DB version upgrades are one-way in practice for many users
- migration must be additive and non-destructive

### 3. Confusing Recovery Story

- Week A adds the recovery anchor but not full server-backed rotation yet
- UI wording must not overpromise recovery before Week B

## Explicit Approval Needed Before Coding

Before implementation begins, we should explicitly accept that Week A will modify:

- `app-v3/app.js` `DB_VERSION`
- `app-v3/app.js` `openDb()`
- `app-v3/app.js` `appendLedgerRecord()`
- export logic for signed and unsigned records

That is expected and correct for Week A, but it crosses the earlier sealed-ledger boundary by design.
