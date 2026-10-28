# The whole-project presentation (docs/PROJECT_REPORT.md): a federated 3D model in the Formcraft website's look (real
# Revit shells, soft sun shadows, build-up animation, day/dusk) with a switch per discipline and per part; a cost
# explorer where every item is staged Now / Later / Leave out (structure and shell are always in) and every cost part
# (materials, labour, plant, preliminaries, contingency) switches on and off; the price book behind the rates; the scope
# matrix; one chapter per discipline; the road map. Reads every package in <report dir>/packages.
#   python -I scripts/project/report.py <report dir> <out html> [config json]
import json, sys, os, re, html, datetime, base64
RD, OUT = sys.argv[1], sys.argv[2]; CF = sys.argv[3] if len(sys.argv) > 3 else RD + "/report.json"
e = html.escape; J = lambda p: json.load(open(p, encoding="utf-8"))
cfg = J(CF) if os.path.exists(CF) else {}
KIT = cfg.get("kit_materials", r"D:\Fomcraft\FMC_BIM_27\FMC_Kit_v2.2\FMC_Kit_v2.2\07_Materials")
ORDER = ["architecture", "structure", "plumbing", "electrical", "mechanical", "interiors", "fire", "external", "landscape"]
pk = {f[:-5]: J(f"{RD}/packages/{f}") for f in os.listdir(RD + "/packages") if f.endswith(".json")}
pks = [pk[k] for k in ORDER if k in pk] + [v for k, v in pk.items() if k not in ORDER]
PROJ, PRES, FIRM = cfg.get("project", "The Ogala Residence"), cfg.get("presenter", "Emlyn Atochon"), cfg.get("firm", "Formcraft")
HEX = {"architecture": "#a8987c", "structure": "#2a78d6", "plumbing": "#1baf7a", "electrical": "#eda100", "mechanical": "#6250d6", "interiors": "#e87ba4", "fire": "#e34948", "external": "#008300", "landscape": "#eb6834"}
ST = {"designed": "Designed", "in_progress": "In progress", "not_started": "Planned · allowance"}
SC = {"designed": ("Designed", "ok"), "partial": ("Partly", "warn"), "allowance": ("Allowance", "plan"), "not": ("Not covered", "bad")}
PARTS = ["Main house", "Boys' quarters", "Site & external works"]
prelim, conting = cfg.get("prelims_pct", 12), cfg.get("contingency_pct", 10)
FULL0 = cfg.get("cost_mode") == "full"
rooms = pk.get("architecture", {}).get("rooms", []); gfa = sum(r[2] for r in rooms) or 1
Mn = lambda x: f"{x / 1e6:,.0f}M"

# ---- the cost data the page computes from: every item with its materials / labour / plant parts and its stage
def rparts(q):   # labour = what the full rate holds beyond materials and plant, so the parts always add up to the full rate
    full = q["rate"]; m = q.get("rate_mat", full); p = q.get("rate_plant", [0, 0, 0])
    return {"mat": [round(x) for x in m], "lab": [round(max(0, f - a - b)) for f, a, b in zip(full, m, p)], "plant": [round(x) for x in p]}
COST = {"pre": prelim, "con": conting, "full0": FULL0, "gfa": gfa, "discs": [
    {"d": p["discipline"], "label": p["label"], "short": p["label"].split(" (")[0], "color": HEX.get(p["discipline"], "#888"), "status": p["status"], "model": bool(p.get("model")),
     "items": [{"id": f"{p['discipline']}:{i}", "label": q["item"], "qty": q["qty"], "unit": q["unit"], "group": q.get("group", ""), "locked": bool(q.get("locked")),
                "s0": "later" if q.get("optional") else "now", "r": rparts(q)} for i, q in enumerate(p["quantities"])]} for p in pks]}

# ---- the price book behind the rates (kit 07_Materials, kept in FMC_Price_Book.csv)
try: PI = J(KIT + "/FMC_Price_Index.json")
except OSError: PI = {}
PB = [[k, v["item"], v["unit"], v["low"], v["likely"], v["high"], v.get("status", ""), v.get("source", ""), v.get("date", "")] for k, v in PI.items() if not k.startswith("_")]
pb_n = {s: sum(1 for r in PB if r[6] == s) for s in ("market", "secondary", "assumed")}

# ---- federated 3D: the real Revit shells (obj2web.py) where exported, else the simple boxes
fed = {}
for p in pks:
    if not p.get("model"): continue
    m = dict(p["model"])
    if "mesh" in m:
        f = os.path.join(RD, m["mesh"])
        if os.path.exists(f): m["mesh"] = J(f)
        else: del m["mesh"]
    fed[p["discipline"]] = {"label": p["label"], "color": HEX.get(p["discipline"], "#999"), **m}
# ---- every part of every discipline (parts_template.json): the Revit categories it draws and the cost items it carries.
# A part is live (switchable) once it has geometry in the model; until then it is listed greyed out.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import kitdata   # kit 03_Master_Data/FMC_Report_Parts.json
TPL = {k: v for k, v in kitdata.load("parts").items() if not k.startswith("_")}
CATDISC = {c: d for d, L in TPL.items() for p in L for c in p["cats"] if c not in ("*", "#lines")}
present = {(d, "#lines") for d, m in fed.items() if m.get("lines")}   # (discipline, category) drawn in the model
for d, m in fed.items():
    for gr in (m.get("mesh") or {}).get("groups", []): present.add((CATDISC.get(gr["cat"], d), gr["cat"]))
    if m.get("boxes") or m.get("prisms"): present.add((d, "Model"))
def live(d, p):
    own = {c for q in TPL[d] for c in q["cats"]}
    return any((d, c) in present for c in p["cats"]) or ("*" in p["cats"] and any(dd == d and c not in own for dd, c in present))
MPARTS = {d: [{"k": f"{d}/{p['name']}", "name": p["name"], "cats": p["cats"], "colour": p["colour"], "order": p["order"], "live": live(d, p)} for p in L] for d, L in TPL.items()}   # model parts (not PARTS, the project's parts)
for c in COST["discs"]:
    for it in c["items"]:
        it["p"] = next((p["k"] for p, t in zip(MPARTS.get(c["d"], []), TPL.get(c["d"], [])) if t.get("items") and re.search(t["items"], it["label"])), "")
    c["model"] = any(p["live"] for p in MPARTS.get(c["d"], []))
HASM = {c["d"]: c["model"] for c in COST["discs"]}
toggle_btns = "".join(f'<button class="dtog" data-d="{p["discipline"]}" aria-pressed="true" {"" if HASM.get(p["discipline"]) else "data-nomodel=1"}><i style="background:{HEX.get(p["discipline"])}"></i>{e(p["label"].split(" (")[0])}</button>' for p in pks)
# the website's baked paper textures (FMC_WEB public/textures), so the model reads as the same paper scale model
WEBTEX = cfg.get("web_textures", r"D:\Fomcraft\FMC_WEB\public\textures")
def data_uri(f):
    try: return "data:image/webp;base64," + base64.b64encode(open(os.path.join(WEBTEX, f), "rb").read()).decode()
    except OSError: return None
TEX = {"paper": data_uri("hotel-paper-512.webp"), "normal": data_uri("hotel-normal-512.webp")}

def dsum(p, k, i): return sum(q["qty"] * q.get(k, q["rate"])[i] for q in p["quantities"])
def img_tag(path):
    try: return f'<img loading="lazy" src="data:image/png;base64,{base64.b64encode(open(path, "rb").read()).decode()}" alt="{e(os.path.basename(path))}">'
    except OSError: return ""
def hbars(items, unit, title, color):
    mx = max([v for _, v in items] + [1]) * 1.08
    rows = "".join(f'<div class="hb"><span class="k">{e(k)}</span><span class="track"><span class="bar" style="width:{100 * v / mx:.1f}%;background:{color}"></span></span><b>{v:,.0f} {e(unit)}</b></div>' for k, v in items)
    return f'<figure class="chart"><figcaption>{e(title)}</figcaption><div class="hbars">{rows}</div></figure>'
def tag(q): return ' <em class="tg lock">shell</em>' if q.get("locked") else (' <em class="tg ch">client choice</em>' if q.get("optional") else "")

chapters = []
for n, p in enumerate(pks, 5):
    d = p["discipline"]; plan = p["status"] != "designed"
    keys = "".join(f'<div class="fig"><b>{e(v)}</b><span>{e(l)}</span></div>' for v, l in p.get("key", []))
    qrows = "".join(f'<tr><td>{e(q["item"])}{tag(q)}</td><td class="n">{q["qty"]:,} {e(q["unit"])}</td><td class="n">{q.get("rate_mat", q["rate"])[1]:,.0f}</td>'
                    f'<td class="n">{q["rate"][1]:,.0f}</td><td class="n"><b>{Mn(q["qty"] * q["rate"][1])}</b></td></tr>' for q in p["quantities"])
    checks = "".join(f'<li class="{c}"><span class="ic">{ {"done": "✓", "partial": "◐", "not": "○"}[c] }</span>{e(t)}</li>' for t, c in p.get("checks", []))
    extra = ""
    if d == "architecture" and rooms:
        lv = {}
        for nm, l, a in rooms: lv[l] = lv.get(l, 0) + a
        big = sorted(rooms, key=lambda r: -r[2])[:8]
        extra = '<div class="cols">' + hbars(sorted(lv.items()), "m²", "Room area by level", "var(--arch)") + hbars([(f"{r[0].title()} ({r[1].split()[0]})", r[2]) for r in big], "m²", "Largest rooms", "var(--arch)") + "</div>"
    if d == "structure" and p.get("drawings"):
        extra = '<div class="gallery">' + "".join(f'<figure class="sheet">{img_tag(x)}</figure>' for x in p["drawings"][:6]) + "</div>"
    note = '<div class="callout plan"><p><b>To be filled in.</b> Planned, not designed yet: the items below are an allowance split into the choices the client can make. When the design is done, its model and real quantities replace them here.</p></div>' if plan else ""
    scope = "".join(f'<li><b>{e(part)}</b> <span class="sc {SC[v[0]][1]}">{SC[v[0]][0]}</span> {e(v[1])}</li>' for part, v in p.get("scope", {}).items())
    # every discipline links to its own report and to the review pack its professional stamps (report.json links)
    lk = cfg.get("links", {}).get(d, {})
    docs = [(lk.get("report"), "Design report", "the full design, explained"), (lk.get("review"), "Review pack", f"for {lk.get('signer', 'the professional')} to check and stamp")]
    extra += '<div class="docs">' + "".join(f'<a class="doc" href="{e(u)}"><b>{t}</b><span>{e(s)}</span></a>' if u else f'<span class="doc off" title="Made when this discipline is designed"><b>{t}</b><span>{e(s)}: when designed</span></span>' for u, t, s in docs) + "</div>"
    chapters.append(f'''<section id="{d}"><div class="chap" style="--c:{HEX.get(d)}"><span>{n:02d}</span><h2>{e(p["label"])}</h2><em class="st {'ok' if not plan else 'plan'}">{ST.get(p["status"], "")}</em></div>
<p>{e(p["summary"])}</p>{note}<div class="figs">{keys}<div class="fig"><b>UGX {Mn(dsum(p, "rate_mat", 1))}</b><span>materials, all items</span></div><div class="fig"><b>UGX {Mn(dsum(p, "rate", 1))}</b><span>full rates, all items</span></div></div>{extra}
<div class="cols"><div class="tw"><table><thead><tr><th>Item</th><th>Quantity</th><th>Materials rate</th><th>Full rate</th><th>Likely, full</th></tr></thead><tbody>{qrows}</tbody></table></div>
<div class="card"><h3>Covers</h3><ul class="scope">{scope}</ul><h3>Design status</h3><ul class="dchecks">{checks}</ul></div></div></section>''')

mat_rows = "".join(f'<tr><th scope="row">{e(part)}</th>' + "".join(
    (lambda v: f'<td><span class="sc {SC[v[0]][1]}" title="{e(v[1])}">{SC[v[0]][0]}</span></td>')(p.get("scope", {}).get(part, ["not", "not part of this discipline"])) for p in pks) + "</tr>" for part in PARTS)
mat_head = "".join(f'<th style="--c:{HEX.get(p["discipline"])}"><span class="dot"></span>{e(p["label"].split(" (")[0])}</th>' for p in pks)
road = "".join(f'<li><b>{e(p["label"])}</b><span>{e("; ".join(t for t, c in p.get("checks", []) if c != "done") or "complete")}</span></li>' for p in pks if any(c != "done" for _, c in p.get("checks", [])))
today = datetime.date.today().strftime("%d %B %Y")
three = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"; orbit = "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"

CSS = r"""
/* Layout: a federated-model opener in the Formcraft website's look (daylight model, soft shadows); its discipline and
   part switches are shared with the cost explorer below. Then the cost controls (what is counted, which phase), totals,
   chart, items staged Now / Later / Leave out, the price book, the scope matrix, a chapter per discipline. */
:root {
  --paper:#eef1f3; --panel:#ffffff; --ink:#121a21; --muted:#56636e; --line:#d3dae0; --hero:#1c252d; --hero-ink:#efeeea; --arch:#8a7b62;
  --s1:#2a78d6; --s2:#d15334; --s4:#eda100; --good:#0ca30c; --warn:#b07800; --crit:#d03b3b; --plan:#56636e; --soft:#f4f6f7;
  --display:"Archivo", "Arial Narrow", Arial, sans-serif; --body:"Public Sans", "Segoe UI", Arial, sans-serif; --mono:"IBM Plex Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --paper:#11161a; --panel:#1a1a19; --ink:#f0efec; --muted:#c3c2b7; --line:#2d353c; --hero:#10171d; --arch:#c2b393; --s1:#3987e5; --s2:#e0714f; --s4:#c98500; --warn:#e0a63a; --plan:#c3c2b7; --soft:#20262b; color-scheme: dark } }
:root[data-theme="dark"] { --paper:#11161a; --panel:#1a1a19; --ink:#f0efec; --muted:#c3c2b7; --line:#2d353c; --hero:#10171d; --arch:#c2b393; --s1:#3987e5; --s2:#e0714f; --s4:#c98500; --warn:#e0a63a; --plan:#c3c2b7; --soft:#20262b; color-scheme: dark }
body { background:var(--paper); color:var(--ink); font:16px/1.6 var(--body); }
.gut { padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); }
.hero { background:var(--hero); color:var(--hero-ink); padding-block:28px 0; }
.hero .in { max-width:1180px; margin:0 auto; display:grid; gap:14px; padding-block:0 20px; }
.eyebrow { font:500 12px/1.4 var(--mono); letter-spacing:.14em; text-transform:uppercase; opacity:.75; }
h1 { font:800 clamp(34px, 7vw, 76px)/.95 var(--display); font-stretch:75%; margin:0; text-wrap:balance; }
.lede { max-width:66ch; font-size:18px; opacity:.9; margin:0; }
.viewer { position:relative; height:min(74vh, 680px); min-height:400px; background:#dfe5e8; }
#v3d { width:100%; height:100%; display:block; touch-action:none; }
.vctl, .vlook { position:absolute; top:10px; display:flex; flex-wrap:wrap; gap:6px; }
.vctl { left:0; right:0; } .vlook { top:auto; bottom:38px; right:max(16px, env(safe-area-inset-right, 0px)); justify-content:flex-end; }
.vload[hidden] { display:none; }
.dtog, .vlook button, .ptog { font:500 12px var(--mono); border-radius:3px; cursor:pointer; display:inline-flex; gap:6px; align-items:center; padding:6px 10px; color:#1c252d; background:#ffffffcc; border:1px solid #1c252d33; backdrop-filter:blur(6px); }
.dtog i, .prow b i { width:10px; height:10px; border-radius:2px; display:inline-block; }
.dtog[aria-pressed="false"], .ptog[aria-pressed="false"] { opacity:.45; text-decoration:line-through; } .dtog[data-nomodel] { border-style:dashed; }
.vlook button[aria-pressed="true"] { background:#1c252d; color:#efeeea; }
button:focus-visible, input:focus-visible, select:focus-visible { outline:2px solid var(--s4); outline-offset:2px; }
.vnote { position:absolute; left:max(16px, env(safe-area-inset-left, 0px)); bottom:12px; font:12px var(--mono); color:#1c252d; opacity:.75; }
.vload { position:absolute; inset:0; display:grid; place-items:center; font:500 13px var(--mono); color:#1c252d; pointer-events:none; }
.parts { max-width:1180px; margin:0 auto; display:grid; gap:8px; padding-block:14px 18px; }
.prow { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.prow b { font:600 12px var(--mono); text-transform:uppercase; letter-spacing:.08em; display:inline-flex; gap:6px; align-items:center; min-width:130px; }
.prow .ptog { background:#ffffff14; color:var(--hero-ink); border-color:#ffffff33; } .ptog small { font:inherit; opacity:.7; }
.prow .ptog:disabled { opacity:.32; filter:blur(.5px); cursor:not-allowed; text-decoration:none; border-style:dashed; } .prow.off { opacity:.5; }
main { max-width:1180px; margin:0 auto; padding-block:28px 80px; display:grid; gap:56px; }
section { display:grid; gap:18px; min-width:0; scroll-margin-top:120px; }
.chap { display:grid; grid-template-columns:auto 1fr auto; gap:4px 16px; align-items:baseline; border-top:4px solid var(--c, var(--ink)); padding-top:12px; }
.chap span { font:500 13px var(--mono); color:var(--muted); }
h2 { font:700 clamp(26px, 4vw, 40px)/1.05 var(--display); font-stretch:85%; margin:0; text-wrap:balance; } h3 { font:700 18px/1.2 var(--display); margin:0; }
p { margin:0; max-width:70ch; }
.st { font:500 11px var(--mono); text-transform:uppercase; letter-spacing:.08em; font-style:normal; padding:3px 7px; border:1px solid currentColor; border-radius:2px; }
.st.ok { color:var(--good); } .st.plan { color:var(--plan); }
.basis { display:grid; gap:8px; border:1px solid var(--line); background:var(--panel); padding:10px 12px; z-index:5; }
@media (min-width:760px) { .basis { position:sticky; top:env(safe-area-inset-top, 0px); } }
.brow { display:flex; flex-wrap:wrap; gap:6px 8px; align-items:center; }
.lbl { font:500 11px var(--mono); text-transform:uppercase; letter-spacing:.08em; color:var(--muted); min-width:64px; }
.basis button, .chip { font:600 13px var(--body); padding:5px 10px; border:1px solid var(--ink); background:var(--panel); color:var(--ink); border-radius:3px; cursor:pointer; display:inline-flex; gap:6px; align-items:center; }
.basis button[aria-pressed="true"], .chip[aria-pressed="true"] { background:var(--ink); color:var(--panel); }
.basis button.ghost { border-color:var(--line); font-weight:500; }
.chip input { width:3.2em; font:500 13px var(--mono); padding:1px 3px; border:1px solid var(--line); border-radius:2px; background:var(--panel); color:var(--ink); }
.basis .tot { margin-left:auto; font:800 22px var(--display); font-stretch:85%; font-variant-numeric:tabular-nums; }
.basis em { font-style:normal; font-size:13px; color:var(--muted); }
.figs { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:1px; background:var(--line); border:1px solid var(--line); }
.fig { background:var(--panel); padding:14px 16px; display:grid; gap:4px; } .fig b { font:800 30px/1 var(--display); font-stretch:80%; font-variant-numeric:tabular-nums; } .fig span { font:12px/1.4 var(--mono); color:var(--muted); }
.cols { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:20px; } .cols > * { min-width:0; }
.chart, .card, .sheet { margin:0; background:var(--panel); border:1px solid var(--line); padding:16px; display:grid; gap:12px; min-width:0; align-content:start; }
figcaption { font:500 12px/1.4 var(--mono); text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
.donut { display:grid; grid-template-columns:minmax(150px, 220px) 1fr; gap:16px; align-items:center; }
@media (max-width:560px) { .donut { grid-template-columns:1fr; } .donut svg { max-width:220px; margin:0 auto; } }
svg text { fill:var(--ink); font-family:var(--mono); } svg .big { font:800 24px var(--display); } svg .sm { font-size:11px; fill:var(--muted); }
.legend { list-style:none; margin:0; padding:0; display:grid; gap:4px; }
.legend li button { all:unset; box-sizing:border-box; width:100%; cursor:pointer; display:grid; grid-template-columns:12px 1fr auto 40px; gap:8px; align-items:center; font-size:14px; padding:4px 6px; border-radius:3px; }
.legend li button:hover { background:var(--paper); } .legend li button[aria-pressed="false"] { opacity:.45; } .legend li button[aria-pressed="false"] span { text-decoration:line-through; }
.legend i { width:12px; height:12px; border-radius:2px; } .legend b { font:500 13px var(--mono); } .legend em { font:12px var(--mono); color:var(--muted); font-style:normal; text-align:right; }
.stack { display:flex; height:26px; gap:2px; border-radius:3px; overflow:hidden; } .stack i { display:block; transition:flex .3s; }
.stack i.later { background-image:repeating-linear-gradient(135deg, transparent 0 5px, rgba(255,255,255,.55) 5px 8px); }
.explore { display:grid; gap:8px; }
.explore details { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--c); } .explore details.off { opacity:.5; }
.explore summary { cursor:pointer; padding:10px 14px; display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center; font:700 16px var(--display); }
.explore summary b { font:500 13px var(--mono); font-variant-numeric:tabular-nums; text-align:right; }
.explore ul { list-style:none; margin:0; padding:0 14px 12px; display:grid; }
.explore li { display:grid; grid-template-columns:1fr auto; gap:4px 10px; align-items:center; font-size:14px; padding:7px 0; border-top:1px solid var(--line); }
.explore li.grp { border-top:2px solid var(--ink); margin-top:6px; padding-top:9px; } .explore li.grp b { font:700 13px var(--mono); text-transform:uppercase; letter-spacing:.06em; }
.explore li small { color:var(--muted); font:12px var(--mono); }
.explore li .amt { font:500 13px var(--mono); font-variant-numeric:tabular-nums; white-space:nowrap; text-align:right; }
.explore li.s-out .nm, .explore li.s-out .amt { text-decoration:line-through; color:var(--muted); } .explore li.s-later .amt { color:var(--muted); font-style:italic; }
.seg { grid-column:1 / -1; display:inline-flex; justify-self:start; border:1px solid var(--line); border-radius:3px; overflow:hidden; }
.seg button { font:500 12px var(--mono); padding:3px 9px; border:0; background:var(--panel); color:var(--muted); cursor:pointer; }
.seg button + button { border-left:1px solid var(--line); }
.seg button[aria-pressed="true"][data-s="now"] { background:var(--good); color:#fff; } .seg button[aria-pressed="true"][data-s="later"] { background:var(--s4); color:#1c252d; } .seg button[aria-pressed="true"][data-s="out"] { background:var(--muted); color:var(--panel); }
em.tg { font:500 10px var(--mono); text-transform:uppercase; letter-spacing:.06em; font-style:normal; border:1px solid currentColor; padding:1px 4px; border-radius:2px; margin-left:6px; white-space:nowrap; }
em.tg.lock { color:var(--s1); } em.tg.ch { color:var(--s2); } li > em.tg { grid-column:1 / -1; justify-self:start; margin:0; }
.tools { display:flex; flex-wrap:wrap; gap:8px; } .tools button { font:500 12px var(--mono); padding:5px 10px; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:3px; cursor:pointer; }
.tw { overflow-x:auto; border:1px solid var(--line); background:var(--panel); } .tw.tall { max-height:520px; overflow:auto; }
table { border-collapse:collapse; width:100%; font-size:14px; } th { text-align:left; font:500 11px var(--mono); text-transform:uppercase; letter-spacing:.07em; color:var(--muted); padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:bottom; background:var(--panel); }
.tw.tall thead th { position:sticky; top:0; }
td { padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top; } td.n { text-align:right; font-family:var(--mono); white-space:nowrap; font-variant-numeric:tabular-nums; } tfoot td { border-top:2px solid var(--ink); border-bottom:0; font-weight:600; }
td.src { font-size:12px; color:var(--muted); max-width:340px; } td code { font:12px var(--mono); color:var(--muted); }
.matrix th .dot { display:inline-block; width:10px; height:10px; border-radius:2px; background:var(--c); margin-right:6px; }
.sc { font:500 11px var(--mono); text-transform:uppercase; letter-spacing:.05em; padding:2px 6px; border-radius:2px; border:1px solid currentColor; white-space:nowrap; }
.sc.ok { color:var(--good); } .sc.warn { color:var(--warn); } .sc.plan { color:var(--plan); border-style:dashed; } .sc.bad { color:var(--crit); }
.scope, .dchecks { list-style:none; margin:0; padding:0; display:grid; gap:6px; font-size:14px; } .dchecks li { display:grid; grid-template-columns:20px 1fr; gap:6px; }
.dchecks .done .ic { color:var(--good); } .dchecks .partial .ic { color:var(--warn); } .dchecks .not .ic { color:var(--crit); }
.callout { border-left:4px solid var(--s2); background:var(--panel); padding:14px 16px; } .callout.plan { border-left-color:var(--plan); }
.hbars { display:grid; gap:8px; } .hb { display:grid; grid-template-columns:minmax(100px, 190px) 1fr minmax(70px, auto); gap:10px; align-items:center; font-size:14px; }
.hb .track { position:relative; height:14px; background:var(--paper); border-radius:2px; } .hb .bar { position:absolute; inset:0 auto 0 0; border-radius:0 4px 4px 0; } .hb b { font:500 13px var(--mono); text-align:right; }
.docs { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:10px; }
.doc { display:grid; gap:2px; padding:12px 14px; border:1px solid var(--line); border-left:4px solid var(--s1); background:var(--panel); color:var(--ink); text-decoration:none; }
.doc b { font:700 16px var(--display); } .doc span { font-size:13px; color:var(--muted); } a.doc:hover { border-color:var(--s1); } .doc.off { border-left-color:var(--line); opacity:.6; }
.gallery { display:grid; grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); gap:14px; } .sheet img { width:100%; aspect-ratio:4/3; object-fit:contain; background:#fff; }
.road { list-style:none; margin:0; padding:0; display:grid; } .road li { display:grid; grid-template-columns:minmax(150px, 260px) 1fr; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); } .road b { font:700 16px var(--display); }
.pbtools { display:flex; flex-wrap:wrap; gap:8px; align-items:center; } .pbtools input[type=search] { font:14px var(--body); padding:6px 10px; border:1px solid var(--line); border-radius:3px; background:var(--panel); color:var(--ink); min-width:0; flex:1 1 220px; max-width:360px; }
.sig { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:1px; background:var(--line); border:2px solid var(--ink); } .sig div { background:var(--panel); padding:12px 14px; display:grid; } .sig span { font:500 11px var(--mono); text-transform:uppercase; color:var(--muted); }
.note { font-size:13px; color:var(--muted); }
a { color:var(--s1); }
"""

BODY = f"""<header class="hero">
  <div class="in gut">
    <div class="eyebrow">{e(FIRM)} · {e(PROJ)} · Project report · {today}</div>
    <h1>{e(PROJ)}: the whole project in one model</h1>
    <p class="lede">Every discipline in one model. Switch a discipline or a part off and it leaves the model, the totals and the charts together. Below, decide for every item whether it is built now, later, or left out, and see what each choice costs.</p>
  </div>
  <div class="viewer"><canvas id="v3d" aria-label="Federated 3D model of {e(PROJ)}"></canvas>
    <div class="vctl gut" role="group" aria-label="Disciplines">{toggle_btns}</div>
    <div class="vlook" role="group" aria-label="Model look"><button data-look="model" aria-pressed="true">Model</button><button data-look="revit" aria-pressed="false">Materials</button><button data-look="disc" aria-pressed="false">Disciplines</button><button id="dusk" aria-pressed="false">Dusk</button><button id="home">Reset view</button></div>
    <div class="vload" id="vload">Building the model…</div>
    <div class="vnote">drag to turn · right-drag or two fingers to move · scroll or pinch to zoom · dashed = no model yet</div></div>
  <div class="parts gut" id="parts" aria-label="Model parts"></div>
</header>

<main class="gut">
<div class="basis" role="group" aria-label="What the totals count">
  <div class="brow"><span class="lbl">Count</span>
    <button class="chip" data-p="mat">Materials</button><button class="chip" data-p="lab">Labour</button><button class="chip" data-p="plant">Plant</button>
    <span class="chip" data-p="pre" role="button" tabindex="0">Preliminaries <input type="number" id="pre-v" min="0" max="40" step="1" aria-label="Preliminaries percent">%</span>
    <span class="chip" data-p="con" role="button" tabindex="0">Contingency <input type="number" id="con-v" min="0" max="40" step="1" aria-label="Contingency percent">%</span>
    <span class="tot" id="t-top" aria-live="polite"></span></div>
  <div class="brow"><span class="lbl">Phase</span><button id="sc-now">Phase 1 only</button><button id="sc-all">Phase 1 and later</button>
    <span class="lbl">Quick</span><button class="ghost" id="pr-mat">Materials only</button><button class="ghost" id="pr-full">Full cost</button></div>
  <em id="basis-note"></em>
</div>

<section>
  <div class="figs">
    <div class="fig"><b id="k-total"></b><span id="k-range"></span></div>
    <div class="fig"><b id="k-bld"></b><span>the buildings alone: house and boys' quarters, without external works, fence and landscape</span></div>
    <div class="fig"><b id="k-now"></b><span>phase 1: built now</span></div>
    <div class="fig"><b id="k-later"></b><span>later phases</span></div>
    <div class="fig"><b id="k-m2"></b><span>per m² of room area ({gfa:,.0f} m², main house and boys' quarters)</span></div>
    <div class="fig"><b id="k-des"></b><span>of the cost counted from designed models</span></div>
    <div class="fig"><b id="k-sel"></b><span>items now / later / left out</span></div>
  </div>
</section>

<section id="costs">
  <div class="chap"><span>01</span><h2>Decide what is built, and when</h2></div>
  <p>Every item can be built now, later, or left out. The structure and the building shell (walls, roof) are always in. Click a discipline in the legend to look at the rest without it. Your choices stay on this device; Reset brings back the recommended set.</p>
  <div class="stack" id="stack" role="img" aria-label="Share of cost by discipline; hatched = later phases"></div>
  <div class="cols">
    <figure class="chart"><figcaption id="donut-cap"></figcaption><div class="donut"><svg viewBox="0 0 240 240" id="donut" role="img" aria-label="Cost by discipline"></svg><ul class="legend" id="legend"></ul></div></figure>
    <div class="card"><h3>Items</h3><div class="tools"><button id="all-now">Everything now</button><button id="shell">Structure and shell only</button><button id="reset">Reset</button></div><div class="explore" id="explore"></div></div>
  </div>
  <div class="tw"><table><thead><tr><th>Discipline</th><th>Status</th><th>Phase 1</th><th>Later</th><th>Counted, low</th><th>Counted, likely</th><th>Counted, high</th></tr></thead><tbody id="ctab"></tbody><tfoot id="cfoot"></tfoot></table></div>
  <p class="note">Rates come from the Formcraft price book below. Each rate is split into materials (with waste), labour and plant, so each part can be counted or left out. Allowance splits are assumptions until each discipline is designed. Excluded: land, professional fees, permits, VAT where applicable.</p>
</section>

<section id="prices">
  <div class="chap"><span>02</span><h2>The prices behind the rates</h2></div>
  <p>Every rate is built up from these prices. When a price changes in the price book, every rate, total and chart in this report is recalculated from it.</p>
  <div class="figs"><div class="fig"><b>{len(PB)}</b><span>prices in the book</span></div><div class="fig"><b>{pb_n["market"]}</b><span>market: current listings or quotes</span></div><div class="fig"><b>{pb_n["secondary"]}</b><span>secondary: published lists</span></div><div class="fig"><b>{pb_n["assumed"]}</b><span>assumed: to be confirmed</span></div></div>
  <div class="pbtools"><input type="search" id="pb-q" placeholder="Find a price (cement, tile, mason…)" aria-label="Find a price"><button class="chip" data-st="" aria-pressed="true">All</button><button class="chip" data-st="market" aria-pressed="false">Market</button><button class="chip" data-st="secondary" aria-pressed="false">Secondary</button><button class="chip" data-st="assumed" aria-pressed="false">Assumed</button></div>
  <div class="tw tall"><table><thead><tr><th>Item</th><th>Unit</th><th>Low</th><th>Likely</th><th>High</th><th>Status</th><th>Source</th></tr></thead><tbody id="pbody"></tbody></table></div>
  <p class="note">Price book: <code>07_Materials/FMC_Price_Book.csv</code> (opens in Excel). Edit a price there, then run <code>scripts/cost/update.cmd</code>.</p>
</section>

<section>
  <div class="chap"><span>03</span><h2>What each discipline covers</h2></div>
  <p>Which part of the project each discipline's figures include. Hover a cell for detail. "Allowance" means costed but not designed yet.</p>
  <div class="tw"><table class="matrix"><thead><tr><th>Part of the project</th>{mat_head}</tr></thead><tbody>{mat_rows}</tbody></table></div>
</section>

<section>
  <div class="chap"><span>04</span><h2>Design progress</h2></div>
  <ul class="road">{road}</ul>
</section>

{"".join(chapters)}

<section>
  <div class="sig"><div><span>Prepared by</span><b>{e(PRES)}, {e(FIRM)}</b></div><div><span>Status</span><b>Design development — figures preliminary</b></div><div><span>Date</span><b>{today}</b></div></div>
  <p class="note">Prepared with Autodesk Revit, Autodesk Robot Structural Analysis and the Formcraft Construction plugin (Formcraft Revit Tools).</p>
</section>
</main>"""

JS = r"""
(function () {
  const $ = (id) => document.getElementById(id), KEY = "ogala-costs-v2";
  const rec = () => ({ on: COST.full0 ? { mat: 1, lab: 1, plant: 1, pre: 1, con: 1 } : { mat: 1, con: 1 }, pre: COST.pre, con: COST.con, scope: "now", discOff: {}, stage: {}, partOff: {}, look: "model", dusk: false });
  let S = rec(); try { S = Object.assign(rec(), JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (x) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (x) {} };
  const M = (x) => (x / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 }) + "M", BN = (x) => (x / 1e9).toFixed(2) + "bn";
  const discOn = (d) => !S.discOff[d.d];
  const st = (it) => it.locked ? "now" : (S.stage[it.id] || it.s0);
  const amt = (it, i) => it.qty * ((S.on.mat ? it.r.mat[i] : 0) + (S.on.lab ? it.r.lab[i] : 0) + (S.on.plant ? it.r.plant[i] : 0));
  const LIVE = new Set(Object.values(PARTS).flat().filter((p) => p.live).map((p) => p.k));
  const pOn = (it) => !(it.p && LIVE.has(it.p) && S.partOff[it.p]);
  const sumD = (d, sts, i) => discOn(d) ? d.items.reduce((a, it) => a + (sts.includes(st(it)) && pOn(it) ? amt(it, i) : 0), 0) : 0;
  const pre = () => S.on.pre ? S.pre / 100 : 0, con = () => S.on.con ? S.con / 100 : 0, K = () => (1 + pre()) * (1 + con());
  const SC = () => S.scope === "all" ? ["now", "later"] : ["now"];
  let hook3d = () => {};
  const STG = [["now", "Now"], ["later", "Later"], ["out", "Leave out"]], SITE = ["external", "landscape"];
  const itemLi = (it) => { const s = pOn(it) ? st(it) : "out"; return `<li class="s-${s}"${pOn(it) ? "" : ' title="Its part is switched off above"'}><span class="nm">${it.label} <small>${it.qty.toLocaleString()} ${it.unit}</small></span><span class="amt">${M(amt(it, 1))}</span>` +
    (it.locked ? `<em class="tg lock">always in: structure and shell</em>` : `<span class="seg" role="group" aria-label="When">` + STG.map(([v, l]) => `<button data-i="${it.id}" data-s="${v}" aria-pressed="${s === v}">${l}</button>`).join("") + "</span>") + "</li>"; };
  const groupsOf = (d) => [...new Set(d.items.map((it) => it.group || "Items"))].map((g) => [g, d.items.filter((it) => (it.group || "Items") === g)]);
  function render() {
    document.querySelectorAll(".basis .chip[data-p]").forEach((b) => b.setAttribute("aria-pressed", !!S.on[b.dataset.p]));
    $("pre-v").value = S.pre; $("con-v").value = S.con;
    $("sc-now").setAttribute("aria-pressed", S.scope === "now"); $("sc-all").setAttribute("aria-pressed", S.scope === "all");
    const k = K(), sc = SC();
    const D = COST.discs.map((d) => ({ d, t: [0, 1, 2].map((i) => sumD(d, sc, i)), now: sumD(d, ["now"], 1), later: sumD(d, ["later"], 1) }));
    const sub = [0, 1, 2].map((i) => D.reduce((a, x) => a + x.t[i], 0)), tot = sub.map((x) => x * k);
    const nowT = D.reduce((a, x) => a + x.now, 0) * k, laterT = D.reduce((a, x) => a + x.later, 0) * k;
    const des = D.filter((x) => x.d.status === "designed").reduce((a, x) => a + x.t[1], 0);
    const parts = ["mat", "lab", "plant"].filter((p) => S.on[p]).map((p) => ({ mat: "materials", lab: "labour", plant: "plant" })[p]);
    const what = (parts.length ? parts.join(", ") : "nothing") + (S.on.pre ? `, preliminaries ${S.pre}%` : "") + (S.on.con ? `, contingency ${S.con}%` : "");
    $("t-top").textContent = "UGX " + BN(tot[1]); $("k-total").textContent = "UGX " + BN(tot[1]);
    $("k-range").textContent = (S.scope === "now" ? "phase 1" : "phase 1 and later") + ", likely (" + BN(tot[0]) + "–" + BN(tot[2]) + ")";
    const siteItem = (it) => /external|landscape/i.test(it.label);   // paving and planting drawn in the architecture are site works too
    $("k-bld").textContent = "UGX " + BN(COST.discs.filter((d) => !SITE.includes(d.d) && discOn(d)).reduce((a, d) => a + d.items.reduce((b, it) => b + (sc.includes(st(it)) && pOn(it) && !siteItem(it) ? amt(it, 1) : 0), 0), 0) * k);
    $("k-now").textContent = "UGX " + BN(nowT); $("k-later").textContent = "UGX " + BN(laterT);
    $("k-m2").textContent = "UGX " + (tot[1] / COST.gfa / 1e6).toFixed(2) + "M"; $("k-des").textContent = sub[1] ? Math.round(100 * des / sub[1]) + "%" : "—";
    const cnt = { now: 0, later: 0, out: 0 }; COST.discs.forEach((d) => discOn(d) && d.items.forEach((it) => cnt[st(it)]++));
    $("k-sel").textContent = cnt.now + " / " + cnt.later + " / " + cnt.out;
    const hid = COST.discs.filter((d) => !discOn(d)).map((d) => d.short);
    $("basis-note").textContent = "Counting " + what + (hid.length ? ". Hidden from view and totals: " + hid.join(", ") : "") + ". Labour and plant rates are still being confirmed with contractors.";
    const all = D.reduce((a, x) => a + x.now + x.later, 0) || 1;
    $("stack").innerHTML = D.map((x) => (x.now > 0 ? `<i style="flex:${x.now};background:${x.d.color}" title="${x.d.short}, phase 1: UGX ${M(x.now)}"></i>` : "") +
      (S.scope === "all" && x.later > 0 ? `<i class="later" style="flex:${x.later};background-color:${x.d.color}" title="${x.d.short}, later: UGX ${M(x.later)}"></i>` : "")).join("");
    let a = -Math.PI / 2, svg = ""; const R0 = 70, R1 = 108, P = (ang, r) => [120 + r * Math.cos(ang), 120 + r * Math.sin(ang)];
    for (const x of D) { if (x.t[1] <= 0) continue; const da = 2 * Math.PI * x.t[1] / sub[1], a2 = a + da, g = 0.01, lg = da > Math.PI ? 1 : 0;
      const [x1, y1] = P(a + g, R1), [x2, y2] = P(a2 - g, R1), [x3, y3] = P(a2 - g, R0), [x4, y4] = P(a + g, R0);
      svg += `<path d="M${x1},${y1} A${R1},${R1} 0 ${lg} 1 ${x2},${y2} L${x3},${y3} A${R0},${R0} 0 ${lg} 0 ${x4},${y4} Z" fill="${x.d.color}"><title>${x.d.short}: UGX ${M(x.t[1])}</title></path>`; a = a2; }
    svg += `<text x="120" y="116" text-anchor="middle" class="big">${M(sub[1])}</text><text x="120" y="138" text-anchor="middle" class="sm">UGX before % additions</text>`;
    $("donut").innerHTML = svg; $("donut-cap").textContent = "Cost by discipline, " + (S.scope === "now" ? "phase 1" : "phase 1 and later") + " (likely)";
    $("legend").innerHTML = D.map((x) => `<li><button data-d="${x.d.d}" aria-pressed="${discOn(x.d)}"><i style="background:${x.d.color}"></i><span>${x.d.short}</span><b>${M(x.t[1])}</b><em>${sub[1] ? Math.round(100 * x.t[1] / sub[1]) : 0}%</em></button></li>`).join("");
    const open = new Set([...document.querySelectorAll("#explore details[open]")].map((x) => x.dataset.d));
    $("explore").innerHTML = COST.discs.map((d) => `<details data-d="${d.d}" style="--c:${d.color}" class="${discOn(d) ? "" : "off"}" ${open.has(d.d) ? "open" : ""}><summary><span>${d.short}</span><b>now ${M(sumD(d, ["now"], 1))}<br>later ${M(sumD(d, ["later"], 1))}</b></summary><ul>` +
      groupsOf(d).map(([g, its]) => { const free = its.filter((it) => !it.locked), one = free.length && free.every((it) => st(it) === st(free[0])) ? st(free[0]) : "";
        return `<li class="grp"><b>${g}</b><span class="amt">${M(its.reduce((a, it) => a + (SC().includes(st(it)) && pOn(it) ? amt(it, 1) : 0), 0))}</span>` +
          (free.length ? `<span class="seg" role="group" aria-label="${g}: when">` + STG.map(([v, l]) => `<button data-g="${d.d}|${g}" data-s="${v}" aria-pressed="${one === v}">All ${l.toLowerCase()}</button>`).join("") + "</span>" : `<em class="tg lock">always in</em>`) + "</li>" + its.map(itemLi).join(""); }).join("") + "</ul></details>").join("");
    $("ctab").innerHTML = D.map((x) => `<tr${discOn(x.d) ? "" : ' style="opacity:.45"'}><td>${x.d.label}</td><td>${x.d.status === "designed" ? "Designed" : "Allowance"}</td><td class="n">${M(x.now)}</td><td class="n">${M(x.later)}</td>` + [0, 1, 2].map((i) => `<td class="n">${i === 1 ? "<b>" : ""}${M(x.t[i])}${i === 1 ? "</b>" : ""}</td>`).join("") + "</tr>").join("") +
      (S.on.pre ? `<tr><td>Preliminaries &amp; margin</td><td>${S.pre}%</td><td></td><td></td>` + sub.map((x) => `<td class="n">${M(x * pre())}</td>`).join("") + "</tr>" : "") +
      (S.on.con ? `<tr><td>Contingency</td><td>${S.con}%</td><td></td><td></td>` + sub.map((x) => `<td class="n">${M(x * (1 + pre()) * con())}</td>`).join("") + "</tr>" : "");
    $("cfoot").innerHTML = `<tr><td>Total counted</td><td></td><td class="n">${M(nowT)}</td><td class="n">${M(laterT)}</td>` + tot.map((x) => `<td class="n">${M(x)}</td>`).join("") + "</tr>";
    document.querySelectorAll(".dtog").forEach((b) => b.setAttribute("aria-pressed", !S.discOff[b.dataset.d]));
    document.querySelectorAll(".vlook [data-look]").forEach((b) => b.setAttribute("aria-pressed", S.look === b.dataset.look)); $("dusk").setAttribute("aria-pressed", S.dusk);
    $("parts").innerHTML = COST.discs.filter((d) => PARTS[d.d]).map((d) => `<div class="prow${discOn(d) ? "" : " off"}"><b><i style="background:${d.color}"></i>${d.short}</b>` + PARTS[d.d].map((p) => {
      const c = d.items.filter((it) => it.p === p.k && sc.includes(st(it))).reduce((a, it) => a + amt(it, 1), 0) * k;
      return `<button class="ptog" data-k="${p.k}" ${p.live ? "" : "disabled"} aria-pressed="${p.live && !S.partOff[p.k]}" title="${p.live ? "Switch this part in the model and the totals" : "Not designed yet: it switches on here once it is in the model"}">${p.name}${c ? `<small>${M(c)}</small>` : ""}</button>`; }).join("") + "</div>").join("");
    hook3d(); save();
  }
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.closest("input")) return;
    const b = t.closest("#legend button, .dtog"); if (b) { S.discOff[b.dataset.d] = !S.discOff[b.dataset.d]; if (!S.discOff[b.dataset.d]) delete S.discOff[b.dataset.d]; render(); return; }
    const gb = t.closest(".seg button[data-g]"); if (gb) { const [dd, g] = gb.dataset.g.split("|"); COST.discs.find((x) => x.d === dd).items.forEach((it) => { if ((it.group || "Items") === g && !it.locked) { if (gb.dataset.s === it.s0) delete S.stage[it.id]; else S.stage[it.id] = gb.dataset.s; } }); render(); return; }
    const sg = t.closest(".seg button"); if (sg) { const it = COST.discs.flatMap((d) => d.items).find((x) => x.id === sg.dataset.i); if (sg.dataset.s === it.s0) delete S.stage[it.id]; else S.stage[it.id] = sg.dataset.s; render(); return; }
    const c = t.closest(".basis .chip[data-p]"); if (c) { S.on[c.dataset.p] = S.on[c.dataset.p] ? 0 : 1; render(); return; }
    const pt = t.closest(".ptog"); if (pt) { const k = pt.dataset.k; S.partOff[k] = !S.partOff[k]; if (!S.partOff[k]) delete S.partOff[k]; render(); return; }
    const lk = t.closest("[data-look]"); if (lk) { S.look = lk.dataset.look; render(); return; }
  });
  document.addEventListener("keydown", (ev) => { const c = ev.target.closest && ev.target.closest('.chip[role="button"]'); if (c && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); c.click(); } });
  const pct = (id, k) => $(id).addEventListener("change", (ev) => { const v = Math.max(0, Math.min(40, +ev.target.value || 0)); S[k] = v; S.on[k] = 1; render(); });
  pct("pre-v", "pre"); pct("con-v", "con");
  $("sc-now").onclick = () => { S.scope = "now"; render(); }; $("sc-all").onclick = () => { S.scope = "all"; render(); };
  $("pr-mat").onclick = () => { S.on = { mat: 1, con: 1 }; render(); }; $("pr-full").onclick = () => { S.on = { mat: 1, lab: 1, plant: 1, pre: 1, con: 1 }; render(); };
  $("dusk").onclick = () => { S.dusk = !S.dusk; render(); };
  $("all-now").onclick = () => { S.stage = {}; COST.discs.forEach((d) => d.items.forEach((it) => { if (!it.locked) S.stage[it.id] = "now"; })); S.discOff = {}; render(); };
  $("shell").onclick = () => { S.stage = {}; COST.discs.forEach((d) => d.items.forEach((it) => { if (!it.locked) S.stage[it.id] = "later"; })); render(); };
  $("reset").onclick = () => { const keep = { on: S.on, pre: S.pre, con: S.con, look: S.look, dusk: S.dusk }; S = Object.assign(rec(), keep); render(); };

  // ---- price book
  let pbSt = "";
  const pbRender = () => { const q = $("pb-q").value.trim().toLowerCase();
    $("pbody").innerHTML = PB.filter((r) => (!pbSt || r[6] === pbSt) && (!q || (r[0] + " " + r[1]).toLowerCase().includes(q))).map((r) =>
      `<tr><td>${r[1]}<br><code>${r[0]}</code></td><td>${r[2]}</td>` + [3, 4, 5].map((i) => `<td class="n">${i === 4 ? "<b>" : ""}${Math.round(r[i]).toLocaleString()}${i === 4 ? "</b>" : ""}</td>`).join("") +
      `<td><span class="sc ${{ market: "ok", secondary: "warn", assumed: "plan" }[r[6]] || "plan"}">${r[6]}</span></td><td class="src">${r[7]}${r[8] ? " · " + r[8] : ""}</td></tr>`).join(""); };
  $("pb-q").addEventListener("input", pbRender);
  document.querySelectorAll(".pbtools .chip").forEach((b) => b.onclick = () => { pbSt = b.dataset.st; document.querySelectorAll(".pbtools .chip").forEach((x) => x.setAttribute("aria-pressed", x === b)); pbRender(); });
  pbRender();

  // ---- federated 3D in the website's look: matte model colours, soft sun shadows, build-up, dusk
  const CATDISC = {}; Object.entries(PARTS).forEach(([d, L]) => L.forEach((p) => p.cats.forEach((c) => { if (c !== "*" && c !== "#lines") CATDISC[c] = d; })));
  const DCOL = Object.fromEntries(COST.discs.map((d) => [d.d, d.color]));
  const CATCOL = { Furniture: "#ffae61", Casework: "#ffae61", "Plumbing Fixtures": "#ffffff", "Lighting Fixtures": "#ffae61", Doors: "#a0805d", Windows: "#1c252d", "Curtain Wall Mullions": "#1c252d", Railings: "#1c252d", "Top Rails": "#1c252d", Gutters: "#1c252d", Fascias: "#efeeea", Site: "#c8c2b0", Pipes: "#9aa0a4", "Wall Sweeps": "#e2e1dc" };
  const partOf = (d, cat) => { const L = PARTS[d] || []; return L.find((p) => p.cats.includes(cat)) || L.find((p) => p.cats.includes("*")) || { k: d + "/Model", name: "Model", colour: "#c8bfae", order: 5 }; };
  const cv = $("v3d"), PG = [], MESH = [];
  async function inflate(b64) {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Uint8Array(await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }
  if (window.THREE) (async () => { try {
    // renderer, lights and paper exactly as the website's hotel scene (FMC_WEB src/components/scene/hotel/hotelDay.js)
    let dirty = 2;
    const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, logarithmicDepthBuffer: true }); r.setPixelRatio(Math.min(2, devicePixelRatio || 1)); r.physicallyCorrectLights = true;
    r.outputEncoding = THREE.sRGBEncoding; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.92;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap; r.shadowMap.autoUpdate = false;
    const C = (h) => new THREE.Color(h).convertSRGBToLinear();
    const scene = new THREE.Scene(), DAY = C("#e4e3df"), DUSK = C("#4a5560"); scene.background = DAY.clone(); scene.fog = new THREE.Fog(DAY.clone(), 120, 320);
    const cam = new THREE.PerspectiveCamera(34, 1, 0.1, 1200);
    const hemi = new THREE.HemisphereLight(C("#ffffff"), C("#b9bdc1"), 0.5), sun = new THREE.DirectionalLight(C("#fff6ea"), 2.1), fill = new THREE.DirectionalLight(C("#ffe2c6"), 0.45);
    scene.add(hemi, sun, fill, sun.target); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 4;
    const tl = new THREE.TextureLoader(), tex = (u, srgb) => { if (!u) return null; const t = tl.load(u, () => (dirty = 2)); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.encoding = THREE.sRGBEncoding; t.anisotropy = r.capabilities.getMaxAnisotropy(); return t; };
    const paperTex = tex(TEX.paper, true), normTex = tex(TEX.normal, false);
    const paper = (hex, k) => new THREE.MeshStandardMaterial({ color: C(hex), map: paperTex, normalMap: normTex, normalScale: new THREE.Vector2(k || 1, k || 1), roughness: 0.94, metalness: 0, side: THREE.DoubleSide });
    const lin = new Float32Array(256).map((_, i) => Math.pow(i / 255, 2.2));
    const groups = {}, part = (d, p) => { const k = p.k; if (!groups[k]) { const g = new THREE.Group(); g.userData = { d, name: p.name, order: p.order, k }; scene.add(g); groups[k] = g; PG.push(g); } return groups[k]; };
    const matFor = (col, glass) => glass ? new THREE.MeshStandardMaterial({ color: C("#d9dee0"), roughness: 0.22, metalness: 0.1, emissive: C("#ffad5e"), emissiveIntensity: 0, side: THREE.DoubleSide }) : paper(col);
    const add = (g, mesh, info) => { if (info.d === "structure" && mesh.material) Object.assign(mesh.material, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }); mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData = info; g.add(mesh); MESH.push(mesh); };
    const P = (x, y, z) => new THREE.Vector3(x / 1000, z / 1000, -y / 1000);
    const greens = ["#3f6b35", "#4f7d3a", "#5f8f43", "#74a24f", "#8db75e"];
    // shells -> flat faces with paper laid on by the face's direction (1 tile = 4 m, as on the website)
    function paperUV(geo) {
      const g = geo.toNonIndexed(), p = g.attributes.position.array, n = p.length / 3, uv = new Float32Array(n * 2);
      for (let t = 0; t < n; t += 3) {
        const i = 3 * t, ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2], bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
        const nx = Math.abs(ay * bz - az * by), ny = Math.abs(az * bx - ax * bz), nz = Math.abs(ax * by - ay * bx), ax2 = ny >= nx && ny >= nz ? 1 : nx >= nz ? 0 : 2;
        for (let v = t; v < t + 3; v++) { const x = p[3 * v], y = p[3 * v + 1], z = p[3 * v + 2]; uv[2 * v] = (ax2 === 0 ? z : x) / 4; uv[2 * v + 1] = (ax2 === 1 ? z : y) / 4; }
      }
      g.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); g.computeVertexNormals(); return g;
    }
    // planting at its real size and place (planters, hedges, shrubs): a paper bush filling the Revit element's box
    function shrub(g, d, lo, hi, k) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), paper(greens[2 + k % 3], 0.45));
      m.scale.set(Math.max(0.15, (hi[0] - lo[0]) / 2), Math.max(0.15, (hi[1] - lo[1]) / 2), Math.max(0.15, (hi[2] - lo[2]) / 2));
      m.position.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2); m.rotation.y = k; add(g, m, { d, cat: "Planting", fixed: true });
    }
    for (const [d, m] of Object.entries(FED)) {
      if (m.mesh) {
        const o = m.mesh.offset, s = m.mesh.scale;
        for (const gr of m.mesh.groups) {
          const dd = CATDISC[gr.cat] || d, p = partOf(dd, gr.cat), g = part(dd, p);
          const q = new Uint16Array((await inflate(gr.pos)).buffer), c = await inflate(gr.col), ib = (await inflate(gr.idx)).buffer, n = gr.verts;
          const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
          for (let v = 0; v < n; v++) { pos[3 * v] = o[0] + q[3 * v] * s; pos[3 * v + 1] = o[2] + q[3 * v + 2] * s; pos[3 * v + 2] = -(o[1] + q[3 * v + 1] * s); col[3 * v] = lin[c[3 * v]]; col[3 * v + 1] = lin[c[3 * v + 1]]; col[3 * v + 2] = lin[c[3 * v + 2]]; }
          if (gr.cat === "Planting") {   // boxes from the export -> bushes the same size, in the same place
            for (let b = 0; b + 8 <= n; b += 8) {
              let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (let v = b; v < b + 8; v++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[3 * v + k]); hi[k] = Math.max(hi[k], pos[3 * v + k]); }
              shrub(g, d, lo, hi, b / 8);
            }
            continue;
          }
          const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
          geo.setIndex(new THREE.BufferAttribute(gr.i32 ? new Uint32Array(ib) : new Uint16Array(ib), 1));
          add(g, new THREE.Mesh(paperUV(geo), matFor(CATCOL[gr.cat] || p.colour, gr.glass)), { d: dd, cat: gr.cat, glass: gr.glass, model: CATCOL[gr.cat] || p.colour });
        }
      } else {   // simple boxes and slabs (no Revit export yet)
        const p = partOf(d, "*"), g = part(d, p), mt = () => matFor(m.color || "#c8bfae");
        (m.boxes || []).forEach(([x0, y0, z0, x1, y1, z1, b, h]) => {
          const A = P(x0, y0, z0), B = P(x1, y1, z1); let me;
          if (Math.abs(x0 - x1) < 1 && Math.abs(y0 - y1) < 1) { me = new THREE.Mesh(new THREE.BoxGeometry(b / 1000, (z1 - z0) / 1000, b / 1000), mt()); me.position.copy(A.clone().add(B).multiplyScalar(0.5)); }
          else { me = new THREE.Mesh(new THREE.BoxGeometry(b / 1000, h / 1000, A.distanceTo(B)), mt()); me.position.copy(A.clone().add(B).multiplyScalar(0.5)); me.position.y += h / 2000; me.lookAt(B.x, me.position.y, B.z); }
          add(g, me, { d, cat: "Model", model: m.color || "#c8bfae" });
        });
        (m.prisms || []).forEach(([lp, z0, z1]) => {
          const me = new THREE.Mesh(new THREE.ExtrudeGeometry(new THREE.Shape(lp.map((q) => new THREE.Vector2(q[0] / 1000, q[1] / 1000))), { depth: Math.max(10, z1 - z0) / 1000, bevelEnabled: false }), mt());
          me.rotation.x = -Math.PI / 2; me.position.y = z0 / 1000; add(g, me, { d, cat: "Model", model: m.color || "#c8bfae" });
        });
      }
      if ((m.lines || []).length) {
        const p = partOf(d, "#lines"), pts = []; m.lines.forEach(([A, B]) => pts.push(P(...A), P(...B)));
        const ls = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: C(p.colour) })); ls.userData = { d, cat: "lines", model: p.colour, line: true }; part(d, p).add(ls); MESH.push(ls);
      }
    }
    // frame the building (not the whole site), ground and shadows to suit
    const bb = new THREE.Box3(); PG.filter((g) => g.userData.name !== "Site & paving" && g.userData.d !== "landscape").forEach((g) => bb.expandByObject(g));
    const ctr = bb.getCenter(new THREE.Vector3()), sz = bb.getSize(new THREE.Vector3()), R = Math.max(sz.x, sz.z, 8);
    const gm = paper("#e9e8e4", 0.3); if (paperTex) { gm.map = paperTex.clone(); gm.map.needsUpdate = true; gm.map.repeat.set(R * 3.5, R * 3.5); }
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(R * 14, R * 14), gm);
    ground.rotation.x = -Math.PI / 2; ground.position.set(ctr.x, bb.min.y - 0.06, ctr.z); ground.receiveShadow = true; scene.add(ground);
    sun.position.copy(ctr).add(new THREE.Vector3(-R * 1.1, R * 1.0, R * 0.9)); sun.target.position.copy(ctr); fill.position.copy(ctr).add(new THREE.Vector3(R, R * 0.5, -R));
    const sc = sun.shadow.camera; sc.left = -R * 1.2; sc.right = R * 1.2; sc.top = R * 1.2; sc.bottom = -R * 1.2; sc.near = 1; sc.far = R * 5; sc.updateProjectionMatrix();
    scene.fog.near = R * 2.5; scene.fog.far = R * 7;
    cam.position.copy(ctr).add(new THREE.Vector3(R * 0.62, R * 0.4, R * 0.78));
    // fully free: orbit all round, pan (right-drag / two fingers), zoom from inside a room to the whole site
    const ctl = new THREE.OrbitControls(cam, cv); ctl.target.copy(ctr); ctl.enableDamping = true; ctl.screenSpacePanning = true; ctl.minDistance = 0.2; ctl.maxDistance = R * 12; ctl.zoomSpeed = 1.2;
    ctl.listenToKeyEvents && ctl.listenToKeyEvents(window); ctl.saveState();
    $("home").onclick = () => { ctl.reset(); ctl.autoRotate = false; };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches; ctl.autoRotate = !reduced; ctl.autoRotateSpeed = 0.45;
    cv.addEventListener("pointerdown", () => (ctl.autoRotate = false));
    hook3d = () => {
      MESH.forEach((me) => { const u = me.userData; if (u.fixed || u.glass) return; const want = S.look === "revit" && !u.line ? "#ffffff" : S.look === "disc" ? DCOL[u.d] : u.model;
        me.material.color.copy(C(want)); const vc = S.look === "revit" && !u.line; if (me.material.vertexColors !== vc) { me.material.vertexColors = vc; me.material.needsUpdate = true; } });
      const k = S.dusk ? 1 : 0; scene.background.copy(DAY).lerp(DUSK, k); scene.fog.color.copy(scene.background);
      sun.intensity = 2.1 - 1.35 * k; hemi.intensity = 0.5 - 0.25 * k; fill.intensity = 0.4 - 0.22 * k;
      MESH.forEach((me) => { if (me.userData.glass) me.material.emissiveIntensity = k * 1.15; });
      dirty = 2;
    };
    const t0 = performance.now();
    const fit = () => { const w = cv.clientWidth, h = cv.clientHeight; r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }; addEventListener("resize", fit); fit();
    $("vload").hidden = true; hook3d();
    (function loop() {
      const t = (performance.now() - t0) / 1000; let building = false;
      PG.forEach((g) => { const u = g.userData, kk = reduced ? 1 : Math.min(1, Math.max(0, (t - u.order * 0.32) / 0.8)), ez = 1 - Math.pow(1 - kk, 3);
        if (kk < 1) building = true; g.position.y = (1 - ez) * 3.5; g.visible = kk > 0 && !S.discOff[u.d] && !S.partOff[u.k]; });
      if (building || dirty > 0) { r.shadowMap.needsUpdate = true; dirty--; }
      ctl.update(); r.render(scene, cam); requestAnimationFrame(loop);
    })();
  } catch (x) { $("vload").textContent = "The 3D model could not be opened in this browser. Everything below still works."; } })();
  else $("vload").textContent = "The 3D model could not be loaded. Everything below still works.";
  render();
})();
"""

page = (f"""<title>Ogala Project Report</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..100,500..800&family=Public+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>{CSS}</style>
{BODY}
<script src="{three}"></script>
<script src="{orbit}"></script>
<script>
const COST = {json.dumps(COST, separators=(",", ":"))};
const PB = {json.dumps(PB, separators=(",", ":"))};
const FED = {json.dumps(fed, separators=(",", ":"))};
const TEX = {json.dumps(TEX)};
const PARTS = {json.dumps(MPARTS, separators=(",", ":"))};
""" + JS + "</script>")
open(OUT, "w", encoding="utf-8").write(page)
sub = {k: sum(dsum(p, k, 1) for p in pks) for k in ("rate_mat", "rate")}
print(OUT, f"{len(page) / 1e6:.2f} MB", f"all items: materials {sub['rate_mat'] * (1 + conting / 100) / 1e9:.2f}bn, full {sub['rate'] * (1 + prelim / 100) * (1 + conting / 100) / 1e9:.2f}bn; {len(PB)} prices")
