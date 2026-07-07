import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeNaturalTransactionText,
  parseNaturalAmount,
  isLikelyNaturalAmount,
  cleanNaturalLabelQuery,
  isQuantityOnlySaleQuery,
  parsedNaturalTransaction,
  parseNaturalTransaction
} from "../../app-v3/nlp-parser.js";

test("normalizeNaturalTransactionText strips currency symbols, words and commas", () => {
  assert.equal(normalizeNaturalTransactionText("sold rice for ₦75,000"), "sold rice for 75000");
  assert.equal(normalizeNaturalTransactionText("paid $1,200 dollars"), "paid 1200");
  assert.equal(normalizeNaturalTransactionText("  received  500 naira  "), "received 500");
  assert.equal(normalizeNaturalTransactionText(null), "");
});

test("parseNaturalAmount converts to minor units with k/thousand multiplier", () => {
  assert.equal(parseNaturalAmount("500"), 50000);
  assert.equal(parseNaturalAmount("7.5k"), 750000);
  assert.equal(parseNaturalAmount("2 thousand"), 200000);
  assert.equal(parseNaturalAmount("12.34"), 1234);
  assert.equal(parseNaturalAmount("abc"), 0);
  assert.equal(parseNaturalAmount(""), 0);
});

test("isLikelyNaturalAmount accepts k-suffixed or >=100 plain numbers", () => {
  assert.equal(isLikelyNaturalAmount("5k"), true);
  assert.equal(isLikelyNaturalAmount("150"), true);
  assert.equal(isLikelyNaturalAmount("99"), false);
  assert.equal(isLikelyNaturalAmount("rice"), false);
});

test("cleanNaturalLabelQuery strips articles and quantity prefixes, blanks pronouns", () => {
  assert.equal(cleanNaturalLabelQuery("some rice"), "rice");
  assert.equal(cleanNaturalLabelQuery("3 bags of rice"), "rice");
  assert.equal(cleanNaturalLabelQuery("2 plates jollof"), "jollof");
  // Pidgin pronouns resolve to empty, not a fake label
  assert.equal(cleanNaturalLabelQuery("am"), "");
  assert.equal(cleanNaturalLabelQuery("it"), "");
  // Voice phase 1: generic nouns are kept, not stripped
  assert.equal(cleanNaturalLabelQuery("goods"), "goods");
  assert.equal(cleanNaturalLabelQuery("items"), "items");
  assert.equal(cleanNaturalLabelQuery("products"), "products");
});

test("isQuantityOnlySaleQuery detects quantity/unit-only phrases", () => {
  assert.equal(isQuantityOnlySaleQuery("50 units"), true);
  assert.equal(isQuantityOnlySaleQuery("3 pieces"), true);
  assert.equal(isQuantityOnlySaleQuery("2 bags of"), true);
  assert.equal(isQuantityOnlySaleQuery("50 bags of rice"), false);
  assert.equal(isQuantityOnlySaleQuery("rice"), false);
  assert.equal(isQuantityOnlySaleQuery("50"), false);
  assert.equal(isQuantityOnlySaleQuery(""), false);
});

test("parsedNaturalTransaction resolves quantity-only sale to products", () => {
  const parsed = parsedNaturalTransaction("sale", "50 units", "385");
  assert.equal(parsed.action, "sale");
  assert.equal(parsed.labelQuery, "products");
  assert.equal(parsed.amountMinor, 38500);
});

test("parsedNaturalTransaction returns null on zero/invalid amount", () => {
  assert.equal(parsedNaturalTransaction("sale", "rice", "0"), null);
  assert.equal(parsedNaturalTransaction("sale", "rice", "abc"), null);
});

test("parseNaturalTransaction routes sale phrasing", () => {
  const parsed = parseNaturalTransaction("I sold rice for 5000");
  assert.equal(parsed.action, "sale");
  assert.equal(parsed.labelQuery, "rice");
  assert.equal(parsed.amountMinor, 500000);
});

test("parseNaturalTransaction: quantity-only sale normalizes to products", () => {
  const parsed = parseNaturalTransaction("Sold 50 units for 385");
  assert.equal(parsed.action, "sale");
  assert.equal(parsed.labelQuery, "products");
});

test("parseNaturalTransaction: pidgin empty label stays blank, not defaulted", () => {
  const parsed = parseNaturalTransaction("I sell am for 500");
  assert.equal(parsed.action, "sale");
  assert.equal(parsed.labelQuery, "");
});

test("parseNaturalTransaction routes purchase phrasing", () => {
  const parsed = parseNaturalTransaction("I bought fuel for 12,500");
  assert.equal(parsed.action, "purchase");
  assert.equal(parsed.labelQuery, "fuel");
  assert.equal(parsed.amountMinor, 1250000);
});

test("parseNaturalTransaction routes payment with counterparty", () => {
  const parsed = parseNaturalTransaction("I paid 500 to Musa for transport");
  assert.equal(parsed.action, "payment");
  assert.equal(parsed.labelQuery, "transport");
  assert.equal(parsed.counterparty, "Musa");
});

test("parseNaturalTransaction routes receipt phrasing", () => {
  const parsed = parseNaturalTransaction("I received 2500 from ABC Traders");
  assert.equal(parsed.action, "receipt");
  assert.equal(parsed.labelQuery, "customer payment");
  assert.equal(parsed.counterparty, "ABC Traders");
});

test("parseNaturalTransaction routes 'customer paid' to receipt", () => {
  const parsed = parseNaturalTransaction("customer paid 28000");
  assert.equal(parsed.action, "receipt");
  assert.equal(parsed.labelQuery, "customer payment");
});

// Phase 4A borrowing taxonomy: liability phrasing must never fall into
// sale/receipt/payment, and repayment must not read as a generic payment.
test("parseNaturalTransaction routes borrowing to liability_in", () => {
  const parsed = parseNaturalTransaction("I borrowed 20000 from Mama Chika");
  assert.equal(parsed.action, "liability_in");
  assert.equal(parsed.counterparty, "Mama Chika");
  assert.equal(parsed.amountMinor, 2000000);

  const bare = parseNaturalTransaction("borrowed 5k");
  assert.equal(bare.action, "liability_in");
  assert.equal(bare.labelQuery, "");
  assert.equal(bare.amountMinor, 500000);
});

test("parseNaturalTransaction routes repayment to liability_out", () => {
  for (const phrase of ["I repaid 5000", "paid back 3000", "loan repayment of 2k", "repaid the loan 4000"]) {
    const parsed = parseNaturalTransaction(phrase);
    assert.equal(parsed.action, "liability_out", `phrase: ${phrase}`);
    assert.equal(parsed.labelQuery, "loan repayment", `phrase: ${phrase}`);
  }
});

test("parseNaturalTransaction returns null on unparseable or zero-amount input", () => {
  assert.equal(parseNaturalTransaction("hello world"), null);
  assert.equal(parseNaturalTransaction("sold rice"), null);
  assert.equal(parseNaturalTransaction("I sold rice for 0"), null);
  assert.equal(parseNaturalTransaction(""), null);
});
