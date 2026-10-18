"""Healthcare pack, batch I2 (interiors: medical equipment, furniture, casework), detailed product models.
Pattern: make_products.py. Compiler/renderer: ../../tools/fmc_parts.py (not edited).
Run: python3 gen_I2_interiors.py [family-substring ...]
Writes <family>.product.json, .recipe.json, .preview.png and .png (type image, 600 px) for every family in
batches/I2_interiors.json. Geometry for a multi-size record is drawn at one type (named in `about`); the other types share it."""
import json, os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import fmc_parts as fp

RECS = {r['family']: r for r in json.load(open(os.path.join(HERE, 'batches', 'I2_interiors.json')))}
A = lambda v, src='typical product, to confirm with the supplier': {"value": v, "source_status": "assumed", "source": src}
NESTED = "Water, drainage, gases and extract reach this item via the nested shared FMC_P_MechEq_ServicePoint (Medical Equipment cannot hold pipe or duct connectors)."

# ---------------------------------------------------------------- part shorthands
def _p(d, lod, rep):
    if lod != 'mf': d['lod'] = lod
    if rep: d['repeat'] = {"n": rep[0], "d": list(rep[1:])}
    return d
def BX(n, at, m, r=0, lod='mf', rep=None):
    d = {"n": n, "shape": "box", "at": [round(v, 2) for v in at], "mat": m}
    if r: d['r'] = r
    return _p(d, lod, rep)
def FB(n, at, m, r=0, lod='mf', rep=None):
    d = {"n": n, "shape": "fbox", "at": [round(v, 2) for v in at], "mat": m}
    if r: d['r'] = r
    return _p(d, lod, rep)
def CZ(n, c, r, z, m, lod='mf', rep=None, seg=None):
    d = {"n": n, "shape": "cyl", "axis": "z", "c": c, "r": r, "z": z, "mat": m}
    if seg: d['seg'] = seg
    return _p(d, lod, rep)
def CY(n, c, r, y, m, lod='mf', rep=None, seg=None):
    d = {"n": n, "shape": "cyl", "axis": "y", "c": c, "r": r, "y": y, "mat": m}
    if seg: d['seg'] = seg
    return _p(d, lod, rep)
def CX(n, c, r, x, m, lod='mf', rep=None, seg=None):
    d = {"n": n, "shape": "cyl", "axis": "x", "c": c, "r": r, "x": x, "mat": m}
    if seg: d['seg'] = seg
    return _p(d, lod, rep)
def TN(n, axis, c, prof, m, lod='mf', rep=None):
    return _p({"n": n, "shape": "turn", "axis": axis, "c": c, "profile": prof, "mat": m}, lod, rep)
def PR(n, pts, z, m, lod='mf', rep=None):
    return _p({"n": n, "shape": "prism", "pts": [[round(a, 2), round(b, 2)] for a, b in pts], "z": z, "mat": m}, lod, rep)
def FR(n, pts, y, m, lod='mf', rep=None):
    return _p({"n": n, "shape": "front", "pts": [[round(a, 2), round(b, 2)] for a, b in pts], "y": y, "mat": m}, lod, rep)
def RT(n, pts, x, m, lod='mf', rep=None):
    return _p({"n": n, "shape": "right", "pts": [[round(a, 2), round(b, 2)] for a, b in pts], "x": x, "mat": m}, lod, rep)

def rrect_pts(x0, y0, x1, y1, r, n=4): return fp.rrect(x0, y0, x1, y1, r, n)
def rot_rect(cx, cy, L, T, ang):
    a = math.radians(ang); ux, uy = math.cos(a), math.sin(a); vx, vy = -uy, ux
    return [[cx + sx * L / 2 * ux + sy * T / 2 * vx, cy + sx * L / 2 * uy + sy * T / 2 * vy] for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
def rounded_profile(pts, r, n=3):
    """Round the corners of a closed 2D outline (for side profiles)."""
    out = []
    N = len(pts)
    for i in range(N):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % N]
        d1 = [p0[0] - p1[0], p0[1] - p1[1]]; d2 = [p2[0] - p1[0], p2[1] - p1[1]]
        l1, l2 = math.hypot(*d1), math.hypot(*d2); rr = min(r, l1 / 2.2, l2 / 2.2)
        a = [p1[0] + d1[0] / l1 * rr, p1[1] + d1[1] / l1 * rr]; b = [p1[0] + d2[0] / l2 * rr, p1[1] + d2[1] / l2 * rr]
        for k in range(n + 1):  # quadratic bezier a -> p1 -> b
            t = k / n; out.append([(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * p1[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * p1[1] + t * t * b[1]])
    return out

# ---------------------------------------------------------------- shared details
def dpull(n, x, z, yface, L=160, vertical=False, m='hdl', lod='f', proj=30, r=6):
    """D-pull bar handle: bar and two posts, standing proud of a front face at y = yface."""
    if vertical:
        return [CZ(n + " Bar", [x, yface - proj + r], r, [z - L / 2, z + L / 2], m, lod),
                CY(n + " Post", [x, z - L / 2 + 12], 4, [yface - proj + r, yface], m, lod, rep=(2, 0, 0, L - 24))]
    return [CX(n + " Bar", [yface - proj + r, z], r, [x - L / 2, x + L / 2], m, lod),
            CY(n + " Post", [x - L / 2 + 12, z], 4, [yface - proj + r, yface], m, lod, rep=(2, L - 24, 0, 0))]

def castors(n, xs, ys, top, wr=50, w=30, fork='frame', wheel='castor', lod='mf'):
    """Twin-wheel style castors at the corners xs x ys: stem plate, fork and wheel, from z = 0 up to `top`."""
    out = []
    dx = xs[1] - xs[0] if len(xs) > 1 else 0
    for j, y in enumerate(ys):
        tag = n + (" Front" if j == 0 else " Back")
        k = len(xs)
        out += [BX(tag + " Fork", [xs[0] - w / 2 - 6, y - wr * 0.6, wr * 1.1, xs[0] + w / 2 + 6, y + wr * 0.6, top], fork, r=6, rep=(k, dx, 0, 0)),
                CX(tag + " Wheel", [y, wr], wr, [xs[0] - w / 2, xs[0] + w / 2], wheel, rep=(k, dx, 0, 0), seg=20)]
    return out

def glides(n, xs, ys, r=18, h=12, m='rubber', lod='f'):
    out = []
    dx = xs[1] - xs[0] if len(xs) > 1 else 0
    for j, y in enumerate(ys):
        out.append(CZ(n + (" Front" if j == 0 else " Back"), [xs[0], y], r, [0, h], m, lod, rep=(len(xs), dx, 0, 0), seg=16))
    return out

def base_run(x0, x1, D, H, cols, carcass='carc', front='front', top='top', plinth='plinth', hdl='hdl', plinth_h=100, top_t=30,
             upstand=100, name='', worktop=True, handle='d', yback=0, toe=50):
    """Base casework run against a wall (back at y = yback): carcass, recessed plinth, fronts, handles, worktop and upstand.
    cols: list of (width, [items top to bottom]) where an item is ('drawer', h), ('door', h), ('doors', h) (pair), ('open', h)
    or ('drawers', h, n) (n equal drawers)."""
    P = []; yb = yback; yf = yb - D
    pre = (name + ' ') if name else ''
    x = x0; kc = 0; kk = 0
    for w, items in cols:  # one carcass and plinth per column; a 'knee' column is an open recess with a back panel only
        if items[0][0] == 'knee':
            kk += 1; P.append(BX(pre + f"Knee Panel {kk}", [x, yb - 20, plinth_h, x + w, yb, H - top_t], carcass))
        else:
            kc += 1; sfx = '' if kc == 1 else f' {kc}'
            P.append(BX(pre + "Carcass" + sfx, [x, yf + 20, plinth_h, x + w, yb, H - top_t], carcass))
            P.append(BX(pre + "Plinth" + sfx, [x + 2, yf + toe, 0, x + w - 2, yb - 20, plinth_h], plinth))
        x += w
    if worktop:
        P.append(BX(pre + "Worktop", [x0, yf - 20, H - top_t, x1, yb, H], top, r=4))
        if upstand: P.append(BX(pre + "Upstand", [x0, yb - 15, H, x1, yb, H + upstand], top, r=2))
    x = x0; gap = 3; k = 0
    for w, items in cols:
        z = H - top_t - gap
        for it in items:
            kind, h = it[0], it[1]
            z0 = z - h + gap; k += 1; tag = f"{pre}{kind.title()} {k}"
            if kind == 'knee':
                pass
            elif kind == 'open':
                P.append(BX(tag + " Shelf", [x + 20, yf + 30, z0 + 10, x + w - 20, yb - 20, z0 + 28], carcass, lod='f'))
            elif kind == 'drawer':
                P.append(FB(tag + " Front", [x + gap, yf, z0, x + w - gap, yf + 20, z], front, r=3))
                P += dpull(tag + " Handle", x + w / 2, z - min(40, h / 2), yf, L=min(160, w - 80), m=hdl) if handle == 'd' else [FB(tag + " Handle", [x + w / 2 - 70, yf - 22, z - 30, x + w / 2 + 70, yf, z - 18], hdl, r=4, lod='f')]
            elif kind == 'drawers':
                n = it[2]; hh = h / n
                P.append(FB(tag + " Front", [x + gap, yf, z - hh + gap, x + w - gap, yf + 20, z], front, r=3, rep=(n, 0, 0, -hh)))
                P.append(CX(tag + " Handle Bar", [yf - 20, z - 28], 5, [x + w / 2 - 60, x + w / 2 + 60], hdl, lod='f', rep=(n, 0, 0, -hh)))
            elif kind == 'door':
                P.append(FB(tag + " Leaf", [x + gap, yf, z0, x + w - gap, yf + 20, z], front, r=3))
                P += dpull(tag + " Handle", x + w - 45, z - 110, yf, L=160, vertical=True, m=hdl) if handle == 'd' else [FB(tag + " Handle", [x + w - 50, yf - 22, z - 190, x + w - 38, yf, z - 30], hdl, r=4, lod='f')]
            elif kind == 'doors':
                hw = w / 2
                P.append(FB(tag + " Leaf", [x + gap, yf, z0, x + hw - gap / 2, yf + 20, z], front, r=3, rep=(2, hw - gap / 2, 0, 0)))
                P.append(CZ(tag + " Handle Bar", [x + hw - 40, yf - 20], 5, [z - 200, z - 40], hdl, lod='f', rep=(2, 80, 0, 0)))
            z = z0 - gap
        x += w
    return P

def cut_worktop(P, wname, hx0, hy0, hx1, hy1):
    """Replace box part `wname` by up to 4 pieces around a sink opening, so the bowl below shows (voids do not render)."""
    i = next(k for k, q in enumerate(P) if q['n'] == wname); q = P.pop(i); a = q['at']; m = q['mat']
    pieces = [(wname, [a[0], a[1], a[2], hx0, a[4], a[5]]), (wname + " Right", [hx1, a[1], a[2], a[3], a[4], a[5]]),
              (wname + " Front", [hx0, a[1], a[2], hx1, hy0, a[5]]), (wname + " Back", [hx0, hy1, a[2], hx1, a[4], a[5]])]
    for n, at in pieces:
        if at[3] - at[0] > 0.5 and at[4] - at[1] > 0.5: P.insert(i, BX(n, at, m)); i += 1
    return P

def bowl(n, x0, y0, x1, y1, zb, zt, m, t=3, r=0):
    """Open sink bowl: floor and four walls."""
    return [BX(n + " Floor", [x0, y0, zb, x1, y1, zb + t], m, r=r), BX(n + " Wall Front", [x0, y0, zb, x1, y0 + t, zt], m),
            BX(n + " Wall Back", [x0, y1 - t, zb, x1, y1, zt], m), BX(n + " Wall Left", [x0, y0 + t, zb, x0 + t, y1 - t, zt], m),
            BX(n + " Wall Right", [x1 - t, y0 + t, zb, x1, y1 - t, zt], m)]

def wall_unit(x0, x1, D, H, z0, leaves, glazed=True, sloped=True, name='Wall Unit', carc='carc', front='front', glass='glass', hdl='hdl'):
    """Wall cupboard hung at z0 (underside), back at y = 0: carcass, sloped anti-dust top, glazed or solid leaves, handles, shelves."""
    P = []; yf = -D; zt = z0 + H
    P.append(BX(name + " Carcass", [x0, yf + 20, z0, x1, 0, zt], carc))
    if sloped:
        P.append(RT(name + " Sloped Top", [[0, zt], [yf + 20, zt], [yf + 20, zt + 20], [0, zt + 20 + D * 0.45]], [x0, x1], carc))
    w = (x1 - x0) / leaves
    for i in range(leaves):
        a, b = x0 + i * w + 2, x0 + (i + 1) * w - 2
        if glazed:
            P += [FB(f"{name} Leaf {i + 1} Frame", [a, yf, z0 + 2, b, yf + 20, zt - 2], front, r=3),
                  FB(f"{name} Leaf {i + 1} Glass", [a + 45, yf - 1, z0 + 47, b - 45, yf + 2, zt - 47], glass, r=2)]
        else:
            P.append(FB(f"{name} Leaf {i + 1}", [a, yf, z0 + 2, b, yf + 20, zt - 2], front, r=3))
        hx = b - 25 if i % 2 == 0 and leaves > 1 else (a + 25 if leaves > 1 else b - 25)
        P += dpull(f"{name} Leaf {i + 1} Handle", hx, z0 + 110, yf, L=128, vertical=True, m=hdl, proj=26)
    return P

def upright_fridge(W, D, H, base_h, panel_h, interior, feet, mats, extras=()):
    x0, x1 = -W / 2, W / 2; yf = -D; yc = -D + 50; zt = H - panel_h; zm = zt + panel_h / 2
    P = [BX("Side Left", [x0, yc, base_h, x0 + 40, 0, zt], 'body'), BX("Side Right", [x1 - 40, yc, base_h, x1, 0, zt], 'body'),
         BX("Head Housing", [x0, yc, zt, x1, 0, H], 'body', r=4), BX("Back", [x0 + 40, -40, base_h, x1 - 40, 0, zt], 'body'),
         BX("Inner Floor", [x0 + 40, yc, base_h, x1 - 40, -40, base_h + 40], 'liner'),
         BX("Machine Compartment", [x0 + 5, yc + 10, feet[0], x1 - 5, -5, base_h], 'body'),
         FB("Vent Slat", [x0 + 40, yc + 2, feet[0] + 14, x1 - 40, yc + 10, feet[0] + 20], 'grey', lod='f', rep=(max(1, int((base_h - feet[0] - 25) // 12)), 0, 0, 12)),
         # door: frame of stiles and rails, double glazed panel
         FB("Door Stile Left", [x0, yf, base_h, x0 + 60, yc, zt - 4], 'body', r=4), FB("Door Stile Right", [x1 - 60, yf, base_h, x1, yc, zt - 4], 'body', r=4),
         FB("Door Rail Top", [x0 + 60, yf, zt - 70, x1 - 60, yc, zt - 4], 'body'), FB("Door Rail Bottom", [x0 + 60, yf, base_h, x1 - 60, yc, base_h + 90], 'body'),
         FB("Door Glass", [x0 + 60, yf + 12, base_h + 90, x1 - 60, yf + 30, zt - 70], 'glass'),
         FB("Door Gasket", [x0 + 4, yc - 1, base_h + 4, x1 - 4, yc + 1, zt - 8], 'grey', lod='f'),
         CZ("Hinge", [x0 + 10, yf + 40], 9, [zt - 2, zt + 10], 'chrome', lod='f'),
         CZ("Hinge Bottom", [x0 + 10, yf + 40], 9, [base_h - 12, base_h], 'chrome', lod='f'),
         CY("Door Lock", [x1 - 30, base_h + 45], 9, [yf - 6, yf], 'chrome', lod='f'),
         FB("Control Panel", [x0, yf, zt, x1, yc, H], 'body', r=4),
         FB("Display", [-W * 0.18, yf - 3, zm - 30, W * 0.12, yf, zm + 30], 'black', r=4),
         FB("Temperature Readout", [-W * 0.15, yf - 4, zm - 14, W * 0.02, yf - 3, zm + 14], 'green', lod='f'),
         CY("Alarm LED", [W * 0.07, zm + 12], 6, [yf - 5, yf], 'red', lod='f'),
         CY("Key", [W * 0.2, zm], 10, [yf - 4, yf], 'grey', lod='f', rep=(3, 32, 0, 0)),
         FB("Label Strip", [x0 + 25, yf - 2, zm - 12, -W * 0.22, yf, zm + 12], 'label', r=3, lod='f')]
    P += dpull("Door Handle", x1 - 32, base_h + (zt - base_h) * 0.55, yf, L=min(500, (zt - base_h) * 0.4), vertical=True, m='chrome', lod='mf', proj=40, r=9)
    zi = base_h + 40
    for i, (kind, z, h) in enumerate(interior):
        if kind == 'basket':
            P.append(BX(f"Basket {i + 1}", [x0 + 50, yc + 20, z, x1 - 50, -50, z + h], 'grey', lod='f'))
        else:
            P.append(BX(f"Drawer {i + 1}", [x0 + 50, yc + 10, z, x1 - 50, -50, z + h], 'ss', lod='f'))
            P.append(BX(f"Drawer {i + 1} Pull", [-60, yc + 2, z + h - 30, 60, yc + 10, z + h - 10], 'grey', lod='f'))
    xs, ys = [x0 + 50, x1 - 50], [yf + 80, -50]
    if feet[1] == 'castor': P += castors("Castor", xs, ys, feet[0], wr=feet[0] * 0.42, w=26, fork='grey', wheel='castor')
    else: P += [CZ("Foot Front", [xs[0], ys[0]], 20, [0, feet[0]], 'black', rep=(2, xs[1] - xs[0], 0, 0), seg=16),
                CZ("Foot Back", [xs[0], ys[1]], 20, [0, feet[0]], 'black', rep=(2, xs[1] - xs[0], 0, 0), seg=16)]
    return P + list(extras)

def typed(fn, spec):
    """Per-type geometry (second pass): spec = {type name: (tag, arg)}; parts from fn(arg) get ' <tag>' on their name and only = [type]."""
    out = []
    for tn, (tag, arg) in spec.items():
        for q in fn(arg):
            q = dict(q); q['n'] = f"{q['n']} {tag}"; q['only'] = [tn]; out.append(q)
    return out

def only(parts, types):
    for q in parts: q['only'] = list(types)
    return parts

# ---------------------------------------------------------------- product builder
OUT = []
def product(fam, desc, ifc, types, materials, parts, values, about, connectors=(), clearances=(), type_values=None, template=None, drawn=None):
    rec = RECS[fam]
    p = {"family": fam, "category": rec['category'], "desc": desc, "ifc": ifc, "keynote": rec['kn'],
         "types": [t if isinstance(t, dict) else {"name": t} for t in types], "materials": materials, "parts": parts,
         "reference": dict(rec['ref']), "values": values, "about": about}
    if template: p['template'] = template
    if type_values: p['type_values'] = type_values
    if connectors: p['connectors'] = list(connectors)
    if clearances: p['clearances'] = list(clearances)
    if any(q.get('only') for q in parts): p['about'] += " Each type has its own geometry (parts carry 'only' for their type); shared parts have none."
    elif drawn and len(p['types']) > 1: p['about'] += f" Geometry is drawn at the {drawn} type; the other types share it until a parametric pass."
    OUT.append(p)
    return p

E = lambda part, side='back', n='Power': {"n": n, "domain": "electrical", "system": "PowerBalanced", "part": part, "side": side}
ELV = lambda part, side='back', n='Data', sys_='Data': {"n": n, "domain": "electrical", "system": sys_, "part": part, "side": side}
CW = lambda part, side='back': {"n": "CW", "domain": "pipe", "system": "DomesticColdWater", "part": part, "side": side, "diameter": 15, "flow": "In"}
HW = lambda part, side='back': {"n": "HW", "domain": "pipe", "system": "DomesticHotWater", "part": part, "side": side, "diameter": 15, "flow": "In"}
SAN = lambda part, side='bottom', d=40: {"n": "Waste", "domain": "pipe", "system": "Sanitary", "part": part, "side": side, "diameter": d, "flow": "Out"}

M_FRIDGE = {"body": "FMC_Metal_Steel_EpoxyCoated_White", "liner": "FMC_Plastic_ABS_White", "glass": "FMC_Glass_Clear", "grey": "FMC_Plastic_ABS_Grey",
            "chrome": "FMC_Metal_Chrome_Polished", "black": "FMC_Plastic_ABS_Black", "green": "FMC_Plastic_LED_Green", "red": "FMC_Plastic_LED_Red",
            "label": "FMC_Plastic_ABS_Blue", "ss": "FMC_Metal_StainlessSteel_Brushed", "castor": "FMC_Plastic_Nylon_CastorGrey"}

# ================================================================ MEDICAL EQUIPMENT
# 1 Vaccine fridge 600 x 650 x 1800, glass door, 5 baskets, feet
fam = "FMC_I_MedEq_Fridge_Vaccine"
parts = upright_fridge(600, 650, 1800, 140, 160, [('basket', 260 + 255 * i, 150) for i in range(5)], (40, 'feet'), M_FRIDGE,
                       extras=[FB("Data Logger Port", [150, -652, 1620, 190, -650, 1660], 'black', r=4, lod='f')])
product(fam, "Vaccine refrigerator 2-8 C, upright, glass door, 5 wire baskets, digital display with alarm and data logger, 600 x 650 x 1800",
        "IfcMedicalDevice", ["600x650x1800_Vaccine"], dict(M_FRIDGE), parts,
        {"Size 600 x 650 x 1800 mm": A("600x650x1800", "record size; typical 300-400 l pharmacy vaccine fridge"), "Storage 2 to 8 C": A("2-8C", "cold-chain vaccine storage practice (WHO PQS E003)"),
         "Supply 240 V, 300 VA": A(300, "typical compressor fridge running load")},
        "Vaccine fridge modelled as a generic product: white steel cabinet built as sides, back and head housing; glazed door of stiles and rails with gasket, hinges, lock and D-pull; "
        "control panel with display, temperature readout, alarm LED, keys and logger port; 5 wire baskets inside; machine compartment with vent slats on 4 feet. " + NESTED,
        connectors=[E("Head Housing", 'top')], type_values={"Voltage": 240, "Apparent Load": 300})

# 2 Blood bank fridge 700 x 800 x 2000, 6 drawers, chart recorder, castors
fam = "FMC_I_MedEq_Fridge_BloodBank"
parts = upright_fridge(700, 800, 2000, 170, 240, [('drawer', 270 + 245 * i, 190) for i in range(6)], (110, 'castor'), M_FRIDGE,
                       extras=[CY("Chart Recorder", [230, 1880], 85, [-803, -800], 'liner'), CY("Chart Recorder Window", [230, 1880], 75, [-805, -803], 'glass', lod='f'),
                               FB("Blood Bank Label", [-330, -803, 1775, -150, -800, 1795], 'red', r=3, lod='f')])
M = dict(M_FRIDGE)
product(fam, "Blood bank refrigerator 4 C, upright, heated glass door, 6 stainless drawers, chart recorder, touch display, alarms, on castors, 700 x 800 x 2000",
        "IfcMedicalDevice", ["700x800x2000_BloodBank"], M, parts,
        {"Size 700 x 800 x 2000 mm": A("700x800x2000", "record size; typical 500-600 l blood bank fridge"), "Storage 4 +/- 2 C": A("4C", "blood storage practice (BS EN 16590 / WHO)"),
         "Supply 240 V, 600 VA": A(600, "typical load with heated door")},
        "Blood bank fridge modelled as a generic product: white steel cabinet, glazed door with gasket, hinges, lock and D-pull; control panel with display, alarm LED, keys, "
        "red label and circular chart recorder; 6 stainless drawers with pulls; vented machine compartment on 4 castors. " + NESTED,
        connectors=[E("Head Housing", 'top')], type_values={"Voltage": 240, "Apparent Load": 600})

# 3 Mortuary fridge, 3 bodies, side loading in 3 tiers, refrigeration unit on top, stainless
fam = "FMC_I_MedEq_MortuaryFridge_3Body"
P = [BX("Cabinet", [-1250, -860, 120, 1250, 0, 1660], 'ss', r=6), BX("Plinth", [-1230, -820, 40, 1230, -20, 120], 'ss'),
     CZ("Foot Front", [-1150, -780], 30, [0, 40], 'ss', rep=(3, 1150, 0, 0), seg=16), CZ("Foot Back", [-1150, -80], 30, [0, 40], 'ss', rep=(3, 1150, 0, 0), seg=16),
     BX("Refrigeration Unit", [-1250, -860, 1660, 1250, 0, 1900], 'ss', r=6),
     FB("Condenser Grille Slat", [-1150, -866, 1690, 400, -860, 1698], 'grey', lod='f', rep=(12, 0, 0, 16)),
     FB("Controller", [560, -866, 1700, 1180, -860, 1870], 'grey', r=6), FB("Controller Display", [600, -869, 1760, 860, -866, 1840], 'black', r=4),
     FB("Controller Readout", [620, -870, 1785, 800, -869, 1815], 'green', lod='f'), CY("Alarm LED", [920, 1810], 9, [-870, -866], 'red', lod='f'),
     CY("Alarm Mute Key", [1000, 1810], 14, [-870, -866], 'black', lod='f', rep=(2, 60, 0, 0))]
for i, (a, b) in enumerate(((135, 630), (645, 1140), (1155, 1650))):
    t = f"Tier {i + 1}"; zm = (a + b) / 2
    P += [FB(t + " Door", [-1225, -900, a, 1225, -860, b], 'ss', r=8), FB(t + " Door Gasket", [-1230, -862, a - 4, 1230, -858, b + 4], 'black', lod='f'),
          FB(t + " Latch", [1060, -940, zm - 30, 1200, -900, zm + 30], 'chrome', r=10), FB(t + " Latch Keeper", [1200, -925, zm - 40, 1240, -900, zm + 40], 'chrome', r=4, lod='f'),
          FB(t + " Name Card Holder", [-200, -903, zm + 90, 200, -900, zm + 170], 'clear', r=4, lod='f'),
          CY(t + " Hinge", [-1235, a + 70], 14, [-905, -862], 'chrome', lod='f', rep=(2, 0, 0, b - a - 140))]
product(fam, "Mortuary body refrigerator, 3 bodies side-loading in 3 tiers, stainless steel, top-mounted refrigeration unit with controller and alarm, 2500 x 900 x 1900",
        "IfcMedicalDevice", ["2500x900x1900_3Body"],
        {"ss": "FMC_Metal_StainlessSteel_Brushed", "grey": "FMC_Plastic_ABS_Grey", "black": "FMC_Plastic_ABS_Black", "green": "FMC_Plastic_LED_Green", "red": "FMC_Plastic_LED_Red",
         "chrome": "FMC_Metal_Chrome_Polished", "clear": "FMC_Plastic_Polycarbonate_Clear"}, P,
        {"Size 2500 x 900 x 1900 mm": A("2500x900x1900", "record size"), "3 bodies, 3 tiers": A(3, "NMEG mortuary body refrigerator, 3-body"),
         "Storage +2 to +6 C": A("2-6C", "HBN 20 mortuary practice"), "Supply 240 V, 1500 VA": A(1500, "typical 3-body condensing unit")},
        "Mortuary fridge modelled as a generic product: stainless cabinet on plinth and 6 feet; 3 full-length tier doors with gaskets, lever latches and keepers, hinges, "
        "name-card holders; top refrigeration unit with condenser grille, controller, display, alarm LED and mute keys. " + NESTED,
        connectors=[E("Refrigeration Unit", 'top')], type_values={"Voltage": 240, "Apparent Load": 1500})

# 4 Autopsy table 2400 x 800: pedestal, dished top, perforated grid, foot sink, gooseneck tap, spray hose, head rest
fam = "FMC_I_MedEq_Table_Autopsy"
P = [BX("Base Plate", [-450, -320, 0, 450, 320, 20], 'ss', r=20), BX("Pedestal", [-300, -220, 20, 300, 220, 760], 'ss', r=40),
     BX("Pedestal Cap", [-340, -260, 760, 340, 260, 800], 'ss', r=40),
     FB("Pedestal Control Panel", [-120, -224, 520, 120, -220, 640], 'grey', r=6, lod='f'), CY("Control Key", [-70, 580], 14, [-228, -224], 'black', lod='f', rep=(3, 70, 0, 0)),
     CZ("Levelling Foot", [-400, -270], 22, [-0.1, 20], 'black', lod='f', rep=(2, 800, 0, 0), seg=16),
     BX("Tray", [-1200, -400, 800, 820, 400, 860], 'ss', r=30),
     BX("Rim Front", [-1200, -400, 860, 820, -370, 900], 'ss'), BX("Rim Back", [-1200, 370, 860, 820, 400, 900], 'ss'),
     BX("Rim Head", [-1200, -370, 860, -1170, 370, 900], 'ss'),
     BX("Grid Slat", [-1120, -330, 866, -1080, 330, 874], 'ss', lod='f', rep=(19, 100, 0, 0)),
     BX("Grid Rail", [-1140, -340, 860, 780, -320, 866], 'ss', lod='f', rep=(2, 0, 660, 0)),
     BX("Drain Channel", [780, -340, 858, 820, 340, 862], 'grey', lod='f'),
     BX("Downdraught Slot", [-1100, -403, 875, 700, -400, 890], 'black', lod='f', rep=(2, 0, 803, 0)),
     BX("Sink Bottom", [820, -360, 760, 1200, 360, 780], 'ss'), BX("Sink Wall Front", [820, -400, 760, 1200, -360, 900], 'ss'),
     BX("Sink Wall Back", [820, 360, 760, 1200, 400, 900], 'ss'), BX("Sink Wall End", [1160, -360, 780, 1200, 360, 900], 'ss'),
     CZ("Sink Waste", [1000, 0], 30, [780, 782], 'chrome', lod='f'),
     CZ("Tap Pillar", [1180, 250], 18, [900, 1150], 'chrome'), CX("Tap Spout", [250, 1150], 12, [1000, 1180], 'chrome'),
     CZ("Tap Outlet", [1000, 250], 12, [1100, 1150], 'chrome'), BX("Tap Lever", [1180, 200, 1060, 1196, 240, 1070], 'chrome', lod='f'),
     CZ("Spray Hose Holder", [1180, -250], 20, [900, 1000], 'chrome'), CZ("Spray Head", [1180, -250], 26, [1000, 1040], 'black'),
     BX("Head Rest", [-1150, -110, 874, -950, 110, 950], 'rubber', r=40)]
product(fam, "Autopsy table 2400 x 800, stainless steel, pedestal base with controls, dished top with rims and perforated grid, foot-end sink, tap, spray hose and downdraught slots",
        "IfcMedicalDevice", ["2400x800_Pedestal"],
        {"ss": "FMC_Metal_StainlessSteel_Brushed", "grey": "FMC_Plastic_ABS_Grey", "black": "FMC_Plastic_ABS_Black", "chrome": "FMC_Metal_Chrome_Polished", "rubber": "FMC_Rubber_Black"}, P,
        {"Top 2400 x 800 mm": A("2400x800", "record size"), "Working height 900 mm": A(900, "typical fixed-height pedestal autopsy table"),
         "Stainless steel grade 304": A("304", "typical mortuary table construction")},
        "Autopsy table modelled as a generic product: pedestal on base plate with levelling feet and control keys; dished tray with rims, removable grid slats, drain channel, "
        "downdraught slots; sink at the foot with waste, gooseneck tap and lever, spray hose holder and head rest. " + NESTED)

# 5 Bench-top analyser 900 x 700 (sits on a bench top at z = 0)
fam = "FMC_I_MedEq_Analyser_Lab_Bench"
P = [BX("Lower Body", [-450, -700, 20, 450, 0, 430], 'body', r=20), BX("Upper Housing", [-450, -480, 430, 450, 0, 720], 'body', r=20),
     RT("Hood", [[-480, 720], [-480, 600], [-700, 440], [-700, 430], [-470, 430], [-470, 720]], [-430, 120], 'clear'),
     BX("Deck", [-440, -690, 430, 440, -480, 440], 'grey'),
     BX("Sample Rack", [-420, -660, 440, -390, -520, 520], 'white', rep=(5, 45, 0, 0)),
     BX("Sample Tube Caps", [-418, -655, 520, -392, -525, 535], 'cap', lod='f', rep=(5, 45, 0, 0)),
     TN("Reagent Carousel", 'z', [-120, -590], [[0, 440], [95, 440], [95, 470], [0, 470]], 'white'),
     CZ("Reagent Bottle", [-170, -590], 18, [470, 520], 'cap', lod='f', rep=(4, 33, 0, 0), seg=12),
     FB("Front Panel Door", [-430, -703, 60, 130, -700, 410], 'grey', r=8), BX("Door Grip", [60, -715, 200, 100, -703, 280], 'black', r=4, lod='f'),
     FB("Status Light Bar", [-440, -704, 415, 440, -700, 425], 'blue', lod='f'),
     BX("Monitor Arm", [270, -560, 720, 300, -520, 900], 'grey'), FB("Monitor", [150, -620, 880, 430, -560, 1080], 'black', r=10),
     FB("Touch Screen", [165, -622, 895, 415, -620, 1065], 'screen', r=6, lod='f'),
     FB("Bottle Bay", [160, -703, 60, 440, -700, 410], 'grey', r=8), CY("Reservoir Cap", [230, 360], 18, [-708, -703], 'blue', lod='f', rep=(3, 70, 0, 0)),
     RT("Side Vent Slat", [[-400, 150], [-100, 150], [-100, 158], [-400, 158]], [450, 453], 'grey', lod='f', rep=(10, 0, 0, 18)),
     CZ("Foot", [-410, -660], 20, [0, 20], 'black', lod='f', rep=(2, 820, 0, 0), seg=16), CZ("Foot Back", [-410, -40], 20, [0, 20], 'black', lod='f', rep=(2, 820, 0, 0), seg=16)]
product(fam, "Bench-top clinical chemistry analyser, 900 x 700 footprint, sample rack loader, reagent carousel under a clear hood, touch-screen monitor, front service doors",
        "IfcMedicalDevice", ["900x700_Benchtop"],
        {"body": "FMC_Plastic_ABS_MedicalGrey", "grey": "FMC_Plastic_ABS_Grey", "white": "FMC_Plastic_ABS_White", "clear": "FMC_Plastic_Polycarbonate_Clear",
         "black": "FMC_Plastic_ABS_Black", "screen": "FMC_Plastic_LED_Blue", "blue": "FMC_Plastic_ABS_Blue", "cap": "FMC_Plastic_LED_Red"}, P,
        {"Footprint 900 x 700 mm": A("900x700", "record size"), "Height 1080 mm with monitor": A(1080), "Supply 240 V, 1500 VA": A(1500, "typical bench analyser with cooler"),
         "Bench load about 150 kg": A(150, "typical mid-size bench analyser; check bench rating")},
        "Analyser modelled as a generic product: medical-grey lower body and upper housing, clear sloped hood over the reagent carousel and bottles, sample racks with tube caps on "
        "the loading deck, front doors with grip and bottle bay, status light bar, touch-screen monitor on an arm, side vents and feet. Sits on a bench top (z = 0). " + NESTED,
        connectors=[E("Upper Housing"), ELV("Upper Housing", 'top', 'LIS Data')], type_values={"Voltage": 240, "Apparent Load": 1500})

# 6 Bench centrifuge 600 x 600, sloped control front, round lid
fam = "FMC_I_MedEq_Centrifuge_Bench"
prof = rounded_profile([[-30, 30], [-600, 30], [-600, 150], [-470, 330], [-30, 330]], 25)
def slope_plate(n, x0, x1, s0, s1, off, m, lod='f'):
    """Plate on the sloped face from (y,z)=(-600,150) to (-470,330); s0..s1 is the fraction along it."""
    ay, az, by, bz = -600, 150, -470, 330; L = math.hypot(by - ay, bz - az); ux, uz = (by - ay) / L, (bz - az) / L; nx, nz = -uz, ux
    nx, nz = (nx, nz) if nx < 0 else (-nx, -nz)
    p = lambda s, o: [ay + ux * s * L + nx * o, az + uz * s * L + nz * o]
    return RT(n, [p(s0, 0), p(s1, 0), p(s1, off), p(s0, off)], [x0, x1], m, lod)
P = [RT("Body", prof, [-300, 300], 'body'),
     CZ("Foot", [-240, -560], 22, [0, 30], 'black', rep=(2, 480, 0, 0), seg=16), CZ("Foot Back", [-240, -70], 22, [0, 30], 'black', rep=(2, 480, 0, 0), seg=16),
     TN("Lid", 'z', [0, -250], [[0, 330], [215, 330], [215, 345], [195, 372], [0, 380]], 'lid'),
     CZ("Lid Window", [0, -250], 80, [379, 384], 'clear', lod='f'),
     BX("Lid Hinge", [-60, -50, 330, 60, -25, 360], 'grey', lod='f'),
     slope_plate("Control Panel", -260, 260, 0.08, 0.92, 3, 'grey', 'mf'),
     slope_plate("Display", -220, 40, 0.3, 0.8, 5, 'black'), slope_plate("Display Readout", -200, 10, 0.4, 0.7, 6, 'green'),
     slope_plate("Start Key", 80, 140, 0.3, 0.55, 6, 'green'), slope_plate("Stop Key", 160, 220, 0.3, 0.55, 6, 'red'),
     slope_plate("Lid Release Key", 80, 220, 0.62, 0.8, 6, 'blue'),
     RT("Side Vent Slat", [[-450, 120], [-150, 120], [-150, 126], [-450, 126]], [300, 302], 'grey', lod='f', rep=(6, 0, 0, 20)),
     FB("Mains Switch", [200, -30, 80, 240, -27, 130], 'black', lod='f')]
product(fam, "Bench-top centrifuge, refrigerated class, 600 x 600, round hinged lid with window, sloped control panel with display and start/stop keys",
        "IfcMedicalDevice", ["600x600_Benchtop"],
        {"body": "FMC_Plastic_ABS_White", "lid": "FMC_Plastic_ABS_MedicalGrey", "grey": "FMC_Plastic_ABS_Grey", "clear": "FMC_Plastic_Polycarbonate_Clear", "black": "FMC_Plastic_ABS_Black",
         "green": "FMC_Plastic_LED_Green", "red": "FMC_Plastic_LED_Red", "blue": "FMC_Plastic_ABS_Blue"}, P,
        {"Footprint 600 x 600 mm": A("600x600", "record size"), "Height 380 mm, 760 mm with lid open": A(380, "typical refrigerated bench centrifuge"),
         "Supply 240 V, 1000 VA": A(1000, "typical refrigerated bench centrifuge")},
        "Centrifuge modelled as a generic product: rounded body with sloped front, round domed lid with window and rear hinge, control panel with display, start, stop and lid-release keys, "
        "side vents, mains switch and 4 feet. Sits on a bench top (z = 0). " + NESTED,
        connectors=[E("Body")], type_values={"Voltage": 240, "Apparent Load": 1000})

# 7 Microscope station 500 x 400: binocular compound microscope
fam = "FMC_I_MedEq_Microscope_Bench"
P = [BX("Base", [-110, -200, 0, 110, 60, 50], 'body', r=30), CZ("Foot", [-80, -170], 10, [-0.1, 4], 'black', lod='f', rep=(2, 160, 0, 0)),
     CZ("Illuminator Lens", [0, -110], 26, [50, 60], 'clear', lod='f'), CX("Light Dial", [-60, 30], 18, [110, 120], 'black', lod='f'),
     FR("Arm", [[-30, 50], [30, 50], [30, 300], [-30, 300]], [20, 70], 'body'),
     RT("Arm Neck", [[20, 290], [70, 290], [70, 420], [-140, 420], [-140, 330], [20, 330]], [-30, 30], 'body'),
     BX("Stage", [-80, -190, 180, 80, 20, 196], 'black'), BX("Stage Clip", [-60, -170, 196, -20, -150, 200], 'chrome', lod='f', rep=(2, 80, 0, 0)),
     BX("Mechanical Stage", [80, -150, 186, 100, -20, 196], 'black', lod='f'), CZ("Stage Knob", [100, -50], 10, [130, 178], 'black', lod='f'),
     TN("Condenser", 'z', [0, -110], [[0, 140], [22, 140], [22, 178], [0, 178]], 'black'),
     TN("Nosepiece", 'z', [0, -110], [[0, 300], [38, 300], [44, 316], [0, 330]], 'chrome'),
     CZ("Objective", [-26, -110], 9, [240, 300], 'chrome', rep=(3, 26, 0, 0), seg=16),
     TN("Head", 'z', [0, -80], [[0, 420], [55, 420], [55, 450], [0, 462]], 'body'),
     RT("Eyepiece Tube", [[-100, 440], [-70, 440], [-170, 510], [-190, 510]], [-46, -24], 'body', rep=(2, 70, 0, 0)),
     CZ("Eyepiece", [-35, -180], 15, [510, 540], 'black', rep=(2, 70, 0, 0), seg=16),
     CX("Coarse Focus Knob", [-10, 120], 32, [-58, -30], 'black', rep=(2, 88, 0, 0)), CX("Fine Focus Knob", [-10, 120], 20, [-72, -58], 'grey', lod='f', rep=(2, 116, 0, 0)),
     BX("Work Zone Mat", [-250, -400, -0.1, 250, 0, 0.0], 'mat', lod='f')]
product(fam, "Laboratory microscope station 500 x 400: binocular compound microscope with LED base illuminator, mechanical stage, 3-objective nosepiece, coarse and fine focus",
        "IfcMedicalDevice", ["500x400_Binocular"],
        {"body": "FMC_Plastic_ABS_White", "black": "FMC_Plastic_ABS_Black", "grey": "FMC_Plastic_ABS_Grey", "chrome": "FMC_Metal_Chrome_Polished", "clear": "FMC_Glass_Clear",
         "mat": "FMC_Plastic_ABS_MedicalGrey"}, P,
        {"Station 500 x 400 mm": A("500x400", "record size (bench zone)"), "Microscope 220 x 260 x 500 mm": A("220x260x500", "typical upright binocular microscope")},
        "Microscope modelled as a generic product on a 500 x 400 bench zone: base with illuminator lens and dial, C-arm and neck, stage with clips and mechanical stage, condenser, "
        "nosepiece with 3 objectives, head with two inclined eyepiece tubes and eyepieces, coarse and fine focus knobs both sides. Sits on a bench top (z = 0).")

# 8 Physio plinth 1900 x 700, 3-section, electric height-adjustable
fam = "FMC_I_MedEq_Physio_Plinth"
P = [BX("Base Frame", [-750, -260, 90, 750, 260, 130], 'frame', r=10),
     BX("Lift Column", [-320, -180, 130, -120, 180, 560], 'frame', r=20, rep=(2, 440, 0, 0)),
     BX("Top Frame", [-900, -300, 560, 900, 300, 600], 'frame', r=10),
     FB("Head Section", [-950, -350, 600, -380, 350, 680], 'vinyl', r=25), FB("Body Section", [-370, -350, 600, 470, 350, 680], 'vinyl', r=25),
     FB("Leg Section", [480, -350, 600, 950, 350, 680], 'vinyl', r=25),
     CZ("Face Hole", [-760, 0], 70, [680, 682], 'black', lod='f', seg=24), CZ("Face Hole Plug", [-760, 0], 60, [682, 684], 'vinyl2', lod='f', seg=24),
     BX("Arm Rest", [-700, -420, 560, -460, -350, 640], 'vinyl', r=20, lod='f', rep=(2, 0, 770, 0)),
     BX("Motor Housing", [-100, -150, 400, 100, 150, 520], 'grey', r=15),
     BX("Foot Control Bar", [-800, -340, 50, 800, -310, 70], 'frame', r=8), BX("Foot Control Bar Back", [-800, 310, 50, 800, 340, 70], 'frame', r=8),
     BX("Foot Bar End", [-830, -340, 50, -800, 340, 70], 'frame', r=8, rep=(2, 1630, 0, 0)),
     BX("Handset", [300, -380, 360, 340, -350, 480], 'grey', r=10, lod='f'), CY("Handset Key", [320, 450], 7, [-384, -380], 'blue', lod='f', rep=(2, 0, 0, -40)),
     BX("Paper Roll Bracket", [-990, -260, 560, -950, 260, 600], 'frame', lod='f'), CX("Paper Roll", [0, 600], 40, [-1010, -990], 'white', lod='f')]
P += castors("Castor", [-700, 700], [-220, 220], 90, wr=40, w=28)
product(fam, "Physiotherapy treatment plinth 1900 x 700, 3 sections with face hole, electric height adjustment 500-950 mm on twin columns, perimeter foot control bar, castors",
        "IfcMedicalDevice", ["1900x700_3Section"],
        {"frame": "FMC_Metal_Steel_EpoxyCoated_White", "vinyl": "FMC_Fabric_Vinyl_Upholstery_Blue", "vinyl2": "FMC_Fabric_Mattress_PU_Blue", "black": "FMC_Plastic_ABS_Black",
         "grey": "FMC_Plastic_ABS_Grey", "blue": "FMC_Plastic_ABS_Blue", "white": "FMC_Plastic_ABS_White", "castor": "FMC_Plastic_Nylon_CastorGrey"}, P,
        {"Top 1900 x 700 mm": A("1900x700", "record size"), "Height 500 to 950 mm (shown 680)": A("500-950", "typical electric physio plinth"),
         "Safe working load 200 kg": A(200, "typical electric treatment plinth")},
        "Plinth modelled as a generic product: twin lift columns on a base frame, motor housing, top frame, head section with face hole and plug, body and leg sections, arm rests, "
        "perimeter foot control bar, hand set, paper roll and 4 castors. The record lists no connectors; the plinth plugs into a bedside socket.")

# 9 Parallel bars 3000 x 900
fam = "FMC_I_MedEq_Physio_ParallelBars"
P = [BX("Platform", [-1500, -450, 0, 1500, 450, 40], 'timber', r=10), BX("Non Slip Deck", [-1450, -400, 40, 1450, 400, 44], 'deck')]
P.append(FR("Ramp End", [[-1600, 0], [-1500, 0], [-1500, 40]], [-450, 450], 'deck'))
P.append(FR("Ramp Start", [[1500, 0], [1600, 0], [1500, 40]], [-450, 450], 'deck'))
for side, y in (("Left", -380), ("Right", 380)):
    P += [BX(f"Base Track {side}", [-1450, y - 40, 44, 1450, y + 40, 60], 'frame', r=8),
          CZ(f"Upright {side}", [-1350, y], 25, [60, 860], 'frame', rep=(3, 1350, 0, 0)),
          CZ(f"Height Collar {side}", [-1350, y], 32, [600, 660], 'black', lod='f', rep=(3, 1350, 0, 0)),
          CY(f"Clamp Knob {side}", [-1350, 630], 14, ([y - 70, y - 32] if y < 0 else [y + 32, y + 70]), 'black', lod='f', rep=(3, 1350, 0, 0)),
          CZ(f"Rail Saddle {side}", [-1350, y], 30, [860, 880], 'frame', lod='f', rep=(3, 1350, 0, 0)),
          CX(f"Hand Rail {side}", [y, 900], 22, [-1450, 1450], 'timber2'),
          TN(f"Rail End Cap {side}", 'x', [y, 900], [[0, -1475], [22, -1450], [0, -1450]], 'black', lod='f'),
          TN(f"Rail End Cap {side} Far", 'x', [y, 900], [[0, 1450], [22, 1450], [0, 1475]], 'black', lod='f')]
product(fam, "Physiotherapy parallel walking bars 3000 x 900, timber platform with non-slip deck and end ramps, height-adjustable uprights on base tracks, timber hand rails",
        "IfcMedicalDevice", ["3000x900_HeightAdj"],
        {"timber": "FMC_Timber_Mvule", "timber2": "FMC_Timber_Musizi", "deck": "FMC_Rubber_Black", "frame": "FMC_Metal_Steel_EpoxyCoated_White", "black": "FMC_Plastic_ABS_Black"}, P,
        {"Length 3000 mm, width 900 mm": A("3000x900", "record size"), "Rail height 700 to 1000 mm (shown 900)": A("700-1000", "typical adjustable parallel bars"),
         "Approach zone 1500 mm at the entry end": A(1500, "wheelchair turning space, BS 8300 / HBN 00-03")},
        "Parallel bars modelled as a generic product: platform with rubber non-slip deck and end ramps, base tracks, 3 uprights a side with height collars and clamp knobs, "
        "rail saddles, timber hand rails with end caps.",
        clearances=[{"n": "Approach Zone", "shape": "box", "at": [1600, -750, 0, 3100, 750, 10], "sub": "Clearance Accessibility"}])

# ================================================================ FURNITURE
M_CASE = {"carc": "FMC_Board_Melamine_White", "front": "FMC_Plastic_Laminate_HPL", "top": "FMC_Plastic_Laminate_HPL", "plinth": "FMC_Metal_StainlessSteel_Brushed",
          "hdl": "FMC_Metal_StainlessSteel_Brushed"}

# 10 Bedside locker 500 x 450 x 850
fam = "FMC_I_Furniture_Locker_Bedside"
P = [BX("Carcass", [-250, -430, 110, 250, 0, 820], 'carc', r=6), BX("Top", [-260, -450, 820, 260, 10, 850], 'top', r=20),
     BX("Top Lip", [-260, -10, 850, 260, 10, 880], 'abs', r=6), BX("Top Lip Side", [-260, -450, 850, -240, 10, 870], 'abs', r=6, rep=(2, 500, 0, 0)),
     FB("Drawer Front", [-245, -450, 640, 245, -430, 810], 'front', r=6), FB("Drawer Grip", [-80, -456, 760, 80, -450, 790], 'abs', r=8, lod='f'),
     FB("Door Leaf", [-245, -450, 130, 245, -430, 630], 'front', r=6), FB("Door Grip", [170, -456, 450, 200, -450, 600], 'abs', r=8, lod='f'),
     CZ("Door Hinge", [-238, -440], 6, [160, 200], 'grey', lod='f', rep=(2, 0, 0, 380)),
     BX("Inner Shelf", [-230, -420, 370, 230, -20, 388], 'carc', lod='f'),
     BX("Base", [-250, -430, 70, 250, 0, 110], 'abs', r=6),
     CZ("Towel Rail Post", [270, -380], 8, [600, 780], 'ss', lod='f', rep=(2, 0, 330, 0)), CY("Towel Rail", [282, 780], 9, [-390, -40], 'ss')]
P[-1] = BX("Towel Rail", [262, -390, 770, 280, -40, 790], 'ss', r=8)
P += castors("Castor", [-200, 200], [-380, -50], 70, wr=30, w=22, fork='grey')
product(fam, "Bedside locker 500 x 450 x 850, drawer over cupboard, raised-lip worktop, side towel rail, on 4 castors (2 braked), HPL and ABS",
        "IfcFurniture", ["500x450x850_Drawer"],
        dict(M_CASE, abs="FMC_Plastic_ABS_White", grey="FMC_Plastic_ABS_Grey", ss="FMC_Metal_StainlessSteel_Brushed", frame="FMC_Plastic_ABS_Grey", castor="FMC_Plastic_Nylon_CastorGrey"), P,
        {"Size 500 x 450 x 850 mm": A("500x450x850", "record size"), "Castor 75 mm, 2 braked": A(75, "typical ward locker")},
        "Locker modelled as a generic product: carcass, worktop with raised lip on three sides, drawer with moulded grip, door with grip and hinges, inner shelf, ABS base, "
        "side towel rail on posts, 4 castors.")

# 11 Waiting beam seating 3/4/5 seats, pitch 640
fam = "FMC_I_Furniture_Seating_Waiting_Beam"
pitch = 640
T3, T4, T5 = "1920_3Seat", "2560_4Seat", "3200_5Seat"
def bs_seat(i):   # seat i (0-based), origin at the left end of the beam
    x0 = i * pitch
    return [BX(f"Seat Bracket {i + 1}", [x0 + pitch / 2 - 30, -300, 440, x0 + pitch / 2 + 30, 260, 455], 'frame'),
            RT(f"Seat Shell {i + 1}", [[-330, 455], [260, 455], [260, 470], [-330, 470], [-340, 465]], [x0 + 30, x0 + pitch - 30], 'shell'),
            BX(f"Seat Pad {i + 1}", [x0 + 45, -320, 470, x0 + pitch - 45, 250, 510], 'vinyl', r=40),
            BX(f"Back Strut {i + 1}", [x0 + pitch / 2 - 25, 230, 455, x0 + pitch / 2 + 25, 260, 560], 'frame'),
            RT(f"Back Shell {i + 1}", [[250, 540], [290, 540], [340, 900], [300, 900]], [x0 + 30, x0 + pitch - 30], 'shell'),
            RT(f"Back Pad {i + 1}", [[215, 600], [250, 560], [300, 880], [265, 890]], [x0 + 50, x0 + pitch - 50], 'vinyl')]
def bs_arm(i):
    x0 = i * pitch
    return [BX(f"Arm Post {i + 1}", [x0 - 15, -260, 455, x0 + 15, -220, 640], 'frame'), BX(f"Arm Pad {i + 1}", [x0 - 25, -300, 640, x0 + 25, 120, 670], 'arm', r=20)]
def bs_leg(x, tag):
    return [BX(f"Leg {tag}", [x - 30, -40, 40, x + 30, 0, 380], 'frame', r=8), BX(f"Leg Foot {tag}", [x - 50, -320, 0, x + 50, 280, 40], 'frame', r=12),
            CZ(f"Glide {tag}", [x, -290], 18, [-0.1, 4], 'rubber', lod='f'), CZ(f"Glide Back {tag}", [x, 250], 18, [-0.1, 4], 'rubber', lod='f')]
P = bs_leg(210, "Left") + sum((bs_seat(i) for i in range(3)), []) + sum((bs_arm(i) for i in range(4)), [])
P += only(bs_seat(3) + bs_arm(4), [T4, T5]) + only(bs_seat(4) + bs_arm(5), [T5])
for n, t in ((3, T3), (4, T4), (5, T5)):
    L = n * pitch
    P += only([BX(f"Beam {n}S", [-40, -60, 380, L + 40, 20, 440], 'frame', r=8)] + bs_leg(L - 210, f"Right {n}S"), [t])
types = [{"name": f"{k * pitch}_{k}Seat", "desc": f"Beam seating, {k} seats at {pitch} mm pitch, antimicrobial vinyl pads, steel beam on 2 T-legs"} for k in (3, 4, 5)]
product(fam, "Waiting-area beam seating, seats at 640 mm pitch with arms between, antimicrobial vinyl seat and back pads on moulded shells, steel beam on 2 T-legs",
        "IfcFurniture", types,
        {"frame": "FMC_Metal_Aluminium_PowderCoated", "shell": "FMC_Plastic_ABS_Grey", "vinyl": "FMC_Fabric_Vinyl_Upholstery_Blue", "arm": "FMC_Plastic_ABS_Black", "rubber": "FMC_Rubber_Black"}, P,
        {"Seat pitch 640 mm": A(640, "typical beam seating"), "Seat height 470 mm, overall height 900 mm": A("470/900", "typical beam seating; BS EN 16139"),
         "Length 1920 / 2560 / 3200 mm": A("1920/2560/3200", "seats x pitch")},
        "Beam seating modelled as a generic product: powder-coated beam on 2 T-legs with glides, seat brackets, moulded seat and back shells, vinyl seat and back pads, "
        "arm posts with pads between seats. Origin at the left end of the beam; seats 1-3 are shared, seats 4 and 5, the beam and the right leg are per type.", drawn="1920_3Seat")

# 12 Corridor bench, backless 1200/1800
fam = "FMC_I_Furniture_Seating_Corridor_Bench"
def corridor_bench(L):
    x0 = -L / 2
    return [BX("Seat Pad", [x0, -220, 400, -x0, 220, 460], 'vinyl', r=40), BX("Seat Board", [x0 + 15, -205, 380, -x0 - 15, 205, 400], 'board'),
     BX("Seat Rail", [x0 + 40, -190, 340, -x0 - 40, -150, 380], 'frame', r=6, rep=(2, 0, 340, 0)),
     FR("Leg Frame", [[x0 + 60, 0], [x0 + 120, 0], [x0 + 140, 380], [x0 + 80, 380]], [-190, -150], 'frame', rep=(2, 0, 340, 0)),
     FR("Leg Frame Right", [[-x0 - 120, 0], [-x0 - 60, 0], [-x0 - 80, 380], [-x0 - 140, 380]], [-190, -150], 'frame', rep=(2, 0, 340, 0)),
     BX("Leg Cross Bar", [x0 + 80, -190, 120, x0 + 120, 190, 150], 'frame', rep=(2, L - 200, 0, 0)),
     CZ("Glide", [x0 + 90, -170], 16, [-0.1, 6], 'rubber', lod='f', rep=(2, L - 180, 0, 0)), CZ("Glide Back", [x0 + 90, 170], 16, [-0.1, 6], 'rubber', lod='f', rep=(2, L - 180, 0, 0)),
     FB("Piping Front", [x0 + 20, -224, 425, -x0 - 20, -220, 435], 'arm', lod='f'), FB("Piping Back", [x0 + 20, 220, 425, -x0 - 20, 224, 435], 'arm', lod='f')]
P = typed(corridor_bench, {"1200_Backless": ("1200", 1200), "1800_Backless": ("1800", 1800)})
product(fam, "Backless corridor bench, antimicrobial vinyl seat pad on a ply seat board, steel sled frames with cross bars and glides",
        "IfcFurniture", [{"name": "1200_Backless", "desc": "Backless corridor bench 1200 x 440, antimicrobial vinyl, steel frame"}, {"name": "1800_Backless", "desc": "Backless corridor bench 1800 x 440, antimicrobial vinyl, steel frame"}],
        {"vinyl": "FMC_Fabric_Vinyl_Upholstery_Blue", "board": "FMC_Board_Plywood_Marine18", "frame": "FMC_Metal_Aluminium_PowderCoated", "rubber": "FMC_Rubber_Black", "arm": "FMC_Plastic_ABS_Black"}, P,
        {"Length 1200 / 1800 mm, depth 440 mm": A("1200/1800x440", "record types; typical bench depth"), "Seat height 460 mm": A(460, "BS EN 16139 / HBN 00-04 rest-stop seating")},
        "Bench modelled as a generic product: upholstered vinyl seat pad with piping on a ply board, seat rails, tapered sled leg frames with cross bars and glides.", drawn="1200_Backless")

# 13 Bariatric waiting chair 700 wide
fam = "FMC_I_Furniture_Chair_Bariatric_Waiting"
P = [BX("Leg Front", [-350, -300, 0, -310, -260, 470], 'frame', r=8, rep=(2, 660, 0, 0)),
     RT("Leg Back", [[200, 0], [240, 0], [280, 470], [240, 470]], [-350, -310], 'frame'), RT("Leg Back Right", [[200, 0], [240, 0], [280, 470], [240, 470]], [310, 350], 'frame'),
     BX("Seat Rail Side", [-350, -300, 430, -310, 280, 470], 'frame', rep=(2, 660, 0, 0)),
     BX("Seat Rail Front", [-310, -300, 430, 310, -260, 470], 'frame'), BX("Side Stretcher", [-350, -260, 150, -310, 215, 180], 'frame', rep=(2, 660, 0, 0)),
     BX("Cross Stretcher", [-310, -20, 150, 310, 20, 180], 'frame'),
     BX("Seat Cushion", [-320, -320, 470, 320, 260, 560], 'vinyl', r=40),
     RT("Back Frame", [[250, 470], [290, 470], [360, 1000], [320, 1000]], [-350, -310], 'frame'), RT("Back Frame Right", [[250, 470], [290, 470], [360, 1000], [320, 1000]], [310, 350], 'frame'),
     RT("Back Cushion", [[210, 570], [270, 560], [330, 980], [270, 990]], [-310, 310], 'vinyl'),
     BX("Arm Post", [-350, -280, 470, -310, -240, 700], 'frame', rep=(2, 660, 0, 0)),
     BX("Arm Pad", [-365, -320, 700, -295, 260, 740], 'arm', r=25, rep=(2, 660, 0, 0)),
     CZ("Glide", [-330, -280], 18, [-0.1, 5], 'rubber', lod='f', rep=(2, 660, 0, 0)), CZ("Glide Back", [-330, 220], 18, [-0.1, 5], 'rubber', lod='f', rep=(2, 660, 0, 0)),
     FB("Load Label", [-60, -324, 500, 60, -320, 530], 'label', r=4, lod='f')]
product(fam, "Bariatric waiting chair 700 wide, rated 250 kg+, seat 500 high, reinforced steel frame, wide arms, high back, antimicrobial vinyl",
        "IfcFurniture", ["700_Bariatric"],
        {"frame": "FMC_Metal_SteelLTZ_Painted", "vinyl": "FMC_Fabric_Vinyl_Upholstery_Blue", "arm": "FMC_Plastic_ABS_Black", "rubber": "FMC_Rubber_Black", "label": "FMC_Plastic_ABS_White"}, P,
        {"Width 700 mm": A(700, "record type"), "Seat height 500 mm": A(500, "record note"), "Rated load 250 kg+": A(250, "record note; BS EN 16139 level 2 bariatric"),
         "Front transfer space 900 mm": A(900, "HBN 00-03 / BS 8300")},
        "Bariatric chair modelled as a generic product: reinforced steel front and raked back legs, seat rails, stretcher, deep seat and high back cushions, wide arm posts and pads, "
        "glides and load-rating label.",
        clearances=[{"n": "Transfer Space", "shape": "box", "at": [-450, -1220, 0, 450, -320, 10], "sub": "Clearance Accessibility"}])

# 14 Modular lounge seating straight / curved
fam = "FMC_I_Furniture_Seating_Modular_Lounge"
def sector(ri, ro, a0, a1, C=(0, -1942), n=6):
    pts = [[C[0] + ro * math.cos(math.radians(a0 + (a1 - a0) * k / n)), C[1] + ro * math.sin(math.radians(a0 + (a1 - a0) * k / n))] for k in range(n + 1)]
    pts += [[C[0] + ri * math.cos(math.radians(a1 - (a1 - a0) * k / n)), C[1] + ri * math.sin(math.radians(a1 - (a1 - a0) * k / n))] for k in range(n + 1)]
    return pts
def lounge_curved(_):
    """Concave 45 degree module: outer (back) radius 2292 gives an 1800 outer arc; seats face the arc centre at (0, -1942)."""
    ro, ri = 2292, 1592; P = [PR("Plinth", sector(ri + 20, ro - 20, 68.5, 111.5), [0, 120], 'plinthm'), PR("Base", sector(ri, ro, 67.5, 112.5), [120, 300], 'fab2'),
                              PR("Back Shell", sector(ro - 20, ro, 67.5, 112.5, n=9), [120, 830], 'fab2')]
    for k in range(3):
        a0 = 67.5 + 15 * k
        P += [PR(f"Seat Cushion {k + 1}", sector(ri - 10, ro - 140, a0 + 0.25, a0 + 14.75, n=3), [300, 440], 'fab'),
              PR(f"Back Cushion {k + 1}", sector(ro - 150, ro - 20, a0 + 0.25, a0 + 14.75, n=3), [300, 800], 'fab')]
    return P
def lounge_straight(_):
    return [BX("Plinth", [-880, -330, 20, 880, 330, 120], 'plinthm', r=10), BX("Base", [-900, -350, 120, 900, 350, 300], 'fab2', r=20),
     BX("Seat Cushion", [-890, -360, 300, -300, 220, 440], 'fab', r=40, rep=(3, 593.3, 0, 0)),
     RT("Back Cushion", [[200, 300], [350, 300], [350, 820], [250, 800]], [-890, -300], 'fab', rep=(3, 593.3, 0, 0)),
     BX("Back Shell", [-900, 340, 120, 900, 360, 830], 'fab2', r=10),
     BX("Seam", [-302, -362, 300, -298, 220, 440], 'plinthm', lod='f', rep=(2, 593.3, 0, 0)),
     CZ("Foot", [-850, -300], 18, [0, 20], 'plinthm', lod='f', rep=(2, 1700, 0, 0)), CZ("Foot Back", [-850, 300], 18, [0, 20], 'plinthm', lod='f', rep=(2, 1700, 0, 0))]
P = typed(lounge_straight, {"1800_Straight": ("Straight", 0)}) + typed(lounge_curved, {"1800_Curved": ("Curved", 0)})
P += [BX("Power Module", [-60, -366, 200, 60, -350, 260], 'black', r=6, lod='f'), FB("USB Port", [-40, -368, 220, 40, -366, 240], 'grey', lod='f')]
product(fam, "Modular reception lounge seating, 3-seat module 1800 wide, wipe-clean upholstered seat and back cushions on a plinth base",
        "IfcFurniture", [{"name": "1800_Straight", "desc": "Modular lounge seating, straight 3-seat module 1800 x 700"}, {"name": "1800_Curved", "desc": "Modular lounge seating, curved 3-seat module, 45 degree arc, outer length 1800"}],
        {"fab": "FMC_Fabric_Upholstery_WipeClean_Grey", "fab2": "FMC_Fabric_Vinyl_Upholstery_Blue", "plinthm": "FMC_Metal_Aluminium_PowderCoated", "black": "FMC_Plastic_ABS_Black", "grey": "FMC_Plastic_ABS_Grey"}, P,
        {"Module 1800 x 700 mm, 3 seats": A("1800x700", "typical modular lounge module"), "Seat height 440 mm, back 830 mm": A("440/830", "typical soft seating")},
        "Lounge module modelled as a generic product: powder-coated plinth and feet, upholstered base, 3 seat cushions and inclined back cushions with seams, back shell, "
        "front power and USB module.", drawn="1800_Straight")

# 15 Anti-ligature bench 1200/1800, rotomoulded, fixed
fam = "FMC_I_Furniture_Seating_AntiLigature"
prof = rounded_profile([[-260, 0], [260, 0], [260, 380], [330, 820], [230, 830], [170, 460], [-280, 460]], 45, 4)
def antilig(L):
    return [RT("Body", prof, [-L / 2 + 40, L / 2 - 40], 'pe'),
     RT("End Cap Left", rounded_profile([[-250, 10], [250, 10], [250, 380], [310, 800], [240, 810], [180, 450], [-270, 450]], 45, 4), [-L / 2, -L / 2 + 40], 'pe'),
     RT("End Cap Right", rounded_profile([[-250, 10], [250, 10], [250, 380], [310, 800], [240, 810], [180, 450], [-270, 450]], 45, 4), [L / 2 - 40, L / 2], 'pe'),
     CZ("Ballast Fill Cap", [0, -180], 25, [460, 464], 'pe2', lod='f'),
     FB("Fixing Cover", [-L / 2 + 120, -262, 60, -L / 2 + 180, -260, 120], 'pe2', r=25, lod='f', rep=(2, L - 300, 0, 0)),
     BX("Floor Fixing Plate", [-L / 2 + 60, -240, -0.1, L / 2 - 60, 240, 2], 'ss', lod='f')]
P = typed(antilig, {"1200_Fixed": ("1200", 1200), "1800_Fixed": ("1800", 1800)})
product(fam, "Anti-ligature fixed bench, one-piece rotomoulded polyethylene, ballast filled, no gaps or ligature points, concealed floor fixings",
        "IfcFurniture", [{"name": "1200_Fixed", "desc": "Anti-ligature rotomoulded bench 1200, fixed"}, {"name": "1800_Fixed", "desc": "Anti-ligature rotomoulded bench 1800, fixed"}],
        {"pe": "FMC_Plastic_Polyethylene_Rotomoulded_Blue", "pe2": "FMC_Plastic_ABS_Grey", "ss": "FMC_Metal_StainlessSteel_Brushed"}, P,
        {"Length 1200 / 1800 mm": A("1200/1800", "record types"), "Seat height 460 mm, back 830 mm": A("460/830", "typical anti-ligature bench"),
         "Weight 90 kg filled": A(90, "typical ballast-filled rotomoulded bench")},
        "Anti-ligature bench modelled as a generic product: one-piece rounded rotomoulded body with integral back, rounded end caps, dished seat, ballast fill cap, "
        "tamper-proof fixing covers and floor fixing plate. Colour drawn blue; finish to the mental health brief.", drawn="1200_Fixed")

# 16 Consulting desk 1400 x 700 with pedestal, modesty panel, cable tray, power/data module
fam = "FMC_I_Furniture_Desk_Consulting"
P = [BX("Desk Top", [-700, -700, 720, 700, 0, 745], 'top', r=8), FB("Edge Band", [-700, -702, 720, 700, -700, 745], 'edge', lod='f'),
     BX("End Panel Left", [-700, -660, 0, -675, -20, 720], 'carc'), BX("End Panel Right", [675, -660, 0, 700, -20, 720], 'carc'),
     BX("Modesty Panel", [-675, -60, 300, 675, -40, 700], 'carc'), BX("Cable Tray", [-500, -120, 640, 500, -60, 700], 'steel', lod='f'),
     CZ("Cable Grommet", [-450, -80], 35, [744, 747], 'black', lod='f', rep=(2, 900, 0, 0)),
     BX("Power Module", [380, -110, 745, 560, -50, 805], 'alu', r=6), FB("Socket Face", [390, -112, 760, 470, -110, 795], 'white', r=4, lod='f', rep=(2, 85, 0, 0)),
     BX("Pedestal", [200, -660, 30, 660, -100, 690], 'carc', r=4),
     FB("Pedestal Drawer", [205, -680, 560, 655, -660, 685], 'front', r=3), FB("Pedestal Drawer Mid", [205, -680, 420, 655, -660, 555], 'front', r=3),
     FB("Pedestal File Drawer", [205, -680, 40, 655, -660, 415], 'front', r=3),
     CX("Drawer Handle", [-695, 650], 6, [370, 490], 'alu', lod='f'), CX("Drawer Handle Mid", [-695, 520], 6, [370, 490], 'alu', lod='f'),
     CX("Drawer Handle File", [-695, 380], 6, [370, 490], 'alu', lod='f'), CY("Pedestal Lock", [600, 660], 8, [-684, -680], 'alu', lod='f'),
     CZ("Leveller", [-688, -600], 10, [-0.1, 3], 'black', lod='f', rep=(2, 1376, 0, 0))]
product(fam, "Consulting desk 1400 x 700, HPL top with edge band, panel ends, modesty panel, cable tray and grommets, desk-top power and data module, 3-drawer pedestal",
        "IfcFurniture", ["1400x700_Pedestal"],
        {"top": "FMC_Plastic_Laminate_HPL", "edge": "FMC_Plastic_ABS_Grey", "carc": "FMC_Board_Melamine_White", "front": "FMC_Plastic_Laminate_HPL", "steel": "FMC_Metal_SteelLTZ_Painted",
         "black": "FMC_Plastic_ABS_Black", "alu": "FMC_Metal_Aluminium_Anodised_Silver", "white": "FMC_Plastic_ABS_White"}, P,
        {"Top 1400 x 700 mm, height 720 mm": A("1400x700x720", "record size; BS EN 527-1 desk height"), "Supply 240 V, 500 VA (PC and screens)": A(500, "typical consulting PC point")},
        "Desk modelled as a generic product: HPL top with ABS edge band, melamine panel ends and modesty panel, cable tray, grommets, pop-up power and data module with two outlets, "
        "3-drawer pedestal (2 box, 1 file) with handles and lock, levellers. Stands with its back at y = 0.",
        connectors=[E("Power Module", 'bottom'), ELV("Power Module", 'back')], type_values={"Voltage": 240, "Apparent Load": 500})

# 17 Task chair: 5-star base, castors, gas lift, seat, back, arms
fam = "FMC_I_Furniture_Chair_Consulting"
P = [CZ("Hub", [0, 0], 35, [60, 110], 'black'), CZ("Gas Lift", [0, 0], 22, [110, 330], 'black'), CZ("Gas Lift Shroud", [0, 0], 28, [110, 230], 'grey', lod='f'),
     BX("Mechanism", [-130, -150, 330, 130, 120, 370], 'black', r=20), BX("Height Lever", [130, -100, 350, 220, -80, 360], 'black', r=6, lod='f'),
     BX("Seat", [-250, -260, 370, 250, 220, 450], 'fab', r=70), BX("Seat Shell", [-240, -250, 360, 240, 210, 372], 'black', r=60),
     RT("Back Upright", [[180, 360], [230, 360], [250, 600], [205, 600]], [-25, 25], 'black'),
     RT("Back", [[200, 560], [260, 560], [280, 1000], [220, 1000]], [-230, 230], 'fab'),
     RT("Lumbar Pad", [[192, 620], [205, 620], [210, 720], [198, 720]], [-160, 160], 'black', lod='f'),
     BX("Arm Post", [-270, -50, 370, -240, 0, 620], 'black', r=8, rep=(2, 510, 0, 0)), BX("Arm Pad", [-280, -200, 620, -230, 60, 645], 'black', r=20, rep=(2, 510, 0, 0))]
for i in range(5):
    a = 90 + 72 * i; ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
    P.append(PR(f"Star Leg {i + 1}", rot_rect(ca * 175, sa * 175, 300, 45, a), [60, 95], 'alu'))
    P.append(CZ(f"Castor {i + 1} Hood", [ca * 320, sa * 320], 28, [30, 62], 'black', seg=16))
    P.append(PR(f"Castor {i + 1} Wheel", rot_rect(ca * 320, sa * 320, 50, 40, a + 90), [0, 50], 'castor'))
product(fam, "Clinician task chair: 5-star aluminium base on castors, gas lift with synchro mechanism, upholstered seat and back with lumbar pad, height-adjustable arms",
        "IfcFurniture", ["650_Task"],
        {"fab": "FMC_Fabric_Vinyl_Upholstery_Blue", "black": "FMC_Plastic_ABS_Black", "grey": "FMC_Plastic_ABS_Grey", "alu": "FMC_Metal_Aluminium_Anodised_Silver", "castor": "FMC_Plastic_Nylon_CastorGrey"}, P,
        {"Base 650 mm diameter": A(650, "typical task chair, BS EN 1335"), "Seat height 420 to 540 mm (shown 450)": A("420-540", "BS EN 1335-1 type A")},
        "Task chair modelled as a generic product: 5 star legs with hooded twin-wheel castors, hub, gas lift with shroud, mechanism and lever, seat on shell, back on upright with lumbar pad, "
        "arm posts and pads.")

# 18 Patient chair with arms
fam = "FMC_I_Furniture_Chair_Patient_Arm"
P = [BX("Leg Front", [-280, -260, 0, -250, -230, 450], 'wood', r=8, rep=(2, 530, 0, 0)),
     RT("Leg Back", [[190, 0], [220, 0], [260, 880], [230, 880]], [-280, -250], 'wood'), RT("Leg Back Right", [[190, 0], [220, 0], [260, 880], [230, 880]], [250, 280], 'wood'),
     BX("Seat Rail Front", [-250, -260, 400, 250, -235, 450], 'wood'), BX("Seat Rail Side", [-280, -230, 400, -250, 200, 450], 'wood', rep=(2, 530, 0, 0)),
     BX("Seat Cushion", [-260, -290, 450, 260, 210, 520], 'vinyl', r=35),
     RT("Back Cushion", [[180, 540], [225, 530], [250, 860], [205, 860]], [-245, 245], 'vinyl'),
     RT("Back Top Rail", [[225, 860], [262, 860], [264, 880], [228, 880]], [-280, 280], 'wood', lod='f'),
     BX("Arm Support", [-280, -240, 450, -250, -210, 650], 'wood', r=8, rep=(2, 530, 0, 0)),
     RT("Arm Rest", [[-290, 650], [230, 650], [230, 680], [-280, 685]], [-295, -235], 'wood'), RT("Arm Rest Right", [[-290, 650], [230, 650], [230, 680], [-280, 685]], [235, 295], 'wood'),
     BX("Stretcher", [-250, -230, 150, 250, -210, 175], 'wood', lod='f'), BX("Stretcher Side", [-275, -230, 150, -255, 200, 175], 'wood', lod='f', rep=(2, 530, 0, 0)),
     CZ("Glide", [-265, -245], 14, [-0.1, 4], 'rubber', lod='f', rep=(2, 530, 0, 0)), CZ("Glide Back", [-265, 205], 14, [-0.1, 4], 'rubber', lod='f', rep=(2, 530, 0, 0))]
product(fam, "Patient side chair with arms, hardwood frame with stretchers, wipe-clean vinyl seat and back, open arms for easy rise, seat 450 high",
        "IfcFurniture", ["600_ArmSide"],
        {"wood": "FMC_Timber_Mvule", "vinyl": "FMC_Fabric_Vinyl_Upholstery_Blue", "rubber": "FMC_Rubber_Black"}, P,
        {"Width 600 mm, depth 580 mm": A("600x580", "typical patient arm chair"), "Seat height 450 mm, arm 650 mm": A("450/650", "typical easy-rise patient chair, HBN 00-04")},
        "Patient chair modelled as a generic product: hardwood front legs and raked back legs, seat rails, stretchers, upholstered seat and back cushions, back top rail, "
        "arm supports with shaped arm rests, glides.")

# 19 Mobile privacy screen 3-panel (zig-zag)
fam = "FMC_I_Furniture_Screen_Mobile_Privacy"
P = []; pw = 760; ang = 30
segs = [(-pw * math.cos(math.radians(ang)) - pw / 2, pw * math.sin(math.radians(ang)) / 2, -ang),  # centre of left panel
        (0, 0, 0), (pw * math.cos(math.radians(ang)) / 2 + pw / 2, pw * math.sin(math.radians(ang)) / 2, ang)]
segs = []
hx = [(-pw / 2 - pw * math.cos(math.radians(ang)), pw * math.sin(math.radians(ang))), (-pw / 2, 0), (pw / 2, 0), (pw / 2 + pw * math.cos(math.radians(ang)), pw * math.sin(math.radians(ang)))]
names = ["Left", "Centre", "Right"]
for i in range(3):
    (ax_, ay_), (bx_, by_) = hx[i], hx[i + 1]
    cx, cy = (ax_ + bx_) / 2, (ay_ + by_) / 2; a = math.degrees(math.atan2(by_ - ay_, bx_ - ax_)); Lp = math.hypot(bx_ - ax_, by_ - ay_)
    t = names[i] + " Panel"
    P += [PR(t + " Curtain", rot_rect(cx, cy, Lp - 60, 6, a), [300, 1750], 'fabric'),
          PR(t + " Top Rail", rot_rect(cx, cy, Lp - 40, 26, a), [1750, 1776], 'frame'),
          PR(t + " Bottom Rail", rot_rect(cx, cy, Lp - 40, 26, a), [276, 300], 'frame')]
for i, (x, y) in enumerate(hx):
    P += [CZ(f"Post {i + 1}", [x, y], 14, [150, 1800], 'frame'), TN(f"Post {i + 1} Cap", 'z', [x, y], [[0, 1800], [16, 1800], [10, 1815], [0, 1818]], 'black', lod='f'),
          CZ(f"Post {i + 1} Hinge", [x, y], 18, [1500, 1530], 'black', lod='f') if 0 < i < 3 else CZ(f"Post {i + 1} Grip", [x, y], 18, [1000, 1150], 'black', lod='f'),
          BX(f"Post {i + 1} Foot", [x - 20, y - 160, 90, x + 20, y + 160, 150], 'frame', r=10),
          CZ(f"Post {i + 1} Castor Hood", [x, y - 130], 22, [55, 90], 'black', lod='f', seg=16), CX(f"Post {i + 1} Castor Wheel", [y - 130, 30], 30, [x - 12, x + 12], 'castor', seg=16),
          CZ(f"Post {i + 1} Castor Back Hood", [x, y + 130], 22, [55, 90], 'black', lod='f', seg=16), CX(f"Post {i + 1} Castor Back Wheel", [y + 130, 30], 30, [x - 12, x + 12], 'castor', seg=16)]
P.append(PR("Mid Rail Centre", rot_rect(0, 0, pw - 40, 20, 0), [1000, 1020], 'frame'))
product(fam, "Mobile privacy screen, 3 hinged panels of wipe-clean antimicrobial curtain in powder-coated tubular frames, 4 posts on castors, folds flat",
        "IfcFurniture", ["2280x1800_3Panel"],
        {"fabric": "FMC_Fabric_Curtain_Antimicrobial_LightBlue", "frame": "FMC_Metal_Steel_EpoxyCoated_White", "black": "FMC_Plastic_ABS_Black", "castor": "FMC_Plastic_Nylon_CastorGrey"}, P,
        {"3 panels of 760 mm, height 1820 mm": A("3x760x1820", "typical folding ward screen"), "Curtain antimicrobial PVC-coated, wipe clean": A("PVC", "HBN 00-09 infection control")},
        "Screen modelled as a generic product: 3 curtain panels (outer panels folded 30 degrees) in top and bottom rails, mid rail, 4 posts with caps, hinges and grips, "
        "post feet with 2 castors each.")

# 20 Mobile records shelving carriage 1800 x 900, double sided
fam = "FMC_I_Furniture_Cabinet_Records_Mobile"
H = 2000
P = [BX("Floor Rail", [-1000, -350, 0, 1000, -310, 25], 'steel', rep=(2, 0, 660, 0)), BX("Carriage Base", [-900, -450, 25, 900, 450, 110], 'steel', r=6),
     FB("Base Fascia", [-905, -455, 30, 905, -450, 105], 'grey', lod='f'),
     BX("Upright", [-900, -450, 110, -880, 450, H], 'steel', rep=(3, 890, 0, 0)), BX("Centre Back Panel", [-880, -5, 110, 880, 5, H], 'steel'),
     BX("Canopy", [-900, -450, H, 900, 450, H + 20], 'steel'),
     BX("End Panel", [900, -460, 30, 925, 460, H + 20], 'end', r=6),
     TN("Hand Wheel Rim", 'x', [-200, 1100], [[150, 965], [170, 965], [170, 975], [150, 975]], 'chrome'),
     TN("Hand Wheel Hub", 'x', [-200, 1100], [[0, 925], [40, 925], [40, 965], [0, 965]], 'chrome'),
     BX("Hand Wheel Spoke", [935, -210, 1100 - 150, 965, -190, 1100 + 150], 'chrome', lod='f'), BX("Hand Wheel Spoke Cross", [935, -350, 1090, 965, -50, 1110], 'chrome', lod='f'),
     CX("Hand Wheel Knob", [-350, 1100], 14, [975, 1030], 'black', lod='f'),
     BX("Label Card", [925, -400, 1650, 930, -100, 1850], 'white', lod='f'),
     BX("Shelf Front Side", [-880, -440, 400, 880, -5, 420], 'steel', rep=(5, 0, 0, 340)), BX("Shelf Back Side", [-880, 5, 400, 880, 440, 420], 'steel', rep=(5, 0, 0, 340)),
     BX("Files Front Left", [-870, -420, 120, -10, -60, 380], 'files', lod='f', rep=(5, 0, 0, 340)), BX("Files Front Right", [10, -420, 120, 870, -60, 340], 'files2', lod='f', rep=(5, 0, 0, 340)),
     BX("Anti Tilt Guide", [-880, -360, 25, -800, -300, 60], 'grey', lod='f', rep=(2, 1680, 0, 0))]
product(fam, "Mobile records shelving carriage 1800 x 900, double-sided, 6 shelf levels a side on a carriage running on floor rails, end panel with hand wheel",
        "IfcFurniture", ["1800x900_DoubleSided"],
        {"steel": "FMC_Metal_SteelLTZ_Painted", "grey": "FMC_Plastic_ABS_Grey", "end": "FMC_Plastic_Laminate_HPL", "chrome": "FMC_Metal_Chrome_Polished", "black": "FMC_Plastic_ABS_Black",
         "white": "FMC_Plastic_ABS_White", "files": "FMC_Plastic_ABS_Blue", "files2": "FMC_Plastic_ABS_Yellow"}, P,
        {"Carriage 1800 x 900 mm, height 2000 mm": A("1800x900x2000", "record size; typical mobile shelving bay"), "Shelf load 80 kg per level": A(80, "typical filing shelving"),
         "Floor rail load: check slab, about 1000 kg per carriage full": A(1000, "typical full records carriage")},
        "Records carriage modelled as a generic product: floor rails, carriage base with fascia and anti-tilt guides, uprights, centre back panel, canopy, 5 shelf levels a side above "
        "the base with file blocks, HPL end panel with label card and hand wheel (rim, hub, spokes, knob).")

# 21 Family room sofa 2/3 seat
fam = "FMC_I_Furniture_Sofa_Family_Room"
def sofa(ns):
    W = 300 + 600 * ns; x0 = -W / 2; cw = (W - 300) / ns
    return [BX("Base Frame", [x0 + 140, -380, 130, -x0 - 140, 360, 420], 'fab2', r=20),
     BX("Seat Cushion", [x0 + 150, -420, 420, x0 + 150 + cw - 5, 220, 520], 'fab', r=40, rep=(ns, cw, 0, 0)),
     RT("Back Cushion", [[180, 420], [360, 420], [380, 830], [250, 840]], [x0 + 150, x0 + 150 + cw - 5], 'fab', rep=(ns, cw, 0, 0)),
     BX("Back", [x0 + 140, 300, 130, -x0 - 140, 400, 820], 'fab2', r=20),
     BX("Arm", [x0, -420, 130, x0 + 140, 400, 640], 'fab2', r=40), BX("Arm Right", [-x0 - 140, -420, 130, -x0, 400, 640], 'fab2', r=40),
     FB("Arm Front Panel", [x0 + 10, -424, 140, x0 + 130, -420, 630], 'wood', r=30, lod='f'), FB("Arm Front Panel Right", [-x0 - 130, -424, 140, -x0 - 10, -420, 630], 'wood', r=30, lod='f'),
     BX("Leg", [x0 + 20, -400, 0, x0 + 70, -350, 130], 'wood', r=10, rep=(2, W - 90, 0, 0)), BX("Leg Back", [x0 + 20, 330, 0, x0 + 70, 380, 130], 'wood', r=10, rep=(2, W - 90, 0, 0)),
     BX("Scatter Cushion", [x0 + 170, 140, 500, x0 + 450, 260, 760], 'fab3', r=40, lod='f')]
P = typed(sofa, {"1500_2Seat": ("2S", 2), "2100_3Seat": ("3S", 3)})
product(fam, "Family room sofa, wipe-clean upholstery, seat and back cushions, padded arms with timber front panels, timber legs",
        "IfcFurniture", [{"name": "1500_2Seat", "desc": "Family room sofa, 2 seats, 1500 x 820"}, {"name": "2100_3Seat", "desc": "Family room sofa, 3 seats, 2100 x 820"}],
        {"fab": "FMC_Fabric_Upholstery_WipeClean_Grey", "fab2": "FMC_Fabric_Upholstery_WipeClean_Grey", "fab3": "FMC_Fabric_Kitenge_Print", "wood": "FMC_Timber_Mvule"}, P,
        {"Width 1500 / 2100 mm, depth 820 mm": A("1500/2100x820", "typical 2 and 3 seat sofa"), "Seat height 450 mm": A(450, "typical healthcare lounge seating, HBN 00-04 (easy rise)")},
        "Sofa modelled as a generic product: upholstered base, 2 seat and inclined back cushions, back, padded arms with timber front panels, 4 timber legs, Kitenge scatter cushion (Fine).",
        drawn="1500_2Seat")

# 22 Staff rest table 1200 x 800
fam = "FMC_I_Furniture_Table_StaffRest"
P = [BX("Table Top", [-600, -400, 715, 600, 400, 740], 'top', r=40), BX("Edge Band", [-600, -400, 712, 600, 400, 715], 'edge', r=40, lod='f'),
     BX("Apron Long", [-520, -330, 640, 520, -310, 712], 'frame', rep=(2, 0, 640, 0)), BX("Apron Short", [-540, -310, 640, -520, 310, 712], 'frame', rep=(2, 1060, 0, 0)),
     BX("Leg", [-560, -350, 15, -520, -310, 712], 'frame', r=6, rep=(2, 1080, 0, 0)), BX("Leg Back", [-560, 310, 15, -520, 350, 712], 'frame', r=6, rep=(2, 1080, 0, 0)),
     CZ("Glide", [-540, -330], 16, [0, 15], 'rubber', lod='f', rep=(2, 1080, 0, 0)), CZ("Glide Back", [-540, 330], 16, [0, 15], 'rubber', lod='f', rep=(2, 1080, 0, 0)),
     CZ("Fixing", [-450, -320], 6, [700, 712], 'frame', lod='f', rep=(4, 300, 0, 0))]
product(fam, "Staff rest table 1200 x 800, HPL top with ABS edge, steel apron frame on 4 square legs with glides",
        "IfcFurniture", ["1200x800_Rest"],
        {"top": "FMC_Plastic_Laminate_HPL", "edge": "FMC_Plastic_ABS_Grey", "frame": "FMC_Metal_SteelLTZ_Painted", "rubber": "FMC_Rubber_Black"}, P,
        {"Top 1200 x 800 mm, height 740 mm": A("1200x800x740", "record size; BS EN 1730 dining height"), "Seats 4 to 6": A("4-6", "typical")},
        "Table modelled as a generic product: radiused HPL top with ABS edge band, steel aprons, 4 square legs with glides, top fixings.")

# ================================================================ CASEWORK
# 23 Nurse station counter L (3600 x 2400), lowered accessible section, transaction ledge, cable management
fam = "FMC_I_Casework_NurseStation_Counter"
P = []
# long leg: staff worktop 740 on the staff side (y > -800), public fascia at y = -800 with ledge at 1100
P += [BX("Long Fascia", [-900, -800, 100, 1800, -760, 1080], 'front', r=4), BX("Long Ledge", [-900, -880, 1080, 1800, -560, 1110], 'ledge', r=10),
      BX("Long Plinth", [-900, -740, 0, 1800, -100, 100], 'plinth'), BX("Long Worktop", [-900, -760, 710, 1000, 0, 740], 'top', r=6),
      FB("Fascia Panel Joint", [-2, -802, 120, 2, -800, 1060], 'plinth', lod='f', rep=(2, 900, 0, 0)),
      FB("LED Strip", [-880, -890, 1070, 1780, -880, 1078], 'led', lod='f'),
      BX("Pedestal", [-250, -720, 100, 250, -100, 710], 'carc', r=4),
      # drawers face the staff side (+y)
      FB("Pedestal Drawer", [-245, -100, 520, 245, -80, 700], 'front2', r=3, rep=(3, 0, 0, -205)),
      CX("Pedestal Drawer Handle", [-74, 660], 5, [-60, 60], 'hdl', lod='f', rep=(3, 0, 0, -205)),
      BX("Cable Tray", [-880, -700, 600, 1000, -620, 660], 'steel', lod='f'), CZ("Grommet", [-600, -680], 35, [739, 742], 'black', lod='f', rep=(4, 500, 0, 0)),
      BX("Power Data Module", [300, -740, 742, 700, -660, 800], 'alu', r=6), BX("Module Socket", [320, -662, 755, 400, -660, 790], 'white', lod='f', rep=(4, 95, 0, 0))]
# lowered accessible section on the public side, knee space
P += [BX("Accessible Top", [-1800, -900, 730, -900, 0, 760], 'ledge', r=10),
      BX("Accessible Leg Panel", [-1800, -880, 0, -1770, 0, 730], 'carc'), BX("Knee Space Back", [-1770, -120, 100, -900, -100, 730], 'carc'),
      FB("Hearing Loop Sign", [-860, -803, 900, -760, -800, 980], 'white', r=6, lod='f'),
      FB("Fascia Feature Band", [-900, -803, 820, 1800, -800, 860], 'blue', lod='f'),
      RT("Return Feature Band", [[-760, 820], [1600, 820], [1600, 860], [-760, 860]], [1800, 1803], 'blue', lod='f')]
def nurse_return(sg, pre):
    """Return leg along +y at the right (sg = 1) or left (sg = -1) end; ledge on the public (outer) side."""
    def mx(at): return [min(sg * at[0], sg * at[3]), at[1], at[2], max(sg * at[0], sg * at[3]), at[4], at[5]]
    def mxr(x): return sorted([sg * x[0], sg * x[1]])
    return [BX(pre + "Return Fascia", mx([1760, -760, 100, 1800, 1600, 1080]), 'front', r=4), BX(pre + "Return Ledge", mx([1720, -560, 1080, 1880, 1600, 1110]), 'ledge', r=10),
            BX(pre + "Return Plinth", mx([1100, -100, 0, 1740, 1550, 100]), 'plinth'),
            BX(pre + "Return Worktop", mx([1000, -760, 710, 1760, 1600, 740]) if sg > 0 else mx([1000, 0, 710, 1760, 1600, 740]), 'top', r=6),
            BX(pre + "Return Base Unit", mx([1100, 200, 100, 1740, 1550, 710]), 'carc'),
            RT(pre + "Return Door", [[203, 105], [1547, 105], [1547, 705], [203, 705]], mxr([1080, 1100]), 'front2'),
            RT(pre + "Return Door Joint", [[870, 110], [880, 110], [880, 700], [870, 700]], mxr([1078, 1080]), 'plinth', lod='f'),
            CZ(pre + "Return Door Handle", [sg * 1072, 830], 5, [520, 680], 'hdl', lod='f', rep=(2, 0, 100, 0)),
            RT(pre + "Return Feature Band", [[-760, 820], [1600, 820], [1600, 860], [-760, 860]], mxr([1800, 1803]), 'blue', lod='f')]
P = [q for q in P if q['n'] != "Return Feature Band"]
P += only(nurse_return(1, ""), ["3600x2400_L", "3600x2400_U"]) + only(nurse_return(-1, "Left "), ["3600x2400_U"])
P += only([BX("End Panel", [-1800, -800, 0, -1770, -100, 760], 'carc')], ["3600x2400_L", "3600_Straight"])
P += only([BX("Worktop Extension", [1000, -760, 710, 1770, 0, 740], 'top', r=6), BX("End Panel Right", [1770, -800, 0, 1800, 0, 1080], 'carc'),
           BX("Straight Base Unit", [1100, -620, 100, 1740, -100, 710], 'carc'), FB("Straight Door", [1100, -100, 105, 1740, -80, 705], 'front2', r=3)], ["3600_Straight"])
product(fam, "Ward nurse station counter, L-shaped 3600 x 2400 (L, U and straight types), staff worktop 740, raised public transaction ledge 1100 with LED strip, "
        "lowered 760 accessible section with knee space, pedestal, return base units (L, U) or end base unit (straight), cable tray, grommets and power/data module",
        "IfcFurniture", [{"name": "3600x2400_L", "desc": "Nurse station counter, L-shaped 3600 x 2400"}, {"name": "3600x2400_U", "desc": "Nurse station counter, U-shaped 3600 x 2400 x 2400"},
                         {"name": "3600_Straight", "desc": "Nurse station counter, straight 3600"}],
        {"front": "FMC_Plastic_Laminate_HPL", "front2": "FMC_Board_Melamine_White", "ledge": "FMC_Stone_Quartz_Engineered_White", "top": "FMC_Plastic_Laminate_HPL",
         "plinth": "FMC_Metal_StainlessSteel_Brushed", "carc": "FMC_Board_Melamine_White", "hdl": "FMC_Metal_StainlessSteel_Brushed", "steel": "FMC_Metal_SteelLTZ_Painted",
         "black": "FMC_Plastic_ABS_Black", "alu": "FMC_Metal_Aluminium_Anodised_Silver", "white": "FMC_Plastic_ABS_White", "led": "FMC_Plastic_LED_Blue", "blue": "FMC_Plastic_ABS_Blue"}, P,
        {"Staff worktop 740 mm, transaction ledge 1100 mm": A("740/1100", "HBN 04-01 / typical nurse base"), "Accessible section 900 wide at 760 mm with knee space": A("900@760", "BS 8300-2 / Approved Document M"),
         "Supply 240 V, 2000 VA (4 PCs, printer)": A(2000, "typical nurse base")},
        "Nurse station modelled as a generic product: HPL public fascia with joints and quartz transaction ledge with LED strip, lowered accessible section with knee space and hearing loop sign, "
        "staff worktop with grommets, cable tray and a power/data module, 3-drawer pedestal facing the staff; L adds a right return leg (fascia, ledge, worktop, base unit with doors), U adds both returns, straight closes with an end panel and a base unit; stainless plinths.",
        connectors=[E("Power Data Module", 'bottom'), ELV("Power Data Module", 'back')], type_values={"Voltage": 240, "Apparent Load": 2000}, drawn="3600x2400_L")

# 24 Reception counter accessible 2400/3600, with protective screen
fam = "FMC_I_Casework_Reception_Counter_Accessible"
def raised(R):
    return [BX("Raised Fascia", [-300, -800, 100, R, -760, 1080], 'front', r=4), BX("Raised Ledge", [-300, -900, 1080, R, -560, 1110], 'ledge', r=10),
     BX("Plinth", [-300, -740, 0, R, -100, 100], 'plinth'), BX("Staff Worktop", [-300, -760, 710, R, 0, 740], 'top', r=6),
     BX("End Panel Right", [R - 30, -760, 0, R, 0, 1080], 'carc'), FB("Fascia Feature Band", [-300, -803, 860, R, -800, 920], 'blue', lod='f'),
     BX("Screen Glass", [-280, -720, 1110, R - 20, -708, 1650], 'glass'), BX("Screen Post", [-300, -730, 1110, -280, -698, 1660], 'alu', rep=(2, R + 280, 0, 0))]
P = typed(raised, {"2400_Accessible": ("2400", 1200), "3600_Accessible": ("3600", 2400)})
P += [BX("Lowered Top", [-1200, -900, 730, -300, 0, 760], 'ledge', r=10), BX("End Panel", [-1200, -800, 0, -1170, 0, 730], 'carc'),
     BX("Knee Space Back", [-1170, -120, 100, -300, -100, 730], 'carc'),
     BX("Screen Pass Slot", [300, -722, 1110, 700, -706, 1200], 'black', lod='f'),
     FB("Speech Grille", [420, -722, 1400, 580, -720, 1460], 'alu', r=20, lod='f'),
     BX("Pedestal", [600, -720, 100, 1100, -100, 710], 'carc', r=4), FB("Pedestal Drawer", [605, -100, 520, 1095, -80, 700], 'front2', r=3, rep=(3, 0, 0, -205)),
     CX("Pedestal Drawer Handle", [-74, 660], 5, [790, 910], 'hdl', lod='f', rep=(3, 0, 0, -205)),
     CZ("Grommet", [-100, -680], 35, [739, 742], 'black', lod='f', rep=(2, 500, 0, 0)), BX("Cable Tray", [-280, -700, 600, 560, -620, 660], 'steel', lod='f'),
     BX("Power Data Module", [-200, -740, 742, 200, -660, 800], 'alu', r=6), BX("Module Socket", [-180, -662, 755, -100, -660, 790], 'white', lod='f', rep=(4, 95, 0, 0)),
     FB("Hearing Loop Sign", [-250, -803, 600, -150, -800, 680], 'white', r=6, lod='f')]
product(fam, "Accessible reception counter 2400 / 3600, raised 1100 section with quartz ledge and protective glazed screen with pass slot and speech grille, "
        "lowered 760 accessible section with knee space, staff worktop, pedestal, cable management and power/data",
        "IfcFurniture", [{"name": "2400_Accessible", "desc": "Accessible reception counter 2400 (1500 raised, 900 lowered)"}, {"name": "3600_Accessible", "desc": "Accessible reception counter 3600 (2700 raised, 900 lowered)"}],
        {"front": "FMC_Plastic_Laminate_HPL", "front2": "FMC_Board_Melamine_White", "ledge": "FMC_Stone_Quartz_Engineered_White", "top": "FMC_Plastic_Laminate_HPL",
         "plinth": "FMC_Metal_StainlessSteel_Brushed", "carc": "FMC_Board_Melamine_White", "hdl": "FMC_Metal_StainlessSteel_Brushed", "steel": "FMC_Metal_SteelLTZ_Painted",
         "black": "FMC_Plastic_ABS_Black", "alu": "FMC_Metal_Aluminium_Anodised_Silver", "white": "FMC_Plastic_ABS_White", "blue": "FMC_Plastic_ABS_Blue", "glass": "FMC_Glass_Laminated"}, P,
        {"Raised ledge 1100 mm, lowered section 760 mm": A("1100/760", "BS 8300-2 reception counters"), "Lowered section 900 mm wide with 700 mm knee space": A(900, "BS 8300-2"),
         "Supply 240 V, 1000 VA": A(1000, "typical 2-position reception")},
        "Reception counter modelled as a generic product: raised HPL fascia with feature band and quartz ledge, laminated glass screen on posts with pass slot and speech grille, "
        "lowered accessible section with knee space and hearing loop sign, staff worktop, pedestal with handles, cable tray, grommets, power/data module, end panels, plinth.",
        connectors=[E("Power Data Module", 'bottom'), ELV("Power Data Module", 'back')], type_values={"Voltage": 240, "Apparent Load": 1000}, drawn="2400_Accessible")

# 25 Clinical base unit, stainless 600/900/1200, coved plinth
fam = "FMC_I_Casework_Clinical_BaseUnit_SS"
M_SS = {"carc": "FMC_Metal_StainlessSteel_Brushed", "front": "FMC_Metal_StainlessSteel_Brushed", "top": "FMC_Metal_StainlessSteel_Brushed",
        "plinth": "FMC_Metal_StainlessSteel_Brushed", "hdl": "FMC_Metal_Chrome_Polished", "cove": "FMC_Rubber_Black", "label": "FMC_Plastic_ABS_White"}
SS_LAYOUT = {600: [(600, [('drawer', 150), ('door', 710)])], 900: [(900, [('drawers', 300, 2), ('doors', 560)])],
             1200: [(600, [('drawers', 300, 2), ('door', 560)]), (600, [('drawers', 300, 2), ('door', 560)])]}
def ss_base(W):
    h = W / 2
    P = base_run(-h, h, 600, 900, SS_LAYOUT[W], upstand=100)
    return P + [RT("Worktop Front Roll", [[-620, 860], [-600, 860], [-600, 900], [-620, 900]], [-h, h], 'top'),
                RT("Upstand Cove", [[-35, 900], [-15, 900], [-15, 920]], [-h, h], 'top', lod='f'),
                BX("Inner Shelf", [-h + 20, -560, 380, h - 20, -30, 400], 'carc', lod='f'),
                CZ("Hinge", [-h + 5, -605], 6, [180, 220], 'hdl', lod='f', rep=(2, W - 10, 0, 0)),
                RT("Coved Plinth Toe", [[-555, 0], [-548, 0], [-548, 40]], [-h + 2, h - 2], 'cove', lod='f')]
P = typed(ss_base, {"600_SS": ("600", 600), "900_SS": ("900", 900), "1200_SS": ("1200", 1200)})
P += [BX("Spur Box", [-40, -20, 20, 40, 0, 90], 'plinth')]
product(fam, "Clinical base unit, stainless steel 304, 2 drawers over a pair of doors, rolled-edge worktop with coved upstand, coved plinth, chrome D-pulls",
        "IfcFurniture", [{"name": "600_SS", "desc": "Clinical base unit 600, stainless, drawer over door"}, {"name": "900_SS", "desc": "Clinical base unit 900, stainless, 2 drawers over 2 doors"},
                         {"name": "1200_SS", "desc": "Clinical base unit 1200, stainless, 2 drawer columns over 2 doors"}], M_SS, P,
        {"Height 900 mm, depth 600 mm": A("900x600", "HTM 63 / typical clinical base unit"), "Widths 600 / 900 / 1200 mm": A("600/900/1200", "record types"),
         "Stainless steel 304, 1.2 mm": A("304", "typical clinical casework"), "Supply 240 V, 300 VA (under-counter appliance)": A(300, "assumed spur for an under-counter item")},
        "Base unit modelled as a generic product: stainless carcass, 2 drawers with labels and D-pulls, pair of doors with hinges and pulls, inner shelf, rolled-edge worktop with "
        "coved upstand, recessed plinth with coved toe; a spur box behind the plinth carries the power connector.", connectors=[E("Spur Box")], type_values={"Voltage": 240, "Apparent Load": 300}, drawn="900_SS")

# 26 Clinical wall unit, glazed, sloped top
fam = "FMC_I_Casework_Clinical_WallUnit_Glazed"
def wall_glazed(W):
    h = W / 2
    return wall_unit(-h, h, 320, 720, 0, 1 if W == 600 else 2) + [
        BX("Shelf", [-h + 20, -280, 240, h - 20, -20, 258], 'carc', lod='f', rep=(2, 0, 0, 240)), BX("Bottom Light Pelmet", [-h, -320, -30, h, -290, 0], 'carc'),
        BX("LED Under Light", [-h + 50, -280, -34, h - 50, -60, -30], 'led', lod='f')]
P = typed(wall_glazed, {"600_Glazed": ("600", 600), "900_Glazed": ("900", 900), "1200_Glazed": ("1200", 1200)})
product(fam, "Clinical wall unit, glazed pair of doors in aluminium frames, sloped anti-dust top, 2 adjustable shelves, LED under-light pelmet, hung at 1450",
        "IfcFurniture", [{"name": "600_Glazed", "desc": "Clinical wall unit 600, single glazed door"}, {"name": "900_Glazed", "desc": "Clinical wall unit 900, pair of glazed doors"},
                         {"name": "1200_Glazed", "desc": "Clinical wall unit 1200, pair of glazed doors"}],
        {"carc": "FMC_Board_Melamine_White", "front": "FMC_Metal_Aluminium_Anodised_Silver", "glass": "FMC_Glass_Clear", "hdl": "FMC_Metal_StainlessSteel_Brushed", "led": "FMC_Plastic_LED_Blue"}, P,
        {"Height 720 mm, depth 320 mm": A("720x320", "HTM 63 wall cupboard"), "Underside at 1450 mm AFL": A(1450, "typical over clinical worktop"),
         "Sloped top 25 degrees": A(25, "HTM 63 dust-shedding top")},
        "Wall unit modelled as a generic product: carcass with sloped dust-shedding top, aluminium-framed glazed leaves with D-pulls, 2 shelves, pelmet with LED under-light. "
        "Back at y = 0; underside at the Default Elevation.", type_values={"Default Elevation": 1450}, drawn="900_Glazed")

# 27 Clinical tall unit store 600 x 600 x 2100
fam = "FMC_I_Casework_Clinical_TallUnit_Store"
P = [BX("Carcass", [-300, -580, 100, 300, 0, 2100], 'carc'), BX("Plinth", [-298, -530, 0, 298, -20, 100], 'plinth'),
     RT("Sloped Top", [[0, 2100], [-580, 2100], [-580, 2120], [0, 2380]], [-300, 300], 'carc'),
     FB("Upper Leaf", [-297, -600, 1203, 297, -580, 2097], 'front', r=3), FB("Lower Leaf", [-297, -600, 103, 297, -580, 1197], 'front', r=3),
     BX("Shelf", [-280, -560, 400, 280, -20, 418], 'carc', lod='f', rep=(5, 0, 0, 330)),
     CZ("Hinge", [-293, -604], 6, [200, 240], 'hdl', lod='f', rep=(4, 0, 0, 500)),
     CY("Lock", [250, 1250], 9, [-606, -600], 'hdl', lod='f'), FB("Vent Grille", [-100, -602, 1950, 100, -600, 2020], 'grey', r=4, lod='f'),
     FB("Label Holder", [-100, -603, 1820, 100, -600, 1880], 'white', r=3, lod='f')]
P += dpull("Upper Handle", 250, 1400, -600, L=192, vertical=True, m='hdl', lod='mf') + dpull("Lower Handle", 250, 1000, -600, L=192, vertical=True, m='hdl', lod='mf')
product(fam, "Clinical tall store cupboard 600 x 600 x 2100, upper and lower doors with D-pulls and lock, 5 shelves, sloped anti-dust top, stainless plinth",
        "IfcFurniture", ["600x600x2100_Store"],
        {"carc": "FMC_Board_Melamine_White", "front": "FMC_Plastic_Laminate_HPL", "plinth": "FMC_Metal_StainlessSteel_Brushed", "hdl": "FMC_Metal_StainlessSteel_Brushed",
         "grey": "FMC_Plastic_ABS_Grey", "white": "FMC_Plastic_ABS_White"}, P,
        {"Size 600 x 600 x 2100 mm": A("600x600x2100", "record size"), "Sloped top adds 280 mm": A(280, "HTM 63 dust-shedding top")},
        "Tall store modelled as a generic product: carcass on recessed stainless plinth, sloped top, upper and lower HPL leaves with D-pulls, hinges, lock, vent grille and label holder, 5 shelves.")

# 28 Pharmacy dispensary shelving bay 900/1200
fam = "FMC_I_Casework_Pharmacy_Shelving_Dispensary"
def dispensary(W):
    nb = int((W - 80) // 210)
    return [BX("Upright", [-W / 2, -350, 0, -W / 2 + 25, 0, 2100], 'steel', rep=(2, W - 25, 0, 0)), BX("Back Panel", [-W / 2 + 25, -15, 100, W / 2 - 25, 0, 2100], 'back'),
     BX("Plinth", [-W / 2 + 25, -330, 0, W / 2 - 25, -15, 100], 'steel'), BX("Canopy", [-W / 2, -350, 2100, W / 2, 0, 2130], 'steel'),
     BX("Base Shelf", [-W / 2 + 25, -350, 100, W / 2 - 25, -15, 120], 'shelf'),
     RT("Shelf", [[-300, 380], [-15, 420], [-15, 432], [-300, 392]], [-W / 2 + 25, W / 2 - 25], 'shelf', rep=(7, 0, 0, 240)),
     FB("Shelf Lip", [-W / 2 + 25, -306, 380, W / 2 - 25, -300, 420], 'clear', lod='f', rep=(7, 0, 0, 240)),
     FB("Label Rail", [-W / 2 + 25, -308, 365, W / 2 - 25, -306, 385], 'label', lod='f', rep=(7, 0, 0, 240)),
     BX("Dispensing Bin", [-W / 2 + 40, -290, 395, -W / 2 + 230, -40, 520], 'bin', lod='f', rep=(nb, 210, 0, 0)),
     BX("Dispensing Bin Row 2", [-W / 2 + 40, -285, 635, -W / 2 + 230, -40, 760], 'bin2', lod='f', rep=(nb, 210, 0, 0)),
     BX("Drug Boxes Row 3", [-W / 2 + 40, -270, 880, W / 2 - 40, -40, 990], 'box', lod='f'),
     BX("Drug Boxes Row 4", [-W / 2 + 40, -270, 1120, W / 2 - 80, -40, 1230], 'box2', lod='f'),
     BX("Dispensing Bin Row 5", [-W / 2 + 40, -280, 1355, -W / 2 + 230, -40, 1480], 'bin', lod='f', rep=(nb, 210, 0, 0)),
     BX("Drug Boxes Row 6", [-W / 2 + 40, -270, 1600, W / 2 - 160, -40, 1710], 'box', lod='f'),
     FB("Bay Label", [-150, -352, 2105, 150, -350, 2125], 'label', lod='f')]
P = typed(dispensary, {"900_Dispensary": ("900", 900), "1200_Dispensary": ("1200", 1200)})
product(fam, "Pharmacy dispensary shelving bay 900 / 1200 wide, 2100 high, 7 adjustable inclined shelves with clear lips and label rails, dispensing bins and stock",
        "IfcFurniture", [{"name": "900_Dispensary", "desc": "Dispensary shelving bay 900, 7 inclined shelves"}, {"name": "1200_Dispensary", "desc": "Dispensary shelving bay 1200, 7 inclined shelves"}],
        {"steel": "FMC_Metal_Steel_EpoxyCoated_White", "back": "FMC_Board_Melamine_White", "shelf": "FMC_Metal_Steel_EpoxyCoated_White", "clear": "FMC_Plastic_Polycarbonate_Clear",
         "label": "FMC_Plastic_ABS_White", "bin": "FMC_Plastic_ABS_Blue", "bin2": "FMC_Plastic_ABS_Yellow", "box": "FMC_Plastic_ABS_White", "box2": "FMC_Plastic_ABS_MedicalGrey"}, P,
        {"Bay 900 / 1200 x 350 x 2100 mm": A("900/1200x350x2100", "record types; typical dispensary shelving"), "Shelf pitch 240 mm, 10 degree incline": A("240/10", "typical gravity-fed dispensary shelving")},
        "Dispensary bay modelled as a generic product: uprights, back panel, plinth, canopy with bay label, base shelf and 7 inclined shelves with clear lips and label rails, "
        "blue and yellow dispensing bins and boxed stock (Fine).", drawn="900_Dispensary")

# 29 Pharmacy dispensing counter 2400 with drawer packs
fam = "FMC_I_Casework_Pharmacy_Counter_Dispensing"
P = base_run(-1200, 1200, 650, 900, [(600, [('drawers', 765, 6)]), (600, [('drawers', 765, 6)]), (600, [('drawers', 765, 3)]), (600, [('door', 765)])], upstand=0)
P += [FB("Drawer Label", [-1000, -653, 830, -800, -650, 845], 'label', lod='f', rep=(6, 0, 0, -127.5)), FB("Drawer Label Col 2", [-400, -653, 830, -200, -650, 845], 'label', lod='f', rep=(6, 0, 0, -127.5)),
      BX("Dispensing Shelf", [-1200, -300, 1200, 1200, 0, 1220], 'carc'), BX("Shelf Upright", [-1200, -300, 900, -1180, 0, 1200], 'carc', rep=(3, 1190, 0, 0)),
      BX("Back Panel", [-1200, -15, 900, 1200, 0, 1200], 'carc'),
      BX("Power Module", [400, -60, 950, 700, -15, 1010], 'alu', r=6), FB("Module Socket", [420, -62, 960, 500, -60, 1000], 'white', r=4, lod='f', rep=(3, 95, 0, 0)),
      CY("Door Lock", [650, 820], 9, [-656, -650], 'hdl', lod='f'), BX("Label Printer", [-1100, -260, 900, -800, -40, 1080], 'grey', r=20, lod='f')]
P = [p for p in P if p['n'] != 'Label Printer']
P.append(BX("Label Printer", [-1100, -560, 900, -800, -340, 1050], 'grey', r=20, lod='f'))
P[-1]['at'][2] = 900
P = [p for p in P if p['n'] != 'Door Lock'] + [CY("Door Lock", [650, 820], 9, [-656, -650], 'hdl', lod='f')]
product(fam, "Pharmacy dispensing counter 2400, drawer packs (6 + 6 + 3 drawers) and a lockable cupboard, HPL worktop, rear dispensing shelf with back panel and power module",
        "IfcFurniture", ["2400_DrawerPack"],
        {"carc": "FMC_Board_Melamine_White", "front": "FMC_Plastic_Laminate_HPL", "top": "FMC_Plastic_Laminate_HPL", "plinth": "FMC_Metal_StainlessSteel_Brushed",
         "hdl": "FMC_Metal_StainlessSteel_Brushed", "label": "FMC_Plastic_ABS_White", "alu": "FMC_Metal_Aluminium_Anodised_Silver", "white": "FMC_Plastic_ABS_White", "grey": "FMC_Plastic_ABS_MedicalGrey"}, P,
        {"Length 2400 mm, height 900 mm, depth 650 mm": A("2400x650x900", "record size; typical dispensing bench"), "15 drawers in 3 packs + 1 lockable cupboard": A(15, "typical dispensing counter"),
         "Supply 240 V, 500 VA": A(500, "PC and label printer")},
        "Dispensing counter modelled as a generic product: carcass on recessed plinth, two packs of 6 shallow drawers with labels, a pack of 3 deep drawers, lockable cupboard, "
        "bar handles, HPL worktop, raised dispensing shelf on uprights with back panel, power module, label printer (Fine).",
        connectors=[E("Power Module", 'bottom')], type_values={"Voltage": 240, "Apparent Load": 500})

# 30 Lab wall bench 1500/1800/3000 with service spine, sink
fam = "FMC_I_Casework_Lab_Bench_Wall"
M_LAB = {"carc": "FMC_Board_Melamine_White", "front": "FMC_Plastic_Laminate_HPL", "top": "FMC_Plastic_EpoxyResin_Black", "plinth": "FMC_Plastic_ABS_Grey",
         "hdl": "FMC_Metal_StainlessSteel_Brushed", "spine": "FMC_Metal_Steel_EpoxyCoated_White", "white": "FMC_Plastic_ABS_White", "chrome": "FMC_Metal_Chrome_Polished",
         "sink": "FMC_Plastic_ABS_Grey", "red": "FMC_Plastic_LED_Red", "blue": "FMC_Plastic_ABS_Blue", "yellow": "FMC_Plastic_ABS_Yellow", "glass": "FMC_Glass_Clear"}
LAB_COLS = {1500: [(500, [('drawers', 765, 4)]), (400, [('knee', 765)]), (600, [('doors', 765)])],
            1800: [(500, [('drawers', 765, 4)]), (700, [('knee', 765)]), (600, [('doors', 765)])],
            3000: [(500, [('drawers', 765, 4)]), (1000, [('knee', 765)]), (500, [('drawers', 765, 4)]), (1000, [('doors', 765)])]}
def lab_wall(L):
    x0 = -L / 2; sx = x0 + L - 500; ns = (L - 200) // 600 + 1; ng = L // 600
    P = base_run(x0, -x0, 750, 900, LAB_COLS[L], top='top', upstand=0, yback=-150)
    P = cut_worktop(P, "Worktop", sx, -720, sx + 400, -260)
    P += bowl("Sink Bowl", sx, -720, sx + 400, -260, 700, 900, 'sink', t=12)
    return P + [BX("Sink Rim", [sx - 10, -730, 900, sx + 410, -720, 903], 'sink', lod='f'),
      BX("Service Spine", [x0, -150, 870, -x0, 0, 1350], 'spine'), BX("Spine Cap", [x0, -150, 1350, -x0, 0, 1370], 'spine'),
      FB("Twin Socket", [x0 + 100, -152, 1150, x0 + 246, -150, 1236], 'white', r=6, rep=(ns, (L - 346) / max(1, ns - 1), 0, 0)),
      CY("Gas Turret", [x0 + 300, 1000], 16, [-200, -150], 'chrome', rep=(ng, (L - 600) / max(1, ng - 1), 0, 0)),
      CZ("Gas Turret Handle", [x0 + 300, -190], 12, [1016, 1040], 'yellow', lod='f', rep=(ng, (L - 600) / max(1, ng - 1), 0, 0)),
      BX("Reagent Shelf", [x0, -300, 1600, -x0, 0, 1620], 'glass'), BX("Shelf Bracket", [x0 + 50, -300, 1370, x0 + 70, -20, 1600], 'spine', rep=(2, L - 120, 0, 0)),
      CZ("Lab Tap Pillar", [sx + 200, -200], 16, [902, 1180], 'chrome'), CY("Lab Tap Spout", [sx + 200, 1180], 10, [-460, -200], 'chrome'),
      CZ("Lab Tap Outlet", [sx + 200, -450], 10, [1100, 1180], 'chrome'), BX("Tap Wrist Lever", [sx + 160, -230, 1120, sx + 240, -215, 1130], 'chrome', lod='f', rep=(2, 0, 0, -40)),
      FB("Data Outlet", [sx, -152, 920, sx + 100, -150, 1000], 'blue', r=4, lod='f')]
P = typed(lab_wall, {"1500_Wall": ("1500", 1500), "1800_Wall": ("1800", 1800), "3000_Wall": ("3000", 3000)})
P += [BX("Service Entry Box", [-60, -120, 100, 60, -20, 300], 'spine')]
product(fam, "Laboratory wall bench with service spine: epoxy-resin worktop 900 high, drawer unit, knee space, sink cupboard with resin sink and lab gooseneck tap, "
        "spine with twin sockets, gas turrets and data outlet, glass reagent shelf on brackets",
        "IfcFurniture", [{"name": "1500_Wall", "desc": "Lab wall bench 1500 with service spine"}, {"name": "1800_Wall", "desc": "Lab wall bench 1800 with service spine"},
                         {"name": "3000_Wall", "desc": "Lab wall bench 3000 with service spine"}], dict(M_LAB), P,
        {"Worktop 900 mm high, 750 deep + 150 spine": A("900/750/150", "HBN 15 / typical lab bench"), "Lengths 1500 / 1800 / 3000 mm": A("1500/1800/3000", "record types"),
         "Supply 240 V, 2000 VA (4 twin sockets)": A(2000, "typical lab bench diversity")},
        "Wall bench modelled as a generic product: epoxy-resin worktop on a 4-drawer unit and a sink cupboard (pair of doors) with knee space between, recessed plinth, service spine with "
        "twin sockets, gas turrets and a data outlet, glass reagent shelf on brackets, resin sink with gooseneck tap and wrist levers. Services enter through a shared box in the void under the spine.",
        connectors=[CW("Service Entry Box", 'top'), SAN("Service Entry Box", 'bottom'), E("Service Entry Box", 'front')], type_values={"Voltage": 240, "Apparent Load": 2000}, drawn="1800_Wall")

# 31 Lab island bench 3000 x 1500, double-sided, centre spine with 2-tier reagent shelf, end sink
fam = "FMC_I_Casework_Lab_Bench_Island"
P = []
for side, sgn in (("Front", 1), ("Back", -1)):
    cols = [(600, [('drawers', 765, 3)]), (900, [('knee', 765)]), (1500, [('doors', 765)])]
    run = base_run(-1500, 1500, 675, 900, cols, top='top', upstand=0, name=side, yback=-75)
    run = [q for q in run if 'Open' not in q['n']]
    if sgn < 0:  # mirror in y about y = 0
        for q in run:
            if 'at' in q: a = q['at']; q['at'] = [a[0], -a[4], a[2], a[3], -a[1], a[5]]
            if q['shape'] == 'cyl' and q['axis'] == 'y': q['y'] = [-q['y'][1], -q['y'][0]]
            if q['shape'] == 'cyl' and q['axis'] == 'z': q['c'] = [q['c'][0], -q['c'][1]]
            if q['shape'] == 'cyl' and q['axis'] == 'x': q['c'] = [-q['c'][0], q['c'][1]]
    P += run
P = cut_worktop(P, "Front Worktop", 1050, -500, 1450, -150)
P = cut_worktop(P, "Back Worktop", 1050, 150, 1450, 500)
P += bowl("End Sink", 1050, -500, 1450, -150, 700, 900, 'sink', t=12) + bowl("End Sink Back", 1050, 150, 1450, 500, 700, 900, 'sink', t=12)
P += [BX("Spine", [-1500, -75, 900, 1500, 75, 1300], 'spine'),
      FB("Spine Socket", [-1300, -77, 1100, -1154, -75, 1186], 'white', r=6, rep=(3, 1000, 0, 0)),
      FB("Spine Socket Back", [-1300, 75, 1100, -1154, 77, 1186], 'white', r=6, rep=(3, 1000, 0, 0)),
      CY("Gas Turret", [-800, 1000], 16, [-125, -75], 'chrome', rep=(2, 1000, 0, 0)), CY("Gas Turret Back", [-800, 1000], 16, [75, 125], 'chrome', rep=(2, 1000, 0, 0)),
      BX("Reagent Upright", [-1480, -20, 1300, -1440, 20, 1900], 'spine', rep=(3, 1460, 0, 0)),
      BX("Reagent Shelf", [-1500, -175, 1500, 1500, 175, 1520], 'glass', rep=(2, 0, 0, 350)),
      CZ("Tap Pillar", [1250, -100], 16, [900, 1180], 'chrome'), CY("Tap Spout", [1250, 1180], 10, [-340, -100], 'chrome'),
      CZ("Tap Pillar Back", [1250, 100], 16, [900, 1180], 'chrome'), CY("Tap Spout Back", [1250, 1180], 10, [100, 340], 'chrome'),
      BX("End Panel", [1500, -770, 0, 1525, 770, 900], 'carc'), BX("End Panel Left", [-1525, -770, 0, -1500, 770, 900], 'carc')]
product(fam, "Laboratory island bench 3000 x 1500, double-sided with a central service spine, epoxy-resin worktops, drawer units, cupboards, knee spaces, two-tier glass reagent shelf, end sinks",
        "IfcFurniture", ["3000x1500_Island"], dict(M_LAB), P,
        {"Island 3000 x 1500 mm, worktop 900 mm": A("3000x1500x900", "record size; HBN 15"), "Reagent shelf tiers at 1500 and 1850 mm": A("1500/1850", "typical island reagent shelving"),
         "Supply 240 V, 3000 VA (8 twin sockets)": A(3000, "typical island bench diversity")},
        "Island bench modelled as a generic product: two mirrored runs of drawer units and cupboards with knee spaces, epoxy-resin worktops, central spine with twin sockets both faces "
        "and gas turrets, uprights carrying a two-tier glass reagent shelf, end sinks with gooseneck taps, end panels.",
        connectors=[CW("Spine", 'bottom'), SAN("End Sink Floor"), E("Spine", 'top')], type_values={"Voltage": 240, "Apparent Load": 3000})

# 32 Fume cupboard 1200/1500/1800, ducted
fam = "FMC_I_Casework_FumeCupboard"
def fume(W):
    x0 = -W / 2
    P = base_run(x0, -x0, 900, 900, [(W / 2, [('door', 765)]), (W / 2, [('door', 765)])], top='top', upstand=0, carcass='carc', front='front', hdl='hdl')
    P = [p for p in P if p['n'] != 'Worktop']
    return P + [BX("Work Surface", [x0, -900, 870, -x0, 0, 920], 'top', r=4), RT("Spill Lip", [[-900, 920], [-880, 920], [-880, 935], [-900, 935]], [x0 + 90, -x0 - 90], 'top'),
      BX("Side Post", [x0, -900, 920, x0 + 90, 0, 2350], 'body', r=6), BX("Side Post Right", [-x0 - 90, -900, 920, -x0, 0, 2350], 'body', r=6),
      BX("Back Baffle", [x0 + 90, -80, 920, -x0 - 90, 0, 2200], 'liner'), BX("Canopy", [x0, -900, 2200, -x0, 0, 2350], 'body', r=6),
      RT("Aerofoil Sill", [[-920, 925], [-880, 925], [-860, 960], [-900, 965]], [x0 + 90, -x0 - 90], 'ss'),
      FB("Sash Frame", [x0 + 95, -905, 1000, -x0 - 95, -880, 1700], 'frame', r=4), FB("Sash Glass", [x0 + 125, -907, 1030, -x0 - 125, -878, 1670], 'glass'),
      FB("Sash Handle", [x0 + 300, -930, 990, -x0 - 300, -905, 1020], 'frame', r=8),
      FB("Upper Glass Panel", [x0 + 95, -890, 1720, -x0 - 95, -870, 2190], 'glass'),
      FB("Fascia Panel", [x0 + 90, -903, 2210, -x0 - 90, -900, 2340], 'body'),
      FB("Airflow Monitor", [-x0 - 330, -906, 2230, -x0 - 120, -903, 2320], 'black', r=6), FB("Airflow Readout", [-x0 - 310, -907, 2265, -x0 - 210, -906, 2300], 'green', lod='f'),
      CY("Alarm LED", [-x0 - 160, 2290], 8, [-908, -906], 'red', lod='f'), CY("Light Switch", [-x0 - 160, 2255], 8, [-908, -906], 'grey', lod='f'),
      FB("Service Tap Plate", [x0 + 10, -903, 1000, x0 + 80, -900, 1500], 'ss', lod='f'),
      CY("Service Tap", [x0 + 45, 1100], 12, [-930, -903], 'blue', lod='f', rep=(3, 0, 0, 120)),
      FB("Socket Plate", [-x0 - 80, -903, 1000, -x0 - 10, -900, 1300], 'white', lod='f'),
      FB("Solvent Store Label", [x0 + 100, -923, 760, x0 + 300, -920, 820], 'yellow', lod='f')]
P = typed(fume, {"1200_Ducted": ("1200", 1200), "1500_Ducted": ("1500", 1500), "1800_Ducted": ("1800", 1800)})
P += [CZ("Extract Spigot", [0, -450], 125, [2350, 2500], 'duct'), BX("Spigot Collar", [-170, -620, 2350, 170, -280, 2365], 'body', lod='f'),
      BX("Services Junction Box", [220, -200, 2350, 340, -80, 2410], 'grey')]
product(fam, "Ducted fume cupboard 1200 / 1500 / 1800, epoxy work surface with spill lip and aerofoil sill, counter-balanced vertical sash, airflow monitor and alarm, "
        "services on the side posts, 250 mm extract spigot, ventilated solvent store base",
        "IfcFurniture", [{"name": "1200_Ducted", "desc": "Ducted fume cupboard 1200"}, {"name": "1500_Ducted", "desc": "Ducted fume cupboard 1500"}, {"name": "1800_Ducted", "desc": "Ducted fume cupboard 1800"}],
        {"carc": "FMC_Board_Melamine_White", "front": "FMC_Metal_Steel_EpoxyCoated_White", "hdl": "FMC_Metal_StainlessSteel_Brushed", "plinth": "FMC_Plastic_ABS_Grey",
         "top": "FMC_Plastic_EpoxyResin_Black", "body": "FMC_Metal_Steel_EpoxyCoated_White", "liner": "FMC_Board_FibreCement_Painted", "ss": "FMC_Metal_StainlessSteel_Brushed",
         "frame": "FMC_Metal_Aluminium_PowderCoated", "glass": "FMC_Glass_Laminated", "black": "FMC_Plastic_ABS_Black", "green": "FMC_Plastic_LED_Green", "red": "FMC_Plastic_LED_Red",
         "grey": "FMC_Plastic_ABS_Grey", "blue": "FMC_Plastic_ABS_Blue", "white": "FMC_Plastic_ABS_White", "duct": "FMC_Metal_Duct_Galvanised", "yellow": "FMC_Plastic_ABS_Yellow"}, P,
        {"Width 1200 / 1500 / 1800 mm, depth 900, height 2350 + spigot": A("W x 900 x 2350", "record types; BS EN 14175"), "Face velocity 0.5 m/s at 500 mm sash": A(0.5, "BS EN 14175 / typical"),
         "Extract spigot 250 mm, about 0.4 m3/s": A(250, "typical 1500 fume cupboard"), "Supply 240 V, 500 VA (lights, monitor, sockets)": A(500, "typical")},
        "Fume cupboard modelled as a generic product: base solvent store with two doors and label, epoxy work surface with spill lip and aerofoil sill, side posts with service taps and socket plate, "
        "back baffle, glazed counter-balanced sash with handle, upper glazing, canopy fascia with airflow monitor, alarm LED and light switch, galvanised extract spigot.",
        connectors=[{"n": "Extract", "domain": "duct", "system": "ExhaustAir", "part": "Extract Spigot", "side": "top", "diameter": 250, "flow": "Out"}, E("Services Junction Box", 'top')],
        type_values={"Voltage": 240, "Apparent Load": 500}, drawn="1500_Ducted")

# 33 Class II biosafety cabinet 1200/1500 on stand
fam = "FMC_I_Casework_BiosafetyCabinet_ClassII"
def bsc(W):
    x0 = -W / 2; ns = int((W - 200) // 50)
    P = [BX("Stand Leg", [x0 + 20, -760, 30, x0 + 70, -710, 730], 'frame', rep=(2, W - 90, 0, 0)), BX("Stand Leg Back", [x0 + 20, -70, 30, x0 + 70, -20, 730], 'frame', rep=(2, W - 90, 0, 0)),
     BX("Stand Rail", [x0 + 20, -760, 680, -x0 - 20, -20, 730], 'frame'), BX("Stand Low Rail", [x0 + 20, -760, 150, -x0 - 20, -710, 190], 'frame'),
     CZ("Leveller", [x0 + 45, -735], 20, [0, 30], 'black', rep=(2, W - 90, 0, 0), seg=16), CZ("Leveller Back", [x0 + 45, -45], 20, [0, 30], 'black', rep=(2, W - 90, 0, 0), seg=16),
     BX("Cabinet Base", [x0, -780, 730, -x0, 0, 880], 'body', r=8),
     BX("Side Wall", [x0, -780, 880, x0 + 80, 0, 1900], 'body', r=8), BX("Side Wall Right", [-x0 - 80, -780, 880, -x0, 0, 1900], 'body', r=8),
     BX("Back Wall", [x0 + 80, -80, 880, -x0 - 80, 0, 1900], 'body'), BX("Work Tray", [x0 + 80, -700, 880, -x0 - 80, -80, 900], 'ss'),
     BX("Front Grille", [x0 + 80, -780, 880, -x0 - 80, -700, 905], 'ss'),
     BX("Grille Slot", [x0 + 100, -770, 905, x0 + 110, -710, 906], 'black', lod='f', rep=(ns, 50, 0, 0)),
     RT("Sash", [[-780, 1150], [-760, 1150], [-640, 1750], [-660, 1750]], [x0 + 85, -x0 - 85], 'glass'),
     RT("Sash Frame Bottom", [[-790, 1130], [-750, 1130], [-750, 1160], [-790, 1160]], [x0 + 85, -x0 - 85], 'frame'),
     BX("Head Unit", [x0, -700, 1750, -x0, 0, 2050], 'body', r=8), RT("Head Front", [[-700, 1750], [-640, 1750], [-640, 2050], [-700, 2050]], [x0, -x0], 'body'),
     FB("Control Panel", [x0 + 200, -706, 1830, -x0 - 200, -700, 1980], 'grey', r=6), FB("Display", [x0 + 240, -708, 1860, x0 + 560, -706, 1950], 'black', r=4),
     FB("Display Readout", [x0 + 260, -709, 1885, x0 + 480, -708, 1925], 'green', lod='f'),
     CY("Key", [x0 + 640, 1905], 14, [-710, -706], 'grey2', lod='f', rep=(4, 60, 0, 0)), CY("Alarm LED", [-x0 - 260, 1940], 8, [-710, -706], 'red', lod='f'),
     FB("UV Lamp Indicator", [-x0 - 300, -708, 1860, -x0 - 230, -706, 1880], 'blue', lod='f'),
     BX("Exhaust Filter Housing", [x0 + 150, -550, 2050, -x0 - 150, -150, 2150], 'body', r=10), BX("Exhaust Grille", [x0 + 200, -500, 2150, -x0 - 200, -200, 2153], 'ss', lod='f'),
     FB("Side Window", [x0 - 2, -700, 1000, x0, -300, 1600], 'glass', lod='f'), FB("Service Valve", [-x0, -500, 1100, -x0 + 2, -440, 1300], 'blue', lod='f')]
    P[-2] = RT("Side Window", [[-700, 1000], [-300, 1000], [-300, 1600], [-700, 1600]], [x0 - 3, x0], 'glass', lod='f')
    P[-1] = RT("Service Valve", [[-500, 1100], [-440, 1100], [-440, 1300], [-500, 1300]], [-x0, -x0 + 3], 'blue', lod='f')
    return P
P = typed(bsc, {"1200_ClassII": ("1200", 1200), "1500_ClassII": ("1500", 1500)})
P += [BX("Mains Inlet Box", [-100, -140, 2050, 100, -60, 2090], 'grey')]
product(fam, "Class II microbiological safety cabinet 1200 / 1500 on stand: inclined front sash, perforated front grille, stainless work tray, control panel with airflow display and alarms, top exhaust HEPA housing",
        "IfcFurniture", [{"name": "1200_ClassII", "desc": "Class II biosafety cabinet 1200 on stand"}, {"name": "1500_ClassII", "desc": "Class II biosafety cabinet 1500 on stand"}],
        {"frame": "FMC_Metal_SteelLTZ_Painted", "body": "FMC_Metal_Steel_EpoxyCoated_White", "ss": "FMC_Metal_StainlessSteel_Brushed", "glass": "FMC_Glass_Laminated", "black": "FMC_Plastic_ABS_Black",
         "grey": "FMC_Plastic_ABS_Grey", "grey2": "FMC_Plastic_ABS_MedicalGrey", "green": "FMC_Plastic_LED_Green", "red": "FMC_Plastic_LED_Red", "blue": "FMC_Plastic_LED_Blue"}, P,
        {"Width 1200 / 1500 mm, depth 780 mm, height 2150 mm on stand": A("W x 780 x 2150", "record types; typical Class II A2 cabinet"), "Work surface 880 mm": A(880, "typical stand height"),
         "BS EN 12469 Class II": A("EN 12469", "record"), "Supply 240 V, 1200 VA": A(1200, "typical Class II cabinet")},
        "Cabinet modelled as a generic product: painted stand with rails and levellers, cabinet base, side and back walls, stainless work tray, perforated front grille, inclined glass sash with frame, "
        "head unit with control panel, display, keys, alarm and UV indicators, side window and service valve, top exhaust filter housing with grille.",
        connectors=[E("Mains Inlet Box", 'top')], type_values={"Voltage": 240, "Apparent Load": 1200}, drawn="1200_ClassII")

# 34 Sterile store wire shelving 900/1200
fam = "FMC_I_Casework_SterileStore_Shelving_Wire"
Dp = 450
def wire_bay(W):
    P = [CZ("Post", [-W / 2 + 15, -Dp + 15], 13, [30, 1880], 'wire', rep=(2, W - 30, 0, 0), seg=16), CZ("Post Back", [-W / 2 + 15, -15], 13, [30, 1880], 'wire', rep=(2, W - 30, 0, 0), seg=16),
         CZ("Post Cap", [-W / 2 + 15, -Dp + 15], 14, [1880, 1890], 'black', lod='f', rep=(2, W - 30, 0, 0), seg=16),
         CZ("Post Cap Back", [-W / 2 + 15, -15], 14, [1880, 1890], 'black', lod='f', rep=(2, W - 30, 0, 0), seg=16),
         CZ("Foot", [-W / 2 + 15, -Dp + 15], 16, [0, 30], 'black', rep=(2, W - 30, 0, 0), seg=16), CZ("Foot Back", [-W / 2 + 15, -15], 16, [0, 30], 'black', rep=(2, W - 30, 0, 0), seg=16)]
    for i, z in enumerate((250, 650, 1050, 1450, 1850)):
        t = f"Shelf {i + 1}"
        P += [BX(t + " Rim", [-W / 2 + 2, -Dp + 2, z - 25, W / 2 - 2, -Dp + 8, z], 'wire', rep=(2, 0, Dp - 10, 0)),
              BX(t + " End Rim", [-W / 2 + 2, -Dp + 8, z - 6, -W / 2 + 8, -8, z], 'wire', rep=(2, W - 10, 0, 0)),
              BX(t + " Wire", [-W / 2 + 8, -Dp + 60, z - 4, W / 2 - 8, -Dp + 64, z], 'wire', lod='f', rep=(5, 0, 70, 0))]
    return P + [FB("Shelf Label", [-80, -Dp - 3, 1830, 80, -Dp + 2, 1850], 'label', lod='f', rep=(5, 0, 0, -400)),
                BX("Sterile Packs", [-W / 2 + 70, -400, 254, W / 2 - 70, -60, 420], 'pack', lod='f', rep=(4, 0, 0, 400))]
P = typed(wire_bay, {"900_Wire": ("900", 900), "1200_Wire": ("1200", 1200)})
product(fam, "Sterile store wire shelving bay 900 / 1200 x 450, 1890 high, 5 open epoxy-coated wire shelves (lowest 250 above floor for cleaning), 4 posts on feet, shelf labels",
        "IfcFurniture", [{"name": "900_Wire", "desc": "Sterile store wire shelving 900 x 450 x 1890, 5 shelves"}, {"name": "1200_Wire", "desc": "Sterile store wire shelving 1200 x 450 x 1890, 5 shelves"}],
        {"wire": "FMC_Metal_Chrome_Polished", "black": "FMC_Plastic_ABS_Black", "castor": "FMC_Plastic_Nylon_CastorGrey", "label": "FMC_Plastic_ABS_White", "pack": "FMC_Plastic_ABS_Blue"}, P,
        {"Bay 900 / 1200 x 450 x 1890 mm": A("900/1200x450x1890", "record types; typical wire shelving"), "Lowest shelf 250 mm above floor": A(250, "HTM 01-01 / sterile storage practice"),
         "Top shelf no higher than 1850 mm": A(1850, "sterile storage practice")},
        "Wire shelving modelled as a generic product: 4 round posts with caps on feet, 5 shelves of rims, end rims and longitudinal wires, shelf labels, sterile packs (Fine).", drawn="900_Wire")

# 35 Procedure room casework run 2400: base units with inset sink, wall units over
fam = "FMC_I_Casework_ProcedureRoom_Unit"
P = base_run(-1200, 1200, 600, 900, [(600, [('drawers', 765, 4)]), (900, [('doors', 765)]), (900, [('drawer', 160), ('doors', 600)])], top='top', upstand=150, handle='d')
P = cut_worktop(P, "Worktop", -450, -480, 0, -150)
P += bowl("Sink Bowl", -450, -480, 0, -150, 720, 900, 'ss')
P += [      CZ("Sink Waste", [-225, -315], 25, [723, 726], 'chrome', lod='f'),
      CZ("Mixer Body", [-225, -60], 22, [900, 1000], 'chrome'), CY("Mixer Spout", [-225, 1150], 12, [-300, -60], 'chrome'),
      CZ("Mixer Riser", [-225, -60], 12, [1000, 1150], 'chrome'), BX("Mixer Elbow Lever", [-225, -75, 990, 0, -60, 1005], 'chrome', lod='f'),
      CZ("Mixer Outlet", [-225, -300], 12, [1100, 1150], 'chrome')]
P += wall_unit(300, 1200, 320, 720, 1450, 2, name="Wall Unit")
P += [FB("Splashback", [-1200, -6, 1050, 1200, 0, 1450], 'top'), BX("Sharps Bracket", [-1100, -150, 1150, -900, -6, 1350], 'yellow', r=10),
      FB("Glove Dispenser", [-850, -100, 1200, -580, -6, 1350], 'white', r=10), FB("Glove Box Slot", [-800, -102, 1230, -630, -100, 1250], 'grey', r=6, lod='f')]
product(fam, "Treatment / procedure room casework run 2400: drawer unit, sink unit with inset stainless bowl and elbow-lever mixer, cupboard unit, coved upstand, glazed wall units, sharps and glove points",
        "IfcFurniture", ["2400_Run"],
        {"carc": "FMC_Board_Melamine_White", "front": "FMC_Plastic_Laminate_HPL", "top": "FMC_Plastic_Laminate_HPL", "plinth": "FMC_Metal_StainlessSteel_Brushed",
         "hdl": "FMC_Metal_StainlessSteel_Brushed", "ss": "FMC_Metal_StainlessSteel_Brushed", "chrome": "FMC_Metal_Chrome_Polished", "glass": "FMC_Glass_Clear",
         "yellow": "FMC_Plastic_ABS_Yellow", "white": "FMC_Plastic_ABS_White", "grey": "FMC_Plastic_ABS_Grey"}, P,
        {"Run 2400 mm, worktop 900 mm, depth 600 mm": A("2400x600x900", "record size; HBN 00-03 treatment room"), "Wall units 720 high at 1450 mm": A(1450, "typical clinical casework"),
         "Supply 240 V, 1000 VA": A(1000, "worktop sockets in the run")},
        "Procedure run modelled as a generic product: 4-drawer unit, sink unit with inset stainless bowl, waste and elbow-lever mixer, drawer-over-cupboard unit, D-pulls and bar handles, "
        "HPL worktop with 150 upstand, recessed plinth, 2-leaf glazed wall unit with sloped top, sharps bracket and glove dispenser.",
        connectors=[CW("Mixer Body", 'bottom'), HW("Mixer Body", 'bottom'), SAN("Sink Bowl Floor"), E("Carcass")], type_values={"Voltage": 240, "Apparent Load": 1000})
OUT[-1]['connectors'][1]['part'] = "Upstand"; OUT[-1]['connectors'][1]['side'] = 'back'
OUT[-1]['connectors'][0]['part'] = "Upstand"; OUT[-1]['connectors'][0]['side'] = 'top'

# 36 Sluice base unit 1200, stainless sink top
fam = "FMC_I_Casework_Sluice_Unit_Base"
P = base_run(-600, 600, 600, 900, [(1200, [('doors', 765)])], carcass='carc', front='front', top='top', plinth='plinth', hdl='hdl', upstand=150)
P = cut_worktop(P, "Worktop", -550, -540, -50, -140)
P += bowl("Sink Bowl", -550, -540, -50, -140, 760, 900, 'top')
P += [BX("Sink Bowl Base", [-547, -537, 763, -53, -143, 765], 'grey', lod='f'),
      CZ("Sink Waste", [-300, -340], 25, [765, 768], 'chrome', lod='f'),
      BX("Drainer Groove", [30, -520, 900, 550, -505, 903], 'grey', lod='f', rep=(6, 0, 70, 0)),
      CZ("Mixer Body", [-300, -60], 22, [900, 1000], 'chrome'), CZ("Mixer Riser", [-300, -60], 12, [1000, 1180], 'chrome'),
      CY("Mixer Spout", [-300, 1180], 12, [-320, -60], 'chrome'), CZ("Mixer Outlet", [-300, -310], 12, [1120, 1180], 'chrome'),
      BX("Mixer Elbow Lever", [-300, -75, 990, -80, -60, 1005], 'chrome', lod='f'),
      BX("Inner Shelf", [-580, -560, 400, 580, -30, 418], 'carc', lod='f'),
      RT("Coved Plinth Toe", [[-555, 0], [-548, 0], [-548, 40]], [-598, 598], 'cove', lod='f'),
      RT("Worktop Front Roll", [[-620, 860], [-600, 860], [-600, 900], [-620, 900]], [-600, 600], 'top'),
      FB("Hopper Side Panel", [598, -603, 0, 600, 0, 900], 'top', lod='f')]
product(fam, "Sluice room base unit 1200, all stainless steel: one-piece top with sink bowl, drainer grooves and 150 coved upstand, elbow-lever mixer, pair of doors, coved plinth",
        "IfcFurniture", ["1200_Sluice"],
        {"carc": "FMC_Metal_StainlessSteel_Brushed", "front": "FMC_Metal_StainlessSteel_Brushed", "top": "FMC_Metal_StainlessSteel_Brushed", "plinth": "FMC_Metal_StainlessSteel_Brushed",
         "hdl": "FMC_Metal_Chrome_Polished", "chrome": "FMC_Metal_Chrome_Polished", "grey": "FMC_Plastic_ABS_Grey", "cove": "FMC_Rubber_Black"}, P,
        {"Length 1200 mm, worktop 900 mm, depth 600 mm": A("1200x600x900", "record size; HBN 00-03 dirty utility"), "Stainless steel 304, sink bowl 500 x 400 x 140": A("304", "typical sluice base unit")},
        "Sluice base unit modelled as a generic product: stainless carcass, pair of doors with bar handles, inner shelf, one-piece top with sink bowl, waste and drainer grooves, "
        "rolled front edge, 150 upstand, elbow-lever mixer, coved plinth and hopper-side closing panel.",
        connectors=[CW("Upstand", 'top'), HW("Upstand", 'back'), SAN("Sink Bowl Floor")])

# 37 Ward pantry kitchen 1800/2400
fam = "FMC_I_Casework_Kitchen_Ward_Pantry"
PANTRY_COLS = {1800: [(600, [('drawer', 160), ('door', 600)]), (600, [('doors', 765)]), (600, [('knee', 765)])],
               2400: [(600, [('drawer', 160), ('door', 600)]), (600, [('doors', 765)]), (600, [('drawer', 160), ('doors', 600)]), (600, [('knee', 765)])]}
def pantry(L):
    x0 = -L / 2; fx = x0 + L - 600; bx = x0 + L - 500; mx = x0 + 820
    P = base_run(x0, -x0, 600, 900, PANTRY_COLS[L], top='top', upstand=100)
    P = cut_worktop(P, "Worktop", x0 + 620, -520, x0 + 1020, -140)
    P += bowl("Sink Bowl", x0 + 620, -520, x0 + 1020, -140, 720, 900, 'ss')
    P += [BX("Fridge Cabinet", [fx + 10, -570, 20, fx + 590, -20, 850], 'white', r=6), FB("Fridge Door", [fx + 12, -590, 30, fx + 588, -570, 845], 'white', r=10),
          FB("Fridge Grip", [fx + 20, -600, 600, fx + 40, -590, 820], 'grey', r=6, lod='f'), FB("Fridge Kick Grille", [fx + 30, -592, 35, fx + 570, -590, 90], 'grey', lod='f'),
          FB("Splashback", [x0, -6, 1000, -x0, 0, 1450], 'top'),
          BX("Drainer", [x0 + 50, -540, 898, x0 + 600, -120, 903], 'ss', r=20),
          BX("Drainer Groove", [x0 + 70, -500, 903, x0 + 560, -492, 905], 'grey', lod='f', rep=(4, 0, 90, 0)), CZ("Sink Waste", [mx, -330], 25, [723, 726], 'chrome', lod='f'),
          CZ("Mixer Body", [mx, -60], 22, [900, 960], 'chrome'), TN("Mixer Swan Neck", 'y', [mx, 1130], [[0, -60], [12, -60], [12, -280], [0, -280]], 'chrome'),
          CZ("Mixer Riser", [mx, -60], 12, [960, 1130], 'chrome'), CZ("Mixer Outlet", [mx, -280], 12, [1060, 1130], 'chrome'),
          BX("Mixer Lever", [mx, -75, 975, mx + 160, -60, 985], 'chrome', lod='f'),
          BX("Boiler Body", [bx, -160, 1150, bx + 400, 0, 1650], 'ss', r=20), FB("Boiler Panel", [bx + 40, -162, 1450, bx + 360, -160, 1620], 'black', r=6),
          CY("Boiler Ready LED", [bx + 100, 1560], 7, [-165, -162], 'green', lod='f'), CY("Boiler Power LED", [bx + 140, 1560], 7, [-165, -162], 'red', lod='f'),
          BX("Boiler Tap", [bx + 185, -200, 1130, bx + 215, -160, 1150], 'black'), CZ("Boiler Tap Nozzle", [bx + 200, -190], 8, [1100, 1130], 'black', lod='f'),
          BX("Boiler Drip Tray", [bx + 70, -230, 900, bx + 330, -20, 920], 'ss', lod='f')]
    return P + wall_unit(x0, x0 + L - 600, 320, 720, 1450, 2, glazed=False, sloped=False, name="Wall Unit")
P = typed(pantry, {"1800_Pantry": ("1800", 1800), "2400_Pantry": ("2400", 2400)})
P += [BX("Service Entry Box", [-60, -20, 20, 60, 0, 90], 'plinth')]
product(fam, "Ward pantry kitchen run 1800 / 2400: laminate worktop, stainless sink and drainer with swan-neck lever mixer, drawer and cupboard units, under-counter fridge, "
        "wall-mounted instant water boiler, wall cupboards",
        "IfcFurniture", [{"name": "1800_Pantry", "desc": "Ward pantry run 1800 with sink, fridge and boiler point"}, {"name": "2400_Pantry", "desc": "Ward pantry run 2400 with sink, fridge, boiler point and extra cupboard"}],
        {"carc": "FMC_Board_Melamine_White", "front": "FMC_Plastic_Laminate_HPL", "top": "FMC_Plastic_Laminate_HPL", "plinth": "FMC_Metal_StainlessSteel_Brushed",
         "hdl": "FMC_Metal_StainlessSteel_Brushed", "ss": "FMC_Metal_StainlessSteel_Brushed", "chrome": "FMC_Metal_Chrome_Polished", "white": "FMC_Plastic_ABS_White",
         "grey": "FMC_Plastic_ABS_Grey", "black": "FMC_Plastic_ABS_Black", "green": "FMC_Plastic_LED_Green", "red": "FMC_Plastic_LED_Red", "glass": "FMC_Glass_Clear"}, P,
        {"Run 1800 / 2400 mm, worktop 900 mm": A("1800/2400x600x900", "record types; HBN 04-01 ward kitchen"), "Water boiler 10 l, 3 kW": A(3000, "typical wall-mounted instant boiler"),
         "Supply 240 V, 3500 VA (boiler + fridge)": A(3500, "boiler + fridge")},
        "Pantry run modelled as a generic product: drawer-over-cupboard unit, sink unit with pair of doors, open bay with under-counter fridge (door, grip, kick grille), HPL worktop and upstand, "
        "stainless sink with waste and drainer with grooves, lever mixer with swan neck, wall-mounted water boiler with panel, LEDs, tap and drip tray, 2-leaf wall cupboard sized to the run. Services enter through a shared box behind the plinth.",
        connectors=[CW("Service Entry Box", 'top'), HW("Service Entry Box", 'left'), SAN("Service Entry Box", 'right'), E("Service Entry Box", 'front')], type_values={"Voltage": 240, "Apparent Load": 3500}, drawn="1800_Pantry")

# ---------------------------------------------------------------- materials the kit lacks (owner adds)
NEEDED = []   # second pass: the kit now has all four materials asked for in the first pass

# ---------------------------------------------------------------- write
def count_parts(p): return len(fp.expand(p['parts']))
if __name__ == '__main__':
    only = sys.argv[1:]
    kit = set(open(os.path.join(HERE, 'batches', 'KIT_MATERIALS.txt')).read().split())
    import re
    done = set()
    for prod in OUT:
        if only and not any(s in prod['family'] for s in only): continue
        names = [q['n'] for q in fp.expand(prod['parts'])]
        assert len(names) == len(set(names)), (prod['family'], [n for n in names if names.count(n) > 1])
        for t in prod['types']: assert re.match(r'^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$', t['name']), t['name']
        for k, v in prod['materials'].items(): assert v in kit, (prod['family'], v)
        for q in prod['parts']: assert q['mat'] in prod['materials'], (prod['family'], q['n'], q['mat'])
        for c in prod.get('connectors', []): assert c['part'] in names, (prod['family'], c)
        ex = fp.expand(prod['parts'])
        n = max(sum(1 for q in ex if not q.get('only') or t['name'] in q['only']) for t in prod['types'])   # parts shown in the busiest type
        f = prod['family']
        json.dump(prod, open(os.path.join(HERE, f + '.product.json'), 'w'), indent=1)
        r = fp.compile_product(prod)
        json.dump(r, open(os.path.join(HERE, f + '.recipe.json'), 'w'), indent=1)
        fp.render(prod, os.path.join(HERE, f + '.preview.png'))
        fp.render_type_image(prod, os.path.join(HERE, f + '.png'), size=600)
        print(f"{f}: {n} parts per type max, {len(ex)} in all, {len(r['ops'])} ops" + ("  OVER 70" if n > 70 else ""), flush=True)
        done.add(f)
    json.dump(NEEDED, open(os.path.join(HERE, 'batches', 'I2_interiors.materials_needed.json'), 'w'), indent=1)
    missing = set(RECS) - {p['family'] for p in OUT}
    print("families built:", len(done), "missing from script:", sorted(missing))
