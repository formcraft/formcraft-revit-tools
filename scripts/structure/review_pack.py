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

today = datetime.date.today().strftime("%d %B %Y")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import review_page
MESHF = cfg.get("review_mesh") or os.path.join(os.path.dirname(os.path.dirname(W)), "_Report", "mesh", "structure.web.json")
mesh = json.load(open(MESHF)) if os.path.exists(MESHF) else None
if mesh: mesh |= {"colors": {"Structural Columns": "#7f8a94", "Structural Framing": "#a9b3bb", "Floors": "#d5d9dc", "Structural Foundations": "#8f969b"},
                  "labels": {"Structural Columns": "Columns", "Structural Framing": "Beams", "Floors": "Slabs", "Structural Foundations": "Pads"}}
meta = {"title": "Ogala Structural Review", "eyebrow": "Formcraft · The Ogala Residence · Structural design · For review by the engineer of record",
        "h1": "Structural design review pack", "intro": f"Prepared by {cfg.get('presenter', 'Emlyn Atochon')}, {cfg.get('firm', 'Formcraft')}, {today} (analysis run {run}). Each section sets out the method, the formulas and every member result.",
        "back": (f'<a href="{e(cfg["project_report"])}">Back to the project report</a>' if cfg.get("project_report") else "") + (f' · <a href="{e(cfg["structure_report_url"])}">The structural design report</a>' if cfg.get("structure_report_url") else ""),
        "signer": "Engineer of record", "statement": "I have reviewed this design, the sections marked accepted are correct to the codes stated, and the corrections noted are to be made before construction.",
        "reglabel": "Registration (ERB) number", "gaps": GAPS}
page = review_page.render(S, meta, mesh)
open(OUT, "w", encoding="utf-8").write(page)
print(OUT, f"{len(page) / 1e6:.2f} MB", len(S), "sections", sum(len(s["rows"]) for s in S), "rows")
