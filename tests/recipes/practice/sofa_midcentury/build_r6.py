"""Sofa practice, round 6 (25 Oct 2026): round 5 plus the fixes from comparing its render with the photo (panel front
curve moved forward so the cushions sit inside the shell; cushions narrowed clear of the posts and arm curls; arm curl moved
behind the back cushions). Round 5 notes follow.
Sofa practice, round 5 (25 Oct 2026): the first round on the `subd` part (PR #259), live in Rhino 8.
Round 4 stalled at 6/10 because flat outlines can't make a hull. Round 5 builds the soft parts from SubD cages:
- side panels: a bent-plywood plate cage (flat top just under the arm, a big front curve sweeping down into the rail,
  a rounded back-bottom corner, the lower edge and front tucked inward like a hull);
- arms: a board swept along a plan path (round front, back end curling in behind the back cushion), on two posts;
- front rail: a thin strip swept round both front corners;
- seat cushions: lattice boxes, soft edges, flat fronts;
- back cushions: lattice boxes whose front seams are pulled back, so the 3 x 2 biscuits puff up (top row 1.4x taller).
The cage builders (plate, sweep, lattice) are the reusable part: they belong in the bridge as ops once this proves out.
Axes in mm: x along, -y front, z up. Run: python build_r5.py -> r5_parts.json"""
import json, math

FRAME, UPH = "FMC_Timber_Mahogany", "FMC_Fabric_Upholstery_WipeClean_Grey"   # stand-ins until walnut / green velvet are in the kit


def P(name, op, sub, mat, **spec):
    return {"name": name, "op": op, "subcategory": sub, "material": mat, "visibility": "fine", **spec}


# ---- cage builders ------------------------------------------------------------------------------------------------
def check_cage(V, F, name):
    """Every edge used once each way (closed, consistent); positive volume (faces point out), else flip."""
    seen = {}
    for f in F:
        for a, b in zip(f, f[1:] + f[:1]):
            if (a, b) in seen: raise ValueError(f"{name}: edge {a}-{b} used twice the same way")
            seen[(a, b)] = 1
    open_ = [e for e in seen if (e[1], e[0]) not in seen]
    if open_: raise ValueError(f"{name}: {len(open_)} open edges, e.g. {open_[0]}")
    vol = 0.0
    for f in F:
        p0 = V[f[0]]
        for i in range(1, len(f) - 1):
            a, b = V[f[i]], V[f[i + 1]]
            vol += (p0[0] * (a[1] * b[2] - a[2] * b[1]) - p0[1] * (a[0] * b[2] - a[2] * b[0]) + p0[2] * (a[0] * b[1] - a[1] * b[0])) / 6
    if vol < 0: F = [f[::-1] for f in F]
    return F


def ring8(c, n, zb, zt, w, e):
    """A section ring: width w across n (plan normal) at centre c, from zb to zt, corners chamfered by e (edge loops that
    keep SubD from shrinking a thin section into a lens)."""
    pt = lambda s, z: [round(c[0] + n[0] * s, 1), round(c[1] + n[1] * s, 1), round(z, 1)]
    h = w / 2
    return [pt(-h, zb + e), pt(-h + e, zb), pt(h - e, zb), pt(h, zb + e), pt(h, zt - e), pt(h - e, zt), pt(-h + e, zt), pt(-h, zt - e)]


def sweep(stations, w, e):
    """stations: [(x, y, zb, zt)] along a plan path -> closed cage (8-vertex rings, quad-capped ends)."""
    V, F, R = [], [], []
    for i, (x, y, zb, zt) in enumerate(stations):
        a = stations[max(i - 1, 0)]; b = stations[min(i + 1, len(stations) - 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]; L = math.hypot(tx, ty)
        n = (-ty / L, tx / L)
        R.append(list(range(len(V), len(V) + 8))); V += ring8((x, y), n, zb, zt, w, e)
    for r0, r1 in zip(R, R[1:]):
        for k in range(8):
            F.append([r0[k], r0[(k + 1) % 8], r1[(k + 1) % 8], r1[k]])
    for r, flip in ((R[0], True), (R[-1], False)):
        for q in ([0, 1, 6, 7], [1, 2, 5, 6], [2, 3, 4, 5]):
            f = [r[i] for i in q]; F.append(f[::-1] if flip else f)
    return V, F


def lattice(xs, ys, zs, warp):
    """The surface of a box lattice (node lines at xs, ys, zs) -> closed quad cage; warp(i, j, k, p) moves a node."""
    idx, V = {}, []
    def v(i, j, k):
        if (i, j, k) not in idx:
            idx[(i, j, k)] = len(V); V.append(warp(i, j, k, [xs[i], ys[j], zs[k]]))
        return idx[(i, j, k)]
    F, I, J, K = [], len(xs) - 1, len(ys) - 1, len(zs) - 1
    for i in range(I):
        for k in range(K):
            F.append([v(i, 0, k), v(i + 1, 0, k), v(i + 1, 0, k + 1), v(i, 0, k + 1)])
            F.append([v(i, J, k), v(i, J, k + 1), v(i + 1, J, k + 1), v(i + 1, J, k)])
        for j in range(J):
            F.append([v(i, j, 0), v(i, j + 1, 0), v(i + 1, j + 1, 0), v(i + 1, j, 0)])
            F.append([v(i, j, K), v(i + 1, j, K), v(i + 1, j + 1, K), v(i, j + 1, K)])
    for j in range(J):
        for k in range(K):
            F.append([v(0, j, k), v(0, j, k + 1), v(0, j + 1, k + 1), v(0, j + 1, k)])
            F.append([v(I, j, k), v(I, j + 1, k), v(I, j + 1, k + 1), v(I, j, k + 1)])
    return [[round(c, 1) for c in p] for p in V], F


def plate(cols, rows, surf, t):
    """A bent plate: surf(u, v) -> outer point and inward normal (plan); u over cols, v over rows; t thick."""
    V, F, O, In = [], [], {}, {}
    for j, u in enumerate(cols):
        for k, w in enumerate(rows):
            p, n = surf(u, w)
            O[j, k] = len(V); V.append([round(c, 1) for c in p])
            In[j, k] = len(V); V.append([round(p[0] + n[0] * t, 1), round(p[1] + n[1] * t, 1), round(p[2], 1)])
    J, K = len(cols) - 1, len(rows) - 1
    for j in range(J):
        for k in range(K):
            F.append([O[j, k], O[j + 1, k], O[j + 1, k + 1], O[j, k + 1]])
            F.append([In[j, k], In[j, k + 1], In[j + 1, k + 1], In[j + 1, k]])
    for j in range(J):   # rims: bottom and top edges
        F.append([O[j, 0], In[j, 0], In[j + 1, 0], O[j + 1, 0]])
        F.append([O[j, K], O[j + 1, K], In[j + 1, K], In[j, K]])
    for k in range(K):   # rims: back and front edges
        F.append([O[0, k], O[0, k + 1], In[0, k + 1], In[0, k]])
        F.append([O[J, k], In[J, k], In[J, k + 1], O[J, k + 1]])
    return V, F


def subd(name, sub, mat, V, F, **extra):
    return P(name, "subd", sub, mat, vertices=V, faces=check_cage(V, F, name), **extra)


# ---- the sofa -----------------------------------------------------------------------------------------------------
parts = []
X_OUT, T = 1050, 20                 # outer face of the side panels; plywood thickness
Y_BACK, Y_FRONT = 420, -365         # panel extent
Z_BOT, Z_TOP = 238, 470             # panel bottom (on the legs) and flat top, 55 under the arm
ARM_Z0, ARM_Z1 = 525, 561           # arm board (verified arm height 561)


def panel_edges(y):
    """Side profile (y, z): flat top that sweeps down and forward in one big curve; rounded back-bottom corner."""
    y0 = -165                                 # the flat top runs to here, then a quarter ellipse (200 x 224) drops to the rail
    if y >= y0: zt = Z_TOP
    else: zt = Z_BOT + 8 + (Z_TOP - Z_BOT - 8) * math.sqrt(max(0.0, 1 - ((y0 - y) / (y0 - Y_FRONT)) ** 2))
    R = 150                                   # back-bottom corner radius
    zb = Z_BOT if y <= Y_BACK - R else Z_BOT + R - math.sqrt(max(0.0, R * R - (y - (Y_BACK - R)) ** 2))
    return zb, zt


def side_surf(sg):
    def f(u, v):
        y = Y_BACK + (Y_FRONT - Y_BACK) * u
        zb, zt = panel_edges(y)
        z = zb + (zt - zb) * v
        tuck = 60 * max(0.0, (-180 - y) / (-180 - Y_FRONT)) ** 2 + 22 * (1 - v) ** 2   # front turns in to the rail; lower edge tucks in (hull)
        x = sg * (X_OUT - tuck)
        return [x, y, z], (-sg, 0)
    return f


cols = [0, 0.02, 0.1, 0.22, 0.36, 0.5, 0.6, 0.68, 0.75, 0.81, 0.86, 0.9, 0.935, 0.965, 0.985]
rows = [0, 0.06, 0.35, 0.7, 0.94, 1]
for s, sg in (("L", -1), ("R", 1)):
    V, F = plate(cols, rows, side_surf(sg), T)
    parts.append(subd(f"Side_{s}", "Frame", FRAME, V, F))

# front rail: tucked ends behind the seat deck, round corners into the panels' lower front
corner = lambda sg, angs: [(sg * (905 + 85 * math.cos(math.radians(a))), -260 - 85 * math.sin(math.radians(a))) for a in angs]
rail = [(-990, -200), (-990, -260)] + corner(-1, (20, 45, 70)) + [(-905, -350), (-300, -352), (300, -352), (905, -350)] + corner(1, (70, 45, 20)) + [(990, -260), (990, -200)]
V, F = sweep([(x, y, Z_BOT - 6, Z_BOT + 40) for x, y in rail], T, 4)
parts.append(subd("Rail_Front", "Frame", FRAME, V, F))

# arms: a 110 x 36 board, round front 30 past the front post, back end curling in behind the back cushion
for s, sg in (("L", -1), ("R", 1)):
    path = [(-1000, -395), (-1000, -380), (-1000, -300), (-1000, -100), (-1000, 150), (-1000, 380)]   # curl sits behind the leaning back cushion
    path += [(-870 - 130 * math.cos(math.radians(a)), 400 + 130 * math.sin(math.radians(a))) for a in (20, 45, 70)] + [(-870, 530), (-820, 532)]
    st = [(x if sg < 0 else -x, y, ARM_Z0, ARM_Z1) for x, y in path]
    V, F = sweep(st, 110, 9)
    parts.append(subd(f"Arm_{s}", "Frame", FRAME, V, F))
    for k, y in (("F", -300), ("M", 150)):
        zt = panel_edges(y)[1] - 10
        parts.append(P(f"Post_{s}{k}", "box_rounded", "Frame", FRAME, center=[sg * 1010, y, (zt + ARM_Z0 + 5) / 2], size=[26, 30, ARM_Z0 + 5 - zt], radius=5))

# legs: tapered rounds splayed out, under the panel's front and back
for k, (top, bot) in {"FL": ((-1030, -300, Z_BOT + 10), (-1066, -360, 0)), "FR": ((1030, -300, Z_BOT + 10), (1066, -360, 0)),
                      "BL": ((-1030, 250, Z_BOT + 10), (-1066, 320, 0)), "BR": ((1030, 250, Z_BOT + 10), (1066, 320, 0))}.items():
    parts.append(P(f"Leg_{k}", "loft", "Legs", FRAME, sections=[{"origin": list(top), "profile": {"circle": 19}}, {"origin": list(bot), "profile": {"circle": 10}}]))

# seat deck (hidden) and back panel (hidden behind the cushions)
parts.append(P("Seat_Deck", "box_rounded", "Upholstery", UPH, center=[0, 30, 290], size=[2050, 720, 60], radius=8))
parts.append(P("Back_Panel", "box_rounded", "Upholstery", UPH, center=[0, 448, 540], size=[1880, 28, 400], radius=8))

# seat cushions: soft lattice boxes, flat fronts, crown 8 mm
W, GAP = 653, 6                     # 3 x 653 + 2 x 6 = 1971: clear of the front posts (inner face 997)
for i, xc in enumerate((-(W + GAP), 0, W + GAP), 1):
    xs = [xc - W / 2 + d for d in (0, 22, W * .3, W * .7, W - 22, W)]
    ys = [-385 + d for d in (0, 22, 340, 640, 662)]
    zs = [318 + d for d in (0, 22, 130, 162)]
    crown = lambda i_, j_, k_, p: [p[0], p[1], p[2] + (8 if k_ == 3 and 0 < i_ < 5 and 0 < j_ < 4 else 0)]
    V, F = lattice(xs, ys, zs, crown)
    parts.append(subd(f"SeatCushion_{i}", "Cushions", UPH, V, F))

# back cushions: 3 x 2 biscuits; front seams pulled back 32 mm, biscuit centres pushed 10 mm forward; leaning back 14 deg
H, D, W = 360, 170, 622            # back cushions fit between the arms (inner edge 945)
ux = [0, 24, W / 6, W / 3 - 12, W / 3 + 12, W / 2, 2 * W / 3 - 12, 2 * W / 3 + 12, 5 * W / 6, W - 24, W]
uz = [0, 24, 75, 138, 162, 255, 336, H]          # seam at 150 (doubled edge loops keep it sharp): rows 150 / 210 (top 1.4x)
seam_i, mid_i, seam_k, mid_k = {3, 4, 6, 7}, {2, 5, 8}, {3, 4}, {2, 5}
for i, xc in enumerate((-(W + GAP), 0, W + GAP), 1):
    y0, z0 = 262, 478
    xs = [xc - W / 2 + d for d in ux]; ys = [y0 + d for d in (0, 48, D - 26, D)]; zs = [z0 + d for d in uz]
    def tuft(i_, j_, k_, p):
        if j_ != 0: return p
        dy = 0
        edge = i_ in (0, len(ux) - 1) or k_ in (0, len(uz) - 1)
        if i_ in seam_i or k_ in seam_k: dy = 14 if edge else 38
        elif i_ in mid_i and k_ in mid_k: dy = -12
        return [p[0], p[1] + dy, p[2]]
    V, F = lattice(xs, ys, zs, tuft)
    parts.append(subd(f"BackCushion_{i}", "Cushions", UPH, V, F, rotate={"deg": -14, "axis": [1, 0, 0], "center": [xc, y0 + D / 2, z0]}))

json.dump(parts, open("r6_parts.json", "w"), separators=(",", ":"))
print(len(parts), "parts,", len(json.dumps(parts, separators=(",", ":"))) // 1024, "KB")
