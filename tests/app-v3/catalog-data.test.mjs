import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SECTORS,
  SUPPORTED_LANGUAGES,
  REGION_CURRENCY_MAP,
  CAPTURE_EXAMPLES,
  BUSINESS_TYPES,
  QUICK_PICKS,
  LAYER_B,
  EXTRA_SEARCH_LABELS,
  LIABILITY_LABELS,
  PRIMARY_ACTIONS,
  TRANSFER_ACTIONS,
  LIABILITY_ACTIONS,
  isLiabilityAction
} from "../../app-v3/catalog-data.js";

test("isLiabilityAction accepts only the two liability actions", () => {
  assert.equal(isLiabilityAction("liability_in"), true);
  assert.equal(isLiabilityAction("liability_out"), true);
  assert.equal(isLiabilityAction("sale"), false);
  assert.equal(isLiabilityAction("transfer_in"), false);
  assert.equal(isLiabilityAction(""), false);
});

test("action id sets are locked (Phase 4A taxonomy)", () => {
  assert.deepEqual(PRIMARY_ACTIONS.map((a) => a.id), ["sale", "purchase", "payment", "receipt"]);
  assert.deepEqual(TRANSFER_ACTIONS.map((a) => a.id), ["transfer_in", "transfer_out"]);
  assert.deepEqual(LIABILITY_ACTIONS.map((a) => a.id), ["liability_in", "liability_out"]);
});

test("every business type references an existing sector", () => {
  const sectorIds = new Set(SECTORS.map((s) => s.id));
  for (const businessType of BUSINESS_TYPES) {
    assert.equal(
      sectorIds.has(businessType.sector_id),
      true,
      `business type ${businessType.id} references unknown sector ${businessType.sector_id}`
    );
  }
});

test("every QUICK_PICKS key is a known business type", () => {
  const businessTypeIds = new Set(BUSINESS_TYPES.map((b) => b.id));
  for (const key of Object.keys(QUICK_PICKS)) {
    assert.equal(businessTypeIds.has(key), true, `QUICK_PICKS key ${key} is not a business type`);
  }
});

test("QUICK_PICKS entries only use the four primary verb keys", () => {
  const allowed = new Set(["sell", "purchase", "payment", "receipt"]);
  for (const [businessType, picks] of Object.entries(QUICK_PICKS)) {
    for (const verb of Object.keys(picks)) {
      assert.equal(allowed.has(verb), true, `${businessType} has unexpected verb key ${verb}`);
    }
  }
});

test("LAYER_B regions use the four layer-B verb keys", () => {
  const allowed = new Set(["sell", "buy", "pay", "receive"]);
  for (const [region, businessTypes] of Object.entries(LAYER_B)) {
    for (const [businessType, verbs] of Object.entries(businessTypes)) {
      for (const verb of Object.keys(verbs)) {
        assert.equal(allowed.has(verb), true, `${region}/${businessType} has unexpected verb key ${verb}`);
      }
    }
  }
});

test("REGION_CURRENCY_MAP values are 3-letter ISO-style codes", () => {
  for (const [region, currency] of Object.entries(REGION_CURRENCY_MAP)) {
    assert.match(currency, /^[A-Z]{3}$/, `region ${region} has malformed currency ${currency}`);
  }
});

test("CAPTURE_EXAMPLES has non-empty NG, US and DEFAULT sets", () => {
  for (const region of ["NG", "US", "DEFAULT"]) {
    assert.equal(Array.isArray(CAPTURE_EXAMPLES[region]), true);
    assert.equal(CAPTURE_EXAMPLES[region].length > 0, true);
  }
});

test("SUPPORTED_LANGUAGES is a non-empty list", () => {
  assert.equal(SUPPORTED_LANGUAGES.length > 0, true);
});

test("search/liability labels are well-formed with unique ids", () => {
  const seen = new Set();
  for (const label of [...EXTRA_SEARCH_LABELS, ...LIABILITY_LABELS]) {
    assert.equal(typeof label.id, "string");
    assert.equal(label.id.length > 0, true);
    assert.equal(seen.has(label.id), false, `duplicate label id ${label.id}`);
    seen.add(label.id);
    assert.equal(typeof label.display_name, "string");
    assert.equal(Array.isArray(label.transaction_contexts), true);
    assert.equal(label.transaction_contexts.length > 0, true);
    assert.equal(Array.isArray(label.countries), true);
    assert.equal(Array.isArray(label.business_types), true);
  }
});

test("liability labels are global and carry only liability contexts", () => {
  for (const label of LIABILITY_LABELS) {
    assert.deepEqual(label.countries, ["GLOBAL"], `${label.id} should be GLOBAL`);
    assert.deepEqual(label.business_types, [], `${label.id} should have no business-type restriction`);
    for (const context of label.transaction_contexts) {
      assert.equal(isLiabilityAction(context), true, `${label.id} has non-liability context ${context}`);
    }
  }
});
