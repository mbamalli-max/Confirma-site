"""Bring statuses from a marked-up review workbook back into alias-review.csv (the record of truth).

usage: python3 ingest_review.py <workbook.xlsx> [--reviewer NAME] [--review alias-review.csv] [--write]

Reads the "Nigeria pilot set" and "Aliases" sheets. Prints every change; writes only with --write.
Rows whose status is still "draft" and that have no review entry are left out of the file.
"""
import argparse, csv, datetime, sys
from pathlib import Path
from openpyxl import load_workbook

sys.path.insert(0, str(Path(__file__).parent))
from aliastext import norm  # noqa: E402

HERE = Path(__file__).parent
REVIEW = HERE / "alias-review.csv"
FIELDS = ["alias", "type_id", "status", "reviewer", "reviewed_on", "notes"]
STATUSES = {"draft", "ok", "fix", "drop"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workbook")
    ap.add_argument("--reviewer", default="Muhammad")
    ap.add_argument("--review", default=str(REVIEW), help="review file to update (default: alias-review.csv)")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()
    review_path = Path(args.review)

    with open(review_path, encoding="utf-8", newline="") as f:
        current = list(csv.DictReader(f))
    by_key = {(norm(r["alias"]), r["type_id"]): r for r in current}

    wb = load_workbook(args.workbook, read_only=True)
    marked, errors = {}, []
    for sheet in ("Nigeria pilot set", "Aliases"):
        rows = wb[sheet].iter_rows(values_only=True)
        header = [str(h or "").strip() for h in next(rows)]
        col = {name: header.index(name) for name in ("alias", "type_id", "status", "reviewer_notes")}
        for n, row in enumerate(rows, 2):
            alias = str(row[col["alias"]] or "").strip()
            if not alias:
                continue
            type_id = str(row[col["type_id"]] or "").strip()
            status = str(row[col["status"]] or "draft").strip().lower()
            notes = str(row[col["reviewer_notes"]] or "").strip()
            if status not in STATUSES:
                errors.append(f"{sheet} row {n}: {alias!r} has status {status!r} (use ok, fix, drop or draft)")
                continue
            key = (norm(alias), type_id)
            if key in marked and marked[key][1:] != (status, notes):
                errors.append(f"{sheet} row {n}: {alias!r} is marked differently on another sheet")
                continue
            marked[key] = (alias, status, notes)
    if errors:
        print("NOT INGESTED"); print("\n".join(errors)); sys.exit(1)

    today = datetime.date.today().isoformat()
    changes = []
    for key, (alias, status, notes) in sorted(marked.items()):
        existing = by_key.get(key)
        if existing is None:
            if status == "draft" and not notes:
                continue
            existing = {"alias": alias, "type_id": key[1], "status": "draft", "reviewer": "", "reviewed_on": "", "notes": ""}
            current.append(existing); by_key[key] = existing
        if (existing["status"], existing["notes"]) != (status, notes):
            changes.append(f"{alias} -> {key[1]}: {existing['status']} -> {status}" + (f"  [{notes}]" if notes else ""))
            existing.update(status=status, notes=notes, reviewer=args.reviewer, reviewed_on=today)

    print("\n".join(changes) or "no changes")
    print(f"{len(changes)} change(s)")
    if args.write and changes:
        with open(review_path, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
            w.writeheader(); w.writerows(current)
        print(f"wrote {review_path.name}")
    elif changes:
        print("dry run: add --write to save")


if __name__ == "__main__":
    main()
