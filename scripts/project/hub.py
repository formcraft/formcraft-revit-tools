# The designers' hub: one internal page with every project's releases (release.py), each with its documents by audience
# (client / professional / internal) and their links, the disciplines' design status and checks, the cost, and what
# changed. Built from <projects root>/*/01_WIP/_Release; rebuild after each release.
#   python -I scripts/project/hub.py <projects root> <out html>
import json, os, sys, glob, html, datetime
ROOT, OUT = sys.argv[1:3]; e = html.escape
J = lambda p, d=None: json.load(open(p, encoding="utf-8")) if os.path.exists(p) else d
projects = []
for idx in sorted(glob.glob(os.path.join(ROOT, "*", "01_WIP", "_Release", "index.json"))):
    I = J(idx); rel = os.path.dirname(idx)
    ms = [J(os.path.join(rel, r["folder"], "manifest.json")) for r in I["releases"]]
    projects.append((I, [m for m in ms if m]))
LBL = {"designed": ("Designed", "ok"), "in_progress": ("In progress", "warn"), "not_started": ("Allowance only", "plan")}
AUD = [("client", "For the client"), ("professional", "For the professionals who stamp"), ("internal", "Design data (internal)")]
cards = []
for I, ms in projects:
    m = ms[-1]; s = m["summary"]
    rows = "".join(f'<tr><td>{e(d.title())}</td><td><span class="tag {LBL.get(v["status"], ("", ""))[1]}">{LBL.get(v["status"], (v["status"], ""))[0]}</span></td>'
                   f'<td class="n">{v["checks_done"]} / {v["checks"]}</td><td class="n">{s["cost_full_likely_ugx"].get(d, 0) / 1e6:,.0f}M</td></tr>' for d, v in sorted(s["disciplines"].items()))
    docs = "".join(f'<div class="aud"><h4>{t}</h4><ul>' + "".join(
        f'<li>{"<a href=" + chr(34) + e(x["url"]) + chr(34) + ">" + e(x["title"]) + "</a>" if x.get("url") else e(x["title"])} <span class="f">{e(x["file"])}</span></li>' for x in m["documents"] if x["audience"] == a) + "</ul></div>" for a, t in AUD)
    hist = "".join(f'<li><b>{e(x["label"])}</b> {e(x["date"][:10])} · {e(x.get("note") or "")}<ul>' + "".join(f"<li>{e(c)}</li>" for c in x["changes"]) + "</ul></li>" for x in reversed(ms))
    st = s.get("structure", {})
    cards.append(f'''<section class="proj"><header><div><span class="code">{e(m["code"])}</span><h2>{e(m["project"])}</h2></div><div class="rel">{e(m["label"])} · {e(m["date"][:10])} · {e(m["status"])}</div></header>
<div class="figs"><div><b>UGX {s["total_full_likely_ugx"] / 1e9:.2f}bn</b><span>works, likely, all items, before preliminaries and contingency</span></div><div><b>{(st.get("steel_kg") or 0) / 1000:.1f} t</b><span>reinforcement</span></div>
<div><b>{"Yes" if st.get("redundant") else "No"}</b><span>frame stands without the walls</span></div><div><b>{len(m["documents"])}</b><span>documents in this release</span></div></div>
<div class="cols"><div><h3>Disciplines</h3><table><thead><tr><th>Discipline</th><th>Status</th><th>Checks</th><th>Cost</th></tr></thead><tbody>{rows}</tbody></table></div><div><h3>Documents</h3>{docs}</div></div>
<details><summary>Release history ({len(ms)})</summary><ul class="hist">{hist}</ul></details></section>''')
page = f'''<title>Formcraft Design Hub</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root {{ --paper:#f4f5f2; --panel:#fff; --ink:#1c252d; --muted:#5d6872; --line:#d9ddd8; --acc:#d15334; --ok:#2f8a4c; --warn:#b07800; --plan:#5d6872;
  --sans:"IBM Plex Sans", "Segoe UI", Arial, sans-serif; --mono:"IBM Plex Mono", Consolas, monospace; }}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --paper:#13171a; --panel:#1b2024; --ink:#ebeee9; --muted:#a6afb6; --line:#2c3338; --acc:#e47a5d; --ok:#55b673; --warn:#e0a63a; --plan:#a6afb6; color-scheme:dark }} }}
:root[data-theme="dark"] {{ --paper:#13171a; --panel:#1b2024; --ink:#ebeee9; --muted:#a6afb6; --line:#2c3338; --acc:#e47a5d; --ok:#55b673; --warn:#e0a63a; --plan:#a6afb6; color-scheme:dark }}
body {{ background:var(--paper); color:var(--ink); font:15px/1.55 var(--sans); }}
.wrap {{ max-width:1100px; margin:0 auto; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); padding-block:28px 64px; display:grid; gap:22px; }}
h1 {{ font:700 clamp(26px, 4vw, 36px)/1.1 var(--sans); margin:0; }} .lede {{ color:var(--muted); margin:0; max-width:70ch; }}
.proj {{ background:var(--panel); border:1px solid var(--line); border-top:4px solid var(--acc); padding:18px; display:grid; gap:16px; min-width:0; }}
.proj header {{ display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; align-items:baseline; }} .code {{ font:500 12px var(--mono); color:var(--acc); letter-spacing:.1em; }}
h2 {{ font:700 22px/1.2 var(--sans); margin:2px 0 0; }} h3 {{ font:600 14px var(--sans); margin:0 0 8px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }} h4 {{ margin:0 0 4px; font:600 14px var(--sans); }}
.rel {{ font:13px var(--mono); color:var(--muted); }}
.figs {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:1px; background:var(--line); border:1px solid var(--line); }} .figs div {{ background:var(--panel); padding:12px 14px; display:grid; }}
.figs b {{ font:700 24px var(--sans); }} .figs span {{ font:12px var(--mono); color:var(--muted); }}
.cols {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:20px; }} .cols > div {{ min-width:0; }}
table {{ border-collapse:collapse; width:100%; font-size:14px; }} th {{ text-align:left; font:500 11px var(--mono); text-transform:uppercase; color:var(--muted); padding:6px 8px; border-bottom:1px solid var(--line); }}
td {{ padding:6px 8px; border-bottom:1px solid var(--line); }} td.n {{ text-align:right; font-family:var(--mono); }}
.tag {{ font:500 11px var(--mono); padding:2px 6px; border:1px solid currentColor; border-radius:2px; }} .tag.ok {{ color:var(--ok); }} .tag.warn {{ color:var(--warn); }} .tag.plan {{ color:var(--plan); border-style:dashed; }}
.aud ul, .hist {{ margin:0 0 12px; padding-left:18px; }} .aud li {{ margin:2px 0; }} .f {{ font:11px var(--mono); color:var(--muted); }}
a {{ color:var(--acc); }} details summary {{ cursor:pointer; font-weight:600; }}
</style>
<div class="wrap"><header><h1>Formcraft design hub</h1><p class="lede">Every project's latest release: what the client sees, what each professional stamps, the design data behind them, and what changed. Built {datetime.date.today().strftime("%d %B %Y")}.</p></header>
{"".join(cards) or "<p>No releases yet: run scripts/project/release.py on a project.</p>"}
<p class="lede">Prepared with Autodesk Revit, Autodesk Robot Structural Analysis and the Formcraft Construction plugin (Formcraft Revit Tools).</p></div>'''
open(OUT, "w", encoding="utf-8").write(page); print(OUT, len(projects), "project(s)")
