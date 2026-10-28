# General notes (S-001) and typical reinforcement details (S-106) as fmc_model_edit ops, from the design json.
#   python -I scripts/structure/notes-details.py <work dir> <rc-design json>   -> <work dir>/notes_ops.json
# Drafting views in mm at 1:20 (details) / 1:1 notes text. PRELIMINARY - NOT FOR CONSTRUCTION.
import json, sys, collections
W, DJ = sys.argv[1], sys.argv[2]
d = json.load(open(DJ)); cfg = json.load(open(W + "/config.json")) if __import__("os").path.exists(W + "/config.json") else {}
ops = []; n = 0
def add(o):
    global n; ops.append(o); n += 1; return f"${n}"
def rect(v, x, y, w, h): add({"op": "detail_line", "view": v, "points_mm": [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], "closed": True})
def bar_dot(v, x, y, r=12): add({"op": "detail_line", "view": v, "points_mm": [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]], "closed": True})
def txt(v, x, y, t, w=120): add({"op": "text", "view": v, "point_mm": [x, y], "text": t, "width_mm": w})

NOTES = [
 "GENERAL NOTES - PRELIMINARY, NOT FOR CONSTRUCTION. To be checked and signed by a registered structural engineer (engineer of record) before construction.",
 "1. CODES: Uganda National Building (Structural Design) Code 2019; EN 1990 basis and combinations; EN 1991 loads; EN 1992 concrete (simplified checks); US 319 seismic (zone 2, Kampala); Building Control Regulations timber schedule 16 (SG grades).",
 "2. STRUCTURE: RC frame of columns, ground beams, floor beams and ring beams with masonry (stone/block) walls built tight into the frame as confined infill. RC first-floor slab 200 mm. Attic: suspended timber floor. Roof: timber Fink trusses @ 600 c/c, clay tiles.",
 "3. CONCRETE: C30/37 (checks made with fck 25 MPa, conservative); max aggregate 20 mm; blinding C12/15 50 mm. REINFORCEMENT: B500 (H), BS 4449; links H8. Covers: beams/columns 40, slabs 25, walls 30, foundations 50 (75 cast against earth).",
 "4. LAPS AND ANCHORAGE: columns 48 dia, beams/slabs 42 dia, anchorage 36 dia. Column links at 100 c/c for 600 mm each end of every storey and through joints (seismic); elsewhere per schedule.",
 "5. LOADS (characteristic): FF slab dead 6.8-7.0 kN/m2 (200 RC + screed + finishes + services), imposed 1.5 kN/m2 (residential), balconies 2.5; attic floor dead 0.6, storage 2.5; roof dead 1.0 kN/m2 plan (tiles, battens, trusses), imposed 0.5 (inaccessible); stone walls 22 kN/m3.",
 "6. WIND: basic speed 25 m/s ASSUMED (to be confirmed from UNMA data), peak pressure 0.63 kPa, net 0.75 kPa on the walls. SEISMIC: Cd = C.Z.I.K = 0.08 x 0.8 x 1.0 x 2 = 0.128; base shear about 865 kN; storey drift limit 0.010 h.",
 "7. FOUNDATIONS: pad footings at 1.0 m min below ground on assumed allowable bearing 150 kPa - TO BE CONFIRMED BY A GEOTECHNICAL INVESTIGATION (trial pits) before construction; ground beams tie all pads both ways.",
 "8. MASONRY INFILL (REQUIRED FOR STABILITY): walls marked as infill are part of the earthquake resistance. Build them after the frame, tight to columns and beams (no gaps; pack the top joint with mortar), with wall ties (6 mm bar or ties) every 450 mm into the columns. Do not remove, or cut large openings in, these walls without the engineer's approval.",
 "9. TIMBER: SG8 (e.g. Eucalyptus grandis, Mukusu) or better, pressure-treated (US 324), moisture 15% in service. Truss joints by nail plates or 18 mm ply gussets both faces (fabricator to design). Every truss strapped to the ring beam with 30x2.5 galvanised straps and 2 M12 cast-in anchors.",
 "10. Read with the architectural drawings, the bar bending schedules (BS 8666) and the design report. Do not scale. Report discrepancies before work.",
]
nv = add({"op": "create_view", "kind": "drafting", "name": "S-001 General notes (PRELIMINARY)", "scale": 1})
for i, t in enumerate(NOTES): txt(nv, 0, -i * 30, t, 380)
sh = add({"op": "create_sheet", "number": "S-001", "name": "General notes - PRELIMINARY, NOT FOR CONSTRUCTION"}); add({"op": "place_view", "sheet": sh, "view": nv})

# typical details: the most common beam, column, pad and slab of the design
dv = add({"op": "create_view", "kind": "drafting", "name": "S-106 Typical reinforcement details (PRELIMINARY)", "scale": 20})
c = collections.Counter((x["size"], x["bars"], x["links"]) for x in d["columns"]).most_common(2)
b = collections.Counter((x["size"], x["bottom"], x["top"], x["links"]) for x in d["beams"]).most_common(2)
p = max(d["pads"], key=lambda x: int(x["size"].split("x")[0]))
s = [x for x in d["slabs"] if not x["level"].startswith(("GF", "Site"))]
ox = 0
for (size, bars, links), k in c:
    a = int(size); rect(dv, ox, 0, a, a); rect(dv, ox + 40, 40, a - 80, a - 80)
    nb = int(bars.split("H")[0]); pos = [(48, 48), (a - 48, 48), (a - 48, a - 48), (48, a - 48)] + [(a / 2, 48), (a / 2, a - 48), (48, a / 2), (a - 48, a / 2)] + [(a / 3, 48), (2 * a / 3, a - 48), (48, 2 * a / 3), (a - 48, a / 3)]
    for (x, y) in pos[:nb]: bar_dot(dv, ox + x, y)
    txt(dv, ox, -60, f"COLUMN C {size}x{size} ({k} No.): {bars} vertical, {links} links (100 c/c 600 mm each end), cover 40", 90); ox += a + 600
for (size, bot, top, links), k in b:
    bw, h = map(int, size.split("x")); rect(dv, ox, 0, bw, h); rect(dv, ox + 40, 40, bw - 80, h - 80)
    for row, spec in ((48, bot), (h - 48, top)):
        nb = int(spec.split("H")[0])
        for j in range(nb): bar_dot(dv, ox + 48 + j * (bw - 96) / max(1, nb - 1), row)
    txt(dv, ox, -60, f"BEAM {size} ({k} No.): bottom {bot}, top {top}, {links} links, cover 40; slab 200 cast monolithic", 90); ox += bw + 600
B, _, hh = map(int, p["size"].split("x")); sc = 0.25
rect(dv, ox, 0, B * sc, hh * sc); rect(dv, ox + B * sc / 2 - 40, hh * sc, 80, 300)
add({"op": "detail_line", "view": dv, "points_mm": [[ox + 12, 15], [ox + B * sc - 12, 15]]})
txt(dv, ox, -60, f"PAD (largest) {p['size']} (shown 1:80): {p['bars']} bottom both ways, cover 50 (75 to earth), on 50 blinding; starters from the column with 450 legs; service pressure {p['pressure_kPa']} kPa <= 150 assumed", 110); ox += B * sc + 600
if s:
    sl = max(s, key=lambda x: x["t"]); add({"op": "detail_line", "view": dv, "points_mm": [[ox, 0], [ox + 1200, 0], [ox + 1200, sl["t"]], [ox, sl["t"]]], "closed": True})
    add({"op": "detail_line", "view": dv, "points_mm": [[ox + 25, 30], [ox + 1175, 30]]}); add({"op": "detail_line", "view": dv, "points_mm": [[ox + 25, sl["t"] - 30], [ox + 1175, sl["t"] - 30]]})
    txt(dv, ox, -60, f"SLAB {sl['t']} mm: {sl['bars']} bottom both ways; same top over beams (0.3 span each side); cover 25; corner bars at re-entrant corners 2H12 x 1200", 110)
txt(dv, 0, -400, "Typical details only: sizes and bars for every member are in the bar bending schedules (BS 8666) and the design report. PRELIMINARY - NOT FOR CONSTRUCTION.", 300)
sh2 = add({"op": "create_sheet", "number": "S-106", "name": "Typical reinforcement details - PRELIMINARY, NOT FOR CONSTRUCTION"}); add({"op": "place_view", "sheet": sh2, "view": dv})
json.dump(ops, open(W + "/notes_ops.json", "w")); print(len(ops), "ops")
