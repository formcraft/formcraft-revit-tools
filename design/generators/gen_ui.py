import sys
exec(open(__import__('pathlib').Path(__file__).with_name('flowlib.py')).read())
FLOWC, BUILDC, MODELC = "#7FC7BE", "#B8862B", "#6FA8FF"

def set_js(fname, js):
    p = ROOT / fname; s = p.read_text()
    a = s.index("class Component extends DCLogic"); b = s.index("</script>", a)
    p.write_text(s[:a] + js + "\n" + s[b:])

def tabbar(names, acc):
    return "".join(f'<button onClick="{{{{t{i}.go}}}}" aria-pressed="{{{{t{i}.p}}}}" style="font: inherit; font-size: 13px; min-height: 36px; padding: 6px 14px; border: none; background: transparent; cursor: pointer; '
                   f'color: {{{{t{i}.fg}}}}; font-weight: {{{{t{i}.w}}}}; box-shadow: {{{{t{i}.sh}}}}">{E(n)}</button>' for i, n in enumerate(names))
def tab_js(n, acc, extra_state="", extra_vals="", msgs=None):
    m = "{}" if not msgs else "{" + ", ".join(f"{k}: {repr(v)}" for k, v in msgs.items()) + "}"
    return ("class Component extends DCLogic {\n"
            f"constructor(props) {{ super(props); this.state = {{ tab: 0, msg: 'Clickable mockup. Values are samples.'{extra_state} }}; }}\n"
            "renderVals() {\n"
            f"const s = this.state, v = {{ show: {{}}, a: {{}}, msg: s.msg }}, M = {m};\n"
            f"for (let i = 0; i < {n}; i++) {{ const on = i === s.tab; v['t' + i] = {{ p: on ? 'true' : 'false', fg: on ? '#1B2532' : '#4A515C', w: on ? '600' : '400', sh: on ? 'inset 0 -3px 0 {acc}' : 'none', go: () => this.setState({{ tab: i }}) }}; v.show['s' + i] = on; }}\n"
            "Object.keys(M).forEach((k) => { v.a[k] = () => this.setState({ msg: M[k] }); });\n"
            f"{extra_vals}\nreturn v;\n}}\n}}")
def panes_if(blocks):
    return "".join(f'<sc-if value="{{{{show.s{i}}}}}" hint-placeholder-val="{{{{{"true" if i == 0 else "false"}}}}}">{b}</sc-if>' for i, b in enumerate(blocks))
def act(label, key, primary=False):
    st = f"background: {NAVY}; color: #FFFFFF; border: 1px solid {NAVY}" if primary else "background: #FFFFFF; color: #1A1D21; border: 1px solid #C9CED6"
    return f'<button onClick="{{{{a.{key}}}}}" style="font: inherit; font-size: 12.5px; min-height: 32px; padding: 2px 12px; border-radius: 4px; cursor: pointer; {st}">{E(label)}</button>'
def window(title, inner, w=980, h=640, acc=NAVY):
    return (f'<div style="width: {w}px; flex-shrink: 0; align-self: flex-start; background: #FFFFFF; border: 1px solid #C9CED6; border-radius: 8px; box-shadow: 0 16px 40px rgba(26,29,33,0.14); overflow: hidden; display: flex; flex-direction: column; height: {h}px">'
            f'<div style="height: 32px; display: flex; align-items: center; padding: 0 12px; background: #F1F3F5; font-size: 12.5px; font-weight: 600">{E(title)}</div><div style="height: 2px; background: {acc}"></div>{inner}</div>')
def side(items):
    return f'<div style="flex: 1; min-width: 0">{callouts(items, 1)}</div>'

# ---------- 1. On-view overlays (Flow) ----------
G = "#1E8E3E"
def vp(x, y, w, h, ghost=False):
    st = 'stroke-dasharray="6 4" fill="rgba(127,199,190,0.12)" stroke="#2C6B63"' if ghost else 'fill="#FFFFFF" stroke="#5B6270"'
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" {st} stroke-width="1.5"></rect>'
sheet = lambda inner: (f'<svg viewBox="0 0 640 420" style="width: 100%; height: 420px; background: #E9ECEF; border-radius: 6px" role="img" aria-label="Sheet with viewports, sample">'
                       f'<rect x="20" y="20" width="600" height="380" fill="#FFFFFF" stroke="#9AA1AB"></rect><rect x="500" y="20" width="120" height="380" fill="#F6F7F9" stroke="#9AA1AB"></rect>{inner}</svg>')
ov_layout = (sheet(vp(46, 60, 190, 140) + vp(262, 48, 210, 160) + vp(58, 236, 170, 130) + vp(262, 230, 200, 140)
                   + vp(40, 44, 200, 150, True) + vp(256, 44, 220, 150, True) + vp(40, 226, 200, 150, True) + vp(256, 226, 220, 150, True)
                   + '<line x1="40" y1="34" x2="476" y2="34" stroke="#2C6B63" stroke-dasharray="3 3"></line><text x="44" y="30" font-size="11" fill="#2C6B63">sheet grid from Manage</text>')
             + f'<div style="display: flex; gap: 8px; align-items: center">{chip("Ghost preview: 4 viewports align to the grid", "info")}{act("Apply, one Undo", "lay", True)}{act("Cancel", "cancel")}</div>')
tag = lambda x, y, tx, ty, t: f'<line x1="{x}" y1="{y}" x2="{tx}" y2="{ty}" stroke="#1B2532"></line><rect x="{tx - 22}" y="{ty - 10}" width="44" height="18" rx="3" fill="#FFFFFF" stroke="#1B2532"></rect><text x="{tx}" y="{ty + 3}" font-size="10" text-anchor="middle">{t}</text>'
plan = lambda inner: (f'<svg viewBox="0 0 300 260" style="width: 100%; height: 260px; background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 6px" role="img" aria-label="Plan with tags, sample">'
                      f'<rect x="40" y="40" width="220" height="180" fill="none" stroke="#1A1D21" stroke-width="4"></rect><line x1="150" y1="40" x2="150" y2="220" stroke="#1A1D21" stroke-width="3"></line>{inner}</svg>')
ov_tags = (f'<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px"><div><div style="font-size: 12px; font-weight: 600; margin-bottom: 4px">Before</div>'
           + plan(tag(80, 80, 180, 120, "D01") + tag(200, 90, 100, 130, "D02") + tag(90, 180, 200, 170, "W01") + tag(220, 190, 120, 200, "W02"))
           + '</div><div><div style="font-size: 12px; font-weight: 600; margin-bottom: 4px">After Tag Tidy (preview)</div>'
           + plan(tag(80, 80, 80, 26, "D01") + tag(200, 90, 200, 26, "D02") + tag(90, 180, 90, 238, "W01") + tag(220, 190, 220, 238, "W02"))
           + f'</div></div><div style="display: flex; gap: 8px; align-items: center">{chip("Leaders never cross · one elbow · clear of walls", "info")}{act("Apply to 4 tags", "tag", True)}{act("Cancel", "cancel")}</div>')
ov_box = (f'<svg viewBox="0 0 640 380" style="width: 100%; height: 380px; background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 6px" role="img" aria-label="Section box drawn by dragging an area, sample">'
          f'<rect x="60" y="40" width="520" height="300" fill="none" stroke="#1A1D21" stroke-width="3"></rect><line x1="300" y1="40" x2="300" y2="340" stroke="#1A1D21" stroke-width="2"></line>'
          f'<rect x="320" y="70" width="230" height="170" fill="rgba(255,174,97,0.15)" stroke="#E07B1F" stroke-width="2" stroke-dasharray="6 4"></rect>'
          f'<text x="326" y="64" font-size="11" fill="#B35C00">dragged area · Level 2 · offset 300 mm</text><circle cx="550" cy="240" r="6" fill="#E07B1F"></circle></svg>'
          f'<div style="display: flex; gap: 8px; align-items: center">{chip("Opens your own 3D view with the section box", "info")}{act("Open 3D", "box", True)}{act("Cancel", "cancel")}</div>')
ov_touch = (f'<svg viewBox="0 0 640 380" style="width: 100%; height: 380px; background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 6px" role="img" aria-label="Touch feedback on the view, sample">'
            f'<rect x="60" y="40" width="520" height="300" fill="none" stroke="#1A1D21" stroke-width="3"></rect>'
            f'<circle cx="250" cy="190" r="26" fill="rgba(127,199,190,0.25)" stroke="#2C6B63" stroke-width="2"></circle><circle cx="390" cy="190" r="26" fill="rgba(127,199,190,0.25)" stroke="#2C6B63" stroke-width="2"></circle>'
            f'<path d="M226 190 H196 M414 190 H444" stroke="#2C6B63" stroke-width="2"></path><text x="320" y="250" font-size="12" text-anchor="middle" fill="#2C6B63">pinch: zoom 140%</text>'
            f'<rect x="470" y="300" width="100" height="28" rx="14" fill="#1B2532"></rect><text x="520" y="318" font-size="11" text-anchor="middle" fill="#FFFFFF">Touch on</text></svg>'
            f'<div style="display: flex; gap: 8px">{chip("Long press selects; two fingers pan; the pill shows touch is on", "info")}</div>')
names = ["Sheet Layout", "Tag Tidy", "Section box", "Touch"]
inner = (f'<div style="display: flex; padding: 0 12px; border-bottom: 1px solid #DDE1E6">{tabbar(names, FLOWC)}</div>'
         f'<div style="padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; flex-grow: 1">{panes_if([ov_layout, ov_tags, ov_box, ov_touch])}</div>'
         f'<div style="padding: 7px 14px; border-top: 1px solid #DDE1E6; font-size: 12px; color: #3B424D">{{{{msg}}}}</div>')
page("UI_Overlays.dc.html", "Flow on the view", "Formcraft Flow · on the view", "Flow shows a preview on the view before anything moves",
     f'<div style="display: flex; gap: 28px; flex-grow: 1; min-height: 0">{window("Revit view · A-1001 Ground Floor Plan", inner, 980, 640, FLOWC)}'
     + side([("Preview first", "Sheet Layout, Tag Tidy and Section box draw a dashed preview on the view. Nothing moves until you apply, and one Undo reverts it.", "#2C6B63"),
             ("Rules from Manage", "The sheet grid, title block guides and annotation standard come from Manage when it is licensed; otherwise Flow uses its own defaults.", ORANGE),
             ("Touch feedback", "Touch shows what each gesture is doing, and the pill on the view says touch is on. See the gestures board for every gesture.", NAVY)]) + '</div>', h=900)
set_js("UI_Overlays.dc.html", tab_js(4, FLOWC, msgs={"lay": "4 viewports aligned, one Undo (sample).", "tag": "4 tags tidied, one Undo (sample).", "box": "Your 3D view opened with the section box (sample).", "cancel": "Cancelled: nothing changed."}))

# ---------- 2. Log file window (Core) ----------
LOG = [["10:42", "Pane", "fmc_file · save_as", "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", "Dry run", ("OK", "good")],
       ["10:43", "Pane", "fmc_file · save_as", "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", "Run", ("OK", "good")],
       ["10:51", "Claude", "fmc_family · plan", "6 pilot families", "Check", ("3 ready, 3 blocked", "warn")],
       ["10:55", "Claude", "create_point_based_element", "THE OGALA RESIDENCE (live)", "Refused", ("Live-model lock", "bad")],
       ["11:02", "Ask", "model_statistics", "THE OGALA RESIDENCE (live)", "Read", ("1,840 tokens", "grey")],
       ["11:10", "Script", "FMC_ModelHealth", "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", "Run", ("Report saved", "good")]]
def logtab(rows):
    return (table(["Time", "From", "Tool", "Document", "Kind", "Result"], rows, ["50px", "60px", "1.3fr", "1.5fr", "70px", "130px"])
            + f'<div style="display: flex; gap: 8px">{act("Open the CSV", "csv")}{act("Open the reports folder", "folder")}{act("Copy row for support", "copy")}</div>')
tabs = ["All", "Pane clicks", "Claude", "Refused"]
blocks = [logtab(LOG), logtab([r for r in LOG if r[1] == "Pane"]), logtab([r for r in LOG if r[1] in ("Claude", "Ask")]), logtab([r for r in LOG if r[4] == "Refused"])]
inner = (f'<div style="display: flex; align-items: center; padding: 0 12px; border-bottom: 1px solid #DDE1E6">{tabbar(tabs, NAVY)}<span style="margin-left: auto; font-size: 12px; color: #5B6270">FMC_MCP_FileLog.csv · today · this PC</span></div>'
         f'<div style="padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; flex-grow: 1; overflow: auto">{panes_if(blocks)}</div>'
         f'<div style="padding: 7px 14px; border-top: 1px solid #DDE1E6; font-size: 12px; color: #3B424D">{{{{msg}}}}</div>')
page("UI_Log.dc.html", "Log file window", "Formcraft Core · Log file (ribbon)", "Every action, dry run and refusal in one log you can read",
     f'<div style="display: flex; gap: 28px; flex-grow: 1; min-height: 0">{window("Formcraft · Log file", inner, 980, 560)}'
     + side([("Opened from the ribbon", "Core › Log file opens today's log for this PC. The same rows go to FMC_MCP_FileLog.csv in the reports folder, from pane clicks and from Claude.", NAVY),
             ("Refusals are logged too", "When the live-model lock refuses a tool, the row says so. That is how a BIM Manager sees the rules working.", "#A50E0E"),
             ("Never used to rank people", "The log records tools and results for support and audit (Manual 14.5). Ask Claude rows hold tokens only, never the question or answer.", ORANGE)]) + '</div>', h=810)
set_js("UI_Log.dc.html", tab_js(4, NAVY, msgs={"csv": "FMC_MCP_FileLog.csv opens in Excel (sample).", "folder": "The reports folder opens (sample).", "copy": "Row copied for a support message (sample)."}))

# ---------- 3. Command palette (Ctrl+K) ----------
def res(rows):
    out = ""
    for grp, items in rows:
        out += f'<div style="font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: {MUTED}; padding: 8px 12px 4px">{E(grp)}</div>'
        for t, sub, key in items:
            out += (f'<button onClick="{{{{a.{key}}}}}" style="display: flex; width: 100%; align-items: center; gap: 10px; text-align: left; font: inherit; font-size: 13.5px; min-height: 40px; padding: 4px 12px; border: none; background: #FFFFFF; cursor: pointer">'
                    f'<span style="font-weight: 600">{E(t)}</span><span style="font-size: 12px; color: {MUTED}">{E(sub)}</span></button>')
    return out
Q = [("sheet", [("Sections", [("Drawings › Sheets", "Manage", "go1"), ("Ready to issue", "Manage", "go2")]), ("Actions", [("Sheet Layout: align viewports", "Flow · FA", "go3"), ("Create sheets from the register", "Manage · dry run first", "go4")]), ("Settings", [("Sheet grid and title block guides", "Settings › Flow", "go5")])]),
     ("qa", [("Sections", [("Check › QA", "Manage", "go6")]), ("Actions", [("Run QA on this model", "Manage · ribbon button", "go7"), ("Brief compliance check", "Manage › QA · uses the CIS", "go8")]), ("Help", [("QA rulebook", "Rules", "go9")])]),
     ("level", [("Actions", [("Start from brief: create levels", "Model · new files only", "go10"), ("Find levels that break the naming rule", "Manage › QA", "go11")]), ("Help", [("Level naming (decision D3)", "Manual 4.6", "go12")])])]
blocks = [res(r) for _, r in Q]
inner = (f'<div style="padding: 12px"><div style="display: flex; align-items: center; gap: 8px; border: 1.5px solid {NAVY}; border-radius: 6px; padding: 8px 10px">'
         f'<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4" fill="none" stroke="#1B2532" stroke-width="2"></path></svg>'
         f'<span style="font-size: 15px">{{{{query}}}}</span><span style="margin-left: auto; font-size: 11px; padding: 1px 6px; border: 1px solid #C9CED6; border-radius: 3px">Esc</span></div>'
         f'<div style="display: flex; gap: 6px; margin-top: 8px; align-items: center"><span style="font-size: 12px; color: {MUTED}">Try:</span>{tabbar(["sheet", "qa", "level"], ORANGE)}</div></div>'
         f'<div style="border-top: 1px solid #DDE1E6; flex-grow: 1; overflow: auto">{panes_if(blocks)}</div>'
         f'<div style="padding: 7px 12px; border-top: 1px solid #DDE1E6; font-size: 12px; color: #3B424D">{{{{msg}}}}</div>')
page("UI_Palette.dc.html", "Search: Ctrl+K", "Formcraft Core · search (Ctrl+K)", "One search finds every section, tool and setting, so the ribbon can stay small",
     f'<div style="display: flex; gap: 28px; flex-grow: 1; min-height: 0">{window("Formcraft pane · search", inner, 620, 520)}'
     + side([("Why it matters", "The ribbon has three tools per module. Everything else is found here: sections, actions, settings and help.", NAVY),
             ("Only what you may run", "Results follow your role and licence. A tool you can't run shows why, and who can.", ORANGE),
             ("Same rules", "An action picked here runs exactly like its button: dry run first, then your yes, then the log.", "#2C6B63")]) + '</div>', h=720)
set_js("UI_Palette.dc.html", tab_js(3, ORANGE, extra_vals="v.query = ['sheet', 'qa', 'level'][s.tab];",
                                    msgs={f"go{i}": "Opens it in the pane (sample)." for i in range(1, 13)}))

# ---------- 4. Inventory ----------
INV = [["Core", "Ribbon: Core, Manage, Flow, Model, Build panels", "Ribbon, R_Manage, R_Flow, R_Model, R_Build", "This section and the Core section"],
       ["Core", "Pane shell, start-of-day card, responsive pane", "PaneShell, ResponsivePane", "Core section"],
       ["Core", "Connect, Settings (General), Admin, Ask Claude", "PaneConnect, PaneSettings, PaneAdmin, PaneAsk", "Core and AI sections"],
       ["Core", "Log file window, search (Ctrl+K)", "UI_Log, UI_Palette", "This section, Core column"],
       ["Core", "Sign in, first-run setup, Settings › Account, Admin › Licences and seats", "PaneSignIn, PaneWelcome, PaneAccount, PaneSeats", "This section, Account column"],
       ["Core", "Locked, offline and error states; updates and about", "PaneStates, PaneUpdates", "This section, Account column"],
       ["All", "Build-ready UI kit: tokens, components, states, WPF names", "UI_Kit", "This section, Account column"],
       ["Manage", "Settings › Manage; Project; Materials", "PaneSettingsManage, PaneProject, PaneMaterials", "This section"],
       ["Manage", "Templates, Families, Sheets data, Issue, Review, Workshare, Links, QA, Rules, Reports, Scripts", "Pane… boards", "Manage page"],
       ["Manage", "Revision on the drawing (tab over the viewport); sheet prints", "ReviewOnSheet, SheetPrints", "This section, Manage column"],
       ["Flow", "Settings › Flow; Touch; Sheets; Annotate", "PaneSettingsFlow, PaneFlowTouch, PaneSheets, PaneAnnotate", "This section"],
       ["Flow", "On the view: Sheet Layout ghost, Tag Tidy preview, Section box, touch feedback; gestures", "UI_Overlays, Flow_Gestures", "This section, Flow column"],
       ["Model", "Settings › Model; Start from brief; Systems; Structural", "PaneSettingsModel, PaneModelBrief, PaneModelSystems, PaneModelStructural", "This section"],
       ["Model", "Diagrams, calculations for review, quantities", "Model_Diagrams, Model_Review, Model_Quantities", "Model page"],
       ["Build", "Settings › Build; Build pane; workspace window; coloured Revit views; web window", "PaneSettingsBuild, PaneBuild, B_Workspace, B_RevitViews, B_Web", "This section"],
       ["All", "Dry-run and confirm dialogs", "Inside each pane (open them in play mode)", "Every pane"]]
page("UI_Inventory.dc.html", "Every screen in the plugin", "Formcraft Revit Tools · screen inventory", "Every pane, window, overlay and dialog the plugin needs, and where each is drawn",
     table(["Module", "Screen", "Board", "Where on this canvas"], INV, ["80px", "1.6fr", "1.4fr", "1fr"])
     + callouts([("Play mode", "Every pane, the web window, the overlays, the log and search are clickable in play mode.", NAVY),
                 ("Nothing hidden", "If a screen is not in this list, it is not in the plan yet. Add a comment and it gets drawn.", ORANGE)], 2), h=1000)

# ---------- 5. UI kit (build-ready) ----------
sw = lambda c, n, use: f'<div style="display: flex; flex-direction: column; gap: 4px"><div style="height: 44px; border-radius: 6px; border: 1px solid #DDE1E6; background: {c}"></div><div style="font-size: 12px; font-weight: 600">{n}</div><div style="font-size: 11px; {MONO}">{c}</div><div style="font-size: 11px; color: {MUTED}">{use}</div></div>'
colours = grid([sw("#1B2532", "Navy", "Primary, active, text on light"), sw("#FFAE61", "Orange", "Brand line, AI tag, Manage"), sw("#1A1D21", "Ink", "Body text"), sw("#5B6270", "Muted", "Secondary text"),
                sw("#C9CED6", "Line", "Borders, inputs"), sw("#F1F3F5", "Header", "Pane header, table head"), sw("#7FC7BE", "Flow", "Flow accent"), sw("#6FA8FF", "Model", "Model accent"),
                sw("#E8C27A", "Build", "Build accent"), sw("#1E8E3E", "Good", "OK, connected"), sw("#E0A100", "Warning", "Needs attention"), sw("#D93025", "Critical", "Refused, error")], 6, 10)
b1 = f'<button style="min-height: 26px; padding: 1px 9px; font: inherit; font-size: 11.5px; border: 1px solid {NAVY}; background: {NAVY}; color: #FFFFFF; font-weight: 600; border-radius: 3px">Primary</button>'
b2 = f'<button style="min-height: 26px; padding: 1px 9px; font: inherit; font-size: 11.5px; border: 1px solid {LINE}; background: #FFFFFF; color: {INK}; border-radius: 3px">Secondary</button>'
b3 = f'<button style="min-height: 26px; padding: 1px 9px; font: inherit; font-size: 11.5px; border: 1px solid {LINE}; background: #FFFFFF; color: {INK}; border-radius: 3px">Check with Claude<span style="margin-left: 4px; font-size: 9.5px; padding: 0 4px; border-radius: 3px; background: {ORANGE}; color: {NAVY}; font-weight: 700">AI</span></button>'
tg = lambda on: f'<span style="display: inline-block; width: 40px; height: 22px; border-radius: 11px; background: {NAVY if on else "#6B7280"}; position: relative"><span style="position: absolute; top: 3px; left: {21 if on else 3}px; width: 16px; height: 16px; border-radius: 50%; background: #FFFFFF"></span></span>'
segc = f'<span style="display: inline-flex; padding: 2px; background: #EEF0F3; border-radius: 5px"><span style="padding: 3px 10px; background: #FFFFFF; border-radius: 4px; font-size: 11.5px; font-weight: 600">Light</span><span style="padding: 3px 10px; font-size: 11.5px">Dark</span></span>'
inpc = f'<span style="display: inline-block; width: 180px; height: 28px; border: 1px solid {LINE}; border-radius: 4px; padding: 5px 8px; box-sizing: border-box; font-size: 12px; color: {MUTED}">Project code</span>'
comp = table(["Component", "Looks like", "States", "WPF name"], [], ["150px", "1fr", "1fr", "170px"])
rows = [("Button", b1 + " " + b2, "rest, hover, pressed, disabled, busy", "FmcButton.Primary / .Secondary"), ("AI button", b3, "same + needs key", "FmcButton.Ai"),
        ("Switch", tg(True) + " " + tg(False), "on, off, locked (padlock)", "FmcToggle"), ("Segmented", segc, "one selected", "FmcSegmented"),
        ("Chip", chip("OK", "good") + " " + chip("Check", "warn") + " " + chip("Refused", "bad") + " " + chip("Info", "info"), "good, warning, critical, info, neutral", "FmcChip.{State}"),
        ("Input", inpc, "empty, filled, invalid, read-only", "FmcTextBox"), ("Status banner", chip("Live project: Claude reads and reports", "bad"), "setup open, shared, live", "FmcDocBanner")]
comp = (f'<div style="background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 8px; overflow: hidden"><div style="display: grid; grid-template-columns: 130px 1.4fr 1fr 190px; gap: 10px; padding: 6px 10px; background: #F1F3F5; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: {MUTED}"><span>Component</span><span>Looks like</span><span>States</span><span>WPF name</span></div>'
        + "".join(f'<div style="display: grid; grid-template-columns: 130px 1.4fr 1fr 190px; gap: 10px; padding: 8px 10px; border-top: 1px solid #E3E6EA; font-size: 12.5px; align-items: center"><span style="font-weight: 600">{n}</span><span>{l}</span><span style="color: #3B424D">{st}</span><span style="{MONO}; font-size: 11.5px">{w}</span></div>' for n, l, st, w in rows) + '</div>')
spec = table(["Token", "Value"], [["Font", "IBM Plex Sans; IBM Plex Mono for paths and codes"], ["Text sizes", "13 header · 12.5 body · 11.5 controls · 10.5 hints"], ["Spacing", "4 · 6 · 8 · 10 · 16"], ["Radius", "3 buttons · 4 inputs · 5 nav · 8 pane and dialogs"],
                                   ["Pane width", "320 to 560 px; compact layout below 400 px"], ["Touch targets", "26 px in the pane, 44 px when Touch is on"], ["Dark theme", "Follows Revit; same tokens, dark values"], ["Icons", "24 px grid, 2 px stroke, navy; no logo on buttons"]], ["150px", "1fr"])
page("UI_Kit.dc.html", "Build-ready UI kit", "Formcraft Revit Tools · UI kit for the build", "One set of tokens and components for every pane, so the shell can be built first",
     colours + f'<div style="display: grid; grid-template-columns: 1.6fr 1fr; gap: 16px">{comp}{spec}</div>'
     + callouts([("Build the shell first", "Pane frame, header, navigation, search, settings, sign-in, licence and states use only these parts. Features drop in later as sections.", NAVY),
                 ("One source", "Tokens live in one WPF resource dictionary (FmcTheme.xaml); the canvases use the same values.", ORANGE),
                 ("Accessible", "Text contrast 4.5:1, keyboard focus on every control, labels on icon-only buttons.", "#2C6B63")], 3), h=1000)
print("ui ok")

def tile(label, value, sub=""):
    return (f'<div style="background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 8px; padding: 10px 12px"><div style="font-size: 11.5px; color: #5B6270">{E(label)}</div>'
            f'<div style="font-size: 24px; font-weight: 700; margin-top: 2px">{E(value)}</div><div style="font-size: 11px; color: #5B6270">{E(sub)}</div></div>')
# ---------- 6. Formcraft account website (payments live here) ----------
def plan_card(name, price, items, primary=False, key="p"):
    bd = f"2px solid {NAVY}" if primary else "1px solid #DDE1E6"
    lis = "".join(f'<li style="margin: 3px 0">{E(i)}</li>' for i in items)
    return (f'<div style="background: #FFFFFF; border: {bd}; border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 8px">'
            f'<div style="font-size: 15px; font-weight: 700">{E(name)}</div><div style="font-size: 20px; font-weight: 700">{E(price)}<span style="font-size: 12px; font-weight: 400; color: {MUTED}"> per seat / year</span></div>'
            f'<ul style="margin: 0; padding-left: 18px; font-size: 12.5px; color: #3B424D">{lis}</ul><div style="margin-top: auto">{act("Choose " + name, key, primary)}</div></div>')
w_plans = (grid([plan_card("Core", "Free", ["Pane, Connect AI, Log file", "Settings, search, help", "Needed by every module"], key="pcore"),
                 plan_card("Manage", "[PRICE]", ["Project start, templates, families", "Sheets, issue, QA, rules, reports", "Materials library"], True, "pman"),
                 plan_card("Flow", "[PRICE]", ["Touch, Sheet Layout, Tag Tidy", "Section box, shortcuts standard", "For every Revit user"], key="pflow"),
                 plan_card("Model", "[PRICE]", ["Start from brief", "MEP systems, structural checks", "Quantities"], key="pmod"),
                 plan_card("Build", "[PRICE]", ["Build pane and workspace window", "BoQ, progress, packages, 4D", "Web workspace for outsiders"], key="pbuild")], 5, 10)
           + f'<div style="display: flex; gap: 8px; align-items: center">{chip("14-day trial of any module, no card needed", "info")}{chip("Team discount from 5 seats: [DISCOUNT]", "grey")}</div>')
w_checkout = (f'<div style="display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px"><div style="display: flex; flex-direction: column; gap: 10px">'
              + table(["Module", "Seats", "Per seat / year", "Total"], [["Manage", "8", "[PRICE]", "[TOTAL]"], ["Flow", "10", "[PRICE]", "[TOTAL]"], ["Build", "2", "[PRICE]", "[TOTAL]"]], ["1fr", "60px", "120px", "100px"])
              + f'<div style="font-size: 13px; font-weight: 600">Pay with</div><div style="display: flex; gap: 8px; flex-wrap: wrap">{act("Card", "card", True)}{act("Mobile money", "momo")}{act("Bank transfer (invoice first)", "bank")}</div>'
              + f'<div style="font-size: 12px; color: #3B424D">Payment methods depend on the payment provider chosen; prices in UGX, VAT shown on the invoice.</div></div>'
              + f'<div style="background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 8px"><div style="font-size: 14px; font-weight: 700">Order summary</div>'
              + table(["Item", "Amount"], [["Subtotal", "[SUBTOTAL]"], ["VAT", "[VAT]"], ["Total per year", "[TOTAL]"]], ["1fr", "110px"])
              + f'<div>{act("Pay and activate", "pay", True)}</div><div style="font-size: 11.5px; color: {MUTED}">Seats activate at once; the plugin picks them up at the next licence check.</div></div></div>')
w_sub = (grid([tile("Plan", "Team", "renews 31 Dec 2026"), tile("Seats", "20", "Manage 8 · Flow 10 · Build 2"), tile("Next payment", "[AMOUNT]", "card ending 4242"), tile("Trials", "1", "Model, 9 days left")], 4, 10)
         + table(["Module", "Seats used", "Seats", "Change"], [["Manage", "7", "8", ("Add or remove", "grey")], ["Flow", "9", "10", ("Add or remove", "grey")], ["Model", "2", "2 (trial)", ("Buy", "info")], ["Build", "0", "2", ("Add or remove", "grey")]], ["1fr", "90px", "90px", "130px"])
         + f'<div style="display: flex; gap: 8px; flex-wrap: wrap">{act("Add seats", "add")}{act("Change renewal date", "renew")}{act("Turn off auto-renew", "auto")}{act("Update payment method", "method")}</div>')
w_inv = (table(["Invoice", "Date", "For", "Amount", "Status"], [["FMC-INV-2026-014", "01 Oct 2026", "2 Build seats (prorated)", "[AMOUNT]", ("Paid", "good")], ["FMC-INV-2026-001", "02 Jan 2026", "Team plan, 18 seats", "[AMOUNT]", ("Paid", "good")], ["FMC-INV-2026-015", "13 Oct 2026", "Model, 2 seats", "[AMOUNT]", ("Due 27 Oct", "warn")]], ["150px", "100px", "1fr", "100px", "100px"])
         + f'<div style="display: flex; gap: 8px; flex-wrap: wrap">{act("Download PDF", "pdf")}{act("Pay now", "paynow", True)}{act("Billing details and TIN", "tin")}</div>')
w_keys = (table(["Person", "Modules", "PCs", "Last check"], [["[NAME A]", "Manage, Flow, Model", "crafty27", "Today"], ["[NAME C]", "Manage, Flow", "fmc-ws-02", "Today"], ["[NAME D]", "Manage, Build", "fmc-qs-01", "Yesterday"]], ["1fr", "1.2fr", "120px", "90px"])
          + f'<div style="display: flex; gap: 8px; flex-wrap: wrap">{act("Invite a person", "inv")}{act("Make an offline licence file", "off")}{act("Show licence keys", "keys")}{act("Sign out a lost PC", "lost")}</div>')
names = ["Plans", "Checkout", "Subscription", "Invoices", "People and keys"]
inner = (f'<div style="display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: #FFFFFF; border-bottom: 1px solid #DDE1E6"><span style="font-weight: 700">Formcraft account</span><span style="font-size: 12px; color: {MUTED}">account.[FORMCRAFT DOMAIN]</span><span style="margin-left: auto; font-size: 12px">[NAME B] · Billing admin</span></div>'
         f'<div style="display: flex; padding: 0 12px; background: #FFFFFF; border-bottom: 1px solid #DDE1E6">{tabbar(names, ORANGE)}</div>'
         f'<div style="padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; flex-grow: 1; overflow: auto; background: #F6F7F9">{panes_if([w_plans, w_checkout, w_sub, w_inv, w_keys])}</div>'
         f'<div style="padding: 7px 16px; border-top: 1px solid #DDE1E6; font-size: 12px; color: #3B424D; background: #FFFFFF">{{{{msg}}}}</div>')
page("UI_AccountWeb.dc.html", "Formcraft account website", "Formcraft account · website (not in Revit)", "Buying, renewals, invoices and seats live on the account website",
     f'<div style="display: flex; gap: 28px; flex-grow: 1; min-height: 0">{window("Browser · Formcraft account", inner, 1020, 680, ORANGE)}'
     + side([("Why not in Revit", "Payments need a secure web checkout, receipts and tax records. The plugin only signs in and reads the licence.", NAVY),
             ("Plans by module", "Core is free; Manage, Flow, Model and Build are bought per seat per year, with a 14-day trial of any module.", ORANGE),
             ("One source of seats", "Seats bought here show in Admin › Licences and seats in the pane within one licence check.", "#2C6B63"),
             ("Placeholders", "Prices, discounts and the domain are [PLACEHOLDERS] until you set them.", "#8A919C")]) + '</div>', h=900)
set_js("UI_AccountWeb.dc.html", tab_js(5, ORANGE, msgs={k: v for k, v in [("pcore", "Core is free: download and sign in (sample)."), ("pman", "Manage added to the order (sample)."), ("pflow", "Flow added (sample)."), ("pmod", "Model added (sample)."), ("pbuild", "Build added (sample)."),
    ("card", "Card payment selected (sample)."), ("momo", "Mobile money selected: approve on your phone (sample)."), ("bank", "Invoice issued; seats start when payment arrives (sample)."), ("pay", "Paid: seats active; the plugin picks them up at the next check (sample)."),
    ("add", "Pick a module and the number of seats (sample)."), ("renew", "Renewal date options (sample)."), ("auto", "Auto-renew off; you'll get reminders (sample)."), ("method", "Payment method form (sample)."),
    ("pdf", "Invoice PDF downloaded (sample)."), ("paynow", "Opens checkout for FMC-INV-2026-015 (sample)."), ("tin", "Billing name, address and TIN for invoices (sample)."),
    ("inv", "Invite form (sample)."), ("off", "Offline licence file for a PC, valid 30 days (sample)."), ("keys", "Keys shown to billing admins only (sample)."), ("lost", "That PC's seat is freed and its sign-in ends (sample).")]}))
print("accountweb ok")
