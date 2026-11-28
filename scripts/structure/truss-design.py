# Timber roof trusses: geometry from the roofs in facts.json, pin-jointed analysis (stiffness method), member sizes by the
# Uganda code's allowable stresses (kit timber.strength_classes_sch16, roofs.timber_truss_limits, roofs.clay_tiles),
# and the drawing ops: roof framing plan (structural plan at the bearing level + truss lines) and truss elevations
# (drafting views), each on its sheet.
#   python scripts/structure/truss-design.py   (numpy: not -I) <work dir> <out dir>    -> <work dir>/trusses.json, truss_ops.json
# PRELIMINARY - NOT FOR CONSTRUCTION. Hip/jack trusses and connector design by the truss fabricator to these loads.
import json, math, sys, os
import numpy as np
W, OUT = sys.argv[1], sys.argv[2]
facts = json.load(open(W + "/facts.json")); cfg = json.load(open(W + "/config.json")) if os.path.exists(W + "/config.json") else {}
EX = set(cfg.get("exclude_levels", ["BQ GF +0.17", "BQ FF +3.15"])); BEAR = cfg.get("roof_bearing_level", "Roof +7.25")
EL = {l["name"]: l["elevation_mm"] for l in facts["levels"]}
SP = cfg.get("truss_spacing_mm", 600)                       # kit roofs.timber_truss_limits: rafters for tiles 0.6 m
GRADE = cfg.get("timber_grade", "SG8")                       # Eucalyptus grandis (Kalitunsi), Mukusu, Ugandan mahogany
ALLOW = {"SG8": (8.0, 8148), "SG12": (12.0, 9710)}[GRADE]   # allowable bending (MPa), E mean
f_b, E = ALLOW; f_t = 0.6 * f_b; f_c = f_b                 # tension 0.6 MOR (kit timber.test_derivation); compression ~ flexure
G_SLOPE, Q_PLAN = 0.65, cfg.get("roof_imposed_kn_m2", 0.5)   # tiles + 50x35 battens + underlay on slope; kit loads.imposed_roof_inaccessible
SIZES = [(50, 100), (50, 125), (50, 150), (75, 150), (50, 175), (75, 175), (75, 200), (75, 225)]

def fink(L, h):
    """Fink (W) truss: nodes and members; bottom chord in 3, top chord in 4 panels."""
    n = {0: (0, 0), 1: (L / 3, 0), 2: (2 * L / 3, 0), 3: (L, 0), 4: (L / 4, h / 2), 5: (L / 2, h), 6: (3 * L / 4, h / 2)}
    m = [(0, 4, "top"), (4, 5, "top"), (5, 6, "top"), (6, 3, "top"), (0, 1, "bottom"), (1, 2, "bottom"), (2, 3, "bottom"),
         (1, 4, "web"), (1, 5, "web"), (2, 5, "web"), (2, 6, "web")]
    return n, m

def solve(nodes, mem, loads):
    ids = sorted(nodes); ix = {k: i for i, k in enumerate(ids)}; K = np.zeros((2 * len(ids),) * 2)
    for a, b, _ in mem:
        (x1, y1), (x2, y2) = nodes[a], nodes[b]; L = math.hypot(x2 - x1, y2 - y1); c, s = (x2 - x1) / L, (y2 - y1) / L
        k = np.outer([-c, -s, c, s], [-c, -s, c, s]) / L; dofs = [2 * ix[a], 2 * ix[a] + 1, 2 * ix[b], 2 * ix[b] + 1]
        K[np.ix_(dofs, dofs)] += k
    F = np.zeros(2 * len(ids))
    for k2, (fx, fy) in loads.items(): F[2 * ix[k2]] += fx; F[2 * ix[k2] + 1] += fy
    fixed = [2 * ix[0], 2 * ix[0] + 1, 2 * ix[3] + 1]; free = [i for i in range(len(F)) if i not in fixed]
    u = np.zeros(len(F)); u[free] = np.linalg.solve(K[np.ix_(free, free)], F[free])
    out = []
    for a, b, kind in mem:
        (x1, y1), (x2, y2) = nodes[a], nodes[b]; L = math.hypot(x2 - x1, y2 - y1); c, s = (x2 - x1) / L, (y2 - y1) / L
        du = (u[2 * ix[b]] - u[2 * ix[a]]) * c + (u[2 * ix[b] + 1] - u[2 * ix[a] + 1]) * s
        out.append((a, b, kind, L, du / L))          # axial "strain x EA": tension +, scaled by EA = 1 below
    return out

def design_truss(name, span, rise, overhang):
    nodes, mem = fink(span, rise); slope = math.hypot(span / 2, rise) / (span / 2)
    w_top = (G_SLOPE * slope + Q_PLAN) * SP / 1000            # kN per m of plan length on the top chord
    loads = {}
    panel = span / 4
    for k2, share in ((0, 0.5 + overhang / panel), (4, 1), (5, 1), (6, 1), (3, 0.5 + overhang / panel)): loads[k2] = (0, -w_top * panel / 1000 * share)
    for k2 in (1, 2): loads[k2] = (0, -0.25 * SP / 1000 * span / 3000)   # services / light ceiling on the bottom chord
    forces = solve(nodes, mem, loads)
    rows, sizes = [], {}
    for a, b, kind, L, N in forces:
        for bw, hh in SIZES:
            A = bw * hh
            # in plane: the member length about its depth; out of plane: battens hold the top chord (~340 mm gauge),
            # other members brace only at their ends (add longitudinal binders to long compression webs)
            l_out = 340 if kind == "top" else L
            lam = max(L / (hh / math.sqrt(12)), l_out / (bw / math.sqrt(12)))
            if N >= 0: ok = N * 1000 / A <= f_t; util = N * 1000 / A / f_t
            else:
                kc = 1 / (1 + (lam / 100) ** 2) if lam > 20 else 1.0   # simple column reduction; braced at the panel points
                fc = f_c * kc; util = -N * 1000 / A / fc
                if kind == "top":   # top chord also bends between panel points under the battens
                    Mb = w_top * (panel / 1000) ** 2 / 8          # kNm, panel span in m
                    util += Mb * 1e6 / (bw * hh * hh / 6) / f_b
                ok = util <= 1 and lam <= 180
            if kind == "top" and hh < 125: continue
            if ok: rows.append({"member": f"{a}-{b}", "kind": kind, "length_mm": round(L), "N_kN": round(N, 2), "size": f"{bw}x{hh}", "util": round(util, 2)}); break
        else: rows.append({"member": f"{a}-{b}", "kind": kind, "length_mm": round(L), "N_kN": round(N, 2), "size": "75x225+", "util": None})
    # one size per member kind (fabrication)
    for kind in ("top", "bottom", "web"):
        pick = max((r["size"] for r in rows if r["kind"] == kind), key=lambda s2: tuple(map(int, s2.replace("+", "").split("x")))[0] * tuple(map(int, s2.replace("+", "").split("x")))[1])
        sizes[kind] = pick
    R = sum(-l[1] for l in loads.values()) / 2
    return {"name": name, "span_mm": round(span), "rise_mm": round(rise), "pitch_deg": round(math.degrees(math.atan(2 * rise / span)), 1), "overhang_mm": round(overhang),
            "spacing_mm": SP, "grade": GRADE, "loads": {"g_slope_kn_m2": G_SLOPE, "q_plan_kn_m2": Q_PLAN}, "reaction_kn": round(R, 2), "members": rows, "sizes": sizes, "nodes": nodes, "mem": mem}

# ---- the roofs of the building (left out: excluded levels, small lean-to roofs -> rafters)
trusses, ops = [], []
for r in facts["roofs"]:
    if r["level"] in EX or r["area_m2"] < 40 or not r.get("plan_min_mm"): continue
    if r["plan_max_mm"][2] < EL.get(BEAR, 0) + 1000: continue      # a lower roof (outbuilding, canopy): not on these walls
    (x0, y0, z0), (x1, y1, z1) = r["plan_min_mm"], r["plan_max_mm"]
    dx, dy = x1 - x0, y1 - y0; along_y = dx <= dy * 1.6       # ridge along the longer side unless the roof is very wide
    width = dx if along_y else dy; length = dy if along_y else dx
    rise = z1 - EL.get(BEAR, z0); oh = cfg.get("eaves_overhang_mm", 600)
    span = width - 2 * oh
    t = design_truss(f"T{len(trusses) + 1}", span, rise * span / width, oh)
    n = int(length // SP) + 1
    t.update({"roof_id": r["id"], "count": n, "along": "y" if along_y else "x", "plan": [[x0, y0], [x1, y1]]})
    trusses.append(t)

# ---- drawing ops: roof framing plan with every truss line, and an elevation per truss type
k = 0
def add(o):
    global k; ops.append(o); k += 1; return f"${k}"
plan = add({"op": "create_view", "kind": "structural_plan", "level": BEAR, "name": "S-104 Roof framing plan (PRELIMINARY)", "scale": 100, "discipline": "Structural", "detail_level": "Medium"})
for t in trusses:
    (x0, y0), (x1, y1) = t["plan"]
    for i in range(t["count"]):
        if t["along"] == "y": y = y0 + 300 + i * SP; add({"op": "detail_line", "view": plan, "points_mm": [[x0, y], [x1, y]]})
        else: x = x0 + 300 + i * SP; add({"op": "detail_line", "view": plan, "points_mm": [[x, y0], [x, y1]]})
    add({"op": "text", "view": plan, "point_mm": [(x0 + x1) / 2, (y0 + y1) / 2], "width_mm": 60,
         "text": f"{t['count']} No. {t['name']} Fink trusses @ {SP} c/c, span {t['span_mm']} + {t['overhang_mm']} eaves, {t['pitch_deg']} deg; {GRADE} treated timber; 50x35 battens; 30x2.5 GS straps to ring beam each end"})
sh = add({"op": "create_sheet", "number": "S-104", "name": "Roof framing plan - PRELIMINARY, NOT FOR CONSTRUCTION"}); add({"op": "place_view", "sheet": sh, "view": plan})
el = add({"op": "create_view", "kind": "drafting", "name": "S-105 Roof truss elevations (PRELIMINARY)", "scale": 50})
oy = 0
for t in trusses:
    nodes = t["nodes"]
    for a, b, kind in t["mem"]:
        add({"op": "detail_line", "view": el, "points_mm": [[nodes[a][0], nodes[a][1] + oy], [nodes[b][0], nodes[b][1] + oy]]})
    for r2 in t["members"]:
        a, b = map(int, r2["member"].split("-")); mx, my = (nodes[a][0] + nodes[b][0]) / 2, (nodes[a][1] + nodes[b][1]) / 2 + oy
        add({"op": "text", "view": el, "point_mm": [mx, my + 150], "width_mm": 35, "text": f"{r2['size']} ({r2['N_kN']:+.1f} kN)"})
    add({"op": "text", "view": el, "point_mm": [0, oy - 900], "width_mm": 180,
         "text": f"{t['name']}: Fink truss, span {t['span_mm']} mm, rise {t['rise_mm']} mm ({t['pitch_deg']} deg), @ {SP} c/c, {t['count']} No. Top chord {t['sizes']['top']}, bottom chord {t['sizes']['bottom']}, webs {t['sizes']['web']}, {GRADE} pressure-treated (US 324). Joints: galvanised nail plates or 18 mm ply gussets both faces, by fabricator. Reaction {t['reaction_kn']} kN per truss (service). Loads: tiles+battens {G_SLOPE} kN/m2 on slope, imposed {Q_PLAN} kN/m2. PRELIMINARY."})
    oy -= t["rise_mm"] + 3000
sh2 = add({"op": "create_sheet", "number": "S-105", "name": "Roof truss elevations - PRELIMINARY, NOT FOR CONSTRUCTION"}); add({"op": "place_view", "sheet": sh2, "view": el})
for t in trusses: t["nodes"] = {str(a): v for a, v in t["nodes"].items()}
json.dump(trusses, open(W + "/trusses.json", "w"), indent=1); json.dump(ops, open(W + "/truss_ops.json", "w"))
for t in trusses: print(t["name"], t["span_mm"], t["rise_mm"], t["pitch_deg"], t["count"], t["sizes"], "R", t["reaction_kn"])
print(len(ops), "ops")
