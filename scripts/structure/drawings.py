# The preliminary structural sheet set as fmc_model_edit ops: foundation + ground beam plan, framing plans per level,
# a 3D view; members tagged; one sheet each (S-100..). Element ids from the build batch (types may change, ids don't).
#   python -I scripts/structure/drawings.py <work dir>   -> <work dir>/drawings.json, then revit-edit.mjs it
import json, sys
W = sys.argv[1]
p = json.load(open(W + "/plan.json", encoding="utf-8")); b = json.load(open(W + "/build.out.json"))
pairs = list(zip(p["ops"], b["ops"][2:]))
import os
if os.path.exists(W + "/extra.json") and os.path.exists(W + "/extra.out.json"):
    pairs += list(zip(json.load(open(W + "/extra.json")), json.load(open(W + "/extra.out.json"))["ops"]))
beams = {}; cols = {}; pads = []
for o, r in pairs:
    ids = r.get("created_ids", [])
    if o["op"] == "beam": beams.setdefault(o["level"], []).extend(ids)
    if o["op"] == "column": cols.setdefault(o["level"], []).extend(ids)
    if o["op"] == "isolated_foundation": pads.extend(ids)
gnd = [k for k in beams if k.startswith("Site")][0]
views = [
    ("S-100", "Foundation and ground beam plan", "Site ±0.00", beams.get(gnd, []) + pads, cols.get("S Pad top -0.25", [])),
    ("S-101", "First floor framing plan", "FF +3.85", beams.get("FF +3.85", []), cols.get("S Pad top -0.25", [])),
    ("S-102", "Roof framing plan", "Roof +7.25", beams.get("Roof +7.25", []), cols.get("FF +3.85", [])),
]
ops = []
n = 0
def add(o):
    global n; ops.append(o); n += 1; return f"${n}"
for num, name, lvl, members, columns in views:
    v = add({"op": "create_view", "kind": "structural_plan", "level": lvl, "name": f"{num} {name} (PRELIMINARY)", "scale": 100, "discipline": "Structural", "detail_level": "Medium"})
    add({"op": "tag", "view": v, "ids": members, "orientation": "horizontal"})
    if columns: add({"op": "tag", "view": v, "ids": columns, "offset_mm": [450, 450]})
    sh = add({"op": "create_sheet", "number": num, "name": f"{name} - PRELIMINARY, NOT FOR CONSTRUCTION"})
    add({"op": "place_view", "sheet": sh, "view": v})
v3 = add({"op": "create_view", "kind": "3d", "name": "S-103 RC frame 3D (PRELIMINARY)", "detail_level": "Medium", "discipline": "Structural"})
sh = add({"op": "create_sheet", "number": "S-103", "name": "RC frame 3D - PRELIMINARY, NOT FOR CONSTRUCTION"})
add({"op": "place_view", "sheet": sh, "view": v3})
json.dump(ops, open(W + "/drawings.json", "w"))
print(len(ops), {k: len(v) for k, v in beams.items()}, len(pads), {k: len(v) for k, v in cols.items()})
