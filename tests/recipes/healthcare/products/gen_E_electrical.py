"""Healthcare pack, batch E (electrical, ELV, nurse call, lighting, lightning protection): detailed product models.
Same pattern as make_products.py. Run: python3 gen_E_electrical.py [family-substring ...]
Writes <family>.product.json, .recipe.json, .preview.png and .png (type image, 600 px) in this folder."""
import json, os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import fmc_parts as fp

RECS = {r['family']: r for r in json.load(open(os.path.join(HERE, 'batches', 'E_electrical.json')))}
A = lambda v, src='typical product, to confirm with the supplier': {"value": v, "source_status": "assumed", "source": src}

MAT = {
    'white': 'FMC_Plastic_ABS_White', 'black': 'FMC_Plastic_ABS_Black', 'grey': 'FMC_Plastic_ABS_Grey', 'mgrey': 'FMC_Plastic_ABS_MedicalGrey',
    'blue': 'FMC_Plastic_ABS_Blue', 'yellow': 'FMC_Plastic_ABS_Yellow', 'steel': 'FMC_Metal_SteelLTZ_Painted', 'epw': 'FMC_Metal_Steel_EpoxyCoated_White',
    'ss': 'FMC_Metal_StainlessSteel_Brushed', 'chrome': 'FMC_Metal_Chrome_Polished', 'alu': 'FMC_Metal_Aluminium_Anodised_Silver',
    'pcoat': 'FMC_Metal_Aluminium_PowderCoated', 'galv': 'FMC_Metal_ColdFormed_Galvanised', 'pc': 'FMC_Plastic_Polycarbonate_Clear',
    'glass': 'FMC_Glass_Clear', 'frost': 'FMC_Glass_Frosted', 'red': 'FMC_Plastic_LED_Red', 'green': 'FMC_Plastic_LED_Green', 'ledblue': 'FMC_Plastic_LED_Blue',
    'rubber': 'FMC_Rubber_Black', 'copper': 'FMC_Metal_CopperTape_20x3', 'cubond': 'FMC_Metal_EarthRod_CopperBond', 'brass': 'FMC_Metal_Brass_Polished',
    'conc': 'FMC_Concrete_C25', 'pvframe': 'FMC_Metal_PVFrame_Aluminium', 'pv': 'FMC_Glass_PV_Module', 'gy': 'FMC_Plastic_CableCore_GreenYellow',
    'cable': 'FMC_Plastic_ArmouredCable_Black', 'castor': 'FMC_Plastic_Nylon_CastorGrey', 'china': 'FMC_Ceramic_VitreousChina_White',
    'struct': 'FMC_Metal_StructuralSteel_S275', 'conduit': 'FMC_Plastic_Conduit_White', 'tray': 'FMC_Metal_CableTray_Galvanised',
    # stand-ins until the kit has the right finish (see batches/E_electrical.materials_needed.json)
    # added to the kit on 17 Oct (second pass) at this batch's request
    'redsteel': 'FMC_Metal_Steel_Painted_Red', 'redabs': 'FMC_Plastic_ABS_Red', 'opal': 'FMC_Plastic_Diffuser_Opal',
    'screen': 'FMC_Glass_Display_Black', 'green_steel': 'FMC_Metal_Steel_Painted_Green', 'orange': 'FMC_Plastic_ABS_Orange',
}
NEEDED = []   # all six requests are in the kit since the second pass (17 Oct)

def ONLY(types, parts):
    """Per-type geometry: these parts show only in the listed types (compiler adds a Yes/No 'Show ...' parameter)."""
    for q in parts: q['only'] = list(types)
    return parts
def _rep(d, rep):
    if rep: d['repeat'] = {'n': rep[0], 'd': [rep[1], rep[2], rep[3]]}
    return d
def B(n, at, m, r=0, lod='mf', rep=None):
    d = {'n': n, 'shape': 'box', 'at': at, 'mat': m, 'lod': lod}
    if r: d['r'] = r
    return _rep(d, rep)
def F(n, at, m, r=0, lod='mf', rep=None):
    d = {'n': n, 'shape': 'fbox', 'at': at, 'mat': m, 'lod': lod}
    if r: d['r'] = r
    return _rep(d, rep)
def C(n, ax, c, r, rng, m, lod='mf', rep=None, seg=None):
    d = {'n': n, 'shape': 'cyl', 'axis': ax, 'c': c, 'r': r, ax: rng, 'mat': m, 'lod': lod}
    if seg: d['seg'] = seg
    return _rep(d, rep)
def T(n, ax, c, prof, m, lod='mf', rep=None, seg=None):
    d = {'n': n, 'shape': 'turn', 'axis': ax, 'c': c, 'profile': prof, 'mat': m, 'lod': lod}
    if seg: d['seg'] = seg
    return _rep(d, rep)
def FR(n, pts, y, m, lod='mf', rep=None): return _rep({'n': n, 'shape': 'front', 'pts': pts, 'y': y, 'mat': m, 'lod': lod}, rep)
def RT(n, pts, x, m, lod='mf', rep=None): return _rep({'n': n, 'shape': 'right', 'pts': pts, 'x': x, 'mat': m, 'lod': lod}, rep)
def PZ(n, pts, z, m, lod='mf', rep=None): return _rep({'n': n, 'shape': 'prism', 'pts': pts, 'z': z, 'mat': m, 'lod': lod}, rep)
def ring(r0, r1, t0, t1): return [[r0, t0], [r1, t0], [r1, t1], [r0, t1]]
def disc(r, t0, t1): return [[0, t0], [r, t0], [r, t1], [0, t1]]

def PWR(part, side='back', n='Power'): return {"n": n, "domain": "electrical", "system": "PowerBalanced", "part": part, "side": side}
def ELV(system, part, side='back', n=None): return {"n": n or system, "domain": "electrical", "system": system, "part": part, "side": side}
def etv(v, va, three=False, elev=None):
    d = {"Voltage": v, "Apparent Load": va}
    if three: d["Number of Poles"] = 3
    if elev is not None: d["Default Elevation"] = elev
    return d

P = []
def add(fam, desc, ifc, types, parts, values, about, tv=None, conns=(), clear=(), cat=None, template=None, view=None):
    rec = RECS[fam]
    used = []
    for p in parts:
        if p.get('mat') and p['mat'] not in used: used.append(p['mat'])
    prod = {"family": fam, "category": cat or rec['category'], "template": template or "Metric Generic Model.rft", "desc": desc, "ifc": ifc,
            "keynote": rec['kn'], "types": [], "type_values": dict(tv or {}), "materials": {k: MAT[k] for k in used},
            "reference": dict(rec['ref']), "parts": parts, "connectors": list(conns), "values": values,
            "about": about + " Generic product modelled as real parts (photo-to-family, 17 Oct); sizes assumed, brand and model open."}
    for t in types:
        if isinstance(t, str): prod['types'].append({"name": t})
        else: prod['types'].append({"name": t[0], "values": t[1]})
    if clear: prod['clearances'] = list(clear)
    if view: prod['view'] = view
    if not prod['type_values']: prod.pop('type_values')
    P.append(prod)

def plate(w=86, h=86, m='white', box_d=35, screws=True, sm=None):
    """Wall accessory: steel back box, moulded plate (front at y = -9.5), two fixing screws."""
    out = [B('Back Box', [-w / 2 + 3, 0, 3, w / 2 - 3, box_d, h - 3], 'steel'),
           F('Plate', [-w / 2, -7, 0, w / 2, 0, h], m, 4),
           F('Plate Face', [-w / 2 + 2, -9.5, 2, w / 2 - 2, -7, h - 2], m, 5, 'f')]
    if screws: out.append(C('Screw', 'y', [-w / 2 + 11, h / 2], 3.2, [-10.5, -9.5], sm or m, 'f', rep=(2, w - 22, 0, 0)))
    return out

def socket13(x0, m='white', mark='red'):
    """BS 1363 outlet at centre x0 on a twin plate (slots, rocker, rocker surround, mark)."""
    s = 'L' if x0 < 0 else 'R'
    return [FR(f'Earth Slot {s}', [[x0 - 2, 52], [x0 + 2, 52], [x0 + 2, 60], [x0 - 2, 60]], [-9.6, -6], 'black', 'f'),
            FR(f'Live Slot {s}', [[x0 + 7, 30], [x0 + 15, 30], [x0 + 15, 34], [x0 + 7, 34]], [-9.6, -6], 'black', 'f'),
            FR(f'Neutral Slot {s}', [[x0 - 15, 30], [x0 - 7, 30], [x0 - 7, 34], [x0 - 15, 34]], [-9.6, -6], 'black', 'f')]

def rocker(x, z, n, m='white', mark='red', w=10, h=20):
    return [F(f'Rocker Surround {n}', [x - w / 2 - 1, -10.5, z - h / 2 - 2, x + w / 2 + 1, -9.5, z + h / 2 + 2], m, 1.5, 'f'),
            F(f'Rocker {n}', [x - w / 2, -13, z - h / 2, x + w / 2, -10.5, z + h / 2], m, 1.5, 'f'),
            F(f'Rocker Mark {n}', [x - 2, -13.3, z + h / 2 - 6, x + 2, -13, z + h / 2 - 2], mark, 0, 'f')]

def cabinet_floor(x0, x1, D, H, m='epw', plinth=100, top=30):
    return [B('Plinth', [x0, -D, 0, x1, 0, plinth], 'steel'),
            B('Body', [x0, -D + 10, plinth, x1, 0, H], m),
            B('Top Cover', [x0 - 10, -D, H, x1 + 10, 10, H + top], m)]

def clear_front(x0, x1, D, H, depth=1000, sub='Clearance Maintenance', z0=0):
    return {"n": "Working Space", "shape": "box", "at": [x0, -D - depth, z0, x1, -D, z0 + H], "sub": sub}

# =============================================================== ELECTRICAL EQUIPMENT
# 1 Main LV switchboard: 4 sections x 800, 800 deep, 2200 high (incomer ACB, 2 MCCB outgoing sections, essential section)
p = cabinet_floor(-1600, 1600, 800, 2200)
p += [T('Lifting Eye', 'x', [-400, 2262], [[18, -1405], [30, -1405], [30, -1395], [18, -1395]], 'galv', 'f', rep=(4, 930, 0, 0)),
      F('Incomer Door', [-1595, -800, 110, -805, -790, 2190], 'epw', 4),
      F('Compartment Door A', [-795, -800, 115, -5, -790, 405], 'epw', 3, rep=(6, 0, 0, 300)),
      F('Compartment Door B', [5, -800, 115, 795, -790, 405], 'epw', 3, rep=(6, 0, 0, 300)),
      F('MCCB Handle A', [-430, -818, 230, -370, -800, 290], 'black', 6, 'f', rep=(6, 0, 0, 300)),
      F('MCCB Handle B', [370, -818, 230, 430, -800, 290], 'black', 6, 'f', rep=(6, 0, 0, 300)),
      F('Busbar Cover', [-795, -800, 1915, 795, -790, 2190], 'epw', 3),
      F('Essential Door', [805, -800, 110, 1595, -790, 2190], 'epw', 4),
      F('Essential Band', [815, -801, 2090, 1585, -800, 2160], 'redsteel', 0, 'f'),
      F('ACB Escutcheon', [-1460, -802, 880, -940, -800, 1320], 'steel', 6),
      F('ACB Fascia', [-1440, -812, 900, -960, -802, 1300], 'black', 4),
      F('ACB Charging Handle', [-1240, -840, 960, -1160, -812, 1100], 'grey', 6, 'f'),
      C('ACB On Button', 'y', [-1360, 1220], 16, [-820, -812], 'green', 'f'),
      C('ACB Off Button', 'y', [-1040, 1220], 16, [-820, -812], 'red', 'f'),
      F('Multifunction Meter', [-1320, -806, 1560, -1080, -800, 1760], 'screen', 4),
      C('Lamp L1', 'y', [-1300, 1850], 14, [-815, -800], 'red', 'f'),
      C('Lamp L2', 'y', [-1200, 1850], 14, [-815, -800], 'yellow', 'f'),
      C('Lamp L3', 'y', [-1100, 1850], 14, [-815, -800], 'ledblue', 'f'),
      F('Door Handle', [-875, -820, 1000, -855, -800, 1160], 'black', 6, 'f', rep=(2, 2400, 0, 0)),
      F('Vent Grille', [-1500, -801, 180, -900, -800, 330], 'steel', 3, 'f', rep=(4, 800, 0, 0)),
      F('Mimic Bus', [-1500, -802, 2030, 1500, -800, 2042], 'black', 0, 'f'),
      F('Mimic Drop', [-1206, -802, 1900, -1194, -800, 2030], 'black', 0, 'f', rep=(4, 800, 0, 0)),
      F('Section Label', [-1300, -802, 1970, -1100, -800, 2010], 'black', 0, 'f', rep=(4, 800, 0, 0)),
      F('Essential Meter', [1080, -806, 1560, 1320, -800, 1760], 'screen', 4),
      C('Essential Lamp', 'y', [1130, 1850], 14, [-815, -800], 'green', 'f', rep=(2, 140, 0, 0))]
add('FMC_E_EQ_MSB_LV_Main', 'Main LV switchboard, form 4, floor standing, 4 sections (ACB incomer, 2 MCCB outgoing, essential section), 3200 x 800 x 2200',
    'IfcElectricDistributionBoard', [('1600A_Form4', {"Apparent Load": 1150000}), ('2500A_Form4', {"Apparent Load": 1797000})], p,
    {"Board 3200 x 800 x 2200 mm": A("3200x800x2200", "typical 4-section form 4 board, supplier GA to confirm"),
     "Incomer 1600 A / 2500 A ACB": A("1600A/2500A", "type name; engineer sizes the incomer"), "Plinth 100 mm": A(100),
     "Front working space 1000 mm": A(1000, "BS 7671 / switchroom practice")},
    "Main switchboard: plinth, body, top cover, lifting eyes, ACB incomer door with ACB fascia, charging handle, on/off buttons, multifunction meter and phase lamps; two outgoing sections of six MCCB compartments with rotary handles; essential section with red identification band, meter and lamps; mimic bus, vent grilles, door handles.",
    tv=etv(415, 1150000, True), conns=[PWR('Body', 'top', 'Supply')], clear=[clear_front(-1600, 1600, 800, 2200)])

# 2 Essential MDB: 2 sections x 800, 600 deep, 2000 high, red identification
p = cabinet_floor(-800, 800, 600, 2000)
p += [F('Incomer Door', [-795, -600, 110, -5, -590, 1990], 'epw', 4),
      F('Outgoing Door', [5, -600, 110, 795, -590, 1990], 'epw', 4),
      F('Essential Band', [-785, -601, 1880, 785, -600, 1950], 'redsteel', 0, 'f'),
      F('Label Plate', [-200, -602, 1895, 200, -601, 1935], 'white', 0, 'f'),
      F('MCCB Escutcheon', [-600, -602, 900, -200, -600, 1250], 'steel', 4),
      F('Incomer MCCB', [-560, -612, 940, -240, -602, 1210], 'black', 4),
      F('Rotary Handle Base', [-450, -618, 1030, -350, -612, 1130], 'yellow', 6, 'f'),
      F('Rotary Handle', [-415, -640, 1000, -385, -618, 1160], 'redabs', 6, 'f'),
      F('Multifunction Meter', [-520, -606, 1500, -280, -600, 1700], 'screen', 4),
      C('Lamp L1', 'y', [-500, 1790], 14, [-615, -600], 'red', 'f'),
      C('Lamp L2', 'y', [-400, 1790], 14, [-615, -600], 'yellow', 'f'),
      C('Lamp L3', 'y', [-300, 1790], 14, [-615, -600], 'ledblue', 'f'),
      F('Door Window', [100, -601, 700, 700, -599, 1700], 'pc', 6, 'f'),
      F('Window Frame', [90, -600.5, 690, 710, -600, 1710], 'black', 8, 'f'),
      F('Outgoing MCCB Row', [130, -603, 1450, 670, -601, 1600], 'black', 3, 'f', rep=(3, 0, 0, -330)),
      F('MCCB Toggle', [170, -612, 1505, 200, -603, 1545], 'white', 2, 'f', rep=(8, 64, 0, 0)),
      F('Door Handle', [-75, -620, 900, -55, -600, 1060], 'black', 6, 'f'),
      F('Door Handle Right', [705, -620, 900, 725, -600, 1060], 'black', 6, 'f'),
      F('Hinge', [-795, -606, 300, -780, -600, 380], 'steel', 2, 'f', rep=(2, 0, 0, 1300)),
      F('Vent Grille', [-650, -601, 180, -150, -600, 300], 'steel', 3, 'f', rep=(2, 800, 0, 0)),
      F('Louvre Slat', [-645, -602, 195, -155, -601, 205], 'epw', 0, 'f', rep=(4, 0, 0, 25))]
add('FMC_E_EQ_MDB_Essential', 'Essential services main distribution board on the generator supply, floor standing, 2 sections, 1600 x 600 x 2000, red identification band',
    'IfcElectricDistributionBoard', [('400A_Essential', {"Apparent Load": 287000}), ('630A_Essential', {"Apparent Load": 453000})], p,
    {"Board 1600 x 600 x 2000 mm": A("1600x600x2000"), "Incomer 400 A / 630 A MCCB": A("400A/630A", "type name"),
     "Red identification for essential supply": A("red", "HTM 06-01 essential supply identification practice"), "Front working space 1000 mm": A(1000, "BS 7671 / practice")},
    "Essential MDB: plinth, body, two doors, red essential band with label plate, incomer MCCB with yellow/red rotary handle, meter and phase lamps; glazed outgoing door showing three MCCB rows with toggles; handles, hinges, louvred vents.",
    tv=etv(415, 287000, True), conns=[PWR('Body', 'top', 'Supply')], clear=[clear_front(-800, 800, 600, 2000)])

# 3 Final SPN DB: wall, 360 x 400 x 110, smoked window, 12 module row
p = [B('Enclosure', [-180, -100, 0, 180, 0, 400], 'epw', 6),
     F('Door', [-176, -110, 10, 176, -100, 390], 'epw', 6),
     F('Door Window', [-140, -111, 150, 140, -109, 300], 'pc', 6, 'f'),
     F('DIN Cover Strip', [-125, -108, 195, 125, -106, 255], 'white', 2, 'f'),
     F('MCB Toggle', [-118, -114, 215, -106, -108, 235], 'black', 1, 'f', rep=(8, 18, 0, 0)),
     *ONLY(['8way_SPN'], [F('Blank Strip', [26, -110, 210, 88, -108, 240], 'white', 1, 'f')]),
     *ONLY(['12way_SPN'], [F('MCB Toggle Extra', [26, -114, 215, 38, -108, 235], 'black', 1, 'f', rep=(4, 18, 0, 0))]),
     F('Main Switch Toggle', [92, -115, 212, 118, -108, 238], 'redabs', 2, 'f'),
     F('Circuit Chart Holder', [-120, -111, 60, 120, -110, 120], 'white', 3, 'f'),
     F('Door Catch', [150, -118, 180, 165, -110, 260], 'grey', 3, 'f'),
     C('Knockout', 'z', [-120, -55], 10, [400, 402], 'steel', 'f', rep=(5, 60, 0, 0)),
     C('Cover Screw', 'y', [-160, 375], 3.5, [-112, -110], 'chrome', 'f', rep=(2, 320, 0, 0)),
     F('Earth Symbol Label', [-25, -111, 330, 25, -110, 360], 'yellow', 2, 'f')]
add('FMC_E_EQ_DB_Final_SPN', 'Final distribution board SPN 240 V, surface metal enclosure, smoked window door, single DIN row, 100 A main switch',
    'IfcElectricDistributionBoard', [('8way_SPN', {"Apparent Load": 15000}), ('12way_SPN', {"Apparent Load": 23000})], p,
    {"Enclosure 360 x 400 x 110 mm": A("360x400x110"), "8 or 12 ways SPN, 100 A main switch": A("8/12 way", "type name"),
     "Mounting height 1400 mm (to bottom)": A(1400, "BS 7671 accessible height practice")},
    "SPN board: white steel enclosure, door with smoked window over the DIN cover strip and 8 MCB toggles plus blank (8way) or 12 toggles (12way), red main switch, circuit chart holder, catch, top knockouts, screws, label.",
    tv=etv(240, 15000, False, 1400), conns=[PWR('Enclosure', 'top', 'Supply')])

# 4 Essential DB red: wall, 450 x 650 x 150 TPN, red door
p = [B('Enclosure', [-225, -140, 0, 225, 0, 650], 'epw', 6),
     F('Door', [-215, -150, 15, 215, -140, 635], 'redsteel', 6),
     F('Door Window', [-170, -151, 300, 170, -149, 580], 'pc', 4, 'f'),
     F('Breaker Row', [-160, -149.5, 320, 160, -148, 370], 'white', 2, 'f', rep=(3, 0, 0, 85)),
     F('Breaker Toggle', [-150, -153, 335, -140, -149.5, 355], 'black', 1, 'f', rep=(12, 17, 0, 0)),
     F('Breaker Toggle Mid', [-150, -153, 420, -140, -149.5, 440], 'black', 1, 'f', rep=(12, 17, 0, 0)),
     *ONLY(['12way_TPN'], [F('Blank Strip', [54, -151, 330, 150, -149.5, 360], 'white', 1, 'f'),
                          F('Blank Strip Mid', [54, -151, 415, 150, -149.5, 445], 'white', 1, 'f')]),
     *ONLY(['18way_TPN'], [F('Breaker Toggle Extra', [54, -153, 335, 64, -149.5, 355], 'black', 1, 'f', rep=(6, 17, 0, 0)),
                          F('Breaker Toggle Mid Extra', [54, -153, 420, 64, -149.5, 440], 'black', 1, 'f', rep=(6, 17, 0, 0))]),
     F('Essential Label', [-110, -151, 590, 110, -150, 620], 'white', 3, 'f'),
     F('Main Switch', [-60, -153, 200, 60, -150, 280], 'grey', 4, 'f'),
     F('Main Switch Handle', [-15, -165, 225, 15, -153, 255], 'redabs', 3, 'f'),
     F('Handle', [185, -165, 290, 200, -150, 360], 'black', 4, 'f'),
     C('Lock Cylinder', 'y', [192, 390], 7, [-156, -150], 'chrome', 'f'),
     F('Hinge', [-222, -152, 100, -212, -140, 160], 'steel', 2, 'f', rep=(2, 0, 0, 380)),
     B('Gland Plate', [-180, -120, 650, 180, -20, 660], 'grey')]
add('FMC_E_EQ_DB_Essential_Red', 'Essential-supply distribution board TPN 415 V, surface, red door for identification, glazed, 100 A main switch',
    'IfcElectricDistributionBoard', [('12way_TPN', {"Apparent Load": 72000}), ('18way_TPN', {"Apparent Load": 72000})], p,
    {"Enclosure 450 x 650 x 150 mm": A("450x650x150", "same body as FMC_E_EQ_DB_Final_TPN"), "12 or 18 ways TPN": A("12/18 way", "type name"),
     "Red door, essential supply": A("red", "HTM 06-01 identification practice"), "Mounting height 1400 mm": A(1400)},
    "Essential board: white enclosure, red door with window, breaker rows with 12 or 18 toggles per row (blank strip on 12way), ESSENTIAL label, main switch with red handle, handle, lock, hinges, gland plate.",
    tv=etv(415, 72000, True, 1400), conns=[PWR('Enclosure', 'top', 'Supply')], clear=[clear_front(-225, 225, 150, 2000, 1000, z0=-1400)])

# 5 ATS panel: floor, 800 x 600 x 2000, controller, mimic, selector, e-stop, glazed lower door
p = cabinet_floor(-400, 400, 600, 2000)
p += [F('Control Door', [-395, -600, 1210, 395, -590, 1990], 'epw', 4),
      F('Switch Door', [-395, -600, 110, 395, -590, 1200], 'epw', 4),
      F('Controller Bezel', [-230, -603, 1560, 30, -600, 1800], 'black', 6),
      F('Controller Display', [-205, -605, 1640, 5, -603, 1780], 'screen', 3, 'f'),
      C('Controller Key', 'y', [-195, 1590], 8, [-609, -603], 'grey', 'f', rep=(6, 38, 0, 0)),
      F('Mimic Source A', [130, -601, 1840, 140, -600, 1930], 'black', 0, 'f'),
      F('Mimic Source B', [300, -601, 1840, 310, -600, 1930], 'black', 0, 'f'),
      F('Mimic Bus', [130, -601, 1830, 310, -600, 1840], 'black', 0, 'f'),
      F('Mimic Load', [215, -601, 1720, 225, -600, 1830], 'black', 0, 'f'),
      C('Lamp Mains', 'y', [135, 1945], 13, [-614, -600], 'green', 'f'),
      C('Lamp Generator', 'y', [305, 1945], 13, [-614, -600], 'yellow', 'f'),
      C('Lamp On Load', 'y', [220, 1700], 13, [-614, -600], 'red', 'f'),
      T('Selector Body', 'y', [-100, 1380], disc(30, -600, -608), 'black', 'f'),
      F('Selector Knob', [-108, -626, 1355, -92, -608, 1405], 'black', 3, 'f'),
      T('E-Stop Collar', 'y', [150, 1380], disc(35, -600, -612), 'yellow', 'f'),
      T('E-Stop Mushroom', 'y', [150, 1380], [[0, -612], [12, -612], [12, -625], [30, -628], [30, -640], [0, -644]], 'redabs', 'f'),
      F('Switch Window', [-250, -601, 450, 250, -599, 1050], 'pc', 6, 'f'),
      F('Changeover Switch', [-200, -598, 600, 200, -592, 900], 'black', 4, 'f'),
      F('Changeover Handle', [-20, -599, 680, 20, -598.5, 820], 'yellow', 2, 'f'),
      F('Door Handle', [325, -620, 700, 345, -600, 860], 'black', 6, 'f', rep=(2, 0, 0, 880)),
      F('Vent Grille', [-250, -601, 160, 250, -600, 300], 'steel', 3, 'f'),
      F('Louvre Slat', [-245, -602, 175, 245, -601, 185], 'epw', 0, 'f', rep=(4, 0, 0, 30)),
      F('Rating Plate', [-350, -601, 1250, -230, -600, 1310], 'chrome', 2, 'f')]
add('FMC_E_EQ_ATS_Panel', 'Automatic transfer switch panel, mains/generator changeover, floor standing 800 x 600 x 2000, controller and mimic',
    'IfcSwitchingDevice', [('400A_4P', {"Apparent Load": 287000}), ('630A_4P', {"Apparent Load": 453000})], p,
    {"Panel 800 x 600 x 2000 mm": A("800x600x2000"), "Rating 400 A / 630 A, 4-pole": A("400A/630A 4P", "type name"),
     "Transfer time under 10 s": A("10 s", "BS 7671 / HTM 06-01 essential supply practice")},
    "ATS panel: plinth, body, control door with controller bezel, display and keys, source mimic and lamps (mains, generator, on load), auto/manual selector, emergency stop; lower door with window over the changeover switch; handles, vents, rating plate.",
    tv=etv(415, 287000, True), conns=[PWR('Body', 'top', 'Mains'), PWR('Body', 'bottom', 'Generator')], clear=[clear_front(-400, 400, 600, 2000)])

# 6 Diesel standby generator in acoustic canopy on base tank; control end at x = -2500, length per rating
p = [F('Side Door', [-2100, -905, 600, -1200, -900, 2150], 'pcoat', 10, rep=(2, 1150, 0, 0)),
     F('Door Handle', [-1310, -925, 1250, -1290, -905, 1400], 'black', 4, 'f', rep=(2, 1150, 0, 0)),
     F('Door Hinge', [-2095, -910, 800, -2080, -905, 880], 'steel', 2, 'f', rep=(2, 1150, 0, 0)),
     F('Control Window', [-2350, -906, 1500, -2150, -905, 1800], 'pc', 6, 'f'),
     F('Controller', [-2330, -904, 1530, -2170, -903, 1770], 'screen', 4, 'f'),
     T('E-Stop', 'y', [-2250, 1350], [[0, 902], [30, 902], [30, 895], [0, 890]], 'redabs', 'f'),
     T('E-Stop Collar', 'y', [-2250, 1350], disc(40, 900, 903), 'yellow', 'f'),
     T('Lifting Eye', 'y', [-2300, 2420], ring(30, 45, -10, 10), 'galv', 'f'),
     C('Fuel Filler', 'y', [-2200, 300], 40, [-910, -880], 'black', 'f'),
     F('Cable Entry Plate', [-2400, -906, 460, -2000, -900, 560], 'steel', 4, 'f')]
for t, x1 in (('250kVA_Canopy', 1300), ('500kVA_Canopy', 2500), ('800kVA_Canopy', 3500)):
    k = t.split('kVA')[0]
    p += ONLY([t], [
        B(f'Base Frame {k}', [-2500, -900, 0, x1, 900, 150], 'struct'),
        B(f'Base Tank {k}', [-2400, -880, 150, x1 - 100, 880, 450], 'black', 20),
        B(f'Canopy {k}', [-2500, -900, 450, x1, 900, 2300], 'pcoat', 30),
        B(f'Roof {k}', [-2540, -940, 2300, x1 + 40, 940, 2360], 'pcoat', 30),
        B(f'Drip Tray Lip {k}', [-2500, -905, 150, x1, -900, 180], 'struct', 0, 'f'),
        F(f'Inlet Louvre {k}', [x1 - 1250, -906, 900, x1 - 150, -900, 2000], 'steel', 6),
        F(f'Louvre Blade {k}', [x1 - 1230, -912, 1050, x1 - 170, -906, 1100], 'pcoat', 0, 'f', rep=(3, 0, 0, 330)),
        RT(f'Radiator Louvre {k}', [[-750, 600], [750, 600], [750, 2150], [-750, 2150]], [x1, x1 + 6], 'steel'),
        RT(f'Radiator Blade {k}', [[-730, 760], [730, 760], [730, 800], [-730, 800]], [x1 + 6, x1 + 12], 'pcoat', 'f', rep=(3, 0, 0, 460)),
        C(f'Silencer {k}', 'x', [0, 2550], 180, [-1500, x1 - 1700], 'steel', seg=24),
        C(f'Silencer Saddle {k}', 'z', [-1300, 0], 60, [2360, 2400], 'struct', 'f', rep=(2, x1 - 600, 0, 0)),
        C(f'Exhaust Stack {k}', 'z', [x1 - 1700, 0], 90, [2550, 3100], 'steel'),
        T(f'Rain Cap {k}', 'z', [x1 - 1700, 0], [[0, 3100], [110, 3100], [110, 3115], [0, 3140]], 'steel', 'f'),
        T(f'Lifting Eye Rear {k}', 'y', [x1 - 200, 2420], ring(30, 45, -10, 10), 'galv', 'f')])
add('FMC_E_EQ_Generator_Diesel_Standby', 'Diesel standby generating set in acoustic canopy on a base day tank, 415 V 3-phase, radiator end louvre, roof silencer',
    'IfcElectricGenerator', [('250kVA_Canopy', {"Apparent Load": 250000}), ('500kVA_Canopy', {"Apparent Load": 500000}), ('800kVA_Canopy', {"Apparent Load": 800000})], p,
    {"Canopy length 3800 / 5000 / 6000 mm, 1800 x 2360 mm": A("3800/5000/6000x1800x2360", "typical canopy sets per rating; width and height kept common, supplier GA to confirm"),
     "Base tank 8 h at 75 % load": A("8 h", "HTM 06-01 practice, engineer confirms"), "Rating per type 250/500/800 kVA prime/standby": A("kVA", "type name"),
     "Access 1000 mm all round": A(1000, "maintenance practice")},
    "Generator set: base frame and day tank, acoustic canopy and roof, two side doors with handles and hinges, inlet louvre and radiator louvre with blades (length per rating), control window with controller, emergency stop, roof silencer with saddles, exhaust stack and rain cap, lifting eyes, fuel filler, cable entry.",
    tv=etv(415, 500000, True), conns=[PWR('Cable Entry Plate', 'back', 'Output')],
    clear=[{"n": "Access", "shape": "box", "at": [-3500, -1900, 0, 4500, 1900, 2400], "sub": "Clearance Maintenance"}])

# 7 Central UPS: UPS cabinet 600 + battery cabinet 800, 850 deep, 1900 high, dark
p = [B('UPS Cabinet', [-700, -850, 60, -100, 0, 1900], 'steel', 4),
     B('Battery Cabinet', [-100, -850, 60, 700, 0, 1900], 'steel', 4),
     C('Levelling Foot', 'z', [-660, -810], 20, [0, 60], 'black', 'f', rep=(4, 450, 0, 0)),
     C('Levelling Foot Rear', 'z', [-660, -40], 20, [0, 60], 'black', 'f', rep=(4, 450, 0, 0)),
     B('Plinth Skirt', [-700, -840, 20, 700, -10, 60], 'black'),
     F('UPS Door', [-695, -860, 70, -105, -850, 1890], 'steel', 6),
     F('Door Perforation', [-660, -861, 120, -140, -860, 1300], 'black', 4, 'f'),
     F('Perforation Rib', [-660, -862, 140, -140, -861, 152], 'steel', 0, 'f', rep=(14, 0, 0, 82)),
     F('Display Bezel', [-560, -864, 1480, -240, -860, 1700], 'black', 8),
     F('Touch Display', [-545, -866, 1500, -255, -864, 1680], 'screen', 4, 'f'),
     F('Status Bar', [-560, -864, 1730, -240, -860, 1745], 'green', 2, 'f'),
     C('Status LED', 'y', [-520, 1440], 5, [-866, -864], 'green', 'f', rep=(4, 30, 0, 0)),
     F('Battery Door', [-95, -860, 70, 695, -850, 1890], 'steel', 6),
     F('Battery Vent', [-40, -861, 150, 640, -860, 400], 'black', 4, 'f'),
     F('Battery Vent Rib', [-40, -862, 165, 640, -861, 175], 'steel', 0, 'f', rep=(5, 0, 0, 48)),
     F('Door Handle', [-150, -880, 900, -130, -860, 1080], 'chrome', 6, 'f', rep=(2, 790, 0, 0)),
     F('Rating Label', [200, -861, 1600, 450, -860, 1700], 'white', 2, 'f'),
     F('Top Vent', [-650, -800, 1900, -150, -50, 1905], 'black', 0, 'f')]
add('FMC_E_EQ_UPS_Central', 'Central online double-conversion UPS with matching battery cabinet, floor standing, 1400 x 850 x 1900, touch display',
    'IfcElectricFlowStorageDevice', [('60kVA_Online', {"Apparent Load": 60000}), ('120kVA_Online', {"Apparent Load": 120000})], p,
    {"UPS + battery cabinets 1400 x 850 x 1900 mm": A("1400x850x1900"), "Rating 60 / 120 kVA, 415 V in and out": A("kVA", "type name"),
     "Autonomy 10 min at full load": A("10 min", "design basis, engineer confirms"), "Front access 1000 mm": A(1000)},
    "Central UPS: UPS and battery cabinets on levelling feet and plinth skirt, perforated UPS door with ribs, display bezel with touch screen, status bar and LEDs, battery door with louvred vent, chrome handles, rating label, top vent.",
    tv=etv(415, 60000, True), conns=[PWR('UPS Cabinet', 'top', 'Input')], clear=[clear_front(-700, 700, 860, 1900)])

# 8 Rack UPS 10 kVA: 19" 3U power + 3U battery
p = [B('Power Module', [-220, -620, 140, 220, 0, 273], 'steel', 2),
     B('Battery Module', [-220, -620, 0, 220, 0, 133], 'steel', 2),
     F('Front Bezel', [-222, -640, 141, 222, -620, 272], 'black', 6),
     F('Battery Bezel', [-222, -640, 1, 222, -620, 132], 'black', 6),
     F('Rack Ear', [-241, -628, 0, -220, -623, 273], 'steel', 2, rep=(2, 461, 0, 0)),
     C('Rack Screw', 'y', [-232, 30], 3.5, [-631, -628], 'chrome', 'f', rep=(2, 463, 0, 0)),
     C('Rack Screw Upper', 'y', [-232, 243], 3.5, [-631, -628], 'chrome', 'f', rep=(2, 463, 0, 0)),
     F('LCD', [-60, -642, 190, 60, -640, 240], 'screen', 3, 'f'),
     F('LCD Window', [-65, -641, 185, 65, -640, 245], 'grey', 4, 'f'),
     C('Button', 'y', [90, 215], 6, [-645, -640], 'grey', 'f', rep=(3, 22, 0, 0)),
     C('Power Button', 'y', [-120, 215], 9, [-645, -640], 'grey', 'f'),
     C('Status LED', 'y', [-180, 230], 3, [-642, -640], 'green', 'f', rep=(3, 0, 0, -16)),
     F('Bezel Vent', [-200, -641, 155, -90, -640, 260], 'steel', 3, 'f'),
     F('Battery Vent', [-200, -641, 20, 200, -640, 110], 'steel', 3, 'f'),
     F('Vent Slot', [-195, -642, 30, 195, -641, 34], 'black', 0, 'f', rep=(10, 0, 0, 8)),
     F('Rear Terminal Block', [-150, 0, 160, 150, 15, 250], 'grey', 2, 'f')]
add('FMC_E_EQ_UPS_Rack', 'Rack-mount online UPS 10 kVA, 19 in, 3U power module and 3U battery module, LCD and status LEDs',
    'IfcElectricFlowStorageDevice', [('10kVA_Rack6U', {"Apparent Load": 10000})], p,
    {"19 in, 6U total (2 x 3U), 620 mm deep": A("482x267x640", "typical 10 kVA rack UPS"), "Rating 10 kVA, 240 V": A("10kVA", "type name"),
     "Autonomy 8 min at full load": A("8 min")},
    "Rack UPS: power and battery modules, black bezels, rack ears with screws, LCD in window, buttons, power button, status LEDs, vents with slots, rear terminal block.",
    tv=etv(240, 10000), conns=[PWR('Rear Terminal Block', 'back', 'Input')])

# 9 Medical IT (IPS) panel: wall, stainless front, 600 x 1000 x 250, insulation monitor, alarm indicators
p = [B('Cabinet', [-300, -250, 0, 300, 0, 1000], 'epw', 4),
     F('Door', [-295, -260, 5, 295, -250, 995], 'ss', 6),
     F('Monitor Bezel', [-200, -263, 700, 40, -260, 900], 'black', 6),
     F('Insulation Monitor Display', [-180, -265, 760, 20, -263, 880], 'screen', 3, 'f'),
     C('Monitor Key', 'y', [-170, 725], 7, [-268, -263], 'grey', 'f', rep=(5, 45, 0, 0)),
     F('Indicator Panel', [80, -263, 650, 250, -260, 920], 'white', 6),
     C('Lamp Normal', 'y', [165, 870], 14, [-275, -263], 'green', 'f'),
     C('Lamp Insulation Fault', 'y', [165, 800], 14, [-275, -263], 'yellow', 'f'),
     C('Lamp Overload', 'y', [165, 730], 14, [-275, -263], 'red', 'f'),
     C('Test Button', 'y', [120, 675], 11, [-272, -263], 'grey', 'f'),
     C('Mute Button', 'y', [210, 675], 11, [-272, -263], 'black', 'f'),
     F('Label Strip', [-200, -261, 940, 200, -260, 975], 'white', 2, 'f'),
     F('Louvre', [-200, -261, 60, 200, -260, 200], 'black', 4, 'f'),
     F('Louvre Blade', [-195, -263, 75, 195, -261, 85], 'ss', 0, 'f', rep=(5, 0, 0, 25)),
     F('Outgoing MCB Window', [-200, -261, 300, 200, -259, 560], 'pc', 4, 'f'),
     F('MCB Toggle', [-180, -262, 410, -168, -259.5, 440], 'black', 1, 'f', rep=(12, 30, 0, 0)),
     C('Lock', 'y', [270, 500], 8, [-266, -260], 'chrome', 'f'),
     F('Hinge', [-298, -262, 120, -288, -255, 200], 'ss', 2, 'f', rep=(2, 0, 0, 680)),
     B('Gland Plate', [-200, -200, -8, 200, -50, 0], 'steel', 0, 'f')]
add('FMC_E_EQ_IPS_Theatre_IT', 'Medical IT isolated power panel (HTM 06-01 group 2): isolating transformer, insulation monitor, alarm indicators, outgoing MCBs, stainless front, wall mounted 600 x 1000 x 250',
    'IfcElectricDistributionBoard', [('5kVA_IT', {"Apparent Load": 5000}), ('8kVA_IT', {"Apparent Load": 8000})], p,
    {"Panel 600 x 1000 x 250 mm": A("600x1000x250"), "Isolating transformer 5 / 8 kVA, 230 V IT": A("kVA", "type name; HTM 06-01 group 2"),
     "Insulation monitor alarm at 50 kOhm": A("50 kOhm", "IEC 61557-8 / BS 7671 710"), "Bottom at 600 mm": A(600)},
    "IPS panel: cabinet, stainless door, insulation monitor bezel with display and keys, indicator panel with normal/insulation fault/overload lamps, test and mute buttons, label strip, louvre, MCB window with toggles, lock, hinges, gland plate.",
    tv=etv(240, 5000, False, 600), conns=[PWR('Cabinet', 'top', 'Supply')])

# 10 Pad transformer: oil-filled ground mounted on plinth with radiators, conservator, bushings
p = [B('Plinth', [-1100, -900, 0, 1100, 900, 200], 'conc'),
     B('Skid', [-900, -500, 200, 900, -380, 300], 'struct', rep=(2, 0, 880, 0)),
     B('Tank', [-750, -450, 300, 750, 450, 1700], 'green_steel', 20),
     B('Tank Cover', [-780, -480, 1700, 780, 480, 1740], 'green_steel', 20),
     F('Radiator Fin', [-640, -760, 420, -610, -450, 1560], 'green_steel', 0, rep=(14, 92, 0, 0)),
     F('Radiator Fin Rear', [-640, 450, 420, -610, 760, 1560], 'green_steel', 0, rep=(14, 92, 0, 0)),
     B('Radiator Header', [-650, -760, 1560, 650, -450, 1600], 'green_steel', 0, 'f', rep=(2, 0, 1210, 0)),
     C('Conservator', 'x', [300, 2050], 170, [-600, 400], 'green_steel'),
     B('Conservator Bracket', [-450, 260, 1740, -400, 340, 1900], 'green_steel', 0, 'f', rep=(2, 650, 0, 0)),
     C('Breather', 'z', [500, 300], 30, [1880, 2050], 'pc', 'f'),
     T('HV Bushing', 'z', [-300, -200], [[0, 1740], [45, 1740], [45, 1780], [35, 1800], [45, 1820], [35, 1840], [45, 1860], [35, 1880], [45, 1900], [20, 1930], [10, 1990], [0, 1990]], 'china', rep=(3, 300, 0, 0)),
     T('LV Bushing', 'z', [-375, 150], [[0, 1740], [35, 1740], [35, 1800], [25, 1830], [12, 1880], [0, 1880]], 'china', rep=(4, 250, 0, 0)),
     F('Rating Plate', [-150, -451, 1200, 150, -450, 1400], 'chrome', 3, 'f'),
     T('Lifting Lug', 'x', [0, 1760], [[20, -760], [40, -760], [40, -740], [20, -740]], 'galv', 'f', rep=(2, 1500, 0, 0)),
     F('Earth Terminal', [500, -455, 420, 580, -450, 480], 'brass', 3, 'f'),
     C('Drain Valve', 'y', [-500, 380], 25, [-480, -450], 'brass', 'f'),
     C('Oil Level Gauge', 'x', [-300, 2100], 50, [-620, -600], 'chrome', 'f'),
     C('Thermometer Pocket', 'z', [500, -250], 25, [1740, 1800], 'chrome', 'f')]
add('FMC_E_EQ_Transformer_Pad', 'Ground-mounted oil-filled distribution transformer 11/0.415 kV on a concrete plinth: radiators, conservator, HV and LV bushings',
    'IfcTransformer', [('500kVA_11kV', {"Apparent Load": 500000}), ('1000kVA_11kV', {"Apparent Load": 1000000})], p,
    {"Envelope 2200 x 1800 x 2200 mm with plinth": A("2200x1800x2200", "typical 500-1000 kVA ONAN; utility (UMEME) GA governs"),
     "11 / 0.415 kV, Dyn11": A("11/0.415 kV", "UMEME distribution practice"), "Rating 500 / 1000 kVA": A("kVA", "type name"),
     "Clearance 1500 mm to fence": A(1500, "utility practice, to confirm")},
    "Transformer: concrete plinth, skids, tank and cover, front and rear radiator banks with headers, conservator on brackets with breather and oil gauge, three HV and four LV porcelain bushings, rating plate, lifting lugs, earth terminal, drain valve, thermometer pocket.",
    tv=etv(415, 500000, True), conns=[PWR('Tank Cover', 'top', 'LV Out')],
    clear=[{"n": "Fence Clearance", "shape": "box", "at": [-2600, -2400, 0, 2600, 2400, 2200], "sub": "Clearance Maintenance"}])

# 11 Intake meter cabinet: wall, 600 x 800 x 250, rain hood, 3 meter windows
p = [B('Cabinet', [-300, -250, 0, 300, 0, 800], 'epw', 4),
     B('Rain Hood', [-330, -300, 800, 330, 10, 830], 'epw', 0),
     F('Door', [-295, -260, 5, 295, -250, 795], 'epw', 6),
     F('Meter Window', [-260, -261, 450, 260, -259, 720], 'pc', 6, 'f'),
     *ONLY(['1-way_Intake'], [F('Meter Body 1', [-70, -268, 480, 70, -261, 700], 'mgrey', 6),
                             F('Meter LCD 1', [-50, -269, 620, 50, -268, 670], 'screen', 2, 'f'),
                             C('Meter Pulse LED 1', 'y', [0, 590], 4, [-269.5, -268], 'red', 'f')]),
     *ONLY(['3-way_Intake'], [F('Meter Body 3', [-230, -268, 480, -90, -261, 700], 'mgrey', 6, rep=(3, 165, 0, 0)),
                             F('Meter LCD 3', [-210, -269, 620, -110, -268, 670], 'screen', 2, 'f', rep=(3, 165, 0, 0)),
                             C('Meter Pulse LED 3', 'y', [-160, 590], 4, [-269.5, -268], 'red', 'f', rep=(3, 165, 0, 0))]),
     F('Cut-out Fuse', [-120, -258, 120, 120, -252, 300], 'black', 4, 'f'),
     F('Fuse Carrier', [-40, -265, 170, 40, -258, 260], 'grey', 4, 'f'),
     F('Hasp', [255, -275, 380, 280, -260, 430], 'chrome', 3, 'f'),
     F('Danger Label', [-80, -261, 330, 80, -260, 400], 'yellow', 3, 'f'),
     F('Vent', [-250, -261, 40, -50, -260, 90], 'black', 3, 'f'),
     B('Gland Plate', [-200, -200, -8, 200, -50, 0], 'steel', 0, 'f')]
add('FMC_E_EQ_MeterCabinet_Intake', 'Intake and metering cabinet, wall/plinth mounted 600 x 800 x 250, rain hood, meter viewing window, utility cut-out',
    'IfcElectricDistributionBoard', [('1-way_Intake', {"Number of Poles": 1, "Voltage": 240, "Apparent Load": 23000}), ('3-way_Intake', {"Apparent Load": 69000})], p,
    {"Cabinet 600 x 800 x 250 mm": A("600x800x250"), "1 or 3 meter ways": A("1/3 way", "type name; utility meters"),
     "Meter window at eye level, bottom at 1000 mm": A(1000, "utility reading practice")},
    "Meter cabinet: steel cabinet with rain hood, door with meter window, one or three meter bodies (per type) with LCD and pulse LED, utility cut-out with fuse carrier, padlock hasp, danger label, vent, gland plate.",
    tv=etv(415, 69000, True, 1000), conns=[PWR('Gland Plate', 'bottom', 'Supply')])

# 12 Solar inverter: wall, 600 x 700 x 250
p = [B('Mounting Bracket', [-250, -15, 150, 250, 0, 550], 'steel'),
     B('Body', [-300, -250, 0, 300, -15, 700], 'white', 20),
     F('Front Panel', [-280, -255, 380, 280, -250, 680], 'mgrey', 12),
     F('Display Band', [-200, -258, 520, 200, -255, 640], 'black', 10),
     F('LCD', [-170, -260, 545, 30, -258, 615], 'screen', 3, 'f'),
     C('Status LED', 'y', [80, 600], 6, [-260, -258], 'green', 'f'),
     C('Fault LED', 'y', [120, 600], 6, [-260, -258], 'red', 'f'),
     C('Comms LED', 'y', [160, 600], 6, [-260, -258], 'ledblue', 'f'),
     F('Heatsink Fin', [-322, -230, 60, -300, -35, 640], 'alu', 0, rep=(2, 622, 0, 0)),
     B('Heatsink Fin Back', [-322, -200, 60, 322, -175, 640], 'alu', 0, 'f', rep=(3, 0, 50, 0)),
     F('Vent Grille', [-200, -252, 80, 200, -250, 220], 'black', 8, 'f'),
     F('Vent Slat', [-195, -253, 92, 195, -252, 98], 'mgrey', 0, 'f', rep=(6, 0, 0, 20)),
     T('DC Switch', 'z', [200, -150], [[0, 0], [35, 0], [35, -15], [0, -15]], 'black'),
     F('DC Switch Handle', [185, -175, -40, 215, -125, -15], 'redabs', 3, 'f'),
     C('DC Connector', 'z', [-220, -150], 9, [-30, 0], 'black', 'f', rep=(6, 40, 0, 0)),
     C('AC Gland', 'z', [80, -150], 16, [-25, 0], 'grey', 'f'),
     C('Comms Gland', 'z', [130, -150], 10, [-20, 0], 'grey', 'f')]
add('FMC_E_EQ_Inverter_Solar', 'Grid-tie / hybrid solar inverter, 3-phase, wall mounted 600 x 700 x 250, LCD, DC isolator, finned heatsink',
    'IfcElectricFlowTreatmentDevice', [('10kW_3Ph', {"Apparent Load": 10000}), ('50kW_3Ph', {"Apparent Load": 50000})], p,
    {"Body 600 x 700 x 250 mm": A("600x700x250", "typical 10-50 kW string inverter; 50 kW body larger, supplier GA"), "Output 10 / 50 kW, 415 V": A("kW", "type name"),
     "Bottom at 1000 mm, 500 mm free space above and below": A(1000, "inverter installation practice")},
    "Inverter: wall bracket, body, front panel with display band, LCD and status/fault/comms LEDs, side and rear heatsink fins, vent grille with slats, DC isolator with red handle, DC connector row, AC and comms glands underneath.",
    tv=etv(415, 10000, True, 1000), conns=[PWR('AC Gland', 'bottom', 'AC Out')])

# 13 Battery bank: 3 LFP racks, each 600 x 600 x 2000, 10 modules + BMS
p = [B('Rack Frame', [-930, -600, 0, -330, 0, 2000], 'steel', 0, rep=(3, 630, 0, 0)),
     B('Rack Plinth', [-930, -600, 0, 960, 0, 60], 'black'),
     F('Module', [-910, -610, 100, -350, -600, 260], 'mgrey', 4, rep=(9, 0, 0, 178)),
     F('Module Rack 2', [-280, -610, 100, 280, -600, 260], 'mgrey', 4, rep=(9, 0, 0, 178)),
     F('Module Rack 3', [350, -610, 100, 910, -600, 260], 'mgrey', 4, rep=(9, 0, 0, 178)),
     F('Module Handle', [-900, -625, 150, -880, -610, 220], 'black', 4, 'f', rep=(9, 0, 0, 178)),
     F('Module Handle Rack 2', [-270, -625, 150, -250, -610, 220], 'black', 4, 'f', rep=(9, 0, 0, 178)),
     F('Module Handle Rack 3', [360, -625, 150, 380, -610, 220], 'black', 4, 'f', rep=(9, 0, 0, 178)),
     F('BMS Unit', [-910, -612, 1720, 910, -600, 1960], 'black', 6),
     F('BMS Display', [-200, -614, 1780, 100, -612, 1920], 'screen', 3, 'f'),
     C('BMS LED', 'y', [200, 1880], 6, [-615, -612], 'green', 'f', rep=(4, 40, 0, 0)),
     F('Breaker Handle', [600, -630, 1790, 640, -612, 1890], 'redabs', 4, 'f')]
add('FMC_E_EQ_BatteryBank', 'Lithium (LFP) battery bank 100 kWh, three 19 in racks of 9 modules with BMS and DC breaker',
    'IfcElectricFlowStorageDevice', [('100kWh_LFP', {"Apparent Load": 50000})], p,
    {"Envelope 1890 x 600 x 2000 mm": A("1890x600x2000", "typical 3-rack LFP bank"), "Energy 100 kWh, LFP": A("100kWh", "type name"),
     "Front access 1000 mm, ventilated room": A(1000, "battery room practice")},
    "Battery bank: three rack frames on a plinth, 27 battery modules with handles, BMS unit with display and LEDs, red DC breaker handle.",
    tv=etv(415, 50000, True), conns=[PWR('BMS Unit', 'top', 'DC Link')], clear=[clear_front(-930, 960, 625, 2000)])

# 14 Rotary isolator: wall IP66, 150 x 200 x 120
p = [B('Enclosure', [-75, -110, 0, 75, 0, 200], 'grey', 8),
     F('Cover', [-73, -120, 2, 73, -110, 198], 'grey', 8),
     F('Yellow Plate', [-45, -122, 60, 45, -120, 150], 'yellow', 6),
     T('Handle Boss', 'y', [0, 105], disc(26, -122, -130), 'redabs'),
     F('Handle Bar', [-9, -150, 65, 9, -130, 145], 'redabs', 6),
     F('Padlock Tab', [-6, -132, 40, 6, -122, 60], 'grey', 2, 'f'),
     F('ON Marker', [52, -121, 140, 60, -120, 150], 'black', 0, 'f'),
     F('OFF Marker', [52, -121, 60, 60, -120, 70], 'black', 0, 'f'),
     C('Cover Screw', 'y', [-60, 15], 3.5, [-122, -120], 'grey', 'f', rep=(2, 120, 0, 0)),
     C('Cover Screw Top', 'y', [-60, 185], 3.5, [-122, -120], 'grey', 'f', rep=(2, 120, 0, 0)),
     C('Cable Gland', 'z', [-30, -55], 12, [-22, 0], 'black', 'f', rep=(2, 60, 0, 0))]
add('FMC_E_EQ_Isolator_Rotary', 'Rotary equipment isolator, IP66, grey enclosure, red/yellow lockable handle',
    'IfcSwitchingDevice', [('20A_4P', {"Apparent Load": 14000}), ('32A_4P', {"Apparent Load": 23000}), ('63A_4P', {"Apparent Load": 45000})], p,
    {"Enclosure 150 x 200 x 120 mm": A("150x200x120", "typical 20-63 A IP66 isolator"), "Rating 20 / 32 / 63 A, 4-pole": A("A", "type name"),
     "Padlockable in OFF": A("lockable", "BS EN 60947-3 practice"), "Height 1500 mm": A(1500)},
    "Isolator: grey enclosure and cover, yellow plate, red handle boss and bar, padlock tab, ON/OFF markers, cover screws, cable glands.",
    tv=etv(415, 23000, True, 1500), conns=[PWR('Enclosure', 'back', 'Supply')])

# =============================================================== ELECTRICAL FIXTURES
# 15 Red essential socket (twin switched, red plate)
p = plate(146, 86, 'redabs', sm='redabs') + socket13(-36) + socket13(36) + rocker(-61, 65, 'L', 'redabs', 'white') + rocker(61, 65, 'R', 'redabs', 'white')
p.append(F('Essential Label', [-25, -9.8, 6, 25, -9.5, 16], 'white', 1, 'f'))
add('FMC_E_ElecFixture_Socket_13A_Essential_Red', 'Twin 13 A switched socket outlet, BS 1363, red plate for the essential (generator-backed) circuit, 146 x 86',
    'IfcOutlet', ['13A_TwinSwitched'], p,
    {"Plate 146 x 86 mm": A("146x86", "BS 4662 twin box / plate"), "Red identification for essential supply": A("red", "HTM 06-01 practice"),
     "Load 180 VA": A(180, "design allowance, engineer confirms"), "Height 450 mm (1000 mm at bedheads)": A(450)},
    "Red essential socket: steel box, red plate and face, two BS 1363 outlets with earth/live/neutral slots, rockers with white marks, screws, label strip.",
    tv=etv(240, 180, False, 450), conns=[PWR('Back Box')])

# 16 Medical IT socket: twin, white, green indicators per outlet, IT label
p = plate(146, 86, 'white') + socket13(-36) + socket13(36) + rocker(-61, 65, 'L') + rocker(61, 65, 'R')
p += [C('Indicator L', 'y', [-61, 22], 3.5, [-11, -9.5], 'green', 'f'), C('Indicator R', 'y', [61, 22], 3.5, [-11, -9.5], 'green', 'f'),
      F('IT Label', [-22, -9.9, 4, 22, -9.5, 18], 'ledblue', 1, 'f')]
add('FMC_E_ElecFixture_Socket_MedicalIT', 'Twin switched socket on the medical IT (isolated) supply, with neon/LED indicator per outlet and IT identification label',
    'IfcOutlet', ['13A_TwinIT'], p,
    {"Plate 146 x 86 mm": A("146x86"), "Indicator per outlet, IT label": A("indicator", "HTM 06-01 group 2 identification practice"),
     "Load 500 VA": A(500, "design allowance for theatre equipment"), "Height 1000 mm at pendant/wall": A(1000)},
    "IT socket: twin plate with BS 1363 outlets, rockers, green indicators and blue IT label strip, screws, steel box.",
    tv=etv(240, 500, False, 1000), conns=[PWR('Back Box')])

# 17 Floor box: recessed, 300 x 300 stainless lid at floor level
p = [B('Floor Box', [-140, -140, -95, 140, 140, -4], 'galv'),
     B('Trim Frame', [-155, -155, -4, 155, 155, 0], 'ss', 6),
     B('Lid', [-140, -140, -2, 140, 140, 3], 'ss', 4),
     B('Lid Tray Recess', [-125, -125, 3, 125, 125, 3.5], 'grey', 2, 'f'),
     B('Cable Flap', [-60, 125, 3, 60, 140, 5], 'black', 2, 'f', rep=(2, 0, -265, 0)),
     B('Lift Slot', [-20, -5, 3.5, 20, 5, 4], 'black', 2, 'f'),
     B('Socket Module', [-110, -40, -60, -10, 40, -10], 'white', 0, 'f', rep=(2, 120, 0, 0)),
     B('Data Module', [-30, 60, -60, 30, 100, -10], 'white', 0, 'f'),
     C('Lid Screw', 'z', [-135, -135], 3, [3, 4], 'ss', 'f', rep=(2, 270, 0, 0)),
     C('Lid Screw Rear', 'z', [-135, 135], 3, [3, 4], 'ss', 'f', rep=(2, 270, 0, 0)),
     C('Conduit Entry', 'x', [0, -60], 12.5, [140, 170], 'galv', 'f')]
add('FMC_E_ElecFixture_Socket_Floor_Box', 'Floor box 2-gang, recessed in screed, stainless trim and lid with cable exit flaps, twin power and data modules inside',
    'IfcOutlet', ['300x300_2Gang'], p,
    {"Lid 300 x 300 mm, box depth 95 mm": A("300x300x95", "typical 2-gang screed floor box"), "2 power + 2 data outlets": A("2-gang", "type name"),
     "Load 360 VA": A(360, "design allowance")},
    "Floor box: galvanised box, stainless trim, lid with recessed tray, two cable flaps, lift slot, corner screws, conduit entry; socket and data modules inside (Fine).",
    tv=etv(240, 360), conns=[PWR('Floor Box', 'bottom'), ELV('Data', 'Data Module', 'bottom')])

# 18 Industrial 32 A IEC 60309 interlocked switched socket
p = [B('Enclosure', [-75, -110, 0, 75, 0, 260], 'grey', 8),
     F('Switch Plate', [-45, -112, 160, 45, -110, 240], 'yellow', 6),
     T('Switch Boss', 'y', [0, 200], disc(22, -112, -120), 'redabs'),
     F('Switch Handle', [-8, -138, 168, 8, -120, 232], 'redabs', 5),
     *[q for t, m in (('32A_1P', 'blue'), ('32A_3P', 'redabs')) for q in ONLY([t], [
        T(f'Socket Body {t[4:]}', 'y', [0, 85], [[0, -110], [42, -110], [42, -150], [38, -160], [0, -160]], m),
        T(f'Socket Lid {t[4:]}', 'y', [0, 85], [[0, -160], [44, -160], [44, -170], [0, -172]], m),
        F(f'Lid Hinge {t[4:]}', [-20, -168, 128, 20, -150, 140], m, 4, 'f'),
        F(f'Lid Latch {t[4:]}', [-12, -175, 30, 12, -160, 45], m, 3, 'f')])],
     F('Rating Label', [-30, -111, 250, 30, -110, 256], 'white', 0, 'f'),
     C('Cover Screw', 'y', [-62, 12], 3.5, [-112, -110], 'grey', 'f', rep=(2, 124, 0, 0)),
     C('Cover Screw Top', 'y', [-62, 248], 3.5, [-112, -110], 'grey', 'f', rep=(2, 124, 0, 0)),
     C('Cable Gland', 'z', [0, -55], 14, [-25, 0], 'black', 'f')]
add('FMC_E_ElecFixture_Socket_Industrial_32A', 'Industrial interlocked switched socket IEC 60309, 32 A, IP44/IP67, wall mounted, rotary switch and flip lid',
    'IfcOutlet', [('32A_1P', {"Voltage": 240, "Number of Poles": 1, "Apparent Load": 7400}), ('32A_3P', {"Apparent Load": 23000})], p,
    {"Enclosure 150 x 260 x 170 mm": A("150x260x170"), "32 A, 1P+N+E (blue, 230 V) or 3P+N+E (red, 415 V)": A("32A", "IEC 60309 colour code: blue body on 1P, red on 3P (per type)"),
     "Height 1200 mm": A(1200)},
    "Industrial socket: grey enclosure, yellow switch plate with red rotary handle, angled IEC 60309 socket body with flip lid, hinge and latch, label, screws, gland.",
    tv=etv(415, 23000, True, 1200), conns=[PWR('Enclosure')])

# 19 Fused spur 13 A
p = plate() + [F('Fuse Carrier', [-26, -13, 50, 2, -9.5, 72], 'white', 2, 'f'),
               F('Fuse Carrier Slot', [-16, -13.3, 59, -8, -13, 63], 'black', 0, 'f'),
               F('FUSE Legend', [-24, -9.8, 74, 0, -9.5, 78], 'grey', 0, 'f'),
               C('Neon', 'y', [20, 30], 3.5, [-11, -9.5], 'red', 'f'),
               C('Flex Outlet', 'y', [0, 10], 5, [-11, -9.5], 'black', 'f')] + rocker(22, 60, 'S', 'white', 'red', 12, 22)
add('FMC_E_ElecFixture_FusedSpur', 'Switched fused connection unit 13 A, BS 1363-4, with neon and flex outlet, 86 x 86',
    'IfcSwitchingDevice', ['13A_SwitchedNeon'], p,
    {"Plate 86 x 86 mm": A("86x86", "BS 4662 single box"), "Fuse 13 A (BS 1362)": A("13A", "type name"), "Load 1000 VA": A(1000, "design allowance"),
     "Height 1000 mm": A(1000)},
    "Fused spur: plate with fuse carrier and slot, legend, red neon, flex outlet, double-pole rocker with mark, screws, steel box.",
    tv=etv(240, 1000, False, 1000), conns=[PWR('Back Box')])

# 20 Light switch: one plate, rockers per type (1G wide, 2G, 3G narrow, 4G 2 x 2 grid)
p = plate(sm='white')
p += ONLY(['10A_1G'], rocker(0, 43, '1G', 'white', 'grey', 26, 50))
p += ONLY(['10A_2G'], rocker(-14, 43, '2G L', 'white', 'grey', 22, 46) + rocker(14, 43, '2G R', 'white', 'grey', 22, 46))
p += ONLY(['10A_3G'], rocker(-21, 43, '3G L', 'white', 'grey', 15, 46) + rocker(0, 43, '3G M', 'white', 'grey', 15, 46) + rocker(21, 43, '3G R', 'white', 'grey', 15, 46))
p += ONLY(['10A_4G'], rocker(-13, 56, '4G TL', 'white', 'grey', 20, 20) + rocker(13, 56, '4G TR', 'white', 'grey', 20, 20)
                     + rocker(-13, 30, '4G BL', 'white', 'grey', 20, 20) + rocker(13, 30, '4G BR', 'white', 'grey', 20, 20))
add('FMC_E_ElecFixture_Switch_Light', 'Plate light switch 10 AX, 2-way, 86 x 86 white moulded; 1 to 4 gangs by type',
    'IfcSwitchingDevice', [('10A_1G', {}), ('10A_2G', {}), ('10A_3G', {}), ('10A_4G', {})], p,
    {"Plate 86 x 86 mm": A("86x86"), "10 AX, 2-way per gang": A("10AX", "BS EN 60669-1"), "Height 1000 mm": A(1000, "Approved Document M range")},
    "Light switch: plate, screws, steel box; rockers with surrounds and marks per type: 1G one wide, 2G two, 3G three narrow, 4G a 2 x 2 grid.",
    tv=etv(240, 0, False, 1000), conns=[PWR('Back Box')])

# 21 Dimmer
p = plate(sm='white') + [T('Knob Skirt', 'y', [0, 43], disc(19, -9.5, -12), 'white', 'f'),
                         T('Knob', 'y', [0, 43], [[0, -12], [16, -12], [16, -24], [13, -27], [0, -27]], 'white'),
                         F('Knob Pointer', [-1.5, -27.3, 47, 1.5, -27, 56], 'grey', 0, 'f'),
                         F('Scale Mark', [-25, -9.8, 62, -21, -9.5, 66], 'grey', 0, 'f'),
                         F('Scale Mark Max', [21, -9.8, 62, 25, -9.5, 66], 'grey', 0, 'f')]
add('FMC_E_ElecFixture_Switch_Dimmer', 'Rotary push-on/off LED dimmer, 1 gang, trailing edge, 86 x 86',
    'IfcSwitchingDevice', ['400W_1G'], p,
    {"Plate 86 x 86 mm, box 35 mm": A("86x86"), "LED load 5-150 W / 400 W incandescent": A("400W", "typical trailing-edge dimmer"), "Height 1000 mm": A(1000)},
    "Dimmer: plate, rotary knob with skirt and pointer, min/max marks, screws, steel box.",
    tv=etv(240, 0, False, 1000), conns=[PWR('Back Box')])

# 22 Nurse call bedhead unit, with pillow speaker in a holster
p = plate(146, 86, 'white', 35)
p += [T('Call Button Ring', 'y', [-40, 43], disc(20, -9.5, -11), 'yellow', 'f'),
      T('Call Button', 'y', [-40, 43], [[0, -11], [16, -11], [16, -18], [12, -21], [0, -21]], 'redabs'),
      C('Reassurance LED', 'y', [-40, 74], 3.5, [-11, -9.5], 'yellow', 'f'),
      C('Cancel Button', 'y', [5, 43], 11, [-15, -9.5], 'green'),
      F('Pillow Socket Bezel', [32, -11, 25, 62, -9.5, 61], 'grey', 4, 'f'),
      C('Pillow Socket', 'y', [47, 43], 9, [-15, -11], 'black', 'f'),
      F('Label Window', [-60, -10, 6, 60, -9.5, 16], 'pc', 1, 'f'),
      *ONLY(['146x86_WithPillow'], [F('Holster', [90, -30, 10, 150, 0, 110], 'white', 8),
      F('Pillow Speaker', [100, -45, 30, 140, -22, 190], 'white', 14),
      C('Pillow Call Button', 'y', [120, 160], 9, [-49, -45], 'redabs', 'f'),
      F('Pillow Grille', [108, -46, 60, 132, -45, 120], 'grey', 6, 'f'),
      C('Pillow Light Button', 'y', [120, 135], 6, [-48, -45], 'yellow', 'f'),
      C('Lead Drop', 'z', [120, -33], 4, [-80, 30], 'grey', 'f'),
      C('Lead Run', 'x', [-33, -80], 4, [47, 124], 'grey', 'f'),
      C('Lead Rise', 'z', [47, -33], 4, [-84, 43], 'grey', 'f'),
      C('Lead Plug', 'y', [47, 43], 7, [-33, -15], 'black', 'f')])]
add('FMC_E_ElecFixture_NurseCall_BedheadUnit', 'Nurse call bedhead unit: call button with reassurance LED, cancel, pillow speaker socket; pillow speaker handset in a holster',
    'IfcAlarm', [('146x86_Standard', {}), ('146x86_WithPillow', {})], p,
    {"Plate 146 x 86 mm": A("146x86"), "Call, cancel, reassurance LED, pillow socket": A("HTM 08-03", "HTM 08-03 bedhead call point"),
     "Height 1400 mm at bedhead": A(1400, "bedhead practice")},
    "Bedhead unit: plate with red call button on yellow ring, reassurance LED, green cancel, pillow socket with bezel, label window; holster with pillow speaker (call and light buttons, grille, lead) on the WithPillow type only.",
    tv={"Default Elevation": 1400}, conns=[ELV('NurseCall', 'Back Box')])

# 23 Ceiling pull cord with reset
p = [B('Ceiling Unit', [-43, -43, -40, 43, 43, 0], 'white', 6),
     B('Unit Cover', [-40, -40, -46, 40, 40, -40], 'white', 10, 'f'),
     C('Reset Button', 'z', [-18, 0], 8, [-50, -46], 'redabs', 'f'),
     C('Reassurance LED', 'z', [18, 0], 4, [-48, -46], 'yellow', 'f'),
     T('Cord Gland', 'z', [0, 18], [[0, -46], [6, -46], [4, -58], [0, -58]], 'white', 'f'),
     C('Pull Cord', 'z', [0, 18], 1.5, [-1700, -58], 'redabs', seg=8),
     T('Bangle Upper', 'z', [0, 18], [[17, -1012], [25, -1012], [25, -988], [17, -988]], 'orange'),
     T('Bangle Lower', 'z', [0, 18], [[17, -1712], [25, -1712], [25, -1688], [17, -1688]], 'orange'),
     T('Cord Toggle', 'z', [0, 18], [[0, -1715], [6, -1712], [6, -1688], [0, -1685]], 'redabs', 'f')]
add('FMC_E_ElecFixture_NurseCall_PullCord_Toilet', 'Assisted-toilet emergency pull cord, ceiling unit with reset button and reassurance LED, red cord with two bangles to 100 mm above floor',
    'IfcAlarm', ['86_CeilingPull'], p,
    {"Ceiling unit 86 x 86 mm": A("86x86"), "Bangles at 800-1000 mm and 100 mm above floor": A("bangles", "Approved Document M / BS 8300"),
     "Cord length 1700 mm (2400 ceiling)": A(1700, "set on site to ceiling height")},
    "Pull cord: ceiling unit and cover, red reset button, reassurance LED, cord gland, red cord, two bangles and end toggle hanging below the ceiling (z = 0).",
    conns=[ELV('NurseCall', 'Ceiling Unit', 'top')])

# 24 Over-door light: dual (red call / white or amber attack)
p = [F('Base', [-90, -30, 0, 90, 0, 70], 'white', 10),
     F('Base Rim', [-86, -33, 4, 86, -30, 66], 'white', 8, 'f'),
     *ONLY(['180x70_Single'], [T('Lens Single', 'y', [0, 35], [[0, -33], [28, -33], [28, -45], [22, -55], [12, -60], [0, -62]], 'red'),
                              T('Lens Ring Single', 'y', [0, 35], ring(28, 31, -33, -40), 'grey', 'f')]),
     *ONLY(['180x70_Dual'], [T('Lens Red', 'y', [-40, 35], [[0, -33], [28, -33], [28, -45], [22, -55], [12, -60], [0, -62]], 'red'),
                            T('Lens White', 'y', [40, 35], [[0, -33], [28, -33], [28, -45], [22, -55], [12, -60], [0, -62]], 'opal'),
                            T('Lens Ring', 'y', [-40, 35], ring(28, 31, -33, -40), 'grey', 'f', rep=(2, 80, 0, 0))]),
     F('Label', [-30, -34, 8, 30, -33, 18], 'grey', 2, 'f'),
     C('Screw', 'y', [-78, 35], 2.5, [-34, -33], 'white', 'f', rep=(2, 156, 0, 0))]
add('FMC_E_ElecFixture_NurseCall_OverDoorLight', 'Nurse call over-door indicator, dual lens (red call, white/amber attack), 180 x 70 base, above corridor door',
    'IfcAlarm', [('180x70_Single', {}), ('180x70_Dual', {})], p,
    {"Base 180 x 70 x 62 mm": A("180x70x62"), "Visible along the corridor, 360 deg lens": A("lens", "HTM 08-03"), "Height 2150 mm (door head + 50)": A(2150)},
    "Over-door light: base and rim, one red lens (Single) or red and white lenses (Dual) with grey rings, label, screws.",
    tv={"Default Elevation": 2150}, conns=[ELV('NurseCall', 'Base')])

def slab(s0, s1, o0, o1, A=(-235, 60), B=(-40, 180)):
    L = math.hypot(B[0] - A[0], B[1] - A[1]); d = ((B[0] - A[0]) / L, (B[1] - A[1]) / L); n = (-d[1], d[0])
    P = lambda s, o: [round(A[0] + d[0] * s + n[0] * o, 2), round(A[1] + d[1] * s + n[1] * o, 2)]
    return [P(s0, o0), P(s1, o0), P(s1, o1), P(s0, o1)]
# 25 Master station: desk console 300 x 240, tilted touch screen, handset
p = [PZ('Console Base', [[-170, -240], [170, -240], [170, 0], [-170, 0]], [0, 30], 'mgrey'),
     RT('Console Body', [[-235, 30], [0, 30], [0, 180], [-40, 180], [-235, 60]], [-170, 170], 'mgrey'),
     RT('Screen Bezel', slab(10, 219, 0, 4), [-120, 150], 'black'),
     RT('Touch Screen', slab(20, 209, 4, 5), [-110, 140], 'screen', 'f'),
     RT('Handset Cradle', [[-200, 30], [-20, 30], [-20, 110], [-200, 60]], [-230, -170], 'mgrey'),
     RT('Handset', [[-210, 64], [-10, 114], [-10, 134], [-210, 84]], [-220, -180], 'black'),
     C('Speaker Grille', 'z', [0, -20], 4, [180, 181], 'black', 'f', rep=(5, 0, 0, 0)),
     F('Speaker Slot', [-120, -20, 180, 120, -10, 181], 'black', 0, 'f', rep=(1, 0, 0, 0)),
     C('Call LED', 'x', [-230, 45], 4, [80, 82], 'red', 'f'),
     C('Foot', 'z', [-150, -220], 8, [-3, 0], 'rubber', 'f', rep=(2, 300, 0, 0)),
     C('Coiled Lead', 'x', [-120, 50], 6, [-180, -170], 'black', 'f')]
p = [q for q in p if q['n'] not in ('Speaker Grille',)]
p.append(B('Speaker Grille', [-120, -30, 180, 120, -8, 181], 'black', 3, 'f'))
p = [q for q in p if q['n'] != 'Speaker Slot']
p.append(C('Mute Button', 'z', [120, -200], 8, [30, 33], 'grey', 'f'))
add('FMC_E_ElecFixture_NurseCall_MasterStation', 'Nurse call master station, desk console with tilted touch screen, handset and speaker',
    'IfcCommunicationsAppliance', ['340x240_Desk'], p,
    {"Console 400 x 240 x 180 mm": A("400x240x180"), "Touch screen 10 in": A("10in"), "Desk mounting at nurse base": A("desk", "HTM 08-03")},
    "Master station: base, wedge body, tilted bezel and touch screen, handset in cradle with coiled lead, speaker grille, call LED, mute button, rubber feet.",
    conns=[ELV('NurseCall', 'Console Base')])

# 26 RJ45 data outlet, 2 angled shuttered ports
p = plate(sm='white')
for x, s, tl in ((0, 'C', ['86x86_1-port']), (-20, 'L', ['86x86_2-port']), (20, 'R', ['86x86_2-port'])):
    p += ONLY(tl, [F(f'Module {s}', [x - 13, -12, 28, x + 13, -9.5, 58], 'white', 2, 'f'),
          F(f'Port {s}', [x - 7.5, -12.2, 34, x + 7.5, -12, 48], 'black', 1, 'f'),
          F(f'Shutter {s}', [x - 7, -12.6, 46, x + 7, -12.2, 52], 'white', 1, 'f'),
          F(f'Port Key {s}', [x - 3, -12.3, 30, x + 3, -12, 34], 'black', 0, 'f')])
p += [F('Label Window', [-25, -10, 66, 25, -9.5, 76], 'pc', 1, 'f'), F('ID Icon', [-36, -10, 52, -32, -9.5, 56], 'ledblue', 0, 'f')]
add('FMC_E_ElecFixture_Data_Outlet_RJ45', 'Data outlet, 86 x 86 plate with angled shuttered Cat6A RJ45 modules and label window',
    'IfcOutlet', [('86x86_1-port', {}), ('86x86_2-port', {})], p,
    {"Plate 86 x 86 mm": A("86x86"), "Cat 6A RJ45, shuttered": A("Cat6A", "structured cabling practice, HTM 08-03"), "Height 450 mm / 1000 mm at desks": A(450)},
    "Data outlet: plate, one centred module (1-port) or two (2-port) with RJ45 ports, keyways and shutters, label window, ID icon, screws, steel box.",
    tv={"Default Elevation": 450}, conns=[ELV('Data', 'Back Box')])

# 27 Card reader with keypad, surface
p = [F('Back Plate', [-43, -8, 0, 43, 0, 130], 'black', 8),
     F('Reader Body', [-41, -26, 2, 41, -8, 128], 'black', 10),
     F('Glass Front', [-38, -27, 5, 38, -26, 125], 'screen', 8, 'f'),
     T('Read Zone Ring', 'y', [0, 100], ring(14, 18, -27, -28), 'ledblue', 'f'),
     F('Card Icon', [-8, -27.5, 94, 8, -27, 106], 'grey', 1, 'f'),
     F('Status LED Bar', [-20, -27.5, 76, 20, -27, 79], 'green', 1, 'f')]
for k in range(4):
    p.append(C(f'Key Row {k + 1}', 'y', [-18, 60 - k * 15], 4.5, [-28, -27], 'grey', 'f', rep=(3, 18, 0, 0)))
p.append(C('Tamper Screw', 'z', [0, -15], 2.5, [-1, 2], 'chrome', 'f'))
add('FMC_E_ElecFixture_AccessControl_CardReader', 'Access control proximity card reader with PIN keypad, surface mounted 86 x 130, glass front, LED ring',
    'IfcSensor', ['86x130_Surface'], p,
    {"Reader 86 x 130 x 27 mm": A("86x130x27"), "13.56 MHz + keypad, IP65": A("13.56MHz", "typical"), "Height 1050 mm": A(1050, "Approved Document M")},
    "Card reader: back plate, black body, glass front, blue read-zone ring, card icon, status LED bar, 3 x 4 keypad, tamper screw.",
    tv={"Default Elevation": 1050}, conns=[ELV('Security', 'Back Plate')])

# 28 Mag-lock 600 lb at door head (z = 0 = underside of head, y = 0 = frame face)
p = [B('Head Bracket', [-140, -60, -6, 140, 0, 0], 'alu'),
     B('Bracket Upstand', [-140, -6, -6, 140, 0, 40], 'alu', 0, 'f'),
     B('Magnet Body', [-125, -55, -48, 125, -6, -6], 'alu', 3),
     B('Magnet Face', [-120, -60, -45, 120, -55, -9], 'chrome', 1),
     B('End Cap', [-131, -55, -48, -125, -6, -6], 'black', 0, 'f', rep=(2, 256, 0, 0)),
     C('Status LED', 'y', [100, -27], 3, [-61, -55], 'red', 'f'),
     B('Armature Plate', [-90, -72, -45, 90, -60, -9], 'chrome', 2),
     C('Sex Bolt', 'y', [-50, -27], 5, [-80, -72], 'chrome', 'f', rep=(2, 100, 0, 0)),
     C('Armature Spacer', 'y', [0, -27], 7, [-80, -72], 'rubber', 'f'),
     C('Cable Entry', 'z', [-100, -30], 4, [0, 30], 'black', 'f')]
add('FMC_E_ElecFixture_AccessControl_MagLock', 'Electromagnetic lock 600 lb (270 kg), surface mounted at the door head with L-bracket and armature plate, LED status',
    'IfcActuator', ['600lb_12-24V'], p,
    {"Magnet 250 x 49 x 42 mm": A("250x49x42", "typical 600 lb mag-lock"), "Holding force 600 lb, 12/24 V DC": A("600lb", "type name"),
     "Fail-safe, released by fire alarm": A("fail-safe", "BS 7273-4")},
    "Mag-lock: L bracket on the head, aluminium magnet body with end caps and chrome face, status LED, armature plate with sex bolts and spacer, cable entry; underside of head at z = 0.",
    conns=[ELV('Security', 'Head Bracket', 'top')])

# 29 Door intercom panel (video), stainless
p = [B('Back Box', [-50, 0, 5, 50, 45, 245], 'steel'),
     F('Panel', [-55, -12, 0, 55, 0, 250], 'ss', 6),
     F('Rain Hood', [-55, -30, 240, 55, -12, 250], 'ss', 3),
     *ONLY(['110x250_Video'], [T('Camera Window', 'y', [0, 210], disc(14, -12, -14), 'screen'),
                              T('Camera Lens', 'y', [0, 210], disc(6, -14, -15), 'black', 'f'),
                              C('IR LED', 'y', [-22, 210], 3, [-13, -12], 'red', 'f', rep=(2, 44, 0, 0))]),
     *ONLY(['110x250_Audio'], [F('Blank Badge', [-25, -13, 195, 25, -12, 225], 'ss', 4, 'f')]),
     F('Speaker Slot', [-25, -13, 150, 25, -12, 154], 'black', 1, 'f', rep=(5, 0, 0, 8)),
     F('Name Window', [-38, -13, 90, 38, -12, 130], 'pc', 3, 'f'),
     T('Call Button', 'y', [0, 55], [[0, -12], [16, -12], [16, -16], [13, -19], [0, -19]], 'chrome'),
     T('Call Button Ring', 'y', [0, 55], ring(16, 19, -12, -14), 'ledblue', 'f'),
     C('Mic Hole', 'y', [0, 25], 1.5, [-13, -12], 'black', 'f'),
     C('Security Screw', 'y', [-45, 12], 2.5, [-13, -12], 'ss', 'f', rep=(2, 90, 0, 0))]
add('FMC_E_ElecFixture_Intercom_Door', 'Door entry intercom panel, stainless, camera with IR, speaker, name window, illuminated call button, rain hood',
    'IfcCommunicationsAppliance', [('110x250_Audio', {}), ('110x250_Video', {})], p,
    {"Panel 110 x 250 x 12 mm on flush box": A("110x250"), "Camera on video type": A("video", "type name"), "Call button at 1100 mm": A(1100, "Approved Document M")},
    "Intercom: back box, stainless panel with rain hood, camera window and lens with IR LEDs (Video) or blank badge (Audio), speaker slots, name window, illuminated call button, mic hole, security screws.",
    tv={"Default Elevation": 1000}, conns=[ELV('Communication', 'Back Box')])

# 30 Theatre clock + elapsed timer, 600 x 300
def digits(x0, z0, n, name):
    w, h, t, g = 22, 40, 4, 34
    return [F(f'{name} Seg Top', [x0 + 3, -21, z0 + h - t, x0 + w - 3, -20, z0 + h], 'red', 0, 'f', rep=(n, g, 0, 0)),
            F(f'{name} Seg Mid', [x0 + 3, -21, z0 + h / 2 - t / 2, x0 + w - 3, -20, z0 + h / 2 + t / 2], 'red', 0, 'f', rep=(n, g, 0, 0)),
            F(f'{name} Seg Bot', [x0 + 3, -21, z0, x0 + w - 3, -20, z0 + t], 'red', 0, 'f', rep=(n, g, 0, 0)),
            F(f'{name} Seg Left', [x0, -21, z0 + 3, x0 + t, -20, z0 + h - 3], 'red', 0, 'f', rep=(n, g, 0, 0)),
            F(f'{name} Seg Right', [x0 + w - t, -21, z0 + 3, x0 + w, -20, z0 + h - 3], 'red', 0, 'f', rep=(n, g, 0, 0))]
p = [F('Housing', [-300, -45, 0, 300, 0, 300], 'ss', 8),
     F('Display Window', [-270, -46, 150, 270, -45, 280], 'screen', 4),
     F('Elapsed Window', [-270, -46, 70, 270, -45, 140], 'screen', 4)]
p += digits(-100, 195, 6, 'Time')
p[3:] = [q for q in p[3:]]
p += [F('Elapsed Bar', [-200, -21, 95, 200, -20, 115], 'green', 2, 'f'),
      F('Label Time', [-260, -46, 255, -150, -45.5, 270], 'grey', 0, 'f'),
      F('Label Elapsed', [-260, -46, 120, -150, -45.5, 135], 'grey', 0, 'f'),
      C('Start Button', 'y', [-120, 35], 13, [-55, -45], 'green', 'f'),
      C('Stop Button', 'y', [-60, 35], 13, [-55, -45], 'redabs', 'f'),
      C('Reset Button', 'y', [0, 35], 13, [-55, -45], 'grey', 'f'),
      C('Set Button', 'y', [60, 35], 13, [-55, -45], 'grey', 'f')]
for q in p:   # digit segments sit on the display face
    if 'Seg' in q['n'] or q['n'] == 'Elapsed Bar': q['at'][1], q['at'][4] = -47, -46
add('FMC_E_ElecFixture_Clock_Theatre_Elapsed', 'Theatre clock and elapsed-time timer, stainless flush/surface panel 600 x 300 with LED digits and start/stop/reset buttons',
    'IfcCommunicationsAppliance', ['600x300_Wall'], p,
    {"Panel 600 x 300 x 45 mm": A("600x300x45"), "Digit height 40-50 mm, readable at 10 m": A("40mm"), "Synchronised to master clock": A("sync", "HTM 03-01 / theatre practice"),
     "Centre at 2000 mm": A(2000)},
    "Theatre clock: stainless housing, time and elapsed windows, six red seven-segment digits (time), green elapsed bar, labels, start/stop/reset/set buttons.",
    tv={"Default Elevation": 1850}, conns=[ELV('Communication', 'Housing')])

# 31 Patient TV on articulated arm
p = [F('Wall Plate', [-60, -15, 0, 60, 0, 200], 'white', 8),
     C('Wall Pivot', 'z', [0, -40], 25, [20, 180], 'white'),
     B('Arm 1', [-12, -340, 80, 12, -40, 120], 'mgrey', 10),
     C('Elbow', 'z', [0, -340], 25, [60, 140], 'white'),
     B('Arm 2', [-12, -620, 80, 12, -340, 120], 'mgrey', 10),
     C('Head Pivot', 'z', [0, -620], 22, [40, 160], 'white'),
     F('Tilt Bracket', [-60, -655, 40, 60, -640, 160], 'black', 4),
     B('Tilt Hub', [-15, -640, 85, 15, -620, 115], 'black', 4, 'f'),
     F('TV Back', [-260, -690, -60, 260, -655, 260], 'black', 10),
     F('TV Bezel', [-265, -700, -65, 265, -690, 265], 'black', 6),
     F('Screen', [-250, -702, -45, 250, -700, 245], 'screen', 2, 'f'),
     C('Power LED', 'y', [230, -57], 2, [-702, -700], 'red', 'f'),
     F('Handset', [270, -730, 20, 300, -705, 140], 'white', 8, 'f'),
     F('Handset Clip', [265, -705, 50, 300, -690, 110], 'grey', 3, 'f'),
     C('Cable Duct', 'z', [0, -8], 6, [-100, 0], 'white', 'f')]
add('FMC_E_ElecFixture_TV_Patient_Arm', 'Patient entertainment TV 22 in on a wall-mounted articulated arm, with handset and clip',
    'IfcAudioVisualAppliance', ['22in_Arm'], p,
    {"Screen 22 in (530 x 330 mm)": A("22in"), "Arm reach 700 mm": A(700), "Wall plate at 1700 mm": A(1700), "Load 40 VA": A(40)},
    "Patient TV: wall plate and pivot, two arm links with elbow and head pivot, tilt bracket and hub, TV back, bezel, screen, power LED, handset with clip, cable duct.",
    tv=etv(240, 40, False, 1700), conns=[PWR('Wall Plate'), ELV('Communication', 'Wall Plate', 'back', 'TV')])

# 32 HEPA hand dryer, hands-in blade type, 300 x 660 x 250
p = [F('Back Plate', [-150, -30, 0, 150, 0, 660], 'mgrey', 20),
     F('Upper Body', [-150, -250, 380, 150, -30, 660], 'ss', 40),
     F('Lower Body', [-150, -250, 0, 150, -30, 200], 'ss', 40),
     B('Side Cheek', [-150, -120, 200, -130, -30, 380], 'ss', 0, rep=(2, 280, 0, 0)),
     B('Air Blade Upper', [-120, -230, 374, 120, -100, 380], 'black', 3, 'f'),
     B('Air Blade Lower', [-120, -230, 200, 120, -100, 206], 'black', 3, 'f'),
     F('HEPA Cover', [-100, -252, 450, 100, -250, 620], 'mgrey', 10, 'f'),
     C('Status LED', 'y', [0, 420], 5, [-253, -250], 'ledblue', 'f'),
     F('Inlet Grille', [-100, -252, 30, 100, -250, 150], 'black', 10, 'f'),
     F('Grille Bar', [-95, -253, 45, 95, -252, 49], 'ss', 0, 'f', rep=(8, 0, 0, 13)),
     C('Security Screw', 'y', [-120, 640], 3, [-252, -250], 'chrome', 'f', rep=(2, 240, 0, 0))]
add('FMC_E_ElecFixture_HandDryer_HEPA', 'Hands-in blade hand dryer with HEPA filter, stainless, 300 x 660 x 250 (public toilets only)',
    'IfcElectricAppliance', ['300x660_HEPA'], p,
    {"Dryer 300 x 660 x 250 mm": A("300x660x250", "typical hands-in blade dryer"), "Power 1600 W, dry time 10-12 s": A(1600),
     "HEPA H13 filter": A("H13"), "Hand cavity at 950-1100 mm": A(800, "mounting height to bottom, BS 8300")},
    "Hand dryer: back plate, stainless upper and lower bodies joined by side cheeks around an open hand cavity, upper and lower air blades, HEPA cover, LED, inlet grille with bars, screws.",
    tv=etv(240, 1600, False, 800), conns=[PWR('Back Plate')])

# 33 Adaptable junction box, galvanised, conduit spouts; box size per type, bottom spout shared
p = [C('Spout Bottom', 'z', [0, -25], 12.5, [-25, 0], 'galv'),
     C('Conduit Stub Bottom', 'z', [0, -25], 10, [-100, -25], 'conduit', 'f')]
for t, a in (('75x75_Galv', 37.5), ('100x100_Galv', 50)):
    k = t.split('_')[0]
    p += ONLY([t], [B(f'Box {k}', [-a, -50, 0, a, 0, 2 * a], 'galv'),
                    F(f'Lid {k}', [-a - 3, -55, -3, a + 3, -50, 2 * a + 3], 'galv', 3),
                    C(f'Lid Screw {k}', 'y', [-a + 6, 6], 3, [-56, -55], 'chrome', 'f', rep=(2, 2 * a - 12, 0, 0)),
                    C(f'Lid Screw Top {k}', 'y', [-a + 6, 2 * a - 6], 3, [-56, -55], 'chrome', 'f', rep=(2, 2 * a - 12, 0, 0)),
                    C(f'Spout Top {k}', 'z', [0, -25], 12.5, [2 * a, 2 * a + 25], 'galv'),
                    C(f'Conduit Stub Top {k}', 'z', [0, -25], 10, [2 * a + 25, 2 * a + 100], 'conduit', 'f'),
                    C(f'Spout Side {k}', 'x', [-25, a], 12.5, [a, a + 25], 'galv', 'f'),
                    C(f'Knockout {k}', 'x', [-25, a], 10, [-a - 1, -a], 'galv', 'f'),
                    C(f'Earth Terminal {k}', 'y', [0, a], 4, [-2, 0], 'brass', 'f')])
add('FMC_E_ElecFixture_JunctionBox', 'Adaptable junction box, galvanised steel, screwed lid, 20 mm conduit spouts',
    'IfcJunctionBox', [('75x75_Galv', {}), ('100x100_Galv', {})], p,
    {"Box 75 x 75 or 100 x 100, 50 mm deep (per type)": A("75x75/100x100x50", "BS EN 60670"), "20 mm conduit entries": A(20)},
    "Junction box: galvanised box, lid with four screws, top/bottom/side spouts with conduit stubs, knockout, earth terminal.",
    tv=etv(240, 0), conns=[PWR('Spout Bottom', 'bottom')])

# =============================================================== COMMUNICATION / SECURITY
# 34 Wi-Fi AP ceiling
p = [T('Mount Plate', 'z', [0, 0], disc(70, -8, 0), 'grey'),
     T('AP Body', 'z', [0, 0], [[0, -42], [95, -42], [108, -36], [110, -24], [108, -12], [100, -8], [0, -8]], 'white'),
     T('Status Ring', 'z', [0, 0], ring(18, 22, -43, -42), 'ledblue', 'f'),
     T('Centre Badge', 'z', [0, 0], disc(10, -43, -42), 'grey', 'f'),
     B('T-Bar Clip', [-90, -12, -4, 90, 12, 0], 'galv', 0, 'f'),
     C('Security Slot', 'z', [80, 0], 4, [-38, -30], 'black', 'f'),
     B('Kensington Tab', [104, -6, -30, 112, 6, -18], 'grey', 0, 'f')]
add('FMC_E_Comms_WiFi_AccessPoint', 'Wi-Fi 6 access point, ceiling mounted, 220 mm disc with status ring', 'IfcCommunicationsAppliance', ['220_Ceiling'], p,
    {"Disc 220 x 42 mm": A("220x42"), "Wi-Fi 6, PoE+": A("802.11ax PoE+"), "One per 2-4 bays, survey confirms": A("survey", "wireless survey")},
    "Access point: mounting plate and T-bar clip above, domed white body, blue status ring, centre badge, security slot and lock tab; hangs below the ceiling (z = 0).",
    conns=[ELV('Data', 'Mount Plate', 'top')])

# 35 Comms rack: 24U (1200) or 42U (2000) carcass per type, open sides drawn as panels so the kit shows through the glass
p = [B('Plinth', [-300, -800, 40, 300, 0, 100], 'black'),
     C('Castor', 'z', [-250, -750], 25, [0, 40], 'castor', 'f', rep=(2, 500, 0, 0)),
     C('Castor Rear', 'z', [-250, -50], 25, [0, 40], 'castor', 'f', rep=(2, 500, 0, 0)),
     F('Patch Panel', [-240, -790, 1000, 240, -780, 1044], 'grey', 0, 'f', rep=(2, 0, 0, -120)),
     F('Patch Port Row', [-225, -791, 1015, 225, -790, 1030], 'black', 0, 'f', rep=(2, 0, 0, -120)),
     F('Cable Manager', [-240, -795, 1046, 240, -780, 1080], 'black', 0, 'f', rep=(2, 0, 0, -120)),
     F('Switch', [-240, -790, 700, 240, -760, 744], 'mgrey', 2, 'f', rep=(2, 0, 0, -60)),
     F('Switch LEDs', [-200, -791, 725, 160, -790, 730], 'green', 0, 'f', rep=(2, 0, 0, -60)),
     F('Server', [-240, -790, 400, 240, -770, 488], 'black', 2, 'f', rep=(2, 0, 0, -100)),
     F('Server Bezel', [-230, -791, 410, 230, -790, 478], 'steel', 2, 'f', rep=(2, 0, 0, -100)),
     F('PDU Strip', [-240, -790, 150, 240, -770, 194], 'black', 0, 'f')]
for t, H in (('24U_600x800', 1200), ('42U_600x800', 2000)):
    k = t[:3]
    p += ONLY([t], [B(f'Side Panel {k}', [-300, -800, 100, -285, 0, H], 'black', 0, rep=(2, 585, 0, 0)),
                    B(f'Back Panel {k}', [-285, -15, 100, 285, 0, H], 'black'),
                    B(f'Roof {k}', [-300, -800, H, 300, 0, H + 40], 'black'),
                    C(f'Roof Fan {k}', 'z', [-130, -400], 60, [H + 40, H + 45], 'grey', 'f', rep=(2, 260, 0, 0)),
                    F(f'Door Stile {k}', [-298, -815, 110, -270, -800, H - 10], 'black', 0, rep=(2, 568, 0, 0)),
                    F(f'Door Top Rail {k}', [-270, -815, H - 40, 270, -800, H - 10], 'black', 0),
                    F(f'Door Bottom Rail {k}', [-270, -815, 110, 270, -800, 140], 'black', 0),
                    F(f'Door Glass {k}', [-270, -812, 140, 270, -810, H - 40], 'glass', 0),
                    F(f'Door Handle {k}', [240, -840, H / 2 - 100, 258, -815, H / 2 + 100], 'chrome', 4, 'f'),
                    F(f'Rail {k}', [-252, -795, 120, -240, -780, H - 20], 'galv', 0, 'f', rep=(2, 492, 0, 0))])
p += ONLY(['42U_600x800'], [F('Patch Panel Upper', [-240, -790, 1800, 240, -780, 1844], 'grey', 0, 'f', rep=(2, 0, 0, -120)),
                            F('Patch Port Row Upper', [-225, -791, 1815, 225, -790, 1830], 'black', 0, 'f', rep=(2, 0, 0, -120)),
                            F('Cable Manager Upper', [-240, -795, 1846, 240, -780, 1880], 'black', 0, 'f', rep=(2, 0, 0, -120))])
add('FMC_E_Comms_Rack_Comms', 'Floor-standing 19 in comms rack 600 x 800, glass front door, roof fans, castors and plinth; patch panels, switches and servers shown',
    'IfcCommunicationsAppliance', [('24U_600x800', {}), ('42U_600x800', {})], p,
    {"Rack 600 x 800, 1240 high (24U) or 2040 high (42U)": A("600x800x1240/2040"), "Front 1000 mm, rear 750 mm access": A(1000, "TIA-942 / practice"),
     "Load 2000 VA": A(2000, "design allowance")},
    "Comms rack: plinth, castors; per type (24U/42U) side and back panels, roof with fans, glass door with stiles, rails and handle, 19 in rails; patch panels with port rows and cable managers (two more on 42U), two switches with LEDs, two servers with bezels, PDU.",
    tv=etv(240, 2000), conns=[PWR('Plinth', 'bottom'), ELV('Data', 'Plinth', 'bottom', 'Data')], clear=[clear_front(-300, 300, 815, 2040)])

# 36 PA ceiling speaker, recessed, fire dome
p = [T('Grille Rim', 'z', [0, 0], [[85, -8], [100, -8], [100, 0], [85, 0]], 'white'),
     T('Grille', 'z', [0, 0], disc(85, -5, -2), 'white'),
     T('Grille Ring', 'z', [0, 0], ring(16, 19, -5.5, -5), 'grey', 'f', rep=(4, 0, 0, 0)),
     T('Fire Dome', 'z', [0, 0], [[0, 0], [90, 0], [90, 60], [70, 110], [0, 125]], 'steel'),
     B('Terminal Block', [-20, 85, 20, 20, 110, 50], 'china', 0, 'f'),
     B('Spring Clip', [-6, -98, 0, 6, -88, 60], 'galv', 0, 'f', rep=(2, 0, 186, 0)),
     B('Transformer Tap', [80, -15, 40, 100, 15, 70], 'black', 0, 'f')]
p[2] = T('Grille Ring 1', 'z', [0, 0], ring(25, 28, -5.5, -5), 'grey', 'f')
p.insert(3, T('Grille Ring 2', 'z', [0, 0], ring(45, 48, -5.5, -5), 'grey', 'f'))
p.insert(4, T('Grille Ring 3', 'z', [0, 0], ring(65, 68, -5.5, -5), 'grey', 'f'))
p.insert(5, T('Grille Centre', 'z', [0, 0], disc(10, -5.5, -5), 'grey', 'f'))
add('FMC_E_Comms_PA_Speaker_Ceiling', 'PA / voice alarm ceiling speaker 6 W, recessed, 200 mm grille, steel fire dome, ceramic terminal block (BS 5839-8)',
    'IfcAudioVisualAppliance', ['6W_100V'], p,
    {"Grille 200 mm, cut-out 175 mm": A("200/175"), "6 W at 100 V line": A("6W", "type name"), "Fire dome and ceramic terminal, BS EN 54-24": A("EN54-24", "voice alarm practice")},
    "Ceiling speaker: grille rim and perforated grille with rings, fire dome and ceramic terminal block above the ceiling, spring clips, transformer taps.",
    conns=[ELV('Communication', 'Fire Dome', 'top')])

# 37 CCTV dome
p = [T('Base', 'z', [0, 0], [[0, -30], [70, -30], [75, -20], [75, 0], [0, 0]], 'white'),
     T('Dome Bubble', 'z', [0, 0], [[55, -30], [55, -45], [48, -60], [36, -72], [20, -79], [0, -81], [0, -30]], 'pc'),
     T('Camera Ball', 'z', [0, 0], [[0, -32], [40, -32], [40, -50], [32, -62], [18, -70], [0, -72]], 'black', 'f'),
     C('Lens', 'y', [0, -58], 9, [-38, -30], 'screen', 'f'),
     C('IR LED', 'y', [-16, -58], 3, [-36, -32], 'red', 'f', rep=(2, 32, 0, 0)),
     T('Trim Ring', 'z', [0, 0], ring(55, 72, -31, -30), 'grey', 'f'),
     C('Cable Entry', 'z', [40, 0], 6, [0, 15], 'black', 'f')]
p[3] = C('Lens', 'y', [0, -56], 10, [-44, -36], 'screen', 'f'); p[4] = C('IR LED', 'y', [-18, -56], 3, [-40, -36], 'red', 'f', rep=(2, 36, 0, 0))
add('FMC_E_SecurityDevice_CCTV_Camera_Dome', 'IP dome camera, ceiling surface mount, vandal-resistant 150 mm dome, IR', 'IfcSensor', ['150_Ceiling'], p,
    {"Dome 150 mm dia x 81 mm": A("150x81"), "4 MP, IR 30 m, IK10, PoE": A("4MP IK10"), "Coverage per security survey": A("survey")},
    "Dome camera: base, trim ring, clear bubble, camera ball with lens and IR LEDs, cable entry; hangs below the ceiling (z = 0).",
    conns=[ELV('Security', 'Base', 'top')])

# 38 CCTV bullet, wall
p = [T('Wall Base', 'y', [0, 0], [[0, 0], [50, 0], [50, -12], [20, -20], [0, -20]], 'white'),
     C('Arm', 'y', [0, 0], 12, [-80, -20], 'white'),
     T('Ball Joint', 'y', [0, 0], [[0, -70], [14, -72], [18, -80], [14, -88], [0, -90]], 'white', 'f'),
     C('Bracket', 'z', [0, -88], 10, [0, 30], 'white'),
     C('Body', 'y', [0, 40], 40, [-260, -60], 'white'),
     B('Sun Shield', [-46, -290, 70, 46, -60, 86], 'white', 8),
     T('Front Ring', 'y', [0, 40], ring(34, 40, -260, -265), 'grey', 'f'),
     T('Front Glass', 'y', [0, 40], disc(34, -260, -261), 'screen', 'f'),
     T('Lens', 'y', [0, 40], disc(12, -261, -262), 'black', 'f'),
     C('IR LED', 'y', [-22, 40], 4, [-262, -261], 'red', 'f', rep=(2, 44, 0, 0)),
     C('Cable Tail', 'y', [0, 10], 4, [-80, -60], 'black', 'f')]
add('FMC_E_SecurityDevice_CCTV_Camera_Bullet', 'IP bullet camera, wall mounted on bracket with sun shield and IR', 'IfcSensor', ['80x280_Wall'], p,
    {"Body 80 dia x 280 mm, sun shield": A("80x280"), "4 MP, IR 50 m, IP67, PoE": A("4MP IP67"), "Height 2700-3000 mm": A(2700)},
    "Bullet camera: round wall base, arm, ball joint and bracket, cylindrical body, sun shield, front ring and glass with lens and IR LEDs, cable tail.",
    tv={"Default Elevation": 2700}, conns=[ELV('Security', 'Wall Base')])

# =============================================================== LIGHTING
# 39 Cleanroom IP65 panel, flanged recessed; 600 x 600 or 1200 x 600 per type, driver shared
p = [B('Driver Box', [-120, -50, 80, 120, 50, 120], 'steel'),
     C('Cable Gland', 'x', [0, 100], 8, [120, 140], 'black', 'f')]
for t, X in (('600x600_IP65', 300), ('1200x600_IP65', 600)):
    k = t[:4] if X == 300 else t[:5]
    Y = 300
    p += ONLY([t], [B(f'Flange {k}', [-X - 10, -Y - 10, -12, X + 10, Y + 10, 0], 'epw', 4),
                    B(f'Gasket {k}', [-X, -Y, -13, X, Y, -12], 'rubber', 0, 'f'),
                    B(f'Diffuser {k}', [-X + 20, -Y + 20, -14, X - 20, Y - 20, -12.5], 'opal', 3),
                    B(f'Body {k}', [-X + 10, -Y + 10, 0, X - 10, Y - 10, 80], 'epw'),
                    B(f'LED Board {k}', [-X + 40, -Y + 40, 20, X - 40, Y - 40, 25], 'grey', 0, 'f'),
                    C(f'Retaining Screw {k}', 'z', [-X + 2, -Y + 2], 4, [-15, -12], 'ss', 'f', rep=(3, X - 2, 0, 0)),
                    C(f'Retaining Screw Rear {k}', 'z', [-X + 2, Y - 2], 4, [-15, -12], 'ss', 'f', rep=(3, X - 2, 0, 0)),
                    C(f'Retaining Screw Side {k}', 'z', [-X + 2, 0], 4, [-15, -12], 'ss', 'f', rep=(2, 2 * X - 4, 0, 0)),
                    B(f'Suspension Lug {k}', [-X, -20, 60, -X + 10, 20, 80], 'galv', 0, 'f', rep=(2, 2 * X - 10, 0, 0))])
add('FMC_E_LightFixture_Panel_600_Cleanroom_IP65', 'Sealed IP65 cleanroom LED panel, flanged, front-maintained, gasketed opal diffuser, stainless retaining screws',
    'IfcLightFixture', [('600x600_IP65', {"Apparent Load": 40}), ('1200x600_IP65', {"Apparent Load": 60})], p,
    {"Flange 620 x 620 or 1220 x 620 mm, body 80 mm": A("620x620x80 / 1220x620x80", "per type"), "IP65 room side, 40 W, 4000 lm": A("IP65 40W"),
     "Cleanroom / theatre ceiling, HTM 03-01": A("HTM 03-01")},
    "Cleanroom panel: white flange with gasket and opal diffuser below the ceiling, recessed body, LED board, driver box with gland, eight stainless retaining screws, suspension lugs; flange, body and diffuser sized per type.",
    tv=etv(240, 40), conns=[PWR('Driver Box', 'top')])

# 40 General LED panel 600, lay-in
p = [B('Edge Frame', [-298, -298, -10, 298, 298, 0], 'alu', 0),
     B('Diffuser', [-285, -285, -10.5, 285, 285, -9.5], 'opal', 0),
     B('Back Tray', [-290, -290, 0, 290, 290, 12], 'epw'),
     B('Driver Box', [-90, -40, 12, 90, 40, 42], 'white'),
     C('Flex Lead', 'x', [0, 27], 4, [90, 160], 'black', 'f'),
     T('Plug', 'x', [0, 27], disc(10, 160, 190), 'white', 'f'),
     B('Safety Wire Lug', [-280, -10, 12, -265, 10, 20], 'galv', 0, 'f', rep=(2, 545, 0, 0)),
     B('Diffuser Edge Line', [-290, -290, -10.6, 290, -286, -10.5], 'grey', 0, 'f', rep=(2, 0, 576, 0))]
add('FMC_E_LightFixture_Panel_600_General', 'Recessed LED panel 600 x 600 for lay-in grid, slim aluminium edge, opal diffuser, separate driver', 'IfcLightFixture', [('600x600_General', {})], p,
    {"Panel 595 x 595 x 10 mm + driver": A("595x595"), "36 W, 3600 lm, 4000 K, UGR < 19": A("36W"), "Exposed grid ceiling": A("grid")},
    "LED panel: aluminium edge frame, opal diffuser, back tray, driver box with flex lead and plug, safety-wire lugs.",
    tv=etv(240, 36), conns=[PWR('Driver Box', 'top')])

# 41 Downlight: trim, reflector, diffuser, body, heatsink and clips per size; driver shared
p = [B('Driver', [90, -30, 30, 190, 30, 60], 'white'),
     C('Driver Lead', 'x', [0, 45], 4, [35, 90], 'black', 'f')]
for t, R_ in (('150_Downlight', 75), ('200_Downlight', 100)):
    k = t[:3]; f_ = R_ / 100
    p += ONLY([t], [T(f'Trim {k}', 'z', [0, 0], [[80 * f_, -6], [R_, -6], [R_, 0], [80 * f_, 0]], 'white'),
                    T(f'Reflector {k}', 'z', [0, 0], [[70 * f_, -6], [80 * f_, -6], [80 * f_, 30], [70 * f_, 30]], 'white'),
                    T(f'Diffuser {k}', 'z', [0, 0], disc(76 * f_, -4, -3), 'opal'),
                    T(f'Body {k}', 'z', [0, 0], disc(70 * f_, 0, 40), 'alu'),
                    T(f'Heatsink Fin {k}', 'z', [0, 0], disc(60 * f_, 45, 50), 'alu', rep=(6, 0, 0, 10)),
                    T(f'Heatsink Core {k}', 'z', [0, 0], disc(35 * f_, 40, 100), 'alu'),
                    B(f'Spring Clip {k}', [-6, -R_ + 4, 0, 6, -R_ + 12, 50], 'galv', 0, 'f', rep=(2, 0, 2 * R_ - 16, 0))])
add('FMC_E_LightFixture_Downlight_LED', 'Recessed LED downlight, white trim, opal diffuser, finned heatsink, remote driver, spring clips', 'IfcLightFixture',
    [('150_Downlight', {"Apparent Load": 15}), ('200_Downlight', {"Apparent Load": 22})], p,
    {"Trim 150 / 200 mm, height 100 mm (per type)": A("150/200x100"), "15 / 22 W, 4000 K": A("W"), "IP44 below ceiling": A("IP44")},
    "Downlight: trim, reflector, opal diffuser, body, six heatsink fins on a core, spring clips, remote driver with lead.",
    tv=etv(240, 22), conns=[PWR('Driver', 'top')])

# 42 LED batten, surface: channel, diffuser, end caps per length; cable entry shared
p = [C('Cable Entry', 'z', [-500, 0], 10, [0, 6], 'grey', 'f')]
dif = [[35 * math.cos(math.pi * k / 12), -12 - 30 * math.sin(math.pi * k / 12)] for k in range(13)]
for t, L in (('1200_Batten', 600), ('1500_Batten', 750)):
    k = t[:4]
    p += ONLY([t], [B(f'Base Channel {k}', [-L, -35, -12, L, 35, 0], 'epw', 0),
                    RT(f'Diffuser {k}', dif, [-L + 15, L - 15], 'opal'),
                    T(f'End Cap L {k}', 'x', [0, -12], [[0, -L], [36, -L], [36, -L + 15], [0, -L + 15]], 'grey'),
                    T(f'End Cap R {k}', 'x', [0, -12], [[0, L - 15], [36, L - 15], [36, L], [0, L]], 'grey'),
                    C(f'Fixing Screw {k}', 'z', [-L + 150, 0], 4, [-13, -12], 'chrome', 'f', rep=(2, 2 * L - 300, 0, 0))])
add('FMC_E_LightFixture_Batten_LED', 'LED batten, surface ceiling mount, white steel base channel, opal half-round diffuser, end caps', 'IfcLightFixture',
    [('1200_Batten', {"Apparent Load": 36}), ('1500_Batten', {"Apparent Load": 45})], p,
    {"Length 1200 / 1500 mm (per type), 70 x 45 mm": A("1200/1500x70x45"), "36 / 45 W, 4000 K": A("W")},
    "Batten: steel base channel on the ceiling, half-round opal diffuser, grey end caps, fixing screws (length per type), cable entry; hangs below the ceiling (z = 0).",
    tv=etv(240, 36), conns=[PWR('Cable Entry', 'top')])

# 43 Ward bedhead luminaire, up/down + reading + night light
prof = [[0, 0], [0, 300], [-60, 300], [-110, 260], [-110, 40], [-70, 0]]
p = [RT('Body', prof, [-600, 600], 'alu'),
     RT('Uplight Diffuser', [[-8, 300], [-60, 300], [-62, 302], [-8, 302]], [-580, 580], 'opal'),
     RT('Downlight Louvre', [[-10, -2], [-68, -2], [-68, 0], [-10, 0]], [-580, 580], 'grey'),
     B('Louvre Blade', [-575, -66, -6, -570, -12, -2], 'alu', 0, 'f', rep=(24, 50, 0, 0)),
     RT('Front Fascia', [[-110, 60], [-112, 60], [-112, 240], [-110, 240]], [-590, 590], 'white', 'f'),
     T('End Cap', 'x', [-50, 150], [[0, -606], [10, -606], [10, -600], [0, -600]], 'grey', 'f'),
     F('End Plate', [-606, -110, 0, -600, 0, 300], 'grey', 0, rep=(2, 1206, 0, 0)),
     T('Reading Light Arm', 'z', [450, -160], disc(10, 140, 200), 'alu'),
     B('Reading Light Neck', [440, -160, 190, 460, -112, 200], 'alu', 0),
     T('Reading Light Head', 'y', [450, 150], [[0, -160], [28, -160], [32, -200], [0, -200]], 'white'),
     T('Reading Lens', 'y', [450, 150], disc(26, -200, -201), 'opal', 'f'),
     F('Night Light', [-80, -112, 30, 80, -111, 50], 'yellow', 3, 'f'),
     F('Control Panel', [-560, -113, 120, -460, -112, 200], 'mgrey', 4, 'f'),
     C('Control Button', 'y', [-540, 160], 6, [-115, -113], 'white', 'f', rep=(3, 30, 0, 0))]
p = [q for q in p if q['n'] != 'Reading Light Arm']
p.insert(7, B('Reading Light Arm', [440, -170, 140, 460, -112, 160], 'alu', 0))
p[8] = B('Reading Light Neck', [440, -170, 140, 460, -150, 190], 'alu', 0)
p[9] = T('Reading Light Head', 'y', [450, 205], [[0, -140], [26, -140], [32, -190], [0, -190]], 'white')
p[10] = T('Reading Lens', 'y', [450, 205], disc(30, -190, -191), 'opal', 'f')
p = [q for q in p if q['n'] != 'End Cap']
add('FMC_E_LightFixture_Bedhead_Reading_Ward', 'Ward bedhead luminaire 1200: indirect uplight, louvred downlight, adjustable reading light, night light, integral controls', 'IfcLightFixture',
    ['1200_UpDownReading'], p,
    {"Body 1200 x 110 x 300 mm": A("1200x110x300"), "Up 2000 lm, reading 300 lux at pillow, night light < 5 lux": A("lux", "HBN 04-01 / SLL LG2"),
     "Bottom at 1650 mm": A(1650)},
    "Bedhead luminaire: extruded body with opal uplight diffuser, downlight louvre with blades, white fascia, end plates, adjustable reading light (arm, neck, head, lens), amber night light, control panel with buttons.",
    tv=etv(240, 60, False, 1650), conns=[PWR('Body')])

def arc_band(cy, cz, r0, r1, a0=0, a1=180, n=16):
    """Side outline (y, z) of a bent tube: band between radii r0 and r1 around (cy, cz), angles in degrees."""
    out = [[round(cy + r1 * math.cos(math.radians(a0 + (a1 - a0) * k / n)), 1), round(cz + r1 * math.sin(math.radians(a0 + (a1 - a0) * k / n)), 1)] for k in range(n + 1)]
    inn = [[round(cy + r0 * math.cos(math.radians(a0 + (a1 - a0) * k / n)), 1), round(cz + r0 * math.sin(math.radians(a0 + (a1 - a0) * k / n)), 1)] for k in range(n, -1, -1)]
    return out + inn
# 44 Examination light on wall arm
p = [F('Wall Plate', [-50, -12, 0, 50, 0, 140], 'white', 10),
     C('Wall Pivot', 'z', [0, -35], 18, [10, 130], 'white'),
     C('Arm', 'y', [0, 70], 12, [-500, -35], 'white'),
     C('Elbow', 'z', [0, -500], 16, [50, 90], 'white'),
     C('Gooseneck Riser', 'z', [0, -500], 8, [90, 300], 'chrome'),
     RT('Gooseneck Bend', arc_band(-590, 300, 82, 98), [-8, 8], 'chrome'),
     T('Head', 'z', [0, -680], [[0, 300], [20, 300], [75, 260], [85, 230], [0, 230]], 'white'),
     T('Head Lens', 'z', [0, -680], disc(70, 228, 230), 'opal'),
     T('LED Ring', 'z', [0, -680], ring(30, 45, 227, 228), 'yellow', 'f'),
     C('Handle', 'z', [0, -680], 12, [170, 228], 'mgrey'),
     C('Switch', 'x', [-680, 250], 7, [55, 72], 'grey', 'f')]
add('FMC_E_LightFixture_Examination_Wall_Arm', 'LED examination light on a wall-mounted swing arm with gooseneck, 50 000 lux head, centre handle', 'IfcLightFixture',
    ['700_WallArm'], p,
    {"Arm reach 700 mm, head 170 mm": A("700/170"), "50 000 lux at 0.5 m, CRI > 90": A("50000lux"), "Wall plate at 1600 mm": A(1600), "Load 20 VA": A(20)},
    "Exam light: wall plate and pivot, swing arm, elbow, gooseneck riser and bend, head with opal lens and LED ring, centre handle, switch.",
    tv=etv(240, 20, False, 1600), conns=[PWR('Wall Plate')])

# 45 Mobile examination light, 5-star base
p = [T('Hub', 'z', [0, 0], disc(50, 60, 110), 'mgrey')]
for k in range(5):
    a = math.radians(90 + 72 * k); ca, sa = math.cos(a), math.sin(a); nx, ny = -sa, ca
    x1, y1 = 300 * ca, 300 * sa
    pts = [[round(30 * ca + 15 * nx, 1), round(30 * sa + 15 * ny, 1)], [round(x1 + 15 * nx, 1), round(y1 + 15 * ny, 1)],
           [round(x1 - 15 * nx, 1), round(y1 - 15 * ny, 1)], [round(30 * ca - 15 * nx, 1), round(30 * sa - 15 * ny, 1)]]
    p.append(PZ(f'Leg {k + 1}', pts, [65, 95], 'mgrey'))
    p.append(C(f'Castor {k + 1}', 'z', [round(x1, 1), round(y1, 1)], 22, [0, 65], 'castor', 'f'))
p += [C('Column', 'z', [0, 0], 18, [110, 1250], 'white'),
      F('Power Unit', [-45, -40, 700, 45, -18, 850], 'white', 8),
      C('Power Switch', 'y', [0, 820], 6, [-43, -40], 'green', 'f'),
      C('Gooseneck Riser', 'z', [0, 0], 8, [1250, 1600], 'chrome'),
      RT('Gooseneck Bend', arc_band(-110, 1600, 102, 118), [-8, 8], 'chrome'),
      T('Head', 'z', [0, -220], [[0, 1600], [20, 1600], [75, 1560], [85, 1530], [0, 1530]], 'white'),
      T('Head Lens', 'z', [0, -220], disc(70, 1528, 1530), 'opal'),
      T('LED Ring', 'z', [0, -220], ring(30, 45, 1527, 1528), 'yellow', 'f'),
      C('Handle', 'z', [0, -220], 12, [1470, 1528], 'mgrey')]
add('FMC_E_LightFixture_Examination_Mobile', 'Mobile LED examination light on a 5-castor base with column, gooseneck and head', 'IfcLightFixture', ['1720_Stand'], p,
    {"Base 600 dia, height 1720 mm": A("600x1550"), "50 000 lux at 0.5 m": A("50000lux"), "Load 20 VA": A(20)},
    "Mobile exam light: hub, five legs with castors, column, power unit with switch, gooseneck riser and bend, head with opal lens, LED ring and handle.",
    tv=etv(240, 20), conns=[PWR('Power Unit')], cat='Lighting Fixtures')

# 46 Operating light, ceiling, double dome (main 700, satellite 600)
p = [B('Unistrut Channel', [-400, -171, 300, 400, -129, 341], 'galv', rep=(2, 0, 300, 0)),
     C('Threaded Rod', 'z', [-150, -150], 6, [20, 300], 'galv', 'mf', rep=(2, 300, 0, 0)),
     C('Threaded Rod Rear', 'z', [-150, 150], 6, [20, 300], 'galv', 'mf', rep=(2, 300, 0, 0)),
     B('Mounting Plate', [-200, -200, 0, 200, 200, 20], 'steel'),
     T('Ceiling Cover', 'z', [0, 0], [[0, 0], [250, 0], [250, -15], [200, -40], [0, -40]], 'white'),
     C('Central Axis', 'z', [0, 0], 50, [-400, -40], 'white'),
     C('Arm Main', 'x', [0, -380], 30, [0, 900], 'white'),
     *ONLY(['700-600_DoubleDome'], [C('Arm Satellite', 'x', [0, -330], 30, [-850, 0], 'white')]),
     C('Spring Arm Main', 'z', [900, 0], 25, [-900, -380], 'white'),
     *ONLY(['700-600_DoubleDome'], [C('Spring Arm Sat', 'z', [-850, 0], 25, [-750, -330], 'white')]),
     C('Yoke Main', 'y', [900, -950], 18, [-60, 60], 'white'),
     *ONLY(['700-600_DoubleDome'], [C('Yoke Sat', 'y', [-850, -800], 18, [-60, 60], 'white')]),
     T('Dome Main', 'z', [900, 0], [[0, -1000], [350, -1060], [350, -1080], [0, -1080]], 'white'),
     T('Dome Main Top', 'z', [900, 0], [[0, -950], [80, -955], [300, -1020], [350, -1060], [0, -1060]], 'white'),
     T('Lens Main', 'z', [900, 0], disc(330, -1082, -1080), 'frost'),
     T('LED Ring Main', 'z', [900, 0], ring(120, 150, -1083, -1082), 'yellow', 'f', rep=(1, 0, 0, 0)),
     T('LED Ring Main 2', 'z', [900, 0], ring(220, 250, -1083, -1082), 'yellow', 'f'),
     T('Sterile Handle Main', 'z', [900, 0], [[0, -1082], [25, -1082], [22, -1180], [0, -1185]], 'mgrey'),
     *ONLY(['700-600_DoubleDome'], [T('Dome Sat', 'z', [-850, 0], [[0, -850], [80, -855], [260, -910], [300, -950], [300, -970], [0, -970]], 'white')]),
     *ONLY(['700-600_DoubleDome'], [T('Lens Sat', 'z', [-850, 0], disc(280, -972, -970), 'frost')]),
     *ONLY(['700-600_DoubleDome'], [T('LED Ring Sat', 'z', [-850, 0], ring(150, 180, -973, -972), 'yellow', 'f')]),
     *ONLY(['700-600_DoubleDome'], [T('Sterile Handle Sat', 'z', [-850, 0], [[0, -972], [25, -972], [22, -1070], [0, -1075]], 'mgrey')])]
p = [q for q in p if q['n'] != 'Dome Main']
add('FMC_E_LightFixture_OperatingLight_Ceiling', 'LED surgical light, ceiling mounted to a Unistrut frame: central axis, spring arms, 700 main dome and 600 satellite dome with sterile handles',
    'IfcLightFixture', [('700_Single', {"Apparent Load": 150}), ('700-600_DoubleDome', {"Apparent Load": 300})], p,
    {"Domes 700 / 600 mm, arm reach 900 mm": A("700/600"), "160 000 lux, 4500 K, Ra > 95 (IEC 60601-2-41)": A("160000lux"),
     "Ceiling 2900-3000 mm, Unistrut frame by structure": A(3000, "HBN 26 theatre practice"), "Sweep radius 1250 mm": A(1250)},
    "Surgical light: Unistrut channels and threaded rods above the ceiling, mounting plate, ceiling cover, central axis, arms with spring arms and yokes, main dome and (DoubleDome type) satellite dome with frosted lenses, LED rings and sterile handles; sweep envelope on Clearance Operation.",
    tv=etv(240, 300), conns=[PWR('Mounting Plate', 'top')],
    clear=[{"n": "Sweep", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, -1200], [1250, -1200], [1250, -900], [0, -900]], "sub": "Clearance Operation"}])

# 47 Night footlight, recessed, louvred
p = plate(sm='white')
p += [F('Louvre Aperture', [-30, -10, 20, 30, -9.5, 50], 'black', 3, 'f'),
      F('Louvre Blade', [-30, -14, 22, 30, -9.5, 26], 'white', 0, 'f', rep=(5, 0, 0, 6)),
      F('LED Glow', [-25, -9.8, 21, 25, -9.6, 49], 'yellow', 0, 'f')]
add('FMC_E_LightFixture_NightLight_Footlight', 'Recessed LED night footlight, low level, louvred white plate on a single box, warm amber, glare free', 'IfcLightFixture', ['86x86_Recessed'], p,
    {"Plate 86 x 86 mm": A("86x86"), "1 W amber, < 5 lux at floor": A("1W", "HBN 04-01 night lighting"), "Centre at 300 mm": A(300)},
    "Footlight: plate, louvre aperture with five downward blades, amber LED glow, screws, steel box.",
    tv=etv(240, 1, False, 300), conns=[PWR('Back Box')])

# 48 Emergency bulkhead, maintained 3 h
p = [F('Base', [-170, -55, 0, 170, 0, 140], 'white', 30),
     F('Diffuser', [-160, -80, 10, 160, -55, 130], 'opal', 28),
     F('Diffuser Crown', [-145, -84, 22, 145, -80, 118], 'opal', 24, 'f'),
     C('Charge LED', 'y', [140, 20], 4, [-60, -55], 'green', 'f'),
     F('Test Switch', [-150, -58, 15, -130, -55, 30], 'redabs', 2, 'f'),
     C('Clip', 'y', [-170, 70], 5, [-60, -50], 'grey', 'f', rep=(2, 340, 0, 0)),
     F('Pictogram Strip', [-60, -85, 60, 60, -84, 80], 'green', 2, 'f')]
add('FMC_E_LightFixture_Emergency_Bulkhead_Maintained', 'Emergency LED bulkhead, maintained, 3 h, self-contained with green charge LED and test switch, IP65', 'IfcLightFixture', ['3h_Maintained'], p,
    {"Body 340 x 140 x 85 mm": A("340x140x85"), "3 h duration, maintained": A("3h", "BS 5266-1 for premises with sleeping risk"), "Height 2400 mm": A(2400)},
    "Emergency bulkhead: base, rounded opal diffuser with crown, green charge LED, test switch, side clips, pictogram strip.",
    tv=etv(240, 4, False, 2400), conns=[PWR('Base')])

# 49 Exit sign, edge-lit blade (double-sided type), wall/ceiling
p = [F('Header Box', [-200, -60, 200, 200, 0, 250], 'white', 6),
     F('Blade', [-190, -34, 0, 190, -26, 200], 'pc', 4),
     F('Legend Panel', [-180, -35, 10, 180, -34, 190], 'green', 3),
     *ONLY(['380x250_Double'], [F('Legend Panel Rear', [-180, -26, 10, 180, -25, 190], 'green', 3, 'f')]),
     FR('Man Torso', [[-138, 92], [-124, 92], [-106, 146], [-120, 150]], [-35.5, -35], 'white', 'f'),
     T('Man Head', 'y', [-104, 166], disc(11, -35, -35.5), 'white', 'f'),
     FR('Man Thigh Front', [[-130, 96], [-120, 90], [-96, 58], [-108, 52]], [-35.5, -35], 'white', 'f'),
     FR('Man Shin Front', [[-108, 52], [-96, 58], [-92, 32], [-104, 30]], [-35.5, -35], 'white', 'f'),
     FR('Man Thigh Back', [[-136, 98], [-128, 88], [-152, 70], [-160, 80]], [-35.5, -35], 'white', 'f'),
     FR('Man Shin Back', [[-160, 80], [-152, 70], [-170, 54], [-178, 62]], [-35.5, -35], 'white', 'f'),
     FR('Man Arm Front', [[-114, 138], [-88, 120], [-84, 128], [-108, 146]], [-35.5, -35], 'white', 'f'),
     FR('Man Arm Back', [[-118, 136], [-122, 144], [-152, 128], [-148, 120]], [-35.5, -35], 'white', 'f'),
     FR('Door Left', [[-74, 30], [-68, 30], [-68, 170], [-74, 170]], [-35.5, -35], 'white', 'f'),
     FR('Door Right', [[-20, 30], [-14, 30], [-14, 170], [-20, 170]], [-35.5, -35], 'white', 'f'),
     FR('Door Head', [[-74, 164], [-14, 164], [-14, 170], [-74, 170]], [-35.5, -35], 'white', 'f'),
     FR('Arrow', [[20, 90], [90, 90], [90, 60], [150, 100], [90, 140], [90, 110], [20, 110]], [-35.5, -35], 'white', 'f'),
     C('Charge LED', 'y', [180, 225], 3, [-61, -60], 'green', 'f')]
add('FMC_E_LightFixture_ExitSign_Illuminated', 'Illuminated exit sign, edge-lit acrylic blade under a header box, ISO 7010 running-man legend with arrow, maintained 3 h', 'IfcLightFixture',
    [('380x250_Single', {}), ('380x250_Double', {})], p,
    {"Blade 380 x 200 mm, viewing distance 24 m": A("380x200", "BS 5266-1 / ISO 7010"), "Maintained 3 h": A("3h"), "Bottom at 2100 mm": A(2100)},
    "Exit sign: header box with charge LED, clear blade, green legend panel (and a rear one on the Double type), white running-man pictogram (torso, head, legs, arms), door outline and arrow.",
    tv=etv(240, 3, False, 2100), conns=[PWR('Header Box', 'top')])

# 50 IP65 round bulkhead
p = [T('Base', 'y', [0, 0], [[0, 0], [135, 0], [135, -30], [125, -40], [0, -40]], 'white'),
     T('Diffuser Dome', 'y', [0, 0], [[0, -40], [118, -40], [112, -60], [90, -78], [50, -88], [0, -90]], 'opal'),
     T('Bezel Ring', 'y', [0, 0], ring(115, 128, -40, -48), 'white'),
     F('Guard Bar H', [-115, -92, -6, 115, -80, 6], 'white', 4, 'f'),
     F('Guard Bar V', [-6, -92, -115, 6, -80, 115], 'white', 4, 'f'),
     C('Bezel Screw', 'y', [-122, 0], 4, [-50, -48], 'ss', 'f', rep=(2, 244, 0, 0)),
     C('Cable Gland', 'z', [0, -20], 10, [-155, -135], 'grey', 'f')]
add('FMC_E_LightFixture_Bulkhead_IP65', 'Round LED bulkhead 270 mm, IP65, polycarbonate opal dome with eyelid-free cross guard', 'IfcLightFixture', ['270_Wall'], p,
    {"Diameter 270 mm, 90 mm deep": A("270x90"), "15 W, IP65, IK08": A("15W IP65"), "Height 2400 mm": A(2400)},
    "Bulkhead: base, opal dome, bezel ring with screws, cross guard bars, cable gland.",
    tv=etv(240, 15, False, 2400), conns=[PWR('Base')])

# 51 Street light pole with LED head and solar option (8 m)
p = [B('Base Plate', [-160, -160, 0, 160, 160, 20], 'galv'),
     C('Anchor Bolt', 'z', [-125, -125], 12, [0, 80], 'galv', 'f', rep=(2, 250, 0, 0)),
     C('Anchor Bolt Rear', 'z', [-125, 125], 12, [0, 80], 'galv', 'f', rep=(2, 250, 0, 0)),
     F('Inspection Door', [-30, -90, 600, 30, -78, 900], 'galv', 6, 'f'),
     F('Battery Box', [-150, -260, 3000, 150, -60, 3600], 'pcoat', 10),
     B('Battery Box Clamp', [-60, -60, 3200, 60, 0, 3260], 'galv', 0, 'f', rep=(2, 0, 0, 200))]
for t, H in (('6m_LED', 6000), ('8m_LED', 8000)):
    k = t[:2]
    p += ONLY([t], [T(f'Pole {k}', 'z', [0, 0], [[0, 20], [85, 20], [45, H], [0, H]], 'galv'),
                    PZ(f'Arm {k}', [[-20, 0], [20, 0], [20, -1500], [-20, -1500]], [H - 300, H - 260], 'galv'),
                    C(f'Arm Spigot {k}', 'y', [0, H - 260], 25, [-1650, -1500], 'galv'),
                    B(f'Luminaire Head {k}', [-160, -2300, H - 340, 160, -1550, H - 220], 'pcoat', 60),
                    B(f'LED Module {k}', [-120, -2200, H - 346, 120, -1650, H - 340], 'yellow', 30, 'f'),
                    B(f'Heat Fins {k}', [-130, -2250, H - 220, 130, -1600, H - 200], 'pcoat', 20, 'f'),
                    B(f'Solar Panel Frame {k}', [-600, -500, H + 150, 600, 500, H + 190], 'pvframe'),
                    B(f'Solar Panel Cells {k}', [-580, -480, H + 190, 580, 480, H + 192], 'pv', 0, 'f'),
                    C(f'Panel Bracket {k}', 'z', [0, 0], 30, [H, H + 150], 'galv')])
add('FMC_E_LightFixture_Streetlight_Pole', 'Street light: tapered galvanised pole on base plate, single arm, LED road luminaire; solar option with roof panel and pole-mounted battery box',
    'IfcLightFixture', [('6m_LED', {}), ('8m_LED', {})], p,
    {"Pole 6 m or 8 m (per type), arm 1.5 m": A("6000/8000/1500"), "LED 60 W, Type II road optic": A("60W"),
     "Solar option: 1.2 x 1.0 m panel, LiFePO4 battery box": A("solar", "note in record"), "Spacing 25-30 m": A("25-30 m")},
    "Street light: base plate and anchor bolts, tapered pole with inspection door, arm with spigot, LED luminaire with module and fins, solar panel on bracket, battery box with clamps.",
    tv=etv(240, 60), conns=[PWR('Base Plate', 'bottom')])

# 52 Bollard light 900
p = [T('Base Flange', 'z', [0, 0], disc(110, 0, 15), 'steel'),
     T('Body', 'z', [0, 0], disc(100, 15, 720), 'steel'),
     T('Light Window', 'z', [0, 0], disc(95, 720, 840), 'opal'),
     T('Louvre Ring', 'z', [0, 0], ring(95, 102, 735, 743), 'steel', 'f', rep=(4, 0, 0, 25)),
     T('Louvre Post', 'z', [0, 0], disc(10, 720, 840), 'steel'),
     T('Cap', 'z', [0, 0], [[0, 840], [110, 840], [110, 870], [90, 895], [0, 900]], 'steel'),
     F('Access Door', [-40, -101, 150, 40, -99, 400], 'steel', 6, 'f'),
     C('Door Screw', 'y', [0, 380], 4, [-103, -100], 'ss', 'f')]
p = [q for q in p if q['n'] != 'Louvre Post']
add('FMC_E_LightFixture_Bollard_Light', 'LED bollard 900 mm, 200 dia aluminium body, 360 deg louvred opal window, flanged base', 'IfcLightFixture', ['900_LED'], p,
    {"Height 900 mm, 200 dia": A("900x200"), "LED 15 W, IP65": A("15W")},
    "Bollard: base flange, dark body with access door and screw, opal light window with four louvre rings, domed cap.",
    tv=etv(240, 15), conns=[PWR('Base Flange', 'bottom')])

# 53 Floodlight
p = [F('Wall Plate', [-50, -10, 120, 50, 0, 200], 'steel', 6),
     B('Yoke Arm', [-180, -60, 150, -165, -10, 170], 'steel', rep=(2, 345, 0, 0)),
     B('Yoke Base', [-180, -60, 150, 180, -10, 170], 'steel'),
     F('Housing', [-165, -100, 0, 165, -60, 260], 'steel', 15),
     F('Heatsink Fin', [-150, -60, 15, -142, -20, 245], 'steel', 0, rep=(14, 22, 0, 0)),
     F('Front Glass', [-150, -102, 15, 150, -100, 245], 'glass', 10),
     F('LED Chip', [-120, -103, 40, -96, -102, 64], 'yellow', 0, 'f', rep=(6, 44, 0, 0)),
     F('LED Chip Row 2', [-120, -103, 118, -96, -102, 142], 'yellow', 0, 'f', rep=(6, 44, 0, 0)),
     F('LED Chip Row 3', [-120, -103, 196, -96, -102, 220], 'yellow', 0, 'f', rep=(6, 44, 0, 0)),
     C('Pivot Knob', 'x', [-80, 160], 14, [-195, -180], 'black', 'f', rep=(2, 375, 0, 0)),
     C('Cable Gland', 'z', [0, -80], 9, [-25, 0], 'black', 'f')]
add('FMC_E_LightFixture_Floodlight', 'LED floodlight on a U yoke, die-cast housing with rear fins, glass front, IP66', 'IfcLightFixture',
    [('100W_IP66', {"Apparent Load": 100}), ('200W_IP66', {"Apparent Load": 200})], p,
    {"Housing 330 x 260 x 100 mm (200 W larger)": A("330x260x100"), "100 / 200 W, IP66": A("W"), "Mounting height 4-6 m": A(4500)},
    "Floodlight: wall plate, U yoke with pivot knobs, housing with rear heatsink fins, glass front, three rows of LED chips, cable gland.",
    tv=etv(240, 100, False, 4500), conns=[PWR('Wall Plate')])

# 54 X-ray warning light, door head
p = [F('Box', [-200, -70, 0, 200, 0, 150], 'white', 8),
     F('Legend Panel', [-185, -72, 15, 185, -70, 135], 'red', 4),
     F('Legend Upper', [-120, -72.5, 85, 120, -72, 115], 'white', 2, 'f'),
     F('Legend Lower', [-150, -72.5, 35, 150, -72, 65], 'white', 2, 'f'),
     T('Trefoil Disc', 'y', [-160, 75], disc(12, -72, -72.5), 'yellow', 'f'),
     C('Status LED', 'y', [185, 7], 2.5, [-71, -70], 'green', 'f'),
     C('Fixing Screw', 'y', [-190, 75], 3, [-71, -70], 'white', 'f', rep=(2, 380, 0, 0))]
add('FMC_E_LightFixture_XrayWarning_Light', "Radiation warning light box over the X-ray room door: red illuminated legend 'X-RAY IN USE / DO NOT ENTER', interlocked to the generator",
    'IfcLightFixture', ['400x150_DoorHead'], p,
    {"Box 400 x 150 x 70 mm": A("400x150x70"), "Two-stage warning (prepare / exposure) per IRR17": A("IRR17", "IRR 2017 / IPEM practice"), "Bottom at 2150 mm": A(2150)},
    "X-ray warning light: white box, red legend panel with two white legend bands (text set by sign maker), trefoil disc, status LED, screws.",
    tv=etv(240, 10, False, 2150), conns=[PWR('Box')])

# =============================================================== LIGHTNING PROTECTION
# 55 Air terminal
p = [B('Base Plate', [-60, -60, 0, 60, 60, 6], 'brass'),
     C('Base Screw', 'z', [-45, -45], 4, [6, 9], 'chrome', 'f', rep=(2, 90, 0, 0)),
     C('Base Screw Rear', 'z', [-45, 45], 4, [6, 9], 'chrome', 'f', rep=(2, 90, 0, 0)),
     T('Rod Boss', 'z', [0, 0], [[0, 6], [22, 6], [22, 40], [12, 55], [0, 55]], 'brass'),
     *[q for t, h in (('500_Copper', 500), ('1000_Copper', 1000)) for q in ONLY([t], [
        C(f'Rod {h}', 'z', [0, 0], 8, [55, h - 40], 'copper'),
        T(f'Tip {h}', 'z', [0, 0], [[0, h - 40], [8, h - 40], [0, h]], 'copper')])],
     B('Tape Clamp', [20, -20, 0, 70, 20, 12], 'brass', 0, 'f'),
     B('Tape', [70, -12.5, 0, 300, 12.5, 3], 'copper', 0, 'f'),
     C('Clamp Bolt', 'z', [45, 0], 5, [12, 18], 'chrome', 'f')]
add('FMC_LP_LP_AirTerminal_Rod', 'Lightning air terminal, solid copper rod 16 mm on a flat gunmetal base with 25 x 3 tape clamp (BS EN 62305)', 'IfcDiscreteAccessory',
    [('500_Copper', {}), ('1000_Copper', {})], p,
    {"Rod 16 dia x 500 / 1000 mm (per type)": A("16x500/1000", "BS EN 62561-2 air termination rod"), "Base 120 x 120 mm with tape clamp": A("120x120"),
     "Protective angle / rolling sphere by designer": A("BS EN 62305-3")},
    "Air terminal: gunmetal base plate with screws, rod boss, copper rod with pointed tip, tape clamp and bolt with a tape stub.",
    cat='Electrical Fixtures')

# 56 Down conductor test clamp
p = [B('Tape Upper', [-12.5, -3, 60, 12.5, 0, 600], 'copper'),
     B('Tape Lower', [-12.5, -3, -600, 12.5, 0, -60], 'copper'),
     B('Clamp Back Plate', [-25, -6, -70, 25, -3, 70], 'brass'),
     B('Clamp Front Plate', [-25, -12, -70, 25, -6, 70], 'brass', 3),
     B('Link Bar', [-12.5, -6, -60, 12.5, -3, 60], 'copper', 0, 'f'),
     C('Clamp Bolt', 'y', [-14, -45], 5, [-18, -12], 'chrome', 'f', rep=(2, 28, 0, 0)),
     C('Clamp Bolt Upper', 'y', [-14, 45], 5, [-18, -12], 'chrome', 'f', rep=(2, 28, 0, 0)),
     B('DC Clip', [-20, -8, 400, 20, 0, 420], 'grey', 0, 'f', rep=(2, 0, 0, -800)),
     C('Clip Screw', 'y', [0, 410], 3, [-9, -8], 'chrome', 'f', rep=(2, 0, 0, -800)),
     F('Test Label', [-25, -1, 90, 25, 0, 130], 'white', 2, 'f')]
p[-1]['at'] = [-25, -12.5, 75, 25, -12, 95]
add('FMC_LP_LP_DownConductor_TestClamp', 'Down conductor test clamp, gunmetal, on 25 x 3 copper tape with DC clips above and below', 'IfcDiscreteAccessory', ['25x3_Tape'], p,
    {"Clamp 50 x 140 mm, tape 25 x 3 mm": A("50x140", "BS EN 62561-1"), "Test point 1.5 m above ground": A(1500, "BS EN 62305-3 practice"), "Clips at 1 m centres": A(1000)},
    "Test clamp: front and back plates with four bolts, link bar, upper and lower 25 x 3 tape, two DC clips with screws, test label.",
    tv={"Default Elevation": 1500}, cat='Electrical Fixtures')

# 57 Earth pit: precast chamber 300 x 300, lid at ground level (z = 0)
p = [B('Chamber Wall Front', [-200, -200, -450, 200, -150, 0], 'conc'),
     B('Chamber Wall Back', [-200, 150, -450, 200, 200, 0], 'conc'),
     B('Chamber Wall Left', [-200, -150, -450, -150, 150, 0], 'conc'),
     B('Chamber Wall Right', [150, -150, -450, 200, 150, 0], 'conc'),
     B('Lid Frame', [-205, -205, -10, 205, 205, 0], 'struct'),
     B('Lid', [-195, -195, -8, 195, 195, 30], 'conc', 6),
     B('Lid Plate', [-185, -185, 30, 185, 185, 32], 'yellow', 4, 'f'),
     T('Lift Ring', 'x', [0, 32], ring(10, 15, -40, -30), 'galv', 'f', rep=(2, 70, 0, 0)),
     B('Lid Label', [-70, -120, 32, 70, -80, 33], 'black', 0, 'f'),
     C('Earth Rod Head', 'z', [0, 0], 8, [-400, -150], 'cubond', 'f'),
     B('Rod Clamp', [-15, -15, -200, 15, 15, -170], 'brass', 0, 'f'),
     C('Earth Lead', 'y', [0, -185], 5, [-15, 150], 'gy', 'f')]
add('FMC_LP_LP_EarthPit_Inspection', 'Earth inspection pit, precast concrete 300 x 300 clear with heavy lid flush at ground, earth rod head and clamp visible inside', 'IfcBuildingElementProxy',
    ['300x300_Concrete'], p,
    {"Clear 300 x 300 x 450 mm, lid 390 mm": A("300x300x450"), "Lid marked EARTH, removable for test": A("EARTH", "BS 7430 / BS EN 62305-3")},
    "Earth pit: four precast chamber walls, steel lid frame, concrete lid with yellow plate, lift rings and label; rod head, clamp and green/yellow lead inside.",
    cat='Site')

# 58 Earth rod (top at ground, z = 0)
p = [*ONLY(['1.2m_CopperBond'], [C('Rod 1.2m', 'z', [0, 0], 8, [-1200, -150], 'cubond'),
                                  T('Driving Tip 1.2m', 'z', [0, 0], [[0, -1240], [8, -1200], [0, -1200]], 'cubond')]),
     *ONLY(['2.4m_CopperBond'], [C('Rod 2.4m', 'z', [0, 0], 8, [-2400, -150], 'cubond'),
                                  T('Driving Tip 2.4m', 'z', [0, 0], [[0, -2440], [8, -2400], [0, -2400]], 'cubond'),
                                  T('Coupler', 'z', [0, 0], ring(0, 11, -1250, -1150), 'brass')]),
     B('Rod Clamp', [-18, -15, -230, 18, 15, -170], 'brass'),
     C('Clamp Bolt', 'y', [0, -200], 5, [-24, -15], 'chrome', 'f'),
     C('Earth Lead', 'x', [0, -200], 5, [18, 300], 'gy'),
     T('Rod Top', 'z', [0, 0], [[0, -150], [8, -150], [7, -145], [0, -145]], 'cubond', 'f')]
add('FMC_LP_LP_EarthRod', 'Copper-bonded steel earth rod 16 mm with coupler, driving tip, rod clamp and green/yellow earth lead; top 150 mm below ground', 'IfcDiscreteAccessory',
    [('1.2m_CopperBond', {}), ('2.4m_CopperBond', {})], p,
    {"Rod 16 dia x 1200 / 2400 mm (two coupled 1.2 m rods)": A("16x1200/2400", "BS EN 62561-2"), "Copper bond 250 um": A("250um"), "Target resistance < 10 ohm": A(10, "BS EN 62305-3 / BS 7430")},
    "Earth rod: copper-bonded rod with driving tip, coupler, top, rod clamp with bolt and earth lead; ground at z = 0.",
    cat='Electrical Fixtures')

# 59 Main earthing terminal bar
p = [F('Back Plate', [-280, -6, 0, 280, 0, 120], 'grey', 4),
     B('Insulator', [-260, -40, 30, -220, -6, 90], 'black', 6, rep=(2, 480, 0, 0)),
     F('Earth Bar', [-270, -50, 40, 270, -40, 90], 'copper', 2),
     C('Terminal Bolt', 'y', [-200, 65], 5, [-62, -50], 'chrome', 'f', rep=(12, 36, 0, 0)),
     F('Disconnect Link', [180, -56, 35, 260, -50, 95], 'copper', 2, 'f'),
     C('Link Bolt', 'y', [200, 65], 6, [-64, -56], 'chrome', 'f', rep=(2, 40, 0, 0)),
     F('Label', [-120, -7, 98, 120, -6, 115], 'gy', 2, 'f')]
add('FMC_LP_LP_EarthBar_Main', 'Main earthing terminal bar 12-way, copper on insulators with disconnect link, on a backplate', 'IfcDiscreteAccessory', ['12-way_Copper'], p,
    {"Bar 540 x 50 x 10 mm": A("540x50x10"), "12 terminals M10, disconnect link for test": A("12-way", "BS 7671 542.4"), "Height 500 mm": A(500)},
    "MET bar: grey backplate, two insulators, copper bar with 12 terminal bolts, disconnect link with bolts, green/yellow label.",
    tv={"Default Elevation": 500}, cat='Electrical Fixtures')

# 60 SPD Type 1 TPN in IP65 enclosure
p = [B('Enclosure', [-150, -150, 0, 150, 0, 300], 'grey', 6),
     F('Cover Top', [-147, -160, 240, 147, -150, 297], 'grey', 6),
     F('Cover Bottom', [-147, -160, 3, 147, -150, 80], 'grey', 6),
     F('Cover Side', [-147, -160, 80, -120, -150, 240], 'grey', 0, rep=(2, 267, 0, 0)),
     F('Window Seal', [-120, -152, 80, 120, -150, 84], 'black', 0, 'f', rep=(2, 0, 0, 156)),
     F('Window', [-120, -160, 84, 120, -159, 236], 'pc', 0, 'f'),
     F('DIN Rail', [-120, -110, 150, 120, -100, 185], 'galv', 0, 'f'),
     F('SPD Module', [-110, -158, 110, -74, -110, 225], 'mgrey', 3, rep=(4, 36, 0, 0)),
     F('Status Flag', [-100, -159, 180, -84, -158, 192], 'green', 1, 'f', rep=(4, 36, 0, 0)),
     F('Terminal Screw Row', [-108, -159, 115, 32, -158, 125], 'chrome', 0, 'f'),
     F('Terminal Screw Row Top', [-108, -159, 210, 32, -158, 220], 'chrome', 0, 'f'),
     F('Remote Contact', [40, -158, 120, 70, -120, 220], 'mgrey', 3, 'f'),
     C('Cover Screw', 'y', [-135, 15], 3.5, [-162, -160], 'grey', 'f', rep=(2, 270, 0, 0)),
     C('Cover Screw Top', 'y', [-135, 285], 3.5, [-162, -160], 'grey', 'f', rep=(2, 270, 0, 0)),
     C('Cable Gland', 'z', [-60, -75], 14, [-25, 0], 'black', 'f', rep=(3, 60, 0, 0))]
add('FMC_LP_LP_SPD_Type1', 'Type 1 surge protective device TPN (3+1), Iimp 25 kA per pole, in an IP65 enclosure with window, at the intake', 'IfcProtectiveDevice', ['TPN_T1'], p,
    {"Enclosure 300 x 300 x 160 mm": A("300x300x160"), "Iimp 25 kA/pole, Up < 2.5 kV": A("25kA", "BS EN 61643-11 Type 1"), "Next to MSB, leads < 0.5 m": A(500, "BS 7671 534")},
    "SPD Type 1: grey enclosure, cover frame with clear window, DIN rail, four SPD modules with green status flags, terminal rows, remote signalling contact, screws, glands.",
    tv=etv(415, 0, True, 1400), conns=[PWR('Enclosure', 'top', 'Supply')], cat='Electrical Equipment')

# 61 SPD Type 2: DIN modular, plug-in cartridges (bare device inside a DB)
p = [F('DIN Rail', [-60, -7.5, 30, 60, 0, 65], 'galv'),
     *[q for t, n in (('TPN_T2', 4), ('SPN_T2', 2)) for q in ONLY([t], [
        F(f'Base {n}P', [-36, -50, 0, -36 + 18 * n, -7.5, 90], 'mgrey', 2),
        F(f'Cartridge {n}P', [-35, -68, 12, -19, -50, 78], 'white', 2, rep=(n, 18, 0, 0)),
        F(f'Indicator Window {n}P', [-31, -68.5, 62, -23, -68, 72], 'green', 0, 'f', rep=(n, 18, 0, 0)),
        F(f'Release Slot {n}P', [-30, -68.5, 18, -24, -68, 22], 'black', 0, 'f', rep=(n, 18, 0, 0)),
        C(f'Terminal Screw {n}P', 'z', [-27, -40], 3, [90, 92], 'chrome', 'f', rep=(n, 18, 0, 0)),
        C(f'Terminal Screw Bottom {n}P', 'z', [-27, -40], 3, [-2, 0], 'chrome', 'f', rep=(n, 18, 0, 0))])],
     F('Remote Contact Pins', [-30, -30, -6, 0, -20, 0], 'grey', 0, 'f')]
add('FMC_LP_LP_SPD_Type2', 'Type 2 surge protective device, DIN-rail modular with plug-in cartridges and status windows, in final DBs', 'IfcProtectiveDevice',
    [('TPN_T2', {}), ('SPN_T2', {"Voltage": 240, "Number of Poles": 1})], p,
    {"4 modules x 18 mm, 90 mm high": A("72x90x68"), "In 20 kA, Imax 40 kA, Up < 1.5 kV": A("20/40kA", "BS EN 61643-11 Type 2"), "In each DB, BS 7671 534": A("BS 7671 534")},
    "SPD Type 2: DIN rail, base, four (TPN) or two (SPN) plug-in cartridges with green indicator windows and release slots, top and bottom terminal screws, remote contact pins.",
    tv=etv(415, 0, True, 1400), conns=[PWR('DIN Rail', 'top', 'Supply')], cat='Electrical Equipment')

# 62 Theatre supplementary equipotential bonding bar, 16-way
p = [F('Back Plate', [-220, -10, 0, 220, 0, 160], 'ss', 4),
     F('Tray Top', [-220, -80, 150, 220, -10, 160], 'ss', 0),
     F('Tray Bottom', [-220, -80, 0, 220, -10, 10], 'ss', 0),
     F('Tray Side', [-220, -80, 10, -210, -10, 150], 'ss', 0, rep=(2, 430, 0, 0)),
     B('Insulator', [-190, -50, 50, -160, -10, 110], 'black', 4, rep=(2, 350, 0, 0)),
     F('Bonding Bar', [-200, -60, 60, 200, -50, 100], 'copper', 2),
     C('Terminal Screw', 'y', [-180, 80], 4, [-70, -60], 'chrome', 'f', rep=(16, 24, 0, 0)),
     F('GY Label', [-150, -11, 120, 150, -10, 140], 'gy', 2, 'f'),
     C('Fixing Screw', 'y', [-190, 135], 3, [-11, -10], 'ss', 'f', rep=(2, 380, 0, 0)),
     C('Bonding Lead', 'z', [-180, -40], 4, [-200, 0], 'gy', 'f', rep=(4, 120, 0, 0))]
add('FMC_LP_LP_EquipotentialBar_Theatre', 'Supplementary equipotential bonding bar 16-way for group 2 locations (theatre), copper bar in an open-fronted stainless tray (clear cover by others)', 'IfcDiscreteAccessory',
    ['16-way_Group2'], p,
    {"Box 440 x 160 x 80 mm": A("440x160x80"), "16 terminals, R < 0.2 ohm to any exposed part": A("0.2 ohm", "BS 7671 710 / HTM 06-01"), "Height 300 mm": A(300)},
    "EBB: stainless back plate and tray with screws, two insulators, copper bonding bar with 16 terminal screws, green/yellow label, bonding leads below.",
    tv={"Default Elevation": 300}, cat='Electrical Fixtures')

# 63 Conductor clip (tape type shown)
p = [B('Clip Base', [-20, -10, -16, 20, 0, 16], 'grey', 2),
     B('Clip Saddle', [-20, -16, -16, 20, -13, 16], 'grey', 2),
     B('Saddle Side', [-20, -13, -16, -15, -10, 16], 'grey', 0, rep=(2, 35, 0, 0)),
     B('Tape', [-12.5, -13, -150, 12.5, -10, 150], 'copper'),
     C('Fixing Screw', 'y', [0, 0], 3, [-17, -16], 'chrome', 'f'),
     C('Wall Plug', 'y', [0, 0], 3, [0, 40], 'grey', 'f')]
p[3]['at'] = [-12.5, -13, -150, 12.5, -10, -16]; p[3]['only'] = ['25x3_Tape']
p.insert(4, B('Tape Upper', [-12.5, -13, 16, 12.5, -10, 150], 'copper'))
p[4]['only'] = ['25x3_Tape']
p += ONLY(['8mm_Round'], [C('Round Conductor', 'z', [0, -11.5], 4, [-150, 150], 'copper')])
p[0]['at'] = [-20, -10, -16, 20, 0, 16]
add('FMC_LP_LP_ConductorClip', 'Down conductor DC clip for 25 x 3 tape (round 8 mm type by type name), PVC, screw fixed, with tape stub', 'IfcFastener',
    [('25x3_Tape', {}), ('8mm_Round', {})], p,
    {"Clip 40 x 32 x 16 mm": A("40x32x16"), "Fixings at 1 m vertical, 0.5 m horizontal": A(1000, "BS EN 62305-3 Table")},
    "Clip: base, saddle and sides around a 25 x 3 tape stub (Tape) or 8 mm round conductor (Round), fixing screw, wall plug.",
    cat='Electrical Fixtures')

# 64 Ring earth electrode run: 1 m segment buried 600, with a tape joint clamp
p = [B('Tape Run', [-500, -1.5, -12.5, 500, 1.5, 12.5], 'copper'),
     B('Joint Clamp', [-30, -10, -20, 30, 10, 20], 'brass'),
     C('Clamp Bolt', 'y', [-15, 0], 4, [-14, -10], 'chrome', 'f', rep=(2, 30, 0, 0)),
     B('Rivet Joint', [400, -2, -12.5, 450, 2, 12.5], 'copper', 0, 'f'),
     C('Rivet', 'y', [415, 0], 3, [-3, -2], 'copper', 'f', rep=(2, 20, 0, 0))]
add('FMC_LP_LP_RingEarth_Conductor', 'Ring earth electrode: 25 x 3 bare copper tape laid on edge 600 mm deep, 1 m segment with a joint clamp and riveted joint', 'IfcCableSegment',
    ['25x3_Tape'], p,
    {"Tape 25 x 3 mm, 1000 mm segment": A("25x3", "BS EN 62561-2"), "Depth 600 mm, 1 m from walls": A(600, "BS EN 62305-3 type B arrangement")},
    "Ring earth segment: copper tape on edge, joint clamp with two bolts, riveted joint; place along the route at -600 mm.",
    cat='Generic Models')

# =============================================================== build
REVIEW = os.environ.get('FMC_REVIEW', '/tmp/claude-0/-home-claude/ce672511-dda7-500e-94dd-9bdb64997d11/scratchpad/E_batch/types')
os.makedirs(REVIEW, exist_ok=True)
# ceiling products with parts above the ceiling (back boxes, domes, frames): the compiler's own test needs the hint
BELOW = {'FMC_E_Comms_PA_Speaker_Ceiling', 'FMC_E_LightFixture_Panel_600_Cleanroom_IP65', 'FMC_E_LightFixture_Panel_600_General',
         'FMC_E_LightFixture_Downlight_LED', 'FMC_E_LightFixture_OperatingLight_Ceiling', 'FMC_E_Comms_WiFi_AccessPoint',
         'FMC_E_SecurityDevice_CCTV_Camera_Dome', 'FMC_E_LightFixture_Batten_LED'}
for _p in P:
    if _p['family'] in BELOW: _p['view'] = 'below'
SKIPPED = []   # no Profiles in this batch

def build(prod):
    n = len(fp.expand(prod['parts']))
    assert n <= 70, (prod['family'], n)
    for c in prod.get('connectors', []):
        assert any(p['n'] == c['part'] for p in prod['parts']), (prod['family'], c)
    import re
    for t in prod['types']:
        assert re.match(r'^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$', t['name']), t['name']
    for k, v in prod['materials'].items():
        assert v in KITM, v
    f = prod['family']
    json.dump(prod, open(os.path.join(HERE, f + '.product.json'), 'w'), indent=1)
    r = fp.compile_product(prod)
    json.dump(r, open(os.path.join(HERE, f + '.recipe.json'), 'w'), indent=1)
    fp.render(prod, os.path.join(HERE, f + '.preview.png'))
    fp.render_type_image(prod, os.path.join(HERE, f + '.png'), size=600)
    for t in prod['types'][1:]:   # other types: review previews in the scratchpad, not in the pack
        if any(t['name'] in q.get('only', []) for q in prod['parts']):
            fp.render(dict(prod, _render_type=t['name']), os.path.join(REVIEW, f'{f}__{t["name"]}.preview.png'))
    return f, n, len(r['ops'])

KITM = set(open(os.path.join(HERE, 'batches', 'KIT_MATERIALS.txt')).read().split())
if __name__ == '__main__':
    assert len(P) == len(RECS), (len(P), len(RECS), set(RECS) - {p['family'] for p in P})
    json.dump(NEEDED, open(os.path.join(HERE, 'batches', 'E_electrical.materials_needed.json'), 'w'), indent=1)
    sel = [p for p in P if not sys.argv[1:] or any(a in p['family'] for a in sys.argv[1:])]
    from multiprocessing import Pool
    with Pool(2) as pool:
        for row in pool.imap(build, sel): print(*row, flush=True)
