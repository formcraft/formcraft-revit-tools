# The visual structural design report: interactive 3D frame, load-path and earthquake diagrams, charts (concrete,
# steel, cost, utilisation, drift, loads), the drawings (Revit image exports), value-engineering options and the
# completeness checklist; written as the presenting engineer's own report. Built only from the design files.
#   python scripts/structure/report_visual.py <work dir> <runs dir> <rc-design json> <img dir> <out html> [rates json]
import json, sys, os, math, collections, html, base64, datetime
W, O, DJ, IMG, OUT = sys.argv[1:6]; RATES_F = sys.argv[6] if len(sys.argv) > 6 else None
J = lambda p: json.load(open(p, encoding="utf-8")); e = html.escape
facts, plan, built, sizes, d = J(W + "/facts.json"), J(W + "/plan.json"), J(W + "/build.out.json"), J(W + "/sizes.json"), J(DJ)
run = open(W + "/last_run.txt").read().strip(); res, chk, runj = J(f"{O}/{run}_results.json"), J(f"{O}/{run}_check.json"), J(f"{O}/{run}.json")
trusses = J(W + "/trusses.json") if os.path.exists(W + "/trusses.json") else []
stairs = [s for s in (J(W + "/stairs.json") if os.path.exists(W + "/stairs.json") else []) if "waist_mm" in s]
cfg = J(W + "/config.json") if os.path.exists(W + "/config.json") else {}
grav = J(W + "/sizes_gravity.json") if os.path.exists(W + "/sizes_gravity.json") else {}
EL = {l["name"]: l["elevation_mm"] for l in facts["levels"]}; PAD_TOP = -250; ATTIC = (cfg.get("attic") or {}).get("level")
pairs = list(zip(plan["ops"], built["ops"][2:]))
if os.path.exists(W + "/extra.json") and os.path.exists(W + "/extra.out.json"):
    pairs += list(zip(J(W + "/extra.json"), J(W + "/extra.out.json")["ops"]))
util = {x[1]: x[6] for x in chk}
PRESENTER = cfg.get("presenter", "Emlyn Atochon"); FIRM = cfg.get("firm", "Formcraft")

# ---------------- geometry for the 3D model + quantities ----------------
cols, beams, vol, form = [], [], collections.Counter(), collections.Counter()
for o, r in pairs:
    for j, i in enumerate((r or {}).get("created_ids", [])):
        if o["op"] == "column":
            b, h = sizes.get(str(i), o["size_mm"]); p = o["points_mm"][j]; z0 = PAD_TOP if o["level"].startswith("S Pad") else EL[o["level"]]; z1 = EL[o["top_level"]]
            cols.append({"x": p[0], "y": p[1], "z0": z0, "z1": z1, "b": b, "u": util.get(i, 0)})
            vol["Columns"] += b * h * (z1 - z0) / 1e9; form["Columns"] += 4 * b * (z1 - z0) / 1e6
        if o["op"] == "beam":
            b, h = sizes.get(str(i), o["size_mm"]); z = EL[o["level"]]; L = math.dist(o["start_mm"][:2], o["end_mm"][:2]); g = z < 500
            beams.append({"a": o["start_mm"][:2], "b": o["end_mm"][:2], "z": z, "w": b, "h": h, "g": g, "u": util.get(i, 0)})
            hb = h - (0 if g else 200); vol["Ground beams" if g else "Floor & ring beams"] += b * max(0, hb) * L / 1e9
            form["Ground beams" if g else "Floor & ring beams"] += (2 * max(0, hb) + (0 if g else b)) * L / 1e6
pads = []
for p in d["pads"]:
    B, _, t = map(int, p["size"].split("x")); pads.append({"x": p["at"][0], "y": p["at"][1], "B": B, "t": t})
    vol["Pad footings"] += B * B * t / 1e9; form["Pad footings"] += 4 * B * t / 1e6
slabs3d = []
for sl in plan["plan"]["slabs"]:
    lp = sl["loops_mm"][0]; A = abs(sum(lp[i][0] * lp[(i + 1) % len(lp)][1] - lp[(i + 1) % len(lp)][0] * lp[i][1] for i in range(len(lp)))) / 2e6
    timber = sl["level"] == ATTIC
    slabs3d.append({"loop": lp, "z": EL[sl["level"]] + sl.get("offset_mm", 0), "t": 30 if timber else sl["thickness_mm"], "timber": timber, "ground": sl["on_ground"]})
    if timber: continue
    vol["Ground floor slabs" if sl["on_ground"] else "First floor slab"] += A * sl["thickness_mm"] / 1000
    if not sl["on_ground"]: form["First floor slab"] += A
if stairs:
    s0 = stairs[0]; vol["Stair"] = 2 * s0["flight_width_mm"] / 1000 * s0["span_mm"] / 1000 * (s0["waist_mm"] + 85) / 1000; form["Stair"] = 2 * s0["flight_width_mm"] / 1000 * s0["span_mm"] / 1000 * 1.3
truss3d = []
for t in trusses:
    (x0, y0), (x1, y1) = t["plan"]; segs = [[t["nodes"][str(a)], t["nodes"][str(b)]] for a, b, _ in t["mem"]]
    for i in range(t["count"]):
        truss3d.append({"along": t["along"], "o": [x0 + t["overhang_mm"], y0 + 300 + i * t["spacing_mm"]] if t["along"] == "y" else [x0 + 300 + i * t["spacing_mm"], y0 + t["overhang_mm"]], "z": EL.get("Roof +7.25", 7250), "segs": segs})
vol_total = sum(vol.values()); steel = d["steel_kg"]["total"]
excav = sum(((p["B"] + 600) / 1000) ** 2 * 1.25 for p in pads)
model3d = {"cols": cols, "beams": beams, "pads": pads, "slabs": slabs3d, "trusses": truss3d}

# ---------------- cost (indicative Kampala rates; replace with the QS's) ----------------
R = {"concrete": (480_000, 550_000, 620_000), "steel": (4_600, 5_200, 5_800), "formwork": (30_000, 38_000, 45_000), "excavation": (25_000, 35_000, 45_000),
     "truss_T1": (620_000, 720_000, 820_000), "truss_T2": (440_000, 520_000, 600_000), "attic_floor_m2": (80_000, 95_000, 110_000)}
KIT_RATES = cfg.get("kit_rates", "D:/Fomcraft/FMC_BIM_27/FMC_Kit_v2.2/FMC_Kit_v2.2/07_Materials/FMC_Rates.json")
if os.path.exists(KIT_RATES):   # the kit's rates computed from the price book (scripts/cost/rates.py)
    KR = J(KIT_RATES); R.update({k: tuple(KR[k]["rate"]) for k in ("concrete", "steel", "formwork", "excavation", "attic_floor") if k in KR})
    if "timber_truss_m3" in KR:
        for t in trusses:
            m3 = sum(m["length_mm"] / 1000 * math.prod(int(v) / 1000 for v in t["sizes"][m["kind"]].replace("+", "").split("x")) for m in t["members"])
            R["truss_" + t["name"]] = tuple(round(m3 * a + b) for a, b in zip(KR["timber_truss_m3"]["rate"], KR.get("truss_fixings", {"rate": [0, 0, 0]})["rate"]))
if RATES_F and os.path.exists(RATES_F): R.update({k: tuple(v) for k, v in J(RATES_F).items()})
attic_area = sum(abs(sum(s["loop"][i][0] * s["loop"][(i + 1) % len(s["loop"])][1] - s["loop"][(i + 1) % len(s["loop"])][0] * s["loop"][i][1] for i in range(len(s["loop"])))) / 2e6 for s in slabs3d if s["timber"])
qty = {"Concrete (m³)": (vol_total, "concrete"), "Reinforcement (kg)": (steel, "steel"), "Formwork (m²)": (sum(form.values()), "formwork"), "Excavation (m³)": (excav, "excavation")}
for t in trusses: qty[f"Roof trusses {t['name']} (No.)"] = (t["count"], "truss_" + t["name"] if "truss_" + t["name"] in R else "truss_T1")
qty["Attic timber floor (m²)"] = (attic_area, "attic_floor_m2")
cost = {k: tuple(q * r for r in R[rk]) for k, (q, rk) in qty.items()}
tot = [sum(c[i] for c in cost.values()) for i in range(3)]
cost_by_element = collections.Counter()
for k, v in vol.items(): cost_by_element[k] += v * R["concrete"][1] + form.get(k, 0) * R["formwork"][1]
for k, v in d["steel_kg"]["by_element"].items():
    key = {"Columns": "Columns", "Beams": "Floor & ring beams", "Ground beams": "Ground beams", "Pads": "Pad footings", "Slabs": "First floor slab"}.get(k, k)
    cost_by_element[key] += v * R["steel"][1]
cost_by_element["Pad footings"] += excav * R["excavation"][1]
cost_by_element["Roof trusses"] = sum(cost[k][1] for k in cost if k.startswith("Roof trusses")); cost_by_element["Attic timber floor"] = cost["Attic timber floor (m²)"][1]
M = lambda x: f"{x / 1e6:,.1f}M"

# ---------------- analysis numbers ----------------
seis = res.get("seismic", {}); lv = list(res["levels"].values()); disp = {n["node"]: max(n["ux_mm"], n["uy_mm"]) for n in res["nodes"]}; fk = 5 / seis.get("K", 2)
d1 = max(disp[n] for n in lv[0]["nodes"]) * fk; h1 = lv[0]["elevation_mm"] + 250; d2 = max(abs(disp[a] - disp.get(b, 0)) for a, b in res["stacks"]) * fk; h2 = lv[1]["elevation_mm"] - lv[0]["elevation_mm"]
lim1, lim2 = min(0.01 * h1, 60), min(0.01 * h2, 60)
ub = [x[6] for x in chk if x[0] == "beam"]; uc = [x[6] for x in chk if x[0] == "column"]
F = seis.get("F_kn", [0, 0]); Vb = seis.get("V_kn", 0); Wx = cfg.get("wind_storey_kn", [63, 65])
colvol_now = vol["Columns"]
colvol_grav = sum(grav.get(str(i), o["size_mm"])[0] ** 2 * (EL[o["top_level"]] - (PAD_TOP if o["level"].startswith("S Pad") else EL[o["level"]])) / 1e9
                  for o, r in pairs if o["op"] == "column" for i in (r or {}).get("created_ids", []))

# ---------------- chart helpers (inline SVG, palette tokens) ----------------
SER = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)", "var(--s8)"]
def donut(items, unit, title, fmt=lambda v: f"{v:.0f}"):
    total = sum(v for _, v in items); cx, cy, r0, r1 = 120, 120, 70, 108; a = -math.pi / 2; out = []; leg = []
    for i, (k, v) in enumerate(items):
        da = 2 * math.pi * v / total; a2 = a + da; g = 0.012 if len(items) > 1 else 0
        p = lambda ang, rr: (cx + rr * math.cos(ang), cy + rr * math.sin(ang))
        (x1, y1), (x2, y2), (x3, y3), (x4, y4) = p(a + g, r1), p(a2 - g, r1), p(a2 - g, r0), p(a + g, r0); lg = 1 if da > math.pi else 0
        out.append(f'<path d="M{x1:.1f},{y1:.1f} A{r1},{r1} 0 {lg} 1 {x2:.1f},{y2:.1f} L{x3:.1f},{y3:.1f} A{r0},{r0} 0 {lg} 0 {x4:.1f},{y4:.1f} Z" fill="{SER[i % 8]}"><title>{e(k)}: {fmt(v)} {unit} ({100 * v / total:.0f}%)</title></path>')
        leg.append(f'<li><i style="background:{SER[i % 8]}"></i><span>{e(k)}</span><b>{fmt(v)} {unit}</b><em>{100 * v / total:.0f}%</em></li>'); a = a2
    return (f'<figure class="chart"><figcaption>{e(title)}</figcaption><div class="donut"><svg viewBox="0 0 240 240" role="img" aria-label="{e(title)}">{"".join(out)}'
            f'<text x="120" y="116" text-anchor="middle" class="big">{fmt(total)}</text><text x="120" y="138" text-anchor="middle" class="sm">{e(unit)} total</text></svg><ul class="legend">{"".join(leg)}</ul></div></figure>')
def hbars(items, unit, title, fmt=lambda v: f"{v:,.0f}", color=None, maxv=None, marks=None):
    mx = maxv or max(v for _, v in items) * 1.08; rows = []
    for i, (k, v) in enumerate(items):
        w = 100 * v / mx; c = color or "var(--s1)"
        mk = "" if not marks else f'<i class="mark" style="left:{100 * marks[i] / mx:.1f}%" title="limit {fmt(marks[i])} {unit}"></i>'
        rows.append(f'<div class="hb"><span class="k">{e(k)}</span><span class="track"><span class="bar" style="width:{w:.1f}%;background:{c}" title="{e(k)}: {fmt(v)} {unit}"></span>{mk}</span><b>{fmt(v)} {e(unit)}</b></div>')
    return f'<figure class="chart"><figcaption>{e(title)}</figcaption><div class="hbars">{"".join(rows)}</div></figure>'
def histo(vals, title, color):
    bins = [0] * 10
    for v in vals: bins[min(9, int(v * 10))] += 1
    mx = max(bins) or 1; W2, H2 = 300, 150; bw = W2 / 10; bars = []
    for i, n in enumerate(bins):
        h = (H2 - 24) * n / mx
        if n: bars.append(f'<rect x="{i * bw + 2:.1f}" y="{H2 - 18 - h:.1f}" width="{bw - 4:.1f}" height="{h:.1f}" rx="2" fill="{color}"><title>{i * 10}–{i * 10 + 10}% used: {n} members</title></rect>'
                          f'<text x="{i * bw + bw / 2:.1f}" y="{H2 - 22 - h:.1f}" text-anchor="middle" class="sm">{n}</text>')
    ax = "".join(f'<text x="{i * bw:.1f}" y="{H2 - 4}" class="sm">{i * 10}%</text>' for i in range(0, 10, 2))
    return f'<figure class="chart"><figcaption>{e(title)}</figcaption><svg viewBox="0 0 {W2} {H2}" class="hist" role="img" aria-label="{e(title)}"><line x1="0" x2="{W2}" y1="{H2 - 18}" y2="{H2 - 18}" class="axis"/>{"".join(bars)}{ax}</svg></figure>'

# ---------------- diagrams ----------------
def load_path():
    steps = [("Roof tiles & trusses", "1.0 kN/m² + 0.5 imposed", "s5"), ("Ring beams at +7.25", "carry trusses & attic floor", "s2"), ("Upper columns", "230–300 mm square", "s1"),
             ("First floor slab & beams", "200 mm slab, 230 mm beams", "s2"), ("Ground floor columns", "230–350 mm square", "s1"), ("Pad footings", "0.9–2.2 m square, 1 m deep", "s4"), ("Ground", "150 kN/m² assumed — soil test", "s6")]
    h = 64; out = []
    for i, (a, b, c) in enumerate(steps):
        y = 10 + i * h
        out.append(f'<rect x="20" y="{y}" width="300" height="46" rx="4" fill="var(--panel)" stroke="var(--{c})" stroke-width="2"/><rect x="20" y="{y}" width="8" height="46" fill="var(--{c})"/>'
                   f'<text x="40" y="{y + 20}" class="t1">{e(a)}</text><text x="40" y="{y + 37}" class="sm">{e(b)}</text>')
        if i < len(steps) - 1: out.append(f'<path d="M170 {y + 48} v12" stroke="var(--ink)" stroke-width="2" marker-end="url(#ar)"/>')
    return (f'<svg viewBox="0 0 340 {10 + len(steps) * h}" class="diag" role="img" aria-label="Load path from roof to ground"><defs><marker id="ar" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--ink)"/></marker></defs>{"".join(out)}</svg>')
def quake():
    out = ['<svg viewBox="0 0 420 300" class="diag" role="img" aria-label="Earthquake forces on the frame">',
           '<defs><marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--s2)"/></marker></defs>',
           '<line x1="40" y1="260" x2="400" y2="260" class="ground"/>']
    xs = [140, 230, 320]; zf, zr = 160, 70
    for x in xs: out.append(f'<line x1="{x}" y1="260" x2="{x}" y2="{zr}" class="memb"/>')
    for z in (zf, zr): out.append(f'<line x1="{xs[0]}" y1="{z}" x2="{xs[-1]}" y2="{z}" class="memb"/>')
    out.append(f'<path d="M{xs[0]} 260 L{xs[1]} {zf} M{xs[1]} 260 L{xs[0]} {zf}" class="strut"/><path d="M{xs[1]} {zf} L{xs[2]} {zr} M{xs[2]} {zf} L{xs[1]} {zr}" class="strut"/>')
    for z, f2, lab in ((zr, F[1], "roof level"), (zf, F[0], "first floor")):
        L = 30 + 70 * f2 / max(F); out.append(f'<line x1="{xs[0] - 10 - L}" y1="{z}" x2="{xs[0] - 6}" y2="{z}" stroke="var(--s2)" stroke-width="4" marker-end="url(#ar2)"/>'
                                               f'<text x="{xs[0] - 12 - L}" y="{z - 9}" class="t1">{f2:.0f} kN</text><text x="{xs[0] - 12 - L}" y="{z + 18}" class="sm">{lab}</text>')
    out.append(f'<text x="230" y="285" text-anchor="middle" class="sm">base shear {Vb:.0f} kN · walls (dashed) brace the frame</text></svg>')
    return "".join(out)

# ---------------- drawings ----------------
def img(name):
    for f in os.listdir(IMG):
        if name in f: return "data:image/png;base64," + base64.b64encode(open(os.path.join(IMG, f), "rb").read()).decode()
    return None
DRW = [("S-101", "First floor framing plan", "S-101"), ("S-100", "Foundation & ground beam plan", "S-100"), ("S-107", "First floor slab reinforcement", "S-107"),
       ("S-104", "Roof framing plan", "S-104"), ("S-105", "Roof truss elevations", "S-105"), ("S-106", "Typical reinforcement details", "S-106"), ("S-108", "Stair details", "S-108"), ("S-103", "Frame 3D (Revit)", "S-103")]
gallery = "".join(f'<figure class="sheet"><img loading="lazy" src="{src}" alt="{e(t)}"><figcaption><b>{n}</b> {e(t)}</figcaption></figure>' for n, t, k in DRW if (src := img(k)))

# ---------------- checklist ----------------
# statuses from the supplementary checks (extra-checks.py) where they have run; data gaps stay open
XC = J(W + "/extra_checks.json")["checks"] if os.path.exists(W + "/extra_checks.json") else {}
xs = lambda k, dflt: XC[k]["status"] if k in XC else dflt
marks_done = os.path.exists(W + "/marks_ops.out.json")
CH = [("Dead loads from the real build-ups", "done"), ("Imposed loads: 2.0 kN/m² floors, 2.5 balconies and attic", xs("q2", "partial")), ("Wind (25 m/s assumed, UNMA value needed)", "partial"),
      ("Earthquake: US 319 static; EC8 comparison needs site ag and soil class", xs("modal", "partial")), ("Load combinations EN 1990", "done"), ("Robustness ties / imperfections", xs("ties", "not")),
      ("3D frame with diaphragms and infill", "done"), ("Independent Robot check of the final model", "done" if cfg.get("robot_check", {}).get("run_after") == run else "partial"), ("Storey drift", "done"), ("Slenderness / second order", xs("slender", "partial")),
      ("Beams: bending & shear", "done"), ("Beams: deflection & cracking", xs("defl", "partial")), ("Torsion in edge beams", xs("torsion", "not")), ("Columns: axial + biaxial", "done"),
      ("Ductile detailing: strong column / weak beam", xs("scwb", "partial")), ("First floor slab", "done"), ("Stairs", "done"), ("Infill wall strength & ties", xs("infill", "not")),
      ("Pad bearing & bending", "done"), ("Pad punching / one-way shear", xs("punch", "not")), ("Geotechnical investigation (soil test)", "not"), ("Settlement (needs the soil test)", "not"), ("Roof trusses", "done"),
      ("Truss joints, bracing, uplift", xs("truss", "partial")), ("Attic floor & plywood diaphragm", xs("diaphragm", "partial")), ("Covers for durability & 60 min fire", "done"),
      ("Drawings with bar marks (S-110 schedules)", "done" if marks_done else "partial"), ("Bar bending schedules BS 8666", "done"), ("Design report", "done"), ("Engineer of record signature", "not")]
cnt = collections.Counter(s for _, s in CH)
# the walls the earthquake design relies on (infill.json) and the bare-frame redundancy result (update.py)
INF = [p for p in (J(W + "/infill.json") if os.path.exists(W + "/infill.json") else []) if p["structural"]]
UPD = J(W + "/update_summary.json") if os.path.exists(W + "/update_summary.json") else {}
red = UPD.get("redundancy", {}).get("bare_frame_gravity_wind_over_capacity")
WALLS_NOTE = (f'<p class="callout"><b>The walls are part of the structure.</b> In an earthquake this building relies on {len(INF)} masonry wall panels between its columns (US 319, K = 2). '
              'They are built after the frame, tight to the columns and beams, tied into the columns every 450 mm, and are never removed, cut, or given bigger openings without the structural engineer. '
              + ("Without any walls, the concrete frame still carries the full weight of the house and the wind on its own." if red == 0 else "") + "</p>") if INF else ""
lab = {"done": ("Done", "ok", "✓"), "partial": ("Partial", "warn", "◐"), "not": ("Open", "bad", "○")}
check_html = "".join(f'<li class="{lab[s][1]}"><span class="ic" aria-hidden="true">{lab[s][2]}</span><span>{e(t)}</span><em>{lab[s][0]}</em></li>' for t, s in CH)

rc = cfg.get("robot_check")
robot_html = (f'<div class="callout"><p><b>Checked twice.</b> I ran the final model again, independently, in Autodesk Robot Structural Analysis ({e(rc["run"])}). '
              f'On Robot&#39;s forces every one of the {rc["members"]} members still passes, and the sway is {rc["drift"][0]} mm and {rc["drift"][1]} mm against limits of {lim1:.0f} and {lim2:.0f} mm.</p></div>') if rc else ""
# ---------------- page ----------------
three = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"; orbit = "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"
today = datetime.date.today().strftime("%d %B %Y")
conc_items = sorted(vol.items(), key=lambda x: -x[1]); steel_items = sorted(d["steel_kg"]["by_element"].items(), key=lambda x: -x[1])
size_items = sorted(d["steel_kg"]["by_size"].items(), key=lambda x: int(x[0][1:]))
cost_items = sorted(cost_by_element.items(), key=lambda x: -x[1])
cost_rows = "".join(f'<tr><td>{e(k)}</td><td class="n">{q:,.0f}</td><td class="n">{R[rk][1]:,}</td><td class="n">{M(cost[k][0])}</td><td class="n"><b>{M(cost[k][1])}</b></td><td class="n">{M(cost[k][2])}</td></tr>' for k, (q, rk) in qty.items())
VE = [
 ("Soil test before final pad sizes", "Pads are the largest concrete item in the frame (" + f"{vol['Pad footings']:.0f} m³). At 200 kN/m² they shrink by about a quarter (≈ 10 m³, UGX 6–8M saved); at 100 kN/m² they grow by half. The test pays for itself.", "save"),
 ("Keep the timber attic", f"Already taken: about 48 m³ of concrete and 4 t of steel removed, and the house is 1,160 kN lighter in an earthquake.", "done"),
 ("No concrete shear walls", "Already taken: the stone and block walls, built tight into the frame, stiffen it enough. About 35 m³ of concrete avoided. Condition: the walls must be built properly and never removed.", "done"),
 ("Steel before size in columns", f"Already taken: {sum(1 for c in cols if c['b'] == 230)} of {len(cols)} column lengths stay at 230 mm. Column concrete {colvol_now:.1f} m³ against {colvol_grav:.1f} m³ in the gravity-only design with bigger columns.", "done"),
 ("Standardise to 3 column and 4 beam sizes", "Fewer formwork sizes means the shutters are reused more: typically 10–15% off formwork cost, for a little more concrete.", "save"),
 ("Thinner external terraces", f"Ground-bearing slabs and terraces are {vol['Ground floor slabs']:.0f} m³. External terraces at 100 mm with mesh instead of 150 mm save roughly 10–15 m³ if the architecture allows.", "save"),
 ("Check floors at 2.0 kN/m²", "International practice uses 2.0 kN/m² for homes; Uganda allows 1.5. Checking at 2.0 adds a few percent of slab steel and buys margin for parties, bookshelves and future use. Recommended.", "cost"),
 ("Round portico columns", "The architecture shows Ø340 round columns; the design uses 300 mm square. Round columns need tube formwork: keep them only if they matter architecturally.", "cost"),
 ("Trusses at 600 or 1,200 mm", "At 600 mm (41 trusses) tiles sit on battens directly. At 1,200 mm with purlins there are half as many trusses but more purlin timber: price both with the fabricator.", "save"),
]
ve_html = "".join(f'<article class="ve {k}"><h4>{e(a)}</h4><p>{e(b)}</p><span class="tag">{ {"save": "Saves money", "done": "Done", "cost": "Small cost, worth it"}[k] }</span></article>' for a, b, k in VE)

page = f"""<title>Ogala Structural Design</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..100,500..800&family=Public+Sans:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a drawing-office report. Full-bleed 3D model as the opener, then numbered chapters in one reading column with
   wide figure rows; charts and drawings sit on white "sheets" with a title-block caption. */
:root {{
  --paper:#eef1f3; --panel:#ffffff; --ink:#121a21; --muted:#56636e; --line:#d3dae0; --hero:#0f1820; --hero-ink:#eef3f7;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300; --s7:#6250d6; --s8:#e34948;
  --good:#0ca30c; --warn:#fab219; --crit:#d03b3b;
  --display:"Archivo", "Arial Narrow", Arial, sans-serif; --body:"Public Sans", "Segoe UI", Arial, sans-serif; --mono:"IBM Plex Mono", Consolas, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --paper:#11161a; --panel:#1a1a19; --ink:#f0efec; --muted:#c3c2b7; --line:#2d353c; --hero:#0a0f13;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767; color-scheme: dark }} }}
:root[data-theme="dark"] {{ --paper:#11161a; --panel:#1a1a19; --ink:#f0efec; --muted:#c3c2b7; --line:#2d353c; --hero:#0a0f13;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767; color-scheme: dark }}
body {{ background:var(--paper); color:var(--ink); font:16px/1.6 var(--body); }}
.gut {{ padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); }}
.hero {{ background:var(--hero); color:var(--hero-ink); padding-block:28px 0; }}
.hero .in {{ max-width:1180px; margin:0 auto; display:grid; gap:18px; }}
.eyebrow {{ font:500 12px/1.4 var(--mono); letter-spacing:.14em; text-transform:uppercase; opacity:.75; }}
h1 {{ font:800 clamp(34px, 7vw, 76px)/.95 var(--display); font-stretch:75%; letter-spacing:-.01em; margin:0; text-wrap:balance; }}
.lede {{ max-width:62ch; font-size:18px; opacity:.9; margin:0; }}
.viewer {{ position:relative; height:min(68vh, 620px); min-height:360px; border-top:1px solid #ffffff22; }}
#v3d {{ width:100%; height:100%; display:block; }}
.vctl {{ position:absolute; left:12px; top:12px; display:flex; flex-wrap:wrap; gap:6px; max-width:calc(100% - 24px); }}
.vctl button {{ font:500 12px var(--mono); color:var(--hero-ink); background:#ffffff14; border:1px solid #ffffff33; padding:6px 10px; border-radius:3px; cursor:pointer; }}
.vctl button[aria-pressed="true"] {{ background:var(--hero-ink); color:var(--hero); }}
.vctl button:focus-visible {{ outline:2px solid var(--s4); outline-offset:2px; }}
.vleg {{ position:absolute; right:12px; bottom:12px; font:12px/1.5 var(--mono); background:#0f1820cc; padding:8px 10px; border-radius:3px; display:grid; gap:2px; }}
.vleg i {{ display:inline-block; width:10px; height:10px; margin-right:6px; vertical-align:-1px; }}
.vnote {{ position:absolute; left:12px; bottom:12px; font:12px var(--mono); opacity:.7; }}
main {{ max-width:1180px; margin:0 auto; padding-block:36px 80px; display:grid; gap:64px; }}
section {{ display:grid; gap:20px; min-width:0; }}
.chap {{ display:grid; grid-template-columns:auto 1fr; gap:4px 16px; align-items:baseline; border-top:3px solid var(--ink); padding-top:12px; }}
.chap span {{ font:500 13px var(--mono); color:var(--muted); }}
h2 {{ font:700 clamp(26px, 4vw, 40px)/1.05 var(--display); font-stretch:85%; margin:0; text-wrap:balance; }}
h3 {{ font:700 20px/1.2 var(--display); margin:0; }} h4 {{ font:700 17px/1.25 var(--display); margin:0; }}
p {{ margin:0; max-width:68ch; }}
.cols {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:20px; }} .cols > * {{ min-width:0; }}
.figs {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:1px; background:var(--line); border:1px solid var(--line); }}
.fig {{ background:var(--panel); padding:16px; display:grid; gap:4px; }}
.fig b {{ font:800 34px/1 var(--display); font-stretch:80%; font-variant-numeric:tabular-nums; }} .fig span {{ font:12px/1.4 var(--mono); color:var(--muted); }}
.chart, .sheet, .card {{ margin:0; background:var(--panel); border:1px solid var(--line); padding:16px; display:grid; gap:12px; min-width:0; }}
figcaption {{ font:500 12px/1.4 var(--mono); text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }}
.donut {{ display:grid; grid-template-columns:minmax(150px, 210px) 1fr; gap:16px; align-items:center; }}
@media (max-width:520px) {{ .donut {{ grid-template-columns:1fr; }} .donut svg {{ max-width:220px; margin:0 auto; }} }}
svg text {{ fill:var(--ink); font-family:var(--mono); }} svg .big {{ font:800 28px var(--display); fill:var(--ink); }} svg .sm {{ font-size:11px; fill:var(--muted); }} svg .t1 {{ font:600 13px var(--body); fill:var(--ink); }}
.legend {{ list-style:none; margin:0; padding:0; display:grid; gap:6px; font-size:14px; }}
.legend li {{ display:grid; grid-template-columns:12px 1fr auto 40px; gap:8px; align-items:center; }} .legend i {{ width:12px; height:12px; border-radius:2px; }}
.legend b {{ font:500 13px var(--mono); font-variant-numeric:tabular-nums; }} .legend em {{ font:12px var(--mono); color:var(--muted); font-style:normal; text-align:right; }}
.hbars {{ display:grid; gap:8px; }} .hb {{ display:grid; grid-template-columns:minmax(90px, 160px) 1fr minmax(80px, auto); gap:10px; align-items:center; font-size:14px; }}
.hb .track {{ position:relative; height:14px; background:var(--paper); border-radius:2px; }} .hb .bar {{ position:absolute; left:0; top:0; bottom:0; border-radius:0 4px 4px 0; }}
.hb .mark {{ position:absolute; top:-4px; bottom:-4px; width:2px; background:var(--ink); }} .hb b {{ font:500 13px var(--mono); text-align:right; font-variant-numeric:tabular-nums; }}
svg.hist {{ width:100%; height:auto; }} .axis {{ stroke:var(--line); }}
.diag {{ width:100%; height:auto; max-height:480px; }} .diag .memb {{ stroke:var(--ink); stroke-width:4; }} .diag .strut {{ stroke:var(--muted); stroke-width:2; stroke-dasharray:5 4; fill:none; }} .diag .ground {{ stroke:var(--s6); stroke-width:3; }}
.tw {{ overflow-x:auto; border:1px solid var(--line); background:var(--panel); }}
table {{ border-collapse:collapse; width:100%; font-size:14px; }} th {{ text-align:left; font:500 11px/1.3 var(--mono); text-transform:uppercase; letter-spacing:.07em; color:var(--muted); padding:9px 12px; border-bottom:1px solid var(--line); }}
td {{ padding:9px 12px; border-bottom:1px solid var(--line); }} td.n {{ text-align:right; font-family:var(--mono); font-variant-numeric:tabular-nums; white-space:nowrap; }} tfoot td {{ border-top:2px solid var(--ink); border-bottom:0; font-weight:600; }}
.gallery {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:16px; }}
.sheet img {{ width:100%; aspect-ratio:4/3; object-fit:contain; background:#fff; border:1px solid var(--line); cursor:zoom-in; }}
.sheet figcaption b {{ color:var(--ink); margin-right:6px; }}
.ves {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:14px; }}
.ve {{ background:var(--panel); border:1px solid var(--line); padding:16px; display:grid; gap:8px; align-content:start; }}
.ve .tag {{ font:500 11px var(--mono); text-transform:uppercase; letter-spacing:.08em; justify-self:start; padding:3px 7px; border:1px solid currentColor; border-radius:2px; }}
.ve.save .tag {{ color:var(--s3); }} .ve.done .tag {{ color:var(--s1); }} .ve.cost .tag {{ color:var(--s2); }}
.prog {{ display:flex; height:12px; border-radius:2px; overflow:hidden; gap:2px; }} .prog i {{ display:block; }}
.checks {{ list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:6px 18px; }}
.checks li {{ display:grid; grid-template-columns:22px 1fr auto; gap:8px; align-items:center; padding:7px 0; border-bottom:1px solid var(--line); font-size:14px; }}
.checks .ic {{ font-weight:700; }} .checks em {{ font:500 11px var(--mono); text-transform:uppercase; font-style:normal; }}
.checks .ok .ic, .checks .ok em {{ color:var(--good); }} .checks .warn .ic {{ color:var(--warn); }} .checks .warn em {{ color:var(--muted); }} .checks .bad .ic, .checks .bad em {{ color:var(--crit); }}
.callout {{ border-left:4px solid var(--s2); background:var(--panel); padding:14px 16px; }}
.sig {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:1px; background:var(--line); border:2px solid var(--ink); }}
.sig div {{ background:var(--panel); padding:12px 14px; display:grid; gap:2px; }} .sig span {{ font:500 11px var(--mono); text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }}
dialog {{ border:0; padding:0; max-width:96vw; max-height:94vh; background:#fff; }} dialog img {{ max-width:96vw; max-height:90vh; display:block; }} dialog::backdrop {{ background:#000c; }}
@media (prefers-reduced-motion: reduce) {{ * {{ scroll-behavior:auto; }} }}
</style>

<header class="hero">
  <div class="in gut">
    <div class="eyebrow">{e(FIRM)} · The Ogala Residence · Main house · Structural design · {today}</div>
    <h1>How the Ogala house stands up</h1>
    <p class="lede">I designed the structure of the main house to carry its own weight, the people and things inside it, wind and the earthquakes Kampala must plan for, using as little concrete as the code allows. Turn the model: every column, beam, footing and roof truss below is the real design.</p>
  </div>
  <div class="viewer">
    <canvas id="v3d" aria-label="3D model of the structural frame"></canvas>
    <div class="vctl gut" role="group" aria-label="Model display">
      <button id="m-type" aria-pressed="true">By element</button><button id="m-util" aria-pressed="false">How hard it works</button>
      <button id="t-slab" aria-pressed="true">Slabs</button><button id="t-roof" aria-pressed="true">Roof trusses</button><button id="t-pad" aria-pressed="true">Footings</button>
    </div>
    <div class="vleg" id="vleg"></div>
    <div class="vnote">drag to turn · scroll to zoom</div>
  </div>
</header>

<main class="gut">
<section>
  <div class="figs">
    <div class="fig"><b>{vol_total:.0f} m³</b><span>concrete, all elements</span></div>
    <div class="fig"><b>{steel / 1000:.1f} t</b><span>reinforcing steel</span></div>
    <div class="fig"><b>UGX {tot[1] / 1e6:,.0f}M</b><span>structure cost, likely ({tot[0] / 1e6:,.0f}–{tot[2] / 1e6:,.0f}M)</span></div>
    <div class="fig"><b>{max(ub + uc) * 100:.0f}%</b><span>most any part is used, under 100% = safe</span></div>
    <div class="fig"><b>{100 * d2 / lim2:.0f}%</b><span>of the allowed earthquake sway (first floor)</span></div>
  </div>
</section>

<section>
  <div class="chap"><span>01</span><h2>The idea, in plain words</h2></div>
  <div class="cols">
    <div class="card"><h3>A skeleton with strong muscles</h3><p>The house has a skeleton of reinforced-concrete posts (columns) and beams. The stone and block walls are built tight into it, like muscle on bone, so when the ground shakes the walls and frame hold each other still. That is why the columns can stay slim — most are just 23 cm square.</p></div>
    <div class="card"><h3>Heavy below, light above</h3><p>The first floor is a solid concrete slab: it ties every column together like a tray. Above it, the attic floor and the roof are timber. A lighter top means less force in an earthquake and less concrete to pay for — the timber attic alone took out about 48 m³ of concrete.</p></div>
    <div class="card"><h3>Feet in firm ground</h3><p>Every column stands on a square concrete foot (pad) about a metre down, and the feet are joined by ground beams so they can't drift apart. Their size depends on how strong the soil is — which is why a soil test comes next.</p></div>
  </div>
  <div class="cols">
    <figure class="chart"><figcaption>How the weight travels to the ground</figcaption>{load_path()}</figure>
    <figure class="chart"><figcaption>What an earthquake does — and what holds it</figcaption>{quake()}<p>The earthquake pushes sideways hardest at the top. The first-floor slab gathers that push and hands it to the columns and the walls between them. The house sways {d2:.0f} mm at the first floor against an allowed {lim2:.0f} mm.</p></figure>
  </div>
</section>

<section>
  <div class="chap"><span>02</span><h2>What I designed it for</h2></div>
  <div class="cols">
    {hbars([("First floor slab (dead)", 7.0), ("People & furniture", 1.5), ("Balconies", 2.5), ("Stairs", 2.0), ("Attic storage", 2.5), ("Attic floor (dead)", 0.6), ("Roof (dead)", 1.0), ("Roof (imposed)", 0.5)], "kN/m²", "Loads per square metre (1 kN/m² ≈ 100 kg on every m²)", fmt=lambda v: f"{v:.1f}")}
    {hbars([("Wind, first floor", Wx[0]), ("Wind, roof level", Wx[1]), ("Earthquake, first floor", F[0]), ("Earthquake, roof level", F[1])], "kN", "Sideways forces: earthquake governs, wind is about 15% of it", color="var(--s2)")}
  </div>
  <p>Codes: Uganda National Building (Structural Design) Code 2019, with Eurocode load combinations and concrete rules where Uganda's code points to them, and Uganda's seismic code US 319 for Kampala (zone 2). Wind uses an assumed basic speed of 25 m/s until the Meteorological Authority's site value is in.</p>
</section>

<section>
  <div class="chap"><span>03</span><h2>Every part, checked</h2></div>
  <p>The whole frame was modelled in 3D and analysed for {len([c for c in runj['form']['cases']])} load cases and {len(runj['form'].get('combinations', []))} combinations. Each column and beam was then checked for bending, shear and axial force, and sized up only where it failed. The result is a frame where most parts work hard — that is what an economical design looks like.</p>
  {robot_html}
  <div class="cols">
    {histo(uc, f"Columns: how much of their strength is used ({len(uc)} column lengths)", "var(--s1)")}
    {histo(ub, f"Beams: how much of their strength is used ({len(ub)} beams)", "var(--s2)")}
    {hbars([("Ground floor sway", d1), ("First floor sway", d2)], "mm", "Earthquake sway against the limit (black mark)", fmt=lambda v: f"{v:.1f}", color="var(--s3)", maxv=max(lim1, lim2) * 1.1, marks=[lim1, lim2])}
  </div>
</section>

<section>
  <div class="chap"><span>04</span><h2>Materials</h2></div>
  <div class="cols">
    {donut(conc_items, "m³", "Concrete by element")}
    {donut([(k, v) for k, v in steel_items], "kg", "Reinforcing steel by element", fmt=lambda v: f"{v:,.0f}")}
  </div>
  <div class="cols">
    {hbars([(k, v) for k, v in size_items], "kg", "Steel by bar size (H = high-yield B500)", color="var(--s7)")}
    {hbars([("Frame: columns, beams, footings", vol["Columns"] + vol["Floor & ring beams"] + vol["Ground beams"] + vol["Pad footings"]), ("Suspended first floor slab", vol["First floor slab"]), ("Ground-bearing slabs & terraces", vol["Ground floor slabs"])], "m³", "Where the concrete really goes", fmt=lambda v: f"{v:.0f}", color="var(--s1)")}
  </div>
</section>

<section>
  <div class="chap"><span>05</span><h2>What it costs</h2></div>
  <div class="cols">
    {donut([(k, v / 1e6) for k, v in cost_items], "UGX M", "Structure cost by element (likely)", fmt=lambda v: f"{v:,.1f}")}
    <div class="card"><h3>UGX {tot[1] / 1e6:,.0f} million, likely</h3><p>Range {tot[0] / 1e6:,.0f}–{tot[2] / 1e6:,.0f} million for the structure only: concrete, steel, formwork, excavation for the footings, the roof trusses and the attic floor. It excludes walls, finishes, roofing tiles, hardcore and the contractor's preliminaries and profit. The rates are my Kampala estimates for 2026; the quantity surveyor's rates replace them in one step.</p></div>
  </div>
  <div class="tw"><table><thead><tr><th>Item</th><th>Quantity</th><th>Rate (UGX)</th><th>Low</th><th>Likely</th><th>High</th></tr></thead><tbody>{cost_rows}</tbody>
  <tfoot><tr><td>Total structure</td><td></td><td></td><td class="n">{M(tot[0])}</td><td class="n">{M(tot[1])}</td><td class="n">{M(tot[2])}</td></tr></tfoot></table></div>
</section>

<section>
  <div class="chap"><span>06</span><h2>The roof and the stair</h2></div>
  <div class="cols">
    <div class="card"><h3>Timber roof trusses</h3><p>{"; ".join(f"{t['count']} {t['name']} Fink trusses spanning {t['span_mm'] / 1000:.1f} m at {t['pitch_deg']}°, top chord {t['sizes']['top']}, bottom chord {t['sizes']['bottom']}, webs {t['sizes']['web']}" for t in trusses)}. Treated SG8 hardwood (e.g. Eucalyptus grandis) at 600 mm centres, tiles on 50×35 battens, every truss strapped to the ring beam.</p></div>
    <div class="card"><h3>The main stair</h3><p>{e(f"A concrete U stair of {stairs[0]['risers']} steps of {stairs[0]['riser_mm']} mm with {stairs[0]['going_mm']} mm treads, two flights with a half landing. Waist slab {stairs[0]['waist_mm']} mm with {stairs[0]['main']} bars; the landing sits on its own beam and two small columns.") if stairs else ""}</p></div>
  </div>
</section>

<section>
  <div class="chap"><span>07</span><h2>The drawings</h2></div>
  <p>Eleven sheets in the structural model: general notes, foundations, framing plans, 3D, roof framing and trusses, typical details, slab reinforcement, stair and member schedules. Bar bending schedules (BS 8666) for every element are issued with them. Click a drawing to enlarge it.</p>
  <div class="gallery">{gallery}</div>
</section>

<section>
  <div class="chap"><span>08</span><h2>What would make it better</h2></div>
  <p>Straight talk on where money can still be saved, and where spending a little more is the right call.</p>
  <div class="ves">{ve_html}</div>
</section>

<section>
  <div class="chap"><span>09</span><h2>Where the design stands</h2></div>
  <p>I measured the design against Uganda's code and, where that code is lenient, against Eurocode and ACI practice. {cnt['done']} items are done, {cnt['partial']} are partly done and {cnt['not']} are open. The open ones are for the engineer of record and the soil test before construction.</p>{f'<p class="callout"><b>For the engineer of record:</b> every load, formula and member result is set out for checking, section by section, with accept, correct and query marks and the sign-off, in the <a href="{e(cfg["review_url"])}">structural design review pack</a>.</p>' if cfg.get("review_url") else ""}
  <div class="prog" role="img" aria-label="{cnt['done']} done, {cnt['partial']} partial, {cnt['not']} open"><i style="flex:{cnt['done']};background:var(--good)"></i><i style="flex:{cnt['partial']};background:var(--warn)"></i><i style="flex:{cnt['not']};background:var(--crit)"></i></div>
  <ul class="checks">{check_html}</ul>
  <div class="callout"><p><b>Two conditions for the builder.</b> The stone and block walls shown as infill are part of the earthquake resistance: build them after the frame, tight to the columns and beams, tied every 450 mm, and never remove them or cut new large openings without the engineer's approval. And confirm the soil with trial pits before the footings are cast.</p></div>
  <div class="sig"><div><span>Prepared by</span><b>{e(PRESENTER)}, {e(FIRM)}</b></div><div><span>Status</span><b>Preliminary — not for construction</b></div><div><span>Engineer of record</span><b>to review and sign</b></div><div><span>Basis</span><b>{e(run)} · architecture model of {today}</b></div></div>
  {WALLS_NOTE}
  <p class="note">Prepared with Autodesk Revit, Autodesk Robot Structural Analysis and the Formcraft Construction plugin (Formcraft Revit Tools).</p>
</section>
</main>
<dialog id="zoom"><img alt=""></dialog>

<script src="{three}"></script>
<script src="{orbit}"></script>
<script>
const M3 = {json.dumps(model3d, separators=(",", ":"))};
(function () {{
  const cv = document.getElementById("v3d"), leg = document.getElementById("vleg");
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const zoom = document.getElementById("zoom");
  document.querySelectorAll(".sheet img").forEach((im) => im.addEventListener("click", () => {{ zoom.querySelector("img").src = im.src; try {{ zoom.showModal(); }} catch (e) {{}} }}));
  zoom.addEventListener("click", () => zoom.close());
  if (!window.THREE) {{ leg.textContent = "3D needs WebGL: see the drawings below."; return; }}
  let renderer;
  try {{ renderer = new THREE.WebGLRenderer({{ canvas: cv, antialias: true }}); }} catch (e) {{ leg.textContent = "3D needs WebGL: see the drawings below."; return; }}
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene(); scene.background = new THREE.Color(css("--hero") || "#0f1820");
  const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 500);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.75)); const sun = new THREE.DirectionalLight(0xffffff, 0.75); sun.position.set(-20, 30, 15); scene.add(sun);
  const P = (x, y, z) => new THREE.Vector3(x / 1000, z / 1000, -y / 1000);
  const C = {{ col: css("--s1"), beam: css("--s2"), gbeam: css("--s3"), pad: css("--s4"), slab: "#c9d2d9", timber: "#b98b5a", truss: "#d9b27c" }};
  const groups = {{ frame: new THREE.Group(), slab: new THREE.Group(), roof: new THREE.Group(), pad: new THREE.Group() }};
  Object.values(groups).forEach((g) => scene.add(g));
  const util = [];
  const box = (a, b, w, h, color, u, grp, kind) => {{
    const len = a.distanceTo(b), m = new THREE.Mesh(new THREE.BoxGeometry(w, h, len), new THREE.MeshStandardMaterial({{ color, roughness: 0.8 }}));
    m.position.copy(a.clone().add(b).multiplyScalar(0.5)); m.lookAt(b); grp.add(m); if (u !== undefined) util.push({{ m, u, base: color }}); return m;
  }};
  M3.cols.forEach((c) => box(P(c.x, c.y, c.z0), P(c.x, c.y, c.z1), c.b / 1000, c.b / 1000, C.col, c.u, groups.frame));
  M3.beams.forEach((b) => {{ const a = P(b.a[0], b.a[1], b.z - b.h / 2), e2 = P(b.b[0], b.b[1], b.z - b.h / 2); box(a, e2, b.w / 1000, b.h / 1000, b.g ? C.gbeam : C.beam, b.u, groups.frame); }});
  M3.pads.forEach((p) => {{ const m = new THREE.Mesh(new THREE.BoxGeometry(p.B / 1000, p.t / 1000, p.B / 1000), new THREE.MeshStandardMaterial({{ color: C.pad, roughness: 0.9 }})); m.position.copy(P(p.x, p.y, -1000 + p.t / 2)); groups.pad.add(m); }});
  M3.slabs.forEach((s) => {{
    const sh = new THREE.Shape(s.loop.map((q) => new THREE.Vector2(q[0] / 1000, q[1] / 1000)));
    const g = new THREE.ExtrudeGeometry(sh, {{ depth: s.t / 1000, bevelEnabled: false }});
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({{ color: s.timber ? C.timber : C.slab, transparent: true, opacity: s.ground ? 0.35 : 0.55, roughness: 1, side: THREE.DoubleSide }}));
    m.rotation.x = -Math.PI / 2; m.position.y = (s.z - s.t) / 1000; groups.slab.add(m);
  }});
  const tm = new THREE.LineBasicMaterial({{ color: C.truss }}); const pts = [];
  M3.trusses.forEach((t) => t.segs.forEach(([a, b]) => {{
    const at = (n) => t.along === "y" ? P(t.o[0] + n[0], t.o[1], t.z + n[1]) : P(t.o[0], t.o[1] + n[0], t.z + n[1]); pts.push(at(a), at(b));
  }}));
  groups.roof.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), tm));
  const bb = new THREE.Box3().setFromObject(groups.frame), ctr = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
  cam.position.copy(ctr.clone().add(new THREE.Vector3(size.x * 1.1, size.y * 1.6 + 8, size.z * 1.25)));
  const ctl = new THREE.OrbitControls(cam, cv); ctl.target.copy(ctr); ctl.enableDamping = true; ctl.autoRotate = !matchMedia("(prefers-reduced-motion: reduce)").matches; ctl.autoRotateSpeed = 0.6;
  cv.addEventListener("pointerdown", () => (ctl.autoRotate = false));
  const ramp = (u) => new THREE.Color().setHSL(0.6 - 0.6 * Math.min(1, u), 0.75, 0.5);
  const setLeg = (mode) => {{ leg.innerHTML = mode === "type"
    ? `<span><i style="background:${{C.col}}"></i>Columns</span><span><i style="background:${{C.beam}}"></i>Floor &amp; ring beams</span><span><i style="background:${{C.gbeam}}"></i>Ground beams</span><span><i style="background:${{C.pad}}"></i>Footings</span><span><i style="background:${{C.truss}}"></i>Roof trusses</span>`
    : `<span><i style="background:#2a6fe0"></i>lightly used</span><span><i style="background:#22c55e"></i>about half</span><span><i style="background:#e2a10c"></i>working hard</span><span><i style="background:#e0402a"></i>near 100%</span>`; }};
  const mode = (m) => {{ util.forEach((x) => x.m.material.color.set(m === "type" ? x.base : ramp(x.u))); document.getElementById("m-type").setAttribute("aria-pressed", m === "type"); document.getElementById("m-util").setAttribute("aria-pressed", m === "util"); setLeg(m); }};
  document.getElementById("m-type").onclick = () => mode("type"); document.getElementById("m-util").onclick = () => mode("util");
  [["t-slab", "slab"], ["t-roof", "roof"], ["t-pad", "pad"]].forEach(([id, g]) => {{ const b = document.getElementById(id); b.onclick = () => {{ groups[g].visible = !groups[g].visible; b.setAttribute("aria-pressed", groups[g].visible); }}; }});
  setLeg("type");
  const fit = () => {{ const w = cv.clientWidth, h = cv.clientHeight; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }};
  addEventListener("resize", fit); fit();
  (function loop() {{ ctl.update(); renderer.render(scene, cam); requestAnimationFrame(loop); }})();
}})();
</script>"""
open(OUT, "w", encoding="utf-8").write(page)
print(OUT, f"{len(page) / 1e6:.2f} MB", f"concrete {vol_total:.1f} m3, steel {steel} kg, cost {tot[1] / 1e6:.0f}M ({tot[0] / 1e6:.0f}-{tot[2] / 1e6:.0f})", dict(cnt))
