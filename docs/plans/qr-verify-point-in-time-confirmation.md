# QR / Report Verification — Point-in-Time Confirmation

Status: CONFIRMATION ONLY. No code changes made or needed.

## Question addressed
Does the QR code verify a report as of its generation date, or does it silently
resolve to current live state?

## Finding
The existing design already separates these correctly.

- `POST /attest` (`server/src/routes/attest.js:86-116`) freezes `ledger_root_hash`,
  `entry_count`, `window_start`/`window_end`, and `issued_at` into an immutable
  `attestations` row keyed by a fresh `vt_id`. Nothing about this row changes
  after insert.
- The QR code (`app-v3/app.js:2618`, `server/src/routes/payment.js:478`) encodes
  `attestation.verify_url` = `https://konfirmata.com/verify/{vt_id}` — a pointer
  to that frozen row, not to the device's current chain tip.
- `GET /verify/:vt_id` (`attest.js:124-233`) looks up the attestation by `vt_id`
  and re-verifies the signature over the same frozen payload every time it's
  scanned, regardless of how much has been recorded since.
- The public page (`website-v2/verify.html:229-243`) surfaces only point-in-time
  fields — `attested_at` (labeled "Checked at"), `window_start`/`window_end`
  ("Record window"), `entry_count` ("Attested record count"), `ledger_root_hash`.
  It does not render `fork_status` or current device status.

This matches the intended model: the report/QR attests to state *as generated*,
and that attestation stays true forever independent of later activity.

## Watch item (not a defect)
`GET /verify/:vt_id` also returns `fork_status` and `key_rotation_events`
(`attest.js:212-225`), which reflect the device's **current** status, not the
attested-at state. The public frontend does not currently render either field.
If a future change surfaces them on `verify.html`, they must be labeled
distinctly (e.g. "Current device status") and kept visually separate from the
"Checked at" block — otherwise a viewer could conflate "device status now" with
"validity of this report as of its date," which would undermine the
point-in-time guarantee this design otherwise provides cleanly.

## Action taken
None. No code touched. This note exists so the distinction is documented before
anyone extends the verify page.
