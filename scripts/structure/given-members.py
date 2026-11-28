# The architect's own structural columns (RC, from facts.json) that the wall-based frame planner does not see (Ogala:
# the entrance portico's three Ø340 RC columns and its RC beam carrying the first-floor balcony): columns, pads, the beam
# on their line and tie beams back to the nearest frame column, as fmc_model_edit ops in the plan's op format.
#   python -I scripts/structure/given-members.py <work dir>     -> <work dir>/extra.json
# Apply with revit-edit.mjs extra.json apply (its reply extra.out.json gives the ids); robot-run, rc-design,
# revit-apply and drawings read extra.json + extra.out.json beside plan.json + build.out.json.
import json, math, sys, os
W = sys.argv[1]
facts = json.load(open(W + "/facts.json")); plan = json.load(open(W + "/plan.json", encoding="utf-8"))
cfg = json.load(open(W + "/config.json")) if os.path.exists(W + "/config.json") else {}
EX = set(cfg.get("exclude_levels", ["BQ GF +0.17", "BQ FF +3.15"])); EL = {l["name"]: l["elevation_mm"] for l in facts["levels"]}
PAD = [l for l in plan["ops"] if l["op"] == "level" and l["name"].startswith("S Pad")][0]["name"]
frame_cols = plan["plan"]["columns"]
given = [c for c in facts.get("columns", []) + facts.get("arch_columns", [])
         if c.get("at_mm") and c["level"] not in EX and re.search(r"\bRC\b|concrete", (c.get("type") or "") + " " + (c.get("material") or ""), re.I)] if (re := __import__("re")) else []
given = list({(round(c["at_mm"][0]), round(c["at_mm"][1])): c for c in given}.values())
# the top: the level just above the architect's beams that sit on them (else the first floor)
beams_arch = [b for b in facts.get("framing", []) if b.get("start_mm") and re.search(r"\bRC\b|concrete", (b.get("type") or "") + (b.get("material") or ""), re.I)]
near_frame = lambda p: min(((math.dist(p, c["at_mm"][:2]), c) for c in frame_cols), key=lambda t: t[0])
given = [c for c in given if near_frame(c["at_mm"][:2])[0] < cfg.get("given_max_offset_mm", 4000)]
ops = []
levels_up = sorted(EL.items(), key=lambda x: x[1])
def seg_dist(p, a, b):
    ax, ay, bx, by = a[0], a[1], b[0], b[1]; L2 = (bx - ax) ** 2 + (by - ay) ** 2 or 1
    u = max(0, min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / L2))
    return math.dist(p, (ax + u * (bx - ax), ay + u * (by - ay)))
def top_for(c):
    zs = [b["start_mm"][2] for b in beams_arch if seg_dist(c["at_mm"][:2], b["start_mm"], b["end_mm"]) < 300]
    z = max(zs) if zs else EL.get("FF +3.85", 3850)
    return next(n for n, e in levels_up if e >= z - 300 and not n.startswith("S Pad") and n not in EX)
if given:
    tops = {id(c): top_for(c) for c in given}
    for c in given:
        ops.append({"op": "column", "type_name": "300 x 450mm", "level": PAD, "top_level": tops[id(c)], "points_mm": [[round(c["at_mm"][0]), round(c["at_mm"][1])]], "size_mm": [300, 300], "_given": c["id"]})
    # the beam along their line (consecutive columns), at their top level
    line = sorted(given, key=lambda c: (c["at_mm"][0], c["at_mm"][1]))
    for a, b in zip(line, line[1:]):
        if tops[id(a)] == tops[id(b)] and math.dist(a["at_mm"][:2], b["at_mm"][:2]) < 7000:
            ops.append({"op": "beam", "type_name": "300 x 600mm", "level": tops[id(a)], "start_mm": [round(a["at_mm"][0]), round(a["at_mm"][1]), 0], "end_mm": [round(b["at_mm"][0]), round(b["at_mm"][1]), 0], "size_mm": [230, 400]})
    # tie beams to the nearest frame column reaching the same level, and ground beams under them
    for c in given:
        cand = [f for f in frame_cols if f["top"] == tops[id(c)] or f["bottom"] == tops[id(c)]]
        d2, f = min(((math.dist(c["at_mm"][:2], f["at_mm"]), f) for f in cand), key=lambda t: t[0])
        for lvl in (tops[id(c)], [o for o in plan["ops"] if o["op"] == "beam" and EL.get(o["level"], 9e9) < 500][0]["level"]):
            ops.append({"op": "beam", "type_name": "300 x 600mm", "level": lvl, "start_mm": [round(c["at_mm"][0]), round(c["at_mm"][1]), 0], "end_mm": [f["at_mm"][0], f["at_mm"][1], 0], "size_mm": [230, 400 if EL[lvl] > 500 else 400]})
        ops.append({"op": "isolated_foundation", "type_name": "1800 x 1200 x 450mm", "level": PAD, "points_mm": [[round(c["at_mm"][0]), round(c["at_mm"][1])]], "size_mm": [1200, 1200, 400]})
json.dump(ops, open(W + "/extra.json", "w"), indent=1)
print(len(given), "given columns:", [(c["type"], c["at_mm"][:2]) for c in given], len(ops), "ops")
