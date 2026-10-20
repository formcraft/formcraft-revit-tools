"""Sofa practice, round 4: after the round 3 blind review (6/10): the panel top climbs from seat height at the front to the arm at
the back (tapered shell, no rear posts); back cushions are one soft body each with shallow seams (biscuits stand 17 mm
proud); the arm front overhangs 80 mm past its post. Round 3 (20 Oct 2026). From close crops of the owner's photo (crop_*.png in the log):
- the side panel is a shallow bent-wood shell (about 250 mm), top edge flat just under the arm, big rounded front corners
  rolling into the front rail; the arm floats above it on two posts;
- the arm is a flat 110 x 35 board with a round front that turns the back corner;
- the back cushions are 3 x 2 puffed biscuits (top row taller), not seams cut into a flat face.
Round 3b: biscuits overlap 10 mm (shallow seams, softer), back top lowered to about 830. Round 2's 4 x 2 tuft count was a misreading, corrected here and in the reference. Axes in mm: x along, -y front, z up.
Run: python build_r3.py -> r3_parts.json (new parts) and r3_remove.json (round 2 parts this round replaces)."""
import json, math

FRAME, HARD, UPH = "FMC_Timber_Mahogany", "FMC_Metal_StructuralSteel_S275", "FMC_Fabric_Upholstery_WipeClean_Grey"

def arc(c, r, a0, a1, n=10):
    return [[round(c[0] + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)), 2),
             round(c[1] + r * math.sin(math.radians(a0 + (a1 - a0) * i / n)), 2)] for i in range(n + 1)]

def P(name, op, sub, mat, **spec):
    return {"name": name, "op": op, "subcategory": sub, "material": mat, "visibility": "fine", **spec}

def clean(pts):
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) > 0.5: out.append(p)
    return out

# side panel in (y, z): bottom sloping 258 -> 232 toward the front, front corners R130 (bottom) and R110 (top), top flat at 485
side = clean([[400, 258], [-250, 232]] + arc((-250, 422), 190, -90, -180) + arc((-360, 422), 80, 180, 110)
             + [[300, 545]] + arc((380, 505), 40, 90, 0) + [[420, 278]] + arc((400, 278), 20, 0, -90))
parts, T = [], 20
for s, x0 in (("L", -1065), ("R", 1045)):
    parts.append(P(f"Side_{s}", "extrude_points", "Frame", FRAME, points=[[x0, y, z] for y, z in side], vector=[T, 0, 0]))
# front rail: the shell's bottom lip, wrapping both front corners
rail = ([[-1055, -300, 232]] + [[x, y, 232] for x, y in arc((-945, -330), 110, 180, 270)] +
        [[x, y, 232] for x, y in arc((945, -330), 110, 270, 360)] + [[1055, -300, 232]])
parts.append(P("Rail_Front", "sweep_path", "Frame", FRAME, path=rail, profile=[[-10, 0], [10, 0], [10, 36], [-10, 36]]))
# arms: flat board, round front, back end turning the corner; two posts carry it above the panel
for s, sg in (("L", -1), ("R", 1)):
    left = [[-965, -460]] + arc((-1020, -460), 55, 0, -180)[1:-1] + [[-1075, -460], [-1075, 330]] + arc((-975, 330), 100, 180, 90)[1:] + [[-800, 430], [-800, 320], [-965, 320]]
    out = left if sg < 0 else [[-x, y] for x, y in left][::-1]   # the right arm mirrors the left
    parts.append(P(f"Arm_{s}", "extrude_points", "Frame", FRAME, points=[[x, y, 545] for x, y in clean(out)], vector=[0, 0, 35]))
    for k, y in (("F", -380),):
        parts.append(P(f"Post_{s}{k}", "box_rounded", "Frame", FRAME, center=[sg * 1020, y, 520], size=[28, 28, 50], radius=6))
# legs: round, tapered, splayed out and away under the panel corners
for k, (top, bot) in {"FL": ((-1040, -300, 232), (-1078, -350, 0)), "FR": ((1040, -300, 232), (1078, -350, 0)),
                      "BL": ((-1040, 360, 256), (-1078, 410, 0)), "BR": ((1040, 360, 256), (1078, 410, 0))}.items():
    parts.append(P(f"Leg_{k}", "loft", "Legs", FRAME, sections=[{"origin": list(top), "profile": {"circle": 18}}, {"origin": list(bot), "profile": {"circle": 10}}]))
    x, y, z = top
    parts.append(P(f"Leg_{k}_Plate", "extrude_points", "Hardware", HARD, points=[[x - 25, y - 25, z - 5], [x + 25, y - 25, z - 5], [x + 25, y + 25, z - 5], [x - 25, y + 25, z - 5]], vector=[0, 0, 5]))
# back: hidden panel, then three cushions of 3 x 2 puffed biscuits on a base, leaning back 14 degrees
parts.append(P("Back_Panel", "box_rounded", "Upholstery", UPH, center=[0, 425, 480], size=[2088, 30, 380], radius=8))
for i, xc in enumerate((-698, 0, 698), 1):
    rot = {"deg": -14, "axis": [1, 0, 0], "center": [xc, 330, 462]}
    names = [f"Back{i}_Base"]
    parts.append(P(names[0], "box_rounded", "Cushions", UPH, center=[xc, 300, 645], size=[690, 150, 366], radius=45, rotate=rot))
    for r, (zc, h) in enumerate(((567, 154), (726, 158)), 1):   # 25 mm inside the body (a 1 mm overshoot broke the union); the body face cuts their flat sides (no sliver edges)   # shallow seams: biscuits stand 17 mm proud; rows overlap 4 mm (a 1 mm overlap made the union fail)
        for c, dx in enumerate((-215, 0, 215), 1):   # biscuits 6 mm apart: each meets only the body (overlapping biscuits broke the union)
            names.append(f"Back{i}_Biscuit{r}{c}")
            parts.append(P(names[-1], "box_rounded", "Cushions", UPH, center=[xc + dx, 230, zc], size=[209, 60, h], radius=18, rotate=rot))
    parts.append(P(f"BackCushion_{i}", "boolean", "Cushions", UPH, kind="union", parts=names))

json.dump(parts, open("r4_parts.json", "w"), separators=(",", ":"))
print(len(parts), "parts")
