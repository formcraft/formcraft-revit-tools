"""Healthcare pack, batch M_mechanical (42 families): AHUs, chillers, fans, FCUs, diffusers, grilles, dampers,
HEPA terminals, steam plant, cold rooms, controls. Parts models in the make_products.py pattern, compiled and rendered
with ../../tools/fmc_parts.py.
Run: python3 gen_M_mechanical.py [family-substring ...]   (writes <family>.product.json, .recipe.json, .preview.png, .png)"""
import json, os, sys, math, re
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import fmc_parts as fp

RECS = {r['family']: r for r in json.load(open(os.path.join(HERE, 'batches', 'M_mechanical.json')))}
A = lambda v, src='typical product, to confirm with the supplier': {"value": v, "source_status": "assumed", "source": src}
MAT = {"white": "FMC_Plastic_ABS_White", "grey": "FMC_Plastic_ABS_Grey", "mgrey": "FMC_Plastic_ABS_MedicalGrey",
       "black": "FMC_Plastic_ABS_Black", "blue": "FMC_Plastic_ABS_Blue", "yellow": "FMC_Plastic_ABS_Yellow",
       "ledg": "FMC_Plastic_LED_Green", "ledr": "FMC_Plastic_LED_Red", "ledb": "FMC_Plastic_LED_Blue",
       "epw": "FMC_Metal_Steel_EpoxyCoated_White", "pcg": "FMC_Metal_Aluminium_PowderCoated", "alu": "FMC_Metal_Aluminium_Anodised_Silver",
       "galv": "FMC_Metal_Duct_Galvanised", "ss": "FMC_Metal_StainlessSteel_Brushed", "dark": "FMC_Metal_SteelLTZ_Painted",
       "chrome": "FMC_Metal_Chrome_Polished", "copper": "FMC_Metal_Copper_Pipe", "brass": "FMC_Metal_Brass_Polished",
       "gi": "FMC_Metal_GI_Pipe", "steel": "FMC_Metal_StructuralSteel_S275", "rubber": "FMC_Rubber_Black",
       "lag": "FMC_Insulation_Elastomeric_Black", "mesh": "FMC_Plastic_InsectMesh_Fibreglass", "glass": "FMC_Glass_Clear",
       "pc": "FMC_Plastic_Polycarbonate_Clear", "enamel": "FMC_Paint_Gloss_Enamel", "red": "FMC_Metal_Steel_Painted_Red", "lgrey": "FMC_Metal_Steel_PowderCoated_LightGrey", "mblue": "FMC_Metal_Steel_Painted_MotorBlue",
       "fin": "FMC_Metal_Aluminium_FinCoil", "amber": "FMC_Plastic_LED_Amber", "hepa": "FMC_Filter_Media_HEPA_White",
       "upvc": "FMC_Plastic_uPVC_Pipe_DarkGrey"}
NEEDED = [
    {"name": "FMC_Metal_Steel_PowderCoated_LightGrey", "colour": "#CFD3D0", "why": "RAL 7035 casings of AHUs, chillers, VRF and condensing units (FMC_Metal_Steel_EpoxyCoated_White used for now)"},
    {"name": "FMC_Metal_Steel_Painted_MotorBlue", "colour": "#1F4E8C", "why": "RAL 5010 cast-iron pump volutes and fan motors (FMC_Metal_Aluminium_PowderCoated used for now)"},
    {"name": "FMC_Metal_Steel_Painted_Red", "colour": "#B3261E", "why": "steam boiler burner housing (FMC_Metal_SprinklerPipe_RedPainted used for now)"},
    {"name": "FMC_Metal_Aluminium_FinCoil", "colour": "#A9B2B8", "why": "finned refrigerant / CHW coil blocks (FMC_Metal_Aluminium_Anodised_Silver used for now)"},
    {"name": "FMC_Plastic_LED_Amber", "colour": "#FFB000", "why": "amber warning LED on room pressure monitors (FMC_Plastic_ABS_Yellow used for now)"},
    {"name": "FMC_Filter_Media_HEPA_White", "colour": "#F4F4F0", "why": "pleated HEPA / laminar-flow screen media (FMC_Plastic_ABS_MedicalGrey / Steel_EpoxyCoated_White used for now)"},
]
P = []
TYPE_RE = re.compile(r'^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$')

# ---------------------------------------------------------------- part helpers
def _l(d, lod, r=0, seg=None):
    if lod != 'mf': d['lod'] = lod
    if r: d['r'] = r
    if seg: d['seg'] = seg
    return d
def B(n, at, mat, r=0, lod='mf'): return _l({"n": n, "shape": "box", "at": [round(v, 2) for v in at], "mat": mat}, lod, r)
def F(n, at, mat, r=0, lod='mf'): return _l({"n": n, "shape": "fbox", "at": [round(v, 2) for v in at], "mat": mat}, lod, r)
def CZ(n, c, r, z, mat, lod='mf', seg=None): return _l({"n": n, "shape": "cyl", "axis": "z", "c": list(c), "r": r, "z": list(z), "mat": mat}, lod, 0, seg)
def CY(n, c, r, y, mat, lod='mf', seg=None): return _l({"n": n, "shape": "cyl", "axis": "y", "c": list(c), "r": r, "y": list(y), "mat": mat}, lod, 0, seg)
def CX(n, c, r, x, mat, lod='mf', seg=None): return _l({"n": n, "shape": "cyl", "axis": "x", "c": list(c), "r": r, "x": list(x), "mat": mat}, lod, 0, seg)
def T(n, ax, c, prof, mat, lod='mf'): return _l({"n": n, "shape": "turn", "axis": ax, "c": list(c), "profile": [[round(a, 2), round(b, 2)] for a, b in prof], "mat": mat}, lod)
def PR(n, pts, z, mat, lod='mf'): return _l({"n": n, "shape": "prism", "pts": [[round(a, 2), round(b, 2)] for a, b in pts], "z": list(z), "mat": mat}, lod)
def FR(n, pts, y, mat, lod='mf'): return _l({"n": n, "shape": "front", "pts": [[round(a, 2), round(b, 2)] for a, b in pts], "y": list(y), "mat": mat}, lod)
def RT(n, pts, x, mat, lod='mf'): return _l({"n": n, "shape": "right", "pts": [[round(a, 2), round(b, 2)] for a, b in pts], "x": list(x), "mat": mat}, lod)
def rep(p, n, d): p['repeat'] = {"n": n, "d": list(d)}; return p
def ring(r0, r1, t0, t1): return [[r0, t0], [r1, t0], [r1, t1], [r0, t1]]

def blade_pts(cu, cv, r0, r1, a, span=50, sweep=14):
    """Fan blade outline around (cu, cv): wide at the tip, narrow and swept at the hub."""
    out = [(cu + r1 * math.cos(math.radians(a + s)), cv + r1 * math.sin(math.radians(a + s))) for s in (-span / 2, -span / 4, 0, span / 4, span / 2)]
    inn = [(cu + r0 * math.cos(math.radians(a + sweep + s)), cv + r0 * math.sin(math.radians(a + sweep + s))) for s in (span / 4, -span / 4)]
    return out + inn

def volute_pts(cu, cv, r0, grow, out_h):
    """Scroll casing outline (u right, v up): spiral from 0 to -270 deg, then a vertical discharge on the right."""
    pts = [(cu + r0, cv)]
    for k in range(1, 19):
        th = -15 * k; r = r0 + grow * (-th) / 270
        pts.append((cu + r * math.cos(math.radians(th)), cv + r * math.sin(math.radians(th))))
    top = cv + r0 + grow
    pts += [(cu, top + out_h), (cu + r0, top + out_h)]
    return pts

def frame4(pfx, x0, x1, z0, z1, y0, y1, t, mat, lod='mf'):
    """Rectangular frame seen from the front: four bars."""
    return [F(f"{pfx} Top", [x0, y0, z1 - t, x1, y1, z1], mat, 0, lod), F(f"{pfx} Bottom", [x0, y0, z0, x1, y1, z0 + t], mat, 0, lod),
            F(f"{pfx} Left", [x0, y0, z0 + t, x0 + t, y1, z1 - t], mat, 0, lod), F(f"{pfx} Right", [x1 - t, y0, z0 + t, x1, y1, z1 - t], mat, 0, lod)]

def fan_top(pfx, cx, cy, z, R, nb=3, shroud='epw', guard='dark', blade='grey'):
    """Top-discharge axial fan: shroud ring, wire guard rings and bars, hub, blades."""
    h = max(120, R * 0.3)
    p = [T(f"{pfx} Shroud", 'z', [cx, cy], ring(R, R + 14, z, z + h), shroud),
         T(f"{pfx} Guard Outer", 'z', [cx, cy], ring(R - 8, R + 4, z + h, z + h + 8), guard, 'f'),
         T(f"{pfx} Guard Inner", 'z', [cx, cy], ring(R * 0.5 - 5, R * 0.5 + 5, z + h, z + h + 8), guard, 'f'),
         B(f"{pfx} Guard Bar", [cx - R, cy - 4, z + h, cx + R, cy + 4, z + h + 8], guard, 0, 'f'),
         CZ(f"{pfx} Hub", [cx, cy], R * 0.16, [z + h * 0.35, z + h * 0.75], 'dark')]
    for k in range(nb):
        p.append(PR(f"{pfx} Blade {k + 1}", blade_pts(cx, cy, R * 0.15, R * 0.93, 90 + 360 / nb * k, 46), [z + h * 0.5, z + h * 0.5 + 5], blade, 'f'))
    return p

def fan_front(pfx, cx, cz, R, yf, nb=3, bezel='epw', guard='dark', blade='grey'):
    """Front-facing axial fan on a casing face at y = yf: dark opening, bezel, blades, hub, guard rings and bars."""
    return ([CY(f"{pfx} Opening", [cx, cz], R, [yf - 1.5, yf], 'black'),
             T(f"{pfx} Bezel", 'y', [cx, cz], ring(R, R + 18, yf - 8, yf), bezel),
             CY(f"{pfx} Hub", [cx, cz], R * 0.18, [yf - 18, yf - 1.5], 'dark')] +
            [FR(f"{pfx} Blade {k + 1}", blade_pts(cx, cz, R * 0.16, R * 0.92, 90 + 360 / nb * k, 50), [yf - 7, yf - 4], blade, 'f') for k in range(nb)] +
            [T(f"{pfx} Guard Outer", 'y', [cx, cz], ring(R - 6, R + 2, yf - 16, yf - 12), guard, 'f'),
             T(f"{pfx} Guard Mid", 'y', [cx, cz], ring(R * 0.62 - 3, R * 0.62 + 3, yf - 16, yf - 12), guard, 'f'),
             T(f"{pfx} Guard Inner", 'y', [cx, cz], ring(R * 0.3 - 3, R * 0.3 + 3, yf - 16, yf - 12), guard, 'f'),
             F(f"{pfx} Guard Bar H", [cx - R, yf - 15, cz - 3, cx + R, yf - 12, cz + 3], guard, 0, 'f'),
             F(f"{pfx} Guard Bar V", [cx - 3, yf - 15, cz - R, cx + 3, yf - 12, cz + R], guard, 0, 'f')])

def elec(volts, va, poles=None):
    tv = {"Voltage": volts, "Apparent Load": va}
    if poles: tv["Number of Poles"] = poles
    return tv
def E(part, side='back'): return {"n": "Power", "domain": "electrical", "system": "PowerBalanced", "part": part, "side": side}
def ELV(part, system='Data', side='back'): return {"n": system, "domain": "electrical", "system": system, "part": part, "side": side}
def SAN(part, side, d=40): return {"n": "Condensate", "domain": "pipe", "system": "Sanitary", "part": part, "side": side, "diameter": d, "flow": "Out"}
def DUCT(n, system, part, side, flow, d=None, w=None, h=None):
    c = {"n": n, "domain": "duct", "system": system, "part": part, "side": side, "flow": flow}
    if d: c['diameter'] = d
    if w: c['width'] = w; c['height'] = h
    return c

def make(fam, desc, ifc, types, parts, conns=(), values=None, about='', tv=None, clear=None, template=None):
    rec = RECS[fam]; cat = rec['category']
    tmpl = template or ('Metric Mechanical Equipment.rft' if cat == 'Mechanical Equipment' else 'Metric Generic Model.rft')
    types = [t if isinstance(t, dict) else {"name": t} for t in types]
    for t in types: assert TYPE_RE.match(t['name']), (fam, t['name'])
    ex = fp.expand(parts); names = [p['n'] for p in ex]
    assert len(names) == len(set(names)), (fam, [n for n in names if names.count(n) > 1])
    assert len(ex) <= 70, (fam, len(ex))
    for c in conns: assert c['part'] in names, (fam, c['part'])
    assert values and 2 <= len(values) <= 5, (fam, len(values or {}))
    used = sorted({p['mat'] for p in ex if p.get('mat')})
    prod = {"family": fam, "category": cat, "template": tmpl, "desc": desc, "ifc": ifc, "keynote": rec['kn'], "types": types,
            "type_values": tv or {}, "materials": {k: MAT[k] for k in used}, "reference": dict(rec['ref']), "parts": parts,
            "connectors": list(conns), "values": values, "about": about}
    if clear: prod['clearances'] = clear
    if any(k in fam for k in ('Cassette', 'Ducted_FCU', 'ERV', 'Evaporator', 'Diffuser', 'HEPA_Terminal')): prod['view'] = 'below'
    P.append(prod); return prod

# ================================================================= 1. split AC, high wall indoor
def split_wall():
    s = lambda pts: [(y - 8, z) for y, z in pts]
    body = s([(0, 0), (0, 315), (-170, 315), (-205, 300), (-225, 265), (-230, 200), (-225, 120), (-212, 75), (-175, 58), (-125, 40), (-85, 25), (-70, 0)])
    parts = [
        B("Mounting Plate", [-420, -8, 30, 420, 0, 280], 'galv'),
        RT("Body", body, [-490, 490], 'white'),
        RT("End Cap Left", body, [-500, -490], 'mgrey', 'f'), RT("End Cap Right", body, [490, 500], 'mgrey', 'f'),
        F("Front Panel", [-492, -246, 110, 492, -236, 302], 'white', 14),
        RT("Outlet Throat", s([(-212, 75), (-85, 25), (-86, 19), (-213, 69)]), [-450, 450], 'black'),
        RT("Louvre Flap", s([(-218, 70), (-150, 42), (-148, 36), (-220, 64)]), [-455, 455], 'white'),
        rep(B("Vane", [-412, -170, 30, -408, -110, 50], 'mgrey', 0, 'f'), 8, [117, 0, 0]),
        rep(B("Intake Slot", [-450, -175, 315, -440, -30, 318], 'mgrey', 0, 'f'), 16, [60, 0, 0]),
        F("Display Window", [290, -248, 140, 430, -246, 172], 'black', 6, 'f'),
        CY("LED Run", [330, 156], 4, [-249, -248], 'ledg', 'f'), CY("LED Timer", [360, 156], 4, [-249, -248], 'ledb', 'f'),
        CX("Liquid Line", [-40, 45], 5, [-560, -500], 'copper'), CX("Suction Line", [-70, 45], 8, [-560, -500], 'copper'),
        CX("Condensate Drain", [-30, 16], 9, [-580, -500], 'grey')]
    types = [{"name": n, "values": {"Apparent Load": va}} for n, va in (("2.6kW_9kBTU", 800), ("3.5kW_12kBTU", 1100), ("5.3kW_18kBTU", 1700), ("7.0kW_24kBTU", 2300))]
    make("FMC_M_MechEq_AC_Split_WallHigh", "Split air conditioner, high-wall indoor unit 2.6 to 7.0 kW (9k to 24k BTU/h), white, curved body, outlet louvre, top intake",
         "IfcUnitaryEquipment", types, parts, [E("Mounting Plate"), SAN("Condensate Drain", "left")],
         {"Unit 1000 x 315 x 238 mm (18k)": A("1000x315x238", "typical 18k BTU/h high-wall indoor unit"), "Cooling 2.6 / 3.5 / 5.3 / 7.0 kW": A("2.6-7.0kW", "9k-24k BTU/h, 1 kW = 3412 BTU/h"),
          "Condensate 16 mm hose to 40 mm waste": A(40, "condensate hose to tundish / trapped waste"), "Mounting height 2100 mm": A(2100, "underside of unit, room practice")},
         "Modelled as a generic product: curved white body on a mounting plate, flat front panel, dark outlet throat with swing flap and vertical vanes, top intake slots, display with LEDs, refrigerant and condensate tails at the left.",
         dict(elec(240, 1700), **{"Default Elevation": 2100}))

# ================================================================= 2. split AC outdoor
def split_outdoor():
    parts = [B("Foot Rail", [-400, -170, 0, -340, 170, 40], 'dark'), B("Foot Rail Right", [340, -170, 0, 400, 170, 40], 'dark'),
             B("Casing", [-422, -150, 40, 422, 150, 600], 'epw', 8),
             B("Top Panel", [-428, -156, 600, 428, 156, 612], 'epw', 6),
             B("Valve Cover", [422, -110, 80, 434, 70, 320], 'mgrey', 4),
             CX("Service Valve Liquid", [-40, 130], 8, [434, 470], 'brass'), CX("Service Valve Gas", [10, 130], 12, [434, 470], 'brass'),
             B("Coil Fins", [-410, 150, 60, 410, 158, 585], 'fin'),
             rep(F("Coil Guard Bar", [-410, 158, 90, 410, 162, 94], 'dark', 0, 'f'), 10, [0, 0, 50]),
             F("Rating Plate", [260, -152, 470, 380, -150, 540], 'alu', 0, 'f'),
             F("Handle Recess", [300, -152, 120, 380, -150, 150], 'black', 6, 'f')]
    parts += fan_front("Fan", -110, 320, 215, -150, 3)
    make("FMC_M_MechEq_AC_Split_Outdoor", "Split air conditioner outdoor condensing unit 2.6 to 7.0 kW, single front fan with guard, rear finned coil, side service valves",
         "IfcUnitaryEquipment", ["2.6-7.0kW_Condensing"], parts, [E("Valve Cover", "right")],
         {"Unit 845 x 300 x 612 mm": A("845x300x612", "typical 9k-24k BTU/h condensing unit"), "Fan 430 mm": A(430), "Load 2300 VA": A(2300, "24k BTU/h unit running current, engineer confirms"),
          "Service clearance 300 mm rear, 500 mm front": A("300/500", "manufacturer practice")},
         "Modelled as a generic product: white casing on foot rails, front axial fan with bezel, blades, hub and wire guard, finned coil with guard bars at the rear, right-side valve cover with liquid and gas service valves.",
         elec(240, 2300))

# ================================================================= 3/6. cassettes
def cassette(fam, pan, bod, h, types, desc, vals, about, va, compact=False):
    P2, B2 = pan / 2, bod / 2; sl = 70 if not compact else 50
    g = (P2 - 175) if not compact else (P2 - 130)
    parts = [B("Chassis", [-B2, -B2, 0, B2, B2, h], 'galv', 20),
             B("Panel", [-P2, -P2, -35, P2, P2, 0], 'white', 30 if not compact else 14),
             B("Intake Grille", [-g, -g, -37, g, g, -35], 'white', 8)]
    o0, o1 = g + 25, g + 25 + sl
    for nm, at in (("North", [-g, o0, -36.5, g, o1, -35]), ("South", [-g, -o1, -36.5, g, -o0, -35]), ("East", [o0, -g, -36.5, o1, g, -35]), ("West", [-o1, -g, -36.5, -o0, g, -35])):
        parts.append(B(f"Outlet Slot {nm}", at, 'black'))
    f0, f1 = o0 + sl * 0.25, o0 + sl * 0.65
    for nm, at in (("North", [-g + 10, f0, -44, g - 10, f1, -36.5]), ("South", [-g + 10, -f1, -44, g - 10, -f0, -36.5]), ("East", [f0, -g + 10, -44, f1, g - 10, -36.5]), ("West", [-f1, -g + 10, -44, -f0, g - 10, -36.5])):
        parts.append(B(f"Louvre Flap {nm}", at, 'white'))
    n = 14 if not compact else 10; d = (2 * g - 20) / (n - 1)
    parts.append(rep(B("Grille Slat", [-g + 6, -g + 6, -39, g - 6, -g + 12, -37], 'mgrey', 0, 'f'), n, [0, d, 0]))
    c0 = P2 - 8 - (sl * 0.9)
    parts += [rep(B("Corner Cover Front", [-P2 + 8, -P2 + 8, -37, -c0, -c0, -35], 'mgrey', 0, 'f'), 2, [c0 + P2 - 8, 0, 0]),
              rep(B("Corner Cover Rear", [-P2 + 8, c0, -37, -c0, P2 - 8, -35], 'mgrey', 0, 'f'), 2, [c0 + P2 - 8, 0, 0])]
    parts += [B("Signal Receiver", [P2 - 70, -P2 + 14, -38, P2 - 20, -P2 + 34, -35], 'black', 0, 'f'),
              CZ("Receiver LED", [P2 - 32, -P2 + 24], 3, [-39, -38], 'ledg', 'f'),
              rep(B("Hanger Bracket Left", [-B2 - 40, -B2 + 60, h - 70, -B2, -B2 + 120, h - 30], 'dark'), 2, [0, bod - 180, 0]),
              rep(B("Hanger Bracket Right", [B2, -B2 + 60, h - 70, B2 + 40, -B2 + 120, h - 30], 'dark'), 2, [0, bod - 180, 0]),
              B("Electrical Box", [-B2 + 80, -B2 - 45, 60, -B2 + 260, -B2, 200], 'dark'),
              CX("Drain Socket", [B2 - 220, 170], 16, [B2, B2 + 50], 'grey'),
              CX("Liquid Line", [-B2 + 160, 140], 6, [B2, B2 + 50], 'copper'), CX("Gas Line", [-B2 + 200, 140], 9.5, [B2, B2 + 50], 'copper')]
    if compact:
        parts.append(B("EEV Kit Box", [B2, -B2 + 40, 40, B2 + 120, -B2 + 200, 180], 'galv'))
    make(fam, desc, "IfcUnitaryEquipment", types, parts, [E("Electrical Box", "front"), SAN("Drain Socket", "right")], vals, about,
         dict(elec(240, va), **{"Default Elevation": 2700}))

# ================================================================= 4. ducted FCU
def ducted_fcu():
    parts = [B("Casing", [-500, -330, -280, 500, 350, -20], 'galv'),
             B("Supply Spigot", [-420, -380, -250, 420, -330, -50], 'galv'),
             F("Supply Flange", [-440, -386, -270, 440, -380, -30], 'dark'),
             F("Supply Opening", [-410, -388, -245, 410, -386, -55], 'black'),
             F("Filter Frame", [-470, 350, -270, 470, 380, -30], 'dark'),
             F("Filter Media", [-450, 380, -255, 450, 384, -45], 'mesh'),
             rep(F("Filter Pull", [-330, 384, -160, -290, 395, -140], 'black', 0, 'f'), 2, [620, 0, 0]),
             B("Access Panel", [-450, -300, -285, 450, 320, -280], 'galv'),
             rep(CZ("Panel Screw", [-430, -280], 5, [-287, -285], 'chrome', 'f'), 3, [430, 0, 0]),
             rep(CZ("Panel Screw Rear", [-430, 300], 5, [-287, -285], 'chrome', 'f'), 3, [430, 0, 0]),
             B("Control Box", [500, -180, -250, 560, 120, -60], 'dark'),
             CX("Drain Spigot", [200, -262], 16, [-560, -500], 'grey'),
             CX("Liquid Line", [80, -200], 6, [-560, -500], 'copper'), CX("Gas Line", [130, -200], 9.5, [-560, -500], 'copper'),
             rep(B("Hanger Bracket Left", [-530, -320, -110, -500, -280, -60], 'dark'), 2, [0, 620, 0]),
             rep(B("Hanger Bracket Right", [500, -320, -110, 530, -280, -60], 'dark'), 2, [0, 620, 0]),
             rep(CZ("Hanger Rod Left", [-515, -300], 5, [-60, 0], 'gi', 'f'), 2, [0, 620, 0]),
             rep(CZ("Hanger Rod Right", [515, -300], 5, [-60, 0], 'gi', 'f'), 2, [0, 620, 0])]
    types = [{"name": "5kW_Ducted", "values": {"Apparent Load": 250}}, {"name": "10kW_Ducted", "values": {"Apparent Load": 450}}]
    make("FMC_M_MechEq_AC_Ducted_FCU", "Ducted fan coil / ducted split indoor unit 5 to 10 kW, ceiling-void mounted, rectangular supply spigot, rear filter return, side drain",
         "IfcUnitaryEquipment", types, parts,
         [E("Control Box", "right"), DUCT("Supply", "SupplyAir", "Supply Opening", "front", "Out", w=820, h=190), SAN("Drain Spigot", "left")],
         {"Casing 1000 x 680 x 260 mm": A("1000x680x260", "typical 5-10 kW ducted unit"), "Supply spigot 820 x 190 mm": A("820x190"), "External static 50 Pa": A(50, "standard ESP setting"),
          "Fan load 250 / 450 VA": A("250/450")},
         "Modelled as a generic product: galvanised casing hung on four brackets and rods below the slab (z = 0), supply spigot with flange, rear filter frame with mesh and pulls, underside access panel with screws, control box, drain and refrigerant tails.",
         dict(elec(240, 450), **{"Default Elevation": 3000}))

# ================================================================= 5. VRF outdoor
def vrf_outdoor():
    parts = [B("Base Frame", [-620, -382, 0, 620, 382, 80], 'dark'),
             rep(B("Corner Post Front", [-620, -382, 80, -580, -342, 1600], 'pcg'), 2, [1200, 0, 0]),
             rep(B("Corner Post Rear", [-620, 342, 80, -580, 382, 1600], 'pcg'), 2, [1200, 0, 0]),
             F("Front Panel Lower", [-580, -385, 80, 580, -376, 760], 'lgrey'),
             F("Front Panel Upper", [-580, -385, 760, 580, -376, 1600], 'lgrey'),
             F("Service Cover", [300, -392, 300, 560, -385, 700], 'lgrey', 6),
             F("Cover Handle", [400, -398, 640, 460, -392, 660], 'black', 4, 'f'),
             F("Rating Plate", [-500, -387, 1350, -340, -385, 1450], 'alu', 0, 'f'),
             B("Core", [-580, -376, 80, 580, 376, 1600], 'dark'),
             B("Coil Left", [-623, -342, 120, -619, 342, 1560], 'fin'), B("Coil Right", [619, -342, 120, 623, 342, 1560], 'fin'),
             B("Coil Rear", [-580, 376, 120, 580, 381, 1560], 'fin'),
             rep(B("Guard Bar Left", [-629, -342, 200, -623, 342, 208], 'dark', 0, 'f'), 8, [0, 0, 180]),
             rep(B("Guard Bar Right", [623, -342, 200, 629, 342, 208], 'dark', 0, 'f'), 8, [0, 0, 180]),
             rep(B("Guard Bar Rear", [-580, 381, 200, 580, 387, 208], 'dark', 0, 'f'), 8, [0, 0, 180]),
             B("Top Deck", [-620, -382, 1600, 620, 382, 1620], 'lgrey'),
             CY("Liquid Valve", [440, 200], 10, [-410, -385], 'brass'), CY("Gas Valve", [490, 200], 16, [-410, -385], 'brass'),
             CY("Oil Equaliser Valve", [540, 200], 8, [-405, -385], 'brass', 'f')]
    parts += fan_top("Fan Left", -300, 0, 1620, 285, 3, shroud='lgrey') + fan_top("Fan Right", 300, 0, 1620, 285, 3, shroud='lgrey')
    types = [{"name": "28kW_VRF", "values": {"Apparent Load": 9000}}, {"name": "56kW_VRF", "values": {"Apparent Load": 18000}}]
    make("FMC_M_MechEq_VRF_Outdoor", "VRF heat-pump outdoor unit 28 to 56 kW, twin top-discharge fans, three-side finned coil with guards, front service panel, 415 V 3-phase",
         "IfcUnitaryEquipment", types, parts, [E("Front Panel Lower", "front")],
         {"Unit 1240 x 765 x 1690 mm": A("1240x765x1690", "typical twin-fan VRF module"), "Cooling 28 / 56 kW": A("28/56kW"), "Load 9 / 18 kVA, 415 V 3-phase": A("9/18kVA", "engineer confirms from selection"),
          "Service clearance 500 mm front, 300 mm sides": A("500/300", "manufacturer practice")},
         "Modelled as a generic product: base frame, corner posts, white front panels with service cover and handle, finned coil on sides and rear with guard bars, top deck with two fans (shroud, guard, hub, blades), service valves.",
         elec(415, 18000, 3), [{"n": "Service Space", "shape": "box", "at": [-620, -882, 0, 620, -382, 1690], "sub": "Clearance Maintenance"}])

# ================================================================= 7. close control unit
def precision():
    parts = [rep(CZ("Leg Foot Front", [-410, -335], 30, [0, 25], 'rubber'), 2, [820, 0, 0]),
             rep(CZ("Leg Foot Rear", [-410, 335], 30, [0, 25], 'rubber'), 2, [820, 0, 0]),
             rep(B("Stand Leg Front", [-430, -355, 25, -390, -315, 260], 'steel'), 2, [820, 0, 0]),
             rep(B("Stand Leg Rear", [-430, 315, 25, -390, 355, 260], 'steel'), 2, [820, 0, 0]),
             B("Stand Frame", [-450, -375, 260, 450, 375, 300], 'steel'),
             T("EC Fan Rotor", 'z', [0, 0], ring(200, 230, 60, 250), 'dark'), CZ("EC Fan Motor", [0, 0], 110, [80, 260], 'pcg'),
             T("EC Fan Inlet Ring", 'z', [0, 0], ring(160, 235, 250, 260), 'galv', 'f'),
             B("Cabinet", [-450, -370, 300, 450, 375, 2250], 'pcg'),
             F("Door Left", [-445, -380, 310, -3, -370, 2240], 'dark'), F("Door Right", [3, -380, 310, 445, -370, 2240], 'dark'),
             F("Door Perforation Left", [-405, -382, 1450, -45, -380, 2180], 'mesh', 0, 'f'), F("Door Perforation Right", [45, -382, 1450, 405, -380, 2180], 'mesh', 0, 'f'),
             F("Handle Left", [-60, -394, 1150, -35, -382, 1330], 'chrome', 4), F("Handle Right", [35, -394, 1150, 60, -382, 1330], 'chrome', 4),
             F("Display Bezel", [90, -384, 1210, 330, -380, 1390], 'black', 6), F("Display Screen", [102, -386, 1222, 318, -384, 1378], 'ledb', 3, 'f'),
             CY("Status LED Run", [360, 1360], 6, [-386, -380], 'ledg', 'f'), CY("Status LED Alarm", [360, 1330], 6, [-386, -380], 'ledr', 'f'),
             rep(CZ("Hinge Left", [-446, -383], 8, [450, 560], 'chrome', 'f'), 3, [0, 0, 760]),
             rep(CZ("Hinge Right", [446, -383], 8, [450, 560], 'chrome', 'f'), 3, [0, 0, 760]),
             B("Top Grille", [-430, -355, 2250, 430, 355, 2254], 'mesh'),
             rep(B("Top Grille Slat", [-430, -355, 2254, -422, 355, 2262], 'dark', 0, 'f'), 20, [44.6, 0, 0]),
             F("Rating Plate", [-400, -382, 400, -280, -380, 470], 'alu', 0, 'f'),
             CY("Condensate Drain", [300, 360], 16, [375, 425], 'grey'),
             CY("Humidifier Feed", [200, 360], 8, [375, 420], 'copper', 'f')]
    make("FMC_M_MechEq_AC_Precision_ServerRoom", "Close-control (precision) air conditioner 10 kW, downflow, floor stand with EC fan, dark front doors with perforated upper panels, touch display",
         "IfcUnitaryEquipment", ["10kW_Downflow"], parts, [E("Cabinet", "top"), SAN("Condensate Drain", "back")],
         {"Cabinet 900 x 750 x 1950 mm on 300 mm stand": A("900x750x1950", "typical 10 kW close-control unit"), "Cooling 10 kW sensible": A("10kW"),
          "Load 9 kVA, 415 V 3-phase (with heater and humidifier)": A(9000, "engineer confirms"), "Front service clearance 900 mm": A(900, "manufacturer practice")},
         "Modelled as a generic product: floor stand with legs, feet and an EC fan lowered into the floor void, grey cabinet, two dark doors with perforated panels, handles, hinges, touch display and LEDs, top return grille, rear drain.",
         elec(415, 9000, 3), [{"n": "Front Service", "shape": "box", "at": [-450, -1280, 0, 450, -380, 2250], "sub": "Clearance Maintenance"}])

# ================================================================= 8/9. AHUs
def ahu(fam, sections, D, H, types, desc, vals, about, va, theatre=False):
    base = 150; L = sum(s[1] for s in sections); x0 = -L / 2; yF, yB = -D / 2, D / 2; zt = base + H
    parts = [B("Base Frame", [x0, yF, 0, x0 + L, yB, base], 'dark'), B("Casing", [x0, yF, base, x0 + L, yB, zt], 'lgrey')]
    xs = x0; joints = [x0]
    for kind, l, label in sections:
        xe = xs + l; xm = (xs + xe) / 2; joints.append(xe)
        door = kind in ('mix', 'filter', 'fan', 'humid', 'hepa')
        if door:
            parts += [F(f"Door {label}", [xs + 45, yF - 12, base + 110, xe - 45, yF, zt - 110], 'lgrey', 8),
                      F(f"Handle {label}", [xe - 115, yF - 42, base + H / 2 - 90, xe - 85, yF - 12, base + H / 2 + 90], 'black', 6),
                      CZ(f"Hinge {label}", [xs + 55, yF - 16], 9, [base + 170, zt - 170], 'chrome', 'f')]
        if kind in ('filter', 'hepa'):
            parts.append(CY(f"Gauge {label}", [xm, zt - 260], 55, [yF - 34, yF - 12], 'white'))
        if kind == 'fan':
            parts += [CY(f"Window {label}", [xm, base + H * 0.62], 120, [yF - 16, yF - 12], 'glass'),
                      F(f"Isolator {label}", [xe + 25, yF - 70, zt - 420, xe + 145, yF, zt - 260], 'yellow' if not theatre else 'grey', 6)]
        if kind == 'humid':
            parts += [CY(f"Window {label}", [xm, base + H * 0.62], 90, [yF - 16, yF - 12], 'glass'),
                      CZ("Steam Inlet", [xm, yF + 150], 25, [zt, zt + 140], 'ss')]
        if kind == 'coil':
            parts += [F(f"Header Plate {label}", [xm - 160, yF - 6, base + 180, xm + 160, yF, zt - 180], 'pcg'),
                      CY(f"Flow {label}", [xm - 70, zt - 320], 40, [yF - 200, yF - 6], 'gi'),
                      CY(f"Return {label}", [xm + 70, base + 320], 40, [yF - 200, yF - 6], 'gi')]
        if kind == 'coil' and 'Cooling' in label:
            parts += [CY("Drain Stub", [xm + 260, base + 50], 20, [yF - 130, yF], 'upvc'),
                      CZ("Drain Trap", [xm + 260, yF - 120], 24, [20, base + 70], 'upvc')]
        if kind == 'mix':
            w = l - 200
            parts += [B("Return Neck", [xs + 100, yF + 150, zt, xe - 100, yB - 150, zt + 150], 'galv'),
                      B("Return Flange", [xs + 80, yF + 130, zt + 150, xe - 80, yB - 130, zt + 165], 'dark'),
                      B("Fresh Air Neck", [x0 - 120, yF + 150, base + 150, x0, yB - 150, zt - 150], 'galv'),
                      rep(FR("Fresh Air Blade", [(x0 - 150, base + 190), (x0 - 105, base + 240), (x0 - 105, base + 252), (x0 - 150, base + 202)], [yF + 160, yB - 160], 'alu', 'f'), 5, [0, 0, (H - 400) / 5]),
                      B("Damper Actuator", [x0 - 110, yB - 150, base + 250, x0 - 20, yB - 60, base + 380], 'black')]
            if not theatre:
                parts += [rep(B("Return Blade", [xs + 110, yF + 160, zt + 166, xs + 150, yB - 160, zt + 172], 'alu', 0, 'f'), max(2, int(w / 120)), [120, 0, 0]),
                          B("Return Actuator", [xe - 80, yB - 260, zt + 10, xe + 30, yB - 160, zt + 130], 'black')]
        if kind == 'outlet':
            parts += [B("Supply Neck", [xs + 100, yF + 150, zt, xe - 100, yB - 150, zt + 150], 'galv'),
                      B("Supply Flange", [xs + 80, yF + 130, zt + 150, xe - 80, yB - 130, zt + 165], 'dark'),
                      F("Control Panel", [xs + 60, yF - 260, base + 500, xe - 60, yF, base + 1300], 'dark', 6),
                      F("Control Panel Handle", [xe - 120, yF - 285, base + 820, xe - 95, yF - 260, base + 980], 'chrome', 4, 'f'),
                      CY("Panel Indicator", [xs + 120, base + 1220], 12, [yF - 266, yF - 260], 'ledg', 'f')]
        xs = xe
    for i, xj in enumerate(joints):
        parts.append(F(f"Section Joint {i + 1}", [xj - 20 if 0 < i < len(joints) - 1 else (xj if i == 0 else xj - 40), yF - 8, base, xj + 20 if 0 < i < len(joints) - 1 else (xj + 40 if i == 0 else xj), yF, zt], 'pcg'))
    parts.append(rep(B("Lifting Lug", [x0 + 200, yF - 30, 40, x0 + 280, yF, 110], 'dark', 0, 'f'), 4, [(L - 480) / 3, 0, 0]))
    sw, sd = sections[-1][1] - 200, D - 300; rw, rd = sections[0][1] - 200, D - 300
    make(fam, desc, "IfcUnitaryEquipment", types, parts,
         [E("Control Panel", "front"), DUCT("Supply", "SupplyAir", "Supply Flange", "top", "Out", w=sw, h=sd),
          DUCT("Return", "ExhaustAir", "Return Flange", "top", "In", w=rw, h=rd)] + ([SAN("Drain Trap", "bottom")] if any('Cooling' in s[2] for s in sections) else []),
         vals, about, elec(415, va, 3),
         [{"n": "Access Side", "shape": "box", "at": [x0, yF - 1000 - 260, 0, x0 + L, yF - 260, zt], "sub": "Clearance Maintenance"}])

# ================================================================= 10. ERV
def erv():
    parts = [B("Casing", [-600, -480, -390, 600, 480, -30], 'epw')]
    for nm, cy, x in (("OA", -240, [-680, -600]), ("EA", 240, [-680, -600]), ("SA", -240, [600, 680]), ("RA", 240, [600, 680])):
        parts += [CX(f"Spigot {nm}", [cy, -210], 125, x, 'galv'),
                  T(f"Spigot Seal {nm}", 'x', [cy, -210], ring(124, 130, x[0] + 25, x[0] + 35) if x[0] > 0 else ring(124, 130, x[1] - 35, x[1] - 25), 'rubber', 'f')]
    parts += [B("Access Panel", [-560, -440, -396, 560, 440, -390], 'epw'),
              rep(B("Panel Latch", [-420, -446, -398, -380, -430, -388], 'black', 0, 'f'), 3, [400, 0, 0]),
              rep(F("Filter Door", [-470, -488, -360, -170, -480, -80], 'epw', 6), 2, [640, 0, 0]),
              rep(CY("Filter Knob", [-320, -220], 14, [-500, -488], 'black', 'f'), 2, [640, 0, 0]),
              F("Control Box", [-110, -500, -340, 110, -480, -120], 'dark', 4),
              F("Airflow Label", [-80, -481, -100, 80, -480, -80], 'blue', 0, 'f'),
              rep(B("Hanger Bracket Front", [-560, -510, -90, -500, -480, -50], 'dark'), 2, [1060, 0, 0]),
              rep(B("Hanger Bracket Rear", [-560, 480, -90, -500, 510, -50], 'dark'), 2, [1060, 0, 0]),
              rep(CZ("Hanger Rod Front", [-530, -495], 5, [-50, 0], 'gi', 'f'), 2, [1060, 0, 0]),
              rep(CZ("Hanger Rod Rear", [-530, 495], 5, [-50, 0], 'gi', 'f'), 2, [1060, 0, 0])]
    types = [{"name": "500m3h_ERV", "values": {"Apparent Load": 250}}, {"name": "1000m3h_ERV", "values": {"Apparent Load": 520}}]
    make("FMC_M_MechEq_ERV_FreshAir", "Energy recovery ventilator 500 to 1000 m3/h, ceiling-void mounted, counter-flow core, four round spigots, side filter doors, underside access panel",
         "IfcUnitaryEquipment", types, parts,
         [E("Control Box", "front"), DUCT("Supply", "SupplyAir", "Spigot SA", "right", "Out", d=250), DUCT("Exhaust", "ExhaustAir", "Spigot EA", "left", "Out", d=250)],
         {"Casing 1200 x 960 x 360 mm": A("1200x960x360", "typical 1000 m3/h ERV"), "Spigots 250 mm": A(250), "Heat recovery efficiency 75 %": A("75%", "counter-flow core, typical"),
          "Fan load 250 / 520 VA": A("250/520")},
         "Modelled as a generic product: white casing hung on four brackets and rods, four round spigots with seals (OA, EA at one end; SA, RA at the other), side filter doors with knobs, control box, underside access panel with latches.",
         dict(elec(240, 520), **{"Default Elevation": 3000}))

# ================================================================= 11. inline fan
def inline_fan():
    zc = -200
    parts = [T("Casing", 'x', [0, zc], [[0, -150], [150, -150], [160, -135], [160, 135], [150, 150], [0, 150]], 'galv'),
             CX("Spigot In", [0, zc], 100, [-235, -150], 'galv'), CX("Spigot Out", [0, zc], 100, [150, 235], 'galv'),
             T("Seal In", 'x', [0, zc], ring(99, 104, -235, -225), 'rubber', 'f'), T("Seal Out", 'x', [0, zc], ring(99, 104, 225, 235), 'rubber', 'f'),
             rep(T("Casing Rib", 'x', [0, zc], ring(158, 166, -95, -85), 'galv', 'f'), 3, [90, 0, 0]),
             T("Mounting Strap Left", 'x', [0, zc], ring(160, 167, -125, -110), 'dark'), T("Mounting Strap Right", 'x', [0, zc], ring(160, 167, 110, 125), 'dark'),
             B("Strap Lug Left", [-125, -20, zc + 160, -110, 20, -30], 'dark'), B("Strap Lug Right", [110, -20, zc + 160, 125, 20, -30], 'dark'),
             CZ("Hanger Rod Left", [-117, 0], 5, [-30, 0], 'gi', 'f'), CZ("Hanger Rod Right", [117, 0], 5, [-30, 0], 'gi', 'f'),
             B("Terminal Box", [-55, -205, zc - 50, 55, -158, zc + 50], 'grey', 6),
             CZ("Cable Gland", [0, -182], 9, [zc - 70, zc - 50], 'black', 'f'),
             PR("Airflow Arrow", [(-60, -10), (30, -10), (30, -25), (60, 0), (30, 25), (30, 10), (-60, 10)], [zc + 158, zc + 164], 'yellow', 'f')]
    types = [{"name": f"{d}_Inline", "values": {"Apparent Load": va}} for d, va in ((100, 25), (150, 60), (200, 120))]
    make("FMC_M_MechEq_ExtractFan_Inline", "In-line mixed-flow extract fan 100 to 200 mm, round galvanised casing with ribs, spigots and seals, mounting straps, terminal box",
         "IfcFan", types, parts,
         [E("Terminal Box", "front"), DUCT("Duct In", "ExhaustAir", "Spigot In", "left", "In", d=200), DUCT("Duct Out", "ExhaustAir", "Spigot Out", "right", "Out", d=200)],
         {"Spigot 100 / 150 / 200 mm": A("100/150/200"), "Casing 320 dia x 470 mm (200)": A("320x470", "typical mixed-flow in-line fan"), "Load 25 / 60 / 120 VA": A("25/60/120")},
         "Modelled as a generic product: round ribbed casing with inlet and outlet spigots and rubber seals, two straps with lugs and rods to the slab (z = 0), terminal box with gland, airflow arrow.",
         dict(elec(240, 120), **{"Default Elevation": 3000}))

# ================================================================= 12. roof fan
def roof_fan():
    parts = [B("Roof Kerb", [-400, -400, 0, 400, 400, 290], 'galv'),
             B("Kerb Capping", [-412, -412, 290, 412, 412, 300], 'galv'),
             B("Base Plate", [-420, -420, 300, 420, 420, 312], 'alu', 20),
             CZ("Spigot", [0, 0], 225, [-150, 0], 'galv'),
             T("Mesh Band", 'z', [0, 0], ring(300, 305, 312, 520), 'mesh'),
             T("Hood", 'z', [0, 0], [[0, 520], [415, 520], [415, 538], [320, 590], [170, 628], [0, 638]], 'alu'),
             T("Hood Lip", 'z', [0, 0], ring(405, 418, 505, 520), 'alu', 'f'),
             T("Motor Cap", 'z', [0, 0], [[0, 638], [95, 634], [95, 670], [60, 695], [0, 700]], 'grey'),
             rep(B("Hood Strut Front", [-262, -262, 312, -246, -246, 520], 'alu'), 2, [508, 0, 0]),
             rep(B("Hood Strut Rear", [-262, 246, 312, -246, 262, 520], 'alu'), 2, [508, 0, 0]),
             rep(CZ("Base Bolt Front", [-380, -380], 8, [312, 320], 'chrome', 'f'), 2, [760, 0, 0]),
             rep(CZ("Base Bolt Rear", [-380, 380], 8, [312, 320], 'chrome', 'f'), 2, [760, 0, 0]),
             F("Isolator", [150, -460, 140, 260, -400, 260], 'grey', 6), F("Isolator Knob", [190, -472, 180, 220, -460, 220], 'yellow', 4, 'f'),
             CZ("Conduit", [205, -430], 10, [260, 330], 'grey', 'f')]
    types = [{"name": "300_Roof", "values": {"Apparent Load": 250}}, {"name": "450_Roof", "values": {"Apparent Load": 550}}]
    make("FMC_M_MechEq_ExtractFan_Roof", "Roof extract fan, mushroom cowl on a roof kerb, 300 to 450 mm, aluminium hood, mesh guard band, isolator on kerb",
         "IfcFan", types, parts, [E("Isolator", "front"), DUCT("Extract", "ExhaustAir", "Spigot", "bottom", "In", d=450)],
         {"Hood 830 dia, 700 high on 300 kerb": A("830x700", "typical 450 roof cowl fan"), "Spigot 300 / 450 mm": A("300/450"), "Load 250 / 550 VA": A("250/550")},
         "Modelled as a generic product: galvanised kerb with capping, base plate, mesh guard band, four struts, domed aluminium hood with lip and motor cap, spigot below the roof (z = 0), isolator on the kerb.",
         elec(240, 550))

# ================================================================= 13. wall fan
def wall_fan():
    parts = [F("Fascia", [-170, -30, 0, 170, 0, 340], 'white', 26),
             F("Grille Recess", [-145, -32, 25, 145, -30, 315], 'black', 16),
             rep(F("Louvre Slat", [-140, -40, 36, 140, -32, 46], 'white', 3), 12, [0, 0, 23]),
             CY("Run LED", [130, 22], 4, [-32, -30], 'ledg', 'f'),
             rep(CY("Screw Cover", [-150, 170], 6, [-32, -30], 'mgrey', 'f'), 2, [300, 0, 0]),
             CY("Wall Sleeve", [0, 170], 128, [0, 230], 'white'),
             CY("Backdraught Shutter", [0, 170], 128, [230, 236], 'mgrey', 'f'),
             F("External Cowl", [-150, 236, 20, 150, 266, 320], 'grey', 12, 'f'),
             CZ("Pull Cord", [150, -15], 1.5, [-220, 0], 'white', 'f'), CZ("Cord Toggle", [150, -15], 7, [-240, -220], 'white', 'f')]
    types = [{"name": "150_Wall", "values": {"Apparent Load": 30}}, {"name": "250_Wall", "values": {"Apparent Load": 60}}]
    make("FMC_M_MechEq_ExtractFan_Wall", "Wall extract fan 150 to 250 mm, through-wall, white louvred fascia, sleeve, back-draught shutter and external cowl, pull-cord switch",
         "IfcFan", types, parts, [E("Wall Sleeve", "back")],
         {"Fascia 340 x 340 mm (250)": A("340x340", "typical 250 mm window/wall fan"), "Sleeve 256 dia through 230 wall": A("256/230"), "Load 30 / 60 VA": A("30/60"),
          "Mounting height 2200 mm": A(2200, "high-level wall practice")},
         "Modelled as a generic product: rounded fascia with louvre slats over a dark recess, run LED, screw covers, wall sleeve with back-draught shutter and external cowl, pull cord.",
         dict(elec(240, 60), **{"Default Elevation": 2200}))

# ================================================================= 14. fume cupboard fan + stack
def fume_fan():
    cz = 520
    parts = [rep(B("Base Rail", [-500, -350, 0, 500, -300, 100], 'galv'), 2, [0, 650, 0]),
             rep(CZ("AV Mount Front", [-400, -325], 35, [100, 140], 'rubber'), 2, [800, 0, 0]),
             rep(CZ("AV Mount Rear", [-400, 325], 35, [100, 140], 'rubber'), 2, [800, 0, 0]),
             B("Mounting Plate", [-500, -350, 140, 500, 350, 160], 'galv'),
             B("Volute Foot", [-260, -200, 160, 260, 150, 220], 'dark'),
             FR("Volute", volute_pts(0, cz, 280, 100, 140), [-200, 150], 'galv'),
             CY("Inlet Cone", [0, cz], 175, [-280, -200], 'galv'),
             CY("Flexible Connector", [0, cz], 155, [-330, -280], 'black'),
             CY("Inlet Spigot", [0, cz], 150, [-400, -330], 'galv'),
             B("Motor Pedestal", [-150, 150, 160, 150, 450, 390], 'steel'),
             CY("Motor", [0, cz], 140, [150, 450], 'mblue'),
             rep(T("Motor Fin", 'y', [0, cz], ring(140, 150, 180, 190), 'mblue', 'f'), 6, [0, 42, 0]),
             T("Fan Cowl", 'y', [0, cz], [[0, 450], [145, 450], [145, 500], [110, 525], [0, 525]], 'dark'),
             B("Terminal Box", [-60, 240, cz + 135, 60, 340, cz + 215], 'grey'),
             B("Discharge Transition", [0, -200, cz + 520, 280, 150, cz + 640], 'galv'),
             CZ("Stack", [140, -25], 150, [cz + 640, 3500], 'galv'),
             T("Stack Band", 'z', [140, -25], ring(150, 158, 2400, 2440), 'galv', 'f'),
             T("Stack Nozzle", 'z', [140, -25], [[0, 3500], [152, 3500], [105, 3820], [0, 3820]], 'galv'),
             T("Windband", 'z', [140, -25], ring(225, 232, 3620, 3900), 'galv'),
             rep(B("Windband Strut", [138, -253, 3640, 142, 203, 3660], 'galv', 0, 'f'), 2, [0, 0, 200]),
             CZ("Stack Drain", [-15, -25], 12, [cz + 560, cz + 640], 'galv', 'f'),
             F("Isolator", [300, -370, 160, 420, -350, 300], 'grey', 6), F("Isolator Knob", [345, -382, 210, 375, -370, 250], 'yellow', 4, 'f')]
    make("FMC_M_MechEq_ExtractFan_FumeCupboard", "Fume cupboard extract fan 0.3 m3/s, centrifugal on anti-vibration base, flexible inlet, vertical discharge stack with nozzle and windband",
         "IfcFan", ["0.3m3s_FumeStack"], parts, [E("Isolator", "front"), DUCT("Extract", "ExhaustAir", "Inlet Spigot", "front", "In", d=300)],
         {"Flow 0.3 m3/s": A(0.3, "record basis"), "Stack 300 dia, top 3.0 m above roof": A("300/3000", "BS EN 14175 / HTM 03-01 practice: discharge above roof line"),
          "Discharge velocity 15 m/s at nozzle": A(15, "fume stack practice"), "Load 2 kVA, 415 V 3-phase": A(2000)},
         "Modelled as a generic product: base rails with AV mounts, plate, scroll volute with inlet cone, flexible connector and spigot, motor with fins and cowl, terminal box, transition to a tall stack with nozzle, band and windband, isolator.",
         elec(415, 2000, 3))

# ================================================================= 15. isolation HEPA extract
def isolation_hepa():
    parts = [B("Base Frame", [-900, -350, 0, 800, 350, 150], 'steel'),
             B("HEPA Housing", [-900, -350, 150, -50, 350, 1300], 'ss'),
             F("Housing Door", [-860, -362, 240, -270, -350, 1220], 'ss', 10),
             T("Bagging Ring", 'y', [-565, 730], ring(215, 238, -384, -362), 'ss'),
             CY("Bag Port Cover", [-565, 730], 215, [-366, -362], 'mgrey'),
             rep(CY("Door Clamp", [-835, 400], 18, [-392, -362], 'black'), 2, [0, 0, 660]),
             rep(CY("Door Clamp Right", [-295, 400], 18, [-392, -362], 'black'), 2, [0, 0, 660]),
             CY("Gauge", [-160, 1050], 55, [-376, -350], 'white'), T("Gauge Bezel", 'y', [-160, 1050], ring(52, 60, -380, -350), 'black', 'f'),
             CY("Test Port Upstream", [-200, 600], 12, [-380, -350], 'chrome', 'f'), CY("Test Port Downstream", [-120, 600], 12, [-380, -350], 'chrome', 'f'),
             B("Fan Section", [-50, -350, 150, 800, 350, 1200], 'epw'),
             F("Fan Door", [0, -362, 240, 750, -350, 1110], 'epw', 8), F("Fan Door Handle", [680, -392, 600, 705, -362, 760], 'black', 4),
             CY("Fan Window", [375, 750], 110, [-366, -362], 'glass'),
             CX("Inlet Spigot", [0, 725], 160, [-1060, -960], 'ss'),
             CX("Isolation Damper", [0, 725], 185, [-960, -900], 'dark'),
             B("Damper Handle", [-945, -30, 910, -915, 30, 1040], 'red', 0, 'f'),
             CZ("Outlet Spigot", [500, 0], 160, [1200, 1420], 'galv'), T("Outlet Collar", 'z', [500, 0], ring(160, 185, 1200, 1230), 'dark', 'f'),
             B("Control Panel", [800, -260, 450, 890, 260, 1100], 'dark', 4),
             CX("Alarm Beacon", [180, 1150], 30, [890, 905], 'ledr', 'f'), CX("Run Lamp", [100, 1150], 15, [890, 900], 'ledg', 'f')]
    make("FMC_M_MechEq_ExtractFan_Isolation_HEPA", "Negative-pressure isolation room extract unit 0.2 m3/s, stainless bag-in/bag-out HEPA housing with test ports and gauge, fan section, control panel",
         "IfcFan", ["0.2m3s_BIBO"], parts,
         [E("Control Panel", "right"), DUCT("Extract In", "ExhaustAir", "Inlet Spigot", "left", "In", d=320), DUCT("Extract Out", "ExhaustAir", "Outlet Spigot", "top", "Out", d=320)],
         {"Flow 0.2 m3/s": A(0.2, "record basis"), "HEPA H14, bag-in/bag-out": A("H14", "HTM 03-01 isolation suite extract practice"), "Unit 1700 x 700 x 1420 mm": A("1700x700x1420"),
          "Load 1.5 kVA": A(1500)},
         "Modelled as a generic product: base frame, stainless HEPA housing with clamped door, bagging ring and bag cover, gauge, upstream and downstream test ports, isolation damper with handle on the inlet, fan section with door, window and handle, outlet spigot, control panel with beacon.",
         elec(240, 1500), [{"n": "Filter Change Space", "shape": "box", "at": [-900, -1250, 0, 800, -350, 1300], "sub": "Clearance Maintenance"}])

# ================================================================= 16. chiller
def chiller():
    parts = [B("Base Frame", [-1800, -1100, 0, 1800, 1100, 150], 'dark'),
             B("Electrical Bay", [1200, -1100, 150, 1800, 1100, 2250], 'lgrey'),
             F("Panel Door Left", [1220, -1112, 400, 1495, -1100, 2150], 'lgrey', 6), F("Panel Door Right", [1505, -1112, 400, 1780, -1100, 2150], 'lgrey', 6),
             F("Door Handle Left", [1460, -1130, 1150, 1480, -1112, 1300], 'black', 4, 'f'), F("Door Handle Right", [1520, -1130, 1150, 1540, -1112, 1300], 'black', 4, 'f'),
             F("HMI Display", [1290, -1116, 1500, 1440, -1112, 1610], 'black', 4), F("Main Isolator", [1600, -1124, 1550, 1680, -1112, 1650], 'red', 4),
             RT("Coil Front", [(-1100, 2250), (-1040, 2250), (-240, 880), (-300, 880)], [-1780, 1200], 'fin'),
             RT("Coil Rear", [(1100, 2250), (1040, 2250), (240, 880), (300, 880)], [-1780, 1200], 'fin'),
             RT("V End Panel Left", [(-1040, 2250), (1040, 2250), (240, 880), (-240, 880)], [-1800, -1780], 'lgrey'),
             RT("V End Panel Right", [(-1040, 2250), (1040, 2250), (240, 880), (-240, 880)], [1180, 1200], 'lgrey'),
             B("V Floor", [-1780, -300, 860, 1200, 300, 880], 'dark'),
             B("Fan Deck", [-1800, -1100, 2250, 1200, 1100, 2280], 'lgrey'),
             rep(B("Post Front", [-1800, -1100, 150, -1740, -1040, 2250], 'lgrey'), 3, [1470, 0, 0]),
             rep(B("Post Rear", [-1800, 1040, 150, -1740, 1100, 2250], 'lgrey'), 3, [1470, 0, 0]),
             rep(CZ("Compressor", [-1150, -650], 160, [180, 760], 'enamel'), 2, [750, 0, 0]),
             rep(T("Compressor Dome", 'z', [-1150, -650], [[0, 760], [160, 760], [130, 830], [70, 860], [0, 866]], 'enamel'), 2, [750, 0, 0]),
             CX("Suction Header", [-650, 900], 40, [-1250, -300], 'copper'),
             CX("Evaporator", [600, 520], 260, [-1600, 900], 'lag'),
             CX("CHW Inlet", [500, 520], 75, [-1880, -1600], 'gi'), CX("CHW Outlet", [720, 520], 75, [-1880, -1600], 'gi'),
             T("CHW Inlet Flange", 'x', [500, 520], ring(75, 115, -1880, -1860), 'gi', 'f'), T("CHW Outlet Flange", 'x', [720, 520], ring(75, 115, -1880, -1860), 'gi', 'f')]
    for i, x in enumerate((-1300, -300, 700)):
        parts += fan_top(f"Fan {i + 1}", x, 0, 2280, 420, 3, shroud='lgrey')
    types = [{"name": "200kW_AirCooled", "values": {"Apparent Load": 85000}}, {"name": "400kW_AirCooled", "values": {"Apparent Load": 170000}}]
    make("FMC_M_MechEq_Chiller_AirCooled", "Air-cooled scroll chiller 200 to 400 kW, V-coil with top fans, compressors under the coils, insulated evaporator with CHW nozzles, end electrical bay",
         "IfcChiller", types, parts, [E("Electrical Bay", "right"),
          {"n": "CHW Return", "domain": "pipe", "system": "HydronicReturn", "part": "CHW Inlet", "side": "left", "diameter": 150, "flow": "In"},
          {"n": "CHW Supply", "domain": "pipe", "system": "HydronicSupply", "part": "CHW Outlet", "side": "left", "diameter": 150, "flow": "Out"}],
         {"Unit 3600 x 2200 x 2400 mm (200 kW)": A("3600x2200x2400", "typical 200 kW air-cooled scroll chiller"), "Cooling 200 / 400 kW": A("200/400kW"),
          "Load 85 / 170 kVA, 415 V 3-phase": A("85/170kVA", "EER about 2.9, engineer confirms"), "Clearance 1500 mm sides, open above": A(1500, "manufacturer practice")},
         "Modelled as a generic product: base frame, posts, V-shaped finned coils with end panels and fan deck, three top fans (shroud, guard, hub, blades), two scroll compressors with domes and suction header under the V, lagged evaporator with flanged CHW nozzles, end electrical bay with doors, HMI and isolator. CHW return (In) and supply (Out) connectors on the nozzles.",
         elec(415, 85000, 3), [{"n": "Coil Airflow Space", "shape": "box", "at": [-1800, -2600, 0, 1800, -1100, 2400], "sub": "Clearance Maintenance"}])

# ================================================================= 17. CHW pump
def chw_pump():
    zc = 350
    vol = [(y, z) for y, z in volute_pts(0, zc, 150, 55, 70)]
    parts = [B("Baseplate", [-560, -220, 0, 400, 220, 60], 'dark'),
             B("Volute Foot", [-440, -100, 60, -320, 100, 210], 'mblue'),
             RT("Volute", vol, [-440, -310], 'mblue'),
             CX("Suction Nozzle", [0, zc], 55, [-530, -440], 'mblue'), T("Suction Flange", 'x', [0, zc], ring(0, 95, -550, -530), 'mblue'),
             CZ("Discharge Nozzle", [-375, 75], 42, [zc + 250, zc + 330], 'mblue'), T("Discharge Flange", 'z', [-375, 75], ring(0, 80, zc + 330, zc + 350), 'mblue'),
             T("Motor Adapter", 'x', [0, zc], [[0, -310], [125, -310], [105, -200], [0, -200]], 'mblue'),
             CX("Motor", [0, zc], 135, [-200, 250], 'mblue'),
             rep(T("Motor Fin", 'x', [0, zc], ring(135, 145, -170, -160), 'mblue', 'f'), 6, [65, 0, 0]),
             T("Fan Cowl", 'x', [0, zc], [[0, 250], [140, 250], [140, 310], [100, 335], [0, 340]], 'dark'),
             B("Motor Feet", [-160, -120, 60, 200, 120, 225], 'mblue'),
             B("Terminal Box", [-40, -60, zc + 135, 80, 60, zc + 215], 'mblue'),
             CZ("Cable Gland", [80, 0], 10, [zc + 175, zc + 195], 'black', 'f'),
             CY("Gauge Cock", [-375, zc + 300], 6, [15, 33], 'brass', 'f'),
             T("Lifting Eye", 'z', [180, 0], ring(14, 20, zc + 130, zc + 170), 'chrome', 'f')]
    make("FMC_M_MechEq_Pump_ChilledWater", "Chilled water pump 5 l/s, close-coupled end-suction, cast-iron volute, flanged suction and discharge, TEFC motor on a common baseplate",
         "IfcPump", ["5ls_EndSuction"], parts, [E("Terminal Box", "top"),
          {"n": "CHW Return", "domain": "pipe", "system": "HydronicReturn", "part": "Suction Nozzle", "side": "left", "diameter": 65, "flow": "In"},
          {"n": "CHW Supply", "domain": "pipe", "system": "HydronicSupply", "part": "Discharge Nozzle", "side": "top", "diameter": 50, "flow": "Out"}],
         {"Flow 5 l/s at 200 kPa": A("5l/s@200kPa", "record basis, head assumed"), "Suction DN65, discharge DN50": A("DN65/DN50"), "Motor 2.2 kW, 415 V 3-phase": A(2200),
          "Baseplate 960 x 440 mm": A("960x440")},
         "Modelled as a generic product: baseplate, scroll volute with foot, flanged end suction and top discharge, motor adapter, finned motor with cowl and feet, terminal box with gland, gauge cock, vent, lifting eye. CHW return on the suction, supply on the discharge.",
         elec(415, 2800, 3))

# ================================================================= 18. kitchen hood
def kitchen_hood():
    shell = [(0, 550), (-900, 550), (-1200, 350), (-1200, 0), (-1180, 0), (-1180, 340), (-893, 530), (0, 530)]
    side = [(0, 0), (0, 550), (-900, 550), (-1200, 350), (-1200, 0)]
    parts = [B("Back Panel", [-1200, -20, 0, 1200, 0, 550], 'ss'),
             RT("Canopy Shell", shell, [-1180, 1180], 'ss'),
             RT("Side Panel Left", side, [-1200, -1180], 'ss'), RT("Side Panel Right", side, [1180, 1200], 'ss'),
             rep(RT("Baffle Filter", [(-20, 515), (-55, 527), (-370, 215), (-335, 203)], [-1150, -640], 'alu'), 4, [575, 0, 0]),
             B("Grease Trough", [-1180, -370, 150, 1180, -300, 205], 'ss'),
             B("Grease Gutter Front", [-1180, -1180, 0, 1180, -1120, 45], 'ss'),
             CZ("Grease Cup", [1080, -335], 32, [100, 150], 'ss', 'f'),
             rep(B("Light Fitting", [-760, -820, 505, -360, -620, 530], 'pc'), 2, [1120, 0, 0]),
             rep(CZ("Suppression Nozzle", [-800, -500], 12, [495, 530], 'chrome', 'f'), 3, [800, 0, 0]),
             B("Extract Spigot", [-400, -520, 550, 400, -200, 740], 'galv'),
             B("Spigot Flange", [-420, -540, 740, 420, -180, 755], 'dark'),
             rep(CZ("Hanger Rod Front", [-1000, -800], 6, [550, 1100], 'gi', 'f'), 2, [2000, 0, 0]),
             rep(CZ("Hanger Rod Rear", [-1000, -150], 6, [550, 1100], 'gi', 'f'), 2, [2000, 0, 0]),
             F("Switch Panel", [850, -1206, 150, 1100, -1200, 300], 'ss', 0, 'f'),
             rep(CY("Switch", [900, 225], 12, [-1212, -1206], 'black', 'f'), 3, [70, 0, 0]),
             F("Pilot Lamp", [1060, -1210, 210, 1080, -1206, 240], 'ledg', 0, 'f')]
    make("FMC_M_MechEq_Hood_Kitchen_Extract", "Kitchen extract canopy hood 2400 to 3600 mm, wall type, stainless steel, baffle grease filters, grease trough and cup, lights, top extract spigot",
         "IfcFlowTerminal", ["2400_WallCanopy", "3600_WallCanopy"], parts, [DUCT("Extract", "ExhaustAir", "Spigot Flange", "top", "In", w=800, h=300)],
         {"Canopy 2400 x 1200 x 550 mm": A("2400x1200x550", "DW/172 wall canopy, overhang 300 beyond cooking line"), "Baffle filters 500 x 500": A(500),
          "Extract velocity 0.25 m/s at canopy face": A(0.25, "DW/172 practice"), "Underside 2000 mm AFL": A(2000)},
         "Modelled as a generic product: stainless back panel, bent canopy shell with sloped front, side panels, inclined baffle filters over a grease trough, front gutter and grease cup, recessed lights, suppression nozzles, top extract spigot and flange, hanger rods, switch panel.",
         {"Default Elevation": 2000})

# ================================================================= 19. cold room condensing unit
def cold_condenser():
    parts = [B("Base Plate", [-500, -300, 0, 500, 300, 30], 'dark'),
             rep(CZ("Rubber Foot Front", [-450, -250], 20, [-15, 0], 'rubber', 'f'), 2, [900, 0, 0]),
             rep(CZ("Rubber Foot Rear", [-450, 250], 20, [-15, 0], 'rubber', 'f'), 2, [900, 0, 0]),
             B("Coil Housing", [0, -300, 30, 500, 300, 700], 'lgrey', 6),
             B("Coil", [10, 300, 60, 490, 306, 680], 'fin'),
             rep(B("Coil Guard Bar", [10, 306, 90, 490, 310, 96], 'dark', 0, 'f'), 6, [0, 0, 100]),
             B("Compressor Mount", [-420, -200, 30, -120, 100, 50], 'rubber'),
             CZ("Compressor", [-270, -50], 120, [50, 330], 'enamel'),
             T("Compressor Dome", 'z', [-270, -50], [[0, 330], [120, 330], [100, 385], [55, 405], [0, 410]], 'enamel'),
             B("Compressor Terminal Cover", [-310, -185, 230, -230, -160, 300], 'black', 0, 'f'),
             CX("Receiver", [180, 110], 65, [-470, -60], 'dark'),
             CX("Filter Drier", [-80, 300], 22, [-380, -180], 'copper'),
             CX("Sight Glass", [-80, 300], 14, [-170, -140], 'glass', 'f'),
             CZ("Suction Line", [-200, -50], 11, [400, 520], 'copper'), CX("Suction Riser", [-50, 520], 11, [-200, 0], 'copper'),
             CZ("Discharge Line", [-120, 40], 8, [200, 460], 'copper'), CX("Discharge Riser", [40, 460], 8, [-120, 0], 'copper'),
             rep(CY("Service Valve", [-440, 120], 12, [-330, -300], 'brass', 'f'), 2, [90, 0, 0]),
             B("Electrical Box", [-80, -260, 430, 0, -60, 650], 'grey', 4),
             B("HP LP Switch", [-40, -40, 450, 0, 40, 520], 'black', 0, 'f')]
    parts += fan_front("Fan", 250, 380, 205, -300, 4, bezel='lgrey')
    parts = [p for p in parts if p['n'] != 'Fan Guard Mid']
    types = [{"name": "2kW_CondUnit", "values": {"Apparent Load": 1500, "Voltage": 240, "Number of Poles": 1}},
             {"name": "5kW_CondUnit", "values": {"Apparent Load": 3500, "Voltage": 415, "Number of Poles": 3}}]
    make("FMC_M_MechEq_Condenser_ColdRoom", "Cold room air-cooled condensing unit 2 to 5 kW, open-frame compressor and receiver, fan and finned coil housing, filter drier, sight glass, electrical box",
         "IfcCondenser", types, parts, [E("Electrical Box", "front")],
         {"Unit 1000 x 600 x 700 mm": A("1000x600x700", "typical 2-5 kW condensing unit"), "Refrigeration 2 / 5 kW at -10 C evap": A("2/5kW"), "Load 1.5 kVA 240 V / 3.5 kVA 415 V": A("1.5/3.5kVA")},
         "Modelled as a generic product: base plate on rubber feet, compressor with dome and terminal cover on a mount, receiver, filter drier and sight glass, copper risers, service valves, coil housing with front fan and guard, rear coil with bars, electrical box and pressure switch.",
         elec(240, 1500, 1))

# ================================================================= 20. cold room evaporator
def cold_evap():
    parts = [B("Casing", [-600, -250, -350, 600, 250, -50], 'epw', 6),
             rep(B("Mounting Rail", [-620, -200, -50, 620, -150, 0], 'epw'), 2, [0, 350, 0]),
             B("Coil Face", [-560, 250, -330, 560, 256, -70], 'fin'),
             rep(B("Coil Guard Bar", [-560, 256, -300, 560, 260, -294], 'dark', 0, 'f'), 4, [0, 0, 60]),
             B("Drip Tray", [-620, -265, -385, 620, 270, -350], 'epw'),
             CZ("Drain Stub", [560, 0], 16, [-440, -385], 'grey'),
             B("End Cover Left", [-620, -260, -360, -600, 260, -40], 'epw'), B("End Cover Right", [600, -260, -360, 620, 260, -40], 'epw'),
             B("Terminal Box", [620, -150, -300, 670, 0, -160], 'grey', 4),
             CX("Defrost Heater Gland", [-75, -230], 8, [670, 690], 'black', 'f')]
    parts += fan_front("Fan Left", -300, -200, 135, -250, 4) + fan_front("Fan Right", 300, -200, 135, -250, 4)
    parts = [p for p in parts if not p['n'].endswith('Guard Mid')]
    types = [{"name": "2kW_UnitCooler", "values": {"Apparent Load": 800}}, {"name": "5kW_UnitCooler", "values": {"Apparent Load": 1500}}]
    make("FMC_M_MechEq_Evaporator_ColdRoom", "Cold room evaporator (unit cooler) 2 to 5 kW, low-profile ceiling hung, two front fans with guards, rear finned coil, drip tray with drain, electric defrost",
         "IfcEvaporator", types, parts, [E("Terminal Box", "right"), SAN("Drain Stub", "bottom")],
         {"Unit 1240 x 535 x 385 mm": A("1240x535x385", "typical 2-5 kW unit cooler"), "Fans 2 x 270 mm": A("2x270"), "Load 0.8 / 1.5 kVA with defrost": A("0.8/1.5kVA"),
          "Coil inlet clearance 300 mm": A(300, "manufacturer practice")},
         "Modelled as a generic product: white casing on two ceiling rails (z = 0), two front fans (bezel, blades, hub, guard), rear finned coil with bars, drip tray and drain, end covers, terminal box with defrost gland.",
         dict(elec(240, 1500), **{"Default Elevation": 2700}))

# ================================================================= 21. pneumatic tube station
def pts_station():
    parts = [F("Back Plate", [-250, -10, 0, 250, 0, 1000], 'ss'),
             F("Station Body", [-220, -260, 250, 220, -10, 860], 'mgrey', 20),
             CZ("Tube Riser", [0, -135], 55, [860, 2000], 'upvc'),
             rep(T("Tube Coupling", 'z', [0, -135], ring(55, 63, 860, 900), 'dark'), 2, [0, 0, 600]),
             F("Door Frame", [-150, -266, 500, 150, -260, 800], 'black', 14),
             F("Door Window", [-125, -268, 525, 125, -266, 775], 'pc', 10),
             F("Keypad Panel", [-180, -266, 300, 180, -260, 470], 'black', 8),
             F("Display", [-150, -268, 410, 30, -266, 455], 'ledb', 3, 'f'),
             rep(F("Key Top", [-150, -270, 360, -120, -266, 390], 'white', 4, 'f'), 4, [45, 0, 0]),
             rep(F("Key Bottom", [-150, -270, 318, -120, -266, 348], 'white', 4, 'f'), 4, [45, 0, 0]),
             CY("Status LED Ready", [80, 440], 6, [-268, -266], 'ledg', 'f'), CY("Status LED Busy", [120, 440], 6, [-268, -266], 'ledr', 'f'),
             F("Basket Floor", [-200, -300, 0, 200, -20, 15], 'ss'),
             F("Basket Front", [-200, -300, 15, 200, -290, 110], 'ss', 0), F("Basket Side Left", [-200, -290, 15, -190, -20, 110], 'ss'),
             F("Basket Side Right", [190, -290, 15, 200, -20, 110], 'ss'),
             CX("Carrier", [-160, 85], 55, [-150, 150], 'blue'),
             T("Carrier Cap Left", 'x', [-160, 85], ring(0, 58, -165, -150), 'black'), T("Carrier Cap Right", 'x', [-160, 85], ring(0, 58, 150, 165), 'black')]
    make("FMC_M_MechEq_PneumaticTube_Station", "Pneumatic tube system station, wall mounted, 110 mm tube riser, keypad and display, glazed send door, receiving basket with carrier",
         "IfcTransportElement", ["110_Single"], parts, [E("Back Plate")],
         {"Tube 110 mm": A(110, "common hospital PTS tube"), "Station 440 x 260 x 610 mm, basket 400 wide": A("440x260x610"), "Load 50 VA": A(50),
          "Keypad at 1200 to 1400 mm": A("1200-1400", "accessible controls practice")},
         "Modelled as a generic product: stainless back plate, grey station body, tube riser with couplings to the ceiling, glazed door, keypad with keys, display and LEDs, open receiving basket with a blue carrier.",
         dict(elec(240, 50), **{"Default Elevation": 800}), template='Metric Mechanical Equipment.rft')

# ================================================================= 22. pneumatic tube blower
def pts_blower():
    zc = 380
    parts = [B("Base Frame", [-400, -300, 0, 400, 300, 80], 'dark'),
             rep(CZ("AV Mount", [-340, -240], 25, [-20, 0], 'rubber', 'f'), 2, [680, 0, 0]),
             rep(CZ("AV Mount Rear", [-340, 240], 25, [-20, 0], 'rubber', 'f'), 2, [680, 0, 0]),
             B("Housing Foot", [-200, -230, 80, 200, -60, 130], 'mblue'),
             T("Blower Housing", 'y', [0, zc], [[0, -230], [255, -230], [272, -205], [272, -85], [255, -60], [0, -60]], 'mblue'),
             rep(T("Housing Rib", 'y', [0, zc], ring(272, 280, -190, -182), 'mblue', 'f'), 3, [0, 40, 0]),
             CY("Motor", [0, zc], 140, [-60, 260], 'mblue'),
             rep(T("Motor Fin", 'y', [0, zc], ring(140, 150, -30, -20), 'mblue', 'f'), 5, [0, 55, 0]),
             T("Fan Cowl", 'y', [0, zc], [[0, 260], [145, 260], [145, 315], [105, 340], [0, 345]], 'dark'),
             B("Motor Feet", [-120, -60, 80, 120, 240, 245], 'mblue'),
             B("Terminal Box", [-60, 0, zc + 135, 60, 120, zc + 205], 'mblue'),
             CZ("Inlet Port", [-130, -145], 42, [600, 720], 'mblue'), CZ("Outlet Port", [130, -145], 42, [600, 720], 'mblue'),
             CZ("Inlet Silencer", [-130, -145], 72, [720, 960], 'galv'), CZ("Outlet Silencer", [130, -145], 72, [720, 960], 'galv'),
             B("Diverter Valve", [-220, -230, 960, 220, -60, 1060], 'dark', 8),
             B("Valve Actuator", [-60, -60, 990, 60, 40, 1050], 'black'),
             CZ("Line Stub", [0, -145], 55, [1060, 1220], 'upvc'),
             CZ("Atmosphere Port", [-170, -145], 30, [1060, 1120], 'galv', 'f'),
             CZ("Relief Valve", [190, -145], 20, [1060, 1110], 'brass', 'f')]
    make("FMC_M_MechEq_PneumaticTube_Blower", "Pneumatic tube system blower 1.5 kW, side-channel blower with inlet and outlet silencers, air diverter valve, 110 mm line connection, on AV base",
         "IfcFan", ["1.5kW_SideChannel"], parts, [E("Terminal Box", "top")],
         {"Motor 1.5 kW, 415 V 3-phase": A(1500, "record basis"), "Unit 800 x 600 x 1220 mm": A("800x600x1220", "typical PTS blower package"), "Line 110 mm": A(110)},
         "Modelled as a generic product: base frame on AV mounts, ribbed side-channel housing, finned motor with cowl, feet and terminal box, inlet and outlet ports with silencers, diverter valve with actuator, 110 mm line stub, atmosphere port, relief valve.",
         elec(415, 2000, 3))

# ================================================================= 23. steam boiler
def steam_boiler():
    zc = 950
    parts = [B("Skid Frame", [-1500, -700, 0, 1500, 700, 150], 'steel'),
             rep(B("Boiler Saddle", [-950, -420, 150, -780, 420, 460], 'dark'), 2, [1550, 0, 0]),
             T("Shell", 'x', [0, zc], [[0, -1260], [300, -1230], [480, -1160], [550, -1060], [550, 960], [480, 1060], [300, 1130], [0, 1160]], 'alu'),
             rep(T("Cladding Band", 'x', [0, zc], ring(550, 556, -700, -680), 'ss', 'f'), 3, [700, 0, 0]),
             B("Burner", [1160, -260, 760, 1460, 260, 1140], 'red', 30),
             CY("Burner Fan Motor", [1310, 1140], 90, [-420, -260], 'red'),
             F("Burner Air Inlet", [1210, -268, 800, 1410, -260, 900], 'mesh', 0, 'f'),
             B("Smoke Box", [-1400, -380, 680, -1240, 380, 1300], 'dark'),
             CZ("Chimney", [-1320, 0], 150, [1300, 2700], 'dark'),
             T("Chimney Cap", 'z', [-1320, 0], [[0, 2700], [230, 2700], [230, 2720], [0, 2820]], 'dark'),
             B("Control Panel", [250, -740, 750, 850, -580, 1500], 'epw', 6),
             B("Panel Stand", [300, -720, 150, 800, -620, 750], 'steel'),
             F("Panel Handle", [790, -752, 1060, 810, -740, 1200], 'chrome', 4, 'f'),
             rep(CY("Panel Gauge", [360, 1380], 45, [-756, -740], 'white'), 2, [140, 0, 0]),
             rep(CY("Indicator Lamp", [360, 1250], 12, [-750, -740], 'ledg', 'f'), 4, [60, 0, 0]),
             CY("Emergency Stop", [740, 1400], 22, [-760, -740], 'ledr', 'f'),
             CZ("Water Gauge Glass", [1040, -470], 15, [880, 1260], 'glass'),
             rep(CY("Gauge Cock", [1040, 900], 22, [-500, -440], 'brass', 'f'), 2, [0, 0, 340]),
             rep(CZ("Safety Valve", [-350, 0], 40, [1490, 1700], 'brass'), 2, [260, 0, 0]),
             CZ("Steam Stop Valve", [350, 0], 60, [1490, 1650], 'dark'),
             T("Valve Handwheel", 'z', [350, 0], ring(80, 95, 1720, 1735), 'red', 'f'),
             CZ("Valve Spindle", [350, 0], 10, [1650, 1730], 'chrome', 'f'),
             CZ("Steam Outlet Flange", [350, 0], 110, [1650, 1675], 'dark'),
             CZ("Pressure Gauge Siphon", [100, 0], 10, [1490, 1620], 'copper', 'f'),
             CY("Steam Pressure Gauge", [100, 1660], 60, [-15, 15], 'white'),
             CX("Feed Pump", [-580, 330], 90, [-1000, -650], 'mblue'),
             CX("Feed Pump Motor", [-580, 330], 110, [-650, -300], 'mblue'),
             CX("Feedwater Inlet", [-580, 330], 26, [-1180, -1000], 'gi'),
             CZ("Blowdown Valve", [-200, -300], 25, [150, 420], 'brass', 'f')]
    types = [{"name": "100kgh_Steam", "values": {"Apparent Load": 3000}}, {"name": "250kgh_Steam", "values": {"Apparent Load": 5000}}]
    make("FMC_M_MechEq_Boiler_Steam_CSSD", "Packaged steam generator 100 to 250 kg/h for CSSD and laundry, horizontal shell on skid, front burner, chimney, safety valves, gauge glass, feed pump, control panel",
         "IfcBoiler", types, parts,
         [E("Control Panel", "front"), {"n": "Steam", "domain": "pipe", "system": "Other", "part": "Steam Outlet Flange", "side": "top", "diameter": 50, "flow": "Out"},
          {"n": "Feedwater", "domain": "pipe", "system": "DomesticColdWater", "part": "Feedwater Inlet", "side": "left", "diameter": 25, "flow": "In"}],
         {"Output 100 / 250 kg/h at 8 bar": A("100/250kg/h", "record basis, pressure typical for CSSD sterilisers (HTM 01-01)"), "Skid 3000 x 1400 mm, shell 1100 dia": A("3000x1400"),
          "Steam outlet DN50": A(50), "Electrical load 3 / 5 kVA (burner, pump, controls)": A("3/5kVA"), "Front burner withdrawal 1500 mm": A(1500, "manufacturer practice")},
         "Modelled as a generic product: skid frame and saddles, clad horizontal shell with bands and dished ends, red front burner with fan motor, rear smoke box and chimney, control panel on a stand with gauges and lamps, gauge glass with cocks, twin safety valves, steam stop valve and outlet flange, pressure gauge, feed pump and motor, blowdown.",
         elec(415, 5000, 3), [{"n": "Burner Withdrawal", "shape": "box", "at": [1460, -700, 0, 2960, 700, 1600], "sub": "Clearance Maintenance"}])

# ================================================================= 24. air curtain
def air_curtain():
    prof = [(0, 0), (0, 220), (-200, 220), (-240, 195), (-250, 130), (-238, 45), (-205, 0)]
    parts = [RT("Casing", prof, [-740, 740], 'white'),
             RT("End Cap Left", prof, [-750, -740], 'mgrey'), RT("End Cap Right", prof, [740, 750], 'mgrey'),
             B("Discharge Slot", [-700, -190, -4, 700, -110, 0], 'black'),
             rep(B("Discharge Vane", [-690, -186, -14, -686, -114, -4], 'mgrey', 0, 'f'), 16, [91.7, 0, 0]),
             F("Intake Grille", [-700, -253, 55, 700, -236, 185], 'black', 6),
             rep(F("Intake Slat", [-700, -258, 62, 700, -253, 70], 'white', 0, 'f'), 8, [0, 0, 15.5]),
             F("Control Panel", [520, -254, 192, 700, -250, 214], 'mgrey', 4, 'f'),
             CY("Run LED", [680, 203], 3, [-256, -254], 'ledg', 'f'),
             rep(B("Mounting Bracket", [-600, -10, 40, -560, 0, 200], 'dark'), 2, [1160, 0, 0])]
    types = [{"name": "1500_Ambient", "values": {"Apparent Load": 250}}, {"name": "2000_Ambient", "values": {"Apparent Load": 350}}]
    make("FMC_M_MechEq_AirCurtain_Entrance", "Entrance air curtain 1500 to 2000 mm, over-door wall mounted, ambient, white casing, front intake grille, downward discharge slot with vanes",
         "IfcUnitaryEquipment", types, parts, [E("Mounting Bracket 1", "back")],
         {"Length 1500 / 2000 mm, 250 deep, 220 high": A("1500/2000x250x220", "typical over-door air curtain"), "Discharge velocity 8 m/s": A(8),
          "Load 250 / 350 VA (ambient)": A("250/350"), "Fixed 100 mm above door head": A(2200)},
         "Modelled as a generic product: curved white casing with grey end caps, front intake grille with slats, discharge slot with vanes on the underside, control panel with LED, wall brackets.",
         dict(elec(240, 350), **{"Default Elevation": 2200}))

# ================================================================= 25. ceiling fan
def ceiling_fan():
    parts = [CZ("Mounting Hook Plate", [0, 0], 40, [-10, 0], 'dark'),
             T("Ceiling Canopy", 'z', [0, 0], [[0, 0], [80, 0], [80, -12], [45, -80], [0, -80]], 'white'),
             CZ("Downrod", [0, 0], 12, [-350, -80], 'white'),
             T("Rod Coupling", 'z', [0, 0], ring(0, 22, -365, -340), 'white'),
             T("Motor Housing", 'z', [0, 0], [[0, -360], [60, -360], [110, -385], [132, -420], [126, -452], [100, -470], [0, -470]], 'white'),
             T("Motor Band", 'z', [0, 0], ring(130, 134, -430, -414), 'chrome', 'f'),
             T("Bottom Cap", 'z', [0, 0], [[0, -470], [62, -470], [42, -500], [0, -506]], 'white')]
    for k in range(3):
        a = 90 + 120 * k
        rot = lambda u, v: (u * math.cos(math.radians(a)) - v * math.sin(math.radians(a)), u * math.sin(math.radians(a)) + v * math.cos(math.radians(a)))
        parts.append(PR(f"Blade Iron {k + 1}", [rot(u, v) for u, v in ((100, -18), (230, -28), (230, 28), (100, 18))], [-436, -428], 'chrome'))
        parts.append(PR(f"Blade {k + 1}", [rot(u, v) for u, v in ((190, -45), (700, -62), (700, 62), (190, 45))], [-428, -423], 'epw'))
        parts.append(CZ(f"Blade Screw {k + 1}", rot(210, 0), 6, [-423, -420], 'chrome', 'f'))
    types = [{"name": "1200_3Blade", "values": {"Apparent Load": 70}}, {"name": "1400_3Blade", "values": {"Apparent Load": 80}}]
    make("FMC_M_MechEq_CeilingFan", "Ceiling fan 1200 to 1400 mm sweep, three metal blades on blade irons, motor housing, downrod and ceiling canopy",
         "IfcFan", types, parts, [E("Mounting Hook Plate", "top")],
         {"Sweep 1200 / 1400 mm": A("1200/1400"), "Drop 506 mm (350 downrod)": A(506, "typical ceiling fan"), "Blade tip at least 2300 mm AFL": A(2300, "safety practice"),
          "Load 70 / 80 VA": A("70/80")},
         "Modelled as a generic product: hook plate, ceiling canopy, downrod with coupling, motor housing with chrome band and bottom cap, three blade irons, blades and screws; hangs below the ceiling (z = 0).",
         dict(elec(240, 80), **{"Default Elevation": 3000}))

# ================================================================= 26. dehumidifier
def dehumidifier():
    parts = [B("Body", [-200, -150, 40, 200, 150, 620], 'white', 30),
             B("Top Panel", [-190, -140, 620, 190, 140, 626], 'mgrey', 26),
             B("Outlet Grille", [-160, -50, 626, 160, 120, 628], 'black', 8),
             rep(B("Outlet Slat", [-155, -45, 628, 155, -39, 632], 'mgrey', 0, 'f'), 9, [0, 19, 0]),
             B("Control Strip", [-150, -130, 626, 150, -75, 629], 'black', 6),
             B("Display", [-40, -122, 629, 40, -86, 630], 'ledb', 0, 'f'),
             rep(CZ("Button", [-120, -104], 8, [629, 632], 'white', 'f'), 2, [50, 0, 0]),
             rep(CZ("Button Right", [70, -104], 8, [629, 632], 'white', 'f'), 2, [50, 0, 0]),
             F("Water Tank", [-180, -157, 60, 180, -150, 300], 'mgrey', 14),
             F("Tank Window", [-60, -159, 120, 60, -157, 260], 'pc', 8, 'f'),
             F("Tank Handle", [-60, -160, 270, 60, -157, 290], 'black', 6, 'f'),
             F("Front Panel", [-185, -155, 310, 185, -150, 600], 'white', 18),
             F("Rear Filter Grille", [-160, 150, 200, 160, 156, 560], 'mesh', 12),
             F("Carry Handle", [-60, 150, 580, 60, 162, 600], 'black', 6, 'f'),
             rep(CZ("Castor Front", [-150, -100], 20, [0, 40], 'rubber'), 2, [300, 0, 0]),
             rep(CZ("Castor Rear", [-150, 100], 20, [0, 40], 'rubber'), 2, [300, 0, 0]),
             CY("Drain Hose Spigot", [120, 100], 9, [150, 195], 'grey')]
    make("FMC_M_MechEq_Dehumidifier", "Refrigerant dehumidifier 20 l/day for imaging rooms, white cabinet on castors, top outlet grille, controls and display, front water tank, rear filter, continuous drain spigot",
         "IfcUnitaryEquipment", ["20lday_Refrigerant"], parts, [E("Body"), SAN("Drain Hose Spigot", "back")],
         {"Extraction 20 l/day at 30 C 80 % RH": A("20l/day"), "Cabinet 400 x 300 x 630 mm": A("400x300x630", "typical 20 l/day unit"), "Load 380 VA": A(380),
          "Drain 13 mm hose to 40 mm waste": A(40)},
         "Modelled as a generic product: rounded white cabinet, top outlet grille with slats, control strip with display and buttons, front water tank with window and handle, rear filter grille and handle, four castors, drain spigot.",
         elec(240, 380))

# ================================================================= 27. square diffuser
def diffuser_square():
    parts = [B("Plenum Box", [-280, -280, 0, 280, 280, 300], 'galv'),
             CZ("Spigot", [0, 0], 125, [300, 400], 'galv'), T("Spigot Bead", 'z', [0, 0], ring(124, 130, 340, 350), 'galv', 'f'),
             B("Face Frame", [-297, -297, -12, 297, 297, 0], 'epw', 2),
             B("Air Gap Outer", [-262, -262, -13, 262, 262, -12], 'black')]
    s, z = 250, -18
    for k in range(1, 4):
        parts.append(B(f"Cone {k}", [-s, -s, z, s, s, z + 6], 'epw'))
        parts.append(B(f"Air Gap {k}", [-(s - 32), -(s - 32), z - 1, s - 32, s - 32, z], 'black'))
        s -= 44; z -= 7
    parts += [B("Centre Plaque", [-s, -s, z, s, s, z + 6], 'epw'),
              CZ("Centre Screw", [0, 0], 6, [z - 2, z], 'chrome', 'f'),
              rep(B("Plenum Hanger Lug", [-300, -20, 250, -280, 20, 290], 'galv', 0, 'f'), 2, [580, 0, 0]),
              B("Damper Spindle", [-6, -125, 360, 6, 125, 372], 'dark', 0, 'f')]
    make("FMC_M_AirTerminal_Diffuser_Square_4Way", "Square 4-way ceiling supply diffuser 300 to 600, white powder-coated, nested cones with centre plaque, plenum box with round side spigot",
         "IfcAirTerminal", ["300_4Way", "450_4Way", "600_4Way"], parts, [DUCT("Supply", "SupplyAir", "Spigot", "top", "In", d=250)],
         {"Face 595 x 595 mm (600 grid)": A(595, "lay-in face for 600 grid"), "Neck / spigot 250 mm": A(250), "Throw 2.5 m at 0.25 m/s": A(2.5, "typical selection")},
         "Modelled as a generic product: face frame with three stepped cones and a centre plaque separated by dark air gaps, plenum box with hanger lugs, round top spigot with bead and damper spindle; face below the ceiling (z = 0).",
         {"Default Elevation": 2700})

# ================================================================= 28. linear slot
def diffuser_linear():
    parts = [B("Frame Front", [-750, -75, -15, 750, -55, 0], 'epw'), B("Frame Rear", [-750, 55, -15, 750, 75, 0], 'epw'),
             B("Divider", [-750, -8, -18, 750, 8, 0], 'epw'),
             rep(B("End Cap", [-760, -75, -16, -750, 75, 0], 'epw'), 2, [1510, 0, 0]),
             B("Slot Throat", [-750, -55, -6, 750, 55, -1], 'black'),
             rep(B("Pattern Controller Front", [-735, -50, -13, -705, -14, -6], 'mgrey', 0, 'f'), 12, [125, 0, 0]),
             rep(B("Pattern Controller Rear", [-735, 14, -13, -705, 50, -6], 'mgrey', 0, 'f'), 12, [125, 0, 0]),
             RT("Plenum Box", [(-60, 0), (60, 0), (75, 60), (75, 250), (-75, 250), (-75, 60)], [-740, 740], 'galv'),
             CZ("Spigot", [0, 0], 62.5, [250, 350], 'galv'), T("Spigot Bead", 'z', [0, 0], ring(62, 68, 290, 300), 'galv', 'f'),
             rep(B("Hanger Lug", [-600, -85, 200, -560, -70, 240], 'galv', 0, 'f'), 2, [1160, 0, 0])]
    make("FMC_M_AirTerminal_Diffuser_Linear_Slot", "Linear slot diffuser 1200 to 1500 mm, 2 slot, white aluminium profiles with pattern controllers, insulated plenum with top spigot",
         "IfcAirTerminal", ["1200_2Slot", "1500_2Slot"], parts, [DUCT("Supply", "SupplyAir", "Spigot", "top", "In", d=125)],
         {"Length 1200 / 1500 mm, face 150 mm": A("1200/1500x150"), "Slot 20 mm x 2": A("2x20"), "Spigot 125 mm": A(125)},
         "Modelled as a generic product: front and rear frame profiles, centre divider, end caps, dark slot throat with pattern controllers in both slots, plenum box with spigot and hanger lugs.",
         {"Default Elevation": 2700})

# ================================================================= 29. laminar flow canopy
def laminar():
    H = 1500
    parts = [B("Plenum", [-H, -H, 0, H, H, 500], 'galv'),
             B("Perimeter Frame Front", [-H, -H, -30, H, -H + 60, 0], 'ss'), B("Perimeter Frame Rear", [-H, H - 60, -30, H, H, 0], 'ss'),
             B("Perimeter Frame Left", [-H, -H + 60, -30, -H + 60, H - 60, 0], 'ss'), B("Perimeter Frame Right", [H - 60, -H + 60, -30, H, H - 60, 0], 'ss'),
             rep(B("Grid Bar NS", [-500, -H + 60, -30, -470, H - 60, 0], 'ss'), 2, [970, 0, 0]),
             rep(B("Grid Bar EW", [-H + 60, -500, -30, H - 60, -470, 0], 'ss'), 2, [0, 970, 0]),
             rep(B("Screen Row A", [-1440, -1440, -24, -500, -500, -4], 'hepa'), 3, [970, 0, 0]),
             rep(B("Screen Row B", [-1440, -470, -24, -500, 470, -4], 'hepa'), 3, [970, 0, 0]),
             rep(B("Screen Row C", [-1440, 500, -24, -500, 1440, -4], 'hepa'), 3, [970, 0, 0]),
             CZ("Light Mount Boss", [0, 0], 150, [-90, -24], 'ss'), T("Light Mount Plate", 'z', [0, 0], ring(150, 230, -30, -24), 'ss', 'f'),
             B("Skirt Front", [-H, -H - 12, -450, H, -H, 0], 'glass'), B("Skirt Rear", [-H, H, -450, H, H + 12, 0], 'glass'),
             B("Skirt Left", [-H - 12, -H, -450, -H, H, 0], 'glass'), B("Skirt Right", [H, -H, -450, H + 12, H, 0], 'glass'),
             B("Skirt Trim Front", [-H - 14, -H - 16, -470, H + 14, -H + 2, -450], 'ss'), B("Skirt Trim Rear", [-H - 14, H - 2, -470, H + 14, H + 16, -450], 'ss'),
             B("Skirt Trim Left", [-H - 16, -H, -470, -H + 2, H, -450], 'ss'), B("Skirt Trim Right", [H - 2, -H, -470, H + 16, H, -450], 'ss'),
             B("Perimeter Light Front", [-1400, -H + 62, -40, 1400, -H + 120, -30], 'pc'), B("Perimeter Light Rear", [-1400, H - 120, -40, 1400, H - 62, -30], 'pc'),
             CZ("Supply Spigot Main", [-750, -750], 200, [500, 620], 'galv'),
             CZ("Supply Spigot 2", [750, -750], 200, [500, 620], 'galv'), rep(CZ("Supply Spigot Rear", [-750, 750], 200, [500, 620], 'galv'), 2, [1500, 0, 0]),
             rep(CZ("Test Port", [-1300, -1300], 10, [-28, -24], 'chrome', 'f'), 2, [2600, 0, 0])]
    make("FMC_M_AirTerminal_Diffuser_LaminarFlow_Theatre", "Ultra-clean ventilation (UCV) laminar-flow canopy 2400 to 3000 square over the operating zone, stainless frame, 3 x 3 terminal screens, glass partial walls, light mounting boss",
         "IfcAirTerminal", ["2400x2400_UCV", "3000x3000_UCV"], parts, [DUCT("Supply", "SupplyAir", "Supply Spigot Main", "top", "In", d=400)],
         {"Canopy 3000 x 3000 mm, partial walls 450 deep": A("3000x3000/450", "HTM 03-01 UCV terminal, partial-wall type"), "Downflow 0.38 m/s at 2 m above floor": A(0.38, "HTM 03-01 UCV practice"),
          "Spigots 4 x 400 mm": A("4x400"), "Underside of canopy 2800 to 3000 mm AFL": A(3000)},
         "Modelled as a generic product: plenum with four spigots, stainless perimeter frame and grid bars, nine white terminal screens, central operating-light mounting boss, glass partial walls with stainless trims, perimeter lights, test ports.",
         {"Default Elevation": 3000})

# ================================================================= 30. return grille
def grille_return():
    parts = frame4("Frame", -325, 325, -25, 325, -12, 0, 25, 'epw') + [
        F("Plenum Opening", [-300, 0, 0, 300, 2, 300], 'black'),
        rep(RT("Blade", [(-1, 4), (-13, 16), (-13, 20), (-1, 8)], [-300, 300], 'epw'), 14, [0, 0, 20.5]),
        B("Plenum Box", [-300, 2, 0, 300, 250, 300], 'galv'),
        CY("Spigot", [0, 150], 125, [250, 320], 'galv'),
        rep(CY("Fixing Screw", [-312, 150], 4, [-13, -12], 'chrome', 'f'), 2, [624, 0, 0])]
    make("FMC_M_AirTerminal_Grille_Return", "Return air grille 300 x 300 to 600 x 300, fixed 45 degree blades, white aluminium, flanged frame, plenum box with round spigot",
         "IfcAirTerminal", ["300x300_Return", "600x300_Return"], parts, [DUCT("Return", "ExhaustAir", "Spigot", "back", "Out", d=250)],
         {"Neck 600 x 300 mm, face 650 x 350": A("600x300"), "Blades 45 deg at 20 mm pitch": A(20), "Face velocity 2 m/s max": A(2, "CIBSE Guide B practice")},
         "Modelled as a generic product: flanged frame, fixed 45-degree blades over a dark opening, plenum box behind the wall face (y = 0) with round spigot, fixing screws.",
         {"Default Elevation": 2400})

# ================================================================= 31. low-level extract
def grille_lowlevel():
    parts = [F("Face Plate", [-325, -3, -25, 325, 0, 325], 'ss', 4),
             rep(F("Slot", [-292, -4, 25, -280, -3, 275], 'black', 5), 19, [31.4, 0, 0]),
             F("Kick Lip", [-325, -8, -25, 325, -3, -10], 'ss', 0, 'f'),
             B("Plenum Box", [-300, 0, 0, 300, 200, 300], 'galv'),
             CZ("Spigot", [0, 100], 100, [300, 420], 'galv'),
             rep(CY("Fixing Screw Bottom", [-305, -5], 4, [-4, -3], 'chrome', 'f'), 2, [610, 0, 0]),
             rep(CY("Fixing Screw Top", [-305, 305], 4, [-4, -3], 'chrome', 'f'), 2, [610, 0, 0]),
             rep(CY("Quarter Turn Latch", [-150, 300], 8, [-6, -3], 'chrome', 'f'), 2, [300, 0, 0])]
    make("FMC_M_AirTerminal_Grille_Extract_LowLevel", "Low-level extract grille 600 x 300, flush stainless steel slotted face (cleanable, theatre and isolation rooms), plenum with top spigot",
         "IfcAirTerminal", ["600x300_LowLevel"], parts, [DUCT("Extract", "ExhaustAir", "Spigot", "top", "Out", d=200)],
         {"Face 650 x 350 mm, stainless": A("650x350", "HTM 03-01 low-level extract practice"), "Bottom 150 mm above floor": A(150, "HTM 03-01"), "Free area 45 %": A("45%")},
         "Modelled as a generic product: flush stainless face plate with vertical slots, kick lip, quarter-turn latches and screws for cleaning access, plenum box in the wall with top spigot.",
         {"Default Elevation": 150})

# ================================================================= 32. door transfer grille
def grille_transfer():
    parts = (frame4("Frame Front", -245, 245, -20, 170, -32, -22, 20, 'alu') + frame4("Frame Rear", -245, 245, -20, 170, 22, 32, 20, 'alu') +
             frame4("Sleeve", -225, 225, 0, 150, -22, 22, 3, 'alu', 'f') +
             [rep(RT("Chevron Blade", [(-22, 2), (0, 14), (22, 2), (22, 7), (0, 19), (-22, 7)], [-222, 222], 'dark'), 8, [0, 0, 18]),
              rep(CY("Screw Front", [-235, 75], 4, [-33, -32], 'chrome', 'f'), 2, [470, 0, 0]),
              rep(CY("Screw Rear", [-235, 75], 4, [32, 33], 'chrome', 'f'), 2, [470, 0, 0])])
    make("FMC_M_AirTerminal_Grille_Transfer_Door", "Door transfer grille 450 x 150, vision-proof chevron blades, two-part anodised aluminium frame both faces of the leaf, for pressure-regime air transfer",
         "IfcAirTerminal", ["450x150_Chevron"], parts, [],
         {"Cut-out 450 x 150 mm, frame 490 x 190": A("450x150"), "Leaf 44 mm (sleeve)": A(44, "hospital door leaf"), "Free area 40 %": A("40%")},
         "Modelled as a generic product: front and rear frames, thin sleeve through the leaf, chevron (vision-proof) blades, screws; centred on the leaf (y = 0). No duct connector: air transfers through the door.",
         {"Default Elevation": 150})

# ================================================================= 33. HEPA terminal
def hepa_terminal():
    parts = [B("Housing", [-290, -290, 0, 290, 290, 350], 'epw'),
             B("Face Frame", [-297, -297, -15, 297, 297, 0], 'epw', 2),
             B("Perforated Face", [-268, -268, -18, 268, 268, -15], 'hepa'),
             rep(B("Perforation Row", [-250, -251, -19, 250, -248, -18], 'dark', 0, 'f'), 24, [0, 21.7, 0]),
             rep(CZ("Face Fixing", [-255, -255], 6, [-21, -18], 'chrome', 'f'), 2, [510, 0, 0]),
             CZ("DOP Test Port", [230, 230], 10, [-24, -18], 'chrome', 'f'),
             CX("Side Spigot", [0, 200], 125, [-380, -290], 'galv'), T("Spigot Bead", 'x', [0, 200], ring(124, 130, -350, -340), 'galv', 'f'),
             CX("Damper Shaft", [0, 200], 6, [-300, -290], 'dark', 'f'),
             B("Damper Quadrant", [-292, -40, 280, -290, 40, 330], 'dark', 0, 'f'),
             CX("Aerosol Injection Port", [-150, 120], 8, [290, 310], 'chrome', 'f'),
             CZ("Pressure Test Port", [150, 150], 8, [350, 372], 'chrome', 'f'),
             B("Hanger Lug Right", [290, -20, 300, 310, 20, 340], 'galv', 0, 'f')]
    make("FMC_M_AirTerminal_HEPA_TerminalFilter", "Terminal HEPA filter box 600 x 600, H14 gel-seal filter, white housing with side spigot and damper, perforated diffuser face, DOP test and injection ports",
         "IfcAirTerminal", ["600x600_H14"], parts, [DUCT("Supply", "SupplyAir", "Side Spigot", "left", "In", d=250)],
         {"Face 595 x 595 mm, housing 350 deep": A("595x595x350", "typical terminal HEPA box for 600 grid"), "Filter H14 (EN 1822), 99.995 % MPPS": A("H14"),
          "Flow 0.15 m3/s at 0.45 m/s face": A(0.15), "Spigot 250 mm": A(250)},
         "Modelled as a generic product: housing with side spigot, bead, damper shaft and quadrant, face frame and perforated face (rows of perforations), face fixings, DOP test port, aerosol injection and pressure test ports, hanger lug.",
         {"Default Elevation": 2700})

# ================================================================= 34. external louvre
def louvre():
    parts = frame4("Frame", -600, 600, 0, 600, -100, 0, 50, 'pcg') + [
        F("Mullion", [-15, -100, 50, 15, 0, 550], 'pcg'),
        rep(RT("Blade", [(-98, 0), (-90, 0), (-90, 10), (-12, 54), (-12, 66), (-98, 18)], [-550, 550], 'pcg'), 11, [0, 0, 47]),
        F("Bird Mesh", [-550, -6, 50, 550, -4, 550], 'mesh'),
        B("Drainage Sill", [-610, -150, -15, 610, 0, 0], 'pcg'), F("Drip Lip", [-610, -156, -35, 610, -150, 0], 'pcg'),
        B("Wall Sleeve", [-550, 0, 50, 550, 250, 550], 'galv'),
        rep(F("Fixing Lug", [-620, -40, 100, -600, 0, 140], 'pcg', 0, 'f'), 2, [1220, 0, 0])]
    make("FMC_M_AirTerminal_Louvre_External", "External weather louvre 600 x 600 to 1200 x 600, drainable inclined blades, centre mullion, bird mesh, drainage sill and drip, wall sleeve",
         "IfcAirTerminal", ["600x600_Weather", "1200x600_Weather"], parts, [DUCT("Intake", "SupplyAir", "Wall Sleeve", "back", "Out", w=1100, h=500)],
         {"Face 1200 x 600 mm, 100 deep": A("1200x600x100"), "Blade pitch 47 mm, 45 deg": A(47), "Free area 50 %, class B rain defence at 1 m/s": A("50%", "EN 13030 class, typical")},
         "Modelled as a generic product: powder-coated frame and mullion, drainable blades with lips, bird mesh behind, projecting sill with drip, galvanised sleeve into the wall, fixing lugs. External face toward -y.",
         {"Default Elevation": 2400})

# ================================================================= 35-38. dampers (duct along y, front -y)
def damper_body(w, h, depth, flange=30, casing='galv'):
    x0, x1, z0, z1, ya, yb = -w / 2, w / 2, -h / 2, h / 2, -depth / 2, depth / 2
    return ([F("Casing Top", [x0, ya, z1, x1, yb, z1 + 3], casing), F("Casing Bottom", [x0, ya, z0 - 3, x1, yb, z0], casing),
             F("Casing Left", [x0 - 3, ya, z0 - 3, x0, yb, z1 + 3], casing), F("Casing Right", [x1, ya, z0 - 3, x1 + 3, yb, z1 + 3], casing)] +
            frame4("Flange Front", x0 - flange, x1 + flange, z0 - flange, z1 + flange, ya - 5, ya, flange, 'galv') +
            frame4("Flange Rear", x0 - flange, x1 + flange, z0 - flange, z1 + flange, yb, yb + 5, flange, 'galv') +
            [F("Duct End Front", [x0, ya - 6, z0, x1, ya - 5, z1], casing, 0, 'm'), F("Duct End Rear", [x0, yb + 5, z0, x1, yb + 6, z1], casing, 0, 'm')])
def ends(w=None, h=None, d=None, system="SupplyAir"):
    return [DUCT("Duct In", system, "Duct End Front", "front", "In", d=d, w=w, h=h), DUCT("Duct Out", system, "Duct End Rear", "back", "Out", d=d, w=w, h=h)]
def aerofoil(cy, cz, chord, ang, t=10):
    a = math.radians(ang); c, s = math.cos(a), math.sin(a); hc = chord / 2
    pts = [(-hc, 0), (-hc * 0.6, t / 2), (hc * 0.3, t / 2), (hc, 0), (hc * 0.3, -t / 2), (-hc * 0.6, -t / 2)]
    return [(cy + u * c - v * s, cz + u * s + v * c) for u, v in pts]

def damper_fire():
    parts = damper_body(600, 400, 300) + frame4("Retaining Angle", -360, 360, -260, 260, -2, 2, 57, 'galv') + [
        rep(F("Curtain Blade", [-296, -18, 145, 296, 18, 150], 'gi'), 7, [0, 0, 7.5]),
        rep(B("Closing Spring", [-280, -10, 100, -270, 10, 145], 'chrome', 0, 'f'), 2, [550, 0, 0]),
        F("Fusible Link", [-14, -6, 105, 14, 6, 140], 'brass', 0, 'f'),
        F("Link Strap", [-4, -4, 60, 4, 4, 105], 'galv', 0, 'f'),
        RT("Blade Guide Left", [(-20, -200), (20, -200), (20, 200), (-20, 200)], [-300, -292], 'galv', 'f'),
        RT("Blade Guide Right", [(-20, -200), (20, -200), (20, 200), (-20, 200)], [292, 300], 'galv', 'f'),
        RT("Label", [(-80, -50), (80, -50), (80, 50), (-80, 50)], [303, 304], 'yellow', 'f')]
    make("FMC_M_DuctAccessory_Damper_Fire", "Curtain fire damper 200 x 200 to 600 x 400, galvanised casing with flanges, folded interlocking curtain blades held by a 72 C fusible link, stainless closing springs",
         "IfcDamper", ["200x200_Curtain", "600x400_Curtain"], parts, ends(600, 400),
         {"Duct 600 x 400 mm, casing 300 long": A("600x400x300"), "Fire rating E60 / ES60 (EN 1366-2)": A("E60", "rated at compartment walls; engineer confirms"),
          "Fusible link 72 C": A(72), "Access door within 500 mm": A(500, "BS 9999 / maintenance practice")},
         "Modelled as a generic product: four-wall casing, front and rear flanges, retaining angle at the wall line (y = 0), folded curtain pack at the head, blade guides, closing springs, fusible link and strap, label. Duct ends are Medium-only faces for the connectors.")

def damper_firesmoke():
    parts = damper_body(600, 400, 400) + frame4("Retaining Angle", -360, 360, -260, 260, -2, 2, 57, 'galv') + [
        rep(RT("Aerofoil Blade", aerofoil(0, -150, 110, 50), [-296, 296], 'gi'), 4, [0, 0, 100]),
        rep(CX("Blade Spindle", [0, -150], 7, [300, 330], 'chrome', 'f'), 4, [0, 0, 100]),
        F("Linkage Bar", [330, -14, -170, 338, -4, 170], 'galv', 0, 'f'),
        B("Actuator Bracket", [303, -130, -160, 318, 130, 160], 'galv'),
        B("Actuator", [318, -95, -70, 420, 95, 70], 'black', 10),
        CX("Manual Crank Port", [60, 30], 10, [420, 426], 'grey', 'f'),
        CX("Position Indicator", [-60, 30], 14, [420, 424], 'ledg', 'f'),
        B("Thermal Trigger", [300, 60, -40, 340, 120, 0], 'grey', 0, 'f'),
        B("End Switch Box", [318, -95, 80, 380, -30, 140], 'grey', 0, 'f')]
    make("FMC_M_DuctAccessory_Damper_FireSmoke", "Motorised fire and smoke damper 600 x 400, multi-blade aerofoil, spring-return actuator with thermal trigger, end switches, galvanised casing and flanges",
         "IfcDamper", ["600x400_Motorised"], parts, ends(600, 400) + [E("Actuator", "right")],
         {"Duct 600 x 400 mm, casing 400 long": A("600x400x400"), "Rating EI60 S, smoke leakage class S": A("EI60S", "EN 1366-2 / -10; engineer confirms"),
          "Actuator 230 V spring return, 10 VA running": A(10), "Thermal trigger 72 C": A(72)},
         "Modelled as a generic product: casing, flanges and retaining angle, four aerofoil blades at 50 degrees, spindles and linkage bar, actuator on a bracket with crank port and position indicator, thermal trigger and end-switch box.",
         elec(240, 10))

def damper_volume():
    parts = damper_body(600, 400, 200) + [
        rep(RT("Opposed Blade A", aerofoil(0, -150, 100, 30, 6), [-296, 296], 'gi'), 2, [0, 0, 200]),
        rep(RT("Opposed Blade B", aerofoil(0, -50, 100, -30, 6), [-296, 296], 'gi'), 2, [0, 0, 200]),
        rep(CX("Blade Spindle", [0, -150], 6, [300, 312], 'chrome', 'f'), 4, [0, 0, 100]),
        F("Linkage Bar", [306, -20, -170, 312, -10, 170], 'galv', 0, 'f'),
        RT("Quadrant Plate", [(-60, -30), (60, -30), (60, 60), (0, 90), (-60, 60)], [303, 306], 'galv'),
        RT("Hand Lever", [(-8, 0), (8, 0), (8, 130), (-8, 130)], [306, 312], 'red'),
        CX("Locking Nut", [0, 70], 10, [312, 322], 'chrome', 'f')]
    make("FMC_M_DuctAccessory_Damper_Volume", "Volume control damper, opposed-blade, galvanised casing with flanges, locking quadrant and hand lever for balancing",
         "IfcDamper", ["200dia_Balancing", "600x400_OBD"], parts, ends(600, 400),
         {"Duct 600 x 400 mm, casing 200 long": A("600x400x200"), "Leakage class 2 (EN 1751)": A(2), "Blade pitch 100 mm, opposed": A(100)},
         "Modelled as a generic product: casing and flanges, four opposed blades, spindles and linkage, quadrant plate with red hand lever and locking nut. One geometry for both types (drawn at 600 x 400); the round 200 type keeps the same parts.")

def damper_psd():
    x0, x1, z0, z1 = -150, 150, 0, 150
    parts = ([F("Sleeve Top", [x0, 0, z1, x1, 150, z1 + 3], 'galv'), F("Sleeve Bottom", [x0, 0, z0 - 3, x1, 150, z0], 'galv'),
              F("Sleeve Left", [x0 - 3, 0, z0 - 3, x0, 150, z1 + 3], 'galv'), F("Sleeve Right", [x1, 0, z0 - 3, x1 + 3, 150, z1 + 3], 'galv')] +
             frame4("Face Flange", x0 - 30, x1 + 30, z0 - 30, z1 + 30, -3, 0, 30, 'galv') +
             [RT("Blade", aerofoil(20, 75, 140, 82, 4), [-145, 145], 'alu'),
              CX("Pivot Spindle", [20, 140], 5, [-150, 150], 'chrome'),
              B("Counterweight Arm", [130, -120, 136, 136, 20, 144], 'galv'),
              CY("Counterweight", [133, 140], 16, [-110, -80], 'brass'),
              CY("Adjusting Nut", [133, 140], 9, [-80, -72], 'chrome', 'f'),
              F("Stop Bracket", [100, -10, 10, 140, 0, 30], 'galv', 0, 'f'),
              F("Setting Scale", [-140, -4, 155, -60, -3, 175], 'alu', 0, 'f'),
              F("Duct End Rear", [x0, 150, z0, x1, 151, z1], 'galv', 0, 'm')])
    make("FMC_M_DuctAccessory_Damper_PressureStabiliser", "Pressure stabiliser 300 x 150, wall mounted, counterweighted single blade that relieves at a set pressure, flanged face, galvanised sleeve",
         "IfcDamper", ["300x150_Counterweight"], parts, [DUCT("Relief", "SupplyAir", "Duct End Rear", "back", "Out", w=300, h=150)],
         {"Opening 300 x 150 mm, sleeve 150 deep": A("300x150x150"), "Set pressure 10 to 25 Pa (adjustable)": A("10-25Pa", "HTM 03-01 pressure regimes"), "Flow 0.05 m3/s at 25 Pa": A(0.05)},
         "Modelled as a generic product: sleeve into the wall (y > 0), face flange on the room side, blade on a pivot spindle, counterweight arm with brass weight and adjusting nut, stop bracket and setting scale.",
         {"Default Elevation": 2200})

def vav():
    parts = [CY("Inlet Spigot", [0, 0], 150, [-450, -300], 'galv'), T("Inlet Seal", 'y', [0, 0], ring(149, 155, -440, -430), 'rubber', 'f'),
             T("Flow Sensor Ring", 'y', [0, 0], ring(150, 158, -390, -378), 'dark', 'f'),
             CY("Damper Body", [0, 0], 152, [-300, -100], 'galv'),
             CX("Damper Shaft", [0, 0], 6, [152, 162], 'dark', 'f'),
             B("Casing", [-300, -100, -200, 300, 600, 200], 'galv'),
             B("Access Panel", [-220, 0, 200, 220, 500, 204], 'galv'),
             rep(CZ("Panel Screw", [-200, 20], 4, [204, 206], 'chrome', 'f'), 2, [400, 0, 0]),
             rep(CZ("Panel Screw Rear", [-200, 480], 4, [204, 206], 'chrome', 'f'), 2, [400, 0, 0])] + \
        frame4("Outlet Flange", -320, 320, -220, 220, 600, 610, 30, 'galv') + [
             F("Outlet Opening", [-290, 600, -190, 290, 604, 190], 'black'),
             B("Actuator", [162, -250, -50, 222, -150, 50], 'black', 6),
             B("Controller", [222, -295, -100, 300, -105, 100], 'grey', 6),
             CX("Controller LED", [-150, 70], 4, [300, 302], 'ledg', 'f'),
             CX("Sensor Tube High", [-370, 60], 3, [158, 222], 'blue', 'f'), CX("Sensor Tube Low", [-370, 40], 3, [158, 222], 'white', 'f'),
             B("Hanger Bracket", [-330, 250, 150, -300, 310, 200], 'galv', 0, 'f')]
    types = [{"name": "200_VAV"}, {"name": "300_VAV"}]
    make("FMC_M_DuctAccessory_Valve_CAV_VAV", "Single-duct CAV / VAV terminal unit 200 to 300 mm inlet, flow-sensor cross, damper with actuator and controller, lined casing with rectangular outlet",
         "IfcAirTerminalBox", types, parts,
         [DUCT("Duct In", "SupplyAir", "Inlet Spigot", "front", "In", d=300), DUCT("Duct Out", "SupplyAir", "Outlet Opening", "back", "Out", w=580, h=380), E("Controller", "right")],
         {"Inlet 200 / 300 mm, casing 600 x 400 x 700": A("300/600x400x700", "typical VAV with attenuator"), "Flow range 0.05 to 0.45 m3/s (300)": A("0.05-0.45"),
          "Controller 24 V AC via local transformer, 20 VA": A(20)},
         "Modelled as a generic product: round inlet spigot with seal and flow-sensor ring, damper body with shaft, actuator and controller with LED and pressure tubes, lined casing with access panel and screws, flanged outlet, hanger bracket.",
         elec(240, 20))

# ================================================================= 40-42. wall controls
def pressure_monitor():
    parts = [B("Back Box", [-38, 0, 32, 38, 35, 108], 'dark'),
             F("Housing", [-70, -38, 0, 70, 0, 140], 'white', 10),
             F("Display Bezel", [-58, -40, 55, 58, -38, 128], 'black', 6),
             F("Display Screen", [-50, -41, 64, 50, -40, 120], 'ledb', 3, 'f'),
             CY("LED Green", [-35, 38], 6, [-42, -38], 'ledg'), CY("LED Amber", [0, 38], 6, [-42, -38], 'amber'), CY("LED Red", [35, 38], 6, [-42, -38], 'ledr'),
             rep(CY("Button", [-35, 15], 7, [-41, -38], 'grey', 'f'), 3, [35, 0, 0]),
             rep(F("Sounder Slot", [48, -39, 8, 62, -38, 10], 'black', 0, 'f'), 3, [0, 0, 5]),
             CZ("Reference Port", [-55, -19], 3, [-6, 0], 'chrome', 'f'),
             rep(CY("Screw Cover", [-62, 130], 3, [-39, -38], 'mgrey', 'f'), 2, [124, 0, 0])]
    make("FMC_M_DuctAccessory_Sensor_RoomPressure", "Room pressure monitor with display at the room door, differential pressure reading, green / amber / red status LEDs, mute and test buttons, reference port",
         "IfcSensor", ["140x140_Wall"], parts, [ELV("Back Box")],
         {"Housing 140 x 140 x 38 mm": A("140x140x38"), "Range plus or minus 50 Pa, alarm at set point": A("50Pa", "HTM 03-01 isolation room monitoring"), "Mounting height 1600 mm beside door": A(1600)},
         "Modelled as a generic product: white housing on a back box, display with bezel, three status LEDs, three buttons, sounder slots, reference port, screw covers.",
         {"Default Elevation": 1600})

def temp_rh():
    parts = [F("Base", [-42, -10, 0, 42, 0, 85], 'white', 6), F("Cover", [-41, -30, 2, 41, -10, 83], 'white', 12),
             rep(F("Vent Slot Bottom", [-28, -31, 8, 28, -30, 11], 'mgrey', 1, 'f'), 4, [0, 0, 6]),
             rep(F("Vent Slot Top", [-28, -31, 56, 28, -30, 59], 'mgrey', 1, 'f'), 4, [0, 0, 6]),
             CY("Status LED", [30, 45], 2.5, [-31, -30], 'ledg', 'f'),
             CZ("Conduit Entry", [0, -5], 9, [85, 100], 'white', 'f'),
             rep(B("Vent Side Left", [-43, -26, 20, -41, -14, 24], 'mgrey', 0, 'f'), 3, [0, 0, 18])]
    make("FMC_M_DuctAccessory_Sensor_TempHumidity", "Room temperature and humidity sensor, surface wall mounted, white vented housing, status LED, top conduit entry",
         "IfcSensor", ["85x85_Wall"], parts, [ELV("Base")],
         {"Housing 85 x 85 x 30 mm": A("85x85x30"), "Accuracy 0.3 C, 2 % RH": A("0.3C/2%RH"), "Mounting height 1500 mm": A(1500, "BMS practice, away from draughts")},
         "Modelled as a generic product: base and rounded cover with front and side vent slots, status LED, conduit entry.",
         {"Default Elevation": 1500})

def thermostat():
    parts = [B("Back Box", [-35, 0, 8, 35, 35, 78], 'dark'),
             F("Plate", [-43, -12, 0, 43, 0, 86], 'white', 6),
             F("LCD Bezel", [-33, -13, 38, 33, -12, 78], 'black', 4),
             F("Temperature Digits", [-22, -13.6, 50, 12, -13, 70], 'ledb', 0, 'f'),
             F("Mode Icons", [16, -13.6, 52, 28, -13, 68], 'ledb', 0, 'f'),
             rep(CY("Button", [-27, 22], 5, [-15, -12], 'mgrey', 'f'), 4, [18, 0, 0]),
             CY("Occupancy LED", [34, 10], 2, [-13, -12], 'ledg', 'f'),
             rep(CY("Screw Cover", [-36, 8], 2.5, [-13, -12], 'mgrey', 'f'), 2, [72, 0, 0])]
    make("FMC_M_DuctAccessory_Thermostat_Controller", "Room controller / thermostat 86 x 86 on a standard back box, backlit LCD with set point and mode, four buttons, occupancy LED",
         "IfcUnitaryControlElement", ["86x86_Wall"], parts, [ELV("Back Box")],
         {"Plate 86 x 86 x 12 mm on 35 mm box": A("86x86x12", "BS 4662 single box"), "Set point range 16 to 28 C": A("16-28C"), "Mounting height 1400 mm": A(1400, "accessible controls practice")},
         "Modelled as a generic product: plate on a back box, LCD bezel with digits and mode icons, four buttons, occupancy LED, screw covers.",
         {"Default Elevation": 1400})

# ================================================================= second pass (17 Oct evening): per-type geometry
STD_D = [100, 125, 150, 160, 200, 250, 315, 355, 400, 450]
def only(parts, t):
    for p in parts: p['only'] = [t]
    return parts
def capture(builder):
    builder(); return P.pop()
def scale_part(p, kx, ky, kz, sfx):
    import copy
    q = copy.deepcopy(p); q['n'] = f"{p['n']} {sfx}"; K = {'x': kx, 'y': ky, 'z': kz}; s = q['shape']; ax = q.get('axis', 'z')
    if 'at' in q: a = q['at']; q['at'] = [round(a[0] * kx, 2), round(a[1] * ky, 2), round(a[2] * kz, 2), round(a[3] * kx, 2), round(a[4] * ky, 2), round(a[5] * kz, 2)]
    for k in ('x', 'y', 'z'):
        if k in q and isinstance(q[k], list): q[k] = [round(v * K[k], 2) for v in q[k]]
    if s == 'prism': q['pts'] = [[round(a * kx, 2), round(b * ky, 2)] for a, b in q['pts']]
    if s == 'front': q['pts'] = [[round(a * kx, 2), round(b * kz, 2)] for a, b in q['pts']]
    if s == 'right': q['pts'] = [[round(a * ky, 2), round(b * kz, 2)] for a, b in q['pts']]
    if s in ('cyl', 'turn'):
        perp = {'z': ('x', 'y'), 'y': ('x', 'z'), 'x': ('y', 'z')}[ax]
        q['c'] = [round(q['c'][0] * K[perp[0]], 2), round(q['c'][1] * K[perp[1]], 2)]
        kr = min(K[perp[0]], K[perp[1]])
        if s == 'cyl': q['r'] = round(q['r'] * kr, 2)
        else: q['profile'] = [[round(r * kr, 2), round(t * K[ax], 2)] for r, t in q['profile']]
    if 'repeat' in q: d = q['repeat']['d']; q['repeat']['d'] = [round(d[0] * kx, 2), round(d[1] * ky, 2), round(d[2] * kz, 2)]
    return q
def per_type(prod, specs, shared=(), drop=None):
    """specs: [(type, kx, ky, kz, sfx)]; the spec with k = 1 is the drawn base. Shared parts stay once, without 'only'.
    Duct connectors are repeated per type on that type's part, sized by the scale; other connectors stay on the base type."""
    base = [p for p in prod['parts']]; sh = [p for p in base if p['n'] in shared]; var = [p for p in base if p['n'] not in shared]
    new = list(sh); conns = []
    shared = set(shared) | {f"{p['n']} {k + 1}" for p in sh if p.get('repeat') for k in range(p['repeat']['n'])}
    bsfx = [sp[4] for sp in specs if sp[1] == sp[2] == sp[3] == 1][0]
    for t, kx, ky, kz, sf in specs:
        ps = [scale_part(p, kx, ky, kz, sf) for p in var if not (drop and p['n'] in drop.get(t, ()))]
        new += only(ps, t)
        for c in prod['connectors']:
            if c['domain'] != 'duct' or c['part'] in shared: continue
            c2 = dict(c, n=f"{c['n']} {sf}", part=f"{c['part']} {sf}")
            side = c['side']; a, b = ((kx, ky) if side in ('top', 'bottom') else (kx, kz) if side in ('front', 'back') else (ky, kz))
            if 'diameter' in c: c2['diameter'] = min(STD_D, key=lambda d: abs(d - c['diameter'] * min(a, b)))
            if 'width' in c: c2['width'] = round(c['width'] * a / 10) * 10; c2['height'] = round(c['height'] * b / 10) * 10
            conns.append(c2)
    for c in prod['connectors']:
        if c['domain'] == 'duct' and c['part'] not in shared: continue
        conns.append(dict(c, part=c['part'] if c['part'] in shared else f"{c['part']} {bsfx}"))
    prod['parts'] = new; prod['connectors'] = conns
    check(prod); P.append(prod); return prod
def check(prod):
    ex = fp.expand(prod['parts']); names = [p['n'] for p in ex]
    assert len(names) == len(set(names)), (prod['family'], [n for n in names if names.count(n) > 1])
    assert len(ex) <= 70, (prod['family'], len(ex))
    tn = {t['name'] for t in prod['types']}
    for p in ex: assert set(p.get('only', [])) <= tn, (prod['family'], p['n'])
    for c in prod['connectors']: assert c['part'] in names, (prod['family'], c['part'])
    prod['materials'] = {k: MAT[k] for k in sorted({p['mat'] for p in ex if p.get('mat')})}

_inline, _roof, _wall, _hood, _curtain, _cfan, _dsq, _dlin, _lam, _gret, _louv = inline_fan, roof_fan, wall_fan, kitchen_hood, air_curtain, ceiling_fan, diffuser_square, diffuser_linear, laminar, grille_return, louvre
def inline_fan(): per_type(capture(_inline), [("100_Inline", .5, .5, .5, "100"), ("150_Inline", .75, .75, .75, "150"), ("200_Inline", 1, 1, 1, "200")])
def roof_fan(): per_type(capture(_roof), [("300_Roof", .75, .75, .8, "300"), ("450_Roof", 1, 1, 1, "450")])
def wall_fan(): per_type(capture(_wall), [("150_Wall", .7, 1, .7, "150"), ("250_Wall", 1, 1, 1, "250")])
def kitchen_hood(): per_type(capture(_hood), [("2400_WallCanopy", 1, 1, 1, "2400"), ("3600_WallCanopy", 1.5, 1, 1, "3600")])
def air_curtain(): per_type(capture(_curtain), [("1500_Ambient", 1, 1, 1, "1500"), ("2000_Ambient", 1.335, 1, 1, "2000")], shared=("Mounting Bracket",))
def ceiling_fan():
    prod = capture(_cfan)
    per_type(prod, [("1200_3Blade", .857, .857, 1, "1200"), ("1400_3Blade", 1, 1, 1, "1400")],
             shared=tuple(p['n'] for p in prod['parts'] if not p['n'].startswith(('Blade ', 'Blade Screw'))))
def diffuser_square(): per_type(capture(_dsq), [("300_4Way", .5, .5, .8, "300"), ("450_4Way", .75, .75, .9, "450"), ("600_4Way", 1, 1, 1, "600")])
def diffuser_linear(): per_type(capture(_dlin), [("1200_2Slot", .8, 1, 1, "1200"), ("1500_2Slot", 1, 1, 1, "1500")], shared=("Spigot", "Spigot Bead"))
def laminar(): per_type(capture(_lam), [("2400x2400_UCV", .8, .8, 1, "2400"), ("3000x3000_UCV", 1, 1, 1, "3000")], shared=("Light Mount Boss", "Light Mount Plate"))
def grille_return(): per_type(capture(_gret), [("300x300_Return", .5, 1, 1, "300"), ("600x300_Return", 1, 1, 1, "600")])
def louvre(): per_type(capture(_louv), [("600x600_Weather", .5, 1, 1, "600"), ("1200x600_Weather", 1, 1, 1, "1200")], drop={"600x600_Weather": ("Mullion",)})

def damper_fire():
    parts, conns = [], []
    for t, w, h, sf, nb in (("200x200_Curtain", 200, 200, "200", 4), ("600x400_Curtain", 600, 400, "600", 7)):
        x1, z1 = w / 2, h / 2
        p = damper_body(w, h, 300) + frame4("Retaining Angle", -x1 - 60, x1 + 60, -z1 - 60, z1 + 60, -2, 2, 57, 'galv') + [
            rep(F("Curtain Blade", [-x1 + 4, -18, z1 - 55, x1 - 4, 18, z1 - 50], 'gi'), nb, [0, 0, 7.5]),
            rep(B("Closing Spring", [-x1 + 20, -10, z1 - 100, -x1 + 30, 10, z1 - 55], 'chrome', 0, 'f'), 2, [w - 50, 0, 0]),
            F("Fusible Link", [-14, -6, z1 - 95, 14, -6 + 12, z1 - 60], 'brass', 0, 'f'),
            F("Link Strap", [-4, -4, z1 - 140, 4, 4, z1 - 95], 'galv', 0, 'f'),
            RT("Blade Guide Left", [(-20, -z1), (20, -z1), (20, z1), (-20, z1)], [-x1, -x1 + 8], 'galv', 'f'),
            RT("Blade Guide Right", [(-20, -z1), (20, -z1), (20, z1), (-20, z1)], [x1 - 8, x1], 'galv', 'f'),
            RT("Label", [(-80, -min(50, z1 - 10)), (80, -min(50, z1 - 10)), (80, min(50, z1 - 10)), (-80, min(50, z1 - 10))], [x1 + 3, x1 + 4], 'yellow', 'f')]
        parts += only([scale_part(q, 1, 1, 1, sf) for q in p], t)
        conns += [DUCT(f"Duct In {sf}", "SupplyAir", f"Duct End Front {sf}", "front", "In", w=w, h=h), DUCT(f"Duct Out {sf}", "SupplyAir", f"Duct End Rear {sf}", "back", "Out", w=w, h=h)]
    make("FMC_M_DuctAccessory_Damper_Fire", "Curtain fire damper 200 x 200 to 600 x 400, galvanised casing with flanges, folded interlocking curtain blades held by a 72 C fusible link, stainless closing springs",
         "IfcDamper", ["200x200_Curtain", "600x400_Curtain"], parts, conns,
         {"Duct 200 x 200 / 600 x 400 mm, casing 300 long": A("200x200/600x400x300"), "Fire rating E60 / ES60 (EN 1366-2)": A("E60", "rated at compartment walls; engineer confirms"),
          "Fusible link 72 C": A(72), "Access door within 500 mm": A(500, "BS 9999 / maintenance practice")},
         "Modelled as a generic product, one part set per type size: four-wall casing, front and rear flanges, retaining angle at the wall line (y = 0), folded curtain pack at the head, blade guides, closing springs, fusible link and strap, label. Duct ends are Medium-only faces for the connectors.")

def damper_volume():
    rect = damper_body(600, 400, 200) + [
        rep(RT("Opposed Blade A", aerofoil(0, -150, 100, 30, 6), [-296, 296], 'gi'), 2, [0, 0, 200]),
        rep(RT("Opposed Blade B", aerofoil(0, -50, 100, -30, 6), [-296, 296], 'gi'), 2, [0, 0, 200]),
        rep(CX("Blade Spindle", [0, -150], 6, [300, 312], 'chrome', 'f'), 4, [0, 0, 100]),
        F("Linkage Bar", [306, -20, -170, 312, -10, 170], 'galv', 0, 'f'),
        RT("Quadrant Plate", [(-60, -30), (60, -30), (60, 60), (0, 90), (-60, 60)], [303, 306], 'galv'),
        RT("Hand Lever", [(-8, 0), (8, 0), (8, 130), (-8, 130)], [306, 312], 'red'),
        CX("Locking Nut", [0, 70], 10, [312, 322], 'chrome', 'f')]
    rnd = [CY("Round Casing", [0, 0], 100, [-100, 100], 'galv'),
           T("Bead Front", 'y', [0, 0], ring(100, 104, -80, -72), 'galv', 'f'), T("Bead Rear", 'y', [0, 0], ring(100, 104, 72, 80), 'galv', 'f'),
           CY("Duct End Front", [0, 0], 100, [-101, -100], 'galv', 'm'), CY("Duct End Rear", [0, 0], 100, [100, 101], 'galv', 'm'),
           CX("Spindle", [0, 0], 5, [-112, 118], 'chrome'),
           RT("Quadrant Plate", [(-45, -20), (45, -20), (45, 40), (0, 60), (-45, 40)], [100, 103], 'galv'),
           RT("Hand Lever", [(-6, 0), (6, 0), (6, 95), (-6, 95)], [103, 108], 'red'),
           CX("Locking Nut", [0, 45], 8, [108, 116], 'chrome', 'f'),
           T("Seal Front", 'y', [0, 0], ring(104, 108, -100, -94), 'rubber', 'f')]
    parts = only([scale_part(q, 1, 1, 1, "Rect") for q in rect], "600x400_OBD") + only([scale_part(q, 1, 1, 1, "Round") for q in rnd], "200dia_Balancing")
    conns = [DUCT("Duct In Round", "SupplyAir", "Duct End Front Round", "front", "In", d=200), DUCT("Duct Out Round", "SupplyAir", "Duct End Rear Round", "back", "Out", d=200),
             DUCT("Duct In Rect", "SupplyAir", "Duct End Front Rect", "front", "In", w=600, h=400), DUCT("Duct Out Rect", "SupplyAir", "Duct End Rear Rect", "back", "Out", w=600, h=400)]
    make("FMC_M_DuctAccessory_Damper_Volume", "Volume control damper for balancing: 200 mm round single-blade (iris-free butterfly) or 600 x 400 rectangular opposed-blade, locking quadrant and hand lever",
         "IfcDamper", ["200dia_Balancing", "600x400_OBD"], parts, conns,
         {"Round 200 mm x 200 long / rectangular 600 x 400 x 200": A("200dia/600x400"), "Leakage class 2 (EN 1751)": A(2), "Blade pitch 100 mm, opposed (rectangular)": A(100)},
         "Modelled as a generic product with a part set per type: the round type has a beaded round casing, butterfly spindle, quadrant, red lever and nut; the rectangular type has casing, flanges, four opposed blades, spindles, linkage, quadrant and lever. Duct ends are Medium-only faces for the connectors.")
    P[-1]['parts'] = parts

_vav = vav
def vav():
    prod = capture(_vav)
    inlet = ("Inlet Spigot", "Inlet Seal", "Flow Sensor Ring", "Damper Body")
    sh = tuple(p['n'] for p in prod['parts'] if p['n'] not in inlet)
    per_type(prod, [("200_VAV", .667, 1, .667, "200"), ("300_VAV", 1, 1, 1, "300")], shared=sh)

# ================================================================= build list
BUILD = [split_wall, split_outdoor,
         lambda: cassette("FMC_M_MechEq_AC_Cassette_4Way", 950, 840, 250, [{"name": n, "values": {"Apparent Load": va}} for n, va in (("5.3kW_18kBTU", 1700), ("7.0kW_24kBTU", 2300), ("10.5kW_36kBTU", 3600))],
                          "Ceiling cassette 4-way, 5.3 to 10.5 kW (18k to 36k BTU/h), 950 square white panel with four outlet slots and louvres, central intake grille",
                          {"Panel 950 x 950 mm, body 840 x 840 x 250": A("950/840x250", "typical 4-way cassette"), "Cooling 5.3 / 7.0 / 10.5 kW": A("5.3-10.5kW"),
                           "Load 1.7 / 2.3 / 3.6 kVA": A("1.7-3.6kVA"), "Drain socket 32 mm to 40 mm waste": A(40)},
                          "Modelled as a generic product: chassis above the ceiling (z > 0) on four hanger brackets, white panel below the ceiling with intake grille and slats, four outlet slots with louvre flaps, corner covers, signal receiver with LED, electrical box, drain socket and refrigerant tails.", 3600),
         ducted_fcu, vrf_outdoor,
         lambda: cassette("FMC_M_MechEq_VRF_Indoor_Cassette", 620, 570, 285, [{"name": "2.8kW_Compact4Way", "values": {"Apparent Load": 60}}, {"name": "5.6kW_Compact4Way", "values": {"Apparent Load": 90}}],
                          "VRF indoor cassette, compact 4-way for a 600 grid, 2.8 to 5.6 kW, 620 square panel, intake grille, four outlet slots, EEV kit box",
                          {"Panel 620 x 620 mm, body 570 x 570 x 285": A("620/570x285", "typical compact VRF cassette"), "Cooling 2.8 / 5.6 kW": A("2.8/5.6kW"), "Fan load 60 / 90 VA": A("60/90")},
                          "Modelled as a generic product: compact chassis above the ceiling (z > 0) with hanger brackets and EEV kit box, panel below the ceiling with intake grille, outlet slots and flaps, corner covers, receiver LED, electrical box, drain and refrigerant tails.", 90, True),
         precision,
         lambda: ahu("FMC_M_MechEq_AHU_Theatre_HEPA", [('mix', 900, 'Mixing'), ('filter', 600, 'Prefilter'), ('filter', 900, 'Bag Filter'), ('coil', 500, 'Heating Coil'),
                                                       ('coil', 700, 'Cooling Coil'), ('humid', 900, 'Humidifier'), ('fan', 1300, 'Fan'), ('atten', 900, 'Attenuator'),
                                                       ('hepa', 700, 'HEPA'), ('outlet', 700, 'Outlet')], 1400, 1500,
                     [{"name": "1.5m3s_Theatre", "values": {"Apparent Load": 15000}}, {"name": "2.5m3s_Theatre", "values": {"Apparent Load": 24000}}],
                     "Operating theatre AHU 1.5 to 2.5 m3/s, sectional casing: mixing, G4 prefilter, F7 bag filter, LPHW and CHW coils, steam humidifier, plug fan, attenuator, H14 HEPA, outlet; access doors with handles",
                     {"Casing 8100 x 1400 x 1650 mm (1.5 m3/s)": A("8100x1400x1650", "typical theatre AHU sections"), "Filters G4 + F7 + H14 terminal stage": A("G4/F7/H14", "HTM 03-01"),
                      "About 25 air changes per hour in the theatre": A(25, "HTM 03-01 conventional theatre"), "Load 15 / 24 kVA, 415 V 3-phase": A("15/24kVA"), "Access side 1000 mm": A(1000, "door swing and filter withdrawal")},
                     "Modelled as a generic product: base frame with lifting lugs, casing in ten sections with joint strips; mixing box with return spigot on top and fresh-air damper (blades, actuator) on the end; filter and HEPA doors with gauges, coil header plates with flow and return, cooling-coil drain and trap, humidifier and fan doors with windows, steam inlet, fan isolator, outlet spigot and control panel. Hinges, handles and windows on every door.",
                     24000, True),
         lambda: ahu("FMC_M_MechEq_AHU_General", [('mix', 1000, 'Mixing'), ('filter', 450, 'Panel Filter'), ('filter', 800, 'Bag Filter'), ('coil', 500, 'Heating Coil'),
                                                 ('coil', 700, 'Cooling Coil'), ('fan', 1400, 'Fan'), ('outlet', 900, 'Outlet')], 1900, 1700,
                     [{"name": "1m3s_General", "values": {"Apparent Load": 6000}}, {"name": "3m3s_General", "values": {"Apparent Load": 16000}}],
                     "General supply / return AHU 1 to 3 m3/s, sectional casing: mixing box with return and fresh-air dampers, G4 panel and F7 bag filters, LPHW and CHW coils, plug fan with isolator, outlet",
                     {"Casing 5750 x 1900 x 1850 mm (3 m3/s)": A("5750x1900x1850", "typical 3 m3/s AHU"), "Filters G4 + F7": A("G4/F7"), "Load 6 / 16 kVA, 415 V 3-phase": A("6/16kVA"),
                      "Access side 1000 mm": A(1000)},
                     "Modelled as a generic product: base frame with lifting lugs, seven-section casing with joint strips, mixing box with bladed return damper on top and fresh-air damper on the end with actuators, filter doors with gauges, coil header plates with pipe connections, drain trap, fan door with window and yellow isolator, outlet spigot and control panel.",
                     16000),
         erv, inline_fan, roof_fan, wall_fan, fume_fan, isolation_hepa, chiller, chw_pump, kitchen_hood, cold_condenser, cold_evap,
         pts_station, pts_blower, steam_boiler, air_curtain, ceiling_fan, dehumidifier,
         diffuser_square, diffuser_linear, laminar, grille_return, grille_lowlevel, grille_transfer, hepa_terminal, louvre,
         damper_fire, damper_firesmoke, damper_volume, damper_psd, vav, pressure_monitor, temp_rh, thermostat]

if __name__ == '__main__':
    for b in BUILD: b()
    assert {p['family'] for p in P} == set(RECS), set(RECS) - {p['family'] for p in P}
    json.dump([], open(os.path.join(HERE, 'batches', 'M_mechanical.materials_needed.json'), 'w'), indent=1)
    sel = sys.argv[1:]
    SCR = os.environ.get('FMC_SCRATCH', '/tmp/claude-0/-home-claude/ce672511-dda7-500e-94dd-9bdb64997d11/scratchpad/M2')
    below = {"Air Terminals"}
    out = []
    for prod in P:
        if sel and not any(s in prod['family'] for s in only): continue
        f = prod['family']
        json.dump(prod, open(os.path.join(HERE, f + '.product.json'), 'w'), indent=1)
        r = fp.compile_product(prod)
        json.dump(r, open(os.path.join(HERE, f + '.recipe.json'), 'w'), indent=1)
        ceiling = any(k in f for k in ('Hood', 'CeilingFan', 'Inline'))
        views = ((('3D', -35, 22), ('Top', -35, 22), ('Front', 0, 0), ('Side', 90, 0)) if prod.get('view') == 'below' else
                 (('3D', -35, 22), ('Below', -35, -40), ('Front', 0, 0), ('Side', 90, 0)) if ceiling else (('3D', -35, 22), ('Front', 0, 0), ('Side', 90, 0), ('Plan', 0, 89.9)))
        fp.render(prod, os.path.join(HERE, f + '.preview.png'), views=views)
        fp.render_type_image(prod, os.path.join(HERE, f + '.png'), size=600)
        if any(p.get('only') for p in prod['parts']):   # check the other types too (scratch only)
            os.makedirs(SCR, exist_ok=True)
            for t in prod['types'][1:]:
                prod['_render_type'] = t['name']; fp.render(prod, os.path.join(SCR, f + '__' + t['name'] + '.png'), views=views)
            prod.pop('_render_type', None)
        out.append((f, len(fp.expand(prod['parts'])), len(r['ops'])))
        print(out[-1], flush=True)
