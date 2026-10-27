"""Build the alias review workbook: a generated VIEW of aliases.txt (inventory) and alias-review.csv (statuses).

usage: python3 build_aliases.py <types.json exported from catalog-data.js> <out.xlsx>

alias-review.csv is the only source of review statuses. This script reads it and never writes it.
Bring a marked-up workbook back with ingest_review.py. Ship approved rows with export.mjs.
"""
import collections, csv, json, sys
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

HERE = Path(__file__).parent
TYPES = {t["id"]: t for t in json.load(open(sys.argv[1]))}
OUT = Path(sys.argv[2])
if OUT.with_suffix(".csv").resolve() == (HERE / "alias-review.csv").resolve():
    sys.exit("refusing to write over alias-review.csv; choose another output name")
KINDS = {"synonym", "variant", "regional", "pidgin", "hausa", "brand"}
USED_IN = {"any", "NG", "US", "GH", "KE", "UG", "TZ", "ZA", "EA", "WA", "FR-WA"}
PLACE = {"GH": "Ghana", "KE": "Kenya", "UG": "Uganda", "TZ": "Tanzania", "ZA": "South Africa", "EA": "East Africa", "WA": "West Africa", "FR-WA": "francophone West Africa"}
sys.path.insert(0, str(HERE))
from aliastext import norm  # noqa: E402


def review_hint(kind, used_in, note):
    """Who needs to look at a row. A hint only; the review status comes from alias-review.csv."""
    if note.upper().startswith("REJECT"):
        return "recommend drop"
    if kind == "hausa":
        return "needs Muhammad"
    if kind == "pidgin":
        return "needs Pidgin check"
    if kind == "brand":
        return "decision D2"
    if used_in in PLACE:
        return f"needs local check ({PLACE[used_in]})"
    return "draft"


REVIEW_STATUSES = {"draft", "ok", "fix", "drop"}
reviews, errors = {}, []
with open(HERE / "alias-review.csv", encoding="utf-8", newline="") as f:
    for n, rec in enumerate(csv.DictReader(f), 2):
        key = (norm(rec["alias"]), rec["type_id"].strip())
        if rec["status"].strip() not in REVIEW_STATUSES:
            errors.append(f"alias-review.csv line {n}: bad status {rec['status']!r}")
        if key in reviews:
            errors.append(f"alias-review.csv line {n}: duplicate review for {rec['alias']!r} -> {rec['type_id']}")
        reviews[key] = rec

rows = []
for n, line in enumerate(open(HERE / "aliases.txt", encoding="utf-8"), 1):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    parts = [p.strip() for p in line.split("|")]
    if len(parts) != 5:
        errors.append(f"line {n}: expected 5 fields, got {len(parts)}")
        continue
    alias, type_id, kind, used_in, note = parts
    if type_id not in TYPES:
        errors.append(f"line {n}: unknown type {type_id}")
        continue
    if kind not in KINDS:
        errors.append(f"line {n}: bad kind {kind}")
    if used_in not in USED_IN:
        errors.append(f"line {n}: bad used_in {used_in}")
    if not 2 <= len(alias) <= 40:
        errors.append(f"line {n}: alias length {alias!r}")
    t = TYPES[type_id]
    if norm(alias) == norm(t["name"]):
        errors.append(f"line {n}: alias {alias!r} repeats the type name")
    rows.append(dict(alias=alias, normalised=norm(alias), type_id=type_id, type_name=t["name"], type_country=t["country"],
                     kind=kind, used_in=used_in, note=note, review_hint=review_hint(kind, used_in, note)))
    rec = reviews.get((norm(alias), type_id))
    rows[-1]["status"] = rec["status"].strip() if rec else "draft"
    rows[-1]["reviewer_notes"] = rec["notes"] if rec else ""

inventory_keys = {(r["normalised"], r["type_id"]) for r in rows}
errors += [f"alias-review.csv: {rec['alias']!r} -> {rec['type_id']} is not in aliases.txt"
           for key, rec in reviews.items() if key not in inventory_keys]

def eligible(row, region):
    """Pilot rule: selected country's types + GLOBAL; country-tagged aliases only there; no pan-African or pending brand terms."""
    if row["kind"] == "brand" or row["used_in"] in PLACE:
        return False
    if row["type_country"] not in (region, "GLOBAL"):
        return False
    return row["used_in"] in ("any", region)


for row in rows:
    if row["used_in"] in PLACE:
        row["scope"] = "future scope (pan-African)"
    elif row["kind"] == "brand":
        row["scope"] = "pending D2"
    else:
        where = [name for code, name in (("NG", "Nigeria"), ("US", "US"), ("GH", "other countries")) if eligible(row, code)]
        row["scope"] = "pilot-eligible: " + ", ".join(where)

dupes = collections.Counter((r["normalised"], r["type_id"]) for r in rows)
errors += [f"duplicate alias {a!r} for {t}" for (a, t), c in dupes.items() if c > 1]
if errors:
    print("VALIDATION FAILED"); print("\n".join(errors)); sys.exit(1)

# Shared aliases: same normalised alias -> several types; show what each region would see first.
by_alias = collections.defaultdict(list)
for r in rows:
    by_alias[r["normalised"]].append(r)
COUNTRY_LABEL = {"NG": "Nigeria", "US": "United States", "GLOBAL": "everywhere"}  # app labels other-country results


def ranked(targets, region):
    """Pilot: only eligible targets, own country first, then GLOBAL. Other-country types never appear."""
    ok = sorted((t for t in targets if eligible(t, region)), key=lambda t: 0 if t["type_country"] == region else 1)
    return " → ".join(t["type_name"] for t in ok) or "— (not searchable here in the pilot)"


shared = []
for key, targets in sorted(by_alias.items()):
    if len({t["type_id"] for t in targets}) > 1:
        shared.append([targets[0]["alias"], len(targets), ranked(targets, "NG"), ranked(targets, "US"), ranked(targets, "GH")])  # Kenya, Ghana etc. rank alike: no own types

pilot_rows, pilot_seen = [], set()
inventory = {(r["normalised"], r["type_id"]): r for r in rows}
for n, line in enumerate(open(HERE / "pilot_aliases.txt", encoding="utf-8"), 1):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    alias, type_id = [p.strip() for p in line.split("|")]
    src = inventory.get((norm(alias), type_id))
    if not src:
        errors.append(f"pilot line {n}: {alias!r} -> {type_id} is not in aliases.txt")
    elif not eligible(src, "NG"):
        errors.append(f"pilot line {n}: {alias!r} is not searchable in Nigeria under the pilot rule")
    elif (src["normalised"], type_id) in pilot_seen:
        errors.append(f"pilot line {n}: duplicate {alias!r}")
    else:
        pilot_seen.add((src["normalised"], type_id)); pilot_rows.append(src)
if errors:
    print("VALIDATION FAILED"); print("\n".join(errors)); sys.exit(1)

HELD = [
    ["POS / POS agent / POS operator", "POS type is held (R5): float and pass-through amounts need review", "Not listed → description"],
    ["mobile money / agent banking / momo", "same as POS", "Not listed → description"],
    ["bureau de change / BDC / mai canji", "money exchange: buy/sell of currency is not revenue/cost of goods as the app files it", "Not listed → description"],
    ["ajo / esusu / adashe / thrift collector", "collects other people's savings; pass-through", "Not listed → description"],
    ["susu collector (GH) / chama (KE) / stokvel (ZA)", "group savings: other people's money passing through", "Not listed → description"],
    ["M-Pesa agent / MoMo agent", "mobile money agents: same as POS (held)", "Not listed → description"],
    ["loan / money lender", "lending is a liability/asset flow, not sales", "Not listed → description"],
    ["CAC / JAMB / WAEC / NIN as SALE shortcuts", "kept out of shortcuts in Part 1; only offered as search aids (D5)", "—"],
]

DECISIONS = [
    ["D1", "Scope: aliases cover the 26 live types (23 from 4f90cfb + 3 Part 1 GLOBAL types). Plan draft 3 said 30 + 3; that count predates R7. Pilot localisation: Nigerian English, Pidgin and Hausa. Pan-African terms and other languages are future scope.", "Accept."],
    ["D2", "Brand names (Bolt, Uber, DoorDash, Jumia, Instagram, WhatsApp, YouTube) as aliases. People do say 'Bolt driver'. Risk: trademark use in UI is minimal because aliases are never shown as names, only matched.", "Allow as hidden search aids, never displayed."],
    ["D3", "Nigeria has no beauty type, so 'salon', 'barber', 'hairdresser' point to NG Service Provider, then GLOBAL Personal / Professional. US Beauty Services is not shown in Nigeria (pilot rule).", "Accept for now; a NG beauty type is a later catalog decision."],
    ["D4", "'printing press' (industrial printing, ISIC 1811) maps to Document & Print Services.", "Keep as aid; their shortcuts fit well enough."],
    ["D5", "'JAMB registration', 'CAC registration' as search aids for Document & Print. They find the right business; they do not add a shortcut, so no pass-through amounts are created.", "Keep."],
    ["D6", "'Islamiyya teacher' / 'Arabic teacher' → Tutoring / Lessons. Many are paid monthly by parents, which fits.", "Your call."],
    ["D7", "Generic words ('shop', 'store', 'seller', 'driver', 'services', 'delivery') point only to GLOBAL types so they never push a narrow type to the top.", "Accept."],
    ["D9", "Second-hand clothes ('okrika', 'bend down select', 'mitumba'): Nigerian words point to Fashion / Tailor (which sells ready-to-wear); the generic and East African words point to Retail / Trading.", "Accept; revisit if a used-goods type is added."],
    ["D10", "There is no GLOBAL fashion/tailor type, so in the pilot 'tailor' outside Nigeria finds only Personal / Professional Services. Adding a GLOBAL tailoring type is a catalog decision for later.", "Accept for now; flag a GLOBAL tailoring type."],
    ["D11", "Pan-African regional words are in English-script loanword form only (trotro, matatu, boda boda, spaza, duka, fundi). FUTURE SCOPE: not searchable in the pilot. Kept as inventory for a separately approved expansion.", "Keep in workbook; do not import."],
    ["D8", "Normalisation for search: lower-case, strip accents, map ɓ ɗ ƙ ƴ → b d k y, drop apostrophes, punctuation → space. Hooked letters do not decompose under Unicode NFD, so they need the explicit map. Part 2 test 3 should use 'ɗan kasuwa'.", "Accept; update test 3 wording."],
]

wb = Workbook()
head, fill = Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor="1F4E46")


def sheet(ws, header, data, widths):
    ws.append(header)
    for c in ws[1]:
        c.font, c.fill = head, fill
        c.alignment = Alignment(vertical="center", wrap_text=True)
    for r in data:
        ws.append(r)
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "B2"
    ws.auto_filter.ref = ws.dimensions


kinds = collections.Counter(r["kind"] for r in rows)
statuses = collections.Counter(r["status"] for r in rows)
readme = wb.active; readme.title = "README"
for line in [
    "Konfirmata business search aliases — DRAFT 2 for review (2026-10-26; supersedes draft 1)",
    "",
    "What this is: extra words people might type to find a business type in the Part 2 search screen.",
    "",
    "PILOT RULE (Muhammad, 2026-10-26; see 2026-10-26-business-picker-pilot-country-scope.md):",
    "  users see and search only their selected country's types plus GLOBAL types. An alias tagged for one country is",
    "  searched only there; an 'any' alias wherever its GLOBAL type is shown. 'My business isn't listed' always stays.",
    f"  START HERE: the 'Nigeria pilot set' sheet ({len(pilot_rows)} Nigerian English, Pidgin and Hausa words). You do not need to review all rows before the pilot.",
    "  The full Aliases sheet is the longer-term inventory. Pan-African regional terms there are FUTURE SCOPE, not pilot behaviour.",
    "Aliases are search aids only. They are never shown as a business name, never auto-select, and never change shortcuts or statements.",
    f"Aliases: {len(rows)}  |  business types covered: {len({r['type_id'] for r in rows})} of {len(TYPES)}  |  shared by more than one type: {len(shared)}",
    "By kind: " + ", ".join(f"{k} {v}" for k, v in sorted(kinds.items())),
    "By status: " + ", ".join(f"{k} {v}" for k, v in sorted(statuses.items())),
    "Every alias was checked against the live catalog (commit 5f8307d): the type exists, no duplicates, no alias that just repeats the type name.",
    "",
    "How to review (Aliases sheet):",
    "  1. status: change to 'ok', 'fix' or 'drop' (only these and 'draft' are accepted); put details in reviewer_notes.",
    "  2. review_hint says who should look: Hausa rows 'needs Muhammad', Pidgin rows 'needs Pidgin check',",
    "     other African regional words 'needs local check (country)'. Fix spellings in reviewer_notes.",
    "  3. Send the workbook back; ingest_review.py copies your statuses into alias-review.csv (the record of truth).",
    "  Only rows marked 'ok' that pass the pilot rule are shipped to the app.",
    "",
    "Shared aliases sheet: words that point to more than one type, and what each country would see under the pilot rule.",
    "Held out sheet: words deliberately left without an alias; searching them shows 'My business isn't listed'.",
    "Later languages sheet: languages flagged for further development, not in this draft.",
    "Decisions sheet: D1–D11, each with a recommendation.",
]:
    readme.append([line])
readme.column_dimensions["A"].width = 140
readme["A1"].font = Font(bold=True, size=14)

pkinds = collections.Counter(r["kind"] for r in pilot_rows)
pcols = ["alias", "type_name", "type_id", "kind", "note", "review_hint", "status", "reviewer_notes"]
ps = wb.create_sheet("Nigeria pilot set")
sheet(ps, pcols, [[r[c] for c in pcols] for r in pilot_rows], [24, 30, 30, 10, 60, 22, 10, 30])

cols = ["alias", "normalised", "type_id", "type_name", "type_country", "kind", "used_in", "scope", "note", "review_hint", "status", "reviewer_notes"]
sheet(wb.create_sheet("Aliases"), cols, [[r[c] for c in cols] for r in rows], [26, 24, 32, 30, 10, 10, 8, 30, 60, 22, 10, 30])
sheet(wb.create_sheet("Shared aliases"), ["alias", "types", "Nigeria sees", "US sees", "other countries see (GLOBAL only)"], shared, [22, 7, 70, 70, 70])
sheet(wb.create_sheet("Held out"), ["search words", "why no alias", "what the user sees"], HELD, [44, 80, 28])
LATER = [
    ["Yoruba", "Nigeria (SW), Benin", "native reviewer", "Latin script; tonal marks (ẹ ọ ṣ) need normalisation like Hausa hooked letters"],
    ["Igbo", "Nigeria (SE)", "native reviewer", "Latin script; dotted vowels (ị ọ ụ) need normalisation"],
    ["Fulfulde, Kanuri, Tiv, Ijaw, Efik/Ibibio, Edo, Nupe", "Nigeria", "native reviewers", "Latin script"],
    ["Twi / Akan, Ewe, Ga", "Ghana", "native reviewers", "Latin script (ɛ ɔ need normalisation)"],
    ["Swahili", "Kenya, Tanzania, Uganda, DRC (east)", "native reviewer", "Latin script; widely used loanwords already in draft 2 as regional English"],
    ["French", "francophone West & Central Africa", "fluent reviewer", "needs translated type names too, not just aliases"],
    ["Wolof", "Senegal, Gambia", "native reviewer", "Latin script"],
    ["Portuguese", "Angola, Mozambique", "fluent reviewer", "needs translated type names too"],
    ["Amharic", "Ethiopia", "native reviewer", "Ge'ez script: search normalisation and fuzzy matching must be designed for it"],
    ["Arabic", "North Africa, Sahel, Sudan", "fluent reviewer", "Arabic script, right-to-left: needs UI and search work"],
    ["isiZulu, isiXhosa, Sesotho, Setswana", "South Africa, Lesotho, Botswana", "native reviewers", "Latin script"],
    ["Hausa (Ajami script)", "Nigeria, Niger", "Muhammad", "Arabic-script Hausa: separate search design"],
]
sheet(wb.create_sheet("Later languages"), ["language", "where", "who reviews", "notes"], LATER, [40, 36, 20, 80])
sheet(wb.create_sheet("Decisions"), ["id", "question", "recommendation"], DECISIONS, [6, 120, 50])
for ws in wb.worksheets[1:]:
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.alignment = Alignment(wrap_text=True, vertical="top")

wb.save(OUT)
with open(OUT.with_suffix(".csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(cols); [w.writerow([r[c] for c in cols]) for r in rows]
print(f"OK aliases={len(rows)} types={len({r['type_id'] for r in rows})}/{len(TYPES)} shared={len(shared)}")
print("kinds", dict(kinds)); print("status", dict(statuses))
print(f"pilot={len(pilot_rows)}", dict(pkinds)); print("scope", dict(collections.Counter(r["scope"] for r in rows)))
