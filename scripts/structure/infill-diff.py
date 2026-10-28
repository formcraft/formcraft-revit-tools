# The structural walls register (infill.json, written by robot-run.mjs) compared with the last update's, and with the
# architect's walls now: a structural wall removed, made thinner, or with openings grown past 30% is the change the
# engineer must see first. Keeps infill.prev.json as the baseline for next time.
#   python -I scripts/structure/infill-diff.py <work dir>
import json, os, sys, shutil
W = sys.argv[1]
J = lambda p: json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None
now, prev, facts = J(W + "/infill.json") or [], J(W + "/infill.prev.json"), J(W + "/facts.json") or {}
key = lambda p: tuple(sorted(p["cols"])) + (p["z"][0],)
N = {key(p): p for p in now}; P = {key(p): p for p in (prev or [])}
walls = {w["id"] for w in facts.get("walls", [])}
st = [p for p in now if p["structural"]]
print(f"{len(st)} structural wall panels, {len(now) - len(st)} more with openings over 30% (not counted)")
if prev is not None:
    for k, p in P.items():
        q = N.get(k)
        if p["structural"] and not q: print(f"REMOVED: the structural wall between columns {p['cols']} at z {p['z'][0]} is gone")
        elif p["structural"] and not q["structural"]: print(f"WEAKENED: wall between {p['cols']}: openings {p['openings_pct']}% -> {q['openings_pct']}% (over 30%, no longer counted)")
        elif q and q["thickness_mm"] < p["thickness_mm"]: print(f"THINNER: wall between {p['cols']}: {p['thickness_mm']} -> {q['thickness_mm']} mm")
    for k, q in N.items():
        if q["structural"] and not (P.get(k) or {}).get("structural"): print(f"NEW: wall between {q['cols']} now counted as structure")
gone = [p for p in st if walls and not set(p["walls"]) & walls]
for p in gone: print(f"MISSING IN MODEL: walls {p['walls']} (structural) no longer in the architect's model")
if os.path.exists(W + "/infill.json"): shutil.copy(W + "/infill.json", W + "/infill.prev.json")
