import crypto from "node:crypto";

// The ledger hash form used by the app (app-v3/app.js buildLedgerHashCanonicalString),
// unchanged since at least 2026-03-29. Keep both in step; the shared vectors in
// server/test/fixtures/ledger-hash-vectors.json check they agree.
// Known limitation of this existing form: values are joined with an unescaped "|",
// so it checks consistency with the recipe but cannot fix field boundaries.
export const LEDGER_HASH_FIELDS = Object.freeze([
  "id",
  "transaction_type",
  "normalized_label",
  "amount_minor",
  "currency",
  "counterparty",
  "business_type_id",
  "country",
  "source_account",
  "destination_account",
  "reversed_entry_hash",
  "reversed_transaction_type",
  "confirmed_at",
  "prev_entry_hash"
]);

export function buildLedgerHashCanonicalString(entry) {
  return LEDGER_HASH_FIELDS
    .map((field) => entry?.[field])
    .map((value) => value == null ? "" : String(value))
    .join("|");
}

export function computeLedgerEntryHash(entry) {
  return crypto.createHash("sha256").update(buildLedgerHashCanonicalString(entry), "utf8").digest("hex");
}
