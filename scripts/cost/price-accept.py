# Take a reviewed price into the price book; the old row goes to FMC_Price_History.csv (nothing is lost).
#   python -I scripts/cost/price-accept.py <kit 07_Materials dir> <key> <low> <likely> <high> --source "<name / url>" [--unit "<unit>"] [--status market|quote|secondary|assumed] [--note "..."]
# Then run scripts/cost/update.cmd to recalculate every rate, package and report.
import csv, sys, os, datetime
D, key, lo, li, hi, *rest = sys.argv[1:]
opt = lambda n, d=None: rest[rest.index(n) + 1] if n in rest else d
src, unit, status, note = opt("--source", ""), opt("--unit"), opt("--status", "market"), opt("--note")
if not src: sys.exit("--source is required: every price says where it came from")
bf, hf = os.path.join(D, "FMC_Price_Book.csv"), os.path.join(D, "FMC_Price_History.csv")
rows = list(csv.DictReader(open(bf, encoding="utf-8-sig"))); fields = list(rows[0].keys())
hit = next((r for r in rows if r["key"] == key), None)
if not hit: sys.exit(f"{key} isn't in the price book: add its row first (key,item,unit,...)")
new_h = not os.path.exists(hf)
with open(hf, "a", newline="", encoding="utf-8") as h:
    w = csv.writer(h)
    if new_h: w.writerow(["replaced_on"] + fields)
    w.writerow([datetime.date.today().isoformat()] + [hit[f] for f in fields])
hit.update({"low": lo, "likely": li, "high": hi, "date": datetime.date.today().isoformat(), "source": src, "status": status})
if unit: hit["unit"] = unit
if note: hit["notes"] = note
with open(bf, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(rows)
print(f"{key}: {lo} / {li} / {hi} per {hit['unit']} ({status}, {src}); old row kept in FMC_Price_History.csv")
