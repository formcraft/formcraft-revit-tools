import sys
exec(open(__import__('pathlib').Path(__file__).with_name('flowlib.py')).read())
T = "#2C6B63"
ACC = {"core": NAVY, "manage": ORANGE, "flow": "#7FC7BE", "model": "#6FA8FF", "build": "#E8C27A"}
TOP = {"core": NAVY, "manage": ORANGE, "flow": "#7FC7BE", "model": "#6FA8FF", "build": "#B8862B"}
IC = {
 "pane": "M4 4h16v16H4z M14 4v16", "ai": "M9 3v5 M15 3v5 M7 8h10v4a5 5 0 0 1-10 0z M12 17v4",
 "log": "M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7",
 "parts": "M4 6h4 M4 12h4 M4 18h4 M11 6h9 M11 12h9 M11 18h9",
 "qa": "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5 4.5-5",
 "issue": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 8v5 M12 16h.01",
 "touch": "M9 11V5a2 2 0 0 1 4 0v6 M13 10a2 2 0 0 1 4 0v4a6 6 0 0 1-12 0v-2a2 2 0 0 1 4 0",
 "box": "M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",
 "check": "M13 2L4 14h7l-1 8 9-12h-7z", "qty": "M4 20V11 M10 20V5 M16 20v-6 M3 20h18",
 "work": "M3 4h18v14H3z M3 8h18 M8 21h8", "web": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18",
}
def big(label, ic, on=False, dim=False, caret=False):
    c = "#9AA1AB" if dim else NAVY
    cr = f'<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="{c}" stroke-width="3"></path></svg>' if caret else ""
    return (f'<div style="width: 66px; display: flex; flex-direction: column; align-items: center; gap: 4px">'
            f'<div style="width: 38px; height: 38px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: {NAVY if on else "#FFFFFF"}; border: 1.5px solid {c}">'
            f'<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="{IC[ic]}" fill="none" stroke="{"#FFFFFF" if on else c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg></div>'
            f'<div style="font-size: 11px; text-align: center; line-height: 1.2; color: {c}">{label}{cr}</div></div>')
def small(label, ic, dim=False):
    c = "#9AA1AB" if dim else NAVY
    return (f'<div style="display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px; border-radius: 4px; border: 1px solid {"#E3E6EA" if dim else "#C9CED6"}; background: #FFFFFF">'
            f'<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="{IC[ic]}" fill="none" stroke="{c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>'
            f'<span style="font-size: 11.5px; color: {c}; white-space: nowrap">{label}</span></div>')
def panel(name, bigs, smalls, dim=False, hi=None):
    sm = f'<div style="display: flex; flex-direction: column; gap: 5px; padding-top: 2px">{"".join(smalls)}</div>' if smalls else ""
    top = f"box-shadow: inset 0 3px 0 {hi};" if hi else ""
    return (f'<div style="display: flex; flex-direction: column; border-right: 1px solid #E3E6EA; padding: 8px 10px 0; opacity: {0.55 if dim else 1}; {top}">'
            f'<div style="display: flex; gap: 6px; align-items: flex-start">{"".join(bigs)}{sm}</div>'
            f'<div style="margin-top: 6px; padding-bottom: 6px; font-size: 11.5px; color: {"#9AA1AB" if dim else MUTED}; text-align: center">{name}</div></div>')
PANELS = {
 "core":   ("Core",   lambda d: [big("Pane", "pane", True, d), big("Connect<br>AI", "ai", dim=d)], lambda d: [small("Log file", "log", d)]),
 "manage": ("Manage", lambda d: [big("Manage<br>parts", "parts", dim=d, caret=True)], lambda d: [small("Run QA", "qa", d), small("Raise issue", "issue", d)]),
 "flow":   ("Flow",   lambda d: [big("Flow<br>parts", "parts", dim=d, caret=True)], lambda d: [small("Touch on", "touch", d), small("Section box", "box", d)]),
 "model":  ("Model",  lambda d: [big("Model<br>parts", "parts", dim=d, caret=True)], lambda d: [small("Check system", "check", d), small("Quantities", "qty", d)]),
 "build":  ("Build",  lambda d: [big("Build<br>parts", "parts", dim=d, caret=True)], lambda d: [small("Workspace", "work", d), small("Web app", "web", d)]),
}
def ribbon(focus=None):
    out = []
    for k, (name, bf, sf) in PANELS.items():
        d = focus is not None and k not in (focus, "core")
        out.append(panel(name, bf(d), sf(d), d, ACC[k] if focus == k else None))
    return (f'<div style="background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 10px; overflow: hidden">'
            f'<div style="display: flex; gap: 2px; padding: 6px 12px 0; background: #EEF0F3; font-size: 13px; color: #5B6270">' + "".join(f'<span style="padding: 5px 10px">{t}</span>' for t in ["Architecture", "Structure", "Systems", "Insert", "Annotate", "View", "Manage"])
            + f'<span style="padding: 5px 12px; background: #FFFFFF; color: {NAVY}; font-weight: 600; border-radius: 6px 6px 0 0; box-shadow: inset 0 3px 0 {ORANGE}">Formcraft</span></div>'
            f'<div style="display: flex; padding: 4px 4px 0">{"".join(out)}</div></div>')

PARTS = {
 "manage": ["Setup: Project, Templates, Families, Materials", "Drawings: Sheets, Annotate, Issue", "Team: Review, Workshare, Links", "Check: QA, Rules, Reports, Scripts"],
 "flow": ["Touch", "Sheet Layout", "Tags", "3D: Section Box"],
 "model": ["Systems (MEP)", "Structural", "Quantities"],
 "build": ["Views on the model", "BoQ and quantities", "Data package"],
}
def parts_menu(m):
    rows = "".join(f'<div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-top: 1px solid #EEF0F3; font-size: 13px">'
                   f'<span style="width: 14px; height: 14px; border-radius: 3px; background: {NAVY if i != len(PARTS[m]) - 1 or m == "manage" else "#FFFFFF"}; border: 1.5px solid {NAVY}; display: inline-block"></span>{E(p)}</div>' for i, p in enumerate(PARTS[m]))
    return (f'<div style="background: #FFFFFF; border: 1px solid #C9CED6; border-radius: 8px; box-shadow: 0 6px 18px rgba(20,30,45,0.12); overflow: hidden">'
            f'<div style="padding: 8px 10px; font-size: 12px; font-weight: 600; color: {NAVY}">{PANELS[m][0]} parts in the pane</div>{rows}'
            f'<div style="padding: 7px 10px; border-top: 1px solid #EEF0F3; font-size: 12px; color: {MUTED}">Same list as Settings › {PANELS[m][0]} › Parts in the pane</div></div>')

CARDS = {
 "manage": [card("Manage parts", ["A switch list: show or hide Setup, Drawings, Team and Check in the pane", "Ticks mirror Settings › Manage", "Your role still decides what you can run"], top=ORANGE),
            card("Run QA", ["Runs the QA set on the open model", "Report to 06_QA\\Health", "Results open in Check › QA"], top=ORANGE),
            card("Raise issue", ["New issue on the selection or view", "F26001-ISS-0001 IDs, Manual 10.5", "Tracked in Team › Review"], top=ORANGE)],
 "flow": [card("Flow parts", ["Show or hide Touch, Sheet Layout, Tags and 3D in the pane", "Ticks mirror Settings › Flow"], top="#7FC7BE"),
          card("Touch on", ["Master switch for touch in this view (FT)", "Sensitivity and view types in Settings › Flow"], top="#7FC7BE"),
          card("Section box", ["Section box from a dragged area (FX)", "Offset from Settings › Flow"], top="#7FC7BE")],
 "model": [card("Model parts", ["Show or hide Systems, Structural and Quantities in the pane", "Ticks mirror Settings › Model"], top="#6FA8FF"),
           card("Check system", ["Read-only checks for the active system", "Structural: analytical model check, Manual 12.2"], top="#6FA8FF"),
           card("Quantities", ["Counts, lengths, m³, steel t from types", "Feeds Check › Reports and Build"], top="#6FA8FF")],
 "build": [card("Build parts", ["Show or hide Views on the model, BoQ and Data package in the pane", "Ticks mirror Settings › Build"], top="#B8862B"),
           card("Workspace", ["Opens the workspace window beside the model", "BoQ, cost, packages, contractors, programme, contracts"], top="#B8862B"),
           card("Web app", ["Opens the web workspace on the Formcraft CDE", "For people outside the firm and for dashboards"], top="#B8862B")],
}
MOVED = {
 "manage": [["Formcraft Browser", "Core › Pane"], ["Connect", "Core › Connect AI"], ["Log", "Core › Log file"], ["Guard", "Pane › Admin (admins only)"], ["Probe", "Pane › Connect section"]],
 "flow": [["Touch Views", "Settings › Flow › Touch"], ["Align, Distribute, Smart Crop", "Pane › Flow quick tools, Ctrl+K, F-codes"], ["Tag Tidy (FY), Tag Assist", "Pane › Drawings › Annotate"], ["Touch On, Section Box", "Stay on the ribbon, as small buttons"]],
 "model": [["Systems", "Model parts › Systems in the pane"], ["Diagrams, Enrich, Federation", "Pane › Engineer › Systems"], ["Structural check and Robot results", "Pane › Structural"], ["Check, Quantities", "Stay on the ribbon, as small buttons"]],
 "build": [["Progress View, Package View", "Pane › Build › Views on the model"], ["BoQ, cost, packages, contractors", "Workspace window"], ["Programme, contracts, procurement", "Workspace window"], ["Dashboards, outsiders' access", "Web app"]],
}
NAMES = {"manage": "Manage", "flow": "Flow", "model": "Model", "build": "Build"}
for m in NAMES:
    body = (ribbon(m)
            + f'<div style="display: grid; grid-template-columns: 300px 1fr; gap: 16px; align-items: start">{parts_menu(m)}<div style="display: flex; flex-direction: column; gap: 14px">{grid(CARDS[m], 3, 14)}'
            + table(["Tool on the old ribbon", "Where it lives now"], MOVED[m], ["1fr", "1.3fr"]) + '</div></div>'
            + callouts([("Three tools at most", f"{NAMES[m]} has one parts switch and two small buttons. Everything else is in the pane{', the workspace window or the web app' if m == 'build' else ''}, found with Ctrl+K.", TOP[m]),
                        ("Core is always there", "Pane, Connect AI and Log file come with every licence. Panels of modules not licensed are hidden; here they are greyed.", NAVY),
                        ("Parts switch and Settings agree", f"Ticking a part on the ribbon and in Settings › {NAMES[m]} changes the same list, saved per person.", T)], 3))
    page(f"R_{NAMES[m]}.dc.html", f"{NAMES[m]} on the Formcraft tab", f"Formcraft {NAMES[m]} · ribbon", f"{NAMES[m]} on the Formcraft tab: one parts switch, two small buttons", body, h=760)

overview = (ribbon(None)
            + grid([card("Core", ["Pane: show or hide the Formcraft pane", "Connect AI: start the services and the Claude bridge", "Log file: open today's log"], top=NAVY),
                    card("Manage", ["Manage parts", "Run QA, Raise issue"], top=ORANGE), card("Flow", ["Flow parts", "Touch on, Section box"], top="#7FC7BE"),
                    card("Model", ["Model parts", "Check system, Quantities"], top="#6FA8FF"), card("Build", ["Build parts", "Workspace, Web app"], top="#B8862B")], 5, 12)
            + table(["Rule", "What it means"],
                    [["Five panels, never more", "Core plus one panel per licensed module"], ["Three tools per panel at most", "One parts switch and two small buttons per module; Core has Pane, Connect AI, Log file"],
                     ["Everything else in the pane", "Sections, tools and settings; Ctrl+K finds any of them"], ["Build's heavy work off the ribbon", "Workspace window in Revit, web app for outsiders"],
                     ["No logo on buttons", "The Formcraft logo is below its minimum size there"]], ["320px", "1fr"])
            + callouts([("Licensed panels only", "A firm with Manage and Flow sees Core, Manage and Flow: three panels, eight buttons.", ORANGE),
                        ("Parts switches", "Each module's parts switch shows or hides its sections in the pane, so people see only what they use.", NAVY)], 2))
page("Ribbon.dc.html", "Formcraft ribbon tab", "Ribbon · one Formcraft tab for the whole family", "Five small panels, three tools each at most; everything else lives in the pane", overview, h=700)
print("ribbon ok")
