function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export const NATURAL_AMOUNT_PATTERN = "([0-9]+(?:\\.[0-9]+)?\\s*(?:k|thousand)?)";

export function normalizeNaturalTransactionText(input) {
  return String(input || "")
    .trim()
    .replace(/[₦$£€₵]/g, " ")
    .replace(/,/g, "")
    .replace(/\b(?:ngn|usd|naira|naria|dollars?|bucks?|cedis?|pounds?|euros?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseNaturalAmount(value) {
  const raw = String(value || "").trim().toLowerCase();
  const hasMultiplier = /\s*(?:k|thousand)\b/.test(raw);
  const normalized = raw.replace(/\s*(?:k|thousand)\b/g, "").trim();
  const number = parseFloat(normalized);
  if (!Number.isFinite(number)) return 0;
  const amount = hasMultiplier ? number * 1000 : number;
  return Math.round(amount * 100);
}

export function isLikelyNaturalAmount(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (/\s*(?:k|thousand)\b/.test(raw)) return true;
  const number = parseFloat(raw);
  return Number.isFinite(number) && number >= 100;
}

export function cleanNaturalLabelQuery(value) {
  let label = normalizeText(value)
    .replace(/^(?:some|the|a|an)\s+/i, "")
    .replace(/^[0-9]+(?:\.[0-9]+)?\s*(?:bags?|plates?|cups?|pieces?|pcs|cartons?|boxes?|bottles?|litres?|liters?|kg|kilos?|dozens?|packs?|portions?|sets?)\s+(?:of\s+)?/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/^(?:am|it|them|that|something)$/.test(label)) {
    label = "";
  }

  return label;
}

export const QUANTITY_UNIT_WORDS = /^(?:bags?|plates?|cups?|pieces?|pcs|cartons?|boxes?|bottles?|litres?|liters?|kg|kilos?|dozens?|packs?|portions?|sets?|units?|items?)$/;

export function isQuantityOnlySaleQuery(value) {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  let sawQuantityWord = false;
  for (const token of normalized.split(/\s+/)) {
    if (!token || token === "of") continue;
    if (/^[0-9]+(?:\.[0-9]+)?$/.test(token)) continue;
    if (QUANTITY_UNIT_WORDS.test(token)) {
      sawQuantityWord = true;
      continue;
    }
    return false;
  }
  return sawQuantityWord;
}

export function parsedNaturalTransaction(action, labelQuery, amountValue, counterparty = "") {
  const amountMinor = parseNaturalAmount(amountValue);
  if (!amountMinor) return null;
  let cleanedLabel = cleanNaturalLabelQuery(labelQuery);
  // A sale phrased only with quantity/unit words ("50 units", "3 pieces") describes a
  // generic product sale — resolve to the Products label rather than leaving it unmatched.
  // Empty queries (e.g. Pidgin "I sell am") are intentionally left blank, not defaulted.
  if (action === "sale" && isQuantityOnlySaleQuery(labelQuery)) {
    cleanedLabel = "products";
  }
  return {
    action,
    labelQuery: cleanedLabel,
    amountMinor,
    counterparty: String(counterparty || "").trim()
  };
}

export function parseNaturalTransaction(input) {
  const text = normalizeNaturalTransactionText(input);
  const amount = NATURAL_AMOUNT_PATTERN;

  // Phase 4A — borrowing taxonomy. Checked first: "paid back …" must not be
  // read as a generic payment, and "borrowed …" must not fall through.
  let match = text.match(new RegExp(`^(?:i\\s+)?loan\\s+(?:repayment|payback)\\s+(?:of\\s+)?${amount}$`, "i"));
  if (match) return parsedNaturalTransaction("liability_out", "Loan Repayment", match[1]);

  match = text.match(new RegExp(`^(?:i\\s+)?(?:repaid|repay)\\s+(?:the\\s+|a\\s+|my\\s+)?(?:loan|borrowing|debt)\\s+${amount}$`, "i"));
  if (match) return parsedNaturalTransaction("liability_out", "Loan Repayment", match[1]);

  match = text.match(new RegExp(`^(?:i\\s+)?paid\\s+back\\s+(?:the\\s+|a\\s+|my\\s+)?(?:loan\\s+)?${amount}$`, "i"));
  if (match) return parsedNaturalTransaction("liability_out", "Loan Repayment", match[1]);

  match = text.match(new RegExp(`^(?:i\\s+)?(?:repaid|repay)\\s+${amount}$`, "i"));
  if (match) return parsedNaturalTransaction("liability_out", "Loan Repayment", match[1]);

  match = text.match(new RegExp(`^(?:i\\s+)?(?:borrowed|borrow)\\s+${amount}\\s+from\\s+(.+)$`, "i"));
  if (match) return parsedNaturalTransaction("liability_in", match[2], match[1], match[2]);

  match = text.match(new RegExp(`^(?:i\\s+)?(?:borrowed|borrow)\\s+(.+?)\\s+(?:for|at)\\s+${amount}$`, "i"));
  if (match) return parsedNaturalTransaction("liability_in", match[1], match[2]);

  match = text.match(new RegExp(`^(?:i\\s+)?(?:borrowed|borrow)\\s+${amount}$`, "i"));
  if (match) return parsedNaturalTransaction("liability_in", "", match[1]);

  match = text.match(new RegExp(`^(?:i\\s+)?(?:borrowed|borrow)\\s+(.+?)\\s+${amount}$`, "i"));
  if (match) return parsedNaturalTransaction("liability_in", match[1], match[2]);

  match = text.match(new RegExp(`^(?:i\\s+)?(?:sold|sell)\\s+(.+?)\\s+(?:for|at)\\s+${amount}$`, "i"));
  if (match) {
    return parsedNaturalTransaction("sale", match[1], match[2]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:sold|sell)\\s+${amount}\\s+(.+)$`, "i"));
  if (match && isLikelyNaturalAmount(match[1])) {
    return parsedNaturalTransaction("sale", match[2], match[1]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:sold|sell)\\s+(.+?)\\s+${amount}$`, "i"));
  if (match) {
    return parsedNaturalTransaction("sale", match[1], match[2]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:bought|buy)\\s+(.+?)\\s+(?:for|at)\\s+${amount}$`, "i"));
  if (match) {
    return parsedNaturalTransaction("purchase", match[1], match[2]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:bought|buy)\\s+${amount}\\s+(.+)$`, "i"));
  if (match && isLikelyNaturalAmount(match[1])) {
    return parsedNaturalTransaction("purchase", match[2], match[1]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:bought|buy)\\s+(.+?)\\s+${amount}$`, "i"));
  if (match) {
    return parsedNaturalTransaction("purchase", match[1], match[2]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:paid|pay)\\s+${amount}\\s+to\\s+(.+?)\\s+for\\s+(.+)$`, "i"));
  if (match) {
    return parsedNaturalTransaction("payment", match[3], match[1], match[2]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:paid|pay)\\s+${amount}\\s+for\\s+(.+)$`, "i"));
  if (match) {
    return parsedNaturalTransaction("payment", match[2], match[1]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:paid|pay)\\s+(.+?)\\s+(?:for\\s+)?${amount}$`, "i"));
  if (match) {
    return parsedNaturalTransaction("payment", match[1], match[2]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:received|receive|collected|collect)\\s+${amount}\\s+from\\s+(.+?)\\s+for\\s+(.+)$`, "i"));
  if (match) {
    return parsedNaturalTransaction("receipt", match[3], match[1], match[2]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:received|receive|collected|collect)\\s+${amount}\\s+from\\s+(.+)$`, "i"));
  if (match) {
    return parsedNaturalTransaction("receipt", "Customer Payment", match[1], match[2]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:received|receive|collected|collect)\\s+(.+?)\\s+(?:for|at)\\s+${amount}$`, "i"));
  if (match) {
    return parsedNaturalTransaction("receipt", match[1], match[2]);
  }

  match = text.match(new RegExp(`^(?:i\\s+)?(?:received|receive|collected|collect)\\s+(.+?)\\s+${amount}$`, "i"));
  if (match) {
    return parsedNaturalTransaction("receipt", match[1], match[2]);
  }

  match = text.match(new RegExp(`^(customer|client)\\s+(?:paid|pay)\\s+${amount}$`, "i"));
  if (match) {
    return parsedNaturalTransaction("receipt", "Customer Payment", match[2], match[1]);
  }

  return null;
}
