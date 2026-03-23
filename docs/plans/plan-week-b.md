# Confirma Week B Plan

Date: 2026-03-22

## Purpose

Week B adds the first external witness layer for `app-v3/`.

This is the second trust-layer milestone from the March 2026 workplan:

- Phase 1.5B - Node.js Sync Server + Fork Detection
- OTP verification backed by server-issued JWT
- background sync for newly signed entries
- fork detection and key-rotation endpoints

This plan assumes Codex or Claude Code will execute implementation directly after planning.

## Source Of Truth

- App target: `app-v3/`
- New server target: `server/`
- Existing planning context:
  - `docs/plans/v3-foundation-plan.md`
  - `docs/plans/plan-week-a.md`
- Product workplan:
  - Inline workplan provided on 2026-03-22 in this thread

## Week B Outcome

When Week B is complete:

1. The app can request and verify OTP against a server endpoint.
2. The app stores a JWT in the existing `settings` store.
3. New confirmed entries are queued locally for sync without blocking confirmation.
4. A Fastify server can accept signed entries, verify their signatures, and persist them.
5. Fork detection is enforced on `(device_identity, entry_id)` conflicts or chain mismatches.
6. A key-rotation endpoint exists for Week B recovery flows.

## Non-Negotiables

- Confirmation remains local-first and confirmation-gated.
- Sync must never block `appendLedgerRecord()`.
- The records store remains append-only from the app’s point of view.
- Existing Week A signed entries remain valid even when unsynced.
- JWT expiry is 30 days with OTP re-verification as the renewal path.
- Crypto and sync code must remain manually reviewable.

## Design Decisions

### 1. Server Split

- Add a dedicated `server/` workspace inside the repo.
- Use Fastify for HTTP routes.
- Use PostgreSQL via `pg`.
- Keep the app and server independently deployable.

### 2. OTP Strategy

- `POST /auth/otp/request`
  - validates phone number
  - rate-limits by phone and hour
  - stores hashed OTP with 10-minute TTL
- `POST /auth/otp/verify`
  - validates OTP
  - creates or loads user by phone number
  - returns JWT and expiry

For local development:

- support a development OTP response field when `ALLOW_DEV_OTP=true`
- keep the app fallback path available if the server is unreachable

### 3. Sync Queue

- Add a `syncQueue` object store in IndexedDB.
- Queue each appended record after confirmation succeeds.
- Queue payload contains:
  - `queue_id`
  - `entry_id`
  - `entry_hash`
  - `device_identity`
  - `status`
  - `attempt_count`
  - `queued_at`
  - raw `entry_payload`
- Remove queue items only after server acknowledgement.

### 4. Sync Semantics

- Sync runs in the background:
  - after each successful confirmation
  - on app init when auth token exists
  - on reconnect via `window.online`
- Sync payload includes:
  - `device_identity`
  - `public_key`
  - array of queued signed entries
- Server verifies:
  - JWT
  - signature
  - per-device chain continuity
  - duplicate/fork conditions

### 5. Receipt Model

- Server returns:
  - `receipt_counter`
  - `last_synced_entry_id`
  - `server_receipt`
- Week B receipt may use server HMAC signing from server secret.
- Week C will replace or strengthen this with KMS-backed attestation.

### 6. Key Rotation

- `POST /identity/rotate`
  - requires valid JWT
  - accepts old and new device identities
  - stores an audit record
  - marks the old device as `ROTATED`
  - returns a server-signed rotation receipt

## File-Level Plan

### `docs/plans/plan-week-b.md`

- this plan file

### `server/package.json`

- dependencies for Fastify, PostgreSQL, JWT, dotenv
- scripts for `dev`, `start`, and `check`

### `server/server.js`

- app bootstrap
- route registration
- graceful startup

### `server/src/config.js`

- environment parsing

### `server/src/db.js`

- PostgreSQL pool
- thin query helpers

### `server/src/routes/auth.js`

- `POST /auth/otp/request`
- `POST /auth/otp/verify`

### `server/src/routes/sync.js`

- `POST /sync/entries`
- JWT verification
- signature verification
- fork detection
- receipt issuance

### `server/src/routes/identity.js`

- `POST /identity/rotate`

### `server/schema.sql`

- `users`
- `device_identities`
- `ledger_entries`
- `key_rotation_events`
- `otp_challenges`

### `app-v3/syncWorker.js`

- API helpers for auth, sync, and identity rotation

### `app-v3/app.js`

Add or update:

1. sync state and JWT state
2. IndexedDB migration for `syncQueue`
3. queue entry after append succeeds
4. background queue flush
5. OTP server integration with local fallback
6. trust UI rows for auth/sync status

### `app-v3/sw.js`

- cache `syncWorker.js`
- bump cache version for the new asset set

## Required Data Additions

### Settings Store

- `auth_token`
- `auth_token_expires_at`
- `sync_api_base_url`
- `last_sync_at`
- `last_sync_receipt`

### IndexedDB Stores

- new `syncQueue` object store with `queue_id` key path and auto-increment

## Execution Order

1. Add Week B plan.
2. Scaffold server files and schema.
3. Add client sync helper module.
4. Bump IndexedDB to add `syncQueue`.
5. Queue entries after confirmation.
6. Flush queue in background with JWT auth.
7. Surface auth and sync status in the app.
8. Run syntax checks and document remaining infra steps.

## Acceptance Checks

1. A fresh Week A signed entry can be queued after confirmation.
2. Queueing does not block dashboard transition after confirm.
3. The app can store and reuse an auth token.
4. Export and settings surfaces show sync status honestly.
5. Server route files parse cleanly.
6. Client files parse cleanly.

## Expected Follow-Up

Week B implementation in this repo can fully scaffold the sync architecture and client queueing flow, but a real end-to-end sync demo still needs:

- `npm install` in `server/`
- local PostgreSQL or Railway PostgreSQL
- server environment variables
- a running server process reachable by `app-v3`
