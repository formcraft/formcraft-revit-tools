# The supplementary design checks the visual report's checklist asks for, from the design files only (EC2 / EC8 / EC5 /
# EC6 simplified methods, Uganda values where the code gives them): robustness ties, slenderness and second order,
# beam deflection and cracking, compatibility torsion, strong column / weak beam, infill walls, pad punching and shear,
# truss joints / bracing / uplift, the attic plywood diaphragm, the EC8 period and base shear, the 2.0 kN/m² imposed
# load. Writes <work>/extra_checks.json; report_visual.py reads it for the checklist. Preliminary until signed.
#   python -I scripts/structure/extra-checks.py <work dir> <runs dir> <rc-design json>
import json, sys, math, re
W, O, DJ = sys.argv[1:4]
J = lambda p: json.load(open(p, encoding="utf-8"))
d, plan, built, cfg = J(DJ), J(W + "/plan.json"), J(W + "/build.out.json"), J(W + "/config.json")
run = open(W + "/last_run.txt").read().strip(); res = J(f"{O}/{run}_results.json"); chk = J(f"{O}/{run}_check.json")
trusses = J(W + "/trusses.json")
fck, fyk, Es = 30.0, 500.0, 200000.0; fyd, fcd = fyk / 1.15, 0.85 * fck / 1.5; COVER, LINK = 35, 8
def bars(s):   # "4H16" -> (4, 16)
    m = re.match(r"(\d+)H(\d+)", s.replace(" ", "")); return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
def links(s):  # "H8 @ 100/225" -> (8, 225)
    m = re.match(r"H(\d+)\s*@\s*([\d/]+)", s); return (int(m.group(1)), int(m.group(2).split("/")[-1])) if m else (8, 300)
A = lambda n, db: n * math.pi * db * db / 4
OUT = {}
def put(key, status, summary, rows=None): OUT[key] = {"status": status, "summary": summary, "rows": rows or []}

# ---- geometry: Revit ids of the planned columns and beams (plan ops -> build results, same order per kind)
lev = {l["name"]: l["elevation_mm"] for l in J(W + "/facts.json")["levels"]}; lev.setdefault("S Pad top -0.25", -250)
pops, bops = {}, {}
for o in plan["ops"]: pops.setdefault(o["op"], []).append(o)
for r in built["ops"]: bops.setdefault(r.get("kind"), []).append(r)
COL = {}   # id -> {at, z0, z1}
for o, r in zip(pops.get("column", []), bops.get("column", [])):
    for pt, i in zip(o["points_mm"], r.get("created_ids", [])):
        COL[i] = {"at": tuple(pt), "z0": lev.get(o["level"], 0), "z1": min(lev.get(o["top_level"], 7250), 7250)}
BEAM = {}
for o, r in zip(pops.get("beam", []), bops.get("beam", [])):
    for i in r.get("created_ids", []): BEAM[i] = {"s": tuple(o.get("start_mm", (0, 0))[:2]), "e": tuple(o.get("end_mm", (0, 0))[:2]), "level": o.get("level", "")}
RB = {b["id"]: b for b in res["bars"]}
beams = [dict(b, ground=False) for b in d["beams"]] + [dict(b, ground=True) for b in d["ground_beams"]]
def bdims(b): w, h = map(int, b["size"].split("x")); return w, h

# ---- 1. robustness ties (EC2 9.10.2.3, recommended values: 20 kN/m internal, 70 kN minimum; accidental: fyk, γs = 1)
rows, ok = [], True
for b in beams:
    n, db = bars(b["bottom"]); req = max(20 * b["span_m"], 70); prov = A(n, db) * fyk / 1000
    ok &= prov >= req; rows.append([b["id"], b["size"], b["bottom"], round(req), round(prov), prov >= req])
put("ties", "done" if ok else "partial", f"Continuous bottom bars in every beam act as internal and peripheral ties: {sum(r[5] for r in rows)}/{len(rows)} beams carry the EC2 tie force (20 kN/m of span, at least 70 kN). Lap them full tension length at supports.", rows)

# ---- 2. slenderness and second order (EC2 5.8.3.1 / 5.8.8 nominal curvature), sway frame l0 = 1.2 l
def mrd(b, h, As, N):   # symmetric column: steel couple + concrete (parabolic approximation), kNm
    Nc = 0.567 * fck * b * h / 1000; N = min(max(N, 0), Nc)
    return As / 2 * fyd * (h - 2 * (COVER + LINK + 8)) / 1e6 + N * h / 2000 * (1 - N / Nc)
rows, worst, fails = [], 0, 0
for c in d["columns"]:
    g = COL.get(c["id"]); r = RB.get(c["id"], {}); h = c["size"]; n, db = bars(c["bars"]); As = A(n, db)
    L = (g["z1"] - g["z0"]) if g else 3850; l0 = 1.2 * L; lam = l0 / (h / math.sqrt(12))
    N = r.get("ned_kn", c["N_kN"]); nrel = max(N * 1000 / (h * h * fcd), 0.05); lim = 20 * 0.7 * 1.1 * 0.7 / math.sqrt(nrel)
    e0 = max(l0 / 400, h / 30, 20); M2 = 0
    if lam > lim:
        dd = h - COVER - LINK - db / 2; r0 = fyd / Es / (0.45 * dd); Kphi = max(1, 1 + (0.35 + fck / 200 - lam / 150) * 1.0)
        M2 = N * (Kphi * r0) * l0 * l0 / 10 / 1000   # kNm (e2 in mm -> /1000)
    My, Mz = max(r.get("my_knm", c["M_kNm"]), N * e0 / 1000) + M2, r.get("mz_knm", 0)
    MR = mrd(h, h, As, N); NRd = (0.567 * fck * h * h + As * fyd) / 1000; a = 1 + min(1, max(0, (N / NRd - 0.1) / 0.6))   # EC2 5.8.9 exponent
    u = (My / MR) ** a + (Mz / MR) ** a if MR > 0 else 9
    worst = max(worst, u); fails += u > 1; rows.append([c["id"], f"{h}x{h}", c["bars"], round(L), round(lam, 1), round(lim, 1), round(M2, 1), round(u, 2), u <= 1])
put("slender", "done" if not fails else "partial", f"Slenderness λ = 1.2·l/i against EC2 λlim; second-order moments added by nominal curvature where λ > λlim, biaxial interaction (EC2 5.8.9). Worst ratio {worst:.2f}; {fails} column(s) over 1.0.", rows)

# ---- 3. beam deflection (EC2 7.4.2 span/depth, K = 1.3 continuous) and cracking (EC2 7.3.3, tables 7.2N / 7.3N, wk 0.3)
S72 = [(160, 32), (200, 25), (240, 16), (280, 12), (320, 10), (360, 8), (400, 6), (450, 5)]
S73 = [(160, 300), (200, 250), (240, 200), (280, 150), (320, 100), (360, 50)]
look = lambda tab, s: next((v for k, v in tab if s <= k), tab[-1][1])
rows, fails = [], 0; r0 = math.sqrt(fck) * 1e-3
for b in beams:
    w, h = bdims(b); n, db = bars(b["bottom"]); As = A(n, db); dd = h - 40 - 8 - 10   # as rc-design.py
    Kc = b["M_kNm"] * 1e6 / (w * dd * dd * 25); z = min(0.95 * dd, dd * (0.5 + math.sqrt(max(0.0, 0.25 - Kc / 1.134))))
    Areq = max(b["M_kNm"] * 1e6 / (0.87 * fyk * z), 0.0015 * w * dd); rho = Areq / (w * dd); K = 1.3   # EC2: ρ of the required steel
    ld = K * (11 + 1.5 * math.sqrt(fck) * r0 / rho + (3.2 * math.sqrt(fck) * (r0 / rho - 1) ** 1.5 if rho < r0 else 0)) * min(1.5, As / Areq)
    sig = 0.87 * fyk * 0.69 * min(1, Areq / As)   # quasi-permanent / ULS ≈ 0.69 for these loads
    sp = (w - 2 * (40 + LINK) - db) / max(1, n - 1); crack_ok = db <= look(S72, sig) or sp <= look(S73, sig)
    defl_ok = b["span_m"] * 1000 / dd <= ld; fails += not (defl_ok and crack_ok)
    rows.append([b["id"], b["size"], b["span_m"], round(b["span_m"] * 1000 / dd, 1), round(ld, 1), defl_ok, round(sig), round(sp), crack_ok])
put("defl", "done" if not fails else "partial", f"Span/effective depth within the EC2 limit and crack widths under 0.3 mm by bar size or spacing: {len(rows) - fails}/{len(rows)} beams pass.", rows)

# ---- 4. compatibility torsion in edge beams (EC2 6.3.1(2): minimum closed links and longitudinal bars, 9.2.2 / 9.2.3)
rows, fails = [], 0; rw = 0.08 * math.sqrt(fck) / fyk
for b in [b for b in beams if not b["ground"]]:   # ground beams sit under a slab on ground: no torsion from it
    w, h = bdims(b); ld_, s = links(b["links"]); dd = h - COVER - LINK - 8; Asw = 2 * A(1, ld_)
    smax = min(0.75 * (h - 58), 2 * (w + h) / 8, w, Asw / (rw * w)); okk = s <= smax + 1; fails += not okk
    rows.append([b["id"], b["size"], b["links"], round(smax), okk])
put("torsion", "done" if not fails else "partial", f"Frame beams carry torsion only from compatibility, so EC2 asks for closed links no further apart than u/8, 0.75d and the beam width: {len(rows) - fails}/{len(rows)} beams meet it" + ("" if not fails else "; the rest get links at the spacing listed") + ".", rows)

# ---- 5. strong column / weak beam at first-floor joints (EC8 4.4.2.3(4): ΣMRc ≥ 1.3 ΣMRb; top storey exempt)
cols_at = {}
for c in d["columns"]:
    g = COL.get(c["id"])
    if g: cols_at.setdefault(g["at"], []).append((g, c))
def mrb(b, top):
    w, h = bdims(b); n, db = bars(b["top" if top else "bottom"]); return A(n, db) * fyd * 0.9 * (h - COVER - LINK - db / 2) / 1e6
BD = {b["id"]: b for b in beams}
rows, fails = [], 0
for at, cs in cols_at.items():
    if not any(g["z1"] >= 3800 and g["z0"] < 100 for g, _ in cs) or len(cs) < 2: continue   # joints with a column above and below
    MRc = sum(mrd(c["size"], c["size"], A(*bars(c["bars"])), RB.get(c["id"], {}).get("ned_kn", c["N_kN"])) for _, c in cs)
    for ax in (0, 1):
        fr = [BD[i] for i, g in BEAM.items() if i in BD and g["level"].startswith("FF") and (g["s"] == at or g["e"] == at) and abs(g["s"][1 - ax] - g["e"][1 - ax]) < 50]
        if not fr: continue
        MRb = sum(mrb(b, True) if k == 0 else mrb(b, False) for k, b in enumerate(fr)) if len(fr) > 1 else max(mrb(fr[0], True), mrb(fr[0], False))
        okk = MRc >= 1.3 * MRb; fails += not okk; rows.append([f"{at[0]},{at[1]}", "x" if ax == 0 else "y", round(MRc), round(MRb), round(MRc / max(MRb, 1), 2), okk])
put("scwb", "done" if not fails else "partial", f"Columns stronger than the beams they meet (ΣMRc ≥ 1.3 ΣMRb) at {len(rows) - fails}/{len(rows)} first-floor joints, so a strong earthquake yields beams, not columns." + ("" if not fails else " The others: more column bars or a smaller beam top steel, listed."), rows)

# ---- 6. infill walls: out-of-plane arching (EC6 6.3.2 / Annex), ties to the frame
fd, t, la = 1.0, 0.15, 3.85 - 0.45   # MPa (blockwork fk 2.5 / γM 2.5), thinnest wall, clear height
qcap = fd * 1000 * (t / la) ** 2 * 1.0; qw = 1.5 * 0.75; qe = 1.0 * 2.5 * res["seismic"]["Cd"] * 2.5 * t * 14 / 1.0
put("infill", "done" if qcap >= max(qw, qe) else "partial", f"Thinnest infill (150 mm block, {la:.2f} m clear) arches between beam and slab: {qcap:.2f} kPa capacity against {qw:.2f} kPa wind and {qe:.2f} kPa earthquake out of plane. Galvanised ties into the columns every 450 mm and a 20 mm soft joint under each beam keep the struts the analysis relies on.",
    [["150 block", la, round(qcap, 2), round(qw, 2), round(qe, 2), qcap >= max(qw, qe)]])

# ---- 7. pads: one-way shear and punching (EC2 6.2.2 / 6.4.4)
uls = plan["loads"]["uls_kn"] / plan["loads"]["characteristic_kn"]
csz = {tuple(c["at"]): c["size"] for c in d["columns"]}
rows, fails = [], 0
for p in d["pads"]:
    B, L, H = map(int, p["size"].split("x")); dia, s = (int(x) for x in re.findall(r"H(\d+)\s*@\s*(\d+)", p["bars"])[0])
    c = csz.get(tuple(p["at"]), 300); N = p["N_service_kN"] * uls; sg = N * 1000 / (B * L)   # N/mm2
    dd = H - 75 - dia; rho = min(0.02, A(1, dia) * 1000 / s / (1000 * dd)); k = min(2, 1 + math.sqrt(200 / dd)); vmin = 0.035 * k ** 1.5 * math.sqrt(fck)
    vrc = max(0.12 * k * (100 * rho * fck) ** (1 / 3), vmin)
    V1 = sg * B * max(0, (L - c) / 2 - dd) / 1000; u1 = V1 / (vrc * B * dd / 1000)
    up = 0
    for a in (dd, 2 * dd):
        u = 4 * c + 2 * math.pi * a; Ain = c * c + 4 * c * a + math.pi * a * a; Vr = N - sg * Ain / 1000
        up = max(up, (Vr * 1000 / (u * dd)) / (vrc * 2 * dd / a))
    okk = u1 <= 1 and up <= 1; fails += not okk; rows.append([p["id"], p["size"], c, round(N), round(u1, 2), round(up, 2), okk])
put("punch", "done" if not fails else "partial", f"Every pad checked for one-way shear at d from the column face and punching at d and 2d: worst ratios {max(r[4] for r in rows):.2f} (shear) and {max(r[5] for r in rows):.2f} (punching); {len(rows) - fails}/{len(rows)} pass.", rows)

# ---- 8. trusses: joints (nail plates), bracing, uplift (EC5 / BS 5268-3 practice)
fa = 1.0   # N/mm2 design anchorage of punched metal plates on SG8 (conservative, both faces)
rows = []
for tr in trusses:
    Fmax = max(abs(m["N_kN"]) for m in tr["members"]); Ap = Fmax * 1000 / (2 * fa)   # mm2 per face
    side = math.ceil(math.sqrt(Ap * 2) / 25) * 25
    up = (1.5 * 0.75 * 0.7 - 0.9 * tr["loads"]["g_slope_kn_m2"]) * tr["spacing_mm"] / 1000 * (tr["span_mm"] / 2 + tr["overhang_mm"]) / 1000 / math.cos(math.radians(tr["pitch_deg"]))
    rows.append([tr["name"], round(Fmax, 1), f"{side}x{side} mm plates both faces", round(max(up, 0), 2), "30x2.5 GI strap, 4 nails each end (4 kN)", max(up, 0) <= 4])
put("truss", "done" if all(r[5] for r in rows) else "partial", "Joints: punched metal plates sized for the largest member force at a conservative 1.0 N/mm² anchorage. Uplift under 0.75 kPa wind suction against 0.9 × roof dead load, held by galvanised straps at every truss. Bracing: 25×100 diagonal rafter braces at about 45° on both slopes and longitudinal binders on the ceiling ties (BS 5268-3).", rows)

# ---- 9. attic floor plywood diaphragm (EC5 9.2.3 simplified): seismic shear flow against nailed sheathing
att = cfg.get("attic", {}); area = 12.9 * 21.0
Wd = area * (att.get("g_kn_m2", 0.6) + 0.3 * att.get("q_kn_m2", 2.5)) + area * 0.65 * 1.18   # floor + roof above
F = res["seismic"]["Cd"] * Wd; v = F / 2 / 12.9; nail = 0.55; sp = 150 if nail * 1000 / 150 >= v else 100
put("diaphragm", "done" if nail * 1000 / sp >= v else "partial", f"Attic floor and roof weigh {Wd:.0f} kN; at Cd {res['seismic']['Cd']} the plywood carries {F:.0f} kN to the ring beams, a shear flow of {v:.1f} kN/m. 18 mm ply nailed with 3.35 mm ring-shank nails at {sp} mm on panel edges (about {nail} kN per nail) gives {nail * 1000 / sp:.1f} kN/m; blocking under every edge.",
    [[round(Wd), round(F), round(v, 2), sp, round(nail * 1000 / sp, 2)]])

# ---- 10. EC8 period (Rayleigh) and base shear compared with US 319
V, Fk, Cd = res["seismic"]["V_kn"], res["seismic"]["F_kn"], res["seismic"]["Cd"]
zs = [3.85, 7.25]; Wt = V / Cd; wz = [f / z for f, z in zip(Fk, zs)]; Wi = [Wt * x / sum(wz) for x in wz]
lv = res["levels"]; dl = [sum(n["ux_mm"] for n in res["nodes"] if n["node"] in lv[k]["nodes"]) / max(1, len(lv[k]["nodes"])) for k in ("FF +3.85", "Roof +7.25")]
F125 = [1.25 * f for f in Fk]
T = 2 * math.pi * math.sqrt(sum(w / 9.81 * (x / 1000) ** 2 for w, x in zip(Wi, dl)) / max(1e-9, sum(f * x / 1000 for f, x in zip(F125, dl))))
ag, S, TB, TC, TD, q = 0.10, 1.15, 0.2, 0.6, 2.0, 1.5   # agR assumed 0.10 g (to confirm), ground type C assumed (no soil test yet), DCL
Sd = ag * S * (2 / 3 + T / TB * (2.5 / q - 2 / 3)) if T < TB else ag * S * 2.5 / q if T <= TC else max(0.2 * ag, ag * S * 2.5 / q * TC / T)
Fb = Sd * Wt * (0.85 if T <= 2 * TC else 1)
put("modal", "done" if Fb <= V * 1.0 else "partial", f"Fundamental period T ≈ {T:.2f} s (Rayleigh, from the analysed displacements). EC8 base shear with agR 0.10 g assumed and ground type C assumed (no soil test yet), q 1.5: {Fb:.0f} kN against the {V:.0f} kN designed to US 319, so the design case governs" + ("." if Fb <= V else ": the EC8 value is higher and should be run."), [[round(T, 3), round(Fb), round(V), round(Fb / V, 2)]])

# ---- 11. imposed load 2.0 kN/m² instead of 1.5 (EN 1991-1-1 upper value): column and beam utilisation
q_design = cfg.get("q_floor_min_kn_m2", 1.5)   # config: floors designed to at least this imposed load (robot-run.mjs)
dQ = 0 if q_design >= 2.0 else plan["loads"]["q_kn"] * (2.0 / 1.5 - 1) * 1.5; f = 1 + dQ / plan["loads"]["uls_kn"]
ut = [(r[1], r[0], r[6] * f) for r in chk if isinstance(r, list) and len(r) > 6]
over = [x for x in ut if x[2] > 1.0]
put("q2", "done" if not over else "partial", "Floors designed to 2.0 kN/m² imposed load (EN 1991-1-1 upper value for dwellings), above the 1.5 kN/m² minimum: " + f"worst member at {max(x[2] for x in ut):.2f} of capacity." if q_design >= 2.0 else f"Raising imposed load to 2.0 kN/m² adds {dQ:.0f} kN at ULS ({(f - 1) * 100:.1f}% of the total). Worst member then at {max(x[2] for x in ut):.2f} of capacity" + (": no member exceeds it." if not over else f"; {len(over)} member(s) would need the next size up."), [[x[0], x[1], round(x[2], 2)] for x in sorted(ut, key=lambda x: -x[2])[:10]])

json.dump({"run": run, "checks": OUT}, open(W + "/extra_checks.json", "w", encoding="utf-8"), indent=1)
for k, v in OUT.items(): print(f"{k:10s} {v['status']:8s} {v['summary'][:150]}")
