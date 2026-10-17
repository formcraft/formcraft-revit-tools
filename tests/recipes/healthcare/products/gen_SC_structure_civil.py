"""Healthcare pack, batch SC (structure and civil): 45 families as detailed products (photo-to-family pipeline, 17 Oct).
Pattern: make_products.py. Compiler/renderer: ../../tools/fmc_parts.py. Structural sizes are typical and marked
assumed, engineer to confirm: this script never decides a section, a grade or a reinforcement layout.
Run: python3 gen_SC_structure_civil.py [family-substring ...]"""
import json, os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import fmc_parts as fp

RECS = {r['family']: r for r in json.load(open(os.path.join(HERE, 'batches', 'SC_structure_civil.json')))}
A = lambda v, src='typical product, to confirm with the supplier': {"value": v, "source_status": "assumed", "source": src}
ENG = 'typical size, engineer to confirm'
P = []

# catalogue labels that are not Revit categories -> real categories (listed in the report)
CAT_MAP = {
    'FMC_S_GenericModel_LiftPit': 'Structural Foundations',
    'FMC_C_Structure_Manhole_Precast': 'Pipe Accessories', 'FMC_C_Structure_Manhole_Brick': 'Pipe Accessories',
    'FMC_C_Structure_Catchpit_Stormwater': 'Pipe Accessories', 'FMC_C_Structure_Gully_Trapped': 'Pipe Accessories',
    'FMC_C_Structure_Soakpit': 'Pipe Accessories', 'FMC_C_Structure_NeutralisationPit_Lab': 'Pipe Accessories',
    'FMC_C_Structure_SepticTank_MultiChamber': 'Mechanical Equipment', 'FMC_C_Structure_WWTP_Packaged': 'Mechanical Equipment',
    'FMC_C_Structure_GreaseTrap_External': 'Mechanical Equipment', 'FMC_C_Structure_Interceptor_Fuel': 'Mechanical Equipment',
    'FMC_C_Structure_Culvert_Box': 'Site', 'FMC_C_Structure_Culvert_Pipe': 'Site', 'FMC_C_Structure_Drain_UChannel_Covered': 'Site',
    'FMC_C_SiteFurniture_Incinerator_MedicalWaste': 'Mechanical Equipment', 'FMC_C_SiteFurniture_Gatehouse_Barrier': 'Specialty Equipment',
}
MATS = {
    'conc': 'FMC_Concrete_C30', 'c25': 'FMC_Concrete_C25', 'c20': 'FMC_Concrete_C20', 'blind': 'FMC_Concrete_Blinding_C15',
    'pre': 'FMC_Concrete_Manhole_Precast', 'mortar': 'FMC_Masonry_Mortar_1to4', 'rebar': 'FMC_Metal_Rebar_B500_Ribbed',
    'steel': 'FMC_Metal_StructuralSteel_S275', 'galv': 'FMC_Metal_ColdFormed_Galvanised', 'paint': 'FMC_Metal_SteelLTZ_Painted',
    'ci': 'FMC_Metal_BurglarBar_Steel', 'upvc': 'FMC_Plastic_uPVC_Pipe_DarkGrey', 'black': 'FMC_Plastic_ABS_Black',
    'yellow': 'FMC_Plastic_ABS_Yellow', 'white': 'FMC_Paint_RoadMarking_White', 'brick': 'FMC_Masonry_BurntClayBrick_Common',
    'stone': 'FMC_Stone_CrushedStone_20', 'red': 'FMC_Metal_SprinklerPipe_RedPainted', 'blue': 'FMC_Plastic_ABS_Blue',
    'rubber': 'FMC_Rubber_Black', 'alu': 'FMC_Metal_Aluminium_Anodised_Silver', 'grey': 'FMC_Plastic_ABS_Grey',
    'lead': 'FMC_Metal_StructuralSteel_S275', 'gi': 'FMC_Metal_GI_Pipe', 'filler': 'FMC_Board_SoftBoard_Ceiling',
    'asphalt': 'FMC_Concrete_Asphalt', 'kerb': 'FMC_Concrete_Kerb_Precast', 'ogee': 'FMC_Concrete_Pipe_Ogee',
    'hdpe': 'FMC_Plastic_HDPE_PE100_Black', 'pitch': 'FMC_Stone_Pitching', 'ledg': 'FMC_Plastic_LED_Green', 'ledr': 'FMC_Plastic_LED_Red',
    'abswhite': 'FMC_Plastic_ABS_White', 'epoxy': 'FMC_Metal_Steel_EpoxyCoated_White', 'ss': 'FMC_Metal_StainlessSteel_Brushed',
}
NEEDED = [
    {"name": "FMC_Metal_DuctileIron_Black", "colour": "#232323", "why": "manhole covers, frames and gully gratings (EN 124); BurglarBar_Steel used for now"},
    {"name": "FMC_Metal_Lead_Sheet", "colour": "#7A7E83", "why": "lead lining of radiation-shielded sleeves; StructuralSteel_S275 used for now"},
    {"name": "FMC_Board_JointFiller_Fibre", "colour": "#5B4A3A", "why": "bitumen-impregnated fibreboard joint filler; SoftBoard_Ceiling used for now"},
    {"name": "FMC_Paint_RoadMarking_Yellow", "colour": "#F2C230", "why": "ambulance bay, helipad touchdown circle, speed hump markings, wheel stops; ABS_Yellow used for now"},
    {"name": "FMC_Paint_RoadMarking_Blue", "colour": "#1F5FAF", "why": "accessible parking bay surface and sign; ABS_Blue used for now"},
    {"name": "FMC_Paint_RoadMarking_Red", "colour": "#C8102E", "why": "hospital helipad red H; SprinklerPipe_RedPainted used for now"},
    {"name": "FMC_Paint_Safety_Yellow", "colour": "#F5C400", "why": "hazard bands on canopy columns and barrier housings; ABS_Yellow used for now"},
]
NEEDED_FOR = {'ci': 0, 'lead': 1, 'filler': 2, 'yellow': 3, 'blue': 4, 'red': 5}

# ---------------------------------------------------------------- part helpers
def _o(d, lod=None, rep=None, r=None, seg=None, void=False):
    if lod: d['lod'] = lod
    if rep: d['repeat'] = {"n": rep[0], "d": [rep[1], rep[2], rep[3]]}
    if r: d['r'] = r
    if seg: d['seg'] = seg
    if void: d['void'] = True; d.pop('mat', None)
    return d
def B(n, at, mat, **k): return _o({"n": n, "shape": "box", "at": [round(v, 2) for v in at], "mat": mat}, **k)
def FB(n, at, mat, **k): return _o({"n": n, "shape": "fbox", "at": [round(v, 2) for v in at], "mat": mat}, **k)
def PR(n, pts, z0, z1, mat, **k): return _o({"n": n, "shape": "prism", "pts": [[round(a, 2), round(b, 2)] for a, b in pts], "z": [z0, z1], "mat": mat}, **k)
def FR(n, pts, y0, y1, mat, **k): return _o({"n": n, "shape": "front", "pts": [[round(a, 2), round(b, 2)] for a, b in pts], "y": [y0, y1], "mat": mat}, **k)
def RT(n, pts, x0, x1, mat, **k): return _o({"n": n, "shape": "right", "pts": [[round(a, 2), round(b, 2)] for a, b in pts], "x": [x0, x1], "mat": mat}, **k)
def CZ(n, c, r, z0, z1, mat, **k): return _o({"n": n, "shape": "cyl", "axis": "z", "c": c, "r": r, "z": [z0, z1], "mat": mat}, **k)
def CY(n, c, r, y0, y1, mat, **k): return _o({"n": n, "shape": "cyl", "axis": "y", "c": c, "r": r, "y": [y0, y1], "mat": mat}, **k)
def CX(n, c, r, x0, x1, mat, **k): return _o({"n": n, "shape": "cyl", "axis": "x", "c": c, "r": r, "x": [x0, x1], "mat": mat}, **k)
def T(n, axis, c, prof, mat, **k): return _o({"n": n, "shape": "turn", "axis": axis, "c": c, "profile": [[round(a, 2), round(b, 2)] for a, b in prof], "mat": mat}, **k)
def ring(r0, r1, t0, t1): return [[r0, t0], [r1, t0], [r1, t1], [r0, t1]]

def crect(x0, y0, x1, y1, c):
    return [[x0 + c, y0], [x1 - c, y0], [x1, y0 + c], [x1, y1 - c], [x1 - c, y1], [x0 + c, y1], [x0, y1 - c], [x0, y0 + c]]
def ipts(b, d, tw, tf, cu=0, cv=0):
    p = [(-b / 2, -d / 2), (b / 2, -d / 2), (b / 2, -d / 2 + tf), (tw / 2, -d / 2 + tf), (tw / 2, d / 2 - tf), (b / 2, d / 2 - tf), (b / 2, d / 2),
         (-b / 2, d / 2), (-b / 2, d / 2 - tf), (-tw / 2, d / 2 - tf), (-tw / 2, -d / 2 + tf), (-b / 2, -d / 2 + tf)]
    return [[u + cu, v + cv] for u, v in p]
def hexp(cx, cy, s):  # hexagon across flats s
    R = s / math.sqrt(3); return [[cx + R * math.cos(math.pi / 6 + k * math.pi / 3), cy + R * math.sin(math.pi / 6 + k * math.pi / 3)] for k in range(6)]
def strut(uc, vb):  # 41x41 lipped channel, open side at v = vb (bottom)
    p = [(-20.5, 0), (-11, 0), (-11, 6), (-13.5, 6), (-13.5, 2.5), (-18, 2.5), (-18, 38.5), (18, 38.5), (18, 2.5), (13.5, 2.5), (13.5, 6), (11, 6), (11, 0), (20.5, 0), (20.5, 41), (-20.5, 41)]
    return [[uc + u, vb + v] for u, v in p]
def quad(x0, y0, x1, y1, w):  # a stroke from (x0,y0) to (x1,y1), width w (plan)
    dx, dy = x1 - x0, y1 - y0; L = math.hypot(dx, dy) or 1; nx, ny = -dy / L * w / 2, dx / L * w / 2
    ex, ey = dx / L * w / 2, dy / L * w / 2
    return [[x0 - ex + nx, y0 - ey + ny], [x0 - ex - nx, y0 - ey - ny], [x1 + ex - nx, y1 + ey - ny], [x1 + ex + nx, y1 + ey + ny]]
def bolt_v(name, x, y, z, mat='steel', d=20, proj=60, washer=True, lod='f'):
    """Vertical bolt standing on a surface at z: square plate washer, hex nut, thread end."""
    out = []
    if washer: out.append(B(f"{name} Washer", [x - d * 1.25, y - d * 1.25, z, x + d * 1.25, y + d * 1.25, z + 6], mat, lod=lod))
    z1 = z + (6 if washer else 0)
    out.append(PR(f"{name} Nut", hexp(x, y, d * 1.5), z1, z1 + d * 0.8, mat, lod=lod))
    out.append(CZ(f"{name} Thread", [x, y], d / 2, z1 + d * 0.8, z + proj, mat, lod=lod, seg=12))
    return out
def cover(name, cx, cy, w, l, ztop, ribs=5, frame=75, lod_ribs='f'):
    """Ductile-iron access cover and frame, flush at ztop, with a raised anti-slip pattern."""
    x0, y0, x1, y1, f, zb = cx - w / 2, cy - l / 2, cx + w / 2, cy + l / 2, frame, ztop - 100
    out = [B(f"{name} Frame Front", [x0 - f, y0 - f, zb, x1 + f, y0, ztop], 'ci'), B(f"{name} Frame Back", [x0 - f, y1, zb, x1 + f, y1 + f, ztop], 'ci'),
           B(f"{name} Frame Left", [x0 - f, y0, zb, x0, y1, ztop], 'ci'), B(f"{name} Frame Right", [x1, y0, zb, x1 + f, y1, ztop], 'ci'),
           B(f"{name} Cover", [x0, y0, ztop - 6, x1, y1, ztop + 1], 'ci')]
    if ribs:
        pitch = l / (ribs + 1)
        out.append(B(f"{name} Pattern", [cx - w / 2 + 40, cy - l / 2 + pitch - 8, ztop + 1, cx + w / 2 - 40, cy - l / 2 + pitch + 8, ztop + 3.5], 'ci', lod=lod_ribs, rep=(ribs, 0, pitch, 0)))
        out.append(B(f"{name} Keyhole", [cx - w / 2 + 25, cy - 20, ztop + 1, cx - w / 2 + 35, cy + 20, ztop + 2], 'galv', lod='f', rep=(2, w - 60, 0, 0)))
    return out
def round_cover(name, cx, cy, r, ztop):
    return [T(f"{name} Frame", 'z', [cx, cy], ring(r, r + 70, ztop - 100, ztop), 'ci', seg=40),
            T(f"{name} Cover", 'z', [cx, cy], [[0, ztop - 6], [r, ztop - 6], [r, ztop + 1], [0, ztop + 1]], 'ci', seg=40),
            T(f"{name} Pattern Ring", 'z', [cx, cy], ring(r * 0.55, r * 0.65, ztop + 1, ztop + 3.5), 'ci', lod='f', seg=40),
            B(f"{name} Pattern Bar", [cx - r * 0.5, cy - 10, ztop + 1, cx + r * 0.5, cy + 10, ztop + 3.5], 'ci', lod='f')]
def walls4(name, x0, y0, x1, y1, t, z0, z1, mat):
    return [B(f"{name} Front", [x0, y0, z0, x1, y0 + t, z1], mat), B(f"{name} Back", [x0, y1 - t, z0, x1, y1, z1], mat),
            B(f"{name} Left", [x0, y0 + t, z0, x0 + t, y1 - t, z1], mat), B(f"{name} Right", [x1 - t, y0 + t, z0, x1, y1 - t, z1], mat)]
def ladder(name, x, y0, y1, z0, z1, axis='y', n=None, mat='galv', standoff=None):
    """Steel rung ladder; stiles at the two ends of [y0,y1] (axis y) at plan position x."""
    out = []
    n = n or int((z1 - z0 - 150) // 300)
    if axis == 'y':
        out += [B(f"{name} Stile Left", [x - 10, y0 - 10, z0, x + 10, y0 + 10, z1], mat), B(f"{name} Stile Right", [x - 10, y1 - 10, z0, x + 10, y1 + 10, z1], mat),
                CY(f"{name} Rung", [x, z0 + 300], 12, y0, y1, mat, rep=(n, 0, 0, 300), seg=12)]
    else:
        out += [B(f"{name} Stile Left", [y0 - 10, x - 10, z0, y0 + 10, x + 10, z1], mat), B(f"{name} Stile Right", [y1 - 10, x - 10, z0, y1 + 10, x + 10, z1], mat),
                CX(f"{name} Rung", [x, z0 + 300], 12, y0, y1, mat, rep=(n, 0, 0, 300), seg=12)]
    return out


# ---------------------------------------------------------------- concave outlines
# fmc_parts draws a cap as a fan from the vertex mean, so an outline that is not star-shaped about that point
# (I, Z, C, L, U sections) previews wrongly. Such outlines are split here into rectangles (axis-aligned outlines)
# or convex pieces (others); in Revit the pieces are separate extrusions of the same material.
def _area(P): return sum(P[i][0] * P[(i + 1) % len(P)][1] - P[(i + 1) % len(P)][0] * P[i][1] for i in range(len(P))) / 2
def _cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
def fan_ok(P):
    if _area(P) < 0: P = P[::-1]
    c = (sum(q[0] for q in P) / len(P), sum(q[1] for q in P) / len(P))
    return all(_cross(P[i], P[(i + 1) % len(P)], c) > 1e-6 for i in range(len(P)))
def _rects(P):
    vs = sorted({q[1] for q in P}); act, out = {}, []
    for v0, v1 in zip(vs, vs[1:]):
        vm = (v0 + v1) / 2; us = []
        for i in range(len(P)):
            a, b = P[i], P[(i + 1) % len(P)]
            if (a[1] - vm) * (b[1] - vm) < 0: us.append(a[0] + (vm - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
        us.sort(); S = {(round(us[k], 3), round(us[k + 1], 3)) for k in range(0, len(us), 2)}
        for iv in list(act):
            if iv not in S: out.append((iv[0], act.pop(iv), iv[1], v0))
        for iv in S:
            if iv not in act: act[iv] = v0
    for iv, st in act.items(): out.append((iv[0], st, iv[1], vs[-1]))
    return [[[u0, w0], [u1, w0], [u1, w1], [u0, w1]] for u0, w0, u1, w1 in out]
def _convex(Q): return all(_cross(Q[i], Q[(i + 1) % len(Q)], Q[(i + 2) % len(Q)]) >= -1e-6 for i in range(len(Q)))
def _pieces(P):
    if _area(P) < 0: P = P[::-1]
    idx = list(range(len(P))); tris = []
    def inside(p, a, b, c): return _cross(a, b, p) > 1e-9 and _cross(b, c, p) > 1e-9 and _cross(c, a, p) > 1e-9
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        for k in range(len(idx)):
            i0, i1, i2 = idx[k - 1], idx[k], idx[(k + 1) % len(idx)]
            cr = _cross(P[i0], P[i1], P[i2])
            if abs(cr) < 1e-9: idx.pop(k); break
            if cr > 0 and not any(inside(P[j], P[i0], P[i1], P[i2]) for j in idx if j not in (i0, i1, i2)):
                tris.append([i0, i1, i2]); idx.pop(k); break
    if len(idx) == 3: tris.append(idx[:])
    polys = tris; merged = True
    while merged:
        merged = False
        for a in range(len(polys)):
            for b in range(len(polys)):
                if a == b: continue
                A, Bp = polys[a], polys[b]
                for i in range(len(A)):
                    u, v = A[i], A[(i + 1) % len(A)]
                    if u in Bp and Bp[(Bp.index(u) - 1) % len(Bp)] == v:
                        ia, ib = (i + 1) % len(A), Bp.index(u)
                        M = [A[(ia + k) % len(A)] for k in range(len(A) - 1)] + [Bp[(ib + k) % len(Bp)] for k in range(len(Bp) - 1)]
                        if _convex([P[j] for j in M]):
                            polys[a] = M; polys.pop(b); merged = True
                        break
                if merged: break
            if merged: break
    return [[P[j] for j in Q] for Q in polys]
def split_concave(parts):
    out = []
    for p in parts:
        if p['shape'] not in ('prism', 'front', 'right') or fan_ok(p['pts']): out.append(p); continue
        P = p['pts']; ortho = all(P[i][0] == P[(i + 1) % len(P)][0] or P[i][1] == P[(i + 1) % len(P)][1] for i in range(len(P)))
        for k, Q in enumerate(_rects(P) if ortho else _pieces(P)):
            q = dict(p); q['pts'] = [[round(a, 2), round(b, 2)] for a, b in Q]
            if k: q['n'] = f"{p['n']} Part {k + 1}"
            out.append(q)
    return out

def prod(fam, desc, ifc, types, parts, values, about, conns=None, clear=None, tv=None, template=None, mats=None):
    rec = RECS[fam]
    parts = split_concave(parts)
    cat = CAT_MAP.get(fam, rec['category'])
    if cat == 'Mechanical Equipment': template = template or 'Metric Mechanical Equipment.rft'
    used = {p.get('mat') for p in parts if p.get('mat')}
    m = {k: v for k, v in MATS.items() if k in used}
    if mats: m.update(mats)
    tl = []
    for t in types:
        t = dict(t) if isinstance(t, dict) else {"name": t}
        tl.append(t)
    d = {"family": fam, "category": cat, "template": template or 'Metric Generic Model.rft', "desc": desc, "ifc": ifc, "keynote": rec['kn'],
         "types": tl, "materials": m, "parts": parts, "reference": dict(rec['ref']), "values": values, "about": about}
    if tv: d['type_values'] = tv
    if conns: d['connectors'] = conns
    if clear: d['clearances'] = clear
    P.append(d); return d

def san(n, part, side, dia, flow): return {"n": n, "domain": "pipe", "system": "Sanitary", "part": part, "side": side, "diameter": dia, "flow": flow}
def power(part, side): return {"n": "Power", "domain": "electrical", "system": "PowerBalanced", "part": part, "side": side}

# ================================================================ STRUCTURAL COLUMNS
def rc_rect_column():
    s, h = 300, 3000
    parts = [PR("Kicker", crect(-s / 2, -s / 2, s / 2, s / 2, 20), 0, 75, 'conc'),
             PR("Shaft", crect(-s / 2, -s / 2, s / 2, s / 2, 20), 75, h, 'conc'),
             CY("Tie Hole Plug Front", [0, 600], 12, -s / 2 - 1, -s / 2 + 5, 'mortar', lod='f', rep=(4, 0, 0, 700), seg=12),
             RT("Tie Hole Plug Side", fp.circle(0, 600, 12, 12), -s / 2 - 1, -s / 2 + 5, 'mortar', lod='f', rep=(4, 0, 0, 700))]
    prod('FMC_S_StrColumn_RC_Rect', 'Reinforced concrete column, square, 20 mm chamfered arrises, 75 mm kicker, fair-faced with plugged tie holes', 'IfcColumn',
         [{"name": "300x300_RC", "desc": "RC column 300 x 300"}, {"name": "400x400_RC", "desc": "RC column 400 x 400"}, {"name": "500x500_RC", "desc": "RC column 500 x 500"}],
         parts, {"Section 300 x 300 mm (smallest type)": A("300x300", ENG), "Chamfer 20 mm": A(20, "typical formwork fillet"),
                 "Kicker 75 mm": A(75, "typical construction practice"), "Concrete grade and cover from the kit": A("C30 / kit cover", "FMC kit rulebook; engineer to confirm")},
         "RC column modelled as cast: 75 mm kicker, chamfered shaft, plugged formwork tie holes (Fine). Reinforcement is detailed by the engineer, not modelled. Geometry shows the 300 type; 3000 high.")

def rc_round_column():
    r, h = 200, 3000
    parts = [CZ("Kicker", [0, 0], r, 0, 75, 'conc', seg=48), CZ("Shaft", [0, 0], r, 75, h, 'conc', seg=48),
             T("Form Seam", 'z', [0, 0], ring(r, r + 1, 600, 606), 'mortar', lod='f', rep=(4, 0, 0, 600), seg=48)]
    prod('FMC_S_StrColumn_RC_Round', 'Reinforced concrete circular column cast in tube formwork, 75 mm kicker', 'IfcColumn',
         [{"name": "400dia_RC", "desc": "RC circular column 400 dia"}, {"name": "500dia_RC", "desc": "RC circular column 500 dia"}], parts,
         {"Diameter 400 mm (smallest type)": A(400, ENG), "Kicker 75 mm": A(75, "typical construction practice"), "Concrete grade and cover from the kit": A("C30 / kit cover", "FMC kit rulebook; engineer to confirm")},
         "Circular RC column as cast in a tube former: kicker, shaft and the faint tube seams (Fine). Geometry shows 400 dia, 3000 high.")

def steel_uc():
    b, d, tw, tf = 203.6, 203.2, 7.2, 11.0
    parts = [B("Grout Pad", [-210, -210, 0, 210, 210, 30], 'mortar'), B("Base Plate", [-200, -200, 30, 200, 200, 50], 'steel'),
             PR("Column", ipts(b, d, tw, tf), 50, 3000, 'steel'), B("Cap Plate", [-125, -125, 3000, 125, 125, 3015], 'steel'),
             RT("Gusset Front", [[-d / 2, 50], [-190, 50], [-190, 70], [-d / 2, 200]], -6, 6, 'steel'),
             RT("Gusset Back", [[d / 2, 50], [d / 2, 200], [190, 70], [190, 50]], -6, 6, 'steel'),
             FR("Stiffener Left", [[-tw / 2, 50], [-tw / 2, 200], [-190, 70], [-190, 50]], -6, 6, 'steel'),
             FR("Stiffener Right", [[tw / 2, 50], [190, 50], [190, 70], [tw / 2, 200]], -6, 6, 'steel')]
    for i, (x, y) in enumerate(((-150, -150), (150, -150), (-150, 150), (150, 150))): parts += bolt_v(f"HD Bolt {i + 1}", x, y, 50)
    prod('FMC_S_StrColumn_Steel_UC', 'Universal column, S275, on a 20 mm base plate with gussets, four holding-down bolts and a cap plate', 'IfcColumn',
         [{"name": "152UC_S275", "desc": "UC 152x152 serial size"}, {"name": "203UC_S275", "desc": "UC 203x203 serial size"}, {"name": "254UC_S275", "desc": "UC 254x254 serial size"}],
         parts, {"Section 203x203x46 UC (geometry)": A("203.2x203.6x7.2x11.0", "BS 4-1 section table, from knowledge; section choice by engineer"),
                 "Base plate 400 x 400 x 20 mm": A("400x400x20", ENG), "Holding-down bolts 4 x M20": A("4xM20", ENG), "Grade S275": A("S275", "kit material; engineer to confirm")},
         "UC modelled as erected: grout pad, base plate, I-section shaft, gussets and stiffeners, HD bolts with plate washers and nuts (Fine), cap plate. Geometry shows the 203 UC, 3000 high.")

def chs_canopy():
    R = 84.15
    parts = [B("Base Plate", [-175, -175, 0, 175, 175, 20], 'paint'), CZ("Column", [0, 0], R, 20, 3500, 'paint', seg=36),
             T("Hazard Band", 'z', [0, 0], ring(R, R + 1.5, 300, 450), 'yellow', lod='f', rep=(4, 0, 0, 300), seg=36),
             B("Cap Plate", [-130, -130, 3500, 130, 130, 3520], 'paint'),
             FB("Truss Fin Plate", [-6, -100, 3520, 6, 100, 3720], 'paint', lod='mf'),
             CX("Fin Bolt", [0, 3580], 10, -20, 20, 'galv', lod='f', rep=(2, 0, 0, 80), seg=12)]
    for nm, pts in (("Gusset X+", [[R, 20], [170, 20], [170, 40], [R, 170]]), ("Gusset X-", [[-R, 20], [-R, 170], [-170, 40], [-170, 20]])):
        parts.append(FR(nm, pts, -5, 5, 'paint'))
    for nm, pts in (("Gusset Y+", [[R, 20], [R, 170], [170, 40], [170, 20]]), ("Gusset Y-", [[-R, 20], [-170, 20], [-170, 40], [-R, 170]])):
        parts.append(RT(nm, pts, -5, 5, 'paint'))
    for i, (x, y) in enumerate(((-125, -125), (125, -125), (-125, 125), (125, 125))): parts += bolt_v(f"HD Bolt {i + 1}", x, y, 20, mat='galv', d=16, proj=60)
    prod('FMC_S_StrColumn_Steel_CHS_Canopy', 'Ambulance canopy column, circular hollow section, painted, base plate with radial gussets, hazard banding, truss fin plate at the head', 'IfcColumn',
         [{"name": "114_CHS", "desc": "CHS 114.3 canopy column"}, {"name": "168_CHS", "desc": "CHS 168.3 canopy column"}], parts,
         {"CHS 168.3 x 6.3 (geometry)": A("168.3x6.3", "EN 10210 section, from knowledge; section choice by engineer"), "Height 3500 mm to cap plate": A(3500, ENG),
          "Base plate 350 x 350 x 20, 4 x M16": A("350x350x20 4xM16", ENG), "Hazard banding to 1500 mm": A(1500, "vehicle-impact visibility at ambulance set-down")},
         "Canopy column modelled as erected: base plate, four radial gussets, HD bolts, painted CHS with yellow hazard bands (Fine), cap plate and fin plate with bolts for the truss.")

# ================================================================ STRUCTURAL FRAMING
def rc_beam():
    L = 4000
    parts = [RT("Beam", [[-115, -430], [-95, -450], [95, -450], [115, -430], [115, 0], [-115, 0]], -L / 2, L / 2, 'conc'),
             CY("Tie Hole Plug", [-1500, -225], 12, -116, -110, 'mortar', lod='f', rep=(4, 1000, 0, 0), seg=12)]
    prod('FMC_S_StrFraming_RC_Rect', 'Reinforced concrete beam, rectangular, chamfered soffit arrises, fair-faced', 'IfcBeam',
         [{"name": "230x450_RC", "desc": "RC beam 230 wide x 450 deep"}, {"name": "300x600_RC", "desc": "RC beam 300 wide x 600 deep"}], parts,
         {"Section 230 x 450 mm (geometry)": A("230x450", ENG), "Soffit chamfer 20 mm": A(20, "typical formwork fillet"), "Concrete grade and cover from the kit": A("C30 / kit cover", "FMC kit rulebook; engineer to confirm")},
         "RC beam with top at the reference (z = 0), chamfered soffit, plugged tie holes (Fine). Shown 4000 long; reinforcement by the engineer.")

def rc_lbeam():
    L = 4000
    parts = [RT("Beam", [[-115, -580], [-95, -600], [95, -600], [115, -580], [115, -150], [700, -150], [700, 0], [-115, 0]], -L / 2, L / 2, 'conc'),
             RT("Drip Nib", [[-115, -600], [-95, -600], [-95, -615], [-115, -615]], -L / 2, L / 2, 'conc', lod='f'),
             CY("Tie Hole Plug", [-1500, -375], 12, -116, -110, 'mortar', lod='f', rep=(4, 1000, 0, 0), seg=12)]
    prod('FMC_S_StrFraming_RC_LBeam_Edge', 'Reinforced concrete edge L-beam: downstand at the slab edge with the integral slab flange, drip nib on the outer soffit', 'IfcBeam',
         ["230x600_Edge"], parts,
         {"Downstand 230 x 600 mm": A("230x600", ENG), "Slab flange 150 x 585 mm": A("150x585", ENG + "; flange width per BS EN 1992 effective width"), "Drip nib 15 mm": A(15, "typical edge detail")},
         "Edge L-beam: web at the slab edge (outer face toward -y), slab flange inward, chamfered soffit, drip nib and tie-hole plugs (Fine). Shown 4000 long.")

def steel_ub():
    b, d, tw, tf, L = 146.1, 251.4, 6.0, 8.6, 4000
    parts = [RT("Beam", ipts(b, d, tw, tf, 0, -d / 2), -L / 2, L / 2, 'steel')]
    for end, x in (("Left", -L / 2 + 50), ("Right", L / 2 - 50)):
        parts += [FR(f"Bolt Head {end}", hexp(x, -60, 30), -tw / 2 - 13, -tw / 2, 'galv', lod='f', rep=(3, 0, 0, -65)),
                  FR(f"Bolt Nut {end}", hexp(x, -60, 30), tw / 2, tw / 2 + 16, 'galv', lod='f', rep=(3, 0, 0, -65))]
    prod('FMC_S_StrFraming_Steel_UB', 'Universal beam, S275, with bolted web connections at both ends', 'IfcBeam',
         [{"name": "203UB_S275", "desc": "UB 203x133"}, {"name": "254UB_S275", "desc": "UB 254x146"}, {"name": "305UB_S275", "desc": "UB 305x165"}], parts,
         {"Section 254x146x31 UB (geometry)": A("251.4x146.1x6.0x8.6", "BS 4-1 section table, from knowledge; section choice by engineer"),
          "End bolts 3 x M20 per end": A("3xM20", ENG), "Grade S275": A("S275", "kit material; engineer to confirm")},
         "UB with top of steel at z = 0: I-section and three-bolt web connections at each end (Fine). Shown 4000 long.")

def unistrut():
    parts = []
    parts += [RT("Main Channel Front", strut(-300, -641), -700, 700, 'galv'), RT("Main Channel Back", strut(300, -641), -700, 700, 'galv'),
              FR("Cross Channel Left", strut(-250, -682), -420, 420, 'galv'), FR("Cross Channel Right", strut(250, -682), -420, 420, 'galv'),
              B("Mounting Plate", [-300, -300, -702, 300, 300, -682], 'galv'),
              T("Pendant Flange", 'z', [0, 0], [[0, -722], [160, -722], [160, -702], [0, -702]], 'paint', seg=36),
              CZ("Flange Bolt", [-110, -110], 8, -730, -722, 'ss', lod='f', rep=(2, 220, 0, 0), seg=12),
              CZ("Flange Bolt Back", [-110, 110], 8, -730, -722, 'ss', lod='f', rep=(2, 220, 0, 0), seg=12)]
    for i, (x, y) in enumerate(((-650, -300), (650, -300), (-650, 300), (650, 300))):
        parts += [CZ(f"Drop Rod {i + 1}", [x, y], 6, -660, 0, 'galv', seg=12), CZ(f"Anchor {i + 1}", [x, y], 12, -40, 0, 'galv', lod='f', seg=12),
                  PR(f"Rod Nut {i + 1}", hexp(x, y, 19), -651, -641, 'galv', lod='f')]
    for nm, x0, x1 in (("Brace Left", -1150, -700), ("Brace Right", 1150, 700)):
        pts = [[x0, 0], [x0 + (40 if x0 < 0 else -40), 0], [x1, -560], [x1, -600]] if x0 < 0 else [[x0, 0], [x1, -600], [x1, -560], [x0 - 40, 0]]
        parts.append(FR(nm, pts, -320, -280, 'galv', rep=(2, 0, 600, 0)))
        parts.append(B(nm + " Bracket", [x0 - 60, -340, -10, x0 + 60, -260, 0], 'galv', lod='f', rep=(2, 0, 600, 0)))
    prod('FMC_S_StrFraming_Steel_Unistrut_PendantSupport', 'Above-ceiling support frame for a theatre/ICU pendant or OT light: 41x41 strut grid on drop rods, braced, with mounting plate and flange', 'IfcMember',
         ["41x41_Grid"], parts,
         {"Strut 41 x 41 x 2.5 mm": A("41x41x2.5", "typical strut channel"), "Frame 1400 x 840 mm, 640 mm below soffit": A("1400x840", ENG),
          "Mounting plate 600 x 600 x 20 mm": A("600x600x20", ENG), "Design load from the pendant vendor": A("vendor", "pendant/OT-light supplier load data; engineer to confirm")},
         "Ceiling product (soffit at z = 0, hangs below): two main strut channels on four M12 drop rods with anchors and nuts, two cross channels, mounting plate, pendant flange with bolts, two diagonal braces with slab brackets. Grid and load are vendor/engineer data.")

def lifting_beam():
    b, d, tw, tf = 88.7, 152.4, 4.5, 7.7
    lug = [[-60, -d], [60, -d], [60, -200]] + [[60 * math.cos(a), -200 - 60 * math.sin(a)] for a in [k * math.pi / 8 for k in range(1, 8)]] + [[-60, -200]]
    parts = [RT("Beam", ipts(b, d, tw, tf, 0, -d / 2), -1200, 1200, 'paint'),
             B("Bearing Plate Left", [-1200, -75, -d - 10, -1000, 75, -d], 'steel'), B("Bearing Plate Right", [1000, -75, -d - 10, 1200, 75, -d], 'steel'),
             B("Padstone Left", [-1200, -150, -d - 160, -950, 150, -d - 10], 'conc'), B("Padstone Right", [950, -150, -d - 160, 1200, 150, -d - 10], 'conc'),
             FR("Lifting Lug", lug, -8, 8, 'paint'),
             T("Shackle", 'x', [0, -215], [[18, -9], [27, -9], [27, 9], [18, 9]], 'galv', seg=24),
             FB("SWL Label", [-300, -tw / 2 - 1.5, -110, 300, -tw / 2, -45], 'yellow', lod='f'),
             FB("SWL Label Back", [-300, tw / 2, -110, 300, tw / 2 + 1.5, -45], 'yellow', lod='f')]
    prod('FMC_S_StrFraming_Steel_LiftingBeam_LiftShaft', 'Lift-shaft lifting beam, UB on padstones with a centre lifting lug, shackle and SWL marking', 'IfcBeam',
         ["152UB_Lifting"], parts,
         {"Section 152x89x16 UB (geometry)": A("152.4x88.7x4.5x7.7", "BS 4-1 section table, from knowledge; section by engineer"), "Span 2000 mm clear": A(2000, ENG),
          "Safe working load from the lift supplier": A("SWL by lift supplier", "lift installer data; test and mark per LOLER/BS EN 81-20")},
         "Lifting beam with top at z = 0: painted UB bearing on steel plates and concrete padstones, lifting lug and shackle at mid-span, SWL plates both sides (Fine).")

def canopy_truss():
    L, zt = 6000, 700
    parts = [B("Bottom Chord", [-L / 2, -40, 0, L / 2, 40, 80], 'paint'), B("Top Chord", [-L / 2, -40, zt - 80, L / 2, 40, zt], 'paint'),
             B("Vertical", [-L / 2, -30, 80, -L / 2 + 60, 30, zt - 80], 'paint', rep=(7, 990, 0, 0))]
    x0, x1 = -L / 2 + 60, -L / 2 + 990
    parts.append(FR("Diagonal Up", [[x0, 80], [x0 + 85, 80], [x1, zt - 80], [x1 - 85, zt - 80]], -30, 30, 'paint', rep=(3, 1980, 0, 0)))
    x0b, x1b = x0 + 990, x1 + 990
    parts.append(FR("Diagonal Down", [[x0b, zt - 80], [x0b + 85, zt - 80], [x1b, 80], [x1b - 85, 80]], -30, 30, 'paint', rep=(3, 1980, 0, 0)))
    parts += [B("Bearing Plate Left", [-L / 2, -100, -15, -L / 2 + 200, 100, 0], 'paint'), B("Bearing Plate Right", [L / 2 - 200, -100, -15, L / 2, 100, 0], 'paint'),
              FB("Purlin Cleat", [-L / 2 + 20, -5, zt, -L / 2 + 120, 5, zt + 90], 'paint', lod='f', rep=(7, 975, 0, 0))]
    prod('FMC_S_StrFraming_Steel_Truss_Canopy', 'Ambulance canopy truss, Warren girder of square hollow sections, painted, with bearing plates and purlin cleats', 'IfcMember',
         [{"name": "6000_Truss", "desc": "canopy truss 6.0 m span"}, {"name": "9000_Truss", "desc": "canopy truss 9.0 m span"}], parts,
         {"Span 6000 mm (geometry)": A(6000, ENG), "Depth 700 mm": A(700, ENG + "; span/depth about 9"), "Chords SHS 80x80, webs SHS 60x60": A("SHS 80/60", ENG),
          "Purlin cleats at 975 mm": A(975, ENG)},
         "Warren truss: SHS chords, seven verticals, six diagonals alternating, bearing plates at both ends and purlin cleats on the top chord (Fine). Reference at underside of bearing plates.")

def z_purlin():
    Z = [[-65, 0], [1, 0], [1, 198], [63, 198], [63, 180], [65, 180], [65, 200], [-1, 200], [-1, 2], [-63, 2], [-63, 20], [-65, 20]]
    parts = [RT("Purlin", Z, -1500, 1500, 'galv'),
             FB("Cleat Left", [-1500, 1, 10, -1420, 9, 160], 'galv'), FB("Cleat Right", [1420, 1, 10, 1500, 9, 160], 'galv')]
    for zc in (55, 125):
        parts += [CY(f"Bolt Head {zc}", [-1460, zc], 10, -9, -1, 'galv', lod='f', rep=(2, 2920, 0, 0), seg=6),
                  CY(f"Bolt Nut {zc}", [-1460, zc], 10, 9, 17, 'galv', lod='f', rep=(2, 2920, 0, 0), seg=6)]
    parts.append(CY("Sag Rod Hole Marker", [0, 100], 7, -1.5, 1.5, 'black', lod='f'))
    prod('FMC_S_StrFraming_Purlin_Z', 'Cold-formed galvanised Z purlin with lips, cleated and bolted at both ends', 'IfcMember',
         [{"name": "Z150_Galv", "desc": "Z purlin 150 deep"}, {"name": "Z200_Galv", "desc": "Z purlin 200 deep"}], parts,
         {"Z200, flanges 65 mm, lips 20 mm, 2.0 mm (geometry)": A("200x65x20x2.0", "typical cold-formed Z section; section by engineer"),
          "Span 3000 mm shown": A(3000, ENG), "Cleat bolts 2 x M12 per end": A("2xM12", "typical purlin cleat")},
         "Z purlin standing on z = 0: lipped Z section, end cleats, M12 bolts and nuts (Fine), sag-rod hole at mid-span.")

# ================================================================ FOUNDATIONS
def pad_footing():
    parts = [B("Blinding", [-800, -800, -550, 800, 800, -500], 'blind'), B("Pad", [-750, -750, -500, 750, 750, 0], 'conc'),
             B("Setting-out Mark X", [-750, -6, 0, -650, 6, 1], 'white', lod='f', rep=(2, 1400, 0, 0)),
             B("Setting-out Mark Y", [-6, -750, 0, 6, -650, 1], 'white', lod='f', rep=(2, 0, 1400, 0))]
    prod('FMC_S_StrFoundation_PadFooting', 'Reinforced concrete pad footing on 50 mm blinding, top at the column base', 'IfcFooting',
         [{"name": "1500x1500_RC", "desc": "pad 1500 x 1500 x 500"}, {"name": "2000x2000_RC", "desc": "pad 2000 x 2000 x 600"}], parts,
         {"Pad 1500 x 1500 x 500 mm (geometry)": A("1500x1500x500", ENG), "Blinding 50 mm C15, 50 mm projection": A(50, "typical practice"),
          "Concrete grade and cover from the kit": A("C30 / kit cover", "FMC kit rulebook; engineer to confirm")},
         "Pad footing with top at z = 0 (the column base): pad, blinding, grid setting-out marks (Fine). Depth and reinforcement by the engineer.")

def pile_cap():
    s = 1350
    parts = [PR("Cap", crect(-1050, -1050, 1050, 1050, 25), -900, 0, 'conc'), B("Blinding", [-1100, -1100, -975, 1100, 1100, -900], 'blind')]
    for i, (x, y) in enumerate(((-s / 2, -s / 2), (s / 2, -s / 2), (-s / 2, s / 2), (s / 2, s / 2))):
        parts.append(CZ(f"Pile {i + 1}", [x, y], 225, -2900, -825, 'conc', seg=32))
        parts.append(T(f"Pile Cut-off Ring {i + 1}", 'z', [x, y], ring(225, 226, -1000, -975), 'mortar', lod='f', seg=32))
    prod('FMC_S_StrFoundation_PileCap', 'Reinforced concrete pile cap with chamfered corners on blinding, with bored pile stubs', 'IfcFooting',
         [{"name": "2-Pile_RC", "desc": "2-pile cap"}, {"name": "3-Pile_RC", "desc": "3-pile cap"}, {"name": "4-Pile_RC", "desc": "4-pile cap"}], parts,
         {"4-pile cap 2100 x 2100 x 900 (geometry)": A("2100x2100x900", ENG), "Piles 450 dia at 3D = 1350 mm": A("450 at 1350", ENG + "; spacing 3 x diameter"),
          "Edge 150 mm beyond pile face": A(150, "typical practice"), "Pile embedment 75 mm": A(75, "typical practice")},
         "Pile cap with top at z = 0: chamfered cap, blinding, four 450 pile stubs shown 2 m below the cap with the trimmed cut-off line (Fine). Geometry shows the 4-pile type; 2- and 3-pile layouts per the engineer.")

def bored_pile():
    r, Lp = 225, 6000
    parts = [CZ("Pile Shaft", [0, 0], r, -Lp, 0, 'conc', seg=36),
             T("Pile Toe", 'z', [0, 0], [[0, -Lp - 40], [r - 40, -Lp - 40], [r, -Lp], [0, -Lp]], 'conc', seg=36)]
    for k in range(8):
        a = 2 * math.pi * k / 8; parts.append(CZ(f"Starter Bar {k + 1}", [round(165 * math.cos(a), 1), round(165 * math.sin(a), 1)], 8, 0, 750, 'rebar', lod='f', seg=10))
    parts.append(T("Link Ring", 'z', [0, 0], ring(155, 175, 120, 130), 'rebar', lod='f', seg=36))
    prod('FMC_S_StrFoundation_Pile_Bored', 'Bored cast-in-place concrete pile, cut-off at the reference, with the reinforcement cage projecting into the cap', 'IfcPile',
         [{"name": "450_Bored", "desc": "bored pile 450 dia"}, {"name": "600_Bored", "desc": "bored pile 600 dia"}], parts,
         {"Diameter 450 mm (geometry)": A(450, ENG), "Length 6000 mm shown": A(6000, "length by the engineer from the site investigation"),
          "Starter bars 8 x T16, 750 projection": A("8xT16 750", ENG)},
         "Pile with cut-off level at z = 0: shaft, toe, eight starter bars and a link projecting into the cap (Fine). Length and cage by the engineer.")

def strip_footing():
    parts = [B("Blinding", [-1500, -350, -250, 1500, 350, -200], 'blind'), B("Strip", [-1500, -300, -200, 1500, 300, 0], 'conc'),
             B("Wall Setting-out Line", [-1500, -100, 0, 1500, -95, 1], 'white', lod='f'), B("Wall Setting-out Line Back", [-1500, 95, 0, 1500, 100, 1], 'white', lod='f')]
    prod('FMC_S_StrFoundation_StripFooting', 'Concrete strip footing on blinding, top at the foundation wall base', 'IfcFooting',
         [{"name": "600_Strip", "desc": "strip 600 wide x 200"}, {"name": "900_Strip", "desc": "strip 900 wide x 250"}], parts,
         {"Strip 600 x 200 mm (geometry)": A("600x200", ENG), "Blinding 50 mm": A(50, "typical practice"), "Wall set-out 200 mm wall centred": A(200, "typical foundation wall")},
         "Strip footing with top at z = 0: strip, blinding and wall setting-out lines (Fine). Shown 3000 long; for runs, use a wall foundation where possible.")

def equipment_plinth():
    parts = [B("Blinding", [-2150, -950, -500, 2150, 950, -450], 'blind'), B("Inertia Block", [-2100, -900, -450, 2100, 900, 0], 'conc'),
             PR("Plinth Upstand", crect(-2000, -800, 2000, 800, 20), 0, 150, 'conc'),
             B("Isolation Joint Front", [-2125, -925, -450, 2125, -900, 0], 'filler'), B("Isolation Joint Back", [-2125, 900, -450, 2125, 925, 0], 'filler'),
             B("Isolation Joint Left", [-2125, -900, -450, -2100, 900, 0], 'filler'), B("Isolation Joint Right", [2100, -900, -450, 2125, 900, 0], 'filler'),
             B("Joint Sealant Front", [-2125, -925, -15, 2125, -900, 0.5], 'black', lod='f'), B("Joint Sealant Back", [-2125, 900, -15, 2125, 925, 0.5], 'black', lod='f')]
    for row, y in (("Front", -600), ("Back", 600)):
        parts += [CZ(f"Anchor Bolt {row}", [-1500, y], 10, 150, 230, 'galv', lod='f', rep=(3, 1500, 0, 0), seg=12),
                  PR(f"Anchor Nut {row}", hexp(-1500, y, 30), 156, 172, 'galv', lod='f', rep=(3, 1500, 0, 0)),
                  B(f"Anchor Washer {row}", [-1525, y - 25, 150, -1475, y + 25, 156], 'galv', lod='f', rep=(3, 1500, 0, 0))]
    prod('FMC_S_StrFoundation_Plinth_Equipment_Isolated', 'Isolated equipment plinth: inertia block set into the slab with a 25 mm isolation joint all round, chamfered upstand and cast-in anchor bolts', 'IfcFooting',
         [{"name": "MRI_Isolated", "desc": "MRI isolated plinth; mass and size from the scanner vendor"}, {"name": "CT_Isolated", "desc": "CT isolated plinth; from the vendor"},
          {"name": "Generator_Isolated", "desc": "generator inertia base; from the generator vendor"}], parts,
         {"Inertia block 4200 x 1800 x 450 mm (geometry)": A("4200x1800x450", ENG + "; mass ratio from the equipment vendor"), "Isolation joint 25 mm": A(25, "typical vibration break"),
          "Upstand 150 mm": A(150, "typical plinth"), "Equipment mass and anchor pattern from the vendor": A("vendor", "vendor installation drawing; engineer to confirm")},
         "Floor at z = 0: inertia block below floor on blinding, isolation filler and sealant around it, chamfered upstand, six anchor bolts with washers and nuts (Fine). Geometry shows the generator type.")

def tank_base():
    parts = []
    for row, y in (("Front", -1200), ("Back", 1200)):
        parts += [B(f"Pad {row}", [-1700, y - 500, -1000, -700, y + 500, -600], 'conc', rep=(2, 2400, 0, 0)),
                  B(f"Blinding {row}", [-1750, y - 550, -1050, -650, y + 550, -1000], 'blind', rep=(2, 2400, 0, 0)),
                  PR(f"Pedestal {row}", crect(-1400, y - 200, -1000, y + 200, 15), -600, 300, 'conc', rep=(2, 2400, 0, 0)),
                  B(f"Base Plate {row}", [-1350, y - 150, 300, -1050, y + 150, 320], 'galv', lod='f', rep=(2, 2400, 0, 0)),
                  CZ(f"HD Bolt {row} A", [-1300, y - 100], 10, 320, 380, 'galv', lod='f', rep=(2, 2400, 0, 0), seg=10),
                  CZ(f"HD Bolt {row} B", [-1100, y + 100], 10, 320, 380, 'galv', lod='f', rep=(2, 2400, 0, 0), seg=10)]
    parts += [B("Ground Beam Front", [-1000, -1315, -400, 1000, -1085, 0], 'conc'), B("Ground Beam Back", [-1000, 1085, -400, 1000, 1315, 0], 'conc'),
              B("Ground Beam Left", [-1315, -1000, -400, -1085, 1000, 0], 'conc'), B("Ground Beam Right", [1085, -1000, -400, 1315, 1000, 0], 'conc')]
    prod('FMC_S_StrFoundation_Base_TankStand', 'Foundation for a steel water-tank tower: four pads with pedestals tied by ground beams, base plates and holding-down bolts', 'IfcFooting',
         [{"name": "3x3_RC", "desc": "base for a 3 x 3 m tower (legs at 2.4 m)"}, {"name": "4x4_RC", "desc": "base for a 4 x 4 m tower"}], parts,
         {"Legs at 2400 mm centres (geometry)": A(2400, "matches FMC_S_GenericModel_TankStand_Steel"), "Pads 1000 x 1000 x 400 mm at 1000 deep": A("1000x1000x400", ENG),
          "Pedestals 400 x 400, 300 above ground": A("400x400 +300", ENG), "Ground beams 230 x 400 mm": A("230x400", ENG)},
         "Ground at z = 0: four pads on blinding, chamfered pedestals 300 above ground, tie beams, base plates and two HD bolts per leg (Fine). Tank mass (water full) to the engineer.")

# ================================================================ GENERIC STRUCTURAL ITEMS
def lift_pit():
    parts = walls4("Pit Wall", -1000, -1550, 1000, 1550, 200, -1500, 0, 'conc')
    parts += [B("Pit Slab A", [-1000, -750, -1800, 1000, 1550, -1500], 'conc'), B("Pit Slab B", [-1000, -1550, -1800, 200, -750, -1500], 'conc'),
              B("Pit Slab C", [800, -1350, -1800, 1000, -750, -1500], 'conc'), B("Pit Slab D", [200, -1550, -1800, 1000, -1350, -1500], 'conc'),
              B("Sump Base", [0, -1550, -2100, 1000, -550, -1800], 'conc'), B("Blinding", [-1050, -1600, -1850, 1050, 1600, -1800], 'blind'),
              B("Sump Grating", [200, -1350, -1530, 800, -750, -1500], 'galv'),
              B("Grating Bar", [215, -1350, -1500, 225, -750, -1497], 'galv', lod='f', rep=(10, 60, 0, 0)),
              B("Car Buffer Plinth", [-550, 0, -1500, -150, 400, -1200], 'conc', rep=(2, 700, 0, 0)),
              B("Counterweight Buffer Plinth", [-200, 900, -1500, 200, 1300, -1150], 'conc'),
              B("Ladder Bracket", [-800, -210, -1300, -650, -190, -1280], 'galv', lod='f', rep=(2, 0, 400, 0)),
              B("Ladder Bracket Top", [-800, -210, -150, -650, -190, -130], 'galv', lod='f', rep=(2, 0, 400, 0))]
    parts += ladder("Pit Ladder", -660, -200, 200, -1500, 0, n=4)
    prod('FMC_S_GenericModel_LiftPit', 'Reinforced concrete lift pit with sump and grating, buffer plinths and pit ladder', 'IfcBuildingElementProxy',
         ["1600x2700_Pit"], parts,
         {"Clear pit 1600 x 2700 mm": A("1600x2700", "lift supplier GA; confirm"), "Pit depth 1500 mm": A(1500, "lift supplier (BS EN 81-20 refuge space); confirm"),
          "Walls 200, base 300 mm, waterproof concrete": A("200/300", ENG), "Sump 600 x 600 x 300 mm": A("600x600x300", "typical practice")},
         "Pit open at the lowest landing (z = 0): four walls, base built round a corner sump, sump base and grating with bars, two car buffer plinths and a counterweight plinth, galvanised pit ladder with wall brackets. Tanking by the waterproofing specialist.")

def cast_in_channel():
    parts = [RT("Channel", strut(0, 0), -500, 500, 'galv'),
             RT("Foam Filler", [[-11, 0.5], [11, 0.5], [11, 37], [-11, 37]], -497, 497, 'yellow', lod='f'),
             RT("End Cap Left", [[-21, 0], [21, 0], [21, 41], [-21, 41]], -503, -500, 'red', lod='f'), RT("End Cap Right", [[-21, 0], [21, 0], [21, 41], [-21, 41]], 500, 503, 'red', lod='f'),
             CZ("Anchor Stem", [-450, 0], 5, 41, 120, 'galv', rep=(5, 225, 0, 0), seg=12), CZ("Anchor Head", [-450, 0], 12, 120, 126, 'galv', rep=(5, 225, 0, 0), seg=16)]
    for i, x in enumerate((-200, 200)):
        parts += [CZ(f"T-Bolt {i + 1}", [x, 0], 6, -45, 0, 'ss', lod='f', seg=12), PR(f"T-Bolt Nut {i + 1}", hexp(x, 0, 19), -25, -15, 'ss', lod='f'),
                  B(f"T-Bolt Washer {i + 1}", [x - 15, -15, -15, x + 15, 15, -12], 'ss', lod='f')]
    prod('FMC_S_GenericModel_CastInChannel', 'Cast-in anchor channel for pendants and services, 41 x 41, galvanised, with I-anchors, foam filler, end caps and T-bolts', 'IfcDiscreteAccessory',
         ["41x41_CastIn"], parts,
         {"Channel 41 x 41 mm, 1000 long": A("41x41x1000", "typical cast-in channel"), "Anchors at 225 mm": A(225, "typical"),
          "Load class from the channel supplier": A("supplier", "supplier ETA data; engineer to confirm")},
         "Slab soffit at z = 0: channel cast up into the slab with its slot flush at the soffit, foam filler in the slot, end caps, five I-anchors, two T-bolts with nuts and washers below (Fine).")

def embed_plate():
    parts = [FB("Plate", [-100, 0, 0, 100, 12, 200], 'steel'),
             CY("Stud Low", [-60, 40], 8, 12, 112, 'steel', rep=(2, 120, 0, 0), seg=12), CY("Stud High", [-60, 160], 8, 12, 112, 'steel', rep=(2, 120, 0, 0), seg=12),
             CY("Stud Head Low", [-60, 40], 16, 112, 122, 'steel', rep=(2, 120, 0, 0), seg=16), CY("Stud Head High", [-60, 160], 16, 112, 122, 'steel', rep=(2, 120, 0, 0), seg=16),
             CY("Weld Collar Low", [-60, 40], 11, 12, 16, 'steel', lod='f', rep=(2, 120, 0, 0), seg=16), CY("Weld Collar High", [-60, 160], 11, 12, 16, 'steel', lod='f', rep=(2, 120, 0, 0), seg=16),
             FB("Centre Mark", [-1, -0.5, 20, 1, 0, 180], 'white', lod='f'), FB("Centre Mark H", [-80, -0.5, 99, 80, 0, 101], 'white', lod='f')]
    prod('FMC_S_GenericModel_Embed_Plate', 'Cast-in steel plate with four headed shear studs, face flush with the concrete', 'IfcPlate',
         [{"name": "200x200_Plate", "desc": "embed plate 200 x 200 x 12, 4 studs"}, {"name": "300x300_Plate", "desc": "embed plate 300 x 300 x 15, 4 studs"}], parts,
         {"Plate 200 x 200 x 12 mm (geometry)": A("200x200x12", ENG), "Studs 4 x 16 dia x 100": A("4x16x100", ENG), "Load from the attached item": A("by others", "engineer to confirm")},
         "Face at y = 0 flush with the concrete face; studs run back into the concrete (+y): plate, four headed studs with weld collars, centre marks (Fine).")

def movement_joint():
    L = 1000
    parts = [B("Filler Board", [-L / 2, -10, -150, L / 2, 10, -30], 'filler'), CX("Backer Rod", [0, -22], 9, -L / 2, L / 2, 'rubber', seg=12),
             B("Frame Left", [-L / 2, -60, -10, L / 2, -10, 0], 'alu'), B("Frame Right", [-L / 2, 10, -10, L / 2, 60, 0], 'alu'),
             B("Anchor Leg Left", [-L / 2, -60, -50, L / 2, -55, -10], 'alu'), B("Anchor Leg Right", [-L / 2, 55, -50, L / 2, 60, -10], 'alu'),
             B("Rubber Insert", [-L / 2, -10, -12, L / 2, 10, 0], 'rubber'),
             CZ("Screw Left", [-400, -35], 4, 0, 1, 'ss', lod='f', rep=(4, 266, 0, 0), seg=10), CZ("Screw Right", [-400, 35], 4, 0, 1, 'ss', lod='f', rep=(4, 266, 0, 0), seg=10),
             CY("Dowel", [-300, -90], 10, -250, 250, 'rebar', lod='f', rep=(3, 300, 0, 0), seg=12),
             CY("Dowel Sleeve", [-300, -90], 13, 10, 260, 'grey', lod='f', rep=(3, 300, 0, 0), seg=12)]
    prod('FMC_S_GenericModel_MovementJoint_Slab', 'Slab movement joint: fibreboard filler, backer rod, flush aluminium floor joint cover with rubber insert, sleeved dowels', 'IfcBuildingElementProxy',
         [{"name": "20_Joint", "desc": "20 mm joint"}, {"name": "30_Joint", "desc": "30 mm joint"}], parts,
         {"Joint width 20 mm (geometry)": A(20, ENG), "Cover 120 mm wide, flush": A(120, "typical hospital floor joint cover; cleanable"),
          "Dowels 20 dia at 300, 500 long": A("20 at 300", ENG)},
         "Floor at z = 0, joint along x: filler board and backer rod in the gap, flush aluminium cover frames with anchor legs and screws, rubber insert, sleeved dowels across the joint (Fine). Shown 1000 long.")

def tank_stand():
    H, a = 3000, 1200
    parts = [B("Leg Front", [-a - 50, -a - 50, 15, -a + 50, -a + 50, H], 'galv', rep=(2, 2 * a, 0, 0)),
             B("Leg Back", [-a - 50, a - 50, 15, -a + 50, a + 50, H], 'galv', rep=(2, 2 * a, 0, 0)),
             B("Base Plate Front", [-a - 125, -a - 125, 0, -a + 125, -a + 125, 15], 'galv', rep=(2, 2 * a, 0, 0)),
             B("Base Plate Back", [-a - 125, a - 125, 0, -a + 125, a + 125, 15], 'galv', rep=(2, 2 * a, 0, 0)),
             B("Mid Rail X", [-a + 50, -a - 40, 1460, a - 50, -a + 40, 1540], 'galv', rep=(2, 0, 2 * a, 0)),
             B("Mid Rail Y", [-a - 40, -a + 50, 1460, -a + 40, a - 50, 1540], 'galv', rep=(2, 2 * a, 0, 0)),
             B("Ring Beam X", [-a - 50, -a - 37, H - 150, a + 50, -a + 37, H], 'galv', rep=(2, 0, 2 * a, 0)),
             B("Ring Beam Y", [-a - 37, -a + 50, H - 150, -a + 37, a - 50, H], 'galv', rep=(2, 2 * a, 0, 0)),
             B("Deck Joist", [-1000 - 25, -a + 37, H - 100, -1000 + 25, a - 37, H], 'galv', rep=(5, 500, 0, 0)),
             B("Deck Plate", [-a - 50, -a - 50, H, a + 50, a + 50, H + 6], 'galv')]
    for z0, z1, bay in ((15, 1460, "Lower"), (1540, H - 150, "Upper")):
        x0, x1 = -a + 50, a - 50
        parts.append(FR(f"Brace X {bay} A", [[x0, z0], [x0 + 90, z0], [x1, z1], [x1 - 90, z1]], -a - 12, -a - 4, 'galv', rep=(2, 0, 2 * a + 16, 0)))
        parts.append(FR(f"Brace X {bay} B", [[x1, z0], [x1 - 90, z0], [x0, z1], [x0 + 90, z1]], -a - 4, -a + 4, 'galv', rep=(2, 0, 2 * a, 0)))
        parts.append(RT(f"Brace Y {bay} A", [[x0, z0], [x0 + 90, z0], [x1, z1], [x1 - 90, z1]], -a - 12, -a - 4, 'galv', rep=(2, 2 * a + 16, 0, 0)))
        parts.append(RT(f"Brace Y {bay} B", [[x1, z0], [x1 - 90, z0], [x0, z1], [x0 + 90, z1]], -a - 4, -a + 4, 'galv', rep=(2, 2 * a, 0, 0)))
    parts += [B("Ladder Stile Left", [-210, -a - 160, 0, -190, -a - 140, H + 1000], 'galv'), B("Ladder Stile Right", [190, -a - 160, 0, 210, -a - 140, H + 1000], 'galv'),
              CX("Ladder Rung", [-a - 150, 300], 10, -190, 190, 'galv', rep=(13, 0, 0, 300), seg=10),
              B("Ladder Bracket", [-200, -a - 150, 1480, 200, -a - 40, 1520], 'galv', lod='f', rep=(2, 0, 0, 1400)),
              CZ("Guard Post", [-a - 30, -a - 30], 20, H + 6, H + 1100, 'galv', rep=(2, 2 * a + 60, 0, 0), seg=12),
              CZ("Guard Post Back", [-a - 30, a + 30], 20, H + 6, H + 1100, 'galv', rep=(2, 2 * a + 60, 0, 0), seg=12),
              CX("Guard Rail X", [-a - 30, H + 1080], 20, -a - 30, a + 30, 'galv', rep=(2, 0, 2 * a + 60, 0), seg=12),
              CY("Guard Rail Y", [-a - 30, H + 1080], 20, -a - 30, a + 30, 'galv', rep=(2, 2 * a + 60, 0, 0), seg=12)]
    prod('FMC_S_GenericModel_TankStand_Steel', 'Galvanised steel water-tank tower: four SHS legs, X-braced in two bays, channel ring beam, joists and chequer-plate deck, ladder and guard rail', 'IfcBuildingElementProxy',
         [{"name": "3m_Tower", "desc": "tank tower, deck at 3.0 m"}, {"name": "6m_Tower", "desc": "tank tower, deck at 6.0 m"}], parts,
         {"Legs at 2400 mm centres, deck 2500 square": A("2400 / 2500", "typical 10 000 L tank tower; engineer to confirm"), "Deck at 3000 mm (geometry)": A(3000, ENG),
          "Legs SHS 100 x 100, braces 60 x 8 flat": A("SHS100 / FL60x8", ENG), "Design load: tank full of water": A("by engineer", "engineer to confirm")},
         "Tower standing on its base (FMC_S_StrFoundation_Base_TankStand): legs on base plates, mid rails, flat-bar X bracing on all four faces in two bays, ring beam, five deck joists, deck plate, front ladder rising 1 m above the deck, corner posts and guard rail.")

def base_plate():
    parts = [B("Grout", [-160, -160, 0, 160, 160, 30], 'mortar'), B("Plate", [-150, -150, 30, 150, 150, 50], 'steel'),
             CZ("Grout Hole", [0, 0], 25, 50, 50.6, 'black', lod='f'), B("Shear Key", [-50, -50, -100, 50, 50, 30], 'steel', lod='f')]
    for row, y in (("Front", -100), ("Back", 100)):
        parts += [CZ(f"Anchor Bolt {row}", [-100, y], 10, -400, 110, 'galv', rep=(2, 200, 0, 0), seg=12),
                  B(f"Plate Washer {row}", [-125, y - 25, 50, -75, y + 25, 56], 'galv', lod='f', rep=(2, 200, 0, 0)),
                  PR(f"Nut {row}", hexp(-100, y, 30), 56, 72, 'galv', lod='f', rep=(2, 200, 0, 0)),
                  B(f"Anchor Plate {row}", [-140, y - 40, -400, -60, y + 40, -390], 'steel', lod='f', rep=(2, 200, 0, 0))]
    prod('FMC_S_StrConnection_BasePlate', 'Column base plate connection: plate on grout with a shear key, four cast-in anchor bolts with anchor plates, plate washers and nuts', 'IfcPlate',
         [{"name": "300x300_BasePlate", "desc": "300 x 300 x 20, 4 x M20"}, {"name": "400x400_BasePlate", "desc": "400 x 400 x 25, 4 x M24"}], parts,
         {"Plate 300 x 300 x 20 mm (geometry)": A("300x300x20", ENG), "Anchors 4 x M20, 400 embedment": A("4xM20x400", ENG), "Grout 30 mm non-shrink": A(30, "typical practice")},
         "Top of concrete at z = 0: grout bed, plate with grout hole, shear key, anchor bolts cast into the concrete with anchor plates, plate washers and nuts (Fine). The column is a separate family.")

def fin_plate():
    parts = [FB("Fin Plate", [0, -5, -200, 100, 5, 0], 'steel'),
             PR("Weld Front", [[0, -5], [0, -13], [8, -5]], -200, 0, 'steel', lod='f'), PR("Weld Back", [[0, 5], [8, 5], [0, 13]], -200, 0, 'steel', lod='f'),
             FR("Bolt Head", hexp(55, -40, 30), -18, -5, 'galv', rep=(3, 0, 0, -60)),
             CY("Washer", [55, -40], 18, 5, 8, 'galv', lod='f', rep=(3, 0, 0, -60), seg=16),
             FR("Nut", hexp(55, -40, 30), 8, 24, 'galv', rep=(3, 0, 0, -60)),
             CY("Thread End", [55, -40], 10, 24, 32, 'galv', lod='f', rep=(3, 0, 0, -60), seg=12)]
    prod('FMC_S_StrConnection_FinPlate', 'Beam fin plate, 10 mm, fillet-welded to the support, three M20 bolts with washers and nuts', 'IfcPlate',
         ["100x200_Fin"], parts,
         {"Fin plate 100 x 200 x 10 mm": A("100x200x10", ENG), "Bolts 3 x M20 8.8 at 60 mm": A("3xM20 8.8", ENG), "Fillet welds 8 mm both sides": A(8, ENG)},
         "Support face at x = 0, top at z = 0: fin plate with fillet welds both sides, three bolts with heads, washers, nuts and thread ends (Fine). The beam web sits against the plate on +y.")

def rad_sleeve():
    r = 50
    parts = [T("Sleeve Tube", 'y', [0, 0], ring(r, r + 4, -140, 140), 'gi', seg=32), T("Lead Lining", 'y', [0, 0], ring(r + 4, r + 7, -115, 115), 'lead', seg=32),
             T("Lead Collar Front", 'y', [0, 0], ring(r + 4, r + 60, -118, -115), 'lead', seg=32), T("Lead Collar Back", 'y', [0, 0], ring(r + 4, r + 60, 115, 118), 'lead', seg=32),
             T("Sealant Ring Front", 'y', [0, 0], ring(r + 4, r + 12, -124, -118), 'black', lod='f', seg=32), T("Sealant Ring Back", 'y', [0, 0], ring(r + 4, r + 12, 118, 124), 'black', lod='f', seg=32),
             FB("Radiation Label", [-30, -119.5, r + 64, 30, -118, r + 94], 'yellow', lod='f')]
    prod('FMC_S_GenericModel_Opening_RadiationShielded_Sleeve', 'Lead-lined through-wall sleeve for a shielded room: steel sleeve, lead lining and lapping collars on both faces, sealant and warning label', 'IfcBuildingElementProxy',
         [{"name": "100dia_Lead", "desc": "100 mm bore sleeve"}, {"name": "150dia_Lead", "desc": "150 mm bore sleeve"}], parts,
         {"Bore 100 mm (geometry)": A(100, "service size"), "Lead code and lap from the RPA shielding report": A("RPA report", "radiation protection adviser; not decided here"),
          "Collar lap 60 mm beyond sleeve": A(60, "typical; RPA to confirm"), "Wall 230 mm (sleeve 280 long)": A(230, "typical wall")},
         "Wall centred on y = 0 (230 thick), sleeve axis along y: steel sleeve, lead lining, collars lapping the wall lead on both faces, sealant rings and a radiation label (Fine). Lead thickness is the RPA's decision.")

# ================================================================ DRAINAGE STRUCTURES
def benching_halves(r, w, z0, z1, mat):
    a0 = math.asin(w / r); pts = [[round(r * math.cos(t), 1), round(r * math.sin(t), 1)] for t in [a0 + (math.pi - 2 * a0) * k / 12 for k in range(13)]]
    return [PR("Benching Back", pts, z0, z1, mat), PR("Benching Front", [[x, -y] for x, y in reversed(pts)], z0, z1, mat)]

def manhole_precast():
    ri, ro = 525, 625
    parts = cover("Access", 0, 0, 600, 600, 0, ribs=5)
    parts += [B("Adjustment Course Front", [-400, -400, -250, 400, -300, -100], 'brick'), B("Adjustment Course Back", [-400, 300, -250, 400, 400, -100], 'brick'),
              B("Adjustment Course Left", [-400, -300, -250, -300, 300, -100], 'brick'), B("Adjustment Course Right", [300, -300, -250, 400, 300, -100], 'brick'),
              CZ("Cover Slab", [0, 0], 700, -400, -250, 'pre', seg=48), B("Access Opening", [-300, -300, -401, 300, 300, -249], 'pre', void=True),
              T("Chamber Ring", 'z', [0, 0], ring(ri, ro, -900, -400), 'pre', rep=(2, 0, 0, -500), seg=48),
              T("Base Unit", 'z', [0, 0], [[0, -2050], [ro, -2050], [ro, -1400], [ri, -1400], [ri, -1900], [0, -1900]], 'pre', seg=48),
              B("Channel", [-ri, -75, -1900, ri, 75, -1830], 'pre')]
    parts += benching_halves(ri, 75, -1900, -1720, 'pre')
    parts += [B("Step Iron", [-150, 395, -700, 150, 415, -680], 'galv', lod='f', rep=(4, 0, 0, -300)),
              B("Step Iron Leg L", [-150, 415, -700, -130, ri, -680], 'galv', lod='f', rep=(4, 0, 0, -300)),
              B("Step Iron Leg R", [130, 415, -700, 150, ri, -680], 'galv', lod='f', rep=(4, 0, 0, -300)),
              CX("Inlet Pipe", [0, -1820], 80, -950, -ri + 10, 'upvc'), CX("Outlet Pipe", [0, -1845], 80, ri - 10, 950, 'upvc')]
    prod('FMC_C_Structure_Manhole_Precast', 'Precast concrete inspection chamber: base unit with benching and channel, chamber rings, cover slab, brick adjustment course, ductile-iron cover and frame', 'IfcDistributionChamberElement',
         [{"name": "1050dia_Precast", "desc": "1050 internal diameter"}, {"name": "1200dia_Precast", "desc": "1200 internal diameter"}], parts,
         {"Internal diameter 1050 mm (geometry)": A(1050, "typical precast ring (BS EN 1917)"), "Depth to invert 1900 mm shown": A(1900, "depth from the drainage design"),
          "Cover 600 x 600 D400 near roads": A("600x600 D400", "BS EN 124; class by location"), "Pipes 160 mm uPVC": A(160, "drainage design")},
         "Ground at z = 0: cover and frame with pattern and keyholes, brick adjustment course, cover slab with opening, two rings, base unit with half-round channel and benching, four step irons (Fine), inlet and outlet pipe stubs with connectors.",
         conns=[san("SAN In", "Inlet Pipe", "left", 160, "In"), san("SAN Out", "Outlet Pipe", "right", 160, "Out")])

def manhole_brick():
    parts = cover("Access", 0, -150, 600, 450, 0, ribs=4)
    parts += [B("Cover Slab", [-530, -680, -230, 530, 680, -100], 'conc'), B("Access Opening", [-300, -375, -231, 300, 75, -99], 'conc', void=True)]
    parts += walls4("Chamber Wall", -530, -680, 530, 680, 230, -1430, -230, 'brick')
    parts += [B("Base Slab", [-630, -780, -1580, 630, 780, -1430], 'conc'), B("Channel", [-75, -450, -1430, 75, 450, -1370], 'conc'),
              B("Benching Left", [-300, -450, -1430, -75, 450, -1260], 'conc'), B("Benching Right", [75, -450, -1430, 300, 450, -1260], 'conc'),
              B("Step Iron", [-150, -450, -600, 150, -430, -580], 'galv', lod='f', rep=(3, 0, 0, -300)),
              CY("Inlet Pipe", [0, -1350], 80, -950, -440, 'upvc'), CY("Outlet Pipe", [0, -1365], 80, 440, 950, 'upvc')]
    prod('FMC_C_Structure_Manhole_Brick', 'Brick inspection chamber, one-brick walls on a concrete base, benching and channel, RC cover slab, ductile-iron cover and frame', 'IfcDistributionChamberElement',
         [{"name": "600x900_Brick", "desc": "internal 600 x 900"}, {"name": "900x1200_Brick", "desc": "internal 900 x 1200"}], parts,
         {"Internal 600 x 900 mm (geometry)": A("600x900", "typical shallow chamber"), "Walls 230 mm burnt clay brick in 1:4": A(230, "typical Uganda practice"),
          "Depth 1200 mm to benching": A(1200, "drainage design"), "Cover 600 x 450 B125": A("600x450 B125", "BS EN 124; footway")},
         "Ground at z = 0: cover and frame over an opening in the RC cover slab, four brick walls, base slab, channel and benching, step irons (Fine), pipe stubs along y with connectors.",
         conns=[san("SAN In", "Inlet Pipe", "front", 160, "In"), san("SAN Out", "Outlet Pipe", "back", 160, "Out")])

def catchpit():
    parts = walls4("Pit Wall", -600, -600, 600, 600, 150, -1200, 0, 'conc')
    parts += [B("Base", [-650, -650, -1350, 650, 650, -1200], 'conc'),
              B("Frame Angle Front", [-450, -450, -50, 450, -400, 0], 'galv'), B("Frame Angle Back", [-450, 400, -50, 450, 450, 0], 'galv'),
              B("Frame Angle Left", [-450, -400, -50, -400, 400, 0], 'galv'), B("Frame Angle Right", [400, -400, -50, 450, 400, 0], 'galv'),
              B("Grating Bar", [-397, -400, -40, -392, 400, 0], 'galv', rep=(17, 49, 0, 0)),
              B("Grating Cross Rod", [-400, -305, -8, 400, -297, 0], 'galv', lod='f', rep=(3, 0, 300, 0))]
    U = [[-225, -375], [225, -375], [225, 0], [150, 0], [150, -300], [-150, -300], [-150, 0], [-225, 0]]
    parts += [RT("Inlet Channel Left", U, -1200, -600, 'pre'), FR("Inlet Channel Front", U, -1200, -600, 'pre'),
              CX("Outlet Pipe", [0, -700], 100, 590, 950, 'upvc')]
    prod('FMC_C_Structure_Catchpit_Stormwater', 'Stormwater catch pit with silt trap, galvanised bar grating on angle frame, U-channel inlets and outlet pipe', 'IfcDistributionChamberElement',
         ["900x900_Catchpit"], parts,
         {"Internal 900 x 900 mm": A("900x900", "typical"), "Silt trap 500 mm below outlet invert": A(500, "typical practice"),
          "Grating 40 x 5 bars at 49 mm": A("40x5 at 49", "typical bar grating; load class by location"), "Outlet 200 mm": A(200, "drainage design")},
         "Ground at z = 0: concrete walls and base, galvanised angle frame, 17 bearing bars and cross rods, two precast U-channel inlets, outlet pipe stub with connector; the silt trap is the depth below the outlet.",
         conns=[san("SAN Out", "Outlet Pipe", "right", 200, "Out")])

def gully():
    parts = [T("Gully Pot", 'z', [0, 0], [[0, -900], [265, -900], [265, -150], [225, -150], [225, -860], [0, -860]], 'pre', seg=40),
             CZ("Concrete Bed", [0, 0], 400, -1050, -900, 'c20', seg=40), T("Concrete Haunch", 'z', [0, 0], ring(265, 420, -300, -150), 'c20', seg=40),
             B("Seating Front", [-300, -300, -150, 300, -230, -100], 'brick'), B("Seating Back", [-300, 230, -150, 300, 300, -100], 'brick'),
             B("Seating Left", [-300, -230, -150, -230, 230, -100], 'brick'), B("Seating Right", [230, -230, -150, 300, 230, -100], 'brick'),
             B("Frame Front", [-280, -280, -100, 280, -225, 0], 'ci'), B("Frame Back", [-280, 225, -100, 280, 280, 0], 'ci'),
             B("Frame Left", [-280, -225, -100, -225, 225, 0], 'ci'), B("Frame Right", [225, -225, -100, 280, 225, 0], 'ci'),
             B("Grating Bar", [-220, -220, -40, -200, 220, 0.5], 'ci', rep=(9, 52, 0, 0)), B("Grating Rim", [-222, -222, -40, 222, -205, 0.5], 'ci'),
             B("Grating Rim Back", [-222, 205, -40, 222, 222, 0.5], 'ci'), B("Hinge Lug", [-150, 222, -30, -100, 240, 0], 'ci', lod='f', rep=(2, 250, 0, 0)),
             CX("Outlet Pipe", [0, -450], 75, 255, 600, 'upvc'), CZ("Rodding Stopper", [180, 0], 35, -470, -430, 'rubber', lod='f')]
    prod('FMC_C_Structure_Gully_Trapped', 'Trapped road gully: precast gully pot on concrete bed with haunch, brick seating, ductile-iron hinged grating and frame, 150 outlet', 'IfcDistributionChamberElement',
         ["450x450_Trapped"], parts,
         {"Gully pot 450 dia x 750 deep": A("450x750", "typical precast road gully (BS 5911-6)"), "Grating 450 x 450 D400": A("450x450 D400", "BS EN 124; carriageway"),
          "Outlet 150 mm, trap seal 85 mm": A("150 / 85", "typical")},
         "Road surface at z = 0: frame (four bars), slotted grating with rims and hinge lugs, brick seating course, gully pot, concrete bed and haunch, rodding stopper (Fine), outlet stub with connector.",
         conns=[san("SAN Out", "Outlet Pipe", "right", 150, "Out")])

def septic():
    parts = [B("Base Slab", [-2100, -1100, -2500, 2100, 1100, -2250], 'conc')] + walls4("Tank Wall", -2000, -1000, 2000, 1000, 200, -2250, -200, 'conc')
    parts += [B("Baffle Wall", [600, -800, -2250, 750, 800, -500], 'conc'), B("Roof Slab", [-2000, -1000, -200, 2000, 1000, 0], 'conc'),
              B("Access Shaft 1", [-1650, -450, 0, -750, 450, 150], 'conc'), B("Access Shaft 2", [750, -450, 0, 1650, 450, 150], 'conc')]
    parts += [B("Shaft Opening 1", [-1500, -300, -201, -900, 300, 150], 'conc', void=True), B("Shaft Opening 2", [900, -300, -201, 1500, 300, 150], 'conc', void=True)]
    parts += cover("Cover 1", -1200, 0, 600, 600, 250, ribs=4) + cover("Cover 2", 1200, 0, 600, 600, 250, ribs=4)
    parts += [CZ("Vent Pipe", [1800, 800], 55, 0, 2500, 'upvc', seg=16), T("Vent Cowl", 'z', [1800, 800], [[0, 2480], [55, 2480], [110, 2560], [110, 2600], [0, 2640]], 'upvc', seg=16),
              CX("Inlet Pipe", [0, -500], 80, -2400, -1990, 'upvc'), CX("Outlet Pipe", [0, -575], 80, 1990, 2400, 'upvc'),
              CZ("Inlet Dip Tee", [-1700, 0], 80, -1200, -400, 'upvc', lod='f', seg=16), CZ("Outlet Dip Tee", [1700, 0], 80, -1200, -400, 'upvc', lod='f', seg=16)]
    prod('FMC_C_Structure_SepticTank_MultiChamber', 'Two-chamber reinforced concrete septic tank with baffle wall, roof slab, raised access shafts with covers, dip tees and vent', 'IfcTank',
         [{"name": "10m3_RC", "desc": "about 10 m3"}, {"name": "20m3_RC", "desc": "about 20 m3"}, {"name": "40m3_RC", "desc": "about 40 m3"}], parts,
         {"Internal 3600 x 1600 x 2050 mm (10 m3 geometry)": A("3600x1600x2050", "sizing by the engineer (note: where no sewer)"),
          "Chamber split 2:1": A("2:1", "typical practice"), "Walls 200, base 250, roof 200 mm": A("200/250/200", ENG), "Vent 110 mm to 2.5 m": A(110, "typical")},
         "Ground at z = 0 at roof level: base, walls, baffle (gap at the top), roof slab, two raised access shafts with covers, inlet and outlet dip tees (Fine), pipe stubs with connectors, vent pipe with cowl. Size by the engineer.",
         conns=[san("SAN In", "Inlet Pipe", "left", 160, "In"), san("SAN Out", "Outlet Pipe", "right", 160, "Out")])

def soakpit():
    ri, ro = 1000, 1230
    parts = [CZ("Gravel Base", [0, 0], 1300, -3700, -3400, 'stone', seg=48),
             T("Honeycomb Course", 'z', [0, 0], ring(ri, ro, -3400, -3250), 'brick', rep=(10, 0, 0, 250), seg=48),
             T("Solid Collar", 'z', [0, 0], ring(ri, ro, -900, -400), 'brick', seg=48), T("Ring Beam", 'z', [0, 0], ring(ri - 20, ro + 50, -400, -210), 'conc', seg=48),
             CZ("Cover Slab", [0, 0], 1300, -210, -60, 'conc', seg=48), CZ("Access Opening", [0, 0], 300, -211, -59, 'conc', void=True)]
    parts += round_cover("Access", 0, 0, 300, 0)
    parts[-4]['profile'] = ring(300, 380, -60, 0)
    parts += [CX("Inlet Pipe", [0, -650], 80, -1600, -ri - 20, 'upvc')]
    prod('FMC_C_Structure_Soakpit', 'Soak pit lined with honeycomb (open-jointed) brickwork on a gravel base, solid top collar, RC ring beam and cover slab with access cover', 'IfcDistributionChamberElement',
         ["2000dia_Honeycomb"], parts,
         {"Internal diameter 2000 mm": A(2000, "typical"), "Effective depth 2500 mm": A(2500, "percolation test and engineer"),
          "Lining 230 mm honeycomb brick": A(230, "typical Uganda practice"), "Cover slab 150 mm RC": A(150, ENG)},
         "Ground at z = 0: round cover and frame, RC cover slab with opening, ring beam, solid brick collar, ten honeycomb courses with open bands, gravel base, inlet pipe stub with connector.",
         conns=[san("SAN In", "Inlet Pipe", "left", 160, "In")])

def wwtp():
    L2, W2 = 4500, 1200
    parts = [B("Plinth", [-4800, -1500, 0, 6300, 1500, 300], 'conc'), B("Tank Body", [-L2, -W2, 300, L2, W2, 2900], 'paint'),
             B("Rib Front", [-4030, -W2 - 25, 300, -3970, -W2, 2900], 'paint', lod='f', rep=(9, 1000, 0, 0)),
             B("Rib Back", [-4030, W2, 300, -3970, W2 + 25, 2900], 'paint', lod='f', rep=(9, 1000, 0, 0)),
             B("Walkway Grating", [-4400, -400, 2900, 4400, 400, 2940], 'galv'),
             CZ("Rail Post Front", [-4000, -400], 20, 2940, 4040, 'galv', rep=(5, 2000, 0, 0), seg=12),
             CZ("Rail Post Back", [-4000, 400], 20, 2940, 4040, 'galv', rep=(5, 2000, 0, 0), seg=12),
             CX("Top Rail", [-400, 4020], 20, -4000, 4000, 'galv', rep=(2, 0, 800, 0), seg=12),
             CX("Knee Rail", [-400, 3500], 15, -4000, 4000, 'galv', lod='f', rep=(2, 0, 800, 0), seg=12),
             B("Access Hatch", [-3400, -1050, 2900, -2600, -500, 2930], 'galv', rep=(4, 2000, 0, 0)),
             B("Blower Kiosk", [4600, -1000, 300, 6100, 1000, 2500], 'epoxy'), B("Kiosk Roof", [4550, -1050, 2500, 6150, 1050, 2560], 'epoxy'),
             FB("Kiosk Louvre", [5300, -1010, 1800, 5950, -1000, 1840], 'grey', lod='f', rep=(5, 0, 0, -80)),
             FB("Control Panel", [4700, -1060, 900, 5200, -1000, 1900], 'grey'), FB("Panel Handle", [5150, -1075, 1350, 5170, -1060, 1450], 'black', lod='f'),
             CY("Panel Lamp Green", [4800, 1800], 10, -1066, -1060, 'ledg', lod='f', seg=12), CY("Panel Lamp Red", [4840, 1800], 10, -1066, -1060, 'ledr', lod='f', seg=12),
             CX("Air Main", [700, 2300], 40, 4500, 4600, 'gi', lod='f', seg=12),
             CX("Inlet Pipe", [800, 2200], 80, -4900, -4490, 'upvc'), CY("Outlet Pipe", [4000, 700], 80, -1500, -1190, 'upvc')]
    parts += ladder("Access Ladder", -4650, -250, 250, 300, 3900, n=11)
    prod('FMC_C_Structure_WWTP_Packaged', 'Packaged wastewater treatment plant for hospital effluent: containerised steel tank with walkway, handrails and hatches, blower/control kiosk, ladder, on a concrete plinth', 'IfcBuildingElementProxy',
         [{"name": "50m3d_Packaged", "desc": "50 m3/day plant envelope", "values": {"Apparent Load": 5500}},
          {"name": "100m3d_Packaged", "desc": "100 m3/day plant envelope", "values": {"Apparent Load": 9000}}], parts,
         {"Envelope 9000 x 2400 x 2600 mm on 300 plinth (50 m3/d)": A("9000x2400x2600", "typical packaged MBBR/SBR plant envelope; vendor to confirm"),
          "Supply 415 V 3-phase, 5.5 kVA (50 m3/d)": A("415V 5.5kVA", "typical blower load; vendor to confirm"), "Effluent standard from NEMA permit": A("NEMA", "by the process engineer")},
         "Plant envelope on a plinth (ground z = 0): ribbed tank body, top walkway with posts and rails, four hatches, blower/control kiosk with louvres, panel, lamps and air main (Fine), end ladder, inlet and outlet stubs with connectors; power on the panel.",
         conns=[san("SAN In", "Inlet Pipe", "left", 160, "In"), san("SAN Out", "Outlet Pipe", "front", 160, "Out"), power("Control Panel", "front")],
         tv={"Voltage": 415, "Number of Poles": 3, "Apparent Load": 5500})

def neutralisation():
    parts = walls4("Chamber Wall", -650, -650, 650, 650, 150, -1200, -150, 'conc')
    parts += [B("Base", [-700, -700, -1350, 700, 700, -1200], 'conc'), B("Cover Slab", [-650, -650, -150, 650, 650, 0], 'conc'),
              B("Access Opening", [-300, -300, -151, 300, 300, -6], 'conc', void=True),
              B("HDPE Liner Floor", [-500, -500, -1200, 500, 500, -1190], 'hdpe', lod='f'), B("Limestone Bed", [-500, -500, -1190, 500, 500, -800], 'stone', lod='f'),
              B("Baffle", [-500, 150, -1190, 500, 200, -300], 'hdpe', lod='f')]
    parts += cover("Access", 0, 0, 600, 600, 1, ribs=4)
    parts += [B("Sampling Chamber", [650, -300, -700, 1150, 300, 0], 'conc'), B("Sampling Opening", [750, -150, -701, 1050, 150, -6], 'conc', void=True)]
    parts += cover("Sampling", 900, 0, 300, 300, 1, ribs=0, frame=40)
    parts += [CX("Inlet Pipe", [0, -500], 55, -1000, -640, 'upvc'), CX("Outlet Pipe", [0, -550], 55, 1140, 1450, 'upvc'),
              CZ("Vent Pipe", [-550, 550], 28, 0, 2400, 'upvc', seg=12), T("Vent Cowl", 'z', [-550, 550], [[0, 2390], [28, 2390], [60, 2440], [0, 2470]], 'upvc', seg=12),
              FB("Chemical Warning Sign", [-640, 520, 1500, -460, 522, 1680], 'yellow', lod='f')]
    prod('FMC_C_Structure_NeutralisationPit_Lab', 'Laboratory effluent neutralisation chamber: concrete chamber with HDPE liner, limestone-chip bed and baffle, sealed cover, sampling chamber, vent', 'IfcDistributionChamberElement',
         ["1000x1000_Neutralisation"], parts,
         {"Internal 1000 x 1000 x 1050 mm": A("1000x1000x1050", "typical small lab neutralisation chamber"), "Limestone chips 400 mm bed": A(400, "typical; process engineer to confirm"),
          "Pipes 110 mm PP/uPVC, chemical resistant": A(110, "drainage design"), "Discharge standard from the NWSC trade-effluent permit": A("NWSC", "by the process engineer")},
         "Ground at z = 0: chamber walls, base and cover slab, liner, limestone bed and baffle (Fine, seen in section), cover and frame, sampling chamber with small cover on the outlet, inlet/outlet stubs with connectors, vent with cowl and warning sign.",
         conns=[san("SAN In", "Inlet Pipe", "left", 110, "In"), san("SAN Out", "Outlet Pipe", "right", 110, "Out")])

def grease_trap():
    parts = walls4("Chamber Wall", -850, -550, 850, 550, 150, -1150, -150, 'conc')
    parts += [B("Base", [-900, -600, -1300, 900, 600, -1150], 'conc'), B("Cover Slab", [-850, -550, -150, 850, 550, 0], 'conc'),
              B("Baffle", [100, -400, -1050, 175, 400, -300], 'conc', lod='mf'), B("Opening 1", [-650, -225, -151, -50, 225, -6], 'conc', void=True),
              B("Opening 2", [250, -225, -151, 650, 225, -6], 'conc', void=True)]
    parts += cover("Cover Inlet", -350, 0, 600, 450, 1, ribs=3) + cover("Cover Outlet", 450, 0, 400, 450, 1, ribs=3)
    parts += [CX("Inlet Pipe", [0, -400], 55, -1150, -840, 'upvc'), CX("Outlet Pipe", [0, -450], 55, 840, 1150, 'upvc'),
              CZ("Inlet Tee", [-650, 0], 55, -800, -350, 'upvc', lod='f', seg=16), CZ("Outlet Tee", [650, 0], 55, -900, -350, 'upvc', lod='f', seg=16)]
    prod('FMC_C_Structure_GreaseTrap_External', 'External kitchen grease trap: two-compartment precast/RC chamber with baffle, inlet and outlet tees, two access covers', 'IfcInterceptor',
         [{"name": "1000L_Precast", "desc": "about 1000 L liquid"}, {"name": "2000L_Precast", "desc": "about 2000 L liquid"}], parts,
         {"Internal 1400 x 800 x 1000 mm (1000 L geometry)": A("1400x800x1000", "sizing from kitchen flow by the engineer"), "Two compartments 2:1": A("2:1", "typical"),
          "Pipes 110 mm": A(110, "drainage design")},
         "Ground at z = 0: walls, base, cover slab with two openings, baffle, two covers and frames, inlet and outlet tees (Fine), pipe stubs with connectors.",
         conns=[san("SAN In", "Inlet Pipe", "left", 110, "In"), san("SAN Out", "Outlet Pipe", "right", 110, "Out")])

def fuel_interceptor():
    zc = -1500
    dome = [[0, -1000], [300, -980], [500, -930], [600, -850], [600, 850], [500, 930], [300, 980], [0, 1000]]
    parts = [B("Concrete Bed", [-1150, -750, zc - 750, 1150, 750, zc - 600], 'c20'), T("Separator Tank", 'x', [0, zc], dome, 'hdpe', seg=40),
             T("Tank Rib", 'x', [0, zc], ring(600, 625, -400, -340), 'hdpe', lod='f', rep=(3, 400, 0, 0), seg=40),
             CZ("Access Turret Inlet", [-600, 0], 300, zc + 550, -150, 'hdpe', seg=32), CZ("Access Turret Outlet", [600, 0], 300, zc + 550, -150, 'hdpe', seg=32),
             B("Cover Slab", [-1100, -500, -150, 1100, 500, 0], 'conc'),
             CZ("Opening Inlet", [-600, 0], 300, -151, -6, 'conc', void=True), CZ("Opening Outlet", [600, 0], 300, -151, -6, 'conc', void=True)]
    parts += round_cover("Inlet Cover", -600, 0, 300, 1) + round_cover("Outlet Cover", 600, 0, 300, 1)
    parts += [CX("Inlet Pipe", [0, -650], 75, -1400, -890, 'upvc'), CX("Outlet Pipe", [0, -700], 75, 890, 1400, 'upvc'),
              CZ("Vent Pipe", [-1000, 400], 28, 0, 2400, 'upvc', seg=12),
              CZ("Alarm Post", [1000, 400], 30, 0, 1500, 'galv', seg=12), B("Alarm Panel", [900, 340, 1500, 1100, 460, 1750], 'grey'),
              CY("Alarm Beacon", [1000, 1700], 18, 330, 340, 'ledr', lod='f', seg=12), CZ("Probe Conduit", [700, 200], 16, -900, 0, 'grey', lod='f', seg=10)]
    prod('FMC_C_Structure_Interceptor_Fuel', 'Underground Class I full-retention fuel/oil interceptor: polyethylene separator tank on a concrete bed, two access turrets with covers, oil-level alarm and vent', 'IfcInterceptor',
         ["1000L_ClassI"], parts,
         {"Nominal size 1000 L (tank 1200 dia x 2000)": A("1200x2000", "typical small Class I interceptor (BS EN 858)"), "Inlet/outlet 150 mm": A(150, "drainage design"),
          "Oil-level alarm required": A("alarm", "BS EN 858-2 / Environment Agency PPG3 practice"), "Covers 600 dia": A(600, "typical")},
         "Ground at z = 0: concrete bed, domed separator tank with ribs, two turrets through the cover slab with round covers, inlet/outlet stubs with connectors, vent, alarm post with panel and beacon, probe conduit (Fine).",
         conns=[san("SAN In", "Inlet Pipe", "left", 150, "In"), san("SAN Out", "Outlet Pipe", "right", 150, "Out")])

# ================================================================ CULVERTS AND CHANNELS
def box_culvert():
    left = [[0, 0], [-600, 0], [-600, 900], [0, 900], [0, 750], [-350, 750], [-450, 650], [-450, 250], [-350, 150], [0, 150]]
    right = [[-x, z] for x, z in reversed(left)]
    parts = [FR("Unit Left Half", left, -1515, -510, 'pre', rep=(3, 0, 1010, 0)), FR("Unit Right Half", right, -1515, -510, 'pre', rep=(3, 0, 1010, 0))]
    hw = [[-1100, 0], [-600, 0], [-600, 900], [600, 900], [600, 0], [1100, 0], [1100, 1300], [-1100, 1300]]
    parts += [FR("Headwall Inlet", hw, -1765, -1515, 'c20'), FR("Headwall Outlet", hw, 1515, 1765, 'c20'),
              PR("Wingwall Inlet Left", [[-1100, -1765], [-850, -1765], [-1550, -2465], [-1800, -2465]], 0, 1000, 'c20'),
              PR("Wingwall Inlet Right", [[850, -1765], [1100, -1765], [1800, -2465], [1550, -2465]], 0, 1000, 'c20'),
              PR("Wingwall Outlet Left", [[-1100, 1765], [-1800, 2465], [-1550, 2465], [-850, 1765]], 0, 1000, 'c20'),
              PR("Wingwall Outlet Right", [[1100, 1765], [850, 1765], [1550, 2465], [1800, 2465]], 0, 1000, 'c20'),
              PR("Apron Inlet", [[-1100, -1765], [1100, -1765], [1550, -2465], [-1550, -2465]], 0, 150, 'c20'),
              PR("Apron Outlet", [[-1100, 1765], [-1550, 2465], [1550, 2465], [1100, 1765]], 0, 150, 'c20'),
              B("Cut-off Wall Inlet", [-1550, -2465, -450, 1550, -2265, 0], 'c20'), B("Cut-off Wall Outlet", [-1550, 2265, -450, 1550, 2465, 0], 'c20'),
              PR("Stone Pitching", [[-1550, 2465], [-1900, 3300], [1900, 3300], [1550, 2465]], 0, 100, 'pitch', lod='f'),
              B("Bedding", [-650, -1515, -150, 650, 1515, 0], 'blind')]
    prod('FMC_C_Structure_Culvert_Box', 'Precast concrete box culvert units with internal haunches, concrete headwalls, splayed wingwalls, aprons with cut-off walls and stone pitching', 'IfcBuildingElementProxy',
         [{"name": "900x600_Precast", "desc": "internal 900 wide x 600 high"}, {"name": "1200x900_Precast", "desc": "internal 1200 x 900"}], parts,
         {"Internal 900 x 600, walls 150 mm (geometry)": A("900x600 t150", "typical precast box; hydraulic size by the engineer"),
          "Units 1000 long, 3 shown": A(1000, "typical precast unit"), "Wingwalls splayed 45 degrees": A(45, "typical"), "Cover and loading by the engineer": A("by engineer", "engineer to confirm")},
         "Invert slab underside at z = 0, flow along y: three precast units (two halves each, haunched inside) on bedding, headwalls, four wingwalls, aprons with cut-off walls, outlet stone pitching (Fine).")

def pipe_culvert():
    ro, zc = 375, 525
    arc = [[round(ro * math.cos(t), 1), round(zc + ro * math.sin(t), 1)] for t in [-k * math.pi / 12 for k in range(13)]]
    haunch = [[-525, 0], [525, 0], [525, zc]] + arc + [[-525, zc]]
    up = [[round(ro * math.cos(t), 1), round(zc + ro * math.sin(t), 1)] for t in [math.pi / 2 + k * math.pi / 12 for k in range(13)]]
    hl = [[0, 0], [-1100, 0], [-1100, 1300], [0, 1300]] + up + [[0, 0]]
    hl = hl[:-1]
    hr = [[-x, z] for x, z in reversed(hl)]
    parts = [T("Pipe", 'y', [0, zc], ring(300, ro, -2000, -1000), 'ogee', rep=(4, 0, 1000, 0), seg=40),
             T("Ogee Joint", 'y', [0, zc], ring(ro, ro + 25, -1050, -950), 'ogee', lod='f', rep=(3, 0, 1000, 0), seg=40),
             FR("Bed and Haunch", haunch, -2000, 2000, 'c20'),
             FR("Headwall Inlet Left", hl, -2250, -2000, 'c20'), FR("Headwall Inlet Right", hr, -2250, -2000, 'c20'),
             FR("Headwall Outlet Left", hl, 2000, 2250, 'c20'), FR("Headwall Outlet Right", hr, 2000, 2250, 'c20'),
             PR("Wingwall Inlet Left", [[-1100, -2250], [-850, -2250], [-1550, -2950], [-1800, -2950]], 0, 1000, 'c20'),
             PR("Wingwall Inlet Right", [[850, -2250], [1100, -2250], [1800, -2950], [1550, -2950]], 0, 1000, 'c20'),
             PR("Wingwall Outlet Left", [[-1100, 2250], [-1800, 2950], [-1550, 2950], [-850, 2250]], 0, 1000, 'c20'),
             PR("Wingwall Outlet Right", [[1100, 2250], [850, 2250], [1550, 2950], [1800, 2950]], 0, 1000, 'c20'),
             PR("Apron Inlet", [[-1100, -2250], [1100, -2250], [1550, -2950], [-1550, -2950]], 0, 150, 'c20'),
             PR("Apron Outlet", [[-1100, 2250], [-1550, 2950], [1550, 2950], [1100, 2250]], 0, 150, 'c20'),
             PR("Stone Pitching", [[-1550, 2950], [-1900, 3800], [1900, 3800], [1550, 2950]], 0, 100, 'pitch', lod='f')]
    prod('FMC_C_Structure_Culvert_Pipe', 'Pipe culvert of ogee-jointed concrete pipes on a concrete bed and haunch, with headwalls, splayed wingwalls, aprons and stone pitching', 'IfcBuildingElementProxy',
         [{"name": "600_Ogee", "desc": "600 mm concrete pipes"}, {"name": "900_Ogee", "desc": "900 mm concrete pipes"}], parts,
         {"Pipe 600 internal, 75 wall (geometry)": A("600 t75", "typical Uganda ogee concrete pipe; hydraulic size by the engineer"),
          "Pipes 1000 long, 4 shown": A(1000, "typical"), "Bed and haunch C20 to pipe centreline": A("C20", "typical class B bedding; engineer to confirm")},
         "Bed underside at z = 0, flow along y: four ogee pipes with joint collars (Fine), bed and haunch, headwalls in two halves round the pipe, four wingwalls, aprons, outlet pitching.")

def u_channel():
    U = [[-225, 0], [225, 0], [225, 375], [175, 375], [175, 325], [150, 325], [150, 75], [-150, 75], [-150, 325], [-175, 325], [-175, 375], [-225, 375]]
    parts = [RT("Channel Unit", U, -1500, -505, 'pre', rep=(3, 1005, 0, 0)), B("Blinding", [-1500, -275, -50, 1515, 275, 0], 'blind'),
             B("Cover Slab", [-1500, -174, 325, -1005, 174, 375], 'pre', rep=(2, 500, 0, 0)),
             B("Lifting Slot", [-1300, -60, 375, -1210, -40, 376], 'black', lod='f', rep=(2, 500, 0, 0)),
             B("Lifting Slot Back", [-1300, 40, 375, -1210, 60, 376], 'black', lod='f', rep=(2, 500, 0, 0)),
             B("Grating Frame Front", [-500, -174, 340, 505, -160, 375], 'galv'), B("Grating Frame Back", [-500, 160, 340, 505, 174, 375], 'galv'),
             B("Grating Bar", [-480, -160, 345, -475, 160, 375], 'galv', rep=(20, 50, 0, 0)),
             B("Cover Slab Far", [510, -174, 325, 1005, 174, 375], 'pre', rep=(2, 500, 0, 0))]
    prod('FMC_C_Structure_Drain_UChannel_Covered', 'Precast concrete U-channel surface drain with rebated seats, precast cover slabs with lifting slots and a galvanised grating section', 'IfcBuildingElementProxy',
         [{"name": "300_Covered", "desc": "300 mm wide channel"}, {"name": "450_Covered", "desc": "450 mm wide channel"}, {"name": "600_Covered", "desc": "600 mm wide channel"}], parts,
         {"Internal 300 x 250, walls 75 mm (geometry)": A("300x250 t75", "typical precast U-drain"), "Units 1000 long, 3 shown": A(1000, "typical"),
          "Covers 50 mm in a 25 x 50 rebate": A("50 / 25x50", "typical"), "Grating every third cover": A("1 in 3", "typical for inlets; designer to confirm")},
         "Bed at z = 0, run along x: three U units with seat rebates on blinding, four precast covers with lifting slots (Fine) and one galvanised grating section with frame and 20 bars.")

def kerb():
    S = [[-62.5, -130], [62.5, -130], [62.5, 125], [-37.5, 125], [-62.5, 100]]
    D = [[-62.5, -130], [62.5, -130], [62.5, 20], [-37.5, 20], [-62.5, -5]]
    parts = [RT("Straight Kerb", S, -1830, -920, 'kerb', rep=(2, 915, 0, 0)),
             FR("Transition Kerb", [[0, -130], [910, -130], [910, 20], [0, 125]], -62.5, 62.5, 'kerb'),
             RT("Dropped Kerb", D, 915, 1825, 'kerb'),
             B("Concrete Bed", [-1830, -150, -280, 1825, 212.5, -130], 'blind'),
             RT("Concrete Haunch", [[62.5, -130], [212.5, -130], [62.5, 20]], -1830, 1825, 'blind'),
             RT("Joint Mortar", [[-62.5, -130], [62.5, -130], [62.5, 125], [-62.5, 125]], -920, -915, 'mortar', lod='f'),
             RT("Joint Mortar 2", [[-62.5, -130], [62.5, -130], [62.5, 125], [-62.5, 125]], -5, 0, 'mortar', lod='f'),
             RT("Joint Mortar 3", [[-62.5, -130], [62.5, -130], [62.5, 20], [-62.5, 20]], 910, 915, 'mortar', lod='f')]
    prod('FMC_C_SiteFurniture_Kerb_Precast', 'Precast concrete half-battered kerb on a concrete bed and haunch, with transition and dropped kerb for crossings', 'IfcBuildingElementProxy',
         [{"name": "125x255_Straight", "desc": "half-battered kerb 125 x 255, 125 upstand"}, {"name": "125x255_Dropped", "desc": "dropped kerb, 25 upstand, with transitions"}], parts,
         {"Kerb 125 x 255 x 915 mm, HB2 profile": A("125x255x915", "typical BS EN 1340 HB2"), "Upstand 125 mm, dropped 25 mm": A("125 / 25", "typical; accessible crossing max 6 mm in some codes, designer to confirm"),
          "Bed 150 mm C15 with haunch": A(150, "typical")},
         "Road at z = 0, run along x: two straight kerbs, a transition kerb and a dropped kerb with mortar joints (Fine), concrete bed and back haunch. Tactile paving is the footway's family.")

def speed_hump():
    pts = [[round(-1850 + 3700 * k / 24, 1), round(75 * (1 - math.cos(2 * math.pi * k / 24)) / 2, 2)] for k in range(25)]
    skin = pts + [[y, z + 3] for y, z in reversed(pts)]
    tri = lambda h: [[-h * 0.58, 0], [h * 0.58, 0], [0, h]]
    parts = [RT("Hump", pts, -2800, 2800, 'asphalt'),
             RT("Marking Stripe", skin, -2700, -2400, 'yellow', rep=(8, 700, 0, 0)),
             CZ("Sign Post", [3200, -2200], 38, 0, 2700, 'galv', seg=16), T("Post Cap", 'z', [3200, -2200], [[0, 2700], [40, 2700], [0, 2730]], 'black', lod='f', seg=16),
             FR("Sign Border", [[3200 + x, 2100 + z] for x, z in tri(650)], -2250, -2240, 'red'),
             FR("Sign Face", [[3200 + x * 0.72, 2100 + 650 / 3 + (z - 650 / 3) * 0.72] for x, z in tri(650)], -2252, -2250, 'abswhite'),
             FR("Sign Symbol", [[3060, 2230], [3340, 2230], [3290, 2290], [3110, 2290]], -2253, -2252, 'black', lod='f'),
             FB("Supplementary Plate", [2950, -2250, 1800, 3450, -2240, 2050], 'abswhite'),
             FB("Plate Text", [3000, -2252, 1900, 3400, -2250, 1950], 'black', lod='f')]
    prod('FMC_C_SiteFurniture_SpeedHump', 'Round-top asphalt speed hump across the ambulance route, 75 mm high, with yellow markings and a hump warning sign', 'IfcBuildingElementProxy',
         ["3700_RoundTop"], parts,
         {"Length 3700 mm in the direction of travel, 75 high": A("3700x75", "typical round-top hump for emergency routes; traffic designer to confirm"),
          "Width 5600 with 200 drainage gaps at kerbs": A(5600, "typical 6 m carriageway"), "Sign 'hump' triangle 750 mm": A(750, "typical; to the Uganda traffic signs manual")},
         "Road at z = 0, travel along y: sinusoidal hump, eight thermoplastic stripes following the hump, warning sign on a post with border, face, symbol and plate.")

def parking_accessible():
    parts = [B("Bay Surface", [-1800, -2500, 0, 600, 2500, 2], 'blue'),
             B("Side Line Left", [-1800, -2500, 0, -1700, 2500, 3], 'white'), B("Side Line Right", [1700, -2500, 0, 1800, 2500, 3], 'white'),
             B("Divider Line", [550, -2500, 0, 650, 2500, 3], 'white'), B("Head Line", [-1800, 2400, 0, 1800, 2500, 3], 'white'),
             PR("Hatch Stripe", [[650, -2400], [650, -2250], [1700, -1200], [1700, -1350]], 0, 3, 'white', rep=(4, 0, 1000, 0)),
             CZ("Symbol Head", [-760, 650], 110, 2, 4, 'white'), PR("Symbol Back", quad(-760, 450, -760, -150, 130), 2, 4, 'white'),
             PR("Symbol Seat", quad(-760, -150, -330, -150, 120), 2, 4, 'white'), PR("Symbol Leg", quad(-330, -150, -230, -550, 110), 2, 4, 'white'),
             PR("Symbol Arm", quad(-760, 250, -460, 250, 100), 2, 4, 'white'), T("Symbol Wheel", 'z', [-700, -330], ring(330, 420, 2, 4), 'white', seg=40),
             B("Wheel Stop", [-1200, 1900, 0, 0, 2050, 100], 'kerb'), B("Wheel Stop Band", [-1000, 1899, 20, -800, 2051, 101], 'yellow', lod='f', rep=(3, 400, 0, 0)),
             CZ("Sign Post", [-600, 2750], 38, 0, 2400, 'galv', seg=16), FB("Sign Plate", [-825, 2700, 1800, -375, 2710, 2400], 'blue'),
             FB("Sign Symbol", [-700, 2698, 1950, -500, 2700, 2250], 'abswhite', lod='f')]
    prod('FMC_C_SiteFurniture_Parking_Bay_Accessible', 'Accessible parking bay 2400 x 5000 with a 1200 hatched transfer zone, blue surface, wheelchair symbol, wheel stop and sign', 'IfcBuildingElementProxy',
         ["3600x5000_Accessible"], parts,
         {"Bay 2400 + 1200 transfer zone, 5000 long": A("3600x5000", "typical (BS 8300-1 / KS ISO 21542 practice)"), "Lines 100 mm white": A(100, "typical"),
          "Rear access zone 1200 mm": A(1200, "BS 8300-1 practice")},
         "Ground at z = 0, entry at -y: blue bay surface, side, divider and head lines, four hatch stripes in the transfer zone, wheelchair symbol, wheel stop with yellow bands (Fine), sign post with blue plate. Transfer and rear zones are clearances.",
         clear=[{"n": "Transfer Zone", "shape": "box", "at": [600, -2500, 0, 1800, 2500, 10], "sub": "Clearance Accessibility"},
                {"n": "Rear Access Zone", "shape": "box", "at": [-1800, -3700, 0, 1800, -2500, 10], "sub": "Clearance Accessibility"}])

LETTERS = {
    'A': [(0, 0, 2, 10), (2, 10, 4, 0), (1, 4, 3, 4)], 'M': [(0, 0, 0, 10), (0, 10, 2, 5), (2, 5, 4, 10), (4, 10, 4, 0)],
    'B': [(0, 0, 0, 10), (0, 10, 3, 10), (0, 5, 3, 5), (0, 0, 3, 0), (3.5, 0.5, 3.5, 4.5), (3.5, 5.5, 3.5, 9.5)],
    'U': [(0, 10, 0, 0.4), (0, 0, 4, 0), (4, 0.4, 4, 10)], 'L': [(0, 0, 0, 10), (0, 0, 4, 0)], 'N': [(0, 0, 0, 10), (0, 10, 4, 0), (4, 0, 4, 10)],
    'C': [(0, 0, 0, 10), (0, 10, 4, 10), (0, 0, 4, 0)], 'E': [(0, 0, 0, 10), (0, 10, 4, 10), (0, 5, 3, 5), (0, 0, 4, 0)]}
def word(text, x0, y0, cw, ch, gap, w, mat, z0=0, z1=3, lod='mf'):
    out = []; sx, sy = cw / 4, ch / 10
    for i, c in enumerate(text):
        ox = x0 + i * (cw + gap)
        for j, (a, b, c2, d) in enumerate(LETTERS[c]):
            out.append(PR(f"Letter {i + 1} {c} Stroke {j + 1}", quad(ox + a * sx, y0 + b * sy, ox + c2 * sx, y0 + d * sy, w), z0, z1, mat, lod=lod))
    return out

def parking_ambulance():
    parts = [B("Bay Line Left", [-2000, -4000, 0, -1850, 4000, 3], 'yellow'), B("Bay Line Right", [1850, -4000, 0, 2000, 4000, 3], 'yellow'),
             B("Bay Line Head", [-2000, 3850, 0, 2000, 4000, 3], 'yellow'), B("Bay Line Entry", [-2000, -4000, 0, 2000, -3850, 3], 'yellow'),
             PR("Keep Clear Hatch", [[-1850, 2500], [-1650, 2500], [-1650 + 1350, 3850], [-1850 + 1350, 3850]], 0, 3, 'yellow', rep=(5, 600, 0, 0)),
             B("Keep Clear Edge", [-1850, 2400, 0, 1850, 2500, 3], 'yellow')]
    parts[-2]['pts'] = [[-1850, 2500], [-1650, 2500], [-650, 3850], [-850, 3850]]
    parts += word("AMBULANCE", -1780, -3700, 300, 1000, 105, 80, 'yellow')
    parts += [CZ("Sign Post", [0, 4300], 38, 0, 2400, 'galv', seg=16), FB("Sign Plate", [-300, 4250, 1800, 300, 4260, 2400], 'abswhite'),
              FB("Sign Cross", [-60, 4248, 1950, 60, 4250, 2250], 'red', lod='f'), FB("Sign Cross Bar", [-150, 4248, 2040, 150, 4250, 2160], 'red', lod='f')]
    prod('FMC_C_SiteFurniture_Parking_Bay_Ambulance', 'Ambulance bay 4000 x 8000: yellow box marking, AMBULANCE legend, keep-clear hatching at the loading end, sign; rear-door clearance', 'IfcBuildingElementProxy',
         ["4000x8000_Ambulance"], parts,
         {"Bay 4000 x 8000 mm": A("4000x8000", "typical (HBN 15-01 / ambulance service guidance)"), "Lines 150 mm yellow": A(150, "typical"),
          "Rear loading zone 1500 mm hatched; 3000 clear behind": A("1500 / 3000", "ambulance stretcher-loading practice; designer to confirm")},
         "Ground at z = 0, the ambulance enters from -y and backs to the canopy (+y): yellow box, AMBULANCE legend in block strokes, keep-clear hatching, sign post. The rear-door zone is an operation clearance.",
         clear=[{"n": "Rear Door Zone", "shape": "box", "at": [-2000, 4000, 0, 2000, 7000, 10], "sub": "Clearance Operation"}])

# ================================================================ PLANT AND SITE EQUIPMENT
def incinerator():
    parts = [B("Base Plinth", [-1500, -1100, 0, 2100, 1100, 200], 'conc'), B("Primary Chamber", [-1000, -700, 200, 600, 700, 1800], 'paint'),
             FB("Loading Door", [-750, -740, 950, 150, -700, 1650], 'paint'), CZ("Door Hinge", [-770, -720], 20, 1000, 1150, 'steel', lod='f', rep=(2, 0, 0, 380), seg=12),
             T("Locking Wheel", 'y', [0, 1300], ring(70, 85, -760, -745), 'steel', lod='f', seg=24), CY("Wheel Hub", [0, 1300], 20, -770, -740, 'steel', lod='f', seg=12),
             FB("Ash Door", [-650, -730, 330, 50, -700, 780], 'paint'), FB("Ash Door Handle", [-20, -750, 500, 10, -730, 620], 'steel', lod='f'),
             FB("Sight Glass", [250, -705, 1400, 330, -700, 1480], 'black', lod='f'),
             B("Saddle", [-850, -350, 1800, -650, 350, 1900], 'paint', rep=(2, 1300, 0, 0)),
             CX("Secondary Chamber", [0, 2300], 450, -1000, 900, 'paint', seg=32), CX("Secondary End Cap", [0, 2300], 430, 900, 950, 'paint', seg=32),
             B("Primary Burner", [-1250, -150, 900, -1000, 150, 1150], 'grey'), CX("Burner Fan", [0, 1025], 90, -1350, -1250, 'grey', seg=20),
             B("Secondary Burner", [-1250, -150, 2200, -1000, 150, 2450], 'grey'), CX("Secondary Burner Fan", [0, 2325], 90, -1350, -1250, 'grey', seg=20),
             T("Stack Base", 'z', [700, 0], [[0, 2700], [300, 2700], [300, 2740], [180, 2900], [0, 2900]], 'paint', seg=32),
             CZ("Stack", [700, 0], 175, 2740, 9000, 'ss', seg=32), T("Stack Flange", 'z', [700, 0], ring(175, 210, 5500, 5530), 'ss', lod='f', seg=32),
             CY("Sampling Port", [700, 7000], 40, -260, -170, 'ss', lod='f', seg=12),
             T("Rain Cap", 'z', [700, 0], [[0, 9150], [320, 9080], [320, 9060], [0, 9120]], 'ss', seg=32),
             B("Rain Cap Stay", [690, -180, 9000, 710, 180, 9080], 'ss', lod='f'),
             B("Control Panel", [1100, -900, 600, 1600, -650, 1600], 'grey'), FB("Panel Door", [1120, -910, 620, 1580, -900, 1580], 'grey', lod='f'),
             CY("Panel Lamp", [1200, 1500], 12, -916, -910, 'ledg', lod='f', seg=12), CY("Panel Lamp Red", [1250, 1500], 12, -916, -910, 'ledr', lod='f', seg=12),
             B("Panel Stand", [1100, -900, 200, 1150, -650, 600], 'paint', rep=(2, 450, 0, 0)),
             CX("Day Tank", [500, 1000], 300, 1100, 1900, 'paint', seg=24), B("Day Tank Stand", [1150, 300, 200, 1200, 700, 700], 'paint', rep=(2, 650, 0, 0)),
             CY("Fuel Line", [-1050, 1000], 10, -150, 300, 'gi', lod='f', seg=8)]
    prod('FMC_C_SiteFurniture_Incinerator_MedicalWaste', 'Dual-chamber medical waste incinerator envelope: primary chamber with loading and ash doors, secondary chamber, burners, 9 m stainless stack with rain cap, control panel, day tank, on a plinth', 'IfcBuildingElementProxy',
         [{"name": "50kgh_DualChamber", "desc": "about 50 kg/h envelope", "values": {"Apparent Load": 2500}}, {"name": "100kgh_DualChamber", "desc": "about 100 kg/h envelope", "values": {"Apparent Load": 4000}}], parts,
         {"Envelope 3600 x 2200 on plinth, stack 9 m (50 kg/h)": A("3600x2200 / 9000", "typical dual-chamber unit; vendor to confirm"),
          "Stack height from the EIA": A("EIA", "by others (NEMA EIA); not decided here"), "Supply 240 V, 2.5 kVA (50 kg/h)": A("240V 2.5kVA", "typical burner/fan load; vendor to confirm"),
          "Secondary chamber 2 s at 1100 C": A("2s 1100C", "WHO/Stockholm guidance; vendor to confirm")},
         "Ground at z = 0: plinth, primary chamber with loading door, hinges, locking wheel, ash door and sight glass, saddled secondary chamber, two burners with fans, stack base, stack with flange, sampling port and rain cap, control panel with lamps, day tank on stand. Power on the panel.",
         conns=[power("Control Panel", "front")], tv={"Voltage": 240, "Apparent Load": 2500})

def boom_barrier():
    parts = [B("Foundation", [-300, -300, -600, 300, 300, 0], 'c20'), B("Housing", [-150, -175, 0, 150, 175, 1000], 'epoxy', r=20),
             B("Housing Top", [-160, -185, 1000, 160, 185, 1040], 'epoxy', r=24), FB("Housing Door", [-120, -178, 100, 120, -175, 900], 'epoxy', r=10, lod='f'),
             CY("Door Lock", [80, 800], 10, -182, -178, 'ss', lod='f', seg=12),
             FB("Reflective Band", [-150, -177, 600, 150, -175, 640], 'yellow', lod='f'),
             CY("Boom Hub", [0, 960], 70, -230, -175, 'ss', seg=24),
             B("Boom", [0, -260, 920, 3100, -200, 1000], 'abswhite', r=8),
             B("Boom Stripe", [300, -261, 919, 600, -199, 1001], 'red', rep=(5, 600, 0, 0)),
             B("Boom Skirt", [200, -240, 880, 3050, -220, 920], 'rubber', lod='f'),
             CY("Boom LED", [450, 960], 8, -263, -260, 'ledr', lod='f', rep=(6, 500, 0, 0), seg=10),
             B("Boom Rest Post", [2960, -270, 0, 3040, -190, 860], 'galv'), B("Rest Base Plate", [2900, -330, 0, 3100, -130, 12], 'galv'),
             FB("Rest Fork Front", [2965, -280, 860, 3035, -268, 1060], 'galv'), FB("Rest Fork Back", [2965, -192, 860, 3035, -180, 1060], 'galv'),
             B("Rest Pad", [2965, -268, 860, 3035, -192, 880], 'rubber', lod='f'),
             CZ("Photocell Post", [600, -600], 40, 0, 600, 'epoxy', lod='f', seg=12), CZ("Photocell Post Far", [600, 600], 40, 0, 600, 'epoxy', lod='f', seg=12)]
    prod('FMC_C_SiteFurniture_Gatehouse_Barrier', 'Automatic boom barrier for the main gate: steel housing on a concrete base, 3 m aluminium boom with red stripes, LEDs and rubber skirt, boom rest, photocells', 'IfcBuildingElementProxy',
         ["3000_Boom"], parts,
         {"Boom 3000 mm, pivot at 960 mm": A("3000 / 960", "typical boom barrier"), "Housing 300 x 350 x 1040 mm": A("300x350x1040", "typical"),
          "Supply 240 V, 300 VA": A("240V 300VA", "typical motor/controller; vendor to confirm"), "Opening time 1.5 to 3 s": A("1.5-3 s", "typical; vendor to confirm")},
         "Ground at z = 0: foundation, housing with top, door, lock and reflective band, boom hub, white boom with five red stripes, rubber skirt and LEDs (Fine), boom rest with fork and pad, two photocell posts. Power on the housing.",
         conns=[power("Housing", "back")], tv={"Voltage": 240, "Apparent Load": 300})

def helipad():
    h = 10000
    parts = [B("Perimeter Line Front", [-h, -h, 0, h, -h + 300, 3], 'white'), B("Perimeter Line Back", [-h, h - 300, 0, h, h, 3], 'white'),
             B("Perimeter Line Left", [-h, -h + 300, 0, -h + 300, h - 300, 3], 'white'), B("Perimeter Line Right", [h - 300, -h + 300, 0, h, h - 300, 3], 'white'),
             T("Touchdown Circle", 'z', [0, 0], ring(5000, 5500, 0, 3), 'yellow', seg=64),
             B("Cross Vertical", [-1500, -4500, 0, 1500, 4500, 3], 'white'), B("Cross Horizontal", [-4500, -1500, 0, 4500, 1500, 3], 'white'),
             B("H Left", [-900, -1500, 3, -500, 1500, 5], 'red'), B("H Right", [500, -1500, 3, 900, 1500, 5], 'red'), B("H Bar", [-500, -200, 3, 500, 200, 5], 'red'),
             B("D-value Box", [h - 2300, -h + 600, 0, h - 700, -h + 1400, 3], 'white', lod='f'), B("Mass Box", [-h + 700, -h + 600, 0, -h + 2300, -h + 1400, 3], 'white', lod='f')]
    k = 0
    for x in (-h + 150, 0, h - 150):
        for y in (-h + 150, 0, h - 150):
            if x == 0 and y == 0: continue
            k += 1; parts.append(T(f"Perimeter Light {k}", 'z', [x, y], [[0, 0], [110, 0], [110, 20], [60, 45], [0, 45]], 'ledg', lod='f', seg=16))
    prod('FMC_C_SiteFurniture_Helipad_Marking', 'Hospital helipad marking placeholder: TLOF perimeter line, yellow touchdown/positioning circle, red H on a white cross, D-value and mass boxes, green perimeter lights', 'IfcBuildingElementProxy',
         ["D20_Hospital"], parts,
         {"D-value 20 m placeholder (TLOF 20 x 20)": A("D20", "placeholder; the D-value and all sizes come from the CAA approval"),
          "Touchdown circle 0.5 D, 0.5 m line": A("10000 / 500", "ICAO Annex 14 Vol II practice"), "Hospital H 3000 x 1800, 400 strokes, on a white cross": A("3000x1800", "ICAO Annex 14 Vol II hospital heliport marking")},
         "Surface at z = 0: perimeter lines, touchdown circle, white cross with red H, D-value and mass marking boxes (Fine), eight green perimeter lights. Placeholder until the aviation authority approves.")

BUILD = [rc_rect_column, rc_round_column, steel_uc, chs_canopy, rc_beam, rc_lbeam, steel_ub, unistrut, lifting_beam, canopy_truss, z_purlin,
         pad_footing, pile_cap, bored_pile, strip_footing, equipment_plinth, tank_base, lift_pit, cast_in_channel, embed_plate, movement_joint,
         tank_stand, base_plate, fin_plate, rad_sleeve, manhole_precast, manhole_brick, catchpit, gully, septic, soakpit, wwtp, neutralisation,
         grease_trap, fuel_interceptor, box_culvert, pipe_culvert, u_channel, kerb, speed_hump, parking_accessible, parking_ambulance,
         incinerator, boom_barrier, helipad]

import re
TYPE_RE = re.compile(r'^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$')
KIT = set(open(os.path.join(HERE, 'batches', 'KIT_MATERIALS.txt')).read().split())

def check(prod):
    errs = []
    for k in ('family', 'desc', 'ifc', 'types', 'materials', 'parts', 'reference', 'values', 'about'):
        if k not in prod: errs.append('missing ' + k)
    for t in prod['types']:
        if not TYPE_RE.match(t['name']) or t['name'].count('_') != 1: errs.append('type ' + t['name'])
    for v in prod['materials'].values():
        if v not in KIT: errs.append('material ' + v)
    ex = fp.expand(prod['parts'])
    if len(ex) > 70: errs.append(f'{len(ex)} parts')
    names = [p['n'] for p in ex] + [c['n'] for c in prod.get('clearances', [])]
    if len(names) != len(set(names)): errs.append('duplicate names ' + str({n for n in names if names.count(n) > 1}))
    for c in prod.get('connectors', []):
        if c['part'] not in names: errs.append('connector part ' + c['part'])
    for p in prod['parts']:
        if p.get('mat') and p['mat'] not in prod['materials']: errs.append('mat key ' + p['mat'])
    if not 2 <= len(prod['values']) <= 5: errs.append(f"{len(prod['values'])} values")
    return errs, len(ex)

if __name__ == '__main__':
    only = sys.argv[1:]
    for f in BUILD: f()
    assert {p['family'] for p in P} == set(RECS), set(RECS) - {p['family'] for p in P}
    json.dump(NEEDED, open(os.path.join(HERE, 'batches', 'SC_structure_civil.materials_needed.json'), 'w'), indent=1)
    out = []
    for prod in P:
        if only and not any(s in prod['family'] for s in only): continue
        errs, n = check(prod)
        if errs: print('CHECK', prod['family'], errs)
        json.dump(prod, open(os.path.join(HERE, prod['family'] + '.product.json'), 'w'), indent=1)
        r = fp.compile_product(prod)
        json.dump(r, open(os.path.join(HERE, prod['family'] + '.recipe.json'), 'w'), indent=1)
        fp.render(prod, os.path.join(HERE, prod['family'] + '.preview.png'))
        fp.render_type_image(prod, os.path.join(HERE, prod['family'] + '.png'), size=600)
        out.append((prod['family'], n, len(r['ops'])))
        print(prod['family'], n, 'parts', len(r['ops']), 'ops', flush=True)
    print(len(out), 'families')
