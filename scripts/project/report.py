# The whole-project presentation: federated 3D model with a filter per discipline, what is counted (designed /
# planned allowance), the project cost plan, a chapter per discipline and the road map. Reads every package in
# <report dir>/packages (scripts/project/packages.py writes them; each discipline's own exporter replaces its
# allowance package once it is designed), so the same page grows as the project fills in.
#   python -I scripts/project/report.py <report dir> <out html> [config json]
import json, sys, os, math, html, datetime, collections, base64
RD, OUT = sys.argv[1], sys.argv[2]; CF = sys.argv[3] if len(sys.argv) > 3 else RD + "/report.json"
e = html.escape; J = lambda p: json.load(open(p, encoding="utf-8"))
cfg = J(CF) if os.path.exists(CF) else {}
ORDER = ["architecture", "structure", "plumbing", "electrical", "mechanical", "interiors", "fire", "external", "landscape"]
pk = {f[:-5]: J(f"{RD}/packages/{f}") for f in os.listdir(RD + "/packages") if f.endswith(".json")}
pks = [pk[k] for k in ORDER if k in pk] + [v for k, v in pk.items() if k not in ORDER]
PROJ, CLIENT, PRES, FIRM = cfg.get("project", "The Ogala Residence"), cfg.get("client", ""), cfg.get("presenter", "Emlyn Atochon"), cfg.get("firm", "Formcraft")
COL = {"architecture": "var(--a)", "structure": "var(--s1)", "plumbing": "var(--s3)", "electrical": "var(--s4)", "mechanical": "var(--s7)", "interiors": "var(--s5)", "fire": "var(--s8)", "external": "var(--s6)", "landscape": "var(--s2)"}
HEX = {"architecture": "#cfc4b1", "structure": "#2a78d6", "plumbing": "#1baf7a", "electrical": "#eda100", "mechanical": "#6250d6", "interiors": "#e87ba4", "fire": "#e34948", "external": "#008300", "landscape": "#eb6834"}
ST = {"designed": ("Designed", "ok"), "in_progress": ("In progress", "warn"), "not_started": ("Planned · allowance", "plan")}

# ---- costs
def cost(p, i): return sum(q["qty"] * q["rate"][i] for q in p["quantities"])
dc = {p["discipline"]: [cost(p, i) for i in range(3)] for p in pks}
sub = [sum(v[i] for v in dc.values()) for i in range(3)]
prelim, conting = cfg.get("prelims_pct", 12) / 100, cfg.get("contingency_pct", 10) / 100
tot = [s * (1 + prelim) * (1 + conting) for s in sub]
designed = sum(dc[p["discipline"]][1] for p in pks if p["status"] == "designed")
gfa = sum(r[2] for r in pk.get("architecture", {}).get("rooms", [])) or 1
Mn = lambda x: f"{x / 1e6:,.0f}M"

# ---- charts (palette tokens; one axis; direct labels)
def donut(items, unit, title, colors, fmt=lambda v: f"{v:,.0f}"):
    total = sum(v for _, v in items) or 1; cx = cy = 120; r0, r1 = 70, 108; a = -math.pi / 2; out, leg = [], []
    for (k, v), c in zip(items, colors):
        da = 2 * math.pi * v / total; a2 = a + da; g = 0.01; P = lambda ang, rr: (cx + rr * math.cos(ang), cy + rr * math.sin(ang))
        (x1, y1), (x2, y2), (x3, y3), (x4, y4) = P(a + g, r1), P(a2 - g, r1), P(a2 - g, r0), P(a + g, r0); lg = 1 if da > math.pi else 0
        if v > 0: out.append(f'<path d="M{x1:.1f},{y1:.1f} A{r1},{r1} 0 {lg} 1 {x2:.1f},{y2:.1f} L{x3:.1f},{y3:.1f} A{r0},{r0} 0 {lg} 0 {x4:.1f},{y4:.1f} Z" fill="{c}"><title>{e(k)}: {fmt(v)} {unit}</title></path>')
        leg.append(f'<li><i style="background:{c}"></i><span>{e(k)}</span><b>{fmt(v)}</b><em>{100 * v / total:.0f}%</em></li>'); a = a2
    return (f'<figure class="chart"><figcaption>{e(title)}</figcaption><div class="donut"><svg viewBox="0 0 240 240" role="img" aria-label="{e(title)}">{"".join(out)}'
            f'<text x="120" y="116" text-anchor="middle" class="big">{fmt(total)}</text><text x="120" y="138" text-anchor="middle" class="sm">{e(unit)}</text></svg><ul class="legend">{"".join(leg)}</ul></div></figure>')
def hbars(items, unit, title, colors, fmt=lambda v: f"{v:,.0f}"):
    mx = max([v for _, v in items] + [1]) * 1.08
    rows = "".join(f'<div class="hb"><span class="k">{e(k)}</span><span class="track"><span class="bar" style="width:{100 * v / mx:.1f}%;background:{c}" title="{e(k)}: {fmt(v)} {unit}"></span></span><b>{fmt(v)} {e(unit)}</b></div>' for (k, v), c in zip(items, colors))
    return f'<figure class="chart"><figcaption>{e(title)}</figcaption><div class="hbars">{rows}</div></figure>'

# ---- federated 3D data: only the disciplines that have a model
fed = {p["discipline"]: {"label": p["label"], "color": HEX.get(p["discipline"], "#999"), **p["model"]} for p in pks if p.get("model")}

# ---- per-discipline chapters
def img_tag(path):
    try: return f'<img loading="lazy" src="data:image/png;base64,{base64.b64encode(open(path, "rb").read()).decode()}" alt="{e(os.path.basename(path))}">'
    except OSError: return ""
chapters = []
for n, p in enumerate(pks, 3):
    d = p["discipline"]; st = ST.get(p["status"], ST["not_started"])
    keys = "".join(f'<div class="fig"><b>{e(v)}</b><span>{e(l)}</span></div>' for v, l in p.get("key", []))
    groups = collections.Counter()
    for q in p["quantities"]: groups[q["group"]] += q["qty"] * q["rate"][1]
    qrows = "".join(f'<tr><td>{e(q["item"])}</td><td class="n">{q["qty"]:,} {e(q["unit"])}</td><td class="n">{q["rate"][1]:,}</td><td class="n"><b>{Mn(q["qty"] * q["rate"][1])}</b></td></tr>' for q in p["quantities"])
    checks = "".join(f'<li class="{c}"><span class="ic">{ {"done": "✓", "partial": "◐", "not": "○"}[c] }</span>{e(t)}</li>' for t, c in p.get("checks", []))
    extra = ""
    if d == "architecture" and p.get("rooms"):
        lv = collections.Counter()
        for nm, l, a in p["rooms"]: lv[l] += a
        big = sorted(p["rooms"], key=lambda r: -r[2])[:8]
        extra = '<div class="cols">' + hbars(sorted(lv.items(), key=lambda x: x[0]), "m²", "Room area by level", ["var(--a2)"] * len(lv)) + hbars([(f"{r[0].title()} ({r[1].split()[0]})", r[2]) for r in big], "m²", "Largest rooms", ["var(--a2)"] * 8) + "</div>"
    if d == "structure" and p.get("drawings"):
        extra = '<div class="gallery">' + "".join(f'<figure class="sheet">{img_tag(x)}</figure>' for x in p["drawings"][:6]) + "</div>"
        if cfg.get("structure_report"): extra += f'<p><a href="{e(cfg["structure_report"])}">Open the full structural design report</a> for the analysis, member checks, materials and drawings.</p>'
    plan_note = "" if p["status"] == "designed" else f'<div class="callout plan"><p><b>To be filled in.</b> This part is planned, not designed yet. The figure below is an allowance so the budget is complete. When its model and design are ready, the real quantities replace the allowance here automatically.</p></div>'
    chapters.append(f'''<section id="{d}"><div class="chap" style="--c:{COL.get(d, 'var(--muted)')}"><span>{n:02d}</span><h2>{e(p["label"])}</h2><em class="st {st[1]}">{st[0]}</em></div>
<p>{e(p["summary"])}</p>{plan_note}<div class="figs">{keys}<div class="fig"><b>UGX {Mn(dc[d][1])}</b><span>likely ({Mn(dc[d][0])}–{Mn(dc[d][2])})</span></div></div>{extra}
<div class="cols"><div class="tw"><table><thead><tr><th>Item</th><th>Quantity</th><th>Rate UGX</th><th>Likely</th></tr></thead><tbody>{qrows}</tbody></table></div>
<div class="card"><h3>Design status</h3><ul class="dchecks">{checks}</ul></div></div></section>''')

# ---- what is counted matrix
cards = "".join(f'<a class="disc {ST.get(p["status"], ST["not_started"])[1]}" href="#{p["discipline"]}" style="--c:{COL.get(p["discipline"])}"><span class="dot"></span><b>{e(p["label"])}</b>'
                f'<em>{ST.get(p["status"], ST["not_started"])[0]}</em><span class="amt">UGX {Mn(dc[p["discipline"]][1])}</span><span class="pct">{100 * dc[p["discipline"]][1] / sub[1]:.0f}% of works</span></a>' for p in pks)
road = "".join(f'<li><b>{e(p["label"])}</b><span>{e("; ".join(t for t, c in p.get("checks", []) if c != "done") or "complete")}</span></li>' for p in pks if any(c != "done" for _, c in p.get("checks", [])))
today = datetime.date.today().strftime("%d %B %Y")
three = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"; orbit = "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"
toggle_btns = "".join(f'<button data-d="{k}" aria-pressed="true"><i style="background:{v["color"]}"></i>{e(v["label"])}</button>' for k, v in fed.items()) + \
    "".join(f'<button disabled title="not modelled yet"><i style="background:{HEX.get(p["discipline"], "#999")}"></i>{e(p["label"].split(" (")[0])}</button>' for p in pks if not p.get("model"))

page = f"""<title>Ogala Project Report</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..100,500..800&family=Public+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a federated-model opener (every discipline in one 3D scene, a filter per discipline), then the "what is counted"
   board, the cost plan, one chapter per discipline in a fixed order, and the road map. Discipline colours are fixed
   across the 3D, the board, the charts and the chapter rules. */
:root {{
  --paper:#eef1f3; --panel:#ffffff; --ink:#121a21; --muted:#56636e; --line:#d3dae0; --hero:#0f1820; --hero-ink:#eef3f7;
  --a:#a8987c; --a2:#8a7b62; --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300; --s7:#6250d6; --s8:#e34948;
  --good:#0ca30c; --warn:#fab219; --crit:#d03b3b; --plan:#56636e;
  --display:"Archivo", "Arial Narrow", Arial, sans-serif; --body:"Public Sans", "Segoe UI", Arial, sans-serif; --mono:"IBM Plex Mono", Consolas, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --paper:#11161a; --panel:#1a1a19; --ink:#f0efec; --muted:#c3c2b7; --line:#2d353c; --hero:#0a0f13; --a:#b3a487; --a2:#c2b393;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767; --plan:#c3c2b7; color-scheme: dark }} }}
:root[data-theme="dark"] {{ --paper:#11161a; --panel:#1a1a19; --ink:#f0efec; --muted:#c3c2b7; --line:#2d353c; --hero:#0a0f13; --a:#b3a487; --a2:#c2b393;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767; --plan:#c3c2b7; color-scheme: dark }}
body {{ background:var(--paper); color:var(--ink); font:16px/1.6 var(--body); }}
.gut {{ padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); }}
.hero {{ background:var(--hero); color:var(--hero-ink); padding-block:28px 0; }}
.hero .in {{ max-width:1180px; margin:0 auto; display:grid; gap:16px; }}
.eyebrow {{ font:500 12px/1.4 var(--mono); letter-spacing:.14em; text-transform:uppercase; opacity:.75; }}
h1 {{ font:800 clamp(34px, 7vw, 78px)/.95 var(--display); font-stretch:75%; margin:0; text-wrap:balance; }}
.lede {{ max-width:64ch; font-size:18px; opacity:.9; margin:0; }}
.viewer {{ position:relative; height:min(72vh, 660px); min-height:380px; }}
#v3d {{ width:100%; height:100%; display:block; }}
.vctl {{ position:absolute; left:0; right:0; top:10px; display:flex; flex-wrap:wrap; gap:6px; }}
.vctl button {{ font:500 12px var(--mono); color:var(--hero-ink); background:#ffffff14; border:1px solid #ffffff33; padding:6px 10px; border-radius:3px; cursor:pointer; display:inline-flex; gap:6px; align-items:center; }}
.vctl button i {{ width:10px; height:10px; border-radius:2px; display:inline-block; }}
.vctl button[aria-pressed="false"] {{ opacity:.45; }} .vctl button:disabled {{ opacity:.3; cursor:not-allowed; border-style:dashed; }}
.vctl button:focus-visible {{ outline:2px solid var(--s4); outline-offset:2px; }}
.vnote {{ position:absolute; left:16px; bottom:12px; font:12px var(--mono); opacity:.7; }}
main {{ max-width:1180px; margin:0 auto; padding-block:36px 80px; display:grid; gap:64px; }}
section {{ display:grid; gap:20px; min-width:0; scroll-margin-top:16px; }}
.chap {{ display:grid; grid-template-columns:auto 1fr auto; gap:4px 16px; align-items:baseline; border-top:4px solid var(--c, var(--ink)); padding-top:12px; }}
.chap span {{ font:500 13px var(--mono); color:var(--muted); }}
h2 {{ font:700 clamp(26px, 4vw, 40px)/1.05 var(--display); font-stretch:85%; margin:0; text-wrap:balance; }} h3 {{ font:700 19px/1.2 var(--display); margin:0; }}
p {{ margin:0; max-width:70ch; }}
.st {{ font:500 11px var(--mono); text-transform:uppercase; letter-spacing:.08em; font-style:normal; padding:3px 7px; border:1px solid currentColor; border-radius:2px; }}
.st.ok {{ color:var(--good); }} .st.warn {{ color:var(--warn); }} .st.plan {{ color:var(--plan); }}
.figs {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:1px; background:var(--line); border:1px solid var(--line); }}
.fig {{ background:var(--panel); padding:14px 16px; display:grid; gap:4px; }} .fig b {{ font:800 30px/1 var(--display); font-stretch:80%; font-variant-numeric:tabular-nums; }} .fig span {{ font:12px/1.4 var(--mono); color:var(--muted); }}
.cols {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:20px; }} .cols > * {{ min-width:0; }}
.chart, .card, .sheet {{ margin:0; background:var(--panel); border:1px solid var(--line); padding:16px; display:grid; gap:12px; min-width:0; align-content:start; }}
figcaption {{ font:500 12px/1.4 var(--mono); text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }}
.donut {{ display:grid; grid-template-columns:minmax(150px, 210px) 1fr; gap:16px; align-items:center; }}
@media (max-width:540px) {{ .donut {{ grid-template-columns:1fr; }} .donut svg {{ max-width:220px; margin:0 auto; }} }}
svg text {{ fill:var(--ink); font-family:var(--mono); }} svg .big {{ font:800 26px var(--display); fill:var(--ink); }} svg .sm {{ font-size:11px; fill:var(--muted); }}
.legend {{ list-style:none; margin:0; padding:0; display:grid; gap:6px; font-size:14px; }} .legend li {{ display:grid; grid-template-columns:12px 1fr auto 40px; gap:8px; align-items:center; }}
.legend i {{ width:12px; height:12px; border-radius:2px; }} .legend b {{ font:500 13px var(--mono); }} .legend em {{ font:12px var(--mono); color:var(--muted); font-style:normal; text-align:right; }}
.hbars {{ display:grid; gap:8px; }} .hb {{ display:grid; grid-template-columns:minmax(100px, 190px) 1fr minmax(80px, auto); gap:10px; align-items:center; font-size:14px; }}
.hb .track {{ position:relative; height:14px; background:var(--paper); border-radius:2px; }} .hb .bar {{ position:absolute; inset:0 auto 0 0; border-radius:0 4px 4px 0; }} .hb b {{ font:500 13px var(--mono); text-align:right; }}
.board {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px; }}
.disc {{ text-decoration:none; color:inherit; background:var(--panel); border:1px solid var(--line); border-top:4px solid var(--c); padding:14px; display:grid; gap:4px; }}
.disc.plan {{ border-style:dashed; border-top-style:solid; }} .disc b {{ font:700 17px/1.2 var(--display); }} .disc em {{ font:500 11px var(--mono); text-transform:uppercase; font-style:normal; color:var(--muted); }}
.disc.ok em {{ color:var(--good); }} .disc .amt {{ font:800 22px var(--display); font-stretch:85%; }} .disc .pct {{ font:12px var(--mono); color:var(--muted); }} .disc .dot {{ display:none; }}
.disc:focus-visible {{ outline:2px solid var(--ink); outline-offset:2px; }}
.stack {{ display:flex; height:28px; gap:2px; border-radius:3px; overflow:hidden; }} .stack i {{ display:block; }}
.tw {{ overflow-x:auto; border:1px solid var(--line); background:var(--panel); }}
table {{ border-collapse:collapse; width:100%; font-size:14px; }} th {{ text-align:left; font:500 11px var(--mono); text-transform:uppercase; letter-spacing:.07em; color:var(--muted); padding:9px 12px; border-bottom:1px solid var(--line); }}
td {{ padding:9px 12px; border-bottom:1px solid var(--line); }} td.n {{ text-align:right; font-family:var(--mono); white-space:nowrap; font-variant-numeric:tabular-nums; }} tfoot td {{ border-top:2px solid var(--ink); border-bottom:0; font-weight:600; }}
.dchecks {{ list-style:none; margin:0; padding:0; display:grid; gap:6px; font-size:14px; }} .dchecks li {{ display:grid; grid-template-columns:20px 1fr; gap:6px; }}
.dchecks .done .ic {{ color:var(--good); }} .dchecks .partial .ic {{ color:var(--warn); }} .dchecks .not .ic {{ color:var(--crit); }}
.callout {{ border-left:4px solid var(--s2); background:var(--panel); padding:14px 16px; }} .callout.plan {{ border-left-color:var(--plan); }}
.gallery {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:14px; }} .sheet img {{ width:100%; aspect-ratio:4/3; object-fit:contain; background:#fff; }}
.road {{ list-style:none; margin:0; padding:0; display:grid; gap:0; counter-reset:r; }} .road li {{ display:grid; grid-template-columns:minmax(150px, 260px) 1fr; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); }}
.road b {{ font:700 16px var(--display); }}
.sig {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1px; background:var(--line); border:2px solid var(--ink); }} .sig div {{ background:var(--panel); padding:12px 14px; display:grid; }} .sig span {{ font:500 11px var(--mono); text-transform:uppercase; color:var(--muted); }}
a {{ color:var(--s1); }}
</style>

<header class="hero">
  <div class="in gut">
    <div class="eyebrow">{e(FIRM)} · {e(PROJ)} · Project report · {today}</div>
    <h1>{e(PROJ)}: the whole project in one model</h1>
    <p class="lede">Every discipline in one place: the architecture, the structure, and every service and finish still to come. Use the buttons to strip the house back to its structure, or to see each system on its own. What is designed is counted from the models; what is still to be designed is carried as a clearly marked allowance, so the budget is complete from day one.</p>
  </div>
  <div class="viewer"><canvas id="v3d" aria-label="Federated 3D model"></canvas><div class="vctl gut" role="group" aria-label="Disciplines">{toggle_btns}</div><div class="vnote">drag to turn · scroll to zoom · dashed = not modelled yet</div></div>
</header>

<main class="gut">
<section>
  <div class="figs">
    <div class="fig"><b>UGX {tot[1] / 1e9:,.2f}bn</b><span>project cost, likely ({tot[0] / 1e9:,.2f}–{tot[2] / 1e9:,.2f}bn)</span></div>
    <div class="fig"><b>{gfa:,.0f} m²</b><span>room area</span></div>
    <div class="fig"><b>UGX {tot[1] / gfa / 1e6:,.2f}M</b><span>per m² of room area, all in</span></div>
    <div class="fig"><b>{100 * designed / sub[1]:.0f}%</b><span>of the works cost counted from designed models</span></div>
    <div class="fig"><b>{sum(p['status'] == 'designed' for p in pks)} / {len(pks)}</b><span>disciplines designed</span></div>
  </div>
</section>

<section>
  <div class="chap"><span>01</span><h2>What is counted</h2></div>
  <p>Solid cards are designed and counted from their models. Dashed cards are planned: their cost is an allowance until the design is done. Tap a card to jump to that part of the report.</p>
  <div class="stack" role="img" aria-label="Share of works cost by discipline">{"".join(f'<i style="flex:{dc[p["discipline"]][1]};background:{COL.get(p["discipline"])}" title="{e(p["label"])}: UGX {Mn(dc[p["discipline"]][1])}"></i>' for p in pks)}</div>
  <div class="board">{cards}</div>
</section>

<section>
  <div class="chap"><span>02</span><h2>The cost plan</h2></div>
  <div class="cols">
    {donut([(p["label"].split(" (")[0], dc[p["discipline"]][1] / 1e6) for p in pks], "UGX M", "Works cost by discipline (likely)", [COL.get(p["discipline"]) for p in pks])}
    {hbars([("Designed (from models)", designed / 1e6), ("Planned (allowances)", (sub[1] - designed) / 1e6), ("Preliminaries & contractor " + str(int(prelim * 100)) + "%", sub[1] * prelim / 1e6), ("Contingency " + str(int(conting * 100)) + "%", sub[1] * (1 + prelim) * conting / 1e6)], "UGX M", "How firm the number is", ["var(--good)", "var(--plan)", "var(--s2)", "var(--s4)"])}
  </div>
  <div class="tw"><table><thead><tr><th>Discipline</th><th>Status</th><th>Low</th><th>Likely</th><th>High</th></tr></thead><tbody>
  {"".join(f'<tr><td>{e(p["label"])}</td><td>{ST.get(p["status"], ST["not_started"])[0]}</td><td class="n">{Mn(dc[p["discipline"]][0])}</td><td class="n"><b>{Mn(dc[p["discipline"]][1])}</b></td><td class="n">{Mn(dc[p["discipline"]][2])}</td></tr>' for p in pks)}
  <tr><td>Preliminaries &amp; contractor's margin</td><td>{int(prelim * 100)}%</td><td class="n">{Mn(sub[0] * prelim)}</td><td class="n">{Mn(sub[1] * prelim)}</td><td class="n">{Mn(sub[2] * prelim)}</td></tr>
  <tr><td>Contingency</td><td>{int(conting * 100)}%</td><td class="n">{Mn(sub[0] * (1 + prelim) * conting)}</td><td class="n">{Mn(sub[1] * (1 + prelim) * conting)}</td><td class="n">{Mn(sub[2] * (1 + prelim) * conting)}</td></tr></tbody>
  <tfoot><tr><td>Project total</td><td></td><td class="n">{Mn(tot[0])}</td><td class="n">{Mn(tot[1])}</td><td class="n">{Mn(tot[2])}</td></tr></tfoot></table></div>
  <p class="note">Rates are indicative Kampala 2026 rates for a finished house of this standard; the quantity surveyor's rates replace them in one file. Excluded: land, professional fees, permits, VAT where applicable, and loose decor beyond the interiors allowance.</p>
</section>

{"".join(chapters)}

<section>
  <div class="chap"><span>{len(pks) + 3:02d}</span><h2>Road map: what fills in next</h2></div>
  <ul class="road">{road}</ul>
  <div class="sig"><div><span>Prepared by</span><b>{e(PRES)}, {e(FIRM)}</b></div><div><span>Status</span><b>Design development — figures preliminary</b></div><div><span>Date</span><b>{today}</b></div></div>
</section>
</main>

<script src="{three}"></script>
<script src="{orbit}"></script>
<script>
const FED = {json.dumps(fed, separators=(",", ":"))};
(function () {{
  const cv = document.getElementById("v3d"); if (!window.THREE) return;
  let r; try {{ r = new THREE.WebGLRenderer({{ canvas: cv, antialias: true }}); }} catch (x) {{ return; }}
  r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  const scene = new THREE.Scene(); scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue("--hero").trim() || "#0f1820");
  const cam = new THREE.PerspectiveCamera(38, 1, 0.1, 800);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.8)); const sun = new THREE.DirectionalLight(0xffffff, 0.7); sun.position.set(-30, 40, 20); scene.add(sun);
  const P = (x, y, z) => new THREE.Vector3(x / 1000, z / 1000, -y / 1000); const G = {{}};
  for (const [d, m] of Object.entries(FED)) {{
    const g = new THREE.Group(); G[d] = g; scene.add(g); const arch = d === "architecture";
    const mat = new THREE.MeshStandardMaterial({{ color: m.color, roughness: 0.85, transparent: arch, opacity: arch ? 0.42 : 1, depthWrite: !arch }});
    (m.boxes || []).forEach(([x0, y0, z0, x1, y1, z1, b, h]) => {{
      const a = P(x0, y0, z0), c = P(x1, y1, z1); let mesh;
      if (Math.abs(x0 - x1) < 1 && Math.abs(y0 - y1) < 1) {{ mesh = new THREE.Mesh(new THREE.BoxGeometry(b / 1000, (z1 - z0) / 1000, b / 1000), mat); mesh.position.copy(a.clone().add(c).multiplyScalar(0.5)); }}
      else {{ const len = a.distanceTo(c); mesh = new THREE.Mesh(new THREE.BoxGeometry(b / 1000, h / 1000, len), mat); mesh.position.copy(a.clone().add(c).multiplyScalar(0.5)); mesh.position.y += h / 2000; mesh.lookAt(c.x, mesh.position.y, c.z); }}
      g.add(mesh);
    }});
    (m.prisms || []).forEach(([lp, z0, z1]) => {{
      const sh = new THREE.Shape(lp.map((q) => new THREE.Vector2(q[0] / 1000, q[1] / 1000)));
      const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, {{ depth: Math.max(10, z1 - z0) / 1000, bevelEnabled: false }}), new THREE.MeshStandardMaterial({{ color: m.color, roughness: 1, transparent: true, opacity: arch ? 0.35 : 0.6, side: THREE.DoubleSide, depthWrite: false }}));
      mesh.rotation.x = -Math.PI / 2; mesh.position.y = z0 / 1000; g.add(mesh);
    }});
    (m.roofs || []).forEach(([x0, y0, x1, y1, z0, z1]) => {{
      const alongY = (x1 - x0) <= (y1 - y0) * 1.6, v = [];
      const q = (x, y, z) => {{ const p = P(x, y, z); v.push(p.x, p.y, p.z); }};
      if (alongY) {{ const xm = (x0 + x1) / 2; q(x0, y0, z0); q(xm, y0, z1); q(xm, y1, z1); q(x0, y0, z0); q(xm, y1, z1); q(x0, y1, z0); q(x1, y0, z0); q(x1, y1, z0); q(xm, y1, z1); q(x1, y0, z0); q(xm, y1, z1); q(xm, y0, z1); }}
      else {{ const ym = (y0 + y1) / 2; q(x0, y0, z0); q(x1, y0, z0); q(x1, ym, z1); q(x0, y0, z0); q(x1, ym, z1); q(x0, ym, z1); q(x0, y1, z0); q(x0, ym, z1); q(x1, ym, z1); q(x0, y1, z0); q(x1, ym, z1); q(x1, y1, z0); }}
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3)); geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({{ color: "#a4553c", roughness: 0.9, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false }})));
    }});
    if ((m.lines || []).length) {{ const pts = []; m.lines.forEach(([a, b]) => pts.push(P(...a), P(...b))); g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({{ color: "#d9b27c" }}))); }}
  }}
  const bb = new THREE.Box3(); Object.values(G).forEach((g) => bb.expandByObject(g)); const ctr = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3());
  cam.position.copy(ctr.clone().add(new THREE.Vector3(sz.x * 0.8, Math.max(sz.x, sz.z) * 0.75, sz.z * 0.9)));
  const ctl = new THREE.OrbitControls(cam, cv); ctl.target.copy(ctr); ctl.enableDamping = true; ctl.autoRotate = !matchMedia("(prefers-reduced-motion: reduce)").matches; ctl.autoRotateSpeed = 0.5;
  cv.addEventListener("pointerdown", () => (ctl.autoRotate = false));
  document.querySelectorAll(".vctl button[data-d]").forEach((b) => b.addEventListener("click", () => {{ const g = G[b.dataset.d]; g.visible = !g.visible; b.setAttribute("aria-pressed", g.visible); }}));
  const fit = () => {{ const w = cv.clientWidth, h = cv.clientHeight; r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }}; addEventListener("resize", fit); fit();
  (function loop() {{ ctl.update(); r.render(scene, cam); requestAnimationFrame(loop); }})();
}})();
</script>"""
open(OUT, "w", encoding="utf-8").write(page)
print(OUT, f"{len(page) / 1e6:.2f} MB", f"total {tot[1] / 1e9:.2f}bn ({tot[0] / 1e9:.2f}-{tot[2] / 1e9:.2f}), designed share {100 * designed / sub[1]:.0f}%")
