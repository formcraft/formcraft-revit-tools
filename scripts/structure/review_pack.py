# The engineer-of-record review pack: every assumption, load, formula and member result of the structural design, set
# out section by section for the checking engineer, who marks each section Accepted / Needs correction / Query, ticks or
# crosses single rows, writes notes, and signs off at the end. Marks and notes live in the artifact's shared database
# (collection "reviews", one document per section; "signoff/<engineer id>"), so Formcraft reads them back and acts.
# Built only from the design files; rebuilt after every design change (the marks stay, keyed by section and row).
#   python -I scripts/structure/review_pack.py <work dir> <runs dir> <rc-design json> <out html>
import json, sys, os, html, datetime
W, O, DJ, OUT = sys.argv[1:5]
J = lambda p: json.load(open(p, encoding="utf-8")); e = html.escape
d, cfg, plan = J(DJ), J(W + "/config.json"), J(W + "/plan.json")
run = open(W + "/last_run.txt").read().strip(); R, RES = J(f"{O}/{run}.json"), J(f"{O}/{run}_results.json")
CHK = [r for r in J(f"{O}/{run}_check.json") if isinstance(r, list)]
XC = J(W + "/extra_checks.json")["checks"] if os.path.exists(W + "/extra_checks.json") else {}
trusses = J(W + "/trusses.json") if os.path.exists(W + "/trusses.json") else []
stairs = [s for s in (J(W + "/stairs.json") if os.path.exists(W + "/stairs.json") else []) if "waist_mm" in s]
sm = R.get("summary", {}); seis = R.get("cfg", {}).get("seismic", {"C": 0.08, "Z": 0.8, "I": 1.0, "K": 2})
util = {}
for r in CHK: util[r[1]] = max(util.get(r[1], 0), r[6])
S = []   # sections: id, title, intro, equations, columns, rows [[row id, cells...]]
def sec(i, title, intro, eqs, cols, rows): S.append({"id": i, "title": title, "intro": intro, "eqs": eqs, "cols": cols, "rows": [[str(r[0])] + [c if isinstance(c, (int, float, bool)) or c is None else str(c) for c in r[1:]] for r in rows]})

sec("basis", "Basis of design", "Codes, materials and assumptions the whole design rests on. Where Uganda's code is silent or lenient, the Eurocode value is used.", [],
    ["Item", "Value"], [[k, k, v] for k, v in [
        ("Codes", "US 319 (earthquake), EN 1990, EN 1991-1-1 / 1-4, EN 1992-1-1, EN 1998-1 (comparison), EN 1995-1-1, EN 1996-1-1, BS 8666 (bar shapes)"),
        ("Concrete", "C30/37 specified; strength checks use fck 25 MPa (conservative), serviceability fck 30"),
        ("Reinforcement", "B500 (H), fyd = 500 / 1.15 = 435 MPa"), ("Timber", "SG8 (trusses), C24 or durable hardwood ≥ C24 (attic joists), 18 mm structural plywood"),
        ("Covers (nominal)", "beams and columns 40, slabs 25, foundations 50, walls 30 mm: exposure XC1-XC2, 60 min fire"),
        ("Soil", "allowable bearing 150 kPa ASSUMED, pads founded 1.0 m below ground: to be confirmed by the soil test"),
        ("Analysis", f"3D frame (frame3d, own solver), cracked stiffness 0.5 EI, fixed bases, rigid-diaphragm ties, masonry infill as compression struts; run {run}"),
        ("Status", "PRELIMINARY: not for construction until the engineer of record signs this pack")]])

g, q = sm.get("applied_g_kn"), sm.get("applied_q_kn"); se, wi = sm.get("seismic", {}), sm.get("wind", {})
sec("loads", "Loads", "Dead loads come from the real Revit build-ups of every floor, wall and roof (layer by layer). Imposed loads by room use. Wind and earthquake as below.",
    ["Cd = C · Z · I · K = %s · %s · %s · %s = %s" % (seis.get("C"), seis.get("Z"), seis.get("I"), seis.get("K"), se.get("Cd")),
     "V = Cd · W ;  F_i = V · W_i h_i / Σ W_j h_j   (US 319 equivalent static, W = G + 0.25 Q)",
     "q_p = 0.613 · c_e · v_b² / 1000 ;  p = q_p · (c_pe − c_pi)   (EN 1991-1-4, v_b 25 m/s ASSUMED)"],
    ["Load", "Value"], [[k, k, v] for k, v in [
        ("Dead load applied to the frame (G)", f"{g} kN"), ("Imposed load applied (Q)", f"{q} kN"),
        ("Imposed: floors", "2.0 kN/m² (rooms), 2.5 kN/m² (balconies, stairs)"), ("Imposed: attic (storage)", f"{cfg.get('attic', {}).get('q_kn_m2', 2.5)} kN/m², timber floor {cfg.get('attic', {}).get('g_kn_m2', 0.6)} kN/m² dead"),
        ("Roof", "clay tiles on SG8 trusses: 0.65 kN/m² on slope, 0.5 kN/m² imposed on plan"),
        ("Earthquake: Cd", se.get("Cd")), ("Earthquake: storey weights W", " / ".join(f"{x} kN" for x in se.get("W_kn", []))), ("Earthquake: base shear V", f"{se.get('V_kn')} kN"),
        ("Earthquake: storey forces F", " / ".join(f"{x} kN" for x in se.get("F_kn", []))),
        ("Wind: peak pressure q_p", f"{wi.get('qp_kpa')} kPa"), ("Wind: design pressure p", f"{wi.get('p_kpa')} kPa"),
        ("Wind: storey forces X / Y", f"{wi.get('WX_kn')} / {wi.get('WY_kn')} kN")]])
cmb = [c["name"] for c in R["form"].get("combinations", [])]
sec("combos", "Load combinations", "EN 1990 combinations analysed (ψ0 imposed 0.7, wind 0.6; earthquake with γ 1.25 on US 319 forces).", ["E_d = Σ γ_G G + γ_Q,1 Q_1 + Σ γ_Q,i ψ_0,i Q_i"],
    ["Combination"], [[c, c] for c in cmb])
rc = cfg.get("robot_check", {})
sec("model", "Analysis model and independent check", "The frame is analysed by Formcraft's own 3D solver and the final model again in Autodesk Robot; the two must agree.", ["K u = F  (linear elastic, 6 DOF per node);  cracked stiffness 0.5 E_c I"],
    ["Item", "Value"], [[k, k, v] for k, v in [("Nodes / bars / infill struts", f"{sm.get('nodes')} / {sm.get('bars')} / {sm.get('struts')}"), ("Supports", R["form"].get("supports")),
        ("Robot check run", rc.get("run", "pending")), ("Robot: members / max utilisation", f"{rc.get('members', '-')} / {rc.get('max_util', '-')}"), ("Robot: drift GF / FF (mm)", rc.get("drift", "-"))]])
lv = RES.get("levels", {}); K = RES["seismic"]["K"]
disp = {n["node"]: max(n["ux_mm"], n["uy_mm"]) for n in RES.get("nodes", [])}
if lv:
    ff, rf = list(lv.values())[-2], list(lv.values())[-1]
    d1 = max(disp[n] for n in ff["nodes"]) * 5 / K; d2 = max(abs(disp[a] - disp.get(b, 0)) for a, b in RES["stacks"]) * 5 / K
    h1, h2 = ff["elevation_mm"] + 250, rf["elevation_mm"] - ff["elevation_mm"]
    sec("drift", "Storey drift", "Design drift is the elastic drift under the earthquake forces times 5/K (US 319), limited to 1% of the storey height and 60 mm.", ["d = d_e · 5 / K ≤ min(0.010 h, 60 mm)"],
        ["Storey", "Height mm", "Drift mm", "Limit mm", "OK"], [["GF", "Ground floor", h1, round(d1, 1), round(min(0.01 * h1, 60)), d1 <= min(0.01 * h1, 60)], ["FF", "First floor", h2, round(d2, 1), round(min(0.01 * h2, 60)), d2 <= min(0.01 * h2, 60)]])
sec("columns", "Columns: axial and biaxial bending", "Each column at its worst combination: N/N_Rd + M/M_Rd ≤ 1 with the minimum eccentricity; steel 1–3% before a bigger section (least concrete).",
    ["N_Rd = 0.4 f_ck A_c + 0.67 f_yk A_s ;  M_Rd = 0.87 f_yk (A_s/2)(h − 100)", "e_min = max(h/30, 20 mm)"],
    ["Column", "Size", "Bars", "Links", "N_Ed kN", "M_Ed kNm", "Utilisation", "OK"],
    [[c["id"], c["id"], f'{c["size"]}x{c["size"]}', c["bars"], c["links"], round(c["N_kN"] or 0), round(c["M_kNm"] or 0, 1), util.get(c["id"]), (util.get(c["id"]) or 0) <= 1] for c in d["columns"]])
sec("beams", "Beams: bending and shear", "Frame beams from the analysis envelope; singly reinforced (K ≤ 0.156); shear by the variable strut method; links also set by torsion and seismic rules.",
    ["K = M / (b d² f_ck) ≤ 0.156 ;  z = d (0.5 + √(0.25 − K/1.134)) ;  A_s = M / (0.87 f_yk z)", "V_Rd,c = 0.12 k (100 ρ f_ck)^(1/3) b d ;  s = A_sw 0.87 f_yk z cot θ / V_Ed"],
    ["Beam", "Level", "Span m", "Size", "Bottom", "Top", "Links", "M_Ed kNm", "V_Ed kN", "Utilisation", "OK"],
    [[b["id"], b["id"], b.get("level", ""), b["span_m"], b["size"], b["bottom"], b["top"], b["links"], b["M_kNm"], b["V_kN"], util.get(b["id"]), (util.get(b["id"]) or 0) <= 1] for b in d["beams"]])
sec("gbeams", "Ground beams", "Carry the ground-floor walls to the pads; continuous over supports (M = wL²/10).", ["w_Ed = 1.35 (w_wall + 25 b h) ;  M = w L² / 10 ;  V = w L / 2"],
    ["Beam", "Span m", "Size", "Wall kN/m", "Bottom", "Top", "Links", "M_Ed kNm", "V_Ed kN"],
    [[b["id"], b["id"], b["span_m"], b["size"], b["wall_kN_m"], b["bottom"], b["top"], b["links"], b["M_kNm"], b["V_kN"]] for b in d["ground_beams"]])
sec("pads", "Pad foundations: bearing and bending", "Pads sized for 150 kPa (assumed) under service load; bending at the column face.", ["B ≥ √(1.1 N_sls / q_a) ;  M = q c² / 2 per m ;  A_s = M / (0.87 f_yk 0.9 d)"],
    ["Pad", "Size mm", "N service kN", "Pressure kPa", "Bars"], [[p["id"], p["id"], p["size"], p["N_service_kN"], p["pressure_kPa"], p["bars"]] for p in d["pads"]])
sec("slabs", "Slabs", "Suspended slabs by the coefficient method (two-way, continuous edges); ground slabs carry an anti-crack mesh.", ["M = 0.063 n l_x² ;  A_s ≥ 0.0013 b d"],
    ["Slab", "Level", "Thickness mm", "Bars", "Layers"], [[s["id"], s["id"], s["level"], s["t"], s["bars"], s["layers"]] for s in d["slabs"]])
sec("stairs", "Stairs", "Monolithic waist slab spanning between floor and landing beam.", ["M = w L² / 10 per m width"],
    ["Stair", "Risers × mm", "Going mm", "Span mm", "Waist mm", "M kNm/m", "Main bars", "Landing beam"],
    [[s["id"], s["id"], f'{s["risers"]} × {s["riser_mm"]}', s["going_mm"], s["span_mm"], s["waist_mm"], s["M_kNm_per_m"], s["main"], s.get("landing_beam", "")] for s in stairs])
sec("trusses", "Roof trusses (SG8)", "Fink trusses at 600 mm; member forces from a pin-jointed analysis; Uganda allowable stresses for SG8.", ["σ_c / (k_c f_c) ≤ 1 (compression, buckling length = panel) ;  σ_t / f_t ≤ 1"],
    ["Member", "Truss", "Kind", "Length mm", "N kN", "Size", "Utilisation", "OK"],
    [[f'{t["name"]}:{m["member"]}', t["name"], m["kind"], m["length_mm"], m["N_kN"], m["size"], m["util"], m["util"] <= 1] for t in trusses for m in t["members"]])
sec("joists", "Attic timber floor joists", "Joists at 400 mm between the roof-level beams, with a creep allowance on deflection.", ["σ_m = M / W ≤ 0.8 · 24 / 1.3 ;  δ = 5 w L⁴ / (384 E I) · 1.6 ≤ L / 250"],
    ["Span m", "Joist", "Stress ratio", "Deflection mm"], [[j["span_m"], j["span_m"], j["joist"], j["stress_ratio"], j["deflection_mm"]] for j in d["joists"]])
XH = {"ties": (["Beam", "Size", "Bottom bars", "Required kN", "Provided kN", "OK"], ["F_tie = max(20 kN/m · L, 70 kN) ≤ A_s f_yk  (accidental, γ_s = 1)"]),
      "slender": (["Column", "Size", "Bars", "Height mm", "λ", "λ_lim", "M_2 kNm", "Ratio", "OK"], ["λ = l_0 / i, l_0 = 1.2 l ;  λ_lim = 20 A B C / √n", "M_2 = N_Ed e_2, e_2 = (1/r) l_0² / 10 ;  (M_y/M_Ry)^a + (M_z/M_Rz)^a ≤ 1"]),
      "defl": (["Beam", "Size", "Span m", "L/d", "Limit", "Deflection OK", "σ_s MPa", "Bar spacing mm", "Cracking OK"], ["L/d ≤ K [11 + 1.5 √f_ck ρ_0/ρ + 3.2 √f_ck (ρ_0/ρ − 1)^1.5] · A_s,prov/A_s,req", "w_k ≤ 0.3 mm by EC2 tables 7.2N (bar size) or 7.3N (spacing)"]),
      "torsion": (["Beam", "Size", "Links", "s_max mm", "OK"], ["s ≤ min(u/8, 0.75 d, b) ;  ρ_w ≥ 0.08 √f_ck / f_yk"]),
      "scwb": (["Joint (x,y)", "Direction", "ΣM_Rc kNm", "ΣM_Rb kNm", "Ratio", "OK"], ["Σ M_Rc ≥ 1.3 Σ M_Rb  (EN 1998-1 4.4.2.3)"]),
      "infill": (["Wall", "Clear height m", "Capacity kPa", "Wind kPa", "Earthquake kPa", "OK"], ["q_lat = f_d (t / l_a)²  (arching, EN 1996-1-1)"]),
      "punch": (["Pad", "Size", "Column mm", "N_Ed kN", "One-way shear", "Punching", "OK"], ["v_Ed = V_red / (u d) ≤ v_Rd,c · 2d/a at a = d and 2d ;  V_Ed at d from the face ≤ V_Rd,c"]),
      "truss": (["Truss", "F_max kN", "Plates", "Uplift kN", "Strap", "OK"], ["A_plate = F / (2 f_a), f_a = 1.0 N/mm² ;  uplift = (1.5 · 0.75 · 0.7 − 0.9 g) · s · L/2"]),
      "diaphragm": (["W kN", "F kN", "v kN/m", "Nail spacing mm", "Capacity kN/m"], ["F = Cd W ;  v = F / (2 D) ≤ F_v,Rd / s"]),
      "modal": (["T s", "F_b EC8 kN", "V US 319 kN", "Ratio"], ["T = 2π √(Σ m δ² / Σ F δ)  (Rayleigh) ;  F_b = S_d(T) W λ, a_gR 0.10 g and ground C ASSUMED"]),
      "q2": (["Member", "Kind", "Utilisation"], ["N, M scaled by the ULS increase from 1.5 to 2.0 kN/m²"])}
XT = {"ties": "Robustness ties", "slender": "Slenderness and second order", "defl": "Beam deflection and cracking", "torsion": "Compatibility torsion", "scwb": "Strong column / weak beam",
      "infill": "Infill walls", "punch": "Pad punching and one-way shear", "truss": "Truss joints, bracing, uplift", "diaphragm": "Attic plywood diaphragm", "modal": "EC8 period and base shear", "q2": "Imposed load 2.0 kN/m²"}
for k, v in XC.items():
    cols, eqs = XH.get(k, (["Value"], []))
    sec("x_" + k, XT.get(k, k), v["summary"], eqs, cols, [[f"{k}{i}"] + list(r) for i, r in enumerate(v["rows"])])
st = d["steel_kg"]
sec("drawings", "Drawings and bar bending schedules", "The preliminary sheet set S-100 to S-110 (plans, framing, sections, notes and details, member and reinforcement schedules with BS 8666 bar marks) and the BBS workbook.", [],
    ["Item", "Value"], [[k, k, v] for k, v in [("BBS workbook", os.path.basename(DJ).replace("_rc_design.json", "_BBS_preliminary.xlsx")), ("Steel by element (kg)", ", ".join(f"{a} {b}" for a, b in st["by_element"].items())),
        ("Steel by bar size (kg)", ", ".join(f"{a} {b}" for a, b in sorted(st["by_size"].items(), key=lambda x: int(x[0][1:])))), ("Total steel", f"{st['total']} kg")]])
GAPS = ["Soil test: bearing 150 kPa and ground type assumed", "Wind speed: v_b 25 m/s assumed (UNMA value)", "EC8 comparison: site a_gR assumed 0.10 g"]

PAGE = r"""<title>Ogala Structural Review</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* A calculation package for checking: numbered sections (method, formulas, the member table), each with a review strip;
   row ticks inside the tables; the sign-off at the end. Engineering-sheet look: white paper, ink, one blue for actions. */
:root { --paper:#f6f7f8; --panel:#ffffff; --ink:#15191d; --muted:#5a6570; --line:#d6dbe0; --acc:#1f5fbf; --ok:#0b8a3e; --fix:#c2362f; --q:#a86b00; --soft:#eef2f6;
  --sans:"IBM Plex Sans", "Segoe UI", Arial, sans-serif; --mono:"IBM Plex Mono", Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --paper:#101316; --panel:#171b1f; --ink:#e9edf0; --muted:#a3adb7; --line:#2b3238; --acc:#6aa1f0; --ok:#3cc172; --fix:#ef6b63; --q:#e0a63a; --soft:#1d2328; color-scheme:dark } }
:root[data-theme="dark"] { --paper:#101316; --panel:#171b1f; --ink:#e9edf0; --muted:#a3adb7; --line:#2b3238; --acc:#6aa1f0; --ok:#3cc172; --fix:#ef6b63; --q:#e0a63a; --soft:#1d2328; color-scheme:dark }
body { background:var(--paper); color:var(--ink); font:15px/1.55 var(--sans); }
.wrap { max-width:1100px; margin:0 auto; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); padding-block:28px 80px; display:grid; gap:22px; }
header { display:grid; gap:8px; border-bottom:3px solid var(--ink); padding-bottom:16px; }
.eyebrow { font:500 12px var(--mono); letter-spacing:.12em; text-transform:uppercase; color:var(--muted); }
h1 { font:700 clamp(26px, 4vw, 38px)/1.1 var(--sans); margin:0; text-wrap:balance; } h2 { font:700 19px/1.25 var(--sans); margin:0; } p { margin:0; max-width:75ch; }
.bar { position:sticky; top:env(safe-area-inset-top, 0px); z-index:5; background:var(--panel); border:1px solid var(--line); padding:10px 12px; display:flex; flex-wrap:wrap; gap:8px 14px; align-items:center; }
.prog { flex:1 1 220px; height:10px; display:flex; gap:2px; background:var(--soft); border-radius:2px; overflow:hidden; } .prog i { display:block; }
.bar b { font:600 13px var(--mono); } .bar select { font:13px var(--sans); padding:4px 6px; background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:3px; }
.gaps { border-left:4px solid var(--q); background:var(--panel); padding:12px 14px; } .gaps ul { margin:6px 0 0; padding-left:18px; }
.toc { display:flex; flex-wrap:wrap; gap:6px; } .toc a { font:12px var(--mono); color:var(--ink); text-decoration:none; border:1px solid var(--line); padding:3px 7px; border-radius:3px; background:var(--panel); }
.toc a.ok { border-color:var(--ok); color:var(--ok); } .toc a.fix { border-color:var(--fix); color:var(--fix); } .toc a.q { border-color:var(--q); color:var(--q); }
section { background:var(--panel); border:1px solid var(--line); display:grid; gap:12px; padding:16px; min-width:0; scroll-margin-top:70px; }
section.ok { border-left:5px solid var(--ok); } section.fix { border-left:5px solid var(--fix); } section.q { border-left:5px solid var(--q); }
.sh { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; } .sh span { font:500 12px var(--mono); color:var(--muted); }
.eq { display:grid; gap:4px; background:var(--soft); padding:10px 12px; font:13px/1.5 var(--mono); overflow-x:auto; }
.tw { overflow-x:auto; max-height:460px; overflow-y:auto; border:1px solid var(--line); }
table { border-collapse:collapse; width:100%; font-size:13px; } th { position:sticky; top:0; background:var(--panel); text-align:left; font:500 11px var(--mono); text-transform:uppercase; letter-spacing:.05em; color:var(--muted); padding:7px 9px; border-bottom:1px solid var(--line); }
td { padding:6px 9px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; } td.n { text-align:right; font-family:var(--mono); } td.y { color:var(--ok); } td.no { color:var(--fix); font-weight:600; }
tr.rfix td { background:color-mix(in srgb, var(--fix) 10%, transparent); } tr.rok td:first-child { box-shadow:inset 3px 0 var(--ok); }
.rt { display:inline-flex; gap:2px; } .rt button { font:12px var(--mono); width:24px; height:22px; border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:3px; cursor:pointer; padding:0; }
.rt button[aria-pressed="true"][data-v="ok"] { background:var(--ok); color:#fff; border-color:var(--ok); } .rt button[aria-pressed="true"][data-v="fix"] { background:var(--fix); color:#fff; border-color:var(--fix); }
.rv { display:grid; gap:8px; border-top:1px dashed var(--line); padding-top:12px; }
.vb { display:flex; flex-wrap:wrap; gap:6px; } .vb button { font:600 13px var(--sans); padding:6px 12px; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:3px; cursor:pointer; }
.vb button[aria-pressed="true"][data-v="ok"] { background:var(--ok); border-color:var(--ok); color:#fff; } .vb button[aria-pressed="true"][data-v="fix"] { background:var(--fix); border-color:var(--fix); color:#fff; } .vb button[aria-pressed="true"][data-v="q"] { background:var(--q); border-color:var(--q); color:#1b1300; }
textarea, input[type=text], input[type=date] { font:14px var(--sans); width:100%; box-sizing:border-box; padding:8px; border:1px solid var(--line); border-radius:3px; background:var(--panel); color:var(--ink); }
textarea { min-height:64px; resize:vertical; } .who { font:12px var(--mono); color:var(--muted); }
button:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline:2px solid var(--acc); outline-offset:2px; }
.sign { border:2px solid var(--ink); } .sign .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px; } .sign label { display:grid; gap:4px; font-size:13px; color:var(--muted); }
.primary { font:600 14px var(--sans); padding:9px 16px; background:var(--acc); color:#fff; border:0; border-radius:3px; cursor:pointer; justify-self:start; } .primary:disabled { opacity:.5; cursor:not-allowed; }
.signed { display:grid; gap:4px; background:var(--soft); padding:10px 12px; } .note { font-size:13px; color:var(--muted); }
</style>
<div class="wrap">
<header><div class="eyebrow">Formcraft · The Ogala Residence · Structural design · For review by the engineer of record</div>
<h1>Structural design review pack</h1>
<p>Prepared by __PRES__, __FIRM__, __DATE__ (analysis run __RUN__). Each section sets out the method, the formulas and every member result. Mark each section <b>Accepted</b>, <b>Needs correction</b> or <b>Query</b>, tick or cross single rows, and write your notes; they are saved for the design team. When you are satisfied, sign off at the end.</p></header>
<div class="bar" role="status"><b id="cnt"></b><div class="prog" id="prog" aria-hidden="true"></div><label class="note">Show <select id="flt"><option value="all">all sections</option><option value="open">not yet reviewed</option><option value="fix">needs correction or query</option></select></label><span class="note" id="dbn"></span></div>
<div class="gaps"><b>Open data, not yet available</b><ul>__GAPS__</ul></div>
<nav class="toc" id="toc" aria-label="Sections"></nav>
<div id="secs"></div>
<section class="sign" id="signoff"><h2>Engineer of record: sign-off</h2>
<p>I have reviewed this design, the sections marked accepted are correct to the codes stated, and the corrections noted are to be made before construction.</p>
<div id="signedlist"></div>
<div class="grid"><label>Full name<input type="text" id="sg-name" autocomplete="name"></label><label>Registration (ERB) number<input type="text" id="sg-reg"></label><label>Date<input type="date" id="sg-date"></label></div>
<label class="note"><input type="checkbox" id="sg-ok"> I confirm the statement above</label>
<button class="primary" id="sg-btn" disabled>Sign off</button><p class="note" id="sg-msg"></p></section>
</div>
<script>
const SECS = __SECS__;
(async function () {
  const $ = (id) => document.getElementById(id), esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const REV = {};   // section id -> {verdict, note, rows, by, at}
  const fmt = (v) => v === true ? '<td class="y">✓</td>' : v === false ? '<td class="no">✗</td>' : typeof v === "number" ? `<td class="n">${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>` : `<td>${esc(v)}</td>`;
  let db = null, user = null, canWrite = false, me = null;
  function sectionHTML(s, i) {
    const r = REV[s.id] || {}, rows = r.rows || {};
    return `<section id="s-${s.id}" class="${r.verdict || ""}" data-id="${s.id}"><div class="sh"><span>${String(i + 1).padStart(2, "0")}</span><h2>${esc(s.title)}</h2></div><p>${esc(s.intro)}</p>` +
      (s.eqs.length ? `<div class="eq">${s.eqs.map((x) => `<div>${esc(x)}</div>`).join("")}</div>` : "") +
      (s.rows.length ? `<div class="tw"><table><thead><tr><th>Check</th>${s.cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>` + s.rows.map((row) => { const v = rows[row[0]] || "";
        return `<tr class="${v ? "r" + v : ""}"><td><span class="rt" role="group" aria-label="Row ${esc(row[0])}"><button data-s="${s.id}" data-r="${esc(row[0])}" data-v="ok" aria-pressed="${v === "ok"}" title="This row is right" ${canWrite ? "" : "disabled"}>✓</button><button data-s="${s.id}" data-r="${esc(row[0])}" data-v="fix" aria-pressed="${v === "fix"}" title="This row needs correcting" ${canWrite ? "" : "disabled"}>✗</button></span></td>${row.slice(1).map(fmt).join("")}</tr>`; }).join("") + "</tbody></table></div>" : "") +
      `<div class="rv"><div class="vb" role="group" aria-label="Verdict">${[["ok", "Accepted"], ["fix", "Needs correction"], ["q", "Query"]].map(([v, l]) => `<button data-s="${s.id}" data-verdict="${v}" aria-pressed="${r.verdict === v}" ${canWrite ? "" : "disabled"}>${l}</button>`).join("")}</div>
       <textarea data-note="${s.id}" placeholder="Notes and corrections for this section" ${canWrite ? "" : "disabled"}>${esc(r.note || "")}</textarea><div class="who" data-who="${s.id}"></div></div></section>`;
  }
  async function who() {
    const ids = [...new Set(Object.values(REV).map((r) => r.by).filter(Boolean))]; const ps = user && ids.length ? await user.profiles(ids) : {};
    for (const s of SECS) { const r = REV[s.id], el = document.querySelector(`[data-who="${s.id}"]`); if (el) el.textContent = r && r.at ? `Last marked by ${(ps[r.by] && ps[r.by].name) || "a reviewer"} on ${new Date(r.at).toLocaleString()}` : ""; }
  }
  function render() {
    const f = $("flt").value, focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.note : null;
    $("secs").innerHTML = SECS.map((s, i) => { const v = (REV[s.id] || {}).verdict; return f === "all" || (f === "open" && !v) || (f === "fix" && (v === "fix" || v === "q")) ? sectionHTML(s, i) : ""; }).join("");
    const n = { ok: 0, fix: 0, q: 0 }; SECS.forEach((s) => { const v = (REV[s.id] || {}).verdict; if (v) n[v]++; });
    $("cnt").textContent = `${n.ok + n.fix + n.q} / ${SECS.length} reviewed · ${n.ok} accepted · ${n.fix} to correct · ${n.q} queries`;
    $("prog").innerHTML = `<i style="flex:${n.ok};background:var(--ok)"></i><i style="flex:${n.fix};background:var(--fix)"></i><i style="flex:${n.q};background:var(--q)"></i><i style="flex:${SECS.length - n.ok - n.fix - n.q}"></i>`;
    $("toc").innerHTML = SECS.map((s, i) => `<a href="#s-${s.id}" class="${(REV[s.id] || {}).verdict || ""}">${String(i + 1).padStart(2, "0")} ${esc(s.title)}</a>`).join("");
    if (focus) { const t = document.querySelector(`[data-note="${focus}"]`); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
    who();
  }
  // one write at a time per section document
  const queue = {};
  async function save(id) {
    if (!db || !canWrite) return;
    if (queue[id]) { queue[id].again = true; return; } queue[id] = { again: false };
    try { do { queue[id].again = false; await db.doc("reviews/" + id).set(Object.assign({}, REV[id], { by: me, at: new Date().toISOString() })); } while (queue[id].again); $("dbn").textContent = "Saved"; }
    catch (x) { $("dbn").textContent = x && x.code === "invalid_argument" ? "You can read this pack but not mark it" : "Could not save: try again"; }
    delete queue[id];
  }
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-verdict]"); if (b) { const r = REV[b.dataset.s] = REV[b.dataset.s] || {}; r.verdict = r.verdict === b.dataset.verdict ? "" : b.dataset.verdict; render(); save(b.dataset.s); return; }
    const t = ev.target.closest(".rt button"); if (t) { const r = REV[t.dataset.s] = REV[t.dataset.s] || {}; r.rows = Object.assign({}, r.rows); r.rows[t.dataset.r] = r.rows[t.dataset.r] === t.dataset.v ? "" : t.dataset.v; render(); save(t.dataset.s); }
  });
  const timers = {};
  document.addEventListener("input", (ev) => { const n = ev.target.dataset && ev.target.dataset.note; if (!n) return; (REV[n] = REV[n] || {}).note = ev.target.value; clearTimeout(timers[n]); timers[n] = setTimeout(() => save(n), 900); });
  $("flt").onchange = render;
  render();
  // shared marks and sign-offs (database); the pack still reads without it
  [db, user] = await Promise.all([claude.use("db"), claude.use("user")]);
  if (!db) { $("dbn").textContent = "Marks cannot be saved in this view"; return; }
  me = user ? await user.id() : null; const cw = user ? await user.can("data.write") : null; canWrite = !!me && cw !== false;
  $("dbn").textContent = canWrite ? "Your marks save as you go" : "Read-only: ask Formcraft for reviewer access";
  db.collection("reviews").onSnapshot((snap) => {
    let changed = false;
    snap.docChanges().forEach((c) => { if (queue[c.doc.id]) return; if (c.type === "removed") delete REV[c.doc.id]; else REV[c.doc.id] = Object.assign({}, c.doc.data()); changed = true; });
    if (changed) render();
  }, () => { $("dbn").textContent = "Marks are not updating: reload the page"; });
  db.collection("signoff").onSnapshot(async (snap) => {
    const ss = snap.docs.map((x) => x.data()); const ps = user ? await user.profiles(snap.docs.map((x) => x.id)) : {};
    $("signedlist").innerHTML = ss.map((x, i) => `<div class="signed"><b>Signed: ${esc(x.name)}, ERB ${esc(x.reg)}, ${esc(x.date)}</b><span class="note">by ${esc((ps[snap.docs[i].id] || {}).name || "the account holder")}; ${esc(x.summary)}</span></div>`).join("");
  }, () => {});
  const chk = () => { $("sg-btn").disabled = !(canWrite && $("sg-ok").checked && $("sg-name").value.trim() && $("sg-reg").value.trim() && $("sg-date").value); };
  ["sg-ok", "sg-name", "sg-reg", "sg-date"].forEach((id) => $(id).addEventListener("input", chk)); $("sg-ok").addEventListener("change", chk);
  $("sg-btn").onclick = async () => {
    const n = { ok: 0, fix: 0, q: 0 }; SECS.forEach((s) => { const v = (REV[s.id] || {}).verdict; if (v) n[v]++; });
    try { await db.doc("signoff/" + me).set({ name: $("sg-name").value.trim(), reg: $("sg-reg").value.trim(), date: $("sg-date").value, at: new Date().toISOString(), summary: `${n.ok} sections accepted, ${n.fix} to correct, ${n.q} queries of ${SECS.length}` }); $("sg-msg").textContent = "Signed off and saved."; }
    catch (x) { $("sg-msg").textContent = "The sign-off could not be saved."; }
  };
})();
</script>"""
today = datetime.date.today().strftime("%d %B %Y")
page = (PAGE.replace("__SECS__", json.dumps(S, separators=(",", ":"), ensure_ascii=False).replace("</", "<\\/")).replace("__PRES__", e(cfg.get("presenter", "Emlyn Atochon")))
        .replace("__FIRM__", e(cfg.get("firm", "Formcraft"))).replace("__DATE__", today).replace("__RUN__", e(run)).replace("__GAPS__", "".join(f"<li>{e(x)}</li>" for x in GAPS)))
open(OUT, "w", encoding="utf-8").write(page)
print(OUT, f"{len(page) / 1e6:.2f} MB", len(S), "sections", sum(len(s["rows"]) for s in S), "rows")
