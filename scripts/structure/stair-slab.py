# RC stairs (from facts.json stairs) and the floor slab reinforcement plan, as design data, BBS rows and drawing ops.
#   python scripts/structure/stair-slab.py <work dir> <rc-design json> <BBS xlsx>   (openpyxl: not -I)
# Stairs: a U stair (two flights + half landing) in its stair box; waist slab simply supported over the flight + landing,
# EC2 simplified; landing on a landing beam with two stub columns; small external steps (rise <= 600) on grade.
# Slab plan: on the slab's level, bottom mesh labels per bay between beam lines, top bars along every beam.
# PRELIMINARY - NOT FOR CONSTRUCTION.
import json, sys, math, os, collections
import openpyxl
W, DJ, XL = sys.argv[1], sys.argv[2], sys.argv[3]
facts = json.load(open(W + "/facts.json")); d = json.load(open(DJ)); plan = json.load(open(W + "/plan.json", encoding="utf-8"))
built = json.load(open(W + "/build.out.json")); sizes = json.load(open(W + "/sizes.json"))
EL = {l["name"]: l["elevation_mm"] for l in facts["levels"]}
FCK, FYD = 25, 435; MASS = {8: .395, 10: .616, 12: .888, 16: 1.579}; AREA = {k: math.pi * k * k / 4 for k in MASS}
up25 = lambda x: int(math.ceil(x / 25.0) * 25)

# ---- stairs
stairs_out, bbs = [], []
def bar(member, mark, dia, n, L, shape, note):
    bbs.append([member, mark, f"H{dia}", 1, n, n, up25(L), shape, up25(L), "", "", "", round(n * up25(L) / 1000, 2), round(n * up25(L) / 1000 * MASS[dia], 1), note])
for s in facts.get("stairs", []):
    (x0, y0, z0), (x1, y1, z1) = s["box_mm"]; rise = z1 - z0
    if "Monolithic" not in s["type"] and "RC" not in s["type"]: stairs_out.append({"id": s["id"], "type": s["type"], "note": "not RC: by the supplier, fixings to the slab/beams"}); continue
    if rise <= 600: stairs_out.append({"id": s["id"], "type": s["type"], "rise_mm": round(rise), "note": "external steps on grade: 100 mm RC (A142 mesh) on 150 hardcore"}); continue
    nR = math.ceil(rise / 175); R = rise / nR; Gd = 250; per = nR // 2
    width, length = x1 - x0, y1 - y0; flight_w = min(1000, width / 2)
    run = (per - 1) * Gd; landing = max(1000, length - run); span = run + landing
    th = math.atan(R / Gd); h = max(150, int(math.ceil(span / 25 / 25) * 25))
    g = 25 * h / 1000 / math.cos(th) + 25 * R / 2000 + 1.0; q = 2.0       # waist, steps, finishes; imposed 2.0 (stairs)
    n = 1.35 * g + 1.5 * q; M = n * (span / 1000) ** 2 / 8; dd = h - 25 - 6
    K = M * 1e6 / (1000 * dd * dd * FCK); z = min(0.95 * dd, dd * (0.5 + math.sqrt(max(0, 0.25 - K / 1.134))))
    As = max(M * 1e6 / (FYD * z), 0.0013 * 1000 * dd)
    dia, sp = next(((di, sp) for di in (10, 12, 16) for sp in (300, 250, 200, 175, 150, 125) if 1000 * AREA[di] / sp >= As), (16, 125))
    LB = width; wl = n * landing / 1000 / 2 + 1.35 * 25 * 0.23 * 0.3; ML = wl * (LB / 1000) ** 2 / 8   # landing beam takes half the landing strip load
    out = {"id": s["id"], "type": s["type"], "box": s["box_mm"], "rise_mm": round(rise), "risers": nR, "riser_mm": round(R, 1), "going_mm": Gd, "flights": 2,
           "flight_width_mm": round(flight_w), "span_mm": round(span), "waist_mm": h, "load_uls_kn_m2": round(n, 2), "M_kNm_per_m": round(M, 1),
           "main": f"H{dia} @ {sp}", "distribution": "H10 @ 300", "top_at_supports": f"H10 @ {sp}", "landing_beam": f"230x300 over {round(LB)} mm, 2H12 B, 2H12 T, H8 @ 200; on two 230x230 stub columns (4H16, H8 @ 200) from the ground beams",
           "landing_beam_M_kNm": round(ML, 1), "bearing": "upper flight on the first-floor trimmer/edge beam; lower flight on the ground-floor slab thickened to 300 with 2H12"}
    stairs_out.append(out)
    nm = f"Stair {s['id']} ({nR} x {R:.0f}/{Gd})"
    Lf = math.hypot(run, rise / 2) + landing + 2 * 36 * dia
    nmain = int(flight_w // sp) + 1
    bar(nm, "ST01", dia, nmain * 2, Lf, "00", f"flight main bars B, 2 flights, @ {sp}")
    bar(nm, "ST02", 10, int(Lf // 300) * 2 + 2, flight_w - 50, "00", "distribution bars, 2 flights")
    bar(nm, "ST03", 10, nmain * 2 * 2, 0.3 * span + 36 * 10 * 2, "11", f"top bars at both supports @ {sp}")
    bar(nm, "ST04", 12, 4, LB + 2 * 36 * 12, "00", "landing beam 2H12 B + 2H12 T")
    bar(nm, "ST05", 8, int(LB // 200) + 1, 2 * (150 + 220) + 160, "51", "landing beam links H8 @ 200")
    bar(nm, "ST06", 16, 8, rise / 2 + 450 + 48 * 16, "11", "two stub columns 4H16 each")
    bar(nm, "ST07", 8, int(rise / 2 // 200 + 1) * 2, 2 * (150 + 150) + 160, "51", "stub column links H8 @ 200")

# ---- BBS: add a Stairs sheet and update the summary
wb = openpyxl.load_workbook(XL)
if "Stairs" in wb.sheetnames: del wb["Stairs"]
ws = wb.create_sheet("Stairs"); ws.append(["Member", "Bar mark", "Type & size", "No. of mbrs", "No. in each", "Total no.", "Length (mm)", "Shape code", "A", "B", "C", "D", "Total length (m)", "Mass (kg)", "Note"])
for r in bbs: ws.append(r)
sm = wb["Summary"]; sm.append([]); sm.append(["Stairs", round(sum(r[13] for r in bbs))])
wb.save(XL)

# ---- slab reinforcement plan per RC slab level above ground (bays between beam lines)
pairs = list(zip(plan["ops"], built["ops"][2:]))
if os.path.exists(W + "/extra.json") and os.path.exists(W + "/extra.out.json"):
    pairs += list(zip(json.load(open(W + "/extra.json")), json.load(open(W + "/extra.out.json"))["ops"]))
ops = []; k = 0
def add(o):
    global k; ops.append(o); k += 1; return f"${k}"
def inside(p, loop):
    c = False; n2 = len(loop)
    for i in range(n2):
        (x1, y1), (x2, y2) = loop[i][:2], loop[(i + 1) % n2][:2]
        if (y1 > p[1]) != (y2 > p[1]) and p[0] < (x2 - x1) * (p[1] - y1) / (y2 - y1) + x1: c = not c
    return c
slab_spec = {sl["id"]: sl for sl in d["slabs"]}
sheet_no = 107
for lvl in sorted({sl["level"] for sl in plan["plan"]["slabs"] if not sl["on_ground"] and sl["id"] in slab_spec}, key=lambda n2: EL[n2]):
    slabs = [sl for sl in plan["plan"]["slabs"] if sl["level"] == lvl and sl["id"] in slab_spec]
    v = add({"op": "create_view", "kind": "structural_plan", "level": lvl, "name": f"S-{sheet_no} {lvl} slab reinforcement plan (PRELIMINARY)", "scale": 100, "discipline": "Structural", "detail_level": "Medium"})
    beams = [(o, r) for o, r in pairs if o["op"] == "beam" and o["level"] == lvl]
    xs = sorted({round(o["start_mm"][0]) for o, _ in beams if abs(o["start_mm"][0] - o["end_mm"][0]) < 5})
    ys = sorted({round(o["start_mm"][1]) for o, _ in beams if abs(o["start_mm"][1] - o["end_mm"][1]) < 5})
    for sl in slabs:
        spec = slab_spec[sl["id"]]
        for i in range(len(xs) - 1):
            for j in range(len(ys) - 1):
                c = ((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2)
                if inside(c, sl["loops_mm"][0]):
                    add({"op": "text", "view": v, "point_mm": [c[0] - 600, c[1]], "width_mm": 40, "text": f"B1/B2 {spec['bars']}\n{spec['t']} slab"})
    for o, r in beams:
        sx, sy, ex, ey = o["start_mm"][0], o["start_mm"][1], o["end_mm"][0], o["end_mm"][1]
        L = math.dist((sx, sy), (ex, ey)); spec = slab_spec[slabs[0]["id"]] if slabs else None
        if not spec or L < 500: continue
        mx, my = (sx + ex) / 2, (sy + ey) / 2; nx, ny = -(ey - sy) / L * 350, (ex - sx) / L * 350
        add({"op": "detail_line", "view": v, "points_mm": [[sx + nx, sy + ny], [ex + nx, ey + ny]]})
        add({"op": "text", "view": v, "point_mm": [mx + nx, my + ny], "width_mm": 45, "text": f"T1/T2 {spec['bars'].split(' @')[0]} @ {spec['bars'].split('@ ')[1]}, {round(0.3 * L / 50) * 50} each side"})
    add({"op": "text", "view": v, "point_mm": [min(xs or [0]), min(ys or [0]) - 2500], "width_mm": 250,
         "text": "SLAB REINFORCEMENT: B1/B2 bottom bars both ways in every bay; T1/T2 top bars over every beam, extending 0.3 x span each side; 2H12 x 1200 diagonal at re-entrant corners and around openings > 300; cover 25. Voids (stair, double-height) trimmed with 2H12 each side. PRELIMINARY - NOT FOR CONSTRUCTION."})
    sh = add({"op": "create_sheet", "number": f"S-{sheet_no}", "name": f"{lvl} slab reinforcement plan - PRELIMINARY, NOT FOR CONSTRUCTION"}); add({"op": "place_view", "sheet": sh, "view": v}); sheet_no += 1

# ---- stair detail sheet
st = [s for s in stairs_out if "waist_mm" in s]
if st:
    v = add({"op": "create_view", "kind": "drafting", "name": f"S-{sheet_no} Stair details (PRELIMINARY)", "scale": 25})
    for i, s in enumerate(st):
        oy = -i * 6000; run = s["span_mm"] - 1000; R2 = s["rise_mm"] / 2; nR = s["risers"] // 2
        pts = [[0, oy]]
        for r2 in range(nR): pts += [[pts[-1][0], pts[-1][1] + s["riser_mm"]], [pts[-1][0] + s["going_mm"], pts[-1][1] + s["riser_mm"]]]
        add({"op": "detail_line", "view": v, "points_mm": pts})
        add({"op": "detail_line", "view": v, "points_mm": [[0, oy - s["waist_mm"]], [run, oy + R2 - s["waist_mm"]], [run + 1000, oy + R2 - s["waist_mm"]]]})
        add({"op": "detail_line", "view": v, "points_mm": [[pts[-1][0], pts[-1][1]], [run + 1000, oy + R2]]})
        add({"op": "text", "view": v, "point_mm": [run + 1300, oy + R2], "width_mm": 120, "text":
             f"STAIR {s['id']}: {s['risers']} risers x {s['riser_mm']} mm, goings {s['going_mm']} mm, 2 flights of {s['flight_width_mm']} mm with half landing. Waist {s['waist_mm']} mm, span {s['span_mm']} mm (flight + landing). Main bars {s['main']} B, distribution {s['distribution']}, top bars {s['top_at_supports']} 0.3 span at each support. Landing beam {s['landing_beam']}. {s['bearing']}. Imposed 2.0 kN/m2. Cover 25. PRELIMINARY."})
    sh = add({"op": "create_sheet", "number": f"S-{sheet_no}", "name": "Stair details - PRELIMINARY, NOT FOR CONSTRUCTION"}); add({"op": "place_view", "sheet": sh, "view": v})
json.dump(ops, open(W + "/slab_stair_ops.json", "w")); json.dump(stairs_out, open(W + "/stairs.json", "w"), indent=1)
print(len(ops), "ops;", [(s.get("id"), s.get("waist_mm"), s.get("main"), s.get("note")) for s in stairs_out])
