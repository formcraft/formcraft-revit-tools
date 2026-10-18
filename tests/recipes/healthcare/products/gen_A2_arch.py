"""Healthcare pack, batch A2 (architectural): detailed product models for 43 families (the 4 Profiles are 2D sweep
profiles and are skipped). Same pattern as make_products.py: parts with kit materials, generic reference (brand and model
open), assumed values with a reason. Compile + render with ../../tools/fmc_parts.py.
Run: python3 gen_A2_arch.py [family-substring ...]   (writes <family>.product.json, .recipe.json, .preview.png, .png here)

Conventions: mm, x right, y back, z up. Wall products: back at y = 0, standing toward -y, geometry from z = 0 with the
mounting height in Default Elevation. Floor products stand on z = 0. Ceiling products hang below z = 0. Families with
several types carry the first type's geometry; each type has its own Description."""
import json, os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import fmc_parts as fp

RECS = {r['family']: r for r in json.load(open(os.path.join(HERE, 'batches', 'A2_arch.json')))}
A = lambda v, src='typical product, to confirm with the supplier': {"value": v, "source_status": "assumed", "source": src}

MAT = {
    "ss": "FMC_Metal_StainlessSteel_Brushed", "chrome": "FMC_Metal_Chrome_Polished", "alu": "FMC_Metal_Aluminium_Anodised_Silver",
    "alupc": "FMC_Metal_Aluminium_PowderCoated", "galv": "FMC_Metal_ColdFormed_Galvanised", "steel": "FMC_Metal_StructuralSteel_S275",
    "dark": "FMC_Metal_SteelLTZ_Painted", "epoxy": "FMC_Metal_Steel_EpoxyCoated_White", "gi": "FMC_Metal_GI_Pipe",
    "white": "FMC_Plastic_ABS_White", "grey": "FMC_Plastic_ABS_Grey", "mgrey": "FMC_Plastic_ABS_MedicalGrey", "black": "FMC_Plastic_ABS_Black",
    "blue": "FMC_Plastic_ABS_Blue", "yellow": "FMC_Plastic_ABS_Yellow", "orange": "FMC_Plastic_HDPE_Orange",
    "red": "FMC_Plastic_LED_Red", "green": "FMC_Plastic_LED_Green", "ledb": "FMC_Plastic_LED_Blue", "rubber": "FMC_Rubber_Black",
    "castor": "FMC_Plastic_Nylon_CastorGrey", "pc": "FMC_Plastic_Polycarbonate_Clear", "glass": "FMC_Glass_Clear", "frost": "FMC_Glass_Frosted",
    "mirror": "FMC_Glass_Mirror", "hpl": "FMC_Plastic_Laminate_HPL", "mel": "FMC_Board_Melamine_White", "china": "FMC_Ceramic_VitreousChina_White",
    "vinyl": "FMC_Fabric_Vinyl_Upholstery_Blue", "curtain": "FMC_Fabric_Curtain_Disposable_Blue", "curtainp": "FMC_Fabric_Curtain_Plain", "cladding": "FMC_Plastic_PVC_HygienicCladding_White",
    "wprot": "FMC_Plastic_Vinyl_WallProtection_Grey",
    "conc": "FMC_Concrete_C30", "precast": "FMC_Concrete_Precast_Painted", "roof": "FMC_Roofing_AZED_Corrugated_Silver",
    "gutter": "FMC_Plastic_PVCGutter_White", "pipe": "FMC_Plastic_uPVC_Pipe_DarkGrey", "mesh": "FMC_Plastic_InsectMesh_Fibreglass",
    "floor": "FMC_Plastic_Vinyl_Plank", "safety": "FMC_Plastic_Vinyl_SafetyFloor_Grey", "led": "FMC_Plastic_LED_Blue",
    "clearance_accessibility": None, "clearance_maintenance": None,   # clearance solids carry no material
}
NEEDED = []   # second pass (17 Oct): the kit now has every material batch A2 asked for

# ---------------------------------------------------------------- shape helpers
def B(n, at, mat, r=0, lod='mf', **k): d = {"n": n, "shape": "box", "at": at, "mat": mat, "lod": lod, **k}; d.update({"r": r} if r else {}); return d
def F(n, at, mat, r=0, lod='mf', **k): d = {"n": n, "shape": "fbox", "at": at, "mat": mat, "lod": lod, **k}; d.update({"r": r} if r else {}); return d
def C(n, axis, c, r, rng, mat, lod='mf', **k): return {"n": n, "shape": "cyl", "axis": axis, "c": c, "r": r, axis: rng, "mat": mat, "lod": lod, **k}
def T(n, axis, c, prof, mat, lod='mf', **k): return {"n": n, "shape": "turn", "axis": axis, "c": c, "profile": prof, "mat": mat, "lod": lod, **k}
def FR(n, pts, y, mat, lod='mf', **k): return {"n": n, "shape": "front", "pts": pts, "y": y, "mat": mat, "lod": lod, **k}
def RT(n, pts, x, mat, lod='mf', **k): return {"n": n, "shape": "right", "pts": pts, "x": x, "mat": mat, "lod": lod, **k}
def PR(n, pts, z, mat, lod='mf', **k): return {"n": n, "shape": "prism", "pts": pts, "z": z, "mat": mat, "lod": lod, **k}
def rep(n, d): return {"repeat": {"n": n, "d": d}}
def only(types, parts, sfx):   # per-type geometry: parts shown only in these types (Yes/No type parameter), names made unique
    for q in parts: q['only'] = [types] if isinstance(types, str) else list(types); q['n'] = f"{q['n']} {sfx}"
    return parts
def ball(n, axis, c, t, r, mat, lod='f', **k):   # sphere as a turned part: centre (c on the plane, t along the axis)
    prof = [[round(r * math.sin(math.pi * i / 8), 2), round(t - r * math.cos(math.pi * i / 8), 2)] for i in range(9)]
    prof[0][0] = 0; prof[-1][0] = 0
    return T(n, axis, c, prof, mat, lod, **k)
def arc(cx, cy, r, a0, a1, n=8): return [[round(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)), 2), round(cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n)), 2)] for i in range(n + 1)]
def ring_sector(cx, cy, ri, ro, a0, a1, n=8): return arc(cx, cy, ro, a0, a1, n) + arc(cx, cy, ri, a1, a0, n)

# grab-rail pieces: 32 mm tube, 50 mm clear of the wall, round flanges with cover rosettes
R32, OFF = 16, 66
def rail_x(p, x0, x1, z, mat='ss', ends=True):   # on the back wall (y = 0), along x
    out = [C(f"{p} Tube", 'x', [-OFF, z], R32, [x0, x1], mat)]
    if ends:
        out += [C(f"{p} Return", 'y', [x0, z], R32, [-OFF, -8], mat, **rep(2, [x1 - x0, 0, 0])),
                ball(f"{p} Bend", 'y', [x0, z], -OFF, R32, mat, **rep(2, [x1 - x0, 0, 0])),
                T(f"{p} Flange", 'y', [x0, z], [[0, 0], [36, 0], [36, -4], [30, -9], [0, -9]], mat, **rep(2, [x1 - x0, 0, 0]))]
    return out
def rail_z(p, x, z0, z1, mat='ss'):   # on the back wall, vertical
    return [C(f"{p} Tube", 'z', [x, -OFF], R32, [z0, z1], mat),
            C(f"{p} Return", 'y', [x, z0], R32, [-OFF, -8], mat, **rep(2, [0, 0, z1 - z0])),
            ball(f"{p} Bend", 'y', [x, z0], -OFF, R32, mat, **rep(2, [0, 0, z1 - z0])),
            T(f"{p} Flange", 'y', [x, z0], [[0, 0], [36, 0], [36, -4], [30, -9], [0, -9]], mat, **rep(2, [0, 0, z1 - z0]))]
def rail_y(p, xw, s, y0, y1, z, mat='ss'):   # on a side wall whose face is x = xw, rail toward s (+1 / -1)
    xc = xw + s * OFF
    return [C(f"{p} Tube", 'y', [xc, z], R32, [y0, y1], mat),
            C(f"{p} Return", 'x', [y0, z], R32, sorted([xw + s * 8, xc]), mat, **rep(2, [0, y1 - y0, 0])),
            ball(f"{p} Bend", 'x', [y0, z], xc, R32, mat, **rep(2, [0, y1 - y0, 0])),
            C(f"{p} Flange", 'x', [y0, z], 36, sorted([xw, xw + s * 8]), mat, 'f', **rep(2, [0, y1 - y0, 0]))]
def rail_yz(p, xw, s, y, z0, z1, mat='ss'):   # on a side wall, vertical
    xc = xw + s * OFF
    return [C(f"{p} Tube", 'z', [xc, y], R32, [z0, z1], mat),
            C(f"{p} Return", 'x', [y, z0], R32, sorted([xw + s * 8, xc]), mat, **rep(2, [0, 0, z1 - z0])),
            C(f"{p} Flange", 'x', [y, z0], 36, sorted([xw, xw + s * 8]), mat, 'f', **rep(2, [0, 0, z1 - z0]))]

def wc_pan(cx, p='WC', seat='grey'):   # back-to-wall low-level WC, back at y = 0
    return [B(f"{p} Pedestal", [cx - 105, -640, 0, cx + 105, -180, 370], 'china', 90),
            B(f"{p} Bowl", [cx - 185, -720, 300, cx + 185, -170, 400], 'china', 170),
            B(f"{p} Seat", [cx - 180, -715, 400, cx + 180, -205, 422], seat, 165),
            B(f"{p} Seat Opening", [cx - 115, -640, 421, cx + 115, -300, 423], 'black', 110, 'f'),
            F(f"{p} Lid", [cx - 170, -205, 430, cx + 170, -182, 800], seat, 120),
            C(f"{p} Hinge", 'x', [-192, 425], 12, [cx - 120, cx + 120], 'chrome', 'f'),
            B(f"{p} Cistern", [cx - 200, -180, 380, cx + 200, 0, 790], 'china', 20),
            B(f"{p} Cistern Lid", [cx - 205, -185, 790, cx + 205, 0, 805], 'china', 20, 'f')]

def basin_side(p, xw, s, yc, rim=750):   # small hand-rinse basin on a side wall (face x = xw), with mixer and waste
    x0, x1 = sorted([xw, xw + s * 380])
    xi0, xi1 = sorted([xw + s * 60, xw + s * 340])
    return [B(f"{p} Body", [x0, yc - 220, rim - 150, x1, yc + 220, rim], 'china', 60),
            B(f"{p} Bowl", [xi0, yc - 170, rim - 4, xi1, yc + 170, rim + 1], 'white', 50, 'f'),
            C(f"{p} Mixer", 'z', [xw + s * 40, yc], 22, [rim, rim + 120], 'chrome'),
            C(f"{p} Spout", 'x', [yc, rim + 105], 10, sorted([xw + s * 40, xw + s * 170]), 'chrome', 'f'),
            B(f"{p} Lever", [min(xw + s * 30, xw + s * 50), yc + 20, rim + 90, max(xw + s * 30, xw + s * 50), yc + 140, rim + 102], 'chrome', 0, 'f'),
            C(f"{p} Trap", 'z', [xw + s * 120, yc], 22, [rim - 450, rim - 150], 'chrome', 'f')]

# ---------------------------------------------------------------- connectors
def CW(part, side='back'): return {"n": "CW", "domain": "pipe", "system": "DomesticColdWater", "part": part, "side": side, "diameter": 15, "flow": "In"}
def HW(part, side='back'): return {"n": "HW", "domain": "pipe", "system": "DomesticHotWater", "part": part, "side": side, "diameter": 15, "flow": "In"}
def SAN(part, d=100, side='back'): return {"n": "Waste", "domain": "pipe", "system": "Sanitary", "part": part, "side": side, "diameter": d, "flow": "Out"}
def MG(gas, part, side='back'): return {"n": gas, "domain": "pipe", "system": "Other", "part": part, "side": side, "diameter": 15, "flow": "Out" if gas in ("VAC", "AGSS") else "In"}
def E(part, side='back'): return {"n": "Power", "domain": "electrical", "system": "PowerBalanced", "part": part, "side": side}
def ELV(system, part, side='back'): return {"n": system, "domain": "electrical", "system": system, "part": part, "side": side}
def EV(v, va, poles=None):
    d = {"Voltage": v, "Apparent Load": va}
    if poles: d["Number of Poles"] = poles
    return d

P = []
def add(fam, desc, ifc, types, parts, values, about, category=None, template=None, connectors=(), clearances=(), tv=None, **extra):
    rec = RECS[fam]
    cat = category or rec['category']
    used = sorted({p['mat'] for p in parts if p.get('mat') and not p.get('void')})
    prod = {"family": fam, "category": cat, "template": template or "Metric Generic Model.rft", "desc": desc, "ifc": ifc,
            "keynote": rec['kn'], "types": [{"name": n, "desc": d} for n, d in types], "materials": {m: MAT[m] for m in used},
            "parts": parts, "reference": dict(rec['ref']), "values": values, "about": about}
    if connectors: prod["connectors"] = list(connectors)
    if clearances: prod["clearances"] = list(clearances)
    if tv: prod["type_values"] = tv
    prod.update(extra)
    P.append(prod)

# ================================================================= LIFTS
def lift(fam, car_w, car_d, door_w, door_h, kind):
    W, D, h = car_w / 2, car_d, door_h
    cb0, cb1 = 160, 160 + car_d + 100          # car body y range (behind the landing doors)
    ep = W + 60                                  # car body half width
    parts = [
        B("Landing Sill", [-door_w / 2 - 110, -70, 0, door_w / 2 + 110, 70, 10], 'alu'),
        F("Landing Jamb", [-door_w / 2 - 110, -45, 10, -door_w / 2, 0, h], 'ss', **rep(2, [door_w + 110, 0, 0])),
        F("Landing Head", [-door_w / 2 - 110, -45, h, door_w / 2 + 110, 0, h + 160], 'ss'),
        F("Landing Door Fast", [-door_w / 2, 4, 10, 15, 34, h], 'ss'),
        F("Landing Door Slow", [-15, 38, 10, door_w / 2, 68, h], 'ss'),
        F("Door Panel Joint", [12, 2, 10, 18, 4, h], 'dark', lod='f'),
        B("Car Sill", [-door_w / 2 - 40, 80, 0, door_w / 2 + 40, cb0, 10], 'alu', lod='f'),
        F("Car Door", [-door_w / 2, 100, 10, door_w / 2, 130, h], 'ss', lod='f'),
        B("Car Body", [-ep, cb0, 0, ep, cb1, 2450], 'galv', 20),
        B("Car Roof", [-ep - 20, cb0 - 20, 2450, ep + 20, cb1 + 20, 2520], 'dark'),
        B("Door Operator", [-door_w / 2 - 150, 90, 2450 - 220, door_w / 2 + 150, cb0, 2450], 'dark', lod='f'),
        C("Balustrade Post", 'z', [-ep + 40, cb1 - 40], 18, [2520, 3620], 'yellow', **rep(2, [2 * ep - 80, 0, 0])),
        C("Balustrade Post Mid", 'z', [-ep + 40, cb0 + 300], 18, [2520, 3620], 'yellow', **rep(2, [2 * ep - 80, 0, 0])),
        C("Balustrade Top Rail", 'x', [cb1 - 40, 3600], 18, [-ep + 40, ep - 40], 'yellow'),
        C("Balustrade Side Rail", 'y', [-ep + 40, 3600], 18, [cb0 + 300, cb1 - 40], 'yellow', **rep(2, [2 * ep - 80, 0, 0])),
        B("Car Top Station", [ep - 420, cb0 + 80, 2520, ep - 200, cb0 + 220, 2700], 'yellow', 10, 'f'),
        B("Stop Button", [ep - 340, cb0 + 70, 2620, ep - 280, cb0 + 80, 2680], 'red', lod='f'),
        B("Guide Rail Stem", [-ep - 140, cb0 + D / 2 - 8, -200, -ep - 80, cb0 + D / 2 + 8, 4200], 'steel', **rep(2, [2 * ep + 220, 0, 0])),
        B("Guide Rail Flange", [-ep - 150, cb0 + D / 2 - 60, -200, -ep - 140, cb0 + D / 2 + 60, 4200], 'steel', lod='f', **rep(2, [2 * ep + 290, 0, 0])),
        B("Guide Shoe", [-ep - 80, cb0 + D / 2 - 70, 2300, -ep, cb0 + D / 2 + 70, 2480], 'dark', lod='f', **rep(2, [2 * ep + 80, 0, 0])),
        B("Counterweight Frame", [-W * 0.55, cb1 + 120, 300, W * 0.55, cb1 + 300, 2300], 'dark'),
        B("Counterweight Fillers", [-W * 0.55 + 40, cb1 + 110, 360, W * 0.55 - 40, cb1 + 120, 2240], 'steel', lod='f'),
        B("Counterweight Rail", [-W * 0.55 - 70, cb1 + 180, -200, -W * 0.55 - 40, cb1 + 240, 4200], 'steel', **rep(2, [W * 1.1 + 110, 0, 0])),
        B("Machine", [ep - 520, cb1 + 60, 4200, ep + 60, cb1 + 360, 4520], 'dark', 30),
        C("Traction Sheave", 'y', [ep - 230, 4360], 190, [cb1 + 20, cb1 + 60], 'steel', 'f'),
        C("Ropes", 'z', [ep - 230, cb1 + 40], 25, [2520, 4200], 'dark', 'f'),
        F("Hall Call Station", [door_w / 2 + 220, -14, 950, door_w / 2 + 340, 0, 1300], 'ss', 6),
        C("Call Button", 'y', [door_w / 2 + 280, 1210], 15, [-22, -14], 'ledb', 'f', **rep(2, [0, 0, -90])),
        F("Braille Label", [door_w / 2 + 250, -16, 1010, door_w / 2 + 310, -14, 1030], 'black', lod='f'),
        F("Hall Lantern", [-260, -60, h + 175, 260, -45, h + 265], 'black', 6),
        F("Position Indicator", [-90, -62, h + 195, 90, -60, h + 245], 'red', 3, 'f'),
        F("Direction Arrow", [130, -62, h + 195, 200, -60, h + 245], 'green', 3, 'f'),
    ]
    if kind == 'goods':
        parts += [F("Landing Kick Plate", [-door_w / 2 + 10, -2, 10, door_w / 2 - 10, 4, 310], 'ss', lod='f'),
                  F("Load Notice", [-door_w / 2 - 300, -12, 1450, -door_w / 2 - 140, 0, 1650], 'yellow', 4, 'f'),
                  F("Load Notice Text", [-door_w / 2 - 280, -14, 1500, -door_w / 2 - 160, -12, 1560], 'black', 0, 'f')]
    else:
        parts += [F("Bed Lift Sign", [-door_w / 2 - 330, -12, 1450, -door_w / 2 - 150, 0, 1630], 'blue', 4, 'f'),
                  F("Bed Lift Sign Symbol", [-door_w / 2 - 300, -14, 1500, -door_w / 2 - 180, -12, 1570], 'white', 0, 'f'),
                  F("Fire Service Switch", [door_w / 2 + 220, -14, 1700, door_w / 2 + 340, 0, 1800], 'red', 4, 'f')]
    return parts

f = 'FMC_A_SpecEq_Lift_BedPassenger'
add(f, "Bed/passenger lift, machine-room-less, 1600 x 2700 car, 1300 x 2100 two-speed side-opening stainless doors, 2000 kg, 1.0 m/s",
    "IfcTransportElement", [("1600x2700_BedLift", "Bed lift car 1600 x 2700 mm, 2000 kg, MRL, 1300 mm doors")],
    lift(f, 1600, 2700, 1300, 2100, 'bed'),
    {"Car 1600 x 2700 mm internal": A("1600x2700", "bed + attendant, BS ISO 4190-1 bed lift class / HTM 08-02"),
     "Doors 1300 x 2100 mm two-speed side opening": A("1300x2100", "HTM 08-02 bed lift practice"),
     "Rated load 2000 kg, 1.0 m/s": A("2000 kg", "BS ISO 4190-1 car area for 1600 x 2700"),
     "Supply 415 V, 20 kVA": A(20000, "typical MRL gearless drive")},
    "Lift modelled as a generic product: stainless landing frame and two-speed doors, sill, hall call station, lantern and position "
    "indicator, car body behind with car-top balustrade and inspection station, T guide rails, counterweight and MRL machine in the "
    "headroom. Landing line at y = 0, car behind (+y), one storey of shaft equipment shown.",
    connectors=[E("Machine", 'top'), ELV("Communication", "Hall Call Station")], tv={**EV(415, 20000, 3)})

f = 'FMC_A_SpecEq_Lift_Goods_Service'
add(f, "Goods/service lift, machine-room-less, 1400 x 2400 car, 1100 x 2100 stainless doors with kick plates, 1600 kg",
    "IfcTransportElement", [("1400x2400_Goods", "Goods/service lift car 1400 x 2400 mm, 1600 kg, 1100 mm doors")],
    lift(f, 1400, 2400, 1100, 2100, 'goods'),
    {"Car 1400 x 2400 mm internal": A("1400x2400", "BS ISO 4190-1, 1600 kg"), "Doors 1100 x 2100 mm": A("1100x2100"),
     "Rated load 1600 kg": A(1600, "BS ISO 4190-1"), "Supply 415 V, 15 kVA": A(15000, "typical MRL drive")},
    "Goods lift modelled as a generic product: as the bed lift, with kick plates on the landing doors and a load notice; car, rails, "
    "counterweight and MRL machine behind the landing line (y = 0).",
    connectors=[E("Machine", 'top')], tv={**EV(415, 15000, 3)})

f = 'FMC_A_SpecEq_Lift_Dumbwaiter'
dw = [
    B("Shaft Casing", [-420, 40, 0, 420, 820, 2700], 'ss', 0),
    F("Hatch Frame", [-400, -40, 700, 400, 0, 1650], 'ss', 8),
    F("Hatch Opening", [-320, -41, 780, 320, -40, 1560], 'black', 0, 'f'),
    F("Hatch Door Upper", [-310, -60, 1180, 310, -42, 1550], 'ss', 4),
    F("Hatch Door Lower", [-310, -60, 790, 310, -42, 1170], 'ss', 4),
    F("Door Meeting Rail", [-310, -66, 1166, 310, -60, 1184], 'rubber', 0, 'f'),
    F("Door Handle", [-120, -80, 1190, 120, -66, 1210], 'chrome', 6, 'f'),
    B("Serving Sill", [-400, -170, 760, 400, 0, 790], 'ss', 15),
    B("Car", [-300, 120, 790, 300, 720, 1600], 'galv', 10),
    B("Car Shelf", [-290, 110, 1180, 290, 720, 1190], 'galv', 0, 'f'),
    B("Guide Rail", [-370, 380, 0, -340, 460, 2700], 'steel', **rep(2, [710, 0, 0])),
    B("Drive Unit", [-300, 120, 2400, 300, 720, 2650], 'dark', 20),
    F("Call Panel", [460, -14, 1150, 560, 0, 1400], 'ss', 6),
    C("Call Button", 'y', [510, 1340], 13, [-22, -14], 'ledb', 'f', **rep(3, [0, 0, -60])),
    F("In Use Lamp", [470, -16, 1410, 550, -14, 1440], 'red', 3, 'f'),
    F("Station Label", [-150, -16, 1600, 150, -14, 1630], 'black', 0, 'f'),
]
add(f, "Dumbwaiter 100 kg, 600 x 600 car, serving hatch at worktop height with bi-parting stainless doors, call station",
    "IfcTransportElement", [("600x600_Dumbwaiter", "Dumbwaiter 600 x 600 x 800 mm car, 100 kg, counter-level hatch")], dw,
    {"Car 600 x 600 x 800 mm": A("600x600x800", "specimen/pharmacy dumbwaiter class"), "Rated load 100 kg": A(100),
     "Hatch sill 790 mm (counter level)": A(790), "Supply 240 V, 1.5 kVA": A(1500)},
    "Dumbwaiter modelled as a generic product: stainless serving hatch with bi-parting doors and sill, car with shelf, rails and "
    "drive unit inside a stainless casing behind the wall line (y = 0), call station with lit buttons.",
    connectors=[E("Drive Unit", 'top')], tv={**EV(240, 1500), "Default Elevation": 0})

# ================================================================= CUBICLES
def cubicle(w, d, door_w, outward=False, p=''):
    hw = w / 2; t = 13
    yf = -d
    pil = (w - door_w) / 2
    parts = [
        B("Side Panel", [-hw, yf, 150, -hw + t, 0, 2000], 'hpl', **rep(2, [w - t, 0, 0])),
        B("Wall Channel", [-hw - 20, -40, 150, -hw - 0, 0, 2000], 'alu', lod='f'),
        B("Wall Channel Right", [hw, -40, 150, hw + 20, 0, 2000], 'alu', lod='f'),
        B("Pilaster Left", [-hw, yf - t, 150, -hw + pil, yf, 2000], 'hpl'),
        B("Pilaster Right", [hw - pil, yf - t, 150, hw, yf, 2000], 'hpl'),
        F("Door Leaf", [-hw + pil + 3, yf - t - (2 if outward else 0), 170, hw - pil - 3, yf - (2 if outward else 0), 1990], 'hpl', 6),
        C("Head Rail", 'x', [yf - 7, 2020], 20, [-hw - 10, hw + 10], 'alu'),
        C("Head Rail Return", 'y', [-hw + 6, 2020], 20, [yf - 7, -20], 'alu', **rep(2, [w - 12, 0, 0])),
        C("Pedestal Foot", 'z', [-hw + pil / 2, yf - 6], 18, [0, 150], 'ss', **rep(2, [w - pil, 0, 0])),
        C("Foot Shroud", 'z', [-hw + pil / 2, yf - 6], 26, [0, 25], 'ss', 'f', **rep(2, [w - pil, 0, 0])),
        C("Side Foot", 'z', [-hw + 6, yf + 60], 16, [0, 150], 'ss', 'f', **rep(2, [w - 12, 0, 0])),
        B("Hinge", [hw - pil - 6, yf - t - 4, 1800, hw - pil + 6, yf + 2, 1900], 'ss', 0, 'f', **rep(3, [0, 0, -800])),
        F("Indicator Bolt", [-hw + pil + 30, yf - t - 6, 1000, -hw + pil + 90, yf - t, 1060], 'ss', 8, 'f'),
        F("Indicator Window", [-hw + pil + 45, yf - t - 7, 1018, -hw + pil + 75, yf - t - 6, 1042], 'red', 4, 'f'),
        C("Door Knob", 'y', [-hw + pil + 60, 960], 14, [yf - t - 50, yf - t], 'ss', 'f'),
        F("Coat Hook Plate", [-hw + pil + 40, yf + 1, 1700, -hw + pil + 80, yf + 6, 1740], 'ss', 6, 'f'),
        F("Door Sign", [-40, yf - t - 3, 1500, 40, yf - t - 1, 1580], 'grey', 6, 'f'),
    ]
    return parts

f = 'FMC_A_SpecEq_ToiletCubicle_HPL'
add(f, "Toilet cubicle, 12 mm compact HPL panels on stainless pedestal feet, aluminium head rail, indicator bolt, rising hinges",
    "IfcBuildingElementProxy", [("900x1500_HPL", "WC cubicle 900 x 1500 mm, 12 mm compact HPL, 600 mm door"),
                                ("1000x1700_HPL", "WC cubicle 1000 x 1700 mm, 12 mm compact HPL, 650 mm door")],
    only("900x1500_HPL", cubicle(900, 1500, 600), "900") + only("1000x1700_HPL", cubicle(1000, 1700, 650), "1000") + wc_pan(0, 'WC', 'white'),
    {"Cubicle 900 x 1500 or 1000 x 1700 mm, panels 2000 high on 150 feet": A("900x1500/1000x1700", "BS 6465-2 minimum activity space"),
     "Compact HPL 12 mm": A(12, "record note"), "Door 600 / 650 mm, inward opening": A("600/650", "BS 6465-2")},
    "Cubicle modelled as a generic product: HPL side panels and pilasters on stainless feet, door with rising hinges, indicator bolt "
    "and knob, round aluminium head rail with returns to the wall, wall channels, coat hook; a WC pan shows the use (the pan is a "
    "separate plumbing fixture in the project). Back wall at y = 0. Each type has its own panels, door and rail (Show parameters); "
    "the WC is shared.")

f = 'FMC_A_SpecEq_ToiletCubicle_Ambulant'
amb = cubicle(900, 1700, 700, outward=True) + wc_pan(0, 'WC', 'white')
amb += rail_y("Side Rail Left", -450 + 13, +1, -1100, -500, 680) + rail_yz("Vertical Rail Left", -450 + 13, +1, -850, 800, 1400)
amb += rail_y("Side Rail Right", 450 - 13, -1, -1100, -500, 680) + rail_yz("Vertical Rail Right", 450 - 13, -1, -850, 800, 1400)
add(f, "Ambulant WC cubicle 900 x 1700, compact HPL, outward-opening door, horizontal and vertical grab rails on both side panels",
    "IfcBuildingElementProxy", [("900x1700_Ambulant", "Ambulant WC cubicle 900 x 1700 mm, outward door, grab rails both sides")], amb,
    {"Cubicle 900 x 1700 mm (min 800 wide)": A("900x1700", "Approved Document M / BS 8300-2 ambulant cubicle"),
     "Grab rails 600 at 680 mm, vertical 600 rails": A(680, "BS 8300-2 figure, ambulant cubicle"),
     "Door outward opening": A("outward", "record note")},
    "Ambulant cubicle modelled as a generic product: HPL panels on feet, outward-opening door, head rail, indicator bolt; on each side "
    "panel a horizontal and a vertical 32 mm stainless grab rail; WC pan for context. Back wall at y = 0.")

f = 'FMC_A_SpecEq_ToiletCubicle_Accessible_Assembly'
xw = -750   # side wall
acc = wc_pan(-250, 'WC', 'blue')
acc += [B("Flush Lever", [-60, -150, 700, -40, -100, 720], 'chrome', 0, 'f')]
acc += rail_y("Side Wall Rail", xw, +1, -1000, -400, 680)
acc += rail_yz("Side Wall Vertical", xw, +1, -1050, 800, 1400)
acc += [F("Drop Down Plate", [40, -12, 560, 160, 0, 960], 'ss', 10),
        B("Drop Down Hinge", [60, -90, 640, 140, -12, 800], 'ss', 20),
        C("Drop Down Top", 'y', [100, 780], R32, [-830, -90], 'ss'),
        C("Drop Down Bottom", 'y', [100, 660], R32, [-830, -90], 'ss'),
        C("Drop Down Nose", 'z', [100, -830], R32, [660, 780], 'ss'),
        C("Roll Holder", 'x', [-500, 610], 55, [55, 150], 'white', 'f')]
acc += basin_side("Basin", xw, +1, -1250, 720)
acc += [B("Mirror", [xw, -1450, 1000, xw + 6, -1050, 1900], 'mirror'),
        B("Alarm Pull Switch", [xw, -760, 2150, xw + 30, -700, 2210], 'white', 0, 'f'),
        C("Alarm Cord", 'z', [xw + 20, -730], 3, [120, 2150], 'red', 'f'),
        C("Cord Bangle", 'z', [xw + 20, -730], 25, [900, 915], 'red', 'f', **rep(2, [0, 0, -780])),
        B("Alarm Reset Unit", [xw, -1950, 1150, xw + 18, -1870, 1230], 'white', 0, 'f'),
        B("Reset Lamp", [xw + 18, -1925, 1205, xw + 20, -1895, 1220], 'red', 0, 'f'),
        B("Paper Towel Dispenser", [xw, -1700, 1000, xw + 110, -1420, 1350], 'white', 20, 'f'),
        B("Sanitary Bin", [-720, -400, 0, -560, -220, 380], 'grey', 30, 'f')]
add(f, "Accessible WC assembly (Doc M pack) 1500 x 2200: back-to-wall WC with low cistern, drop-down and side rails, corner basin, "
       "emergency assistance alarm, mirror, towel dispenser; 1500 turning circle",
    "IfcElementAssembly", [("1500x2200_Accessible", "Accessible WC 1500 x 2200 mm, Doc M layout, outward door (door in the wall)"),
                           ("1700x2200_Accessible", "Accessible WC 1700 x 2200 mm, Doc M layout, wider transfer space")], acc,
    {"Room 1500 x 2200 mm": A("1500x2200", "Approved Document M fig 18 / BS 8300-2"), "WC centre 500 mm from side wall": A(500, "Approved Document M"),
     "Seat height 480 mm, rails at 680 mm": A(480, "Approved Document M"), "Turning circle 1500 mm": A(1500, "BS 8300-2")},
    "Accessible WC modelled as a generic assembly in a 1500 x 2200 room (back wall y = 0, side wall x = -750, room walls and door "
    "are not part of the family; the 1700 type only moves the opposite wall, so both types share the fittings): WC with contrasting seat and raised lid, cistern, flush lever on the transfer side, hinged drop-down "
    "rail with roll holder, side-wall horizontal and vertical rails, corner hand-rinse basin with mixer, mirror, pull cord with two "
    "bangles, alarm reset unit, towel dispenser, sanitary bin; turning circle on Clearance Accessibility.",
    connectors=[CW("WC Cistern"), SAN("WC Pedestal", 100), ELV("NurseCall", "Alarm Reset Unit")],
    clearances=[{"n": "Turning Circle", "shape": "cyl", "axis": "z", "c": [0, -1450], "r": 750, "z": [0, 10], "sub": "Clearance Accessibility"}])

f = 'FMC_A_SpecEq_ChangingPlaces_Unit'
xl, xr = -1500, 1500
cp = wc_pan(0, 'WC', 'blue')
for side, xc in (("Left", -330), ("Right", 330)):
    cp += [F(f"Drop Rail Plate {side}", [xc - 60, -12, 560, xc + 60, 0, 960], 'ss', 10),
           B(f"Drop Rail Hinge {side}", [xc - 40, -90, 640, xc + 40, -12, 800], 'ss', 20),
           C(f"Drop Rail Top {side}", 'y', [xc, 780], R32, [-830, -90], 'ss'),
           C(f"Drop Rail Bottom {side}", 'y', [xc, 660], R32, [-830, -90], 'ss'),
           C(f"Drop Rail Nose {side}", 'z', [xc, -830], R32, [660, 780], 'ss')]
cp += [  # height-adjustable changing bench on the left wall
    B("Bench Wall Frame", [xl, -2700, 300, xl + 60, -900, 1000], 'epoxy', 10),
    B("Bench Lift Column", [xl + 60, -2000, 300, xl + 160, -1600, 720], 'epoxy', 10),
    B("Bench Top", [xl + 60, -2700, 720, xl + 860, -900, 800], 'vinyl', 40),
    C("Bench Side Rail", 'y', [xl + 840, 870], 15, [-2600, -1000], 'ss', 'f'),
    C("Bench Rail Post", 'z', [xl + 840, -2600], 15, [800, 870], 'ss', 'f', **rep(2, [0, 1600, 0])),
    B("Bench Control", [xl + 60, -880, 900, xl + 90, -820, 1000], 'white', 0, 'f'),
    # height-adjustable basin on the right wall
    B("Basin Carriage", [xr - 60, -1500, 600, xr, -900, 1000], 'epoxy', 10),
] + basin_side("Basin", xr - 60, -1, -1200, 800) + [
    B("Mirror", [xr - 6, -1450, 1050, xr, -950, 1900], 'mirror'),
    # shower on the right wall

    # privacy screen (folding)
] + [
    FR("Privacy Screen", [[-300, 150], [500, 150], [500, 1800], [-300, 1800]], [-3150, -3125], 'curtainp'),
    C("Screen Frame Post", 'z', [-310, -3140], 15, [0, 1820], 'ss', **rep(2, [820, 0, 0])),
    C("Screen Foot", 'y', [-310, 15], 15, [-3350, -2930], 'ss', 'f', **rep(2, [820, 0, 0])),
    # ceiling hoist: two fixed rails on wall brackets at 2400, one traverse rail, motor unit
    B("Rail Wall Bracket", [xl, -2050, 2280, xl + 80, -1950, 2440], 'alu', 0, 'f', **rep(2, [2920, 0, 0])),
    B("Traverse Rail", [xl + 70, -1680, 2340, xr - 70, -1560, 2420], 'alu'),
    B("Traverse Carriage", [xl + 20, -1720, 2300, xl + 120, -1520, 2440], 'white', 10, 'f', **rep(2, [2860, 0, 0])),
    B("Hoist Motor", [-180, -1720, 2050, 180, -1520, 2340], 'white', 40),
    B("Hoist Strap", [-20, -1625, 1450, 20, -1615, 2050], 'blue', 0, 'f'),
    C("Spreader Bar", 'x', [-1620, 1430], 18, [-260, 260], 'grey'),
    ball("Spreader Hook", 'x', [-1620, 1430], -260, 30, 'grey', **rep(2, [520, 0, 0])),
    B("Hand Control", [200, -1650, 1200, 260, -1600, 1360], 'white', 15, 'f'),
    C("Hand Control Cord", 'z', [230, -1625], 4, [1360, 2050], 'black', 'f'),
    B("Charger", [xl + 70, -260, 2250, xl + 160, -120, 2420], 'white', 10, 'f'),
    B("Alarm Reset Unit", [xr - 18, -400, 1150, xr, -320, 1230], 'white', 0, 'f'),
    C("Alarm Cord", 'z', [xr - 30, -1900], 3, [120, 2200], 'red', 'f'),
]
for tn, dy, sfx in (("3000x4000_ChangingPlaces", 0, "4000"), ("3000x3700_ChangingPlaces", 300, "3700")):
    cp += only(tn, [B("Shower Mixer", [xr - 70, -2700 + dy, 1000, xr, -2500 + dy, 1100], 'chrome', 20),
                    C("Shower Riser", 'z', [xr - 50, -2600 + dy], 12, [1100, 2000], 'chrome'),
                    C("Shower Head", 'x', [-2600 + dy, 1700], 40, [xr - 120, xr - 60], 'chrome', 'f'),
                    B("Shower Floor", [xr - 1100, -3600 + dy, 0, xr, -2300 + dy, 4], 'safety'),
                    B("Floor Gully", [xr - 900, -2990 + dy, 4, xr - 100, -2950 + dy, 6], 'ss', 0, 'f'),
                    B("Hoist Fixed Rail", [xl, -3900 + dy, 2350, xl + 70, -100, 2420], 'alu', **rep(2, [2930, 0, 0]))], sfx)
add(f, "Changing Places toilet 3000 x 4000 (BS 8300-2): peninsular WC with two drop-down rails, height-adjustable bench and basin, "
       "XY ceiling hoist, shower, privacy screen, alarm",
    "IfcElementAssembly", [("3000x4000_ChangingPlaces", "Changing Places 3000 x 4000 mm, 2400 mm ceiling, XY hoist"),
                           ("3000x3700_ChangingPlaces", "Changing Places 3000 x 3700 mm (existing-building variant)")], cp,
    {"Room 3000 x 4000 mm, 2400 high": A("3000x4000", "BS 8300-2 Changing Places / changing-places.org"),
     "Bench 1800 x 800 mm, height adjustable": A("1800x800", "BS 8300-2"), "Hoist covering whole room, SWL 200 kg": A(200, "BS 8300-2"),
     "Peninsular WC 1000 mm from side wall": A(1000, "BS 8300-2"), "Supply 240 V, 1 kVA (bench, basin, hoist charger)": A(1000)},
    "Changing Places modelled as a generic assembly (back wall y = 0, side walls x = +-1500; room walls not part of the family): "
    "peninsular WC with contrasting seat and drop-down rails both sides, wall bench on a lift column with side rail, height-adjustable "
    "basin with mirror, shower area with riser and gully, folding privacy screen, XY hoist rails on wall brackets with traverse, motor, "
    "strap, spreader bar and hand control, charger, alarm cord and reset; turning circle on Clearance Accessibility. The shower area "
    "and hoist rails are per type (3700 room: shower 300 mm nearer the back wall, rails 300 shorter).",
    connectors=[CW("WC Cistern"), HW("Basin Mixer", 'back'), SAN("WC Pedestal", 100), E("Bench Lift Column")],
    clearances=[{"n": "Turning Circle", "shape": "cyl", "axis": "z", "c": [0, -2100], "r": 750, "z": [0, 10], "sub": "Clearance Accessibility"}],
    tv={**EV(240, 1000)})

f = 'FMC_A_SpecEq_ShowerCubicle_Accessible'
xl = -600
sh = [
    B("Wet Floor", [-600, -1500, 0, 600, 0, 4], 'safety'),
    B("Linear Gully", [-500, -60, 4, 500, -20, 6], 'ss', 0, 'f'),
    B("Gully Body", [-520, -70, -90, 520, -10, 0], 'ss', 0, 'm'),
    # fold-down seat on the left wall
    B("Seat Wall Plate", [xl, -900, 300, xl + 12, -500, 620], 'ss', 0),
    B("Seat Pad", [xl + 12, -910, 480, xl + 462, -490, 520], 'white', 30),
    B("Seat Leg", [xl + 420, -880, 0, xl + 450, -850, 480], 'ss', 0, 'mf', **rep(2, [0, 330, 0])),
    C("Seat Hinge", 'y', [xl + 30, 470], 15, [-900, -500], 'ss', 'f'),
    # thermostatic mixer, riser rail and hand shower on the back wall
    F("Mixer Body", [-180, -80, 1000, 180, 0, 1080], 'chrome', 35),
    C("Mixer Knob", 'y', [-130, 1040], 32, [-110, -80], 'chrome', 'f', **rep(2, [260, 0, 0])),
    C("Lever Handle", 'y', [-130, 1040], 8, [-150, -110], 'chrome', 'f'),
    C("Riser Rail", 'z', [0, -50], 12, [1100, 2000], 'chrome'),
    C("Riser Bracket", 'y', [0, 1100], 18, [-60, 0], 'chrome', 'f', **rep(2, [0, 0, 900])),
    B("Slider", [-25, -80, 1650, 25, -30, 1720], 'white', 10, 'f'),
    C("Hand Shower", 'z', [0, -130], 45, [1680, 1720], 'chrome'),
    C("Shower Hose", 'z', [60, -60], 6, [1000, 1650], 'chrome', 'f'),
    # grab rails
] + rail_x("Horizontal Rail", 250, 550, 900) + rail_yz("Vertical Rail", xl, +1, -1150, 800, 1400) + [
    # curtain track wall to wall across the front at 2000 mm, curtain partly drawn
    C("Curtain Track", 'x', [-1450, 2000], 12, [-600, 600], 'alu'),
    B("Track End Bracket", [-600, -1480, 1985, -585, -1420, 2015], 'alu', 0, 'f', **rep(2, [1185, 0, 0])),
    PR("Curtain", [[x, -1450 + (12 if i % 2 else -12)] for i, x in enumerate(range(150, 601, 50))] +
       [[x, -1450 + (12 if i % 2 else -12) + 4] for i, x in reversed(list(enumerate(range(150, 601, 50))))], [300, 1985], 'curtainp'),
    B("Soap Shelf", [400, -120, 1150, 560, 0, 1170], 'ss', 0, 'f'),
]
add(f, "Level-access accessible shower area 1200 x 1500: wet-room floor and linear gully, fold-down seat, thermostatic mixer with riser "
       "rail and hand shower, grab rails, wall-to-wall curtain track and curtain",
    "IfcElementAssembly", [("1200x1500_LevelAccess", "Accessible shower area 1200 x 1500 mm, level access, fold-down seat")], sh,
    {"Shower area 1200 x 1500 mm": A("1200x1500", "BS 8300-2 / Approved Document M shower room"), "Seat 450 x 400 mm at 480 mm": A(480, "Approved Document M"),
     "Thermostatic mixer at 1000 mm, TMV3": A(1000, "HTM 04-01 / Approved Document M"), "Curtain track at 2000 mm": A(2000)},
    "Accessible shower modelled as a generic assembly (back wall y = 0, seat wall x = -600): safety floor with linear gully, fold-down "
    "seat with legs, thermostatic mixer with two knobs and lever, riser rail with slider and hand shower, horizontal and vertical grab "
    "rails, pleated curtain on a wall-to-wall track.",
    connectors=[CW("Mixer Body"), HW("Mixer Body"), SAN("Gully Body", 50, 'bottom')])

# ================================================================= SANITARY ACCESSORIES
f = 'FMC_A_SpecEq_GrabRail_Straight'
gs = []
for Lr in (300, 450, 600, 900):
    gs += only(f"{Lr}_SS", rail_x("Rail", -Lr / 2, Lr / 2, 0) + [C("Fixing Screw", 'y', [-Lr / 2, 0], 4, [-10, -9], 'chrome', 'f', **rep(2, [Lr, 0, 0]))], str(Lr))
add(f, "Straight grab rail, 32 mm brushed stainless tube, 50 mm clear of the wall, concealed-fixing flanges with cover rosettes",
    "IfcDiscreteAccessory", [(f"{L}_SS", f"Straight grab rail {L} mm centres, 32 mm stainless steel, concealed fixings") for L in (300, 450, 600, 900)], gs,
    {"Tube 32 mm, 50 mm clear of wall": A(32, "BS 8300-2"), "Mounting height 800 mm (centreline)": A(800, "Approved Document M"),
     "Length 300/450/600/900 mm centres": A("300-900", "record types")},
    "Grab rail modelled as a generic product: tube, returns with bends to the wall, flanges with rosettes. Centreline at z = 0, height "
    "set by Default Elevation; each length is its own set of parts (Show parameters).", tv={"Default Elevation": 800})

f = 'FMC_A_SpecEq_GrabRail_DropDown'
dd = [F("Wall Plate", [-60, -12, -220, 60, 0, 180], 'ss', 10),
      C("Wall Plate Screw", 'y', [-35, 150], 5, [-14, -12], 'chrome', 'f', **rep(2, [70, 0, 0])),
      C("Wall Plate Screw Low", 'y', [-35, -190], 5, [-14, -12], 'chrome', 'f', **rep(2, [70, 0, 0])),
      B("Hinge Housing", [-45, -95, -150, 45, -12, 40], 'ss', 25),
      C("Hinge Pin", 'x', [-60, 20], 10, [-50, 50], 'chrome', 'f'),
      C("Roll Holder Spindle", 'x', [-300, -170], 8, [-60, 60], 'chrome', 'f'),
      B("Roll Holder Arm", [-6, -320, -175, 6, -280, -120], 'chrome', 0, 'f'),
      C("Toilet Roll", 'x', [-300, -170], 55, [-55, 55], 'white', 'f')]
for Pj in (750, 850):
    dd += only(f"{Pj}_DropDown", [C("Arm Top", 'y', [0, 0], R32, [-Pj, -95], 'ss'),
                                  C("Arm Bottom", 'y', [0, -120], R32, [-(Pj - 30), -95], 'ss'),
                                  ball("Arm Bend Top", 'y', [0, 0], -Pj, R32, 'ss', 'mf'),
                                  C("Arm Nose", 'z', [0, -(Pj - 10)], R32, [-110, 0], 'ss'),
                                  ball("Arm Bend Bottom", 'z', [0, -(Pj - 22)], -120, R32, 'ss', 'mf'),
                                  B("Flush Button", [-20, -(Pj + 10), 15, 20, -(Pj - 50), 30], 'blue', 8, 'f')], str(Pj))
add(f, "Hinged drop-down support rail 750 mm, 32 mm stainless loop, wall plate with hinge housing, toilet-roll holder, remote flush button",
    "IfcDiscreteAccessory", [("750_DropDown", "Drop-down support rail 750 mm projection, stainless, roll holder"),
                             ("850_DropDown", "Drop-down support rail 850 mm projection, stainless, roll holder")], dd,
    {"Projection 750 mm": A(750, "Approved Document M (rail extends beyond the WC pan front)"), "Top of rail 680 mm above floor": A(680, "Approved Document M"),
     "Tube 32 mm": A(32, "BS 8300-2")},
    "Drop-down rail modelled as a generic product: wall plate with screws, hinge housing and pin, looped arm (top and bottom tubes, nose, "
    "bends), roll holder with roll, flush button at the nose. Top tube at z = 0; Default Elevation 680; the arm is per type (750 / 850).",
    tv={"Default Elevation": 680})

f = 'FMC_A_SpecEq_GrabRail_LShape'
ls = [C("Horizontal Tube", 'x', [-OFF, 0], R32, [-300, 300], 'ss'),
      C("Vertical Tube", 'z', [300, -OFF], R32, [0, 600], 'ss'),
      ball("Corner Bend", 'y', [300, 0], -OFF, R32, 'ss', 'mf'),
      C("Return", 'y', [-300, 0], R32, [-OFF, -8], 'ss'),
      C("Return Corner", 'y', [300, 0], R32, [-OFF, -8], 'ss'),
      C("Return Top", 'y', [300, 600], R32, [-OFF, -8], 'ss'),
      ball("End Bend", 'y', [-300, 0], -OFF, R32, 'ss'),
      ball("Top Bend", 'y', [300, 600], -OFF, R32, 'ss'),
      T("Flange", 'y', [-300, 0], [[0, 0], [36, 0], [36, -4], [30, -9], [0, -9]], 'ss'),
      T("Flange Corner", 'y', [300, 0], [[0, 0], [36, 0], [36, -4], [30, -9], [0, -9]], 'ss'),
      T("Flange Top", 'y', [300, 600], [[0, 0], [36, 0], [36, -4], [30, -9], [0, -9]], 'ss'),
      C("Grip Band", 'x', [-OFF, 0], R32 + 1, [-150, 150], 'chrome', 'f')]
add(f, "L-shaped shower grab rail 600 x 600, 32 mm stainless, three concealed-fixing flanges",
    "IfcDiscreteAccessory", [("600x600_LShape", "L-shaped grab rail 600 x 600 mm, 32 mm stainless steel")], ls,
    {"Legs 600 x 600 mm": A("600x600"), "Tube 32 mm, 50 mm clear": A(32, "BS 8300-2"), "Horizontal leg at 900 mm": A(900, "shower practice")},
    "L rail modelled as a generic product: horizontal and vertical tubes, bends, three returns with flanges, polished grip band. "
    "Horizontal centreline at z = 0; Default Elevation 900.", tv={"Default Elevation": 900})

f = 'FMC_A_SpecEq_BackrestPad_WC'
add(f, "WC backrest pad 400 x 200, padded vinyl cushion on a stainless wall plate",
    "IfcDiscreteAccessory", [("400x200_Backrest", "WC backrest 400 x 200 mm, vinyl pad, stainless plate")],
    [F("Wall Plate", [-170, -10, 15, 170, 0, 185], 'ss', 8),
     F("Spacer", [-120, -40, 50, 120, -10, 150], 'ss', 6),
     F("Pad", [-200, -95, 0, 200, -40, 200], 'vinyl', 40),
     F("Pad Face", [-185, -98, 12, 185, -95, 188], 'vinyl', 34, 'f'),
     F("Pad Seam", [-200, -70, 0, 200, -65, 200], 'black', 40, 'f'),
     C("Screw", 'y', [-150, 30], 4, [-12, -10], 'chrome', 'f', **rep(2, [300, 0, 0])),
     C("Screw Top", 'y', [-150, 170], 4, [-12, -10], 'chrome', 'f', **rep(2, [300, 0, 0]))],
    {"Pad 400 x 200 mm": A("400x200"), "Projection 95 mm": A(95), "Bottom at 750 mm (behind low cistern)": A(750, "Approved Document M backrest")},
    "Backrest modelled as a generic product: stainless wall plate with screws, spacer, padded vinyl cushion with face panel and seam. "
    "Default Elevation 750.", tv={"Default Elevation": 750})

f = 'FMC_A_SpecEq_Mirror_Tilting_Accessible'
mt = [RT("Frame", [[-30, 0], [-12, 0], [-110, 700], [-128, 700]], [-250, 250], 'ss'),
      RT("Mirror Glass", [[-33, 15], [-31, 15], [-126, 685], [-128, 685]], [-235, 235], 'mirror'),
      F("Top Wall Bracket", [-200, -10, 640, 200, 0, 720], 'ss', 6),
      RT("Tilt Arm", [[-10, 690], [-10, 710], [-120, 710], [-120, 690]], [-230, -215], 'ss', **rep(2, [445, 0, 0])),
      C("Tilt Knob", 'x', [-120, 700], 10, [-245, -230], 'chrome', 'f', **rep(2, [475, 0, 0])),
      F("Bottom Pivot", [-60, -32, -10, 60, 0, 25], 'ss', 6),
      C("Pivot Pin", 'x', [-20, 8], 6, [-70, 70], 'chrome', 'f')]
add(f, "Tilting mirror 500 x 700 for wheelchair users, brushed stainless frame, adjustable tilt arms",
    "IfcDiscreteAccessory", [("500x700_Tilting", "Tilting mirror 500 x 700 mm, stainless frame")], mt,
    {"Mirror 500 x 700 mm": A("500x700"), "Bottom edge 900 mm, top 1600+ mm": A(900, "Approved Document M / BS 8300-2"), "Tilt up to 100 mm at top": A(100)},
    "Tilting mirror modelled as a generic product: stainless frame and glass tilted forward at the top, bottom pivot, top wall bracket "
    "with tilt arms and knobs. Default Elevation 900.", tv={"Default Elevation": 900})

# ================================================================= TRACKS AND HOISTS
f = 'FMC_A_SpecEq_CurtainTrack_Bed_Cubicle'
Rr = 300
def track_run(X, Y):
    return [B("Track Left", [-X - 15, Y + Rr, -28, -X + 15, -300, 0], 'alu'),
            B("Track Front", [-X + Rr, Y - 15, -28, X - Rr, Y + 15, 0], 'alu'),
            B("Track Right", [X - 15, Y + Rr, -28, X + 15, -300, 0], 'alu'),
            PR("Bend Left", ring_sector(-X + Rr, Y + Rr, Rr - 15, Rr + 15, 180, 270), [-28, 0], 'alu'),
            PR("Bend Right", ring_sector(X - Rr, Y + Rr, Rr - 15, Rr + 15, 270, 360), [-28, 0], 'alu'),
            C("Ceiling Fixing Left", 'z', [-X, -600], 22, [-6, 0], 'white', 'f', **rep(3, [0, -700, 0])),
            C("Ceiling Fixing Front", 'z', [-600, Y], 22, [-6, 0], 'white', 'f', **rep(3, [600, 0, 0])),
            C("Ceiling Fixing Right", 'z', [X, -600], 22, [-6, 0], 'white', 'f', **rep(3, [0, -700, 0])),
            B("End Stop", [-X - 18, -330, -32, -X + 18, -300, 0], 'white', 0, 'f', **rep(2, [2 * X, 0, 0])),
            pleats(-X, -1400, -340, -2350, -560, 'Curtain Stack Left'), pleats(-X, -1400, -340, -560, -40, 'Mesh Top Left', 'white'),
            pleats(X, -1400, -340, -2350, -560, 'Curtain Stack Right'), pleats(X, -1400, -340, -560, -40, 'Mesh Top Right', 'white'),
            C("Glider Left", 'z', [-X, -1380], 8, [-40, -20], 'white', 'f', **rep(6, [0, 200, 0])),
            C("Glider Right", 'z', [X, -1380], 8, [-40, -20], 'white', 'f', **rep(6, [0, 200, 0]))]
def pleats(x, y0, y1, z0, z1, n, mat='curtain'):
    ys = list(range(int(y0), int(y1) + 1, 40)); pts = [[x + (14 if i % 2 else -14), yy] for i, yy in enumerate(ys)]
    return PR(n, pts + [[px + 4, py] for px, py in reversed(pts)], [z0, z1], mat)
ct = only("2400x2600_U", track_run(1200, -2600), "2400") + only("3000x3000_U", track_run(1500, -3000), "3000")
add(f, "Bed-space cubicle curtain track, U-shaped, ceiling-fixed aluminium track with radius bends, gliders and disposable "
       "curtains with mesh top",
    "IfcDiscreteAccessory", [("2400x2600_U", "Cubicle curtain track U 2400 x 2600 mm around one bed, disposable curtains"),
                             ("3000x3000_U", "Cubicle curtain track U 3000 x 3000 mm around one bed, disposable curtains")], ct,
    {"Track U 2400 x 2600 or 3000 x 3000 from the bedhead wall": A("2400x2600/3000x3000", "HBN 04-01 multi-bed bay bed space"),
     "Curtain drop to 300 mm above floor, 500 mm mesh top": A(500, "HBN 04-01 / HTM 05-02 practice"),
     "Bend radius 300 mm": A(300)},
    "Curtain track modelled as a generic product hanging below the ceiling (z = 0): three straight runs with 300 radius bends, ceiling "
    "fixings, end stops, gliders, two pleated curtain stacks drawn back to the bedhead wall (y = 0) with mesh tops. Each size is its "
    "own set of parts (Show parameters).")

f = 'FMC_A_SpecEq_IVTrack_Ceiling'
iv = [B("Track", [-1200, -15, -30, 1200, 15, 0], 'alu', 6),
      B("End Cap", [-1215, -18, -32, -1200, 18, 0], 'white', 0, 'mf', **rep(2, [2415, 0, 0])),
      C("Ceiling Fixing", 'z', [-1000, 0], 22, [-6, 0], 'white', 'f', **rep(5, [500, 0, 0])),
      B("Carrier", [-560, -22, -60, -440, 22, -28], 'white', 10, **rep(2, [900, 0, 0])),
      C("Carrier Wheel", 'x', [0, -25], 10, [-550, -450], 'castor', 'f', **rep(2, [900, 0, 0])),
      C("Drop Rod", 'z', [-500, 0], 10, [-1000, -60], 'ss', **rep(2, [900, 0, 0])),
      C("Rod Collar", 'z', [-500, 0], 14, [-640, -600], 'ss', 'f', **rep(2, [900, 0, 0])),
      T("Hook Crown", 'z', [-500, 0], [[0, -1020], [16, -1020], [16, -1000], [0, -1000]], 'ss', **rep(2, [900, 0, 0])),
      B("Hook Arm X", [-600, -6, -1020, -400, 6, -1008], 'ss', 0, 'mf', **rep(2, [900, 0, 0])),
      B("Hook Arm Y", [-506, -100, -1020, -494, 100, -1008], 'ss', 0, 'mf', **rep(2, [900, 0, 0])),
      C("Hook Tip X", 'z', [-600, 0], 6, [-1020, -970], 'ss', 'f', **rep(2, [200, 0, 0])),
      C("Hook Tip X2", 'z', [300, 0], 6, [-1020, -970], 'ss', 'f', **rep(2, [200, 0, 0])),
      C("Hook Tip Y", 'z', [-500, -100], 6, [-1020, -970], 'ss', 'f', **rep(2, [0, 200, 0])),
      C("Hook Tip Y2", 'z', [400, -100], 6, [-1020, -970], 'ss', 'f', **rep(2, [0, 200, 0])),
      B("IV Bag", [-560, -30, -1300, -440, 0, -1060], 'pc', 20, 'f'),
      C("Bag Port", 'z', [-500, -15], 5, [-1340, -1300], 'pc', 'f')]
add(f, "Ceiling IV track 2400, aluminium track with two sliding carriers, drop rods and four-hook crowns",
    "IfcDiscreteAccessory", [("2400_IVTrack", "Ceiling IV track 2400 mm, two carriers with 4-hook hangers")], iv,
    {"Track 2400 mm": A(2400), "Hanger 1000 mm below ceiling, 4 hooks": A(1000), "Load 10 kg per carrier": A(10)},
    "IV track modelled as a generic product below the ceiling (z = 0): track with end caps and fixings, two carriers with wheels, drop "
    "rods with collars, four-arm hook crowns with upturned tips, one IV bag for scale.")

f = 'FMC_A_SpecEq_PatientHoist_CeilingTrack'
ht = [B("End Stop Charger End", [-1520, -40, -80, -1500, 40, 0], 'white', 6),
      B("Charging Station", [-1480, -50, -150, -1300, 50, -70], 'white', 15),
      B("Charging Contacts", [-1300, -20, -130, -1290, 20, -100], 'chrome', 0, 'f'),
      B("Trolley", [-90, -40, -110, 90, 40, -70], 'white', 10),
      B("Hoist Motor", [-190, -110, -420, 190, 110, -110], 'white', 60),
      F("Motor Face", [-170, -112, -400, 170, -110, -130], 'mgrey', 40, 'f'),
      B("Emergency Lower", [150, -114, -220, 180, -110, -160], 'red', 6, 'f'),
      F("Status LED", [-60, -113, -160, 60, -112, -150], 'green', 3, 'f'),
      B("Lifting Strap", [-22, -3, -1200, 22, 3, -420], 'blue'),
      T("Strap Swivel", 'z', [0, 0], [[0, -1230], [20, -1230], [20, -1200], [0, -1200]], 'grey'),
      C("Spreader Bar", 'y', [0, -1250], 20, [-270, 270], 'grey'),
      B("Spreader Hook", [-14, -290, -1290, 14, -250, -1240], 'grey', 0, 'mf', **rep(2, [0, 540, 0])),
      B("Hand Control", [230, -40, -900, 290, 0, -730], 'white', 15),
      B("Control Buttons", [240, -42, -860, 280, -40, -780], 'blue', 8, 'f'),
      C("Control Cord", 'z', [260, -20], 4, [-730, -350], 'black', 'f')]
for Lt in (3000, 4000):
    xe = -1500 + Lt
    ht += only(f"{Lt}_Straight", [B("Track", [-1500, -32, -70, xe, 32, 0], 'alu', 4),
                                  B("Track Channel", [-1490, -12, -72, xe - 10, 12, -70], 'dark', 0, 'f'),
                                  B("End Stop", [xe, -40, -80, xe + 20, 40, 0], 'white', 6),
                                  C("Ceiling Fixing", 'z', [-1300, 0], 30, [-8, 0], 'white', 'f', **rep(Lt // 1000 + 1, [(Lt - 400) / (Lt // 1000), 0, 0]))], str(Lt))
add(f, "Ceiling track patient hoist, straight track, 200 kg lift motor with strap and 2-point spreader bar, hand control, charging station",
    "IfcTransportElement", [("3000_Straight", "Straight ceiling hoist track 3000 mm, 200 kg motor"),
                            ("4000_Straight", "Straight ceiling hoist track 4000 mm, 200 kg motor")], ht,
    {"Track 3000 / 4000 mm, profile 64 x 70": A("3000/4000"), "SWL 200 kg": A(200, "typical ward ceiling hoist"), "Charger 240 V, 100 VA": A(100)},
    "Ceiling hoist modelled as a generic product below the ceiling (z = 0): aluminium track from x = -1500 (charging station end) with "
    "end stops and fixings (track, channel, far end stop and fixings per type), trolley, motor unit with emergency-lower and LED, strap "
    "with swivel, spreader bar with hooks, hand control. The lifting envelope (Clearance Operation) is drawn for the 3000 track.",
    connectors=[E("Charging Station", 'top')], tv={**EV(240, 100)},
    clearances=[{"n": "Lifting Envelope", "shape": "box", "at": [-1500, -500, -2400, 1500, 500, -420], "sub": "Clearance Operation"}])

f = 'FMC_A_SpecEq_PatientHoist_Mobile'
mh = [B("Leg", [-520, -340, 70, 650, -290, 125], 'epoxy', 10, **rep(2, [0, 630, 0])),
      B("Base Cross Member", [-600, -330, 70, -460, 330, 140], 'epoxy', 15),
      B("Leg Spread Actuator", [-460, -60, 90, -380, 60, 130], 'grey', 10, 'f'),
      C("Castor Wheel", 'x', [-315, 38], 38, [600, 640], 'castor', **rep(2, [0, 630, 0])),
      C("Castor Wheel Rear", 'x', [-315, 38], 38, [-540, -500], 'castor', **rep(2, [0, 630, 0])),
      B("Castor Fork", [595, -330, 40, 645, -300, 75], 'grey', 0, 'f', **rep(2, [0, 630, 0])),
      B("Castor Fork Rear", [-545, -330, 40, -495, -300, 75], 'grey', 0, 'f', **rep(2, [0, 630, 0])),
      B("Brake Pedal", [-560, -345, 55, -520, -320, 65], 'red', 0, 'f', **rep(2, [0, 665, 0])),
      B("Mast", [-560, -45, 140, -470, 45, 1420], 'epoxy', 15),
      FR("Boom", [[-560, 1380], [-500, 1440], [480, 1520], [480, 1450], [-470, 1370]], [-35, 35], 'epoxy'),
      FR("Actuator Ram", [[-480, 760], [-450, 740], [-170, 1400], [-200, 1420]], [-28, 28], 'grey'),
      C("Actuator Rod", 'y', [-190, 1405], 12, [-40, 40], 'chrome', 'f'),
      T("Hanger", 'z', [450, 0], [[0, 1250], [14, 1250], [14, 1450], [0, 1450]], 'grey'),
      C("Spreader Bar", 'y', [450, 1240], 18, [-260, 260], 'grey'),
      ball("Spreader Hook", 'y', [450, 1240], -260, 28, 'grey', **rep(2, [0, 520, 0])),
      B("Push Handle Post", [-620, -230, 1000, -560, -200, 1150], 'epoxy', 0, 'mf', **rep(2, [0, 430, 0])),
      C("Push Handle", 'y', [-630, 1150], 16, [-260, 260], 'black'),
      B("Control Box", [-640, -100, 650, -560, 100, 950], 'white', 20),
      B("Battery", [-650, -90, 960, -560, 90, 1050], 'grey', 15),
      B("Emergency Stop", [-660, -25, 880, -640, 25, 930], 'red', 8, 'f'),
      B("Status Panel", [-642, -60, 700, -640, 60, 760], 'green', 0, 'f'),
      B("Hand Control", [-680, 120, 850, -640, 170, 1000], 'white', 12, 'f')]
add(f, "Mobile patient hoist, 1200 x 700 base with powered leg spread, 4 castors with rear brakes, electric boom actuator, 2-point spreader bar",
    "IfcTransportElement", [("1200x700_Mobile", "Mobile hoist 1200 x 700 mm base, SWL 180 kg, battery powered")], mh,
    {"Base 1200 x 700 mm (legs open)": A("1200x700"), "SWL 180 kg": A(180), "Boom height range 600-1500 mm": A("600-1500"),
     "Castors 75 mm, braked rear": A(75)},
    "Mobile hoist modelled as a generic product: two legs with spread actuator and cross member, four castors with forks and brake "
    "pedals, mast, boom, actuator ram, hanger and spreader bar with hooks, push handle, control box, battery, emergency stop, hand "
    "control. The sling sweep envelope is a Clearance Operation solid around the spreader bar.",
    clearances=[{"n": "Sling Sweep", "shape": "cyl", "axis": "z", "c": [450, 0], "r": 600, "z": [150, 1500], "sub": "Clearance Operation"}])

# ================================================================= EQUIPMENT
f = 'FMC_A_SpecEq_WheelchairRack_Wall'
def rack(nb):
    W = nb * 700; x0 = -W / 2; sp = (W - 20) / nb
    return [B("Floor Plate", [x0, -950, 0, -x0, 0, 3], 'ss'),
            B("Wheel Guide", [x0 + 220, -700, 3, x0 + 240, -100, 60], 'ss', 0, 'f', **rep(nb, [700, 0, 0])),
            C("Wall Rail", 'x', [-60, 900], 25, [x0, -x0], 'ss'),
            C("Bumper Rail", 'x', [-60, 320], 25, [x0, -x0], 'ss'),
            C("Rail Bracket", 'y', [x0 + 10, 900], 18, [-60, 0], 'ss', 'f', **rep(nb + 1, [sp, 0, 0])),
            C("Bumper Bracket", 'y', [x0 + 10, 320], 18, [-60, 0], 'ss', 'f', **rep(nb + 1, [sp, 0, 0])),
            C("Divider Arm", 'y', [x0 + 10, 850], 20, [-630, -8], 'ss', **rep(nb + 1, [sp, 0, 0])),
            C("Divider Post", 'z', [x0 + 10, -630], 20, [0, 850], 'ss', **rep(nb + 1, [sp, 0, 0])),
            ball("Divider Corner", 'y', [x0 + 10, 850], -630, 20, 'ss', **rep(nb + 1, [sp, 0, 0]))]
wr = only("3-Chair_Rack", rack(3), "3Bay") + only("5-Chair_Rack", rack(5), "5Bay") + [
      F("Sign Plate", [-200, -6, 1500, 200, 0, 1900], 'blue', 15),
      F("Sign Symbol", [-90, -8, 1600, 90, -6, 1780], 'white', 10, 'f'),
      F("Sign Text", [-150, -8, 1530, 150, -6, 1570], 'white', 0, 'f')]
add(f, "Wall-mounted wheelchair parking rack, bays at 700, stainless wall and bumper rails, bay dividers, floor protection plate, parking sign",
    "IfcFurniture", [("3-Chair_Rack", "Wheelchair parking rack, 3 bays, 2100 mm"), ("5-Chair_Rack", "Wheelchair parking rack, 5 bays, 3500 mm")], wr,
    {"Bay width 700 mm, rack 2100 / 3500 mm": A(700, "folded/open attendant chair widths"), "Floor plate depth 950 mm": A(950),
     "Rails at 320 and 900 mm": A("320/900")},
    "Wheelchair rack modelled as a generic product: stainless floor plate with wheel guides, wall rail and low bumper rail on brackets, "
    "tubular bay dividers, blue parking sign. Back wall at y = 0; the rack is per type (3 or 5 bays), the sign is shared.")

f = 'FMC_A_SpecEq_LinenChute_Disposal'
lc = [C("Chute Tube", 'z', [0, 420], 300, [0, 3000], 'ss'),
      T("Chute Joint Band", 'z', [0, 420], [[300, 2400], [312, 2400], [312, 2460], [300, 2460]], 'ss', 'f'),
      B("Throat", [-280, 0, 760, 280, 170, 1440], 'ss'),
      F("Door Frame", [-380, -45, 700, 380, 0, 1520], 'ss', 10),
      F("Frame Shadow", [-330, -46, 760, 330, -45, 1460], 'black', 0, 'f'),
      RT("Hopper Door", [[-47, 770], [-60, 770], [-60, 1450], [-47, 1450]], [-320, 320], 'ss'),
      C("Pull Handle", 'x', [-100, 1360], 14, [-200, 200], 'ss'),
      C("Handle Stand", 'y', [-180, 1360], 10, [-100, -60], 'ss', 'f', **rep(2, [360, 0, 0])),
      C("Hinge", 'x', [-55, 775], 12, [-310, 310], 'ss', 'f'),
      F("Fire Rating Label", [-120, -62, 1050, 120, -60, 1090], 'red', 0, 'f'),
      F("Use Label", [-200, -62, 1170, 200, -60, 1260], 'yellow', 4, 'f'),
      F("Interlock Panel", [420, -14, 1250, 520, 0, 1400], 'ss', 6),
      C("Interlock Lamp", 'y', [470, 1360], 10, [-20, -14], 'green', 'f'),
      C("Interlock Lamp Red", 'y', [470, 1320], 10, [-20, -14], 'red', 'f'),
      C("Key Switch", 'y', [470, 1280], 12, [-22, -14], 'chrome', 'f'),
      T("Floor Collar", 'z', [0, 420], [[300, 0], [380, 0], [380, 40], [300, 40]], 'galv')]
add(f, "Linen and waste chute, 600 dia stainless chute with fire-rated (FD60) bottom-hinged hopper intake door, interlock and labels",
    "IfcBuildingElementProxy", [("600_FireRated", "Linen/waste chute 600 mm dia, FD60 hopper intake door, interlock")], lc,
    {"Chute 600 mm dia": A(600, "record type"), "Intake door FD60, self-closing, bottom-hinged hopper": A("FD60", "HTM 05-02 / BS 476-22"),
     "Intake sill 760 mm": A(760)},
    "Chute modelled as a generic product: one storey of 600 stainless chute behind the wall line (y = 0) with joint band and floor "
    "collar, throat, intake frame, tilted hopper door with pull handle and hinge, fire and use labels, interlock panel with lamps and key.")

def dispenser_soap():
    return [F("Back Plate", [-62, -12, 0, 62, 0, 270], 'grey', 16),
            B("Cover", [-60, -115, 45, 60, -12, 262], 'white', 26),
            B("Cover Dome", [-55, -105, 262, 55, -16, 272], 'white', 24, 'f'),
            F("Level Window", [-12, -116, 140, 12, -112, 230], 'pc', 6, 'f'),
            F("Push Free Badge", [-35, -116, 100, 35, -114, 118], 'blue', 4, 'f'),
            F("Lock Slot", [-8, -116, 250, 8, -114, 256], 'black', 2, 'f'),
            B("Sensor Window", [-30, -100, 40, 30, -80, 45], 'black', 8, 'f'),
            T("Nozzle", 'z', [0, -60], [[0, 30], [8, 30], [8, 45], [0, 45]], 'black', 'f'),
            B("Drip Tray", [-52, -112, 0, 52, -12, 12], 'grey', 22),
            B("Drip Tray Well", [-38, -95, 11, 38, -30, 13], 'black', 15, 'f')]
f = 'FMC_A_SpecEq_Dispenser_Soap_Auto'
add(f, "Touch-free soap/foam dispenser 1200 ml, 124 x 115 x 270 mm, level window, IR sensor, removable drip tray, battery",
    "IfcDiscreteAccessory", [("1200ml_Wall", "Touch-free soap or foam dispenser 1200 ml, wall mounted, battery")], dispenser_soap(),
    {"124 x 115 x 270 mm": A("124x115x270"), "Capacity 1200 ml": A(1200), "Mounting 1000-1100 mm to nozzle beside basin": A(1000, "HBN 00-10 Part C")},
    "Soap dispenser modelled as a generic product: grey back plate, rounded white cover with domed top, level window, badge, lock slot, "
    "sensor window and nozzle underneath, drip tray on an arm. Default Elevation 1000.", tv={"Default Elevation": 1000})

f = 'FMC_A_SpecEq_Dispenser_PaperTowel_Bin'
def towel(dy):
    return [B("Housing", [-200, -150 + dy, 0, 200, min(-6 + dy, 90), 1400], 'ss', 10),
            F("Towel Door", [-190, -153 + dy, 860, 190, -150 + dy, 1390], 'ss', 6),
            F("Level Window", [-25, -154 + dy, 1050, 25, -153 + dy, 1330], 'black', 10, 'f'),
            F("Towel Slot", [-130, -154 + dy, 880, 130, -152 + dy, 895], 'black', 0, 'f'),
            FR("Towel", [[-110, 820], [110, 820], [110, 888], [-110, 888]], [-162 + dy, -156 + dy], 'white'),
            C("Towel Lock", 'y', [0, 1365], 9, [-156 + dy, -153 + dy], 'chrome', 'f'),
            F("Waste Panel", [-190, -153 + dy, 30, 190, -150 + dy, 840], 'ss', 6),
            RT("Waste Flap", [[-152 + dy, 700], [-175 + dy, 760], [-175 + dy, 800], [-152 + dy, 800]], [-150, 150], 'ss'),
            FR("Waste Opening", [[-150, 700], [150, 700], [150, 760], [-150, 760]], [-154 + dy, -152 + dy], 'black', 'f'),
            C("Bin Lock", 'y', [0, 640], 9, [-156 + dy, -153 + dy], 'chrome', 'f'),
            F("Waste Label", [-60, -154 + dy, 560, 60, -153 + dy, 600], 'black', 3, 'f'),
            B("Kick Plate", [-198, -152 + dy, 0, 198, -140 + dy, 30], 'ss', 0, 'f')]
pt = only("400x1400_Surface", towel(0), "Surface") + only("400x1400_Semi-Recessed", towel(90) + [F("Trim Flange", [-225, -6, -25, 225, 0, 1425], 'ss', 8)], "Semi")
add(f, "Combination paper-towel dispenser and waste receptacle, brushed stainless, 400 x 1400 x 150, surface or semi-recessed (trim flange)",
    "IfcDiscreteAccessory", [("400x1400_Surface", "Towel dispenser/waste unit 400 x 1400 x 150 mm, surface mounted"),
                             ("400x1400_Semi-Recessed", "Towel dispenser/waste unit 400 x 1400 mm, semi-recessed 90 mm into the wall, trim flange")], pt,
    {"400 x 1400 x 150 mm": A("400x1400x150"), "Bottom at 300 mm, towel slot at 1180 mm": A(300, "HBN 00-10 Part C reach range"),
     "Semi-recessed: 90 mm in the wall, 60 mm proud": A(90)},
    "Towel/waste unit modelled as a generic product: stainless housing, towel door with level window, slot and towel sheet, lock; waste "
    "panel with angled push flap, opening, lock and label; kick plate. Per type: surface (150 proud) or semi-recessed (90 into the wall, "
    "trim flange). Default Elevation 300.", tv={"Default Elevation": 300})

f = 'FMC_A_SpecEq_Dispenser_GloveApron'
ga = [F("Back Panel", [-310, -8, 0, 310, 0, 560], 'white', 15),
      B("Glove Shelf", [-300, -110, 0, 300, -8, 12], 'white', 6),
      B("Divider", [-300, -110, 12, -292, -8, 300], 'white', 0, 'mf', **rep(4, [197.3, 0, 0])),
      B("Retaining Lip", [-300, -112, 12, 300, -105, 60], 'pc', 0, 'f'),
      B("Glove Box", [-286, -100, 12, -102, -10, 270], 'blue', 0, 'mf', **rep(3, [197.3, 0, 0])),
      F("Glove Slot", [-240, -101, 160, -148, -100, 230], 'white', 30, 'f', **rep(3, [197.3, 0, 0])),
      F("Glove Tuft", [-220, -112, 175, -168, -101, 215], 'ledb', 20, 'f', **rep(3, [197.3, 0, 0])),
      F("Size Label", [-240, -101, 40, -148, -100, 70], 'white', 4, 'f', **rep(3, [197.3, 0, 0])),
      B("Apron Housing", [-300, -120, 330, 300, -8, 540], 'white', 25),
      F("Apron Slot", [-200, -121, 360, 200, -120, 375], 'black', 0, 'f'),
      FR("Apron Sheet", [[-160, 300], [160, 300], [160, 372], [-160, 372]], [-124, -122], 'white'),
      F("Apron Window", [-80, -121, 440, 80, -120, 510], 'pc', 10, 'f'),
      F("PPE Label", [-280, -121, 500, -120, -120, 525], 'blue', 3, 'f')]
add(f, "PPE station: three glove boxes (S/M/L) and an apron roll dispenser, white ABS with clear retaining lip, 620 x 560 x 120",
    "IfcDiscreteAccessory", [("3-Box_Wall", "PPE dispenser, 3 glove boxes + apron roll, 620 x 560 mm")], ga,
    {"620 x 560 x 120 mm": A("620x560x120"), "Three glove boxes + apron roll": A("3 + 1", "record type"), "Bottom at 1000 mm by room entry": A(1000, "HBN 00-09 IPC")},
    "PPE station modelled as a generic product: back panel, glove shelf with dividers and clear lip, three blue glove boxes with slots, "
    "gloves pulled out and size labels, apron housing with slot, sheet and window, PPE label. Default Elevation 1000.", tv={"Default Elevation": 1000})

f = 'FMC_A_SpecEq_SharpsBin_Bracket'
sb = [F("Wall Plate", [-80, -10, 0, 80, 0, 360], 'ss', 10),
      C("Wall Screw", 'y', [0, 330], 5, [-12, -10], 'chrome', 'f', **rep(2, [0, 0, -300])),
      B("Cradle Base", [-125, -255, 0, 125, -10, 12], 'ss', 15),
      B("Cradle Band Front", [-125, -258, 12, 125, -250, 100], 'ss', 0),
      B("Cradle Band Side", [-125, -255, 12, -118, -10, 100], 'ss', 0, 'mf', **rep(2, [243, 0, 0])),
      B("Bin Body", [-115, -245, 12, 115, -20, 290], 'yellow', 20),
      B("Lid", [-118, -248, 290, 118, -17, 330], 'orange', 22),
      RT("Lid Slope", [[-248, 330], [-17, 330], [-17, 345], [-200, 345]], [-110, 110], 'orange'),
      B("Aperture", [-60, -190, 345, 60, -90, 347], 'black', 15, 'f'),
      RT("Closure Flap", [[-200, 345], [-190, 345], [-150, 385], [-160, 388]], [-55, 55], 'orange', 'f'),
      F("Hazard Label", [-80, -246, 130, 80, -245, 230], 'white', 4, 'f'),
      F("Hazard Symbol", [-30, -247, 160, 30, -246, 210], 'black', 10, 'f'),
      B("Locking Clip", [-20, -260, 60, 20, -250, 110], 'ss', 4, 'f')]
add(f, "Sharps container wall bracket with 11 l sharps bin (yellow body, orange lid, temporary-closure flap)",
    "IfcDiscreteAccessory", [("11L_Wall", "Sharps bin bracket with 11 l container, wall mounted")], sb,
    {"Container 11 l, 230 x 225 x 330 mm": A(11), "Bracket 160 x 360 mm plate": A("160x360"), "Aperture at 1100-1200 mm": A(1100, "HTM 07-01 / HBN 00-10 placement")},
    "Sharps bracket modelled as a generic product: stainless wall plate with screws, cradle base and bands, locking clip; yellow bin with "
    "orange sloped lid, aperture, raised closure flap, hazard label. Default Elevation 850.", tv={"Default Elevation": 850})

# ================================================================= SIGNAGE
f = 'FMC_A_SpecEq_Signage_Room_Plate'
rp = [F("Number Panel", [-145, -9, 60, -80, -8, 95], 'white', 3, 'f'),
      F("Number Text", [-135, -11, 68, -90, -9, 88], 'blue', 0, 'f'),
      F("Name Text", [-65, -11, 70, 120, -9, 86], 'white', 0, 'f'),
      F("Name Text Line 2", [-65, -11, 52, 60, -9, 62], 'white', 0, 'f'),
      F("Braille Strip", [-65, -9, 14, 135, -8, 34], 'white', 3, 'f')] + \
     [C(f"Braille Dot {r}", 'y', [-58, 19 + 6 * r], 1.5, [-10, -9], 'white', 'f', **rep(20, [9.5, 0, 0])) for r in range(2)]
for h, tn in ((100, "300x100_Braille"), (200, "300x200_Braille")):
    rp += only(tn, [F("Back Plate", [-150, -4, 0, 150, 0, h], 'blue', 6), F("Face", [-145, -8, 5, 145, -4, h - 5], 'blue', 4),
                    C("Fixing Pad", 'y', [-130, h / 2], 8, [-5, -4], 'grey', 'f', **rep(2, [260, 0, 0]))], str(h))
rp += only("300x200_Braille", [F("Pictogram Panel", [-60, -9, 110, 60, -8, 190], 'white', 8, 'f'), F("Pictogram", [-35, -10, 125, 35, -9, 175], 'blue', 20, 'f')], "200")
add(f, "Room identification plate 300 x 100 or 300 x 200 with tactile name and number, Grade 2 braille strip, pictogram (200 type)",
    "IfcBuildingElementProxy", [("300x100_Braille", "Room ID plate 300 x 100 mm, tactile text and braille"),
                                ("300x200_Braille", "Room ID plate 300 x 200 mm, tactile text, braille and pictogram")], rp,
    {"Plate 300 x 100 / 300 x 200 mm": A("300x100/300x200"), "Centre 1400-1700 mm on the latch side": A(1500, "BS 8300-2 / HTM 65"), "Tactile text 1 mm raised, braille strip": A(1, "BS 8300-2")},
    "Room plate modelled as a generic product: back plate and face per type, number panel, raised name text, braille strip with two rows "
    "of dots, fixing pads; the 200 type adds a pictogram above. Default Elevation 1450 (bottom). Room name and number come from the room "
    "in the project (label in the tag).", tv={"Default Elevation": 1450})

f = 'FMC_A_SpecEq_Signage_Hanging_Wayfinding'
hs = [T("Ceiling Rose", 'z', [-450, 0], [[0, -12], [35, -12], [35, 0], [0, 0]], 'white', **rep(2, [900, 0, 0])),
      C("Suspension Cable", 'z', [-450, 0], 2, [-630, -12], 'ss', **rep(2, [900, 0, 0])),
      B("Cable Gripper", [-460, -10, -660, -440, 10, -630], 'chrome', 0, 'f', **rep(2, [900, 0, 0])),
      FR("Arrow", [[-560, -780], [-480, -700], [-480, -750], [-400, -750], [-400, -810], [-480, -810], [-480, -860]], [-29, -27], 'white', 'f'),
      F("Text Line 1", [-360, -29, -740, 300, -27, -700], 'white', 0, 'f'),
      F("Text Line 2", [-360, -29, -830, 120, -27, -790], 'white', 0, 'f')]
for w, tn in ((1200, "1200x300_Hanging"), (1800, "1800x300_Hanging")):
    hw = w / 2; xs = -600   # signs share the left edge, so the arrow and text sit in the same place
    hs += only(tn, [B("Sign Frame", [xs, -25, -960, xs + w, 25, -660], 'alupc', 8),
                    F("Face Front", [xs + 15, -27, -945, xs + w - 15, -25, -675], 'blue', 6),
                    F("Face Back", [xs + 15, 25, -945, xs + w - 15, 27, -675], 'blue', 6),
                    F("Department Colour Band", [xs + w - 160, -29, -930, xs + w - 30, -27, -690], 'yellow', 0, 'f'),
                    B("LED Edge", [xs, -20, -962, xs + w, 20, -960], 'led', 0, 'f')], str(w))
add(f, "Suspended corridor wayfinding sign 1200 x 300 or 1800 x 300, double-sided, aluminium frame, edge-lit LED, cable suspension",
    "IfcBuildingElementProxy", [("1200x300_Hanging", "Hanging wayfinding sign 1200 x 300 mm, double sided, edge-lit"),
                                ("1800x300_Hanging", "Hanging wayfinding sign 1800 x 300 mm, double sided, edge-lit")], hs,
    {"Sign 1200 / 1800 x 300 x 50 mm": A("1200x300/1800x300"), "Underside 2100 mm min above floor": A(2100, "HTM 65 / BS 8300-2"), "LED 240 V, 30 VA": A(30)},
    "Hanging sign modelled as a generic product below the ceiling (z = 0): roses, cables and grippers 900 apart (shared), arrow and text "
    "(shared), frame, two faces, department colour band and LED edge per type. Hangs 660 mm below the ceiling.",
    connectors=[E("Ceiling Rose 1", 'top')], tv={**EV(240, 30)})

f = 'FMC_A_SpecEq_Signage_Totem_External'
tt = [B("Plinth", [-380, -180, -300, 380, 180, 100], 'conc', 0),
      B("Base Shroud", [-310, -110, 100, 310, 110, 200], 'dark', 10),
      B("Monolith", [-300, -100, 200, 300, 100, 2000], 'alupc', 40),
      B("Cap", [-305, -105, 2000, 305, 105, 2030], 'dark', 42),
      F("Header Panel", [-280, -102, 1650, 280, -100, 1980], 'blue', 30),
      F("H Symbol Back", [-90, -104, 1700, 90, -102, 1930], 'white', 10, 'f'),
      F("H Symbol Left", [-60, -106, 1730, -25, -104, 1900], 'blue', 0, 'f'),
      F("H Symbol Right", [25, -106, 1730, 60, -104, 1900], 'blue', 0, 'f'),
      F("H Symbol Bar", [-25, -106, 1795, 25, -104, 1835], 'blue', 0, 'f'),
      F("Directory Panel", [-280, -102, 500, 280, -100, 1600], 'white', 15),
      F("Directory Line", [-240, -104, 1500, 180, -102, 1530], 'blue', 0, 'f', **rep(8, [0, 0, -120])),
      F("Arrow Tile", [200, -104, 1490, 250, -102, 1540], 'black', 6, 'f', **rep(8, [0, 0, -120])),
      F("Back Header", [-280, 100, 1650, 280, 102, 1980], 'blue', 30, 'f'),
      F("Back Directory", [-280, 100, 500, 280, 102, 1600], 'white', 15, 'f'),
      B("LED Halo", [-300, -100, 200, 300, 100, 210], 'led', 30, 'f'),
      F("Service Door", [-150, 99, 250, 150, 101, 450], 'dark', 4, 'f')]
add(f, "External site totem sign 600 x 2000 x 200, powder-coated aluminium monolith, illuminated header and directory, concrete plinth",
    "IfcBuildingElementProxy", [("600x2000_Totem", "External totem sign 600 x 2000 x 200 mm, illuminated, double sided")], tt,
    {"600 x 2000 x 200 mm": A("600x2000x200"), "Plinth 760 x 360 x 400 mm": A("760x360x400"), "LED 240 V, 150 VA": A(150)},
    "Totem modelled as a generic product: concrete plinth (to 300 below finished level), base shroud, rounded monolith with cap, blue "
    "header with hospital H, directory panel with lines and arrow tiles on both faces, LED halo, rear service door.",
    category="Site", connectors=[E("Plinth", 'bottom')], tv={**EV(240, 150)})

# ================================================================= WALL PROTECTION
f = 'FMC_A_SpecEq_WallProtection_CrashRail'
L = 1200
cr = [RT("Retainer", [[0, 20], [-12, 20], [-12, 180], [0, 180]], [-L, L], 'alu'),
      RT("Bumper Cushion", [[-12, 35], [-22, 35], [-22, 165], [-12, 165]], [-L, L], 'black', 'f'),
      RT("Cover", [[-12, 0], [-28, 10], [-34, 40], [-36, 100], [-34, 160], [-28, 190], [-12, 200]], [-L + 5, L - 5], 'wprot'),
      RT("Face Insert", [[-36, 80], [-38, 82], [-38, 118], [-36, 120]], [-L + 5, L - 5], 'grey', 'f'),
      RT("End Cap", [[0, 0], [-28, 10], [-38, 100], [-28, 190], [0, 200]], [-L - 30, -L + 5], 'grey'),
      RT("End Cap Right", [[0, 0], [-28, 10], [-38, 100], [-28, 190], [0, 200]], [L - 5, L + 30], 'grey'),
      F("Bracket", [-1000, -12, 25, -940, 0, 175], 'alu', 0, 'f', **rep(4, [633, 0, 0]))]
add(f, "Bed-corridor crash (bumper) rail 200 high, aluminium retainer, shock-absorbing cushion, curved impact-resistant PVC cover, end caps",
    "IfcCovering", [("200_Horizontal", "Crash rail 200 mm high, 38 mm projection, horizontal run")], cr,
    {"Height 200 mm, projection 38 mm": A("200x38", "record profile 200x30 class"), "Bottom at 300 mm (trolley/bed height)": A(300, "HBN 00-04 / HTM practice"),
     "Brackets at 600-800 mm centres": A(633)},
    "Crash rail modelled as a generic product: a 2400 mm sample run of aluminium retainer, cushion and curved PVC cover (profile "
    "extruded along x), end caps, brackets. Bottom at z = 0; Default Elevation 300.", tv={"Default Elevation": 300})

f = 'FMC_A_SpecEq_WallProtection_CornerGuard'
def nose(r, z0, z1, n, mat, lod='mf'): return PR(n, [[8, 8]] + arc(8, 8, r, 180, 270, 8), [z0, z1], mat, lod)
def guard(h):
    t = h - 12
    return [B("Cover Wing X", [8, -4, 12, 75, 0, t], 'wprot'), B("Cover Wing Y", [-4, 8, 12, 0, 75, t], 'wprot'), nose(12, 12, t, "Cover Nose", 'wprot'),
            B("Retainer X", [6, 0, 12, 55, 3, t], 'alu', 0, 'f'), B("Retainer Y", [0, 6, 12, 3, 55, t], 'alu', 0, 'f'),
            B("Top Cap X", [8, -6, t, 78, 0, h], 'grey'), B("Top Cap Y", [-6, 8, t, 0, 78, h], 'grey'), nose(14, t, h, "Top Cap Nose", 'grey'),
            B("Grip Rib", [30, -6, 12, 40, -4, t], 'grey', 0, 'f'), B("Grip Rib Side", [-6, 30, 12, -4, 40, t], 'grey', 0, 'f')]
cg = [B("Bottom Cap X", [8, -6, 0, 78, 0, 12], 'grey'), B("Bottom Cap Y", [-6, 8, 0, 0, 78, 12], 'grey'), nose(14, 0, 12, "Bottom Cap Nose", 'grey')]
cg += only("1200_Surface", guard(1200), "1200") + only("1500_Surface", guard(1500), "1500")
add(f, "Surface-mounted corner guard 75 x 75, 1200 or 1500 high, impact-resistant PVC cover on aluminium retainer, rounded nose, caps",
    "IfcCovering", [("1200_Surface", "Corner guard 75 x 75 x 1200 mm, surface mounted"), ("1500_Surface", "Corner guard 75 x 75 x 1500 mm, surface mounted")], cg,
    {"Wings 75 x 75 mm": A("75x75"), "Height 1200 / 1500 mm from skirting": A("1200/1500", "record types"), "Nose radius 12 mm": A(12)},
    "Corner guard modelled as a generic product on an external corner at the origin (wall faces y = 0 and x = 0, wall in +x +y): PVC "
    "cover with rounded nose and grip ribs, retainer, caps; cover, retainer, ribs and top cap per type, bottom cap shared.")

f = 'FMC_A_SpecEq_WallProtection_Handrail_Corridor'
L = 1200
hr = [RT("Retainer", [[0, 10], [-12, 10], [-12, 130], [0, 130]], [-L, L], 'alu'),
      RT("Bumper Cover", [[-12, 0], [-30, 10], [-40, 70], [-30, 130], [-12, 140]], [-L + 5, L - 5], 'wprot'),
      RT("Bumper Insert", [[-38, 55], [-41, 58], [-41, 82], [-38, 85]], [-L + 5, L - 5], 'grey', 'f'),
      RT("Neck", [[-12, 130], [-42, 148], [-42, 162], [-12, 150]], [-L + 5, L - 5], 'wprot'),
      C("Handrail Grip", 'x', [-52, 175], 25, [-L + 5, L - 5], 'wprot'),
      C("Grip Core", 'x', [-52, 175], 18, [-L - 10, -L + 5], 'alu', 'f'),
      ball("Grip End", 'x', [-52, 175], -L + 5, 25, 'grey', 'mf'),
      ball("Grip End Right", 'x', [-52, 175], L - 5, 25, 'grey', 'mf'),
      RT("End Cap", [[0, 0], [-30, 10], [-42, 70], [-30, 135], [0, 145]], [-L - 25, -L + 5], 'grey'),
      RT("End Cap Right", [[0, 0], [-30, 10], [-42, 70], [-30, 135], [0, 145]], [L - 5, L + 25], 'grey'),
      F("Bracket", [-1000, -12, 15, -950, 0, 125], 'alu', 0, 'f', **rep(4, [633, 0, 0]))]
add(f, "Combined corridor handrail and crash rail, 50 mm round grip over a 140 mm bumper, continuous PVC cover on aluminium retainer",
    "IfcRailing", [("150_Continuous", "Combined handrail/crash rail, 50 mm grip, 140 mm bumper, continuous run")], hr,
    {"Grip 50 mm dia, top at 900 mm": A(50, "BS 8300-2 handrail 32-50 mm, 900-1000 mm"), "Bumper 140 mm, projection 77 mm": A("140x77", "record profile 50x40 grip class"),
     "Bottom at 720 mm": A(720)},
    "Handrail modelled as a generic product: a 2400 mm sample run of retainer, curved bumper cover, neck and round grip (profile along x), "
    "rounded grip ends, end caps, brackets. Bottom at z = 0; Default Elevation 720.", tv={"Default Elevation": 720})

f = 'FMC_A_SpecEq_WallPanel_Hygienic_Cladding'
wp = [F("Panel", [-600, -3, 100, 600, 0, 2700], 'cladding')] + [
      RT(f"Cove Segment {i + 1}", arc(-100, 100, 100, -15 * i, -15 * (i + 1), 1) + arc(-100, 100, 97, -15 * (i + 1), -15 * i, 1), [-600, 600], 'cladding') for i in range(6)] + [
      RT("Cove Fillet", [[0, 0], [0, 40], [-12, 22], [-40, 0]], [-600, 600], 'mgrey', 'm'),
      RT("Floor Flange", [[-100, 0], [-160, 0], [-160, 3], [-100, 3]], [-600, 600], 'cladding', 'f'),
      RT("Top Capping", [[0, 2690], [-8, 2690], [-8, 2700], [-5, 2712], [0, 2712]], [-600, 600], 'cladding'),
      F("Weld Joint", [-602, -4, 100, -598, -3, 2700], 'mgrey', 0, 'f', **rep(2, [1200, 0, 0])),
      F("Seam Line", [-602, -3.4, 2690, 602, -3, 2700], 'mgrey', 0, 'f')]
add(f, "Hygienic wall cladding panel 1200 x 2700, 2.5 mm PVC sheet, heat-welded joints, coved skirting former and top capping",
    "IfcCovering", [("1200x2700_PVC", "Hygienic PVC wall cladding 1200 x 2700 mm, welded joints, coved")], wp,
    {"Panel 1200 x 2700 x 2.5 mm": A("1200x2700x2.5", "typical hygienic sheet size"), "Coved junction 100 mm radius former": A(100, "HBN 00-10 Part B"),
     "Fire Class B-s1,d0": A("B-s1,d0", "HTM 05-02")},
    "Cladding modelled as a generic product: sheet panel, coved skirting former with fillet and floor turn-up, top capping, welded "
    "joints both edges.")

f = 'FMC_A_SpecEq_TheatrePanel_Modular'
gases = [("O2", 'white'), ("N2O", 'blue'), ("AIR", 'black'), ("VAC", 'yellow')]
tp = [F("Wall Panel", [-600, -50, 0, 600, 0, 3000], 'epoxy', 0),
      F("Panel Joint", [-603, -51, 0, -597, -50, 3000], 'grey', 0, 'f', **rep(2, [1200, 0, 0])),
      B("Coved Skirting", [-600, -80, 0, 600, -50, 100], 'epoxy', 0),
      F("Service Panel", [-500, -54, 1000, 500, -50, 1700], 'ss', 6),
      F("Theatre Control Panel", [-450, -56, 1800, 0, -50, 2150], 'black', 8),
      F("Control Display", [-420, -57, 2050, -30, -56, 2120], 'green', 4, 'f'),
      F("Control Keys", [-420, -57, 1840, -30, -56, 2020], 'grey', 4, 'f'),
      F("Clock", [100, -56, 1850, 450, -50, 2150], 'black', 8),
      F("Clock Digits", [130, -57, 1960, 420, -56, 2040], 'red', 3, 'f'),
      F("Socket Strip", [-460, -56, 1050, 460, -54, 1150], 'white', 6),
      F("Socket", [-430, -58, 1065, -330, -56, 1135], 'white', 6, 'f', **rep(6, [150, 0, 0])),
      F("Socket Switch", [-345, -60, 1100, -335, -58, 1120], 'red', 0, 'f', **rep(6, [150, 0, 0])),
      F("Data Outlet", [200, -56, 1550, 300, -54, 1650], 'white', 4),
      F("Data Port", [220, -57, 1580, 280, -56, 1620], 'black', 2, 'f'),
      F("Equipotential Point", [350, -58, 1550, 450, -54, 1650], 'yellow', 4, 'f'),
      F("Gas Panel", [-460, -56, 1300, 100, -54, 1500], 'white', 6)]
for i, (g, col) in enumerate(gases):
    x = -380 + i * 130
    tp += [T(f"Gas {g} Ring", 'y', [x, 1400], [[19, -56], [27, -56], [27, -60], [19, -60]], col, 'f'),
           T(f"Gas {g} Socket", 'y', [x, 1400], [[0, -54], [19, -54], [19, -66], [6, -68], [0, -68]], 'chrome')]
tp += [F("X-ray Viewer", [-500, -60, 2250, 500, -50, 2750], 'ss', 6),
       F("Viewer Screen", [-470, -61, 2280, 470, -60, 2720], 'frost', 4, 'f'),
       B("Ceiling Trim", [-600, -60, 2970, 600, 0, 3000], 'epoxy', 0, 'f')]
add(f, "Modular theatre wall panel 1200 x 3000, white epoxy steel, stainless service panel with sockets, data, equipotential point and "
       "four medical gas outlets, theatre control panel, clock and X-ray viewer",
    "IfcCovering", [("1200x3000_Modular", "Modular theatre panel 1200 x 3000 mm with services, control panel and viewer")], tp,
    {"Panel 1200 x 3000 x 50 mm": A("1200x3000x50", "HTM 03-01 / modular theatre systems"), "Gases O2, N2O, AIR, VAC (BS 5682)": A("O2/N2O/AIR/VAC", "HTM 02-01"),
     "6 sockets 240 V, 3 kVA": A(3000), "Service panel at 1000-1700 mm": A("1000-1700")},
    "Theatre panel modelled as a generic product: epoxy panel with joints, coved skirting, stainless service panel with socket strip "
    "(six sockets with switches), data outlet, equipotential point, gas panel with four colour-ringed BS 5682 outlets, control panel "
    "with display and keys, clock, X-ray viewer, ceiling trim. Back at y = 0.",
    connectors=[E("Socket Strip"), ELV("Data", "Data Outlet")] + [MG(g, "Gas Panel") for g, _ in gases], tv={**EV(240, 3000)})

f = 'FMC_A_SpecEq_BedheadTrunking_Horizontal'
bh = []
for L, tn in ((750, "1500_Horizontal"), (1000, "2000_Horizontal"), (1500, "3000_Horizontal")):
  bh += only(tn, [RT("Trunking Body", [[0, 0], [-60, 0], [-80, 20], [-85, 130], [-80, 240], [-60, 260], [0, 260]], [-L, L], 'alu'),
      RT("Cover Gas", [[-82, 25], [-87, 25], [-87, 85], [-84, 85]], [-L + 10, L - 10], 'white', 'f'),
      RT("Cover Power", [[-86, 90], [-88, 90], [-88, 170], [-86, 170]], [-L + 10, L - 10], 'white', 'f'),
      RT("Cover ELV", [[-84, 175], [-87, 175], [-87, 235], [-82, 235]], [-L + 10, L - 10], 'white', 'f'),
      RT("Light Diffuser", [[-60, 260], [-60, 275], [-10, 275], [-10, 260]], [-L + 50, L - 50], 'pc'),
      RT("Uplight Lens", [[-55, 275], [-55, 278], [-15, 278], [-15, 275]], [-L + 60, L - 60], 'led', 'f'),
      RT("End Cap", [[0, 0], [-60, 0], [-82, 20], [-87, 130], [-82, 240], [-60, 260], [0, 260]], [-L - 15, -L], 'grey'),
      RT("End Cap Right", [[0, 0], [-60, 0], [-82, 20], [-87, 130], [-82, 240], [-60, 260], [0, 260]], [L, L + 15], 'grey')], str(2 * L))
bh += [F("Socket Outlet", [-640, -90, 105, -500, -88, 160], 'white', 6, 'f', **rep(4, [170, 0, 0])),
      F("Socket Switch", [-520, -92, 125, -510, -90, 145], 'red', 0, 'f', **rep(4, [170, 0, 0])),
      F("Nurse Call Socket", [130, -89, 185, 210, -87, 225], 'white', 6, 'f'),
      C("Nurse Call Port", 'y', [170, 205], 10, [-90, -89], 'black', 'f'),
      F("Data Outlet", [240, -89, 185, 320, -87, 225], 'white', 6, 'f'),
      F("Reading Light Switch", [350, -89, 185, 420, -87, 225], 'white', 6, 'f'),
      F("Bed Number", [560, -89, 185, 700, -87, 225], 'blue', 4, 'f')]
for i, (g, col) in enumerate([("O2", 'white'), ("VAC", 'yellow'), ("AIR", 'black')]):
    x = 150 + i * 150
    bh += [T(f"Gas {g} Ring", 'y', [x, 55], [[17, -87], [24, -87], [24, -90], [17, -90]], col, 'f'),
           T(f"Gas {g} Socket", 'y', [x, 55], [[0, -86], [17, -86], [17, -98], [5, -100], [0, -100]], 'chrome')]
bh += only("3000_Horizontal", [F("Socket Outlet", [-1450, -90, 105, -1310, -88, 160], 'white', 6, 'f', **rep(2, [170, 0, 0])),
                               F("Nurse Call Socket", [-1150, -89, 185, -1070, -87, 225], 'white', 6, 'f'),
                               F("Bed Number", [-1450, -89, 185, -1310, -87, 225], 'blue', 4, 'f')] +
      [T(f"Gas {g} {k}", 'y', [-1400 + i * 150, 55], prof, col if k == 'Ring' else 'chrome', 'f' if k == 'Ring' else 'mf')
       for i, (g, col) in enumerate([("O2", 'white'), ("VAC", 'yellow'), ("AIR", 'black')])
       for k, prof in (("Ring", [[17, -87], [24, -87], [24, -90], [17, -90]]), ("Socket", [[0, -86], [17, -86], [17, -98], [5, -100], [0, -100]]))], "Bed 2")
add(f, "Horizontal bedhead trunking 1500, aluminium three-compartment extrusion (gases, power, ELV) with integral reading/uplight",
    "IfcBuildingElementProxy", [("1500_Horizontal", "Bedhead trunking 1500 mm, 3 compartments, integral light"),
                                ("2000_Horizontal", "Bedhead trunking 2000 mm, 3 compartments, integral light"),
                                ("3000_Horizontal", "Bedhead trunking 3000 mm (two bed spaces), 3 compartments, integral light")], bh,
    {"Profile 260 x 88 mm, 1500 long": A("260x88", "typical bedhead extrusion"), "Bottom at 1300 mm": A(1300, "HBN 04-01 bedhead practice"),
     "O2, VAC, AIR outlets (BS 5682); 4 sockets; nurse call; data": A("3 gas/4 skt"), "240 V, 3 kVA": A(3000)},
    "Bedhead trunking modelled as a generic product: curved aluminium body with gas, power and ELV covers, uplight diffuser and lens, end "
    "caps, four sockets, three gas outlets, nurse-call and data outlets, light switch, bed number. The services are also hosted by the "
    "E/P families in the project (record note); the connectors here carry the casing's load and gas points. Bottom at z = 0; Default "
    "Elevation 1300. Body, covers, light and end caps per length; the 3000 type adds a second bed's outlets.",
    connectors=[E("Socket Outlet 1"), ELV("NurseCall", "Nurse Call Socket")] + [MG(g, f"Gas {g} Socket") for g in ("O2", "VAC", "AIR")],
    tv={**EV(240, 3000), "Default Elevation": 1300})

# ================================================================= FURNITURE
f = 'FMC_A_SpecEq_LockerBank_Staff'
lk = [B("Carcass", [-450, -450, 100, 450, 0, 1800], 'alupc', 0),
      B("Plinth", [-440, -420, 0, 440, -10, 100], 'black'),
      RT("Sloping Top", [[-450, 1800], [0, 1800], [0, 2050], [-30, 2050]], [-450, 450], 'alupc'),
      B("Divider Edge", [-152, -452, 100, -148, -450, 1800], 'dark', 0, 'f', **rep(2, [300, 0, 0]))]
for tn, nt, sfx in (("900x1800_3-Tier", 3, "3T"), ("900x1800_6-Door", 2, "2T")):
  dh = 1690 / nt
  for t in range(nt):
    z0 = 110 + t * dh
    lk += only(tn, [F(f"Door Tier {t + 1}", [-445, -455, z0, -155, -450, z0 + dh - 10], 'epoxy', 4, **rep(3, [300, 0, 0])),
           F(f"Vent Tier {t + 1}", [-380, -457, z0 + dh - 130, -220, -455, z0 + dh - 60], 'dark', 3, 'f', **rep(3, [300, 0, 0])),
           C(f"Lock Tier {t + 1}", 'y', [-185, z0 + dh / 2], 12, [-465, -455], 'chrome', 'f', **rep(3, [300, 0, 0])),
           F(f"Number Tier {t + 1}", [-350, -457, z0 + dh - 190, -250, -455, z0 + dh - 150], 'black', 3, 'f', **rep(3, [300, 0, 0]))], sfx)
add(f, "Staff locker bank, 3 columns x 3 tiers, 900 x 450 x 1800 + sloping top, steel carcass, white doors with vents, cam locks, numbers",
    "IfcFurniture", [("900x1800_3-Tier", "Locker bank 3 columns x 3 tiers, 900 x 450 x 1800 mm, sloping top"),
                     ("900x1800_6-Door", "Locker bank 3 columns x 2 tiers (6 doors), 900 x 450 x 1800 mm, sloping top")], lk,
    {"900 x 450 x 1800 mm + 250 sloping top": A("900x450x1800"), "Column 300 mm, 3 tiers": A(300), "Plinth 100 mm": A(100)},
    "Locker bank modelled as a generic product: grey steel carcass on a black plinth, anti-dust sloping top, nine white doors with vent "
    "slots, cam locks and number plates. Back at y = 0; doors per type (3 tiers = 9 doors, 2 tiers = 6 doors).")

f = 'FMC_A_SpecEq_PatientWardrobe'
pw = [B("Carcass", [-300, -600, 80, 300, 0, 1800], 'mel', 0),
      B("Plinth", [-285, -560, 0, 285, -20, 80], 'black'),
      RT("Sloping Top", [[-600, 1800], [0, 1800], [0, 1950], [-30, 1950]], [-300, 300], 'mel'),
      F("Door", [-295, -620, 520, 295, -600, 1795], 'hpl', 4),
      F("Drawer Front", [-295, -620, 90, 295, -600, 510], 'hpl', 4),
      F("Edge Band", [-297, -621, 515, 297, -619, 518], 'grey', 0, 'f'),
      FR("Door Handle", [[200, 1050], [215, 1050], [215, 1250], [200, 1250]], [-650, -620], 'ss'),
      C("Handle Stand", 'y', [207, 1065], 7, [-640, -620], 'ss', 'f', **rep(2, [0, 0, 170])),
      FR("Drawer Handle", [[-100, 430], [100, 430], [100, 445], [-100, 445]], [-650, -620], 'ss'),
      C("Drawer Stand", 'y', [-85, 437], 7, [-640, -620], 'ss', 'f', **rep(2, [170, 0, 0])),
      C("Cam Lock", 'y', [200, 1300], 11, [-628, -620], 'chrome', 'f'),
      B("Hinge", [-298, -622, 600, -286, -612, 700], 'ss', 0, 'f', **rep(3, [0, 0, 500])),
      F("Name Card Holder", [-120, -623, 1600, 120, -620, 1680], 'pc', 4, 'f'),
      F("Mirror Strip", [-200, -621, 1150, 100, -620, 1550], 'mirror', 4, 'f')]
add(f, "Ward patient wardrobe 600 x 600 x 1800, white melamine carcass, HPL door and drawer, sloping anti-dust top, stainless D handles, lock",
    "IfcFurniture", [("600x600x1800_Wardrobe", "Patient wardrobe 600 x 600 x 1800 mm, hanging space + drawer, lockable")], pw,
    {"600 x 600 x 1800 mm + sloping top": A("600x600x1800", "record type"), "Drawer 420 mm high": A(420), "HPL faces, MFC carcass": A("HPL", "HBN 04-01 ward furniture")},
    "Wardrobe modelled as a generic product: melamine carcass on a recessed plinth, sloping top, HPL door and drawer with edge band, "
    "stainless D handles, cam lock, hinges, name-card holder and mirror strip. Back at y = 0.")

# ================================================================= EXTERNAL
f = 'FMC_A_GenericModel_Canopy_AmbulanceBay'
cx, cy = 2900, 4400
cn = [B("Pad Foundation", [-cx - 250, -cy - 250, -150, -cx + 250, -cy + 250, 0], 'conc', 0, 'mf', **rep(3, [0, cy, 0])),
      B("Pad Foundation Right", [cx - 250, -cy - 250, -150, cx + 250, -cy + 250, 0], 'conc', 0, 'mf', **rep(3, [0, cy, 0])),
      B("Base Plate", [-cx - 175, -cy - 175, 0, -cx + 175, -cy + 175, 25], 'steel', 0, 'f', **rep(3, [0, cy, 0])),
      B("Base Plate Right", [cx - 175, -cy - 175, 0, cx + 175, -cy + 175, 25], 'steel', 0, 'f', **rep(3, [0, cy, 0])),
      B("Column", [-cx - 100, -cy - 100, 25, -cx + 100, -cy + 100, 4500], 'dark', 8, 'mf', **rep(3, [0, cy, 0])),
      B("Column Right", [cx - 100, -cy - 100, 25, cx + 100, -cy + 100, 4800], 'dark', 8, 'mf', **rep(3, [0, cy, 0])),
      B("Column Guard", [-cx - 130, -cy - 130, 0, -cx + 130, -cy + 130, 1000], 'yellow', 20, 'mf', **rep(3, [0, cy, 0])),
      B("Column Guard Right", [cx - 130, -cy - 130, 0, cx + 130, -cy + 130, 1000], 'yellow', 20, 'mf', **rep(3, [0, cy, 0])),
      B("Guard Band", [-cx - 132, -cy - 132, 400, -cx + 132, -cy + 132, 550], 'black', 20, 'f', **rep(3, [0, cy, 0])),
      B("Guard Band Right", [cx - 132, -cy - 132, 400, cx + 132, -cy + 132, 550], 'black', 20, 'f', **rep(3, [0, cy, 0])),
      B("Edge Beam Left", [-cx - 75, -cy - 300, 4500, -cx + 75, cy + 300, 4800], 'dark'),
      B("Edge Beam Right", [cx - 75, -cy - 300, 4800, cx + 75, cy + 300, 5100], 'dark'),
      FR("Rafter", [[-cx - 300, 4500], [cx + 300, 4800], [cx + 300, 5100], [-cx - 300, 4800]], [-cy - 75, -cy + 75], 'dark', **rep(3, [0, cy, 0])),
      FR("Purlin", [[-cx - 300, 4800], [cx + 300, 5100], [cx + 300, 5180], [-cx - 300, 4880]], [-cy - 300, -cy - 250], 'galv', 'f', **rep(2, [0, 2 * cy + 550, 0])),
      FR("Roof Sheet", [[-cx - 400, 4800], [cx + 400, 5120], [cx + 400, 5140], [-cx - 400, 4820]], [-cy - 400, cy + 400], 'roof'),
      FR("Fascia Front", [[-cx - 400, 4700], [cx + 400, 5020], [cx + 400, 5160], [-cx - 400, 4840]], [-cy - 420, -cy - 400], 'epoxy'),
      B("Gutter", [-cx - 560, -cy - 400, 4650, -cx - 400, cy + 400, 4820], 'gutter', 30),
      C("Downpipe", 'z', [-cx - 480, -cy + 200], 55, [100, 4650], 'pipe', **rep(2, [0, 2 * cy - 400, 0])),
      C("Downpipe Shoe", 'y', [-cx - 480, 120], 55, [-cy + 200, -cy + 380], 'pipe', 'f'),
      B("Light Fitting", [-1500, -cy, 4570, -900, -cy + 300, 4640], 'white', 30, 'mf', **rep(2, [2400, 0, 0])),
      B("Light Fitting Rear", [-1500, cy - 300, 4570, -900, cy, 4640], 'white', 30, 'mf', **rep(2, [2400, 0, 0])),
      B("Light Diffuser", [-1480, -cy + 20, 4565, -920, -cy + 280, 4570], 'pc', 0, 'f', **rep(2, [2400, 0, 0])),
      F("Clear Height Sign", [-700, -cy - 80, 4300, 700, -cy - 70, 4500], 'yellow', 0, 'f'),
      F("Clear Height Text", [-500, -cy - 82, 4350, 500, -cy - 80, 4450], 'black', 0, 'f'),
      B("Sign Bracket", [-650, -cy - 70, 4500, 650, -cy + 75, 4580], 'dark', 0, 'f')]
add(f, "Ambulance drop-off canopy 6000 x 9000, steel SHS columns with impact guards, mono-pitch steel frame, metal roof sheet, gutter "
       "and downpipes, LED lighting, 4200 clear height",
    "IfcBuildingElementProxy", [("6000x9000_Canopy", "Ambulance bay canopy 6000 x 9000 mm, 4200 mm clear height")], cn,
    {"6000 x 9000 mm plan": A("6000x9000", "record type"), "Clear height 4200 mm under beams (4500 at low edge)": A(4200, "record note; HBN 15-01 ambulance access"),
     "Columns 200 SHS on pad foundations": A("200 SHS", "assumed, structural engineer to size"), "Lighting 240 V, 600 VA": A(600)},
    "Canopy modelled as a generic product (Generic Models kept): six SHS columns on pads and base plates with yellow/black impact guards, "
    "edge beams, three rafters, purlins, mono-pitch roof sheet and fascia, gutter on the low side, two downpipes with shoe, four LED "
    "fittings, clear-height sign. The 4200 clear-height check is a Clearance Operation solid. Structure is indicative: sizes are for "
    "the structural engineer.",
    category="Generic Models", connectors=[SAN("Downpipe 1", 110, 'bottom'), E("Light Fitting 1", 'top')], tv={**EV(240, 600)},
    clearances=[{"n": "Clear Height Check", "shape": "box", "at": [-cx + 150, -cy - 300, 0, cx - 150, cy + 300, 4200], "sub": "Clearance Operation"}])

f = 'FMC_A_GenericModel_Bollard_AmbulanceBay'
def bollard(r):
    return [C("Body", 'z', [0, 0], r, [-600, 1000], 'dark'),
            T("Dome Cap", 'z', [0, 0], [[0, 1050], [r * 0.4, 1046], [r * 0.72, 1035], [r * 0.92, 1018], [r + 4, 1000], [r + 4, 990], [0, 990]], 'dark'),
            C("Reflective Band", 'z', [0, 0], r + 1.5, [820, 900], 'yellow', 'f'),
            C("Reflective Band Lower", 'z', [0, 0], r + 1.5, [700, 760], 'yellow', 'f'),
            T("Ground Collar", 'z', [0, 0], [[r, 0], [r + 34, 0], [r + 34, 10], [r, 25]], 'dark', 'f')]
bo = [C("Footing", 'z', [0, 0], 175, [-600, 0], 'conc'), C("Rebar Anchor", 'y', [0, -400], 8, [-170, 170], 'steel', 'm')]
bo += only("150_Steel", bollard(76), "150") + only("200_Steel", bollard(110), "200")
add(f, "Ambulance bay bollard, 152 or 219 mm steel tube, concrete filled, domed cap, two reflective bands, cast into a 350 dia concrete footing",
    "IfcBuildingElementProxy", [("150_Steel", "Steel bollard 152 mm dia, 1000 mm high, concrete filled"),
                                ("200_Steel", "Steel bollard 219 mm dia, 1000 mm high, concrete filled")], bo,
    {"Tube 152 / 219 mm dia, 1000 mm above ground": A("152/219x1000"), "Footing 350 dia x 600 deep": A("350x600"), "Reflective bands 80 + 60 mm": A(80)},
    "Bollard modelled as a generic product: footing below ground (z < 0) and anchor bar shared; tube, domed cap, reflective bands and "
    "ground collar per type.", category="Site")

f = 'FMC_A_GenericModel_Ramp_Stretcher_External'
RISE, LAND, W = 500, 1800, 1000
def ramp(G):
    np_ = G // 1500; dz = RISE * 1500 / G
    up = lambda z0, z1: [[0, z0], [0, z1], [G, RISE + z1], [G + LAND, RISE + z1], [G + LAND, RISE + z0], [G, RISE + z0]]
    return [RT("Ramp Slab", [[0, -150], [0, 0], [G, RISE], [G + LAND, RISE], [G + LAND, -150]], [-W, W], 'conc'),
            RT("Kerb Left", up(0, 100), [-W, -W + 100], 'precast'), RT("Kerb Right", up(0, 100), [W - 100, W], 'precast'),
            RT("Landing Strip", [[G - 60, RISE - 5], [G - 60, RISE - 2], [G, RISE + 3], [G, RISE]], [-W + 100, W - 100], 'yellow', 'f'),
            C("Post", 'z', [-W + 50, 300], 24, [100 + 300 * RISE / G, 1100 + 300 * RISE / G], 'ss', **rep(np_, [0, 1500, dz])),
            C("Post Right", 'z', [W - 50, 300], 24, [100 + 300 * RISE / G, 1100 + 300 * RISE / G], 'ss', **rep(np_, [0, 1500, dz])),
            C("Landing Post", 'z', [-W + 50, G + 900], 24, [RISE + 100, RISE + 1100], 'ss', **rep(2, [2 * W - 100, 0, 0])),
            RT("Handrail Upper", [[-300, 975], [-300, 1025]] + up(975, 1025)[1:4] + up(975, 1025)[4:] + [[0, 975]], [-W + 25, -W + 75], 'ss'),
            RT("Handrail Upper Right", [[-300, 975], [-300, 1025]] + up(975, 1025)[1:4] + up(975, 1025)[4:] + [[0, 975]], [W - 75, W - 25], 'ss'),
            RT("Handrail Lower", up(575, 625), [-W + 30, -W + 70], 'ss'), RT("Handrail Lower Right", up(575, 625), [W - 70, W - 30], 'ss'),
            RT("Anti Slip Finish", [[0, 0], [0, 2], [G, RISE + 2], [G, RISE]], [-W + 100, W - 100], 'safety', 'f')]
rm = only("1in12_Ramp", ramp(6000), "1in12") + only("1in15_Ramp", ramp(7500), "1in15") + [
      RT("Contrast Strip", [[0, 0], [0, 3], [60, 8], [60, 5]], [-W + 100, W - 100], 'yellow', 'f'),
      C("Rail End Return", 'z', [-W + 50, -300], 25, [700, 1025], 'ss', 'f', **rep(2, [2 * W - 100, 0, 0])),
      B("Channel Drain", [-W, -150, -100, W, -50, 0], 'ss', 0, 'f')]
add(f, "External stretcher ramp 1:12 or 1:15, 2000 wide between kerbs, 500 rise plus 1800 top landing, upstand kerbs, "
       "stainless handrails at 1000 and 600 both sides with 300 extensions, contrasting nosings, channel drain",
    "IfcRamp", [("1in12_Ramp", "External stretcher ramp 1:12, 6000 going, 500 mm rise, 1800 mm wide clear"),
                ("1in15_Ramp", "External stretcher ramp 1:15, 7500 going, 500 mm rise, 1800 mm wide clear")], rm,
    {"Gradient 1:12 (6000 going) or 1:15 (7500 going), rise 500 mm": A("1:12/1:15", "Approved Document M table 2"), "Clear width 1800 mm between handrails": A(1800, "stretcher/bed passing"),
     "Landing 1800 mm": A(1800, "Approved Document M"), "Handrails 1000 and 600 mm, 300 extensions": A(1000, "Approved Document M / BS 8300-1")},
    "Ramp modelled as a generic product along +y (foot at y = 0): concrete slab (profile along x), kerbs, stainless posts following the "
    "slope (repeat with rise), upper and lower handrails with 300 extensions, anti-slip finish per type; foot contrast strip, end "
    "returns and channel drain shared.", category="Site")

# ================================================================= CLEARANCE HELPERS
def clearance(fam, sub_key, typ, desc, part, values, about):
    parts = part if isinstance(part, list) else [part]
    for q in parts: q['mat'] = sub_key; q['lod'] = 'mf'
    add(fam, desc, "IfcBuildingElementProxy", typ if isinstance(typ, list) else [typ], parts, values, about, category="Generic Models", shared=True,
        keynote_exempt="nested-only clearance helper; not scheduled or costed", clearance_only=True)

clearance('FMC_A_GenericModel_Clearance_TurningCircle', 'clearance_accessibility', ("1500_TurningCircle", "Wheelchair turning circle 1500 mm dia, clearance solid (never printed)"),
          "Wheelchair turning circle 1500 mm dia, nested clearance solid (non-plotting)",
          {"n": "Turning Circle", "shape": "cyl", "axis": "z", "c": [0, 0], "r": 750, "z": [0, 10], "seg": 48},
          {"Diameter 1500 mm": A(1500, "BS 8300-2 / Approved Document M"), "Solid 10 mm high at floor": A(10, "plan zone; wave 1 convention")},
          "Turning circle 1500 dia centred on the origin, 10 mm high, on Clearance Accessibility at all detail levels; nested by WCs, wards and rooms.")
clearance('FMC_A_GenericModel_Clearance_BedSpace', 'clearance_accessibility', ("1200_Perimeter", "Bed clear zone 1200 mm on both sides and the foot of a 2200 x 1000 bed"),
          "Acute bed clear zone: 1200 mm on both sides and at the foot of a 2200 x 1000 bed against the bedhead wall (non-plotting)",
          [{"n": "Clear Zone Left", "shape": "box", "at": [-1700, -2200, 0, -500, 0, 10]}, {"n": "Clear Zone Right", "shape": "box", "at": [500, -2200, 0, 1700, 0, 10]},
           {"n": "Clear Zone Foot", "shape": "box", "at": [-1700, -3400, 0, 1700, -2200, 10]}],
          {"Perimeter 1200 mm sides and foot": A(1200, "record type; HBN 04-01 bed-space clear zones"), "Bed footprint 2200 x 1000 mm": A("2200x1000", "acute/ICU bed class"),
           "Zone 3400 x 3400 mm overall": A("3400x3400")},
          "U-shaped zone (three boxes) around the bed footprint (left open), bedhead wall at y = 0, 10 mm high, on Clearance Accessibility.")
clearance('FMC_A_GenericModel_Clearance_DoorApproach', 'clearance_accessibility',
          [("450_LatchSide", "Latch-side approach zone 450 x 1500 mm"), ("600_LatchSide", "Latch-side approach zone 600 x 1500 mm (bed passage doors)")],
          "Latch-side door approach clearance 450 or 600 x 1500 beside the leading edge, pull side (non-plotting)",
          [{"n": "Approach Zone 450", "shape": "box", "at": [0, -1500, 0, 450, 0, 10], "only": ["450_LatchSide"]},
           {"n": "Approach Zone 600", "shape": "box", "at": [0, -1500, 0, 600, 0, 10], "only": ["600_LatchSide"]}],
          {"Latch side 450 / 600 mm": A("450/600", "ADA 404.2.4 front approach, pull side 455 mm; HBN 00-04 bed passage 600"),
           "Depth 1500 mm": A(1500, "ADA 404.2.4 (1525 mm) / BS 8300-2")},
          "Approach zone from the door's leading edge (x = 0) toward the latch side, from the wall face (y = 0) 1500 deep, 10 mm high, on "
          "Clearance Accessibility; one zone per type.")
clearance('FMC_A_GenericModel_Clearance_Maintenance', 'clearance_maintenance', ("1000x1000_Box", "Maintenance envelope 1000 wide x 1000 deep x 2000 high"),
          "Equipment maintenance envelope 1000 x 1000 x 2000 in front of the equipment face (non-plotting)",
          {"n": "Maintenance Envelope", "shape": "box", "at": [-500, -1000, 0, 500, 0, 2000]},
          {"Depth 1000 mm in front of the access face": A(1000, "BS 7671 / manufacturers' service space practice"), "Height 2000 mm": A(2000),
           "Width 1000 mm": A(1000)},
          "Box in front of the equipment face (y = 0 toward -y), 2000 high, on Clearance Maintenance; nested by plant families.")

# ================================================================= PARTITION, WASTE STORE
f = 'FMC_A_GenericModel_Partition_Cubicle_Glazed_ICU'
pz = [B("Head Box", [-1800, -60, 2400, 1800, 60, 2700], 'alupc'),
      B("Floor Guide", [-900, -35, 0, 900, 35, 8], 'alu', 0, 'f'),
      B("Jamb", [-1800, -50, 0, -1740, 50, 2400], 'alupc', **rep(2, [3540 - 300, 0, 0])),
      B("Mullion", [-960, -50, 0, -900, 50, 2400], 'alupc', **rep(2, [1860, 0, 0])),
      B("Service Spine", [1440, -80, 0, 1800, 60, 2400], 'epoxy', 10),
      B("Fixed Light Left", [-1740, -10, 50, -960, 10, 2390], 'glass'),
      B("Fixed Light Right", [960, -10, 50, 1440, 10, 2390], 'glass'),
      B("Sill Rail", [-1740, -40, 0, -960, 40, 50], 'alupc', **rep(2, [1920, 0, 0])),
      F("Door Leaf Left", [-900, -45, 15, 30, -25, 2390], 'glass'),
      F("Door Leaf Right", [-30, 25, 15, 900, 45, 2390], 'glass'),
      F("Door Frame Stile", [-900, -47, 15, -860, -23, 2390], 'alupc', **rep(2, [890, 0, 0])),
      F("Door Frame Stile Right", [-30, 23, 15, 10, 47, 2390], 'alupc', **rep(2, [890, 0, 0])),
      F("Door Rail", [-900, -47, 15, 30, -23, 70], 'alupc'),
      F("Door Rail Right", [-30, 23, 15, 900, 47, 70], 'alupc'),
      F("Pull Handle", [-60, -80, 800, -40, -50, 1400], 'ss', 8),
      F("Pull Handle Right", [40, 50, 800, 60, 80, 1400], 'ss', 8),
      F("Manifestation", [-1740, -12, 1000, 1440, -10, 1100], 'frost', 0, 'f'),
      F("Blind Slats", [-1740, -2, 1150, -960, 2, 2350], 'white', 0, 'f'),
      F("Blind Slats Door", [-860, -37, 70, -10, -33, 2350], 'white', 0, 'f'),
      F("Blind Knob", [-990, -14, 1300, -970, -10, 1340], 'grey', 4, 'f'),
      B("Door Operator Cover", [-900, -90, 2400, 900, -60, 2550], 'alupc', 0, 'f'),
      F("Motion Sensor", [-40, -95, 2420, 40, -90, 2460], 'black', 6, 'f'),
      F("Socket Panel", [1460, -82, 900, 1780, -80, 1300], 'white', 6),
      F("Socket", [1480, -84, 950, 1570, -82, 1020], 'white', 4, 'f', **rep(3, [100, 0, 0])),
      F("Data Outlet", [1480, -84, 1200, 1570, -82, 1270], 'white', 4, 'f'),
      F("Gas Panel", [1460, -82, 1400, 1780, -80, 1650], 'white', 6)]
for i, (g, col) in enumerate([("O2", 'white'), ("VAC", 'yellow'), ("AIR", 'black')]):
    pz += [T(f"Gas {g} Ring", 'y', [1525 + i * 100, 1525], [[16, -82], [22, -82], [22, -86], [16, -86]], col, 'f'),
           T(f"Gas {g} Socket", 'y', [1525 + i * 100, 1525], [[0, -80], [16, -80], [16, -92], [5, -94], [0, -94]], 'chrome')]
pz += [F("Nurse Call Panel", [1480, -84, 1750, 1760, -82, 1900], 'white', 6), F("Nurse Call Lamp", [1580, -86, 1860, 1660, -84, 1885], 'red', 3, 'f')]
add(f, "Glazed ICU cubicle front 3600 x 2700: aluminium framing, fixed side lights with integral blinds, automatic bi-parting sliding "
       "glass doors (1800 clear), service spine with gases, sockets, data and nurse call",
    "IfcBuildingElementProxy", [("3600x2700_Glazed", "ICU cubicle front 3600 x 2700 mm, 1800 mm sliding doors, service spine")], pz,
    {"3600 x 2700 mm overall": A("3600x2700", "record type"), "Sliding doors 1800 mm clear": A(1800, "HBN 04-02 critical care, bed passage"),
     "Integral blinds in glazing": A("blinds", "HBN 00-09 IPC"), "Service spine 240 V, 2 kVA": A(2000)},
    "ICU front modelled as a generic product, centred on the partition line (y = 0): head box, jambs, mullions, sill rails, two fixed lights "
    "with blinds and manifestation, two sliding glass leaves with frames and pull handles, operator cover with sensor, service spine with "
    "sockets, data, three colour-ringed gas outlets and nurse-call panel.",
    category="Generic Models", connectors=[E("Socket Panel"), ELV("NurseCall", "Nurse Call Panel")] + [MG(g, "Gas Panel") for g in ("O2", "VAC", "AIR")],
    tv={**EV(240, 2000)})

f = 'FMC_A_GenericModel_WasteStore_Clinical_Cage'
WX, WY, H = 1500, 2000, 2000
ws = [B("Slab", [-WX - 100, -WY - 100, -150, WX + 100, 100, 0], 'conc'),
      B("Gully", [-150, -1100, -60, 150, -900, 2], 'ss', 0, 'f'),
      B("Post", [-WX, -40, 0, -WX + 60, 20, H], 'galv', **rep(3, [WX - 30, 0, 0])),
      B("Post Front", [-WX, -WY, 0, -WX + 60, -WY + 60, H], 'galv', **rep(2, [2 * WX - 60, 0, 0])),
      B("Back Mesh", [-WX + 60, -10, 100, WX - 60, 0, H - 50], 'mesh'),
      B("Side Mesh", [-WX + 20, -WY + 60, 100, -WX + 30, -40, H - 50], 'mesh', **rep(2, [2 * WX - 50, 0, 0])),
      B("Roof Mesh", [-WX, -WY, H - 10, WX, 20, H], 'mesh', 0, 'mf'),
      B("Gate Frame Top", [-WX + 60, -WY + 10, H - 120, WX - 60, -WY + 50, H - 80], 'galv'),
      B("Gate Frame Bottom", [-WX + 60, -WY + 10, 80, WX - 60, -WY + 50, 120], 'galv'),
      B("Gate Meeting Stile", [-30, -WY + 10, 80, 30, -WY + 50, H - 80], 'galv'),
      C("Gate Bar", 'z', [-WX + 160, -WY + 30], 8, [120, H - 120], 'galv', 'mf', **rep(14, [100, 0, 0])),
      C("Gate Bar Right", 'z', [130, -WY + 30], 8, [120, H - 120], 'galv', 'mf', **rep(14, [100, 0, 0])),
      B("Padlock Hasp", [-40, -WY - 10, 1000, 40, -WY + 10, 1080], 'chrome', 0, 'f'),
      F("Warning Sign", [-1100, -WY - 2, 1400, -500, -WY + 8, 1800], 'yellow', 10),
      F("Warning Text", [-1050, -WY - 4, 1450, -550, -WY - 2, 1550], 'black', 0, 'f'),
      F("Warning Symbol", [-880, -WY - 4, 1600, -720, -WY - 2, 1760], 'black', 20, 'f')]
for i, (col, lid) in enumerate([('yellow', 'yellow'), ('orange', 'orange'), ('yellow', 'black'), ('black', 'black')]):
    x = -1100 + i * 730
    ws += [B(f"Bin {i + 1} Body", [x - 300, -1300, 60, x + 300, -300, 1250], col, 40),
           B(f"Bin {i + 1} Lid", [x - 310, -1320, 1250, x + 310, -280, 1300], lid, 40),
           C(f"Bin {i + 1} Wheel", 'x', [-1150, 60], 60, [x - 290, x - 230], 'rubber', 'f', **rep(2, [520, 0, 0])),
           C(f"Bin {i + 1} Castor", 'x', [-400, 60], 60, [x - 290, x - 230], 'rubber', 'f', **rep(2, [520, 0, 0]))]
add(f, "Clinical waste store cage 3000 x 2000 x 2000, galvanised posts and mesh, double barred gates with padlock hasp, warning sign, "
       "four colour-coded 1100 l wheeled bins, slab with gully",
    "IfcBuildingElementProxy", [("3000x2000_Cage", "Clinical waste cage 3000 x 2000 x 2000 mm, 4 x 1100 l bins, lockable")], ws,
    {"3000 x 2000 x 2000 mm": A("3000x2000x2000", "record type"), "Bins 1100 l, colour coded (yellow, orange, tiger, black)": A("4 x 1100 l", "HTM 07-01 colour code"),
     "Lockable, ventilated, washable floor with gully": A("lockable", "HTM 07-01 storage")},
    "Waste cage modelled as a generic product: slab with gully, galvanised posts, mesh back, sides and roof, double gates with frames, "
    "round bars, meeting stile and padlock hasp, warning sign; four bins (yellow, orange, yellow/black tiger, black) with lids, wheels and "
    "castors. Back at y = 0, gates at y = -2000.", category="Site")

# ================================================================= BUILD
def clearance_only(r, sub):
    """Clearance helpers: no Coarse Envelope (it would plot); the zone itself shows at every detail level (wave-1 convention)."""
    ops = []
    for o in r['ops']:
        if o.get('name') == 'Coarse Envelope': continue
        if o['op'] == 'set_visibility': o = dict(o, coarse=True)
        ops.append(o)
    r['ops'] = ops
    return r

if __name__ == '__main__':
    sel = sys.argv[1:]
    fams = [p['family'] for p in P]
    skipped = [r['family'] for r in RECS.values() if r['category'] == 'Profiles']
    missing = [f for f in RECS if f not in fams and f not in skipped]
    assert not missing, missing
    out = []
    for prod in P:
        if sel and not any(s in prod['family'] for s in sel): continue
        co = prod.pop('clearance_only', False)
        n = len(fp.expand(prod['parts']))
        assert n <= 70, (prod['family'], n)
        for t in prod['types']:
            import re
            assert re.match(r'^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$', t['name']), t['name']
        for m in prod['materials'].values(): assert m is None or m in open(os.path.join(HERE, 'batches', 'KIT_MATERIALS.txt')).read(), m
        names = [p['n'] for p in fp.expand(prod['parts'])]
        assert len(names) == len(set(names)), [x for x in names if names.count(x) > 1]
        for c in prod.get('connectors', []): assert c['part'] in names, (prod['family'], c['part'])
        json.dump(prod, open(os.path.join(HERE, prod['family'] + '.product.json'), 'w'), indent=1)
        r = fp.compile_product(prod)
        if co: r = clearance_only(r, None)
        json.dump(r, open(os.path.join(HERE, prod['family'] + '.recipe.json'), 'w'), indent=1)
        fp.render(prod, os.path.join(HERE, prod['family'] + '.preview.png'))
        fp.render_type_image(prod, os.path.join(HERE, prod['family'] + '.png'), size=600)
        out.append((prod['family'], n, len(r['ops'])))
        print(out[-1], flush=True)
    json.dump(NEEDED, open(os.path.join(HERE, 'batches', 'A2_arch.materials_needed.json'), 'w'), indent=1)
    print(len(out), 'families; skipped profiles:', skipped)
