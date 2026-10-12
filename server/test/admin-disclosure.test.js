import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  discloseBreakdown,
  discloseCount,
  discloseSubset
} from "../src/admin-disclosure.js";
import { COUNTRY_CODES, SECTOR_IDS } from "../src/admin-dimensions.js";
import { config, validateRuntimeConfig } from "../src/config.js";
import { COUNTRIES, SECTORS } from "../../app-v3/catalog-data.js";

function oracleCount(count, contributors, k) {
  return contributors < k ? { status: "fewer_than_k" } : { status: "published", value: count };
}

function oracleBreakdown(cells, k, universeSize) {
  const present = cells.filter(({ count }) => count !== 0).map((cell) => ({ ...cell }));
  const total = present.reduce((sum, { count }) => sum + count, 0);
  const stop = (reason) => ({ status: "withheld", reason, total: oracleCount(total, total, k) });
  if (total < k) return stop("total_below_minimum");
  const named = present.filter(({ count }) => count >= k);
  const combined = present.filter(({ count }) => count < k);
  if (!combined.length) {
    named.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
    return { status: "published", cells: named, total };
  }
  named.sort((a, b) => a.count - b.count || a.category.localeCompare(b.category));
  let sum = combined.reduce((value, { count }) => value + count, 0);
  let combinedCount = combined.length;
  while (combinedCount < 2 || sum < k) {
    if (!named.length) return stop("residual_unsafe");
    const next = named.shift();
    sum += next.count;
    combinedCount += 1;
  }
  if (!named.length) return stop("residual_unsafe");
  const possibleHidden = universeSize - named.length;
  if (sum > (possibleHidden - 1) * (k - 1)) return stop("residual_unsafe");
  named.sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  return { status: "published", cells: [...named, { category: "other", count: sum }], total };
}

function enumerate(categoryCount, maxCount, visit) {
  const categories = Array.from({ length: categoryCount }, (_, index) => `category_${index}_marker`);
  const counts = Array(categoryCount).fill(0);
  function step(index) {
    if (index === categoryCount) {
      visit(categories.map((category, position) => ({ category, count: counts[position] })), categories);
      return;
    }
    for (let count = 0; count <= maxCount; count += 1) {
      counts[index] = count;
      step(index + 1);
    }
  }
  step(0);
}

function verifyEnumeration(categoryCount, maxCount, k, verifyPinned = false) {
  const groups = new Map();
  enumerate(categoryCount, maxCount, (cells, categories) => {
    const result = discloseBreakdown(cells, k, categoryCount);
    assert.deepEqual(result, oracleBreakdown(cells, k, categoryCount));
    const serialized = JSON.stringify(result);
    if (result.status === "withheld") {
      assert.equal(Object.hasOwn(result, "cells"), false);
      for (const category of categories) assert.equal(serialized.includes(category), false);
      return;
    }
    const named = new Set(result.cells.filter(({ category }) => category !== "other")
      .map(({ category }) => category));
    for (const cell of result.cells) {
      if (cell.category !== "other") assert.ok(cell.count >= k);
    }
    assert.equal(result.cells.reduce((sum, { count }) => sum + count, 0), result.total);
    const residual = result.cells.find(({ category }) => category === "other");
    if (!residual) return;
    const hidden = cells.filter(({ category, count }) => count > 0 && !named.has(category));
    assert.ok(hidden.length >= 2);
    assert.ok(residual.count >= k);
    const possibleHidden = categoryCount - named.size;
    assert.ok(residual.count <= (possibleHidden - 1) * (k - 1));
    for (const { category } of hidden) assert.equal(serialized.includes(category), false);

    if (verifyPinned) {
      let group = groups.get(serialized);
      if (!group) {
        group = { named, zero: 0, positive: 0, size: 0 };
        groups.set(serialized, group);
      }
      group.size += 1;
      cells.forEach(({ count }, index) => {
        if (count === 0) group.zero |= 2 ** index;
        else group.positive |= 2 ** index;
      });
    }
  });
  if (verifyPinned) {
    for (const group of groups.values()) {
      assert.ok(group.size > 1);
      for (let index = 0; index < categoryCount; index += 1) {
        if (group.named.has(`category_${index}_marker`)) continue;
        assert.ok(group.zero & (2 ** index));
        assert.ok(group.positive & (2 ** index));
      }
    }
  }
}

test("count disclosure enforces contributor boundaries and validates inputs", () => {
  assert.deepEqual(discloseCount(100, 4, 5), { status: "fewer_than_k" });
  assert.deepEqual(discloseCount(100, 5, 5), { status: "published", value: 100 });
  assert.deepEqual(discloseCount(0, 0, 5), { status: "fewer_than_k" });
  for (const input of [-1, 1.5, NaN]) assert.throws(() => discloseCount(input, 5, 5));
  assert.throws(() => discloseCount(1, -1, 5));
  assert.throws(() => discloseCount(1, 1, 4));
});

test("subset disclosure covers every threshold and remainder boundary", () => {
  assert.deepEqual(discloseSubset(4, 4, 5), { status: "withheld" });
  assert.deepEqual(discloseSubset(4, 5, 5), { status: "fewer_than_k" });
  assert.deepEqual(discloseSubset(5, 5, 5), { status: "published", value: 5 });
  assert.deepEqual(discloseSubset(5, 6, 5), { status: "withheld" });
  assert.deepEqual(discloseSubset(5, 9, 5), { status: "withheld" });
  assert.deepEqual(discloseSubset(5, 10, 5), { status: "published", value: 5 });
  assert.deepEqual(discloseSubset(6, 11, 5), { status: "published", value: 6 });
  assert.throws(() => discloseSubset(6, 5, 5));
  for (let parent = 0; parent <= 20; parent += 1) {
    for (let subset = 0; subset <= parent; subset += 1) {
      const result = discloseSubset(subset, parent, 5);
      if (result.status === "published") {
        assert.ok(subset >= 5);
        assert.ok(parent - subset === 0 || parent - subset >= 5);
      } else {
        assert.equal(Object.hasOwn(result, "value"), false);
      }
    }
  }
});

test("breakdown handles boundaries, the reviewed ceiling case, and order independently", () => {
  assert.deepEqual(discloseBreakdown([
    { category: "a", count: 8 },
    { category: "b", count: 4 },
    { category: "c", count: 4 },
    { category: "d", count: 4 },
    { category: "e", count: 4 }
  ], 5, 5), {
    status: "withheld",
    reason: "residual_unsafe",
    total: { status: "published", value: 24 }
  });
  const sixCategoryResult = discloseBreakdown([
    { category: "a", count: 8 },
    { category: "b", count: 4 },
    { category: "c", count: 4 },
    { category: "d", count: 4 },
    { category: "e", count: 4 }
  ], 5, 6);
  assert.deepEqual(sixCategoryResult, {
    status: "published",
    cells: [{ category: "a", count: 8 }, { category: "other", count: 16 }],
    total: 24
  });
  const cells = [
    { category: "z", count: 12 },
    { category: "a", count: 7 },
    { category: "x", count: 3 },
    { category: "m", count: 2 }
  ];
  const shuffled = [cells[2], cells[0], cells[3], cells[1]];
  assert.deepEqual(discloseBreakdown(cells, 5, 10), discloseBreakdown(shuffled, 5, 10));
  assert.throws(() => discloseBreakdown([{ category: "other", count: 5 }], 5, 1));
  assert.throws(() => discloseBreakdown([{ category: "a", count: 1 }, { category: "a", count: 2 }], 5, 2));
});

test("P1 and P2: exhaustive k=5 breakdown properties and no pinned hidden category", () => {
  for (const [categories, maximum] of [[2, 8], [3, 8], [4, 8], [5, 8], [6, 6]]) {
    verifyEnumeration(categories, maximum, 5, true);
  }
});

test("P4: exhaustive breakdown properties at k=7", () => {
  verifyEnumeration(4, 8, 7);
});

test("the disclosure library has no imports", async () => {
  const source = await readFile(new URL("../src/admin-disclosure.js", import.meta.url), "utf8");
  assert.equal(/^\s*import\s/m.test(source), false);
});

test("dimension allow-lists match the client catalog", () => {
  assert.deepEqual(COUNTRY_CODES, COUNTRIES.map(({ id }) => id));
  assert.deepEqual(SECTOR_IDS, SECTORS.map(({ id }) => id));
  assert.equal(COUNTRY_CODES.length, 249);
});

test("the configured threshold accepts integers at least five and rejects other values fatally", () => {
  const saved = { ...config };
  Object.assign(config, {
    nodeEnv: "development",
    jwtSecret: "test-jwt-secret",
    serverReceiptSecret: "test-receipt-secret",
    serverAttestationPrivateKeyPem: "test-key",
    adminJwtExpiry: "1h",
    trustProxy: false,
    allowDevOtp: true,
    smsProviderEnabled: false
  });
  try {
    for (const value of [5, 10]) {
      config.adminKAnonThreshold = value;
      assert.doesNotThrow(() => validateRuntimeConfig());
    }
    for (const value of [4, 0, -1, 5.5, NaN]) {
      config.adminKAnonThreshold = value;
      assert.throws(
        () => validateRuntimeConfig(),
        (error) => error.fatal === true && /ADMIN_K_ANON_THRESHOLD/.test(error.message)
      );
    }
  } finally {
    Object.assign(config, saved);
  }
});
