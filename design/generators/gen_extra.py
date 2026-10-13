import sys
exec(open(__import__('pathlib').Path(__file__).with_name('flowlib.py')).read())
O, Nv, T, R = ORANGE, NAVY, "#2C6B63", "#A50E0E"
ACC = {"manage": ORANGE, "flow": "#7FC7BE", "model": "#6FA8FF", "build": "#E8C27A"}
IC = {
 "browser": "M4 4h16v16H4z M14 4v16", "connect": "M9 3v5 M15 3v5 M7 8h10v4a5 5 0 0 1-10 0z M12 17v4",
 "touch": "M9 11V5a2 2 0 0 1 4 0v6 M13 10a2 2 0 0 1 4 0v4a6 6 0 0 1-12 0v-2a2 2 0 0 1 4 0", "views": "M3 5h18v14H3z M3 10h18 M9 10v9",
 "align": "M4 4v16 M8 7h10v4H8z M8 13h6v4H8z", "dist": "M4 4v16 M20 4v16 M9 8h6v8H9z", "crop": "M6 2v14h14 M2 6h14v14",
 "tidy": "M4 6h10l4 4-4 4H4z M18 18l3 3", "assist": "M4 6h10l4 4-4 4H4z M8 10h.01", "box": "M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",
 "systems": "M13 2L4 14h7l-1 8 9-12h-7z", "check": "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5 4.5-5", "qty": "M4 20V11 M10 20V5 M16 20v-6 M3 20h18",
 "work": "M3 4h18v14H3z M3 8h18 M8 21h8", "progress": "M3 12a9 9 0 1 0 9-9 M12 3v9l6 3", "package": "M3 7l9-4 9 4-9 4z M3 7v10l9 4 9-4V7 M12 11v10",
 "materials": "M12 3a9 9 0 1 0 0 18c1.2 0 1.6-1 1-1.8-.6-.9-.2-2.2 1-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z",
}
def rb(label, ic, on=False, dim=False):
    c = "#9AA1AB" if dim else NAVY
    return (f'<div style="width: 62px; display: flex; flex-direction: column; align-items: center; gap: 5px; opacity: {0.5 if dim else 1}">'
            f'<div style="width: 38px; height: 38px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: {NAVY if on else "#FFFFFF"}; border: 1.5px solid {c}">'
            f'<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="{IC[ic]}" fill="none" stroke="{"#FFFFFF" if on else c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg></div>'
            f'<div style="font-size: 11px; text-align: center; line-height: 1.2; color: {c}">{label}</div></div>')
def rp(name, btns, small=(), dim=False, hi=None):
    sm = "".join(f'<span style="font-size: 12px; color: {"#9AA1AB" if dim else INK}">{s}</span>' for s in small)
    sm = f'<div style="display: flex; flex-direction: column; gap: 5px; padding-top: 2px">{sm}</div>' if small else ""
    top = f"box-shadow: inset 0 3px 0 {hi};" if hi else ""
    return (f'<div style="display: flex; flex-direction: column; border-right: 1px solid #E3E6EA; padding: 8px 7px 0; {top}"><div style="display: flex; gap: 4px; align-items: flex-start">{"".join(btns)}{sm}</div>'
            f'<div style="margin-top: 6px; padding-bottom: 6px; font-size: 11.5px; color: {"#9AA1AB" if dim else MUTED}; text-align: center">{name}</div></div>')
# ribbon boards moved to gen_ribbon.py (Oct 13: five panels, max three tools each)

# ---------- Materials database board ----------
sw = lambda c, n, extra="": (f'<div style="display: flex; flex-direction: column; gap: 4px"><div style="height: 70px; border-radius: 6px; border: 1px solid #DDE1E6; background: {c}; {extra}"></div><div style="font-size: 11.5px; {MONO}">{n}</div></div>')
dots = "background-image: radial-gradient(rgba(0,0,0,0.13) 1px, transparent 1.5px); background-size: 7px 7px;"
hatch = "background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.2) 0 3px, transparent 3px 9px);"
lib = grid([sw("#B9B6AE", "FMC_Concrete_C25-30", dots), sw("#C8B79A", "FMC_Block_Hollow_230", hatch), sw("#EDEAE3", "FMC_Paint_Int_Matt_White"), sw("#8C5A3C", "FMC_Timber_Mvule", hatch),
            sw("#6E7378", "FMC_Steel_S275"), sw("#D8D2C4", "FMC_Tile_Porcelain_600", dots), sw("#A9C4D6", "FMC_Glass_Clear_6mm"), sw("#9E4A2F", "FMC_Roof_Clay_Tile", hatch)], 8, 10)
rec = table(["Part of a material record", "What it holds", "Used by"],
            [["Name and class", "FMC_<Class>_<Name>, e.g. FMC_Tile_Porcelain_600; class and discipline", "Naming rule, search, audit"],
             ["Graphics", "Shaded colour, surface and cut patterns, transparency", "Plans, sections, consistent colours"],
             ["Appearance", "Colour, bump, roughness and opacity maps with real-world size; managed texture folder", "Realistic views and renderers reading Revit appearances"],
             ["Identity", "Description, manufacturer, model, [SUPPLIER], keynote (e.g. F.TIL_02), mark", "Keynotes, schedules, specifications"],
             ["Physical and thermal", "Density, strength class, thermal values where known (blank, never guessed)", "Structural, energy checks"],
             ["Cost and BOQ", "Cost code and unit (m², m³, t) linking to the BOQ template", "Build BOQ and cost"],
             ["Version", "Database version, change log, who approved", "Sync and audit"]], ["210px", "1fr", "300px"])
page("MaterialsDB.dc.html", "Formcraft material database", "Formcraft Manage · materials", "One material database: graphics, textures, data and cost in every record",
     lib + rec + callouts([("Textures that never break", "Textures sit in one managed folder with relative paths; the audit re-points broken paths in a project.", ORANGE),
                           ("Approved, versioned", "The BIM Manager approves additions. Projects see a new version and choose when to update, with a list of what changes.", NAVY),
                           ("Feeds the whole family", "Model uses classes for quantities; Build uses cost codes; Flow's Tag Assist can tag finishes; Manage schedules them.", T)], 3), h=900)

# ---------- Materials flow ----------
f = FC(980, 640, 176, 80, lanes=[("Database", 0, 2), ("Manage", 2, 6), ("Outputs", 6, 8)], lw=100)
f.node("db", 0, 0, "data", "FMC material database", "records + textures, v1.3").node("ap", 1, 0, "gate", "BIM Manager approves", "new or changed").node("rq", 2, 0, "step", "Change request", "from a project").node("up", 0, 1, "auto", "New version notice", "what changes")
f.node("br", 0, 2, "step", "Browse, search, swatches").node("as", 1, 2, "step", "Choose target", "selection, category, rule").node("dr", 2, 2, "auto", "Dry run", "types, elements, before → after").node("lk", 3, 2, "decide", "Allowed here?", "Setup class, D1 toggle")
f.node("st", 4, 2, "stop", "Refused, reason shown").node("ok", 3, 3, "gate", "Apply?").node("rv", 2, 3, "revit", "Assign, one Undo", "type materials only").node("vf", 1, 3, "decide", "Verified?")
f.node("au", 1, 4, "auto", "Audit", "not in DB, duplicates, textures").node("fx", 2, 4, "step", "Fix paths, merge, purge", "each with a dry run").node("nw", 3, 4, "decide", "Material missing from DB?")
f.node("rq2", 4, 4, "step", "Send change request").node("fv", 1, 6, "end", "Finish colour view", "with legend").node("mt", 2, 6, "end", "Material takeoff", "m², m³ by class").node("rf", 3, 6, "end", "Room finishes schedule").node("bd", 4, 6, "end", "Quantities + cost codes", "to Build")
f.edge("db", "up", "", "v").edge("up", "br", "", "v").edge("rq", "ap").edge("ap", "db").edge("br", "as").edge("as", "dr").edge("dr", "lk").edge("lk", "st", "No").edge("lk", "ok", "Yes")
f.edge("ok", "rv", "Approve").edge("rv", "vf").edge("vf", "au", "Yes").edge("au", "fx").edge("fx", "nw").edge("nw", "rq2", "Yes").edge("rq2", "rq", "", "loopR", off=16).edge("au", "fv", "", "v").edge("fv", "mt").edge("mt", "rf").edge("rf", "bd")
flowboard("M_FlowMaterials.dc.html", "Materials flow", "Manage · flow 09 · Setup › Materials", "From one database to assigned, audited, visualised and scheduled materials", f,
          [("Database first", "Every material comes from the Formcraft material database; projects never invent their own.", ORANGE),
           ("Assign with a dry run", "Pick a target (selection, category or rule), see every type and element that would change, then apply with one Undo.", NAVY),
           ("Clean as you go", "The audit finds materials outside the database, duplicates, broken textures and unused materials, and fixes each with a dry run.", T),
           ("Outputs for everyone", "Finish colour views for reviews, material takeoff and room finishes schedules, and quantities with cost codes for Build.", "#B8862B")],
          ["start", "data", "gate", "step", "auto", "decide", "revit", "stop", "end"])
print("extra ok")
