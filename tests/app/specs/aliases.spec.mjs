import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { BUSINESS_TYPES } from "../../../app-v3/catalog-data.js";
import { BUSINESS_ALIASES } from "../../../app-v3/business-aliases.js";
import { normalizeSearchText } from "../../../app-v3/business-text.js";
import {
  DEFAULT_PATHS,
  buildAliasExport,
  checkShippedEntries,
  parseInventory
} from "../../../tools/business-aliases/export.mjs";

const TOOLS = fileURLToPath(new URL("../../../tools/business-aliases/", import.meta.url));
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const scratch = () => mkdtempSync(path.join(tmpdir(), "aliases-spec-"));

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { code: result.status, out: `${result.stdout}\n${result.stderr}` };
}

function typesJson(dir) {
  const file = path.join(dir, "types.json");
  writeFileSync(file, JSON.stringify(BUSINESS_TYPES.map((t) => ({ id: t.id, country: t.country, name: t.name, sector: t.sector_id }))));
  return file;
}

const INVENTORY = [
  "business centre | global_document_services | regional | NG |",
  "cyber cafe | global_document_services | regional | any |",
  "okada | ng_okada_keke_rider | regional | NG |",
  "trotro | global_transport_logistics | regional | GH |",
  "bolt driver | ng_transport_worker | brand | NG |",
  "corner shop | us_retail | synonym | NG |",
  "store | us_retail | synonym | US |"
].join("\n");
const review = (rows) => ["alias,type_id,status,reviewer,reviewed_on,notes", ...rows].join("\n");

test("A1: rebuilding the workbook never rewrites the review file, and ingest writes only when told", () => {
  const dir = scratch();
  const before = sha(DEFAULT_PATHS.review);
  const built = run("python3", [path.join(TOOLS, "build_aliases.py"), typesJson(dir), path.join(dir, "view.xlsx")]);
  expect(built.code, built.out).toBe(0);
  const dryRun = run("python3", [path.join(TOOLS, "ingest_review.py"), path.join(dir, "view.xlsx")]);
  expect(dryRun.code, dryRun.out).toBe(0);
  expect(dryRun.out).toContain("no changes");
  expect(run("node", [path.join(TOOLS, "export.mjs"), "--check"]).code).toBe(0);
  expect(sha(DEFAULT_PATHS.review), "alias-review.csv is byte-identical after rebuild, ingest dry run and check").toBe(before);

  // Mark one pilot row "ok" in a copy of the workbook and ingest it into a copy of the review file.
  const marked = path.join(dir, "marked.xlsx");
  const edit = run("python3", ["-c", `
import sys
from openpyxl import load_workbook
wb = load_workbook(sys.argv[1])
for name in ("Nigeria pilot set", "Aliases"):
    ws = wb[name]
    header = [c.value for c in ws[1]]
    for row in ws.iter_rows(min_row=2):
        if row[header.index("alias")].value == "business centre":
            row[header.index("status")].value = "ok"
            row[header.index("reviewer_notes")].value = "checked"
wb.save(sys.argv[2])
`, path.join(dir, "view.xlsx"), marked]);
  expect(edit.code, edit.out).toBe(0);
  const reviewCopy = path.join(dir, "alias-review.csv");
  copyFileSync(DEFAULT_PATHS.review, reviewCopy);
  const notWritten = run("python3", [path.join(TOOLS, "ingest_review.py"), marked, "--review", reviewCopy]);
  expect(notWritten.out).toContain("business centre -> global_document_services: draft -> ok");
  expect(sha(reviewCopy), "a dry run does not write").toBe(before);
  const written = run("python3", [path.join(TOOLS, "ingest_review.py"), marked, "--review", reviewCopy, "--write"]);
  expect(written.code, written.out).toBe(0);
  const lines = readFileSync(reviewCopy, "utf8").split("\n");
  expect(lines.find((line) => line.startsWith("business centre,"))).toMatch(/^business centre,global_document_services,ok,Muhammad,\d{4}-\d{2}-\d{2},checked$/);
  expect(lines.filter((line) => /,ok,/.test(line))).toHaveLength(1);
  expect(sha(DEFAULT_PATHS.review), "the real review file is untouched").toBe(before);
});

test("A2: only 'ok' rows that pass the pilot rule are shipped", () => {
  const { entries, errors } = buildAliasExport({
    inventoryText: INVENTORY,
    reviewText: review([
      "business centre,global_document_services,ok,Muhammad,2026-10-26,",
      "cyber cafe,global_document_services,draft,,,",
      "okada,ng_okada_keke_rider,fix,Muhammad,2026-10-26,spelling"
    ])
  });
  expect(errors).toEqual([]);
  expect(entries).toEqual([
    { alias: "business centre", normalised: "business centre", type_id: "global_document_services", used_in: "NG" }
  ]);

  for (const [row, reason] of [
    ["trotro,global_transport_logistics,ok,,,", /future scope/],
    ["bolt driver,ng_transport_worker,ok,,,", /D2/],
    ["corner shop,us_retail,ok,,,", /tagged for NG but the type belongs to US/],
    ["photocopy,global_document_services,ok,,,", /not in aliases\.txt/],
    ["okada,ng_okada_keke_rider,approved,,,", /bad status/]
  ]) {
    const refused = buildAliasExport({ inventoryText: INVENTORY, reviewText: review([row]) });
    expect(refused.entries, row).toEqual([]);
    expect(refused.errors.join("\n"), row).toMatch(reason);
  }

  // A hand-edited shipped list holding an unapproved row fails the independent check.
  const tampered = checkShippedEntries(
    [{ alias: "cyber cafe", normalised: "cyber cafe", type_id: "global_document_services", used_in: "any" }],
    { inventoryText: INVENTORY, reviewText: review(["cyber cafe,global_document_services,draft,,,"]) }
  );
  expect(tampered.join("\n")).toMatch(/without an "ok" review \(status draft\)/);

  // The real shipped file is in step with the real review file.
  const check = run("node", [path.join(TOOLS, "export.mjs"), "--check"]);
  expect(check.code, check.out).toBe(0);
});

test("A3: shipped entries are valid, and the real list matches its review", () => {
  const inventoryText = readFileSync(DEFAULT_PATHS.inventory, "utf8");
  const reviewText = readFileSync(DEFAULT_PATHS.review, "utf8");
  expect(checkShippedEntries(BUSINESS_ALIASES, { inventoryText, reviewText })).toEqual([]);
  const typeIds = new Set(BUSINESS_TYPES.map((item) => item.id));
  for (const entry of BUSINESS_ALIASES) expect(typeIds.has(entry.type_id), entry.type_id).toBe(true);

  const okReview = review(["business centre,global_document_services,ok,,,", "okada,ng_okada_keke_rider,ok,,,"]);
  const good = { alias: "business centre", normalised: "business centre", type_id: "global_document_services", used_in: "NG" };
  const problems = checkShippedEntries([
    good,
    { ...good, alias: "Business  Centre" },
    { alias: "okada", normalised: "okada", type_id: "ng_okada_keke_rider", used_in: "any" },
    { alias: "okada", normalised: "OKADA", type_id: "ng_okada_keke_rider", used_in: "NG" },
    { alias: "store", normalised: "store", type_id: "us_retail", used_in: "US" },
    { alias: "ghost", normalised: "ghost", type_id: "ng_ghost_type", used_in: "NG" }
  ], { inventoryText: INVENTORY, reviewText: okReview }).join("\n");
  expect(problems).toMatch(/Business {2}Centre -> global_document_services: shipped twice/);
  expect(problems).toMatch(/okada -> ng_okada_keke_rider: country tag any does not match the inventory \(NG\)/);
  expect(problems).toMatch(/normalised text is wrong/);
  expect(problems).toMatch(/store -> us_retail: shipped without an "ok" review/);
  expect(problems).toMatch(/ghost -> ng_ghost_type: .*not in aliases\.txt/s);
});

test("normalisation: Hausa hooked letters, accents and punctuation; the Python tools and the app agree", () => {
  expect(normalizeSearchText("ɗan kasuwa")).toBe("dan kasuwa");
  expect(normalizeSearchText("ƊAN KASUWA")).toBe("dan kasuwa");
  expect(normalizeSearchText("'Yar Kasuwa")).toBe("yar kasuwa");
  expect(normalizeSearchText("ƙofa ɓera ƴaƴa")).toBe("kofa bera yaya");
  expect(normalizeSearchText("Café  /  Bar")).toBe("cafe bar");
  expect(normalizeSearchText("e-commerce")).toBe("e commerce");

  const aliases = parseInventory(readFileSync(DEFAULT_PATHS.inventory, "utf8")).map((row) => row.alias);
  const result = spawnSync("python3", ["-c", `
import json, sys
sys.path.insert(0, sys.argv[1])
from aliastext import norm
print(json.dumps([norm(a) for a in json.load(sys.stdin)]))
`, TOOLS], { input: JSON.stringify(aliases), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(aliases.map(normalizeSearchText));
});
