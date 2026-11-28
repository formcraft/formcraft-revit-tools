# Compare two runs of the same model (e.g. frame3d "...L" vs Robot): member forces and drift, to validate the solver.
#   python -I scripts/structure/compare-runs.py <runs dir> <run A> <run B>
import json, sys, statistics
D, A, B = sys.argv[1].rstrip("/\\") + "/", sys.argv[2], sys.argv[3]
ra, rb = (json.load(open(D + r + "_results.json")) for r in (A, B))
ka = {b["id"]: b for b in json.load(open(D + A + ".json"))["bars"]}
ba, bb = {b["n"]: b for b in ra["bars"]}, {b["n"]: b for b in rb["bars"]}
rows = []
for n, x in ba.items():
    y = bb.get(n)
    if not y or ka.get(x["id"], {}).get("kind") == "strut": continue
    for k in ("ned_kn", "med_knm"):
        if max(x[k], y[k]) > 5: rows.append((k, x[k], y[k], (y[k] - x[k]) / max(x[k], y[k])))
for k in ("ned_kn", "med_knm"):
    dif = [r[3] for r in rows if r[0] == k]
    if dif: print(k, "members", len(dif), "median diff %.1f%%" % (100 * statistics.median(dif)), "within 10%%: %d%%" % (100 * sum(abs(v) <= 0.10 for v in dif) / len(dif)), "worst %.0f%%" % (100 * max(dif, key=abs)))
da = {n["node"]: max(n["ux_mm"], n["uy_mm"]) for n in ra.get("nodes", [])}; db = {n["node"]: max(n["ux_mm"], n["uy_mm"]) for n in rb.get("nodes", [])}
if da and db: print("max horizontal displacement A %.1f mm, B %.1f mm" % (max(da.values()), max(db.values())))
