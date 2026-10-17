"""Healthcare pack, batch P_plumbing_medgas (17 Oct): 59 plumbing fixtures, pipe accessories, plumbing equipment and
medical gas plant modelled as generic products (photo-to-family pipeline). Same schema as make_products.py; compile and
render with ../../tools/fmc_parts.py. Brand and model stay open (reference = the record's generic ref).
Run: python3 gen_P_plumbing_medgas.py [family-substring ...]   (writes <family>.product.json/.recipe.json/.preview.png/.png)"""
import json, os, sys, math
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import fmc_parts as fp

RECS = {r['family']: r for r in json.load(open(os.path.join(HERE, 'batches', 'P_plumbing_medgas.json')))}
A = lambda v, src='typical product, to confirm with the supplier': {"value": v, "source_status": "assumed", "source": src}

# material keys double as subcategory names (title-cased), so keep them readable
MAT = {
    'china': 'FMC_Ceramic_VitreousChina_White', 'chrome': 'FMC_Metal_Chrome_Polished', 'stainless': 'FMC_Metal_StainlessSteel_Brushed',
    'white': 'FMC_Plastic_ABS_White', 'grey': 'FMC_Plastic_ABS_Grey', 'medical_grey': 'FMC_Plastic_ABS_MedicalGrey', 'black': 'FMC_Plastic_ABS_Black',
    'blue': 'FMC_Plastic_ABS_Blue', 'yellow': 'FMC_Plastic_ABS_Yellow', 'led_red': 'FMC_Plastic_LED_Red', 'led_green': 'FMC_Plastic_LED_Green',
    'led_blue': 'FMC_Plastic_LED_Blue', 'brass': 'FMC_Metal_Brass_Polished', 'copper': 'FMC_Metal_Copper_Pipe', 'painted_steel': 'FMC_Metal_SteelLTZ_Painted',
    'epoxy_white': 'FMC_Metal_Steel_EpoxyCoated_White', 'galvanised': 'FMC_Metal_GI_Pipe', 'aluminium': 'FMC_Metal_Aluminium_Anodised_Silver',
    'powder_coat': 'FMC_Metal_Aluminium_PowderCoated', 'rubber': 'FMC_Rubber_Black', 'glass': 'FMC_Glass_Clear', 'polycarbonate': 'FMC_Plastic_Polycarbonate_Clear',
    'laminate': 'FMC_Plastic_Laminate_HPL', 'quartz': 'FMC_Stone_Quartz_Engineered_White', 'melamine': 'FMC_Board_Melamine_White',
    'upvc': 'FMC_Plastic_uPVC_Pipe_DarkGrey', 'hdpe': 'FMC_Plastic_HDPE_PE100_Black', 'tank': 'FMC_Plastic_WaterTank_Black', 'concrete': 'FMC_Concrete_Precast_Painted',
    'gloss_black': 'FMC_Paint_Gloss_Enamel', 'red': 'FMC_Plastic_FireHoseReel_Red', 'steel': 'FMC_Metal_StructuralSteel_S275', 'collector_glass': 'FMC_Glass_PV_Module',
    'vinyl': 'FMC_Fabric_Vinyl_Upholstery_Blue', 'castor': 'FMC_Plastic_Nylon_CastorGrey',
    # nearest kit material stands in; the wanted finish is in P_plumbing_medgas.materials_needed.json
    'epoxy_resin': 'FMC_Plastic_ABS_Black', 'grp': 'FMC_Plastic_ABS_Grey', 'french_blue': 'FMC_Plastic_ABS_Blue', 'safety_green': 'FMC_Plastic_LED_Green',
}
NEEDED = [
    {"name": "FMC_Plastic_EpoxyResin_Black", "colour": "#2A2C2E", "why": "lab sink and worktop in black epoxy resin (FMC_P_PlumbingFixture_Sink_Lab_Epoxy); ABS black stands in"},
    {"name": "FMC_Plastic_GRP_Panel", "colour": "#9FB0BC", "why": "GRP sectional tank panels (FMC_P_PlumbingEq_Tank_Sectional_GRP); ABS grey stands in"},
    {"name": "FMC_Plastic_ABS_FrenchBlue", "colour": "#1F4E99", "why": "BS 1710 / BS 381C 166 French blue for nitrous oxide terminal rings and labels; ABS blue (#2F6DB5) stands in"},
    {"name": "FMC_Plastic_Sign_SafetyGreen", "colour": "#008C45", "why": "ISO 7010 safety green for the emergency shower sign; LED green stands in"},
]
# BS 1710 / HTM 02-01 gas identification colours (ring, label)
GAS = {'O2': ('white', 'black'), 'N2O': ('french_blue', 'french_blue'), 'MA4': ('black', 'white'), 'SA7': ('black', 'white'),
       'VAC': ('yellow', 'yellow'), 'AGSS': ('grey', 'black'), 'ENT': ('french_blue', 'white')}

# ------------------------------------------------------------------ part helpers
def _p(d, lod):
    if lod != 'mf': d['lod'] = lod
    return d
def B(n, at, m, r=0, lod='mf'):
    d = {"n": n, "shape": "box", "at": [round(v, 1) for v in at], "mat": m}
    if r: d['r'] = r
    return _p(d, lod)
def F(n, at, m, r=0, lod='mf'):
    d = {"n": n, "shape": "fbox", "at": [round(v, 1) for v in at], "mat": m}
    if r: d['r'] = r
    return _p(d, lod)
def C(n, axis, c, r, rng, m, lod='mf', seg=None):
    d = {"n": n, "shape": "cyl", "axis": axis, "c": list(c), "r": r, axis: list(rng), "mat": m}
    if seg: d['seg'] = seg
    return _p(d, lod)
def T(n, axis, c, prof, m, lod='mf'):
    return _p({"n": n, "shape": "turn", "axis": axis, "c": list(c), "profile": [list(q) for q in prof], "mat": m}, lod)
def PR(n, pts, z, m, lod='mf'):
    return _p({"n": n, "shape": "prism", "pts": [[round(a, 1), round(b, 1)] for a, b in pts], "z": list(z), "mat": m}, lod)
def FR(n, pts, y, m, lod='mf'):
    return _p({"n": n, "shape": "front", "pts": [list(q) for q in pts], "y": list(y), "mat": m}, lod)
def RT(n, pts, x, m, lod='mf'):
    return _p({"n": n, "shape": "right", "pts": [list(q) for q in pts], "x": list(x), "mat": m}, lod)
def VD(p):
    p = dict(p); p['void'] = True; p.pop('mat', None); p.pop('lod', None); return p
def R(p, n, d):
    p['repeat'] = {"n": n, "d": list(d)}; return p

def sp(cx, cy, a, b, n, t):
    c, s = math.cos(math.radians(t)), math.sin(math.radians(t))
    return [cx + a * math.copysign(abs(c) ** (2 / n), c), cy + b * math.copysign(abs(s) ** (2 / n), s)]
def oval(cx, cy, a, b, n=2, k=32, t0=0, t1=360):
    return [sp(cx, cy, a, b, n, t0 + (t1 - t0) * i / k) for i in range(k + (0 if t1 - t0 == 360 else 1))]
def ring(name, c, outer, inner, z, m, seg=8, k=3, lod='mf', t0=-90, t1=270):
    """Hollow rim as `seg` sectors (each a simple, fan-safe polygon): outer/inner = (a, b, n) superellipse half-sizes."""
    out = []
    for i in range(seg):
        ta = t0 + (t1 - t0) * i / seg; tb = t0 + (t1 - t0) * (i + 1) / seg
        ts = [ta + (tb - ta) * j / (k - 1) for j in range(k)]
        pts = [sp(c[0], c[1], *outer, t) for t in ts] + [sp(c[0], c[1], *inner, t) for t in reversed(ts)]
        out.append(PR(f"{name} {i + 1}", pts, z, m, lod))
    return out
def sqbowl(name, x0, y0, x1, y1, z0, z1, t, m, lod='mf'):
    """Square-cornered sink bowl (stainless / resin): floor + four walls; outer box given."""
    return [B(f"{name} Floor", (x0, y0, z0, x1, y1, z0 + t), m, lod=lod), B(f"{name} Front", (x0, y0, z0, x1, y0 + t, z1), m, lod=lod),
            B(f"{name} Back", (x0, y1 - t, z0, x1, y1, z1), m, lod=lod), B(f"{name} Left", (x0, y0 + t, z0, x0 + t, y1 - t, z1), m, lod=lod),
            B(f"{name} Right", (x1 - t, y0 + t, z0, x1, y1 - t, z1), m, lod=lod)]
def deck_frame(name, x0, y0, x1, y1, holes, z0, z1, m):
    """A deck / worktop with rectangular cut-outs `holes` [(hx0,hy0,hx1,hy1)] sharing one y band: strips around them."""
    hy0, hy1 = holes[0][1], holes[0][3]
    p = [B(f"{name} Front", (x0, y0, z0, x1, hy0, z1), m), B(f"{name} Back", (x0, hy1, z0, x1, y1, z1), m)]
    xs = [x0] + [v for h in holes for v in (h[0], h[2])] + [x1]
    for i in range(0, len(xs), 2):
        if xs[i + 1] - xs[i] > 0.5: p.append(B(f"{name} Strip {i // 2 + 1}", (xs[i], hy0, z0, xs[i + 1], hy1, z1), m))
    return p
def waste(name, x, y, z, r=24, hole=True, m='chrome'):
    p = [C(f"{name} Plug", 'z', (x, y), r, (z, z + 2), m, 'f'), T(f"{name} Grid", 'z', (x, y), [[r * 0.35, z + 2], [r * 0.45, z + 2], [r * 0.45, z + 3], [r * 0.35, z + 3]], 'black', 'f')]
    if hole: p.append(VD(C(f"{name} Hole", 'z', (x, y), r * 0.8, (z - 30, z + 1), None)))
    return p
def deck_mixer(pre, x, y, z, reach=150, h=200, lever=120, m='chrome'):
    """Monobloc / gooseneck mixer on a deck at z, spout reaching toward -y."""
    return [T(f"{pre} Base", 'z', (x, y), [[0, z], [28, z], [26, z + 8], [0, z + 8]], m),
            C(f"{pre} Body", 'z', (x, y), 22, (z + 8, z + h), m),
            C(f"{pre} Spout", 'y', (x, z + h - 12), 11, (y - reach, y), m),
            C(f"{pre} Nozzle", 'z', (x, y - reach + 8), 12, (z + h - 60, z + h - 2), m),
            T(f"{pre} Aerator", 'z', (x, y - reach + 8), [[0, z + h - 66], [10, z + h - 66], [12, z + h - 60], [0, z + h - 60]], 'black', 'f'),
            C(f"{pre} Lever Hub", 'x', (y, z + h - 50), 14, (x + 20, x + 38), m, 'f'),
            B(f"{pre} Lever", (x + 30, y - 8, z + h - 56, x + 30 + lever, y + 8, z + h - 44), m, r=4, lod='f')]
def wall_mixer(pre, x, z, reach=180, lever=170, y0=0, m='chrome'):
    """Wall-mounted clinical mixer, elbow lever: rosettes, body bar, spout toward -y, down-turned nozzle."""
    return [R(C(f"{pre} Rosette", 'y', (x - 75, z), 30, (y0 - 8, y0), m, 'f'), 2, (150, 0, 0)),
            R(C(f"{pre} Union", 'y', (x - 75, z), 14, (y0 - 40, y0 - 8), m), 2, (150, 0, 0)),
            C(f"{pre} Body", 'x', (y0 - 50, z), 24, (x - 95, x + 95), m),
            C(f"{pre} Spout", 'y', (x, z - 10), 11, (y0 - 50 - reach, y0 - 60), m),
            C(f"{pre} Nozzle", 'z', (x, y0 - 50 - reach + 10), 11, (z - 70, z - 10), m),
            T(f"{pre} Aerator", 'z', (x, y0 - 50 - reach + 10), [[0, z - 76], [9, z - 76], [11, z - 70], [0, z - 70]], 'black', 'f'),
            C(f"{pre} Lever Hub", 'z', (x + 60, y0 - 50), 16, (z + 24, z + 46), m),
            B(f"{pre} Elbow Lever", (x + 60, y0 - 58, z + 34, x + 60 + lever, y0 - 42, z + 44), m, r=4)]
def bib_tap(pre, x, z, m='chrome', handle='red', y0=0):
    return [C(f"{pre} Flange", 'y', (x, z), 26, (y0 - 6, y0), m, 'f'), C(f"{pre} Body", 'y', (x, z), 15, (y0 - 70, y0 - 6), m),
            C(f"{pre} Nose", 'z', (x, y0 - 62), 10, (z - 55, z), m), C(f"{pre} Headwork", 'z', (x, y0 - 45), 14, (z, z + 30), m),
            B(f"{pre} Lever", (x - 6, y0 - 110, z + 30, x + 6, y0 - 40, z + 40), handle, r=3, lod='f')]
def gauge(pre, x, y, z, r=40, face='y', m='chrome', stem=True):
    """Dial gauge facing -y (face='y') or +x (face='x'); bezel, white dial, needle."""
    if face == 'y':
        p = [C(f"{pre} Case", 'y', (x, z), r, (y - 25, y), m), C(f"{pre} Dial", 'y', (x, z), r - 4, (y - 27, y - 25), 'white', 'f'),
             B(f"{pre} Needle", (x - 1.5, y - 29, z - 2, x + r * 0.6, y - 27, z + 2), 'black', lod='f')]
        if stem: p.append(C(f"{pre} Stem", 'z', (x, y - 12), 6, (z - r - 30, z - r + 2), 'brass', 'f'))
    else:
        p = [C(f"{pre} Case", 'x', (y, z), r, (x, x + 25), m), C(f"{pre} Dial", 'x', (y, z), r - 4, (x + 25, x + 27), 'white', 'f'),
             B(f"{pre} Needle", (x + 27, y - 2, z - 1.5, x + 29, y + 2, z + r * 0.6), 'black', lod='f')]
    return p
def handwheel(pre, x, y, z, R_=80, m='red', axis='z'):
    """Valve handwheel: rim (turned ring), two spokes, hub; axis z = wheel lies flat on a vertical stem."""
    if axis == 'z':
        return [T(f"{pre} Rim", 'z', (x, y), [[R_ - 9, z], [R_, z], [R_, z + 10], [R_ - 9, z + 10]], m),
                B(f"{pre} Spoke A", (x - R_ + 5, y - 5, z + 2, x + R_ - 5, y + 5, z + 8), m, lod='f'),
                B(f"{pre} Spoke B", (x - 5, y - R_ + 5, z + 2, x + 5, y + R_ - 5, z + 8), m, lod='f'),
                C(f"{pre} Hub", 'z', (x, y), 16, (z, z + 18), m)]
    return [T(f"{pre} Rim", 'y', (x, z), [[R_ - 9, y], [R_, y], [R_, y - 10], [R_ - 9, y - 10]], m),
            B(f"{pre} Spoke A", (x - R_ + 5, y - 8, z - 5, x + R_ - 5, y - 2, z + 5), m, lod='f'),
            B(f"{pre} Spoke B", (x - 5, y - 8, z - R_ + 5, x + 5, y - 2, z + R_ - 5), m, lod='f'),
            C(f"{pre} Hub", 'y', (x, z), 16, (y - 18, y), m)]
def motor_x(pre, x0, x1, y, z, r, m='blue', feet=True, fins=4):
    """Horizontal foot-mounted motor along x: finned body, fan cowl at x0, terminal box, feet."""
    L = x1 - x0
    p = [C(f"{pre} Motor", 'x', (y, z), r, (x0 + 0.18 * L, x1), m),
         T(f"{pre} Fan Cowl", 'x', (y, z), [[0, x0], [r * 0.9, x0], [r + 4, x0 + 0.05 * L], [r + 4, x0 + 0.18 * L], [0, x0 + 0.18 * L]], m),
         T(f"{pre} Cowl Grille", 'x', (y, z), [[0, x0 - 2], [r * 0.6, x0 - 2], [r * 0.6, x0], [0, x0]], 'black', 'f'),
         B(f"{pre} Terminal Box", (x0 + 0.45 * L, y - r * 0.45, z + r - 5, x0 + 0.75 * L, y + r * 0.45, z + r + r * 0.45), m, r=4)]
    if fins: p.append(R(T(f"{pre} Fin", 'x', (y, z), [[r, x0 + 0.25 * L], [r + 5, x0 + 0.25 * L], [r + 5, x0 + 0.25 * L + 6], [r, x0 + 0.25 * L + 6]], m, 'f'), fins, (0.7 * L / fins, 0, 0)))
    if feet: p.append(R(B(f"{pre} Foot", (x0 + 0.25 * L, y - r * 0.85, z - r - 8, x0 + 0.33 * L, y + r * 0.85, z - r * 0.55), m), 2, (0.5 * L, 0, 0)))
    return p
def motor_z(pre, x, y, z0, z1, r, m='blue'):
    """Vertical motor on a pump: body, fan cowl on top, terminal box on the -y side."""
    H = z1 - z0
    return [C(f"{pre} Motor", 'z', (x, y), r, (z0, z0 + 0.8 * H), m),
            T(f"{pre} Fan Cowl", 'z', (x, y), [[0, z0 + 0.8 * H], [r + 4, z0 + 0.8 * H], [r + 4, z1 - 10], [r * 0.8, z1], [0, z1]], m),
            B(f"{pre} Terminal Box", (x - r * 0.4, y - r - r * 0.45, z0 + 0.35 * H, x + r * 0.4, y - r + 10, z0 + 0.65 * H), m, r=4),
            R(T(f"{pre} Fin", 'z', (x, y), [[r, z0 + 0.12 * H], [r + 5, z0 + 0.12 * H], [r + 5, z0 + 0.12 * H + 6], [r, z0 + 0.12 * H + 6]], m, 'f'), 4, (0, 0, 0.15 * H))]
def panel(pre, x0, x1, z0, z1, yf, depth=200, m='epoxy_white', screen=True, leds=('led_green', 'yellow', 'led_red'), isolator=True):
    """Control panel on its front face yf (facing -y): enclosure, door, HMI screen, LEDs, isolator, door handle."""
    W, H = x1 - x0, z1 - z0
    p = [B(f"{pre} Enclosure", (x0, yf, z0, x1, yf + depth, z1), m, r=4),
         F(f"{pre} Door", (x0 + 8, yf - 6, z0 + 8, x1 - 8, yf, z1 - 8), m, r=4, lod='f')]
    if screen: p.append(F(f"{pre} Screen", (x0 + 0.2 * W, yf - 8, z0 + 0.6 * H, x0 + 0.65 * W, yf - 6, z0 + 0.86 * H), 'black', r=3, lod='f'))
    for i, l in enumerate(leds):
        p.append(C(f"{pre} LED {i + 1}", 'y', (x0 + 0.2 * W + i * 0.12 * W, z0 + 0.48 * H), 8, (yf - 10, yf - 6), l, 'f'))
    if isolator:
        p += [F(f"{pre} Isolator Plate", (x1 - 0.28 * W, yf - 8, z0 + 0.2 * H, x1 - 0.08 * W, yf - 6, z0 + 0.38 * H), 'yellow', lod='f'),
              F(f"{pre} Isolator Handle", (x1 - 0.2 * W, yf - 26, z0 + 0.22 * H, x1 - 0.16 * W, yf - 8, z0 + 0.36 * H), 'red', r=2, lod='f')]
    p.append(F(f"{pre} Door Handle", (x0 + 0.1 * W, yf - 22, z0 + 0.15 * H, x0 + 0.14 * W, yf - 6, z0 + 0.38 * H), 'black', r=2, lod='f'))
    return p
def vessel(pre, x, y, z0, z1, r, m='epoxy_white', legs=True, band=None):
    """Vertical pressure vessel with dished ends on three legs."""
    d = min(r * 0.35, 120)
    p = [C(f"{pre} Shell", 'z', (x, y), r, (z0 + d, z1 - d), m),
         T(f"{pre} Top Head", 'z', (x, y), [[0, z1 - d], [r, z1 - d], [r * 0.85, z1 - d * 0.35], [r * 0.4, z1], [0, z1]], m),
         T(f"{pre} Bottom Head", 'z', (x, y), [[0, z0], [r * 0.4, z0], [r * 0.85, z0 + d * 0.65], [r, z0 + d], [0, z0 + d]], m)]
    if legs and z0 > 0:
        for i, a in enumerate((90, 210, 330)):
            lx, ly = x + 0.8 * r * math.cos(math.radians(a)), y + 0.8 * r * math.sin(math.radians(a))
            p.append(B(f"{pre} Leg {i + 1}", (lx - 20, ly - 20, 0, lx + 20, ly + 20, z0 + d), 'painted_steel'))
    if band: p.append(T(f"{pre} Band", 'z', (x, y), [[r, z0 + 0.6 * (z1 - z0)], [r + 2, z0 + 0.6 * (z1 - z0)], [r + 2, z0 + 0.6 * (z1 - z0) + 60], [r, z0 + 0.6 * (z1 - z0) + 60]], band, 'f'))
    return p
def tu(pre, x, z, gas, y0=0, size=90):
    """Compact BS 5682 terminal unit on a face at y0 (fascia, gas ring, chrome collar, label)."""
    ring_m, lab = GAS[gas]; h = size / 2
    return [F(f"{pre} Fascia", (x - h, y0 - 10, z - h, x + h, y0, z + h), 'white', r=7),
            T(f"{pre} Ring", 'y', (x, z + 6), [[16, y0 - 10], [24, y0 - 10], [24, y0 - 14], [16, y0 - 14]], ring_m),
            T(f"{pre} Collar", 'y', (x, z + 6), [[0, y0 - 10], [16, y0 - 10], [16, y0 - 22], [13, y0 - 24], [5, y0 - 24], [5, y0 - 20], [0, y0 - 20]], 'chrome'),
            F(f"{pre} Label", (x - h * 0.6, y0 - 10.6, z - h + 8, x + h * 0.6, y0 - 10, z - h + 18), lab, r=2, lod='f')]
def socket(pre, x, z, y0=0, m='white', switch='white'):
    """Twin switched socket plate 146 x 86 on a face at y0."""
    return [F(f"{pre} Plate", (x - 73, y0 - 9, z - 43, x + 73, y0, z + 43), m, r=5),
            R(F(f"{pre} Face", (x - 62, y0 - 10, z - 25, x - 20, y0 - 9, z + 15), 'black', r=3, lod='f'), 2, (82, 0, 0)),
            R(F(f"{pre} Rocker", (x - 46, y0 - 13, z + 22, x - 30, y0 - 9, z + 36), switch, r=2, lod='f'), 2, (82, 0, 0))]
def stub(n, x, y, z0, z1, r=11, m='copper', lod='mf'):
    return C(n, 'z', (x, y), r, (z0, z1), m, lod)

# ------------------------------------------------------------------ connectors
def CW(part, side='back', n='CW', flow='In', d=15): return {"n": n, "domain": "pipe", "system": "DomesticColdWater", "part": part, "side": side, "diameter": d, "flow": flow}
def HW(part, side='back', n='HW', flow='In', d=15): return {"n": n, "domain": "pipe", "system": "DomesticHotWater", "part": part, "side": side, "diameter": d, "flow": flow}
def SAN(part, side='back', n='Waste', d=40, flow='Out'): return {"n": n, "domain": "pipe", "system": "Sanitary", "part": part, "side": side, "diameter": d, "flow": flow}
def VNT(part, side='bottom', n='Vent', d=110): return {"n": n, "domain": "pipe", "system": "Vent", "part": part, "side": side, "diameter": d}
def MG(gas, part, side='back', flow='In', d=15): return {"n": gas, "domain": "pipe", "system": "Other", "part": part, "side": side, "diameter": d, "flow": flow}
def ST(part, side='back', n='Steam', flow='In', d=25): return {"n": n, "domain": "pipe", "system": "Other", "part": part, "side": side, "diameter": d, "flow": flow}
def E(part, side='back', n='Power'): return {"n": n, "domain": "electrical", "system": "PowerBalanced", "part": part, "side": side}
def ELV(part, system, side='back', n=None): return {"n": n or system, "domain": "electrical", "system": system, "part": part, "side": side}

P = []
def add(fam, desc, ifc, types, parts, conns, values, about, template=None, category=None, type_values=None, clearances=None, extra=None):
    rec = RECS[fam]
    mats = {}
    for p in parts:
        if p.get('mat'): mats[p['mat']] = MAT[p['mat']]
    prod = {"family": fam, "category": category or rec['category'], "desc": desc, "ifc": ifc, "keynote": rec['kn'],
            "types": [t if isinstance(t, dict) else {"name": t} for t in types], "materials": mats,
            "reference": dict(rec['ref']), "parts": parts, "connectors": conns, "values": values, "about": about}
    tpl = template or ("Metric Mechanical Equipment.rft" if rec['category'] == 'Mechanical Equipment' else "Metric Generic Model.rft")
    prod['template'] = tpl
    if type_values: prod['type_values'] = type_values
    if clearances: prod['clearances'] = clearances
    if extra: prod.update(extra)
    P.append(prod)
    return prod

# =================================================================== PLUMBING FIXTURES
# 1 Vanity basin: one-piece vitreous china vanity top with oval bowl, monobloc mixer, two-door cabinet, recessed plinth
f = 'FMC_P_PlumbingFixture_Basin_Vanity'
cy = -235
parts = ring("Vanity Top", (0, cy), (305, 235, 10), (205, 155, 2.4), (820, 850), 'china', seg=8, k=4)
parts += ring("Bowl Wall", (0, cy - 5), (215, 165, 2.4), (200, 150, 2.4), (690, 820), 'china', seg=6)
parts += [PR("Bowl Floor", oval(0, cy - 5, 205, 155, 2.4, 24), (680, 695), 'china'),
          T("Bowl Slope", 'z', (0, cy - 5), [[60, 695], [150, 695], [150, 712], [60, 700]], 'china', 'f'),
          B("Cabinet", (-290, -440, 100, 290, 0, 818), 'melamine'),
          B("Plinth", (-280, -400, 0, 280, -20, 100), 'grey'),
          R(F("Door", (-288, -458, 110, -3, -440, 812), 'laminate', r=3), 2, (291, 0, 0)),
          R(F("Door Handle", (-40, -478, 600, -28, -458, 780), 'chrome', r=4, lod='f'), 2, (68, 0, 0)),
          C("Supply Tails", 'z', (0, -60), 10, (700, 820), 'chrome', 'm'),
          C("Trap", 'z', (0, cy - 5), 32, (480, 680), 'chrome', 'f'),
          C("Waste Arm", 'y', (0, 520), 20, (cy - 5, 0), 'chrome')]
parts += waste("Waste", 0, cy - 5, 695) + deck_mixer("Mixer", 0, -60, 850, reach=125, h=180, lever=90)
add(f, "Vanity basin 600 mm: one-piece vitreous china top with oval bowl on a two-door melamine cabinet, monobloc lever mixer",
    "IfcSanitaryTerminal", ["600_Single", "1200_Double"], parts,
    [CW("Supply Tails", 'bottom'), HW("Mixer Body", 'bottom'), SAN("Waste Arm")],
    {"Width 600 mm, depth 470 mm": A("600x470"), "Rim height 850 mm": A(850, "HBN 00-10 Part C / BS 6465 basin height"), "Waste 32/40 mm": A(40)},
    "Vanity basin modelled as a generic product: china top with oval bowl (rim sectors, bowl wall, floor, waste), monobloc mixer, two-door cabinet, recessed plinth. Geometry drawn at the 600 single type; the 1200 double type shares it until a two-bowl body is added.")

# 2 Accessible basin with knee space
f = 'FMC_P_PlumbingFixture_Basin_Accessible'
cy = -235
parts = ring("Basin Rim", (0, cy), (275, 225, 4), (205, 150, 2.4), (690, 760), 'china', seg=8, k=4)
parts += [B("Tap Ledge", (-265, -85, 690, 265, 0, 760), 'china', r=20),
          PR("Basin Floor", oval(0, cy, 270, 220, 4, 28), (655, 690), 'china'),
          T("Bowl Slope", 'z', (0, cy - 10), [[50, 690], [170, 690], [170, 708], [50, 694]], 'china', 'f'),
          C("Overflow Slot", 'y', (0, 735), 8, (cy - 152, cy - 148), 'black', 'f'),
          C("Waste Tail", 'z', (0, cy), 18, (590, 655), 'chrome'),
          C("Waste Arm", 'y', (0, 600), 18, (cy, 0), 'chrome'),
          F("Wall Flange", (-200, -12, 660, 200, 0, 700), 'china', r=10, lod='f'),
          C("Supply Tails", 'y', (0, 740), 9, (-60, 0), 'chrome', 'm')]
parts += waste("Waste", 0, cy - 10, 690) + deck_mixer("Mixer", 0, -45, 760, reach=140, h=170, lever=170)
add(f, "Accessible wall-hung basin 550 mm, vitreous china, shallow body and wall-tight waste for knee space, long-lever monobloc mixer",
    "IfcSanitaryTerminal", ["550_Accessible"], parts,
    [CW("Supply Tails"), HW("Mixer Body", 'bottom'), SAN("Waste Arm")],
    {"Width 550 mm, projection 450 mm": A("550x450"), "Rim height 760 mm": A(760, "BS 8300-2 basin rim 720-760 mm"), "Knee space under rim 600 mm min": A(600, "BS 8300-2")},
    "Accessible basin modelled as a generic product: shallow china bowl (rim sectors, floor, slope), tap ledge, long-lever mixer, waste run tight to the wall to keep the knee space clear; approach zone as a clearance.",
    clearances=[{"n": "Approach Zone", "shape": "box", "at": [-450, -1550, 0, 450, -450, 10], "sub": "Clearance Accessibility"}])

# 3 Theatre scrub trough, stainless, 2-bay drawn; arrayed CW/HW/SAN per bay
f = 'FMC_P_PlumbingFixture_ScrubTrough_Theatre'
parts = [F("Front Apron", (-600, -600, 650, 600, -585, 950), 'stainless', r=6),
         B("Front Rim", (-600, -612, 935, 600, -585, 955), 'stainless', r=6),
         R(B("End Wall", (-600, -600, 740, -585, -15, 955), 'stainless'), 2, (1185, 0, 0)),
         B("Upstand", (-600, -15, 740, 600, 0, 1300), 'stainless'),
         RT("Trough Floor", [[-585, 790], [-15, 742], [-15, 726], [-585, 774]], (-585, 585), 'stainless'),
         B("Underside Skirt", (-585, -585, 650, 585, -560, 790), 'stainless', lod='f'),
         R(RT("Wall Bracket", [[-560, 650], [0, 650], [0, 740], [-80, 740]], (-560, -548), 'stainless', 'f'), 2, (1108, 0, 0)),
         F("Upstand Capping", (-600, -20, 1290, 600, 0, 1305), 'stainless', lod='f')]
for i, x in enumerate((-300, 300)):
    k = i + 1
    parts += [C(f"Spout {k}", 'y', (x, 1150), 12, (-300, -15), 'stainless'), C(f"Nozzle {k}", 'z', (x, -290), 12, (1085, 1150), 'stainless'),
              T(f"Aerator {k}", 'z', (x, -290), [[0, 1078], [10, 1078], [12, 1085], [0, 1085]], 'black', 'f'),
              F(f"Sensor Window {k}", (x - 25, -18, 1040, x + 25, -15, 1070), 'black', r=6, lod='f'),
              F(f"TMV Access Panel {k}", (x - 110, -17, 1190, x + 110, -15, 1270), 'stainless', r=4),
              R(C(f"TMV Panel Screw {k}", 'y', (x - 100, 1200), 3, (-18, -17), 'chrome', 'f'), 2, (200, 0, 0)),
              F(f"Knee Paddle {k}", (x - 70, -625, 680, x + 70, -612, 760), 'stainless', r=10),
              C(f"Waste Outlet {k}", 'z', (x, -60), 22, (600, 744), 'stainless'),
              C(f"Waste Plug {k}", 'z', (x, -60), 30, (744, 746), 'chrome', 'f'), VD(C(f"Waste Hole {k}", 'z', (x, -60), 20, (700, 760), None))]
conns = []
for k in (1, 2):
    conns += [CW(f"TMV Access Panel {k}", 'back', f"CW {k}"), HW(f"TMV Access Panel {k}", 'top', f"HW {k}"), SAN(f"Waste Outlet {k}", 'bottom', f"Waste {k}")]
add(f, "Theatre scrub trough, 2-bay stainless steel 1200 mm, sloped trough, 350 mm upstand, wall spouts with sensor and knee control, TMV per bay",
    "IfcSanitaryTerminal", ["600_1Bay", "1200_2Bay", "1800_3Bay"], parts, conns,
    {"Length 1200 mm (2-bay), projection 600 mm": A("1200x600"), "Rim height 950 mm": A(950, "HBN 26 / theatre scrub practice"), "Bay width 600 mm": A(600, "one surgeon per bay")},
    "Scrub trough modelled as a generic product: stainless apron, rim, end walls, sloped trough floor, upstand with capping, per bay a wall spout, sensor window, TMV access panel, knee paddle and waste. Drawn at 2 bays with CW/HW/waste arrayed per bay; 1-bay and 3-bay share the geometry until bay count drives it.")

# 4 Sluice hopper with flushing rim, bucket grating, high-level cistern and flush pipe, bib taps
f = 'FMC_P_PlumbingFixture_Sink_Sluice_Hopper'
cy = -290
parts = [B("Pedestal", (-190, -470, 0, 190, -80, 520), 'china', r=60),
         PR("Bowl Body", oval(0, cy, 280, 240, 3.5, 28), (520, 700), 'china')]
parts += ring("Bowl Rim", (0, cy), (280, 240, 3.5), (230, 195, 2.6), (700, 865), 'china', seg=8)
parts += ring("Flushing Rim", (0, cy), (231, 196, 2.6), (214, 180, 2.6), (830, 850), 'china', seg=6, lod='f')
parts += [T("Bowl Throat", 'z', (0, cy), [[70, 700], [230, 700], [230, 720], [70, 704]], 'china', 'f'),
          B("Grating Frame Front", (-200, -500, 866, 200, -488, 878), 'stainless'),
          B("Grating Frame Back", (-200, -262, 866, 200, -250, 878), 'stainless'),
          R(B("Grating Bar", (-182, -488, 868, -174, -262, 876), 'stainless', lod='f'), 7, (58, 0, 0)),
          B("Back Outlet", (-60, -90, 140, 60, 0, 260), 'china'),
          F("Cistern", (-260, -190, 1750, 260, 0, 2020), 'china', r=20),
          F("Cistern Lid", (-270, -200, 2020, 270, 0, 2040), 'china', r=6),
          B("Flush Lever", (180, -240, 1980, 200, -190, 1995), 'chrome', lod='f'),
          C("Flush Pipe", 'z', (0, -50), 16, (858, 1750), 'chrome'),
          C("Flush Inlet", 'y', (0, 858), 20, (-100, -50), 'chrome')]
parts += bib_tap("Cold Tap", -320, 1100, handle='blue') + bib_tap("Hot Tap", 320, 1100, handle='red')
add(f, "Sluice hopper, vitreous china on pedestal, flushing rim, hinged stainless bucket grating, high-level cistern with flush pipe, hot and cold bib taps",
    "IfcSanitaryTerminal", ["600_FlushingRim"], parts,
    [CW("Cistern"), HW("Hot Tap Body"), SAN("Back Outlet", 'back', d=100)],
    {"Bowl 560 x 480 mm": A("560x480"), "Rim height 865 mm": A(865, "HBN 00-09 / sluice practice"), "Outlet 100 mm": A(100), "Cistern 9 l high level": A(9)},
    "Sluice hopper modelled as a generic product: pedestal, oval china bowl (rim sectors, flushing rim, throat), bucket grating with bars, high-level cistern, lever, flush pipe and two bib taps.")

# 5 Lab sink, black epoxy resin, undermount in a resin worktop, gooseneck with wrist blades, dilution trap
f = 'FMC_P_PlumbingFixture_Sink_Lab_Epoxy'
parts = deck_frame("Worktop", -450, -750, 450, 0, [(-300, -600, 300, -150)], 875, 900, 'epoxy_resin')
parts += sqbowl("Bowl", -320, -620, 320, -130, 600, 875, 20, 'epoxy_resin')
parts += [F("Worktop Drip Edge", (-450, -760, 860, 450, -750, 900), 'epoxy_resin', lod='f'),
          C("Drain Tail", 'z', (0, -375), 20, (460, 620), 'grey'),
          T("Dilution Trap", 'z', (0, -375), [[0, 300], [75, 300], [80, 320], [80, 440], [70, 460], [0, 460]], 'polycarbonate'),
          C("Waste Arm", 'y', (0, 400), 20, (-375, 0), 'grey'),
          T("Tap Base", 'z', (0, -80), [[0, 900], [35, 900], [30, 920], [0, 920]], 'chrome'),
          C("Gooseneck Riser", 'z', (0, -80), 13, (920, 1250), 'chrome'),
          T("Gooseneck Bend", 'y', (0, 1250), [[0, -80], [13, -80], [13, -120], [0, -120]], 'chrome'),
          C("Gooseneck Arm", 'y', (0, 1250), 13, (-290, -100), 'chrome'),
          C("Gooseneck Nozzle", 'z', (0, -280), 11, (1170, 1250), 'chrome'),
          T("Serrated Tip", 'z', (0, -280), [[0, 1135], [6, 1135], [9, 1150], [7, 1160], [10, 1170], [0, 1170]], 'chrome', 'f'),
          C("Valve Bodies", 'x', (-80, 960), 16, (-80, 80), 'chrome'),
          R(B("Wrist Blade", (-150, -92, 950, -80, -68, 970), 'chrome', r=4), 2, (230, 0, 0)),
          R(C("Index Button", 'x', (-80, 960), 9, (-150, -146), 'blue', 'f'), 2, (296, 0, 0))]
parts += waste("Drain", 0, -375, 620, r=30, m='grey')
add(f, "Laboratory sink in black epoxy resin, 600 x 450 x 275 mm undermount bowl in resin worktop, gooseneck with wrist-blade valves, dilution trap",
    "IfcSanitaryTerminal", ["450_Epoxy", "600_Epoxy"], parts,
    [CW("Tap Base", 'bottom'), SAN("Waste Arm", d=40)],
    {"Bowl 600 x 450 x 275 mm": A("600x450x275"), "Worktop height 900 mm": A(900, "laboratory bench height, HBN 15"), "Chemical-resistant epoxy resin": A("epoxy")},
    "Lab sink modelled as a generic product: resin worktop around the cut-out, square resin bowl (floor and four walls), polypropylene waste, dilution trap, gooseneck with serrated nozzle and wrist blades. Drawn at the 600 type; the 450 type shares it.")

# 6 Catering double-bowl sink unit on legs, stainless
f = 'FMC_P_PlumbingFixture_Sink_Kitchen_SS_Double'
holes = [(-560, -560, -60, -110), (60, -560, 560, -110)]
parts = deck_frame("Sink Top", -600, -650, 600, 0, holes, 870, 900, 'stainless')
parts += sqbowl("Bowl L", -560, -560, -60, -110, 600, 870, 2, 'stainless') + sqbowl("Bowl R", 60, -560, 560, -110, 600, 870, 2, 'stainless')
parts += [F("Bullnose Apron", (-600, -662, 845, 600, -650, 900), 'stainless', r=4),
          B("Upstand", (-600, -25, 900, 600, 0, 1050), 'stainless'),
          R(B("Leg Front", (-590, -630, 0, -550, -590, 845), 'stainless', r=8), 2, (1140, 0, 0)),
          R(B("Leg Back", (-590, -60, 0, -550, -20, 845), 'stainless', r=8), 2, (1140, 0, 0)),
          R(T("Bullet Foot Front", 'z', (-570, -610), [[0, -1], [26, -1], [20, 40], [0, 40]], 'stainless', 'f'), 2, (1140, 0, 0)),
          R(T("Bullet Foot Back", 'z', (-570, -40), [[0, -1], [26, -1], [20, 40], [0, 40]], 'stainless', 'f'), 2, (1140, 0, 0)),
          B("Undershelf", (-570, -620, 220, 570, -30, 240), 'stainless'),
          R(C("Waste Tail", 'z', (-310, -335), 20, (480, 600), 'grey'), 2, (620, 0, 0)),
          C("Waste Manifold", 'x', (-335, 480), 20, (-310, 310), 'grey'),
          C("Trap", 'z', (0, -335), 32, (360, 470), 'grey'),
          C("Waste Arm", 'y', (0, 400), 20, (-335, 0), 'grey'),
          C("Supply Tails", 'z', (0, -55), 10, (760, 870), 'chrome', 'm')]
for x in (-310, 310): parts += waste(f"Waste {'L' if x < 0 else 'R'}", x, -335, 602, r=30)
parts += deck_mixer("Mixer", 0, -55, 900, reach=320, h=330, lever=100)
add(f, "Catering double-bowl sink unit 1200 x 650 mm, stainless steel, two 500 x 450 x 270 mm bowls, upstand, legs with bullet feet and undershelf, swivel mixer",
    "IfcSanitaryTerminal", ["1200_Double", "1500_Double"], parts,
    [CW("Supply Tails", 'bottom'), HW("Mixer Body", 'bottom'), SAN("Waste Arm", d=40)],
    {"Unit 1200 x 650 mm, worktop 900 mm": A("1200x650x900", "catering sink unit, BS EN 631 / HBN 00-04 kitchens"), "Bowls 500 x 450 x 270 mm": A("500x450x270"), "Waste 40 mm": A(40)},
    "Catering sink modelled as a generic product: stainless top framed round two square bowls, bullnose apron, upstand, four legs with bullet feet, undershelf, wastes to a common trap, swivel gooseneck mixer. Drawn at 1200; the 1500 type shares it.")

# 7 Plaster sink with plaster trap
f = 'FMC_P_PlumbingFixture_Sink_Plaster_Trap'
parts = [B("Sink Floor", (-450, -480, 650, 450, 0, 690), 'china', r=30)]
parts += [B("Sink Front", (-450, -480, 690, 450, -440, 900), 'china'), B("Sink Back", (-450, -40, 690, 450, 0, 900), 'china'),
          R(B("Sink End", (-450, -440, 690, -410, -40, 900), 'china'), 2, (860, 0, 0)),
          F("Front Roll", (-452, -485, 880, 452, -470, 902), 'china', r=8, lod='f'),
          R(RT("Cantilever Bracket", [[-420, 650], [0, 650], [0, 400]], (-330, -318), 'epoxy_white'), 2, (648, 0, 0)),
          C("Sink Waste Tail", 'z', (0, -250), 25, (500, 650), 'grey'),
          T("Plaster Trap Drum", 'z', (0, -250), [[0, 0], [170, 0], [170, 380], [0, 380]], 'white'),
          T("Trap Lid", 'z', (0, -250), [[0, 380], [180, 380], [180, 410], [60, 430], [0, 430]], 'grey'),
          R(B("Lid Clamp", (-190, -262, 330, -172, -238, 420), 'stainless', lod='f'), 2, (362, 0, 0)),
          B("Lid Handle", (-60, -262, 430, 60, -238, 470), 'grey', r=6, lod='f'),
          C("Trap Inlet", 'z', (0, -250), 25, (430, 500), 'grey'),
          C("Trap Outlet", 'y', (0, 300), 25, (-90, 0), 'grey')]
parts += waste("Waste", 0, -250, 690, r=30) + bib_tap("Cold Tap", -150, 1050, handle='blue') + bib_tap("Hot Tap", 150, 1050, handle='red')
add(f, "Plaster room sink 900 x 480 mm, vitreous china on cantilever brackets, floor-standing plaster settlement trap with clamped lid, bib taps",
    "IfcSanitaryTerminal", ["900_PlasterTrap"], parts,
    [CW("Cold Tap Body"), SAN("Trap Outlet", d=50)],
    {"Sink 900 x 480 x 250 mm": A("900x480x250"), "Rim height 900 mm": A(900), "Plaster trap 340 mm dia": A(340, "typical plaster/sediment trap")},
    "Plaster sink modelled as a generic product: china sink (floor, walls, front roll) on brackets, waste into a plaster settlement drum with clamped lid and handle, outlet to the wall, cold and hot bib taps.")

# 8 Cleaner's sink, low china, bucket grating, bib taps
f = 'FMC_P_PlumbingFixture_Sink_Cleaners'
cy = -230
parts = [B("Sink Body", (-300, -460, 300, 300, 0, 450), 'china', r=40)]
parts += ring("Sink Rim", (0, cy), (300, 230, 6), (250, 180, 3), (450, 600), 'china', seg=8, k=4)
parts += [F("Back Upstand", (-300, -30, 600, 300, 0, 700), 'china', r=15),
          B("Grating Frame Front", (-250, -420, 600, 250, -408, 612), 'stainless'),
          B("Grating Frame Back", (-250, -200, 600, 250, -188, 612), 'stainless'),
          R(B("Grating Bar", (-230, -408, 602, -222, -200, 610), 'stainless', lod='f'), 8, (64, 0, 0)),
          R(C("Grating Hinge", 'x', (-194, 606), 8, (-200, -150), 'stainless', 'f'), 2, (350, 0, 0)),
          R(RT("Wall Bracket", [[-380, 300], [0, 300], [0, 120]], (-220, -208), 'epoxy_white', 'f'), 2, (428, 0, 0)),
          C("Back Outlet", 'y', (0, 340), 25, (-60, 0), 'chrome'),
          C("Trap", 'z', (0, cy), 35, (330, 450), 'chrome', 'f')]
parts += waste("Waste", 0, cy, 450, r=30) + bib_tap("Cold Tap", -170, 1000, handle='blue') + bib_tap("Hot Tap", 170, 1000, handle='red')
add(f, "Cleaner's sink 600 x 460 mm, vitreous china, low level with back upstand, hinged stainless bucket grating, hot and cold bib taps",
    "IfcSanitaryTerminal", ["600_Cleaners"], parts,
    [CW("Cold Tap Body"), HW("Hot Tap Body"), SAN("Back Outlet", d=50)],
    {"Sink 600 x 460 mm": A("600x460"), "Rim height 600 mm, grating at rim": A(600, "low cleaner's sink, bucket stands on grating"), "Taps at 1000 mm": A(1000)},
    "Cleaner's sink modelled as a generic product: china body and rim sectors, back upstand, hinged bucket grating with bars, wall brackets, waste, back outlet and two bib taps above for filling buckets.")

# WC pan builder (pedestal, oval bowl rim, seat ring, raised lid, hinges)
def wc_pan(yb, L, rim, A_=180, seat=True, lid_top=None):
    yc = yb - L * 0.52
    p = [PR("Pedestal", [(-A_ + 40, yb)] + oval(0, yb - L * 0.45, A_ - 50, L * 0.45, 2, 16, 180, 360) + [(A_ - 40, yb)], (0, rim - 120), 'china'),
         PR("Pedestal Foot", [(-A_ + 25, yb)] + oval(0, yb - L * 0.45, A_ - 35, L * 0.47, 2, 16, 180, 360) + [(A_ - 25, yb)], (0, 25), 'china', 'f'),
         PR("Bowl Floor", oval(0, yc, A_ - 10, L * 0.47, 2.2, 24), (rim - 130, rim - 110), 'china'),
         B("Pan Back", (-A_ + 20, yb - 140, rim - 130, A_ - 20, yb, rim), 'china', r=30)]
    p += ring("Bowl Rim", (0, yc), (A_, L * 0.48, 2.2), (A_ - 45, L * 0.48 - 55, 2.0), (rim - 120, rim), 'china', seg=8)
    p += [T("Bowl Throat", 'z', (0, yc - 30), [[40, rim - 110], [110, rim - 110], [110, rim - 95], [40, rim - 106]], 'china', 'f')]
    if seat:
        p += ring("Seat", (0, yc - 8), (A_ + 2, L * 0.48 - 5, 2.2), (A_ - 65, L * 0.48 - 85, 2.0), (rim, rim + 22), 'white', seg=8, k=3)
        top = lid_top or rim + 420
        p += [F("Lid", (-A_ + 5, yb - 165, rim + 30, A_ - 5, yb - 145, top), 'white', r=60),
              R(C("Hinge", 'x', (yb - 160, rim + 22), 12, (-110, -70), 'chrome', 'f'), 2, (180, 0, 0)),
              R(C("Fixing Cap", 'z', (-A_ + 55, yb - L * 0.3), 9, (0, 30), 'white', 'f'), 2, (2 * A_ - 110, 0, 0))]
    return p

# 9 Accessible peninsular WC, back-to-wall pan on a duct, drop-down rails both sides
f = 'FMC_P_PlumbingFixture_WC_Accessible_Peninsular'
parts = wc_pan(-200, 550, 455, lid_top=850)
parts += [B("Duct", (-500, -200, 0, 500, 0, 1000), 'laminate'),
          B("Duct Capping", (-510, -210, 1000, 510, 0, 1020), 'laminate', lod='f'),
          F("Backrest", (-160, -265, 720, 160, -200, 900), 'vinyl', r=25),
          F("Flush Plate", (250, -205, 830, 400, -200, 930), 'chrome', r=6),
          B("Spatula Flush Lever", (380, -260, 870, 395, -205, 885), 'chrome', r=3, lod='f'),
          C("Outlet", 'y', (0, 180), 50, (-200, 0), 'white', 'm')]
for k, x in ((1, -320), (2, 320)):
    parts += [F(f"Rail Mount {k}", (x - 50, -212, 560, x + 50, -200, 760), 'chrome', r=8),
              C(f"Rail Upper {k}", 'y', (x, 690), 16, (-950, -212), 'white'), C(f"Rail Lower {k}", 'y', (x, 610), 16, (-880, -212), 'white'),
              C(f"Rail End {k}", 'z', (x, -935), 16, (600, 700), 'white'),
              C(f"Roll Holder {k}", 'x', (-600, 650), 22, (x - 50, x + 50), 'grey', 'f')]
add(f, "Accessible peninsular WC: back-to-wall china pan with 480 mm seat on a service duct with concealed cistern, backrest, spatula flush lever, drop-down support rails both sides",
    "IfcSanitaryTerminal", ["750_BackToWall"], parts,
    [CW("Duct", 'top'), SAN("Outlet", 'back', d=100)],
    {"Pan projection 750 mm from wall incl. duct": A(750, "BS 8300-2 / ADM 750 mm"), "Seat height 480 mm": A(480, "BS 8300-2"), "Rails 680 mm high, 320 mm off centreline": A("680/320", "BS 8300-2 drop-down rails"),
     "Transfer space both sides": A("peninsular", "HBN 00-02 assisted WC")},
    "Peninsular accessible WC modelled as a generic product: pedestal, oval bowl (rim sectors, throat), seat ring, raised lid, hinges, duct with capping and flush plate, backrest, two drop-down rails with roll holders; transfer zones both sides as clearance.",
    clearances=[{"n": "Transfer Zones", "shape": "box", "at": [-1150, -1700, 0, 1150, -200, 10], "sub": "Clearance Accessibility"}])

# 10 Close-coupled WC
f = 'FMC_P_PlumbingFixture_WC_Standard'
parts = wc_pan(0, 650, 400, A_=180, lid_top=800)
parts += [F("Cistern", (-190, -185, 410, 190, 0, 780), 'china', r=25),
          B("Cistern Lid", (-198, -195, 780, 198, 0, 800), 'china', r=20),
          C("Dual Button", 'z', (0, -95), 24, (800, 806), 'chrome'),
          C("Dual Button Half", 'z', (0, -95), 11, (806, 808), 'chrome', 'f'),
          C("Outlet", 'y', (0, 180), 50, (-60, 0), 'white', 'm'),
          C("Cistern Inlet", 'y', (150, 700), 8, (-20, 0), 'chrome', 'f')]
add(f, "Close-coupled WC: vitreous china floor-standing pan with dual-flush cistern 6/4 l, white seat and lid",
    "IfcSanitaryTerminal", ["650_CloseCoupled"], parts,
    [CW("Cistern Inlet", 'back'), SAN("Outlet", 'back', d=100)],
    {"Projection 650 mm": A(650), "Seat height 420 mm": A(420), "Flush 6/4 l dual": A("6/4 l", "Water Supply (Water Fittings) Regs")},
    "Close-coupled WC modelled as a generic product: pedestal and foot, oval bowl (rim sectors, throat), seat ring, raised lid, hinges, close-coupled cistern with lid and dual push button.")

# 11 Squat pan (ceramic), flush with floor, footrests, high-level cistern with pull chain
f = 'FMC_P_PlumbingFixture_WC_Squat'
cy = -650
parts = ring("Pan Flange", (0, cy), (230, 300, 6), (140, 230, 2.2), (-15, 0), 'china', seg=8, k=4)
parts += ring("Pan Bowl", (0, cy), (145, 235, 2.2), (75, 120, 2.2), (-160, -15), 'china', seg=6)
parts += [PR("Pan Floor", oval(0, cy, 140, 230, 2.2, 24), (-175, -160), 'china'),
          C("Outlet Hole", 'z', (0, cy - 150), 45, (-161, -158), 'black', 'f'),
          R(B("Footrest", (-215, cy - 120, 0, -150, cy + 100, 12), 'china', r=20), 2, (365, 0, 0)),
          R(B("Footrest Rib", (-210, cy - 105, 12, -155, cy - 95, 16), 'china', lod='f'), 6, (0, 40, 0)),
          R(B("Footrest Rib R", (155, cy - 105, 12, 210, cy - 95, 16), 'china', lod='f'), 6, (0, 40, 0)),
          C("Trap", 'z', (0, cy - 150), 50, (-420, -175), 'upvc'),
          C("Trap Outlet", 'y', (0, -380), 50, (cy - 150, 0), 'upvc'),
          C("Flush Inlet", 'y', (0, -30), 20, (cy + 300, -40), 'white'),
          C("Flush Pipe", 'z', (0, -40), 16, (-30, 1800), 'white'),
          F("Cistern", (-220, -170, 1800, 220, 0, 2050), 'white', r=15),
          B("Cistern Lever", (150, -220, 2000, 170, -170, 2015), 'chrome', lod='f'),
          C("Pull Chain", 'z', (160, -215), 3, (1500, 2000), 'chrome', 'f'),
          T("Pull Handle", 'z', (160, -215), [[0, 1440], [14, 1440], [14, 1500], [0, 1500]], 'white', 'f')]
add(f, "Squat pan, vitreous china, set flush with the floor, ribbed footrests, high-level cistern with flush pipe and pull chain (Uganda public facilities)",
    "IfcSanitaryTerminal", ["600_Ceramic"], parts,
    [CW("Cistern"), SAN("Trap Outlet", 'back', d=100)],
    {"Pan 600 x 460 mm": A("600x460", "typical squat pan size, East Africa market"), "Top flush with finished floor": A(0), "Cistern at 1800 mm": A(1800)},
    "Squat pan modelled as a generic product: flange and bowl sectors set into the floor (z = 0), pan floor and outlet, two ribbed footrests, trap and outlet, flush inlet and pipe, high-level cistern with lever and pull chain.")

# 12 Urinal bowl, wall-hung china, sensor flush, spreader
f = 'FMC_P_PlumbingFixture_Urinal_Bowl'
parts = [F("Back Plate", (-180, -25, 480, 180, 0, 1100), 'china', r=40),
         R(RT("Side Wing", [[0, 480], [-250, 500], [-340, 560], [-345, 640], [-260, 860], [-150, 1060], [0, 1100]], (-180, -150), 'china'), 2, (330, 0, 0)),
         PR("Bowl Floor", [(-180, 0)] + oval(0, 0, 180, 340, 2, 16, 180, 360) + [(180, 0)], (480, 560), 'china'),
         RT("Hood", [[-25, 1030], [-150, 1060], [-120, 1100], [-25, 1100]], (-150, 150), 'china'),
         C("Spreader", 'y', (0, 1050), 14, (-60, -25), 'chrome', 'f'),
         C("Waste Grating", 'z', (0, -120), 32, (560, 563), 'chrome', 'f'),
         C("Waste Tail", 'z', (0, -120), 24, (380, 480), 'chrome'),
         C("Waste Arm", 'y', (0, 400), 24, (-120, 0), 'chrome'),
         C("Spreader Inlet", 'z', (0, -60), 14, (1100, 1160), 'chrome'),
         B("Sensor Flush Valve", (-45, -95, 1160, 45, -20, 1270), 'chrome', r=12),
         F("Sensor Window", (-25, -97, 1195, 25, -95, 1235), 'black', r=6, lod='f'),
         C("Supply Pipe", 'y', (0, 1240), 10, (-20, 0), 'chrome')]
parts += ring("Front Lip", (0, 0), (180, 340, 2), (150, 300, 2), (560, 610), 'china', seg=4, t0=180, t1=360)
add(f, "Wall-hung urinal bowl, vitreous china 360 x 345 x 620 mm, integral spreader, sensor flush valve, 40 mm waste",
    "IfcSanitaryTerminal", ["360_Bowl"], parts,
    [CW("Supply Pipe"), SAN("Waste Arm", d=40)],
    {"Bowl 360 x 345 x 620 mm": A("360x345x620"), "Lip height 610 mm (adult)": A(610, "BS 6465-1 / BS 8300 lower lip 380 mm for accessible"), "Sensor flush, 1.5 l": A(1.5)},
    "Urinal modelled as a generic product: back plate, curved side wings, bowl floor and front lip sectors, hood, spreader, grating, waste, sensor flush valve with window.")

# 13 Bedpan washer-disinfector (floor-standing drawn)
f = 'FMC_P_PlumbingFixture_BedpanWasher_Disinfector'
parts = [B("Cabinet", (-300, -600, 100, 300, 0, 1800), 'stainless', r=8),
         B("Plinth", (-290, -570, 0, 290, -20, 100), 'grey'),
         F("Door Gasket", (-262, -604, 905, 262, -600, 1455), 'grey', r=12, lod='f'),
         F("Loading Door", (-255, -616, 910, 255, -604, 1450), 'stainless', r=12),
         C("Door Handle", 'x', (-640, 1405), 12, (-180, 180), 'chrome'),
         R(F("Handle Post", (-190, -640, 1395, -175, -616, 1415), 'chrome', lod='f'), 2, (365, 0, 0)),
         F("Control Panel", (-260, -606, 1520, 260, -600, 1740), 'medical_grey', r=8),
         F("Display", (-220, -608, 1610, -20, -606, 1700), 'black', r=4, lod='f'),
         R(C("Program Button", 'y', (40, 1650), 15, (-610, -606), 'white', 'f'), 3, (60, 0, 0)),
         C("Ready LED", 'y', (40, 1575), 6, (-609, -606), 'led_green', 'f'),
         C("Fault LED", 'y', (100, 1575), 6, (-609, -606), 'led_red', 'f'),
         F("Service Panel", (-280, -604, 130, 280, -600, 860), 'stainless', r=6),
         R(F("Vent Slot", (-200, -606, 180, 200, -604, 190), 'black', lod='f'), 5, (0, 0, 22)),
         B("Elbow Opener", (180, -640, 1180, 260, -604, 1280), 'medical_grey', r=10),
         B("Service Box", (-200, -160, 1800, 200, 0, 1880), 'stainless', r=6),
         C("Vapour Vent", 'z', (-120, -80), 25, (1880, 1960), 'grey'),
         C("Drain Spigot", 'y', (150, 60), 50, (-60, 0), 'grey')]
add(f, "Bedpan washer-disinfector, floor-standing stainless 600 x 600 x 1800 mm, front loading door, elbow door opener, program panel with display, steam disinfection",
    "IfcSanitaryTerminal", [{"name": "600_Floor"}, {"name": "600_Wall"}], parts,
    [CW("Service Box", 'top'), HW("Service Box", 'back'), SAN("Drain Spigot", 'back', d=110), E("Service Box", 'top')],
    {"600 x 600 x 1800 mm (floor)": A("600x600x1800", "HBN 00-09 / BS EN ISO 15883-3 washer-disinfector"), "Power 3 kVA, 240 V": A(3000), "Drain 110 mm": A(110)},
    "Bedpan washer-disinfector modelled as a generic product: stainless cabinet, plinth, loading door with gasket and bar handle, elbow opener, control panel with display, buttons and LEDs, service panel with vents, service box with vapour vent, drain spigot. Floor type drawn; the wall type shares it.",
    type_values={"Voltage": 240, "Apparent Load": 3000})

# 14 Pulp macerator
f = 'FMC_P_PlumbingFixture_Macerator_Pulp'
parts = [B("Body", (-250, -560, 80, 250, 0, 900), 'white', r=60),
         B("Plinth", (-235, -540, 0, 235, -20, 80), 'grey', r=40),
         RT("Lid", [[-555, 900], [-140, 940], [-140, 975], [-555, 930]], (-245, 245), 'medical_grey'),
         F("Lid Handle", (-120, -580, 900, 120, -555, 935), 'grey', r=8),
         B("Console", (-250, -140, 900, 250, 0, 1050), 'white', r=30),
         R(C("Program Button", 'y', (-100, 1000), 16, (-146, -140), 'blue', 'f'), 3, (100, 0, 0)),
         C("Ready LED", 'y', (-100, 950), 6, (-145, -140), 'led_green', 'f'),
         C("Fault LED", 'y', (0, 950), 6, (-145, -140), 'led_red', 'f'),
         F("Lid Seal", (-240, -562, 880, 240, -560, 895), 'grey', lod='f'),
         F("Front Panel", (-200, -566, 200, 200, -560, 780), 'white', r=20),
         R(F("Vent Slot", (-140, -568, 250, 140, -566, 258), 'grey', lod='f'), 4, (0, 0, 22)),
         B("Foot Pedal", (-90, -660, 10, 90, -540, 50), 'grey', r=10),
         C("Outlet", 'y', (0, 150), 55, (-80, 0), 'grey'),
         C("Supply Inlet", 'y', (180, 1000), 8, (-20, 0), 'chrome', 'f')]
add(f, "Pulp macerator, floor-standing 500 x 560 x 1050 mm, white, hinged lid with handle and foot pedal, program console, 110 mm outlet",
    "IfcSanitaryTerminal", ["500_Floor"], parts,
    [CW("Supply Inlet"), SAN("Outlet", d=110), E("Console", 'back')],
    {"500 x 560 x 1050 mm": A("500x560x1050"), "Power 1.1 kW, 240 V": A(1100), "Outlet 110 mm": A(110, "HBN 00-09 disposal hold")},
    "Macerator modelled as a generic product: rounded body, plinth, sloped lid with handle and seal, foot pedal, console with buttons and LEDs, front panel with vents, outlet and inlet.",
    type_values={"Voltage": 240, "Apparent Load": 1100})

# 15 Accessible thermostatic shower set with fold-down seat and level-access drain
f = 'FMC_P_PlumbingFixture_Shower_Accessible_Thermostatic'
parts = [C("Valve Bar", 'x', (-55, 1000), 30, (-160, 160), 'chrome'),
         C("Temp Handle", 'x', (-55, 1000), 34, (-215, -160), 'chrome'),
         B("Temp Stop Button", (-200, -95, 1030, -180, -80, 1040), 'red', lod='f'),
         C("Flow Hub", 'x', (-55, 1000), 30, (160, 200), 'chrome'),
         B("Flow Lever", (185, -110, 960, 200, -90, 1100), 'chrome', r=6),
         C("Wall Union L", 'y', (-150, 1000), 18, (-30, 0), 'chrome'),
         C("Wall Union R", 'y', (150, 1000), 18, (-30, 0), 'chrome'),
         C("Hose Outlet", 'z', (0, -55), 12, (930, 970), 'chrome'),
         C("Hose Drop", 'z', (0, -55), 9, (720, 930), 'grey', 'f'),
         C("Hose Loop", 'x', (-55, 720), 9, (0, 120), 'grey', 'f'),
         C("Hose Rise", 'z', (120, -55), 9, (720, 1580), 'grey', 'f'),
         C("Riser Rail", 'z', (0, -50), 12, (1150, 2050), 'chrome'),
         R(F("Rail Bracket", (-25, -50, 1130, 25, 0, 1170), 'chrome', r=6), 2, (0, 0, 920)),
         B("Slider", (-22, -75, 1620, 22, -30, 1680), 'white', r=8),
         C("Handset Grip", 'z', (60, -95), 16, (1580, 1780), 'white'),
         T("Handset Head", 'z', (60, -95), [[0, 1780], [48, 1780], [52, 1795], [0, 1810]], 'white'),
         B("Seat", (-1050, -480, 460, -600, -50, 490), 'white', r=25),
         R(B("Seat Slot", (-1020, -460, 489, -630, -450, 491), 'grey', lod='f'), 6, (0, 70, 0)),
         F("Seat Bracket", (-1000, -40, 380, -650, 0, 560), 'aluminium', r=10),
         R(B("Seat Leg", (-1030, -470, 0, -1005, -445, 460), 'aluminium'), 2, (395, 0, 0)),
         C("Grab Rail", 'z', (420, -65), 17, (850, 1500), 'white'),
         R(C("Grab Rail Flange", 'y', (420, 870), 25, (-65, 0), 'white', 'f'), 2, (0, 0, 610)),
         B("Linear Drain", (-950, -160, -40, 950, -60, 0), 'stainless'),
         R(B("Drain Slot", (-930, -140, -1, -920, -80, 0.5), 'black', lod='f'), 25, (76, 0, 0)),
         C("Drain Outlet", 'z', (700, -110), 25, (-120, -40), 'grey'),
         B("Curtain Track", (-1100, -1210, 2080, 450, -1190, 2100), 'aluminium', lod='f'),
         B("Curtain Track Return", (430, -1210, 2080, 450, 0, 2100), 'aluminium', lod='f')]
add(f, "Accessible thermostatic shower set: exposed TMV3 bar valve with long flow lever, riser rail and handset, fold-down seat with legs, grab rail, level-access linear drain",
    "IfcSanitaryTerminal", ["TMV3_Wall"], parts,
    [CW("Wall Union R"), HW("Wall Union L"), SAN("Drain Outlet", 'bottom', d=50)],
    {"Valve at 1000 mm, rail to 2050 mm": A("1000/2050", "BS 8300-2 shower controls 750-1000 mm"), "Seat 480 mm high": A(480, "BS 8300-2"), "Area 1500 x 1200 mm level access": A("1500x1200", "HBN 00-02")},
    "Shower set modelled as a generic product: bar valve with temperature handle, stop button and long flow lever, unions, hose, riser rail with slider and handset, fold-down seat with slots, bracket and legs, grab rail, linear drain with slots and outlet, curtain track; level-access area as clearance.",
    clearances=[{"n": "Shower Area", "shape": "box", "at": [-1100, -1200, 0, 450, -60, 10], "sub": "Clearance Accessibility"}])

# 16 Emergency shower and eyewash combination
f = 'FMC_P_PlumbingFixture_Shower_Emergency_Eyewash'
parts = [T("Foot Plate", 'z', (0, 0), [[0, 0], [130, 0], [120, 15], [0, 15]], 'yellow'),
         C("Column", 'z', (0, 0), 20, (15, 2200), 'yellow'),
         C("Inlet Tee", 'z', (0, 0), 26, (2170, 2260), 'brass'),
         C("Shower Arm", 'y', (0, 2215), 18, (-520, 0), 'yellow'),
         C("Head Stem", 'z', (0, -500), 15, (2150, 2215), 'yellow'),
         T("Shower Head", 'z', (0, -500), [[0, 2050], [140, 2068], [152, 2090], [30, 2150], [0, 2150]], 'yellow'),
         C("Shower Valve", 'y', (0, 2215), 30, (-150, -100), 'brass'),
         B("Valve Lever", (0, -135, 2205, 190, -115, 2225), 'chrome'),
         C("Pull Rod", 'z', (180, -125), 5, (1580, 2210), 'chrome'),
         T("Pull Ring", 'y', (180, 1545), [[30, -120], [38, -120], [38, -130], [30, -130]], 'yellow'),
         C("Eyewash Arm", 'y', (0, 1000), 15, (-300, 0), 'yellow'),
         C("Eyewash Valve", 'y', (0, 1000), 26, (-120, -70), 'brass'),
         T("Eyewash Bowl", 'z', (0, -400), [[20, 945], [150, 1000], [150, 1012], [140, 1012], [15, 965], [0, 965], [0, 945]], 'yellow'),
         R(C("Spray Head", 'z', (-60, -400), 14, (965, 1030), 'chrome'), 2, (120, 0, 0)),
         R(T("Dust Cover", 'z', (-60, -400), [[0, 1030], [20, 1030], [18, 1042], [0, 1046]], 'grey', 'f'), 2, (120, 0, 0)),
         F("Push Flag", (-70, -568, 960, 70, -555, 1060), 'yellow', r=10),
         B("Push Flag Arm", (-8, -555, 990, 8, -520, 1000), 'chrome', lod='f'),
         C("Bowl Waste", 'z', (0, -400), 16, (120, 945), 'galvanised'),
         C("Waste Elbow", 'y', (0, 120), 16, (-400, 0), 'galvanised'),
         F("Sign", (-150, -26, 2280, 150, -20, 2500), 'safety_green', r=6)]
add(f, "Emergency shower and eyewash combination, free-standing yellow steel column, 2200 mm shower head with pull rod, eyewash bowl with twin spray heads and push flag",
    "IfcSanitaryTerminal", ["2300_Combo"], parts,
    [CW("Inlet Tee", 'top', d=32), SAN("Waste Elbow", 'back', d=32)],
    {"Shower head 2200 mm": A(2200, "ANSI Z358.1 / BS EN 15154-1 head 2085-2440 mm"), "Eyewash bowl 1000 mm": A(1000, "BS EN 15154-2 bowl 838-1143 mm"), "Supply 32 mm": A(32)},
    "Emergency shower modelled as a generic product: foot plate, column, inlet tee, arm, cone head, valve with lever, pull rod and ring, eyewash arm, valve and bowl, twin sprays with dust covers, push flag, waste and green safety sign.")

# 17 Assisted bath, height adjustable
f = 'FMC_P_PlumbingFixture_Bath_Assisted'
cy = -520
parts = ring("Tub Wall", (0, cy), (950, 410, 5), (890, 350, 4), (480, 900), 'white', seg=8, k=4)
parts += [PR("Tub Base", oval(0, cy, 900, 360, 4, 32), (450, 490), 'white'),
          B("Headrest", (-880, cy - 160, 520, -760, cy + 160, 800), 'vinyl', r=40),
          F("Door Seal", (-310, cy - 413, 500, 310, cy - 408, 880), 'grey', r=20, lod='f'),
          F("Side Door", (-300, cy - 418, 510, 300, cy - 411, 870), 'white', r=20),
          B("Door Handle", (220, cy - 450, 650, 240, cy - 418, 760), 'chrome', r=6),
          B("Lift Column", (-250, cy - 150, 60, 250, cy + 150, 450), 'medical_grey', r=40),
          B("Base Frame", (-800, cy - 300, 0, 800, cy + 300, 60), 'medical_grey', r=40),
          R(C("Foot", 'z', (-760, cy - 260), 25, (-1, 10), 'rubber', 'f'), 2, (1520, 0, 0)),
          R(C("Foot Back", 'z', (-760, cy + 260), 25, (-1, 10), 'rubber', 'f'), 2, (1520, 0, 0)),
          B("Control Pod", (600, cy - 440, 820, 760, cy - 405, 900), 'medical_grey', r=10),
          R(C("Pod Button", 'y', (630, 860), 9, (cy - 445, cy - 440), 'blue', 'f'), 3, (45, 0, 0)),
          C("Filler Body", 'x', (cy + 380, 920), 26, (-150, 150), 'chrome'),
          C("Filler Spout", 'y', (0, 935), 14, (cy + 280, cy + 380), 'chrome'),
          C("Handset Holder", 'z', (300, cy + 385), 15, (900, 960), 'chrome'),
          C("Handset", 'z', (300, cy + 385), 18, (960, 1140), 'white'),
          C("Grab Handle", 'x', (cy - 420, 920), 14, (-700, -400), 'chrome'),
          C("Drain Outlet", 'z', (-600, cy), 25, (300, 450), 'grey'),
          C("Waste Arm", 'y', (-600, 300), 25, (cy, 0), 'grey')]
add(f, "Height-adjustable assisted bath 1900 x 820 mm, white acrylic tub with side door, headrest, lift column on base frame, control pod, thermostatic filler and handset",
    "IfcSanitaryTerminal", ["1900_HeightAdjustable"], parts,
    [CW("Filler Body", 'back'), HW("Filler Body", 'top'), SAN("Waste Arm", d=40), E("Lift Column", 'back')],
    {"Tub 1900 x 820 mm": A("1900x820"), "Rim height 700-1000 mm adjustable, drawn at 900": A(900, "assisted bath lift range"), "Power 0.5 kVA": A(500)},
    "Assisted bath modelled as a generic product: tub wall sectors and base, headrest, side door with seal and handle, lift column and base frame with feet, control pod, filler, handset and grab handle.",
    type_values={"Voltage": 240, "Apparent Load": 500})

# 18 Dual-height drinking fountain
f = 'FMC_P_PlumbingFixture_DrinkingFountain_DualHeight'
parts = [F("Back Plate", (-480, -15, 600, 480, 0, 1060), 'stainless', r=10)]
for nm, x, rim in (("Low", -255, 840), ("High", 255, 1000)):
    parts += [B(f"{nm} Housing", (x - 210, -430, rim - 220, x + 210, -15, rim - 40), 'stainless', r=40),
              RT(f"{nm} Shroud", [[-15, rim - 220], [-250, rim - 220], [-60, rim - 360], [-15, rim - 360]], (x - 150, x + 150), 'stainless')]
    parts += ring(f"{nm} Bowl", (x, -220), (210, 210, 5), (175, 165, 3), (rim - 40, rim), 'stainless', seg=6)
    parts += [T(f"{nm} Bubbler", 'z', (x, -110), [[0, rim - 40], [14, rim - 40], [12, rim + 10], [6, rim + 18], [0, rim + 18]], 'chrome'),
              F(f"{nm} Push Bar", (x - 80, -446, rim - 100, x + 80, -430, rim - 55), 'chrome', r=8),
              C(f"{nm} Drain", 'z', (x, -230), 22, (rim - 40, rim - 38), 'chrome', 'f')]
parts += [C("Waste Arm", 'y', (0, 620), 20, (-200, 0), 'chrome', 'm'), C("Supply Stop", 'y', (0, 700), 9, (-60, 0), 'chrome', 'm')]
add(f, "Dual-height drinking fountain, wall-mounted stainless, accessible low bowl at 840 mm rim and standing bowl at 1000 mm, bubblers and front push bars",
    "IfcSanitaryTerminal", ["960_DualHeight"], parts,
    [CW("Supply Stop"), SAN("Waste Arm", d=32)],
    {"Low bowl rim 840 mm": A(840, "record: low bowl 815-860 rim"), "High bowl rim 1000 mm": A(1000), "Width 960 mm overall": A(960)},
    "Dual fountain modelled as a generic product: back plate, two housings with tapered shrouds, bowl rim sectors, bubblers, push bars and drains; knee-space approach as clearance.",
    clearances=[{"n": "Approach Zone", "shape": "box", "at": [-700, -1650, 0, 250, -430, 10], "sub": "Clearance Accessibility"}])

# 19 Bottle refill station (wall drawn)
f = 'FMC_P_PlumbingFixture_BottleRefill_Station'
parts = [B("Upper Housing", (-210, -270, 1450, 210, 0, 1720), 'stainless', r=25),
         R(B("Side Wall", (-210, -270, 1050, -185, 0, 1450), 'stainless'), 2, (395, 0, 0)),
         B("Back Panel", (-185, -60, 1050, 185, 0, 1450), 'black'),
         B("Base Unit", (-210, -270, 850, 210, 0, 1050), 'stainless', r=25),
         B("Drip Tray", (-170, -250, 1050, 170, -70, 1058), 'black'),
         R(B("Drip Grille Bar", (-160, -245, 1058, 160, -237, 1062), 'stainless', lod='f'), 8, (0, 21, 0)),
         T("Nozzle", 'z', (0, -150), [[0, 1395], [10, 1395], [14, 1420], [20, 1450], [0, 1450]], 'chrome'),
         F("Sensor Window", (-30, -272, 1460, 30, -270, 1480), 'black', r=4, lod='f'),
         F("Counter Display", (-120, -272, 1560, 120, -270, 1660), 'black', r=8),
         F("Counter Digits", (-90, -273, 1590, 90, -272, 1630), 'led_green', lod='f'),
         C("Filter LED", 'y', (150, 1500), 6, (-273, -270), 'led_green', 'f'),
         R(F("Vent Slot", (-150, -272, 880, 150, -270, 888), 'grey', lod='f'), 4, (0, 0, 25)),
         C("Supply Stop", 'y', (-100, 900), 9, (-40, 0), 'chrome', 'm'),
         C("Drain Tail", 'y', (100, 900), 18, (-60, 0), 'grey', 'm')]
add(f, "Bottle refill station, wall-mounted stainless 420 x 270 x 870 mm, chilled and filtered, sensor-operated nozzle, bottle counter display, drip tray with grille",
    "IfcSanitaryTerminal", ["420_Wall", "420_FreeStanding"], parts,
    [CW("Supply Stop"), SAN("Drain Tail", d=32), E("Upper Housing", 'back')],
    {"420 x 270 x 870 mm, nozzle at 1395 mm": A("420x270x870"), "Chiller 370 VA": A(370), "Bottle alcove 400 mm clear": A(400)},
    "Refill station modelled as a generic product: upper housing with sensor and counter display, alcove side walls and back panel, base unit with vents, drip tray with grille bars, nozzle. Wall type drawn; free-standing shares it.",
    type_values={"Voltage": 240, "Apparent Load": 370})

# 20 Mortuary / autopsy sink 1800
f = 'FMC_P_PlumbingFixture_Trough_Autopsy_Sink'
holes = [(300, -620, 860, -110)]
parts = deck_frame("Sink Top", -900, -700, 900, 0, holes, 870, 900, 'stainless')
parts += sqbowl("Bowl", 300, -620, 860, -110, 560, 870, 2, 'stainless')
parts += [F("Front Apron", (-900, -712, 820, 900, -700, 900), 'stainless', r=4),
          B("Upstand", (-900, -25, 900, 900, 0, 1350), 'stainless'),
          R(B("Drainer Rib", (-860, -650, 900, 250, -642, 906), 'stainless', lod='f'), 8, (0, 65, 0)),
          B("Drainer Edge", (-900, -700, 900, -880, -25, 930), 'stainless'),
          R(B("Leg Front", (-880, -680, 0, -840, -640, 820), 'stainless', r=8), 3, (860, 0, 0)),
          R(B("Leg Back", (-880, -60, 0, -840, -20, 820), 'stainless', r=8), 3, (860, 0, 0)),
          B("Leg Rail", (-860, -670, 250, 860, -650, 270), 'stainless'),
          C("Gooseneck Riser", 'y', (580, 1250), 15, (-90, -25), 'chrome'),
          C("Gooseneck Drop", 'z', (580, -90), 15, (1150, 1250), 'chrome'),
          C("Gooseneck Arm", 'y', (580, 1150), 13, (-380, -90), 'chrome'),
          C("Gooseneck Nozzle", 'z', (580, -370), 12, (1060, 1150), 'chrome'),
          R(B("Elbow Lever", (420, -80, 1100, 440, -60, 1260), 'chrome', r=4), 2, (300, 0, 0)),
          C("Mixer Body", 'x', (-60, 1100), 22, (430, 730), 'chrome'),
          C("Spray Hose Holder", 'z', (-200, -60), 18, (1050, 1150), 'chrome'),
          C("Spray Handset", 'z', (-200, -60), 20, (1150, 1300), 'grey'),
          C("Waste Tail", 'z', (580, -365), 30, (380, 560), 'stainless'),
          C("Waste Arm", 'y', (580, 400), 30, (-365, 0), 'stainless')]
parts += waste("Waste", 580, -365, 562, r=40)
add(f, "Mortuary sink 1800 x 700 mm, stainless steel, deep bowl and ribbed drainer, 450 mm upstand, gooseneck mixer with elbow levers, spray handset, on six legs",
    "IfcSanitaryTerminal", ["1800_Mortuary"], parts,
    [CW("Mixer Body", 'back'), HW("Mixer Body", 'top'), SAN("Waste Arm", d=50)],
    {"1800 x 700 mm, worktop 900 mm": A("1800x700x900", "HBN 16 mortuary"), "Bowl 560 x 510 x 310 mm": A("560x510x310"), "Waste 50 mm": A(50)},
    "Mortuary sink modelled as a generic product: stainless top framed round the bowl, ribbed drainer, apron, upstand, six legs with rail, gooseneck mixer with elbow levers, spray handset, waste.")

# =================================================================== PIPE ACCESSORIES
f = 'FMC_P_PipeAccessory_Tap_Elbow_Lever'
parts = wall_mixer("Mixer", 0, 0, reach=170, lever=180) + [B("Temperature Index", (-20, -76, 20, 20, -72, 26), 'blue', lod='f')]
add(f, "Clinical wall-mounted mixer, elbow lever, 150 mm centres, chrome, spout 220 mm, laminar outlet (nested in basins)",
    "IfcValve", ["15_ElbowLever"], parts, [],
    {"Centres 150 mm": A(150, "UK wall mixer standard centres"), "Spout projection 220 mm": A(220), "Lever 180 mm": A(180, "HBN 00-10 Part C elbow-operated controls")},
    "Elbow-lever mixer modelled as a generic product: rosettes and unions, body bar, spout and nozzle with laminar outlet, lever hub, long elbow lever. Nested in basins (no connectors of its own).")

f = 'FMC_P_PipeAccessory_Tap_Sensor'
parts = [T("Base Flange", 'z', (0, 0), [[0, 0], [30, 0], [28, 8], [0, 8]], 'chrome'),
         C("Column", 'z', (0, 0), 22, (8, 170), 'chrome'),
         T("Head", 'z', (0, 0), [[0, 170], [22, 170], [22, 188], [0, 196]], 'chrome'),
         C("Spout", 'y', (0, 180), 15, (-140, 0), 'chrome'),
         C("Nose", 'z', (0, -130), 15, (150, 180), 'chrome'),
         T("Aerator", 'z', (0, -130), [[0, 144], [12, 144], [14, 150], [0, 150]], 'black', 'f'),
         F("Sensor Window", (-12, -24, 95, 12, -20, 125), 'black', r=5),
         C("Sensor LED", 'y', (0, 132), 2.5, (-24, -21), 'led_red', 'f'),
         R(C("Tail", 'z', (-10, 0), 5, (-180, 0), 'chrome', 'f'), 2, (20, 0, 0)),
         B("Control Box", (-60, -30, -320, 60, 30, -180), 'grey', r=6),
         C("Solenoid", 'y', (20, -250), 14, (-50, -30), 'black', 'f'),
         C("Mains Lead", 'x', (0, -300), 4, (60, 160), 'black', 'f')]
add(f, "Sensor (infra-red) tap, deck-mounted chrome column with spout, sensor window, under-deck control box with solenoid and transformer (nested)",
    "IfcValve", ["15_Deck", "15_Wall"], parts, [E("Control Box", 'right')],
    {"Height 196 mm, spout 140 mm": A("196/140"), "Supply 240 V via 6 V transformer, 10 VA": A(10), "Thermal disinfection cycle": A("timed flush", "HTM 04-01 water safety")},
    "Sensor tap modelled as a generic product: base flange, column, head, spout, nose and aerator, sensor window and LED, tails, control box with solenoid and lead. Deck type drawn; wall type shares it.",
    type_values={"Voltage": 240, "Apparent Load": 10})

f = 'FMC_P_PipeAccessory_TMV_Type3'
parts = [C("Body", 'z', (0, 0), 28, (-60, 60), 'chrome'),
         T("Temperature Cap", 'z', (0, 0), [[0, 60], [30, 60], [30, 88], [24, 96], [0, 96]], 'white'),
         C("Tamper Screw", 'z', (0, 0), 5, (96, 100), 'chrome', 'f'),
         C("Hot Inlet Arm", 'x', (0, -30), 14, (-110, -28), 'chrome'),
         C("Hot Inlet Union", 'x', (0, -30), 18, (-140, -110), 'brass', seg=6),
         C("Hot Isolator", 'z', (-75, 0), 12, (-30, 0), 'chrome'),
         B("Hot Isolator Slot", (-82, -1.5, 0, -68, 1.5, 3), 'black', lod='f'),
         T("Hot Ring", 'x', (0, -30), [[14, -100], [17, -100], [17, -92], [14, -92]], 'led_red', 'f'),
         C("Cold Inlet Arm", 'x', (0, -30), 14, (28, 110), 'chrome'),
         C("Cold Inlet Union", 'x', (0, -30), 18, (110, 140), 'brass', seg=6),
         C("Cold Isolator", 'z', (75, 0), 12, (-30, 0), 'chrome'),
         B("Cold Isolator Slot", (68, -1.5, 0, 82, 1.5, 3), 'black', lod='f'),
         T("Cold Ring", 'x', (0, -30), [[14, 92], [17, 92], [17, 100], [14, 100]], 'blue', 'f'),
         C("Outlet", 'z', (0, 0), 14, (-130, -60), 'chrome'),
         C("Outlet Union", 'z', (0, 0), 18, (-160, -130), 'brass', seg=6),
         F("Label", (-18, -29, -40, 18, -28, 20), 'blue', lod='f')]
add(f, "Thermostatic mixing valve Type 3 (TMV3), chrome body, tamper-proof temperature cap, isolating valves and strainer check valves on both inlets, compression unions",
    "IfcValve", [{"name": "15_TMV3"}, {"name": "22_TMV3"}], parts,
    [HW("Hot Inlet Union", 'left'), CW("Cold Inlet Union", 'right'), HW("Outlet Union", 'bottom', 'Mixed', 'Out')],
    {"TMV3 to NHS D08 / BS EN 1111": A("TMV3", "HTM 04-01 / NHS D08 scheme"), "Body 280 x 260 mm with unions": A("280x260"), "Outlet 41 C max": A(41, "HTM 04-01 basin outlet")},
    "TMV3 modelled as a generic product: body, temperature cap, hot and cold arms with hex unions, isolators with screwdriver slots and colour rings, outlet with union, label. Mixed outlet carried as a hot-water Out connector.")

f = 'FMC_P_PipeAccessory_Valve_Gate'
parts = [C("Body", 'x', (0, 0), 38, (-75, 75), 'painted_steel'),
         R(T("Flange", 'x', (0, 0), [[0, -90], [82, -90], [82, -72], [0, -72]], 'painted_steel'), 2, (162, 0, 0)),
         R(C("Flange Bolt Top", 'x', (0, 62), 7, (-96, -66), 'chrome', 'f', seg=6), 2, (162, 0, 0)),
         R(C("Flange Bolt Bottom", 'x', (0, -62), 7, (-96, -66), 'chrome', 'f', seg=6), 2, (162, 0, 0)),
         T("Wedge Housing", 'z', (0, 0), [[0, -45], [50, -40], [52, 50], [0, 50]], 'painted_steel'),
         T("Bonnet", 'z', (0, 0), [[0, 50], [62, 50], [62, 64], [36, 64], [32, 120], [0, 120]], 'painted_steel'),
         R(C("Bonnet Bolt", 'z', (-52, 0), 5, (50, 72), 'chrome', 'f', seg=6), 2, (104, 0, 0)),
         C("Gland", 'z', (0, 0), 18, (120, 140), 'brass'),
         C("Stem", 'z', (0, 0), 8, (140, 200), 'chrome')] + handwheel("Handwheel", 0, 0, 195, 85, 'red')
add(f, "Gate valve, flanged PN16 cast iron, non-rising stem, bronze trim, red handwheel; types cover DN15-100 (DN50 drawn)",
    "IfcValve", ["15-100_Gate"], parts,
    [CW("Flange 1", 'left', 'Inlet', 'In', 50), CW("Flange 2", 'right', 'Outlet', 'Out', 50)],
    {"DN50 drawn, face to face 180 mm": A(180, "BS EN 558 series 3"), "Flange 165 mm dia PN16": A(165, "BS EN 1092-2 DN50 PN16"), "Height to handwheel 205 mm": A(205)},
    "Gate valve modelled as a generic product: body, two flanges with bolts, wedge housing, bonnet with bolts, gland, stem, handwheel with rim, spokes and hub.")

f = 'FMC_P_PipeAccessory_Valve_PRV'
parts = [C("Body", 'x', (0, 0), 26, (-55, 55), 'brass'),
         T("Body Bulb", 'z', (0, 0), [[0, -38], [34, -30], [36, 28], [0, 34]], 'brass'),
         C("Inlet Nut", 'x', (0, 0), 24, (-85, -55), 'brass', seg=6),
         C("Outlet Nut", 'x', (0, 0), 24, (55, 85), 'brass', seg=6),
         C("Inlet Tail", 'x', (0, 0), 16, (-110, -85), 'brass'),
         C("Outlet Tail", 'x', (0, 0), 16, (85, 110), 'brass'),
         T("Spring Bell", 'z', (0, 0), [[0, 30], [42, 30], [40, 48], [30, 120], [22, 130], [0, 130]], 'brass'),
         C("Lock Nut", 'z', (0, 0), 14, (130, 142), 'brass', seg=6),
         C("Adjusting Screw", 'z', (0, 0), 7, (142, 170), 'chrome'),
         C("Strainer Cap", 'z', (0, 0), 22, (-70, -38), 'brass', seg=6),
         C("Gauge Boss", 'y', (0, 0), 9, (-60, -25), 'brass'),
         B("Flow Arrow", (-30, -27, -6, 30, -26, 6), 'black', lod='f')] + gauge("Gauge", 0, -60, 0, 32, stem=False)
add(f, "Pressure reducing valve, bronze, spring-loaded with adjusting screw, integral strainer, outlet pressure gauge, union ends (DN25 drawn)",
    "IfcValve", ["25_PRV", "50_PRV"], parts,
    [CW("Inlet Tail", 'left', 'Inlet', 'In', 25), CW("Outlet Tail", 'right', 'Outlet', 'Out', 25)],
    {"DN25 drawn, length 220 mm": A(220), "Outlet set 1.5-6 bar": A("1.5-6 bar"), "Gauge 0-10 bar, 63 mm": A(63)},
    "PRV modelled as a generic product: body and bulb, hex union nuts and tails, spring bell, lock nut and adjusting screw, strainer cap, gauge boss, gauge with dial and needle, flow arrow.")

f = 'FMC_P_PipeAccessory_FloorDrain_SS'
parts = [B("Frame Front", (-78, -78, -6, 78, -66, 0), 'stainless'), B("Frame Back", (-78, 66, -6, 78, 78, 0), 'stainless'),
         B("Frame Left", (-78, -66, -6, -66, 66, 0), 'stainless'), B("Frame Right", (66, -66, -6, 78, 66, 0), 'stainless'),
         R(B("Grate Bar", (-64, -64, -7, 64, -58, -1), 'stainless', lod='f'), 11, (0, 12.2, 0)),
         B("Grate Plate", (-66, -66, -10, 66, 66, -7), 'black', lod='m'),
         B("Body", (-72, -72, -110, 72, 72, -10), 'stainless'),
         B("Clamp Flange", (-120, -120, -70, 120, 120, -60), 'stainless', lod='f'),
         T("Funnel", 'z', (0, 0), [[0, -170], [42, -170], [70, -110], [0, -110]], 'stainless'),
         C("Outlet Spigot", 'z', (0, 0), 38, (-290, -170), 'stainless'),
         R(C("Grate Screw", 'z', (-55, -55), 3, (-1.5, 0.2), 'chrome', 'f'), 2, (110, 110, 0))]
add(f, "Stainless steel floor drain, 156 mm square slotted grate, body with membrane clamp flange, vertical 75 mm outlet (150 drawn)",
    "IfcWasteTerminal", ["100_SS", "150_SS"], parts, [SAN("Outlet Spigot", 'bottom', d=75)],
    {"Grate 156 x 156 mm (150 type)": A(156), "Outlet 75 mm vertical": A(75), "Clamp flange for tanking membrane": A("clamp", "HBN 00-10 Part B floors")},
    "Floor drain modelled as a generic product: grate frame, slotted grate bars, body, membrane clamp flange, funnel, outlet spigot and grate screws; top at finished floor (z = 0).")

f = 'FMC_P_PipeAccessory_FloorGully_Sealed_Theatre'
parts = [T("Frame", 'z', (0, 0), [[100, -8], [125, -8], [125, 0], [100, 0]], 'stainless'),
         T("Cover Plate", 'z', (0, 0), [[0, -6], [100, -6], [100, -1], [0, -1]], 'stainless'),
         T("Gasket", 'z', (0, 0), [[96, -6.5], [101, -6.5], [101, -0.5], [96, -0.5]], 'black', 'f'),
         C("Cover Screw 1", 'z', (75, 0), 5, (-1.5, 0), 'chrome', 'f'), C("Cover Screw 2", 'z', (-75, 0), 5, (-1.5, 0), 'chrome', 'f'),
         C("Cover Screw 3", 'z', (0, 75), 5, (-1.5, 0), 'chrome', 'f'), C("Cover Screw 4", 'z', (0, -75), 5, (-1.5, 0), 'chrome', 'f'),
         R(B("Key Slot", (-35, -4, -1.5, -15, 4, -0.8), 'black', lod='f'), 2, (50, 0, 0)),
         C("Body", 'z', (0, 0), 95, (-230, -8), 'stainless'),
         T("Clamp Ring", 'z', (0, 0), [[95, -70], [140, -70], [140, -58], [95, -58]], 'stainless'),
         T("Sump", 'z', (0, 0), [[0, -260], [70, -260], [95, -230], [0, -230]], 'stainless'),
         C("Outlet", 'x', (0, -170), 50, (95, 260), 'stainless')]
add(f, "Sealed theatre floor gully, stainless, screw-down gasketed cover flush with floor, membrane clamp ring, 100 mm side outlet (where HTM permits a gully)",
    "IfcWasteTerminal", ["250_Sealed"], parts, [SAN("Outlet", 'right', d=100)],
    {"Cover 250 mm dia": A(250), "Side outlet 100 mm": A(100), "Sealed, gasketed cover": A("sealed", "HBN 26 theatres: drains only where permitted, sealable")},
    "Sealed gully modelled as a generic product: frame ring, cover plate, gasket, four cover screws, key slots, body, clamp ring, sump and side outlet; top at finished floor (z = 0).")

f = 'FMC_P_PipeAccessory_Cleanout_Rodding'
parts = [B("Access Frame", (-100, -100, -8, 100, 100, 0), 'stainless'),
         C("Screwed Plug", 'z', (0, 0), 58, (-6, 0.5), 'brass'),
         B("Plug Key Bar", (-30, -6, 0.5, 30, 6, 6), 'brass', lod='f'),
         R(C("Frame Screw", 'z', (-85, -85), 4, (-1, 0), 'chrome', 'f'), 2, (170, 0, 0)),
         R(C("Frame Screw B", 'z', (-85, 85), 4, (-1, 0), 'chrome', 'f'), 2, (170, 0, 0)),
         C("Riser", 'z', (0, 0), 55, (-400, -8), 'upvc'),
         RT("Bend 45", [[55, -400], [-55, -400], [-255, -600], [-145, -600]], (-55, 55), 'upvc'),
         C("Drain Pipe", 'y', (0, -655), 55, (-600, 400), 'upvc')]
add(f, "Rodding eye, 100 mm, stainless access frame with screwed brass plug flush with floor, riser and 45 degree bend into the drain",
    "IfcDiscreteAccessory", ["100_RoddingEye"], parts, [SAN("Drain Pipe", 'back', d=100)],
    {"100 mm access": A(100, "BS EN 12056 / Approved Document H access points"), "Frame 200 x 200 mm": A(200), "45 degree entry": A(45)},
    "Rodding eye modelled as a generic product: access frame with screws, screwed brass plug with key bar, riser, 45 degree bend and drain pipe below floor (z = 0).")

f = 'FMC_P_PipeAccessory_Vent_AirAdmittance'
parts = [C("Base Spigot", 'z', (0, 0), 55, (0, 80), 'grey'),
         T("Body", 'z', (0, 0), [[0, 80], [56, 80], [78, 105], [78, 112], [0, 112]], 'grey'),
         T("Vent Band", 'z', (0, 0), [[0, 112], [74, 112], [74, 145], [0, 145]], 'black'),
         B("Vent Rib A", (-79, -4, 112, 79, 4, 145), 'grey', lod='f'),
         B("Vent Rib B", (-4, -79, 112, 4, 79, 145), 'grey', lod='f'),
         T("Cap", 'z', (0, 0), [[0, 145], [80, 145], [78, 160], [50, 182], [0, 188]], 'grey'),
         F("Label", (-30, -79, 90, 30, -77, 104), 'white', lod='f')]
add(f, "Air admittance valve 110 mm, grey ABS, push-fit spigot, vented body with diaphragm, domed cap",
    "IfcDiscreteAccessory", ["110_AAV"], parts, [VNT("Base Spigot", 'bottom')],
    {"110 mm spigot": A(110, "BS EN 12380"), "Body 160 mm dia, 190 mm high": A("160x190"), "Airflow 32 l/s": A(32)},
    "AAV modelled as a generic product: spigot, flared body, black vent band with ribs, domed cap, label.")

f = 'FMC_P_PipeAccessory_GreaseInterceptor_Undersink'
parts = [B("Body", (-250, -150, 30, 250, 150, 300), 'stainless', r=15),
         B("Lid", (-256, -156, 300, 256, 156, 314), 'stainless', r=18),
         R(B("Lid Clamp Front", (-150, -165, 260, -110, -150, 320), 'chrome', lod='f'), 2, (260, 0, 0)),
         R(B("Lid Clamp Back", (-150, 150, 260, -110, 165, 320), 'chrome', lod='f'), 2, (260, 0, 0)),
         B("Lid Handle", (-60, -15, 314, 60, 15, 340), 'chrome', r=6),
         C("Inlet", 'x', (0, 230), 25, (-310, -250), 'grey'),
         T("Flow Control", 'x', (0, 230), [[0, -340], [32, -340], [32, -310], [0, -310]], 'black'),
         C("Outlet", 'x', (0, 200), 25, (250, 320), 'grey'),
         C("Vent Boss", 'z', (180, 0), 15, (314, 350), 'grey', 'f'),
         R(C("Foot", 'z', (-220, -120), 15, (0, 30), 'rubber', 'f'), 2, (440, 0, 0)),
         R(C("Foot Back", 'z', (-220, 120), 15, (0, 30), 'rubber', 'f'), 2, (440, 0, 0)),
         F("Rating Plate", (-60, -152, 120, 60, -150, 170), 'white', lod='f')]
add(f, "Under-sink grease interceptor 20 l, stainless, clamped gasketed lid with handle, flow-control fitting on inlet, 50 mm inlet and outlet",
    "IfcInterceptor", ["20L_Undersink"], parts,
    [SAN("Inlet", 'left', 'Inlet', 50, 'In'), SAN("Outlet", 'right', 'Outlet', 50, 'Out')],
    {"500 x 300 x 340 mm": A("500x300x340"), "Capacity 20 l, 1 l/s": A("20 l", "BS EN 1825 sizing"), "Inlet/outlet 50 mm": A(50)},
    "Grease interceptor modelled as a generic product: stainless body, lid with four clamps and handle, inlet with flow-control fitting, outlet, vent boss, feet and rating plate.")

# =================================================================== PLUMBING EQUIPMENT
f = 'FMC_P_PlumbingEq_WaterHeater_Instant'
z0 = 1300
parts = [B("Body", (-115, -80, z0, 115, 0, z0 + 330), 'white', r=20),
         F("Front Cover", (-110, -88, z0 + 8, 110, -80, z0 + 322), 'white', r=18),
         F("Display", (-60, -90, z0 + 210, 60, -88, z0 + 260), 'black', r=4, lod='f'),
         F("Display Digits", (-40, -91, z0 + 222, 40, -90, z0 + 248), 'led_blue', lod='f'),
         C("Temp Knob", 'y', (0, z0 + 140), 30, (-104, -88), 'medical_grey'),
         B("Knob Grip", (-4, -108, z0 + 115, 4, -104, z0 + 165), 'grey', lod='f'),
         C("Power LED", 'y', (70, z0 + 80), 4, (-90, -88), 'led_green', 'f'),
         C("Cold Stub", 'z', (-45, -40), 9, (z0 - 60, z0), 'chrome'),
         C("Hot Stub", 'z', (45, -40), 9, (z0 - 60, z0), 'chrome'),
         R(C("Union Nut", 'z', (-45, -40), 14, (z0 - 30, z0 - 12), 'brass', 'f', seg=6), 2, (90, 0, 0)),
         C("Cable Gland", 'z', (0, -30), 10, (z0 - 30, z0), 'grey')]
add(f, "Instantaneous electric water heater, wall-mounted 230 x 88 x 330 mm, digital temperature display, pressure type, 15 mm compression connections",
    "IfcElectricFlowStorageDevice", [{"name": "3kW_Instant", "values": {"Apparent Load": 3000}}, {"name": "6kW_Instant", "values": {"Apparent Load": 6000}}], parts,
    [CW("Cold Stub", 'bottom'), HW("Hot Stub", 'bottom', flow='Out'), E("Cable Gland", 'bottom')],
    {"230 x 88 x 330 mm": A("230x88x330"), "3 kW / 6 kW at 240 V": A("3/6 kW", "type name"), "Mounted at 1300 mm (over sink)": A(1300)},
    "Instant heater modelled as a generic product: body and cover, display with digits, temperature knob, power LED, cold and hot stubs with hex union nuts, cable gland.",
    type_values={"Voltage": 240, "Apparent Load": 3000})

f = 'FMC_P_PlumbingEq_WaterHeater_Storage'
parts = vessel("Tank", 0, -240, 900, 1800, 225, 'epoxy_white', legs=False)
parts += [R(F("Wall Bracket", (-120, -30, 1050, 120, 0, 1090), 'painted_steel'), 2, (0, 0, 550)),
          R(B("Bracket Arm", (-15, -60, 1050, 15, -30, 1090), 'painted_steel', lod='f'), 2, (0, 0, 550)),
          F("Thermostat Cover", (-90, -475, 960, 90, -440, 1080), 'medical_grey', r=20),
          C("Temp Knob", 'y', (-30, 1020), 18, (-490, -475), 'white'),
          C("Heating LED", 'y', (40, 1020), 6, (-478, -475), 'led_red', 'f'),
          F("Rating Label", (-70, -466, 1500, 70, -464, 1600), 'white', lod='f'),
          C("Cold Inlet", 'z', (-80, -240), 11, (820, 920), 'copper'),
          C("Hot Outlet", 'z', (80, -240), 11, (820, 920), 'copper'),
          C("PT Relief Valve", 'x', (-240, 1700), 12, (215, 270), 'brass'),
          C("Relief Discharge", 'z', (270, -240), 10, (1300, 1700), 'copper', 'f'),
          C("Drain Cock", 'z', (0, -300), 8, (840, 900), 'brass', 'f'),
          C("Cable Gland", 'z', (0, -440), 9, (930, 970), 'grey', 'f')]
add(f, "Electric storage water heater (unvented), vertical wall-mounted cylinder 450 mm dia, thermostat cover, P&T relief valve, 15 mm connections (100 l drawn)",
    "IfcElectricFlowStorageDevice", ["50L_Storage", "100L_Storage", "200L_Storage"], parts,
    [CW("Cold Inlet", 'bottom'), HW("Hot Outlet", 'bottom', flow='Out'), E("Thermostat Cover", 'bottom')],
    {"100 l drawn: 450 dia x 900 mm": A("450x900"), "3 kW, 240 V": A(3000), "Bottom at 900 mm": A(900)},
    "Storage heater modelled as a generic product: cylinder with dished heads, wall brackets, thermostat cover with knob and LED, rating label, inlet and outlet, P&T valve with discharge, drain cock, cable gland. 100 l drawn; 50 and 200 l share it.",
    type_values={"Voltage": 240, "Apparent Load": 3000})

f = 'FMC_P_PlumbingEq_WaterHeater_Solar'
coll = [[-1950, 280], [-30, 820], [-30, 900], [-1950, 360]]
glass = [[-1940, 362], [-40, 902], [-40, 908], [-1940, 368]]
parts = [R(RT("Collector Frame", coll, (-1040, -40), 'aluminium'), 2, (1080, 0, 0)),
         R(RT("Collector Glazing", glass, (-1020, -60), 'collector_glass'), 2, (1080, 0, 0)),
         R(B("Front Leg", (-1040, -1960, 0, -1000, -1920, 300), 'aluminium'), 3, (1020, 0, 0)),
         R(B("Rear Leg", (-1040, -20, 0, -1000, 20, 1050), 'aluminium'), 3, (1020, 0, 0)),
         R(B("Base Rail", (-1040, -1960, 0, -1000, 20, 40), 'aluminium'), 3, (1020, 0, 0)),
         C("Tank", 'x', (180, 1180), 270, (-1100, 1100), 'epoxy_white'),
         T("Tank End L", 'x', (180, 1180), [[0, -1160], [180, -1150], [270, -1100], [0, -1100]], 'epoxy_white'),
         T("Tank End R", 'x', (180, 1180), [[0, 1100], [270, 1100], [180, 1150], [0, 1160]], 'epoxy_white'),
         R(B("Tank Cradle", (-760, 0, 900, -720, 360, 930), 'aluminium'), 2, (1480, 0, 0)),
         R(C("Riser", 'z', (-900, -20), 14, (900, 1000), 'copper'), 2, (1800, 0, 0)),
         C("Cold Feed", 'x', (180, 1050), 11, (1160, 1300), 'copper'),
         C("Hot Draw", 'x', (180, 1300), 11, (-1300, -1160), 'copper'),
         C("Relief Valve", 'z', (600, 180), 12, (1450, 1520), 'brass', 'f'),
         R(T("Tank Band", 'x', (180, 1180), [[270, -700], [273, -700], [273, -680], [270, -680]], 'grey', 'f'), 3, (700, 0, 0))]
add(f, "Solar thermosiphon water heater, two flat-plate collectors 2 m2 each on an aluminium frame, horizontal 200 l tank above, close-coupled (roof mounted)",
    "IfcSolarDevice", ["200L_Thermosiphon", "300L_Thermosiphon"], parts,
    [CW("Cold Feed", 'right'), HW("Hot Draw", 'left', flow='Out')],
    {"Collectors 2 x 1000 x 2000 mm": A("2x2 m2"), "Tank 200 l, 540 dia x 2320 mm": A(200), "Tilt about 15 degrees": A(15, "latitude near equator plus self-cleaning slope")},
    "Solar heater modelled as a generic product: two collector frames with glazing, front and rear legs, base rails, horizontal tank with ends, cradles and bands, risers, cold feed, hot draw and relief valve. 200 l drawn; 300 l shares it.")

f = 'FMC_P_PlumbingEq_Calorifier'
parts = vessel("Shell", 0, 0, 350, 2050, 520, 'aluminium', legs=False)
parts += [R(B("Leg", (-420, -420, 0, -360, -360, 500), 'painted_steel'), 2, (780, 0, 0)),
          R(B("Leg Back", (-420, 360, 0, -360, 420, 500), 'painted_steel'), 2, (780, 0, 0)),
          R(T("Cladding Band", 'z', (0, 0), [[520, 700], [524, 700], [524, 715], [520, 715]], 'stainless', 'f'), 3, (0, 0, 450)),
          C("Manhole", 'y', (0, 800), 210, (-560, -520), 'painted_steel'),
          C("Manhole Cover", 'y', (0, 800), 180, (-580, -560), 'painted_steel'),
          R(C("Manhole Bolt", 'y', (-150, 800), 9, (-590, -580), 'chrome', 'f', seg=6), 2, (300, 0, 0)),
          T("Coil Flange", 'x', (0, 600), [[0, 520], [200, 520], [200, 560], [0, 560]], 'painted_steel'),
          C("Steam Inlet", 'x', (60, 700), 30, (560, 720), 'steel'),
          C("Condensate Outlet", 'x', (-60, 500), 20, (560, 720), 'steel'),
          C("Cold Inlet", 'x', (0, 450), 40, (-700, -520), 'copper'),
          C("Hot Outlet", 'z', (0, 0), 40, (2030, 2180), 'copper'),
          T("Hot Outlet Flange", 'z', (0, 0), [[0, 2150], [80, 2150], [80, 2170], [0, 2170]], 'copper'),
          C("Secondary Return", 'x', (0, 1400), 25, (-700, -520), 'copper'),
          C("Safety Valve", 'z', (250, 0), 20, (1980, 2150), 'brass'),
          C("Thermostat Pocket", 'y', (300, 1500), 15, (-600, -490), 'brass', 'f')]
parts += gauge("Thermometer", -200, -520, 1600, 50) + gauge("Pressure Gauge", 200, -520, 1600, 50)
add(f, "Steam-heated calorifier, vertical copper-lined cylinder with aluminium-clad insulation, steam coil, manhole, safety valve, thermometer and gauge (1000 l drawn)",
    "IfcTank", ["1000L_Calorifier", "2000L_Calorifier"], parts,
    [CW("Cold Inlet", 'left'), HW("Hot Outlet", 'top', flow='Out', d=50), HW("Secondary Return", 'left', 'HWS Return', 'In', 32),
     ST("Steam Inlet", 'right'), ST("Condensate Outlet", 'right', 'Condensate', 'Out', 20)],
    {"1000 l drawn: 1040 dia x 2180 mm": A("1040x2180"), "Steam coil, 3 bar g": A("3 bar g"), "Storage at 60 C": A(60, "HTM 04-01 Legionella control")},
    "Calorifier modelled as a generic product: clad shell with dished heads, four legs, cladding bands, manhole with cover and bolts, coil flange, steam and condensate stubs, cold inlet, hot outlet with flange, secondary return, safety valve, thermostat pocket, thermometer and gauge. 1000 l drawn; 2000 l shares it.")

f = 'FMC_P_PlumbingEq_Tank_Poly_Tower'
H = 4500
parts = [R(B("Tower Leg Front", (-950, -950, 0, -880, -880, H), 'steel'), 2, (1830, 0, 0)),
         R(B("Tower Leg Back", (-950, 880, 0, -880, 950, H), 'steel'), 2, (1830, 0, 0)),
         R(B("Footing Front", (-1050, -1050, -50, -780, -780, 150), 'concrete'), 2, (1830, 0, 0)),
         R(B("Footing Back", (-1050, 780, -50, -780, 1050, 150), 'concrete'), 2, (1830, 0, 0)),
         R(B("Brace Front", (-950, -950, 1100, 950, -890, 1160), 'steel'), 3, (0, 0, 1100)),
         R(B("Brace Back", (-950, 890, 1100, 950, 950, 1160), 'steel'), 3, (0, 0, 1100)),
         R(B("Brace Left", (-950, -950, 1100, -890, 950, 1160), 'steel'), 3, (0, 0, 1100)),
         R(B("Brace Right", (890, -950, 1100, 950, 950, 1160), 'steel'), 3, (0, 0, 1100)),
         B("Platform", (-1000, -1000, H, 1000, 1000, H + 60), 'galvanised'),
         T("Tank Body", 'z', (0, 0), [[0, H + 60], [900, H + 60], [910, H + 120], [910, H + 2150], [820, H + 2300], [380, H + 2420], [0, H + 2440]], 'tank'),
         R(T("Tank Rib", 'z', (0, 0), [[905, H + 400], [925, H + 400], [925, H + 440], [905, H + 440]], 'tank', 'f'), 4, (0, 0, 420)),
         C("Manlid", 'z', (0, 0), 250, (H + 2430, H + 2470), 'tank'),
         B("Manlid Handle", (-80, -15, H + 2470, 80, 15, H + 2495), 'tank', lod='f'),
         C("Inlet", 'x', (300, H + 2150), 20, (800, 1050), 'galvanised'),
         C("Overflow", 'x', (-300, H + 2050), 25, (880, 1050), 'upvc'),
         C("Outlet Socket", 'y', (0, H + 180), 25, (-1000, -900), 'galvanised'),
         C("Down Pipe", 'z', (0, -1000), 25, (300, H + 180), 'galvanised'),
         C("Outlet Valve", 'z', (0, -1000), 35, (1200, 1290), 'brass'),
         R(C("Ladder Stile", 'z', (1000, -200), 15, (0, H + 900), 'galvanised'), 2, (0, 400, 0)),
         R(C("Ladder Rung", 'y', (1000, 300), 11, (-200, 200), 'galvanised', 'f'), 16, (0, 0, 300))]
add(f, "Polyethylene water tank 5000 l (black, ribbed) on a 4.5 m steel tower with braced legs, galvanised platform, ladder, inlet, overflow and outlet with valve",
    "IfcTank", ["5000L_Tower", "10000L_Tower"], parts,
    [CW("Inlet", 'right', 'Inlet', 'In', 25), CW("Down Pipe", 'bottom', 'Outlet', 'Out', 50)],
    {"Tank 5000 l, 1820 dia x 2440 mm": A("1820x2440", "typical East African poly tank"), "Tower 4500 mm, 2000 x 2000 mm": A(4500, "gives about 0.45 bar at ground"), "Footings 270 x 270 mm": A(270)},
    "Tower tank modelled as a generic product: four legs on concrete footings, three levels of braces, platform, ribbed poly tank with manlid and handle, inlet, overflow, outlet with down pipe and valve, ladder with rungs. 5000 l drawn; 10000 l shares it.")

f = 'FMC_P_PlumbingEq_Tank_Sectional_GRP'
parts = [R(B("Base Beam", (-2020, -1300, 0, -1920, 1300, 150), 'steel'), 5, (985, 0, 0)),
         B("Tank Body", (-2000, -1250, 150, 2000, 1250, 2150), 'grp'),
         R(B("Flange Front", (-1015, -1290, 150, -985, -1250, 2150), 'grp'), 3, (1000, 0, 0)),
         R(B("Flange Back", (-1015, 1250, 150, -985, 1290, 2150), 'grp'), 3, (1000, 0, 0)),
         R(B("Flange Side L", (-2040, -265, 150, -2000, -235, 2150), 'grp'), 2, (0, 1000, 0)),
         R(B("Flange Side R", (2000, -265, 150, 2040, -235, 2150), 'grp'), 2, (0, 1000, 0)),
         B("Flange Belt Front", (-2000, -1290, 1135, 2000, -1250, 1165), 'grp'),
         B("Flange Belt Back", (-2000, 1250, 1135, 2000, 1290, 1165), 'grp'),
         R(B("Roof Rib", (-1015, -1250, 2150, -985, 1250, 2190), 'grp'), 3, (1000, 0, 0)),
         B("Divider Line Front", (-25, -1300, 150, 25, -1250, 2150), 'grey'),
         B("Divider Line Roof", (-25, -1250, 2150, 25, 1250, 2200), 'grey'),
         R(B("Hatch", (-1700, -900, 2150, -1100, -300, 2210), 'grp'), 2, (2800, 0, 0)),
         R(B("Hatch Lid", (-1710, -910, 2210, -1090, -290, 2230), 'grp', lod='f'), 2, (2800, 0, 0)),
         R(C("Vent Pipe", 'z', (-1400, 600), 30, (2150, 2350), 'upvc'), 2, (2800, 0, 0)),
         R(T("Vent Cowl", 'z', (-1400, 600), [[0, 2350], [70, 2350], [60, 2390], [0, 2410]], 'upvc'), 2, (2800, 0, 0)),
         R(C("Ladder Stile", 'z', (-2150, -200), 15, (0, 2700), 'galvanised'), 2, (0, 400, 0)),
         R(C("Ladder Rung", 'y', (-2150, 300), 11, (-200, 200), 'galvanised', 'f'), 8, (0, 0, 300)),
         C("Inlet Pipe", 'x', (0, 2000), 25, (2000, 2250), 'galvanised'),
         C("Outlet Pipe 1", 'y', (-1000, 350), 40, (-1500, -1290), 'galvanised'),
         C("Outlet Pipe 2", 'y', (1000, 350), 40, (-1500, -1290), 'galvanised'),
         C("Overflow Pipe", 'x', (-800, 1950), 40, (2000, 2250), 'upvc'),
         C("Drain Valve", 'y', (-1500, 250), 25, (-1400, -1290), 'brass', 'f'),
         C("Level Gauge", 'z', (1900, -1300), 12, (300, 2050), 'polycarbonate', 'f')]
parts += handwheel("Outlet Valve 1", -1000, -1420, 350, 70, 'red', 'y') + handwheel("Outlet Valve 2", 1000, -1420, 350, 70, 'red', 'y')
add(f, "Sectional GRP water tank 20 m3, 4000 x 2500 x 2000 mm on 1 m panels, divided into two compartments, steel bearers, roof hatches and vents, external ladder, valved outlets",
    "IfcTank", ["20m3_GRP", "50m3_GRP"], parts,
    [CW("Inlet Pipe", 'right', 'Inlet', 'In', 50), CW("Outlet Pipe 1", 'front', 'Outlet A', 'Out', 80), CW("Outlet Pipe 2", 'front', 'Outlet B', 'Out', 80)],
    {"4000 x 2500 x 2000 mm, 20 m3": A("4000x2500x2000"), "Two compartments": A(2, "HTM 04-01 divided storage for maintenance"), "Bearers 150 mm at 1 m": A(150)},
    "GRP tank modelled as a generic product: steel bearers, panel body, external flange grid (vertical, belt and roof ribs), divider line, two hatches with lids, two vent cowls, ladder, inlet, two outlets with handwheel valves, overflow, drain and level gauge. 20 m3 drawn; 50 m3 shares it.")

f = 'FMC_P_PlumbingEq_Tank_Underground_Rainwater'
parts = [C("Tank Body", 'x', (0, -1750), 1250, (-2200, 2200), 'hdpe'),
         T("End Cap L", 'x', (0, -1750), [[0, -2400], [800, -2350], [1250, -2200], [0, -2200]], 'hdpe'),
         T("End Cap R", 'x', (0, -1750), [[0, 2200], [1250, 2200], [800, 2350], [0, 2400]], 'hdpe'),
         R(T("Rib", 'x', (0, -1750), [[1250, -1900], [1300, -1900], [1300, -1840], [1250, -1840]], 'hdpe', 'f'), 8, (500, 0, 0)),
         C("Access Turret", 'z', (0, 0), 350, (-560, -70), 'hdpe'),
         C("Manhole Cover", 'z', (0, 0), 380, (-70, 0), 'painted_steel'),
         R(B("Cover Keyhole", (-120, -10, -1, -90, 10, 0.5), 'black', lod='f'), 2, (210, 0, 0)),
         C("Filter Turret", 'z', (-1500, 0), 250, (-560, -70), 'hdpe'),
         C("Filter Cover", 'z', (-1500, 0), 280, (-70, 0), 'painted_steel'),
         C("Inlet Pipe", 'x', (0, -350), 55, (-2700, -1750), 'upvc'),
         C("Overflow Pipe", 'x', (0, -600), 55, (1750, 2700), 'upvc'),
         C("Delivery Pipe", 'y', (200, -350), 20, (0, 600), 'hdpe'),
         B("Bedding Slab", (-2600, -1500, -3100, 2600, 1500, -3000), 'concrete')]
add(f, "Underground rainwater harvesting tank 20 m3, ribbed HDPE horizontal cylinder 2500 dia x 4800 mm, access turret and filter turret with covers at grade, inlet, overflow and pump delivery",
    "IfcTank", ["20m3_Underground", "50m3_Underground"], parts,
    [SAN("Inlet Pipe", 'left', 'Rainwater In', 110, 'In'), SAN("Overflow Pipe", 'right', 'Overflow', 110, 'Out'), CW("Delivery Pipe", 'back', 'Delivery', 'Out', 40)],
    {"2500 dia x 4800 mm, 20 m3": A("2500x4800"), "Cover at finished ground (z = 0)": A(0), "Bedding slab 100 mm C20": A(100, "BS 8515 rainwater harvesting")},
    "Rainwater tank modelled as a generic product: ribbed cylinder with domed end caps, access turret and cover with keyholes, filter turret and cover, inlet, overflow, delivery pipe and bedding slab, all below ground (z = 0). 20 m3 drawn; 50 m3 shares it.")

f = 'FMC_P_PlumbingEq_Pump_BoosterSet'
parts = [B("Base Frame", (-650, -450, 0, 650, 350, 120), 'painted_steel'),
         R(B("Pump Foot", (-330, -90, 120, -170, 90, 160), 'stainless'), 2, (500, 0, 0)),
         R(C("Pump Sleeve", 'z', (-250, 0), 70, (160, 640), 'stainless'), 2, (500, 0, 0)),
         R(T("Pump Head", 'z', (-250, 0), [[0, 640], [85, 640], [85, 680], [60, 700], [0, 700]], 'stainless'), 2, (500, 0, 0)),
         R(T("Motor Stool", 'z', (-250, 0), [[0, 700], [70, 700], [95, 780], [0, 780]], 'blue'), 2, (500, 0, 0)),
         R(C("Motor", 'z', (-250, 0), 105, (780, 1080), 'blue'), 2, (500, 0, 0)),
         R(T("Fan Cowl", 'z', (-250, 0), [[0, 1080], [110, 1080], [110, 1140], [80, 1160], [0, 1160]], 'blue'), 2, (500, 0, 0)),
         R(B("Terminal Box", (-300, -170, 880, -200, -100, 990), 'blue', r=4), 2, (500, 0, 0)),
         C("Suction Header", 'x', (-330, 220), 50, (-700, 600), 'stainless'),
         R(C("Suction Branch", 'y', (-250, 220), 32, (-330, -60), 'stainless'), 2, (500, 0, 0)),
         C("Discharge Header", 'x', (250, 600), 50, (-600, 700), 'stainless'),
         R(C("Discharge Branch", 'y', (-250, 600), 32, (60, 250), 'stainless'), 2, (500, 0, 0)),
         R(C("Check Valve", 'y', (-250, 600), 42, (120, 180), 'brass'), 2, (500, 0, 0)),
         R(C("Isolator", 'y', (-250, 220), 42, (-260, -200), 'brass'), 2, (500, 0, 0)),
         R(B("Isolator Lever", (-260, -255, 262, -110, -205, 274), 'red', lod='f'), 2, (500, 0, 0)),
         C("Gauge Riser", 'z', (550, 250), 8, (650, 760), 'brass')]
parts += gauge("Discharge Gauge", 550, 225, 800, 45, stem=False)
parts += vessel("Pressure Vessel", 860, 0, 120, 900, 180, 'red', legs=True)
parts += [B("Panel Stand", (-40, 280, 120, 40, 330, 1150), 'painted_steel')] + panel("Control Panel", -280, 280, 1150, 1600, 300, 180)
add(f, "Cold water booster set, duty/standby: two vertical multistage stainless pumps with motors on a base frame, suction and discharge headers, check and isolating valves, membrane pressure vessel, VSD control panel",
    "IfcPump", ["2x2.2kW_DutyStandby"], parts,
    [CW("Suction Header", 'left', 'Suction', 'In', 80), CW("Discharge Header", 'right', 'Discharge', 'Out', 80), E("Control Panel Enclosure", 'top')],
    {"Footprint 1600 x 800 mm, height 1600 mm": A("1600x800x1600"), "2 x 2.2 kW, 415 V 3-phase": A("2x2.2 kW"), "Vessel 80 l": A(80, "BS EN 806-2 booster practice")},
    "Booster set modelled as a generic product: base frame, two pumps (foot, sleeve, head, motor stool, motor, fan cowl, terminal box), suction and discharge headers with branches, check valves and isolators with levers, gauge, red membrane vessel on legs, control panel on a stand with screen, LEDs and isolator.",
    type_values={"Voltage": 415, "Number of Poles": 3, "Apparent Load": 5500})

f = 'FMC_P_PlumbingEq_Pump_Sump_Submersible'
parts = [B("Stand Foot", (-130, -15, 0, 130, 15, 30), 'painted_steel'),
         B("Stand Foot B", (-15, -130, 0, 15, 130, 30), 'painted_steel'),
         T("Strainer Base", 'z', (0, 0), [[0, 30], [140, 30], [140, 90], [0, 90]], 'black'),
         T("Strainer Slots", 'z', (0, 0), [[140, 45], [142, 45], [142, 75], [140, 75]], 'painted_steel', 'f'),
         T("Volute", 'z', (0, 0), [[0, 90], [150, 90], [150, 200], [120, 220], [0, 220]], 'painted_steel'),
         C("Motor Housing", 'z', (0, 0), 115, (220, 560), 'stainless'),
         R(T("Housing Rib", 'z', (0, 0), [[115, 280], [120, 280], [120, 290], [115, 290]], 'stainless', 'f'), 4, (0, 0, 70)),
         T("Top Cover", 'z', (0, 0), [[0, 560], [115, 560], [100, 600], [0, 610]], 'painted_steel'),
         B("Handle Post L", (-80, -10, 600, -65, 10, 720), 'stainless'),
         B("Handle Post R", (65, -10, 600, 80, 10, 720), 'stainless'),
         B("Handle Bar", (-80, -10, 705, 80, 10, 725), 'stainless'),
         C("Cable Gland", 'z', (40, 40), 14, (600, 640), 'black'),
         C("Cable", 'z', (40, 40), 6, (640, 1600), 'black'),
         C("Discharge Stub", 'x', (0, 160), 32, (150, 230), 'painted_steel'),
         C("Riser Pipe", 'z', (260, 0), 32, (130, 1700), 'galvanised'),
         C("Discharge Bend", 'x', (0, 160), 32, (230, 290), 'galvanised'),
         C("Check Valve", 'z', (260, 0), 45, (900, 1000), 'brass'),
         C("Gate Valve", 'z', (260, 0), 45, (1150, 1230), 'brass'),
         T("Float Switch", 'z', (-220, 80), [[0, 380], [35, 400], [40, 440], [30, 470], [0, 480]], 'yellow'),
         C("Float Cable", 'z', (-150, 60), 4, (480, 1600), 'black', 'f')]
parts += handwheel("Valve Wheel", 260, -80, 1190, 50, 'red', 'y')
add(f, "Submersible sump pump 1.5 kW, cast iron volute and stainless motor housing on a stand, lifting handle, float switch, 50 mm discharge riser with check and gate valves",
    "IfcPump", ["1.5kW_Submersible"], parts,
    [SAN("Riser Pipe", 'top', 'Discharge', 50, 'Out'), E("Cable", 'top')],
    {"1.5 kW, 240 V": A(1500), "Pump 300 dia x 725 mm": A("300x725"), "Discharge 50 mm": A(50)},
    "Sump pump modelled as a generic product: cross stand, strainer base with slots, volute, ribbed motor housing, top cover, lifting handle, cable and gland, discharge stub, bend and riser with check valve, gate valve and handwheel, float switch with cable. Stands on the sump floor (z = 0).",
    type_values={"Voltage": 240, "Apparent Load": 1800})

f = 'FMC_P_PlumbingEq_WaterTreatment_RO_Dialysis'
parts = [R(B("Frame Post Front", (-800, -400, 0, -760, -360, 1900), 'stainless'), 2, (1560, 0, 0)),
         R(B("Frame Post Back", (-800, 360, 0, -760, 400, 1900), 'stainless'), 2, (1560, 0, 0)),
         R(B("Frame Rail Front", (-800, -400, 1860, 800, -360, 1900), 'stainless'), 2, (0, 0, -1760)),
         R(B("Frame Rail Back", (-800, 360, 1860, 800, 400, 1900), 'stainless'), 2, (0, 0, -1760)),
         R(C("Membrane Vessel", 'x', (100, 1150), 52, (-700, 700), 'white'), 4, (0, 0, 160)),
         R(T("Vessel Cap L", 'x', (100, 1150), [[0, -740], [56, -740], [56, -700], [0, -700]], 'grey'), 4, (0, 0, 160)),
         R(T("Vessel Cap R", 'x', (100, 1150), [[0, 700], [56, 700], [56, 740], [0, 740]], 'grey'), 4, (0, 0, 160)),
         C("Vessel Manifold", 'z', (-760, 100), 16, (1100, 1680), 'stainless', 'f'),
         R(C("Cartridge Housing", 'z', (-600, -200), 65, (350, 850), 'blue'), 2, (200, 0, 0)),
         R(T("Cartridge Head", 'z', (-600, -200), [[0, 850], [75, 850], [75, 900], [0, 900]], 'blue'), 2, (200, 0, 0)),
         B("Pump Base", (-150, -300, 40, 450, 100, 80), 'stainless')]
parts += motor_x("HP Pump", 0, 420, -100, 200, 110, 'blue', fins=3)
parts += [C("Pump End", 'x', (-100, 200), 70, (-140, 0), 'stainless'),
          R(C("Flow Meter", 'z', (200, -385), 18, (1200, 1450), 'polycarbonate'), 3, (90, 0, 0)),
          R(C("Flow Float", 'z', (200, -385), 12, (1300, 1320), 'led_red', 'f'), 3, (90, 0, 0))]
parts += gauge("Feed Gauge", -350, -360, 1350, 40, stem=False) + gauge("Reject Gauge", -200, -360, 1350, 40, stem=False)
parts += panel("Control Panel", 400, 760, 1300, 1800, -400, 180)
parts += [C("Feed Inlet", 'x', (-200, 250), 20, (-900, -800), 'stainless'), C("Drain Outlet", 'z', (500, 200), 20, (-50, 40), 'stainless'),
          C("Permeate Outlet", 'x', (100, 1700), 16, (800, 900), 'stainless')]
add(f, "Reverse osmosis plant 500 l/h for dialysis water, stainless skid with four membrane pressure vessels, twin cartridge pre-filters, high-pressure pump, flow meters, gauges and HMI control panel",
    "IfcUnitaryEquipment", ["500Lh_RO"], parts,
    [CW("Feed Inlet", 'left', 'Feed', 'In', 25), CW("Permeate Outlet", 'right', 'Permeate', 'Out', 25), SAN("Drain Outlet", 'bottom', 'Reject', 25), E("Control Panel Enclosure", 'top')],
    {"Skid 1600 x 800 x 1900 mm": A("1600x800x1900"), "500 l/h permeate": A(500, "type name"), "Water to ISO 23500 / BS ISO 13959": A("ISO 23500"), "Power 3 kVA, 415 V": A(3000)},
    "RO plant modelled as a generic product: stainless frame (posts, rails), four membrane vessels with end caps and manifold, two cartridge housings, pump base with motor and pump end, three flow meters with floats, feed and reject gauges, control panel with screen and LEDs, feed, permeate and drain stubs.",
    type_values={"Voltage": 415, "Number of Poles": 3, "Apparent Load": 3000})

f = 'FMC_P_PlumbingEq_UVSteriliser'
parts = [C("Chamber", 'x', (-150, 1600), 50, (-450, 450), 'stainless'),
         T("End Cap", 'x', (-150, 1600), [[0, 450], [58, 450], [58, 490], [0, 490]], 'stainless'),
         T("Lamp Cap", 'x', (-150, 1600), [[0, 490], [32, 490], [32, 560], [0, 560]], 'black'),
         C("Lamp Cable", 'z', (540, -150), 5, (1300, 1600), 'black', 'f'),
         C("Inlet Stub", 'z', (-370, -150), 16, (1650, 1730), 'stainless'),
         C("Outlet Stub", 'z', (370, -150), 16, (1650, 1730), 'stainless'),
         R(T("Union", 'z', (-370, -150), [[0, 1700], [24, 1700], [24, 1720], [0, 1720]], 'brass', 'f'), 2, (740, 0, 0)),
         R(F("Wall Clamp", (-300, -30, 1520, -260, 0, 1680), 'stainless'), 2, (560, 0, 0)),
         R(B("Clamp Arm", (-300, -150, 1540, -260, -30, 1560), 'stainless', lod='f'), 2, (560, 0, 0)),
         C("UV Sensor Port", 'y', (0, 1600), 14, (-215, -195), 'black'),
         B("Controller", (-180, -90, 1200, 180, 0, 1420), 'white', r=10),
         F("Controller Display", (-120, -92, 1320, 40, -90, 1390), 'black', r=4, lod='f'),
         C("Lamp LED", 'y', (90, 1360), 6, (-93, -90), 'led_blue', 'f'),
         C("Alarm LED", 'y', (130, 1360), 6, (-93, -90), 'led_red', 'f'),
         R(C("Controller Button", 'y', (-80, 1250), 10, (-94, -90), 'grey', 'f'), 3, (60, 0, 0))]
add(f, "Inline UV steriliser, wall-mounted stainless chamber 100 dia x 1000 mm with UV-C lamp, UV intensity sensor and controller with lamp-life display",
    "IfcFilter", ["Inline_UV"], parts,
    [CW("Inlet Stub", 'top', 'Inlet', 'In', 25), CW("Outlet Stub", 'top', 'Outlet', 'Out', 25), E("Controller", 'back')],
    {"Chamber 100 dia x 1000 mm": A("100x1000"), "Dose 40 mJ/cm2": A(40, "BS EN 14897 / HTM 04-01 point-of-entry UV"), "Lamp 80 W, 240 V": A(80)},
    "UV steriliser modelled as a generic product: chamber with end cap and lamp cap, lamp cable, inlet and outlet stubs with unions, wall clamps, UV sensor port, controller with display, LEDs and buttons.",
    type_values={"Voltage": 240, "Apparent Load": 100})

def cssd_face(pre, yf, s, door_glass=True, wide=380):
    """Front (s=-1) or rear (s=+1) face of a pass-through CSSD machine at y = yf."""
    o = yf + s * 6
    p = [F(f"{pre} Door Frame", (-wide, min(yf, o), 300, wide, max(yf, o), 1500), 'stainless', r=10)]
    if door_glass: p.append(F(f"{pre} Door Glass", (-wide + 40, min(o, o + s * 3), 340, wide - 40, max(o, o + s * 3), 1460), 'glass', r=8))
    p += [F(f"{pre} Kick Plate", (-wide - 60, min(yf, yf + s * 4), 20, wide + 60, max(yf, yf + s * 4), 260), 'grey'),
          F(f"{pre} Control Panel", (-wide, min(yf, yf + s * 4), 1560, wide, max(yf, yf + s * 4), 1880), 'medical_grey', r=8),
          F(f"{pre} Touchscreen", (-wide + 40, min(yf, yf + s * 7), 1620, -wide + 300, max(yf, yf + s * 7), 1820), 'black', r=4),
          C(f"{pre} Status LED", 'y', (wide - 60, 1760), 9, sorted((yf, yf + s * 8)), 'led_green', 'f'),
          C(f"{pre} Stop Button", 'y', (wide - 60, 1660), 18, sorted((yf, yf + s * 14)), 'red', 'f')]
    return p

f = 'FMC_P_PlumbingEq_Washer_Disinfector_CSSD'
parts = [B("Cabinet", (-500, -400, 0, 500, 400, 1950), 'stainless', r=6)]
parts += cssd_face("Load", -400, -1) + cssd_face("Unload", 400, 1)
parts += [F("Wall Flange", (-560, -20, 0, 560, 20, 2000), 'stainless', lod='f')]
parts += [B("Service Duct", (-450, -300, 1950, 450, 300, 2100), 'stainless', r=6),
          C("Vapour Condenser", 'z', (300, 0), 80, (2100, 2250), 'stainless'),
          B("Rack Rail", (-330, -340, 1000, 330, -330, 1010), 'chrome', lod='f'),
          C("Drain Spigot", 'z', (0, 200), 40, (-80, 0), 'grey')]
add(f, "Pass-through washer-disinfector for CSSD, stainless 1000 x 800 x 1950 mm, glazed vertical-sliding doors on the load and clean sides, touchscreen panels, service duct and vapour condenser",
    "IfcUnitaryEquipment", ["1000_SingleDoor", "1000_DoubleDoor"], parts,
    [CW("Service Duct", 'top'), HW("Service Duct", 'back'), SAN("Drain Spigot", 'bottom', d=75), E("Service Duct", 'right')],
    {"1000 x 800 x 1950 mm": A("1000x800x1950", "BS EN ISO 15883-2 machine, HBN 13 CSSD"), "Power 18 kVA, 415 V": A(18000), "Drain 75 mm": A(75)},
    "Washer-disinfector modelled as a generic product: cabinet, load and unload faces (door frame and glass, kick plate, control panel, touchscreen, LED and stop button), wall flange for the barrier wall (y = 0), service duct, vapour condenser, rack rail, drain. Double-door drawn; single-door shares it.",
    type_values={"Voltage": 415, "Number of Poles": 3, "Apparent Load": 18000})

f = 'FMC_P_PlumbingEq_Steriliser_Steam_CSSD'
parts = [B("Cabinet", (-550, -700, 0, 550, 700, 1950), 'stainless', r=6)]
parts += cssd_face("Load", -700, -1, door_glass=False, wide=360) + cssd_face("Unload", 700, 1, door_glass=False, wide=360)
parts += [F("Load Chamber Door", (-320, -712, 420, 320, -706, 1300), 'stainless', r=60),
          F("Unload Chamber Door", (-320, 706, 420, 320, 712, 1300), 'stainless', r=60),
          F("Load Door Seal", (-330, -707, 410, 330, -706, 1310), 'black', r=64, lod='f'),
          F("Load Door Badge", (-120, -714, 1200, 120, -712, 1240), 'medical_grey', lod='f'),
          C("Load Printer Slot", 'y', (200, 1700), 3, (-708, -704), 'black', 'f'),
          F("Wall Flange", (-610, -20, 0, 610, 20, 2000), 'stainless', lod='f'),
          B("Service Header", (-450, -400, 1950, 450, 400, 2080), 'stainless', r=6),
          C("Steam Inlet", 'z', (-300, 200), 20, (2080, 2200), 'steel'),
          C("Water Inlet", 'z', (-100, 200), 12, (2080, 2200), 'copper'),
          C("Vent Stack", 'z', (300, 0), 40, (2080, 2300), 'stainless'),
          C("Drain Spigot", 'z', (0, 300), 40, (-80, 0), 'grey')]
add(f, "Pass-through steam steriliser for CSSD, 300 l chamber, stainless 1100 x 1400 x 1950 mm, sliding chamber doors with seals on both sides, touchscreen panels with printer, service header with steam, water, vent and drain",
    "IfcUnitaryEquipment", ["300L_PassThrough", "600L_PassThrough"], parts,
    [ST("Steam Inlet", 'top'), CW("Water Inlet", 'top'), SAN("Drain Spigot", 'bottom', d=50), E("Service Header", 'right')],
    {"1100 x 1400 x 1950 mm, 300 l": A("1100x1400x1950", "BS EN 285 large steriliser, HBN 13"), "Steam 3 bar g, 25 mm": A("3 bar g"), "Power 6 kVA, 415 V": A(6000)},
    "Steam steriliser modelled as a generic product: cabinet, load and unload faces (door frame, chamber door with seal and badge, kick plate, panel, touchscreen, printer slot, LED, stop button), wall flange, service header with steam, water, vent stack and drain. Built on the Mechanical Equipment template with category Plumbing Equipment for the category-switch test (connectors must survive).",
    template="Metric Mechanical Equipment.rft", type_values={"Voltage": 415, "Number of Poles": 3, "Apparent Load": 6000})

f = 'FMC_P_PlumbingEq_Autoclave_Benchtop'
parts = [B("Body", (-230, -580, 25, 230, 0, 440), 'white', r=25),
         F("Front Bezel", (-225, -590, 30, 225, -580, 435), 'medical_grey', r=20),
         T("Door", 'y', (-50, 230), [[0, -590], [150, -590], [150, -608], [140, -615], [0, -615]], 'stainless'),
         T("Door Seal Ring", 'y', (-50, 230), [[150, -590], [158, -590], [158, -594], [150, -594]], 'black', 'f'),
         B("Door Handle", (60, -640, 200, 130, -612, 260), 'black', r=8),
         F("Display", (130, -593, 300, 210, -590, 380), 'black', r=4),
         R(C("Program Button", 'y', (150, 250), 9, (-594, -590), 'blue', 'f'), 3, (25, 0, 0)),
         C("Power LED", 'y', (170, 100), 5, (-593, -590), 'led_green', 'f'),
         F("Reservoir Lid", (-150, -430, 440, 150, -160, 448), 'grey', r=10),
         R(B("Side Vent", (230, -480, 120, 232, -100, 128), 'grey', lod='f'), 5, (0, 0, 25)),
         R(C("Foot", 'z', (-190, -540), 18, (0, 25), 'rubber', 'f'), 2, (380, 0, 0)),
         R(C("Foot Back", 'z', (-190, -40), 18, (0, 25), 'rubber', 'f'), 2, (380, 0, 0)),
         C("Drain Hose Port", 'y', (-120, 100), 10, (0, 20), 'grey'),
         C("Water Fill Port", 'y', (120, 100), 8, (0, 20), 'grey')]
add(f, "Benchtop steam autoclave 23 l, class B, 460 x 590 x 440 mm, round stainless door with locking handle, display and program buttons, top water reservoir",
    "IfcMedicalDevice", ["23L_Benchtop"], parts,
    [CW("Water Fill Port"), SAN("Drain Hose Port", d=15), E("Body", 'back')],
    {"460 x 590 x 440 mm": A("460x590x440"), "23 l chamber, class B": A(23, "BS EN 13060"), "Power 2.3 kVA, 240 V": A(2300)},
    "Bench autoclave modelled as a generic product: body, bezel, round door with seal ring and handle, display, buttons, LED, reservoir lid, side vents, feet, fill and drain ports. Sits on the bench (z = 0 at worktop).",
    type_values={"Voltage": 240, "Apparent Load": 2300})

for fam, tname, desc, labels, conns in (
        ('FMC_P_PlumbingEq_ServicePoint_MedGas', '60_MedGas', 'Medical gas service point (O2, vacuum, medical air) inside a Medical Equipment host',
         [('O2', 'white', 'back'), ('VAC', 'yellow', 'left'), ('MA4', 'black', 'right')],
         [MG('O2', 'Point', 'back', 'In'), MG('VAC', 'Point', 'left', 'Out'), MG('MA4', 'Point', 'right', 'In')]),
        ('FMC_P_PlumbingEq_ServicePoint_Water', '60_Water', 'Water and drainage service point (CW, HW, waste) inside a Medical Equipment host',
         [('CW', 'blue', 'back'), ('HW', 'red', 'left'), ('Waste', 'grey', 'bottom')],
         [CW('Point', 'back'), HW('Point', 'left'), SAN('Point', 'bottom', d=40)])):
    parts = [B("Point", (-30, -30, 0, 30, 30, 60), 'medical_grey')]
    for n, m, side in labels:   # identification tags on the connector faces, inside the 60 mm cube outline
        if side == 'back': parts.append(F(f"{n} Tag", (-20, 29, 40, 20, 30, 52), m, lod='f'))
        if side == 'left': parts.append(B(f"{n} Tag", (-30, -20, 40, -29, 20, 52), m, lod='f'))
        if side == 'right': parts.append(B(f"{n} Tag", (29, -20, 40, 30, 20, 52), m, lod='f'))
        if side == 'bottom': parts.append(F(f"{n} Tag", (-20, -30, 4, 20, -29, 16), m, lod='f'))
    add(fam, desc, "IfcFlowTerminal", [tname], parts, conns,
        {"Point 60 mm cube": A(60, 'symbolic connection point'), "Connectors " + ', '.join(c['n'] for c in conns): A(len(conns), "Revit QE4: pipes refuse Medical Equipment hosts")},
        "Nested shared service point: carries the pipe connectors a Medical Equipment host cannot (Revit QE4 test, 17 Oct). Placed inside the host at the real outlet position; a 60 mm cube with BS 1710 / water identification tags (Fine only).",
        extra={"shared": True, "keynote_exempt": "nested service point, never scheduled; the host carries the keynote"})

# =================================================================== MEDICAL GAS (Mechanical Equipment)
def terminal(fam, types, gas, desc, vals, about, agss=False):
    ring_m, lab = GAS[gas]
    parts = [B("Back Box", (-45, 0, 5, 45, 55, 95), 'painted_steel'),
             F("Fascia", (-50, -10, 0, 50, 0, 100), 'white', r=8),
             F("Fascia Face", (-47, -12, 3, 47, -10, 97), 'white', r=7, lod='f'),
             T("Gas Ring", 'y', (0, 55), [[19, -12], [27, -12], [27, -16], [19, -16]], ring_m),
             T("Socket Collar", 'y', (0, 55), [[0, -10], [19, -10], [19, -24], [15, -26], [6, -26], [6, -22], [0, -22]], 'chrome'),
             T("Release Ring", 'y', (0, 55), [[14, -24], [17, -24], [17, -28], [14, -28]], 'chrome', 'f'),
             F("Label Strip", (-30, -12.6, 14, 30, -12, 26), lab, r=2, lod='f'),
             R(C("Screw", 'y', (-40, 90), 2.5, (-12.8, -12), 'chrome', 'f'), 2, (80, 0, 0))]
    if agss:   # AGSS terminal (BS ISO 9170-2): larger 30 mm socket and flow indicator window
        parts[3:6] = [T("Gas Ring", 'y', (0, 58), [[24, -12], [33, -12], [33, -16], [24, -16]], ring_m),
                      T("Socket Collar", 'y', (0, 58), [[0, -10], [24, -10], [24, -30], [20, -32], [10, -32], [10, -26], [0, -26]], 'chrome'),
                      F("Flow Indicator", (25, -13, 80, 42, -12, 92), 'polycarbonate', r=3, lod='f'),
                      F("Flow Indicator Ball", (31, -13.5, 83, 36, -13, 88), 'led_green', lod='f')]
        parts[0]['at'] = [-45, 0, 0, 45, 70, 100]
    add(fam, desc, "IfcFlowTerminal", types, parts, [MG(gas, "Back Box", 'back', 'Out' if gas in ('VAC', 'AGSS') else 'In')], vals, about,
        type_values={"Default Elevation": 1400})

terminal('FMC_P_MechEq_MedGas_Outlet_MedAir', ["BS5682_MA4", "BS5682_SA7"], 'MA4',
         "Medical air terminal unit (4 bar) / surgical air (7 bar), BS 5682 probe, wall mounted, flush back box, black and white identification",
         {"Probe to BS 5682": A("BS 5682", "BS 5682:2015, gas-specific probes"), "Fascia 100 x 100 mm": A("100x100"), "Identification black/white": A("black/white", "BS 1710 / HTM 02-01"), "Mounting height 1400 mm": A(1400, "bedhead practice")},
         "Terminal unit modelled as a generic product: square fascia, black identification ring, chrome collar and release ring, white label strip, screws, steel back box. MA4 and SA7 share geometry (the SA7 probe differs in the socket).")
terminal('FMC_P_MechEq_MedGas_Outlet_N2O', ["BS5682_N2O", "BS5682_Entonox"], 'N2O',
         "Nitrous oxide / Entonox terminal unit, BS 5682 probe, wall mounted, flush back box, French blue identification",
         {"Probe to BS 5682": A("BS 5682"), "Fascia 100 x 100 mm": A("100x100"), "Identification French blue (Entonox blue/white)": A("French blue", "BS 1710 / BS 381C 166, HTM 02-01"), "Mounting height 1400 mm": A(1400)},
         "Terminal unit modelled as a generic product: square fascia, French blue identification ring and label, chrome collar and release ring, screws, steel back box. Entonox type shares geometry (blue/white label).")
terminal('FMC_P_MechEq_MedGas_Outlet_AGSS', ["ISO9170_AGSS"], 'AGSS',
         "Anaesthetic gas scavenging (AGSS) terminal unit, BS ISO 9170-2, 30 mm socket with flow indicator, wall or pendant mounted, flush back box",
         {"Terminal to BS ISO 9170-2": A("ISO 9170-2", "HTM 02-01 AGSS"), "Fascia 100 x 100 mm": A("100x100"), "Flow 80 l/min extract": A(80, "BS EN ISO 7396-2 high-flow AGSS")},
         "AGSS terminal modelled as a generic product: fascia, larger 30 mm socket collar with identification ring, flow indicator window with ball, label, screws, deep back box.", agss=True)

# Bedhead panel (horizontal trunking)
f = 'FMC_P_MechEq_MedGas_BedheadPanel'
nose = [[0, 0], [-70, 0], [-90, 25], [-90, 275], [-70, 300], [0, 300]]
parts = [RT("Trunking", nose, (-1000, 1000), 'aluminium'),
         RT("End Cap L", [[0, -5], [-75, -5], [-95, 25], [-95, 275], [-75, 305], [0, 305]], (-1012, -1000), 'grey'),
         RT("End Cap R", [[0, -5], [-75, -5], [-95, 25], [-95, 275], [-75, 305], [0, 305]], (1000, 1012), 'grey'),
         B("Uplight Lens", (-950, -70, 300, 950, -15, 308), 'polycarbonate'),
         F("Reading Light Lens", (-400, -88, -6, 400, -18, 0), 'polycarbonate', lod='f'),
         R(F("Divider", (-260, -92, 20, -256, -90, 280), 'grey', lod='f'), 3, (380, 0, 0)),
         F("Label Strip", (-950, -92, 262, 950, -90, 280), 'white', lod='f')]
for n, x in (('O2', 450), ('VAC', 580), ('MA4', 710)): parts += tu(n, x, 140, n, y0=-90)
parts += socket("Socket A", -800, 150, y0=-90) + socket("Socket B", -620, 150, y0=-90, switch='red')
parts += [F("Nurse Call Plate", (-410, -99, 107, -290, -90, 193), 'white', r=5),
          C("Call Button", 'y', (-370, 165), 14, (-104, -99), 'led_red', 'f'),
          C("Reset Button", 'y', (-330, 165), 14, (-104, -99), 'led_green', 'f'),
          C("Reassurance LED", 'y', (-310, 125), 4, (-101, -99), 'yellow', 'f'),
          C("Handset Socket", 'y', (-370, 125), 10, (-101, -99), 'black', 'f'),
          F("Data Plate", (-240, -99, 107, -154, -90, 193), 'white', r=5),
          R(F("RJ45", (-228, -100, 150, -208, -99, 166), 'black', lod='f'), 2, (34, 0, 0))]
add(f, "Bedhead services panel: 2000 mm horizontal aluminium trunking with O2, vacuum and medical air terminal units, two twin sockets (one essential red rockers), nurse call and data, uplight and reading light",
    "IfcFlowTerminal", [{"name": "1Bed_Panel"}, {"name": "2Bed_Panel"}], parts,
    [MG('O2', 'O2 Fascia'), MG('VAC', 'VAC Fascia', flow='Out'), MG('MA4', 'MA4 Fascia'), E("Socket A Plate"), ELV("Nurse Call Plate", 'NurseCall'), ELV("Data Plate", 'Data')],
    {"Trunking 2000 x 300 x 90 mm": A("2000x300x90", "HTM 08-03 bedhead services"), "Outlets at 1440 mm": A(1440, "trunking at 1300 mm, HBN 04-01"), "Gas order O2, VAC, MA": A("O2/VAC/MA4", "HTM 02-01 terminal order")},
    "Bedhead panel modelled as a generic product: trunking extrusion with end caps, uplight and reading-light lenses, dividers, label strip, three terminal units (fascia, ring, collar, label), two twin sockets, nurse call plate with call, reset, LED and handset socket, data plate. 1-bed drawn; 2-bed shares it until a second set is nested.",
    type_values={"Voltage": 240, "Apparent Load": 1000, "Default Elevation": 1300})

def pendant(fam, desc, types, gases, arms, shelves, head_h, extra_parts, vals, about):
    parts = [T("Ceiling Flange", 'z', (0, 0), [[0, -30], [260, -30], [260, 0], [0, 0]], 'epoxy_white'),
             T("Canopy", 'z', (0, 0), [[0, -380], [140, -380], [200, -60], [220, -30], [0, -30]], 'epoxy_white'),
             C("Gas Inlet O2", 'z', (-120, 60), 11, (0, 120), 'copper', 'f'), C("Gas Inlet VAC", 'z', (-60, 120), 11, (0, 120), 'copper', 'f'),
             C("Gas Inlet MA4", 'z', (60, 120), 11, (0, 120), 'copper', 'f'), C("Power Inlet", 'z', (120, 60), 14, (0, 120), 'grey', 'f'),
             C("Data Inlet", 'z', (120, -60), 14, (0, 120), 'grey', 'f')]
    z = -380
    for a in range(arms):
        L = 900 if a == 0 else 700; x0 = 0 if a == 0 else 900
        parts += [C(f"Joint {a + 1}", 'z', (x0, 0), 95, (z - 110, z), 'medical_grey'),
                  B(f"Arm {a + 1}", (x0, -85, z - 230, x0 + L, 85, z - 110), 'epoxy_white', r=60)]
        z -= 230
    xh = 900 if arms == 1 else 1600
    parts += [C("Head Joint", 'z', (xh, 0), 95, (z - 120, z), 'medical_grey'),
              B("Brake Handle", (xh - 30, -160, z - 100, xh + 30, -95, z - 60), 'black', r=8),
              B("Service Head", (xh - 160, -210, z - 120 - head_h, xh + 160, 210, z - 120), 'epoxy_white', r=40),
              R(C("Corner Rail", 'z', (xh - 170, -215), 10, (z - 100 - head_h, z - 140), 'chrome', 'f'), 2, (340, 0, 0)),
              T("Head Base", 'z', (xh, 0), [[0, z - 150 - head_h], [150, z - 150 - head_h], [190, z - 120 - head_h], [0, z - 120 - head_h]], 'medical_grey'),
              B("Handle", (xh - 120, -260, z - 180 - head_h, xh + 120, -230, z - 160 - head_h), 'chrome', r=8)]
    ztop = z - 200
    for i, g in enumerate(gases):
        parts += tu(g if gases.count(g) == 1 else f"{g} {gases[:i + 1].count(g)}", xh - 100 + (i % 3) * 100, ztop - 60 - (i // 3) * 110, g, y0=-210)
    zs = ztop - 60 - ((len(gases) - 1) // 3) * 110 - 170
    parts += socket("Socket A", xh - 75, zs, y0=-210) + socket("Socket B", xh - 75, zs - 110, y0=-210, switch='red')
    parts += [F("Nurse Call", (xh + 20, -219, zs - 40, xh + 140, -210, zs + 40), 'white', r=5),
              C("Call LED", 'y', (xh + 80, zs + 10), 8, (-222, -219), 'led_red', 'f')]
    for s in range(shelves):
        zz = zs - 260 - s * 260
        parts += [B(f"Shelf {s + 1}", (xh - 330, -460, zz, xh + 330, 0, zz + 25), 'laminate', r=20),
                  B(f"Shelf Rail {s + 1}", (xh - 330, -470, zz - 15, xh + 330, -455, zz + 40), 'chrome', lod='f')]
    parts += [p(xh, ztop) for p in extra_parts]
    conns = [MG('O2', 'Gas Inlet O2', 'top'), MG('VAC', 'Gas Inlet VAC', 'top', 'Out'), MG('MA4', 'Gas Inlet MA4', 'top'),
             E("Power Inlet", 'top'), ELV("Data Inlet", 'Data', 'top')]
    add(fam, desc, "IfcFlowTerminal", types, parts, conns, vals, about, type_values={"Voltage": 240, "Apparent Load": 3000})

pendant('FMC_P_MechEq_MedGas_Pendant_ICU',
        "ICU ceiling pendant, single articulated arm 900 mm on a Unistrut frame, service head with O2, vacuum and medical air terminals, sockets, nurse call, two equipment shelves and rails",
        [{"name": "900_SingleArm"}, {"name": "1600_DoubleArm"}], ['O2', 'O2', 'VAC', 'VAC', 'MA4', 'MA4'], 1, 2, 1250,
        [lambda xh, zt: C("Infusion Pole", 'z', (xh + 200, -150), 12, (zt - 1100, zt + 120), 'chrome'),
         lambda xh, zt: C("Status LED", 'y', (xh + 120, zt + 60), 8, (-213, -210), 'led_green', 'f')],
        {"Arm reach 900 mm, rotation 330 degrees": A("900/330"), "Head 320 x 420 x 1250 mm": A("320x420x1250"), "Ceiling fixing to Unistrut, about 300 kg load": A(300, "HTM 02-01 / manufacturer fixing")},
        "ICU pendant modelled as a generic product: ceiling flange, canopy, gas, power and data inlets above the ceiling (z > 0), arm with joints and brake, service head with corner rails, base and handle, six terminal units, two twin sockets, nurse call, two shelves with rails, infusion pole, status LED. Single arm drawn; double arm shares it.")
pendant('FMC_P_MechEq_MedGas_Pendant_Theatre',
        "Theatre anaesthesia pendant, double articulated arm, service head with O2, N2O, medical air, surgical air, vacuum and AGSS terminals, sockets, three shelves, drawer and monitor arm",
        [{"name": "1600_Anaesthesia"}, {"name": "1600_Surgeon"}], ['O2', 'N2O', 'MA4', 'SA7', 'VAC', 'AGSS'], 2, 3, 1150,
        [lambda xh, zt: B("Drawer Unit", (xh - 200, -440, zt - 1180, xh + 200, -40, zt - 1060), 'epoxy_white', r=10),
         lambda xh, zt: B("Drawer Handle", (xh - 80, -455, zt - 1130, xh + 80, -440, zt - 1115), 'chrome', lod='f'),
         lambda xh, zt: C("Monitor Arm Post", 'z', (xh + 200, 120), 25, (zt - 200, zt + 100), 'chrome'),
         lambda xh, zt: B("Monitor Arm", (xh + 200, 100, zt + 60, xh + 650, 140, zt + 100), 'medical_grey', r=10),
         lambda xh, zt: F("Monitor", (xh + 500, -60, zt - 130, xh + 900, -10, zt + 150), 'black', r=10)],
        {"Two arms 900 + 700 mm": A("900+700"), "Head 320 x 420 x 1150 mm": A("320x420x1150"), "Gases O2, N2O, MA4, SA7, VAC, AGSS": A(6, "HTM 02-01 anaesthetic room / theatre schedule")},
        "Theatre pendant modelled as a generic product: ceiling flange, canopy, inlets above the ceiling, two arms with joints, brake, service head with rails, base and handle, six terminal units in BS 1710 colours, two sockets, nurse call, three shelves, drawer unit, monitor arm and monitor. Anaesthesia drawn; surgeon type shares it.")

# Area valve service unit (AVSU), 3-gas drawn
f = 'FMC_P_MechEq_MedGas_AreaValveBox'
parts = [B("Box", (-225, -110, 0, 225, 0, 320), 'epoxy_white'),
         F("Frame Top", (-235, -122, 290, 235, -110, 330), 'epoxy_white'), F("Frame Bottom", (-235, -122, -10, 235, -110, 30), 'epoxy_white'),
         F("Frame Left", (-235, -122, 30, -205, -110, 290), 'epoxy_white'), F("Frame Right", (205, -122, 30, 235, -110, 290), 'epoxy_white'),
         F("Cover Glazing", (-205, -118, 30, 205, -114, 290), 'polycarbonate', lod='m'),
         F("Lock", (195, -132, 140, 225, -122, 180), 'chrome'),
         F("Warning Label", (-200, -124, 296, 200, -122, 324), 'yellow', lod='f')]
for n, x in (('O2', -130), ('VAC', 0), ('MA4', 130)):
    ring_m, lab = GAS[n]
    parts += [C(f"{n} Pipe", 'z', (x, -55), 11, (-60, 400), 'copper'),
              C(f"{n} Valve", 'z', (x, -55), 22, (130, 190), 'brass'),
              B(f"{n} Lever", (x - 10, -110, 150, x + 10, -55, 170), ring_m, r=4),
              C(f"{n} Emergency Inlet", 'y', (x, 90), 12, (-100, -55), 'brass', 'f'),
              F(f"{n} Label", (x - 50, -112, 240, x + 50, -110, 270), lab if lab != 'white' else 'black', lod='f'),
              T(f"{n} Band", 'z', (x, -55), [[11, 330], [13, 330], [13, 350], [11, 350]], ring_m, 'f')]
add(f, "Area valve service unit (AVSU), surface/recessed steel box 450 x 330 mm with lockable glazed cover, lever ball valves, emergency inlet ports and gas labels per gas (3-gas drawn)",
    "IfcValve", ["2Gas_AVSU", "3Gas_AVSU", "4Gas_AVSU"], parts,
    [MG('O2', 'O2 Pipe', 'top'), MG('VAC', 'VAC Pipe', 'top', 'Out'), MG('MA4', 'MA4 Pipe', 'top')],
    {"Box 450 x 330 x 120 mm": A("450x330x120"), "Mounted at 1500 mm": A(1500, "HTM 02-01 AVSU at an accessible height"), "Valves 22 mm with NIST emergency inlets": A(22)},
    "AVSU modelled as a generic product: box, cover frame, glazing (Medium only, so Fine shows the valves), lock, warning label, per gas a copper pipe with BS 1710 band, lever ball valve (lever in gas colour), emergency inlet and label. 3-gas drawn; 2 and 4-gas share it.",
    type_values={"Default Elevation": 1500})

f = 'FMC_P_MechEq_MedGas_AlarmPanel_Area'
parts = [B("Back Box", (-140, 0, 10, 140, 50, 230), 'painted_steel'),
         F("Fascia", (-150, -10, 0, 150, 0, 240), 'white', r=8),
         F("Title Strip", (-130, -11, 205, 130, -10, 228), 'led_red', lod='f')]
for i, (n, lbl) in enumerate((('O2', 'black'), ('VAC', 'yellow'), ('MA4', 'black'))):
    zz = 160 - i * 45
    parts += [F(f"{n} Label", (-130, -11, zz - 12, -50, -10, zz + 12), lbl, r=2),
              C(f"{n} Normal LED", 'y', (-20, zz), 7, (-14, -10), 'led_green', 'f'),
              C(f"{n} Low LED", 'y', (20, zz), 7, (-14, -10), 'led_red', 'f'),
              C(f"{n} High LED", 'y', (60, zz), 7, (-14, -10), 'led_red', 'f'),
              C(f"{n} Sensor Gland", 'z', (-60 + i * 60, 25), 8, (230, 260), 'brass', 'f')]
parts += [C("Mute Button", 'y', (-80, 30), 13, (-16, -10), 'yellow'), C("Test Button", 'y', (-30, 30), 13, (-16, -10), 'black'),
          R(F("Buzzer Slot", (60, -11, 20, 110, -10, 24), 'black', lod='f'), 4, (0, 0, 9)),
          R(C("Fascia Screw", 'y', (-135, 15), 3, (-11, -10), 'chrome', 'f'), 2, (270, 0, 0))]
add(f, "Medical gas area alarm panel, 3 gases, 300 x 240 mm white fascia with normal / low / high pressure LEDs per gas, mute and test buttons, buzzer",
    "IfcAlarm", ["3Gas_Area"], parts,
    [MG('O2', 'O2 Sensor Gland', 'top'), MG('VAC', 'VAC Sensor Gland', 'top', 'Out'), MG('MA4', 'MA4 Sensor Gland', 'top'), E("Back Box")],
    {"Fascia 300 x 240 mm": A("300x240"), "Mounted at 1500 mm at the nurse base": A(1500, "HTM 02-01 area alarms"), "Power 20 VA, 240 V": A(20)},
    "Area alarm modelled as a generic product: back box, fascia, title strip, per gas a coloured label, normal, low and high LEDs and a sensor gland, mute and test buttons, buzzer slots, screws.",
    type_values={"Voltage": 240, "Apparent Load": 20, "Default Elevation": 1500})

f = 'FMC_P_MechEq_MedGas_Manifold_O2Cylinder'
parts = [B("Control Cabinet", (-260, -180, 1000, 260, 0, 1500), 'epoxy_white', r=8),
         F("Cabinet Door", (-250, -186, 1010, 250, -180, 1490), 'epoxy_white', r=6, lod='f')]
parts += gauge("Bank A Gauge", -150, -186, 1380, 45, stem=False) + gauge("Bank B Gauge", 150, -186, 1380, 45, stem=False) + gauge("Line Gauge", 0, -186, 1250, 40, stem=False)
parts += [C("Duty A LED", 'y', (-150, 1110), 8, (-190, -186), 'led_green', 'f'), C("Duty B LED", 'y', (150, 1110), 8, (-190, -186), 'yellow', 'f'),
          C("Outlet Pipe", 'z', (0, -90), 11, (1500, 1800), 'copper'),
          T("Outlet Band", 'z', (0, -90), [[11, 1700], [13, 1700], [13, 1720], [11, 1720]], 'white', 'f'),
          C("Header A", 'x', (-200, 1650), 12, (-1650, -260), 'brass'), C("Header B", 'x', (-200, 1650), 12, (260, 1650), 'brass'),
          B("Restraint Rail A", (-1700, -60, 1050, -500, -20, 1100), 'painted_steel'),
          B("Restraint Rail B", (500, -60, 1050, 1700, -20, 1100), 'painted_steel')]
for bank, x0 in (('A', -1600), ('B', 600)):
    parts += [R(C(f"Cylinder {bank}", 'z', (x0, -200), 115, (0, 1250), 'gloss_black'), 5, (250, 0, 0)),
              R(T(f"Shoulder {bank}", 'z', (x0, -200), [[0, 1250], [115, 1250], [100, 1330], [45, 1380], [0, 1385]], 'white'), 5, (250, 0, 0)),
              R(C(f"Cylinder Valve {bank}", 'z', (x0, -200), 22, (1385, 1470), 'brass'), 5, (250, 0, 0)),
              R(C(f"Pigtail {bank}", 'z', (x0, -200), 5, (1470, 1650), 'copper', 'f'), 5, (250, 0, 0))]
add(f, "Automatic oxygen cylinder manifold, 2 x 5 J-size cylinders, wall-mounted control cabinet with bank and line pressure gauges, changeover indication, headers with pigtails, cylinder restraint rails",
    "IfcUnitaryEquipment", ["2x5_Auto", "2x10_Auto"], parts,
    [MG('O2', 'Outlet Pipe', 'top', 'Out', 22), E("Control Cabinet", 'back')],
    {"2 x 5 J cylinders (230 dia x 1385 mm)": A("2x5 J", "BS EN ISO 7396-1 / HTM 02-01 manifold"), "Cabinet 520 x 500 x 180 mm": A("520x500x180"), "Power 50 VA, 240 V": A(50)},
    "Manifold modelled as a generic product: control cabinet and door, bank and line gauges, duty LEDs, outlet pipe with white band, two brass headers, restraint rails, per bank five black cylinders with white shoulders, valves and pigtails. 2 x 5 drawn; 2 x 10 shares it.",
    type_values={"Voltage": 240, "Apparent Load": 50})

f = 'FMC_P_MechEq_MedGas_VIE_LOX'
parts = [B("Plinth", (-1300, -1300, 0, 2900, 1300, 150), 'concrete')]
parts += vessel("Vessel", 0, 0, 650, 3600, 720, 'epoxy_white', legs=False)
parts += [R(B("Leg Front", (-560, -560, 150, -480, -480, 900), 'painted_steel'), 2, (1040, 0, 0)),
          R(B("Leg Back", (-560, 480, 150, -480, 560, 900), 'painted_steel'), 2, (1040, 0, 0)),
          B("Valve Manifold", (-300, -820, 1000, 300, -720, 1500), 'stainless'),
          R(C("Safety Valve", 'z', (-200, -770), 15, (1500, 1620), 'brass'), 2, (400, 0, 0)),
          C("Top Vent", 'z', (0, 0), 25, (3600, 3800), 'stainless'),
          C("Liquid Line", 'x', (-770, 1100), 18, (300, 1600), 'stainless'),
          R(B("Vaporiser Fin A", (1450, -160, 300, 1750, 160, 3000), 'aluminium'), 3, (420, 0, 0)),
          R(B("Vaporiser Fin B", (1585, -15, 300, 1615, 15, 3000), 'aluminium'), 3, (420, 0, 0)),
          R(B("Vaporiser Fin C", (1450, -15, 300, 1750, 15, 3000), 'aluminium'), 3, (420, 0, 0)),
          R(B("Vaporiser Fin D", (1585, -160, 300, 1615, 160, 3000), 'aluminium'), 3, (420, 0, 0)),
          B("Vaporiser Header Bottom", (1450, -40, 220, 2590, 40, 300), 'stainless'),
          B("Vaporiser Header Top", (1450, -40, 3000, 2590, 40, 3080), 'stainless'),
          C("Supply Pipe", 'x', (0, 2600), 18, (2590, 2900), 'copper'),
          B("Fill Cabinet", (-1250, -1250, 150, -850, -950, 1050), 'painted_steel', r=6),
          F("Fill Coupling", (-1100, -1262, 650, -1000, -1250, 750), 'brass', lod='f'),
          F("Hazard Label", (-300, -722, 2000, 300, -716, 2300), 'yellow', lod='f')]
parts += gauge("Contents Gauge", -150, -820, 1700, 60, stem=False) + gauge("Pressure Gauge", 150, -820, 1700, 60, stem=False)
add(f, "Liquid oxygen VIE (vacuum insulated evaporator) 1500 l, vertical vessel on legs with valve manifold, contents and pressure gauges, three finned ambient vaporisers, fill cabinet, on a concrete plinth; safety-distance zone as a solid",
    "IfcTank", ["1500L_VIE", "3000L_VIE"], parts,
    [MG('O2', 'Supply Pipe', 'right', 'Out', 28)],
    {"Vessel 1440 dia x 3600 mm (1500 l)": A("1440x3600"), "Safety distance 5 m to buildings, 3 m to drains": A("5 m / 3 m", "BCGA CP 36 / HTM 02-01 VIE siting"), "Plinth 4200 x 2600 mm": A("4200x2600")},
    "VIE modelled as a generic product: plinth, vessel with dished heads and four legs, valve manifold with safety valves, top vent, liquid line, three star-finned vaporisers with headers, supply pipe, fill cabinet with coupling, hazard label, contents and pressure gauges; the BCGA CP 36 separation zone as a Clearance Operation solid. 1500 l drawn; 3000 l shares it.",
    clearances=[{"n": "Safety Distance Zone", "shape": "box", "at": [-4300, -4300, 0, 5900, 4300, 50], "sub": "Clearance Operation"}])

f = 'FMC_P_MechEq_MedGas_OxygenPlant_PSA'
parts = [B("Skid", (-1600, -700, 0, 1600, 700, 100), 'painted_steel'),
         B("Compressor Enclosure", (-1550, -600, 100, -550, 400, 1400), 'blue', r=10),
         R(F("Compressor Louvre", (-1450, -606, 300, -650, -600, 320), 'grey', lod='f'), 8, (0, 0, 50)),
         F("Compressor Panel", (-1000, -606, 1000, -650, -600, 1300), 'black', r=4, lod='f'),
         B("Refrigerant Dryer", (-450, -600, 100, 50, -100, 900), 'white', r=8),
         F("Dryer Louvre", (-400, -606, 200, 0, -600, 500), 'grey', lod='f'),
         R(C("Filter Housing", 'z', (150, -450), 50, (500, 1000), 'aluminium'), 3, (130, 0, 0)),
         C("Air Header", 'x', (-450, 1050), 20, (-550, 500), 'copper')]
parts += vessel("Air Receiver", -150, 300, 100, 1800, 280, 'galvanised', legs=False)
parts += vessel("Adsorber A", 650, 200, 100, 2600, 230, 'blue', legs=False) + vessel("Adsorber B", 1150, 200, 100, 2600, 230, 'blue', legs=False)
parts += vessel("Oxygen Receiver", 1350, -350, 100, 1700, 200, 'white', legs=False, band='white')
parts += [C("Column Manifold", 'x', (200, 2450), 25, (650, 1150), 'stainless'),
          C("Oxygen Outlet", 'z', (1350, -350), 14, (1700, 2000), 'copper'),
          T("Outlet Band", 'z', (1350, -350), [[14, 1900], [16, 1900], [16, 1920], [14, 1920]], 'white', 'f')]
parts += gauge("Column Gauge A", 650, -30, 1500, 45, stem=False) + gauge("Column Gauge B", 1150, -30, 1500, 45, stem=False)
parts += panel("Control Panel", 300, 950, 1100, 1900, -650, 160)
add(f, "PSA oxygen plant 20 m3/h (93 % O2), skid with screw compressor package, refrigerant dryer and filters, air receiver, twin zeolite adsorber columns, oxygen receiver, analyser and HMI control panel",
    "IfcUnitaryEquipment", ["20m3h_PSA", "50m3h_PSA"], parts,
    [MG('O2', 'Oxygen Outlet', 'top', 'Out', 28), E("Control Panel Enclosure", 'top')],
    {"Skid 3200 x 1400 mm, columns 2600 mm": A("3200x1400x2600"), "20 m3/h at 93 +/- 3 % O2": A(20, "type name; WHO/UNICEF PSA specification"), "Power 18 kVA, 415 V": A(18000)},
    "PSA plant modelled as a generic product: skid, compressor enclosure with louvres and panel, dryer, three filter housings, air header, galvanised air receiver, two blue adsorber columns with manifold and gauges, oxygen receiver with white band, outlet, control panel with screen, LEDs and isolator. 20 m3/h drawn; 50 m3/h shares it.",
    type_values={"Voltage": 415, "Number of Poles": 3, "Apparent Load": 18000})

def plant(fam, desc, types, gas, flow, pump_m, vessel_m, extra, vals, about):
    parts = [B("Base Frame", (-1300, -650, 0, 1300, 650, 120), 'painted_steel')]
    for i, x0 in enumerate((-1200, -200)):
        k = 'AB'[i]
        parts += motor_x(f"Pump {k}", x0, x0 + 550, -250, 330, 150, 'blue', fins=3)
        parts += [C(f"Pump {k} Body", 'x', (-250, 330), 170, (x0 + 550, x0 + 850), pump_m),
                  B(f"Pump {k} Base", (x0, -420, 120, x0 + 850, -80, 160), 'painted_steel'),
                  C(f"Pump {k} Exhaust", 'z', (x0 + 700, -250), 25, (500, 1200), 'galvanised'),
                  C(f"Pump {k} Isolator", 'z', (x0 + 700, 150), 30, (400, 470), 'brass')]
    parts += vessel("Receiver", 900, 150, 120, 1900, 350, vessel_m, legs=False, band=GAS[gas][0])
    parts += [C("Plant Header", 'x', (150, 1000), 25, (-1200, 900), 'copper'),
              T("Header Band", 'x', (150, 1000), [[25, -300], [27, -300], [27, -260], [25, -260]], GAS[gas][0], 'f'),
              C("Plant Connection", 'z', (-1200, 150), 25, (1000, 1500), 'copper')]
    parts += [p() for p in extra]
    parts += panel("Control Panel", -1250, -650, 1300, 1900, 300, 180)
    parts.append(B("Panel Stand", (-1000, 400, 120, -900, 480, 1300), 'painted_steel'))
    add(fam, desc, "IfcUnitaryEquipment", types, parts,
        [MG(gas, 'Plant Connection', 'top', flow, 42), E("Control Panel Enclosure", 'top')], vals, about,
        type_values={"Voltage": 415, "Number of Poles": 3, "Apparent Load": 15000})

plant('FMC_P_MechEq_MedGas_VacuumPlant',
      "Medical vacuum plant, duplex: two oil-lubricated rotary vane pumps with motors on a base frame, vacuum receiver, duplex bacteria filters with drain flasks, exhaust pipes, control panel",
      ["Duplex_Vacuum", "Triplex_Vacuum"], 'VAC', 'In', 'yellow', 'galvanised',
      [lambda: C("Bacteria Filter A", 'z', (-300, 450), 70, (900, 1350), 'aluminium'),
       lambda: C("Bacteria Filter B", 'z', (-100, 450), 70, (900, 1350), 'aluminium'),
       lambda: C("Drain Flask A", 'z', (-300, 450), 45, (780, 900), 'polycarbonate', 'f'),
       lambda: C("Drain Flask B", 'z', (-100, 450), 45, (780, 900), 'polycarbonate', 'f')],
      {"Base 2600 x 1300 mm": A("2600x1300"), "Duplex, each pump 100 % duty": A("2 x 100 %", "HTM 02-01 vacuum plant"), "Receiver 500 l": A(500)},
      "Vacuum plant modelled as a generic product: base frame, two pump sets (finned motor, fan cowl, terminal box, feet, yellow pump body, base, exhaust, isolator), galvanised receiver with yellow band, header with band, plant connection, two bacteria filters with drain flasks, control panel on a stand. Duplex drawn; triplex shares it.")
plant('FMC_P_MechEq_MedGas_AirPlant',
      "Medical air compressor plant, duplex: two compressors with motors on a base frame, air receiver, twin-tower desiccant dryers, filters and dew-point monitor, control panel",
      ["Duplex_Air", "Triplex_Air"], 'MA4', 'Out', 'grey', 'epoxy_white',
      [lambda: C("Dryer Tower A", 'z', (-350, 480), 90, (120, 1500), 'aluminium'),
       lambda: C("Dryer Tower B", 'z', (-100, 480), 90, (120, 1500), 'aluminium'),
       lambda: B("Dryer Head", (-460, 400, 1500, 10, 560, 1600), 'grey', r=10),
       lambda: C("Filter Bowl", 'z', (200, 480), 45, (900, 1250), 'aluminium'),
       lambda: B("Dewpoint Monitor", (300, 440, 1150, 450, 520, 1300), 'white', r=6)],
      {"Base 2600 x 1300 mm": A("2600x1300"), "Duplex compressors, twin-tower dryers": A("2 x 100 %", "HTM 02-01 medical air plant"), "Receiver 500 l, 10 bar": A(500)},
      "Air plant modelled as a generic product: base frame, two compressor sets (finned motor, fan cowl, terminal box, feet, grey compressor body, base, intake, isolator), receiver with black band, header, plant connection, twin dryer towers with head, filter bowl, dew-point monitor, control panel on a stand. Duplex drawn; triplex shares it.")

# ------------------------------------------------------------------ write, compile, render
def build(prod):
    fam = prod['family']
    n = len(fp.expand(prod['parts']))
    json.dump(prod, open(os.path.join(HERE, fam + '.product.json'), 'w'), indent=1)
    r = fp.compile_product(prod)
    json.dump(r, open(os.path.join(HERE, fam + '.recipe.json'), 'w'), indent=1)
    fp.render(prod, os.path.join(HERE, fam + '.preview.png'))
    fp.render_type_image(prod, os.path.join(HERE, fam + '.png'), size=600)
    return fam, n, len(r['ops'])

def check(prod):
    import re
    errs = []
    names = [p['n'] for p in fp.expand(prod['parts'])]
    if len(names) != len(set(names)): errs.append('duplicate part names: ' + str(sorted({x for x in names if names.count(x) > 1})))
    if len(names) > 70: errs.append(f'{len(names)} parts > 70')
    for t in prod['types']:
        if not re.match(r'^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$', t['name']): errs.append('type name ' + t['name'])
    for c in prod.get('connectors', []):
        if c['part'] not in names: errs.append('connector part missing ' + c['part'])
    for k in ('family', 'desc', 'ifc', 'types', 'materials', 'parts', 'reference', 'values', 'about'):
        if k not in prod: errs.append('missing ' + k)
    kit = set(open(os.path.join(HERE, 'batches', 'KIT_MATERIALS.txt')).read().split())
    for m in prod['materials'].values():
        if m not in kit: errs.append('material not in kit ' + m)
    return errs

if __name__ == '__main__':
    json.dump(NEEDED, open(os.path.join(HERE, 'batches', 'P_plumbing_medgas.materials_needed.json'), 'w'), indent=1)
    sel = [p for p in P if not sys.argv[1:] or any(s in p['family'] for s in sys.argv[1:])]
    bad = False
    for p in sel:
        e = check(p)
        if e: print('CHECK', p['family'], e); bad = True
    missing = set(RECS) - {p['family'] for p in P}
    if missing: print('NOT MODELLED', sorted(missing))
    if bad: sys.exit(1)
    with Pool(min(8, os.cpu_count() or 2)) as pool:
        for fam, n, ops in pool.imap_unordered(build, sel): print(f"{fam}: {n} parts, {ops} ops")
