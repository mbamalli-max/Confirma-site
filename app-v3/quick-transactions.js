const INFLOW_TYPES = new Set(["sale", "receipt"]);
const OUTFLOW_TYPES = new Set(["purchase", "payment"]);

export function computeQuickTransactions({ records, nowSeconds, windowDays = 90, minUses = 2, perRow = 3 } = {}) {
  if (!Array.isArray(records) || !Number.isFinite(nowSeconds)) return { inflow: [], outflow: [] };
  const cutoff = nowSeconds - (Math.max(0, windowDays) * 24 * 60 * 60);
  const reversedHashes = new Set(records
    .filter((record) => record?.transaction_type === "reversal" && record.reversed_entry_hash)
    .map((record) => record.reversed_entry_hash));
  const groups = new Map();

  records.forEach((record) => {
    if (!record || record.transaction_type === "reversal" || reversedHashes.has(record.entry_hash)) return;
    if (!(INFLOW_TYPES.has(record.transaction_type) || OUTFLOW_TYPES.has(record.transaction_type))) return;
    if (!record.normalized_label || !record.label || record.confirmed_at == null || record.confirmed_at === "" || !Number.isFinite(Number(record.confirmed_at))) return;
    const confirmedAt = Number(record.confirmed_at);
    if (confirmedAt < cutoff || confirmedAt > nowSeconds) return;
    const key = `${record.transaction_type}\u0000${record.normalized_label}`;
    const group = groups.get(key) || { transaction_type: record.transaction_type, normalized_label: record.normalized_label, label: record.label, uses: 0, mostRecent: 0 };
    group.uses += 1;
    group.mostRecent = Math.max(group.mostRecent, confirmedAt);
    groups.set(key, group);
  });

  const rank = (types) => [...groups.values()]
    .filter((group) => types.has(group.transaction_type) && group.uses >= minUses)
    .sort((a, b) => b.uses - a.uses || b.mostRecent - a.mostRecent || a.label.localeCompare(b.label))
    .slice(0, Math.max(0, perRow))
    .map(({ mostRecent, ...group }) => group);

  return { inflow: rank(INFLOW_TYPES), outflow: rank(OUTFLOW_TYPES) };
}
