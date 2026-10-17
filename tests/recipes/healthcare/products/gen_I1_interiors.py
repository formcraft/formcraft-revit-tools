"""Healthcare pack, batch I1 (interiors / medical equipment / furniture): 37 families modelled as detailed products.
Pattern: make_products.py. Compiler + renderer: ../../tools/fmc_parts.py (not edited).
Run: python3 gen_I1_interiors.py [name-filter ...]   writes <family>.product.json, .recipe.json, .preview.png, .png here."""
import json, os, sys, math, re
from multiprocessing import Pool
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'tools'))
import fmc_parts as fp

RECS = {r['family']: r for r in json.load(open(os.path.join(HERE, 'batches', 'I1_interiors.json')))}
KIT = set(open(os.path.join(HERE, 'batches', 'KIT_MATERIALS.txt')).read().split())
A = lambda v, src='typical product, to confirm with the supplier': {"value": v, "source_status": "assumed", "source": src}

MATS = {
    "white": "FMC_Plastic_ABS_White", "mgrey": "FMC_Plastic_ABS_MedicalGrey", "grey": "FMC_Plastic_ABS_Grey",
    "black": "FMC_Plastic_ABS_Black", "blue": "FMC_Plastic_ABS_Blue", "yellow": "FMC_Plastic_ABS_Yellow",
    "frame": "FMC_Metal_Steel_EpoxyCoated_White", "dark": "FMC_Metal_SteelLTZ_Painted", "ss": "FMC_Metal_StainlessSteel_Brushed",
    "chrome": "FMC_Metal_Chrome_Polished", "alu": "FMC_Metal_Aluminium_Anodised_Silver",
    "mattress": "FMC_Fabric_Mattress_PU_Blue", "vinyl": "FMC_Fabric_Vinyl_Upholstery_Blue", "rubber": "FMC_Rubber_Black",
    "castor": "FMC_Plastic_Nylon_CastorGrey", "clear": "FMC_Plastic_Polycarbonate_Clear",
    "screen": "FMC_Plastic_ABS_Black",           # opaque stand-in; kit request FMC_Glass_Display_Black
    "red": "FMC_Plastic_FireHoseReel_Red",      # nearest red plastic; kit request FMC_Plastic_ABS_Red
    "sign": "FMC_Plastic_LED_Green",            # nearest safety green; kit request FMC_Plastic_Sign_SafetyGreen
    "ledg": "FMC_Plastic_LED_Green", "ledb": "FMC_Plastic_LED_Blue", "ledr": "FMC_Plastic_LED_Red",
    "hpl": "FMC_Plastic_Laminate_HPL", "wood": "FMC_Timber_Mahogany", "mel": "FMC_Board_Melamine_White",
    "china": "FMC_Ceramic_VitreousChina_White", "mirror": "FMC_Glass_Mirror",
}
MATERIALS_NEEDED = [
    {"name": "FMC_Glass_Display_Black", "colour": "#11161D", "why": "screens of monitors, ventilators, scanners and bed panels; FMC_Plastic_ABS_Black used meanwhile"},
    {"name": "FMC_Plastic_ABS_Red", "colour": "#C8202B", "why": "resuscitation trolley drawers, brake pedals, CPR release, shock button; FMC_Plastic_FireHoseReel_Red used meanwhile"},
    {"name": "FMC_Plastic_Sign_SafetyGreen", "colour": "#00873D", "why": "AED location sign (ISO 7010 E010); FMC_Plastic_LED_Green used meanwhile"},
]

# ------------------------------------------------------------------ part constructors
def _p(n, shape, mat, lod=None, rep=None, **g):
    p = {"n": n, "shape": shape, **g, "mat": mat}
    if lod: p["lod"] = lod
    if rep: p["repeat"] = {"n": rep[0], "d": [rep[1], rep[2], rep[3]]}
    return p
def box(n, x0, y0, z0, x1, y1, z1, m, r=0, lod=None, rep=None):
    g = {"at": [round(v, 1) for v in (x0, y0, z0, x1, y1, z1)]}
    if r: g["r"] = r
    return _p(n, "box", m, lod, rep, **g)
def fbox(n, x0, y0, z0, x1, y1, z1, m, r=0, lod=None, rep=None):
    g = {"at": [round(v, 1) for v in (x0, y0, z0, x1, y1, z1)]}
    if r: g["r"] = r
    return _p(n, "fbox", m, lod, rep, **g)
def cyl(n, axis, c, r, span, m, lod=None, rep=None, seg=None):
    g = {"axis": axis, "c": [round(c[0], 1), round(c[1], 1)], "r": r, axis: [round(span[0], 1), round(span[1], 1)]}
    if seg: g["seg"] = seg
    return _p(n, "cyl", m, lod, rep, **g)
def turn(n, axis, c, prof, m, lod=None, rep=None):
    return _p(n, "turn", m, lod, rep, axis=axis, c=[round(c[0], 1), round(c[1], 1)], profile=[[round(a, 1), round(b, 1)] for a, b in prof])
def front(n, pts, y0, y1, m, lod=None, rep=None):
    return _p(n, "front", m, lod, rep, pts=[[round(a, 1), round(b, 1)] for a, b in pts], y=[y0, y1])
def right(n, pts, x0, x1, m, lod=None, rep=None):
    return _p(n, "right", m, lod, rep, pts=[[round(a, 1), round(b, 1)] for a, b in pts], x=[x0, x1])
def prism(n, pts, z0, z1, m, lod=None, rep=None):
    return _p(n, "prism", m, lod, rep, pts=[[round(a, 1), round(b, 1)] for a, b in pts], z=[z0, z1])

# ------------------------------------------------------------------ 2D helpers
def incl(hx, hz, ang, L, t0, t1, dirx=1):
    """Inclined slab in a 2D sketch plane: hinge (hx,hz), runs L along angle ang (deg) toward dirx, thickness from t0 to t1
    along the upward normal."""
    c, s = math.cos(math.radians(ang)), math.sin(math.radians(ang))
    d = (dirx * c, s); nv = (-dirx * s, c) if dirx > 0 else (s, c)
    P = lambda a, t: [hx + d[0] * a + nv[0] * t, hz + d[1] * a + nv[1] * t]
    return [P(0, t0), P(L, t0), P(L, t1), P(0, t1)]
def incl_end(hx, hz, ang, L, dirx=1):
    c, s = math.cos(math.radians(ang)), math.sin(math.radians(ang)); return hx + dirx * c * L, hz + s * L
def rr(a0, b0, a1, b1, r=0): return fp.rrect(a0, b0, a1, b1, r)
def rtop(a0, b0, a1, b1, r, n=6):
    pts = [[a0, b0], [a1, b0]]
    for cx, a_start in ((a1 - r, 0), (a0 + r, 90)):
        for k in range(n + 1):
            a = math.radians(a_start + 90 * k / n); pts.append([cx + r * math.cos(a), b1 - r + r * math.sin(a)])
    return pts
def bar2(p, q, w):
    dx, dy = q[0] - p[0], q[1] - p[1]; L = math.hypot(dx, dy); nx, ny = -dy / L * w / 2, dx / L * w / 2
    return [[p[0] + nx, p[1] + ny], [q[0] + nx, q[1] + ny], [q[0] - nx, q[1] - ny], [p[0] - nx, p[1] - ny]]
def ellipse(cx, cy, ax, ay, n=36): return [[cx + ax * math.cos(2 * math.pi * k / n), cy + ay * math.sin(2 * math.pi * k / n)] for k in range(n)]

# ------------------------------------------------------------------ shared component helpers
def castor(n, x, y, r, rep=None, pedal=False, hub=False, sign=None):
    """Hospital castor: hooded twin wheel, stem, optional brake pedal. Top of stem at 2r+34."""
    sg = sign if sign else (-1 if y <= 0 else 1); w = max(9, r * 0.3)
    out = [cyl(f"{n} Wheel", "x", [y, r], r, [x - w, x + w], "castor", rep=rep),
           box(f"{n} Hood", x - w - 5, y - r * 0.8, r * 0.95, x + w + 5, y + r * 0.8, 2 * r + 10, "grey", r=r * 0.3, rep=rep),
           cyl(f"{n} Stem", "z", [x, y], max(7, r * 0.2), [2 * r + 10, 2 * r + 34], "chrome", rep=rep)]
    if hub: out.append(cyl(f"{n} Hub", "x", [y, r], r * 0.38, [x - w - 2, x + w + 2], "chrome", "f", rep))
    if pedal:
        ya, yb = (y - r * 0.8 - 45, y - r * 0.8) if sg < 0 else (y + r * 0.8, y + r * 0.8 + 45)
        out.append(box(f"{n} Brake Pedal", x - w, ya, r * 1.3, x + w, yb, r * 1.3 + 14, "red", r=4, lod="f", rep=rep))
    return out
def ctop(r): return 2 * r + 34
def castors4(x0, x1, y0, y1, r, pedal=True, hub=False, pre="Castor"):
    return (castor(f"{pre} Front", x0, y0, r, rep=(2, x1 - x0, 0, 0), pedal=pedal, hub=hub) +
            castor(f"{pre} Back", x0, y1, r, rep=(2, x1 - x0, 0, 0), pedal=pedal, hub=hub))
def basket(n, x0, y0, z0, x1, y1, z1, m="chrome"):
    """Open wire basket: floor and four thin walls."""
    return [box(f"{n} Floor", x0, y0, z0, x1, y1, z0 + 6, m),
            fbox(f"{n} Wall", x0, y0, z0, x1, y0 + 5, z1, m, rep=(2, 0, y1 - y0 - 5, 0)),
            right(f"{n} End", rr(y0 + 5, z0, y1 - 5, z1), x0, x0 + 5, m, rep=(2, x1 - x0 - 5, 0, 0)),
            fbox(f"{n} Wire", x0 + 30, y0 - 1, z0 + 20, x1 - 30, y0, z0 + 24, "grey", lod="f", rep=(3, 0, 0, (z1 - z0 - 40) / 2))]
def screen(n, x0, x1, y, z0, z1, depth=30, bez=12, body="dark", traces=False):
    """Display facing -y with its face at y - depth."""
    out = [fbox(f"{n} Bezel", x0, y - depth, z0, x1, y, z1, body, r=8),
           fbox(f"{n} Display", x0 + bez, y - depth - 1.5, z0 + bez, x1 - bez, y - depth, z1 - bez, "screen", r=3)]
    if traces:
        h = (z1 - z0 - 2 * bez); w = (x1 - x0 - 2 * bez)
        for k, m in enumerate(("ledg", "yellow", "ledb")):
            zz = z1 - bez - h * (0.22 + 0.24 * k)
            out.append(fbox(f"{n} Trace {k + 1}", x0 + bez + 12, y - depth - 2.5, zz, x0 + bez + w * 0.68, y - depth - 1.5, zz + 4, m, lod="f"))
            out.append(fbox(f"{n} Value {k + 1}", x0 + bez + w * 0.74, y - depth - 2.5, zz - 8, x1 - bez - 10, y - depth - 1.5, zz + 16, m, lod="f"))
    return out
def iv_pole(n, x, y, z0, z1, mat="chrome"):
    return [cyl(f"{n}", "z", [x, y], 12, [z0, z1], mat),
            box(f"{n} Hook Bar", x - 110, y - 5, z1 - 18, x + 110, y + 5, z1 - 6, "chrome", lod="f"),
            cyl(f"{n} Hook", "z", [x - 100, y], 5, [z1 - 55, z1 - 6], "chrome", "f", rep=(2, 200, 0, 0))]
def five_leg_base(R, r_c, z0, pre="Base"):
    out = [turn(f"{pre} Hub", "z", [0, 0], [[0, z0 - 5], [55, z0 - 5], [50, z0 + 45], [0, z0 + 55]], "mgrey")]
    for k in range(5):
        a = math.radians(90 + 72 * k); ex, ey = R * math.cos(a), R * math.sin(a)
        out.append(prism(f"{pre} Leg {k + 1}", bar2([40 * math.cos(a), 40 * math.sin(a)], [ex, ey], 34), z0, z0 + 28, "mgrey"))
        out += castor(f"Castor {k + 1}", ex, ey, r_c)
    return out

WATER_NOTE = " Water and gases via the nested service point (FMC_P_MechEq_ServicePoint); Medical Equipment cannot hold pipe connectors."
P = []
def product(fam, tname, desc, ifc, parts, values, about, E=None, voltage=240, elv=None, conn_part=None, conn_side="back",
            elv_part=None, clear=None, tv=None):
    rec = RECS[fam]
    used = sorted({p['mat'] for p in parts if p.get('mat')})
    prod = {"family": fam, "category": rec['category'], "template": "Metric Generic Model.rft", "desc": desc, "ifc": ifc,
            "keynote": rec['kn'], "types": [{"name": tname}], "materials": {k: MATS[k] for k in used},
            "reference": dict(rec['ref']), "parts": parts, "values": values, "about": about}
    tvals = dict(tv or {}); conns = []
    codes = rec['connectors']
    if 'E' in codes:
        conns.append({"n": "Power", "domain": "electrical", "system": "PowerBalanced", "part": conn_part, "side": conn_side})
        tvals['Voltage'] = voltage; tvals['Apparent Load'] = E
        if voltage == 415: tvals['Number of Poles'] = 3
    if 'ELV' in codes:
        conns.append({"n": elv[0], "domain": "electrical", "system": elv[1], "part": elv_part or conn_part, "side": conn_side})
    if any(c in codes for c in ('CW', 'HW', 'SAN', 'MG', 'VNT', 'ST')): prod['about'] += WATER_NOTE
    if conns: prod['connectors'] = conns
    if tvals: prod['type_values'] = tvals
    if clear: prod['clearances'] = clear
    P.append(prod); return prod

# ================================================================== BEDS
def bed_electric(L, W, kind):
    hx, hy = L / 2, W / 2
    r = 75 if kind in ('icu', 'bari') else 62; top = ctop(r); d0 = 450 if kind != 'bari' else 430
    t = 170 if kind != 'ward' else 140
    rail = "mgrey" if kind != 'ward' else "white"
    P_ = castors4(-hx + 170, hx - 170, -hy + 140, hy - 140, r)
    P_ += [box("Base Frame", -hx + 120, -hy + 100, top - 6, hx - 120, hy - 100, top + 40, "frame", r=25),
           box("Base Cover", -hx + 320, -hy + 170, top + 40, hx - 320, hy - 170, top + 150, "white", r=70),
           box("Lift Column", -hx + 430, -120 if kind != 'bari' else -170, top + 40, -hx + 590, 120 if kind != 'bari' else 170, d0, "mgrey", r=30, rep=(2, L - 1020, 0, 0)),
           box("Deck Frame", -hx + 50, -hy + 45, d0, hx - 50, hy - 45, d0 + 45, "frame", r=20),
           cyl("Bumper Wheel", "z", [-hx + 20, -hy + 45], 36, [d0 - 35, d0 + 55], "grey", rep=(2, 0, W - 90, 0))]
    zb = d0 + 45; hinge = -200; Lb = hinge - (-hx + 80)
    P_ += [fbox("Mattress Seat And Legs", hinge, -hy + 65, zb, hx - 80, hy - 65, zb + t, "mattress", r=40),
           front("Mattress Back", incl(hinge, zb, 30, -Lb if False else Lb, 0, t, -1), -hy + 65, hy - 65, "mattress"),
           front("Backrest Deck", incl(hinge, zb, 30, Lb, -40, 0, -1), -hy + 55, hy - 55, "frame"),
           fbox("Mattress Side Seam", hinge + 10, -hy + 63, zb + t * 0.5, hx - 110, -hy + 65, zb + t * 0.5 + 6, "vinyl", lod="f"),
           front("Mattress Back Seam", incl(hinge, zb, 30, Lb - 30, t * 0.5, t * 0.5 + 6, -1), -hy + 63, -hy + 65, "vinyl", lod="f"),
           box("Mattress Section Seam", 330, -hy + 65, zb + t, 338, hy - 65, zb + t + 2, "vinyl", lod="f")]
    hb = "white" if kind != 'ward' else "hpl"
    P_ += [right("Headboard", rr(-hy + 15, d0 - 40, hy - 15, d0 + 560, 70), -hx + 10, -hx + 40, hb),
           right("Headboard Grip Slot", rr(-200, d0 + 440, 200, d0 + 500, 28), -hx + 40, -hx + 42, "dark", lod="f"),
           right("Footboard", rr(-hy + 15, d0 - 40, hy - 15, d0 + 430, 60), hx - 40, hx - 10, hb),
           right("Footboard Grip Slot", rr(-hy + 50, d0 + 365, -hy + 230, d0 + 405, 18), hx - 10, hx - 8, "dark", lod="f"),
           right("Footboard Grip Slot Right", rr(hy - 230, d0 + 365, hy - 50, d0 + 405, 18), hx - 10, hx - 8, "dark", lod="f"),
           right("Nurse Panel", rr(-210, d0 + 200, 210, d0 + 345, 18), hx - 10, hx - 5, "mgrey"),
           right("Nurse Panel Display", rr(-185, d0 + 235, -45, d0 + 325, 6), hx - 5, hx - 3.5, "screen", lod="f"),
           cyl("Nurse Panel Key", "x", [5, d0 + 300], 14, [hx - 5, hx - 2], "white", "f", rep=(4, 0, 46, 0)),
           cyl("Status LED", "x", [5, d0 + 245], 6, [hx - 5, hx - 2.5], "ledg", "f", rep=(3, 0, 46, 0))]
    def rails(nm, xa, xb, z0, z1):
        return [fbox(nm, xa, -hy - 32, z0, xb, -hy - 10, z1, rail, r=55, rep=(2, 0, W + 42, 0)),
                fbox(f"{nm} Grip Slot", xa + 90, -hy - 33.5, z1 - 95, xb - 90, -hy - 32, z1 - 45, "dark", r=22, lod="f", rep=(2, 0, W + 65.5, 0)),
                box(f"{nm} Arm", xa + 100, -hy - 15, d0 + 20, xa + 140, hy + 15, z0 + 30, "grey", rep=(2, xb - xa - 240, 0, 0))]
    P_ += rails("Head Rail", -hx + 140, -hx + 820, d0 + 150, d0 + 520) + rails("Foot Rail", 60, hx - 160, d0 + 150, d0 + 470)
    P_ += iv_pole("IV Pole", -hx + 55, -hy + 75, d0 - 30, d0 + 1400)
    P_ += [fbox("Handset", 300, -hy - 52, d0 + 240, 370, -hy - 32, d0 + 410, "grey", r=20, lod="f"),
           fbox("Handset Keys", 312, -hy - 53.5, d0 + 280, 358, -hy - 52, d0 + 390, "white", r=6, lod="f")]
    if kind == 'icu':
        P_ += [fbox("Rail Control Panel", -hx + 380, -hy - 35, d0 + 260, -hx + 620, -hy - 32, d0 + 360, "grey", r=12, lod="f"),
               cyl("Rail Control Key", "y", [-hx + 415, d0 + 310], 11, [-hy - 38, -hy - 35], "white", "f", rep=(4, 45, 0, 0)),
               box("CPR Release Handle", -hx + 300, -hy + 15, d0 - 20, -hx + 460, -hy + 45, d0 + 30, "red", r=10)]
    if kind == 'bari':
        P_ += [box("Lifting Pole Socket", -hx - 60, -40, d0 - 60, -hx + 10, 40, d0 + 560, "frame", r=12),
               cyl("Lifting Pole Post", "z", [-hx - 25, 0], 30, [d0 + 560, 2050], "frame"),
               cyl("Lifting Pole Boom", "x", [0, 2030], 28, [-hx - 25, -hx + 760], "frame"),
               box("Trapeze Strap", -hx + 700, -20, 1640, -hx + 730, 20, 2005, "dark"),
               cyl("Trapeze Handle", "y", [-hx + 715, 1630], 18, [-140, 140], "yellow")]
    return P_

f = "FMC_I_MedEq_Bed_ICU_Electric"
product(f, "2200x1000_ICU", "ICU bed, electric, 4-section, 2200 x 1000, split side rails with nurse controls, 150 mm central-brake castors, IV pole, CPR release",
        "IfcMedicalDevice", bed_electric(2200, 1000, 'icu'),
        {"Overall 2200 x 1000 mm": A("2200x1000"), "Platform height 450 to 850 mm": A("450-850", "typical ICU bed range"),
         "Castors 150 mm, central brake": A(150), "Clear perimeter 1200 mm": A(1200, "HBN 04-02 critical care bed space")},
        "ICU bed modelled as a generic product: hooded castors with brake pedals, base frame and shroud, twin lift columns, deck, "
        "4-section mattress with the backrest raised 30 deg (seams at Fine), split head and foot rails with grip slots and nurse keypad, "
        "headboard, footboard nurse panel with display, keys and LEDs, IV pole, handset, red CPR release.",
        E=600, elv=("Nurse Call", "NurseCall"), conn_part="Base Cover",
        clear=[{"n": "Bed Perimeter", "shape": "box", "at": [-1100, -1700, 0, 2300, 1700, 10], "sub": "Clearance Operation"}])

f = "FMC_I_MedEq_Bed_Ward_Electric"
product(f, "2150x950_3Function", "Ward bed, electric, 3-function (height, back, knee), 2150 x 950, split rails, 125 mm castors, HPL head and foot boards",
        "IfcMedicalDevice", bed_electric(2150, 950, 'ward'),
        {"Overall 2150 x 950 mm": A("2150x950"), "Platform height 400 to 800 mm": A("400-800", "typical ward bed range"),
         "Castors 125 mm": A(125), "Safe working load 230 kg": A(230, "typical, EN 60601-2-52")},
        "Ward bed modelled as a generic product: castors with brakes, base and shroud, lift columns, raised backrest, split rails "
        "with grip slots, HPL head and foot boards, foot panel, IV pole, handset.",
        E=400, conn_part="Base Cover")

f = "FMC_I_MedEq_Bed_Bariatric"
product(f, "2300x1200_Bariatric", "Bariatric bed, electric, 2300 x 1200, reinforced lift columns, split rails, lifting pole with trapeze, 150 mm castors",
        "IfcMedicalDevice", bed_electric(2300, 1200, 'bari'),
        {"Overall 2300 x 1200 mm": A("2300x1200"), "Safe working load 450 kg": A(450, "typical bariatric bed"),
         "Castors 150 mm": A(150), "Access zone 1500 mm each side": A(1500, "bariatric bed space practice")},
        "Bariatric bed modelled as a generic product: heavy castors, wide base, broad lift columns, raised backrest, split rails, "
        "lifting pole with yellow trapeze handle, IV pole, foot panel.",
        E=800, conn_part="Base Cover",
        clear=[{"n": "Bariatric Access Zone", "shape": "box", "at": [-1150, -2100, 0, 2650, 2100, 10], "sub": "Clearance Accessibility"}])

# manual ward bed, 2 cranks
def bed_manual():
    L, W = 2000, 900; hx, hy = L / 2, W / 2; r = 62; top = ctop(r)
    P_ = castors4(-hx + 30, hx - 30, -hy + 30, hy - 30, r)
    P_ += [cyl("Head Post", "z", [-hx + 30, -hy + 30], 20, [top, 1050], "frame", rep=(2, 0, W - 60, 0)),
           cyl("Foot Post", "z", [hx - 30, -hy + 30], 20, [top, 850], "frame", rep=(2, 0, W - 60, 0)),
           cyl("Head Top Tube", "y", [-hx + 30, 1050], 20, [-hy + 30, hy - 30], "frame"),
           cyl("Foot Top Tube", "y", [hx - 30, 850], 20, [-hy + 30, hy - 30], "frame"),
           right("Head Panel", rr(-hy + 52, 560, hy - 52, 1000, 30), -hx + 22, -hx + 38, "hpl"),
           right("Foot Panel", rr(-hy + 52, 470, hy - 52, 800, 30), hx - 38, hx - 22, "hpl"),
           cyl("Head Low Tube", "y", [-hx + 30, 300], 16, [-hy + 30, hy - 30], "frame"),
           cyl("Foot Low Tube", "y", [hx - 30, 300], 16, [-hy + 30, hy - 30], "frame"),
           box("Side Frame", -hx + 30, -hy + 20, 380, hx - 30, -hy + 60, 430, "frame", rep=(2, 0, W - 80, 0)),
           box("Spring Deck", -hx + 60, -hy + 60, 405, hx - 60, hy - 60, 425, "dark")]
    zb = 430; hinge = -150; Lb = hinge - (-hx + 60)
    P_ += [fbox("Mattress Seat And Legs", hinge, -hy + 50, zb, hx - 60, hy - 50, zb + 130, "mattress", r=35),
           front("Mattress Back", incl(hinge, zb, 40, Lb, 0, 130, -1), -hy + 50, hy - 50, "mattress"),
           front("Backrest Frame", incl(hinge, zb, 40, Lb, -30, 0, -1), -hy + 60, hy - 60, "frame"),
           fbox("Mattress Side Seam", hinge + 10, -hy + 48, zb + 62, hx - 90, -hy + 50, zb + 68, "vinyl", lod="f"),
           front("Mattress Back Seam", incl(hinge, zb, 40, Lb - 30, 62, 68, -1), -hy + 48, -hy + 50, "vinyl", lod="f")]
    P_ += [cyl("Crank Shaft", "x", [-200, 350], 10, [0, hx + 40], "chrome", rep=(2, 0, 400, 0)),
           box("Crank Arm", hx + 40, -210, 290, hx + 52, -190, 362, "chrome", rep=(2, 0, 400, 0)),
           cyl("Crank Knob", "x", [-200, 298], 14, [hx + 52, hx + 105], "black", rep=(2, 0, 400, 0)),
           box("Gearbox", -40, -230, 330, 40, -170, 380, "dark", rep=(2, 0, 400, 0), lod="f"),
           cyl("Side Rail Tube Front", "x", [-hy - 22, 650], 12, [-hx + 300, hx - 300], "chrome", rep=(2, 0, 0, 110)),
           cyl("Side Rail Tube Back", "x", [hy + 22, 650], 12, [-hx + 300, hx - 300], "chrome", rep=(2, 0, 0, 110)),
           cyl("Side Rail Post Front", "z", [-hx + 330, -hy - 22], 13, [400, 772], "chrome", rep=(2, L - 660, 0, 0)),
           cyl("Side Rail Post Back", "z", [-hx + 330, hy + 22], 13, [400, 772], "chrome", rep=(2, L - 660, 0, 0)),
           box("Side Rail Bracket", -hx + 315, -hy - 30, 380, -hx + 345, hy + 30, 410, "chrome", rep=(2, L - 660, 0, 0))]
    return P_
f = "FMC_I_MedEq_Bed_Ward_Manual"
product(f, "2000x900_2Crank", "Manual ward bed, 2-crank (backrest and knee), 2000 x 900, tubular epoxy-white ends with HPL panels, chrome drop rails, 125 mm castors",
        "IfcMedicalDevice", bed_manual(),
        {"Overall 2000 x 900 mm": A("2000x900"), "Deck height 430 mm": A(430, "fixed-height manual bed"),
         "Castors 125 mm with brakes": A(125), "Head end 1050 mm, foot end 850 mm": A("1050/850")},
        "Manual bed modelled as a generic product: tubular head and foot ends with HPL panels, side frames, spring deck, mattress with "
        "raised backrest, two foot-end cranks with knobs and gearboxes, chrome two-bar drop rails, castors with brakes.")

def cot():
    L, W = 1400, 700; hx, hy = L / 2, W / 2; r = 50; top = ctop(r)
    P_ = castors4(-hx + 60, hx - 60, -hy + 60, hy - 60, r)
    P_ += [box("Base Frame", -hx + 30, -hy + 30, top - 4, hx - 30, hy - 30, top + 36, "frame", r=20),
           box("Storage Shelf", -hx + 60, -hy + 50, 330, hx - 60, hy - 50, 345, "mel"),
           cyl("Corner Post Front", "z", [-hx + 30, -hy + 30], 22, [top + 36, 1350], "frame", rep=(2, L - 60, 0, 0)),
           cyl("Corner Post Back", "z", [-hx + 30, hy - 30], 22, [top + 36, 1350], "frame", rep=(2, L - 60, 0, 0)),
           cyl("Post Cap Front", "z", [-hx + 30, -hy + 30], 26, [1350, 1370], "blue", rep=(2, L - 60, 0, 0)),
           cyl("Post Cap Back", "z", [-hx + 30, hy - 30], 26, [1350, 1370], "blue", rep=(2, L - 60, 0, 0)),
           box("Deck Frame", -hx + 50, -hy + 50, 570, hx - 50, hy - 50, 600, "frame"),
           fbox("Mattress", -hx + 55, -hy + 55, 600, hx - 55, hy - 55, 700, "mattress", r=25),
           fbox("Mattress Seam", -hx + 70, -hy + 53, 648, hx - 70, -hy + 55, 653, "vinyl", lod="f"),
           cyl("Side Top Rail", "x", [-hy + 30, 1300], 17, [-hx + 30, hx - 30], "frame", rep=(2, 0, W - 60, 0)),
           cyl("Side Bottom Rail", "x", [-hy + 30, 620], 17, [-hx + 30, hx - 30], "frame", rep=(2, 0, W - 60, 0)),
           cyl("Bar Front", "z", [-hx + 132, -hy + 30], 9, [620, 1300], "frame", rep=(12, 103, 0, 0)),
           cyl("Bar Back", "z", [-hx + 132, hy - 30], 9, [620, 1300], "frame", rep=(12, 103, 0, 0)),
           right("Head Panel", rr(-hy + 50, 610, hy - 50, 1320, 40), -hx + 22, -hx + 38, "clear"),
           right("Foot Panel", rr(-hy + 50, 610, hy - 50, 1320, 40), hx - 38, hx - 22, "clear"),
           right("Foot Panel Name Card", rr(-120, 1150, 120, 1250, 10), hx - 22, hx - 20, "white", lod="f"),
           box("Drop Side Latch", -hx + 80, -hy + 5, 1270, -hx + 140, -hy + 20, 1330, "blue", r=8, lod="f", rep=(2, L - 220, 0, 0))]
    return P_
f = "FMC_I_MedEq_Bed_Paediatric_Cot"
product(f, "1400x700_HighRail", "Paediatric hospital cot, 1400 x 700, high barred drop sides, clear polycarbonate ends, epoxy-white steel, castors with brakes",
        "IfcMedicalDevice", cot(),
        {"Overall 1400 x 700 mm": A("1400x700"), "Side height 700 mm above mattress": A(700, "high-sided paediatric cot"),
         "Bar spacing 103 mm centres (85 mm clear)": A(103, "BS EN 716 type spacing to confirm"), "Castors 100 mm": A(100)},
        "Cot modelled as a generic product: castors with brakes, base frame, storage shelf, corner posts with caps, barred drop sides "
        "with latches, clear end panels, name card, mattress.")

def delivery():
    L, W = 1900, 800; hx, hy = L / 2, W / 2; r = 62; top = ctop(r); zb = 720
    P_ = castors4(-hx + 170, hx - 300, -hy + 130, hy - 130, r)
    P_ += [box("Base Frame", -hx + 120, -hy + 90, top - 6, hx - 250, hy - 90, top + 40, "frame", r=25),
           box("Base Cover", -hx + 200, -hy + 140, top + 40, hx - 330, hy - 140, top + 170, "white", r=70),
           box("Lift Column", -260, -170, top + 170, 60, 170, zb - 60, "white", r=50),
           box("Deck Frame", -hx + 60, -hy + 40, zb - 60, 300, hy - 40, zb, "frame", r=20),
           fbox("Seat Cushion", -150, -hy + 55, zb, 190, hy - 55, zb + 110, "vinyl", r=30),
           box("Seat Wing", 190, -hy + 55, zb, 330, -140, zb + 110, "vinyl", r=30, rep=(2, 0, hy + 85, 0)),
           front("Backrest", incl(-150, zb, 45, 760, 0, 110, -1), -hy + 55, hy - 55, "vinyl"),
           front("Backrest Shell", incl(-150, zb, 45, 760, -35, 0, -1), -hy + 60, hy - 60, "white"),
           front("Backrest Seam", incl(-150, zb, 45, 730, 52, 58, -1), -hy + 53, -hy + 55, "dark", lod="f"),
           fbox("Foot Section Stowed", 200, -hy + 70, zb - 230, 520, hy - 70, zb - 130, "vinyl", r=25),
           box("Foot Section Slide", 180, -hy + 90, zb - 140, 330, hy - 90, zb - 60, "frame"),
           turn("Catch Basin", "z", [300, 0], [[0, zb - 160], [150, zb - 150], [175, zb - 75], [168, zb - 75], [145, zb - 142], [0, zb - 150]], "ss"),
           box("Accessory Rail", -150, -hy - 25, zb - 45, 320, -hy - 13, zb - 20, "chrome", rep=(2, 0, W + 38, 0)),
           box("Rail Standoff", -120, -hy - 13, zb - 45, -100, -hy + 40, zb - 20, "chrome", rep=(2, 400, 0, 0), lod="f"),
           cyl("Leg Support Post", "z", [330, -hy - 40], 16, [zb - 60, zb + 430], "chrome", rep=(2, 0, W + 80, 0)),
           box("Leg Support Clamp", 305, -hy - 60, zb - 70, 355, -hy - 10, zb - 10, "dark", r=8, rep=(2, 0, W + 70, 0)),
           box("Leg Support Arm", 320, -hy - 55, zb + 410, 420, -hy - 25, zb + 435, "chrome", rep=(2, 0, W + 80, 0)),
           fbox("Knee Crutch", 300, -hy - 100, zb + 430, 600, -hy + 10, zb + 510, "vinyl", r=35, rep=(2, 0, W + 90, 0)),
           fbox("Knee Crutch Strap", 430, -hy - 102, zb + 430, 470, -hy + 12, zb + 512, "black", lod="f", rep=(2, 0, W + 90, 0)),
           cyl("Handgrip", "x", [-hy - 45, zb + 260], 15, [-560, -240], "chrome", rep=(2, 0, W + 90, 0)),
           cyl("Handgrip Cover", "x", [-hy - 45, zb + 260], 20, [-520, -320], "black", rep=(2, 0, W + 90, 0)),
           cyl("Handgrip Post Front", "z", [-260, -hy - 45], 12, [zb - 45, zb + 260], "chrome", rep=(2, -280, 0, 0)),
           cyl("Handgrip Post Back", "z", [-260, hy + 45], 12, [zb - 45, zb + 260], "chrome", rep=(2, -280, 0, 0)),
           cyl("Head Push Bar", "y", [-hx + 30, zb + 40], 16, [-hy + 60, hy - 60], "chrome"),
           box("Head Bar Bracket", -hx + 20, -hy + 60, zb - 60, -hx + 60, -hy + 90, zb + 40, "frame", rep=(2, 0, W - 150, 0)),
           box("Hydraulic Pedal", -200, -hy - 80, top + 30, -80, -hy + 140, top + 55, "grey", r=10),
           box("Lowering Pedal", -40, -hy - 80, top + 30, 80, -hy + 140, top + 55, "red", r=10),
           fbox("Control Handle", 50, -hy - 30, zb - 55, 150, -hy - 20, zb - 30, "grey", lod="f")]
    return P_
f = "FMC_I_MedEq_Bed_Delivery"
product(f, "1900x800_Delivery", "Delivery bed, 1900 x 800, hydraulic, perineal seat cut-out with stainless catch basin, stowed foot section, knee crutch leg supports, handgrips",
        "IfcMedicalDevice", delivery(),
        {"Overall 1900 x 800 mm": A("1900x800"), "Seat height 720 mm (hydraulic range 650-950)": A(720, "typical hydraulic delivery bed"),
         "Backrest 0 to 70 deg": A("0-70"), "Castors 125 mm with brakes": A(125)},
        "Delivery bed modelled as a generic product: castors with brakes, shrouded base, hydraulic column with pump and lowering pedals, "
        "seat with perineal cut-out wings, raised backrest, stowed foot section, stainless catch basin, accessory rails, knee crutch "
        "leg supports with straps and clamps, handgrips, head push bar.")

def bassinet():
    L, W = 800, 450; hx, hy = L / 2, W / 2; r = 38; top = ctop(r)
    P_ = castor("Castor Front", -hx + 60, -hy + 50, r, rep=(2, L - 120, 0, 0), pedal=True) + castor("Castor Back", -hx + 60, hy - 50, r, rep=(2, L - 120, 0, 0))
    P_ += [box("Base Frame", -hx + 30, -hy + 25, top - 4, hx - 30, hy - 25, top + 32, "frame", r=16),
           box("End Column", -hx + 60, -45, top + 32, -hx + 115, 45, 770, "frame", r=20, rep=(2, L - 175, 0, 0)),
           box("Storage Shelf", -hx + 115, -hy + 40, 330, hx - 115, hy - 40, 345, "mel"),
           box("Cradle Frame", -hx + 40, -hy + 15, 770, hx - 40, hy - 15, 790, "frame", r=12),
           box("Drawer Body", -250, -hy + 25, 680, 250, hy - 25, 770, "white"),
           fbox("Drawer Front", -260, -hy + 20, 680, 260, -hy + 25, 768, "white", r=10),
           fbox("Drawer Handle", -70, -hy + 10, 735, 70, -hy + 20, 750, "grey", r=4),
           box("Tub Floor", -360, -200, 790, 360, 200, 800, "clear", r=40),
           fbox("Tub Side", -360, -200, 800, 360, -194, 1060, "clear", r=30, rep=(2, 0, 394, 0)),
           right("Tub End", rr(-194, 800, 194, 1060, 30), -360, -354, "clear", rep=(2, 714, 0, 0)),
           box("Tub Rim", -365, -205, 1055, 365, -190, 1068, "clear", r=8, rep=(2, 0, 395, 0)),
           fbox("Mattress", -350, -190, 800, 350, 190, 865, "mattress", r=20),
           fbox("Mattress Seam", -340, -192, 830, 340, -190, 835, "vinyl", lod="f"),
           fbox("Name Card Holder", 190, -208, 975, 320, -200, 1030, "white", r=6, lod="f"),
           cyl("Tilt Knob", "y", [-hx + 88, 740], 16, [-75, -45], "black", lod="f")]
    return P_
f = "FMC_I_MedEq_Cot_Infant_Bassinet"
product(f, "800x450_Bedside", "Bedside infant bassinet, clear polycarbonate tub 720 x 400 on epoxy-white trolley with drawer, shelf and castors",
        "IfcMedicalDevice", bassinet(),
        {"Overall 800 x 450 mm": A("800x450"), "Tub rim height 1060 mm": A(1060, "bedside height"), "Clear tub 720 x 400 x 270 mm": A("720x400x270"),
         "Castors 75 mm, 2 braked": A(75)},
        "Bassinet modelled as a generic product: castors (front two braked), base frame, end columns, shelf, drawer with handle, cradle frame, "
        "clear tub (floor, sides, ends, rim), mattress, name card, tilt knob.")

def incubator():
    L, W = 1100, 700; hx, hy = L / 2, W / 2; r = 50; top = ctop(r)
    P_ = castors4(-hx + 90, hx - 90, -hy + 80, hy - 80, r)
    P_ += [box("Base Frame", -hx + 50, -hy + 40, top - 4, hx - 50, hy - 40, top + 40, "frame", r=25),
           box("Stand Cabinet", -450, -280, top + 40, 450, 280, 860, "mgrey", r=30),
           fbox("Drawer", -420, -287, 580, 420, -280, 830, "white", r=10, rep=(2, 0, 0, -260)),
           fbox("Drawer Handle", -120, -300, 785, 120, -287, 805, "grey", r=6, rep=(2, 0, 0, -260)),
           box("Incubator Base", -hx + 20, -hy + 20, 860, hx - 20, hy - 20, 1010, "white", r=60),
           box("Hood Base Rail", -hx + 35, -hy + 35, 1010, hx - 35, hy - 35, 1022, "mgrey", r=50),
           front("Hood", rtop(-hx + 40, 1022, hx - 40, 1520, 170), -hy + 40, hy - 40, "clear"),
           turn("Porthole Ring", "y", [-200, 1220], [[52, -hy + 40], [68, -hy + 40], [68, -hy + 26], [52, -hy + 26]], "mgrey", rep=(2, 400, 0, 0)),
           turn("Porthole Door", "y", [-200, 1220], [[0, -hy + 30], [52, -hy + 30], [52, -hy + 34], [0, -hy + 34]], "clear", rep=(2, 400, 0, 0)),
           box("Porthole Latch", -215, -hy + 22, 1285, -185, -hy + 34, 1300, "white", lod="f", rep=(2, 400, 0, 0)),
           right("End Iris Port", rr(-60, 1150, 60, 1270, 50), hx - 40, hx - 30, "mgrey", lod="f"),
           fbox("Mattress Tray", -hx + 80, -hy + 80, 1022, hx - 80, hy - 80, 1060, "mattress", r=15),
           box("Hood Lift Handle", -150, -hy + 80, 1520, 150, -hy + 120, 1545, "mgrey", r=10)]
    P_ += screen("Control Display", 120, 470, -hy + 20, 880, 990, depth=6, bez=10, body="mgrey")
    P_ += [turn("Control Knob", "y", [60, 935], [[0, -hy + 14], [26, -hy + 14], [26, -hy - 6], [0, -hy - 6]], "grey"),
           fbox("Humidity Reservoir", -hx + 60, -hy + 14, 890, -hx + 280, -hy + 20, 980, "clear", r=12, lod="f"),
           cyl("Status LED", "y", [-180, 960], 6, [-hy + 16, -hy + 20], "ledg", "f", rep=(3, 30, 0, 0)),
           cyl("Accessory Pole", "z", [hx - 60, hy - 60], 15, [1010, 1850], "alu"),
           box("Accessory Shelf", hx - 230, hy - 210, 1600, hx - 40, hy - 40, 1615, "mgrey")]
    return P_
f = "FMC_I_MedEq_Incubator_Neonatal"
product(f, "1100x700_Closed", "Closed neonatal incubator on mobile cabinet stand, clear double-wall hood with 4 portholes, front control display, 1100 x 700",
        "IfcMedicalDevice", incubator(),
        {"Overall 1100 x 700 mm": A("1100x700"), "Mattress height 1060 mm": A(1060, "fixed-height stand"), "Power 600 VA": A(600, "typical incubator heater + controller"),
         "Hood 1020 x 620 x 500 mm": A("1020x620x500")},
        "Incubator modelled as a generic product: castors with brakes, cabinet stand with two drawers, incubator base, clear hood with "
        "portholes, latches and end iris port, mattress tray, control display with knob and LEDs, humidity reservoir, accessory pole and shelf.",
        E=600, conn_part="Incubator Base")

def warmer():
    L, W = 1000, 800; hx, hy = L / 2, W / 2; r = 50; top = ctop(r)
    P_ = castors4(-hx + 90, hx - 90, -hy + 80, hy - 80, r)
    P_ += [box("Base Frame", -hx - 90, -hy + 40, top - 4, hx - 50, hy - 40, top + 40, "frame", r=25),
           box("Stand Cabinet", -400, -260, top + 40, 420, 260, 760, "mgrey", r=30),
           fbox("Drawer", -380, -267, 520, 400, -260, 740, "white", r=10, rep=(2, 0, 0, -240)),
           fbox("Drawer Handle", -110, -280, 700, 130, -267, 718, "grey", r=6, rep=(2, 0, 0, -240)),
           box("Bed Platform", -380, -310, 760, 440, 310, 860, "white", r=40),
           fbox("Xray Tray", -340, -318, 780, 400, -310, 840, "grey", r=8, lod="f"),
           fbox("Mattress", -360, -290, 860, 420, 290, 910, "mattress", r=15),
           fbox("Side Wall", -370, -300, 860, 430, -294, 1020, "clear", r=12, rep=(2, 0, 594, 0)),
           right("End Wall", rr(-294, 860, 294, 1020, 12), 424, 430, "clear"),
           box("Column", -hx - 70, -90, top + 40, -hx + 30, 90, 2050, "white", r=30),
           fbox("Heater Arm", -hx - 70, -110, 1950, 120, 110, 2060, "white", r=40),
           box("Heater Head", -170, -330, 1860, 300, 330, 1990, "white", r=70),
           box("Heater Element", -140, -300, 1848, 270, 300, 1862, "dark", r=50),
           box("Reflector Slot", -110, -280, 1844, -100, 280, 1849, "chrome", lod="f", rep=(11, 35, 0, 0)),
           cyl("Observation Lamp", "z", [235, 0], 30, [1838, 1848], "white", "f"),
           box("Control Module", -hx - 110, -230, 1280, -hx + 50, -90, 1680, "white", r=30)]
    P_ += screen("Control Display", -hx - 90, -hx + 30, -230, 1450, 1650, depth=4, bez=10, body="mgrey")
    P_ += [cyl("Control Key", "y", [-hx - 70, 1350], 11, [-238, -230], "grey", "f", rep=(4, 30, 0, 0)),
           cyl("Alarm LED", "y", [-hx - 70, 1405], 6, [-237, -230], "ledr", "f", rep=(2, 30, 0, 0)),
           fbox("Flowmeter Body", -hx - 60, -98, 1120, -hx - 10, -90, 1250, "chrome", r=6),
           cyl("Flowmeter Tube", "z", [-hx - 35, -104], 10, [1135, 1240], "clear", "f"),
           cyl("Flowmeter Knob", "y", [-hx - 35, 1100], 12, [-112, -90], "white", "f"),
           box("Tilt Handle", 440, -60, 790, 480, 60, 820, "grey", r=10)]
    return P_
f = "FMC_I_MedEq_Warmer_Radiant_Infant"
product(f, "1000x800_Radiant", "Infant radiant warmer, 1000 x 800, overhead quartz heater head on column, bed platform with clear drop walls, X-ray tray, control module",
        "IfcMedicalDevice", warmer(),
        {"Overall 1000 x 800 mm, 2060 high": A("1000x800x2060"), "Heater 600 W": A(600, "typical radiant warmer heater"),
         "Mattress height 910 mm": A(910), "Power 800 VA": A(800, "heater + controller")},
        "Warmer modelled as a generic product: castors with brakes, cabinet with drawers, bed platform with X-ray tray, mattress, clear "
        "drop walls, column, heater arm and head with element and reflector slots, observation lamp, control module with display, keys "
        "and alarm LEDs, O2 flowmeter, tilt handle.",
        E=800, conn_part="Column")

def gynae():
    W = 650; hy = W / 2
    P_ = [box("Plinth", -830, -hy + 60, 0, 380, hy - 60, 80, "dark", r=10),
          box("Cabinet", -860, -hy + 40, 80, 410, hy - 40, 620, "frame", r=15),
          fbox("Drawer", -830, -hy + 33, 470, -260, -hy + 40, 600, "mgrey", r=8, rep=(2, 600, 0, 0)),
          fbox("Door", -830, -hy + 33, 100, -260, -hy + 40, 450, "mgrey", r=8, rep=(2, 600, 0, 0)),
          fbox("Drawer Handle", -620, -hy + 22, 545, -470, -hy + 33, 560, "chrome", r=4, rep=(2, 600, 0, 0)),
          fbox("Door Handle", -300, -hy + 22, 300, -285, -hy + 33, 420, "chrome", r=4, rep=(2, 600, 0, 0)),
          box("Top Frame", -900, -hy, 620, 450, hy, 660, "frame", r=10),
          fbox("Seat Cushion", -150, -hy + 5, 660, 450, hy - 5, 740, "vinyl", r=25),
          front("Backrest", incl(-150, 660, 40, 760, 0, 80, -1), -hy + 5, hy - 5, "vinyl"),
          front("Backrest Shell", incl(-150, 660, 40, 760, -30, 0, -1), -hy + 15, hy - 15, "frame"),
          fbox("Seat Seam", -140, -hy + 3, 698, 440, -hy + 5, 703, "dark", lod="f"),
          turn("Drain Bowl", "z", [470, 0], [[0, 540], [160, 545], [182, 615], [174, 615], [154, 553], [0, 550]], "ss"),
          box("Drain Bowl Slide", 360, -170, 560, 470, -140, 580, "ss", rep=(2, 0, 310, 0)),
          box("Accessory Rail", -150, -hy - 22, 625, 450, -hy - 10, 650, "chrome", rep=(2, 0, W + 32, 0)),
          box("Leg Holder Clamp", 410, -hy - 45, 600, 460, -hy - 5, 670, "dark", r=8, rep=(2, 0, W + 50, 0)),
          cyl("Leg Holder Post", "z", [435, -hy - 28], 15, [600, 1000], "chrome", rep=(2, 0, W + 56, 0)),
          box("Leg Holder Arm", 420, -hy - 45, 975, 560, -hy - 15, 995, "chrome", rep=(2, 0, W + 60, 0)),
          fbox("Leg Cradle", 480, -hy - 110, 990, 780, -hy + 10, 1060, "vinyl", r=35, rep=(2, 0, W + 100, 0)),
          fbox("Leg Cradle Strap", 610, -hy - 112, 990, 650, -hy + 12, 1062, "black", lod="f", rep=(2, 0, W + 100, 0)),
          box("Step", 420, -hy + 60, 160, 640, hy - 60, 200, "frame", r=10),
          box("Step Tread", 430, -hy + 70, 200, 630, hy - 70, 206, "rubber", lod="f"),
          box("Step Bracket", 400, -hy + 70, 80, 430, hy - 70, 200, "frame"),
          cyl("Paper Roll", "y", [-950, 700], 45, [-hy + 60, hy - 60], "white"),
          box("Paper Roll Bracket", -965, -hy + 45, 640, -930, -hy + 60, 700, "frame", rep=(2, 0, W - 105, 0)),
          cyl("Levelling Foot", "z", [-800, -hy + 80], 22, [-5 + 5, 12], "rubber", "f", rep=(2, 1150, 0, 0))]
    return P_
f = "FMC_I_MedEq_Couch_Gynaecology"
product(f, "1800x650_Stirrups", "Gynaecology examination couch, 1800 x 650 overall, cabinet base with drawers and doors, raised backrest, stainless drain bowl, leg cradles on posts, step",
        "IfcMedicalDevice", gynae(),
        {"Overall 1800 x 650 mm": A("1800x650"), "Seat height 740 mm": A(740), "Backrest 0 to 60 deg": A("0-60"),
         "Leg holders adjustable 900 to 1100 mm": A("900-1100")},
        "Gynae couch modelled as a generic product: plinth and cabinet base with drawers, doors and chrome handles, top frame, seat and "
        "raised backrest, stainless drain bowl on slides, accessory rails with clamps, leg holder posts and padded leg cradles with straps, "
        "step with tread, paper roll.")

def dialysis_chair():
    W = 800; hy = W / 2; r = 62; top = ctop(r)
    P_ = castors4(-420, 420, -250, 250, r)
    P_ += [box("Base Frame", -480, -300, top - 6, 480, 300, top + 40, "frame", r=40),
           box("Base Cover", -400, -260, top + 40, 400, 260, top + 120, "white", r=60),
           box("Lift Column", -170, -150, top + 120, 150, 150, 480, "mgrey", r=40),
           box("Seat Frame", -300, -270, 480, 260, 270, 520, "frame", r=20),
           fbox("Seat Cushion", -300, -280, 520, 260, 280, 640, "vinyl", r=40),
           fbox("Seat Seam", -280, -282, 578, 240, -280, 584, "dark", lod="f"),
           front("Backrest", incl(-300, 540, 45, 800, 0, 130, -1), -270, 270, "vinyl"),
           front("Backrest Shell", incl(-300, 540, 45, 800, -40, 0, -1), -260, 260, "mgrey"),
           front("Backrest Seam", incl(-300, 540, 45, 780, 63, 69, -1), -272, -270, "dark", lod="f")]
    ex, ez = incl_end(-300, 540, 45, 800, -1)
    P_ += [front("Headrest", incl(ex + 20, ez - 20, 45, 170, 20, 170, -1), -170, 170, "vinyl"),
           front("Leg Rest", incl(260, 560, -15, 560, 0, 110, 1), -260, 260, "vinyl"),
           front("Leg Rest Frame", incl(260, 560, -15, 560, -35, 0, 1), -240, 240, "mgrey")]
    fx, fz = incl_end(260, 560, -15, 560, 1)
    P_ += [box("Foot Plate", fx - 20, -230, fz - 160, fx + 25, 230, fz + 60, "grey", r=12),
           box("Armrest Post", -150, -hy + 40, 520, -100, -hy + 90, 730, "mgrey", r=10, rep=(2, 0, W - 130, 0)),
           fbox("Armrest Pad", -380, -hy + 25, 720, 160, -hy + 130, 800, "vinyl", r=35, rep=(2, 0, W - 155, 0)),
           fbox("Armrest Seam", -360, -hy + 23, 758, 140, -hy + 25, 763, "dark", lod="f"),
           box("Armrest Release Lever", 60, -hy + 20, 690, 120, -hy + 35, 715, "grey", lod="f")]
    hx_, hz_ = incl_end(-300, 540, 45, 600, -1)
    nx, nz = -math.sin(math.radians(45)), -math.cos(math.radians(45))
    P_ += [cyl("Push Handle", "y", [hx_ + nx * 50, hz_ + nz * 50], 15, [-310, 310], "chrome"),
           cyl("Push Handle Grip", "y", [hx_ + nx * 50, hz_ + nz * 50], 19, [-310, -230], "black", rep=(2, 0, 540, 0)),
           fbox("Handset", 0, -hy + 5, 600, 60, -hy + 25, 720, "grey", r=18, lod="f"),
           box("Central Brake Pedal", 420, -220, r * 1.2, 470, 220, r * 1.2 + 20, "red", r=8)]
    return P_
f = "FMC_I_MedEq_Chair_Dialysis"
product(f, "1900x800_Reclining", "Electric reclining dialysis / treatment chair, 1900 x 800 reclined, blue vinyl, padded armrests, push handle, central-brake castors",
        "IfcMedicalDevice", dialysis_chair(),
        {"Reclined 1900 x 800 mm": A("1900x800"), "Seat height 520 to 900 mm": A("520-900"), "Safe working load 200 kg": A(200),
         "Power 300 VA": A(300, "typical 3-motor treatment chair")},
        "Dialysis chair modelled as a generic product: castors with brakes and central brake pedal, base, lift column, seat, reclined "
        "backrest with shell and headrest, extended leg rest and foot plate, armrest posts and padded arms with release lever, push handle "
        "with grips, handset; seams at Fine.",
        E=300, conn_part="Base Cover")

def phlebotomy():
    P_ = [cyl("Leg Front", "z", [-210, -240], 15, [25, 450], "chrome", rep=(2, 420, 0, 0)),
          cyl("Leg Back", "z", [-210, 170], 15, [25, 450], "chrome", rep=(2, 420, 0, 0)),
          cyl("Glide Front", "z", [-210, -240], 20, [0, 25], "rubber", rep=(2, 420, 0, 0)),
          cyl("Glide Back", "z", [-210, 170], 20, [0, 25], "rubber", rep=(2, 420, 0, 0)),
          cyl("Front Crossbar", "x", [-240, 150], 11, [-210, 210], "chrome"),
          cyl("Side Crossbar", "y", [-210, 150], 11, [-240, 170], "chrome", rep=(2, 420, 0, 0)),
          box("Seat Frame", -240, -260, 440, 240, 200, 470, "dark", r=10),
          box("Seat Cushion", -250, -290, 470, 250, 210, 560, "vinyl", r=45),
          box("Seat Seam", -240, -292, 512, 240, -288, 518, "dark", lod="f"),
          right("Backrest", incl(200, 540, 80, 620, 0, 90, 1), -240, 240, "vinyl"),
          right("Backrest Shell", incl(200, 540, 80, 620, -30, 0, 1), -230, 230, "dark"),
          box("Backrest Upright", -60, 170, 440, 60, 230, 560, "dark"),
          box("Arm Bracket", -380, 60, 430, -240, 110, 460, "dark", rep=(2, 620, 0, 0)),
          cyl("Arm Post", "z", [-370, 85], 22, [430, 700], "chrome", rep=(2, 740, 0, 0)),
          cyl("Arm Height Knob", "x", [85, 620], 16, [-420, -392], "black", rep=(2, 812, 0, 0)),
          box("Armrest Board", -450, -480, 700, -290, 150, 720, "dark", r=20, rep=(2, 740, 0, 0)),
          box("Armrest Pad", -445, -475, 720, -295, 145, 775, "vinyl", r=35, rep=(2, 740, 0, 0)),
          box("Armrest Seam", -447, -477, 744, -293, 147, 749, "dark", lod="f", rep=(2, 740, 0, 0)),
          box("Armrest Hinge", -400, 100, 700, -340, 150, 720, "chrome", lod="f", rep=(2, 740, 0, 0)),
          cyl("Footrest Bar", "x", [-300, 120], 12, [-210, 210], "chrome"),
          box("Footrest Support", -205, -300, 110, -195, -240, 130, "chrome", rep=(2, 400, 0, 0))]
    return P_
f = "FMC_I_MedEq_Chair_Phlebotomy"
product(f, "900x700_Armrests", "Phlebotomy (blood-draw) chair, 900 x 700, padded seat and back, two long height-adjustable swing-away forearm rests, chrome tube frame",
        "IfcMedicalDevice", phlebotomy(),
        {"Overall 900 x 700 mm": A("900x700"), "Seat height 470 mm": A(470), "Armrest height 700 to 900 mm": A("700-900"),
         "Safe working load 160 kg": A(160)},
        "Phlebotomy chair modelled as a generic product: chrome legs with glides and crossbars, seat, reclined back with shell, padded "
        "forearm boards on posts with height knobs and swing-away hinges, footrest bar; seams at Fine.")

def dental():
    P_ = [box("Base Plate", -320, -270, 0, 470, 270, 40, "white", r=60),
          box("Lift Column", 80, -170, 40, 360, 170, 420, "white", r=40),
          box("Seat Shell", -260, -260, 420, 300, 260, 470, "white", r=30),
          fbox("Seat Cushion", -250, -250, 470, 300, 250, 560, "vinyl", r=40),
          front("Backrest", incl(-250, 520, 30, 700, 0, 100, -1), -230, 230, "vinyl"),
          front("Backrest Shell", incl(-250, 520, 30, 700, -35, 0, -1), -235, 235, "white")]
    ex, ez = incl_end(-250, 520, 30, 700, -1)
    P_ += [front("Headrest", incl(ex + 10, ez + 15, 20, 230, 10, 100, -1), -130, 130, "vinyl"),
           front("Headrest Bar", incl(ex + 40, ez - 10, 20, 220, -20, 12, -1), -40, 40, "chrome"),
           front("Leg Rest", incl(300, 520, -20, 600, 0, 90, 1), -230, 230, "vinyl"),
           front("Leg Rest Shell", incl(300, 520, -20, 600, -35, 0, 1), -235, 235, "white"),
           box("Armrest", -220, 255, 600, 160, 320, 650, "vinyl", r=25),
           box("Armrest Post", 100, 260, 470, 140, 300, 600, "white"),
           box("Delivery Bracket", 180, -310, 420, 260, -250, 470, "white"),
           cyl("Delivery Post", "z", [220, -300], 35, [470, 830], "white"),
           box("Delivery Arm", 180, -335, 800, 700, -265, 850, "white", r=25),
           box("Instrument Table", 600, -630, 850, 1000, -280, 900, "white", r=40),
           box("Instrument Tray", 700, -560, 900, 950, -340, 910, "ss", lod="f"),
           fbox("Table Keypad", 860, -560, 900, 980, -460, 906, "screen", lod="f"),
           box("Handpiece Holder", 620, -650, 860, 980, -615, 935, "mgrey", r=8),
           cyl("Handpiece", "z", [655, -632], 9, [935, 1080], "chrome", "f", rep=(5, 75, 0, 0)),
           cyl("Handpiece Hose", "z", [655, -640], 5, [640, 860], "black", "f", rep=(5, 75, 0, 0)),
           box("Water Unit", -170, 290, 0, 110, 460, 860, "white", r=40),
           turn("Cuspidor Bowl", "z", [-30, 420], [[0, 860], [110, 860], [140, 960], [130, 960], [100, 872], [0, 872]], "china"),
           box("Cup Filler", -40, 330, 940, -20, 380, 975, "chrome", lod="f"),
           box("Assistant Arm", -300, 300, 780, -150, 340, 810, "white"),
           box("Suction Holder", -360, 280, 760, -280, 360, 830, "mgrey", r=10),
           cyl("Suction Tip", "z", [-335, 320], 10, [830, 920], "grey", "f", rep=(2, 0, 25, 0)),
           cyl("Light Pole", "z", [-150, 400], 30, [860, 1920], "white"),
           box("Light Arm", -820, 380, 1890, -130, 420, 1930, "white", r=15),
           box("Light Arm Drop", -820, -20, 1890, -780, 420, 1930, "white", r=15),
           cyl("Light Swivel", "z", [-800, 0], 15, [1760, 1890], "grey"),
           box("Light Head", -960, -170, 1680, -640, 170, 1760, "white", r=120),
           box("Light Lens", -930, -140, 1672, -670, 140, 1680, "clear", r=100),
           cyl("Light Handle", "x", [0, 1720], 14, [-1010, -960], "black", "f"),
           turn("Foot Control", "z", [520, -560], [[0, 0], [150, 0], [150, 30], [120, 60], [0, 60]], "mgrey"),
           cyl("Foot Control Pedal", "z", [520, -560], 40, [60, 80], "grey", "f")]
    return P_
f = "FMC_I_MedEq_Chair_Dental"
product(f, "1900x900_Unit", "Dental chair unit, 1900 x 900, electric lift and recline, doctor's delivery unit with 5 handpieces, assistant water unit with cuspidor, operating light, foot control",
        "IfcMedicalDevice", dental(),
        {"Chair 1900 x 900 mm": A("1900x900"), "Seat height 420 to 800 mm": A("420-800"), "Operating light 15000-35000 lux": A("15000-35000"),
         "Power 1000 VA": A(1000, "typical dental unit incl. light")},
        "Dental unit modelled as a generic product: base plate, lift column, seat, backrest, headrest on bar, leg rest, armrest, delivery post "
        "and arm with instrument table, tray, keypad, holder, 5 handpieces with hoses, water unit with china cuspidor and cup filler, "
        "assistant suction arm, light pole, arm and head with lens and handle, foot control.",
        E=1000, conn_part="Base Plate", conn_side="bottom")

def recliner():
    P_ = castor("Castor Back", -300, 260, 30, rep=(2, 600, 0, 0))
    P_ += [cyl("Front Glide", "z", [-300, -300], 22, [0, 94], "rubber", rep=(2, 600, 0, 0)),
           box("Base Frame", -370, -330, 94, 370, 300, 130, "dark", r=20),
           box("Arm", -400, -380, 130, -280, 330, 640, "vinyl", r=40, rep=(2, 680, 0, 0)),
           box("Arm Cap", -405, -392, 640, -275, 342, 672, "wood", r=45, rep=(2, 680, 0, 0)),
           box("Arm Seam", -402, -383, 380, -278, -377, 386, "dark", lod="f", rep=(2, 680, 0, 0)),
           box("Seat Base", -280, -360, 130, 280, 260, 380, "vinyl", r=20),
           box("Seat Cushion", -280, -370, 380, 280, 260, 500, "vinyl", r=50),
           box("Seat Seam", -270, -372, 438, 270, -368, 444, "dark", lod="f"),
           right("Back Cushion", incl(260, 450, 75, 650, 0, 170, 1), -280, 280, "vinyl"),
           right("Back Shell", incl(260, 450, 75, 680, -40, 0, 1), -290, 290, "vinyl"),
           right("Head Roll", incl(*incl_end(260, 450, 75, 470, 1), 75, 190, 160, 240, 1), -270, 270, "vinyl"),
           right("Back Seam", incl(260, 450, 75, 640, 85, 91, 1), -282, -280, "dark", lod="f"),
           right("Footrest", incl(-360, 400, -15, 300, 0, 90, -1), -260, 260, "vinyl"),
           box("Footrest Linkage", -200, -560, 250, -180, -300, 390, "dark", lod="f", rep=(2, 380, 0, 0)),
           box("Recline Lever", 400, -220, 420, 412, -190, 560, "chrome"),
           cyl("Recline Knob", "x", [-205, 565], 16, [398, 440], "black")]
    hy_, hz_ = incl_end(260, 450, 75, 600, 1)
    P_ += [cyl("Push Handle", "x", [hy_ + 35, hz_ - 40], 15, [-260, 260], "chrome")]
    return P_
f = "FMC_I_MedEq_Chair_Recliner_Visitor"
product(f, "900x800_Visitor", "Visitor / patient recliner chair, 800 wide x 900 deep, wipe-clean blue vinyl, timber arm caps, lever recline with footrest, rear castors and push handle",
        "IfcFurniture", recliner(),
        {"Overall 800 x 900 mm (upright)": A("800x900"), "Seat height 500 mm": A(500), "Reclined depth 1600 mm": A(1600),
         "Safe working load 160 kg": A(160)},
        "Recliner modelled as a generic product: base frame on rear castors and front glides, upholstered arms with timber caps, seat, back "
        "cushion with shell and head roll, extended footrest with linkage, recline lever and knob, push handle; seams at Fine.")

def stretcher():
    L, W = 2000, 700; hx, hy = L / 2, W / 2; r = 75; top = ctop(r)
    P_ = castors4(-hx + 180, hx - 180, -hy + 120, hy - 120, r)
    P_ += [box("Chassis", -hx + 120, -hy + 80, top - 6, hx - 120, hy - 80, top + 50, "frame", r=25),
           box("Base Tray", -hx + 150, -hy + 90, top + 50, hx - 150, hy - 90, top + 150, "mgrey", r=60),
           box("Hydraulic Column", -hx + 430, -90, top + 150, -hx + 570, 90, 600, "rubber", r=50, rep=(2, L - 1000, 0, 0)),
           box("Hydraulic Pedal", -260, -hy - 70, top + 30, -100, -hy + 90, top + 55, "grey", r=10),
           box("Lowering Pedal", -60, -hy - 70, top + 30, 100, -hy + 90, top + 55, "red", r=10),
           box("Platform Frame", -hx + 40, -hy + 40, 600, hx - 40, hy - 40, 640, "frame", r=20),
           cyl("Bumper Wheel", "z", [-hx + 30, -hy + 50], 34, [570, 650], "grey", rep=(2, 0, W - 100, 0))]
    zb = 640; hinge = -200; Lb = hinge - (-hx + 60)
    P_ += [fbox("Mattress Seat And Legs", hinge, -hy + 60, zb, hx - 60, hy - 60, zb + 80, "mattress", r=30),
           front("Mattress Back", incl(hinge, zb, 35, Lb, 0, 80, -1), -hy + 60, hy - 60, "mattress"),
           front("Backrest Frame", incl(hinge, zb, 35, Lb, -30, 0, -1), -hy + 70, hy - 70, "frame"),
           fbox("Mattress Seam", hinge + 10, -hy + 58, zb + 37, hx - 90, -hy + 60, zb + 43, "vinyl", lod="f"),
           cyl("Side Rail Tube Front", "x", [-hy - 20, 720], 12, [-hx + 260, hx - 260], "chrome", rep=(2, 0, 0, 110)),
           cyl("Side Rail Tube Back", "x", [hy + 20, 720], 12, [-hx + 260, hx - 260], "chrome", rep=(2, 0, 0, 110)),
           cyl("Side Rail Post Front", "z", [-hx + 290, -hy - 20], 14, [610, 842], "chrome", rep=(2, L - 580, 0, 0)),
           cyl("Side Rail Post Back", "z", [-hx + 290, hy + 20], 14, [610, 842], "chrome", rep=(2, L - 580, 0, 0)),
           box("Side Rail Hinge", -hx + 270, -hy - 28, 595, -hx + 310, hy + 28, 625, "chrome", rep=(2, L - 580, 0, 0)),
           cyl("Push Handle Post", "z", [hx - 25, -hy + 80], 15, [600, 960], "chrome", rep=(2, 0, W - 160, 0)),
           cyl("Push Handle Bar", "y", [hx - 25, 960], 15, [-hy + 80, hy - 80], "chrome"),
           cyl("Push Handle Grip", "y", [hx - 25, 960], 20, [-hy + 140, hy - 140], "black")]
    P_ += iv_pole("IV Pole", -hx + 40, -hy + 60, 600, 1950)
    P_ += [cyl("O2 Cylinder", "x", [-hy + 190, top + 220], 70, [-300, 330], "black"),
           cyl("O2 Cylinder Shoulder", "x", [-hy + 190, top + 220], 70, [330, 400], "white"),
           cyl("O2 Cylinder Valve", "x", [-hy + 190, top + 220], 24, [400, 470], "chrome"),
           box("Cylinder Strap", -200, -hy + 110, top + 140, -170, -hy + 270, top + 295, "grey", rep=(2, 380, 0, 0)),
           box("Xray Cassette Tray", -hx + 70, -hy + 70, 575, -260, hy - 70, 598, "mgrey", lod="f")]
    return P_
f = "FMC_I_MedEq_Trolley_Stretcher"
product(f, "2000x700_Hydraulic", "Patient trolley (stretcher), hydraulic, 2000 x 700, chrome drop side rails, push handle, IV pole, O2 cylinder holder, X-ray cassette tray, 150 mm castors",
        "IfcMedicalDevice", stretcher(),
        {"Overall 2000 x 700 mm": A("2000x700"), "Platform height 600 to 900 mm": A("600-900", "typical hydraulic trolley"),
         "Castors 150 mm, central brake": A(150), "Safe working load 250 kg": A(250)},
        "Stretcher modelled as a generic product: castors with brakes, chassis, base tray, twin hydraulic columns with bellows, pump and "
        "lowering pedals, platform, mattress with raised back, chrome two-bar side rails on hinges, foot-end push handle with grip, IV "
        "pole, O2 cylinder with shoulder, valve and straps, X-ray cassette tray, bumper wheels.")

# ================================================================== WHEELCHAIRS
def wheelchair(W, bari=False):
    hx = W / 2; fx = hx - 75; wx = hx - 30   # frame x, wheel centre x
    R = 300; yc = 200
    P_ = [turn("Rear Tyre", "x", [yc, R], [[R - 30, -wx - 15], [R, -wx - 15], [R, -wx + 15], [R - 30, -wx + 15]], "rubber", rep=(2, 2 * wx, 0, 0)),
          turn("Rear Rim", "x", [yc, R], [[R - 55, -wx - 10], [R - 30, -wx - 10], [R - 30, -wx + 10], [R - 55, -wx + 10]], "alu", rep=(2, 2 * wx, 0, 0)),
          cyl("Rear Hub", "x", [yc, R], 40, [-wx - 25, -wx + 30], "alu", rep=(2, 2 * wx - 5, 0, 0)),
          turn("Pushrim Left", "x", [yc, R], [[R - 48, -wx - 32], [R - 36, -wx - 32], [R - 36, -wx - 15], [R - 48, -wx - 15]], "chrome"),
          turn("Pushrim Right", "x", [yc, R], [[R - 48, wx + 15], [R - 36, wx + 15], [R - 36, wx + 32], [R - 48, wx + 32]], "chrome")]
    for k, a in enumerate((0, 45, 90, 135)):
        c, s = math.cos(math.radians(a)) * (R - 55), math.sin(math.radians(a)) * (R - 55)
        P_.append(right(f"Spoke {k + 1}", bar2([yc - c, R - s], [yc + c, R + s], 5), -wx - 2, -wx + 2, "chrome", lod="f", rep=(2, 2 * wx, 0, 0)))
    P_ += [cyl("Seat Rail", "y", [-fx, 500], 12, [-300, 250], "chrome", rep=(2, 2 * fx, 0, 0)),
           cyl("Back Post", "z", [-fx, 230], 12, [300, 960], "chrome", rep=(2, 2 * fx, 0, 0)),
           cyl("Push Handle", "y", [-fx, 960], 12, [230, 310], "chrome", rep=(2, 2 * fx, 0, 0)),
           cyl("Push Handle Grip", "y", [-fx, 960], 17, [300, 410], "black", rep=(2, 2 * fx, 0, 0)),
           cyl("Lower Rail", "y", [-fx, 300], 12, [-260, 230], "chrome", rep=(2, 2 * fx, 0, 0)),
           cyl("Front Post", "z", [-fx, -260], 12, [230, 500], "chrome", rep=(2, 2 * fx, 0, 0)),
           box("Castor Fork Head", -fx - 20, -320, 200, -fx + 20, -248, 230, "chrome", rep=(2, 2 * fx, 0, 0)),
           box("Castor Fork Cheek", -fx - 18, -320, 95, -fx - 14, -280, 200, "chrome", rep=(2, 2 * fx + 32, 0, 0)),
           box("Castor Fork Cheek Inner", -fx + 14, -320, 95, -fx + 18, -280, 200, "chrome", rep=(2, 2 * fx - 32, 0, 0)),
           cyl("Castor Wheel", "x", [-300, 95], 95, [-fx - 12, -fx + 12], "castor", rep=(2, 2 * fx, 0, 0)),
           right("Footrest Hanger", bar2([-250, 480], [-470, 175], 24), -fx - 12, -fx + 12, "chrome", rep=(2, 2 * fx, 0, 0)),
           box("Footplate", -fx, -560, 150, -25, -400, 172, "black", r=10, rep=(2, fx + 25, 0, 0)),
           cyl("Arm Post Front", "z", [-fx, -120], 12, [500, 760], "chrome", rep=(2, 2 * fx, 0, 0)),
           box("Armrest Pad", -fx - 25, -220, 760, -fx + 25, 230, 800, "black", r=20, rep=(2, 2 * fx, 0, 0)),
           right("Side Guard", rr(-150, 520, 200, 740, 30), -fx - 18, -fx - 13, "grey", rep=(2, 2 * fx + 31, 0, 0)),
           box("Seat Sling", -fx, -290, 470, fx, 240, 500, "vinyl", r=10),
           fbox("Back Sling", -fx + 5, 228, 520, fx - 5, 240, 930, "vinyl", r=20),
           front("Cross Brace A", bar2([-fx, 300], [fx, 490], 22), -8, 8, "chrome"),
           front("Cross Brace B", bar2([fx, 300], [-fx, 490], 22), -8, 8, "chrome"),
           box("Brake Lever", -fx - 30, -50, 430, -fx - 20, -30, 560, "chrome", rep=(2, 2 * fx + 50, 0, 0)),
           cyl("Brake Knob", "z", [-fx - 25, -40], 14, [560, 600], "black", rep=(2, 2 * fx + 50, 0, 0)),
           cyl("Anti Tip Lever", "y", [-fx, 120], 10, [230, 470], "chrome", "f", rep=(2, 2 * fx, 0, 0))]
    if bari:
        P_ += [front("Cross Brace C", bar2([-fx, 300], [fx, 490], 22), 140, 156, "chrome"),
               front("Cross Brace D", bar2([fx, 300], [-fx, 490], 22), 140, 156, "chrome")]
    return P_
TURN = lambda: [{"n": "Turning Circle", "shape": "turn", "axis": "z", "c": [0, 0], "profile": [[0, 0], [750, 0], [750, 10], [0, 10]], "sub": "Clearance Accessibility"}]
f = "FMC_I_MedEq_Wheelchair_Standard"
product(f, "1050x650_SelfPropel", "Self-propelled wheelchair, 650 wide x 1050 long, 600 mm rear wheels with pushrims, 200 mm front castors, swing-away footrests, padded arms",
        "IfcMedicalDevice", wheelchair(650),
        {"Overall 650 x 1050 mm": A("650x1050"), "Seat width 460 mm, height 500 mm": A("460/500"), "Rear wheels 600 mm (24 in)": A(600),
         "Turning circle 1500 mm": A(1500, "BS 8300 / ADM wheelchair turning space")},
        "Wheelchair modelled as a generic product: rear tyres, rims, hubs, spokes and pushrims, chrome frame (seat and lower rails, back "
        "posts, push handles with grips, front posts), front castors with forks, footrest hangers and plates, arm posts and pads, side guards, "
        "seat and back slings, cross brace, brakes, anti-tip levers; 1500 turning circle on Clearance Accessibility.",
        clear=TURN())
f = "FMC_I_MedEq_Wheelchair_Bariatric"
product(f, "1100x800_Bariatric", "Bariatric wheelchair, 800 wide x 1100 long, double cross brace, 600 mm rear wheels with pushrims, wide seat",
        "IfcMedicalDevice", wheelchair(800, True),
        {"Overall 800 x 1100 mm": A("800x1100"), "Seat width 610 mm": A(610), "Safe working load 250 kg": A(250),
         "Turning circle 1500 mm": A(1500, "BS 8300 / ADM wheelchair turning space")},
        "Bariatric wheelchair modelled as a generic product: as the standard chair with a wider frame and seat and a double cross brace; "
        "1500 turning circle on Clearance Accessibility.",
        clear=TURN())

# ================================================================== TROLLEYS
def push_handle_x(x_face, z, y0, y1, out=60, pre="Push Handle"):
    s = -1 if x_face < 0 else 1
    return [cyl(pre, "y", [x_face + s * out, z], 15, [y0, y1], "chrome"),
            cyl(f"{pre} Standoff", "x", [y0 + 15, z], 11, sorted([x_face, x_face + s * out]), "chrome", rep=(2, 0, y1 - y0 - 30, 0))]

def crash():
    r = 50; top = ctop(r)
    P_ = castors4(-250, 250, -180, 180, r)
    P_ += [box("Base Bumper", -320, -250, top, 320, 250, top + 40, "grey", r=30),
           box("Body", -280, -215, top + 40, 280, 225, 1000, "mgrey", r=10),
           box("Corner Post Front", -305, -240, top + 40, -265, -200, 1000, "grey", r=18, rep=(2, 570, 0, 0)),
           box("Corner Post Back", -305, 205, top + 40, -265, 245, 1000, "grey", r=18, rep=(2, 570, 0, 0)),
           fbox("Drawer Small", -255, -222, 880, 255, -215, 980, "red", r=6, rep=(3, 0, 0, -110)),
           fbox("Drawer Large", -255, -222, 470, 255, -215, 650, "red", r=6, rep=(2, 0, 0, -190)),
           fbox("Drawer Small Handle", -200, -230, 950, 200, -222, 966, "grey", r=5, rep=(3, 0, 0, -110)),
           fbox("Drawer Large Handle", -200, -230, 620, 200, -222, 636, "grey", r=5, rep=(2, 0, 0, -190)),
           fbox("Drawer Label", -240, -223, 900, -150, -222, 930, "white", lod="f", rep=(3, 0, 0, -110)),
           box("Lock Bar", 262, -234, 300, 280, -222, 985, "grey"),
           box("Seal Tag", 255, -240, 955, 287, -234, 990, "yellow", lod="f"),
           box("Top Tray", -300, -240, 1000, 300, 240, 1015, "grey", r=12),
           box("Tray Rim", -300, -240, 1015, 300, -228, 1050, "grey", rep=(2, 0, 468, 0)),
           box("Tray Rim Side", -300, -228, 1015, -288, 228, 1050, "grey", rep=(2, 588, 0, 0)),
           box("Defibrillator", -230, -150, 1015, 130, 140, 1230, "dark", r=30)]
    P_ += [fbox("Defibrillator Display", -205, -152, 1110, 0, -150, 1210, "screen", r=4),
           box("Defibrillator Handle", -150, -30, 1230, 60, 30, 1260, "black", r=12),
           fbox("Defibrillator Paddle", 20, -158, 1040, 60, -150, 1110, "yellow", r=8, rep=(2, 55, 0, 0)),
           cyl("Defibrillator Knob", "y", [55, 1170], 18, [-162, -150], "black"),
           box("CPR Board", -260, 245, 300, 260, 265, 950, "yellow", r=30),
           box("CPR Board Hand Hole", -60, 264, 870, 60, 266, 920, "dark", r=20, lod="f"),
           cyl("O2 Cylinder", "z", [365, 0], 55, [300, 900], "black"),
           cyl("O2 Cylinder Shoulder", "z", [365, 0], 55, [900, 950], "white"),
           cyl("O2 Cylinder Valve", "z", [365, 0], 20, [950, 1010], "chrome"),
           box("Cylinder Bracket", 280, -62, 500, 425, 62, 520, "grey", rep=(2, 0, 0, 260)),
           box("Sharps Bin", -370, -90, 720, -305, 90, 880, "yellow", r=10),
           box("Sharps Bin Lid", -372, -92, 880, -303, 92, 905, "red", r=10, lod="f")]
    P_ += push_handle_x(-280, 930, -200, 200)
    P_ += iv_pole("IV Pole", 270, 265, 600, 1800)
    return P_
f = "FMC_I_MedEq_Trolley_Resuscitation"
product(f, "800x550_5Drawer", "Resuscitation (crash) trolley, 800 x 550 incl. handle, 5 red drawers with breakaway seal, defibrillator shelf, CPR board, O2 cylinder, sharps bin, IV pole",
        "IfcMedicalDevice", crash(),
        {"Overall 800 x 550 x 1000 mm (top)": A("800x550x1000"), "5 drawers (3 x 100, 2 x 180 mm)": A("3x100+2x180"),
         "Castors 100 mm, 2 braked": A(100), "Contents per Resuscitation Council UK list": A("RCUK", "RCUK quality standards equipment list")},
        "Crash trolley modelled as a generic product: castors with brakes, base bumper, grey body with corner posts, five red drawers with "
        "handles and labels, lock bar with seal tag, top tray with rims, defibrillator with display, handle, paddles and knob, CPR board, "
        "O2 cylinder with brackets, sharps bin, push handle, IV pole.")

def medicine():
    r = 50; top = ctop(r)
    P_ = castors4(-230, 230, -150, 150, r)
    P_ += [box("Base Bumper", -320, -220, top, 320, 220, top + 40, "grey", r=25),
           box("Body", -300, -200, top + 40, 300, 200, 900, "frame", r=10),
           fbox("Door", -282, -207, 200, -5, -200, 720, "blue", r=8, rep=(2, 287, 0, 0)),
           fbox("Door Handle", -50, -216, 470, -30, -207, 640, "chrome", r=4, rep=(2, 80, 0, 0)),
           cyl("Door Hinge", "z", [-285, -205], 6, [240, 300], "chrome", "f", rep=(2, 570, 0, 0)),
           fbox("Drawer", -282, -207, 730, -5, -200, 885, "white", r=8, rep=(2, 287, 0, 0)),
           fbox("Drawer Handle", -200, -214, 840, -90, -207, 856, "grey", r=4, rep=(2, 287, 0, 0)),
           fbox("Keypad", 180, -209, 600, 255, -207, 700, "black", r=6),
           cyl("Keypad LED", "y", [217, 685], 4, [-211, -209], "ledr", "f"),
           fbox("Keypad Keys", 190, -210, 612, 245, -209, 670, "grey", lod="f"),
           box("Worktop", -315, -215, 900, 315, 215, 920, "grey", r=15),
           box("Gallery Back", -315, 198, 920, 315, 215, 1000, "mgrey"),
           box("Gallery Side", -315, -215, 920, -298, 198, 1000, "mgrey", rep=(2, 613, 0, 0)),
           box("Wall Tether Bracket", -100, 200, 600, 100, 230, 700, "grey", lod="f")]
    P_ += push_handle_x(-300, 850, -170, 170)
    return P_
f = "FMC_I_MedEq_Trolley_Medicine"
product(f, "700x500_Lockable", "Lockable drug (medicine) trolley, 700 x 500 incl. handle, epoxy-white steel, blue lockable doors with keypad lock, drawers, gallery worktop, wall tether",
        "IfcMedicalDevice", medicine(),
        {"Overall 700 x 500 x 1000 mm": A("700x500x1000"), "Lock: digital keypad": A("keypad"), "Castors 100 mm, 2 braked": A(100)},
        "Medicine trolley modelled as a generic product: castors with brakes, base bumper, steel body, two blue doors with handles and "
        "hinges, two drawers, keypad lock with LED, worktop with gallery, wall tether bracket, push handle.")

def dressing():
    r = 38; top = ctop(r)
    P_ = castor("Castor Front", -370, -220, r, rep=(2, 740, 0, 0), pedal=True) + castor("Castor Back", -370, 220, r, rep=(2, 740, 0, 0))
    P_ += [cyl("Leg Front", "z", [-370, -220], 14, [top, 920], "ss", rep=(2, 740, 0, 0)),
           cyl("Leg Back", "z", [-370, 220], 14, [top, 920], "ss", rep=(2, 740, 0, 0)),
           box("Top Shelf", -400, -250, 900, 400, 250, 920, "ss", r=10),
           box("Drawer Body", -340, -240, 820, 340, 240, 900, "ss"),
           fbox("Drawer Front", -320, -246, 825, 320, -240, 895, "ss", r=5),
           fbox("Drawer Handle", -80, -258, 855, 80, -246, 868, "chrome", r=4),
           cyl("Gallery Back", "x", [245, 970], 8, [-395, 395], "ss"),
           cyl("Gallery Side", "y", [-395, 970], 8, [-245, 245], "ss", rep=(2, 790, 0, 0)),
           cyl("Gallery Post Back", "z", [-395, 245], 8, [920, 970], "ss", rep=(2, 790, 0, 0)),
           cyl("Gallery Post Front", "z", [-395, -245], 8, [920, 970], "ss", rep=(2, 790, 0, 0)),
           box("Bottom Shelf", -400, -250, 300, 400, 250, 318, "ss", r=10),
           fbox("Bottom Shelf Lip", -400, -252, 318, 400, -240, 340, "ss", r=4),
           box("Bowl Ring Bracket", 400, -15, 880, 460, 15, 900, "ss", lod="f"),
           turn("Bowl Ring", "z", [560, 0], [[92, 880], [104, 880], [104, 900], [92, 900]], "ss", lod="f")]
    return P_
f = "FMC_I_MedEq_Trolley_Dressing_SS"
product(f, "800x500_2Tier", "Stainless steel dressing trolley, 800 x 500, two shelves, gallery rails on three sides, drawer, bowl ring, 75 mm castors (2 braked)",
        "IfcFurniture", dressing(),
        {"Overall 800 x 500 x 970 mm": A("800x500x970"), "Grade 304 stainless steel": A("304"), "Castors 75 mm": A(75)},
        "Dressing trolley modelled as a generic product: four stainless tube legs on castors, top shelf with three-sided gallery and posts, "
        "drawer with handle, bottom shelf with lip, bowl ring on bracket.")

def mayo():
    r = 25; top = ctop(r)
    P_ = castor("Castor Front", -260, -175, r, rep=(2, 520, 0, 0), pedal=True) + castor("Castor Back", -260, 175, r, rep=(2, 520, 0, 0))
    P_ += [box("Base Rail", -290, -195, top - 4, 290, -155, top + 30, "ss", r=10, rep=(2, 0, 350, 0)),
           box("Base Crossbar", -290, -155, top - 4, -220, 155, top + 30, "ss"),
           cyl("Column", "z", [-255, 0], 25, [top + 30, 760], "ss"),
           turn("Height Collar", "z", [-255, 0], [[0, 730], [32, 730], [32, 775], [0, 775]], "chrome"),
           cyl("Height Knob", "y", [-255, 755], 20, [-75, -32], "black"),
           cyl("Inner Column", "z", [-255, 0], 18, [775, 1150], "ss"),
           box("Arm", -275, -16, 1120, 200, 16, 1145, "ss", r=8),
           box("Tray", -240, -180, 1145, 240, 180, 1155, "ss", r=20),
           box("Tray Rim", -240, -180, 1155, 240, -172, 1175, "ss", rep=(2, 0, 352, 0)),
           box("Tray Rim Side", -240, -172, 1155, -232, 172, 1175, "ss", rep=(2, 472, 0, 0)),
           front("Arm Gusset", [[-245, 1060], [-245, 1120], [-150, 1120]], -8, 8, "ss", lod="f")]
    return P_
f = "FMC_I_MedEq_Trolley_Instrument_Mayo"
product(f, "600x400_Mayo", "Mayo instrument stand, stainless steel, 480 x 360 removable tray on cantilever arm, telescopic column 850-1150, U-base on 50 mm castors",
        "IfcMedicalDevice", mayo(),
        {"Base 600 x 400 mm": A("600x400"), "Tray 480 x 360 mm": A("480x360"), "Height 850 to 1150 mm": A("850-1150")},
        "Mayo stand modelled as a generic product: U-base with rails and crossbar on castors, stainless column with collar and height knob, "
        "telescopic inner column, cantilever arm with gusset, tray with rims.")

def linen():
    r = 50; top = ctop(r)
    P_ = castors4(-390, 390, -230, 230, r, pedal=True)
    P_ += [box("Base Frame", -440, -280, top - 4, 440, 280, top + 30, "frame", r=20),
           cyl("Post Front", "z", [-430, -260], 14, [top + 30, 945], "frame", rep=(2, 860, 0, 0)),
           cyl("Post Back", "z", [-430, 260], 14, [top + 30, 945], "frame", rep=(2, 860, 0, 0)),
           box("Top Rail", -440, -272, 930, 440, -250, 945, "frame", rep=(2, 0, 522, 0)),
           box("Top Cross Rail", -445, -250, 930, -425, 250, 945, "frame", rep=(3, 435, 0, 0)),
           turn("Bag Hoop", "z", [-210, 0], [[205, 925], [222, 925], [222, 945], [205, 945]], "frame", rep=(2, 420, 0, 0)),
           turn("Linen Bag Blue", "z", [-210, 0], [[0, 330], [170, 335], [200, 380], [205, 925], [0, 925]], "vinyl"),
           turn("Linen Bag White", "z", [210, 0], [[0, 330], [170, 335], [200, 380], [205, 925], [0, 925]], "white"),
           turn("Lid", "z", [-210, 0], [[0, 945], [228, 945], [228, 960], [200, 990], [0, 995]], "grey", rep=(2, 420, 0, 0)),
           box("Lid Handle", -240, -40, 995, -180, 40, 1010, "dark", lod="f", rep=(2, 420, 0, 0)),
           box("Foot Pedal", -270, -340, top + 20, -150, -270, top + 40, "blue", r=8, rep=(2, 420, 0, 0)),
           cyl("Pedal Rod", "z", [-210, -280], 6, [top + 30, 950], "chrome", "f", rep=(2, 420, 0, 0)),
           cyl("Push Handle Post", "z", [455, -220], 12, [930, 1010], "chrome", rep=(2, 0, 440, 0)),
           cyl("Push Handle", "y", [455, 1010], 15, [-235, 235], "chrome"),
           box("Push Handle Bracket", 440, -232, 930, 470, -208, 945, "chrome", rep=(2, 0, 440, 0))]
    return P_
f = "FMC_I_MedEq_Trolley_Linen"
product(f, "900x600_2Bag", "Linen trolley, two-bag, 900 x 600, epoxy-white frame, pedal-operated lids, colour-coded bags, push handle, 100 mm castors",
        "IfcFurniture", linen(),
        {"Overall 900 x 600 x 1010 mm": A("900x600x1010"), "Two bags 120 l each": A(120), "Castors 100 mm": A(100)},
        "Linen trolley modelled as a generic product: castors with brakes, base frame, posts, top rails, bag hoops, blue and white bags, "
        "lids with handles, foot pedals with rods, push handle.")

def meal():
    r = 63; top = ctop(r)
    P_ = castors4(-480, 480, -240, 240, r)
    P_ += [box("Bumper", -600, -340, top + 10, 600, 340, top + 70, "rubber", r=60),
           box("Body", -560, -300, top + 30, 560, 300, 1000, "ss", r=20),
           fbox("Door", -545, -306, top + 90, -10, -300, 960, "ss", r=10, rep=(2, 555, 0, 0)),
           fbox("Door Handle", -60, -320, 600, -40, -306, 820, "chrome", r=5, rep=(2, 100, 0, 0)),
           cyl("Door Hinge Top", "z", [-548, -304], 7, [850, 920], "chrome", "f", rep=(2, 1096, 0, 0)),
           cyl("Door Hinge Bottom", "z", [-548, -304], 7, [300, 370], "chrome", "f", rep=(2, 1096, 0, 0)),
           box("Worktop", -575, -315, 1000, 575, 315, 1020, "ss", r=20),
           box("Worktop Rim", -575, 298, 1020, 575, 315, 1060, "ss"),
           box("Worktop Rim Side", -575, -315, 1020, -558, 298, 1060, "ss", rep=(2, 1133, 0, 0)),
           right("Control Panel", rr(-180, 700, 180, 940, 15), 560, 566, "mgrey"),
           right("Control Display", rr(-150, 860, 0, 920, 4), 566, 568, "screen", lod="f"),
           cyl("Thermostat Knob", "x", [80, 890], 20, [566, 590], "black", "f", rep=(2, 0, 70, 0)),
           cyl("Power LED", "x", [-140, 800], 7, [566, 570], "ledg", "f", rep=(2, 0, 40, 0)),
           cyl("Mains Switch", "x", [100, 760], 16, [566, 576], "red", "f"),
           right("Vent Slot", rr(-200, 300, 200, 310, 4), 560, 562, "dark", lod="f", rep=(6, 0, 0, 32)),
           box("Mains Lead Holder", -600, -60, 300, -560, 60, 420, "grey", lod="f")]
    P_ += push_handle_x(-560, 900, -230, 230)
    return P_
f = "FMC_I_MedEq_Trolley_Meal"
product(f, "1200x700_Heated", "Heated meal (food service) trolley, 1200 x 700, stainless steel, two heated compartments with doors, thermostat panel, wraparound bumper, 125 mm castors",
        "IfcFurniture", meal(),
        {"Overall 1200 x 700 x 1060 mm": A("1200x700x1060"), "Heating 1.5 kW": A(1500, "typical heated meal trolley"),
         "Holding temperature 63 C minimum": A(63, "food safety hot holding"), "Castors 125 mm": A(125)},
        "Meal trolley modelled as a generic product: castors with brakes, wraparound bumper, stainless body, two doors with handles and hinges, "
        "worktop with rims, end control panel with display, thermostat knobs, LEDs and mains switch, vent slots, push handle, lead holder.",
        E=1500, conn_part="Body")

def iv_stand():
    r = 25; top = ctop(r)
    P_ = five_leg_base(280, r, top)
    P_ += [turn("Pole Base Cover", "z", [0, 0], [[0, top + 55], [30, top + 55], [20, top + 120], [0, top + 120]], "mgrey"),
           cyl("Pole", "z", [0, 0], 13, [top + 55, 1300], "ss"),
           turn("Adjust Collar", "z", [0, 0], [[12, 1270], [22, 1275], [22, 1315], [12, 1315]], "chrome"),
           cyl("Adjust Knob", "y", [0, 1292], 16, [-50, -20], "black"),
           cyl("Upper Pole", "z", [0, 0], 9, [1315, 2100], "chrome"),
           turn("Crown", "z", [0, 0], [[0, 2085], [24, 2088], [24, 2112], [0, 2118]], "chrome"),
           box("Hook Arm X", -125, -5, 2095, 125, 5, 2105, "chrome"),
           box("Hook Arm Y", -5, -125, 2095, 5, 125, 2105, "chrome"),
           cyl("Hook Tip X", "z", [-120, 0], 5, [2105, 2150], "chrome", rep=(2, 240, 0, 0)),
           cyl("Hook Tip Y", "z", [0, -120], 5, [2105, 2150], "chrome", rep=(2, 0, 240, 0)),
           turn("Hook Ball", "z", [-120, 0], [[0, 2150], [7, 2153], [0, 2160]], "chrome", lod="f", rep=(2, 240, 0, 0))]
    return P_
f = "FMC_I_MedEq_Stand_IV"
product(f, "600_5Leg", "IV stand, 5-leg base 600 dia on 50 mm castors, stainless pole, chrome telescopic upper pole to 2150, 4-hook crown",
        "IfcMedicalDevice", iv_stand(),
        {"Base 600 mm diameter": A(600), "Height 1300 to 2150 mm": A("1300-2150"), "4 hooks": A(4)},
        "IV stand modelled as a generic product: five-leg base with hub and castors, pole with base cover, adjust collar and knob, upper pole, "
        "crown with four hook arms and tips.")

def overbed():
    r = 25; top = ctop(r)
    P_ = castor("Castor Front", -420, -165, r, rep=(2, 790, 0, 0)) + castor("Castor Back", -420, 165, r, rep=(2, 790, 0, 0))
    P_ += [box("Base Leg", -450, -190, top - 4, 400, -140, top + 30, "frame", r=15, rep=(2, 0, 330, 0)),
           box("Base Crossbar", -450, -140, top - 4, -360, 140, top + 30, "frame"),
           box("Column", -440, -45, top + 30, -340, 45, 560, "frame", r=12),
           box("Inner Column", -428, -33, 560, -352, 33, 785, "alu", r=8),
           box("Top Bracket", -445, -70, 780, -250, 70, 800, "dark"),
           box("Top Edge", -455, -205, 795, 455, 205, 805, "mgrey", r=32),
           box("Top", -450, -200, 805, 450, 200, 825, "hpl", r=30),
           box("Spill Lip", -450, -205, 825, 450, -197, 837, "mgrey", rep=(2, 0, 402, 0)),
           box("Lift Lever", -320, -200, 783, -220, -150, 795, "black", r=6),
           box("Vanity Tray Lid", -150, -100, 825, 150, 100, 828, "mirror", lod="f")]
    return P_
f = "FMC_I_MedEq_Table_Overbed"
product(f, "900x400_HeightAdj", "Overbed table, 900 x 400 HPL top with raised spill lips, gas-spring height adjustment 750-1100, H-base on 50 mm castors",
        "IfcFurniture", overbed(),
        {"Top 900 x 400 mm": A("900x400"), "Height 750 to 1100 mm": A("750-1100"), "Base slides under bed, 120 mm high": A(120)},
        "Overbed table modelled as a generic product: H-base legs and crossbar on castors, column with telescopic inner column, top bracket, "
        "HPL top with edge band and spill lips, lift lever, vanity tray lid.")

def ot_table():
    P_ = [box("Base", -560, -270, 15, 360, 270, 160, "ss", r=70),
          box("Floor Lock Pad", -520, -230, 0, -440, -150, 15, "rubber", lod="f", rep=(2, 800, 0, 0)),
          box("Floor Lock Pad Back", -520, 150, 0, -440, 230, 15, "rubber", lod="f", rep=(2, 800, 0, 0)),
          box("Column", -220, -160, 160, 120, 160, 650, "ss", r=40),
          box("Column Upper", -200, -140, 650, 100, 140, 760, "mgrey", r=30),
          box("Top Frame", -770, -250, 760, 1000, 250, 800, "ss", r=10),
          box("Head Frame", -1000, -140, 760, -780, 140, 800, "ss", r=10),
          fbox("Head Pad", -1000, -150, 800, -780, 150, 870, "rubber", r=25),
          fbox("Back Pad", -770, -255, 800, -120, 255, 870, "rubber", r=25),
          fbox("Seat Pad", -110, -255, 800, 380, 255, 870, "rubber", r=25),
          fbox("Leg Pad Left", 390, -255, 800, 1000, -5, 870, "rubber", r=25),
          fbox("Leg Pad Right", 390, 5, 800, 1000, 255, 870, "rubber", r=25),
          fbox("Side Rail", -770, -268, 770, 1000, -258, 795, "ss", r=4, rep=(2, 0, 526, 0)),
          box("Rail Standoff", -700, -260, 775, -680, -250, 790, "ss", lod="f", rep=(6, 320, 0, 0)),
          box("Section Joint", -125, -262, 770, -110, 262, 800, "dark", lod="f", rep=(2, 510, 0, 0)),
          box("Armboard Clamp", -560, -290, 760, -480, -255, 810, "ss"),
          box("Armboard Frame", -570, -790, 790, -430, -290, 805, "ss", r=20),
          fbox("Armboard Pad", -580, -800, 805, -420, -290, 865, "rubber", r=25),
          cyl("Screen Post", "z", [-760, -275], 12, [780, 1350], "ss", rep=(2, 0, 550, 0)),
          cyl("Anaesthesia Screen Bar", "y", [-760, 1350], 12, [-275, 275], "ss"),
          box("Screen Clamp", -785, -290, 765, -735, -262, 805, "dark", rep=(2, 0, 552, 0)),
          fbox("Handset", 200, 262, 560, 270, 282, 730, "grey", r=18, lod="f"),
          fbox("Handset Keys", 210, 282, 590, 260, 284, 710, "white", r=6, lod="f"),
          fbox("Base Control Panel", -100, -273, 60, 150, -270, 130, "mgrey", r=8, lod="f")]
    return P_
f = "FMC_I_MedEq_Table_Operating"
product(f, "2000x550_Electric", "Electro-hydraulic operating table, 2000 x 550 top, 5 sections (head, back, seat, split legs), stainless column and base, accessory side rails, armboard, anaesthesia screen frame",
        "IfcMedicalDevice", ot_table(),
        {"Top 2000 x 550 mm": A("2000x550"), "Height 650 to 1050 mm": A("650-1050"), "Trendelenburg +/-30 deg, lateral tilt +/-20 deg": A("30/20"),
         "Power 1000 VA": A(1000, "typical electro-hydraulic OT table")},
        "OT table modelled as a generic product: stainless base with floor-lock pads, column with upper shroud, top frame with head, back, "
        "seat and split leg pads, accessory side rails with standoffs, section joints, armboard with clamp, anaesthesia screen frame, handset, "
        "base control panel. Tilt and rotation by angle parameters are a later step (record note).",
        E=1000, conn_part="Base", conn_side="bottom")

def anaesthesia():
    r = 62; top = ctop(r)
    P_ = castors4(-300, 300, -240, 260, r)
    P_ += [box("Base", -360, -300, top - 6, 360, 320, top + 60, "mgrey", r=30),
           box("Lower Cabinet", -340, -280, top + 60, 340, 300, 700, "white", r=20),
           fbox("Drawer", -320, -287, 560, 320, -280, 690, "mgrey", r=8, rep=(3, 0, 0, -140)),
           fbox("Drawer Handle", -150, -296, 655, 150, -287, 672, "grey", r=5, rep=(3, 0, 0, -140)),
           box("Worktop", -380, -340, 700, 380, 300, 730, "mgrey", r=30),
           fbox("Worktop Rail", -380, -350, 705, 380, -340, 725, "chrome", r=4),
           box("Tower", -300, -50, 730, 300, 300, 1350, "white", r=20),
           fbox("Flowmeter Panel", -120, -56, 950, 120, -50, 1250, "black", r=10),
           cyl("Flow Tube", "z", [-80, -60], 9, [985, 1225], "clear", rep=(3, 80, 0, 0)),
           cyl("Flow Knob O2", "y", [-80, 935], 14, [-78, -56], "white"),
           cyl("Flow Knob N2O", "y", [0, 935], 14, [-78, -56], "blue"),
           cyl("Flow Knob Air", "y", [80, 935], 14, [-78, -56], "black"),
           box("Backbar", -290, -70, 1220, 290, -50, 1250, "grey"),
           box("Vaporiser Sevo", 150, -130, 1010, 260, -50, 1220, "yellow", r=15),
           box("Vaporiser Des", -270, -130, 1010, -160, -50, 1220, "blue", r=15),
           cyl("Vaporiser Dial", "z", [205, -90], 38, [1220, 1245], "white", "f"),
           cyl("Vaporiser Dial Des", "z", [-215, -90], 38, [1220, 1245], "white", "f"),
           cyl("Absorber Canister", "z", [-440, -170], 70, [700, 930], "clear"),
           cyl("Absorber Cap", "z", [-440, -170], 74, [930, 950], "mgrey"),
           box("Absorber Bracket", -400, -200, 760, -340, -140, 800, "grey"),
           turn("Bellows Housing", "z", [-440, 70], [[0, 740], [80, 740], [80, 1000], [60, 1040], [0, 1050]], "clear"),
           cyl("Bellows Base", "z", [-440, 70], 85, [720, 745], "mgrey"),
           cyl("APL Valve", "z", [-440, -170], 22, [950, 990], "yellow", "f"),
           cyl("Circuit Port", "y", [-500, 820], 14, [-260, -200], "mgrey", "f", rep=(2, 60, 0, 0)),
           box("Top Shelf", -320, -70, 1350, 320, 310, 1370, "mgrey", r=15),
           cyl("Monitor Pole", "z", [0, 150], 25, [1370, 1440], "grey")]
    P_ += screen("Monitor", -260, 260, 160, 1440, 1780, depth=60, bez=18, body="dark", traces=True)
    P_ += [cyl("O2 Reserve Cylinder", "z", [-150, 370], 55, [top + 60, 900], "black"),
           cyl("O2 Cylinder Shoulder", "z", [-150, 370], 55, [900, 960], "white"),
           cyl("N2O Reserve Cylinder", "z", [150, 370], 55, [top + 60, 960], "blue"),
           box("Cylinder Yoke", -220, 300, 880, 220, 330, 920, "chrome", lod="f")]
    return P_
f = "FMC_I_MedEq_Machine_Anaesthesia"
product(f, "800x700_Workstation", "Anaesthesia workstation, 800 x 700, mobile cabinet with drawers, flowmeter bank, two vaporisers on backbar, absorber, bellows, monitor, reserve cylinders",
        "IfcMedicalDevice", anaesthesia(),
        {"Overall 800 x 700 x 1780 mm": A("800x700x1780"), "Gases O2, N2O, Air (pipeline + reserve cylinders)": A("O2/N2O/Air", "HTM 02-01"),
         "Power 1200 VA incl. monitor": A(1200)},
        "Anaesthesia machine modelled as a generic product: castors with brakes, base, cabinet with three drawers, worktop with rail, tower "
        "with flowmeter panel, flow tubes and O2/N2O/Air knobs, backbar with sevoflurane and desflurane vaporisers, absorber canister, bellows "
        "housing, APL valve, circuit ports, top shelf, monitor with traces, reserve cylinders with yoke.",
        E=1200, conn_part="Tower")

def ventilator():
    r = 25; top = ctop(r)
    P_ = castor("Castor X", -210, 0, r, rep=(2, 420, 0, 0), sign=-1) + castor("Castor Y", 0, -210, r, rep=(2, 0, 420, 0))
    P_ += [box("Base Leg X", -235, -25, top - 4, 235, 25, top + 26, "mgrey", r=10),
           box("Base Leg Y", -25, -235, top - 4, 25, 235, top + 26, "mgrey", r=10),
           box("Column", -40, -40, top + 26, 40, 40, 900, "mgrey", r=15),
           *basket("Basket", -150, -190, 600, 150, -45, 700), box("Basket Bracket", -30, -50, 640, 30, -40, 690, "grey"),
           box("Body", -200, -150, 900, 200, 180, 1250, "white", r=30),
           box("Screen Hinge", -60, -140, 1250, 60, -95, 1268, "grey"),
           box("Screen Unit", -200, -160, 1268, 200, -105, 1570, "mgrey", r=20),
           fbox("Display", -180, -162, 1290, 180, -160, 1550, "screen", r=6)]
    for k, m in enumerate(("yellow", "ledg", "ledb")):
        zz = 1500 - 70 * k
        P_ += [fbox(f"Waveform {k + 1}", -165, -163, zz, 60, -162, zz + 4, m, lod="f"),
               fbox(f"Value {k + 1}", 80, -163, zz - 12, 165, -162, zz + 20, m, lod="f")]
    P_ += [box("Alarm Light", -80, -150, 1570, 80, -115, 1585, "ledb"),
           turn("Main Knob", "y", [140, 1000], [[0, -152], [30, -152], [30, -180], [0, -180]], "grey"),
           cyl("Inspiratory Port", "y", [-130, 960], 17, [-185, -150], "mgrey", rep=(2, 90, 0, 0)),
           fbox("Expiratory Valve", -170, -160, 1050, -20, -150, 1150, "mgrey", r=20),
           box("Heater Base", 45, -80, 690, 170, 80, 775, "white", r=15),
           turn("Humidifier Chamber", "z", [107, 0], [[0, 775], [58, 775], [58, 870], [40, 895], [0, 900]], "clear"),
           cyl("Humidifier LED", "x", [-40, 740], 5, [170, 173], "ledg", "f"),
           box("Tube Arm Post", 200, -20, 1150, 230, 20, 1420, "mgrey"),
           box("Tube Arm", 200, -20, 1420, 460, 20, 1445, "mgrey", r=8),
           cyl("Tube Hook", "z", [450, 0], 8, [1360, 1420], "grey", "f"),
           box("Carry Handle", -160, 150, 1250, 160, 175, 1290, "grey", r=8),
           right("Fan Vent", rr(-100, 960, 120, 968, 3), 200, 202, "dark", lod="f", rep=(5, 0, 0, 25))]
    return P_
f = "FMC_I_MedEq_Ventilator_ICU"
product(f, "500x500_ICU", "ICU ventilator on mobile 4-leg stand, 500 x 500 base, touch screen, inspiratory/expiratory ports, heated humidifier, tube support arm",
        "IfcMedicalDevice", ventilator(),
        {"Stand 500 x 500 mm, height 1590 mm": A("500x500x1590"), "Display 15 in": A(15), "Power 300 VA": A(300),
         "Gas: O2 and Air at 4 bar from pendant": A("O2/Air 4 bar", "HTM 02-01")},
        "Ventilator modelled as a generic product: four-leg stand on castors, column with basket, body, tilting screen unit with display, "
        "waveforms and values, alarm light, main knob, ports, expiratory valve, heated humidifier with chamber, tube support arm and hook, "
        "carry handle, fan vents.",
        E=300, conn_part="Body")

def dialysis_machine():
    r = 50; top = ctop(r)
    P_ = castors4(-180, 180, -220, 220, r)
    P_ += [box("Base", -250, -300, top - 6, 250, 300, top + 60, "mgrey", r=30),
           box("Lower Body", -240, -260, top + 60, 240, 280, 900, "white", r=20),
           box("Jug Shelf", -235, -340, 340, 235, -260, 360, "mgrey"),
           box("Acid Concentrate Jug", -210, -330, 360, -60, -262, 640, "white", r=15),
           cyl("Acid Jug Cap", "z", [-135, -296], 22, [640, 670], "red"),
           cyl("Bicarbonate Cartridge", "z", [110, -296], 50, [380, 650], "white"),
           cyl("Cartridge Holder", "z", [110, -296], 34, [650, 690], "blue"),
           box("Upper Body", -240, -200, 900, 240, 280, 1250, "white", r=20),
           fbox("Pump Housing", -200, -206, 1070, -15, -200, 1235, "mgrey", r=15, rep=(2, 215, 0, 0)),
           turn("Pump Rotor", "y", [-108, 1152], [[0, -206], [62, -206], [62, -226], [0, -226]], "grey", rep=(2, 215, 0, 0)),
           box("Pump Rotor Arm", -168, -230, 1145, -48, -226, 1159, "white", lod="f", rep=(2, 215, 0, 0)),
           fbox("Heparin Pump", -200, -206, 935, 200, -200, 1050, "mgrey", r=10),
           cyl("Heparin Syringe", "x", [-215, 992], 15, [-150, 60], "clear"),
           cyl("Syringe Plunger", "x", [-215, 992], 5, [60, 140], "white"),
           cyl("Pressure Port", "y", [-180, 1060], 9, [-212, -200], "blue", "f", rep=(3, 30, 0, 0)),
           box("Monitor Mount", -60, 0, 1250, 60, 80, 1280, "grey")]
    P_ += screen("Monitor", -230, 230, 0, 1280, 1600, depth=80, bez=20, body="white")
    P_ += [box("Status Light", -120, -70, 1600, 120, -20, 1615, "ledg"),
           box("Dialyser Arm", 240, -160, 1000, 310, -110, 1030, "mgrey"),
           cyl("Dialyser", "z", [330, -135], 30, [880, 1180], "clear"),
           cyl("Dialyser Cap Arterial", "z", [330, -135], 33, [1180, 1210], "red"),
           cyl("Dialyser Cap Venous", "z", [330, -135], 33, [850, 880], "blue"),
           box("Dialyser Clamp", 300, -150, 1010, 360, -120, 1040, "grey", lod="f")]
    P_ += iv_pole("IV Pole", -200, 240, 1250, 1900, "ss")
    return P_
f = "FMC_I_MedEq_Machine_Dialysis"
product(f, "500x600_Haemodialysis", "Haemodialysis machine, 500 x 600 footprint, blood pumps, heparin syringe pump, concentrate jug and bicarbonate cartridge, dialyser holder, monitor, IV pole",
        "IfcMedicalDevice", dialysis_machine(),
        {"Footprint 500 x 600 mm, height 1600 mm": A("500x600x1600"), "Power 1800 VA": A(1800, "typical HD machine with heater"),
         "RO water inlet and drain via service point": A("RO + drain")},
        "Dialysis machine modelled as a generic product: castors with brakes, base, lower body, jug shelf with acid concentrate jug and "
        "bicarbonate cartridge, upper body with two blood pump housings and rotors, heparin syringe pump, pressure ports, tilting monitor, "
        "status light, dialyser on arm with arterial and venous caps, IV pole.",
        E=1800, conn_part="Base")

def monitor():
    r = 25; top = ctop(r)
    P_ = five_leg_base(280, r, top)
    P_ += [cyl("Pole", "z", [0, 0], 16, [top + 50, 1050], "alu"),
           box("Basket Bracket", -30, -40, 820, 30, 0, 860, "grey"),
           *basket("Basket", -140, -200, 800, 140, -40, 900),
           box("Mount Plate", -60, -30, 1050, 60, 30, 1100, "grey"),
           box("Monitor Body", -200, -60, 1100, 200, 60, 1400, "white", r=25),
           fbox("Display", -180, -62, 1118, 115, -60, 1382, "screen", r=4)]
    for k, m in enumerate(("ledg", "yellow", "ledb")):
        zz = 1330 - 60 * k
        P_ += [fbox(f"Waveform {k + 1}", -168, -63, zz, 0, -62, zz + 4, m, lod="f"),
               fbox(f"Value {k + 1}", 20, -63, zz - 12, 100, -62, zz + 20, m, lod="f")]
    P_ += [turn("Rotary Knob", "y", [160, 1160], [[0, -60], [22, -60], [22, -80], [0, -80]], "grey"),
           fbox("Key", 140, -62, 1250, 180, -60, 1275, "mgrey", r=4, lod="f", rep=(3, 0, 0, 40)),
           box("Alarm Light Bar", -80, -40, 1400, 80, 20, 1415, "ledb"),
           box("Handle Post", -130, -15, 1400, -110, 15, 1440, "grey", rep=(2, 240, 0, 0)),
           box("Handle", -130, -15, 1440, 130, 15, 1458, "grey", r=6),
           box("Cable Hook", 13, -35, 980, 25, -16, 1020, "grey", lod="f")]
    return P_
f = "FMC_I_MedEq_Monitor_Patient_Mobile"
product(f, "400x300_Rollstand", "Patient monitor 15 in on 5-leg roll stand with basket, 400 x 300 head, waveforms, rotary knob, alarm light bar, carry handle",
        "IfcMedicalDevice", monitor(),
        {"Monitor head 400 x 300 mm": A("400x300"), "Display 15 in": A(15), "Roll stand base 600 mm": A(600), "Power 100 VA": A(100)},
        "Monitor modelled as a generic product: five-leg roll stand with castors, pole, basket, mount plate, monitor body with display, "
        "waveforms, values, rotary knob, keys, alarm light bar, carry handle, cable hook.",
        E=100, conn_part="Monitor Body")

def aed():
    P_ = [fbox("Wall Bracket", -175, -20, 0, 175, 0, 300, "grey", r=15),
          box("Bracket Ledge", -160, -125, 0, 160, -20, 22, "grey", r=10),
          box("Bracket Side Hook", -165, -125, 22, -152, -20, 90, "grey", rep=(2, 317, 0, 0)),
          fbox("AED Body", -145, -115, 22, 145, -20, 270, "yellow", r=40),
          fbox("Face Panel", -128, -118, 40, 128, -115, 252, "dark", r=30),
          box("Handle Post", -70, -85, 270, -52, -55, 300, "dark", rep=(2, 122, 0, 0)),
          box("Handle Bar", -70, -85, 295, 70, -55, 312, "dark", r=6),
          fbox("Status Display", -100, -119, 175, 40, -118, 230, "screen", r=3),
          turn("Shock Button", "y", [65, 105], [[0, -118], [30, -118], [27, -127], [0, -129]], "red"),
          turn("On Off Button", "y", [-75, 105], [[0, -118], [20, -118], [18, -125], [0, -126]], "ledg"),
          fbox("Pads Pictogram", -30, -119, 60, 30, -118, 150, "white", r=6, lod="f"),
          cyl("Pads Socket", "y", [95, 222], 14, [-124, -118], "black", "f"),
          cyl("Ready LED", "y", [65, 222], 5, [-121, -118], "ledg", "f"),
          fbox("Speaker Slot", -115, -119, 58, -50, -118, 62, "black", lod="f", rep=(4, 0, 0, 10)),
          fbox("AED Sign", -150, -5, 340, 150, 0, 490, "sign", r=10),
          fbox("Sign Heart", -42, -6, 375, 42, -5, 455, "white", r=20, lod="f"),
          front("Sign Bolt", [[-6, 445], [12, 418], [0, 415], [10, 385], [-12, 412], [0, 415]], -7, -6, "sign", lod="f")]
    return P_
f = "FMC_I_MedEq_Defibrillator"
product(f, "350x300_AED", "Automated external defibrillator (AED) on wall bracket, 350 x 300, yellow body with dark face, shock and on/off buttons, carry handle, ISO 7010 AED sign above",
        "IfcMedicalDevice", aed(),
        {"Bracket 350 x 300 mm": A("350x300"), "AED 290 x 250 x 95 mm": A("290x250x95"), "Handle height 1200 mm AFL": A(1200, "Resuscitation Council UK AED siting"),
         "Battery powered, no mains": A("battery")},
        "AED modelled as a generic product: wall bracket with ledge and side hooks, body, face panel, carry handle, status display, shock and "
        "on/off buttons, pads pictogram and socket, ready LED, speaker slots, AED sign with heart and bolt. Wall mounted: back at y = 0.",
        tv={"Default Elevation": 900})

def ultrasound():
    r = 62; top = ctop(r)
    P_ = castors4(-210, 210, -270, 320, r)
    P_ += [box("Base", -270, -330, top - 6, 270, 380, top + 80, "white", r=80),
           box("Tower", -170, 150, top + 80, 170, 340, 800, "white", r=40),
           fbox("Printer Bay", -120, 145, 600, 120, 150, 700, "dark", r=8, lod="f"),
           right("Tower Vent", rr(170, 300, 320, 306, 3), 170, 172, "dark", lod="f", rep=(5, 0, 0, 22)),
           box("Console", -300, -300, 800, 300, 340, 880, "white", r=60),
           box("Control Panel", -250, -280, 880, 250, 50, 890, "mgrey", r=30),
           turn("Trackball", "z", [0, -170], [[0, 890], [27, 890], [26, 898], [20, 906], [10, 911], [0, 913]], "grey"),
           turn("Trackball Ring", "z", [0, -170], [[27, 889], [40, 889], [40, 894], [27, 894]], "dark", lod="f"),
           box("TGC Slider", -220, -40, 890, -212, 20, 896, "black", lod="f", rep=(8, 20, 0, 0)),
           cyl("Rotary Encoder", "z", [80, -60], 13, [890, 905], "grey", "f", rep=(4, 40, 0, 0)),
           box("Key Row", 80, -260, 890, 110, -230, 896, "white", lod="f", rep=(4, 40, 0, 0)),
           right("Touch Panel", incl(60, 890, 60, 240, 0, 25, 1), -200, 200, "mgrey"),
           right("Touch Display", incl(60, 890, 60, 225, 25, 27, 1), -180, 180, "screen", lod="f"),
           cyl("Monitor Post", "z", [0, 270], 25, [880, 1150], "grey"),
           box("Monitor Arm", -30, 230, 1130, 30, 290, 1160, "grey")]
    P_ += screen("Monitor", -270, 270, 260, 1150, 1500, depth=50, bez=15, body="dark")
    sector = [[0, 1450]] + [[160 * math.sin(math.radians(a)), 1450 - 240 * math.cos(math.radians(a))] for a in range(-35, 36, 10)]
    P_ += [front("Image Sector", sector, 207.5, 208.5, "grey", lod="f"),
           cyl("Probe Holder", "z", [325, -200], 30, [790, 880], "mgrey", rep=(3, 0, 90, 0)),
           cyl("Probe", "z", [325, -200], 18, [860, 960], "white", rep=(3, 0, 90, 0)),
           cyl("Gel Bottle", "z", [-330, -200], 28, [800, 950], "blue"),
           box("Gel Holder", -350, -230, 790, -300, -170, 840, "mgrey"),
           cyl("Front Handle", "x", [-335, 855], 15, [-220, 220], "grey"),
           box("Handle Standoff", -220, -335, 840, -200, -300, 870, "grey", rep=(2, 420, 0, 0))]
    return P_
f = "FMC_I_MedEq_Ultrasound_Cart"
product(f, "600x900_Cart", "Ultrasound scanner cart, 600 x 900, articulated 21.5 in monitor, touch panel, keyboard console with trackball, 3 probe holders, gel holder, printer bay",
        "IfcMedicalDevice", ultrasound(),
        {"Footprint 600 x 900 mm, height 1500 mm": A("600x900x1500"), "Monitor 21.5 in": A(21.5), "Power 700 VA": A(700)},
        "Ultrasound cart modelled as a generic product: castors with brakes, base, tower with printer bay and vents, console with control "
        "panel, trackball, TGC sliders, encoders and keys, tilted touch panel, monitor on post and arm with image sector, probe holders and "
        "probes, gel bottle, front handle.",
        E=700, conn_part="Base")

def xray_mobile():
    P_ = [cyl("Rear Wheel", "y", [-450, 150], 150, [-350, -300], "rubber", rep=(2, 0, 650, 0)),
          cyl("Rear Hub", "y", [-450, 150], 70, [-356, -300], "mgrey", rep=(2, 0, 656, 0))]
    P_ += castor("Front Castor", 330, -220, 50, rep=(2, 0, 440, 0))
    P_ += [box("Chassis", -650, -300, 110, 450, 300, 700, "white", r=60),
           box("Bumper Strip", -660, -310, 110, 460, 310, 150, "rubber", r=65, lod="f"),
           box("Top Cover", -600, -280, 700, 300, 280, 760, "mgrey", r=80),
           fbox("Detector Slot", -460, -305, 250, -40, -300, 640, "dark", r=12),
           fbox("Detector", -420, -318, 420, -80, -302, 740, "black", r=10),
           box("Column", 300, -90, 110, 440, 90, 1600, "white", r=40),
           box("Inner Column", 315, -75, 1600, 425, 75, 1950, "mgrey", r=30),
           box("Arm Carriage", 280, -110, 1400, 460, 110, 1560, "mgrey", r=20),
           box("Arm", -350, -70, 1450, 300, 70, 1540, "white", r=30),
           box("Arm Inner", -460, -55, 1460, -350, 55, 1530, "mgrey"),
           box("Tube Yoke", -570, -60, 1470, -450, 60, 1500, "mgrey"),
           turn("Tube Housing", "y", [-520, 1360], [[0, -200], [80, -200], [110, -170], [110, 170], [80, 200], [0, 200]], "white"),
           box("Collimator", -610, -110, 1100, -430, 110, 1250, "mgrey", r=20),
           box("Collimator Window", -590, -90, 1090, -450, 90, 1100, "clear"),
           cyl("Collimator Knob", "y", [-560, 1180], 15, [-130, -110], "black", rep=(2, 80, 0, 0)),
           fbox("Collimator Display", -600, -112, 1200, -470, -110, 1240, "screen", lod="f"),
           box("Console", -660, -250, 760, -500, 250, 1100, "white", r=30),
           box("Touch Screen", -640, -200, 1100, -520, 200, 1110, "screen", r=10),
           cyl("Push Handle", "y", [-715, 1000], 20, [-280, 280], "grey"),
           cyl("Push Handle Standoff", "x", [-250, 1000], 14, [-715, -660], "grey", rep=(2, 0, 500, 0)),
           box("Handswitch", -560, 255, 800, -520, 285, 920, "grey", r=10, lod="f"),
           box("Handswitch Holder", -570, 250, 790, -510, 262, 860, "dark", lod="f")]
    return P_
f = "FMC_I_MedEq_Xray_Mobile"
product(f, "1300x700_Mobile", "Mobile digital X-ray unit, 1300 x 700 parked, battery chassis, telescopic column and arm, tube head with collimator, wireless detector slot, touch console, push handle",
        "IfcMedicalDevice", xray_mobile(),
        {"Parked 1300 x 700 x 1950 mm": A("1300x700x1950"), "Generator 32 kW (battery)": A(32, "typical mobile DR"), "Charging 1500 VA": A(1500, "13 A socket")},
        "Mobile X-ray modelled as a generic product: rear wheels with hubs, front castors, chassis with bumper and top cover, detector slot "
        "and detector, column and inner column, arm carriage, telescopic arm, yoke, tube housing, collimator with window, knobs and display, "
        "rear console with touch screen, push handle, handswitch. Shown parked.",
        E=1500, conn_part="Chassis")

def xray_room():
    P_ = [box("Ceiling Rail", -2200, -1250, 2790, 2200, -1150, 2840, "alu", rep=(2, 0, 2400, 0)),
          box("Bridge", -300, -1250, 2730, -100, 1250, 2790, "alu"),
          box("Carriage", -350, -250, 2650, -50, 250, 2730, "white", r=20),
          box("Telescope Outer", -280, -100, 2100, -120, 100, 2650, "white", r=10),
          box("Telescope Inner", -265, -85, 1700, -135, 85, 2100, "mgrey", r=8),
          box("Tube Yoke", -260, -90, 1530, -140, 90, 1700, "mgrey"),
          turn("Tube Housing", "y", [-200, 1400], [[0, -230], [90, -230], [130, -190], [130, 190], [90, 230], [0, 230]], "white"),
          box("Collimator", -320, -150, 1060, -80, 150, 1270, "mgrey", r=20),
          box("Collimator Window", -300, -130, 1050, -100, 130, 1060, "clear"),
          box("Control Handle Unit", -330, -310, 1300, -70, -240, 1500, "white", r=20),
          fbox("Control Display", -300, -312, 1380, -100, -310, 1480, "screen", r=4),
          cyl("Tube Handle", "x", [-330, 1290], 15, [-340, -60], "grey"),
          box("Table Floor Plate", -900, -320, 0, 300, 320, 60, "mgrey", r=30),
          box("Table Pedestal", -700, -230, 60, 100, 230, 650, "white", r=40),
          box("Table Carrier", -760, -260, 650, 160, 260, 700, "mgrey"),
          box("Bucky Tray", -420, -340, 640, 80, 340, 695, "mgrey", r=10),
          cyl("Bucky Handle", "y", [-170, 667], 12, [-360, -340], "black", "f"),
          box("Table Top", -1200, -400, 700, 1000, 400, 740, "black", r=30),
          box("Table Pad", -1150, -380, 740, 950, 380, 770, "mattress", r=30),
          box("Foot Switch", -500, -650, 0, -380, -560, 50, "grey", r=10, lod="f"),
          box("Wall Stand Base", 1850, -300, 0, 2150, 300, 40, "mgrey", r=20),
          box("Wall Stand Column", 1960, -150, 40, 2110, 150, 2300, "white", r=20),
          box("Wall Stand Carriage", 1940, -200, 1050, 1990, 200, 1700, "mgrey"),
          box("Wall Bucky", 1780, -300, 1100, 1940, 300, 1650, "white", r=20),
          right("Wall Bucky Face", rr(-280, 1120, 280, 1630, 10), 1774, 1780, "dark", lod="f"),
          cyl("Wall Stand Handgrip", "z", [1860, -330], 14, [1150, 1450], "grey", rep=(2, 0, 660, 0)),
          box("Handgrip Bracket", 1840, -340, 1430, 1880, -300, 1450, "grey", rep=(2, 0, 640, 0))]
    return P_
f = "FMC_I_MedEq_Xray_Fixed_Room"
product(f, "RoomSet_CeilingTube", "General radiography room set: ceiling-suspended tube on rails with telescope, collimator and control handle, floating-top table with bucky, vertical wall stand",
        "IfcMedicalDevice", xray_room(),
        {"Ceiling rails 4400 mm at 2800 mm AFL": A("4400@2800", "typical rail set, ceiling height to suit"),
         "Table top 2200 x 800 mm": A("2200x800"), "Generator 50 kW, 415 V 3-phase": A(50, "typical DR room"),
         "Shielding by architecture (lead-lined walls)": A("by A", "record note")},
        "X-ray room modelled as a generic product: ceiling rails, bridge, carriage, telescopic column, yoke, tube housing, collimator with "
        "window, control handle with display, table floor plate, pedestal, carrier, bucky tray, floating top and pad, foot switch, wall stand "
        "with base, column, carriage, bucky and handgrips. Ceiling at 2800 assumed.",
        E=80000, voltage=415, elv=("Data", "Data"), conn_part="Table Pedestal", elv_part="Wall Stand Column")

def ct():
    gz = 1050
    P_ = [box("Gantry Plinth", -800, -420, 0, 800, 420, 260, "white", r=60),
          box("Gantry Side", -1000, -440, 0, -680, 440, 1500, "white", r=80, rep=(2, 1680, 0, 0)),
          turn("Gantry Ring", "y", [0, gz], [[350, -420], [385, -450], [860, -450], [900, -410], [900, 410], [860, 450], [385, 450], [350, 420]], "white"),
          turn("Bore Liner", "y", [0, gz], [[349, -421], [356, -421], [356, 421], [349, 421]], "mgrey"),
          turn("Bore LED Ring", "y", [0, gz], [[388, -452], [405, -452], [405, -450], [388, -450]], "ledb", lod="f"),
          fbox("Gantry Display", -150, -455, 1580, 150, -450, 1720, "screen", r=8),
          fbox("Gantry Control Panel", -880, -446, 900, -720, -440, 1150, "mgrey", r=10, rep=(2, 1600, 0, 0)),
          cyl("Gantry Control Key", "y", [-800, 1080], 12, [-450, -446], "white", "f", rep=(3, 0, 0, -60)),
          box("Table Floor Plate", -300, -2500, 0, 300, -800, 60, "mgrey", r=30),
          box("Table Pedestal", -220, -2300, 60, 220, -1000, 650, "white", r=50),
          box("Table Carrier", -260, -2450, 650, 260, -700, 820, "white", r=40),
          box("Cradle", -230, -2500, 820, 230, 200, 860, "black", r=30),
          box("Patient Pad", -210, -2480, 860, 210, 150, 900, "mattress", r=30),
          box("Head Holder", -150, 150, 860, 150, 260, 960, "grey", r=40, lod="f"),
          box("Table Control Panel", -270, -1000, 700, -262, -820, 790, "mgrey", lod="f"),
          box("Foot Pedal", -360, -1600, 0, -260, -1450, 50, "grey", r=10, lod="f", rep=(2, 620, 0, 0))]
    return P_
f = "FMC_I_MedEq_CT_Scanner"
product(f, "700Bore_64Slice", "CT scanner, 64-slice class, 700 mm bore gantry 2000 x 880 x 1720 with patient table 2500 long (vendor envelope)",
        "IfcMedicalDevice", ct(),
        {"Bore 700 mm": A(700), "Gantry 2000 x 880 mm": A("2000x880"), "Table travel 2000 mm": A(2000),
         "Supply 415 V 3-phase, 100 kVA": A(100, "typical 64-slice CT, vendor to confirm")},
        "CT modelled as a generic product inside the vendor envelope: plinth, side housings, gantry ring with bore liner and LED ring, display "
        "and control panels, patient table with floor plate, pedestal, carrier, cradle, pad, head holder, control panel and foot pedals. "
        "Service and shielding by MEP and A.",
        E=100000, voltage=415, elv=("Data", "Data"), conn_part="Gantry Plinth")

def mri():
    gz = 1100
    P_ = [box("Magnet Plinth", -900, -800, 0, 900, 800, 380, "white", r=100),
          turn("Magnet Cover", "y", [0, gz], [[300, -800], [1000, -800], [1080, -720], [1080, 720], [1000, 800], [300, 800]], "white"),
          turn("Front Flare", "y", [0, gz], [[300, -850], [420, -850], [620, -800], [300, -800]], "mgrey"),
          turn("Rear Flare", "y", [0, gz], [[300, 800], [620, 800], [420, 850], [300, 850]], "mgrey"),
          turn("Bore Liner", "y", [0, gz], [[298, -851], [304, -851], [304, 851], [298, 851]], "mgrey"),
          turn("Bore LED Ring", "y", [0, gz], [[425, -852], [445, -852], [445, -850], [425, -850]], "ledb", lod="f"),
          fbox("Front Control Panel", -760, -806, 950, -560, -800, 1250, "mgrey", r=12, rep=(2, 1320, 0, 0)),
          fbox("Front Panel Display", -740, -808, 1150, -580, -806, 1235, "screen", r=4, lod="f", rep=(2, 1320, 0, 0)),
          box("Cold Head Housing", -220, 250, 2100, 220, 700, 2450, "mgrey", r=60),
          cyl("Cold Head", "z", [0, 480], 90, [2450, 2560], "grey"),
          box("Table Floor Plate", -320, -2700, 0, 320, -900, 60, "mgrey", r=30),
          box("Table Pedestal", -230, -2500, 60, 230, -1050, 700, "white", r=50),
          box("Table Carrier", -260, -2650, 700, 260, -850, 860, "white", r=40),
          box("Cradle", -200, -2700, 860, 200, 300, 900, "white", r=30),
          box("Patient Pad", -190, -2680, 900, 190, 200, 935, "mattress", r=30),
          turn("Head Coil", "y", [0, 1030], [[115, -900], [150, -900], [150, -650], [115, -650]], "white"),
          box("Head Coil Base", -150, -900, 935, 150, -650, 970, "white", lod="f"),
          box("Table Handle", -270, -2700, 760, -262, -2450, 800, "grey", lod="f")]
    return P_
f = "FMC_I_MedEq_MRI_Scanner"
product(f, "1.5T_Closed", "MRI scanner, 1.5 T closed bore (60 cm), magnet 2160 x 1700 x 2560 with detachable patient table (vendor envelope), 5 gauss line zone",
        "IfcMedicalDevice", mri(),
        {"Field 1.5 T": A(1.5), "Bore 600 mm": A(600), "Magnet 2160 x 1700 mm": A("2160x1700"),
         "5 gauss line 2.5 x 4.0 m from isocentre": A("2.5x4.0", "typical shielded 1.5 T, vendor to confirm"),
         "Supply 415 V 3-phase, 90 kVA": A(90, "typical incl. gradient amplifiers")},
        "MRI modelled as a generic product inside the vendor envelope: plinth, magnet cover with front and rear flares, bore liner, LED ring, "
        "front control panels with displays, cold head housing, table with floor plate, pedestal, carrier, cradle, pad, head coil and handle. "
        "5 gauss line on Clearance Radiation (non-plotting). Chilled water via the service point.",
        E=90000, voltage=415, elv=("Data", "Data"), conn_part="Magnet Plinth",
        clear=[{"n": "5 Gauss Line", "shape": "prism", "pts": [[round(a, 1), round(b, 1)] for a, b in ellipse(0, 0, 2500, 4000)], "z": [0, 10], "sub": "Clearance Radiation"}])

def mammo():
    P_ = [box("Base Plate", -360, -300, 0, 360, 360, 40, "mgrey", r=40),
          box("Column", -150, 100, 40, 150, 330, 2050, "white", r=40),
          box("Carriage", -180, 30, 900, 180, 100, 1500, "mgrey", r=20),
          turn("Rotation Hub", "y", [0, 1200], [[0, 30], [150, 30], [150, 0], [0, 0]], "grey"),
          box("C Arm", -130, -120, 600, 130, 0, 2000, "white", r=40),
          box("Tube Head", -180, -500, 1760, 180, -60, 1960, "white", r=60),
          box("Collimator", -120, -470, 1660, 120, -260, 1760, "mgrey", r=15),
          fbox("Face Shield", -160, -515, 1350, 160, -505, 1720, "clear", r=20),
          box("Face Shield Bracket", -170, -505, 1700, -150, -460, 1760, "mgrey", rep=(2, 320, 0, 0)),
          box("Paddle Bracket", -70, -140, 1160, 70, -120, 1520, "mgrey"),
          box("Compression Paddle", -130, -470, 1150, 130, -140, 1170, "clear", r=15),
          box("Paddle Wall", -130, -150, 1170, 130, -140, 1240, "clear"),
          box("Breast Support", -150, -480, 950, 150, -120, 1020, "black", r=30),
          box("Detector Housing", -160, -470, 880, 160, -120, 950, "white", r=30),
          cyl("Handgrip", "z", [-215, -250], 15, [1000, 1250], "grey", rep=(2, 430, 0, 0)),
          box("Handgrip Arm", -215, -265, 1235, -130, -235, 1255, "grey", rep=(2, 345, 0, 0)),
          fbox("Arm Control Panel", -110, -124, 750, 110, -120, 860, "mgrey", r=10),
          cyl("Arm Control Key", "y", [-70, 805], 12, [-128, -124], "white", "f", rep=(4, 45, 0, 0)),
          fbox("Arm Display", -100, -122, 1300, 100, -120, 1380, "screen", r=4, lod="f"),
          box("Foot Pedal Unit", -350, -820, 0, -150, -620, 60, "mgrey", r=20, rep=(2, 500, 0, 0)),
          box("Foot Pedal", -330, -800, 60, -170, -650, 75, "grey", r=10, lod="f", rep=(2, 500, 0, 0))]
    return P_
f = "FMC_I_MedEq_Mammography_Unit"
product(f, "1200x900_Digital", "Digital mammography unit, floor-standing column with rotating C-arm, tube head, face shield, compression paddle, detector, handgrips, twin foot pedals",
        "IfcMedicalDevice", mammo(),
        {"Footprint 1200 x 900 mm incl. pedals": A("1200x900"), "Detector 24 x 30 cm": A("24x30"), "Supply 415 V 3-phase, 15 kVA": A(15),
         "Acquisition workstation and shielded screen separate": A("separate")},
        "Mammography unit modelled as a generic product: base plate, column, carriage, rotation hub, C-arm, tube head, collimator, face shield, "
        "paddle bracket and compression paddle, breast support and detector housing, handgrips, arm control panel and display, foot pedals.",
        E=15000, voltage=415, conn_part="Column")

# ================================================================== write
RX = re.compile(r'^[A-Za-z0-9.x×-]+_[A-Za-z0-9-]+$')
def check(prod):
    errs = []
    for k in ('family', 'desc', 'ifc', 'types', 'materials', 'parts', 'reference', 'values', 'about'):
        if k not in prod: errs.append('missing ' + k)
    for t in prod['types']:
        if not RX.match(t['name']): errs.append('type ' + t['name'])
    for v in prod['materials'].values():
        if v not in KIT: errs.append('material ' + v)
    ex = fp.expand(prod['parts']); names = [p['n'] for p in ex]
    if len(ex) > 70: errs.append(f'{len(ex)} parts')
    if len(set(names)) != len(names): errs.append('dup names ' + str({n for n in names if names.count(n) > 1}))
    if not 2 <= len(prod['values']) <= 5: errs.append('values count')
    for c in prod.get('connectors', []):
        if c['part'] not in {p['n'] for p in prod['parts']}: errs.append('connector part ' + c['part'])
    return errs, len(ex)
def build(prod):
    fam = prod['family']
    json.dump(prod, open(os.path.join(HERE, fam + '.product.json'), 'w'), indent=1, ensure_ascii=False)
    r = fp.compile_product(prod)
    json.dump(r, open(os.path.join(HERE, fam + '.recipe.json'), 'w'), indent=1, ensure_ascii=False)
    fp.render(prod, os.path.join(HERE, fam + '.preview.png'))
    fp.render_type_image(prod, os.path.join(HERE, fam + '.png'), size=600)
    return fam, len(r['ops'])

if __name__ == '__main__':
    assert len(P) == len(RECS) and {p['family'] for p in P} == set(RECS), set(RECS) - {p['family'] for p in P}
    bad = False
    for prod in P:
        e, n = check(prod)
        if e: bad = True; print('!!', prod['family'], e)
    json.dump(MATERIALS_NEEDED, open(os.path.join(HERE, 'batches', 'I1_interiors.materials_needed.json'), 'w'), indent=1)
    if bad and '--force' not in sys.argv: sys.exit(1)
    flt = [a for a in sys.argv[1:] if not a.startswith('--')]
    todo = [p for p in P if not flt or any(s in p['family'] for s in flt)]
    with Pool(min(8, os.cpu_count() or 2)) as pool:
        for fam, nops in pool.imap_unordered(build, todo): print(fam, nops, 'ops')
