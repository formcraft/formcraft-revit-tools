"""Healthcare pack, batch FL (fire protection + landscape): 38 families modelled as detailed products.
Pattern: make_products.py. Compile + render with ../../tools/fmc_parts.py (not edited here).
Run: python3 gen_FL_fire_landscape.py [family ...]   (writes <family>.product.json, .recipe.json, .preview.png, .png)
Geometry is drawn for the type named first in each family's 'geometry' note; other types share it (sizes in values)."""
import json, os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import fmc_parts as fp

BATCH = 'FL_fire_landscape'
RECS = {r['family']: r for r in json.load(open(os.path.join(HERE, 'batches', BATCH + '.json')))}
A = lambda v, src='typical product, to confirm with the supplier': {"value": v, "source_status": "assumed", "source": src}
P = []

# ------------------------------------------------------------------ part helpers
def _p(n, shape, m, lod, **k):
    d = {"n": n, "shape": shape}
    d.update(k)
    if m: d["mat"] = m
    if lod != 'mf': d["lod"] = lod
    return d
def B(n, at, m, r=0, lod='mf'): return _p(n, 'box', m, lod, at=at, **({"r": r} if r else {}))
def F(n, at, m, r=0, lod='mf'): return _p(n, 'fbox', m, lod, at=at, **({"r": r} if r else {}))
def CY(n, ax, c, r, rng, m, lod='mf'): return _p(n, 'cyl', m, lod, axis=ax, c=c, r=r, **{ax: rng})
def TU(n, ax, c, prof, m, lod='mf'): return _p(n, 'turn', m, lod, axis=ax, c=c, profile=prof)
def RING(n, ax, c, r0, r1, t0, t1, m, lod='mf'): return TU(n, ax, c, [[r0, t0], [r1, t0], [r1, t1], [r0, t1]], m, lod)
def DISC(n, ax, c, r, t0, t1, m, lod='mf'): return TU(n, ax, c, [[0, t0], [r, t0], [r, t1], [0, t1]], m, lod)
def FR(n, pts, y, m, lod='mf'): return _p(n, 'front', m, lod, pts=pts, y=y)
def RT(n, pts, x, m, lod='mf'): return _p(n, 'right', m, lod, pts=pts, x=x)
def PR(n, pts, z, m, lod='mf'): return _p(n, 'prism', m, lod, pts=pts, z=z)
def rep(d, n, dv): d["repeat"] = {"n": n, "d": dv}; return d
def ell_prof(rx, z0, z1, k=10):
    zm, hz = (z0 + z1) / 2, (z1 - z0) / 2
    return [[round(rx * math.sin(math.pi * i / k), 1), round(zm - hz * math.cos(math.pi * i / k), 1)] for i in range(k + 1)]
def ELL(n, c, rx, z0, z1, m, lod='mf', k=10): return TU(n, 'z', c, ell_prof(rx, z0, z1, k), m, lod)
def bar2(p0, p1, w):
    """Quad of width w along the segment p0->p1 (2D)."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]; L = math.hypot(dx, dy); nx, ny = -dy / L * w / 2, dx / L * w / 2
    return [[round(p0[0] + nx, 1), round(p0[1] + ny, 1)], [round(p1[0] + nx, 1), round(p1[1] + ny, 1)],
            [round(p1[0] - nx, 1), round(p1[1] - ny, 1)], [round(p0[0] - nx, 1), round(p0[1] - ny, 1)]]
def BXZ(n, p0, p1, w, y, m, lod='mf'): return FR(n, bar2(p0, p1, w), y, m, lod)    # slanted bar in the front plane
def BYZ(n, p0, p1, w, x, m, lod='mf'): return RT(n, bar2(p0, p1, w), x, m, lod)    # slanted bar in the side plane
def arch(y0, y1, z0, rise, k=8):
    cy, ry = (y0 + y1) / 2, (y1 - y0) / 2
    return [[y0, z0]] + [[round(cy - ry * math.cos(math.pi * i / k), 1), round(z0 + rise * math.sin(math.pi * i / k), 1)] for i in range(k + 1)] + [[y1, z0]]

def count(parts): return sum(p.get('repeat', {}).get('n', 1) for p in parts)

# ------------------------------------------------------------------ connectors
def pipe(n, part, side, system, dia, flow='In'): return {"n": n, "domain": "pipe", "system": system, "part": part, "side": side, "diameter": dia, "flow": flow}
def elec(n, part, side, system='PowerBalanced'): return {"n": n, "domain": "electrical", "system": system, "part": part, "side": side}

# ------------------------------------------------------------------ materials (kit names only)
M = {"red": "FMC_Metal_SprinklerPipe_RedPainted",       # nearest to signal-red painted steel; FMC_Paint_Enamel_SignalRed requested
     "hose": "FMC_Plastic_FireHoseReel_Red", "brass": "FMC_Metal_Brass_Polished", "chrome": "FMC_Metal_Chrome_Polished",
     "steel": "FMC_Metal_SteelLTZ_Painted", "galv": "FMC_Metal_ColdFormed_Galvanised", "gi": "FMC_Metal_GI_Pipe",
     "ss": "FMC_Metal_StainlessSteel_Brushed", "white": "FMC_Plastic_ABS_White", "black": "FMC_Plastic_ABS_Black",
     "grey": "FMC_Plastic_ABS_Grey", "yellow": "FMC_Plastic_ABS_Yellow", "blue": "FMC_Plastic_ABS_Blue",
     "ledr": "FMC_Plastic_LED_Red", "ledg": "FMC_Plastic_LED_Green", "glass": "FMC_Glass_Clear", "pc": "FMC_Plastic_Polycarbonate_Clear",
     "lcd": "FMC_Glass_Reflective_BlueGreen", "rubber": "FMC_Rubber_Black", "epw": "FMC_Metal_Steel_EpoxyCoated_White",
     "conc": "FMC_Concrete_Precast_Painted", "concg": "FMC_Concrete_C30", "bark": "FMC_Timber_Mugavu",
     "leaf1": "FMC_Plant_Grass_Kikuyu", "leaf2": "FMC_Plant_Hedge_Duranta", "leaf3": "FMC_Plant_Grass_Paspalum", "leaf4": "FMC_Plastic_PPR_Green",
     "flower": "FMC_Fabric_Kitenge_Print", "mulch": "FMC_Plant_Mulch_Bark", "soil": "FMC_Earth_Topsoil",
     "timber": "FMC_Timber_Mvule", "pine": "FMC_Timber_Pine_CCATreated", "stone": "FMC_Stone_Dressed", "granite": "FMC_Stone_Granite_Black_Polished",
     "water": "FMC_Glass_Reflective_BlueGreen", "pebble": "FMC_Stone_Pebbles_River", "mesh": "FMC_Metal_BRCMesh_A142",
     "alu": "FMC_Metal_Aluminium_PowderCoated", "nylon": "FMC_Plastic_Nylon_CastorGrey"}

NEEDED = [
    {"name": "FMC_Paint_Enamel_SignalRed", "colour": "#C1121F", "why": "fire equipment (extinguishers, cabinets, hose reels, hydrants, valves, pumps, panels, call points) is signal-red (RAL 3000) painted steel or cast iron; the kit only has the red sprinkler-pipe paint, used as nearest"},
    {"name": "FMC_Metal_Gunmetal_LG2", "colour": "#A88B5A", "why": "landing valves, breeching inlets and instantaneous couplings are gunmetal/bronze castings; FMC_Metal_Brass_Polished used as nearest"},
    {"name": "FMC_Plant_Bark_Trunk", "colour": "#5E4A3A", "why": "tree and palm trunks; FMC_Timber_Mugavu used as nearest"},
    {"name": "FMC_Plant_Foliage_Canopy", "colour": "#3F6A2C", "why": "tree, palm and shrub foliage; the kit's grass and Duranta hedge materials used as nearest"},
    {"name": "FMC_Plant_Flowers_Orange", "colour": "#E0582A", "why": "flowering ornamental tree (Nandi flame / Spathodea type), shrubs and groundcover flowers; FMC_Fabric_Kitenge_Print used as nearest colour"},
    {"name": "FMC_Water_Still", "colour": "#4A86A8", "why": "water surface of the healing-garden feature; FMC_Glass_Reflective_BlueGreen used as nearest"},
    {"name": "FMC_Metal_ChainLink_Galvanised", "colour": "#A7ACAF", "why": "chain-link mesh panel of the boundary fence; FMC_Metal_BRCMesh_A142 used as nearest (dark, reads as see-through mesh)"},
]

def make(fam, desc, ifc, types, parts, values, about, category=None, template=None, tv=None, conns=None, clear=None, geometry=None):
    rec = RECS[fam]
    cat = category or rec['category']
    used = sorted({p['mat'] for p in parts if p.get('mat')})
    prod = {"family": fam, "category": cat,
            "template": template or ("Metric Mechanical Equipment.rft" if cat == "Mechanical Equipment" else "Metric Generic Model.rft"),
            "desc": desc, "ifc": ifc, "keynote": rec['kn'],
            "types": [t if isinstance(t, dict) else {"name": t} for t in types],
            "materials": {k: M[k] for k in used}, "reference": dict(rec['ref']), "parts": parts, "values": values,
            "about": about + (f" Geometry drawn for {geometry}; the other types share it (sizes in the values)." if geometry else "")}
    if tv: prod["type_values"] = tv
    if conns: prod["connectors"] = conns
    if clear: prod["clearances"] = clear
    n = count(parts); assert n <= 70, (fam, n)
    P.append(prod)
    return prod

# ================================================================== FIRE PROTECTION
# ---- Sidewall sprinkler (wall at y = 0, points toward -y; centre at z = 0)
make("FMC_FP_Sprinkler_Sidewall", "Horizontal sidewall sprinkler K80 (5.6K), 68 C 5 mm bulb, 1/2 in thread, brass, recessed chrome escutcheon",
     "IfcFireSuppressionTerminal", ["K80_Sidewall"], [
        TU("Escutcheon", 'y', [0, 0], [[11, 0], [34, 0], [34, -3], [14, -9], [11, -9]], "chrome"),
        TU("Body", 'y', [0, 0], [[0, 6], [11, 6], [11, -18], [0, -18]], "brass"),
        B("Wrench Boss", [-13, -24, -8, 13, -18, 8], "brass", 2),
        rep(B("Frame Arm", [-11, -52, -2.5, -8, -24, 2.5], "brass"), 2, [19, 0, 0]),
        B("Frame Head", [-11, -56, -2.5, 11, -52, 2.5], "brass"),
        TU("Bulb", 'y', [0, 0], [[0, -52], [2.5, -49], [2.5, -28], [0, -24]], "ledr", 'f'),
        F("Deflector Plate", [-24, -60, -10, 24, -56, 14], "brass", 3),
        B("Deflector Hood", [-26, -64, 14, 26, -50, 17], "brass", 3),
        rep(B("Deflector Tine", [-24, -60, -15, -19, -57, -10], "brass", 0, 'f'), 3, [21.5, 0, 0]),
     ], {"K-factor 5.6 (K80)": A("K80", "type name; standard-response sidewall"), "Deflector 52 mm wide with top hood": A(52),
         "68 C bulb, 5 mm": A("68C 5mm", "ordinary-hazard sidewall practice"), "Mounting 100-150 mm below ceiling": A(150, "BS EN 12845 / NFPA 13 sidewall practice")},
     "Sidewall sprinkler modelled as a generic product: chrome escutcheon at the wall, brass body and wrench boss, frame arms, red bulb, vertical deflector with top hood and tines.",
     tv={"Default Elevation": 2550}, conns=[pipe("Inlet", "Body", "back", "FireProtectWet", 15)])

# ---- Concealed sprinkler (ceiling at z = 0; cover plate just below)
make("FMC_FP_Sprinkler_Concealed", "Concealed pendent sprinkler K80 (5.6K), 68 C, push-on white cover plate 83 mm, threaded support cup",
     "IfcFireSuppressionTerminal", ["K80_Concealed"], [
        TU("Cover Plate", 'z', [0, 0], [[0, -6], [40, -6], [41.5, -4.5], [41.5, -3], [0, -3]], "epw"),
        RING("Retainer Flange", 'z', [0, 0], 30, 37, -3, 0, "epw", 'f'),
        TU("Support Cup", 'z', [0, 0], [[0, 0], [33, 0], [33, 46], [28, 50], [0, 50]], "brass"),
        rep(RING("Cup Thread Rib", 'z', [0, 0], 33, 34.5, 8, 12, "brass", 'f'), 3, [0, 0, 12]),
        B("Wrench Boss", [-15, -9, 50, 15, 9, 58], "brass", 2),
        TU("Body", 'z', [0, 0], [[0, 58], [12, 58], [12, 72], [0, 72]], "brass"),
        TU("Thread Inlet", 'z', [0, 0], [[0, 72], [10, 72], [10, 86], [0, 86]], "brass", 'f'),
        rep(B("Solder Tab", [-2, -43, -5, 2, -40, -3], "chrome", 0, 'f'), 2, [0, 83, 0]),
     ], {"K-factor 5.6 (K80)": A("K80", "type name"), "Cover plate 83 mm": A(83, "typical concealed cover plate"),
         "Plate release 57 C, bulb 68 C": A("57C/68C", "typical concealed pendent pairing"), "Cup depth 50 mm above ceiling": A(50)},
     "Concealed sprinkler modelled as a generic product: flat white cover plate with retainer flange flush to the ceiling (z = 0), threaded support cup, wrench boss, brass body and thread.",
     conns=[pipe("Inlet", "Thread Inlet", "top", "FireProtectWet", 15)])

# ---- Hose reel, swinging, in cabinet (wall; Medium shows the door shut, Fine shows it open with the reel)
hr = [
    F("Cabinet Back", [-380, -12, 0, 380, 0, 760], "red"),
    rep(B("Cabinet Side", [-380, -280, 0, -368, -12, 760], "red"), 2, [748, 0, 0]),
    B("Cabinet Top", [-368, -280, 748, 368, -12, 760], "red"),
    B("Cabinet Bottom", [-368, -280, 0, 368, -12, 12], "red"),
    F("Front Frame Top", [-380, -286, 700, 380, -280, 760], "red"),
    F("Front Frame Bottom", [-380, -286, 0, 380, -280, 40], "red"),
    rep(F("Front Frame Stile", [-380, -286, 40, -350, -280, 700], "red"), 2, [730, 0, 0]),
    F("Label FIRE HOSE REEL", [-170, -288, 712, 170, -286, 748], "white", 2, 'f'),
    F("Door Shut", [-372, -298, 40, 372, -286, 700], "red", 4, 'm'),
    F("Door Glass Shut", [-320, -300, 100, 320, -298, 640], "glass", 0, 'm'),
    B("Door Open", [-392, -1028, 40, -380, -286, 700], "red", 0, 'f'),
    B("Door Glass Open", [-394, -980, 100, -392, -334, 640], "glass", 0, 'f'),
    B("Door Handle", [-406, -1004, 330, -394, -988, 440], "black", 3, 'f'),
    rep(B("Hinge", [-388, -294, 80, -376, -282, 140], "chrome", 0, 'f'), 2, [0, 0, 480]),
    DISC("Reel Back Flange", 'y', [0, 390], 300, -20, -26, "red"),
    DISC("Reel Hub", 'y', [0, 390], 95, -26, -200, "red"),
    RING("Hose Coil Inner", 'y', [0, 390], 95, 165, -30, -196, "hose"),
    RING("Hose Coil Middle", 'y', [0, 390], 167, 225, -36, -190, "hose"),
    RING("Hose Coil Outer", 'y', [0, 390], 227, 270, -44, -182, "hose"),
    RING("Reel Front Rim", 'y', [0, 390], 268, 300, -200, -206, "red"),
    F("Reel Spoke Horizontal", [-290, -206, 383, 290, -200, 397], "red"),
    F("Reel Spoke Vertical", [-7, -206, 100, 7, -200, 680], "red"),
    DISC("Swivel Cap", 'y', [0, 390], 48, -206, -216, "chrome", 'f'),
    B("Swing Arm", [0, -20, 382, 330, -14, 398], "gi", 0, 'f'),
    CY("Swing Pivot", 'z', [330, -60], 14, [120, 730], "gi"),
    CY("Inlet Valve Body", 'z', [330, -60], 24, [60, 120], "brass"),
    CY("Inlet Valve Stem", 'y', [330, 90], 5, [-84, -130], "chrome", 'f'),
    RING("Inlet Handwheel", 'y', [330, 90], 26, 34, -130, -138, "red"),
    CY("Inlet Pipe", 'z', [330, -60], 14, [-60, 60], "gi"),
    B("Hose Guide", [-340, -250, 40, -250, -150, 72], "chrome", 6),
    B("Nozzle Clip", [-368, -215, 520, -345, -185, 560], "chrome", 0, 'f'),
    TU("Nozzle", 'z', [-326, -200], [[0, 300], [10, 300], [17, 350], [17, 480], [13, 520], [0, 520]], "black"),
    TU("Nozzle Tip", 'z', [-326, -200], [[0, 285], [7, 285], [10, 300], [0, 300]], "chrome", 'f'),
    CY("Hose Lead", 'z', [-300, -200], 12, [72, 300], "hose"),
]
make("FMC_FP_FireProt_HoseReel_Swinging", "Swinging fire hose reel, 30 m x 19 mm hose, in a red steel cabinet 760 x 760 x 280 with glazed door, swivel inlet with stop valve",
     "IfcFireSuppressionTerminal", ["30m_Swinging"], hr,
     {"Hose 30 m x 19 mm": A("30m 19mm", "type name; BS EN 671-1 hose reel"), "Cabinet 760 x 760 x 280 mm": A("760x760x280"),
      "Drum 600 mm diameter": A(600), "Cabinet bottom 900 mm above floor": A(900, "nozzle within reach, BS EN 671-3 practice")},
     "Hose reel modelled as a generic product: red steel cabinet with label fascia; Medium shows the glazed door shut, Fine shows it open on its hinges with the reel inside: drum flanges, three hose coils, spokes, swivel cap, swing arm and pivot, inlet stop valve with red handwheel, hose guide, nozzle in its clip.",
     category="Mechanical Equipment", tv={"Default Elevation": 900}, conns=[pipe("Water Inlet", "Inlet Pipe", "bottom", "FireProtectWet", 25)])

# ---- Landing valve 65 (oblique globe valve on a riser branch; inlet flange at z = 0)
lv = [
    DISC("Inlet Flange", 'z', [0, 0], 92, 0, 20, "brass"),
    rep(CY("Flange Bolt X", 'z', [-68, 0], 8, [20, 30], "steel", 'f'), 2, [136, 0, 0]),
    rep(CY("Flange Bolt Y", 'z', [0, -68], 8, [20, 30], "steel", 'f'), 2, [0, 136, 0]),
    TU("Valve Body", 'z', [0, 0], [[0, 20], [40, 20], [58, 50], [62, 90], [55, 130], [34, 150], [0, 150]], "brass"),
    TU("Bonnet", 'z', [0, 0], [[0, 150], [36, 150], [36, 172], [26, 184], [26, 215], [0, 215]], "brass"),
    B("Gland Nut", [-20, -20, 215, 20, 20, 232], "brass", 4),
    CY("Spindle", 'z', [0, 0], 8, [232, 268], "chrome"),
    RING("Handwheel Rim", 'z', [0, 0], 62, 72, 262, 274, "red"),
    B("Handwheel Spoke X", [-64, -5, 264, 64, 5, 272], "red"),
    B("Handwheel Spoke Y", [-5, -64, 264, 5, 64, 272], "red"),
    DISC("Handwheel Hub", 'z', [0, 0], 16, 260, 278, "red"),
    CY("Outlet Branch", 'y', [0, 95], 36, [-45, -120], "brass"),
    RING("Outlet Collar", 'y', [0, 95], 36, 46, -112, -126, "brass"),
    TU("Instantaneous Coupling", 'y', [0, 95], [[30, -126], [50, -126], [50, -170], [44, -176], [30, -176]], "chrome"),
    B("Coupling Release Lugs", [-60, -166, 90, 60, -152, 100], "chrome", 3, 'f'),
    DISC("Blank Cap", 'y', [0, 95], 47, -176, -190, "brass"),
    B("Cap Chain", [46, -184, 30, 50, -180, 92], "chrome", 0, 'f'),
    B("Strap Lock", [-8, -60, 175, 8, -36, 205], "yellow", 0, 'f'),
]
make("FMC_FP_FireProt_LandingValve_Riser", "Landing valve 65 mm, oblique globe pattern, gunmetal, flanged inlet, female instantaneous outlet with blank cap and chain, red handwheel, strap lock",
     "IfcValve", ["65_LandingValve"], lv,
     {"Outlet 65 mm (2.5 in) instantaneous": A(65, "type name; BS 5041-1"), "Inlet flange DN65, 185 mm": A(185, "EN 1092 PN16 flange"), "Height 280 mm to handwheel": A(280)},
     "Landing valve modelled as a generic product: flanged inlet with bolts, globe body and bonnet, gland nut, spindle and red handwheel, horizontal outlet with instantaneous coupling, release lugs, blank cap and chain, yellow strap lock. Outlet drawn horizontal (real valves angle it about 45 degrees down).",
     category="Pipe Accessories", conns=[pipe("Riser Inlet", "Inlet Flange", "bottom", "FireProtectWet", 65)])

# ---- External pillar hydrant, 2-way (ground at z = 0)
hy = [
    DISC("Base Flange", 'z', [0, 0], 170, 0, 35, "red"),
    rep(CY("Base Bolt X", 'z', [-135, 0], 12, [35, 50], "steel", 'f'), 2, [270, 0, 0]),
    rep(CY("Base Bolt Y", 'z', [0, -135], 12, [35, 50], "steel", 'f'), 2, [0, 270, 0]),
    TU("Barrel", 'z', [0, 0], [[0, 35], [100, 35], [100, 75], [86, 95], [86, 600], [0, 600]], "red"),
    TU("Head", 'z', [0, 0], [[0, 600], [86, 600], [104, 630], [104, 760], [92, 780], [0, 780]], "red"),
    TU("Bonnet Dome", 'z', [0, 0], [[0, 780], [82, 780], [72, 830], [42, 862], [0, 872]], "red"),
    B("Operating Nut", [-18, -18, 866, 18, 18, 902], "brass", 3),
    RING("Reflective Band", 'z', [0, 0], 86, 88.5, 440, 520, "white"),
    CY("Outlet Right", 'x', [0, 690], 44, [100, 165], "red"),
    CY("Outlet Left", 'x', [0, 690], 44, [-165, -100], "red"),
    TU("Coupling Right", 'x', [0, 690], [[32, 165], [52, 165], [52, 205], [32, 205]], "brass"),
    TU("Coupling Left", 'x', [0, 690], [[32, -205], [52, -205], [52, -165], [32, -165]], "brass"),
    DISC("Cap Right", 'x', [0, 690], 50, 205, 222, "brass"),
    DISC("Cap Left", 'x', [0, 690], 50, -222, -205, "brass"),
    B("Cap Chain Right", [212, -3, 560, 216, 3, 645], "chrome", 0, 'f'),
    B("Cap Chain Left", [-216, -3, 560, -212, 3, 645], "chrome", 0, 'f'),
    TU("Drain Boss", 'y', [0, 150], [[0, -84], [22, -84], [22, -104], [0, -104]], "red", 'f'),
    F("Identification Plate", [-40, -90, 300, 40, -86, 380], "white", 4, 'f'),
]
make("FMC_FP_FireProt_Hydrant_Pillar_External", "External pillar fire hydrant, 2-way 65 mm instantaneous outlets with caps and chains, DN100 flanged base, cast iron painted red, reflective band",
     "IfcFireSuppressionTerminal", ["2-way_Pillar"], hy,
     {"Two 65 mm outlets": A("2x65", "type name; BS 750 / BS 336 couplings"), "Height 900 mm above ground": A(900), "Inlet DN100 flange": A(100), "Barrel 172 mm diameter": A(172)},
     "Pillar hydrant modelled as a generic product: bolted base flange, barrel and head, domed bonnet with operating nut, two side outlets with couplings, caps and chains, reflective band, drain boss and identification plate.",
     category="Mechanical Equipment", conns=[pipe("Main", "Base Flange", "bottom", "FireProtectWet", 100)])

# ---- Breeching inlet (wall; collecting head with inlets)
bi = [
    F("Back Plate", [-290, -10, 0, 290, 0, 580], "red", 8),
    F("Label DRY RISER INLET", [-200, -14, 470, 200, -10, 545], "white", 4),
    rep(B("Head Bracket", [-190, -95, 200, -160, -10, 260], "steel"), 2, [350, 0, 0]),
    CY("Collecting Head", 'x', [-160, 230], 72, [-210, 210], "red"),
    CY("Riser Outlet", 'z', [0, -160], 55, [290, 470], "red"),
    CY("Riser Elbow", 'y', [0, 450], 55, [-215, -10], "red"),
    rep(CY("Inlet Neck", 'y', [-115, 205], 40, [-300, -215], "brass"), 2, [230, 0, 0]),
    rep(RING("Check Valve Boss", 'y', [-115, 205], 40, 54, -255, -280, "brass"), 2, [230, 0, 0]),
    rep(TU("Male Coupling", 'y', [-115, 205], [[30, -300], [46, -300], [46, -345], [30, -345]], "chrome"), 2, [230, 0, 0]),
    rep(DISC("Blank Cap", 'y', [-115, 205], 50, -345, -358, "brass"), 2, [230, 0, 0]),
    rep(B("Cap Chain", [-70, -352, 110, -66, -348, 200], "chrome", 0, 'f'), 2, [230, 0, 0]),
    CY("Drain Valve", 'z', [0, -160], 15, [118, 160], "brass"),
    RING("Drain Valve Wheel", 'z', [0, -160], 18, 26, 110, 117, "red", 'f'),
    rep(CY("Plate Fixing", 'y', [-260, 30], 6, [-14, -10], "chrome", 'f'), 2, [520, 0, 0]),
]
make("FMC_FP_FireProt_BreechingInlet", "Fire brigade breeching inlet (dry riser), 65 mm male instantaneous inlets with non-return valves, blank caps and chains, DN100 outlet, drain valve, red back plate with label",
     "IfcValve", ["2-way_Inlet", "4-way_Inlet"], bi,
     {"Inlets 65 mm male instantaneous": A(65, "BS 5041-3"), "Outlet DN100 (2-way), DN150 (4-way)": A("100/150", "BS 9990 dry riser practice"),
      "Back plate 580 x 580 mm": A("580x580"), "Inlet centre 600 to 750 mm above ground": A(600, "BS 9990 inlet height")},
     "Breeching inlet modelled as a generic product: red back plate with label, collecting head on brackets, riser outlet and elbow into the wall, inlet necks with check-valve bosses, male couplings, blank caps and chains, drain valve.",
     category="Pipe Accessories", tv={"Default Elevation": 450}, conns=[pipe("Riser", "Riser Elbow", "back", "FireProtectWet", 100, "Out")],
     geometry="2-way_Inlet")

# ---- Extinguishers (wall, on bracket; base at z = 0)
def extinguisher(fam, desc, types, R, H, band, kind, values, geometry):
    cy = -(30 + R)
    neck = H
    parts = [
        F("Wall Bracket Plate", [-35, -6, H * 0.55, 35, 0, neck + 40], "steel", 6),
        B("Bracket Hook", [-14, cy + 18, neck + 2, 14, -6, neck + 14], "steel"),
        RING("Base Foot", 'z', [0, cy], R - 14, R - 2, 0, 14, "black"),
        TU("Cylinder", 'z', [0, cy], [[0, 10], [R - 12, 10], [R, 24], [R, H - R * 0.75], [R * 0.75, H - R * 0.25], [24, H - 4], [0, H]], "red"),
        RING("Label Band", 'z', [0, cy], R, R + 1, H * 0.32, H * 0.58, band),
        F("Instruction Label", [-R * 0.55, cy - R - 2.5, H * 0.34, R * 0.55, cy - R * 0.85, H * 0.56], "white", 4, 'f'),
        DISC("Neck", 'z', [0, cy], 22, H - 4, H + 14, "brass"),
        B("Valve Body", [-18, cy - 18, H + 14, 18, cy + 18, H + 62], "chrome", 6),
        B("Carry Handle", [-13, cy - 5, H + 48, 13, cy + 95, H + 57], "black", 4),
        B("Squeeze Lever", [-13, cy - 5, H + 66, 13, cy + 100, H + 75], "red", 4),
        CY("Safety Pin", 'x', [cy - 8, H + 62], 3, [-24, 24], "chrome", 'f'),
        RING("Pin Ring", 'x', [cy - 8, H + 62], 7, 10, 24, 27, "chrome", 'f'),
        F("Tamper Tag", [26, cy - 12, H + 30, 46, cy - 10, H + 58], "yellow", 3, 'f'),
    ]
    hx = R + 34
    if kind == 'CO2':
        parts += [CY("Hose Elbow", 'x', [cy, H + 36], 8, [18, hx], "rubber"),
                  CY("Hose", 'z', [hx, cy], 8, [H * 0.62, H + 44], "rubber"),
                  TU("Discharge Horn", 'z', [hx, cy], [[10, H * 0.62], [15, H * 0.62], [40, H * 0.14], [34, H * 0.14]], "black"),
                  B("Horn Clip", [R - 6, cy - 8, H * 0.5, hx - 30, cy + 8, H * 0.56], "black", 0, 'f')]
    else:
        parts += [TU("Gauge Bezel", 'y', [0, H + 40], [[0, cy - 18], [15, cy - 18], [15, cy - 28], [0, cy - 28]], "chrome"),
                  DISC("Gauge Face", 'y', [0, H + 40], 12, cy - 28, cy - 29.5, "white", 'f'),
                  F("Gauge Needle", [-1, cy - 30.5, H + 40, 1, cy - 29.5, H + 50], "ledr", 0, 'f'),
                  CY("Hose Elbow", 'x', [cy, H + 30], 9, [18, R + 14], "rubber"),
                  CY("Hose", 'z', [R + 14, cy], 9, [H * 0.22, H + 39], "rubber"),
                  TU("Nozzle", 'z', [R + 14, cy], [[0, H * 0.08], [8, H * 0.08], [13, H * 0.14], [13, H * 0.22], [0, H * 0.22]], "black"),
                  B("Nozzle Clip", [R - 6, cy - 8, H * 0.15, R + 4, cy + 8, H * 0.2], "black", 0, 'f')]
    make(fam, desc, "IfcFireSuppressionTerminal", types, parts, values,
         f"{kind} extinguisher modelled as a generic product: red cylinder with foot ring, {band} identification band and instruction label, valve with carry handle, squeeze lever, safety pin and tamper tag, "
         + ("hose and discharge horn in its clip" if kind == 'CO2' else "pressure gauge, hose and nozzle in its clip") + ", wall bracket and hook.",
         category="Specialty Equipment", tv={"Default Elevation": 350}, geometry=geometry)
extinguisher("FMC_FP_FireProt_Extinguisher_CO2", "CO2 fire extinguisher 2 kg / 5 kg, red with black band, squeeze-grip valve, hose and horn (5 kg), wall bracket",
             ["2kg_CO2", "5kg_CO2"], 70, 620, "black", "CO2",
             {"5 kg: 140 mm diameter, 680 mm overall": A("140x680", "BS EN 3 typical 5 kg CO2"), "2 kg: 110 mm diameter, 540 mm overall": A("110x540", "BS EN 3 typical 2 kg CO2"),
              "Ratings 34B (2 kg), 70B to 89B (5 kg)": A("34B/89B", "BS EN 3-7 typical"), "Handle at or below 1100 mm": A(1100, "BS 5306-8 siting")}, "5kg_CO2")
extinguisher("FMC_FP_FireProt_Extinguisher_Powder", "ABC dry powder fire extinguisher 6 kg / 9 kg, red with blue band, stored pressure with gauge, hose and nozzle, wall bracket",
             ["6kg_Powder", "9kg_Powder"], 80, 470, "blue", "Powder",
             {"6 kg: 160 mm diameter, 540 mm overall": A("160x540", "BS EN 3 typical 6 kg powder"), "9 kg: 180 mm diameter, 600 mm overall": A("180x600", "BS EN 3 typical 9 kg powder"),
              "Rating 27A 144B C (6 kg)": A("27A 144B C", "BS EN 3-7 typical"), "Handle at or below 1100 mm": A(1100, "BS 5306-8 siting")}, "6kg_Powder")

# ---- Extinguisher cabinet (floor; GRP, domed top)
cab = [
    B("Plinth", [-200, -160, 0, 200, 160, 60], "black", 10),
    B("Cabinet Body", [-190, -150, 60, 190, 150, 800], "red", 20),
    RT("Domed Top", arch(-150, 150, 800, 90), [-190, 190], "red"),
    F("Door", [-172, -160, 90, 172, -150, 780], "red", 14),
    F("Window", [-120, -162, 330, 120, -160, 640], "pc", 10),
    F("Window Frame", [-128, -161, 322, 128, -160, 648], "black", 12, 'f'),
    F("Label FIRE EXTINGUISHER", [-132, -162, 680, 132, -160, 750], "white", 4),
    F("Handle", [128, -176, 200, 150, -162, 300], "black", 6),
    CY("Latch", 'y', [139, 330], 8, [-162, -170], "chrome", 'f'),
    rep(F("Hinge", [-184, -165, 150, -170, -150, 210], "chrome", 2, 'f'), 2, [0, 0, 500]),
    rep(B("Ventilation Slot", [-80, -162, 120, 80, -160, 128], "black", 0, 'f'), 3, [0, 0, 20]),
]
make("FMC_FP_FireProt_Extinguisher_Cabinet", "Floor-standing GRP extinguisher cabinet, red, domed top, door with viewing window and label; single (1 x 9 kg) or double",
     "IfcFurniture", ["1Ext_Single", "2Ext_Double"], cab,
     {"Single: 400 x 320 x 890 mm": A("400x320x890", "typical GRP single cabinet"), "Double: 720 x 320 x 890 mm": A("720x320x890", "typical GRP double cabinet"), "Takes 9 kg / 9 l extinguisher": A("9kg")},
     "Extinguisher cabinet modelled as a generic product: black plinth, red GRP body with domed top, door with framed viewing window, label, handle and latch, hinges, vent slots.",
     category="Specialty Equipment", geometry="1Ext_Single")

# ---- Fire blanket (wall)
make("FMC_FP_FireProt_FireBlanket", "Fire blanket 1.2 x 1.2 m in a rigid red wall container with quick-release pull tapes",
     "IfcFireSuppressionTerminal", ["1200x1200_Blanket"], [
        F("Container", [-140, -60, 0, 140, 0, 300], "red", 18),
        F("Lid Flap", [-145, -68, 225, 145, -56, 305], "red", 18),
        F("Label Panel", [-110, -62, 40, 110, -60, 205], "white", 6),
        F("Flame Symbol", [-30, -63, 125, 30, -62, 190], "red", 4, 'f'),
        rep(F("Label Text Line", [-80, -63, 60, 80, -62, 68], "black", 0, 'f'), 3, [0, 0, 18]),
        rep(F("Pull Tape", [-78, -44, -28, -64, -40, 4], "black"), 2, [142, 0, 0]),
        rep(F("Pull Tab", [-88, -48, -58, -54, -36, -28], "black", 6), 2, [142, 0, 0]),
        rep(CY("Fixing Screw", 'y', [-120, 270], 4, [-62, -58], "chrome", 'f'), 2, [240, 0, 0]),
     ], {"Blanket 1200 x 1200 mm": A("1200x1200", "type name; BS EN 1869"), "Container 280 x 300 x 60 mm": A("280x300x60"), "Top at 1500 mm": A(1500, "kitchen siting practice")},
     "Fire blanket modelled as a generic product: red container with lid flap, white label panel with flame symbol and text lines, two black pull tapes and tabs, fixing screws.",
     category="Specialty Equipment", tv={"Default Elevation": 1200})

# ---- Alarm check valve set (vertical on the riser; bottom flange at z = 0)
acv = [
    TU("Butterfly Valve", 'z', [0, 0], [[0, 0], [100, 0], [100, 55], [0, 55]], "red"),
    B("Gear Operator", [100, -50, 0, 190, 50, 60], "red", 6),
    B("Supervisory Switch", [120, -72, 60, 170, -30, 96], "grey", 4, 'f'),
    RING("Gear Handwheel", 'x', [0, 30], 68, 78, 205, 215, "red"),
    B("Handwheel Spoke", [205, -70, 26, 215, 70, 34], "red"),
    CY("Handwheel Shaft", 'x', [0, 30], 8, [190, 205], "chrome", 'f'),
    DISC("Lower Flange", 'z', [0, 0], 115, 55, 75, "red"),
    TU("Alarm Valve Body", 'z', [0, 0], [[0, 75], [85, 75], [110, 130], [115, 250], [100, 320], [80, 340], [0, 340]], "red"),
    DISC("Hand Hole Cover", 'y', [0, 215], 66, -100, -122, "red"),
    rep(CY("Cover Bolt", 'y', [-48, 215], 6, [-122, -130], "steel", 'f'), 2, [96, 0, 0]),
    DISC("Upper Flange", 'z', [0, 0], 115, 340, 360, "red"),
    CY("Riser Stub", 'z', [0, 0], 57, [360, 620], "red"),
    CY("Trim Riser", 'z', [180, -70], 13, [140, 520], "gi"),
    CY("Trim Branch Lower", 'x', [-70, 150], 13, [95, 193], "gi"),
    CY("Trim Branch Upper", 'x', [-70, 500], 13, [55, 193], "gi"),
    TU("Retard Chamber", 'z', [270, -70], [[0, 220], [52, 220], [52, 430], [30, 460], [0, 460]], "red"),
    CY("Retard Link", 'x', [-70, 300], 10, [193, 225], "gi", 'f'),
    B("Alarm Pressure Switch", [240, -160, 470, 300, -112, 535], "grey", 6),
    CY("Switch Tee", 'z', [270, -70], 10, [460, 500], "gi", 'f'),
    CY("Gauge Branch Lower", 'x', [0, 170], 10, [-170, -105], "gi"),
    CY("Gauge Branch Upper", 'x', [0, 470], 10, [-170, -55], "gi"),
    rep(CY("Gauge Stem", 'y', [-170, 170], 6, [0, -45], "brass"), 2, [0, 0, 300]),
    rep(TU("Pressure Gauge", 'y', [-170, 170], [[0, -45], [42, -45], [42, -66], [0, -66]], "chrome"), 2, [0, 0, 300]),
    rep(DISC("Gauge Dial", 'y', [-170, 170], 36, -66, -68, "white", 'f'), 2, [0, 0, 300]),
    CY("Drain Valve", 'y', [70, 110], 18, [-80, -130], "brass"),
    B("Drain Lever", [70, -128, 104, 170, -116, 116], "yellow", 0, 'f'),
    F("Valve Plate", [-50, -118, 260, 50, -113, 300], "white", 3, 'f'),
]
make("FMC_FP_FireProt_Valve_AlarmCheck", "Wet alarm check valve set DN100 / DN150: supervised butterfly main stop, alarm valve with hand-hole cover, trim, retard chamber, pressure switch, two gauges, drain",
     "IfcValve", ["100_AlarmCheck", "150_AlarmCheck"], acv,
     {"DN100: set height about 620 mm": A(620, "typical wet alarm valve set"), "Gauges 0-16 bar, 100 mm dial": A("100mm"), "Main stop supervised by switch": A("supervised", "BS EN 12845 installation control valve set")},
     "Alarm check valve set modelled as a generic product: butterfly main stop with gear operator, handwheel and supervisory switch, flanged alarm valve body with hand-hole cover, riser stub, trim pipework, retard chamber, alarm pressure switch, two pressure gauges, drain valve and lever, valve plate.",
     category="Pipe Accessories", conns=[pipe("Supply", "Butterfly Valve", "bottom", "FireProtectWet", 100), pipe("Installation", "Riser Stub", "top", "FireProtectWet", 100, "Out")],
     geometry="100_AlarmCheck")

# ---- Zone valve with flow switch (horizontal pipe along x; pipe centre at z = 0)
zv = [
    DISC("Inlet Flange", 'x', [0, 0], 92, -400, -385, "red"),
    CY("Inlet Spool", 'x', [0, 0], 38, [-385, -315], "red"),
    RING("Valve Flange In", 'x', [0, 0], 38, 92, -315, -300, "red"),
    TU("Butterfly Valve", 'x', [0, 0], [[0, -300], [85, -300], [85, -250], [0, -250]], "red"),
    RING("Valve Flange Out", 'x', [0, 0], 38, 92, -250, -235, "red"),
    B("Gear Operator", [-300, -45, 85, -250, 45, 170], "red", 6),
    CY("Handwheel Shaft", 'z', [-275, 0], 7, [170, 200], "chrome", 'f'),
    RING("Handwheel", 'z', [-275, 0], 58, 66, 200, 210, "red"),
    B("Handwheel Spoke", [-339, -5, 201, -211, 5, 209], "red"),
    B("Position Indicator", [-290, -12, 210, -260, 12, 228], "yellow", 0, 'f'),
    B("Tamper Switch", [-245, -42, 92, -205, 2, 150], "grey", 4),
    CY("Main Pipe", 'x', [0, 0], 38, [-235, 385], "red"),
    DISC("Outlet Flange", 'x', [0, 0], 92, 385, 400, "red"),
    B("Flow Switch Saddle", [-30, -44, 28, 30, 44, 46], "red", 6),
    B("Flow Switch Housing", [-52, -60, 46, 52, 60, 148], "red", 10),
    B("Flow Switch Cover", [-48, -56, 148, 48, 56, 160], "white", 10),
    CY("Conduit Gland", 'y', [0, 110], 10, [-60, -88], "grey"),
    F("Flow Switch Label", [-35, -62, 70, 35, -60, 120], "white", 3, 'f'),
    CY("Test Drain Branch", 'z', [180, 0], 13, [-150, -34], "brass"),
    B("Test Drain Valve", [158, -24, -170, 202, 24, -125], "brass", 6),
    B("Test Drain Lever", [202, -6, -156, 292, 6, -144], "red", 0, 'f'),
    TU("Sight Glass", 'z', [180, 0], [[0, -230], [22, -230], [22, -170], [0, -170]], "pc"),
    CY("Drain Outlet", 'z', [180, 0], 13, [-320, -230], "gi"),
    CY("Gauge Stem", 'z', [230, 0], 6, [36, 110], "brass"),
    TU("Pressure Gauge", 'y', [230, 140], [[0, 10], [40, 10], [40, -12], [0, -12]], "chrome"),
    DISC("Gauge Dial", 'y', [230, 140], 34, -12, -14, "white", 'f'),
]
make("FMC_FP_FireProt_Valve_ZoneFlowSwitch", "Sprinkler zone control valve set DN65 / DN100: supervised butterfly valve with gear operator, vane flow switch, test and drain valve with sight glass, pressure gauge",
     "IfcValve", ["65_ZoneFlow", "100_ZoneFlow"], zv,
     {"DN65 set length 800 mm": A(800, "typical zone control assembly"), "Flow switch: vane type, 24 V dc": A("24V dc", "BS EN 12259-5"), "Test orifice equal to one sprinkler (K80)": A("K80", "BS EN 12845 zone test")},
     "Zone valve set modelled as a generic product: flanged inlet and outlet, butterfly valve with gear operator, handwheel, position indicator and tamper switch, vane flow switch with saddle, housing, cover and conduit gland, test and drain valve with lever and sight glass, gauge.",
     category="Pipe Accessories", conns=[pipe("Inlet", "Inlet Flange", "left", "FireProtectWet", 65), pipe("Outlet", "Outlet Flange", "right", "FireProtectWet", 65, "Out"),
                                          elec("Flow Switch", "Flow Switch Housing", "top", "FireAlarm")],
     geometry="65_ZoneFlow")

# ---- Fire pump set: electric + diesel + jockey on one skid (floor)
fps = [
    B("Base Frame", [-2400, -1100, 0, 2400, 1600, 200], "steel"),
    # electric main pump, shaft along y, motor at the back
    TU("Electric Motor", 'y', [-1600, 600], [[0, 30], [270, 30], [280, 80], [280, 900], [0, 900]], "red"),
    rep(RING("Motor Fin", 'y', [-1600, 600], 280, 292, 200, 220, "red", 'f'), 4, [0, 170, 0]),
    TU("Fan Cowl", 'y', [-1600, 600], [[0, 900], [255, 900], [240, 1060], [0, 1060]], "red"),
    B("Motor Terminal Box", [-1720, 300, 870, -1480, 520, 1000], "red", 10),
    B("Motor Feet", [-1850, 150, 200, -1350, 850, 330], "red"),
    B("Coupling Guard Electric", [-1760, -170, 450, -1440, 30, 760], "yellow", 30),
    TU("Electric Pump Volute", 'y', [-1600, 600], [[0, -170], [300, -170], [320, -260], [300, -400], [0, -400]], "red"),
    B("Electric Pump Foot", [-1800, -420, 200, -1400, -150, 330], "red"),
    CY("Electric Suction", 'y', [-1600, 600], 100, [-400, -880], "red"),
    # diesel main pump
    B("Diesel Engine Block", [-260, 80, 250, 460, 1150, 1000], "red", 30),
    B("Cylinder Head", [-200, 150, 1000, 400, 1080, 1120], "steel", 20),
    B("Rocker Cover", [-150, 200, 1120, 350, 1030, 1180], "red", 20),
    B("Radiator", [-320, 1150, 250, 520, 1300, 1400], "steel", 10),
    B("Radiator Grille", [-280, 1300, 300, 480, 1310, 1350], "black", 0, 'f'),
    CY("Air Filter", 'x', [700, 1250], 120, [460, 780], "black"),
    CY("Exhaust Riser", 'z', [300, 600], 60, [1120, 1800], "gi"),
    CY("Exhaust Silencer", 'y', [300, 1900], 130, [250, 1150], "gi"),
    B("Coupling Guard Diesel", [-60, -170, 450, 260, 80, 760], "yellow", 30),
    TU("Diesel Pump Volute", 'y', [100, 600], [[0, -170], [300, -170], [320, -260], [300, -400], [0, -400]], "red"),
    B("Diesel Pump Foot", [-100, -420, 200, 300, -150, 330], "red"),
    CY("Diesel Suction", 'y', [100, 600], 100, [-400, -880], "red"),
    rep(B("Battery", [560, 150, 200, 740, 420, 450], "black", 6), 2, [0, 330, 0]),
    B("Fuel Day Tank", [820, 700, 1250, 1320, 1500, 1750], "red", 20),
    rep(B("Tank Leg Front", [830, 710, 200, 880, 760, 1250], "steel"), 2, [440, 0, 0]),
    rep(B("Tank Leg Back", [830, 1440, 200, 880, 1490, 1250], "steel"), 2, [440, 0, 0]),
    CY("Fuel Line", 'x', [800, 950], 10, [460, 820], "black", 'f'),
    # jockey pump (vertical multistage)
    B("Jockey Base", [1550, -150, 200, 1850, 150, 260], "steel"),
    CY("Jockey Stack", 'z', [1700, 0], 80, [260, 800], "ss"),
    CY("Jockey Motor", 'z', [1700, 0], 115, [800, 1180], "red"),
    TU("Jockey Fan Cap", 'z', [1700, 0], [[0, 1180], [110, 1180], [90, 1230], [0, 1240]], "red"),
    CY("Jockey Suction", 'y', [1700, 330], 32, [-80, -880], "red"),
    CY("Jockey Discharge", 'z', [1700, -180], 32, [700, 1600], "red"),
    CY("Jockey Discharge Link", 'y', [1700, 700], 32, [-180, -60], "red"),
    # headers and valves
    CY("Suction Header", 'x', [-950, 450], 150, [-2350, 2350], "red"),
    CY("Electric Discharge", 'z', [-1600, -180], 90, [900, 1500], "red"),
    CY("Diesel Discharge", 'z', [100, -180], 90, [900, 1500], "red"),
    rep(TU("Check Valve", 'z', [-1600, -180], [[0, 1000], [125, 1000], [125, 1090], [0, 1090]], "red"), 2, [1700, 0, 0]),
    rep(TU("Discharge Valve", 'z', [-1600, -180], [[0, 1200], [130, 1200], [130, 1250], [0, 1250]], "red"), 2, [1700, 0, 0]),
    rep(RING("Valve Handwheel", 'y', [-1600, 1225], 70, 80, -320, -330, "red"), 2, [1700, 0, 0]),
    CY("Discharge Header", 'x', [-180, 1600], 125, [-2000, 2350], "red"),
    # controllers
    B("Electric Controller", [-2300, 1250, 200, -1500, 1580, 2000], "red", 6),
    B("Diesel Controller", [-1300, 1250, 200, -600, 1580, 2000], "red", 6),
    B("Jockey Controller", [1600, 1320, 950, 2100, 1550, 1550], "red", 6),
    B("Jockey Controller Stand", [1820, 1400, 200, 1880, 1460, 950], "steel"),
    rep(B("Controller Handle", [-1560, 1236, 1000, -1540, 1250, 1200], "black", 0, 'f'), 2, [1000, 0, 0]),
    rep(F("Controller Display", [-2150, 1246, 1500, -1850, 1250, 1700], "lcd", 4, 'f'), 2, [1000, 0, 0]),
    rep(CY("Controller Lamp", 'y', [-2150, 1350], 12, [1240, 1250], "ledg", 'f'), 4, [100, 0, 0]),
    rep(CY("Controller Alarm Lamp", 'y', [-1150, 1350], 12, [1240, 1250], "ledr", 'f'), 4, [100, 0, 0]),
    F("Controller Labels", [1700, 1314, 1450, 2000, 1320, 1520], "white", 3, 'f'),
]
make("FMC_FP_MechEq_FirePump_Set", "Packaged sprinkler fire pump set on one skid: electric main pump, diesel standby pump with radiator, exhaust and day tank, jockey pump, suction and discharge headers, three controllers",
     "IfcPump", ["3Pump_ElecDieselJockey"], fps,
     {"Skid 4800 x 2700 mm, 2000 mm high (controllers)": A("4800x2700x2000", "typical packaged set, duty to be sized by the fire engineer"),
      "Electric motor 415 V 3-phase, 55 kW (allowance)": A("55kW", "allowance for a hospital ordinary-hazard set; engineer confirms"),
      "Suction header DN300, discharge DN250": A("DN300/DN250"), "To BS EN 12845 / LPC rules": A("BS EN 12845")},
     "Fire pump set modelled as a generic product: base frame; electric pump with finned motor, fan cowl, terminal box, coupling guard and volute; diesel pump with engine block, head, rocker cover, radiator and grille, air filter, exhaust and silencer, batteries, day tank on legs; vertical multistage jockey pump; suction and discharge headers with check valves, valves and handwheels; three controllers with displays and lamps.",
     tv={"Voltage": 415, "Number of Poles": 3, "Apparent Load": 68000},
     conns=[pipe("Suction", "Suction Header", "left", "FireProtectWet", 300), pipe("Discharge", "Discharge Header", "right", "FireProtectWet", 250, "Out"),
            elec("Power", "Electric Controller", "top")])

# ---- Fire water tank (sectional pressed steel on plinth walls)
tk = [
    rep(B("Plinth Wall", [-3110, -3150, 0, -2990, 3150, 600], "concg"), 6, [1220, 0, 0]),
    B("Tank Shell", [-3050, -3050, 600, 3050, 3050, 3650], "galv"),
    B("Base Flange", [-3080, -3080, 600, 3080, 3080, 640], "galv"),
    B("Top Flange", [-3080, -3080, 3610, 3080, 3080, 3650], "galv"),
    rep(B("Panel Flange X", [-1855, -3080, 640, -1805, 3080, 3610], "galv"), 4, [1220, 0, 0]),
    rep(B("Panel Flange Y", [-3080, -1855, 640, 3080, -1805, 3610], "galv"), 4, [0, 1220, 0]),
    rep(B("Panel Flange Z", [-3080, -3080, 1795, 3080, 3080, 1845], "galv"), 2, [0, 0, 1220]),
    B("Roof", [-3050, -3050, 3650, 3050, 3050, 3670], "galv"),
    B("Manhole Frame", [1800, 1800, 3670, 2500, 2500, 3720], "galv"),
    B("Manhole Lid", [1780, 1780, 3720, 2520, 2520, 3735], "galv", 0, 'f'),
    TU("Vent Cowl", 'z', [-2000, 2000], [[0, 3670], [60, 3670], [60, 3950], [150, 3950], [150, 3990], [0, 4050]], "gi"),
    rep(B("Ladder Stringer", [2300, -3135, 0, 2340, -3095, 3950], "galv"), 2, [400, 0, 0]),
    rep(CY("Ladder Rung", 'x', [-3115, 300], 12, [2340, 2700], "galv"), 12, [0, 0, 300]),
    rep(B("Roof Handrail Post", [2300, -3050, 3670, 2340, -3010, 4700], "galv"), 2, [400, 0, 0]),
    B("Roof Handrail", [2300, -3050, 4660, 2740, -3010, 4700], "galv"),
    CY("Level Gauge Tube", 'z', [-2500, -3120], 20, [700, 3600], "pc"),
    F("Level Gauge Board", [-2600, -3105, 700, -2400, -3080, 3600], "white", 0, 'f'),
    CY("Pump Suction Outlet", 'x', [-1200, 800], 110, [3050, 3600], "red"),
    DISC("Suction Flange", 'x', [-1200, 800], 180, 3600, 3625, "red"),
    CY("Fill Inlet", 'x', [1200, 3300], 50, [3050, 3500], "gi"),
    CY("Overflow", 'x', [0, 3420], 65, [3050, 3420], "gi"),
    CY("Overflow Downpipe", 'z', [3420, 0], 65, [700, 3420], "gi"),
    CY("Drain", 'y', [2000, 720], 40, [-3050, -3300], "gi"),
    TU("Drain Valve", 'y', [2000, 720], [[0, -3300], [60, -3300], [60, -3360], [0, -3360]], "red"),
    F("Tank Label", [-1400, -3060, 2600, 1400, -3052, 3000], "white", 0, 'f'),
]
make("FMC_FP_PlumbingEq_FireTank", "Sectional pressed-steel fire water tank, galvanised 1220 mm panels with external flanges, on concrete plinth walls; ladder, handrail, manhole, vent, level gauge, suction outlet, fill, overflow, drain",
     "IfcTank", ["100m3_Sectional", "200m3_Sectional"], tk,
     {"100 m3: 6.1 x 6.1 x 3.05 m (5 x 5 x 2.5 panels)": A("6100x6100x3050", "1220 mm sectional panels; effective capacity below overflow"),
      "200 m3: 8.5 x 8.5 x 3.05 m": A("8540x8540x3050", "1220 mm sectional panels"), "Plinth walls 600 mm at panel centres": A(600, "sectional tank supplier practice"),
      "Effective capacity to BS EN 12845": A("BS EN 12845", "fire engineer sizes the store")},
     "Fire tank modelled as a generic product: plinth walls under each panel line, galvanised shell with external base, top and panel flanges, roof with manhole and vent cowl, ladder with rungs and roof handrail, level gauge, pump suction outlet with flange, fill inlet, overflow and downpipe, drain and valve, label.",
     tv={}, conns=[pipe("Pump Suction", "Suction Flange", "right", "FireProtectWet", 200, "Out")], geometry="100m3_Sectional")


# ---- Addressable fire alarm panel (wall)
fap = [
    B("Back Box", [-225, -120, 0, 225, 0, 420], "red", 6),
    F("Door", [-220, -132, 6, 220, -120, 414], "red", 6),
    F("Display Bezel", [-130, -134, 290, 130, -132, 372], "black", 4),
    F("LCD", [-112, -135, 302, 112, -134, 360], "lcd", 2, 'f'),
    rep(CY("Fire Zone LED", 'y', [-180, 260], 4, [-136, -132], "ledr", 'f'), 8, [26, 0, 0]),
    rep(CY("Fault LED", 'y', [-180, 238], 4, [-136, -132], "yellow", 'f'), 8, [26, 0, 0]),
    CY("Power LED", 'y', [180, 260], 4, [-136, -132], "ledg", 'f'),
    F("Keypad", [40, -134, 90, 180, -132, 212], "grey", 4),
    rep(F("Key Row 1", [50, -136, 180, 75, -134, 200], "white", 2, 'f'), 4, [32, 0, 0]),
    rep(F("Key Row 2", [50, -136, 145, 75, -134, 165], "white", 2, 'f'), 4, [32, 0, 0]),
    rep(F("Key Row 3", [50, -136, 110, 75, -134, 130], "white", 2, 'f'), 4, [32, 0, 0]),
    rep(F("Control Button", [-190, -136, 110, -150, -134, 140], "grey", 3, 'f'), 3, [60, 0, 0]),
    F("Evacuate Button", [-190, -136, 160, -150, -134, 190], "ledr", 3, 'f'),
    CY("Key Switch", 'y', [-170, 60], 10, [-136, -132], "chrome", 'f'),
    F("Label Strip", [-150, -134, 385, 150, -133, 405], "white", 2, 'f'),
    CY("Door Lock", 'y', [195, 210], 8, [-136, -132], "chrome", 'f'),
    rep(CY("Cable Knockout", 'z', [-150, -60], 12, [420, 425], "grey", 'f'), 5, [75, 0, 0]),
]
make("FMC_FP_FireAlarm_Panel_Addressable", "Addressable fire alarm control panel, 2-loop / 4-loop, surface red steel enclosure 450 x 420 x 135, LCD, zone LEDs, keypad, controls, key switch",
     "IfcAlarm", ["2-loop_Addressable", "4-loop_Addressable"], fap,
     {"Enclosure 450 x 420 x 135 mm": A("450x420x135", "typical 2-4 loop panel"), "Mains 230 V, standby batteries 24 h + 30 min alarm": A("24h", "BS 5839-1 / BS EN 54-4"),
      "Loop capacity 2 or 4 loops of 126 to 250 devices": A("2/4 loops", "type name"), "Top at 1600 mm": A(1600, "access level practice")},
     "Fire alarm panel modelled as a generic product: red back box and door, LCD with bezel, rows of fire and fault LEDs, power LED, keypad with keys, silence/reset/evacuate buttons, key switch, label, door lock, cable knockouts.",
     category="Fire Alarm Devices", tv={"Voltage": 240, "Apparent Load": 150, "Default Elevation": 1180},
     conns=[elec("Mains", "Back Box", "top"), elec("Loop", "Back Box", "top", "FireAlarm")])

# ---- Detectors (ceiling at z = 0)
def detector(fam, desc, types, multi, values, about):
    parts = [TU("Base", 'z', [0, 0], [[0, -12], [51, -12], [51, 0], [0, 0]], "white")]
    if multi:
        parts += [TU("Head", 'z', [0, 0], [[0, -46], [38, -46], [46, -42], [50, -34], [50, -12], [0, -12]], "white"),
                  RING("Smoke Inlet Band", 'z', [0, 0], 47, 50.5, -32, -20, "grey", 'f'),
                  rep(B("Inlet Bar", [-51, -2, -32, -46, 2, -20], "white", 0, 'f'), 2, [97, 0, 0])]
        top = -46
    else:
        parts += [TU("Head", 'z', [0, 0], [[0, -36], [38, -36], [46, -32], [50, -24], [50, -12], [0, -12]], "white"),
                  rep(B("Vent Rib X", [-50, -2, -30, -44, 2, -16], "white", 0, 'f'), 2, [94, 0, 0]),
                  rep(B("Vent Rib Y", [-2, -50, -30, 2, -44, -16], "white", 0, 'f'), 2, [0, 94, 0])]
        top = -36
    parts += [rep(CY("Thermistor Guard Post X", 'z', [-13, 0], 2.5, [top - 14, top], "white"), 2, [26, 0, 0]),
              rep(CY("Thermistor Guard Post Y", 'z', [0, -13], 2.5, [top - 14, top], "white"), 2, [0, 26, 0]),
              RING("Thermistor Guard Ring", 'z', [0, 0], 10, 15.5, top - 17, top - 14, "white"),
              DISC("Thermistor", 'z', [0, 0], 3, top - 12, top, "black", 'f'),
              CY("LED", 'z', [0, -32], 4, [top - 1.5, top], "ledr", 'f')]
    if multi: parts.append(CY("LED Opposite", 'z', [0, 32], 4, [top - 1.5, top], "ledr", 'f'))
    make(fam, desc, "IfcSensor", types, parts, values, about, tv={}, conns=[elec("Fire Alarm", "Base", "top", "FireAlarm")])

detector("FMC_FP_FireAlarm_Detector_Heat", "Addressable heat detector with mounting base, class A1R rate-of-rise or CS fixed temperature, 100 mm diameter, 50 mm high",
         ["A1R_Heat", "CS_Heat"], False,
         {"Diameter 100 mm": A(100, "same base as the pack's smoke detector"), "Height 53 mm with base": A(53), "Class A1R / CS to BS EN 54-5": A("A1R/CS", "type names"),
          "Coverage radius 5300 mm": A(5300, "BS 5839-1 point heat detector, flat ceiling")},
         "Heat detector modelled as a generic product: base, low-profile head with vent ribs, exposed thermistor in a guard of four posts and a ring, LED; hangs below the ceiling (z = 0).")
P[-1]["clearances"] = [{"n": "Coverage", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, -60], [5300, -60], [5300, -55], [0, -55]], "sub": "Coverage"}]
detector("FMC_FP_FireAlarm_Detector_Multi", "Addressable multi-sensor detector (optical smoke + heat) with mounting base, 100 mm diameter, 62 mm high",
         ["optical-heat_Multi"], True,
         {"Diameter 100 mm": A(100), "Height 63 mm with base": A(63), "Optical + heat, BS EN 54-7 and 54-5": A("EN 54-7/-5"),
          "Coverage radius 7500 mm (smoke mode)": A(7500, "BS 5839-1 point smoke detector, flat ceiling")},
         "Multi-sensor modelled as a generic product: base, domed head with smoke-inlet band and bars, thermistor in a guard at the centre, twin LEDs; hangs below the ceiling (z = 0).")
P[-1]["clearances"] = [{"n": "Coverage", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, -70], [7500, -70], [7500, -65], [0, -65]], "sub": "Coverage"}]

# ---- Manual call point (wall, centre at z = 0)
make("FMC_FP_FireAlarm_CallPoint_Manual", "Addressable manual call point, surface, red 87 x 87 x 58 mm, resettable element, test key, LED",
     "IfcAlarm", ["87x87_Surface"], [
        B("Back Box", [-44, -30, -44, 44, 0, 44], "red", 6),
        F("Front Housing", [-44, -56, -44, 44, -30, 44], "red", 8),
        F("Element Window", [-29, -57, -27, 29, -56, 31], "white", 3),
        F("Push Area", [-15, -58, -10, 15, -57, 20], "white", 2),
        F("Push Here Text", [-20, -58.5, -21, 20, -57.5, -16], "black", 0, 'f'),
        FR("House Symbol", [[-9, -4], [9, -4], [9, 7], [0, 15], [-9, 7]], [-58.5, -57.5], "black", 'f'),
        F("Test Key Slot", [-8, -57, -40, 8, -56, -34], "black", 1, 'f'),
        CY("LED", 'y', [32, 36], 2.5, [-57, -56], "ledr", 'f'),
        rep(CY("Cover Screw", 'y', [-36, -38], 2.5, [-57, -56], "chrome", 'f'), 2, [72, 0, 0]),
        CY("Cable Entry", 'z', [0, -15], 6, [44, 48], "red", 'f'),
     ], {"Housing 87 x 87 x 58 mm": A("87x87x58", "BS EN 54-11 type A typical"), "Height 1400 mm": A(1400, "BS 5839-1 call point height"),
         "Resettable element, type A": A("type A")},
     "Call point modelled as a generic product: red back box and front housing, white resettable element with push area, house symbol and PUSH HERE text, test key slot, LED, cover screws, cable entry. The optional hinged clear cover is left off so the element reads.",
     category="Fire Alarm Devices", tv={"Default Elevation": 1400}, conns=[elec("Loop", "Back Box", "back", "FireAlarm")])

# ---- Sounder-beacon (wall; axis y)
make("FMC_FP_FireAlarm_Sounder_Beacon", "Addressable sounder-beacon, red body, sounder grille, red LED beacon lens, wall or ceiling base, 104 mm diameter",
     "IfcAlarm", ["Wall_SounderBeacon", "Ceiling_SounderBeacon"], [
        TU("Base", 'y', [0, 0], [[0, 0], [52, 0], [52, -22], [0, -22]], "red"),
        TU("Sounder Body", 'y', [0, 0], [[0, -22], [52, -22], [50, -34], [44, -40], [0, -40]], "red"),
        RING("Grille Ring Outer", 'y', [0, 0], 38, 42, -40, -41.5, "black", 'f'),
        RING("Grille Ring Inner", 'y', [0, 0], 29, 33, -40, -41.5, "black", 'f'),
        TU("Beacon Collar", 'y', [0, 0], [[0, -40], [26, -40], [26, -46], [0, -46]], "red"),
        TU("Beacon Lens", 'y', [0, 0], [[0, -46], [24, -46], [23, -58], [18, -68], [9, -73], [0, -74]], "ledr"),
        rep(CY("Screw Cover", 'y', [-46, 0], 3, [-14, -23], "red", 'f'), 2, [92, 0, 0]),
        F("Label", [-20, -23, -46, 20, -22, -38], "white", 2, 'f'),
     ], {"Diameter 104 mm, 75 mm deep": A("104x75", "typical addressable sounder-beacon"), "Sound output up to 100 dB(A)": A("100dBA", "BS EN 54-3"),
         "Beacon to BS EN 54-23 (wards: visual, staff alarm strategy)": A("EN 54-23", "record note")},
     "Sounder-beacon modelled as a generic product: red base and sounder body with grille rings, collar and red LED lens dome, screw covers, label. Drawn wall mounted; the ceiling type uses the same body (place on the ceiling face).",
     category="Fire Alarm Devices", tv={"Default Elevation": 2300}, conns=[elec("Loop", "Base", "back", "FireAlarm")], geometry="Wall_SounderBeacon")

# ---- Magnetic door holder (wall unit; centre at z = 0)
make("FMC_FP_FireAlarm_DoorHolder_Magnetic", "Electromagnetic door holder, wall mounted, 24 V dc, 50 kg holding force, with release button; door keeper plate supplied with the door",
     "IfcAlarm", ["Wall_Magnetic"], [
        F("Back Plate", [-50, -8, -80, 50, 0, 65], "grey", 8),
        TU("Housing", 'y', [0, 0], [[0, -8], [42, -8], [42, -42], [38, -48], [0, -48]], "white"),
        TU("Magnet Face", 'y', [0, 0], [[0, -48], [34, -48], [34, -54], [0, -54]], "ss"),
        RING("Coil Ring", 'y', [0, 0], 10, 15, -54, -55.5, "black", 'f'),
        CY("Release Button", 'y', [0, -62], 7, [-8, -15], "ledr"),
        CY("Status LED", 'y', [36, 52], 3, [-8, -10], "ledg", 'f'),
        CY("Cable Entry", 'z', [0, -4], 6, [65, 75], "grey", 'f'),
        rep(CY("Fixing Screw", 'y', [-38, 52], 3, [-8, -10], "chrome", 'f'), 2, [76, 0, 0]),
     ], {"Holding force 50 kg": A("50kg"), "24 V dc, 40 mA": A("24V dc", "BS EN 1155 hold-open device"), "Height 1800 to 1950 mm behind the door": A(1900)},
     "Door holder modelled as a generic product: back plate, round housing, stainless magnet face with coil ring, red release button, status LED, cable entry, screws; released by the fire alarm.",
     category="Fire Alarm Devices", tv={"Default Elevation": 1900}, conns=[elec("Fire Alarm", "Back Plate", "back", "FireAlarm")])

# ---- I/O interface module (wall box)
make("FMC_FP_FireAlarm_Interface_Module", "Addressable fire alarm interface module (input or relay output) in a surface back box, 150 x 150 x 45, LEDs, address switch, glands",
     "IfcAlarm", ["Input_Module", "Output_Module"], [
        B("Back Box", [-75, -35, 0, 75, 0, 150], "white", 6),
        F("Cover", [-72, -45, 3, 72, -35, 147], "white", 8),
        F("Label Window", [-50, -46, 100, 50, -45, 130], "grey", 3, 'f'),
        CY("LED Status", 'y', [-40, 75], 3, [-46, -45], "ledg", 'f'),
        CY("LED Active", 'y', [-20, 75], 3, [-46, -45], "ledr", 'f'),
        F("Address Switch", [0, -46, 66, 50, -45, 84], "blue", 1, 'f'),
        rep(CY("Cable Gland", 'z', [-50, -18], 8, [-14, 0], "grey"), 3, [50, 0, 0]),
        rep(CY("Cover Screw", 'y', [-62, 14], 3, [-46, -45], "chrome", 'f'), 2, [124, 0, 0]),
        F("Terminal Warning", [-40, -46, 22, 40, -45, 40], "yellow", 2, 'f'),
     ], {"Box 150 x 150 x 45 mm": A("150x150x45"), "Input monitored / output 1 A volt-free relay": A("1A relay", "type names"), "Height 1800 mm beside the plant it controls": A(1800)},
     "Interface module modelled as a generic product: back box and cover, label window, status and active LEDs, address switch, cable glands, screws, terminal warning label. Used for AHU shutdown and lift recall.",
     category="Fire Alarm Devices", tv={"Default Elevation": 1800}, conns=[elec("Loop", "Back Box", "back", "FireAlarm")], geometry="Input_Module")

# ---- Clean-agent suppression cylinder (floor, strapped to wall)
cy0 = -170
gs = [
    RING("Foot Ring", 'z', [0, cy0], 108, 128, 0, 24, "steel"),
    TU("Cylinder", 'z', [0, cy0], [[0, 20], [120, 20], [135, 60], [135, 980], [110, 1060], [60, 1100], [0, 1106]], "red"),
    RING("Agent Label Band", 'z', [0, cy0], 135, 136.5, 450, 760, "white"),
    F("Hazard Label", [-55, cy0 - 140, 780, 55, cy0 - 128, 860], "yellow", 4, 'f'),
    DISC("Neck", 'z', [0, cy0], 36, 1100, 1130, "brass"),
    B("Valve Body", [-46, cy0 - 46, 1130, 46, cy0 + 46, 1212], "brass", 8),
    TU("Pressure Gauge", 'y', [0, 1176], [[0, cy0 - 46], [30, cy0 - 46], [30, cy0 - 62], [0, cy0 - 62]], "chrome"),
    DISC("Gauge Dial", 'y', [0, 1176], 26, cy0 - 62, cy0 - 64, "white", 'f'),
    CY("Solenoid Actuator", 'z', [0, cy0], 32, [1212, 1300], "black"),
    B("Manual Actuator", [-26, cy0 - 26, 1300, 26, cy0 + 26, 1346], "red", 6),
    RING("Pull Ring", 'y', [0, 1323], 9, 13, cy0 - 26, cy0 - 30, "chrome", 'f'),
    CY("Hose Elbow", 'x', [cy0, 1176], 18, [46, 170], "black"),
    CY("Discharge Hose", 'z', [170, cy0], 18, [1176, 1520], "black"),
    DISC("Hose Coupling", 'z', [170, cy0], 27, 1520, 1550, "brass"),
    F("Wall Channel", [-180, -10, 700, 180, 0, 1000], "galv"),
    RING("Strap", 'z', [0, cy0], 136, 142, 850, 890, "galv"),
    rep(B("Strap Arm", [-146, cy0, 850, -138, -10, 890], "galv"), 2, [284, 0, 0]),
    F("Nameplate", [-40, cy0 - 140, 300, 40, cy0 - 130, 360], "chrome", 2, 'f'),
]
make("FMC_FP_FireProt_Suppression_Gas_ServerRoom", "Clean-agent (FK-5-1-12 / HFC-227ea) suppression cylinder 80 l, red, valve with solenoid and manual actuators, gauge, discharge hose, wall strap",
     "IfcFireSuppressionTerminal", ["80l_CleanAgent"], gs,
     {"80 l cylinder, 270 mm diameter, 1350 mm to actuator": A("270x1350", "typical clean-agent cylinder"), "Fill ratio up to 1.12 kg/l": A("1.12kg/l", "agent supplier; engineer sizes the charge"),
      "Released by the suppression panel (24 V solenoid)": A("24V", "BS EN 15004")},
     "Suppression cylinder modelled as a generic product: foot ring, red cylinder with agent label band and hazard label, neck, valve with gauge, solenoid and manual actuators with pull ring, discharge hose and coupling, wall channel, strap and arms, nameplate. Nozzles and pipe are drawn by the pipework.",
     category="Mechanical Equipment", conns=[elec("Release", "Solenoid Actuator", "top", "FireAlarm")])

# ---- Fire action notice (wall, A4)
make("FMC_FP_FireProt_Signage_FireAction", "Fire action notice A4 (210 x 297), rigid plastic, blue with white text and fire pictogram, screw caps",
     "IfcBuildingElementProxy", ["A4_FireAction"], [
        F("Sign Plate", [-105, -3, 0, 105, 0, 297], "blue", 4),
        F("Header Text", [-80, -4, 262, 80, -3, 284], "white"),
        F("Pictogram Panel", [-95, -4, 190, -50, -3, 240], "white", 3),
        F("Fire Symbol", [-82, -5, 200, -62, -4, 228], "ledr", 2, 'f'),
        rep(F("Text Line Discover", [-40, -4, 200, 95, -3, 205], "white", 0, 'f'), 4, [0, 0, 11]),
        F("Pictogram Alarm", [-95, -4, 115, -50, -3, 165], "white", 3, 'f'),
        rep(F("Text Line Alarm", [-40, -4, 120, 95, -3, 125], "white", 0, 'f'), 4, [0, 0, 11]),
        rep(F("Text Line Assembly", [-95, -4, 40, 95, -3, 45], "white", 0, 'f'), 4, [0, 0, 14]),
        rep(CY("Screw Cap", 'y', [-92, 284], 5, [-3, -6], "chrome", 'f'), 2, [184, 0, 0]),
        rep(CY("Screw Cap Low", 'y', [-92, 13], 5, [-3, -6], "chrome", 'f'), 2, [184, 0, 0]),
     ], {"A4 210 x 297 mm": A("210x297", "type name"), "To ISO 7010 / BS 5499": A("ISO 7010"), "Centre at about 1500 mm beside call points": A(1500)},
     "Fire action notice modelled as a generic product: blue plate, white header, pictogram panels with fire symbol, text lines for discover/alarm/assembly, screw caps.",
     category="Specialty Equipment", tv={"Default Elevation": 1350})

# ================================================================== LANDSCAPE
def canopy_lobes(lobes):
    return [ELL(n, c, rx, z0, z1, m) for (n, c, rx, z0, z1, m) in lobes]

# ---- Shade tree (6 m geometry)
st = [
    DISC("Mulch Ring", 'z', [0, 0], 750, 0, 40, "mulch"),
    TU("Root Flare", 'z', [0, 0], [[0, 0], [240, 0], [170, 60], [120, 220], [0, 220]], "bark"),
    TU("Trunk", 'z', [0, 0], [[0, 220], [120, 220], [100, 1200], [85, 2100], [70, 2600], [0, 2600]], "bark"),
    BXZ("Branch West", [-30, 1900], [-1350, 3250], 120, [-55, 55], "bark"),
    BXZ("Branch East", [30, 2150], [1250, 3400], 110, [-50, 50], "bark"),
    BYZ("Branch South", [-30, 2050], [-1200, 3300], 110, [-50, 50], "bark"),
    BYZ("Branch North", [30, 2250], [1150, 3450], 100, [-45, 45], "bark"),
    CY("Leader", 'z', [0, 0], 60, [2600, 3800], "bark"),
    *canopy_lobes([
        ("Canopy Lower Tier", [0, 0], 2750, 2900, 4300, "leaf1"),
        ("Canopy Lobe West", [-1500, 150], 1350, 3200, 4900, "leaf2"),
        ("Canopy Lobe East", [1450, -100], 1350, 3300, 5000, "leaf2"),
        ("Canopy Lobe South", [100, -1450], 1300, 3250, 4900, "leaf2"),
        ("Canopy Lobe North", [-100, 1450], 1300, 3350, 5000, "leaf2"),
        ("Canopy Lobe SW", [-1250, -1250], 950, 3000, 4300, "leaf1"),
        ("Canopy Lobe NE", [1200, 1250], 950, 3100, 4400, "leaf1"),
        ("Canopy Crown", [0, 0], 1700, 4000, 6000, "leaf3")]),
]
make("FMC_L_Planting_Tree_Shade", "Shade tree (indigenous species, e.g. Markhamia / Albizia type), 6 m or 10 m, broad layered canopy on a clear stem, mulched base",
     "IfcGeographicElement", ["6m_Shade", "10m_Shade"], st,
     {"6 m: canopy spread 5.5 m, clear stem 2.6 m": A("6000/5500", "semi-mature indigenous shade tree"), "10 m: canopy spread 8 m": A("10000/8000", "mature shade tree"),
      "Mulch ring 1.5 m diameter": A(1500), "Species from the indigenous list (landscape architect)": A("open", "record note")},
     "Shade tree modelled as a generic product: mulch ring, root flare, tapering trunk, four main branches and leader, layered canopy of a broad lower tier, four side lobes, two diagonal lobes and a crown.",
     geometry="6m_Shade")

# ---- Ornamental tree (4 m, flowering, umbrella crown)
ot = [
    DISC("Mulch Ring", 'z', [0, 0], 600, 0, 40, "mulch"),
    TU("Trunk", 'z', [0, 0], [[0, 0], [130, 0], [90, 80], [75, 1100], [0, 1100]], "bark"),
    BXZ("Stem West", [-20, 1000], [-850, 2300], 80, [-40, 40], "bark"),
    BXZ("Stem East", [20, 1050], [800, 2350], 75, [-38, 38], "bark"),
    BYZ("Stem South", [-20, 1050], [-750, 2250], 75, [-38, 38], "bark"),
    BYZ("Stem North", [20, 1000], [700, 2400], 70, [-35, 35], "bark"),
    *canopy_lobes([
        ("Canopy Umbrella", [0, 0], 1850, 2200, 3300, "leaf2"),
        ("Canopy Lobe West", [-950, 0], 1000, 2500, 3600, "leaf1"),
        ("Canopy Lobe East", [950, 100], 950, 2550, 3650, "leaf1"),
        ("Canopy Lobe South", [0, -950], 950, 2500, 3600, "leaf3"),
        ("Canopy Lobe North", [100, 950], 950, 2550, 3650, "leaf3"),
        ("Canopy Crown", [0, 0], 1100, 2900, 4000, "leaf2")]),
    *[ELL(f"Flower Cluster {i + 1}", [round(r * math.cos(a)), round(r * math.sin(a))], 300, z, z + 380, "flower")
      for i, (r, a, z) in enumerate([(1250, 0.3, 3150), (1200, 1.9, 3200), (1250, 3.5, 3150), (1150, 5.0, 3200), (500, 1.0, 3650), (550, 4.2, 3600), (0, 0, 3800), (1500, 2.7, 2900)])],
]
make("FMC_L_Planting_Tree_Ornamental", "Flowering ornamental tree (e.g. Nandi flame / Spathodea or Jacaranda type), 4 m or 6 m, multi-stem umbrella crown with flower clusters",
     "IfcGeographicElement", ["4m_Ornamental", "6m_Ornamental"], ot,
     {"4 m: spread 3.7 m": A("4000/3700", "young ornamental tree"), "6 m: spread 5 m": A("6000/5000"), "Flowering colour orange-red (species open)": A("orange-red", "landscape architect confirms species")},
     "Ornamental tree modelled as a generic product: mulch ring, short trunk splitting into four stems, umbrella canopy with side lobes and crown, eight flower clusters on the crown.",
     geometry="4m_Ornamental")

# ---- Palm (6 m)
def arch_frond(name, horiz, top, length, rise, droop, w, axis, sign, m):
    """Arching frond in a vertical plane: band from the crown rising then drooping to the tip (front plane for x, side plane for y)."""
    up, lo = [], []
    for k in range(9):
        t = k / 8; r = 150 + length * t; z = top + rise * math.sin(math.pi * min(t / 0.35, 1) / 2) - droop * max(0, (t - 0.35) / 0.65) ** 1.6
        th = 70 * (1 - 0.7 * t)
        up.append([round(sign * r, 1), round(z + th / 2, 1)]); lo.append([round(sign * r, 1), round(z - th / 2, 1)])
    pts = up + lo[::-1]
    return FR(name, pts, [-w, w], m) if axis == 'x' else RT(name, pts, [-w, w], m)
def frond(i, ang, top):
    out = []
    for k, (r0, r1, w, dz) in enumerate(((150, 1000, 240, -120), (900, 1800, 300, 40), (1700, 2600, 170, 420))):
        ca, sa = math.cos(ang), math.sin(ang); px, py = -sa, ca
        pts = [[r0 * ca + px * w * (0.6 if k else 0.3), r0 * sa + py * w * (0.6 if k else 0.3)], [r1 * ca + px * w, r1 * sa + py * w],
               [(r1 + 60) * ca, (r1 + 60) * sa], [r1 * ca - px * w, r1 * sa - py * w], [r0 * ca - px * w * (0.6 if k else 0.3), r0 * sa - py * w * (0.6 if k else 0.3)]]
        if k == 2: pts = [pts[0], pts[1], [r1 * ca, r1 * sa], pts[3], pts[4]]
        out.append(PR(f"Frond {i + 1} {'Inner Mid Tip'.split()[k]}", [[round(a, 1), round(b, 1)] for a, b in pts], [top - dz - 40, top - dz], "leaf3" if k < 2 else "leaf1"))
    return out
pm = [
    DISC("Mulch Ring", 'z', [0, 0], 500, 0, 40, "mulch"),
    TU("Root Boss", 'z', [0, 0], [[0, 0], [230, 0], [180, 120], [0, 120]], "bark"),
    TU("Trunk", 'z', [0, 0], [[0, 120], [175, 120], [150, 2500], [140, 5000], [150, 5300], [0, 5300]], "bark"),
    rep(RING("Trunk Ring", 'z', [0, 0], 140, 166, 400, 440, "bark", 'f'), 12, [0, 0, 400]),
    TU("Crown Shaft", 'z', [0, 0], [[0, 5300], [170, 5300], [190, 5500], [160, 5750], [0, 5800]], "leaf2"),
    *[f for i in range(4) for f in frond(i, i * math.pi / 2 + math.pi / 4, 5780)],
    arch_frond("Frond East", 'x', 5780, 2500, 300, 1100, 170, 'x', 1, "leaf3"),
    arch_frond("Frond West", 'x', 5760, 2400, 280, 1150, 170, 'x', -1, "leaf3"),
    arch_frond("Frond North", 'y', 5790, 2450, 320, 1050, 170, 'y', 1, "leaf3"),
    arch_frond("Frond South", 'y', 5770, 2500, 260, 1150, 170, 'y', -1, "leaf3"),
    TU("Old Frond Skirt", 'z', [0, 0], [[160, 5300], [420, 5050], [440, 5120], [190, 5420]], "bark"),
    BXZ("Spear Frond East", [0, 5700], [500, 6300], 140, [-20, 20], "leaf2"),
    BYZ("Spear Frond North", [0, 5700], [-450, 6250], 140, [-20, 20], "leaf2"),
    ELL("Fruit Cluster East", [240, 60], 140, 5200, 5450, "flower"),
    ELL("Fruit Cluster West", [-220, -80], 130, 5220, 5450, "flower"),
]
make("FMC_L_Planting_Palm", "Palm (e.g. Phoenix / Royal palm type), 6 m or 9 m clear trunk with leaf-scar rings, crown shaft, arching fronds, fruit clusters",
     "IfcGeographicElement", ["6m_Palm", "9m_Palm"], pm,
     {"6 m overall, crown spread 5.4 m": A("6000/5400"), "9 m overall": A(9000), "Trunk 300 to 350 mm diameter": A(330)},
     "Palm modelled as a generic product: mulch ring, root boss, tall trunk with twelve leaf-scar rings, crown shaft, four arching fronds on the main axes and four diagonal fronds in three drooping segments, a skirt of old frond bases, two spear fronds, two fruit clusters.",
     geometry="6m_Palm")

# ---- Shrub (1.2 m geometry)
sh = [
    DISC("Mulch Ring", 'z', [0, 0], 650, 0, 30, "mulch"),
    rep(CY("Stem", 'z', [-80, 0], 18, [30, 260], "bark", 'f'), 3, [80, 0, 0]),
    ELL("Body Core", [0, 0], 520, 120, 1050, "leaf2"),
    ELL("Lobe West", [-330, 60], 330, 150, 820, "leaf1"),
    ELL("Lobe East", [320, -40], 320, 170, 860, "leaf1"),
    ELL("Lobe South", [20, -320], 320, 160, 800, "leaf3"),
    ELL("Lobe North", [-40, 330], 320, 160, 840, "leaf3"),
    ELL("Top Lobe", [60, 40], 320, 750, 1200, "leaf2"),
    *[ELL(f"Flower {i + 1}", [round(r * math.cos(a)), round(r * math.sin(a))], 70, z, z + 110, "flower", 'f')
      for i, (r, a, z) in enumerate([(430, 0.5, 700), (420, 2.2, 650), (430, 3.9, 700), (400, 5.4, 650), (150, 1.2, 1110), (300, 4.6, 980)])],
]
make("FMC_L_Planting_Shrub", "Flowering shrub, 0.6 m or 1.2 m, rounded layered form, mulched base", "IfcGeographicElement", ["0.6m_Shrub", "1.2m_Shrub"], sh,
     {"1.2 m: spread 1.2 m": A("1200/1200"), "0.6 m: spread 0.7 m": A("600/700"), "Planting centres 600 to 1000 mm": A("600-1000", "landscape architect")},
     "Shrub modelled as a generic product: mulch ring, stems, a core mass with four side lobes and a top lobe, flowers dotted over the surface.",
     geometry="1.2m_Shrub")

# ---- Hedge run (2 m length, 1.2 m)
hd = [
    B("Mulch Strip", [-1050, -400, 0, 1050, 400, 30], "mulch"),
    rep(CY("Stem", 'z', [-875, 0], 20, [30, 230], "bark", 'f'), 8, [250, 0, 0]),
    RT("Hedge Body", [[-200, 180], [200, 180], [290, 400], [300, 900], [230, 1120], [0, 1200], [-230, 1120], [-300, 900], [-290, 400]], [-1000, 1000], "leaf2"),
    rep(ELL("Lump Front Low", [-800, -215], 230, 260, 760, "leaf1"), 5, [400, 0, 0]),
    rep(ELL("Lump Front High", [-600, -205], 230, 620, 1100, "leaf3"), 4, [400, 0, 0]),
    rep(ELL("Lump Back Low", [-600, 215], 230, 260, 760, "leaf1"), 4, [400, 0, 0]),
    rep(ELL("Lump Back High", [-800, 205], 230, 620, 1100, "leaf3"), 5, [400, 0, 0]),
    rep(ELL("Top Lump", [-750, 0], 250, 1020, 1250, "leaf2"), 4, [500, 0, 0]),
]
make("FMC_L_Planting_Hedge", "Clipped hedge run (e.g. Duranta), 1.2 m or 1.8 m high, 600 mm wide, per 2 m length, mulched strip",
     "IfcGeographicElement", ["1.2m_Hedge", "1.8m_Hedge"], hd,
     {"1.2 m high x 0.6 m wide, 2 m run": A("1200x600x2000"), "1.8 m high type": A(1800), "Planted at 3 to 4 per metre, double staggered": A("3-4/m", "Duranta hedge practice")},
     "Hedge modelled as a generic product: mulch strip, stems, clipped body with battered sides and rounded top, leafy lumps along both faces and the top. Array it along a line for a run.",
     geometry="1.2m_Hedge")

# ---- Groundcover patch (1 m x 1 m)
gc = [B("Mulch Bed", [-500, -500, 0, 500, 500, 30], "mulch"),
      rep(B("Edging Front", [-510, -510, 0, 510, -500, 60], "pine"), 2, [0, 1010, 0]),
      rep(B("Edging Side", [-510, -500, 0, -500, 500, 60], "pine"), 2, [1010, 0, 0])]
k = 0
for i in range(4):
    for j in range(4):
        x, y = -375 + 250 * i + (40 if j % 2 else -30), -375 + 250 * j + (30 if i % 2 else -40)
        gc.append(ELL(f"Plant {k + 1}", [x, y], 165 - 15 * ((i + j) % 2), 30, 260 + 40 * ((i * j) % 3), ["leaf1", "leaf3", "leaf2", "leaf4"][(i + 2 * j) % 4])); k += 1
gc += [ELL(f"Flower {i + 1}", [x, y], 45, 250, 320, "flower", 'f') for i, (x, y) in enumerate([(-300, -280), (-60, 120), (200, -150), (350, 330), (-280, 360), (120, 400)])]
make("FMC_L_Planting_Groundcover", "Groundcover planting patch, 0.3 m high, 1 m x 1 m, plants at 250 mm centres in mulch, timber edging",
     "IfcGeographicElement", ["0.3m_Groundcover"], gc,
     {"Height 300 mm": A(300, "type name"), "16 plants per m2 (250 mm centres)": A(16, "groundcover practice"), "Mulch 50 mm": A(50)},
     "Groundcover patch modelled as a generic product: mulch bed with timber edging, sixteen plant mounds in four greens at staggered centres, a few flowers. Array for larger beds.")

# ---- Raised therapy planter (wheelchair height)
tp = [
    rep(B("Leg Front", [-590, -290, 0, -540, -240, 600], "galv"), 2, [1130, 0, 0]),
    rep(B("Leg Back", [-590, 240, 0, -540, 290, 600], "galv"), 2, [1130, 0, 0]),
    rep(B("Foot Pad", [-600, -300, 0, -530, -230, 12], "rubber", 0, 'f'), 2, [1130, 0, 0]),
    rep(B("Foot Pad Back", [-600, 230, 0, -530, 300, 12], "rubber", 0, 'f'), 2, [1130, 0, 0]),
    B("Low Rail Back", [-540, 250, 120, 540, 280, 160], "galv"),
    B("Tray Base", [-590, -290, 600, 590, 290, 620], "galv"),
    rep(B("Slat Front", [-600, -300, 600, 600, -280, 655], "timber", 4), 2, [0, 0, 60]),
    rep(B("Slat Back", [-600, 280, 600, 600, 300, 655], "timber", 4), 2, [0, 0, 60]),
    rep(B("Slat Left", [-600, -280, 600, -580, 280, 655], "timber", 4), 2, [0, 0, 60]),
    rep(B("Slat Right", [580, -280, 600, 600, 280, 655], "timber", 4), 2, [0, 0, 60]),
    B("Cap Rail Front", [-630, -330, 720, 630, -260, 750], "timber", 10),
    B("Cap Rail Back", [-630, 260, 720, 630, 330, 750], "timber", 10),
    B("Cap Rail Left", [-630, -260, 720, -560, 260, 750], "timber"),
    B("Cap Rail Right", [560, -260, 720, 630, 260, 750], "timber"),
    B("Soil", [-560, -260, 620, 560, 260, 715], "soil"),
    ELL("Herb West", [-380, 40], 160, 700, 900, "leaf3"),
    ELL("Herb Centre", [-60, -60], 180, 700, 940, "leaf1"),
    ELL("Herb East", [280, 60], 170, 700, 910, "leaf2"),
    ELL("Herb Back", [440, -120], 110, 700, 840, "leaf4"),
    rep(ELL("Flower", [-200, 120], 45, 880, 950, "flower", 'f'), 3, [220, -60, 0]),
    rep(CY("Rail Screw", 'z', [-600, -295], 5, [750, 753], "ss", 'f'), 4, [400, 0, 0]),
]
make("FMC_L_Planting_Planter_Raised_Therapy", "Wheelchair-height therapy planter 1200 x 600, rim 750, timber-clad tray on galvanised legs with knee recess under, cap rail to lean on",
     "IfcFurniture", ["1200x600x750_Therapy"], tp,
     {"1200 x 600 mm, rim 750 mm": A("1200x600x750", "type name"), "Knee recess 600 mm high under the tray": A(600, "owner to confirm against the accessibility brief (685 mm in some guides)"),
      "Soil depth 100 mm in the tray": A(100, "shallow herb tray"), "Approach space 1500 mm in front": A(1500, "wheelchair turning space")},
     "Therapy planter modelled as a generic product: galvanised legs with rubber pads and a back rail, tray with timber slats on all four faces, wide cap rail with screws, soil, herbs and flowers; open underneath for knee access.",
     category="Planting", clear=[{"n": "Approach Space", "shape": "box", "at": [-600, -1800, 0, 600, -330, 10], "sub": "Clearance Accessibility"}])

# ---- Healing-garden bench with armrests (1500)
def bench_frame(x0, x1, arms, tag):
    parts = [RT(f"Front Leg {tag}", bar2([-250, 0], [-235, 640 if arms else 440], 50), [x0, x1], "steel"),
             RT(f"Rear Leg {tag}", bar2([230, 0], [205, 440], 50), [x0, x1], "steel"),
             RT(f"Back Support {tag}", bar2([205, 420], [300, 880], 50), [x0, x1], "steel"),
             RT(f"Seat Rail {tag}", bar2([-290, 415], [230, 425], 40), [x0, x1], "steel"),
             B(f"Foot {tag}", [x0 - 5, -280, 0, x1 + 5, -215, 10], "rubber", 0, 'f')]
    if arms: parts.append(B(f"Armrest {tag}", [x0 - 25, -330, 640, x1 + 25, 130, 675], "timber", 18))
    return parts
bn = bench_frame(-735, -705, True, "Left") + bench_frame(705, 735, True, "Right") + bench_frame(-15, 15, False, "Centre")
bn += [rep(B("Seat Slat", [-750, -305, 435, 750, -235, 462], "timber", 6), 6, [0, 88, 0])]
d = (95, 450); L = math.hypot(*d); u = (d[0] / L, d[1] / L); nrm = (-u[1] * 28, u[0] * 28); p0 = (215 + 0.2 * u[0] * 0 - 10, 500)
slat = [[p0[0], p0[1]], [p0[0] + u[0] * 80, p0[1] + u[1] * 80], [p0[0] + u[0] * 80 + nrm[0], p0[1] + u[1] * 80 + nrm[1]], [p0[0] + nrm[0], p0[1] + nrm[1]]]
bn += [rep(RT("Back Slat", [[round(a, 1), round(b, 1)] for a, b in slat], [-750, 750], "timber"), 4, [0, round(u[0] * 100, 1), round(u[1] * 100, 1)]),
       rep(CY("Slat Bolt Left", 'z', [-720, -270], 5, [462, 465], "ss", 'f'), 6, [0, 88, 0]),
       rep(CY("Slat Bolt Right", 'z', [720, -270], 5, [462, 465], "ss", 'f'), 6, [0, 88, 0]),
       rep(CY("Slat Bolt Centre", 'z', [0, -270], 5, [462, 465], "ss", 'f'), 6, [0, 88, 0])]
make("FMC_L_SiteFurniture_Bench_HealingGarden", "Healing-garden bench 1500 / 1800 with backrest and armrests to help standing, hardwood slats on powder-coated steel frames, seat 460, arms 675",
     "IfcFurniture", ["1500_Bench", "1800_Bench"], bn,
     {"Seat height 460 mm, arm height 675 mm": A("460/675", "inclusive seating guidance (BS 8300 / HBN 00-03 garden practice)"),
      "Length 1500 / 1800 mm, depth 640 mm": A("1500-1800x640"), "Hardwood slats 70 x 27 mm": A("70x27"), "Armrests extend to the seat front to push up on": A("forward arms")},
     "Bench modelled as a generic product: three steel frames (front legs rising into the arm supports, rear legs, back supports, seat rails, feet), six hardwood seat slats with bolt heads at each frame, four raked back slats, timber armrests.",
     category="Site", geometry="1500_Bench")

# ---- Precast concrete bench with timber cap (1800)
cb = [
    B("Shadow Plinth", [-840, -190, 0, 840, 190, 80], "concg"),
    B("Precast Body", [-900, -250, 80, 900, 250, 400], "conc"),
    rep(B("Arris Chamfer", [-900, -255, 395, 900, -245, 405], "conc", 0, 'f'), 2, [0, 500, 0]),
    rep(B("Batten", [-860, -230, 400, -820, 230, 420], "timber"), 4, [560, 0, 0]),
    rep(B("Timber Slat", [-900, -245, 420, 900, -175, 455], "timber", 6), 6, [0, 82, 0]),
    rep(CY("Fixing Front Row", 'z', [-840, -210], 5, [455, 458], "ss", 'f'), 4, [560, 0, 0]),
    rep(CY("Fixing Back Row", 'z', [-840, 200], 5, [455, 458], "ss", 'f'), 4, [560, 0, 0]),
    rep(F("Lifting Socket Cover", [-700, -252, 300, -660, -250, 340], "steel", 0, 'f'), 2, [1360, 0, 0]),
    rep(CY("Skate Stop", 'z', [-300, 30], 14, [455, 475], "ss", 'f'), 2, [600, 0, 0]),
]
make("FMC_L_SiteFurniture_Bench_Concrete_TimberCap", "Precast concrete bench 1800 / 2400 x 500, 455 high, with hardwood slat cap on battens, stainless fixings and skate stops, recessed shadow plinth",
     "IfcFurniture", ["1800_Bench", "2400_Bench"], cb,
     {"1800 / 2400 x 500 mm, seat 455 mm": A("1800-2400x500x455"), "Precast unit about 0.29 m3 (1800)": A(0.29), "Hardwood slats 70 x 35 mm": A("70x35")},
     "Concrete bench modelled as a generic product: recessed shadow plinth, precast body with arris chamfers and lifting socket covers, timber battens, six slats with stainless fixings, two skate stops.",
     category="Site", geometry="1800_Bench")

# ---- Timber pergola 3000 x 3000
pg = [
    rep(B("Post Front", [-1500, -1500, 150, -1350, -1350, 2400], "timber"), 2, [2850, 0, 0]),
    rep(B("Post Back", [-1500, 1350, 150, -1350, 1500, 2400], "timber"), 2, [2850, 0, 0]),
    rep(B("Post Shoe Front", [-1510, -1510, 0, -1340, -1340, 150], "galv"), 2, [2850, 0, 0]),
    rep(B("Post Shoe Back", [-1510, 1340, 0, -1340, 1510, 150], "galv"), 2, [2850, 0, 0]),
    rep(B("Beam Outer", [-1700, -1550, 2200, 1700, -1500, 2400], "timber"), 2, [0, 2950, 0]),
    rep(B("Beam Inner", [-1700, -1350, 2200, 1700, -1300, 2400], "timber"), 2, [0, 2650, 0]),
    rep(B("Rafter", [-1525, -1750, 2400, -1475, 1750, 2600], "timber"), 9, [375, 0, 0]),
    rep(B("Shade Batten", [-1650, -1520, 2600, 1650, -1480, 2650], "pine"), 11, [0, 300, 0]),
    BXZ("Knee Brace Front Left", [-1350, 1850], [-1000, 2200], 70, [-1460, -1390], "timber"),
    BXZ("Knee Brace Front Right", [1350, 1850], [1000, 2200], 70, [-1460, -1390], "timber"),
    BXZ("Knee Brace Back Left", [-1350, 1850], [-1000, 2200], 70, [1390, 1460], "timber"),
    BXZ("Knee Brace Back Right", [1350, 1850], [1000, 2200], 70, [1390, 1460], "timber"),
    rep(CY("Beam Bolt Front", 'y', [-1425, 2300], 10, [-1560, -1290], "galv", 'f'), 2, [2850, 0, 0]),
    rep(CY("Beam Bolt Back", 'y', [-1425, 2300], 10, [1290, 1560], "galv", 'f'), 2, [2850, 0, 0]),
]
make("FMC_L_SiteFurniture_Pergola_Timber", "Timber shade pergola 3000 x 3000, 150 x 150 posts on galvanised shoes, twin beams, rafters and shade battens, knee braces, bolted",
     "IfcBuildingElementProxy", ["3000x3000_Pergola"], pg,
     {"Plan 3000 x 3000 mm, 2650 mm high": A("3000x3000x2650", "type name"), "Posts 150 x 150, beams 2 x 50 x 200, rafters 50 x 200": A("150/50x200", "engineer checks spans and wind uplift"),
      "Battens 40 x 50 at 300 mm (about 15 % shade)": A("40x50@300")},
     "Pergola modelled as a generic product: four posts on galvanised shoes, twin beams each side through-bolted, nine rafters, eleven shade battens, knee braces in the beam plane. Footings are drawn by structure.",
     category="Site")

# ---- Healing-garden water feature (1500 dia)
wf = [
    TU("Basin Wall", 'z', [0, 0], [[680, 0], [750, 0], [750, 440], [680, 440]], "stone"),
    TU("Coping", 'z', [0, 0], [[660, 440], [790, 440], [790, 490], [660, 490]], "granite"),
    DISC("Basin Floor", 'z', [0, 0], 680, 0, 60, "concg"),
    DISC("Water Surface", 'z', [0, 0], 680, 60, 380, "water"),
    TU("Central Plinth", 'z', [0, 0], [[0, 380], [170, 380], [140, 520], [90, 600], [0, 600]], "stone"),
    TU("Upper Bowl", 'z', [0, 0], [[0, 600], [80, 600], [380, 700], [400, 760], [360, 760], [0, 720]], "stone"),
    DISC("Bowl Water", 'z', [0, 0], 362, 720, 745, "water"),
    TU("Overflow Sheet", 'z', [0, 0], [[400, 700], [404, 700], [404, 390], [400, 390]], "water", 'f'),
    TU("Bubbler Jet", 'z', [0, 0], [[0, 745], [14, 745], [8, 880], [0, 920]], "water", 'f'),
    *[ELL(f"Pebble {i + 1}", [round(r * math.cos(a)), round(r * math.sin(a))], 60, 375, 400, "pebble", 'f') for i, (r, a) in enumerate([(520, 0.4), (560, 1.6), (500, 2.9), (540, 4.1), (520, 5.3)])],
    *[DISC(f"Uplight {i + 1}", 'z', [round(260 * math.cos(a)), round(260 * math.sin(a))], 28, 378, 384, "chrome", 'f') for i, a in enumerate([0.9, 3.0, 5.1])],
    B("Pump Chamber Lid", [880, -250, 0, 1280, 250, 60], "concg"),
    rep(B("Lifting Key", [920, -30, 60, 960, 30, 66], "steel", 0, 'f'), 2, [280, 0, 0]),
]
make("FMC_L_SiteFurniture_WaterFeature_HealingGarden", "Small recirculating water feature for a healing garden: 1500 mm dressed-stone basin with granite coping, central plinth and overflowing bowl, bubbler, uplights, pump chamber",
     "IfcBuildingElementProxy", ["1500dia_Recirculating"], wf,
     {"Basin 1500 mm diameter, coping at 490 mm": A("1500/490", "type name; seat-height coping"), "Water depth 300 mm (shallow for safety)": A(300, "healing-garden practice; risk assessment confirms"),
      "Pump 250 W, 240 V via RCD": A(250, "small recirculating pump allowance"), "Make-up water with float valve": A("float valve")},
     "Water feature modelled as a generic product: dressed-stone basin wall with granite coping, basin floor, water surface, central plinth and bowl with water and overflow sheet, bubbler jet, pebbles, uplights, pump chamber lid with lifting keys.",
     category="Site", tv={"Voltage": 240, "Apparent Load": 300},
     conns=[pipe("Make-up Water", "Pump Chamber Lid", "bottom", "DomesticColdWater", 15), elec("Pump Power", "Pump Chamber Lid", "bottom")])

# ---- Outdoor drinking post (1000 high)
dp = [
    B("Splash Pad", [-400, -400, 0, 400, 400, 60], "concg"),
    B("Drain Grating", [-150, -360, 60, 150, -160, 64], "galv"),
    rep(B("Grating Bar", [-140, -355, 64, -134, -165, 66], "steel", 0, 'f'), 10, [30, 0, 0]),
    TU("Base Plate", 'z', [0, 0], [[0, 60], [130, 60], [130, 76], [0, 76]], "ss"),
    rep(CY("Anchor Cap X", 'z', [-100, 0], 10, [76, 90], "ss", 'f'), 2, [200, 0, 0]),
    rep(CY("Anchor Cap Y", 'z', [0, -100], 10, [76, 90], "ss", 'f'), 2, [0, 200, 0]),
    TU("Post", 'z', [0, 0], [[0, 76], [80, 76], [70, 900], [0, 900]], "ss"),
    F("Access Panel", [-36, -76, 250, 36, -73, 520], "ss", 6, 'f'),
    rep(CY("Panel Screw", 'y', [-26, 262], 3, [-76, -78], "chrome", 'f'), 2, [52, 0, 0]),
    TU("Bowl", 'z', [0, 0], [[0, 900], [80, 900], [170, 960], [178, 1000], [160, 1000], [100, 978], [0, 978]], "ss"),
    DISC("Bowl Drain", 'z', [0, 0], 22, 978, 981, "chrome", 'f'),
    TU("Bubbler", 'z', [60, 0], [[0, 978], [18, 978], [14, 1020], [9, 1035], [0, 1037]], "chrome"),
    B("Bubbler Guard", [40, -22, 1030, 80, 22, 1042], "chrome", 0, 'f'),
    TU("Push Button", 'y', [0, 830], [[0, -66], [30, -66], [30, -84], [25, -92], [0, -92]], "ss"),
    RING("Button Collar", 'y', [0, 830], 30, 36, -66, -74, "black", 'f'),
    F("Drinking Water Sign", [-30, -74, 640, 30, -71, 720], "blue", 4, 'f'),
    CY("Service Inlet", 'z', [40, 0], 15, [-150, 60], "ss"),
    CY("Waste Outlet", 'z', [-40, 0], 25, [-150, 60], "ss"),
]
make("FMC_L_SiteFurniture_DrinkingPost_Outdoor", "Vandal-resistant outdoor drinking post, stainless steel, 1000 high, bowl with guarded bubbler, push button, access panel, on a concrete splash pad with drain grating",
     "IfcSanitaryTerminal", ["1000_DrinkingPost"], dp,
     {"Height 1000 mm to bowl rim": A(1000, "type name"), "Bowl 356 mm diameter": A(356), "Self-closing push button, 15 mm supply": A(15),
      "Splash pad 800 x 800 with drain to soakaway": A("800x800")},
     "Drinking post modelled as a generic product: splash pad with drain grating and bars, base plate with anchor caps, tapered stainless post with access panel and screws, bowl with drain, guarded bubbler, push button with collar, sign, service and waste spigots below.",
     category="Site", conns=[pipe("CW", "Service Inlet", "bottom", "DomesticColdWater", 15), pipe("Waste", "Waste Outlet", "bottom", "Sanitary", 40, "Out")])

# ---- Segregated external waste bins (2-bin)
wb = [
    B("Base Slab", [-680, -330, 0, 680, 330, 60], "concg"),
    rep(CY("Post", 'z', [-630, 280], 30, [60, 1200], "galv"), 3, [630, 0, 0]),
    RT("Rain Hood", arch(-330, 330, 1200, 110), [-680, 680], "alu"),
    B("Hood Fascia", [-680, -336, 1170, 680, -326, 1210], "alu"),
    B("Hanging Rail", [-660, 250, 880, 660, 310, 920], "galv"),
]
for i, (x, col, name) in enumerate(((-315, "black", "General"), (315, "blue", "Recycling"))):
    wb += [TU(f"Bin Body {name}", 'z', [x, 0], [[0, 150], [225, 150], [250, 1000], [0, 1000]], "ss"),
           RING(f"Bin Rim {name}", 'z', [x, 0], 250, 262, 1000, 1022, col),
           TU(f"Bin Lid {name}", 'z', [x, 0], [[0, 1022], [262, 1022], [240, 1062], [150, 1080], [0, 1088]], col),
           B(f"Aperture {name}", [x - 95, -262, 1024, x + 95, -150, 1066], "black", 10, 'f'),
           RING(f"Stream Band {name}", 'z', [x, 0], 244, 248.5, 700, 800, col),
           B(f"Bin Bracket {name}", [x - 40, 230, 860, x + 40, 260, 940], "galv"),
           F(f"Stream Sign {name}", [x - 150, -340, 1172, x + 150, -336, 1208], col, 3, 'f'),
           RING(f"Base Ring {name}", 'z', [x, 0], 205, 228, 150, 175, "black", 'f')]
make("FMC_L_SiteFurniture_WasteBin_External_Segregated", "Segregated external waste station, 2-bin (general black, recycling blue) or 3-bin, 80 l stainless bins with coloured lids and bands, hung on a galvanised frame under a rain hood",
     "IfcFurniture", ["2-bin_Segregated", "3-bin_Segregated"], wb,
     {"2-bin: 1360 x 660 mm, 1310 mm high": A("1360x660x1310"), "3-bin: 1990 x 660 mm": A("1990x660"), "Bins 80 l each, colour coded by stream": A("80l", "estates segregation policy confirms colours")},
     "Waste station modelled as a generic product: concrete base, three posts, curved rain hood with fascia and coloured stream signs, hanging rail, two tapered stainless bins with coloured rims, domed lids with apertures, stream bands, brackets and base rings.",
     category="Site", geometry="2-bin_Segregated")

# ---- Chain-link boundary fence (one 3 m bay)
def lattice(x0, x1, z0, z1, step, w=8):
    """Diamond wires of the chain-link: 45-degree bars clipped to the mesh panel, in front of it (lod f)."""
    out = []; H = z1 - z0
    for sgn, tag in ((1, 'Up'), (-1, 'Down')):
        k = 0; c = x0 - H + step / 2
        while c < x1:
            # line x = c + sgn*(z - z0) for 'Up' (sgn 1) or x = c + H - (z - z0) for 'Down'
            pts = []
            for z in (z0, z1):
                x = c + (z - z0) if sgn > 0 else c + H - (z - z0)
                pts.append([x, z])
            (xa, za), (xb, zb) = pts
            def clip(xa, za, xb, zb):
                t0, t1 = 0.0, 1.0
                for p, q in ((-(xb - xa), xa - x0), ((xb - xa), x1 - xa)):
                    if p == 0: continue
                    r = q / p
                    if p < 0: t0 = max(t0, r)
                    else: t1 = min(t1, r)
                return (t0, t1) if t0 < t1 else None
            tt = clip(xa, za, xb, zb)
            if tt and (tt[1] - tt[0]) * H > 120:
                a = [xa + (xb - xa) * tt[0], za + (zb - za) * tt[0]]; b = [xa + (xb - xa) * tt[1], za + (zb - za) * tt[1]]
                k += 1; out.append(BXZ(f"Mesh Wire {tag} {k}", a, b, w, [-6, -3], "galv", 'f'))
            c += step
    return out
LATTICE = lattice(-1470, 1470, 60, 1760, 320)
fn = [
    rep(CY("Post Footing", 'z', [-1500, 0], 150, [-600, 0], "concg", 'm'), 2, [3000, 0, 0]),
    rep(CY("Post", 'z', [-1500, 0], 30, [0, 1800], "gi"), 2, [3000, 0, 0]),
    rep(BYZ("Cranked Arm", [0, 1780], [-300, 2120], 40, [-1520, -1480], "gi"), 2, [3000, 0, 0]),
    rep(DISC("Post Cap", 'z', [-1500, 0], 34, 1800, 1830, "gi"), 2, [3000, 0, 0]),
    CY("Top Rail", 'x', [0, 1770], 21, [-1470, 1470], "gi"),
    B("Chain Link Mesh", [-1470, -3, 60, 1470, 3, 1760], "mesh"),
    *LATTICE,
    CY("Tension Wire Mid", 'x', [-6, 900], 2.5, [-1470, 1470], "gi", 'f'),
    CY("Tension Wire Bottom", 'x', [-6, 80], 2.5, [-1470, 1470], "gi", 'f'),
    rep(B("Tension Bar", [-1478, -6, 60, -1470, 6, 1760], "gi", 0, 'f'), 2, [2948, 0, 0]),
    CY("Barbed Wire 1", 'x', [-100, 1900], 2.5, [-1500, 1500], "gi"),
    CY("Barbed Wire 2", 'x', [-195, 2010], 2.5, [-1500, 1500], "gi"),
    CY("Barbed Wire 3", 'x', [-285, 2110], 2.5, [-1500, 1500], "gi"),
    rep(B("Barb", [-1400, -110, 1890, -1390, -90, 1910], "gi", 0, 'f'), 10, [300, 0, 0]),
    rep(B("Line Clip", [-1400, -8, 1755, -1390, 8, 1785], "gi", 0, 'f'), 3, [1120, 0, 0]),
]
make("FMC_L_SiteFurniture_Fence_Chainlink", "Boundary chain-link fence, 1.8 m or 2.4 m, per 3 m bay: GI posts in concrete footings, top rail, mesh, tension wires and bars, cranked arms with three barbed strands",
     "IfcRailing", ["1.8m_Chainlink", "2.4m_Chainlink"], fn,
     {"Mesh 1.8 m, 50 mm, 2.5 mm galvanised": A("50x2.5", "chain-link to BS 1722-1 class"), "Posts 60 mm GI at 3 m, footings 300 x 600": A("60@3000"),
      "Cranked arms with 3 barbed strands": A(3, "hospital boundary security"), "2.4 m type": A(2400)},
     "Fence bay modelled as a generic product: post footings (Medium), GI posts and caps, cranked arms, top rail, chain-link mesh panel, mid and bottom tension wires, tension bars, three barbed strands with barbs, line clips. Array along the boundary.",
     category="Site", geometry="1.8m_Chainlink")

# ---- Motorised sliding gate (6 m opening)
gt = [
    B("Track Rail", [-3500, -25, 0, 3050, 25, 40], "steel"),
    B("Track Parking Run", [-9300, -25, 0, -3500, 25, 40], "steel", 0, 'm'),
    B("Bottom Rail", [-3400, -40, 80, 3000, 40, 180], "steel"),
    B("Top Rail", [-3400, -30, 1920, 3000, 30, 2000], "steel"),
    B("Mid Rail", [-3400, -25, 1000, 3000, 25, 1060], "steel"),
    rep(B("Stile", [-3400, -40, 80, -3320, 40, 2000], "steel"), 2, [6320, 0, 0]),
    rep(B("Picket", [-3230, -12, 180, -3206, 12, 1920], "steel"), 30, [205, 0, 0]),
    rep(TU("Track Wheel", 'y', [-3000, 55], [[0, -32], [55, -32], [55, 32], [0, 32]], "nylon"), 2, [5400, 0, 0]),
    B("Gear Rack", [-3400, -62, 360, 3000, -40, 400], "nylon"),
    B("Receiver Post", [3020, -80, 0, 3180, 80, 2150], "steel"),
    B("Receiver Catch", [2990, -60, 800, 3020, 60, 1200], "steel", 0, 'f'),
    rep(B("Guide Post", [-3180, 60, 0, -3080, 160, 2150], "steel"), 1, [0, 0, 0]),
    B("Guide Post Front", [-3180, -160, 0, -3080, -60, 2150], "steel"),
    rep(CY("Guide Roller", 'z', [-3130, -48], 22, [1900, 2000], "nylon"), 2, [0, 96, 0]),
    B("Motor Plinth", [-3500, -480, 0, -3120, -100, 100], "concg"),
    B("Motor Housing", [-3450, -420, 100, -3170, -80, 330], "grey", 30),
    CY("Pinion", 'y', [-3260, 332], 28, [-80, -40], "steel", 'f'),
    rep(B("Photocell", [3040, -100, 450, 3100, -80, 560], "black", 6, 'f'), 1, [0, 0, 0]),
    B("Photocell Guide Side", [-3160, -180, 450, -3100, -160, 560], "black", 6, 'f'),
    TU("Warning Lamp", 'z', [3100, 0], [[0, 2150], [55, 2150], [48, 2240], [0, 2265]], "yellow"),
    rep(B("Post Cap", [-3190, 50, 2150, -3070, 170, 2170], "steel", 0, 'f'), 1, [0, 0, 0]),
    B("Post Cap Front", [-3190, -170, 2150, -3070, -50, 2170], "steel", 0, 'f'),
    F("Keep Clear Sign", [2000, -46, 1300, 2500, -40, 1600], "white", 0, 'f'),
]
make("FMC_L_SiteFurniture_Gate_Sliding_Main", "Motorised sliding main gate for a 6 m / 8 m opening: steel leaf 2 m high with pickets, on a ground track with V-wheels, gear rack, 240 V operator, guide posts with rollers, receiver post, photocells, warning lamp",
     "IfcDoor", ["6m_Motorised", "8m_Motorised"], gt,
     {"Opening 6000 mm, leaf 6400 x 2000 mm": A("6000/6400x2000", "type name"), "Track run 12.3 m (opening + parking)": A(12350),
      "Operator 240 V, 600 VA allowance": A(600, "sliding gate operator for leaves to about 800 kg"), "Safety to BS EN 12453 (photocells, edges)": A("EN 12453")},
     "Sliding gate modelled as a generic product: ground track under the leaf (the 5.8 m parking run behind the guide posts shows at Medium, kept off Fine so the leaf reads), leaf with bottom, mid and top rails, stiles and thirty pickets, V-wheels, gear rack, receiver post and catch, twin guide posts with rollers, operator on a plinth with pinion, photocells, warning lamp, sign.",
     category="Site", tv={"Voltage": 240, "Apparent Load": 600}, conns=[elec("Operator Power", "Motor Housing", "bottom")], geometry="6m_Motorised")

# ------------------------------------------------------------------ write
def main(only=None):
    assert {p['family'] for p in P} == set(RECS), set(RECS) ^ {p['family'] for p in P}
    import re
    for p in P:
        for t in p['types']: assert re.match(r'^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$', t['name']), t['name']
        for m in p['materials'].values(): assert m in KIT, m
        assert 2 <= len(p['values']) <= 5, (p['family'], len(p['values']))
        names = [q['n'] for q in fp.expand(p['parts'])]; assert len(names) == len(set(names)), (p['family'], [n for n in names if names.count(n) > 1])
    json.dump(NEEDED, open(os.path.join(HERE, 'batches', BATCH + '.materials_needed.json'), 'w'), indent=1)
    out = []
    for prod in P:
        if only and prod['family'] not in only: continue
        f = prod['family']
        json.dump(prod, open(os.path.join(HERE, f + '.product.json'), 'w'), indent=1)
        r = fp.compile_product(prod)
        json.dump(r, open(os.path.join(HERE, f + '.recipe.json'), 'w'), indent=1)
        fp.render(prod, os.path.join(HERE, f + '.preview.png'))
        fp.render_type_image(prod, os.path.join(HERE, f + '.png'), size=600)
        out.append((f, count(prod['parts']), len(r['ops'])))
        print(out[-1], flush=True)
    return out

KIT = set(open(os.path.join(HERE, 'batches', 'KIT_MATERIALS.txt')).read().split())
if __name__ == '__main__':
    main(set(sys.argv[1:]) or None)
