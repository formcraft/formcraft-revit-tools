# The structural design report as one HTML page (client summary in plain words + engineering appendix + an objective
# completeness checklist), built from the design files so it is regenerated with every revision.
#   python -I scripts/structure/report.py <work dir> <robot runs dir> <rc-design json> <out html>
import json, sys, os, math, collections, html, datetime
W, O, DJ, OUT = sys.argv[1:5]
J = lambda p: json.load(open(p, encoding="utf-8"))
facts, plan, built = J(W + "/facts.json"), J(W + "/plan.json"), J(W + "/build.out.json")
sizes = J(W + "/sizes.json"); d = J(DJ); run = open(W + "/last_run.txt").read().strip()
res = J(f"{O}/{run}_results.json"); chk = J(f"{O}/{run}_check.json"); runj = J(f"{O}/{run}.json")
trusses = J(W + "/trusses.json") if os.path.exists(W + "/trusses.json") else []
stairs = J(W + "/stairs.json") if os.path.exists(W + "/stairs.json") else []
cfg = J(W + "/config.json") if os.path.exists(W + "/config.json") else {}
EL = {l["name"]: l["elevation_mm"] for l in facts["levels"]}
pairs = list(zip(plan["ops"], built["ops"][2:]))
if os.path.exists(W + "/extra.json") and os.path.exists(W + "/extra.out.json"):
    pairs += list(zip(J(W + "/extra.json"), J(W + "/extra.out.json")["ops"]))
e = html.escape

# ---- quantities from the final sizes
vol = collections.Counter(); PAD_TOP = -250
cols, beams = [], []
for o, r in pairs:
    for j, i in enumerate(r.get("created_ids", []) if r else []):
        if o["op"] == "column":
            b, h = sizes.get(str(i), o["size_mm"]); z0 = PAD_TOP if o["level"].startswith("S Pad") else EL[o["level"]]
            vol["Columns"] += b * h * (EL[o["top_level"]] - z0) / 1e9; cols.append((o["points_mm"][j], b))
        if o["op"] == "beam":
            b, h = sizes.get(str(i), o["size_mm"]); L = math.dist(o["start_mm"][:2], o["end_mm"][:2]); g = EL[o["level"]] < 500
            vol["Ground beams" if g else "Beams (below slab)"] += b * max(0, h - (0 if g else 200)) * L / 1e9; beams.append((o["start_mm"], o["end_mm"], o["level"], b, h))
for p in d["pads"]:
    B, _, t = map(int, p["size"].split("x")); vol["Pads"] += B * B * t / 1e9
for sl in plan["plan"]["slabs"]:
    if sl["level"] == (cfg.get("attic") or {}).get("level"): continue
    lp = sl["loops_mm"][0]; A = abs(sum(lp[i][0] * lp[(i + 1) % len(lp)][1] - lp[(i + 1) % len(lp)][0] * lp[i][1] for i in range(len(lp)))) / 2e6
    vol["Slabs (ground)" if sl["on_ground"] else "Slabs (suspended)"] += A * sl["thickness_mm"] / 1000
vol_total = sum(vol.values()); steel = d["steel_kg"]["total"]
stairs_rc = [s for s in stairs if "waist_mm" in s]
if stairs_rc: vol["Stair"] = 2 * stairs_rc[0]["flight_width_mm"] / 1000 * stairs_rc[0]["span_mm"] / 1000 * (stairs_rc[0]["waist_mm"] + 85) / 1000; vol_total = sum(vol.values())

# ---- analysis numbers
seis = res.get("seismic", {}); lv = list(res["levels"].values())
disp = {n["node"]: max(n["ux_mm"], n["uy_mm"]) for n in res["nodes"]}; f = 5 / seis.get("K", 2)
d1 = max(disp[n] for n in lv[0]["nodes"]) * f; h1 = lv[0]["elevation_mm"] + 250
d2 = max(abs(disp[a] - disp.get(b, 0)) for a, b in res["stacks"]) * f; h2 = lv[1]["elevation_mm"] - lv[0]["elevation_mm"]
umax = {k: max(x[6] for x in chk if x[0] == k) for k in ("beam", "column")}
col_sizes = collections.Counter(x[8] for x in chk if x[0] == "column"); beam_sizes = collections.Counter(x[8] for x in chk if x[0] == "beam")
wind = next((c for c in runj["form"]["cases"] if c["name"] == "WX"), None)

# ---- plan drawing (first floor framing + pads), from the real coordinates
pts = [c[0] for c in cols]; xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
x0, x1, y0, y1 = min(xs) - 1500, max(xs) + 1500, min(ys) - 1500, max(ys) + 1500
S = 520 / (x1 - x0); Wd, Hd = 520, (y1 - y0) * S
P = lambda p: (round((p[0] - x0) * S, 1), round(Hd - (p[1] - y0) * S, 1))
def plan_svg(level, title):
    s = [f'<svg viewBox="0 0 {Wd} {Hd + 30:.0f}" role="img" aria-label="{e(title)}" class="plan">']
    for sl in plan["plan"]["slabs"]:
        if sl["level"] == level: s.append('<polygon class="slab" points="' + " ".join("%s,%s" % P(q) for q in sl["loops_mm"][0]) + '"/>')
    for a, b, lvl, bw, h in beams:
        if lvl == level: (ax, ay), (bx, by) = P(a), P(b); s.append(f'<line class="beam" x1="{ax}" y1="{ay}" x2="{bx}" y2="{by}" stroke-width="{max(1.5, bw * S):.1f}"/>')
    if level.startswith("Site"):
        for p2 in d["pads"]:
            B = int(p2["size"].split("x")[0]) * S; cx, cy = P(p2["at"]); s.append(f'<rect class="pad" x="{cx - B / 2:.1f}" y="{cy - B / 2:.1f}" width="{B:.1f}" height="{B:.1f}"/>')
    for (p2, a) in cols:
        cx, cy = P(p2); w = max(3, a * S); s.append(f'<rect class="col" x="{cx - w / 2:.1f}" y="{cy - w / 2:.1f}" width="{w:.1f}" height="{w:.1f}"/>')
    s.append(f'<text x="0" y="{Hd + 22:.0f}" class="cap">{e(title)}</text></svg>')
    return "".join(s)
gb = [k for k in EL if k.startswith("Site")][0]

# ---- the objective checklist (done / partial / not done)
CH = [
 ("Loads", "Dead loads from the real build-ups (kit unit weights)", "done", "Takedown from the architecture model's layers; stone walls 22 kN/m3."),
 ("Loads", "Imposed loads", "partial", "Residential 1.5 kN/m2 (Uganda/EN 1991 cat. A lower value). International practice often uses 2.0 kN/m2 (UK NA, ACI/ASCE about 1.9): checking at 2.0 is a cheap margin and is recommended."),
 ("Loads", "Wind", "partial", "EN 1991-1-4 simplified, basic speed 25 m/s ASSUMED; needs the UNMA site value. Wind is about 15% of the seismic force, so it does not govern."),
 ("Loads", "Earthquake", "partial", "US 319 equivalent static method (Cd 0.128, base shear about 865 kN). Eurocode 8 would add a modal response-spectrum check and accidental torsion (5% eccentricity): not done."),
 ("Loads", "Load combinations", "done", "ULS 1.35G+1.5Q; G+1.3Q +/-1.25E; 0.9G +/-1.25E; wind with psi0 (EN 1990); SLS G+Q."),
 ("Loads", "Robustness ties and notional (imperfection) loads", "not", "EC2 9.10 ties and 5.2 imperfections not checked; ring beams and ground beams give peripheral ties."),
 ("Analysis", "3D frame model with slabs as diaphragms and masonry infill", "done", "Own solver (frame3d), cracked stiffness 0.5 EI; diaphragm ties; infill as diagonal struts."),
 ("Analysis", "Independent check in Robot Structural Analysis", "partial", "Earlier gravity runs in Robot agreed; the final model's Robot run is pending (Robot was blocked by dialogs)."),
 ("Analysis", "Storey drift", "done", f"{d1:.1f} mm vs {min(0.01 * h1, 60):.0f} mm (ground storey); {d2:.1f} mm vs {min(0.01 * h2, 60):.0f} mm (first storey)."),
 ("Analysis", "Second-order (P-delta) and column slenderness", "partial", "Minimum eccentricity included; slenderness not checked explicitly (columns are short and braced by infill and slabs)."),
 ("Members", "Beams: bending and shear", "done", f"Highest utilisation {umax['beam']:.2f}; links from the shear check."),
 ("Members", "Beams: deflection and crack control", "partial", "Span/depth rules and bar spacing only; no calculated deflection or crack widths."),
 ("Members", "Beams: torsion (edge beams)", "not", "Not checked; edge beams carry no cantilever except the portico, which has its own columns."),
 ("Members", "Columns: axial + biaxial bending", "done", f"Highest utilisation {umax['column']:.2f}; steel 1-3% before upsizing."),
 ("Members", "Columns: ductile (earthquake) detailing", "partial", "Close links at column ends (100 c/c, 600 mm); strong-column/weak-beam and joint shear not checked."),
 ("Members", "Slabs", "done", "200 mm suspended slab, two-way coefficients, minimum steel governs; reinforcement plan S-107."),
 ("Members", "Stairs", "done", "U stair, 150 waist, landing beam and stub columns; details S-108."),
 ("Members", "Masonry infill: in-plane and out-of-plane strength", "not", "Infill stiffness is used; its own strength and wall ties need an engineer's check."),
 ("Foundations", "Pad bearing and bending", "done", "Bearing at 150 kPa ASSUMED; largest service pressure " + str(max(p["pressure_kPa"] for p in d["pads"])) + " kPa."),
 ("Foundations", "Pad punching and one-way shear", "not", "Not checked; pad depths follow 0.3 x width, normally adequate at these loads."),
 ("Foundations", "Geotechnical investigation", "not", "Required by the Building Control Regulations before foundation design: trial pits to confirm 150 kPa and the founding depth."),
 ("Foundations", "Settlement", "not", "Not checked; depends on the soil report."),
 ("Roof", "Timber trusses", "done", "Fink trusses @ 600, SG8, members checked; S-104 and S-105."),
 ("Roof", "Truss joints, bracing and uplift straps", "partial", "Straps and anchors specified; nail-plate design by the fabricator; longitudinal and diagonal bracing to be detailed."),
 ("Roof", "Attic timber floor and plywood diaphragm", "partial", "Joist sizes designed; plywood nailing schedule to be specified."),
 ("Durability & fire", "Covers for exposure and 60-minute fire", "done", "Covers 25-50 mm; member sizes meet EC2 tabulated minimums for R60."),
 ("Deliverables", "Drawings", "partial", "S-001 notes; S-100 foundations; S-101/102 framing; S-103 3D; S-104/105 roof; S-106 typical details; S-107 slab; S-108 stair; S-109 member schedules; grid dimensions on the plans. Missing: building sections and bar marks on the drawings (bars are fully listed in the BBS)."),
 ("Deliverables", "Bar bending schedules (BS 8666)", "done", f"Every element; {steel / 1000:.1f} t; lengths include laps and anchorage (shape codes 00, 11, 51)."),
 ("Deliverables", "Design report", "done", "This document."),
 ("Deliverables", "Engineer of record review and signature", "not", "Required before construction and for the building permit."),
]
chips = {"done": ("Done", "ok"), "partial": ("Partial", "warn"), "not": ("Not done", "bad")}
cnt = collections.Counter(c[2] for c in CH)

def table(head, rows, cls=""):
    return f'<div class="tw"><table class="{cls}"><thead><tr>' + "".join(f"<th>{e(h)}</th>" for h in head) + "</tr></thead><tbody>" + \
        "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows) + "</tbody></table></div>"

today = datetime.date.today().isoformat()
col_rows = [[e(f"{s} ({n})"), e(", ".join(sorted({c['bars'] for c in d['columns'] if f'{c['size']}x{c['size']}' == s})) or "-")] for s, n in sorted(col_sizes.items())]
beam_rows = [[e(f"{s}"), str(n)] for s, n in sorted(beam_sizes.items(), key=lambda x: (int(x[0].split('x')[0]), int(x[0].split('x')[1])))]
pad_rows = [[e(s), str(n)] for s, n in sorted(collections.Counter(p["size"] for p in d["pads"]).items(), key=lambda x: int(x[0].split("x")[0]))]
truss_rows = [[e(t["name"]), f"{t['span_mm'] / 1000:.1f} m", f"{t['pitch_deg']}°", str(t["count"]), e(t["sizes"]["top"]), e(t["sizes"]["bottom"]), e(t["sizes"]["web"])] for t in trusses]
joist_rows = [[f"{j['span_m']} m", e(j["joist"])] for j in d.get("joists", [])]
steel_rows = [[e(k), f"{v:,} kg"] for k, v in d["steel_kg"]["by_element"].items()]
vol_rows = [[e(k), f"{v:.1f} m³"] for k, v in vol.items()]
check_rows = [[e(a), e(b), f'<span class="chip {chips[c][1]}">{chips[c][0]}</span>', e(n)] for a, b, c, n in CH]
sheets = [("S-001", "General notes"), ("S-100", "Foundation and ground beam plan"), ("S-101", "First floor framing plan"), ("S-102", "Roof-level (ring beam) framing plan"),
          ("S-103", "RC frame 3D"), ("S-104", "Roof framing plan (trusses)"), ("S-105", "Roof truss elevations"), ("S-106", "Typical reinforcement details"),
          ("S-107", "First floor slab reinforcement plan"), ("S-108", "Stair details"), ("S-109", "Member schedules")]
st = stairs_rc[0] if stairs_rc else None

page = f"""<title>Ogala Structural Design</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo+Narrow:wght@500;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a drawing-office report - one reading column, a title block header, plans set like sheet thumbnails */
:root {{
  --paper:#f6f7f8; --ink:#1d2329; --muted:#5b6670; --line:#d5dbe0; --panel:#ffffff;
  --steel:#2f5d7c; --slab:#dfe8ef; --beam:#b0413e; --pad:#c9b48a;
  --ok:#2e7d4f; --warn:#a86a00; --bad:#b3261e;
  --display:"Archivo Narrow", "Arial Narrow", Arial, sans-serif; --body:"Source Serif 4", Georgia, serif; --mono:"IBM Plex Mono", Consolas, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --paper:#14181c; --ink:#e4e8ec; --muted:#9aa6b1; --line:#2c343b; --panel:#1b2026; --steel:#7fb0d3; --slab:#22303b; --beam:#e2736d; --pad:#8a7a55; --ok:#5cc28a; --warn:#e0a63a; --bad:#ef7a72; color-scheme: dark }} }}
:root[data-theme="dark"] {{ --paper:#14181c; --ink:#e4e8ec; --muted:#9aa6b1; --line:#2c343b; --panel:#1b2026; --steel:#7fb0d3; --slab:#22303b; --beam:#e2736d; --pad:#8a7a55; --ok:#5cc28a; --warn:#e0a63a; --bad:#ef7a72; color-scheme: dark }}
body {{ background:var(--paper); color:var(--ink); font:17px/1.6 var(--body); }}
.wrap {{ max-width:860px; margin:0 auto; padding-block:28px 64px; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); display:grid; gap:34px; }}
h1, h2, h3 {{ font-family:var(--display); text-wrap:balance; line-height:1.15; margin:0; }}
h1 {{ font-size:clamp(30px, 6vw, 44px); letter-spacing:.01em; }}
h2 {{ font-size:26px; border-top:2px solid var(--ink); padding-top:10px; }}
h3 {{ font-size:19px; color:var(--steel); }}
p {{ margin:0; max-width:66ch; }} section {{ display:grid; gap:14px; min-width:0; }}
.tb {{ display:grid; grid-template-columns:1fr auto; gap:6px 24px; border:2px solid var(--ink); padding:14px 16px; background:var(--panel); }}
.tb .k {{ font:500 11px/1.4 var(--mono); text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }}
.tb .v {{ font:500 14px/1.4 var(--mono); }}
.stamp {{ font:700 13px/1.3 var(--display); letter-spacing:.12em; text-transform:uppercase; color:var(--bad); border:2px solid var(--bad); padding:6px 10px; justify-self:start; }}
.figs {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:1px; background:var(--line); border:1px solid var(--line); }}
.fig {{ background:var(--panel); padding:12px 14px; display:grid; gap:2px; }}
.fig b {{ font:700 26px/1.1 var(--display); font-variant-numeric:tabular-nums; }}
.fig span {{ font:12px/1.35 var(--mono); color:var(--muted); }}
.plain {{ display:grid; gap:12px; }} .plain p strong {{ font-family:var(--display); letter-spacing:.02em; }}
.tw {{ overflow-x:auto; border:1px solid var(--line); background:var(--panel); }}
table {{ border-collapse:collapse; width:100%; font:14px/1.45 var(--body); }}
th {{ text-align:left; font:500 11px/1.3 var(--mono); text-transform:uppercase; letter-spacing:.07em; color:var(--muted); padding:8px 10px; border-bottom:1px solid var(--line); }}
td {{ padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; font-variant-numeric:tabular-nums; }}
tr:last-child td {{ border-bottom:0; }}
.chip {{ font:500 11px/1 var(--mono); letter-spacing:.05em; text-transform:uppercase; padding:4px 7px; border:1px solid currentColor; white-space:nowrap; }}
.ok {{ color:var(--ok); }} .warn {{ color:var(--warn); }} .bad {{ color:var(--bad); }}
.plans {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:18px; }}
.plans figure {{ margin:0; border:1px solid var(--line); background:var(--panel); padding:10px; min-width:0; }}
svg.plan {{ width:100%; height:auto; display:block; }}
.plan .slab {{ fill:var(--slab); stroke:var(--steel); stroke-width:.6; }} .plan .beam {{ stroke:var(--beam); stroke-linecap:square; }}
.plan .col {{ fill:var(--ink); }} .plan .pad {{ fill:var(--pad); fill-opacity:.55; stroke:var(--ink); stroke-width:.4; }} .plan .cap {{ fill:var(--muted); font:11px var(--mono); }}
.two {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:18px; }} .two > * {{ min-width:0; }}
.note {{ font-size:15px; color:var(--muted); }}
code, .mono {{ font-family:var(--mono); font-size:.88em; }}
</style>
<div class="wrap">
<header class="tb">
  <div><div class="k">Formcraft · Structural design report</div><h1>The Ogala Residence: main house structure</h1></div>
  <div class="stamp">Preliminary<br>not for construction</div>
  <div><div class="k">Basis</div><div class="v">Architecture model OGL_A_MainHouse_GF_LOD400 · analysis run {e(run)}</div></div>
  <div><div class="k">Date</div><div class="v">{today}</div></div>
</header>

<section class="plain">
<h2>In plain words</h2>
<p><strong>What holds the house up.</strong> Think of the house as a body. The <em>skeleton</em> is a frame of reinforced-concrete posts (columns) and beams. It stands on concrete "feet" (pad footings) set at least a metre into the ground, joined by beams at ground level so the feet cannot drift apart. The stone and block walls fill the frame like muscle: they are built tight into it and help it stay stiff when the ground shakes. The first floor is a solid concrete slab that ties every column together at that level. Above it, the attic floor and the roof are timber: lighter, cheaper, and easy to build.</p>
<p><strong>What we planned for.</strong> The weight of the house itself (concrete, stone, tiles, finishes); people, furniture and stored things; wind pushing on the walls and roof; and an earthquake of the size Uganda's code expects for Kampala. Every part was tested against the worst of these happening together, with safety factors on top as the code requires.</p>
<p><strong>Why it is economical.</strong> We started every column at the smallest size the code allows (23 cm square) and only made a part bigger where the calculation demanded it. Where a column was short of strength we first added more steel bars, before making it bigger. The stone walls do real structural work, so no heavy concrete walls are needed. The attic is timber instead of concrete, which removes about 48 m³ of concrete and makes the whole house lighter in an earthquake.</p>
<p><strong>What still has to happen before building.</strong> A soil test (trial pits) to confirm the ground can carry 150 kN/m², the wind speed for the site from the Meteorological Authority, and a registered structural engineer to check and sign the design. Until then these drawings are preliminary.</p>
</section>

<section>
<h2>Key figures</h2>
<div class="figs">
  <div class="fig"><b>{vol_total:.0f} m³</b><span>concrete, all elements</span></div>
  <div class="fig"><b>{steel / 1000:.1f} t</b><span>reinforcing steel (BS 8666 schedules)</span></div>
  <div class="fig"><b>{min(int(s.split('x')[0]) for s in col_sizes)}–{max(int(s.split('x')[0]) for s in col_sizes)} mm</b><span>column sizes (square), {sum(col_sizes.values())} column lengths</span></div>
  <div class="fig"><b>{seis.get('V_kn', 0):.0f} kN</b><span>earthquake base shear (Cd {seis.get('Cd', 0)})</span></div>
  <div class="fig"><b>{d2:.0f} / {min(0.01 * h2, 60):.0f} mm</b><span>first-storey drift / limit</span></div>
  <div class="fig"><b>{cnt['done']} · {cnt['partial']} · {cnt['not']}</b><span>checklist: done · partial · not done</span></div>
</div>
</section>

<section>
<h2>The structure</h2>
<div class="plans">
<figure>{plan_svg("FF +3.85", "First floor (+3.85): slab, beams, columns")}</figure>
<figure>{plan_svg(gb, "Ground: pads, ground beams, columns")}</figure>
</div>
<p class="note">Columns are drawn to size. Beam line weight shows beam width. The entrance portico (three RC columns south of grid A, with its balcony beam) is part of the frame.</p>
</section>

<section>
<h2>Design basis</h2>
{table(["Item", "Value"], [
 ["Codes", "Uganda National Building (Structural Design) Code 2019; EN 1990 combinations; EN 1991 loads; EN 1992 concrete (simplified); US 319 seismic; Building Control Regulations timber schedule 16"],
 ["Concrete / steel", "C30/37 specified (checks with f<sub>ck</sub> 25 MPa, conservative); B500 (H) bars; covers beams/columns 40, slabs 25, foundations 50 mm"],
 ["Floor loads", "FF slab dead 6.8–7.0 kN/m² · imposed 1.5 (residential), balconies 2.5, stairs 2.0"],
 ["Attic / roof", "Attic timber floor 0.6 kN/m² + 2.5 storage · roof 1.0 kN/m² plan + 0.5 imposed"],
 ["Wind", f"v<sub>b</sub> {25} m/s assumed · q<sub>p</sub> 0.63 kPa · net 0.75 kPa · total about 128 kN (X) and 73 kN (Y), below the earthquake forces"],
 ["Earthquake", "Cd = C·Z·I·K = 0.08 × 0.8 × 1.0 × 2 = 0.128 (Kampala zone 2, dwelling, RC frame with masonry infill); T₁ = 0.06H = 0.44 s"],
 ["Combinations", "1.35G+1.5Q · G+1.3Q±1.25E · 0.9G±1.25E · 1.35G+1.5Q±0.9W · 1.35G+1.05Q±1.5W · G±1.5W · SLS G+Q"],
 ["Foundations", "Pads at ≥1.0 m on 150 kPa allowable (assumed until the soil test), tied by ground beams"],
])}
</section>

<section>
<h2>Analysis</h2>
<p>A 3D model of the frame ({len(runj['bars'])} members incl. analysis-only ties) was solved for every load case and combination with Formcraft's frame solver: linear elastic, cracked flexural stiffness 0.5 EI. The floor slab and the attic deck are modelled as diaphragms by in-plane ties between the column heads. The stone and block walls are modelled as diagonal struts (masonry E 3 GPa, width 0.15 × diagonal). Supports are fixed at the pad tops. Earlier gravity runs in Robot Structural Analysis gave matching results; the final model's Robot check is pending. The X-shaped members in the analysis model are these ties and struts only: nothing is built from them.</p>
{table(["Result", "Value", "Limit / note"], [
 ["Storey drift, ground", f"{d1:.1f} mm", f"{min(0.01 * h1, 60):.0f} mm (0.010 h)"],
 ["Storey drift, first floor", f"{d2:.1f} mm", f"{min(0.01 * h2, 60):.0f} mm (0.010 h)"],
 ["Highest beam utilisation", f"{umax['beam']:.2f}", "≤ 1.00 (bending, shear)"],
 ["Highest column utilisation", f"{umax['column']:.2f}", "≤ 1.00 (axial + biaxial bending)"],
 ["Earthquake storey forces", " / ".join(f"{x:.0f}" for x in seis.get("F_kn", [])) + " kN", "first floor / roof level"],
])}
</section>

<section>
<h2>Member schedules</h2>
<div class="two">
<div><h3>Columns</h3>{table(["Size (count)", "Vertical bars"], col_rows)}</div>
<div><h3>Beams (floor and ring)</h3>{table(["Size b×h", "Count"], beam_rows)}</div>
<div><h3>Pad footings</h3>{table(["Size B×B×h", "Count"], pad_rows)}</div>
<div><h3>Concrete volumes</h3>{table(["Element", "Volume"], vol_rows + [["<b>Total</b>", f"<b>{vol_total:.1f} m³</b>"]])}</div>
<div><h3>Reinforcement</h3>{table(["Element", "Mass"], steel_rows + [["<b>Total</b>", f"<b>{steel:,} kg</b>"]])}</div>
<div><h3>Attic floor joists (SG8, @ 400)</h3>{table(["Span", "Joist"], joist_rows)}</div>
</div>
<h3>Roof trusses (Fink, SG8 treated, @ 600)</h3>
{table(["Type", "Span", "Pitch", "No.", "Top chord", "Bottom chord", "Webs"], truss_rows)}
{"<h3>Main stair</h3><p>" + e(f"U stair, {st['risers']} risers × {st['riser_mm']} mm, goings {st['going_mm']} mm, waist {st['waist_mm']} mm, main bars {st['main']}, distribution {st['distribution']}; landing beam {st['landing_beam']}.") + "</p>" if st else ""}
<p class="note">Every bar is in the bar bending schedules (BS 8666): 20261028_OGL_BBS_preliminary.xlsx, one sheet per element type.</p>
</section>

<section>
<h2>Completeness checklist</h2>
<p>Measured against the Ugandan code and, where it is lenient, against Eurocode and ACI practice. "Partial" and "Not done" items are for the engineer of record before construction.</p>
{table(["Area", "Item", "Status", "Note"], check_rows, "check")}
</section>

<section>
<h2>Drawings</h2>
{table(["Sheet", "Title"], [[f'<span class="mono">{a}</span>', e(b)] for a, b in sheets])}
<p class="note">All sheets are in the structural model OGL-FMC-ZZ-ZZ-M3-S-0001.rvt and are marked PRELIMINARY – NOT FOR CONSTRUCTION.</p>
</section>

<section>
<h2>Changes to the architecture</h2>
<p>The design is still changing. This structure is tied to the architecture model it was based on: a change check compares the architecture model with the snapshot used here. When a structural change is found (a wall moved, a level changed, a new opening), the structural model and its sheets are flagged "revision pending". The affected part is then redesigned with the same scripted steps, and the sheets go up a revision (P01 → P02).</p>
</section>

<section>
<h2>Conditions</h2>
<p>1. The stone and block walls shown as infill are part of the earthquake resistance. Build them after the frame, tight to columns and beams, tied every 450 mm, and never remove them or cut large new openings without the engineer's approval.<br>
2. Confirm the soil (trial pits) and the site wind speed before construction.<br>
3. A registered structural engineer must review, complete the open checklist items and sign before a building permit application and construction.</p>
</section>
</div>"""
open(OUT, "w", encoding="utf-8").write(page)
print(OUT, f"{vol_total:.1f} m3", f"{steel} kg", dict(cnt))
