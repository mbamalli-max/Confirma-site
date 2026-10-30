// Generates server/test/fixtures/ledger-hash-vectors.json by running the APP's own
// buildLedgerHashCanonicalString + sha256 (extracted from app source files), so the
// server's copy is checked against the client, never against hand-typed hashes.
// Usage (from server/): node scripts/generate-ledger-hash-vectors.mjs <label>=<git-rev> ... > out.json
// Each source is read with `git show <rev>:app-v3/app.js`, so its provenance is the commit itself.
import { execFileSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";

export function extractFunction(source, name) {
  const start = source.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} not terminated`);
}

export function extractHasherSources(source) {
  return {
    canonical_source: extractFunction(source, "buildLedgerHashCanonicalString"),
    sha256_source: extractFunction(source, "sha256")
  };
}

export function hasherFromSources({ canonical_source: canonical, sha256_source: sha }) {
  // eslint-disable-next-line no-new-func
  return new Function("crypto", `${canonical}\n${sha}\nreturn { buildLedgerHashCanonicalString, sha256 };`)(webcrypto);
}

export function loadAppHasher(source) {
  return hasherFromSources(extractHasherSources(source));
}

export function appSourceAtRevision(rev, cwd = new URL("../..", import.meta.url).pathname) {
  return execFileSync("git", ["show", `${rev}:app-v3/app.js`], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export const VECTOR_INPUTS = [
  { name: "first sale", record: { transaction_type: "sale", normalized_label: "rice", amount_minor: 250000, currency: "NGN", counterparty: null, business_type_id: "ng_market_trader", country: "NG", source_account: null, destination_account: null, reversed_entry_hash: null, reversed_transaction_type: null }, id: 1, confirmed_at: 1793000000, prev_entry_hash: "0".repeat(64) },
  { name: "purchase with counterparty", record: { transaction_type: "purchase", normalized_label: "cement bags", amount_minor: 1800000, currency: "NGN", counterparty: "Alhaji Musa", business_type_id: "ng_building_supplies", country: "NG" }, id: 2, confirmed_at: 1793000100, prev_entry_hash: "a".repeat(64) },
  { name: "transfer between accounts", record: { transaction_type: "transfer", normalized_label: "move to savings", amount_minor: 500000, currency: "NGN", source_account: "cash", destination_account: "bank", business_type_id: "unlisted", country: "NG" }, id: 3, confirmed_at: 1793000200, prev_entry_hash: "b".repeat(64) },
  { name: "reversal", record: { transaction_type: "reversal", normalized_label: "rice", amount_minor: 250000, currency: "NGN", reversed_entry_hash: "c".repeat(64), reversed_transaction_type: "sale", country: "NG" }, id: 4, confirmed_at: 1793000300, prev_entry_hash: "c".repeat(64) },
  { name: "null versus empty string", record: { transaction_type: "receipt", normalized_label: "", amount_minor: 0, currency: "USD", counterparty: "", business_type_id: null, country: "US" }, id: 5, confirmed_at: 1793000400, prev_entry_hash: "d".repeat(64) },
  { name: "non-ASCII text", record: { transaction_type: "sale", normalized_label: "ƙwai da gishiri", amount_minor: 1234, currency: "NGN", counterparty: "Ɗan Kasuwa — ₦", country: "NG" }, id: 6, confirmed_at: 1793000500, prev_entry_hash: "e".repeat(64) },
  { name: "large amount", record: { transaction_type: "liability_in", normalized_label: "loan", amount_minor: 900719925474099, currency: "NGN", country: "NG" }, id: 7, confirmed_at: 1793000600, prev_entry_hash: "f".repeat(64) },
  { name: "missing optional fields", record: { transaction_type: "payment", normalized_label: "rent", amount_minor: 75000, currency: "GHS" }, id: 8, confirmed_at: 1793000700, prev_entry_hash: "1".repeat(64) },
  { name: "pipe collision A (known limitation)", record: { transaction_type: "sale", normalized_label: "a|b", amount_minor: 100, currency: "NGN", counterparty: "" }, id: 9, confirmed_at: 1793000800, prev_entry_hash: "2".repeat(64) },
  { name: "pipe collision B (known limitation)", record: { transaction_type: "sale|a", normalized_label: "b", amount_minor: 100, currency: "NGN", counterparty: "" }, id: 9, confirmed_at: 1793000800, prev_entry_hash: "2".repeat(64) }
];

async function main() {
  const revisions = process.argv.slice(2).map((arg) => {
    const [label, rev] = arg.split("=");
    return { label, rev };
  });
  const sources = [];
  const hashers = [];
  for (const { label, rev } of revisions) {
    const appSource = appSourceAtRevision(rev);
    const extracted = extractHasherSources(appSource);
    sources.push({ label, rev, app_js_sha256: sha256Hex(appSource), ...extracted });
    hashers.push({ label, hasher: hasherFromSources(extracted) });
  }
  const vectors = [];
  for (const input of VECTOR_INPUTS) {
    const results = [];
    for (const { label, hasher } of hashers) {
      const canonical = hasher.buildLedgerHashCanonicalString(input.record, input.id, input.confirmed_at, input.prev_entry_hash);
      results.push({ label, canonical, entry_hash: await hasher.sha256(canonical) });
    }
    const first = results[0];
    for (const other of results.slice(1)) {
      if (other.canonical !== first.canonical || other.entry_hash !== first.entry_hash) {
        throw new Error(`App versions disagree for "${input.name}": ${first.label} vs ${other.label}`);
      }
    }
    vectors.push({
      name: input.name,
      entry: { ...input.record, id: input.id, confirmed_at: input.confirmed_at, prev_entry_hash: input.prev_entry_hash },
      canonical: first.canonical,
      entry_hash: first.entry_hash
    });
  }
  process.stdout.write(`${JSON.stringify({ generated_from: hashers.map((h) => h.label), sources, vectors }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
