"""Sofa practice, round 2 (20 Oct 2026): Rhino parts for FMC_I_Furniture_Sofa_MidCentury from the owner's photo.
Round 1 (an earlier session) passed the geometry check but not likeness: torn side shell, thin round arms, a backboard
above the cushions, 3 x 2 tufts. This round: a bent-wood side panel profile, a wrapped front rail, paddle arms on front
posts, back cushions 4 x 2 leaning back, back panel hidden below the cushions, legs under the side panels.
Axes in mm: x along the sofa, -y is the front, z up; the floor is z = 0.  Run: python build_r2.py -> r2_parts.json"""
import json, math

W2, T = 1065, 24                    # half width; side panel thickness
FRAME, HARD = "FMC_Timber_Mahogany", "FMC_Metal_StructuralSteel_S275"   # walnut asked for in the kit CR
UPH, FOAM, PLY, SOFT = "FMC_Fabric_Upholstery_WipeClean_Grey", "FMC_Fabric_Mattress_PU_Blue", "FMC_Board_Plywood_Marine18", "FMC_Timber_Eucalyptus_Sawn"

def arc(c, r, a0, a1, n=8):
    return [[round(c[0] + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)), 2),
             round(c[1] + r * math.sin(math.radians(a0 + (a1 - a0) * i / n)), 2)] for i in range(n + 1)]

def P(name, op, sub, mat, **spec):
    return {"name": name, "op": op, "subcategory": sub, "material": mat, "visibility": "fine", **spec}

# side panel outline in (y, z): bent-wood shell, big front-lower radius, sloping top to the arm, rising behind it
side = ([[-330, 230]] + arc((-330, 340), 110, -90, -180)[1:] + [[-440, 430], [-150, 600], [330, 600]]
        + arc((330, 690), 90, -90, 0)[1:] + [[420, 690], [440, 670], [440, 250]] + arc((420, 250), 20, 0, -90)[1:])
side = [p for i, p in enumerate(side) if i == 0 or p != side[i - 1]]

parts = []
for s, x0 in (("L", -W2), ("R", W2 - T)):
    parts.append(P(f"Side_{s}", "extrude_points", "Frame", FRAME, points=[[x0, y, z] for y, z in side], vector=[T, 0, 0], fillet=4))
# front rail: one bent band that wraps the front corners into the side panels
rail = ([[-1053, -230, 230]] + [[x, y, 230] for x, y in arc((-943, -318), 110, 180, 270)] +
        [[x, y, 230] for x, y in arc((943, -318), 110, 270, 360)] + [[1053, -230, 230]])
parts.append(P("Rail_Front", "sweep_path", "Frame", FRAME, path=rail, profile=[[-12, 0], [12, 0], [12, 40], [-12, 40]]))
# paddle arms on the panels, rounded front, carried by a front post
for s, sg in (("L", -1), ("R", 1)):
    xo, xi = sg * 1068, sg * 968
    front = arc((sg * 1018, -420), 50, 0, -180) if sg < 0 else arc((sg * 1018, -420), 50, 180, 360)
    outline = [[xi, 360], [xi, -420]] + front[1:-1] + [[xo, -420], [xo, 360]]
    parts.append(P(f"Arm_{s}", "extrude_points", "Frame", FRAME, points=[[x, y, 600] for x, y in outline], vector=[0, 0, 28], fillet=8))
    parts.append(P(f"Post_{s}F", "box_rounded", "Frame", FRAME, center=[sg * 1053, -400, 523], size=[26, 26, 154], radius=5))
# legs: tapered, splayed out from under the side panels; centre legs under the frame rails
legs = {"FL": ((-1030, -330, 230), (-1050, -355, 0)), "FR": ((1030, -330, 230), (1050, -355, 0)),
        "BL": ((-1030, 330, 230), (-1050, 355, 0)), "BR": ((1030, 330, 230), (1050, 355, 0)),
        "FC": ((0, -300, 228), (0, -330, 0)), "BC": ((0, 300, 228), (0, 330, 0))}
for k, (top, bot) in legs.items():
    parts.append(P(f"Leg_{k}", "loft", "Legs", FRAME, sections=[{"origin": list(top), "profile": {"circle": 20}}, {"origin": list(bot), "profile": {"circle": 11}}]))
    x, y, z = top
    parts.append(P(f"Leg_{k}_Plate", "extrude_points", "Hardware", HARD,
                   points=[[x - 30, y - 30, z - 5], [x + 30, y - 30, z - 5], [x + 30, y + 30, z - 5], [x - 30, y + 30, z - 5]], vector=[0, 0, 5]))

# hidden LOD 400 frame, springs and foam: kept from round 1 (they passed and don't show)
r1 = {p["name"]: p["spec"] for p in json.load(open("r1_parts_described.json"))["parts"]}
for n in [n for n in r1 if n.startswith(("Frame_", "Spring_", "StayWire_", "SeatCushion_", "SeatFoam_"))]:
    sp = dict(r1[n]); sp["visibility"] = "fine"
    parts.append(sp)

# back: an upholstered panel kept below the cushion tops, and three back cushions, 4 x 2 biscuit tufts, leaning back 12 degrees
parts.append(P("Back_Panel", "box_rounded", "Upholstery", UPH, center=[0, 420, 500], size=[2082, 40, 400], radius=8))
for i, xc in enumerate((-698, 0, 698), 1):
    rot = {"deg": -12, "axis": [1, 0, 0], "center": [xc, 300, 455]}
    parts.append(P(f"Back{i}_Body", "box_rounded", "Cushions", UPH, center=[xc, 300, 640], size=[690, 170, 370], radius=45, rotate=rot))
    seams = []
    for j, dx in enumerate((-172.5, 0, 172.5), 1):
        seams.append(f"Back{i}_SeamV{j}")
        parts.append(P(seams[-1], "box_rounded", "Cushions", UPH, center=[xc + dx, 215, 640], size=[10, 40, 300], radius=4, rotate=rot))
    seams.append(f"Back{i}_SeamH")
    parts.append(P(seams[-1], "box_rounded", "Cushions", UPH, center=[xc, 215, 640], size=[620, 40, 10], radius=4, rotate=rot))
    parts.append(P(f"BackCushion_{i}", "boolean", "Cushions", UPH, kind="difference", parts=[f"Back{i}_Body"] + seams))

json.dump(parts, open("r2_parts.json", "w"), indent=1)
print(len(parts), "specs;", sum(p["op"] != "boolean" for p in parts), "built,", sum(p["op"] == "boolean" for p in parts), "booleans")
