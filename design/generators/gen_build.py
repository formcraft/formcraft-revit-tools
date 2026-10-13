import sys
exec(open(__import__('pathlib').Path(__file__).with_name('flowlib.py')).read())
O, N, T, R = ORANGE, NAVY, "#2C6B63", "#A50E0E"
BG = "#B8862B"   # Build accent (sand gold), used for top rules only
C1, C2 = "#2a78d6", "#eb6834"   # validated chart pair: planned, actual
ST = {"ns": ("#9AA1AB", "Not started"), "ip": ("#E0A100", "In progress"), "dn": ("#1E8E3E", "Done"), "lt": ("#D93025", "Late")}

def svg_bars(items, w=520, h=200, unit="UGX m"):
    mx = max(v for _, v in items); bw = (w - 40) / len(items)
    out = [f'<svg width="{w}" height="{h + 34}" viewBox="0 0 {w} {h + 34}" role="img" aria-label="Cost by element group, sample values">']
    for k in range(5):
        y = 10 + (h - 10) * k / 4
        out.append(f'<line x1="36" x2="{w}" y1="{y:.0f}" y2="{y:.0f}" stroke="#E3E6EA" stroke-width="1"></line>'
                   f'<text x="30" y="{y + 4:.0f}" text-anchor="end" font-size="10" fill="#5B6270">{mx * (4 - k) / 4:.0f}</text>')
    for i, (lab, v) in enumerate(items):
        bh = (h - 10) * v / mx; x = 40 + i * bw + 3; y = 10 + (h - 10) - bh
        out.append(f'<path d="M{x:.1f} {10 + h - 10} V{y + 4:.1f} Q{x:.1f} {y:.1f} {x + 4:.1f} {y:.1f} H{x + bw - 10:.1f} Q{x + bw - 6:.1f} {y:.1f} {x + bw - 6:.1f} {y + 4:.1f} V{10 + h - 10}Z" fill="{C1}"><title>{lab}: {v} {unit}</title></path>'
                   f'<text x="{x + (bw - 6) / 2:.1f}" y="{h + 14}" text-anchor="middle" font-size="10" fill="#3B424D">{lab}</text>')
    out.append(f'<text x="36" y="{h + 30}" font-size="10" fill="#5B6270">{unit} · sample values</text></svg>')
    return "".join(out)

def svg_scurve(plan, act, w=520, h=190):
    n = len(plan)
    px = lambda i: 40 + (w - 120) * i / (n - 1); py = lambda v: 10 + (h - 20) * (1 - v / 100)
    out = [f'<svg width="{w}" height="{h + 20}" viewBox="0 0 {w} {h + 20}" role="img" aria-label="Planned and actual progress, percent complete by month, sample values">']
    for k in range(5):
        y = py(k * 25); out.append(f'<line x1="36" x2="{w - 20}" y1="{y:.0f}" y2="{y:.0f}" stroke="#E3E6EA"></line><text x="30" y="{y + 4:.0f}" text-anchor="end" font-size="10" fill="#5B6270">{k * 25}%</text>')
    for i in range(n): out.append(f'<text x="{px(i):.0f}" y="{h + 14}" text-anchor="middle" font-size="10" fill="#5B6270">M{i + 1}</text>')
    for vals, c, lab in ((plan, C1, "Planned"), (act, C2, "Actual")):
        d = "M" + " L".join(f"{px(i):.1f} {py(v):.1f}" for i, v in enumerate(vals))
        out.append(f'<path d="{d}" fill="none" stroke="{c}" stroke-width="2"></path>')
        for i, v in enumerate(vals):
            out.append(f'<circle cx="{px(i):.1f}" cy="{py(v):.1f}" r="4" fill="{c}" stroke="#FFFFFF" stroke-width="2"><title>{lab} M{i + 1}: {v}%</title></circle>')
        li = len(vals) - 1
        out.append(f'<text x="{px(li) + 8:.1f}" y="{py(vals[li]) + 4:.1f}" font-size="11" fill="#1A1D21">{lab} {vals[li]}%</text>')
    out.append('</svg>')
    legend = f'<div style="display: flex; gap: 14px; font-size: 11.5px; color: #3B424D"><span style="display: inline-flex; align-items: center; gap: 5px"><span style="width: 14px; height: 2px; background: {C1}"></span>Planned</span><span style="display: inline-flex; align-items: center; gap: 5px"><span style="width: 14px; height: 2px; background: {C2}"></span>Actual</span></div>'
    return legend + "".join(out)

def tile(label, value, sub=""):
    return (f'<div style="background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 8px; padding: 10px 12px"><div style="font-size: 11.5px; color: #5B6270">{E(label)}</div>'
            f'<div style="font-size: 24px; font-weight: 700; margin-top: 2px">{E(value)}</div><div style="font-size: 11px; color: #5B6270">{E(sub)}</div></div>')

def status_legend():
    return '<div style="display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px">' + "".join(
        f'<span style="display: inline-flex; align-items: center; gap: 6px"><span style="width: 14px; height: 14px; border-radius: 3px; background: {c}"></span>{t}</span>' for c, t in ST.values()) + '</div>'

def tabs(items, active):
    return '<div style="display: flex; gap: 2px; border-bottom: 1px solid #DDE1E6">' + "".join(
        f'<span style="padding: 7px 12px; font-size: 12.5px; {"font-weight: 600; color: #1B2532; box-shadow: inset 0 -2px 0 #1B2532" if t == active else "color: #4A515C"}">{t}</span>' for t in items) + '</div>'

BOQ_ROWS = [["E.2.01", "Excavate for pad footings, n.e. 1.5 m deep", "m³", "142.6", "Model: S foundations"],
            ["E.5.03", "Concrete C25/30 in pad footings", "m³", "38.4", "Model: FMC_Concrete_Grade"],
            ["E.5.07", "Concrete C25/30 in columns", "m³", "21.9", "Model: S columns"],
            ["E.30.02", "High-yield bar reinforcement H12–H16", "t", "6.82", "Model: rebar by mark"],
            ["F.10.01", "230 mm hollow block walling", "m²", "1,284", "Model: A walls"],
            ["V.21.04", "Twin 13 A switched socket outlet", "nr", "146", "Model: E fixtures"]]
def boq_table(rate=True):
    head = ["Item", "Description", "Unit", "Qty", "Rate", "Source"] if rate else ["Item", "Description", "Unit", "Qty", "Source"]
    rows = [r[:4] + (["[RATE]"] if rate else []) + [r[4]] for r in BOQ_ROWS]
    return table(head, rows, ["60px", "1fr", "40px", "56px", "56px", "120px"] if rate else ["70px", "1fr", "44px", "64px", "170px"])

# ---------- Cover ----------
cover = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Formcraft Build cover</title><script src="./support.js"></script></head><body><x-dc>
<helmet><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet"><style>body{{margin:0}}</style></helmet>
<div style="width: 1440px; height: 810px; box-sizing: border-box; padding: 64px 96px 56px; background: #1B2532; color: #FFFFFF; font-family: 'IBM Plex Sans', sans-serif; display: flex; flex-direction: column">
  <div style="display: flex; align-items: center; justify-content: space-between"><img src="__WHITE__" alt="Formcraft Design &amp; Construction" style="height: 52px; width: auto"><div style="font-family: 'IBM Plex Mono', monospace; font-size: 15px; letter-spacing: 2px; text-transform: uppercase; color: #E8C27A">Formcraft Build · for the whole project team</div></div>
  <h1 style="margin: 52px 0 0; font-size: 96px; line-height: 1; font-weight: 700; letter-spacing: -3px">Formcraft Build</h1>
  <p style="margin: 22px 0 0; max-width: 1040px; font-size: 23px; line-height: 1.45; color: #C9D1DA">The project's commercial and delivery side, on the same BIM model: BOQs from templates, cost, packages, contractors, contracts and progress. For the firm's quantity surveyors and managers working in Revit, and for clients, contractors and site staff on the web.</p>
  <div style="margin-top: 40px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 20px">
    {"".join(f'<div style="border-top: 4px solid #E8C27A; background: #233142; border-radius: 0 0 10px 10px; padding: 16px 18px"><div style="font-size: 20px; font-weight: 700">{t}</div><div style="margin-top: 6px; font-size: 15px; line-height: 1.45; color: #C9D1DA">{d}</div></div>' for t, d in [("Build 1 · in Revit", "BOQ from templates using model quantities; progress and package colours on real Revit views."), ("Build 2 · web", "A web workspace on any laptop or tablet: tables, charts, a light 3D view."), ("Build 3 · supply", "Packages, contractor tracking and selection, contracts register."), ("Build 4 · time", "Programme import from MS Project or Primavera, linked to elements: 4D.")])}
  </div>
  <div style="margin-top: auto; display: flex; justify-content: space-between; font-family: 'IBM Plex Mono', monospace; font-size: 13.5px; color: #9AA1AB"><span>Pages: Overview · Screens · Flows · Plan</span><span>Part of Formcraft Revit Tools: Manage · Flow · Model · Build</span></div>
</div></x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":810}}}}'>
class Component extends DCLogic {{ renderVals() {{ return {{}}; }} }}
</script></body></html>'''
(ROOT / "Main.dc.html").write_text(cover, encoding="utf-8")

# ---------- Overview ----------
lane = lambda t, d, bg="#FFFFFF", bd="#DDE1E6", fg=INK: (f'<div style="background: {bg}; border: 1px solid {bd}; border-radius: 8px; padding: 10px 14px; color: {fg}"><div style="font-size: 15px; font-weight: 700">{E(t)}</div><div style="font-size: 12.5px; line-height: 1.4; margin-top: 3px; opacity: 0.92">{E(d)}</div></div>')
arrow = '<div style="display: flex; justify-content: center; font-size: 18px; color: #5B6270">↕</div>'
ov = (grid([card("Quantity surveyors", ["Work in Revit: Build's main user in the firm", "BOQ from templates, quantities straight from the model", "Rates, valuations, variations"], top=BG),
            card("Project managers", ["Progress by package and element", "Programme, look-ahead, S-curve", "Reports for client meetings"], top=BG),
            card("Procurement officers", ["Packages and what's in them", "Contractor tracking and selection", "Contracts register, milestones"], top=BG),
            card("Clients, contractors, site", ["Outside the firm or without a Revit seat", "Web workspace: 3D model, progress, drawings", "Read only by default"], top=BG)], 4, 14)
      + '<div style="display: flex; gap: 28px">'
      + '<div style="width: 640px; flex-shrink: 0; display: flex; flex-direction: column; gap: 6px">'
      + grid([lane("Build in Revit · the firm", "QSs and managers work on the live model: workspace window + real Revit views coloured by status and package", "#FFFFFF", BG), lane("Build on the web · outside", "Clients, contractors, site staff: tables, charts, light 3D view on any tablet. No Revit seat", "#FFFFFF", BG)], 2, 10)
      + arrow + lane("Project data package", "One versioned package: quantities, BOQ items, packages, status, contractors, programme links. Changes flow both ways with preview, approval and log", NAVY, NAVY, "#FFFFFF")
      + arrow + grid([lane("Manage", "Sheets, issue, reports, roles, rates permission"), lane("Model", "Quantities: concrete, steel, rebar, cables, pipes"), lane("Kit", "BOQ templates, new FMC_ parameters (change request)")], 3, 10)
      + '</div><div style="flex: 1; min-width: 0">'
      + callouts([("Not a tab in the view area", "Revit's API doesn't let an add-in put its own screen in the main view area. Build uses a large workspace window plus real Revit views, which zoom, print and work with Flow touch.", O),
                  ("Your QSs work in Revit", "In the firm the QS measures and prices on the live model in Revit, with Flow touch on a Windows tablet when useful. The web workspace serves people outside the firm who have no Revit seat.", N),
                  ("Integrate, don't rebuild", "Programmes come from MS Project or Primavera; contracts are a register from templates, not legal drafting.", T)], 1)
      + '</div></div>')
page("B_Overview.dc.html", "Build overview", "Formcraft Build · who it's for and how it fits", "The commercial and delivery side of the project, on the same model", ov, h=900)

# ---------- Workspace window (in Revit) ----------
win = (f'<div style="background: #FFFFFF; border: 1px solid #C9CED6; border-radius: 8px; box-shadow: 0 16px 40px rgba(26,29,33,0.14); overflow: hidden; display: flex; flex-direction: column; flex-grow: 1">'
       f'<div style="height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 12px; background: #F1F3F5; font-size: 12.5px; font-weight: 600">Formcraft Build · F26001 Kansanga Offices<span style="margin-left: auto; font-weight: 400; color: #5B6270">Workspace window · float · second monitor · maximise</span></div>'
       f'<div style="height: 2px; background: {BG}"></div><div style="padding: 0 14px">{tabs(["BOQ", "Cost", "Packages", "Contractors", "Progress", "Programme", "Contracts"], "BOQ")}</div>'
       f'<div style="display: flex; gap: 16px; padding: 12px 14px; flex-grow: 1; min-height: 0">'
       f'<div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px"><div style="display: flex; gap: 8px; align-items: center; font-size: 12px; color: #3B424D"><span>Template: FMC BOQ (SMM7-style) v1</span><span>·</span><span>Bill 2 Substructure, Bill 3 Frame, Bill 5 Electrical</span><span style="margin-left: auto">{chip("Quantities from model, 13 Oct 10:40", "info")}</span></div>'
       f'{boq_table()}<div style="display: flex; gap: 8px">{"".join(chip(t, k) for t, k in [("Show in model", "grey"), ("Colour by bill", "grey"), ("Export to Excel", "grey"), ("Rates: QS only", "warn")])}</div></div>'
       f'<div style="width: 420px; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px"><div style="font-size: 13px; font-weight: 600">Cost by element group</div>'
       f'{svg_bars([("Subst.", 118), ("Frame", 204), ("Walls", 96), ("Roof", 61), ("Finishes", 142), ("Elec.", 88), ("Plumb.", 54)], w=410)}'
       f'{grid([tile("Measured items", "412", "from the model"), tile("Unmeasured", "37", "PC sums, provisional"), tile("Changed since last", "9", "flagged for the QS")], 3, 8)}</div></div></div>')
page("B_Workspace.dc.html", "Build workspace window", "Formcraft Build · screen · in Revit", "A large workspace window beside the model: BOQ, cost, packages, contractors, progress",
     f'<div style="display: flex; gap: 24px; flex-grow: 1; min-height: 0">{win}<div style="width: 300px; flex-shrink: 0">'
     + callouts([("The QS's home in Revit", "A Build group in the Formcraft pane opens the workspace beside the live model; it can float, fill a second monitor or be maximised.", BG),
                 ("Show in model", "Selecting rows highlights the elements in the active Revit view; selecting elements filters the BOQ.", N),
                 ("Rates are protected", "Only roles with the rates permission (Admin) see or export rates. [RATE] marks a hidden value.", O),
                 ("Values are samples", "Quantities, items and costs here are placeholders, not a real project.", "#8A919C")], 1) + '</div></div>', h=900)

# ---------- Web workspace (tablet) ----------
tab_frame = (f'<div style="width: 980px; flex-shrink: 0; align-self: flex-start; background: #1A1D21; border-radius: 26px; padding: 18px"><div style="background: #F6F7F9; border-radius: 12px; overflow: hidden; height: 620px; display: flex; flex-direction: column">'
             f'<div style="display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: #FFFFFF; border-bottom: 1px solid #DDE1E6"><span style="font-weight: 700">Formcraft Build</span><span style="font-size: 12px; color: #5B6270">F26001 Kansanga Offices · client representative</span><span style="margin-left: auto">{chip("Read only · rates hidden", "grey")}</span></div>'
             f'<div style="padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; flex-grow: 1">'
             f'{grid([tile("Packages", "11", "4 awarded"), tile("Tenders open", "3", "close 24 Oct"), tile("Progress", "42%", "planned 48%"), tile("Open variations", "5", "2 awaiting QS")], 4, 10)}'
             f'<div style="display: flex; gap: 12px; flex-grow: 1; min-height: 0"><div style="flex: 1; min-width: 0; background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 8px; padding: 10px"><div style="font-size: 13px; font-weight: 600">Progress, % complete</div>{svg_scurve([5, 14, 27, 40, 48], [4, 11, 22, 35, 42], w=440, h=170)}</div>'
             f'<div style="width: 440px; flex-shrink: 0; background: #E9ECEF; border: 1px solid #DDE1E6; border-radius: 8px; position: relative; display: flex; flex-direction: column"><div style="padding: 8px 10px; font-size: 13px; font-weight: 600">3D model · coloured by status</div>'
             f'<svg viewBox="0 0 440 210" style="flex-grow: 1" role="img" aria-label="Isometric block model coloured by progress status, sample">'
             + "".join(f'<polygon points="{80 + i * 58},{150 - j * 34} {120 + i * 58},{130 - j * 34} {160 + i * 58},{150 - j * 34} {120 + i * 58},{170 - j * 34}" fill="{c}" stroke="#FFFFFF" stroke-width="2"></polygon>'
                       for j, row in enumerate([["dn", "dn", "dn", "dn"], ["dn", "ip", "ip", "lt"], ["ns", "ns", "ip", "ns"]]) for i, c in enumerate([ST[k][0] for k in row]))
             + f'</svg><div style="padding: 6px 10px">{status_legend()}</div><div style="position: absolute; right: 10px; top: 8px; font-size: 11px; color: #4A515C">pinch to zoom · drag to orbit</div></div></div>'
             f'{table(["Package", "Contractor", "Status", "Next milestone"], [["P03 Frame", "[CONTRACTOR A]", ("In progress", "warn"), "Level 2 slab, 28 Oct"], ["P07 Electrical first fix", "Tender", ("Tender open", "info"), "Tender close, 24 Oct"]], ["1fr", "1fr", "120px", "1fr"])}'
             f'</div></div></div>')
page("B_Web.dc.html", "Build web workspace", "Formcraft Build · screen · web, any tablet", "For people outside the firm: the same project on any laptop or tablet, no Revit seat",
     f'<div style="display: flex; gap: 28px; flex-grow: 1; min-height: 0">{tab_frame}<div style="flex: 1; min-width: 0">'
     + callouts([("One package, two surfaces", "The web workspace reads and writes the project data package. Changes made here reach Revit only through preview, approval and log.", BG),
                 ("Tablet-first", "Touch-sized controls; a light 3D viewer (exported from the model) with pinch and orbit. Works on iPad and Android, not only Windows.", N),
                 ("Roles decide", "A client or contractor sees progress, packages and drawings; rates stay hidden unless the role allows them.", O),
                 ("Hosting", "Starts on the office network; going online needs sign-in, backups and security, a separate decision.", R)], 1) + '</div></div>', h=900)

# ---------- Native Revit views ----------
iso = lambda rows, title: (f'<div style="background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px"><div style="font-size: 13px; font-weight: 600">{title}</div>'
                           f'<svg viewBox="0 0 420 200" role="img" aria-label="{title}, sample">'
                           + "".join(f'<polygon points="{70 + i * 62},{150 - j * 36} {112 + i * 62},{128 - j * 36} {154 + i * 62},{150 - j * 36} {112 + i * 62},{172 - j * 36}" fill="{c}" stroke="#FFFFFF" stroke-width="2"></polygon>' for j, row in enumerate(rows) for i, c in enumerate(row)) + '</svg>')
pk = {"P02": "#2a78d6", "P03": "#eb6834", "P05": "#1baf7a"}
views = grid([iso([[ST[k][0] for k in r] for r in [["dn"] * 4, ["dn", "ip", "ip", "lt"], ["ns", "ns", "ip", "ns"]]], "3D · {Build} Progress (view filter on FMC_Status)") + status_legend() + '</div>',
              iso([[pk[k] for k in r] for r in [["P02"] * 4, ["P03", "P03", "P03", "P03"], ["P05", "P05", "P03", "P05"]]], "3D · {Build} Packages (filter on FMC_Package)")
              + '<div style="display: flex; gap: 14px; font-size: 12px">' + "".join(f'<span style="display: inline-flex; align-items: center; gap: 6px"><span style="width: 14px; height: 14px; border-radius: 3px; background: {c}"></span>{k} {n}</span>' for (k, c), n in zip(pk.items(), ["Substructure", "Frame", "Electrical"])) + '</div></div>'], 2, 18)
page("B_RevitViews.dc.html", "Build views in Revit", "Formcraft Build · screen · real Revit views", "Progress and packages shown on the model itself: zoom, print, put on sheets, touch with Flow",
     views + grid([card("BOQ schedule view", ["A Revit schedule grouped by FMC_BOQ_Item", "Updates as the model changes", "Can go on a sheet in a report set"], top=BG),
                   card("Progress view", ["View filters on FMC_Status: not started, in progress, done, late", "Status set from the web or the workspace", "Always shown with a legend"], top=BG),
                   card("Package view", ["View filters on FMC_Package", "Used in tender and procurement meetings", "Colours follow the package, not its order"], top=BG),
                   card("Kit change request", ["New: FMC_Status, FMC_Package, FMC_Cost_Code, FMC_BOQ_Item, FMC_Contractor", "Added to the dictionary, never in code", "Needs the BIM Manager's approval"], top=O)], 4, 14), h=900)

# ---------- Flows ----------
KB = ["start", "auto", "decide", "gate", "data", "revit", "stop", "end"]
f = FC(980, 640, 176, 80, lanes=[("Kit and model", 0, 2), ("Build engine", 2, 5), ("QS", 5, 7), ("Out", 7, 8)], lw=100)
f.node("t", 0, 0, "start", "New BOQ", "from a firm template").node("tp", 1, 0, "data", "BOQ template", "SMM7-style, kit").node("mq", 2, 0, "data", "Model quantities", "Model: m³, t, m², nr, m").node("mp", 3, 0, "data", "Item map", "FMC_BOQ_Item on types")
f.node("map", 2, 2, "auto", "Map elements to items").node("um", 3, 2, "decide", "Unmapped elements?").node("ul", 4, 2, "step", "List for the QS", "assign or exclude")
f.node("ms", 2, 3, "auto", "Measure", "by item, rules in template").node("ch", 2, 4, "decide", "Changed since last issue?").node("fl", 3, 4, "step", "Flag changes", "old vs new qty")
f.node("rt", 1, 5, "gate", "QS adds rates", "rates permission").node("pc", 2, 5, "step", "PC and provisional sums").node("ap", 2, 6, "gate", "QS approves the BOQ")
f.node("x", 1, 7, "end", "Excel / PDF BOQ").node("rs", 2, 7, "end", "Revit BOQ schedule").node("wb", 3, 7, "end", "Web workspace")
f.edge("t", "tp").edge("tp", "map", "", "v").edge("mq", "map").edge("mp", "map", "", "v").edge("map", "um").edge("um", "ul", "Yes").edge("um", "ms", "No", "v").edge("ul", "ms", "", "v")
f.edge("ms", "ch").edge("ch", "fl", "Yes").edge("ch", "pc", "No").edge("fl", "pc", "", "v").edge("pc", "rt").edge("rt", "ap", "", "v").edge("ap", "rs").edge("rs", "x").edge("rs", "wb")
flowboard("B_FlowBOQ.dc.html", "BOQ from template", "Build · flow 01 · BOQ", "Model quantities into the firm's BOQ template, priced by the QS", f,
          [("Template-driven", "Bills, items, units and measurement rules come from the firm's BOQ template in the kit, so every project's BOQ looks the same.", BG),
           ("Nothing silently dropped", "Elements with no BOQ item are listed for the QS to assign or exclude, with a reason.", N),
           ("Changes are visible", "Re-measuring flags every quantity that moved since the last issued BOQ.", T),
           ("The QS prices and approves", "Rates, PC sums and the final BOQ are the QS's. Rates are visible only to roles allowed to see them.", O)], KB)

f = FC(980, 600, 176, 80, lanes=[("Site", 0, 2), ("Data package", 2, 4), ("Revit", 4, 6), ("Report", 6, 7)], lw=100)
f.node("s", 0, 0, "start", "Site update", "web on a tablet").node("pk", 1, 0, "step", "Pick package or zone").node("st", 2, 0, "step", "Set status", "photo optional").node("ok", 3, 0, "decide", "Allowed for this role?").node("no", 4, 0, "stop", "Refused, logged")
f.node("pkg", 2, 2, "data", "Change in the package", "who, when, what").node("pv", 3, 2, "step", "Preview in Revit", "elements, old → new").node("g", 3, 3, "gate", "PM approves?").node("rj", 4, 3, "end", "Stays in the package")
f.node("w", 2, 4, "revit", "Write FMC_Status", "one Undo").node("v", 1, 4, "revit", "Progress view updates").node("vf", 2, 5, "decide", "Verified?").node("rb", 3, 5, "stop", "Roll back, report")
f.node("r", 1, 6, "end", "S-curve, weekly report", "Check › Reports")
f.edge("s", "pk").edge("pk", "st").edge("st", "ok").edge("ok", "no", "No").edge("ok", "pkg", "Yes", "v").edge("pkg", "pv").edge("pv", "g").edge("g", "rj", "No").edge("g", "w", "Approve", "vh").edge("w", "v").edge("w", "vf", "", "v").edge("vf", "rb", "No").edge("vf", "r", "Yes", "vh")
flowboard("B_FlowProgress.dc.html", "Progress update loop", "Build · flow 02 · Progress", "From a tap on site to a coloured model and a weekly S-curve", f,
          [("Status is data", "Progress is a value per element or package (FMC_Status), so the model, the S-curve and the report always agree.", BG),
           ("Same control layer", "A site update reaches Revit only through preview, a person's approval, one Undo and a check, like every Manage change.", N),
           ("Works without Revit on site", "Site staff update from the web on any tablet; the PM brings changes into the model.", T)], ["start", "step", "decide", "data", "gate", "revit", "stop", "end"], h=860)

f = FC(980, 620, 196, 80)
f.node("p", 0, 0, "start", "Package ready", "scope from the model").node("ls", 1, 0, "data", "Contractor list", "registration, past work").node("sh", 2, 0, "auto", "Shortlist by criteria", "category, size, region")
f.node("cr", 3, 0, "data", "Criteria + weights", "set before tenders open").node("tn", 2, 1, "step", "Issue tender", "drawings, BOQ section").node("rc", 2, 2, "step", "Receive bids").node("sc", 3, 2, "gate", "Panel scores each bid", "against the criteria")
f.node("rp", 3, 3, "auto", "Evaluation report", "scores, prices, notes").node("aw", 2, 3, "gate", "Award decision", "named approver").node("ct", 1, 3, "data", "Contract register", "value, retention, milestones")
f.node("tr", 1, 4, "step", "Track milestones", "payments, variations").node("pf", 2, 4, "step", "Performance record", "per contract, same criteria").node("dn", 2, 5, "end", "Feeds the next shortlist")
f.edge("p", "ls").edge("ls", "sh").edge("cr", "sh").edge("sh", "tn").edge("tn", "rc").edge("rc", "sc").edge("cr", "sc", "", "v").edge("sc", "rp").edge("rp", "aw").edge("aw", "ct").edge("ct", "tr").edge("tr", "pf").edge("pf", "dn")
flowboard("B_FlowContractors.dc.html", "Contractor selection and contracts", "Build · flow 03 · Supply", "Criteria set first, people decide, every step recorded", f,
          [("Criteria before bids", "Weights are fixed before tenders open, so scoring can't be shaped around a favourite.", BG),
           ("People decide", "A panel scores and a named approver awards. Build prepares the report; it never picks a winner.", O),
           ("A register, not legal drafting", "Contracts are tracked from templates: value, retention, milestones, variations. The legal text comes from the firm's lawyers.", N),
           ("Firms, not staff", "Contractor performance is recorded per contract against the same criteria. The rule against ranking your own staff by activity is unchanged.", T)],
          ["start", "data", "auto", "step", "gate", "end"], h=860)

f = FC(980, 560, 196, 80)
f.node("i", 0, 0, "start", "Import programme", "MS Project XML or P6 XER").node("ac", 1, 0, "auto", "Read activities", "dates, WBS, links").node("mp", 2, 0, "auto", "Suggest element links", "by zone, level, package")
f.node("g", 3, 0, "gate", "PM confirms links").node("un", 3, 1, "step", "Unlinked activities listed").node("d", 2, 1, "data", "Links in the package", "activity ↔ elements")
f.node("v", 1, 1, "revit", "4D view by date", "planned vs status").node("la", 1, 2, "step", "Look-ahead", "next 2–6 weeks").node("rp", 2, 2, "end", "Delay report", "late packages, S-curve")
f.node("rv", 0, 2, "decide", "New programme revision?").node("df", 0, 3, "auto", "Compare revisions", "moved, added, removed")
f.edge("i", "ac").edge("ac", "mp").edge("mp", "g").edge("g", "un", "", "v").edge("g", "d", "Approve", "v").edge("d", "v").edge("v", "la", "", "v").edge("la", "rp").edge("la", "rv").edge("rv", "df", "Yes").edge("df", "ac", "", "loopL", off=14)
flowboard("B_FlowProgramme.dc.html", "Programme and 4D", "Build · flow 04 · Time", "Bring the programme in, link it to the model, see time on the model", f,
          [("Use the scheduler you have", "Programmes are built in MS Project or Primavera and imported. Build doesn't replace them.", BG),
           ("Links are confirmed", "Build suggests which elements belong to each activity; the PM confirms before anything is saved.", O),
           ("Revisions compared", "Each new programme revision shows what moved, so delays are visible early.", T)], ["start", "auto", "gate", "step", "data", "revit", "decide", "end"], h=800)

f = FC(980, 560, 176, 80, lanes=[("Revit", 0, 2), ("Package", 2, 4), ("Web", 4, 7)], lw=100)
f.node("m", 0, 0, "revit", "Manage + Model", "quantities, sheets").node("ex", 1, 0, "auto", "Export package", "versioned").node("im", 3, 0, "auto", "Apply changes", "after approval").node("pv", 4, 0, "gate", "Approve in Revit")
f.node("pk", 1, 2, "data", "Project data package", "v14 · signed by exporter").node("rl", 2, 2, "decide", "Allowed for this role?").node("cf", 3, 2, "decide", "Conflict with a newer change?").node("rs", 4, 2, "step", "Show both, person picks")
f.node("w", 1, 4, "step", "Web workspace", "reads the package").node("ed", 2, 4, "step", "Edit status, packages", "no geometry, ever").node("rt", 3, 5, "stop", "Rates hidden", "role without permission")
f.edge("m", "ex").edge("ex", "pk", "", "v").edge("pk", "w", "", "v").edge("w", "ed").edge("ed", "rl", "", "v").edge("rl", "rt", "No", "vh").edge("rl", "cf", "Yes").edge("cf", "rs", "Yes").edge("cf", "im", "No", "v").edge("rs", "im", "", "loopT", off=12).edge("im", "pv")
flowboard("B_FlowDataHub.dc.html", "Data package hub", "Build · flow 05 · Data", "One versioned package connects Revit and the web, both ways, safely", f,
          [("Data, not models", "The package carries quantities, BOQ items, packages, status, contractors and programme links. Geometry never changes from the web.", BG),
           ("Same as the version bridge", "This is the version-bridge package Manage already plans, so building it early serves both.", N),
           ("Conflicts shown, not guessed", "If two people changed the same value, both are shown and a person picks.", T),
           ("Roles and rates", "Every change is checked against the person's role; rates stay hidden from roles without permission.", O)], ["revit", "auto", "gate", "data", "decide", "step", "stop"], h=800)

# ---------- Plan ----------
plan = (table(["Release", "What ships", "Needs first", "Done when"],
              [["Build 1 · in Revit", "The QS works in Revit: BOQ from template with model quantities; progress and package views; workspace window", "Model quantities; FMC_ parameters approved in the kit", "A real project's BOQ section matches the QS's manual take-off"],
               ["Build 2 · web", "Web workspace on the office network: tables, charts, light 3D, status updates", "Data package (version bridge); roles in Admin", "A PM updates progress on a tablet and it reaches Revit through approval"],
               ["Build 3 · supply", "Packages, contractor list and selection, contracts register, milestones", "Build 2; firm's criteria and contract templates", "One package tendered and awarded end to end with the panel"],
               ["Build 4 · time", "Programme import (MS Project, P6), element links, 4D view, look-ahead, revision compare", "Build 2", "A programme revision shows its delays on the model"]],
              ["170px", "1fr", "300px", "300px"])
        + table(["Area", "Impact on the system"],
                [["Bundle", "Four modules: Manage, Flow, Model, Build. Same Core, licence and Settings; Build adds a workspace window and the web workspace"],
                 ["Data", "The version-bridge package becomes the shared data hub"],
                 ["Kit", "New shared parameters (status, package, cost code, BOQ item, contractor) and BOQ templates, as dictionary change requests"],
                 ["Roles and Admin", "New roles: QS, PM, procurement, client. New permission: who can see and export rates. QSs need Revit seats and short Revit training"],
                 ["Rules", "Contractor evaluation by written criteria and a named approver; staff are never ranked by activity"],
                 ["Hosting", "Web workspace means running a server: sign-in, backups, security. Office network first"],
                 ["Roadmap", "Build follows Manage 1.0 and Model's quantities; it is not Phase 1"]], ["170px", "1fr"]))
page("B_Plan.dc.html", "Build plan and impact", "Formcraft Build · plan", "Four releases after Manage 1.0, and what Build changes in the system", plan, h=640)
print("build ok")

# ---------- Web workspace, interactive (Oct 13) ----------
def tabbtn(i, label):
    return (f'<button onClick="{{{{t{i}.go}}}}" aria-pressed="{{{{t{i}.p}}}}" style="font: inherit; font-size: 13px; padding: 8px 12px; border: none; background: transparent; cursor: pointer; '
            f'color: {{{{t{i}.fg}}}}; font-weight: {{{{t{i}.w}}}}; box-shadow: {{{{t{i}.sh}}}}">{label}</button>')
def rolebtn(i, label):
    return (f'<button onClick="{{{{r{i}.go}}}}" aria-pressed="{{{{r{i}.p}}}}" style="font: inherit; font-size: 12px; min-height: 30px; padding: 2px 10px; border-radius: 15px; cursor: pointer; '
            f'border: 1px solid {N}; background: {{{{r{i}.bg}}}}; color: {{{{r{i}.fg}}}}">{label}</button>')
def act(label, msg):
    return f'<button onClick="{{{{a.{msg}}}}}" style="font: inherit; font-size: 12.5px; min-height: 32px; padding: 2px 12px; border: 1px solid #C9CED6; background: #FFFFFF; border-radius: 4px; cursor: pointer">{label}</button>'
TABS = ["Overview", "Packages", "Progress", "Drawings", "Variations"]
iso3d = (f'<svg viewBox="0 0 440 210" style="flex-grow: 1" role="img" aria-label="Isometric block model coloured by progress status, sample">'
         + "".join(f'<polygon points="{80 + i * 58},{150 - j * 34} {120 + i * 58},{130 - j * 34} {160 + i * 58},{150 - j * 34} {120 + i * 58},{170 - j * 34}" fill="{c}" stroke="#FFFFFF" stroke-width="2"></polygon>'
                   for j, row in enumerate([["dn", "dn", "dn", "dn"], ["dn", "ip", "ip", "lt"], ["ns", "ns", "ip", "ns"]]) for i, c in enumerate([ST[k][0] for k in row])) + '</svg>')
panes = {
 0: (f'{grid([tile("Packages", "11", "4 awarded"), tile("Tenders open", "3", "close 24 Oct"), tile("Progress", "42%", "planned 48%"), tile("Open variations", "5", "2 awaiting QS")], 4, 10)}'
     f'<div style="display: flex; gap: 12px"><div style="flex: 1; min-width: 0; background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 8px; padding: 10px"><div style="font-size: 13px; font-weight: 600">Progress, % complete</div>{svg_scurve([5, 14, 27, 40, 48], [4, 11, 22, 35, 42], w=440, h=170)}</div>'
     f'<div style="width: 440px; flex-shrink: 0; background: #E9ECEF; border: 1px solid #DDE1E6; border-radius: 8px; display: flex; flex-direction: column"><div style="padding: 8px 10px; font-size: 13px; font-weight: 600">3D model · coloured by status</div>{iso3d}<div style="padding: 6px 10px">{status_legend()}</div></div></div>'),
 1: (table(["Package", "Contractor", "Status", "Next milestone"], [["PKG-03 Frame", "[CONTRACTOR A]", ("In progress", "warn"), "Level 2 slab, 28 Oct"], ["PKG-05 Roofing", "[CONTRACTOR B]", ("Awarded", "good"), "Start on site, 4 Nov"],
                                                                 ["PKG-07 Electrical first fix", "Tender", ("Tender open", "info"), "Tender close, 24 Oct"], ["PKG-09 Plumbing", "Not tendered", ("Not started", "grey"), "Tender issue, 1 Nov"]], ["1.2fr", "1fr", "120px", "1fr"])
     + f'<div style="display: flex; gap: 8px">{act("Show package in 3D", "pkg")}{act("Download tender pack", "tender")}</div>'),
 2: (f'<div style="display: flex; gap: 12px"><div style="flex: 1; min-width: 0; background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 8px; padding: 10px"><div style="font-size: 13px; font-weight: 600">Planned against actual</div>{svg_scurve([5, 14, 27, 40, 48], [4, 11, 22, 35, 42], w=440, h=200)}</div>'
     f'<div style="width: 440px; flex-shrink: 0">{table(["Zone", "Status", "Elements"], [["Level 1 frame", ("Done", "good"), "412"], ["Level 2 frame", ("In progress", "warn"), "386"], ["Level 2 slab", ("Late", "bad"), "41"], ["Roof", ("Not started", "grey"), "118"]], ["1fr", "110px", "70px"])}</div></div>'
     + f'<div style="display: flex; gap: 8px">{act("Report site progress", "site")}{act("Add site photo", "photo")}</div>'),
 3: (table(["Sheet", "Title", "Status", "Issued"], [["A-1001", "Ground Floor Plan", ("S4 for construction", "good"), "06 Oct"], ["S-1003", "First Floor Framing Plan", ("S4 for construction", "good"), "08 Oct"], ["E-1001", "Ground Floor Power Layout", ("S2 for information", "info"), "10 Oct"]], ["90px", "1fr", "160px", "80px"])
     + f'<div style="font-size: 12.5px; color: #3B424D">Drawings come from the CDE as issued PDFs with their status codes. Nothing here is a working file.</div><div style="display: flex; gap: 8px">{act("Open PDF", "pdf")}{act("Comment on a drawing", "comment")}</div>'),
 4: (table(["Variation", "Raised by", "Status", "Value"], [["VO-004 Extra window, Level 2", "Client", ("Awaiting QS", "warn"), "[RATE]"], ["VO-005 Change floor finish, lobby", "Client", ("Awaiting QS", "warn"), "[RATE]"], ["VO-003 Additional socket outlets", "Contractor", ("Approved", "good"), "[RATE]"]], ["1.4fr", "100px", "120px", "80px"])
     + f'<div style="font-size: 12.5px; color: #3B424D">A variation raised here becomes a change request for the QS (Manual 16.4). Values show only for roles with the rates permission.</div><div style="display: flex; gap: 8px">{act("Raise a variation", "vo")}</div>'),
}
body_tabs = "".join(f'<sc-if value="{{{{show.s{i}}}}}" hint-placeholder-val="{{{{{"true" if i == 0 else "false"}}}}}"><div style="display: flex; flex-direction: column; gap: 10px">{panes[i]}</div></sc-if>' for i in range(5))
frame = (f'<div style="width: 980px; flex-shrink: 0; align-self: flex-start; background: #1A1D21; border-radius: 26px; padding: 18px"><div style="background: #F6F7F9; border-radius: 12px; overflow: hidden; height: 640px; display: flex; flex-direction: column">'
         f'<div style="display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: #FFFFFF; border-bottom: 1px solid #DDE1E6"><span style="font-weight: 700">Formcraft Build</span><span style="font-size: 12px; color: #5B6270">F26001 Kansanga Offices</span>'
         f'<span style="margin-left: auto; display: flex; gap: 6px; align-items: center"><span style="font-size: 12px; color: #5B6270">Signed in as</span>{rolebtn(0, "Client")}{rolebtn(1, "Contractor")}{rolebtn(2, "Consultant")}</span></div>'
         f'<div style="display: flex; padding: 0 12px; background: #FFFFFF; border-bottom: 1px solid #DDE1E6">{"".join(tabbtn(i, t) for i, t in enumerate(TABS))}<span style="margin-left: auto; align-self: center; font-size: 11.5px; padding: 2px 8px; border-radius: 10px; background: #EEF0F3; color: #3B424D">{{{{roleNote}}}}</span></div>'
         f'<div style="padding: 12px 16px; flex-grow: 1; overflow: auto">{body_tabs}</div>'
         f'<div style="padding: 7px 16px; border-top: 1px solid #DDE1E6; background: #FFFFFF; font-size: 12px; color: #3B424D">{{{{msg}}}}</div></div></div>')
side = callouts([("For people outside the firm", "Clients, contractors and consultants with no Revit seat. In the firm, QSs and managers work in Revit with the Build pane and workspace window.", BG),
                 ("Roles decide", "Each role sees its own packages, progress and drawings. Rates stay hidden unless the role has the rates permission.", N),
                 ("Changes go through approval", "Site progress, photos and variations land in the data package; they reach Revit only after preview, QS approval and a log line.", O),
                 ("Hosted on the CDE", "Runs on the Formcraft CDE, with accounts that follow the Manual 7.6 permissions and expire. Data Protection Act 2019 applies.", R)], 1)
JS = """class Component extends DCLogic {
constructor(props) { super(props); this.state = { tab: 0, role: 0, msg: 'Clickable mockup: pick a role and a tab. Values are samples.' }; }
renderVals() {
const T = ['Overview', 'Packages', 'Progress', 'Drawings', 'Variations'];
const R = ['Client: read only, rates hidden', 'Contractor: own packages, rates hidden', 'Consultant: read and comment'];
const M = { pkg: 'The 3D view highlights the package elements (sample).', tender: 'Tender pack downloaded from the CDE (sample).', site: 'Progress report sent to the data package; the QS approves it before Revit changes (sample).',
  photo: 'Photo attached to Level 2 slab, waiting for review (sample).', pdf: 'Issued PDF opens from the CDE (sample).', comment: 'Comment sent to the project issue list (sample).', vo: 'Variation sent to the QS as a change request (sample).' };
const s = this.state, v = { show: {}, a: {}, roleNote: R[s.role], msg: s.msg };
T.forEach((t, i) => { const on = i === s.tab; v['t' + i] = { p: on ? 'true' : 'false', fg: on ? '#1B2532' : '#4A515C', w: on ? '600' : '400', sh: on ? 'inset 0 -3px 0 #E8C27A' : 'none', go: () => this.setState({ tab: i }) }; v.show['s' + i] = on; });
R.forEach((r, i) => { const on = i === s.role; v['r' + i] = { p: on ? 'true' : 'false', bg: on ? '#1B2532' : '#FFFFFF', fg: on ? '#FFFFFF' : '#1B2532', go: () => this.setState({ role: i, msg: 'Signed in as ' + r.split(':')[0] + '. ' + r.split(':')[1].trim() + '.' }) }; });
Object.keys(M).forEach((k) => { v.a[k] = () => this.setState({ msg: M[k] }); });
return v;
}
}"""
page("B_Web.dc.html", "Build web workspace", "Formcraft Build · screen · web, any tablet", "For people outside the firm: the same project on any laptop or tablet, no Revit seat",
     f'<div style="display: flex; gap: 28px; flex-grow: 1; min-height: 0">{frame}<div style="flex: 1; min-width: 0">{side}</div></div>', h=900)
p = ROOT / "B_Web.dc.html"; s = p.read_text()
a = s.index("class Component extends DCLogic"); b = s.index("</script>", a)
p.write_text(s[:a] + JS + "\n" + s[b:])
print("bweb ok")
