function requireNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
}

function requireThreshold(k) {
  if (!Number.isSafeInteger(k) || k < 5) {
    throw new TypeError("k must be an integer of at least 5.");
  }
}

export function discloseCount(count, contributors, k) {
  requireNonNegativeInteger(count, "count");
  requireNonNegativeInteger(contributors, "contributors");
  requireThreshold(k);
  return contributors < k
    ? { status: "fewer_than_k" }
    : { status: "published", value: count };
}

export function discloseSubset(subset, parent, k) {
  requireNonNegativeInteger(subset, "subset");
  requireNonNegativeInteger(parent, "parent");
  requireThreshold(k);
  if (subset > parent) throw new RangeError("subset must not exceed parent.");
  if (parent < k) return { status: "withheld" };
  if (subset < k) return { status: "fewer_than_k" };
  const remainder = parent - subset;
  if (remainder > 0 && remainder < k) return { status: "withheld" };
  return { status: "published", value: subset };
}

function validateCells(cells, k) {
  if (!Array.isArray(cells)) throw new TypeError("cells must be an array.");
  requireThreshold(k);

  const categories = new Set();
  return cells.map((cell) => {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
      throw new TypeError("each cell must be an object.");
    }
    if (typeof cell.category !== "string" || !cell.category) {
      throw new TypeError("each category must be a non-empty string.");
    }
    if (cell.category === "other") throw new RangeError("other is a reserved category.");
    if (categories.has(cell.category)) throw new RangeError("categories must be unique.");
    categories.add(cell.category);
    requireNonNegativeInteger(cell.count, "cell count");
    return { category: cell.category, count: cell.count };
  }).filter(({ count }) => count > 0);
}

function cellTotal(cells) {
  return cells.reduce((sum, { count }) => {
    const next = sum + count;
    if (!Number.isSafeInteger(next)) throw new RangeError("cell total exceeds the safe integer range.");
    return next;
  }, 0);
}

function withheld(total, k, reason) {
  return {
    status: "withheld",
    reason,
    total: discloseCount(total, total, k)
  };
}

export function discloseAllCells(cells, k) {
  const nonZero = validateCells(cells, k);
  const total = cellTotal(nonZero);
  if (total < k) return withheld(total, k, "total_below_minimum");
  return {
    status: "published",
    cells: nonZero.sort((left, right) => right.count - left.count
      || left.category.localeCompare(right.category)),
    total
  };
}

export function discloseBreakdown(cells, k, universeSize) {
  const nonZero = validateCells(cells, k);
  requireNonNegativeInteger(universeSize, "universeSize");
  if (universeSize < cells.length) {
    throw new RangeError("universeSize must be at least the number of cells.");
  }

  const total = cellTotal(nonZero);
  if (total < k) return withheld(total, k, "total_below_minimum");

  const published = nonZero.filter(({ count }) => count >= k);
  const hidden = nonZero.filter(({ count }) => count < k);
  if (hidden.length === 0) {
    return {
      status: "published",
      cells: published.sort((left, right) => right.count - left.count
        || left.category.localeCompare(right.category)),
      total
    };
  }

  published.sort((left, right) => left.count - right.count
    || left.category.localeCompare(right.category));
  let residualCount = hidden.reduce((sum, { count }) => sum + count, 0);
  let residualCells = hidden.length;
  while (residualCells < 2 || residualCount < k) {
    if (published.length === 0) return withheld(total, k, "residual_unsafe");
    const moved = published.shift();
    residualCount += moved.count;
    residualCells += 1;
  }
  if (published.length === 0) return withheld(total, k, "residual_unsafe");

  const unshownCategoryCount = universeSize - published.length;
  if (residualCount > (unshownCategoryCount - 1) * (k - 1)) {
    return withheld(total, k, "residual_unsafe");
  }
  published.sort((left, right) => right.count - left.count
    || left.category.localeCompare(right.category));
  return {
    status: "published",
    cells: [...published, { category: "other", count: residualCount }],
    total
  };
}
