# Unit rates from the price book: FMC_Price_Book.csv (prices, low / likely / high) x FMC_Rate_Buildups.json (what goes
# into one unit of work) -> FMC_Rates.json (low / likely / high per rate, with the build-up behind each number).
# Change a price in the price book, run this, then the packages and reports (scripts/cost/update.cmd does all three).
#   python -I scripts/cost/rates.py <kit 07_Materials dir>
import csv, json, sys, os, datetime
D = sys.argv[1]
book = {r["key"]: r for r in csv.DictReader(open(os.path.join(D, "FMC_Price_Book.csv"), encoding="utf-8-sig")) if r.get("key")}
bu = {k: v for k, v in json.load(open(os.path.join(D, "FMC_Rate_Buildups.json"), encoding="utf-8")).items() if not k.startswith("_")}
num = lambda s: float(str(s).replace(",", "").strip() or "nan")
out, problems, done = {}, [], {}

def rate(key, stack=()):
    if key in done: return done[key]
    if key in stack: raise ValueError(f"build-up loop: {' -> '.join(stack + (key,))}")
    b = bu[key]; w = 1 + b.get("waste_pct", 0) / 100; tot = [0.0, 0.0, 0.0]; lines = []
    for part, mult in (("materials", w), ("plant", 1), ("labour", 1)):
        for pk, q in b.get(part, {}).items():
            p = book.get(pk)
            if not p: problems.append(f"{key}: no price '{pk}' in the price book"); continue
            v = [num(p["low"]), num(p["likely"]), num(p["high"])]
            if any(x != x for x in v): problems.append(f"{key}: '{pk}' has no price"); continue
            for i in range(3): tot[i] += q * mult * v[i]
            lines.append({"part": part, "item": pk, "qty": q, "unit": p["unit"], "price_likely": v[1], "status": p["status"], "date": p["date"]})
    for rk, q in b.get("rates", {}).items():
        sub = rate(rk, stack + (key,))
        for i in range(3): tot[i] += q * sub["rate"][i]
        lines.append({"part": "rate", "item": rk, "qty": q, "unit": sub["unit"], "price_likely": sub["rate"][1]})
    statuses = {l.get("status") for l in lines if l.get("status")}
    r = {"label": b.get("label", key), "unit": b["unit"], "rate": [round(x, 4 if b["unit"] == "fraction" else 0) for x in tot],
         "basis": "assumed prices in the build-up" if "assumed" in statuses else "market prices", "buildup": lines}
    done[key] = r; return r

for k in bu:
    try: out[k] = rate(k)
    except (ValueError, KeyError) as ex: problems.append(str(ex))
res = {"_generated": datetime.datetime.now().isoformat(timespec="seconds"), "_from": ["FMC_Price_Book.csv", "FMC_Rate_Buildups.json"],
       "_problems": problems, **out}
json.dump(res, open(os.path.join(D, "FMC_Rates.json"), "w", encoding="utf-8"), indent=1)
# the price book as a hash table (key -> record) for direct lookup by every script and the plugin
idx = {k: {"item": r["item"], "unit": r["unit"], "low": num(r["low"]), "likely": num(r["likely"]), "high": num(r["high"]), "date": r["date"],
           "source": r["source"], "status": r["status"]} for k, r in book.items()}
json.dump({"_generated": res["_generated"], **idx}, open(os.path.join(D, "FMC_Price_Index.json"), "w", encoding="utf-8"), indent=1)
for k in ("concrete", "steel", "formwork", "wall_stone", "wall_block", "roof_cover", "fence_m"):
    if k in out: print(f"{k:12s} {out[k]['rate'][1]:>12,.0f} UGX/{out[k]['unit']}  ({out[k]['rate'][0]:,.0f}-{out[k]['rate'][2]:,.0f})  {out[k]['basis']}")
print(len(out), "rates;", len(problems), "problems", problems[:5])
