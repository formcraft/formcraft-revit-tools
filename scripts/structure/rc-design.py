# RC reinforcement design and bar bending schedules from a Robot run (docs/ROBOT_RC_FRAME_PROCESS.md).
#   python scripts/structure/rc-design.py   (openpyxl: not -I) <work dir> <robot runs dir> <run> <out dir>
# Simplified EC2 (fck 25 used in the checks, C30/37 specified as the kit's detailing.concrete_grade asks), B500 (H bars),
# covers and bar rules from the kit (detailing.*, rebar.*), BS 8666 shape codes 00 (straight), 11 (L), 51 (closed link).
# Writes <out>/<stamp>_BBS.xlsx (summary + one sheet per element type) and <out>/<stamp>_design.json for the report.
# PRELIMINARY - NOT FOR CONSTRUCTION until an engineer of record checks and signs.
import json, math, sys, os, datetime
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill

W, D, RUN, OUT = sys.argv[1], sys.argv[2].rstrip("/\\") + "/", sys.argv[3], sys.argv[4]
plan = json.load(open(W + "/plan.json", encoding="utf-8")); built = json.load(open(W + "/build.out.json"))
facts = json.load(open(W + "/facts.json")); sizes = json.load(open(W + "/sizes.json")) if os.path.exists(W + "/sizes.json") else {}
rho = json.load(open(W + "/rho.json")) if os.path.exists(W + "/rho.json") else {}
cfg = json.load(open(W + "/config.json")) if os.path.exists(W + "/config.json") else {}
walls_sw = json.load(open(W + "/shear_walls.json")) if os.path.exists(W + "/shear_walls.json") else []
run = json.load(open(D + RUN + ".json")); res = {b["n"]: b for b in json.load(open(D + RUN + "_results.json"))["bars"]}
EL = {l["name"]: l["elevation_mm"] for l in facts["levels"]}; PAD_TOP = cfg.get("pad_top_mm", -250)
FCK, FY = 25, 500; FYD = 0.87 * FY
COVER = {"beam": 40, "column": 40, "slab": 25, "pad": 50, "wall": 30}          # kit detailing.cover_nominal (+delta 10)
MASS = {6: .222, 8: .395, 10: .616, 12: .888, 16: 1.579, 20: 2.466, 25: 3.854, 32: 6.313}
AREA = {d: math.pi * d * d / 4 for d in MASS}
LAP = 48; ANCH = 36                                                               # kit detailing.lap_anchorage_C30 (column lap, anchorage)
up25 = lambda x: int(math.ceil(x / 25.0) * 25)

def link_len(a, b, d):   # shape 51 closed link: 2(A+B) + 20d (BS 8666)
    return up25(2 * (a + b) + 20 * d)

def pick_bars(As, width, cover, link=8, dmin=12, dmax=25, nmin=2):
    best = None
    for d in [x for x in (12, 16, 20, 25) if dmin <= x <= dmax]:
        n = max(nmin, math.ceil(As / AREA[d]))
        clear = (width - 2 * cover - 2 * link - n * d) / max(1, n - 1)
        if clear < max(d, 25): continue
        if best is None or n * AREA[d] < best[0] * AREA[best[1]] - 1: best = (n, d)
    return best or (max(nmin, math.ceil(As / AREA[25])), 25)

def pitch_bars(As_per_m, h, dmin=10, smax=None, choices=(10, 12, 16)):
    smax = smax or min(3 * h, 400)
    for d in [x for x in choices if x >= dmin]:
        s = min(smax, int(1000 * AREA[d] / max(As_per_m, 1) // 25 * 25))
        if s >= 100: return d, s
    return choices[-1], 100

rows = {"Columns": [], "Beams": [], "Ground beams": [], "Pads": [], "Slabs": [], "Shear walls": []}
design = {"run": RUN, "columns": [], "beams": [], "ground_beams": [], "pads": [], "slabs": [], "walls": [], "joists": []}
mark = {"C": 0, "B": 0, "G": 0, "F": 0, "S": 0, "W": 0}
def bar(sheet, member, prefix, d, n_each, n_mbr, length, shape, dims, note=""):
    mark[prefix] += 1
    tot = n_each * n_mbr; L = up25(length)
    rows[sheet].append([member, f"{prefix}{mark[prefix]:02d}", f"H{d}", n_mbr, n_each, tot, L, shape, *dims, round(tot * L / 1000, 2), round(tot * L / 1000 * MASS[d], 1), note])

# ---- ids: plan ops -> build batch ids
pairs = list(zip(plan["ops"], built["ops"][2:]))
if os.path.exists(W + "/extra.json") and os.path.exists(W + "/extra.out.json"):   # the architect's given members
    pairs += list(zip(json.load(open(W + "/extra.json")), json.load(open(W + "/extra.out.json"))["ops"]))
col_geo, beam_geo, pad_geo = {}, {}, {}
for o, r in pairs:
    ids = r.get("created_ids", [])
    if o["op"] == "column":
        z0 = PAD_TOP if o["level"].startswith("S Pad") else EL[o["level"]]
        for p, i in zip(o["points_mm"], ids): col_geo[i] = (p, z0, EL[o["top_level"]], o["size_mm"])
    if o["op"] == "beam": beam_geo[ids[0]] = (o["start_mm"], o["end_mm"], o["level"], o["size_mm"])
    if o["op"] == "isolated_foundation":
        for p, i in zip(o["points_mm"], ids): pad_geo[i] = (p, o["size_mm"])
bars_by_id = {b["id"]: b for b in run["bars"]}
force = lambda i: res[bars_by_id[i]["n"]] if i in bars_by_id else None

# ---- beams (frame) from Robot; ground beams by hand (wall line load, not in the frame model)
wall_w = []
for w in facts["walls"]:
    if w.get("thickness_mm", 0) >= 100 and w["base_level"] in ("Site ±0.00", "GF +0.45"):
        t = w["thickness_mm"] / 1000; wall_w.append((w, 22 * t * w["height_mm"] / 1000))
S72 = [(160, 32), (200, 25), (240, 16), (280, 12), (320, 10), (360, 8), (400, 6), (450, 5)]   # EC2 tables 7.2N / 7.3N, wk 0.3 mm
S73 = [(160, 300), (200, 250), (240, 200), (280, 150), (320, 100), (360, 50)]
look = lambda tab, x: next((v for k, v in tab if x <= k), tab[-1][1])
def serviceable(L, b, dd, n, d, As_req):   # EC2 7.4.2 span/depth (K 1.3, continuous; fck 30) and 7.3.3 crack control
    r0, rq = math.sqrt(30) * 1e-3, max(As_req, 1) / (b * dd); As = n * AREA[d]
    lim = 1.3 * (11 + 1.5 * math.sqrt(30) * r0 / rq + (3.2 * math.sqrt(30) * (r0 / rq - 1) ** 1.5 if rq < r0 else 0)) * min(1.5, As / max(As_req, 1))
    sig = FYD * 0.69 * min(1, As_req / As); sp = (b - 2 * (COVER["beam"] + 8) - d) / max(1, n - 1)
    return L / dd <= lim and (d <= look(S72, sig) or sp <= look(S73, sig))
def beam_design(i, s, e, b, h, M, V, sheet, prefix, label, frame=False):
    L = math.dist(s[:2], e[:2])
    while True:
        dd = h - COVER["beam"] - 8 - 10
        K = M * 1e6 / (b * dd * dd * FCK); z = min(0.95 * dd, dd * (0.5 + math.sqrt(max(0.0, 0.25 - K / 1.134))))
        As_req = max(M * 1e6 / (FYD * z), 0.0015 * b * dd); As = As_req
        n, d = pick_bars(As, b, COVER["beam"])
        while not serviceable(L, b, dd, n, d, As_req) and As < 1.5 * As_req: As *= 1.1; n, d = pick_bars(As, b, COVER["beam"])
        if serviceable(L, b, dd, n, d, As_req) or h >= 750: break
        h += 50; sizes[str(i)] = [b, h]   # deeper beam: the analysis is run again
    nt, dt = pick_bars(max(As, 0.0015 * b * dd), b, COVER["beam"])
    name = f"{label}{i} {b}x{h} L{L / 1000:.2f}"
    bar(sheet, name, prefix, d, n, 1, L + 24 * d, "00", [L + 24 * d, "", "", ""], "bottom, into supports")
    bar(sheet, name, prefix, dt, nt, 1, L + 2 * ANCH * dt, "00", [L + 2 * ANCH * dt, "", "", ""], "top, anchored past supports")
    VRdc = 0.12 * (1 + min(2, math.sqrt(200 / dd))) * (100 * n * AREA[d] / b / dd * FCK) ** (1 / 3) * b * dd / 1000
    s_req = 0.75 * dd if V <= VRdc else 2 * AREA[8] * FYD * 0.9 * dd * 2.5 / (V * 1000)
    s = int(min(0.75 * dd, 300, s_req, 2 * (b + h) / 8 if frame else 999, b if frame else 999) // 25 * 25)   # frame beams: closed links for compatibility torsion (EC2 6.3.1(2), 9.2.3)
    A, B = b - 2 * COVER["beam"] + 16, h - 2 * COVER["beam"] + 16
    nl = math.ceil((L - 300) / s) + 1
    bar(sheet, name, prefix, 8, nl, 1, link_len(A, B, 8), "51", [A, B, "", ""], f"H8 links @ {s}")
    return {"id": i, "span_m": round(L / 1000, 2), "size": f"{b}x{h}", "bottom": f"{n}H{d}", "top": f"{nt}H{dt}", "links": f"H8 @ {s}", "M_kNm": round(M, 1), "V_kN": round(V, 1)}
for i, (s, e, lvl, sz0) in beam_geo.items():
    b, h = sizes.get(str(i), sz0)
    if EL[lvl] < 500:   # ground beam: walls standing on it, continuous over pads
        mid = ((s[0] + e[0]) / 2, (s[1] + e[1]) / 2); L = math.dist(s[:2], e[:2])
        w = max([kn for (wl, kn) in wall_w if min(math.dist(mid, wl["start_mm"][:2]), math.dist(mid, wl["end_mm"][:2])) < max(L, wl["length_mm"])
                 and abs((wl["end_mm"][0] - wl["start_mm"][0]) * (mid[1] - wl["start_mm"][1]) - (wl["end_mm"][1] - wl["start_mm"][1]) * (mid[0] - wl["start_mm"][0])) / max(1, wl["length_mm"]) < 300] or [0])
        wu = 1.35 * (w + 25 * b * h / 1e6); M = wu * (L / 1000) ** 2 / 10; V = wu * L / 2000
        while M > 0.156 * FCK * b * (h - 58) ** 2 / 1e6 and h < 600: h += 50
        if [b, h] != sizes.get(str(i), sz0): sizes[str(i)] = [b, h]
        design["ground_beams"].append(beam_design(i, s, e, b, h, M, V, "Ground beams", "G", "GB") | {"wall_kN_m": round(w, 1)})
    else:
        f = force(i) or {"med_knm": 0, "ved_kn": 0}
        design["beams"].append(beam_design(i, s, e, b, h, f["med_knm"], f.get("ved_kn", 0), "Beams", "B", "B", frame=True) | {"level": lvl})

# ---- strong column / weak beam (EC8 4.4.2.3(4)): at every joint with a column above and below, the columns' moment
# capacity at their axial load is at least 1.3 x the beams' (their real bars). More column steel first (up to 3%,
# owner 28 Oct: least concrete), then the next size; a size change needs the analysis run again (printed).
COLS = [230, 250, 300, 350, 400, 450, 500, 600]
def col_mrd(a, As, N):   # symmetric column: steel couple + concrete, kNm
    Nc = 0.567 * FCK * a * a / 1000; N = min(max(N or 0, 0), Nc)
    return As / 2 * FYD * (a - 2 * (COVER["column"] + 8 + 8)) / 1e6 + N * a / 2000 * (1 - N / Nc)
def beam_mrd(bd, top):
    b, h = map(int, bd["size"].split("x")); n, d = map(int, (bd["top"] if top else bd["bottom"]).split("H")); return n * AREA[d] * FYD * 0.9 * (h - COVER["beam"] - 8 - d / 2) / 1e6
bdes = {b["id"]: b for b in design["beams"]}; resized = []; design["scwb"] = []
at_col = {}
for i, (p, z0, z1, sz0) in col_geo.items(): at_col.setdefault(tuple(map(round, p)), []).append((i, z0, z1))
for pt, cs in at_col.items():
    for zj in sorted({z1 for _, _, z1 in cs}):
        pair = [c for c in cs if c[2] == zj or c[1] == zj]
        if len(pair) < 2: continue   # top storey or a single column: exempt
        for ax in (0, 1):
            fr = [bdes[i] for i, (bs, be, lvl, _) in beam_geo.items() if i in bdes and abs(EL[lvl] - zj) < 600 and abs(bs[1 - ax] - be[1 - ax]) < 50
                  and min(math.dist(bs[:2], pt), math.dist(be[:2], pt)) < 50]
            if not fr: continue
            need = 1.3 * (sum(beam_mrd(b, k == 0) for k, b in enumerate(fr)) if len(fr) > 1 else max(beam_mrd(fr[0], True), beam_mrd(fr[0], False)))
            for _ in range(30):
                have = sum(col_mrd(sizes.get(str(c[0]), col_geo[c[0]][3])[0], max(rho.get(str(c[0]), 0.01), 0.002) * sizes.get(str(c[0]), col_geo[c[0]][3])[0] ** 2, (force(c[0]) or {}).get("ned_kn")) for c in pair)
                if have >= need: break
                for c in pair:
                    a = sizes.get(str(c[0]), col_geo[c[0]][3])[0]; r = rho.get(str(c[0]), 0.01)
                    if r < 0.03: rho[str(c[0])] = min(0.03, r + 0.0025)
                    else:
                        na = COLS[COLS.index(a) + 1] if a in COLS else 300; sizes[str(c[0])] = [na, na]; rho[str(c[0])] = 0.01; resized.append(c[0])
            design["scwb"].append({"at": list(pt), "z": zj, "dir": "xy"[ax], "MRc": round(have), "MRb_x1.3": round(need), "ok": have >= need})
if resized: print("strong column / weak beam: columns resized", sorted(set(resized)), "- run the analysis again")
json.dump(rho, open(W + "/rho_design.json", "w"))
# ---- columns (after the beams: strong column / weak beam sets their steel or size)
for i, (p, z0, z1, sz0) in sorted(col_geo.items(), key=lambda x: (x[1][1], x[1][0])):
    a = sizes.get(str(i), sz0)[0]; r = rho.get(str(i), 0.01); f = force(i) or {}
    As = max(r * a * a, 0.002 * a * a, 4 * AREA[16]); n, d = None, None
    for dd in (16, 20, 25):
        nn = max(4, math.ceil(As / AREA[dd] / 2) * 2)
        if (a - 2 * COVER["column"] - 2 * 8 - (nn // 4 + 1) * dd) >= 0 and nn <= 12: n, d = nn, dd; break
    n, d = n or 8, d or 25
    H = z1 - z0; ground = z0 == PAD_TOP
    name = f"C{i} @({p[0]:.0f},{p[1]:.0f}) {a}x{a} {'GF' if ground else 'upper'}"
    if ground:   # starters bent into the pad, lap above the floor
        pad_h = 450
        bar("Columns", name, "C", d, n, 1, H + LAP * d + pad_h - COVER["pad"], "11", [H + LAP * d + pad_h - COVER["pad"], max(450, 12 * d), "", ""], "starter leg into the pad")
    else:
        bar("Columns", name, "C", d, n, 1, H - COVER["column"] + 12 * d, "11", [H - COVER["column"], 12 * d, "", ""], "bent into the roof beam")
    ld = max(8, d // 4); s_end, s_mid = 100, min(20 * d, a, 300) // 25 * 25
    n_links = math.ceil(600 / s_end) * 2 + math.ceil(max(0, H - 1200) / s_mid) + 1
    A = a - 2 * COVER["column"] + 2 * ld
    bar("Columns", name, "C", ld, n_links, 1, link_len(A, A, ld), "51", [A, A, "", ""], f"links {s_end} c/c 600 mm each end (seismic), {s_mid} c/c between")
    design["columns"].append({"id": i, "at": p, "size": a, "bars": f"{n}H{d}", "rho_pct": round(100 * n * AREA[d] / a / a, 2), "links": f"H{ld} @ {s_end}/{s_mid}", "N_kN": f.get("ned_kn"), "M_kNm": f.get("med_knm")})

# ---- pads: the column's largest axial force (ULS ~ 1.4 x service), 150 kPa assumed (kit foundations.bearing_assumed_kpa)
qa = cfg.get("bearing_kpa", 150)
gcol = {tuple(map(round, v[0])): i for i, v in col_geo.items() if v[1] == PAD_TOP}
for i, (p, sz0) in pad_geo.items():
    ci = gcol.get(tuple(map(round, p))); f = force(ci) if ci else None
    N = (f["ned_kn"] if f else 300) / 1.4; a = sizes.get(str(ci), [230])[0] if ci else 230
    B = max(sz0[0], 900, int(math.ceil(math.sqrt(N * 1.1 / qa) * 10)) * 100); h = max(sz0[2], 300, int(math.ceil(0.3 * B / 50)) * 50)
    q = 1.4 * N / (B / 1000) ** 2; c = (B - a) / 2000; M = q * c * c / 2          # kNm per m
    dd = h - COVER["pad"] - 16; As = max(M * 1e6 / (FYD * 0.9 * dd), 0.0013 * 1000 * dd)
    d, s = pitch_bars(As, h, dmin=16, smax=300, choices=(16, 20))
    nb = (B - 2 * 75) // s + 1; L = B - 2 * COVER["pad"]
    name = f"F{i} @({p[0]:.0f},{p[1]:.0f}) {B}x{B}x{h}"
    bar("Pads", name, "F", d, nb * 2, 1, L, "00", [L, "", "", ""], f"bottom mesh both ways @ {s}")
    design["pads"].append({"id": i, "at": p, "size": f"{B}x{B}x{h}", "N_service_kN": round(N), "pressure_kPa": round(N * 1.1 / (B / 1000) ** 2), "bars": f"H{d} @ {s} B1+B2"})

# ---- slabs (RC; the attic is timber when config.attic says so)
attic = cfg.get("attic", {"level": "Roof +7.25"}).get("level")
for sl in plan["plan"]["slabs"]:
    if sl["level"] == attic: continue
    t = sl["thickness_mm"]; lp = sl["loops_mm"][0]; xs = [q[0] for q in lp]; ys = [q[1] for q in lp]
    dx, dy = max(xs) - min(xs), max(ys) - min(ys)
    on_ground = sl["on_ground"]
    if on_ground:
        d, s = 10, 200; note = "ground-bearing slab: anti-crack mesh, top"
    else:
        lx = max(c["short_span_mm"] for c in plan["slabs"] if c["level"] == sl["level"]) if any(c["level"] == sl["level"] for c in plan["slabs"]) else 3700
        n = 1.35 * (25 * t / 1000 + 1.5) + 1.5 * 2.0; M = 0.063 * n * (lx / 1000) ** 2
        dd = t - COVER["slab"] - 6; As = max(M * 1e6 / (FYD * 0.95 * dd), 0.0013 * 1000 * dd)
        d, s = pitch_bars(As, t); note = f"bottom both ways and top over beams, lx {lx} mm, M {M:.1f} kNm/m"
    nx = int(dy // s) + 1; ny = int(dx // s) + 1; layers = 1 if on_ground else 2
    name = f"Slab {sl['id']} {sl['level']} {t} mm ({dx / 1000:.1f} x {dy / 1000:.1f} m bbox)"
    for nn, L, ax in ((nx, dx, "X"), (ny, dy, "Y")):
        Ls = L - 2 * COVER["slab"]; pieces = math.ceil(Ls / 11500); Lp = (Ls + (pieces - 1) * 42 * d) / pieces
        bar("Slabs", name, "S", d, nn * pieces * layers, 1, Lp, "00", [Lp, "", "", ""], f"{ax} bars @ {s}, {layers} layer(s); {note}")
    design["slabs"].append({"id": sl["id"], "level": sl["level"], "t": t, "bars": f"H{d} @ {s}", "layers": layers})

# ---- shear walls (200 mm): EC2 9.6 minimum, both faces; horizontal steel for the brace shear if needed
for k, w in enumerate(walls_sw):
    L = math.dist(w["from"][:2], w["to"][:2]); H = w["top_z"] - w["bottom_z"]; t = 200
    Asv = max(0.002 * t * 1000, 0) / 2; dv, sv = pitch_bars(Asv, t, dmin=10, smax=300, choices=(10, 12))
    Ash = max(0.25 * 2 * AREA[dv] * 1000 / sv, 0.001 * t * 1000) / 2; dh, sh = pitch_bars(Ash, t, dmin=8, smax=300, choices=(8, 10, 12))
    nv = int(L // sv) + 1; nh = int(H // sh) + 1
    name = f"W{k + 1} {w['dir']} @({w['from'][0]:.0f},{w['from'][1]:.0f})-({w['to'][0]:.0f},{w['to'][1]:.0f}) z {w['bottom_z']}..{w['top_z']}"
    bar("Shear walls", name, "W", dv, nv * 2, 1, H + LAP * dv, "00", [H + LAP * dv, "", "", ""], f"vertical EF @ {sv}, lapped at floors")
    bar("Shear walls", name, "W", dh, nh * 2, 1, L + 2 * ANCH * dh, "00", [L + 2 * ANCH * dh, "", "", ""], f"horizontal EF @ {sh}, anchored into the end columns")
    design["walls"].append({"wall": k + 1, "dir": w["dir"], "length_m": round(L / 1000, 2), "z": [w["bottom_z"], w["top_z"]], "vertical": f"H{dv} @ {sv} EF", "horizontal": f"H{dh} @ {sh} EF", "openings_ratio": w.get("openings_ratio")})

# ---- attic timber joists (C24 or a durable hardwood of at least C24 strength): bays between the roof-level beams
att = cfg.get("attic")
if att:
    rbeams = [v for v in beam_geo.values() if v[2] == att["level"]]
    spans = sorted({round(math.dist(v[0][:2], v[1][:2]) / 100) / 10 for v in rbeams})
    gk, qk, sp = att.get("g_kn_m2", 0.6), att.get("q_kn_m2", 2.5), 0.4
    for L in spans:
        for (bw, hh) in ((50, 175), (50, 200), (50, 225), (75, 225), (75, 250), (75, 300)):
            Wm, I = bw * hh * hh / 6, bw * hh ** 3 / 12
            Mu = (1.35 * gk + 1.5 * qk) * sp * L * L / 8; fmd = 0.8 * 24 / 1.3
            defl = 5 * (gk + qk) * sp * (L * 1000) ** 4 / (384 * 11000 * I) * 1.6     # creep allowance
            if Mu * 1e6 / Wm <= fmd and defl <= L * 1000 / 250:
                design["joists"].append({"span_m": L, "joist": f"{bw}x{hh} @ 400", "stress_ratio": round(Mu * 1e6 / Wm / fmd, 2), "deflection_mm": round(defl, 1)}); break

# ---- workbook
os.makedirs(OUT, exist_ok=True)
stamp = datetime.datetime.now().strftime("%Y%m%d")
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Summary"
hdr = ["Member", "Bar mark", "Type & size", "No. of mbrs", "No. in each", "Total no.", "Length (mm)", "Shape code", "A", "B", "C", "D", "Total length (m)", "Mass (kg)", "Note"]
tot = {}; tot_el = {}
for sheet, rr in rows.items():
    s = wb.create_sheet(sheet); s.append(hdr)
    for c in s[1]: c.font = Font(bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor="2F4F6F")
    for r in rr:
        s.append(r); tot[r[2]] = tot.get(r[2], 0) + r[13]; tot_el[sheet] = tot_el.get(sheet, 0) + r[13]
    s.freeze_panes = "A2"; s.column_dimensions["A"].width = 46; s.column_dimensions["O"].width = 60
ws.append(["Ogala main house - bar bending schedules (BS 8666) - PRELIMINARY, NOT FOR CONSTRUCTION"]); ws["A1"].font = Font(bold=True, size=13)
ws.append([f"Robot run {RUN}; B500 (H) bars; covers beams/columns 40, slabs 25, foundations 50, walls 30 mm; laps 48d columns, anchorage 36d"])
ws.append([]); ws.append(["Element", "Mass (kg)"])
for k2, v in tot_el.items(): ws.append([k2, round(v)])
ws.append(["Total", round(sum(tot_el.values()))]); ws.append([]); ws.append(["Bar size", "Mass (kg)", "12 m bars (approx)"])
for k2 in sorted(tot, key=lambda x: int(x[1:])): ws.append([k2, round(tot[k2]), math.ceil(tot[k2] / MASS[int(k2[1:])] / 12)])
ws.column_dimensions["A"].width = 30
f_x = os.path.join(OUT, f"{stamp}_OGL_BBS_preliminary.xlsx"); wb.save(f_x)
design["steel_kg"] = {"by_element": {k2: round(v) for k2, v in tot_el.items()}, "by_size": {k2: round(v) for k2, v in tot.items()}, "total": round(sum(tot_el.values()))}
design["sizes_after_ground_beams"] = sizes
json.dump(design, open(os.path.join(OUT, f"{stamp}_OGL_rc_design.json"), "w"), indent=1)
json.dump(sizes, open(W + "/sizes.json", "w"))
print(f_x, design["steel_kg"])
