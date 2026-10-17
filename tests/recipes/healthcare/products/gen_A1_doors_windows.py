"""Healthcare pack, batch A1: 40 hospital doors and windows modelled as products (photo-to-family pipeline, 17 Oct).
Pattern: make_products.py. Compile + render with ../../tools/fmc_parts.py.
Doors use Metric Door.rft, windows Metric Window.rft; wall centre line at y = 0, room / pull side at -y, x across the
opening, z up from the level (windows drawn from z = Sill Height, the template's Sill plane).
Geometry is drawn at the size of the record's first type; every type carries its own Width / Height.
Run: python3 gen_A1_doors_windows.py [family-substring ...]"""
import json, os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import fmc_parts as fp

RECS = {r['family']: r for r in json.load(open(os.path.join(HERE, 'batches', 'A1_doors_windows.json')))}
A = lambda v, src: {"value": v, "source_status": "assumed", "source": src}

MAT = {
    'frame': 'FMC_Metal_Steel_EpoxyCoated_White', 'panel': 'FMC_Metal_Steel_EpoxyCoated_White',
    'laminate': 'FMC_Plastic_Laminate_HPL', 'lipping': 'FMC_Timber_Musizi', 'timber': 'FMC_Timber_Mvule',
    'stainless': 'FMC_Metal_StainlessSteel_Brushed', 'chrome': 'FMC_Metal_Chrome_Polished',
    'glass': 'FMC_Glass_Clear', 'fire_glass': 'FMC_Glass_Laminated', 'frosted': 'FMC_Glass_Frosted',
    'seal': 'FMC_Rubber_Black', 'intumescent': 'FMC_Rubber_Black',
    'aluminium': 'FMC_Metal_Aluminium_Anodised_Silver', 'powder_coat': 'FMC_Metal_Aluminium_PowderCoated',
    'steel': 'FMC_Metal_SteelLTZ_Painted', 'sign_blue': 'FMC_Plastic_ABS_Blue', 'sign_yellow': 'FMC_Plastic_ABS_Yellow',
    'black': 'FMC_Plastic_ABS_Black', 'white': 'FMC_Plastic_ABS_White', 'grey': 'FMC_Plastic_ABS_Grey',
    'led_red': 'FMC_Plastic_LED_Red', 'led_green': 'FMC_Plastic_LED_Green',
    'lead': 'FMC_Metal_Aluminium_PowderCoated', 'lead_glass': 'FMC_Glass_Laminated',
    'copper': 'FMC_Metal_CopperTape_20x3', 'mesh': 'FMC_Plastic_InsectMesh_Fibreglass', 'bars': 'FMC_Metal_BurglarBar_Steel',
    'precast': 'FMC_Concrete_Precast_Painted', 'quartz': 'FMC_Stone_Quartz_Engineered_White',
    'curtain': 'FMC_Fabric_Vinyl_Upholstery_Blue', 'strip_curtain': 'FMC_Plastic_Polycarbonate_Clear',
}
NEEDED = [
    {"name": "FMC_Metal_Lead_Sheet", "colour": "#6E747A", "why": "lead lining (Code 4-5 sheet, 2 mm Pb) in X-ray and CT doors; stand-in FMC_Metal_Aluminium_PowderCoated"},
    {"name": "FMC_Glass_Lead_Xray", "colour": "#CFCBA6", "why": "lead glass (2 mm Pb equivalent) in X-ray door vision panels and control-room viewing windows; stand-in FMC_Glass_Laminated"},
    {"name": "FMC_Seal_Intumescent_Graphite", "colour": "#34363A", "why": "intumescent and smoke seals in fire-door frames; stand-in FMC_Rubber_Black"},
    {"name": "FMC_Fabric_Curtain_Plain", "colour": "#6E5A78", "why": "viewing-room curtain (mortuary viewing window); stand-in FMC_Fabric_Vinyl_Upholstery_Blue"},
]

# ------------------------------------------------------------------ part helpers
R1 = lambda v: round(v, 1)
def _p(n, shape, mat, lod='mf', rep=None, **kw):
    d = {"n": n, "shape": shape, "mat": mat}
    for k, v in kw.items():
        if k in ('at', 'c', 'z', 'y', 'x'): v = [R1(a) for a in v]
        if k in ('pts', 'profile'): v = [[R1(a), R1(b)] for a, b in v]
        d[k] = v
    if lod != 'mf': d['lod'] = lod
    if rep: d['repeat'] = {"n": rep[0], "d": [R1(a) for a in rep[1]]}
    return d
def box(n, at, mat, lod='mf', r=0, rep=None):
    d = _p(n, 'box', mat, lod, rep, at=at)
    if r: d['r'] = r
    return d
def fbox(n, at, mat, lod='mf', r=0, rep=None):
    d = _p(n, 'fbox', mat, lod, rep, at=at)
    if r: d['r'] = r
    return d
def prism(n, pts, z, mat, lod='mf', rep=None): return _p(n, 'prism', mat, lod, rep, pts=pts, z=z)
def front(n, pts, y, mat, lod='mf', rep=None): return _p(n, 'front', mat, lod, rep, pts=pts, y=y)
def right(n, pts, x, mat, lod='mf', rep=None): return _p(n, 'right', mat, lod, rep, pts=pts, x=x)
def cyly(n, cx, cz, r, y, mat, lod='mf', rep=None, seg=24): return dict(_p(n, 'cyl', mat, lod, rep, c=[cx, cz], y=y, r=r), axis='y', seg=seg)
def cylz(n, cx, cy, r, z, mat, lod='mf', rep=None, seg=16): return dict(_p(n, 'cyl', mat, lod, rep, c=[cx, cy], z=z, r=r), axis='z', seg=seg)
def cylx(n, cy, cz, r, x, mat, lod='mf', rep=None, seg=16): return dict(_p(n, 'cyl', mat, lod, rep, c=[cy, cz], x=x, r=r), axis='x', seg=seg)
def turny(n, cx, cz, profile, mat, lod='mf', seg=40): return dict(_p(n, 'turn', mat, lod, None, c=[cx, cz], profile=profile), axis='y', seg=seg)
def rr(a, b, c, d, r): return fp.rrect(a, b, c, d, r, 3)
def ring(n, x0, x1, z0, z1, w, y, mat, lod='mf', wz=None):
    """Rectangular frame of four members (two entries with repeat): stiles w wide, rails wz high."""
    wz = wz or w
    return [box(f"{n} Stile", [x0, y[0], z0, x0 + w, y[1], z1], mat, lod, rep=(2, [x1 - x0 - w, 0, 0])),
            box(f"{n} Rail", [x0 + w, y[0], z0, x1 - w, y[1], z0 + wz], mat, lod, rep=(2, [0, 0, z1 - z0 - wz]))]

# Holes in leaves and linings: the panel is split into convex rectangles around each opening (bands above and below,
# strips beside). No voids, so the preview shows the glass; the preview fans caps from the centroid, so no concave outlines.
def hrect(a, b, c, d): return (a, b, c, d)
def panel(n, x0, x1, z0, z1, y, mat, holes=(), lod='mf'):
    out, zp = [], z0
    def add(nm, a, b, c, d):
        if b - a > 0.5 and d - c > 0.5: out.append(fbox(nm, [a, y[0], c, b, y[1], d], mat, lod))
    hs = sorted(holes, key=lambda h: h[2])
    for i, (a, b, c, d) in enumerate(hs):
        sfx = f" {i + 1}" if len(hs) > 1 else ""
        add(f"{n} Below{sfx}" if i == 0 else f"{n} Between{sfx}", x0, x1, zp, c)
        add(f"{n} Left Of Opening{sfx}", x0, a, c, d); add(f"{n} Right Of Opening{sfx}", b, x1, c, d); zp = d
    add(f"{n} Above" if hs else n, x0, x1, zp, z1)
    return out

def pull_parts(n, x, z0, z1, yf, side=-1, mat='stainless', proj=70):
    """Vertical D pull: 25 mm bar on two standoffs, on the face at yf, projecting toward side (-1 = -y)."""
    yb = yf + side * (proj - 12)
    return [cylz(f"{n} Bar", x, yb, 12.5, [z0, z1], mat, 'f'),
            cyly(f"{n} Standoff", x, z0 + 40, 10, sorted([yf, yb]), mat, 'f', rep=(2, [0, 0, z1 - z0 - 80]), seg=12)]

# ------------------------------------------------------------------ door builder (hinged)
class Door:
    def __init__(s, W, H, t=44, d2=70, face=40, under=8):
        s.W, s.H, s.t, s.d2, s.face = W, H, t, d2, face
        s.xi = W / 2 - face; s.Hs = H - face; s.Hl = H - face - 3; s.z0 = under; s.p = []
    def add(s, *a):
        for x in a: s.p += x if isinstance(x, list) else [x]
        return s
    def frame(s, mat='frame', stop=True, coved=False, arch=True, arch_mat=None, aw=70, at=12, stop_mat=None):
        W, H, d2, xi, f, t = s.W, s.H, s.d2, s.xi, s.face, s.t
        r = 12 if coved else 3
        s.add(prism("Frame Jamb", rr(-W / 2, -d2, -xi, d2, r), [0, H], mat, rep=(2, [W - f, 0, 0])),
              right("Frame Head", rr(-d2, s.Hs, d2, H, r), [-W / 2, W / 2], mat))
        if stop:
            y1 = min(t / 2 + 38, d2 - 6)
            s.add(box("Stop Jamb", [-xi, t / 2, 0, -xi + 15, y1, s.Hs], stop_mat or mat, rep=(2, [2 * xi - 15, 0, 0]), r=2),
                  box("Stop Head", [-xi + 15, t / 2, s.Hs - 15, xi - 15, y1, s.Hs], stop_mat or mat))
        if arch:
            am = arch_mat or mat; xa = xi + 8; zt = s.Hs + 8 + aw
            s.add(prism("Architrave Jamb Front", rr(-xa - aw, -d2 - at, -xa, -d2, 5), [0, zt], am, rep=(2, [2 * xa + aw, 0, 0])),
                  prism("Architrave Jamb Back", rr(-xa - aw, d2, -xa, d2 + at, 5), [0, zt], am, rep=(2, [2 * xa + aw, 0, 0])),
                  right("Architrave Head", rr(-d2 - at, s.Hs + 8, -d2, zt, 5), [-xa - aw, xa + aw], am, rep=(2, [0, 2 * d2 + at, 0])))
        return s
    def leaf(s, n, x0, x1, holes=(), mat='laminate', lip='lipping', lw=8, layers=None, z1=None):
        t, z0, z1 = s.t, s.z0, z1 or s.Hl
        if lip: s.add(box(f"{n} Lipping", [x0, -t / 2, z0, x0 + lw, t / 2, z1], lip, rep=(2, [x1 - x0 - lw, 0, 0])))
        cx0, cx1 = (x0 + lw, x1 - lw) if lip else (x0, x1)
        if layers:
            for ln, lm, y in layers: s.add(panel(f"{n} {ln}", cx0, cx1, z0, z1, y, lm, holes))
        else: s.add(panel(n, cx0, cx1, z0, z1, [-t / 2, t / 2], mat, holes))
        return s
    def vision(s, n, a, b, c, d, glass='glass', bead='lipping', bw=18, proud=6, gl=4):
        t = s.t; y = [-t / 2 - proud, t / 2 + proud]
        s.add(fbox(f"{n} Glass", [a, -gl, c, b, gl, d], glass),
              prism(f"{n} Bead Side", rr(a, y[0], a + bw, y[1], 3), [c, d], bead, rep=(2, [b - a - bw, 0, 0])),
              box(f"{n} Bead Rail", [a + bw, y[0], c, b - bw, y[1], c + bw], bead, rep=(2, [0, 0, d - c - bw])))
        return hrect(a, b, c, d)
    def porthole(s, n, cx, cz, R, glass='glass', ringm='stainless'):
        """Round vision: square cut-out in the leaf, glass disc, ring with face flanges wide enough to cover the cut-out corners."""
        t = s.t; Rf = R * 1.42 + 6
        s.add(cyly(f"{n} Glass", cx, cz, R - 8, [-4, 4], glass, seg=40),
              turny(f"{n} Ring", cx, cz, [[R - 24, -t / 2 - 6], [Rf, -t / 2 - 3], [Rf, -t / 2], [R, -t / 2], [R, t / 2], [Rf, t / 2], [Rf, t / 2 + 3], [R - 24, t / 2 + 6]], ringm))
        return hrect(cx - R, cx + R, cz - R, cz + R)
    def lever(s, x, z=1000, dirn=-1, mat='stainless', esc=True, n="Lever"):
        t = s.t; xe = x + dirn * 125
        s.add(cyly(f"{n} Rose", x, z, 26, [-t / 2 - 9, -t / 2], mat, 'f', rep=(2, [0, t + 9, 0])),
              cyly(f"{n} Neck", x, z, 9, [-t / 2 - 58, -t / 2 - 9], mat, 'f', rep=(2, [0, t + 67, 0]), seg=12),
              cylx(f"{n} Arm", -t / 2 - 50, z, 10, sorted([x, xe]), mat, 'f', rep=(2, [0, t + 100, 0])),
              cyly(f"{n} Return", xe, z, 10, [-t / 2 - 58, -t / 2 - 18], mat, 'f', rep=(2, [0, t + 76, 0]), seg=12))
        if esc: s.add(cyly(f"{n} Escutcheon", x, z - 72, 19, [-t / 2 - 4, -t / 2], mat, 'f', rep=(2, [0, t + 4, 0])))
        return s
    def forend(s, xe, z=1000, mat='stainless'):
        return s.add(box("Lock Forend", [xe - 0.5, -12, z - 118, xe + 1.5, 12, z + 118], mat, 'f'))
    def hinges(s, xk, n=3, n_="Hinge", r=7, mat='stainless', y=None):
        y = -s.t / 2 if y is None else y; z0 = 250; dz = (s.Hl - 250 - z0 - 100) / (n - 1)
        return s.add(cylz(n_, xk, y, r, [z0, z0 + 100], mat, 'f', rep=(n, [0, 0, dz])))
    def closer(s, xk, sg=1, n="Closer", mat='aluminium', big=False):
        t, Hl = s.t, s.Hl; X = lambda a, b: sorted([xk + sg * a, xk + sg * b]); h = 75 if big else 60
        return s.add(fbox(f"{n} Body", [X(60, 340 if big else 320)[0], -t / 2 - 50, Hl - 40 - h, X(60, 340 if big else 320)[1], -t / 2, Hl - 40], mat, 'f', r=10),
                     box(f"{n} Arm", [X(290, 480)[0], -t / 2 - 46, Hl - 22, X(290, 480)[1], -t / 2 - 34, Hl - 12], mat, 'f'),
                     box(f"{n} Shoe", [X(450, 505)[0], -t / 2 - 52, Hl - 14, X(450, 505)[1], -t / 2 - 28, s.Hs], mat, 'f'))
    def kick(s, x0, x1, h=300, n="Kick Plate", mat='stainless', z0=None):
        t = s.t; z0 = s.z0 + 2 if z0 is None else z0
        return s.add(fbox(n, [x0 + 15, -t / 2 - 1.5, z0, x1 - 15, -t / 2, h], mat, 'f', r=3, rep=(2, [0, t + 1.5, 0])))
    def push(s, x0, x1, z0=1050, z1=1400, n="Push Plate", side=1, mat='stainless'):
        t = s.t; y = [t / 2, t / 2 + 2] if side > 0 else [-t / 2 - 2, -t / 2]
        return s.add(fbox(n, [x0, y[0], z0, x1, y[1], z1], mat, 'f', r=6))
    def pull(s, x, z0=900, z1=1300, n="Pull Handle", side=-1, mat='stainless', proj=70):
        yf = -s.t / 2 if side < 0 else s.t / 2
        return s.add(pull_parts(n, x, z0, z1, yf, side, mat, proj))
    def sign(s, cx, cz, n="Fire Door Sign", mat='sign_blue', r=50, both=True):
        t = s.t
        return s.add(cyly(n, cx, cz, r, [-t / 2 - 1.5, -t / 2], mat, 'f', rep=(2, [0, t + 1.5, 0]) if both else None, seg=32))
    def seals(s, n="Perimeter Seal", mat='seal'):
        xi, t = s.xi, s.t
        return s.add(box(f"{n} Jamb", [-xi, -t / 2 + 6, 0, -xi + 2, -t / 2 + 16, s.Hs], mat, 'f', rep=(2, [2 * xi - 2, 0, 0])),
                     box(f"{n} Head", [-xi, -t / 2 + 6, s.Hs - 2, xi, -t / 2 + 16, s.Hs], mat, 'f'))
    def drop_seal(s, x0, x1, n="Drop Seal"):
        return s.add(box(n, [x0 + 10, -8, 1, x1 - 10, 8, s.z0], 'aluminium', 'f'))

# ------------------------------------------------------------------ product assembly
def wh(t): w, h = t.split('x'); return float(w), float(h)
def make(fam, variant, desc, parts, values, about, ifc='IfcDoor', window=False, sill=None, type_values=None, connectors=None, clearances=None, extra_types=None):
    rec = RECS[fam]
    types = []
    for t in rec['types']:
        w, h = wh(t); types.append({"name": f"{t}_{variant}", "values": {"Width": w, "Height": h}})
    used = []
    for p in parts:
        if p['mat'] not in used: used.append(p['mat'])
    tv = dict(type_values or {})
    if window: tv['Sill Height'] = sill
    prod = {"family": fam, "category": rec['category'], "template": "Metric Window.rft" if window else "Metric Door.rft",
            "desc": desc, "ifc": ifc, "keynote": rec['kn'], "types": types, "type_values": tv,
            "materials": {k: MAT[k] for k in used}, "parts": parts, "reference": dict(rec['ref']), "values": values,
            "about": about + " Geometry drawn at the first type's size; brand, model and supplier open for review."}
    if connectors: prod['connectors'] = connectors
    if clearances: prod['clearances'] = clearances
    if not tv: prod.pop('type_values')
    return prod

PRODUCTS = {}
def reg(f): PRODUCTS[f.__name__] = f; return f
D_SRC = "typical hospital doorset, HTM 58 / BS 8300; confirm with the supplier"
W_SRC = "typical hospital window, HBN / HTM 55; confirm with the supplier"

# ================================================================== DOORS
def single_basic(W, H, t=44, frame_mat='frame', arch_mat=None, vision=True, vp=(300, 800, 1650), glass='glass', bead='lipping', closer=True, kick=True, push=True, lever=True, seals='Perimeter Seal', seal_mat='seal', lip='lipping', leaf_mat='laminate', hinges=3, extra_holes=(), coved=False, arch=True):
    d = Door(W, H, t).frame(frame_mat, coved=coved, arch=arch, arch_mat=arch_mat)
    x0, x1 = -d.xi + 3, d.xi - 3; holes = list(extra_holes)
    if vision:
        w, c, dd = vp; cx = (x0 + x1) / 2; holes.append(d.vision("Vision Panel", cx - w / 2, cx + w / 2, c, dd, glass, bead))
    d.leaf("Leaf", x0, x1, holes, leaf_mat, lip)
    if lever: d.lever(x1 - 68).forend(x1)
    if hinges: d.hinges(-d.xi + 1.5, hinges)
    if closer: d.closer(-d.xi)
    if kick: d.kick(x0, x1)
    if push: d.push(x1 - 115, x1 - 40)
    if seals: d.seals(seals, seal_mat)
    return d, x0, x1

@reg
def HC001():
    d, x0, x1 = single_basic(926, 2100)
    return make("FMC_A_Door_FlushSingle_Hygienic", "Hygienic", "Hygienic flush single doorset: HPL-faced 44 mm leaf with hardwood lipping, beaded vision panel, white pressed-steel frame with architraves, return-to-door lever, closer, kick and push plates, perimeter seals",
                d.p, {"Opening 926 x 2100 mm": A("926x2100", "frame outside size, type 1; " + D_SRC), "Leaf 44 mm HPL faced": A(44, D_SRC),
                      "Vision panel 300 x 850 mm, sill 800": A("300x850", "BS 8300 vision zone 500-1500 mm"), "Kick plate 300 mm stainless": A(300, "HTM 58 door protection")},
                "Hinged hygienic doorset modelled as a product: pressed-steel frame with stops and pencil-round architraves both faces, HPL leaf with lipping, vision panel with beads, lever on roses, escutcheons, three hinges, overhead closer with arm and shoe, kick plates both faces, push plate, perimeter seal.")

@reg
def HC002():
    W, H = 1500, 2100; d = Door(W, H).frame()
    xm = -d.xi + 3 + (2 * d.xi - 6) * 0.66            # master 2/3, slave 1/3
    m0, m1, s0, s1 = -d.xi + 3, xm - 1.5, xm + 1.5, d.xi - 3
    cm = (m0 + m1) / 2; cs = (s0 + s1) / 2
    d.leaf("Master Leaf", m0, m1, [d.vision("Master Vision", cm - 175, cm + 175, 800, 1650)])
    d.leaf("Slave Leaf", s0, s1, [d.vision("Slave Vision", cs - 80, cs + 80, 800, 1650)])
    d.lever(m1 - 68).forend(m1)
    d.hinges(m0 - 1.5, 3, "Master Hinge").hinges(s1 + 1.5, 3, "Slave Hinge")
    d.closer(-d.xi, 1, "Master Closer").closer(d.xi, -1, "Slave Closer")
    d.kick(m0, m1, 300, "Master Kick Plate").kick(s0, s1, 300, "Slave Kick Plate")
    d.add(box("Flush Bolt", [s0 - 1.5, -9, d.Hl - 200, s0, 9, d.Hl - 20], 'stainless', 'f', rep=(2, [0, 0, -(d.Hl - 200 - d.z0 - 20)])))
    d.add(fbox("Bed Impact Plate", [m0 + 15, -d.t / 2 - 1.5, 560, s1 - 15, -d.t / 2, 760], 'stainless', 'f', r=3, rep=(2, [0, d.t + 1.5, 0])))
    d.seals()
    return make("FMC_A_Door_LeafAndHalf_BedPassage", "LeafAndHalf", "Leaf-and-half bed-passage doorset: unequal HPL leaves (2/3 + 1/3), vision panels, lever on the master leaf, flush bolts on the slave leaf, two closers, kick and bed-impact plates",
                d.p, {"Opening 1500 x 2100 mm": A("1500x2100", "frame outside size, type 1; " + D_SRC), "Master leaf about 2/3 of the pair": A("2/3", "HBN 00-04 bed passage practice"),
                      "Clear width with both leaves open about 1340 mm": A(1340, "bed + attendant passage, HBN 00-04 (Gate A checks clear width)"), "Impact plate 560-760 mm": A("560-760", "bed bumper height, HTM 58")},
                "Bed-passage leaf-and-half modelled as a product: frame with stops and architraves, master and slave leaves each with lipping and beaded vision panel, lever and escutcheons, hinges on both jambs, two closers, flush bolts top and bottom on the slave leaf, kick plates and a stainless bed-impact band across both leaves.")

def pair_fire(fam, variant, W, H, t, vp_w, vp_c, vp_d, desc, values, about, buffer=False, hold_open=False, glass='fire_glass', push_pull=True, seal_name="Intumescent Seal", sign=True):
    d = Door(W, H, t).frame(); L0, L1, R0, R1_ = -d.xi + 3, -1.5, 1.5, d.xi - 3
    for side, a, b in (("Left", L0, L1), ("Right", R0, R1_)):
        c = (a + b) / 2; d.leaf(f"{side} Leaf", a, b, [d.vision(f"{side} Vision", c - vp_w / 2, c + vp_w / 2, vp_c, vp_d, glass)])
    d.hinges(L0 - 1.5, 3, "Left Hinge").hinges(R1_ + 1.5, 3, "Right Hinge")
    d.closer(-d.xi, 1, "Left Closer", big=hold_open).closer(d.xi, -1, "Right Closer", big=hold_open)
    d.kick(L0, L1, 300, "Left Kick Plate").kick(R0, R1_, 300, "Right Kick Plate")
    if push_pull:
        d.push(L1 - 115, L1 - 40, n="Left Push Plate").push(R0 + 40, R0 + 115, n="Right Push Plate")
        d.pull(L1 - 80, n="Left Pull Handle").pull(R0 + 80, n="Right Pull Handle")
    sz = vp_d + 110 if vp_d + 170 < d.Hl else vp_c - 110
    if sign: d.sign(L0 + (L1 - L0) / 2, sz, "Left Fire Door Sign").sign(R0 + (R1_ - R0) / 2, sz, "Right Fire Door Sign")
    d.add(box("Door Coordinator", [-d.xi + 120, t / 2 + 2, d.Hs - 28, d.xi - 120, t / 2 + 30, d.Hs], 'aluminium', 'f'))
    d.add(box("Meeting Edge Seal", [-1.5, -t / 2 + 6, d.z0, 1.5, -t / 2 + 16, d.Hl], 'intumescent', 'f'))
    d.seals(seal_name, 'intumescent')
    if buffer: d.add(fbox("Bed Buffer Rail", [L0 + 20, -t / 2 - 18, 800, R1_ - 20, -t / 2, 900], 'stainless', 'f', r=8, rep=(2, [0, t + 18, 0])))
    return d

@reg
def HC003():
    d = pair_fire("FMC_A_Door_Double_BedPassage_FD60", "FD60S-Pair", 1800, 2100, 54, 200, 980, 1650, "", {}, "", buffer=True)
    return make("FMC_A_Door_Double_BedPassage_FD60", "FD60S-Pair", "FD60S double bed-passage doorset: equal 54 mm leaves, fire-glazed vision panels, intumescent and smoke seals, coordinator, two closers, push and pull handles, bed buffer rails, fire signs",
                d.p, {"Opening 1800 x 2100 mm": A("1800x2100", "frame outside size, type 1; " + D_SRC), "Fire resistance FD60S (60 min, smoke)": A("FD60S", "BS 476-22 / EN 1634-1 tested doorset, certifier confirms"),
                      "Leaf 54 mm": A(54, "typical FD60 leaf"), "Bed buffer rail 800-900 mm": A("800-900", "HTM 58 bed protection")},
                "Fire-rated bed-passage pair modelled as a product: frame with stops and architraves, two 54 mm HPL leaves with lipping and fire-glazed beaded vision panels, intumescent seals in the reveal and meeting edge, coordinator under the head, two closers, push plates and D pulls, kick plates, stainless buffer rails both faces, blue fire-door signs.")

@reg
def HC004():
    W, H = 1200, 2100; d = Door(W, H, 44).frame(stop=False)
    L0, L1, R0, R1_ = -d.xi + 4, -2, 2, d.xi - 4
    for side, a, b in (("Left", L0, L1), ("Right", R0, R1_)):
        c = (a + b) / 2
        d.leaf(f"{side} Leaf", a, b, [d.porthole(f"{side} Porthole", c, 1450, 150)])
        d.add(fbox(f"{side} Push Plate", [c - 110, -d.t / 2 - 2, 950, c + 110, -d.t / 2, 1150], 'stainless', 'f', r=8, rep=(2, [0, d.t + 2, 0])))
        d.kick(a, b, 400, f"{side} Kick Plate")
        fx = a + 40 if side == "Left" else b - 40
        d.add(box(f"{side} Floor Spring Cover", [fx - 40, -50, 0, fx + 160 if side == "Left" else fx + 40, 50, 2], 'stainless', 'f') if side == "Left" else
              box(f"{side} Floor Spring Cover", [fx - 160, -50, 0, fx + 40, 50, 2], 'stainless', 'f'))
        d.add(cylz(f"{side} Top Pivot", fx, 0, 9, [d.Hl, d.Hs], 'stainless', 'f'))
    d.add(box("Finger Guard Left", [L0 - 4, -14, d.z0, L0, 14, d.Hl], 'seal', 'f'), box("Finger Guard Right", [R1_, -14, d.z0, R1_ + 4, 14, d.Hl], 'seal', 'f'),
          box("Meeting Brush", [-2, -10, d.z0, 2, 10, d.Hl], 'seal', 'f'))
    return make("FMC_A_Door_DoubleAction_Theatre", "DoubleAction", "Double-action pair for theatre and kitchen routes: HPL leaves swinging both ways on floor springs, stainless porthole vision panels, push plates and tall kick plates both faces, finger guards",
                d.p, {"Opening 1200 x 2100 mm": A("1200x2100", "frame outside size, type 1; " + D_SRC), "Porthole 300 mm diameter at 1450": A(300, "typical double-action door vision"),
                      "Kick plate 400 mm both faces": A(400, "trolley impact, HTM 58"), "Swing 90 degrees both ways": A("2-way", "double-action floor spring")},
                "Double-action pair modelled as a product: frame without stops (leaves swing both ways), two HPL leaves with lipping, round portholes with stainless T-section rings, push plates and kick plates both faces, floor-spring cover plates and top pivots, rubber finger guards and a meeting brush.")

# ------------------------------------------------------------------ sliding doors (surface, on the -y wall face, parking to +x)
def slide_base(W, H, d2=70, ov=60, leaf_t=60, park_mat='aluminium', lining='frame', face_frame='stainless'):
    p = []; yb = -d2 - 15; yf = yb - leaf_t
    p += [box("Opening Lining Jamb", [-W / 2, -d2, 0, -W / 2 + 30, d2, H], lining, rep=(2, [W - 30, 0, 0])),
          box("Opening Lining Head", [-W / 2 + 30, -d2, H - 30, W / 2 - 30, d2, H], lining)]
    p += ring("Face Frame", -W / 2 - 45, W / 2 + 45, 0, H + 45, 45, [-d2 - 10, -d2], face_frame, 'mf')
    p[-1]['at'][2] = H; p[-1]['repeat']['n'] = 1      # face frame: head only (no rail on the floor)
    Ltot = 2 * (W + 2 * ov) + 40
    p.append(right("Track Box", rr(yf - 40, H + ov + 10, -d2, H + ov + 230, 18), [-W / 2 - ov - 20, -W / 2 - ov - 20 + Ltot], park_mat))
    p.append(fbox("Track Box End Cap", [-W / 2 - ov - 26, yf - 42, H + ov + 8, -W / 2 - ov - 20, -d2, H + ov + 232], 'grey', 'f', r=14, rep=(2, [Ltot + 6, 0, 0])))
    p.append(box("Floor Guide", [W / 2 + ov + 20, yb - 20, 0, W / 2 + ov + 80, yb + 5, 40], 'stainless', 'f'))
    return p, yb, yf

def slide_leaf(W, H, yb, yf, ov=60, kind='solid', vision=(400, 1150, 1750), mat='laminate', edge='stainless', layers=None, glass='glass'):
    p = []; x0, x1, z0, z1 = -W / 2 - ov, W / 2 + ov, 10, H + ov
    p += ring("Leaf Edge", x0, x1, z0, z1, 25, [yf, yb], edge)
    holes = []
    if kind == 'glazed':
        a, b, c, dd = x0 + 25, x1 - 25, z0 + 25 + 300, z1 - 25
        p += [box("Leaf Mid Rail", [a, yf, c - 120, b, yb, c], edge), fbox("Leaf Kick Panel", [a, yf + 3, z0 + 25, b, yb - 3, c - 120], mat),
              fbox("Leaf Glass", [a, (yf + yb) / 2 - 5, c, b, (yf + yb) / 2 + 5, dd], glass)]
        return p
    w, c, dd = vision
    if w:
        a, b = -w / 2, w / 2; holes.append(hrect(a, b, c, dd))
        p += [fbox("Vision Glass", [a, (yf + yb) / 2 - 5, c, b, (yf + yb) / 2 + 5, dd], glass),
              prism("Vision Bead Side", rr(a, yf - 5, a + 22, yb + 2, 4), [c, dd], edge, rep=(2, [w - 22, 0, 0])),
              box("Vision Bead Rail", [a + 22, yf - 5, c, b - 22, yb + 2, c + 22], edge, rep=(2, [0, 0, dd - c - 22]))]
    if layers:
        for ln, lm, y in layers: p += panel(f"Leaf {ln}", x0 + 25, x1 - 25, z0 + 25, z1 - 25, y, lm, holes)
    else: p += panel("Leaf", x0 + 25, x1 - 25, z0 + 25, z1 - 25, [yf + 2, yb - 2], mat, holes)
    return p

def bar_pull(x, z0, z1, yf, n="Pull Handle", mat='stainless', proj=65): return pull_parts(n, x, z0, z1, yf, -1, mat, proj)

def e_conn(part, load): return [{"n": "Power", "domain": "electrical", "system": "PowerBalanced", "part": part, "side": "top"}], {"Voltage": 240, "Apparent Load": load}

@reg
def HC005():
    W, H = 1500, 2100; p, yb, yf = slide_base(W, H)
    p += slide_leaf(W, H, yb, yf)
    p += ring("Leaf Gasket", -W / 2 - 50, W / 2 + 50, 20, H + 50, 10, [yb, yb + 5], 'seal', 'f')
    p += bar_pull(-W / 2 - 15, 850, 1450, yf)
    p += [
          fbox("Kick Plate", [-W / 2 - 35, yf - 1.5, 35, W / 2 + 35, yf, 400], 'stainless', 'f', r=3),
          fbox("Foot Sensor", [-W / 2 - 300, -125, 120, -W / 2 - 140, -70, 290], 'stainless', 'f', r=10),
          fbox("Foot Sensor Window", [-W / 2 - 280, -127, 160, -W / 2 - 160, -125, 250], 'black', 'f', r=6),
          cyly("Push Button Plate", -W / 2 - 220, 1050, 42, [-95, -70], 'stainless', 'f'),
          cyly("Push Button", -W / 2 - 220, 1050, 26, [-101, -95], 'led_green', 'f'),
          cyly("Interlock Lamp Red", -40, H + 60 + 120, 14, [yf - 46, yf - 40], 'led_red', 'f'),
          cyly("Interlock Lamp Green", 40, H + 60 + 120, 14, [yf - 46, yf - 40], 'led_green', 'f')]
    c, tv = e_conn("Track Box", 250)
    return make("FMC_A_Door_HermeticSliding_Theatre", "Hermetic", "Hermetic automatic sliding theatre door: 60 mm HPL leaf in a stainless edge frame with perimeter gasket, beaded vision panel, track box with operator, foot sensor, push button and interlock lamps",
                p, {"Opening 1500 x 2100 mm": A("1500x2100", "clear opening, type 1; theatre door practice HTM 58 / HBN 26"), "Leaf overlaps opening 60 mm each side": A(60, "hermetic seal overlap, typical"),
                     "Operator load 250 VA": A(250, "typical sliding operator, engineer confirms"), "Airtight to Class 4 (EN 12207)": A("Class 4", "hermetic door practice, supplier confirms")},
                "Hermetic sliding door modelled as a product: steel opening lining and stainless face frame on the corridor face, leaf in a stainless edge profile with HPL core, perimeter gasket, vision panel with beads, vertical bar pull, kick plate, rounded track box with end caps, floor guide, foot sensor, push button and red/green interlock lamps.",
                type_values=tv, connectors=c)

@reg
def HC006():
    W, H = 2000, 2400; p = []; fw = 60; hh = 260; scr = W / 4
    p += [box("Frame Jamb", [-W / 2, -60, 0, -W / 2 + fw, 60, H], 'powder_coat', rep=(2, [W - fw, 0, 0])),
          right("Operator Header", rr(-110, H - hh, 110, H, 16), [-W / 2 + fw, W / 2 - fw], 'powder_coat'),
          box("Threshold", [-W / 2 + fw, -60, 0, W / 2 - fw, 60, 6], 'aluminium', 'f')]
    sa, sb = -W / 2 + fw, -W / 2 + fw + scr - 20       # fixed side screens, rear plane
    for nm, a, b, y in (("Screen", sa, sb, [8, 40]), ):
        p += [box(f"{nm} Stile", [a, y[0], 6, a + 50, y[1], H - hh], 'powder_coat', rep=(2, [b - a - 50, 0, 0])),
              box(f"{nm} Stile Right", [-b, y[0], 6, -b + 50, y[1], H - hh], 'powder_coat', rep=(2, [b - a - 50, 0, 0])),
              box(f"{nm} Bottom Rail", [a + 50, y[0], 6, b - 50, y[1], 106], 'powder_coat', rep=(2, [-(a + b), 0, 0])),
              fbox(f"{nm} Glass", [a + 50, 20, 106, b - 50, 28, H - hh], 'glass', rep=(2, [-(a + b), 0, 0]))]
    la, lb = -(W / 2 - fw - scr) - 60, 0                 # sliding leaves, front plane, closed meeting at x = 0
    p += [box("Leaf Stile", [la, -40, 10, la + 55, -8, H - hh - 10], 'powder_coat', rep=(2, [lb - la - 55, 0, 0])),
          box("Leaf Stile Right", [-lb, -40, 10, -lb + 55, -8, H - hh - 10], 'powder_coat', rep=(2, [lb - la - 55, 0, 0])),
          box("Leaf Bottom Rail", [la + 55, -40, 10, lb - 55, -8, 110], 'powder_coat', rep=(2, [-(la + lb), 0, 0])),
          box("Leaf Top Rail", [la + 55, -40, H - hh - 60, lb - 55, -8, H - hh - 10], 'powder_coat', rep=(2, [-(la + lb), 0, 0])),
          fbox("Leaf Glass", [la + 55, -28, 110, lb - 55, -20, H - hh - 60], 'glass', rep=(2, [-(la + lb), 0, 0])),
          fbox("Manifestation Band", [-W / 2 + fw, -41, 920, W / 2 - fw, -40, 970], 'frosted', 'f', rep=(2, [0, 0, 550])),
          box("Meeting Seal", [-4, -40, 10, 4, -8, H - hh - 10], 'seal', 'f'),
          fbox("Radar Sensor", [-110, -128, H - hh - 50, 110, -110, H - hh + 10], 'black', 'f', r=12, rep=(2, [0, 238, 0])),
          fbox("Key Switch", [W / 2 - fw - 160, -112, H - 120, W / 2 - fw - 100, -110, H - 60], 'stainless', 'f', r=6),
          fbox("Operator Badge", [-260, -112, H - 150, -140, -110, H - 110], 'grey', 'f')]
    c, tv = e_conn("Operator Header", 300)
    return make("FMC_A_Door_AutomaticSliding_Entrance", "BiParting", "Automatic bi-parting sliding entrance: powder-coated aluminium frame, two sliding glazed leaves, fixed side screens, operator header with radar sensors both sides, safety manifestation",
                p, {"Opening 2000 x 2400 mm": A("2000x2400", "frame outside size, type 1; entrance practice HBN 00-04"), "Clear opening about 1100 mm": A(1100, "bi-parting leaves behind fixed side screens (each W/4)"),
                     "Operator load 300 VA": A(300, "typical sliding operator, engineer confirms"), "Manifestation at 900 and 1450 mm": A("900/1450", "Approved Document K / BS 8300 glazing manifestation")},
                "Automatic entrance modelled as a product: aluminium jambs, rounded operator header, threshold, two fixed side screens (rear plane), two sliding leaves with stiles, rails and glass (front plane) meeting at the centre seal, frosted manifestation bands, radar sensors both faces, key switch.",
                type_values=tv, connectors=c)

@reg
def HC007():
    W, H = 1200, 2100; p, yb, yf = slide_base(W, H, leaf_t=50)
    p += slide_leaf(W, H, yb, yf, kind='glazed', mat='laminate', edge='aluminium')
    p += ring("Leaf Gasket", -W / 2 - 50, W / 2 + 50, 20, H + 50, 10, [yb, yb + 5], 'seal', 'f')
    p += bar_pull(-W / 2 - 18, 850, 1450, yf)
    p += [
          cyly("Wave Sensor Plate", -W / 2 - 200, 1050, 42, [-95, -70], 'stainless', 'f'),
          cyly("Wave Sensor Lens", -W / 2 - 200, 1050, 24, [-101, -95], 'led_green', 'f'),
          fbox("Interlock Status Panel", [-90, yf - 42, H + 60 + 80, 90, yf - 40, H + 60 + 160], 'black', 'f', r=8),
          cyly("Interlock Lamp Red", -40, H + 60 + 120, 14, [yf - 48, yf - 42], 'led_red', 'f'),
          cyly("Interlock Lamp Green", 40, H + 60 + 120, 14, [yf - 48, yf - 42], 'led_green', 'f'),
          fbox("Isolation Sign", [W / 2 - 150, yf - 1.5, 1500, W / 2 + 30, yf, 1680], 'sign_yellow', 'f', r=6)]
    c, tv = e_conn("Track Box", 200)
    return make("FMC_A_Door_AutomaticSliding_Isolation", "Isolation", "Automatic sliding isolation-suite door: glazed leaf over a laminate kick panel in an aluminium edge frame, perimeter gasket, wave sensor, interlock status lamps linked to the anteroom door",
                p, {"Opening 1200 x 2100 mm": A("1200x2100", "clear opening, type 1; HBN 04-01 isolation suite"), "Operator load 200 VA": A(200, "typical operator, engineer confirms"),
                     "Interlock with anteroom door": A("interlocked", "HBN 04-01 Supplement 1 isolation suites")},
                "Isolation sliding door modelled as a product: opening lining, stainless face frame, rounded track box with end caps, aluminium leaf frame with mid rail, glass upper and laminate kick panel, perimeter gasket, bar pull, wave sensor, red/green interlock lamps on a status panel, isolation sign.",
                type_values=tv, connectors=c)

@reg
def HC008():
    W, H, t = 1026, 2100, 54; d = Door(W, H, t).frame(arch_mat='frame')
    x0, x1 = -d.xi + 3, d.xi - 3; cx = (x0 + x1) / 2
    vh = d.vision("Lead Glass Vision", cx - 110, cx + 110, 1250, 1600, 'lead_glass', 'stainless', bw=30, proud=8, gl=8)
    d.leaf("Leaf", x0, x1, [vh], layers=[("Skin Room", 'laminate', [-t / 2, -2]), ("Lead Lining", 'lead', [-2, 2]), ("Skin Corridor", 'laminate', [2, t / 2])])
    d.lever(x1 - 68).forend(x1).hinges(-d.xi + 1.5, 4, r=8).closer(-d.xi, big=True).kick(x0, x1).seals()
    zt = d.Hs + 8 + 70
    d.add(fbox("Warning Light Housing", [-200, d.d2, zt + 40, 200, d.d2 + 80, zt + 190], 'white', r=10),
          fbox("Warning Light Lens", [-180, d.d2 + 80, zt + 55, 180, d.d2 + 83, zt + 175], 'led_red', 'f', r=8),
          fbox("Radiation Sign", [cx - 75, t / 2, 1700, cx + 75, t / 2 + 1.5, 1850], 'sign_yellow', 'f', r=4))
    return make("FMC_A_Door_LeadLined_Xray", "Pb2", "Lead-lined X-ray room doorset: 54 mm leaf with 2 mm Pb core between HPL skins, lead-glass vision panel in a stainless bead, heavy hinges and closer, illuminated X-RAY warning light over the corridor face, radiation sign",
                d.p, {"Opening 1026 x 2100 mm": A("1026x2100", "frame outside size, type 1; " + D_SRC), "Lead lining 2 mm Pb": A(2, "typical diagnostic X-ray, radiation protection adviser confirms"),
                      "Lead glass vision 220 x 350 mm, 2 mm Pb eq.": A("220x350", "typical shielded door vision panel"), "Warning light 400 x 150 mm over the door": A("400x150", "IRR17 warning signal at entrance")},
                "Lead-lined doorset modelled as a product: frame with stops and architraves, leaf as two HPL skins with a lead lining layer (visible on the leaf top and bottom), lipping, lead-glass vision with wide stainless bead, lever and escutcheons, four heavy hinges, heavy closer, kick plates, seals, illuminated warning light on the corridor face (+y) and radiation sign.")

@reg
def HC009():
    W, H = 1500, 2100; p, yb, yf = slide_base(W, H, leaf_t=70)
    p += slide_leaf(W, H, yb, yf, vision=(300, 1300, 1700), glass='lead_glass',
                    layers=[("Skin Room", 'laminate', [yf + 2, yf + 33]), ("Lead Lining", 'lead', [yf + 33, yf + 37]), ("Skin Wall", 'laminate', [yf + 37, yb - 2])])
    p += bar_pull(-W / 2 - 15, 800, 1500, yf)
    p += [
          fbox("Kick Plate", [-W / 2 - 35, yf - 1.5, 35, W / 2 + 35, yf, 400], 'stainless', 'f', r=3),
          fbox("Warning Light Housing", [-200, yf - 42, H + 60 + 245, 200, -70, H + 60 + 390], 'white', r=10),
          fbox("Warning Light Lens", [-180, yf - 45, H + 60 + 260, 180, yf - 42, H + 60 + 375], 'led_red', 'f', r=8),
          fbox("Radiation Sign", [W / 2 - 160, yf - 1.5, 1450, W / 2, yf, 1600], 'sign_yellow', 'f', r=4),
          cyly("Push Button Plate", -W / 2 - 220, 1050, 42, [-95, -70], 'stainless', 'f'),
          cyly("Push Button", -W / 2 - 220, 1050, 26, [-101, -95], 'led_green', 'f')]
    c, tv = e_conn("Track Box", 370)
    return make("FMC_A_Door_LeadLined_Sliding_CT", "Pb2-Sliding", "Shielded automatic sliding door for CT and fluoroscopy: 70 mm leaf with lead core, lead-glass vision, stainless edge frame, heavy-duty track box with operator, X-RAY warning light, push button",
                p, {"Opening 1500 x 2100 mm": A("1500x2100", "clear opening, type 1; HBN 06 imaging"), "Lead lining 2 mm Pb": A(2, "typical CT room, radiation protection adviser confirms"),
                     "Operator load 370 VA": A(370, "heavy leaf operator, engineer confirms"), "Leaf about 70 mm, heavy": A(70, "typical shielded sliding leaf")},
                "Shielded sliding door modelled as a product: opening lining, stainless face frame, track box with end caps, leaf in a stainless edge frame with two HPL skins and a lead lining layer, lead-glass vision with beads, bar pull, kick plate, warning light on the track box, radiation sign, push button, floor guide.",
                type_values=tv, connectors=c)

@reg
def HC010():
    W, H, t = 1200, 2100, 80; d = Door(W, H, t, face=60).frame('stainless', arch=False, stop_mat='stainless')
    x0, x1 = -d.xi + 3, d.xi - 3; cx = (x0 + x1) / 2
    d.add(fbox("RF Face Frame", [-W / 2 - 60, -d.d2 - 10, 0, -W / 2, -d.d2, H + 60], 'stainless', rep=(2, [W + 60, 0, 0])),
          fbox("RF Face Frame Head", [-W / 2, -d.d2 - 10, H, W / 2, -d.d2, H + 60], 'stainless'))
    vh = d.vision("RF Vision", cx - 150, cx + 150, 1200, 1600, 'glass', 'stainless', bw=30, proud=6, gl=6)
    d.leaf("Leaf", x0, x1, [vh], mat='stainless', lip='copper', lw=6)
    d.add(fbox("RF Vision Mesh", [cx - 120, -7, 1230, cx + 120, -6, 1570], 'mesh', 'f'))
    d.add(box("Fingerstock Jamb", [-d.xi, -t / 2 + 4, 0, -d.xi + 3, t / 2 - 4, d.Hs], 'copper', 'f', rep=(2, [2 * d.xi - 3, 0, 0])),
          box("Fingerstock Head", [-d.xi, -t / 2 + 4, d.Hs - 3, d.xi, t / 2 - 4, d.Hs], 'copper', 'f'),
          box("RF Threshold", [-d.xi, -t / 2 - 30, 0, d.xi, t / 2 + 30, d.z0], 'copper', 'f'))
    d.hinges(-d.xi + 1.5, 3, r=12)
    d.add(box("Latch Handle Bar", [x1 - 90, -t / 2 - 60, 900, x1 - 60, -t / 2 - 35, 1300], 'stainless', 'f'),
          box("Latch Handle Stand", [x1 - 90, -t / 2 - 40, 900, x1 - 60, -t / 2, 930], 'stainless', 'f', rep=(2, [0, 0, 370])),
          box("Latch Handle Bar Inside", [x1 - 90, t / 2 + 35, 900, x1 - 60, t / 2 + 60, 1300], 'stainless', 'f'),
          box("Latch Handle Stand Inside", [x1 - 90, t / 2, 900, x1 - 60, t / 2 + 40, 930], 'stainless', 'f', rep=(2, [0, 0, 370])),
          fbox("MR Warning Sign", [cx - 90, -t / 2 - 1.5, 1700, cx + 90, -t / 2, 1880], 'led_red', 'f', r=4))
    return make("FMC_A_Door_RFShielded_MRI", "RFShield", "RF-shielded MRI doorset (placeholder to vendor envelope): 80 mm stainless leaf, copper fingerstock in the frame rebate and threshold, mesh-shielded vision panel, cam latch bar handles, MR warning sign",
                d.p, {"Opening 1200 x 2100 mm": A("1200x2100", "vendor envelope placeholder, type 1; MRI supplier confirms"), "RF attenuation 100 dB (10-130 MHz)": A("100 dB", "typical MRI RF cage, vendor confirms"),
                      "Leaf 80 mm": A(80, "typical RF door"), "Frame face 60 mm": A(60, "RF door frame, vendor confirms")},
                "RF door modelled as a product: stainless frame and face frame, stainless leaf with copper edges, copper fingerstock in the jamb and head rebate, raised copper threshold, vision with copper RF mesh, three heavy hinges, vertical cam-latch bar handles both faces, MR warning sign. Placeholder geometry: replace with the MRI vendor's envelope.")

@reg
def HC011():
    d, x0, x1 = single_basic(926, 2100, frame_mat='timber', arch_mat='timber', glass='fire_glass', seals='Intumescent Seal', seal_mat='intumescent', vp=(250, 800, 1550))
    d.sign((x0 + x1) / 2, 1700)
    return make("FMC_A_Door_FireRated_FD30_Ward", "FD30S", "FD30S ward doorset: hardwood frame and architraves, HPL leaf with lipping, fire-glazed vision panel, intumescent and smoke seals, closer, lever, kick and push plates, FIRE DOOR KEEP SHUT signs",
                d.p, {"Opening 926 x 2100 mm": A("926x2100", "frame outside size, type 1; " + D_SRC), "Fire resistance FD30S (30 min, smoke)": A("FD30S", "BS 476-22 / EN 1634-1 tested doorset, certifier confirms"),
                      "Leaf 44 mm": A(44, "typical FD30 leaf"), "Intumescent 15 x 4 mm in frame reveal": A("15x4", "typical FD30 seal")},
                "FD30S ward doorset modelled as a product: hardwood frame with stops and architraves, HPL leaf with lipping, fire-glazed beaded vision panel, lever on roses, three hinges, closer, kick and push plates, intumescent and smoke seals in the reveal, round blue fire-door signs both faces.")

@reg
def HC012():
    d = pair_fire("FMC_A_Door_FireRated_FD60_Corridor", "", 1800, 2100, 54, 420, 700, 1750, "", {}, "", buffer=False)
    return make("FMC_A_Door_FireRated_FD60_Corridor", "FD60S-Pair", "FD60S cross-corridor compartment pair: equal 54 mm HPL leaves with large fire-glazed vision panels, intumescent and smoke seals, coordinator, closers, push plates, D pulls, kick plates, fire signs",
                d.p, {"Opening 1800 x 2100 mm": A("1800x2100", "frame outside size, type 1; " + D_SRC), "Fire resistance FD60S (60 min, smoke)": A("FD60S", "HTM 05-02 compartment doors, certifier confirms"),
                      "Vision panels 420 x 1050 mm": A("420x1050", "cross-corridor visibility, HBN 00-04"), "Leaf 54 mm": A(54, "typical FD60 leaf")},
                "Cross-corridor FD60 pair modelled as a product: frame with stops and architraves, two 54 mm leaves with lipping and large fire-glazed beaded vision panels, intumescent seals in reveal and meeting edge, coordinator, two closers, push plates and D pulls, kick plates, fire-door signs.")

@reg
def HC013():
    d = pair_fire("FMC_A_Door_Smoke_CrossCorridor_HoldOpen", "", 1800, 2100, 44, 480, 1000, 1850, "", {}, "", hold_open=True, glass='fire_glass', seal_name="Smoke Seal", sign=False)
    for side, x in (("Left", -d.xi + 150), ("Right", d.xi - 150)):
        d.add(cyly(f"{side} Hold Open Sign", x, 1450 - 600, 45, [-d.t / 2 - 1.5, -d.t / 2], 'sign_blue', 'f', rep=(2, [0, d.t + 1.5, 0]), seg=32))
    c, tv = e_conn("Left Closer Body", 20)
    c.append({"n": "Fire Alarm", "domain": "electrical", "system": "FireAlarm", "part": "Right Closer Body", "side": "top"})
    return make("FMC_A_Door_Smoke_CrossCorridor_HoldOpen", "HoldOpen", "Smoke-control cross-corridor pair held open on electromagnetic closers that release on fire alarm: glazed upper leaves, smoke seals, coordinator, push plates and pulls, AUTOMATIC FIRE DOOR signs",
                d.p, {"Opening 1800 x 2100 mm": A("1800x2100", "frame outside size, type 1; " + D_SRC), "Hold-open releases on fire alarm (BS 7273-4)": A("BS 7273-4", "fail-safe release, fire engineer confirms"),
                      "Closer supply 24 V DC via 240 V PSU, 20 VA": A(20, "typical EM closer pair"), "Smoke leakage Sa (BS 476-31.1)": A("Sa", "smoke door practice HTM 05-02")},
                "Hold-open smoke pair modelled as a product: frame with stops and architraves, two HPL leaves with tall glazed vision panels, electromagnetic hold-open closers (larger bodies) with conduit, smoke seals in reveal and meeting edge, coordinator, push plates and D pulls, kick plates, AUTOMATIC FIRE DOOR signs.",
                type_values=tv, connectors=c)

@reg
def HC014():
    d, x0, x1 = single_basic(1026, 2100, vp=(300, 800, 1650), seals='Pressure Seal')
    d.drop_seal(x0, x1)
    d.add(box("Threshold Plate", [-d.xi, -d.t / 2 - 40, 0, d.xi, d.t / 2 + 40, 4], 'stainless', 'f'),
          box("Stop Compression Seal Jamb", [-d.xi + 15, d.t / 2 - 2, 0, -d.xi + 20, d.t / 2, d.Hs - 15], 'seal', 'f', rep=(2, [2 * d.xi - 35, 0, 0])),
          fbox("Room Status Sign", [(x0 + x1) / 2 - 100, -d.t / 2 - 1.5, 1720, (x0 + x1) / 2 + 100, -d.t / 2, 1820], 'sign_yellow', 'f', r=4))
    return make("FMC_A_Door_Isolation_Anteroom", "Anteroom", "Isolation anteroom doorset: HPL leaf with vision panel, self-closer, compression pressure seals on stops and frame, automatic drop seal and threshold plate, lever, kick and push plates, room status sign",
                d.p, {"Opening 1026 x 2100 mm": A("1026x2100", "frame outside size, type 1; HBN 04-01 Supplement 1"), "Pressure seals for 10 Pa cascade": A(10, "HTM 03-01 isolation pressure regime"),
                      "Automatic drop seal": A("drop seal", "pressure-door practice"), "Self-closing": A("closer", "HBN 04-01 Supplement 1")},
                "Anteroom doorset modelled as a product: steel frame with stops and architraves, HPL leaf with lipping and vision panel, lever, hinges, self-closer, perimeter pressure seals in reveal and on stops, drop seal under the leaf, stainless threshold plate, kick and push plates, status sign.")

@reg
def HC015():
    W, H = 926, 2100; d = Door(W, H, 54).frame('frame', coved=True, arch=False)
    x0, x1 = -d.xi + 3, d.xi - 3; cx = (x0 + x1) / 2; t = d.t
    a, b, c, dd = cx - 175, cx + 175, 1000, 1600
    d.leaf("Leaf", x0, x1, [hrect(a, b, c, dd)], mat='panel', lip=None)
    d.add(fbox("Flush Glazing Room", [a, -t / 2, c, b, -t / 2 + 6, dd], 'glass'), fbox("Flush Glazing Corridor", [a, t / 2 - 6, c, b, t / 2, dd], 'glass'))
    d.add(*ring("Glazing Spacer", a, b, c, dd, 10, [-t / 2 + 6, t / 2 - 6], 'grey', 'f'))
    d.add(fbox("Cleanroom Pull", [x1 - 95, -t / 2 - 2, 850, x1 - 45, -t / 2, 1250], 'stainless', 'f', r=25),
          fbox("Cleanroom Pull Grip", [x1 - 85, -t / 2 - 40, 900, x1 - 55, -t / 2 - 2, 1200], 'stainless', 'f', r=15),
          fbox("Push Plate", [x1 - 115, t / 2, 1050, x1 - 40, t / 2 + 2, 1400], 'stainless', 'f', r=10))
    d.hinges(-d.xi + 1.5, 3).closer(-d.xi).seals("Cleanroom Gasket").drop_seal(x0, x1)
    d.add(box("Frame Face Flush Trim", [-W / 2 - 20, -d.d2 - 2, 0, -W / 2, -d.d2, H + 20], 'frame', 'f', rep=(2, [W + 20, 0, 0])))
    return make("FMC_A_Door_Cleanroom_Pharmacy", "Cleanroom", "Cleanroom doorset for pharmacy aseptic suites: flush 54 mm white steel leaf, flush double glazing with rounded corners, coved flush frame without architraves or ledges, cleanroom pull, gasket and drop seal",
                d.p, {"Opening 926 x 2100 mm": A("926x2100", "frame outside size, type 1; EU GMP Annex 1 / HBN 14-01"), "Flush both faces, no ledges": A("flush", "cleanroom practice"),
                      "Glazing 350 x 600 mm, R40 corners": A("350x600", "typical cleanroom door vision"), "Leaf 54 mm steel": A(54, "typical cleanroom leaf")},
                "Cleanroom doorset modelled as a product: coved (rounded) frame jambs and head with stops and flush face trims, no architraves, flush steel leaf with rounded-corner flush glazing both faces and spacer, cleanroom pull and grip, push plate, hinges, closer, gasket in the reveal, drop seal.")

@reg
def HC016():
    W, H = 900, 2000; t = 100; d = Door(W, H, t, face=90, under=12)
    d2 = d.d2; p = d.p
    fy = [-d2 - 20, d2]
    p += [box("Frame Jamb", [-W / 2, fy[0], 0, -W / 2 + 90, fy[1], H], 'panel', r=4, rep=(2, [W - 90, 0, 0])),
          box("Frame Head", [-W / 2 + 90, fy[0], H - 90, W / 2 - 90, fy[1], H], 'panel')]
    lx0, lx1, lz1 = -W / 2 + 40, W / 2 - 40, H - 40                          # leaf overlaps the frame face (rebated cold-room leaf)
    ly = [-d2 - 20 - t, -d2 - 20]
    p += [fbox("Leaf", [lx0, ly[0], 12, lx1, ly[1], lz1], 'panel', r=10),
          fbox("Leaf Edge Trim", [lx0 - 3, ly[1] - 15, 9, lx1 + 3, ly[1], lz1 + 3], 'stainless', 'f', r=12),
          fbox("Kick Plate", [lx0 + 20, ly[0] - 1.5, 20, lx1 - 20, ly[0], 350], 'stainless', 'f', r=3)]
    p += ring("Magnetic Gasket", lx0 + 5, lx1 - 5, 20, lz1 - 5, 18, [ly[1], ly[1] + 4], 'seal', 'f')
    for k, z in enumerate((300, H - 450)):
        p += [box(f"Cam Hinge Strap {k + 1}", [lx0 - 10, ly[0] - 22, z, lx0 + 160, ly[0], z + 70], 'chrome', 'f'),
              cylz(f"Cam Hinge Barrel {k + 1}", lx0 - 30, ly[0] - 10, 22, [z - 20, z + 90], 'chrome', 'f'),
              box(f"Cam Hinge Wall Plate {k + 1}", [lx0 - 60, -d2 - 22, z - 20, lx0 - 20, -d2 - 2, z + 90], 'chrome', 'f')]
    p += [fbox("Latch Body", [lx1 - 150, ly[0] - 35, 950, lx1 - 30, ly[0], 1100], 'chrome', 'f', r=10),
          box("Latch Handle", [lx1 - 330, ly[0] - 60, 1005, lx1 - 110, ly[0] - 35, 1040], 'chrome', 'f'),
          fbox("Latch Strike", [lx1 + 10, -d2 - 60, 950, lx1 + 70, -d2 - 20, 1100], 'chrome', 'f', r=8),
          cyly("Inside Safety Release", 0, 1020, 30, [d2, d2 + 60], 'led_red', 'f'),
          box("Heater Strip", [-W / 2 + 90, fy[0] - 1, 0, -W / 2 + 96, fy[0], H - 90], 'grey', 'f'),
          fbox("Thermometer Display", [W / 2 + 40, -d2 - 30, 1500, W / 2 + 160, -d2, 1580], 'black', 'f', r=6),
          fbox("Thermometer Digits", [W / 2 + 55, -d2 - 31, 1515, W / 2 + 145, -d2 - 30, 1565], 'led_red', 'f'),
          box("Strip Curtain Rail", [-W / 2 + 90, d2, H - 130, W / 2 - 90, d2 + 30, H - 90], 'stainless', 'f')]
    sw = (W - 180) / 6
    p.append(fbox("Strip Curtain", [-W / 2 + 90, d2 + 10, 10, -W / 2 + 90 + sw + 25, d2 + 13, H - 120], 'strip_curtain', 'f', rep=(6, [sw, 0, 0])))
    c, tv = e_conn("Frame Head", 100)
    return make("FMC_A_Door_ColdRoom_Insulated", "Insulated", "Insulated cold-room door: 100 mm white steel insulated leaf overlapping the frame, magnetic gasket, cam-rise strap hinges, heavy latch with strike, inside safety release, frame heater strip, thermometer, PVC strip curtain",
                p, {"Opening 900 x 2000 mm": A("900x2000", "frame outside size, type 1; cold-room door practice"), "Leaf 100 mm PIR insulated": A(100, "typical +2 C cold room"),
                     "Frame heater 100 VA": A(100, "anti-condensation heater, engineer confirms"), "Inside safety release": A("release", "EN 378 / cold-room safety practice")},
                "Cold-room door modelled as a product: insulated frame jambs and head, rebated leaf proud of the wall with a stainless edge trim, magnetic gasket ring, two cam-rise strap hinges with barrels and wall plates, latch body, handle and strike, red inside safety release, heater strip, digital thermometer, PVC strip curtain on the cold side.",
                type_values=tv, connectors=c)

@reg
def HC017():
    W, H = 1500, 2100; d = Door(W, H, 54).frame()
    L0, L1, R0, R1_ = -d.xi + 3, -1.5, 1.5, d.xi - 3
    for side, a, b in (("Left", L0, L1), ("Right", R0, R1_)):
        c = (a + b) / 2; d.leaf(f"{side} Leaf", a, b, [d.vision(f"{side} Vision", c - 90, c + 90, 1200, 1600, 'glass', 'stainless')], mat='stainless', lip='stainless', lw=4)
        d.add(fbox(f"{side} Protection Plate", [a + 15, -d.t / 2 - 1.5, 10, b - 15, -d.t / 2, 1000], 'laminate', 'f', r=3, rep=(2, [0, d.t + 1.5, 0])))
    d.add(cylx("Buffer Rail", -d.t / 2 - 45, 900, 16, [L0 + 40, R1_ - 40], 'stainless', 'f', rep=(2, [0, d.t + 90, 0])),
          cyly("Buffer Rail Through Stand", L0 + 60, 900, 10, [-d.t / 2 - 45, d.t / 2 + 45], 'stainless', 'f', rep=(2, [R1_ - L0 - 120, 0, 0])))
    d.lever(L1 - 68, dirn=-1).hinges(L0 - 1.5, 3, "Left Hinge").hinges(R1_ + 1.5, 3, "Right Hinge")
    d.closer(-d.xi, 1, "Left Closer").closer(d.xi, -1, "Right Closer")
    d.add(box("Flush Bolt", [R0, -9, d.Hl - 200, R0 + 1.5, 9, d.Hl - 20], 'stainless', 'f', rep=(2, [0, 0, -(d.Hl - 200 - d.z0 - 20)])))
    d.seals()
    return make("FMC_A_Door_Mortuary_BodyPassage", "BodyPassage", "Mortuary body-passage pair: stainless-faced 54 mm leaves, laminate protection plates to 1000 mm, trolley buffer rails both faces, small vision panels, lever, flush bolts, closers",
                d.p, {"Opening 1500 x 2100 mm": A("1500x2100", "frame outside size, type 1; HBN 16 mortuary"), "Clear width with both leaves about 1340 mm": A(1340, "trolley and coffin passage, HBN 16"),
                     "Buffer rail at 900 mm": A(900, "trolley height, typical"), "Stainless-faced leaves": A("stainless", "hygiene, HBN 16")},
                "Mortuary pair modelled as a product: steel frame with stops and architraves, two stainless-faced leaves with stainless edges and small beaded vision panels, protection plates both faces, round buffer rails on stands both faces, lever with escutcheons, hinges, two closers, flush bolts, seals.")

@reg
def HC018():
    d, x0, x1 = single_basic(1000, 2100, vision=False, push=False)
    t = d.t; yr = t / 2
    d.add(cylx("Horizontal Pull Rail", yr + 50, 900, 12.5, [x0 + 80, x1 - 160], 'stainless', 'f'),
          cyly("Pull Rail Standoff", x0 + 100, 900, 10, [yr, yr + 50], 'stainless', 'f', rep=(2, [x1 - x0 - 280, 0, 0]), seg=12),
          cyly("Emergency Release Indicator", x1 - 68, 1130, 22, [-t / 2 - 6, -t / 2], 'stainless', 'f'),
          fbox("Indicator Window", [x1 - 80, -t / 2 - 7, 1124, x1 - 56, -t / 2 - 6, 1136], 'led_red', 'f'),
          cyly("Thumbturn Rose", x1 - 68, 1130, 24, [t / 2, t / 2 + 6], 'stainless', 'f'),
          box("Thumbturn Lever", [x1 - 110, t / 2 + 6, 1122, x1 - 26, t / 2 + 22, 1138], 'stainless', 'f'),
          fbox("Accessible WC Sign", [(x0 + x1) / 2 - 75, -t / 2 - 1.5, 1450, (x0 + x1) / 2 + 75, -t / 2, 1600], 'sign_blue', 'f', r=6))
    cl = [{"n": "Latch Side Clearance", "shape": "box", "at": [d.xi + 8, -d.d2 - 1500, 0, d.xi + 308, -d.d2 - 12, 2100], "sub": "Clearance Accessibility"}]
    return make("FMC_A_Door_Toilet_Accessible_OutwardOpening", "Accessible", "Accessible WC doorset opening outward: 1000 mm opening, HPL leaf, horizontal pull rail on the inside face, emergency release indicator lock with thumbturn, lever, light closer, kick plates, latch-side clearance zone",
                d.p, {"Opening 1000 x 2100 mm, clear 850+": A("1000x2100", "BS 8300-2 / Approved Document M accessible WC"), "Pull rail 600 mm at 900 mm": A(900, "Approved Document M, horizontal closing rail"),
                      "Latch-side clearance 300 mm, pull side": A(300, "Approved Document M diagram 2.2"), "Emergency release from outside": A("coin release", "Approved Document M 5.10")},
                "Accessible WC doorset modelled as a product: steel frame with stops and architraves, HPL leaf swinging outward (-y), lever on roses, emergency release indicator and red window outside, large thumbturn inside, horizontal pull rail inside, three hinges, closer, kick plates, perimeter seal, blue sign, 300 mm latch-side clearance solid on the pull side.",
                clearances=cl)

@reg
def HC019():
    d, x0, x1 = single_basic(926, 2100, vision=False, push=False, hinges=0, closer=False)
    t = d.t; xi = d.xi
    for i, pt in enumerate(list(d.p)):
        if pt['n'] in ("Stop Jamb", "Stop Head"): pt['mat'] = 'stainless'; pt['n'] = "Reversible " + pt['n']
    d.add(cylz("Pivot Bottom", x0 + 60, 0, 12, [0, d.z0 + 30], 'stainless', 'f'), cylz("Pivot Top", x0 + 60, 0, 12, [d.Hl - 30, d.Hs], 'stainless', 'f'),
          fbox("Floor Pivot Plate", [x0 + 20, -50, 0, x0 + 100, 50, 2], 'stainless', 'f'),
          cyly("Stop Release Cylinder", 0, d.Hs + 20, 14, [t / 2 + 38, d.d2 + 4], 'chrome', 'f'),
          cyly("Emergency Release Indicator", x1 - 68, 1130, 22, [-t / 2 - 6, -t / 2], 'stainless', 'f'),
          fbox("Indicator Window", [x1 - 80, -t / 2 - 7, 1124, x1 - 56, -t / 2 - 6, 1136], 'led_red', 'f'),
          box("Thumbturn Lever", [x1 - 100, t / 2 + 6, 1122, x1 - 36, t / 2 + 20, 1138], 'stainless', 'f'),
          fbox("WC Sign", [(x0 + x1) / 2 - 60, -t / 2 - 1.5, 1450, (x0 + x1) / 2 + 60, -t / 2, 1570], 'white', 'f', r=6))
    return make("FMC_A_Door_Toilet_AntiBarricade", "AntiBarricade", "Anti-barricade WC doorset: removable stainless reversible stop and double-action emergency pivots so staff can swing the leaf outward, indicator lock with emergency release, lever, kick plates",
                d.p, {"Opening 926 x 2100 mm": A("926x2100", "frame outside size, type 1; " + D_SRC), "Reversible stop released by key cylinder in the head": A("key release", "anti-barricade practice, HBN 03-01"),
                      "Double-action emergency pivots": A("pivot", "anti-barricade practice")},
                "Anti-barricade WC doorset modelled as a product: frame with architraves and a stainless reversible stop (jambs and head), key release cylinder over the head, top and bottom pivots with floor plate (no butt hinges), HPL leaf with lipping, lever, indicator lock with red window, thumbturn inside, kick plates, seals, WC sign.")

@reg
def HC020():
    W, H, t = 926, 2100, 54; d = Door(W, H, t).frame()
    x0, x1 = -d.xi + 3, d.xi - 3; cx = (x0 + x1) / 2
    vh = d.vision("Observation Panel", cx - 110, cx + 110, 1150, 1650, 'fire_glass', 'stainless', bw=24, proud=4, gl=10)
    d.leaf("Leaf", x0, x1, [vh])
    d.add(fbox("Blind Slat", [cx - 86, -2, 1180, cx + 86, 2, 1192], 'white', 'f', rep=(8, [0, 0, 55])),
          cyly("Blind Control Knob", cx + 140, 1600, 18, [-t / 2 - 10, -t / 2], 'stainless', 'f'),
          cylz("Continuous Hinge", -d.xi + 1.5, -t / 2, 8, [d.z0, d.Hl], 'stainless', 'f'),
          box("Door Top Alarm Sensor", [x0 + 20, -t / 2 + 4, d.Hl, x1 - 20, t / 2 - 4, d.Hl + 2.5], 'aluminium', 'f'),
          cyly("Door Top Alarm LED", x1 - 40, d.Hs + 20, 6, [-d.d2 - 14, -d.d2 - 12], 'led_red', 'f'),
          right("Anti Ligature Pull", [(-t / 2, 900), (-t / 2 - 40, 960), (-t / 2 - 40, 1060), (-t / 2, 1120)], [x1 - 110, x1 - 50], 'stainless', 'f'),
          right("Anti Ligature Pull Inside", [(t / 2, 900), (t / 2, 1120), (t / 2 + 40, 1060), (t / 2 + 40, 960)], [x1 - 110, x1 - 50], 'stainless', 'f'),
          fbox("Anti Ligature Lock Escutcheon", [x1 - 95, -t / 2 - 3, 820, x1 - 65, -t / 2, 870], 'stainless', 'f', r=12))
    d.kick(x0, x1).seals()
    return make("FMC_A_Door_Psychiatric_AntiLigature", "AntiLigature", "Anti-ligature mental-health bedroom doorset: 54 mm leaf, full-height continuous hinge, door-top alarm sensor, sloped ligature-resistant pulls, observation panel with integral blind, no closer arm",
                d.p, {"Opening 926 x 2100 mm": A("926x2100", "frame outside size, type 1; HBN 03-01 adult acute mental health"), "Door-top alarm load sensor": A("top alarm", "anti-ligature practice, HBN 03-01"),
                     "Continuous hinge full height": A("continuous", "no ligature point at the hinge"), "Observation panel 220 x 500 mm with integral blind": A("220x500", "typical")},
                "Anti-ligature doorset modelled as a product: frame with stops and architraves, HPL leaf with lipping, observation panel with stainless bead and integral blind (slats in the cavity, knob on the corridor face), continuous hinge, door-top alarm sensor bar with LED, sloped pulls both faces, flush lock escutcheon, kick plates, seals; no closer arm (concealed).")

@reg
def HC021():
    d, x0, x1 = single_basic(926, 2100, vp=(250, 800, 1600))
    t, d2, xi = d.t, d.d2, d.xi
    d.add(fbox("Maglock Body", [x1 - 280, -t / 2 - 45, d.Hs - 50, x1 - 20, -t / 2 - 2, d.Hs], 'aluminium', 'f', r=4),
          fbox("Maglock Armature", [x1 - 270, -t / 2 - 2, d.Hl - 50, x1 - 30, -t / 2, d.Hl - 2], 'chrome', 'f'),
          fbox("Card Reader", [xi + 110, d2 + 12 - 12, 1000, xi + 190, d2 + 30, 1130], 'black', r=10),
          cyly("Card Reader LED", xi + 150, 1110, 5, [d2 + 30, d2 + 32], 'led_green', 'f'),
          fbox("Exit Button Plate", [xi + 110, -d2 - 22, 1000, xi + 190, -d2, 1080], 'stainless', 'f', r=6),
          cyly("Exit Button", xi + 150, 1040, 22, [-d2 - 30, -d2 - 22], 'led_green', 'f'),
          fbox("Door Contact", [x1 - 340, -t / 2 - 18, d.Hs - 30, x1 - 300, -t / 2 - 2, d.Hs], 'white', 'f'))
    c = [{"n": "Access Control", "domain": "electrical", "system": "Security", "part": "Card Reader", "side": "back"}]
    return make("FMC_A_Door_AccessControlled_Staff", "AccessControl", "Access-controlled staff doorset: HPL leaf with vision panel, maglock on the head with armature on the leaf, card reader on the corridor side, green exit button inside, door contact, lever, closer",
                d.p, {"Opening 926 x 2100 mm": A("926x2100", "frame outside size, type 1; " + D_SRC), "Maglock 500 kg holding force": A(500, "typical, security engineer confirms"),
                      "Reader at 1000-1100 mm": A(1050, "BS 8300 control height"), "Fail-safe release on fire alarm": A("fail-safe", "BS 7273-4")},
                "Access-controlled doorset modelled as a product: steel frame with stops and architraves, HPL leaf with lipping and vision panel, lever, hinges, closer, kick and push plates, maglock body under the head with armature plate, card reader with LED on the corridor wall (+y), exit button on the room wall (-y), door contact.",
                connectors=c)

@reg
def HC022():
    W, H, t = 1200, 2100, 45; d = Door(W, H, t, face=50)
    xi, d2 = d.xi, d.d2
    d.frame('steel', arch=False)
    L0, L1, R0, R1_ = -xi + 3, -1.5, 1.5, xi - 3
    for side, a, b in (("Left", L0, L1), ("Right", R0, R1_)):
        la, lb = a + 80, b - 80
        holes = [hrect(la, lb, 200, 700), hrect(la, lb, 1500, 1900)]
        d.leaf(f"{side} Leaf", a, b, holes, mat='steel', lip=None)
        for nm, z0, z1 in (("Low", 200, 700), ("High", 1500, 1900)):
            n = int((z1 - z0) / 65)
            d.add(right(f"{side} Louvre {nm}", [(-t / 2 + 2, z0 + 8), (-t / 2 + 6, z0 + 4), (t / 2 - 2, z0 + 46), (t / 2 - 6, z0 + 50)], [la, lb], 'steel', rep=(n, [0, 0, (z1 - z0 - 10) / n])))
    d.hinges(L0 - 1.5, 3, "Left Hinge", r=9, mat='steel').hinges(R1_ + 1.5, 3, "Right Hinge", r=9, mat='steel')
    d.lever(L1 - 68, dirn=-1, mat='chrome', esc=False)
    d.add(box("Flush Bolt", [R0, -9, d.Hl - 200, R0 + 1.5, 9, d.Hl - 20], 'chrome', 'f', rep=(2, [0, 0, -(d.Hl - 200 - d.z0 - 20)])),
          fbox("Plant Room Sign", [R0 + 120, -t / 2 - 1.5, 1050, R1_ - 120, -t / 2, 1350], 'sign_yellow', 'f', r=4))
    return make("FMC_A_Door_Louvred_Steel_Plant", "Louvred-Pair", "Steel louvred pair for plant, generator and medical-gas rooms: pressed-steel rebated frame, painted steel leaves with low and high louvre panels, heavy hinges, lever lock, flush bolts, warning sign",
                d.p, {"Opening 1200 x 2100 mm": A("1200x2100", "frame outside size, type 1; plant door practice"), "Free area about 40 % at the louvres": A(40, "typical inverted-V louvre, engineer confirms ventilation"),
                     "Louvres low 200-700 and high 1500-1900 mm": A("low+high", "cross-ventilation of plant and med-gas rooms, HTM 02-01")},
                "Plant pair modelled as a product: pressed-steel frame with formed rebate (jambs and head as profiles, no architraves), two painted steel leaves built around low and high louvre openings, angled louvre blades, heavy hinges, lever with escutcheons, flush bolts, yellow plant-room sign.")

@reg
def HC023():
    W, H = 926, 2100; d = Door(W, H).frame()
    x0, x1 = -d.xi + 3, d.xi - 3; cx = (x0 + x1) / 2; t = d.t
    ga, gb = cx - 200, cx + 200              # transfer grille 400 x 180 just above the 600 mm protection plate
    d.leaf("Leaf", x0, x1, [hrect(ga, gb, 650, 830)])
    d.add(fbox("Transfer Grille Frame", [ga - 20, -t / 2 - 6, 630, gb + 20, t / 2 + 6, 650], 'aluminium', 'f', rep=(2, [0, 0, 200])))
    d.add(box("Transfer Grille Stile", [ga - 20, -t / 2 - 6, 650, ga, t / 2 + 6, 830], 'aluminium', 'f', rep=(2, [gb - ga + 20, 0, 0])),
          right("Transfer Grille Blade", [(-t / 2 - 2, 658), (-t / 2 + 2, 654), (t / 2 + 2, 680), (t / 2 - 2, 684)], [ga, gb], 'aluminium', 'f', rep=(6, [0, 0, 28])))
    d.lever(x1 - 68).forend(x1).hinges(-d.xi + 1.5, 3).closer(-d.xi)
    d.kick(x0, x1, 600, "Protection Plate")
    d.add(fbox("Room Sign", [cx - 110, -t / 2 - 1.5, 1450, cx + 110, -t / 2, 1560], 'white', 'f', r=4),
          fbox("Room Sign Band", [cx - 110, -t / 2 - 2, 1530, cx + 110, -t / 2 - 1.5, 1560], 'sign_blue', 'f'),
          fbox("Push Plate", [x1 - 115, t / 2, 1200, x1 - 40, t / 2 + 2, 1500], 'stainless', 'f', r=6))
    d.seals()
    return make("FMC_A_Door_Sluice_Single", "Sluice", "Sluice / dirty utility doorset: HPL leaf without vision, transfer grille, stainless protection plates to 600 mm both faces, lever, closer, push plate, room sign",
                d.p, {"Opening 926 x 2100 mm": A("926x2100", "frame outside size, type 1; HBN 00-09 / HTM 58"), "Protection plate 600 mm both faces": A(600, "trolley and cleaning impact, HTM 58"),
                     "Transfer grille 400 x 180 mm": A("400x180", "make-up air for the extracted sluice, HTM 03-01")},
                "Sluice doorset modelled as a product: frame with stops and architraves, HPL leaf with lipping built around a transfer grille (frame, stiles and angled blades through the leaf), lever, hinges, closer, stainless protection plates to 600 both faces, push plate, room sign with colour band, seals.")

@reg
def HC024():
    W, H = 926, 2100; d = Door(W, H).frame()
    x0, x1 = -d.xi + 3, d.xi - 3; cx = (x0 + x1) / 2 - 40
    a, b, c, dd = cx - 130, cx + 130, 450, 1850
    d.leaf("Leaf", x0, x1, [d.vision("Full Height Vision", a, b, c, dd, 'glass', 'lipping', bw=20, gl=10)])
    d.add(fbox("Integral Blind", [a + 20, -3, dd - 420, b - 20, 3, dd - 20], 'white', 'f'),
          fbox("Blind Slider Track", [b + 12, -d.t / 2 - 3, c + 200, b + 24, -d.t / 2, dd - 200], 'aluminium', 'f', r=5),
          fbox("Blind Slider", [b + 8, -d.t / 2 - 10, dd - 460, b + 28, -d.t / 2 - 3, dd - 420], 'white', 'f', r=6))
    d.lever(x1 - 68).forend(x1).hinges(-d.xi + 1.5, 3).closer(-d.xi).kick(x0, x1, 400).seals()
    return make("FMC_A_Door_Nursery_GlazedVision", "GlazedVision", "Nursery / NICU doorset: HPL leaf with a full-height vision panel and integral blind (slider on the corridor face), lever, closer, kick plates, seals",
                d.p, {"Opening 926 x 2100 mm": A("926x2100", "frame outside size, type 1; HBN 09-03 neonatal"), "Vision 260 x 1400 mm from 450 mm": A("260x1400", "child-height to adult observation"),
                     "Integral blind in the glazed unit": A("integral blind", "infection control, no loose blinds")},
                "Nursery doorset modelled as a product: frame with stops and architraves, HPL leaf with lipping around a tall beaded vision panel, integral blind in the cavity (shown part-lowered), slider track and slider on the corridor face, lever, hinges, closer, kick plates, seals.")

@reg
def HC025():
    W, H = 1400, 2100; p = []; d2 = 100
    p += [fbox("Landing Frame Jamb", [-W / 2 - 100, -d2 - 15, 0, -W / 2, -d2 + 40, H], 'stainless', rep=(2, [W + 100, 0, 0])),
          fbox("Landing Frame Header", [-W / 2 - 100, -d2 - 15, H, W / 2 + 100, -d2 + 40, H + 160], 'stainless'),
          box("Landing Sill", [-W / 2 - 60, -d2 - 20, -0.1, W / 2 + 60, 40, 2], 'aluminium'),
          box("Sill Groove", [-W / 2 - 40, -d2 + 15, 2, W / 2 + 40, -d2 + 25, 2.5], 'black', 'f'),
          box("Door Hanger Header", [-W / 2 - 80, 20, H + 20, W / 2 + W / 2 + 120, 120, H + 220], 'steel')]
    pw = W / 2 + 30
    p += [fbox("Fast Panel", [-W / 2 - 15, -d2 + 50, 5, -W / 2 - 15 + pw, -d2 + 80, H + 15], 'stainless', r=3),
          fbox("Slow Panel", [-W / 2 - 15 + pw - 30, -d2 + 85, 5, W / 2 + 15, -d2 + 115, H + 15], 'stainless', r=3),
          box("Panel Meeting Edge", [-W / 2 - 15 + pw - 4, -d2 + 50, 5, -W / 2 - 15 + pw, -d2 + 80, H + 15], 'seal', 'f'),
          fbox("Call Station Plate", [W / 2 + 180, -d2 - 3, 950, W / 2 + 280, -d2, 1200], 'stainless', 'f', r=6),
          cyly("Call Button Up", W / 2 + 230, 1130, 18, [-d2 - 10, -d2 - 3], 'led_green', 'f'),
          cyly("Call Button Down", W / 2 + 230, 1030, 18, [-d2 - 10, -d2 - 3], 'stainless', 'f'),
          fbox("Hall Lantern", [-200, -d2 - 22, H + 30, 200, -d2 - 15, H + 130], 'black', 'f', r=8),
          fbox("Position Indicator Digits", [-60, -d2 - 23, H + 50, 60, -d2 - 22, H + 110], 'led_red', 'f'),
          fbox("Bed Lift Sign", [-W / 2 - 85, -d2 - 16, 1500, -W / 2 - 15, -d2 - 15, 1650], 'sign_blue', 'f')]
    return make("FMC_A_Door_Lift_LandingDoor_Bed", "BedLift", "Bed-lift landing door: two-panel telescopic stainless doors, stainless landing frame and header, aluminium landing sill, door hanger, hall lantern with position indicator, call station",
                p, {"Opening 1400 x 2100 mm": A("1400x2100", "clear landing opening, type 1; HTM 08-02 bed lifts / EN 81-20"), "Telescopic 2-panel side opening": A("2-panel", "typical bed lift"),
                     "Fire-rated landing door E120": A("E120", "EN 81-58, lift supplier confirms")},
                "Landing door modelled as a product (alternative to the one nested in the lift): stainless frame jambs and header on the landing face, aluminium landing sill with groove, hanger header on the shaft side (+y), fast and slow telescopic panels, meeting edge, call station with up and down buttons, hall lantern with digits, bed-lift sign.",
                )

@reg
def HC026():
    W, H = 1200, 2100; d = Door(W, H, 32).frame(stop=False)
    x0, x1 = -d.xi + 3, d.xi - 3; pw = (x1 - x0 - 9) / 4
    p = d.p
    for i in range(4):
        a = x0 + i * (pw + 3); b = a + pw
        p.append(fbox(f"Bifold Panel {i + 1}", [a, -16, 15, b, 16, d.Hl], 'laminate', r=4))
    p += [box("Top Track", [-d.xi, -20, d.Hs - 35, d.xi, 20, d.Hs], 'aluminium'),
          cylz("Pivot Left", x0 + 25, 0, 10, [0, 15], 'stainless', 'f'), cylz("Pivot Right", x1 - 25, 0, 10, [0, 15], 'stainless', 'f'),
          cylz("Panel Hinge A", x0 + pw + 1.5, -16, 6, [300, 400], 'stainless', 'f', rep=(3, [0, 0, 700])),
          cylz("Panel Hinge B", x1 - pw - 1.5, -16, 6, [300, 400], 'stainless', 'f', rep=(3, [0, 0, 700])),
          box("Centre Gap Seal", [-1.5, -10, 15, 1.5, 10, d.Hl], 'seal', 'f'),
          cyly("Knob Left", x0 + 2 * pw - 40, 1000, 18, [-16 - 35, -16], 'stainless', 'f'),
          cyly("Knob Right", x1 - 2 * pw + 40, 1000, 18, [-16 - 35, -16], 'stainless', 'f'),
          fbox("Kick Strip", [x0 + 5, -17.5, 20, x1 - 5, -16, 220], 'stainless', 'f', r=3),
          fbox("Store Sign", [-90, -18, 1500, 90, -17.5, 1580], 'white', 'f', r=4)]
    return make("FMC_A_Door_Stretcher_Bifold_Store", "Bifold", "Bifold store door for stretcher and wheelchair bays: four HPL panels folding in pairs on a top track, pivots, panel hinges, knobs, kick strip",
                p, {"Opening 1200 x 2100 mm": A("1200x2100", "frame outside size, type 1; HBN 15-01 A&E"), "Four panels, two folding pairs": A("4-panel", "typical bifold store door"),
                     "Folded stack about 70 mm each side": A(70, "2 x 32 mm panels")},
                "Bifold door modelled as a product: frame with architraves and no stops, four HPL panels with panel joints, top track, floor pivots at the jambs, hinges between panel pairs, two knobs, stainless kick strip, store sign.")

@reg
def HC027():
    W, H = 600, 600; p = []; d2 = 70; z0 = 0
    p += panel("Opening Lining", -W / 2 - 25, W / 2 + 25, z0, z0 + H + 25, [-d2, d2], 'frame', [hrect(-W / 2, W / 2, z0 + 25, z0 + H)])
    p += ring("Face Frame", -W / 2 - 25, W / 2 + 25, z0 - 25, z0 + H + 25, 25, [-d2 - 10, -d2], 'frame')
    p += [fbox("Access Panel", [-W / 2 + 2, -d2 - 9, z0 + 2, W / 2 - 2, -d2 + 15, z0 + H - 2], 'panel', r=3),
          cyly("Cam Lock", W / 2 - 50, z0 + 120, 13, [-d2 - 13, -d2 - 9], 'chrome', 'f', rep=(2, [0, 0, H - 240])),
          fbox("Concealed Hinge Line", [-W / 2 + 2, -d2 - 9.5, z0 + 20, -W / 2 + 8, -d2 - 9, z0 + H - 20], 'grey', 'f'),
          fbox("Fire Rating Label", [-W / 2 + 40, -d2 - 9.5, z0 + H - 80, -W / 2 + 160, -d2 - 9, z0 + H - 40], 'white', 'f'),
          box("Intumescent Gasket", [-W / 2, -d2 + 15, z0, W / 2, -d2 + 20, z0 + H], 'intumescent', 'f')]
    return make("FMC_A_Door_AccessPanel_Riser", "RiserPanel", "Riser and duct access panel, fire-rated option: white steel panel in a steel face frame and lining, concealed hinge, two cam locks, intumescent gasket, rating label",
                p, {"Panel 600 x 600 mm": A("600x600", "type 1; riser access practice"), "Fire-rated option to match the riser wall (EI 60)": A("EI 60", "BS 476-22 tested panel, certifier confirms"),
                     "Placed with Sill Height for high-level panels": A("sill offset", "door family, set Sill Height on the instance")},
                "Access panel modelled as a product: steel opening lining through the wall, face frame on the room face, white steel panel, concealed hinge line, two cam locks, intumescent gasket, fire-rating label.")

# ================================================================== WINDOWS
def win_boards(W, S, d2=100, fy=-30, x_over=40):
    """Quartz window board in the room-side reveal and a sloped precast cill outside (+y) with a 50 mm projection."""
    return [box("Window Board", [-W / 2 - x_over, -d2 - 25, S - 25, W / 2 + x_over, fy, S], 'quartz', r=6),
            right("External Cill", [(30, S), (d2 + 50, S - 30), (d2 + 50, S - 60), (30, S - 60)], [-W / 2 - 60, W / 2 + 60], 'precast')]

def int_trims(W, H, S, d2=70, aw=60, at=12, mat='frame'):
    return [prism("Architrave Jamb Front", rr(-W / 2 - aw + 8, -d2 - at, -W / 2 + 8, -d2, 4), [S - 25, S + H + aw - 8], mat, rep=(2, [W + aw - 16, 0, 0])),
            prism("Architrave Jamb Back", rr(-W / 2 - aw + 8, d2, -W / 2 + 8, d2 + at, 4), [S - 25, S + H + aw - 8], mat, rep=(2, [W + aw - 16, 0, 0])),
            right("Architrave Head", rr(-d2 - at, S + H - 8, -d2, S + H + aw - 8, 4), [-W / 2 - aw + 8, W / 2 + aw - 8], mat, rep=(2, [0, 2 * d2 + at, 0]))]

@reg
def HC028():
    W, H, S = 1200, 1200, 900; p = []; y = [-15, 20]; f = 35; zt = S + H - 320
    p += ring("Outer Frame", -W / 2, W / 2, S, S + H, f, y, 'steel')
    p += [box("Mullion", [-f / 2, y[0], S + f, f / 2, y[1], zt], 'steel'), box("Transom", [-W / 2 + f, y[0], zt, W / 2 - f, y[1], zt + f], 'steel')]
    sw = 28; cw = (W / 2 - f - f / 2)
    for side, a in (("Left", -W / 2 + f), ("Right", f / 2)):
        b = a + cw
        p += ring(f"{side} Casement", a, b, S + f, zt, sw, [y[1], y[1] + 25], 'steel')
        p += [fbox(f"{side} Glass", [a + sw, y[1] + 8, S + f + sw, b - sw, y[1] + 14, zt - sw], 'glass'),
              box(f"{side} Glazing Bar", [a + sw, y[1] + 4, (S + zt) / 2 - 8, b - sw, y[1] + 22, (S + zt) / 2 + 8], 'steel', 'f')]
    p += ring("Fanlight Sash", -W / 2 + f, W / 2 - f, zt + f, S + H - f, sw, [y[1], y[1] + 25], 'steel')
    p += [fbox("Fanlight Glass", [-W / 2 + f + sw, y[1] + 8, zt + f + sw, W / 2 - f - sw, y[1] + 14, S + H - f - sw], 'glass')]
    p += ring("Mesh Screen Frame", -W / 2, W / 2, S, S + H, 22, [-40, -15], 'aluminium', 'mf')
    p += [fbox("Mosquito Mesh", [-W / 2 + 22, -30, S + 22, W / 2 - 22, -28, S + H - 22], 'mesh', 'f'),
          box("Mesh Screen Mullion", [-11, -40, S + 22, 11, -15, S + H - 22], 'aluminium', 'mf'),
          cylz("Burglar Bar", -W / 2 + 125, -55, 6, [S, S + H], 'bars', rep=(int((W - 150) / 125), [125, 0, 0])),
          box("Burglar Bar Flat", [-W / 2, -62, S + 300, W / 2, -48, S + 330], 'bars', rep=(2, [0, 0, 500])),
          box("Restrictor Stay", [-W / 2 + f + 40, -14 + 0, S + f + 30, -W / 2 + f + 240, -4, S + f + 38], 'chrome', 'f', rep=(2, [W / 2 + f / 2 - f + 0, 0, 0])),
          box("Cockspur Handle", [-f / 2 - 75, -14, (S + zt) / 2 - 6, -f / 2 - 10, -2, (S + zt) / 2 + 6], 'chrome', 'f'),
          box("Cockspur Handle Right", [f / 2 + 10, -14, (S + zt) / 2 - 6, f / 2 + 75, -2, (S + zt) / 2 + 6], 'chrome', 'f')]
    p += win_boards(W, S, fy=-62)
    return make("FMC_A_Window_Ward_SteelCasement_Mesh", "Casement-Mesh", "Ward steel casement window: steel angle frame, mullion and transom, two outward side-hung casements with glazing bars, top-hung fanlight, inner mosquito-mesh screen, 12 mm burglar bars, 100 mm opening restrictors, quartz board, precast cill",
                p, {"Opening 1200 x 1200 mm, sill 900": A("1200x1200", "type 1; " + W_SRC), "Opening restricted to 100 mm": A(100, "HTM 55 / HBN 00-10 window restrictors"),
                     "Burglar bars 12 mm at 125 mm": A(125, "Uganda practice, security confirms"), "Mosquito mesh, fibreglass 18 x 16": A("18x16", "malaria control practice")},
                "Steel casement modelled as a product: angle frame, mullion and transom, two casement sashes with glass and glazing bars (outside the frame line, +y), fanlight sash with glass, room-side aluminium mesh screen with mesh and mid bar, vertical burglar bars with two flats, restrictor stays and cockspur handles, quartz window board inside, sloped precast cill outside.",
                window=True, sill=S)

@reg
def HC029():
    W, H, S = 1200, 1200, 900; p = []; y = [-45, 45]; f = 40
    p += ring("Outer Frame", -W / 2, W / 2, S, S + H, f, y, 'powder_coat')
    sw = W / 2 - f + 30
    for k, (side, a, ys) in enumerate((("Inner", -W / 2 + f, [-40, -12]), ("Outer", W / 2 - f - sw, [-8, 20]))):
        b = a + sw
        p += ring(f"{side} Sash", a, b, S + f, S + H - f, 40, ys, 'powder_coat')
        p += [fbox(f"{side} Sash Glass", [a + 40, ys[0] + 11, S + f + 40, b - 40, ys[0] + 17, S + H - f - 40], 'glass')]
    p += ring("Mesh Sash", W / 2 - f - sw, W / 2 - f, S + f, S + H - f, 30, [24, 42], 'powder_coat')
    p += [fbox("Fly Screen Mesh", [W / 2 - f - sw + 30, 32, S + f + 30, W / 2 - f - 30, 34, S + H - f - 30], 'mesh', 'f'),
          fbox("Sash Pull Handle", [-W / 2 + f + 8, -46, S + 450, -W / 2 + f + 30, -40, S + 700], 'black', 'f', r=8),
          fbox("Sash Lock", [-W / 2 + f + sw - 32, -48, S + 560, -W / 2 + f + sw - 6, -40, S + 640], 'black', 'f', r=4),
          box("Opening Restrictor", [-W / 2 + f + sw + 100, -42, S + f, -W / 2 + f + sw + 160, -12, S + f + 25], 'black', 'f'),
          box("Restrictor Cable", [-W / 2 + f + sw - 40, -44, S + 300, -W / 2 + f + sw + 60, -40, S + 306], 'chrome', 'f'),
          fbox("Drainage Slot Cover", [-W / 2 + 100, 46, S + 8, -W / 2 + 160, 48, S + 22], 'black', 'f', rep=(2, [W - 260, 0, 0]))]
    p += win_boards(W, S, fy=-45)
    return make("FMC_A_Window_Ward_AluSliding_Restricted", "Sliding", "Ward aluminium sliding window: powder-coated frame, two glazed sashes in two tracks, sliding fly-screen sash, opening restrictor and cable, lock, pull handle, quartz board, precast cill",
                p, {"Opening 1200 x 1200 mm, sill 900": A("1200x1200", "type 1; " + W_SRC), "Opening restricted to 100 mm": A(100, "HTM 55 restrictor"),
                     "Three-track frame 90 mm": A(90, "typical sliding section with fly screen")},
                "Sliding window modelled as a product: aluminium outer frame, inner and outer glazed sashes on two tracks, mesh sash on the outer track, pull handle and lock on the interlock, restrictor block with cable, drainage slot covers, quartz board, precast cill.",
                window=True, sill=S)

def internal_glazed(W, H, S, d2=70, f=45, blind=True, glass='glass', two=True, gl=None):
    p = []
    p += panel("Frame Lining", -W / 2, W / 2, S, S + H, [-d2, d2], 'frame', [hrect(-W / 2 + f, W / 2 - f, S + f, S + H - f)])
    a, b, c, d = -W / 2 + f, W / 2 - f, S + f, S + H - f
    if two:
        p += [fbox("Glass Room", [a, -24, c, b, -18, d], glass), fbox("Glass Corridor", [a, 18, c, b, 24, d], glass)]
    else: p += [fbox("Glass", [a, -(gl or 6), c, b, gl or 6, d], glass)]
    p += [prism("Bead Side", rr(a, -40, a + 18, 40, 3), [c, d], 'frame', rep=(2, [b - a - 18, 0, 0])),
          box("Bead Rail", [a + 18, -40, c, b - 18, 40, c + 18], 'frame', rep=(2, [0, 0, d - c - 18]))]
    if blind:
        p += [box("Blind Headrail", [a + 18, -10, d - 70, b - 18, 10, d - 18], 'aluminium', 'f'),
              fbox("Blind Slat", [a + 20, -1, c + 260, b - 20, 1, c + 272], 'white', 'f', rep=(int((d - 70 - c - 260) / 45), [0, 0, 45])),
              fbox("Blind Control Track", [b + 10, -d2 - 2, c + 60, b + 22, -d2, d - 60], 'aluminium', 'f', r=5),
              fbox("Blind Control Slider", [b + 6, -d2 - 10, d - 180, b + 26, -d2 - 2, d - 140], 'white', 'f', r=6)]
    return p

@reg
def HC030():
    W, H, S = 1200, 900, 900
    p = internal_glazed(W, H, S) + int_trims(W, H, S)
    p += [box("Window Board", [-W / 2 - 40, -95, S - 25, W / 2 + 40, -24, S + 45], 'quartz', r=6),
          box("Window Board Corridor", [-W / 2 - 40, 24, S - 25, W / 2 + 40, 95, S + 45], 'quartz', r=6)]
    return make("FMC_A_Window_Observation_Internal_Nurse", "Observation", "Internal nurse observation window: white steel frame lining, double glazing with integral blind and slider control, beads, architraves and window boards both sides",
                p, {"Opening 1200 x 900 mm, sill 900": A("1200x900", "type 1; HBN 04-01 observation from the nurse base"), "Integral blind in a sealed unit": A("integral blind", "infection control"),
                     "Glazing 6.4 mm laminated each side": A("6.4 lam", "typical internal screen")},
                "Observation window modelled as a product: frame lining through the partition built around the glazing, two panes with integral blind (headrail and slats in the cavity), beads, slider track on the nurse side, architraves and quartz boards both sides.",
                ifc='IfcWindow', window=True, sill=S)

@reg
def HC031():
    W, H, S = 1200, 900, 1000; p = []; d2 = 100; r = 60
    p += panel("Flush Frame", -W / 2, W / 2, S, S + H, [-d2, d2], 'stainless', [hrect(-W / 2 + 50, W / 2 - 50, S + 50, S + H - 50)])
    a, b, c, d = -W / 2 + 50, W / 2 - 50, S + 50, S + H - 50
    p += ring("Cavity Spacer", a, b, c, d, 12, [-d2 + 8, d2 - 8], 'grey', 'f')
    p += [fbox("Glass Theatre Side", [a, -d2, c, b, -d2 + 8, d], 'glass'), fbox("Glass Corridor Side", [a, d2 - 8, c, b, d2, d], 'glass'),

          fbox("Desiccant Breather", [b - 80, -d2 + 9, c + 2, b - 40, -d2 + 20, c + 10], 'grey', 'f')]
    return make("FMC_A_Window_Observation_Theatre_Fixed", "FlushFixed", "Flush-glazed fixed theatre observation window: glass flush with both wall faces, stainless lining with rounded corners, sealed cavity, silicone joints, no ledges",
                p, {"Opening 1200 x 900 mm, sill 1000": A("1200x900", "type 1; HBN 26 operating department"), "Flush both faces, R60 corners": A("flush", "cleanable, no ledges, HTM 03-01 / HBN 26"),
                     "Glazing 6.4 mm laminated each face, 200 mm wall": A("6.4 lam", "typical theatre observation")},
                "Theatre observation modelled as a product: stainless frame lining with a rounded opening (no frame proud of either face), two rounded panes flush with the theatre and corridor faces, cavity spacer, silicone joints, desiccant breather.",
                ifc='IfcWindow', window=True, sill=S)

@reg
def HC032():
    W, H, S = 900, 600, 1000; p = []; d2 = 100; f = 60
    p += panel("Lead Lined Frame", -W / 2, W / 2, S, S + H, [-d2, d2], 'steel', [hrect(-W / 2 + f, W / 2 - f, S + f, S + H - f)])
    for side, y in (("Control", [-d2 - 12, -d2]), ("Room", [d2, d2 + 12])):
        p += panel(f"Face Frame {side}", -W / 2 - 40, W / 2 + 40, S - 40, S + H + 40, y, 'steel', [hrect(-W / 2 + f + 20, W / 2 - f - 20, S + f + 20, S + H - f - 20)])
    p += [fbox("Lead Glass", [-W / 2 + f, -10, S + f, W / 2 - f, 10, S + H - f], 'lead_glass'),
          box("Glass Setting Block", [-W / 2 + f, -12, S + f, W / 2 - f, 12, S + f + 8], 'seal', 'f'),
          box("Lead Lining Return", [-W / 2 - 1, -d2, S - 1, -W / 2, d2, S + H + 1], 'lead', 'f', rep=(2, [W + 1, 0, 0])),
          fbox("Radiation Label", [W / 2 - 20, -d2 - 13.5, S - 30, W / 2 + 30, -d2 - 12, S + 20], 'sign_yellow', 'f', r=4),
          box("Control Shelf", [-W / 2 - 40, -d2 - 250, S - 70, W / 2 + 40, -d2 - 12, S - 40], 'laminate', r=6)]
    return make("FMC_A_Window_Viewing_LeadGlass_Xray", "LeadGlass", "Lead-glass control-room viewing window: lead-lined steel frame, wide steel face frames both sides, 2 mm Pb-equivalent lead glass, lead lining returns, radiation label, shelf on the control side",
                p, {"Opening 900 x 600 mm, sill 1000": A("900x600", "type 1; HBN 06 imaging control room"), "Lead glass 2 mm Pb equivalent, about 18 mm": A(2, "radiation protection adviser confirms"),
                     "Frame overlaps lead lining 50 mm": A(50, "shielding overlap practice")},
                "Lead-glass viewing window modelled as a product: lead-lined steel frame around the opening, rounded steel face frames on the control (-y) and room (+y) faces, thick lead glass on setting blocks, lead lining returns at the jambs, radiation label, laminate shelf under the window on the control side.",
                ifc='IfcWindow', window=True, sill=S)

@reg
def HC033():
    W, H, S = 900, 900, 1000
    p = internal_glazed(W, H, S, f=50, glass='glass')
    for q in p:
        if q['mat'] == 'frame': q['mat'] = 'stainless'
    p.append(right("Sloped Sill", [(-95, S - 20), (-40, S - 20), (-40, S + 50), (-95, S)], [-W / 2, W / 2], 'stainless'))
    p += [fbox("Intercom Panel", [W / 2 + 60, -73, S + 300, W / 2 + 180, -70, S + 520], 'stainless', 'f', r=8),
          cyly("Intercom Grille", W / 2 + 120, S + 450, 35, [-76, -73], 'grey', 'f'),
          cyly("Intercom Button", W / 2 + 120, S + 350, 14, [-79, -73], 'led_green', 'f')]
    return make("FMC_A_Window_Viewing_Isolation", "Viewing", "Fixed viewing panel into an isolation room: stainless lining and beads, sealed double glazing with integral blind and slider, sloped sill with no ledge, intercom panel beside",
                p, {"Opening 900 x 900 mm, sill 1000": A("900x900", "type 1; HBN 04-01 Supplement 1"), "Sealed to hold the isolation pressure": A("sealed", "HTM 03-01"),
                     "Integral blind controlled from the corridor": A("integral blind", "privacy with no dust trap")},
                "Isolation viewing panel modelled as a product: stainless frame lining around the glazing, two panes, beads, integral blind with slider control on the corridor face, sloped stainless sill (no ledge), intercom plate with grille and call button.",
                ifc='IfcWindow', window=True, sill=S)

@reg
def HC034():
    W, H, S = 900, 600, 900; p = []; d2 = 70
    p += panel("Hatch Lining", -W / 2, W / 2, S, S + H, [-d2, d2], 'frame', [hrect(-W / 2 + 40, W / 2 - 40, S + 40, S + H - 40)])
    a, b = -W / 2 + 40, W / 2 - 40
    p += [box("Counter Top", [-W / 2 - 100, -d2 - 320, S + 40 - 30, W / 2 + 100, d2 + 300, S + 40], 'quartz', r=12),
          box("Counter Bracket", [-W / 2 - 40, -d2 - 280, S - 180, -W / 2 - 25, -d2, S + 10], 'stainless', 'f', rep=(2, [W + 65, 0, 0])),
          box("Track Bottom", [a, -14, S + 40, b, 14, S + 60], 'aluminium'), box("Track Top", [a, -14, S + H - 70, b, 14, S + H - 40], 'aluminium'),
          fbox("Sliding Pane Left", [a, -10, S + 60, 15, -4, S + H - 70], 'glass'), fbox("Sliding Pane Right", [-15, 4, S + 60, b, 10, S + H - 70], 'glass'),
          box("Pane Finger Pull", [a + 10, -14, S + 200, a + 20, -10, S + 400], 'stainless', 'f'),
          right("Shutter Box", rr(d2, S + H, d2 + 160, S + H + 170, 10), [-W / 2 - 40, W / 2 + 40], 'aluminium'),
          box("Shutter Guide", [-W / 2 - 40, d2, S + 40, -W / 2, d2 + 70, S + H], 'aluminium', rep=(2, [W + 40, 0, 0])),
          box("Shutter Bottom Slat", [-W / 2 - 5, d2 + 25, S + H - 50, W / 2 + 5, d2 + 45, S + H], 'aluminium', 'f'),
          cyly("Shutter Lock", 0, S + H - 25, 10, [d2 + 45, d2 + 50], 'chrome', 'f'),
          fbox("Dispensing Sign", [-160, -d2 - 2, S + H + 40, 160, -d2, S + H + 140], 'sign_blue', 'f', r=6)]
    return make("FMC_A_Window_Hatch_Pharmacy_Dispensing", "Dispensing", "Pharmacy dispensing hatch: steel lining, quartz counter through the wall on brackets, two sliding glass panes in aluminium tracks, security roller shutter with box, guides and bottom slat on the pharmacy side, sign",
                p, {"Opening 900 x 600 mm, sill 900": A("900x600", "type 1; HBN 14-01 pharmacy"), "Counter 900 mm high, 300 mm each side": A(900, "dispensing counter height, BS 8300"),
                     "Security shutter LPS 1175 SR1": A("SR1", "typical pharmacy hatch, security confirms")},
                "Dispensing hatch modelled as a product: lining around the opening, quartz counter through the wall with stainless brackets, top and bottom tracks, two sliding panes with finger pull, roller shutter box, side guides, bottom slat and lock on the pharmacy side (+y), blue sign over the hatch on the patient side.",
                ifc='IfcWindow', window=True, sill=S)

@reg
def HC035():
    W, H, S = 600, 600, 900; p = []; d2 = 70; dp = 280
    p += [box("Cabinet Shell", [-W / 2, -dp, S, W / 2, dp, S + H], 'stainless', r=6)]
    p += [fbox("Wall Flange", [-W / 2 - 50, -d2 - 2, S - 50, W / 2 + 50, -d2, S + H + 50], 'stainless', 'f', r=6, rep=(2, [0, 2 * d2 + 2, 0])),
          fbox("Door", [-W / 2 + 15, -dp - 18, S + 15, W / 2 - 15, -dp, S + H - 15], 'stainless', r=10, rep=(2, [0, 2 * dp + 18, 0])),
          fbox("Door Window", [-W / 2 + 90, -dp - 20, S + 200, W / 2 - 90, -dp - 18, S + H - 70], 'glass', 'f', r=8, rep=(2, [0, 2 * dp + 38, 0])),
          box("Door Handle", [W / 2 - 60, -dp - 55, S + 180, W / 2 - 35, -dp - 18, S + 420], 'stainless', 'f', r=6, rep=(2, [0, 2 * dp + 73, 0])),
          cylz("Door Hinge", -W / 2 + 15, -dp - 9, 7, [S + 60, S + 140], 'stainless', 'f', rep=(2, [0, 0, H - 200])),
          cylz("Door Hinge Back", -W / 2 + 15, dp + 9, 7, [S + 60, S + 140], 'stainless', 'f', rep=(2, [0, 0, H - 200])),
          cyly("Interlock Lamp Red", -W / 2 + 60, S + H - 40, 10, [-dp - 21, -dp - 18], 'led_red', 'f'),
          cyly("Interlock Lamp Green", -W / 2 + 95, S + H - 40, 10, [-dp - 21, -dp - 18], 'led_green', 'f'),
          cyly("Interlock Lamp Red Back", -W / 2 + 60, S + H - 40, 10, [dp + 18, dp + 21], 'led_red', 'f'),
          cyly("Interlock Lamp Green Back", -W / 2 + 95, S + H - 40, 10, [dp + 18, dp + 21], 'led_green', 'f'),
          fbox("UV Lamp Window", [-W / 2 + 30, -dp + 30, S + H - 25, W / 2 - 30, dp - 30, S + H - 15], 'white', 'f')]
    return make("FMC_A_Window_Hatch_PassThrough_Lab", "PassThrough", "Interlocked pass-through hatch for lab and CSSD: stainless cabinet through the wall, glazed doors both faces with interlock lamps, handles, hinges, wall flanges, UV lamp",
                p, {"Hatch 600 x 600 mm, sill 900": A("600x600", "type 1; HBN 15 pathology / HBN 13 CSSD"), "Depth 560 mm through the wall": A(560, "typical pass box"),
                     "Mechanical / electric interlock, one door open at a time": A("interlock", "cleanroom practice")},
                "Pass-through hatch modelled as a product: stainless shell through the wall, flanges on both faces, rounded doors both faces with vision windows, handles, hinges, red/green interlock lamps both faces, UV lamp strip inside.",
                ifc='IfcWindow', window=True, sill=S)

@reg
def HC036():
    W, H, S = 900, 600, 1000; p = []; d2 = 70; f = 40
    p += panel("Screen Lining", -W / 2, W / 2, S, S + H, [-d2, d2], 'frame', [hrect(-W / 2 + f, W / 2 - f, S + f + 60, S + H - f)])
    a, b, c, d = -W / 2 + f, W / 2 - f, S + f + 60, S + H - f
    p += [fbox("Security Glass", [a, -6, c, b, 6, d], 'fire_glass'),
          prism("Bead Side", rr(a, -22, a + 16, 22, 3), [c, d], 'frame', rep=(2, [b - a - 16, 0, 0])),
          box("Bead Rail", [a + 16, -22, c, b - 16, 22, c + 16], 'frame', rep=(2, [0, 0, d - c - 16])),
          turny("Speech Grille", 0, c + 250, [[0, -12], [70, -12], [70, 12], [0, 12]], 'stainless', seg=40),
          turny("Speech Grille Ring", 0, c + 250, [[70, -14], [80, -14], [80, 14], [70, 14]], 'chrome', 'f', seg=40),
          box("Deal Tray", [-200, -d2 - 200, S + f, 200, d2 + 200, S + f + 15], 'stainless'),
          box("Deal Tray Lip", [-200, -d2 - 200, S + f + 15, 200, -d2 - 185, S + f + 60], 'stainless', rep=(2, [0, 2 * d2 + 385, 0])),
          box("Counter Shelf", [-W / 2 - 60, -d2 - 300, S + f + 30, -200, -d2, S + f + 60], 'laminate', r=6),
          box("Counter Shelf Right", [200, -d2 - 300, S + f + 30, W / 2 + 60, -d2, S + f + 60], 'laminate', r=6),
          box("Staff Shelf", [-W / 2 - 60, d2, S + f + 30, -200, d2 + 300, S + f + 60], 'laminate', r=6),
          box("Staff Shelf Right", [200, d2, S + f + 30, W / 2 + 60, d2 + 300, S + f + 60], 'laminate', r=6),
          fbox("Cashier Sign", [-160, -d2 - 2, S + H + 30, 160, -d2, S + H + 120], 'sign_blue', 'f', r=6)]
    return make("FMC_A_Window_Hatch_Cashier", "Cashier", "Cashier and records window: security glazing in a steel lining with beads, round speech grille, stainless deal tray through the wall, shelves both sides, sign",
                p, {"Opening 900 x 600 mm, sill 1000": A("900x600", "type 1; reception / cashier practice"), "Security glass 11.5 mm laminated": A("11.5 lam", "EN 356 P6B typical, security confirms"),
                     "Deal tray 400 mm wide": A(400, "typical")},
                "Cashier window modelled as a product: lining around the glazing (open slot below for the tray), laminated glass with beads, round stainless speech grille with chrome ring, dished deal tray through the wall, laminate shelves on the public and staff sides, sign.",
                ifc='IfcWindow', window=True, sill=S)

@reg
def HC037():
    W, H, S = 1800, 1200, 900; p = []; y = [-30, 30]; f = 50
    p += ring("Screen Frame", -W / 2, W / 2, S, S + H, f, y, 'powder_coat')
    m = W / 6
    p += [box("Mullion", [-m - f / 2, y[0], S + f, -m + f / 2, y[1], S + H - f], 'powder_coat', rep=(2, [2 * m, 0, 0])),
          fbox("Side Glass", [-W / 2 + f, -5, S + f, -m - f / 2, 5, S + H - f], 'glass', rep=(2, [W / 2 + m - f / 2, 0, 0])),
          fbox("Centre Glass", [-m + f / 2, -5, S + f + 140, m - f / 2, 5, S + H - f], 'glass'),
          box("Centre Glass Bottom Rail", [-m + f / 2, y[0], S + f + 110, m - f / 2, y[1], S + f + 140], 'powder_coat'),
          turny("Speech Grille", 0, S + 620, [[0, -9], [60, -9], [60, 9], [0, 9]], 'stainless', seg=40),
          turny("Speech Grille Ring", 0, S + 620, [[60, -11], [70, -11], [70, 11], [60, 11]], 'chrome', 'f', seg=40),
          box("Counter Top", [-W / 2 - 50, -350, S + 20, W / 2 + 50, 350, S + 50], 'quartz', r=15),
          box("Counter Bracket", [-W / 2 + 200, -330, S - 150, -W / 2 + 215, -30, S + 20], 'stainless', 'f', rep=(3, [(W - 400) / 2, 0, 0])),
          fbox("Manifestation Band", [-W / 2 + f, -6, S + 750, W / 2 - f, -5, S + 800], 'frosted', 'f'),
          box("Transaction Slot Trim", [-m + f / 2, -32, S + f, m - f / 2, 32, S + f + 6], 'stainless', 'f')]
    return make("FMC_A_Window_Screen_Reception_Glazed", "Reception", "Reception glazed screen: powder-coated aluminium frame with two mullions, side lights, centre light raised over a transaction slot, round speech grille, quartz counter both sides on brackets, manifestation band",
                p, {"Screen 1800 x 1200 mm, sill 900": A("1800x1200", "type 1; HBN 00-01 / reception practice"), "Counter 920 mm high, 350 mm each side": A(920, "BS 8300 reception counter"),
                     "Transaction gap 110 mm over the counter": A(110, "typical")},
                "Reception screen modelled as a product: aluminium frame, two mullions, two side lights, centre light with a bottom rail raised over the transaction slot, speech grille with ring, quartz counter through the screen with three brackets, slot trim, frosted manifestation band.",
                ifc='IfcWindow', window=True, sill=S)

@reg
def HC038():
    W, H, S = 600, 450, 1800; p = []; y = [-20, 20]; f = 35
    p += ring("Outer Frame", -W / 2, W / 2, S, S + H, f, y, 'powder_coat')
    p += ring("Hopper Sash", -W / 2 + f, W / 2 - f, S + f, S + H - f, 30, [-28, 0], 'powder_coat')
    p += [fbox("Obscured Glass", [-W / 2 + f + 30, -18, S + f + 30, W / 2 - f - 30, -12, S + H - f - 30], 'frosted'),
          right("Side Cheek", [(-28, S + f), (-28, S + H - f), (-140, S + H - f)], [-W / 2 + f, -W / 2 + f + 4], 'powder_coat', 'f', rep=(2, [W - 2 * f - 4, 0, 0])),
          box("Hopper Catch", [-40, -45, S + H - f - 30, 40, -28, S + H - f - 10], 'chrome', 'f'),
          box("Catch Pull Ring", [-6, -60, S + H - f - 80, 6, -45, S + H - f - 10], 'chrome', 'f'),
          cylx("Bottom Hinge", -28, S + f + 5, 5, [-W / 2 + f + 20, W / 2 - f - 20], 'aluminium', 'f')]
    p += win_boards(W, S, fy=-20, x_over=20)
    return make("FMC_A_Window_Hopper_HighLevel_Vent", "Hopper", "High-level hopper vent for WCs, stores and labs: aluminium frame, bottom-hinged inward-opening sash with obscured glass, side cheeks, top catch with pull ring, board and cill",
                p, {"Opening 600 x 450 mm, sill 1800": A("600x450", "type 1; " + W_SRC), "Opens inward about 30 degrees on side cheeks": A(30, "typical hopper"),
                     "Obscured glass": A("obscured", "WC privacy")},
                "Hopper vent modelled as a product: aluminium frame, inward hopper sash with frosted glass, triangular side cheeks, bottom hinge rod, top catch with pull ring, quartz board inside and precast cill outside.",
                ifc='IfcWindow', window=True, sill=S)

@reg
def HC039():
    W, H, S = 1200, 1200, 900; p = []; y = [-50, 40]; f = 60
    p += [prism("Frame Jamb", rr(-W / 2, y[0], -W / 2 + f, y[1], 10), [S, S + H], 'powder_coat', rep=(2, [W - f, 0, 0])),
          right("Frame Head", [(y[0], S + H - f - 40), (y[0], S + H), (y[1], S + H), (y[1], S + H - f)], [-W / 2 + f, W / 2 - f], 'powder_coat'),
          box("Frame Sill", [-W / 2 + f, y[0], S, W / 2 - f, y[1], S + f], 'powder_coat')]
    vx = W / 2 - f - 260
    p += [box("Mullion", [vx - 30, y[0], S + f, vx, y[1], S + H - f], 'powder_coat'),
          fbox("Laminated Glass", [-W / 2 + f, -6, S + f, vx - 30, 6, S + H - f - 40], 'fire_glass'),
          fbox("Blind Headrail", [-W / 2 + f, -2, S + H - f - 120, vx - 30, 2, S + H - f - 40], 'aluminium', 'f'),
          fbox("Vent Panel", [vx, 0, S + f, W / 2 - f, 30, S + H - f], 'powder_coat'),
          fbox("Perforated Grille", [vx, y[0] - 3, S + f, W / 2 - f, y[0], S + H - f], 'stainless'),
          fbox("Grille Slot", [vx + 25, y[0] - 3.5, S + f + 40, W / 2 - f - 25, y[0] - 3, S + f + 52], 'black', 'f', rep=(int((H - 2 * f - 80) / 40), [0, 0, 40])),
          cyly("Tamper Proof Screw", -W / 2 + 30, S + 100, 4, [y[0] - 2, y[0]], 'stainless', 'f', rep=(4, [0, 0, (H - 200) / 3])),
          cyly("Tamper Proof Screw Right", W / 2 - 30, S + 100, 4, [y[0] - 2, y[0]], 'stainless', 'f', rep=(4, [0, 0, (H - 200) / 3])),
          cyly("Vent Key Socket", (vx + W / 2 - f) / 2, S + H - f - 30, 9, [y[0] - 4, y[0] - 3], 'black', 'f'),
          right("Sloped Board", [(-100, S - 20), (y[0], S - 20), (y[0], S + f)], [-W / 2 - 30, W / 2 + 30], 'quartz'),
          right("Sloped Head Trim", [(-100, S + H + 20), (y[0], S + H - f - 40), (y[0], S + H + 20)], [-W / 2 - 30, W / 2 + 30], 'powder_coat')]
    p += [right("External Cill", [(30, S), (150, S - 30), (150, S - 60), (30, S - 60)], [-W / 2 - 60, W / 2 + 60], 'precast')]
    return make("FMC_A_Window_AntiLigature_Psychiatric", "AntiLigature", "Anti-ligature mental-health window: robust aluminium frame with rounded and sloped internal faces, laminated glass with integral blind, side vent behind a slotted stainless grille (restricted 100 mm, key operated), tamper-proof screws, sloped board and head trim",
                p, {"Opening 1200 x 1200 mm, sill 900": A("1200x1200", "type 1; HBN 03-01 adult acute mental health"), "Vent restricted to 100 mm, key operated": A(100, "HBN 03-01 / HTM 55"),
                     "Glass laminated 11.5 mm": A("11.5 lam", "EN 356 P4A typical, security confirms"), "All internal surfaces sloped, no ligature points": A("sloped", "anti-ligature practice")},
                "Anti-ligature window modelled as a product: rounded frame jambs, sloped head and sill members, mullion, laminated glass with integral blind headrail, vent panel behind a slotted stainless grille, tamper-proof screws, vent key socket, sloped quartz board and sloped head trim inside, precast cill outside.",
                ifc='IfcWindow', window=True, sill=S)

@reg
def HC040():
    W, H, S = 1200, 900, 900
    p = internal_glazed(W, H, S, blind=False, glass='fire_glass', two=False, gl=6) + int_trims(W, H, S)
    p += [box("Window Board", [-W / 2 - 40, -95, S - 25, W / 2 + 40, -22, S + 45], 'quartz', r=6),
          box("Curtain Track", [-W / 2 - 150, -140, S + H + 80, W / 2 + 150, -110, S + H + 100], 'aluminium'),
          box("Curtain Track Bracket", [-W / 2 - 100, -110, S + H + 80, -W / 2 - 80, -82, S + H + 100], 'aluminium', 'f', rep=(3, [(W + 160) / 2, 0, 0]))]
    zig = []; x = -W / 2 - 140; k = 0
    while x < -W / 2 + 160: zig.append((x, -135 if k % 2 == 0 else -115)); x += 30; k += 1
    zig = zig + [(px + 0, py + 6) for px, py in zig[::-1]]
    p.append(prism("Curtain Stack", zig, [S - 120, S + H + 78], 'curtain'))
    p.append(fbox("Curtain Pull Rod", [-W / 2 + 150, -142, S + 200, -W / 2 + 162, -130, S + H + 78], 'aluminium', 'f', r=5))
    return make("FMC_A_Window_Viewing_Mortuary", "Viewing", "Mortuary viewing-room window: laminated fixed glazing in a white steel lining with beads, architraves both sides, quartz board, curtain track with pleated curtain drawn back on the viewing side",
                p, {"Opening 1200 x 900 mm, sill 900": A("1200x900", "type 1; HBN 16 viewing room"), "Curtain track 1500 mm on the viewing side": A(1500, "dignified viewing, HBN 16"),
                     "Glass 6.4 mm laminated": A("6.4 lam", "typical")},
                "Mortuary viewing window modelled as a product: steel frame lining around the glazing, laminated glass, beads, architraves both sides, quartz board on the viewing side, aluminium curtain track on brackets, pleated curtain stacked back at one side with a pull rod.",
                ifc='IfcWindow', window=True, sill=S)

# ------------------------------------------------------------------ run
TYPE_RX = __import__('re').compile(r'^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$')
def check(prod):
    parts = fp.expand(prod['parts']); names = [p['n'] for p in parts]
    assert len(parts) <= 70, (prod['family'], len(parts))
    assert len(set(names)) == len(names), (prod['family'], [n for n in names if names.count(n) > 1])
    for t in prod['types']: assert TYPE_RX.match(t['name']), t['name']
    for k, v in prod['materials'].items(): assert v in KIT, v
    assert 2 <= len(prod['values']) <= 5, prod['family']
    for p in parts: assert p['mat'] in prod['materials'], (prod['family'], p['n'])
    for c in prod.get('connectors', []): assert c['part'] in names, (prod['family'], c['part'])
    assert prod['keynote'] and prod['desc'] and prod['about']
    return len(parts)

KIT = set(open(os.path.join(HERE, 'batches', 'KIT_MATERIALS.txt')).read().split())
if __name__ == '__main__':
    sel = sys.argv[1:]; out = []
    for key, fn in PRODUCTS.items():
        prod = fn()
        if sel and not any(s in prod['family'] or s == key for s in sel): continue
        n = check(prod)
        json.dump(prod, open(os.path.join(HERE, prod['family'] + '.product.json'), 'w'), indent=1)
        r = fp.compile_product(prod)
        json.dump(r, open(os.path.join(HERE, prod['family'] + '.recipe.json'), 'w'), indent=1)
        fp.render(prod, os.path.join(HERE, prod['family'] + '.preview.png'))
        fp.render_type_image(prod, os.path.join(HERE, prod['family'] + '.png'), size=600)
        out.append((key, prod['family'], n, len(r['ops']))); print(out[-1], flush=True)
    json.dump(NEEDED, open(os.path.join(HERE, 'batches', 'A1_doors_windows.materials_needed.json'), 'w'), indent=1)
