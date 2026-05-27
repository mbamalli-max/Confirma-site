function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function levenshteinDistance(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const current = row[j];
      const substitution = previous + (left[i - 1] === right[j - 1] ? 0 : 1);
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, substitution);
      previous = current;
    }
  }
  return row[right.length];
}

function soundexCode(value) {
  const letters = normalizeText(value).replace(/[^a-z]/g, "").toUpperCase();
  if (!letters) return "";
  const codes = { B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2, D: 3, T: 3, L: 4, M: 5, N: 5, R: 6 };
  let output = letters[0];
  let previous = codes[output] || "";

  for (let index = 1; index < letters.length && output.length < 4; index += 1) {
    const code = codes[letters[index]] || "";
    if (code && code !== previous) output += code;
    previous = code;
  }

  return output.padEnd(4, "0");
}

function textTokens(value) {
  return normalizeText(value).split(/\s+/).filter(Boolean);
}

function fuzzyTokenMatch(queryToken, labelToken) {
  if (queryToken.length < 4 || labelToken.length < 4) return false;
  if (queryToken.length <= 4 && queryToken.length !== labelToken.length) return false;
  const distance = levenshteinDistance(queryToken, labelToken);
  return distance <= (Math.max(queryToken.length, labelToken.length) >= 7 ? 2 : 1);
}

function phoneticTokenMatch(queryToken, labelToken) {
  if (queryToken.length < 4 || labelToken.length < 4) return false;
  if (Math.abs(queryToken.length - labelToken.length) > 2) return false;
  return soundexCode(queryToken) === soundexCode(labelToken);
}

function labelSearchTerms(item) {
  return [item.display_name, ...(item.synonyms || [])]
    .map((term) => normalizeText(term))
    .filter(Boolean);
}

export function scoreLabelTextMatch(query, item) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return { score: 0, reason: "" };

  const queryTokens = textTokens(normalizedQuery);
  let best = { score: 0, reason: "" };

  labelSearchTerms(item).forEach((term) => {
    const termTokens = textTokens(term);
    let score = 0;
    let reason = "";

    if (term === normalizedQuery) {
      score = 56;
      reason = "Exact match";
    } else if (termTokens.includes(normalizedQuery)) {
      score = 42;
      reason = "Exact word match";
    } else if (queryTokens.length > 1 && queryTokens.every((queryToken) => {
      return termTokens.some((labelToken) => labelToken === queryToken
        || (queryToken.length >= 3 && labelToken.startsWith(queryToken))
        || fuzzyTokenMatch(queryToken, labelToken));
    })) {
      score = 38;
      reason = "Multi-word match";
    } else if (normalizedQuery.length >= 5 && term.includes(normalizedQuery)) {
      score = 28;
      reason = "Phrase match";
    } else if (queryTokens.some((queryToken) => queryToken.length >= 3 && termTokens.some((labelToken) => labelToken.startsWith(queryToken)))) {
      score = 22;
      reason = "Starts with your words";
    } else if (queryTokens.some((queryToken) => termTokens.some((labelToken) => fuzzyTokenMatch(queryToken, labelToken)))) {
      score = 18;
      reason = "Close spelling match";
    } else if (queryTokens.some((queryToken) => termTokens.some((labelToken) => phoneticTokenMatch(queryToken, labelToken)))) {
      score = 12;
      reason = "Sounds similar";
    }

    if (score > best.score) {
      best = { score, reason };
    }
  });

  return best;
}

export const CONFIDENT_LABEL_SCORE = 22;

export function stripScore(item) {
  const clone = { ...item };
  delete clone.score;
  delete clone.confidence;
  delete clone.reason;
  return clone;
}

export function normalizeActionKey(action) {
  if (action === "sell") return "sale";
  if (action === "buy") return "purchase";
  if (action === "pay") return "payment";
  if (action === "receive") return "receipt";
  return action;
}

export function layerBActionKey(action) {
  if (action === "sale") return "sell";
  if (action === "purchase") return "buy";
  if (action === "payment") return "pay";
  if (action === "receipt") return "receive";
  if (action === "transfer_in") return "receive";
  if (action === "transfer_out") return "pay";
  return "sell";
}

export function layerBContextFromActionKey(actionKey) {
  if (actionKey === "sell") return "sale";
  if (actionKey === "buy") return "purchase";
  if (actionKey === "pay") return "payment";
  return "receipt";
}

export function slugifyLabel(value) {
  return normalizeText(value).replace(/\s+/g, "_");
}

export function friendlyActionLabel(action) {
  if (action === "sale") return "Sell";
  if (action === "purchase") return "Buy";
  if (action === "payment") return "Pay";
  if (action === "receipt") return "Receive";
  if (action === "transfer") return "Transfer";
  if (action === "liability_in") return "Money Borrowed";
  if (action === "liability_out") return "Loan Repayment";
  return action;
}
