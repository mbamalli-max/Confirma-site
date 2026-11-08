import { test } from "node:test";
import assert from "node:assert/strict";

import { computeQuickTransactions } from "../../app-v3/quick-transactions.js";

const now = 1_800_000_000;
const record = (overrides = {}) => ({
  transaction_type: "sale", label: "Rice bags", normalized_label: "rice_bags",
  confirmed_at: now - 100, entry_hash: "hash", ...overrides
});

test("uses a 90-day inclusive window and requires two uses", () => {
  const result = computeQuickTransactions({ records: [
    record({ confirmed_at: now - 89 * 86400, entry_hash: "one" }), record({ confirmed_at: now - 89 * 86400, entry_hash: "two" }),
    record({ label: "Old", normalized_label: "old", confirmed_at: now - 91 * 86400, entry_hash: "old-one" }), record({ label: "Old", normalized_label: "old", confirmed_at: now - 91 * 86400, entry_hash: "old-two" }),
    record({ label: "Once", normalized_label: "once", entry_hash: "once" })
  ], nowSeconds: now });
  assert.deepEqual(result.inflow, [{ transaction_type: "sale", normalized_label: "rice_bags", label: "Rice bags", uses: 2 }]);
});

test("ignores reversals, reversed records, transfers, liabilities, and missing fields", () => {
  const result = computeQuickTransactions({ records: [
    record({ entry_hash: "reversed" }), record({ entry_hash: "live" }), record({ entry_hash: "live-two" }),
    record({ transaction_type: "reversal", reversed_entry_hash: "reversed" }),
    record({ transaction_type: "transfer", label: "Till", normalized_label: "till" }),
    record({ transaction_type: "liability_in", label: "Loan", normalized_label: "loan" }), {}, record({ normalized_label: "" })
  ], nowSeconds: now });
  assert.deepEqual(result.inflow, [{ transaction_type: "sale", normalized_label: "rice_bags", label: "Rice bags", uses: 2 }]);
  assert.deepEqual(result.outflow, []);
});

test("splits, ranks, caps, remains deterministic, and does not mutate input", () => {
  const records = [
    record({ label: "Zulu", normalized_label: "zulu", entry_hash: "z1", confirmed_at: now - 10 }), record({ label: "Zulu", normalized_label: "zulu", entry_hash: "z2", confirmed_at: now - 10 }),
    record({ label: "Alpha", normalized_label: "alpha", entry_hash: "a1", confirmed_at: now - 10 }), record({ label: "Alpha", normalized_label: "alpha", entry_hash: "a2", confirmed_at: now - 10 }),
    record({ label: "Recent", normalized_label: "recent", entry_hash: "r1", confirmed_at: now - 1 }), record({ label: "Recent", normalized_label: "recent", entry_hash: "r2", confirmed_at: now - 1 }),
    record({ transaction_type: "purchase", label: "Stock", normalized_label: "stock", entry_hash: "p1" }), record({ transaction_type: "purchase", label: "Stock", normalized_label: "stock", entry_hash: "p2" }),
    record({ transaction_type: "payment", label: "Rent", normalized_label: "rent", entry_hash: "q1" }), record({ transaction_type: "payment", label: "Rent", normalized_label: "rent", entry_hash: "q2" })
  ];
  const before = structuredClone(records);
  const first = computeQuickTransactions({ records, nowSeconds: now, perRow: 2 });
  assert.deepEqual(first.inflow.map((item) => item.label), ["Recent", "Alpha"]);
  assert.deepEqual(first.outflow.map((item) => item.transaction_type), ["payment", "purchase"]);
  assert.deepEqual(computeQuickTransactions({ records, nowSeconds: now, perRow: 2 }), first);
  assert.deepEqual(records, before);
});

test("returns empty rows for empty or unavailable input", () => {
  assert.deepEqual(computeQuickTransactions({ records: [], nowSeconds: now }), { inflow: [], outflow: [] });
  assert.deepEqual(computeQuickTransactions({ records: null, nowSeconds: now }), { inflow: [], outflow: [] });
});
