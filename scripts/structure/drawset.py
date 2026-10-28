# The structural drawing set from the kit (owner 28 Oct: "we have Revit symbols, tags and keynotes in the kit - use
# them"): sheet numbers and names from 03_Master_Data/FMC_Sheet_Register.csv (role S); the kit keynote file loaded
# and every structural type keynoted (C.COL_00, C.PAD_01...); live structural plans with Revit tags and keynote tags;
# real section views through the building and through a typical pad, column, beam and the stair; schedules with bar
# marks and reinforcement (Mark / Comments from bar-marks.py). No detail lines or drawn text for model content.
# Re-runnable: everything the previous run made (drawset.out.json), and the older drawn sheets (drawings, notes,
# slab/stair, truss, schedules batches), is deleted in the same batch first, so the set is replaced, never duplicated.
#   python -I scripts/structure/drawset.py <work dir> <rc-design json> <facts_now json> [kit dir]  -> <work>/drawset.json
import json, os, sys, csv, math
W, DJ, FN = sys.argv[1:4]; KIT = sys.argv[4] if len(sys.argv) > 4 else r"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2"
J = lambda p, d=None: json.load(open(p, encoding="utf-8")) if os.path.exists(p) else d
d, facts, cfg = J(DJ), J(FN), J(W + "/config.json", {})
REG = {r["SheetNumber"]: r for r in csv.DictReader(open(os.path.join(KIT, "03_Master_Data", "FMC_Sheet_Register.csv"), encoding="utf-8-sig")) if r["Role"] == "S"}
KEYNOTES = os.path.join(KIT, "02_Keynotes", "FMC_Keynotes.txt").replace("\\", "/")
# tag types: the category's loaded default unless config.tag_types names one ("Family: Type"); keynotes need a keynote tag
TAG = {"framing": None, "column": None, "foundation": None, "keynote": "M_Keynote Tag: Keynote Text"} | cfg.get("tag_types", {})
def tag(v, ids, kind, **kw):
    o = {"op": "tag", "view": v, "ids": ids} | kw
    if TAG.get(kind): o["tag_type"] = TAG[kind]
    return add(o)
KN = cfg.get("keynotes", {"column": "C.COL_00", "framing": "C.COL_00", "foundation": "C.PAD_01"})   # C30/37 frame, C30/37 pads
TB = cfg.get("title_block", "A1 metric")   # the kit's FMC title block once the model carries it
ops = []; n = 0
def add(o):
    global n; ops.append(o); n += 1; return f"${n}"

# 1 replace: what the previous run made, and the older drawn sheets and views
old = []
for f in ("drawset.out.json", "drawings.out.json", "notes_ops.out.json", "slab_stair_ops.out.json", "truss_ops.out.json", "sched_ops.out.json"):
    r = J(os.path.join(W, f))
    if r: old += [i for o in r.get("ops", []) if o.get("kind") in ("create_view", "create_sheet", "create_schedule") for i in o.get("created_ids", [])]
if old: add({"op": "delete", "ids": sorted(set(old)), "missing_ok": True})

# 2 keynotes: the kit file, and every structural type keynoted
add({"op": "keynote_file", "path": KEYNOTES})
cols = [c["id"] for c in facts["columns"]]; beams = [b["id"] for b in facts["framing"]]; pads = [p["id"] for p in d["pads"]]
for ids, k in ((cols, "column"), (beams, "framing"), (pads, "foundation")):
    if ids: add({"op": "set_param", "ids": ids, "param": "Keynote", "value_text": KN[k], "on_type": True})

# 3 plans: tags show the type (size) and the keynote; bar marks are in the schedules
lvl = {"S-1001": ("Site ±0.00", pads, cols), "S-1002": ("Site ±0.00", [b["id"] for b in d["ground_beams"]], []),
       "S-1003": ("FF +3.85", [b["id"] for b in d["beams"] if b.get("level", "").startswith("FF")], cols),
       "S-1009": ("Roof +7.25", [b["id"] for b in d["beams"] if b.get("level", "").startswith("Roof")], [])}
views = {}
for num, (level, members, columns) in lvl.items():
    r = REG.get(num)
    if not r: continue
    v = add({"op": "create_view", "kind": "structural_plan", "level": level, "name": f"{num} {r['SheetName']}", "scale": int(r["Scale"].split(":")[1]), "discipline": "Structural", "detail_level": "Medium"})
    kind = "foundation" if num == "S-1001" else "framing"
    if members: tag(v, members, kind); tag(v, members, "keynote", offset_mm=[0, -400])
    if columns: tag(v, columns, "column", offset_mm=[450, 450])
    views[num] = [v]

# 4 sections: through the building, and through a typical pad, column, beam and the stair (live views of the model)
xs = [c["at_mm"][0] for c in facts["columns"] if c.get("at_mm")]; ys = [c["at_mm"][1] for c in facts["columns"] if c.get("at_mm")]
x0, x1, y0, y1 = min(xs) - 1500, max(xs) + 1500, min(ys) - 1500, max(ys) + 1500; ym, xm = (y0 + y1) / 2, (x0 + x1) / 2
def section(name, a, b, depth, bottom=-1500, top=9000, scale=50):
    return add({"op": "create_view", "kind": "section", "name": name, "line_mm": [a, b], "depth_mm": depth, "bottom_mm": bottom, "top_mm": top, "scale": scale,
                "discipline": "Structural", "detail_level": "Fine"})
if "S-3001" in REG:
    views["S-3001"] = [section("S-3001 Section A-A (east-west)", [x0, ym], [x1, ym], 600), section("S-3001 Section B-B (north-south)", [xm, y1], [xm, y0], 600)]
pad = max(d["pads"], key=lambda p: int(p["size"].split("x")[0]))
col = max(d["columns"], key=lambda c: c["N_kN"] or 0)
bm = max(d["beams"], key=lambda b: b["M_kNm"])
bgeo = next((f for f in facts["framing"] if f["id"] == bm["id"] and f.get("start_mm")), None)
if "S-4001" in REG:
    B = int(pad["size"].split("x")[0]); px, py = pad["at"]
    views["S-4001"] = [section(f"S-4001 Typical pad {pad['size']} (pad {pad['id']})", [px - B, py], [px + B, py], 400, -1500, 1000, 20)]
if "S-4002" in REG:
    cx, cy = col["at"]; views["S-4002"] = [section(f"S-4002 Typical column {col['size']}x{col['size']} {col['bars']} (column {col['id']})", [cx - 800, cy], [cx + 800, cy], 300, -1500, 7500, 20)]
if "S-4003" in REG and bgeo:
    (sx, sy, sz), (ex, ey, ez) = bgeo["start_mm"], bgeo["end_mm"]
    views["S-4003"] = [section(f"S-4003 Beam {bm['size']} B {bm['bottom']} T {bm['top']} (beam {bm['id']})", [sx, sy], [ex, ey], 300, sz - 1500, sz + 1000, 20)]
st = (J(W + "/stairs.json", []) or [{}])[0]
if "S-4005" in REG and st.get("box"):
    (bx0, by0, _), (bx1, by1, _) = st["box"]
    views["S-4005"] = [section("S-4005 Stair section", [bx0 + 500, by1 + 300], [bx0 + 500, by0 - 300], 1200, -500, 4500, 20)]

# 5 schedules: the members with their bar marks (Mark) and reinforcement (Comments), and their keynotes
SCH = {"S-5001": ("Structural Columns", "S-5001 Column schedule", ["Mark", "Type", "Base Level", "Top Level", "Comments", "Keynote", "Count"], ["Base Level", "Mark"]),
       "S-5002": ("Structural Framing", "S-5002 Beam schedule", ["Mark", "Type", "Reference Level", "Comments", "Keynote", "Count"], ["Reference Level", "Mark"]),
       "S-5003": ("Structural Foundations", "S-5003 Foundation schedule", ["Mark", "Type", "Comments", "Keynote", "Count"], ["Mark"])}
for num, (cat, name, fields, sort) in SCH.items():
    if num in REG: views[num] = [add({"op": "create_schedule", "category": cat, "name": name, "fields": fields, "sort": sort, "itemize": True})]
if "S-6001" in REG: views["S-6001"] = [add({"op": "create_view", "kind": "3d", "name": "S-6001 Structural 3D", "detail_level": "Medium", "discipline": "Structural"})]

# 6 sheets from the register, views placed in a column down the sheet
for num, vs in sorted(views.items()):
    r = REG[num]; sh = add({"op": "create_sheet", "number": num, "name": f"{r['SheetName']} - PRELIMINARY, NOT FOR CONSTRUCTION", "title_block": TB})
    for k, v in enumerate(vs): add({"op": "place_view", "sheet": sh, "view": v, "point_mm": [400, 470 - k * 230] if len(vs) > 1 else [400, 300]})
json.dump(ops, open(W + "/drawset.json", "w"), indent=0)
print(len(ops), "ops;", len(old), "old views/sheets replaced;", "sheets:", ", ".join(sorted(views)))
