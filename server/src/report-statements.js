function getStatementTransactionType(entry) {
  return String(
    entry?.transaction_type
    || entry?.payload?.transaction_type
    || entry?.payload?.action
    || ""
  ).trim().toLowerCase();
}

function getStatementAmountMinor(entry) {
  return Number(entry?.amount_minor ?? entry?.payload?.amount_minor ?? 0);
}

function getStatementReversedHash(entry) {
  return String(entry?.reversed_entry_hash || entry?.payload?.reversed_entry_hash || "").trim();
}

function getStatementConfirmedAtSeconds(entry) {
  const value = entry?.confirmed_at;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1e12) return Math.floor(value / 1000);
    return Math.floor(value);
  }
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

export function computeFinancialStatements(entries, currency) {
  const reversedHashes = new Set(
    entries
      .filter((entry) => getStatementTransactionType(entry) === "reversal" && getStatementReversedHash(entry))
      .map((entry) => getStatementReversedHash(entry))
  );

  const effective = entries.filter((entry) => {
    const transactionType = getStatementTransactionType(entry);
    if (transactionType === "reversal") return false;
    return !reversedHashes.has(String(entry?.entry_hash || ""));
  });

  let grossRevenue = 0;
  let otherIncome = 0;
  let costOfGoods = 0;
  let operatingExpenses = 0;
  let borrowedIn = 0;
  let loanRepaid = 0;
  let start = null;
  let end = null;
  const monthlyBuckets = new Map();

  effective.forEach((entry) => {
    const transactionType = getStatementTransactionType(entry);
    const amountMinor = getStatementAmountMinor(entry);
    const confirmedAt = getStatementConfirmedAtSeconds(entry);
    if (!confirmedAt) return;

    if (start == null || confirmedAt < start) start = confirmedAt;
    if (end == null || confirmedAt > end) end = confirmedAt;

    const month = new Date(confirmedAt * 1000).toISOString().slice(0, 7);
    const bucket = monthlyBuckets.get(month) || { inflows: 0, outflows: 0, net: 0 };

    if (transactionType === "sale") {
      grossRevenue += amountMinor;
      bucket.inflows += amountMinor;
    } else if (transactionType === "receipt") {
      otherIncome += amountMinor;
      bucket.inflows += amountMinor;
    } else if (transactionType === "purchase") {
      costOfGoods += amountMinor;
      bucket.outflows += amountMinor;
    } else if (transactionType === "payment") {
      operatingExpenses += amountMinor;
      bucket.outflows += amountMinor;
    } else if (transactionType === "liability_in") {
      // Borrowing is recorded separately — never revenue/income/inflow.
      borrowedIn += amountMinor;
    } else if (transactionType === "liability_out") {
      // Loan repayment is recorded separately — never expense/outflow.
      loanRepaid += amountMinor;
    }

    bucket.net = bucket.inflows - bucket.outflows;
    monthlyBuckets.set(month, bucket);
  });

  return {
    incomeStatement: {
      grossRevenue,
      otherIncome,
      costOfGoods,
      operatingExpenses,
      netIncome: (grossRevenue + otherIncome) - (costOfGoods + operatingExpenses)
    },
    borrowing: {
      borrowedIn,
      loanRepaid
    },
    cashFlowByMonth: [...monthlyBuckets.entries()]
      .sort(([monthA], [monthB]) => monthA.localeCompare(monthB))
      .map(([month, values]) => ({
        month,
        inflows: values.inflows,
        outflows: values.outflows,
        net: values.net
      })),
    dateRange: { start, end },
    currency
  };
}

export function getEntryCurrency(entry, fallbackCurrency = "NGN") {
  return String(entry?.payload?.currency || entry?.currency || fallbackCurrency || "NGN").toUpperCase();
}

export function groupEntriesByCurrency(entries, fallbackCurrency = "NGN") {
  const grouped = new Map();
  entries.forEach((entry) => {
    const currency = getEntryCurrency(entry, fallbackCurrency);
    if (!grouped.has(currency)) grouped.set(currency, []);
    grouped.get(currency).push(entry);
  });
  return [...grouped.entries()].sort(([currencyA], [currencyB]) => currencyA.localeCompare(currencyB));
}
