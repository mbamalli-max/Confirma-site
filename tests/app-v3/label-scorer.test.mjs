import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scoreLabelTextMatch,
  CONFIDENT_LABEL_SCORE,
  stripScore,
  normalizeActionKey,
  layerBActionKey,
  layerBContextFromActionKey,
  slugifyLabel,
  friendlyActionLabel
} from "../../app-v3/label-scorer.js";

const palmOil = { display_name: "Palm Oil", synonyms: ["red oil"] };
const generatorFuel = { display_name: "Generator Fuel", synonyms: [] };
const riceStock = { display_name: "Rice Stock", synonyms: [] };

test("scoreLabelTextMatch: exact match scores 56", () => {
  assert.deepEqual(scoreLabelTextMatch("palm oil", palmOil), { score: 56, reason: "Exact match" });
});

test("scoreLabelTextMatch: synonyms score like display names", () => {
  assert.equal(scoreLabelTextMatch("red oil", palmOil).score, 56);
});

test("scoreLabelTextMatch: exact word match scores 42", () => {
  assert.deepEqual(scoreLabelTextMatch("palm", palmOil), { score: 42, reason: "Exact word match" });
});

test("scoreLabelTextMatch: multi-word fuzzy match scores 38", () => {
  assert.deepEqual(scoreLabelTextMatch("rice stocks", riceStock), { score: 38, reason: "Multi-word match" });
});

test("scoreLabelTextMatch: phrase substring scores 28", () => {
  assert.deepEqual(scoreLabelTextMatch("nerator", generatorFuel), { score: 28, reason: "Phrase match" });
});

test("scoreLabelTextMatch: prefix match scores 22 (the confidence threshold)", () => {
  const result = scoreLabelTextMatch("gen", generatorFuel);
  assert.deepEqual(result, { score: 22, reason: "Starts with your words" });
  assert.equal(result.score >= CONFIDENT_LABEL_SCORE, true);
});

test("scoreLabelTextMatch: close-spelling fuzzy match scores 18 (below threshold)", () => {
  const result = scoreLabelTextMatch("genarator", generatorFuel);
  assert.deepEqual(result, { score: 18, reason: "Close spelling match" });
  assert.equal(result.score < CONFIDENT_LABEL_SCORE, true);
});

test("scoreLabelTextMatch: empty or unrelated query scores 0", () => {
  assert.equal(scoreLabelTextMatch("", palmOil).score, 0);
  assert.equal(scoreLabelTextMatch("xyz", palmOil).score, 0);
});

test("CONFIDENT_LABEL_SCORE is locked at 22", () => {
  assert.equal(CONFIDENT_LABEL_SCORE, 22);
});

test("stripScore removes scoring fields without mutating the original", () => {
  const item = { id: "rice", display_name: "Rice", score: 42, confidence: "high", reason: "Exact word match" };
  const stripped = stripScore(item);
  assert.deepEqual(stripped, { id: "rice", display_name: "Rice" });
  assert.equal(item.score, 42);
});

test("normalizeActionKey maps verb keys to canonical actions", () => {
  assert.equal(normalizeActionKey("sell"), "sale");
  assert.equal(normalizeActionKey("buy"), "purchase");
  assert.equal(normalizeActionKey("pay"), "payment");
  assert.equal(normalizeActionKey("receive"), "receipt");
  assert.equal(normalizeActionKey("liability_in"), "liability_in");
});

test("layerBActionKey maps actions to catalog verb keys incl. transfers", () => {
  assert.equal(layerBActionKey("sale"), "sell");
  assert.equal(layerBActionKey("purchase"), "buy");
  assert.equal(layerBActionKey("payment"), "pay");
  assert.equal(layerBActionKey("receipt"), "receive");
  assert.equal(layerBActionKey("transfer_in"), "receive");
  assert.equal(layerBActionKey("transfer_out"), "pay");
  assert.equal(layerBActionKey("unknown"), "sell");
});

test("normalizeActionKey/layerBActionKey round-trip on the four primary actions", () => {
  for (const action of ["sale", "purchase", "payment", "receipt"]) {
    assert.equal(normalizeActionKey(layerBActionKey(action)), action);
  }
});

test("layerBContextFromActionKey maps verb keys back to contexts", () => {
  assert.equal(layerBContextFromActionKey("sell"), "sale");
  assert.equal(layerBContextFromActionKey("buy"), "purchase");
  assert.equal(layerBContextFromActionKey("pay"), "payment");
  assert.equal(layerBContextFromActionKey("receive"), "receipt");
  assert.equal(layerBContextFromActionKey("anything-else"), "receipt");
});

test("slugifyLabel normalizes to snake_case", () => {
  assert.equal(slugifyLabel("Palm Oil"), "palm_oil");
  assert.equal(slugifyLabel("  Pure-Water! "), "pure_water");
  assert.equal(slugifyLabel(""), "");
});

test("friendlyActionLabel covers liability actions and passes unknowns through", () => {
  assert.equal(friendlyActionLabel("sale"), "Sell");
  assert.equal(friendlyActionLabel("liability_in"), "Money Borrowed");
  assert.equal(friendlyActionLabel("liability_out"), "Loan Repayment");
  assert.equal(friendlyActionLabel("custom_thing"), "custom_thing");
});
