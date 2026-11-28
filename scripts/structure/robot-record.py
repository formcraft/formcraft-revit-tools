# Record an independent Robot check in the project config (config.robot_check), from a Robot run and the local run it
# was compared with (compare-runs.py figures), so the reports show it against the current design.
#   python -I scripts/structure/robot-record.py <work dir> <runs dir> <robot run> <local run>
import json, sys, statistics
W, O, RB, LA = sys.argv[1:5]
J = lambda p: json.load(open(p, encoding="utf-8"))
ra, rb = J(f"{O}/{LA}_results.json"), J(f"{O}/{RB}_results.json")
kind = {b["id"]: b["kind"] for b in J(f"{O}/{LA}.json")["bars"]}
ba, bb = {b["n"]: b for b in ra["bars"]}, {b["n"]: b for b in rb["bars"]}
diff = {k: [] for k in ("ned_kn", "med_knm")}
for n, x in ba.items():
    y = bb.get(n)
    if not y or kind.get(x["id"]) == "strut": continue
    for k in diff:
        if max(x[k], y[k]) > 5: diff[k].append((y[k] - x[k]) / max(x[k], y[k]))
dmax = lambda r: max(max(n["ux_mm"], n["uy_mm"]) for n in r.get("nodes", [])) if r.get("nodes") else None
c = J(W + "/config.json")
c["robot_check"] = {"run": RB, "compared_with": LA, "run_after": open(W + "/last_run.txt").read().strip(), "calculated": True,
                    "members": len(diff["ned_kn"]), "median_diff_pct": {k: round(100 * statistics.median(v), 1) for k, v in diff.items() if v},
                    "max_sway_mm": {"robot": dmax(rb), "local": dmax(ra)}}
json.dump(c, open(W + "/config.json", "w"))
print(json.dumps(c["robot_check"]))
