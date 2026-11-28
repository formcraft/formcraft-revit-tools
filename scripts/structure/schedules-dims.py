# Member schedules on a sheet (columns, beams, foundations, walls by type with counts) and grid dimension strings on
# the structural plans, as fmc_model_edit ops.
#   python -I scripts/structure/schedules-dims.py <work dir> "<plan view name>" ["<plan view name>" ...]
import json, sys
W, views = sys.argv[1], sys.argv[2:]
plan = json.load(open(W + "/plan.json", encoding="utf-8"))
grids = plan["plan"]["grids"]
# grid ids from the build batch: the add-in reads an all-digit name ("1") as an element id, so pass ids
gid = {o["name"]: o["grid"] for o in json.load(open(W + "/build.out.json"))["ops"] if o.get("kind") == "grid"}
ref = lambda g: str(gid.get(g["name"], g["name"]))
lett = [g for g in grids if g["name"][-1].isalpha()]; num = [g for g in grids if g["name"][-1].isdigit()]
xs = [p[0] for g in grids for p in (g["start_mm"], g["end_mm"])]; ys = [p[1] for g in grids for p in (g["start_mm"], g["end_mm"])]
ops = []; n = 0
def add(o):
    global n; ops.append(o); n += 1; return f"${n}"
for v in views:
    # lettered grids run along x: a vertical dimension string left of the plan; numbered grids: a horizontal one above
    if len(lett) > 1: add({"op": "dimension", "view": v, "refs": [ref(g) for g in lett], "line_mm": [[min(xs) - 1200, min(ys)], [min(xs) - 1200, max(ys)]]})
    if len(num) > 1: add({"op": "dimension", "view": v, "refs": [ref(g) for g in num], "line_mm": [[min(xs), max(ys) + 1200], [max(xs), max(ys) + 1200]]})
sch = []
for cat, name, fields, sort in (("Structural Columns", "S Column schedule", ["Type", "Base Level", "Top Level", "Count"], ["Type", "Base Level"]),
                                ("Structural Framing", "S Beam schedule", ["Type", "Reference Level", "Count"], ["Type", "Reference Level"]),
                                ("Structural Foundations", "S Foundation schedule", ["Type", "Count"], ["Type"]),
                                ("Floors", "S Slab schedule", ["Type", "Level", "Area", "Count"], ["Type", "Level"])):
    sch.append(add({"op": "create_schedule", "category": cat, "name": name, "fields": fields, "sort": sort, "itemize": False}))
sh = add({"op": "create_sheet", "number": "S-109", "name": "Member schedules - PRELIMINARY, NOT FOR CONSTRUCTION"})
for i, s in enumerate(sch): add({"op": "place_view", "sheet": sh, "view": s, "point_mm": [60 + (i % 2) * 280, 500 - (i // 2) * 230]})
json.dump(ops, open(W + "/sched_ops.json", "w")); print(len(ops), "ops")
