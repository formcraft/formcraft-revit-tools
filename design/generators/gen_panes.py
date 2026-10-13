"""Generate the Formcraft Browser pane boards and the ribbon board for the design canvas."""
import json, sys, pathlib
from html import escape as E

ROOT = pathlib.Path(sys.argv[1]) / "project"
ROOT.mkdir(parents=True, exist_ok=True)
LOGO = "/_blob/c0d01c2697f491e1308003dd48747c8b"
NAVY, ORANGE, INK, MUTED, LINE = "#1B2532", "#FFAE61", "#1A1D21", "#5B6270", "#C9CED6"
CHIP = {"good": ("#E6F4EA", "#1E6B34"), "warn": ("#FFF4E0", "#6B4100"), "bad": ("#FDECEA", "#A50E0E"),
        "grey": ("#EEF0F3", "#4A515C"), "info": ("#E3F2EF", "#2C6B63")}
MONO = "font-family: 'IBM Plex Mono', monospace"

ICONS = {
    "Connect": "M9 3v5 M15 3v5 M7 8h10v4a5 5 0 0 1-10 0z M12 17v4",
    "Project": "M3 6h6l2 2h10v11H3z",
    "Templates": "M12 3l9 5-9 5-9-5z M3 13l9 5 9-5",
    "Families": "M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5",
    "Sheets": "M6 3h9l4 4v14H6z M15 3v4h4",
    "Annotate": "M3 12V4h8l10 10-8 8z M7.5 7.5h.01",
    "QA": "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5 4.5-5",
    "Links": "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
    "Rules": "M4 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4z M20 4h-4a3 3 0 0 0-3 3",
    "Activity": "M8 6h13 M8 12h13 M8 18h13 M3.5 6h.01 M3.5 12h.01 M3.5 18h.01",
    "Review": "M7 18a4 4 0 0 1-.9-7.9 5.5 5.5 0 0 1 10.6-1.6A4.5 4.5 0 0 1 17.5 18z M12 10.5v3 M12 16h.01",
    "Workshare": "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 20a6 6 0 0 1 12 0 M16 5.2a3 3 0 0 1 0 5.6 M21 20a6 6 0 0 0-4-5.6",
    "Issue": "M3 11l18-8-8 18-2-8z M11 13l10-10",
    "Scripts": "M8 7l-5 5 5 5 M16 7l5 5-5 5 M13.5 4l-3 16",
    "Systems": "M13 2L4 14h7l-1 8 9-12h-7z",
    "Materials": "M12 3a9 9 0 1 0 0 18c1.2 0 1.6-1 1-1.8-.6-.9-.2-2.2 1-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z M7.5 11h.01 M10 7.5h.01 M14 7.5h.01",
    "Build": "M3 21h18 M5 21V9l7-5 7 5v12 M9 21v-6h6v6",
    "Reports": "M4 20V11 M10 20V5 M16 20v-6 M3 20h18",
    "Settings": "M4 6h9 M17 6h3 M4 12h3 M11 12h9 M4 18h11 M19 18h1 M15 4v4 M9 10v4 M17 16v4",
    "Admin": "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1",
    "Brief": "M15 4h2a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2 M9 3h6v3H9z M9 11h6 M9 15h4",
    "Claude": "M12 3v4 M12 17v4 M3 12h4 M17 12h4 M6 6l2.5 2.5 M15.5 15.5L18 18 M6 18l2.5-2.5 M15.5 8.5L18 6",
}
NAV = ["Connect", "Project", "Templates", "Families", "Sheets", "Annotate", "Review", "Workshare", "QA", "Issue", "Links", "Rules", "Reports", "Scripts"]

def icon(name, color, size=16):
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" aria-hidden="true"><path d="{ICONS[name]}" '
            f'fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>')

# ---------- controls ----------
INP = f"height: 28px; box-sizing: border-box; padding: 0 8px; border: 1px solid {LINE}; border-radius: 4px; font: inherit; font-size: 12.5px; background: #FFFFFF; color: {INK}"
_ids = [0]
def nid():
    _ids[0] += 1
    return f"f{_ids[0]}"

def field(label, ctrl, hint=None, fid=None):
    h = f'<div style="margin-top: 3px; font-size: 11px; line-height: 1.35; color: {MUTED}">{E(hint)}</div>' if hint else ""
    lab = f'<label for="{fid}" style="display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px">{E(label)}</label>' if fid else \
          f'<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px">{E(label)}</div>'
    return f'<div>{lab}{ctrl}{h}</div>'

def inp(label, value="", ph="", mono=False, hint=None, browse=False, pwd=False, num=False):
    i = nid()
    t = "password" if pwd else ("number" if num else "text")
    st = INP + (f"; {MONO}; font-size: 11.5px" if mono else "")
    v = f' value="{E(value)}"' if value else ""
    p = f' placeholder="{E(ph)}"' if ph else ""
    box = f'<input id="{i}" type="{t}"{v}{p} style="flex: 1; min-width: 0; width: 100%; {st}">'
    if browse:
        box = (f'<div style="display: flex; gap: 6px">{box}<button style="height: 28px; padding: 0 10px; border: 1px solid {LINE}; '
               f'background: #FFFFFF; border-radius: 4px; font: inherit; font-size: 12px; cursor: pointer">{E(browse)}</button></div>')
    return field(label, box, hint, i)

def sel(label, options, chosen=0, hint=None):
    i = nid()
    opts = "".join(f'<option{" selected=\"selected\"" if k == chosen else ""}>{E(o)}</option>' for k, o in enumerate(options))
    return field(label, f'<select id="{i}" style="width: 100%; {INP}; padding: 0 6px">{opts}</select>', hint, i)

def ta(label, text="", ph="", rows=3, hint=None, mono=False):
    i = nid()
    st = f"width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid {LINE}; border-radius: 4px; font: inherit; font-size: 12px; line-height: 1.45; resize: vertical"
    if mono:
        st += f"; {MONO}; font-size: 11px"
    p = f' placeholder="{E(ph)}"' if ph else ""
    return field(label, f'<textarea id="{i}" rows="{rows}"{p} style="{st}">{E(text)}</textarea>', hint, i)

def chips(label, items, on=(), hint=None):
    out = []
    for c in items:
        s = c in on
        out.append(f'<button aria-pressed="{"true" if s else "false"}" style="min-width: 36px; height: 26px; padding: 0 9px; border-radius: 13px; '
                   f'border: 1px solid {NAVY if s else LINE}; background: {NAVY if s else "#FFFFFF"}; color: {"#FFFFFF" if s else "#3B424D"}; '
                   f'font: inherit; font-size: 11.5px; font-weight: 500; cursor: pointer">{E(c)}</button>')
    return field(label, f'<div role="group" aria-label="{E(label)}" style="display: flex; flex-wrap: wrap; gap: 4px">{"".join(out)}</div>', hint)

def seg(label, items, active=0, hint=None):
    out = []
    for k, c in enumerate(items):
        s = k == active
        out.append(f'<button aria-pressed="{"true" if s else "false"}" style="flex: 1; min-height: 26px; border: none; border-radius: 4px; '
                   f'background: {"#FFFFFF" if s else "transparent"}; color: {INK if s else "#4A515C"}; font: inherit; font-size: 11.5px; '
                   f'font-weight: {600 if s else 400}; cursor: pointer">{E(c)}</button>')
    return field(label, f'<div role="group" aria-label="{E(label)}" style="display: flex; gap: 2px; padding: 2px; background: #EEF0F3; border-radius: 6px">{"".join(out)}</div>', hint)

def toggle(label, on, sub=None, locked=False):
    bg = NAVY if on else "#6B7280"
    knob = "21px" if on else "3px"
    s = f'<span style="display: block; font-size: 11px; color: {MUTED}">{E(sub)}</span>' if sub else ""
    dis = ' disabled="disabled"' if locked else ""
    return (f'<div style="display: flex; align-items: center; gap: 8px"><span style="flex: 1; min-width: 0"><span style="font-size: 12px; font-weight: 600">{E(label)}</span>{s}</span>'
            f'<button role="switch" aria-checked="{"true" if on else "false"}" aria-label="{E(label)}"{dis} style="width: 40px; height: 22px; padding: 0; border-radius: 11px; '
            f'border: none; background: {bg}; position: relative; cursor: pointer; opacity: {0.55 if locked else 1}"><span style="position: absolute; top: 3px; left: {knob}; '
            f'width: 16px; height: 16px; border-radius: 50%; background: #FFFFFF"></span></button>'
            f'<span style="width: 40px; font-size: 11px; color: #4A515C">{"Locked" if locked else ("On" if on else "Off")}</span></div>')

def checks(label, items, hint=None):
    rows = []
    for it in items:
        text, on = it[0], it[1]
        meta = it[2] if len(it) > 2 else None
        kind = it[3] if len(it) > 3 else "grey"
        i = nid()
        c = ' checked="checked"' if on else ""
        m = ""
        if meta:
            bg, fg = CHIP[kind]
            m = f'<span style="margin-left: auto; font-size: 10.5px; padding: 1px 7px; border-radius: 9px; background: {bg}; color: {fg}; white-space: nowrap">{E(meta)}</span>'
        rows.append(f'<div style="display: flex; align-items: center; gap: 7px; min-height: 26px"><input id="{i}" type="checkbox"{c}>'
                    f'<label for="{i}" style="font-size: 12px">{E(text)}</label>{m}</div>')
    return field(label, f'<div style="display: flex; flex-direction: column">{"".join(rows)}</div>', hint)

def radios(label, items, chosen=0):
    g = nid()
    rows = []
    for k, t in enumerate(items):
        i = nid()
        c = ' checked="checked"' if k == chosen else ""
        rows.append(f'<div style="display: flex; align-items: center; gap: 7px; min-height: 24px"><input id="{i}" type="radio" name="{g}"{c}>'
                    f'<label for="{i}" style="font-size: 12px">{E(t)}</label></div>')
    return field(label, "".join(rows))

def ro(label, value, mono=True, hint=None):
    st = MONO + "; font-size: 11.5px" if mono else "font-size: 12px"
    return field(label, f'<div style="min-height: 28px; box-sizing: border-box; padding: 5px 8px; border-radius: 4px; background: #F1F3F5; color: #3B424D; {st}; line-height: 1.45">{E(value)}</div>', hint)

def drop(label, text, sub):
    return field(label, f'<div style="padding: 12px; border: 1.5px dashed {LINE}; border-radius: 6px; text-align: center; background: #FBFBFC">'
                        f'<div style="font-size: 12px; font-weight: 600; color: #3B424D">{E(text)}</div><div style="font-size: 11px; color: {MUTED}">{E(sub)}</div></div>')

def tbl(label, head, rows, widths):
    gc = " ".join(widths)
    h = "".join(f'<span>{E(x)}</span>' for x in head)
    body = []
    for r in rows:
        cells = []
        for x in r:
            if isinstance(x, tuple):
                bg, fg = CHIP[x[1]]
                cells.append(f'<span><span style="font-size: 10.5px; padding: 1px 6px; border-radius: 9px; background: {bg}; color: {fg}; white-space: nowrap">{E(x[0])}</span></span>')
            else:
                cells.append(f'<span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{E(x)}</span>')
        body.append(f'<div style="display: grid; grid-template-columns: {gc}; gap: 6px; align-items: center; min-height: 26px; padding: 0 6px; border-top: 1px solid #EEF0F3; font-size: 11.5px">{"".join(cells)}</div>')
    return field(label, f'<div style="border: 1px solid #DDE1E6; border-radius: 4px; overflow: hidden"><div style="display: grid; grid-template-columns: {gc}; gap: 6px; '
                        f'padding: 4px 6px; background: #F1F3F5; font-size: 10.5px; color: {MUTED}; text-transform: uppercase; letter-spacing: 0.5px">{h}</div>{"".join(body)}</div>')

def note(text, kind="info"):
    bg, fg = CHIP[kind]
    return f'<div style="padding: 6px 8px; border-radius: 4px; background: {bg}; color: {fg}; font-size: 11.5px; line-height: 1.4">{E(text)}</div>'

def group(title, *parts):
    return (f'<section style="display: flex; flex-direction: column; gap: 10px; padding: 12px 12px 14px; border-bottom: 1px solid #E3E6EA">'
            f'<h3 style="margin: 0; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: {MUTED}; font-weight: 600">{E(title)}</h3>{"".join(parts)}</section>')

def author(ph):
    i = nid()
    return (f'<section style="margin: 12px; padding: 10px 12px; border: 1px solid #DDE1E6; border-top: 3px solid {ORANGE}; border-radius: 6px; background: #FFFCF8">'
            f'<label for="{i}" style="display: block; font-size: 12px; font-weight: 700">Author\'s considerations</label>'
            f'<div style="font-size: 11px; color: {MUTED}; margin: 2px 0 6px">Sent with every Claude request from this panel and saved in the log. It never overrides a rule; a conflict is flagged.</div>'
            f'<textarea id="{i}" rows="4" placeholder="{E(ph)}" style="width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid {LINE}; '
            f'border-radius: 4px; font: inherit; font-size: 12px; line-height: 1.45; resize: vertical"></textarea>'
            f'<div style="display: flex; gap: 6px; margin-top: 6px"><select aria-label="Saved considerations" style="flex: 1; {INP}; padding: 0 6px">'
            f'<option>Saved: none selected</option><option>Client house style notes</option><option>Permit-set rules</option></select>'
            f'<button style="height: 28px; padding: 0 10px; border: 1px solid {LINE}; background: #FFFFFF; border-radius: 4px; font: inherit; font-size: 12px; cursor: pointer">Save as…</button></div></section>')

def btn(t, primary=False, ai=False):
    if primary:
        st = f"border: 1px solid {NAVY}; background: {NAVY}; color: #FFFFFF; font-weight: 600"
    else:
        st = f"border: 1px solid {LINE}; background: #FFFFFF; color: {INK}"
    tag = f'<span style="margin-left: 4px; font-size: 9.5px; padding: 0 4px; border-radius: 3px; background: {ORANGE}; color: {NAVY}; font-weight: 700">AI</span>' if ai else ""
    return f'<button style="min-height: 26px; padding: 1px 9px; font: inherit; font-size: 11.5px; {st}; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center">{E(t)}{tag}</button>'

# ---------- pane chrome ----------
def pane(active, doc, doc_kind, body, footer, foot_note):
    if isinstance(body, (tuple, list)):
        body = "".join(body)
    navs = []
    for n in NAV:
        s = n == active
        col = "#FFFFFF" if s else "#3B424D"
        navs.append(f'<button aria-pressed="{"true" if s else "false"}" style="display: flex; flex-direction: column; align-items: center; gap: 2px; min-height: 44px; '
                    f'padding: 4px 0; border: none; border-radius: 5px; background: {NAVY if s else "transparent"}; color: {col}; font: inherit; font-size: 10.5px; '
                    f'font-weight: {600 if s else 400}; cursor: pointer">{icon(n, col)}{E(n)}</button>')
    bg, fg = CHIP[doc_kind]
    lock = {"good": "Setup tools open", "warn": "Shared model: Claude in shared models is on", "bad": "Live project: Claude reads and reports"}[doc_kind]
    return (f'<div style="width: 440px; flex-shrink: 0; background: #FFFFFF; border: 1px solid {LINE}; border-radius: 8px; box-shadow: 0 12px 32px rgba(26,29,33,0.10); '
            f'display: flex; flex-direction: column; overflow: hidden; font-size: 12.5px">'
            f'<div style="height: 32px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; background: #F1F3F5; font-weight: 600; font-size: 13px">'
            f'<span>Formcraft Browser</span><span style="display: flex; gap: 8px">{btn("?")}</span></div>'
            f'<div style="height: 2px; background: {ORANGE}"></div>'
            f'<nav aria-label="Pane sections" style="display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 2px; padding: 6px 8px; border-bottom: 1px solid #E3E6EA">{"".join(navs)}</nav>'
            f'<div style="padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid #E3E6EA">'
            f'<div style="display: flex; align-items: center; gap: 7px"><span style="width: 8px; height: 8px; border-radius: 50%; background: #1E8E3E"></span>'
            f'<span style="font-weight: 600; font-size: 12px">Claude connected</span><span style="margin-left: auto; {MONO}; font-size: 10.5px; color: {MUTED}">Chat + API · Revit 2025</span></div>'
            f'<div style="padding: 6px 8px; border-radius: 5px; background: {bg}; color: {fg}"><div style="font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{E(doc)}</div>'
            f'<div style="font-size: 11px">{lock}</div></div></div>'
            f'<div style="flex: 1; min-height: 0; overflow: auto">{body}</div>'
            f'<div style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 5px 8px; border-top: 1px solid #E3E6EA; background: #F8F9FA">{"".join(footer)}'
            f'<span style="margin-left: auto; font-size: 11px; color: {MUTED}">{E(foot_note)}</span></div></div>')

def guide_table(rows):
    out = []
    for f, c, feeds, rule in rows:
        out.append(f'<tr><td style="padding: 6px 8px; border-top: 1px solid #E3E6EA; font-weight: 600; vertical-align: top">{E(f)}</td>'
                   f'<td style="padding: 6px 8px; border-top: 1px solid #E3E6EA; color: #3B424D; vertical-align: top">{E(c)}</td>'
                   f'<td style="padding: 6px 8px; border-top: 1px solid #E3E6EA; color: #3B424D; vertical-align: top">{E(feeds)}</td>'
                   f'<td style="padding: 6px 8px; border-top: 1px solid #E3E6EA; {MONO}; font-size: 11.5px; color: #2C6B63; vertical-align: top; white-space: nowrap">{E(rule)}</td></tr>')
    return (f'<table style="width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.4; background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 8px">'
            f'<thead><tr style="text-align: left; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: {MUTED}">'
            f'<th style="padding: 7px 8px; font-weight: 600; width: 24%">Field</th><th style="padding: 7px 8px; font-weight: 600; width: 22%">Control</th>'
            f'<th style="padding: 7px 8px; font-weight: 600">Feeds</th><th style="padding: 7px 8px; font-weight: 600; width: 15%">Rule</th></tr></thead><tbody>{"".join(out)}</tbody></table>')

def board(fname, title, eyebrow, headline, lead, pane_html, guide_rows, extra, h=1240, script=None):
    page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{E(title)}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{{margin:0}}
a{{color:{NAVY}}}a:hover{{color:#2C6B63}}
</style>
</helmet>
<div style="position: relative; width: 1440px; height: {h}px; box-sizing: border-box; padding: 48px 56px 40px; background: #F6F7F9; color: {INK}; font-family: 'IBM Plex Sans', sans-serif; display: flex; gap: 44px">
  <img src="{LOGO}" alt="Formcraft Design &amp; Construction" style="position: absolute; top: 12px; right: 24px; height: 22px; width: auto">
  {pane_html}
  <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 18px; padding-top: 4px">
    <div>
      <div style="{MONO}; font-size: 15px; letter-spacing: 2px; text-transform: uppercase; color: #4A515C">{E(eyebrow)}</div>
      <h2 style="margin: 10px 0 0; font-size: 34px; line-height: 1.1; font-weight: 700; letter-spacing: -1px">{E(headline)}</h2>
      <p style="margin: 10px 0 0; font-size: 15.5px; line-height: 1.5; color: #3B424D">{E(lead)}</p>
    </div>
    {guide_table(guide_rows)}
    {extra}
    <div style="margin-top: auto; {MONO}; font-size: 12px; color: {MUTED}">Planned design. Values are samples. Orange AI tag: calls Claude, arriving in Phase 2.</div>
  </div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":{h}}}}}'>
{script or "class Component extends DCLogic {\nrenderVals() {\nreturn {};\n}\n}"}
</script>
</body>
</html>
'''
    (ROOT / fname).write_text(page, encoding="utf-8")

# ---------- interactive overrides ----------
REG = {"ch": [], "sg": [], "tg": [], "rw": [], "bt": {}, "init": {}, "foot": "", "op": {}, "dl": [], "bc": {}}

def _reset():
    REG.update({"ch": [], "sg": [], "tg": [], "rw": [], "bt": {}, "init": {}, "foot": "", "op": {}, "dl": [], "bc": {}})

def V(key, prop):
    return "{{v." + key + "." + prop + "}}"

def chips(label, items, on=(), hint=None):
    i = nid()
    REG["ch"].append([i, len(items)])
    out = []
    for k, c in enumerate(items):
        key = f"{i}_{k}"
        if c in on:
            REG["init"][key] = True
        out.append(f'<button aria-pressed="{V(key, "p")}" onClick="{V(key, "t")}" style="min-width: 36px; height: 26px; padding: 0 9px; border-radius: 13px; '
                   f'border: 1px solid {V(key, "bd")}; background: {V(key, "bg")}; color: {V(key, "fg")}; '
                   f'font: inherit; font-size: 11.5px; font-weight: 500; cursor: pointer">{E(c)}</button>')
    return field(label, f'<div role="group" aria-label="{E(label) or "Choices"}" style="display: flex; flex-wrap: wrap; gap: 4px">{"".join(out)}</div>', hint)

def seg(label, items, active=0, hint=None):
    i = nid()
    REG["sg"].append([i, len(items)])
    REG["init"][i] = active
    out = []
    for k, c in enumerate(items):
        key = f"{i}_{k}"
        out.append(f'<button aria-pressed="{V(key, "p")}" onClick="{V(key, "t")}" style="flex: 1; min-height: 26px; border: none; border-radius: 4px; '
                   f'background: {V(key, "bg")}; color: {V(key, "fg")}; font: inherit; font-size: 11.5px; font-weight: {V(key, "w")}; cursor: pointer">{E(c)}</button>')
    return field(label, f'<div role="group" aria-label="{E(label) or "Choice"}" style="display: flex; gap: 2px; padding: 2px; background: #EEF0F3; border-radius: 6px">{"".join(out)}</div>', hint)

_static_toggle = toggle
def toggle(label, on, sub=None, locked=False):
    if locked:
        return _static_toggle(label, on, sub, locked)
    i = nid()
    REG["tg"].append(i)
    REG["init"][i] = bool(on)
    s = f'<span style="display: block; font-size: 11px; color: {MUTED}">{E(sub)}</span>' if sub else ""
    return (f'<div style="display: flex; align-items: center; gap: 8px"><span style="flex: 1; min-width: 0"><span style="font-size: 12px; font-weight: 600">{E(label)}</span>{s}</span>'
            f'<button role="switch" aria-checked="{V(i, "p")}" aria-label="{E(label)}" onClick="{V(i, "t")}" style="width: 40px; height: 22px; padding: 0; border-radius: 11px; '
            f'border: none; background: {V(i, "bg")}; position: relative; cursor: pointer"><span style="position: absolute; top: 3px; left: {V(i, "left")}; '
            f'width: 16px; height: 16px; border-radius: 50%; background: #FFFFFF"></span></button>'
            f'<span style="width: 40px; font-size: 11px; color: #4A515C">{V(i, "label")}</span></div>')

def tbl(label, head, rows, widths):
    i = nid()
    REG["rw"].append([i, len(rows)])
    REG["init"][i] = -1
    gc = " ".join(widths)
    h = "".join(f'<span>{E(x)}</span>' for x in head)
    body = []
    for k, r in enumerate(rows):
        key = f"{i}_{k}"
        cells = []
        for x in r:
            if isinstance(x, tuple):
                bg, fg = CHIP[x[1]]
                cells.append(f'<span><span style="font-size: 10.5px; padding: 1px 6px; border-radius: 9px; background: {bg}; color: {fg}; white-space: nowrap">{E(x[0])}</span></span>')
            else:
                cells.append(f'<span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{E(x)}</span>')
        body.append(f'<button onClick="{V(key, "t")}" aria-pressed="{V(key, "p")}" style="width: 100%; text-align: left; font: inherit; color: {INK}; cursor: pointer; '
                    f'display: grid; grid-template-columns: {gc}; gap: 6px; align-items: center; min-height: 28px; padding: 0 6px; border: none; border-top: 1px solid #EEF0F3; '
                    f'font-size: 11.5px; background: {V(key, "bg")}; box-shadow: {V(key, "sh")}">{"".join(cells)}</button>')
    return field(label, f'<div style="border: 1px solid #DDE1E6; border-radius: 4px; overflow: hidden"><div style="display: grid; grid-template-columns: {gc}; gap: 6px; '
                        f'padding: 4px 6px; background: #F1F3F5; font-size: 10.5px; color: {MUTED}; text-transform: uppercase; letter-spacing: 0.5px">{h}</div>{"".join(body)}</div>')

def btn(t, primary=False, ai=False, msg=None, opens=None, closes=None):
    i = nid()
    if msg is None:
        msg = f"{t}: in the plugin this runs here" + (", sends the job to Claude" if ai else "") + (", with a dry run first" if primary else "") + "."
    if opens:
        REG["op"][i] = opens
    elif closes is not None:
        REG["bc"][i] = closes
    else:
        REG["bt"][i] = msg
    if primary:
        st = f"border: 1px solid {NAVY}; background: {NAVY}; color: #FFFFFF; font-weight: 600"
    else:
        st = f"border: 1px solid {LINE}; background: #FFFFFF; color: {INK}"
    tag = f'<span style="margin-left: 4px; font-size: 9.5px; padding: 0 4px; border-radius: 3px; background: {ORANGE}; color: {NAVY}; font-weight: 700">AI</span>' if ai else ""
    return f'<button onClick="{V(i, "t")}" style="min-height: 26px; padding: 1px 9px; font: inherit; font-size: 11.5px; {st}; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center">{E(t)}{tag}</button>'

X_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12 M18 6L6 18" fill="none" stroke="#3B424D" stroke-width="2.2" stroke-linecap="round"></path></svg>'
def dialog(did, title, *parts, primary="OK", done_msg=None, ai=False):
    REG["dl"].append(did)
    pb = btn(primary, True, ai=ai, closes=(done_msg or f"{primary}: done (sample)."))
    return (f'<sc-if value="{{{{v.dl.{did}}}}}" hint-placeholder-val="{{{{false}}}}"><div role="dialog" aria-modal="true" aria-label="{E(title)}" '
            f'style="position: absolute; inset: 0; z-index: 5; background: rgba(27,37,50,0.38); display: flex; align-items: flex-start; justify-content: center; padding: 64px 12px 12px; box-sizing: border-box">'
            f'<div style="width: 100%; max-height: 100%; overflow-y: auto; background: #FFFFFF; border-radius: 8px; box-shadow: 0 16px 40px rgba(26,29,33,0.30); display: flex; flex-direction: column">'
            f'<div style="position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 12px; background: #F1F3F5; font-weight: 600; font-size: 13px">{E(title)}'
            f'<button aria-label="Close" onClick="{{{{v.close.t}}}}" style="margin-left: auto; width: 28px; height: 28px; border: none; background: transparent; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center">{X_ICON}</button></div>'
            f'<div style="height: 2px; background: {ORANGE}"></div>'
            f'<div style="padding: 12px; display: flex; flex-direction: column; gap: 10px">{"".join(parts)}</div>'
            f'<div style="position: sticky; bottom: 0; display: flex; gap: 6px; justify-content: flex-end; padding: 8px 12px; border-top: 1px solid #E3E6EA; background: #F8F9FA">'
            f'<button onClick="{{{{v.close.t}}}}" style="min-height: 26px; padding: 1px 9px; font: inherit; font-size: 11.5px; border: 1px solid {LINE}; background: #FFFFFF; color: {INK}; border-radius: 3px; cursor: pointer">Cancel</button>{pb}</div>'
            f'</div></div></sc-if>')

def admin_btn(on, name="Admin"):
    i = nid()
    if name == "Admin":
        REG["bt"][i] = "You are in Admin." if on else "Admin: only admins see this button. It has its own board on the canvas."
    else:
        REG["bt"][i] = "You are in Settings." if on else "Settings: your own preferences. It has its own board on the canvas."
    col = "#FFFFFF" if on else "#3B424D"
    st = f"background: {NAVY}; color: #FFFFFF; border: 1px solid {NAVY}" if on else f"background: #FFFFFF; color: {INK}; border: 1px solid {LINE}"
    return (f'<button aria-pressed="{"true" if on else "false"}" onClick="{V(i, "t")}" style="min-height: 26px; padding: 1px 8px; font: inherit; font-size: 11.5px; '
            f'{st}; border-radius: 3px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px">{icon(name, col, 14)}{name}</button>')

_static_pane = pane
GROUPS = [("Setup", ["Project", "Templates", "Families", "Materials"]), ("Drawings", ["Sheets", "Annotate", "Issue"]),
          ("Team", ["Review", "Workshare", "Links"]), ("Check", ["QA", "Rules", "Reports", "Scripts"]), ("Engineer", ["Systems"]), ("Build", ["Build"])]
MODTAG = {"Build": "+Build", "Scripts": "+Model", "Systems": "+Model", "Families": "+Model", "Sheets": "+Flow", "Annotate": "+Flow"}
def _navmsg(n, on):
    i = nid()
    REG["bt"][i] = f"You are in {n}." if on else f"{n}: this section has its own board on the canvas."
    return i
def pane(active, doc, doc_kind, body, footer, foot_note, dialogs=""):
    if isinstance(body, (tuple, list)):
        body = "".join(body)
    REG["foot"] = foot_note
    cur = next((g for g, items in GROUPS if active in items), None)
    tabs = []
    for g, items in GROUPS:
        on = g == cur
        i = _navmsg(g, on)
        tabs.append(f'<button aria-pressed="{"true" if on else "false"}" onClick="{V(i, "t")}" style="flex: 1; min-height: 30px; border: none; border-bottom: 2px solid {NAVY if on else "transparent"}; '
                    f'background: transparent; color: {INK if on else "#4A515C"}; font: inherit; font-size: 12px; font-weight: {600 if on else 400}; cursor: pointer">{g}</button>')
    subs = []
    for n in dict(GROUPS)[cur or "Setup"]:
        on = n == active
        col = "#FFFFFF" if on else "#3B424D"
        i = _navmsg(n, on)
        tag = f'<span style="font-size: 9.5px; padding: 0 4px; border-radius: 3px; background: {"#33465C" if on else "#EEF0F3"}; color: {col}">{MODTAG[n]}</span>' if n in MODTAG else ""
        subs.append(f'<button aria-pressed="{"true" if on else "false"}" onClick="{V(i, "t")}" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 30px; padding: 0 6px; '
                    f'border: 1px solid {NAVY if on else LINE}; border-radius: 5px; background: {NAVY if on else "#FFFFFF"}; color: {col}; font: inherit; font-size: 11.5px; font-weight: {600 if on else 400}; cursor: pointer">{icon(n, col, 14)}{E(n)}{tag}</button>')
    qt = "".join(f'<button onClick="{V(_navmsg(t, False), "t")}" style="min-height: 24px; padding: 0 7px; border: 1px solid {LINE}; border-radius: 12px; background: #FFFFFF; font: inherit; font-size: 11px; cursor: pointer">{t}</button>'
                 for t in ("Touch", "Section Box", "Tag Tidy"))
    ci = _navmsg("Connect", active == "Connect")
    con_on = active == "Connect"
    bg, fg = CHIP[doc_kind]
    lock = {"good": "Setup tools open", "warn": "Shared model: Claude in shared models is on", "bad": "Live project: Claude reads and reports"}[doc_kind]
    return (f'<div style="position: relative; width: 440px; flex-shrink: 0; background: #FFFFFF; border: 1px solid {LINE}; border-radius: 8px; box-shadow: 0 12px 32px rgba(26,29,33,0.10); '
            f'display: flex; flex-direction: column; overflow: hidden; font-size: 12.5px">'
            f'<div style="height: 34px; display: flex; align-items: center; gap: 6px; padding: 0 10px; background: #F1F3F5; font-weight: 600; font-size: 13px">'
            f'<span>Formcraft</span>'
            f'<button aria-pressed="{"true" if con_on else "false"}" onClick="{V(ci, "t")}" style="display: inline-flex; align-items: center; gap: 5px; min-height: 24px; padding: 0 8px; border: 1px solid {NAVY if con_on else LINE}; border-radius: 12px; '
            f'background: {NAVY if con_on else "#FFFFFF"}; color: {"#FFFFFF" if con_on else INK}; font: inherit; font-size: 11px; font-weight: 500; cursor: pointer"><span style="width: 7px; height: 7px; border-radius: 50%; background: #1E8E3E"></span>Connected</button>'
            f'<span style="margin-left: auto; display: flex; gap: 6px; align-items: center">{admin_btn(active == "Settings", "Settings")}{admin_btn(active == "Admin")}{btn("?", msg="Help: opens this section of the guide and the first-run tour.")}</span></div>'
            f'<div style="height: 2px; background: {ORANGE}"></div>'
            f'<div style="padding: 6px 10px 0"><label style="display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border: 1px solid {LINE}; border-radius: 5px; color: {MUTED}; font-size: 11.5px">'
            f'<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="#5B6270" stroke-width="2"></circle><path d="M16 16l5 5" stroke="#5B6270" stroke-width="2" stroke-linecap="round"></path></svg>'
            f'<input aria-label="Find a feature" placeholder="Find a feature or rule… (Ctrl+K)" style="flex: 1; min-width: 0; border: none; outline: none; font: inherit; font-size: 11.5px; background: transparent"></label></div>'
            f'<nav aria-label="Feature groups" style="display: flex; padding: 2px 10px 0; border-bottom: 1px solid #E3E6EA">{"".join(tabs)}</nav>'
            f'<nav aria-label="Sections" style="display: flex; gap: 4px; padding: 6px 10px">{"".join(subs)}</nav>'
            f'<div style="display: flex; align-items: center; gap: 4px; padding: 0 10px 6px; font-size: 10.5px; color: {MUTED}"><span>Quick tools</span>{qt}<span style="margin-left: auto; font-size: 9.5px; padding: 0 4px; border-radius: 3px; background: #FFF4E0; color: #6B4100">Flow</span></div>'
            f'<div style="padding: 6px 10px 8px; border-top: 1px solid #E3E6EA; border-bottom: 1px solid #E3E6EA">'
            f'<div style="padding: 6px 8px; border-radius: 5px; background: {bg}; color: {fg}"><div style="font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{E(doc)}</div>'
            f'<div style="font-size: 11px">{lock}</div></div></div>'
            f'<div style="flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain">{body}</div>'
            f'<div style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 5px 8px; border-top: 1px solid #E3E6EA; background: #F8F9FA">{"".join(footer)}'
            f'<span role="status" style="margin-left: auto; font-size: 11px; color: {MUTED}; max-width: 100%">{{{{v.foot}}}}</span></div>{dialogs}</div>')

def take_script(extra_ctor="", extra_method="return {};"):
    js = ("class Component extends DCLogic {\n"
          "constructor(props) {\nsuper(props);\n"
          "this.state = { s: " + json.dumps(REG["init"]) + ", msg: '', dlg: ''" + ((", " + extra_ctor) if extra_ctor else "") + " };\n}\n"
          "extraVals() {\n" + extra_method + "\n}\n"
          "renderVals() {\n"
          "const CH = " + json.dumps(REG["ch"]) + ", SG = " + json.dumps(REG["sg"]) + ", TG = " + json.dumps(REG["tg"]) + ", RW = " + json.dumps(REG["rw"]) + ";\n"
          "const BT = " + json.dumps(REG["bt"], ensure_ascii=False) + ", FOOT = " + json.dumps(REG["foot"], ensure_ascii=False) + ";\n"
          "const s = this.state.s, NAVY = '#1B2532';\n"
          "const set = (k, val) => this.setState({ s: Object.assign({}, this.state.s, { [k]: val }) });\n"
          "const v = {};\n"
          "CH.forEach((c) => { for (let k = 0; k < c[1]; k++) { const key = c[0] + '_' + k, on = !!s[key]; v[key] = { p: on ? 'true' : 'false', bg: on ? NAVY : '#FFFFFF', fg: on ? '#FFFFFF' : '#3B424D', bd: on ? NAVY : '#C9CED6', t: () => set(key, !on) }; } });\n"
          "SG.forEach((g) => { const cur = s[g[0]]; for (let k = 0; k < g[1]; k++) { const on = k === cur; v[g[0] + '_' + k] = { p: on ? 'true' : 'false', bg: on ? '#FFFFFF' : 'transparent', fg: on ? '#1A1D21' : '#4A515C', w: on ? '600' : '400', t: () => set(g[0], k) }; } });\n"
          "TG.forEach((id) => { const on = !!s[id]; v[id] = { p: on ? 'true' : 'false', bg: on ? NAVY : '#6B7280', left: on ? '21px' : '3px', label: on ? 'On' : 'Off', t: () => set(id, !on) }; });\n"
          "RW.forEach((r) => { const cur = s[r[0]]; for (let k = 0; k < r[1]; k++) { const on = k === cur; v[r[0] + '_' + k] = { p: on ? 'true' : 'false', bg: on ? '#E8EDF3' : 'transparent', sh: on ? 'inset 3px 0 0 ' + NAVY : 'none', t: () => set(r[0], on ? -1 : k) }; } });\n"
          "Object.keys(BT).forEach((id) => { v[id] = { t: () => this.setState({ msg: BT[id] }) }; });\n"
          "const OP = " + json.dumps(REG["op"]) + ", BC = " + json.dumps(REG["bc"], ensure_ascii=False) + ", DL = " + json.dumps(REG["dl"]) + ";\n"
          "Object.keys(OP).forEach((id) => { v[id] = { t: () => this.setState({ dlg: OP[id], msg: '' }) }; });\n"
          "Object.keys(BC).forEach((id) => { v[id] = { t: () => this.setState({ dlg: '', msg: BC[id] }) }; });\n"
          "v.dl = {}; DL.forEach((d) => { v.dl[d] = this.state.dlg === d; });\n"
          "v.close = { t: () => this.setState({ dlg: '' }) };\n"
          "v.foot = this.state.msg || FOOT;\n"
          "return Object.assign({ v: v }, this.extraVals());\n}\n}")
    _reset()
    return js

def board(fname, title, eyebrow, headline, lead, pane_html, guide_rows, extra, h=1240, script=None):
    if isinstance(script, tuple):
        js = take_script(*script)
    else:
        js = take_script()
    page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{E(title)}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{{margin:0}}
a{{color:{NAVY}}}a:hover{{color:#2C6B63}}
</style>
</helmet>
<div style="position: relative; width: 1440px; height: {h}px; box-sizing: border-box; padding: 48px 56px 40px; background: #F6F7F9; color: {INK}; font-family: 'IBM Plex Sans', sans-serif; display: flex; gap: 44px">
  <img src="{LOGO}" alt="Formcraft Design &amp; Construction" style="position: absolute; top: 12px; right: 24px; height: 22px; width: auto">
  {pane_html}
  <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 18px; padding-top: 4px">
    <div>
      <div style="{MONO}; font-size: 15px; letter-spacing: 2px; text-transform: uppercase; color: #4A515C">{E(eyebrow)}</div>
      <h2 style="margin: 10px 0 0; font-size: 34px; line-height: 1.1; font-weight: 700; letter-spacing: -1px">{E(headline)}</h2>
      <p style="margin: 10px 0 0; font-size: 15.5px; line-height: 1.5; color: #3B424D">{E(lead)}</p>
    </div>
    {guide_table(guide_rows)}
    {extra}
    <div style="margin-top: auto; {MONO}; font-size: 12px; color: {MUTED}">Clickable mockup: pick rows, chips, toggles and tabs; scroll inside the pane. Values are samples. Orange AI tag: calls Claude, arriving in Phase 2.</div>
  </div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":{h}}}}}'>
{js}
</script>
</body>
</html>
'''
    (ROOT / fname).write_text(page, encoding="utf-8")

def callout(title, text):
    return (f'<div style="border-top: 3px solid {ORANGE}; padding-top: 8px"><div style="font-size: 16px; font-weight: 600">{E(title)}</div>'
            f'<div style="margin-top: 3px; font-size: 14px; line-height: 1.5; color: #3B424D">{E(text)}</div></div>')

WIP = "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt · 01_WIP"
G, W, B, GR, I = "good", "warn", "bad", "grey", "info"

# ======================= CONNECT =======================
body = (group("Start-up health check",
              checks("", [("Revit 2025.4, same update as the team", True, "OK", G), ("FMC Kit v2.2 found", True, "OK", G),
                          ("Rulebooks loaded, schema v1", True, "344 rules", G), ("Team file read", True, "You: Admin", I),
                          ("Licence", True, "Beta · free", I), ("AI service", True, "Not used yet", GR)]),
              note("Offline mode: every feature works without internet. Only the AI buttons (Phase 2) need it.", I)),
        group("Kit and rules",
              inp("FMC Kit folder", "Z:\\00_Standards", mono=True, browse="Browse…"),
              sel("Client Kit", ["Formcraft (internal)", "[CLIENT A] Developments", "[CLIENT B] Health"], 0),
              '<div>' + btn("New client…", opens="d_client") + '</div>',
              ro("Rulebooks", "v0.2 · 11 books · severity, scope, test and fix hint on every rule", mono=False),
              ro("Kit version", "FMC_Kit_v2.2 · 178 parameters · 196 codes")),
        group("Folders the plugin may write",
              ta("Write roots", "Z:\\Projects\\*\\01_WIP\nZ:\\00_Standards\\04_Families\\_Staging\nZ:\\00_Standards\\06_Templates\\_Staging", rows=3, mono=True),
              ta("Never written", "02_Shared · 03_Published · 04_Archive · 05_Incoming", rows=1, mono=True),
              inp("Reports folder", "<project>\\06_QA", mono=True, browse="Browse…")),
        group("Chat through MCP · experimental",
              toggle("MCP service", False, "Port 8080 · for the BIM manager while developing"),
              ro("Tools offered", "Search rules · run QA · project info (read-only first)", mono=False),
              note("No feature needs chat. Every chat request passes the same checks as a pane button.", GR)),
        group("AI buttons · Phase 2",
              inp("API key", "", "Paste key: sk-ant-…", pwd=True, hint="Kept in Windows Credential Manager, never in logs or the kit."),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + inp("Monthly cap (USD)", "25", num=True) + inp("Tokens per call", "20000", num=True) + '</div>',
              note("Arrives after 1.0, so the engine proves itself first.", W)),
        group("Safety",
              toggle("Claude in shared models", False, "Setup tools on workshared models (D1)"),
              toggle("Live-model lock", True, "Claude's model tools never run on live projects", locked=True),
              toggle("Dry run first", True, "Every change shows its plan first", locked=True),
              toggle("Claude never saves, syncs or moves coordinates", True, "Fixed principle", locked=True)),
        group("Support",
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Export diagnostics (zip)", msg="Diagnostics: logs and settings zipped to 06_QA\\Support. You see the file list first; no model content.") + btn("Send feedback", opens="d_fb") + '</div>',
              note("The zip and feedback never hold model content. You see exactly what is sent.", I)),
        author("Rules for every job, e.g. 'Use UK English. Never rename a client's existing families.'"))
dl = (dialog("d_test", "Health check",
              checks("", [("Revit 2025.4", True, "OK", G), ("FMC Kit folder", True, "v2.2", G), ("Rulebooks schema v1", True, "OK", G),
                          ("fmc_guard.json", True, "Found", G), ("Write roots reachable", True, "3 of 3", G), ("Rules marked proposed", True, "25", W)]),
              note("Everything the plugin needs is reachable.", G), primary="Done", done_msg="Health check passed."),
      dialog("d_client", "New Client Kit",
              inp("Client name", "", "[CLIENT NAME]"), inp("Short code", "", "e.g. ACM", mono=True, hint="2–6 letters, used in Client Kit names."),
              drop("Client logo", "Drop SVG or PDF", "Goes into the title block lockup slot"),
              chips("Disciplines they deliver", ["A", "I", "S", "M", "E", "P", "FP", "LP", "C", "L"], {"A", "S"}),
              primary="Create Client Kit", done_msg="Client Kit created (sample)."),
      dialog("d_fb", "Send feedback",
              seg("Kind", ["This was hard", "This was great", "Idea"], 0),
              sel("Where", ["Connect", "Project", "Templates", "Families", "Sheets", "Annotate", "Review", "Workshare", "QA", "Issue"], 0),
              ta("What happened", "", "One line is enough", rows=2),
              checks("Attach (you choose)", [("Screenshot of the pane", False), ("Last 20 log lines", True), ("Revit and plugin version", True)]),
              note("Preview: plugin 0.3.1 · Revit 2025.4 · 20 log lines, file paths removed. No model content.", I),
              primary="Send", done_msg="Thanks. You'll be told when it is planned, released or declined."))
connect = pane("Connect", WIP, G, body, [btn("Save", True), btn("Health check", opens="d_test"), btn("Feedback", opens="d_fb")], "Healthy · offline mode ready", dialogs="".join(dl))
board("PaneConnect.dc.html", "Connect pane", "Pane · Connect", "Health, kit, folders and safety in one place, working offline",
      "The plugin checks itself at start-up and says plainly what is wrong. Everything works offline; chat through MCP is experimental and the AI buttons arrive in Phase 2.",
      connect,
      [("Health check", "Checklist at start-up", "Revit update, kit, rulebook schema, team file, licence", "Roadmap 0.1"),
       ("Offline mode", "Note", "All deterministic features work without internet", "Roadmap 0.1"),
       ("FMC Kit folder, Client Kit", "Path, dropdown", "Every tool reads the kit from here", "MAN 7.4"),
       ("Write roots", "Path list", "The only folders files may be written to", "CLM 2"),
       ("Chat through MCP", "Switch, off", "Experimental; read-only tools first", "Roadmap: MCP"),
       ("AI buttons", "Key, caps", "Phase 2; key in Windows Credential Manager", "ClaudeUse"),
       ("Safety", "Switches, some locked", "D1 toggle; locks shown so users know they always apply", "D1, CLM 1, 6"),
       ("Diagnostics, feedback", "Buttons", "Zip of logs and settings; one-line feedback with preview", "Roadmap 0.1")],
      callout("Every request takes the same road", "Pane buttons, chat requests and AI replies all go through one control layer: permission, rule, preview, log, then a check of what really happened."))

# ======================= PROJECT =======================
body = (group("Where",
              inp("Project folder", "D:\\Projects\\F26001_Pilot", mono=True, browse="Browse…", hint="You create the folder; the tree is built inside it (D5)."),
              checks("Folder check", [("Folder exists and is empty", True, "OK", G), ("You can write here", True, "OK", G)]),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + inp("Project code", "F26001", mono=True) + inp("Short name", "Pilot") + '</div>',
              note("F26001 passes the naming check (2–6 characters, A–Z and 0–9).", G)),
        group("Project details · written to Project Information",
              toggle("Fill from the approved concept (CIS)", True, "Formcraft Model: Start from brief. Blanks stay blank"),
              inp("Project name", "[PROJECT NAME]"),
              inp("Appointing party (client)", "[CLIENT A] Developments"),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + inp("Plot no.", "[PLOT]", mono=True) + inp("Block no.", "[BLOCK]", mono=True) + '</div>',
              '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px">' + inp("Village / parish", "[VILLAGE]") + inp("Division / sub-county", "[DIVISION]") + inp("District", "Kampala") + '</div>',
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + inp("Site area (m²)", "[AREA]", mono=True) + sel("Building class", ["Residential", "Commercial", "Institutional", "Industrial"], 0) + '</div>',
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + inp("Lead consultant", "Formcraft Design & Construction") + inp("Lead architect", "[NAME, REG. NO.]") + '</div>',
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + inp("Structural engineer", "[NAME, REG. NO.]") + inp("MEP engineer", "[NAME, REG. NO.]") + '</div>',
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Coordinate system", ["Arc 1960 / UTM 36N (EPSG:21096)", "Arc 1960 / UTM 35N", "WGS 84 / UTM 36N"], 0) + inp("FFL ±0.000 (m above MSL)", "[LEVEL]", mono=True) + '</div>',
              note("Each field is a kit shared parameter (FMC_Project_Name, FMC_Plot_No, FMC_District, FMC_Site_Area_m2, FMC_CRS…). Title blocks read them, so they are typed once here.", I)),
        group("Naming convention · from the kit",
              ro("Models", "[Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt", mono=True),
              ro("Live example", "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", mono=True),
              ro("Project families", "F26001_[Role]_[CategoryToken]_[Description].rfa · in 01_WIP\\<Role>\\Families (D4)", mono=True),
              ro("Sheets", "[Role]-[Series][Number], e.g. A-1001 · from the sheet register", mono=True),
              ro("Views, filters, materials", "Manual 4.6 patterns · materials FMC_[Group]_[Description]", mono=False),
              tbl("Codes this project uses", ["Code", "Value", "Meaning"], [["Originator", "FMC", "Formcraft"], ["Volume", "ZZ", "Whole building"], ["Level", "ZZ", "All levels"], ["Type", "M3", "3D model"]], ["80px", "60px", "1fr"]),
              note("The patterns are fixed by the kit; the project only picks its codes. The server rejects any other name.", W)),
        group("Who and what",
              sel("Client", ["[CLIENT A] Developments", "Formcraft (internal)", "+ New client…"], 0),
              inp("Site address", "", "[SITE ADDRESS]"),
              chips("Discipline models (roles)", ["A", "I", "S", "M", "E", "P", "FP", "LP", "C", "L", "W", "Z"], {"A", "S", "M", "E", "P", "Z"}),
              '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px">' + inp("Originator", "FMC", mono=True) + inp("Volume", "ZZ", mono=True) + inp("Level", "ZZ", mono=True) + '</div>'),
        group("Stage and issue",
              sel("Model development stage", ["G3 Detailed / permit", "G1 Concept", "G2 Scheme", "G4 Construction", "G5 As-built"], 0),
              sel("Next gate", ["Gate 2 · delivery milestone", "Gate 1 · mobilisation", "Gate 3 · close-out"], 0),
              sel("Issue set", ["PERMIT", "TENDER", "CONSTRUCTION", "RECORD"], 0),
              sel("Client's stage label (optional)", ["None", "RIBA 4 · Technical design", "AIA · Construction documents", "Local · building permit"], 1),
              note("Gates and issue sets drive the plugin. RIBA, AIA or local stages are labels mapped onto them.", I)),
        group("Project manifest",
              ro("Standard", "FMC-BIM v2.2 · rulebooks v0.2", mono=False),
              ro("Template", "FMC_A_Template 2.2.3 · Revit 2025", mono=False),
              note("Stamped into Project Information and a manifest file, so every later check knows which rules applied.", I)),
        group("Extras",
              drop("Project family set", "Drop a size table (CSV)", "One recipe + sizes = families named F26001_… (D4)")),
        author("e.g. 'Client wants room names in English and Luganda. Keep the permit set to A1 only.'"))
dl = (dialog("d_pplan", "Preview: what will be made",
              ro("Folders", "00_Info · 01_WIP · 02_Shared · 03_Published · 04_Archive · 05_Incoming · 06_QA · 07_Cost", mono=False),
              tbl("Models", ["Model", "Template"], [["F26001-FMC-ZZ-ZZ-M3-A-0001", "A"], ["F26001-FMC-ZZ-ZZ-M3-S-0001", "S"], ["F26001-FMC-ZZ-ZZ-M3-M-0001", "M"],
                  ["F26001-FMC-ZZ-ZZ-M3-E-0001", "E"], ["F26001-FMC-ZZ-ZZ-M3-P-0001", "P"], ["F26001-FMC-SW-XX-M3-Z-0001", "Z"]], ["1fr", "60px"]),
              ro("Sheets", "61 from the register for PERMIT · counted, not guessed", mono=False),
              note("Nothing exists yet. Start runs a dry run first.", I), primary="Start (dry run)", done_msg="Dry run complete: nothing made yet. Press Start to build."),
      dialog("d_start", "Starting F26001",
              checks("Steps", [("Folder tree", True, "Done", G), ("Discipline models", True, "3 of 6", W), ("Project information and manifest", False, "Waiting", GR),
                               ("Link models", False, "Waiting", GR), ("Project families", False, "Waiting", GR), ("First QA run", False, "Waiting", GR)]),
              toggle("Stop after the current step", False),
              note("Each step is checked after it runs; the report says what really happened.", I),
              primary="Continue", done_msg="Project start continuing (sample)."),
      dialog("d_undo", "Undo project start",
              tbl("Made by Formcraft", ["Item", "Changed since?"], [["Folder tree", ("No", G)], ["A model", ("No", G)], ["S model", ("Opened by [NAME F]", W)]], ["1fr", "110px"]),
              note("Only items nobody has changed are removed. The S model stays because someone opened it.", W),
              primary="Remove untouched items", done_msg="Untouched items moved to _Archive; the S model kept."))
proj = pane("Project", "No project open · new project", G, body, [btn("Preview", opens="d_pplan"), btn("Start (dry run)", True, opens="d_start"), btn("Undo start", opens="d_undo")], "6 models · 61 sheets", dialogs="".join(dl))
board("PaneProject.dc.html", "Project pane", "Pane · Project", "Start a project the Formcraft way, see it first, undo it while untouched",
      "Fill one form. The plugin checks the folder, shows the full tree, models and sheet count, builds after a dry run, and stamps the standard's version into the project.",
      proj,
      [("Project folder, folder check", "Path, checks", "Folder exists, is empty and writable", "D5, review"),
       ("Project code", "Text, checked live", "Every file and container name", "MAN 4.1"),
       ("Project details", "Fields, CIS switch", "Project Information: plot, district, site area, consultants, CRS, FFL", "Kit parameters"),
       ("Naming convention", "Read-only, codes table", "Model, family, sheet, view and material patterns from the kit", "MAN 4.6, D4"),
       ("Roles", "Chips", "One model per role from its template", "MAN 4.3"),
       ("Stage, gate, issue set", "Dropdowns", "Drive sheets, QA and readiness", "MAN 3.2, STD 2.4"),
       ("Client's stage label", "Dropdown", "RIBA, AIA or local label only", "Decision 1"),
       ("Project manifest", "Read-only", "Standard and template version stamped in", "Roadmap 0.2"),
       ("Preview", "Dialog", "Folders, models, sheet count before anything exists", "Roadmap 0.2"),
       ("Undo start", "Dialog", "Removes only items nobody has changed", "Review")],
      callout("Undo is honest", "Undoing a start is not one Revit undo: files exist and people may have opened them. The plugin removes only what it made and nobody changed, and says what it kept."))

# ======================= TEMPLATES =======================
SW = lambda c, n: (f'<div style="display: flex; flex-direction: column; align-items: center; gap: 3px; width: 64px"><span style="width: 40px; height: 26px; border-radius: 4px; background: {c}; border: 1px solid #C9CED6"></span>'
                   f'<span style="font-size: 10.5px; text-align: center; line-height: 1.2">{n}</span></div>')
body = (group("New file from a template",
              seg("Make a", ["Project model", "Family", "Detail file", "Title block"], 0),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Client Kit", ["[CLIENT A] Developments", "Formcraft (internal)"], 0) + sel("Role", ["A", "S", "M", "E", "P", "Z"], 0) + '</div>',
              sel("Template", ["FMC_A_Template 2.2.3 · Revit 2025 · released", "FMC_A_Template_Starter 2.2.3 · Revit 2025", "FMC_A_Template 2.2.2 · old"], 0),
              ro("File name (from the naming rule)", "F26001-FMC-ZZ-ZZ-M3-A-0002.rvt"),
              inp("Save in", "D:\\Projects\\F26001_Pilot\\01_WIP\\A", mono=True, browse="Browse…"),
              checks("", [("Stamp the manifest (standard and template version)", True), ("Fill Project Information from the project", True), ("Open it when made", True)])),
        group("Firm look · brand pack",
              sel("Brand pack", ["Formcraft (internal)", "[CLIENT A] brand pack", "+ New brand pack…"], 0),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Main font", ["Arial (standard)", "Firm font: [FONT NAME]"], 0) + sel("Title font", ["Arial Bold", "Firm font: [FONT NAME] Bold"], 0) + '</div>',
              '<div style="display: flex; flex-wrap: wrap; gap: 6px">' + SW("#FFAE61", "Formcraft Orange") + SW("#1B2532", "Navy") + SW("#7FC7BE", "Studio Green") + SW("#D15334", "Signal") + SW("#94989B", "Grey") + '</div>',
              chips("Apply to", ["Text types", "Dimension styles", "Tag families", "Title block", "Filter colours", "Fill patterns", "Line styles", "Schedules"], {"Text types", "Dimension styles", "Title block", "Filter colours"}),
              sel("Logo lockup", ["Formcraft Design & Construction (main)", "Formcraft Studio", "Formcraft Construction (role W)", "Client logo"], 0),
              note("Sizes stay at the standard (2.5 / 3.5 / 5 mm); only font and colour change. A sample sheet shows the result first.", I)),
        group("Audit a template",
              inp("Template", "Z:\\00_Standards\\06_Templates\\FMC_A_Template_v2.2.rte", mono=True, browse="Browse…"),
              checks("What the audit covers", [("Shared parameters vs FMC_SharedParameters.txt", True, "2 differ", W), ("View templates and filters", True, "Pass", G),
                                               ("Fonts and colours vs the brand pack", True, "1 off-brand", W), ("Text and dimension styles", True, "1 extra", W),
                                               ("Title blocks and schedules", True, "Pass", G), ("Browser organisation", True, "Pass", G), ("Size, unused families, warnings", True, "38 MB · 12 unused", W)]),
              seg("Show", ["Must", "Should", "Advice"], 0)),
        group("Build",
              checks("Revit versions", [("Revit 2025", True, "pilot", I), ("Revit 2026", False, "Phase 2", GR), ("Revit 2027", False, "Phase 2", GR)]),
              seg("Size", ["Full", "Starter (1–5 people)"], 0),
              chips("Role templates", ["Base", "A", "I", "S", "M", "E", "P", "FP", "LP", "C", "L", "Z", "W"], {"Base", "A", "S", "M", "E", "P", "Z"}),
              chips("Project types", ["House", "School", "Office", "Clinic", "Warehouse"], {"House", "Office"}, hint="Each type adds its own sheets, schedules and room lists."),
              ro("Built in Phase 1", "Parameters, keynotes, filters, view templates, schedules, sheets, browser", mono=False),
              note("Revit pop-up dialogs during a batch are answered by the builder and listed in the report.", GR)),
        group("Template library",
              tbl("", ["Template", "Version", "Status"],
                  [["FMC_A_Template", "2.2.3", ("Released", G)], ["FMC_S_Template", "2.2.3", ("Released", G)], ["FMC_M_Template", "2.2.4", ("Staging", W)],
                   ["[CLIENT A]_A_Template", "1.0.1", ("Released", G)]], ["1fr", "56px", "76px"]),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Compare two versions", opens="d_diff") + btn("Publish to library", opens="d_pub") + '</div>',
              note("Publishing from staging to 06_Templates is a people gate: the BIM Manager approves.", GR)),
        group("Keep projects in step · Phase 2",
              tbl("Projects on an older template", ["Project", "Started on", "Behind by"], [["F25014", "2.2.1", "6 changes"], ["F26001", "2.2.3", "Up to date"]], ["1fr", "70px", "80px"]),
              '<div>' + btn("Preview update for F25014", opens="d_push") + '</div>',
              note("Pushes view templates, styles and filters to live projects; never geometry. Preview first, then the project's Lead approves.", W)),
        group("Saved settings for new projects",
              ro("Units", "mm · m² (2 dp) · m³ (3 dp) · ° (2 dp)", hint="Fixed by the Manual."),
              sel("Title block", ["FMC_TitleBlock · A1", "FMC_TitleBlock · A3 site set"], 0),
              sel("Starting views", ["Standard set by role", "Minimal (plans and 3D)"], 0),
              ro("Output folder", "Z:\\00_Standards\\06_Templates\\_Staging", hint="Builds land in staging.")),
        author("e.g. 'This client prints everything A3 and uses their own font; keep Formcraft Orange off their sheets.'"))
dl = (dialog("d_new", "New file from template",
              ro("Template", "FMC_A_Template 2.2.3 · Revit 2025", mono=False),
              ro("New file", "01_WIP\\A\\F26001-FMC-ZZ-ZZ-M3-A-0002.rvt"),
              checks("Will also", [("Stamp the manifest", True), ("Fill Project Information", True), ("Add to the team file as an A model", True)]),
              note("Made in a dry run first; nothing is overwritten.", I), primary="Create", done_msg="F26001-FMC-ZZ-ZZ-M3-A-0002.rvt made from FMC_A_Template 2.2.3 (sample)."),
      dialog("d_brand", "Apply the brand pack: preview",
              tbl("", ["Item", "Now", "After"], [["Text: FMC_Arial_2.5", "Arial", "[FONT NAME]"], ["Filter: Fire rated walls", "Red", "Signal #D15334"],
                  ["Title block band", "Grey", "Formcraft Orange"], ["Dimension text", "Arial 2.5", "[FONT NAME] 2.5"]], ["1fr", "70px", "100px"]),
              note("A sample A1 sheet is made in staging so you can see it before applying.", I),
              primary="Apply (dry run)", done_msg="Dry run: 14 styles and 9 filters would change."),
      dialog("d_audit", "Audit: FMC_A_Template_v2.2",
              tbl("", ["Item", "Severity", "Rule"], [["FMC_Asset_Tag GUID differs from the kit", ("Must", B), "SPR-004"], ["Text type 'Arial 3mm' not in the standard", ("Should", W), "ANN-003"],
                  ["12 unused families (purge suggested)", ("Advice", GR), "—"]], ["1fr", "64px", "60px"]),
              note("An audit changes nothing.", I), primary="Save report", done_msg="Audit report saved to 06_QA."),
      dialog("d_tplan", "Build plan",
              tbl("", ["Template", "Version", "Steps", "Notes"], [["Base", "2025", "8", ("OK", G)], ["A", "2025", "8", ("OK", G)], ["A Starter", "2025", "6", ("OK", G)],
                  ["M", "2025", "8", ("1 warning", W)], ["E", "2025", "8", ("No demand factors", W)]], ["70px", "56px", "44px", "1fr"]),
              note("After building, each template is reopened and audited again.", I),
              primary="Build (dry run)", done_msg="Dry run done: 5 templates would be built in _Staging."),
      dialog("d_diff", "Compare template versions",
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("From", ["2.2.2", "2.2.1"], 0) + sel("To", ["2.2.3", "2.2.2"], 0) + '</div>',
              tbl("", ["Change", "Area"], [["+ FMC_Socket_Circuit_Ref", "Parameters"], ["VT_A_FP_General: hatch off", "View templates"], ["− Arial 3mm text", "Styles"]], ["1fr", "100px"]),
              primary="Save difference report", done_msg="Difference report saved."),
      dialog("d_pub", "Publish to the library",
              ro("Template", "FMC_M_Template 2.2.4 · staging", mono=False),
              checks("Before publishing", [("Audit passes (no Must items)", True, "OK", G), ("Test project built from it", True, "OK", G), ("Difference report written", True, "OK", G)]),
              sel("Approved by", ["BIM Manager", "Head of Modelling"], 0),
              primary="Publish", done_msg="Published to 06_Templates; old version kept in _Archive."),
      dialog("d_push", "Update F25014 to template 2.2.3",
              tbl("", ["Change", "Type"], [["VT_A_FP_General: hatch off", "View template"], ["FMC_Arial_2.5 colour", "Text style"], ["Fire rated walls", "Filter"]], ["1fr", "100px"]),
              sel("Approved by", ["[NAME A] · Lead A"], 0),
              note("Live project: the Lead approves; nothing in the model geometry changes.", W),
              primary="Update (dry run)", done_msg="Dry run: 6 standards would be transferred to F25014."))
tpl = pane("Templates", "FMC_A_Template_v2.2.rte · _Staging", G, body,
           [btn("New file", True, opens="d_new"), btn("Apply look", opens="d_brand"), btn("Audit", opens="d_audit"), btn("Build (dry run)", opens="d_tplan")], "Library: 4 templates", dialogs="".join(dl))
board("PaneTemplates.dc.html", "Templates pane", "Pane · Templates", "Make files from templates, give them the firm's look, and keep every project in step",
      "Everything to do with templates in one place: new files from released templates, the firm's fonts and colours, audits, builds for each Revit version and project type, a library with a publish gate, and updates pushed to older projects.",
      tpl,
      [("New file from a template", "Type, template, name", "Project, family, detail or title block file, named by the rule and stamped", "MAN 4.1, Roadmap 0.2"),
       ("Brand pack", "Fonts, colour swatches, apply-to chips", "The firm's fonts and colours on text, dimensions, tags, title block and filters", "STD 3.3, MAN 9.14"),
       ("Logo lockup", "Dropdown", "Main, Studio, Construction or client logo", "STD 3.3"),
       ("Audit", "Path + checklist", "Declared coverage, brand check, size and unused families", "Roadmap 0.6"),
       ("Build", "Versions, size, roles, project types", "Starter or full; house, school, office…", "Roadmap 0.6"),
       ("Template library", "Table + publish", "Released and staging versions; BIM Manager publishes", "People gate"),
       ("Keep projects in step", "Phase 2", "Push styles, filters and view templates to older projects after a preview", "Review"),
       ("Saved settings", "Fixed + dropdowns", "Units, title block, starting views for new projects", "MAN 9.10")],
      callout("Fonts and colours, not sizes", "The brand pack changes font and colour only. Text heights stay at the standard, so a client's look never breaks Formcraft's readability rules.")
      + callout("Suggested next", "Template health score on the library, a 'what's new in this version' note shown when someone makes a file, and a per-client starter pack of common details."))

# ======================= SETTINGS =======================
MT = lambda t, k="grey": f'<span style="font-size: 9.5px; padding: 0 5px; border-radius: 3px; background: {CHIP[k][0]}; color: {CHIP[k][1]}; margin-left: 6px">{t}</span>'
body = (group("Settings sections",
              seg("Show", ["General", "Manage", "Flow", "Model", "Build"], 0, hint="One Settings for every module. General is Core's; a module's tab appears when it is licensed."),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + "".join(f'<span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; background: {CHIP[k][0]}; color: {CHIP[k][1]}">{t}</span>'
                  for t, k in [("Core · always", "info"), ("Manage · licensed", "good"), ("Flow · licensed", "good"), ("Model · not yet", "grey"), ("Build · licensed", "good")]) + '</div>'),
        group("General · you",
              ro("Name and role", "[NAME A] · Admin · disciplines Z, A", mono=False),
              ro("Revit user name", "j.okello · matches the team file")),
        group("General · pane",
              seg("Theme", ["Follow Revit", "Light", "Dark"], 0),
              seg("Text size", ["Normal", "Large"], 0),
              sel("Open on", ["Home: start-of-day card", "The last section I used", "QA"], 0),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + ro("Narrowest", "320 px") + ro("Widest", "560 px") + '</div>',
              note("Below 400 px the pane switches to its compact layout; above 560 px the content stops growing so lines stay readable.", GR),
              toggle("Show the first-run tour again", False),
              note("Which parts of each module show in the pane is set in that module's tab, or with its parts switch on the ribbon.", GR)),
        group("General · start-of-day card and notifications",
              toggle("Show the card when I open a model", True),
              checks("Tell me when", [("A review item is assigned to me", True), ("An item I raised is solved", True), ("A scheduled sync is coming (60 s)", True), ("My feedback ships", True)]),
              seg("How", ["In the pane", "Pane and email"], 0)),
        group("General · defaults, privacy, updates",
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Units shown", ["mm, m², m³", "m, m², m³"], 0) + sel("Language", ["English (UK)", "English (US)"], 0) + '</div>',
              toggle("Share anonymous usage counts", False, "Never model content or names"),
              seg("Update channel", ["Stable", "Beta (testers)"], 1),
              ro("Version", "Formcraft 0.3.1 · Core + Manage + Flow + Build · rulebooks v0.2")),
        group("Module tabs",
              checks("", [("Manage · licensed", True, "Settings › Manage", G), ("Flow · licensed", True, "Settings › Flow", G), ("Model · not yet", False, "Appears when licensed", GR), ("Build · licensed", True, "Settings › Build", G)]),
              note("Each module keeps its settings in its own tab, with its parts switch and its two ribbon buttons. General holds what Core gives every module.", I)),
        author("Your own note on your start-of-day card, e.g. 'Friday: issue day, sync before 16:00.'"))
dl = (dialog("d_keys", "Apply Formcraft Shortcuts v1.0",
              checks("Steps", [("Back up your current shortcuts", True, "KeyboardShortcuts_backup.xml", I), ("Merge your extras on top", True, "2 kept", G), ("Open Revit's import dialog with the file ready", True)]),
              note("Revit applies shortcuts through its own Keyboard Shortcuts import, so you confirm the last click there.", I),
              primary="Apply", done_msg="Shortcuts ready to import; backup saved (sample)."),
      dialog("d_reset", "Reset my settings",
              note("Puts your General, Manage and Flow settings back to the defaults. Admin and project settings are not touched.", W),
              primary="Reset", done_msg="Your settings are back to the defaults."),)
st = pane("Settings", WIP, G, body, [btn("Save", True), btn("Reset mine", opens="d_reset")], "Saved 10:42", dialogs="".join(dl))
board("PaneSettings.dc.html", "Settings pane", "Pane · Settings (one for every module)",
      "General: what Core gives every module",
      "Opened from Settings in the pane header. General belongs to Core; Manage, Flow, Model and Build each have their own tab with their parts switch, ribbon buttons and settings. Buying Flow first or Manage first, people find settings in the same place.",
      st,
      [("Sections", "Tabs + licence chips", "General (Core), Manage, Flow, Model, Build; a tab appears when licensed", "Architecture"),
       ("You", "Read-only", "Name, role, Revit user name", "Admin"),
       ("Pane", "Tabs, dropdown", "Theme, text size, open on; 320 to 560 px wide", "UI rule"),
       ("Card and notifications", "Switch, checks", "Start-of-day card and what you are told", "UX"),
       ("Defaults, privacy, updates", "Dropdowns, switches", "Units, language, usage counts, update channel", "Core"),
       ("Module tabs", "Status", "Each module's own tab: parts, ribbon buttons, its settings", "Bundle")],
      callout("Three kinds of settings", "Settings is yours. Admin is the team's: roles, permissions, automation, AI caps. Connect is the plugin's: health, kit, folders, safety locks. Nothing in Settings can loosen a team rule."))

# ======================= FAMILIES =======================
FAM_JS = """const F = [
{ name: 'FMC_E_ElecFixture_SocketDouble', src: 'Library', role: 'E', cat: 'Electrical Fixtures', size: '0.4 MB', types: '2', params: '6 of 6', key: 'E.SOC_00 · 13 A twin switched socket', conn: '1 · Power', score: '96', state: 'Pass', k: 'ok', next: 'Nothing to do', cad: 'None' },
{ name: 'Vendor_Socket_MK', src: 'Downloaded', role: 'E', cat: 'Electrical Fixtures', size: '1.1 MB', types: '3', params: '1 of 6', key: 'None', conn: 'None · Formcraft Model can add', score: '41', state: 'Needs work', k: 'warn', next: 'Bring it in: rename to FMC_E_ElecFixture_SocketMK, map parameters, set keynote', cad: 'None' },
{ name: 'Imported_Kitchen', src: 'Downloaded', role: 'J', cat: 'Casework', size: '14 MB', types: '1', params: '0 of 5', key: 'None', conn: 'Not needed', score: '22', state: 'Heavy', k: 'bad', next: 'Replace with a library family, or purge the 2 DWG files first', cad: '2 DWG inside' },
{ name: 'F26001_E_ElecFixture_Isolator', src: 'Project', role: 'E', cat: 'Electrical Fixtures', size: '0.3 MB', types: '1', params: '6 of 6', key: 'E.SOC_03 · 15 A industrial socket', conn: '1 · Power', score: '90', state: 'Pass', k: 'ok', next: 'Nothing to do', cad: 'None' }
];
const C = { ok: ['#E6F4EA', '#1E6B34'], warn: ['#FFF4E0', '#6B4100'], bad: ['#FDECEA', '#A50E0E'] };
const sel = this.state.fsel;
const fams = F.map((f, i) => { const on = i === sel, c = C[f.k]; return { name: f.name, src: f.src, score: f.score, stBg: c[0], stFg: c[1], state: f.state,
  pressed: on ? 'true' : 'false', bg: on ? '#E8EDF3' : '#FFFFFF', sh: on ? 'inset 3px 0 0 #1B2532' : 'none', pick: () => this.setState({ fsel: i }) }; });
const f = F[sel], c = C[f.k];
return { fams, fd: Object.assign({ stBg: c[0], stFg: c[1] }, f) };"""
FACT = lambda k, v: f'<div style="display: contents"><span style="color: {MUTED}">{k}</span><span>{v}</span></div>'
body = (group("Compliance scan · every family in this file",
              '<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px">'
              + "".join(f'<div style="padding: 6px 8px; border-radius: 5px; background: {CHIP[k][0]}; color: {CHIP[k][1]}"><div style="font-size: 17px; font-weight: 700">{n}</div><div style="font-size: 10.5px; line-height: 1.25">{t}</div></div>'
                        for n, t, k in [("126", "scanned", "grey"), ("98", "compliant", "good"), ("21", "fixable in one pass", "warn"), ("7", "need a person", "bad")]) + '</div>',
              checks("Checked against the Families rulebook", [("Name follows FMC_[Role]_[Category]_[Description]", True, "14 fail", W), ("Required FMC parameters present (by GUID)", True, "17 fail", W),
                                                               ("Keynote and element code set", True, "11 fail", W), ("File size under 2 MB, no imported CAD", True, "5 fail", B),
                                                               ("Type names [KeySize]_[Variant]", True, "6 fail", W), ("Nested families compliant too", True, "2 fail", W)]),
              seg("Show", ["Not compliant (28)", "Fixable (21)", "Need a person (7)", "All (126)"], 0),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Scan again") + btn("Make 21 compliant", True, opens="d_fixall") + btn("List the 7 for a person", msg="The 7 go to the results list with the reason for each; click one to zoom to where it is used.") + '</div>',
              note("Runs on open and before Ready to issue. A Must failure on a placed family blocks the issue until fixed or excepted.", I)),
        group("Families · click one to see what it needs",
              '<div style="border: 1px solid #DDE1E6; border-radius: 4px; overflow: hidden"><div style="display: grid; grid-template-columns: 1fr 74px 40px 82px; gap: 6px; padding: 4px 6px; background: #F1F3F5; font-size: 10.5px; color: #5B6270; text-transform: uppercase; letter-spacing: 0.5px"><span>Family</span><span>From</span><span>Score</span><span>State</span></div>'
              '<sc-for list="{{fams}}" as="f" hint-placeholder-count="4"><button aria-pressed="{{f.pressed}}" onClick="{{f.pick}}" style="width: 100%; text-align: left; font: inherit; font-size: 11.5px; color: #1A1D21; cursor: pointer; display: grid; grid-template-columns: 1fr 74px 40px 82px; gap: 6px; align-items: center; min-height: 28px; padding: 0 6px; border: none; border-top: 1px solid #EEF0F3; background: {{f.bg}}; box-shadow: {{f.sh}}">'
              '<span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{f.name}}</span><span>{{f.src}}</span><span>{{f.score}}</span><span><span style="font-size: 10.5px; padding: 1px 6px; border-radius: 9px; white-space: nowrap; background: {{f.stBg}}; color: {{f.stFg}}">{{f.state}}</span></span></button></sc-for></div>',
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Use Revit selection", msg="Select a family instance in Revit: its family shows here.") + btn("Bring in a file…", opens="d_bring") + btn("Open library", opens="d_pick") + '</div>'),
        group("Selected · {{fd.name}}",
              '<div style="display: grid; grid-template-columns: 96px 1fr; gap: 4px 10px; font-size: 12px; line-height: 1.4">'
              + FACT("Source", "{{fd.src}}") + FACT("Role, category", "{{fd.role}} · {{fd.cat}}") + FACT("File size", "{{fd.size}}") + FACT("Imported CAD", "{{fd.cad}}")
              + FACT("Types", "{{fd.types}}") + FACT("FMC parameters", "{{fd.params}}") + FACT("Keynote", "{{fd.key}}") + FACT("Connectors", "{{fd.conn}}")
              + FACT("Score", '<span style="font-size: 10.5px; padding: 1px 7px; border-radius: 9px; background: {{fd.stBg}}; color: {{fd.stFg}}">{{fd.score}} · {{fd.state}}</span>') + '</div>',
              '<div style="padding: 6px 8px; border-radius: 4px; background: #EEF0F3; font-size: 12px; line-height: 1.4"><b>Next:</b> {{fd.next}}</div>',
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Rename to standard", msg="Rename: shows old and new name, then applies after a dry run.") + btn("Add parameters", opens="d_sample")
              + btn("Set keynote", opens="d_kn") + btn("Add to library", opens="d_bring") + btn("Connectors → Formcraft Model", msg="Formcraft Model opens this family for technical modelling: connectors, systems, clearances.") + '</div>'),
        group("Bring in a family from outside",
              drop("Downloaded family", "Drop .rfa files or a folder", "Manufacturer sites, other firms, old projects"),
              checks("Steps (each shown before it runs)", [("Check it", True, "score 41", W), ("Rename to the naming rule", True, "→ FMC_E_ElecFixture_SocketMK", I),
                                                           ("Map its parameters to FMC parameters", True, "3 mapped · 3 added", I), ("Set keynote and element code", True, "E.SOC_04 (new)", I),
                                                           ("Purge CAD and unused types", True, "", GR), ("Save to library staging", True, "04_Families\\_Staging\\E", I),
                                                           ("Connectors and technical modelling", False, "Formcraft Model", GR)]),
              note("Release from staging to the library stays with the Family Librarian.", GR)),
        group("Shared parameters",
              tbl("Picked families", ["", "Family", "Where"], [["☑", "FMC_E_ElecFixture_SocketDouble", "Loaded"], ["☑", "Vendor_Socket_MK", "Imported"], ["☑", "F26001_E_ElecFixture_Isolator", "Loaded"]], ["20px", "1fr", "64px"]),
              sel("Parameter", ["FMC_Asset_Tag (Asset 7D)", "FMC_Mounting_Height_mm (Electrical)", "FMC_Keynote_Code (Element Code)", "+ Create new parameter…"], 0),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + seg("Binding", ["Type", "Instance"], 1) + seg("Run on", ["2 first", "All"], 0) + '</div>',
              note("Matched by GUID and data type, not just by name. New parameters go through a change request.", I)),
        group("Keynotes",
              ro("Keynote file", "Z:\\00_Standards\\02_Keynotes\\FMC_Keynotes.txt · 21 divisions · 300+ items"),
              inp("Search keynotes", "socket", "Code or words"),
              tbl("", ["Code", "Description"], [["E.SOC_00", "13 A twin switched socket outlet, flush"], ["E.SOC_01", "13 A single switched socket outlet, flush"],
                  ["E.SOC_02", "45 A cooker control unit with socket"], ["E.SOC_03", "15 A industrial socket outlet"]], ["70px", "1fr"]),
              '<div style="font-size: 12px; font-weight: 600; margin-top: 2px">Add a keynote</div>',
              '<div style="display: grid; grid-template-columns: 1fr 90px; gap: 8px">' + sel("Group", ["E.SOC · Socket outlets and control units", "E.LED · Luminaires (LED)", "P.WCS · WC suites", "+ New group…"], 0) + ro("Next code", "E.SOC_04") + '</div>',
              inp("Description", "13 A twin switched socket with 2 USB-A, flush, white", hint="Plain words; material, size and finish."),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Add keynote", opens="d_kn") + btn("Assign to the selected family", msg="Keynote set on the selected family's types (dry run first).") + btn("Reload keynotes in the model") + '</div>',
              note("New keynotes land in staging; the BIM Manager approves them into the kit's keynote file.", W)),
        group("Name and destination",
              ro("Name preview", "FMC_E_ElecFixture_SocketMK.rfa"),
              radios("Save to", ["Library staging (04_Families\\_Staging\\E)", "This project (01_WIP\\E\\Families, named F26001_…)"], 0)),
        author("e.g. 'Downloaded manufacturer families: keep their model number in FMC_Model_Number.'"))
dl = (dialog("d_bring", "Bring in Vendor_Socket_MK",
              ro("New name", "FMC_E_ElecFixture_SocketMK.rfa"),
              tbl("Parameter map", ["Their parameter", "Becomes", ""], [["Manufacturer", "FMC_Manufacturer", ("Mapped", G)], ["Model", "FMC_Model_Number", ("Mapped", G)],
                  ["Mount_Ht", "FMC_Mounting_Height_mm", ("Mapped", G)], ["—", "FMC_Asset_Tag", ("Added", I)], ["Colour_Code", "(left as is)", ("Kept", GR)]], ["1fr", "1fr", "60px"]),
              ro("Keynote", "E.SOC_04 · new, waiting for approval", mono=False),
              note("Every step is a dry run first; the family is re-checked after.", I),
              primary="Bring in (dry run)", done_msg="Dry run: renamed, 3 mapped, 1 added, keynote set; ready for staging."),
      dialog("d_fixall", "Make 21 families compliant",
              tbl("Plan (dry run)", ["Family", "Fixes"], [["Vendor_Socket_MK", "rename · map 3 · add 1 · keynote"], ["Door_Single_900", "rename · types · keynote"],
                  ["Generic_Light_600", "rename · map 2 · keynote"], ["… 18 more", "names, parameters, keynotes"]], ["1fr", "1.3fr"]),
              checks("Do", [("Rename families and types to the standard", True), ("Map their parameters to FMC parameters", True), ("Add missing required parameters", True),
                            ("Set keynotes where the match is certain", True, "15", I), ("Ask me where the keynote is a guess", True, "6", W)]),
              note("Placed instances keep their position; schedules and tags follow the new names. Everything is re-scanned after.", I),
              primary="Make compliant (dry run)", done_msg="Dry run: 21 families ready to fix; 6 keynotes need your pick."),
      dialog("d_kn", "New keynote",
              ro("Code", "E.SOC_04"), ro("Group", "E.SOC · Socket outlets and control units", mono=False),
              ta("Description", "13 A twin switched socket with 2 USB-A, flush, white", rows=2),
              checks("", [("Assign to FMC_E_ElecFixture_SocketMK", True), ("Raise the change request for the kit", True)]),
              primary="Add to staging", done_msg="E.SOC_04 added to staging; change request sent to the BIM Manager."),
      dialog("d_sample", "Add parameters: 2 families first",
              tbl("", ["Family", "Added", "Check"], [["FMC_E_ElecFixture_SocketDouble", "FMC_Asset_Tag", ("OK", G)], ["Vendor_Socket_MK", "FMC_Asset_Tag", ("OK", G)]], ["1fr", "100px", "50px"]),
              note("Re-read after writing: both hold the parameter with the right GUID.", G),
              primary="Apply to all (dry run)", done_msg="Dry run for all families ready to review."),
      dialog("d_pick", "Library",
              inp("Search", "", "Name, role, category or keynote"),
              tbl("", ["", "Family", "Role"], [["☐", "FMC_E_ElecFixture_SocketDouble", "E"], ["☐", "FMC_E_LightFixture_Downlight", "E"], ["☐", "FMC_P_PlumbFix_WCPan", "P"]], ["20px", "1fr", "40px"]),
              primary="Load selected", done_msg="Families loaded into the model (sample)."))
fam = pane("Families", WIP, G, body,
           [btn("Scan file", True, msg="Scan: every family in this file checked against the Families rulebook."), btn("Bring in", opens="d_bring"), btn("Keynote", opens="d_kn")], "126 scanned · 28 not compliant", dialogs="".join(dl))
board("PaneFamilies.dc.html", "Families pane", "Pane · Families",
      "Every family in the file compliant: scan, fix in one pass, see what each one needs",
      "The family hub: select a family and the pane shows its score, parameters, keynote and connectors with the next step. Downloaded families are renamed, mapped and keynoted into library staging. Keynotes and shared parameters live here too.",
      fam,
      [("Compliance scan", "Counts, checks, filter", "Every family in the file against the Families rulebook; fixable vs needs a person", "Families rulebook"),
       ("Make compliant", "Dry-run plan", "Rename, map and add parameters, keynotes; re-scan after", "Roadmap 0.7"),
       ("Families list", "Click a row", "The selected family's details appear below", "—"),
       ("Selected family", "Facts + actions", "Source, size, CAD, types, parameters, keynote, connectors, score and next step", "Families rulebook"),
       ("Bring in a family", "Drop + steps", "Check, rename, map parameters, keynote, purge, save to staging", "MAN 4.6, 5.5, 9.12"),
       ("Parameter map", "Dialog", "Their parameters become FMC parameters by GUID", "MAN 5.3"),
       ("Shared parameters", "Picker + binding", "Add or create; two first, then all", "MAN 5.5, 5.6"),
       ("Keynotes", "Search, add, assign", "Next code worked out (E.SOC_04); new ones via approval", "MAN 6.5, 6.6"),
       ("Connectors", "Hand-off", "Technical modelling goes to Formcraft Model", "Family"),
       ("Save to", "Radio", "Library staging or project WIP", "MAN 9.12, D4")],
      callout("Download, tidy, keep", "A great family from a manufacturer comes in with its own names and parameters. One pass renames it, maps its data to FMC parameters, gives it a keynote and puts it in staging for the Librarian.")
      + callout("Manage tidies, Model builds", "Manage handles names, parameters, keynotes and checks. Adding connectors, systems and clearances is technical modelling, so it hands off to Formcraft Model."),
      script=("fsel: 1", FAM_JS))

# ======================= SHEETS =======================
body = (group("Which sheets",
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Stage", ["G3 Detailed / permit", "G2 Scheme", "G4 Construction"], 0) +
              sel("Issue set", ["PERMIT", "TENDER", "CONSTRUCTION", "RECORD"], 0) + '</div>',
              chips("Roles", ["Z", "A", "S", "M", "E", "P"], {"Z", "A", "S"})),
        group("Register",
              ro("Register", "FMC_Sheet_Register.xlsx · two-way", mono=False),
              seg("When model and register disagree", ["Ask me", "Register wins", "Model wins"], 0),
              tbl("Planned vs in the model", ["Sheet", "Difference"],
                  [["A-1002 First floor plan", ("Missing", W)], ["A-9001 Old option B", ("Extra", GR)], ["S-1001 Foundation plan", ("Name differs", W)]], ["1fr", "100px"])),
        group("Completeness",
              tbl("", ["Sheet", "Status", "Done"],
                  [["Z-0001 Cover and index", ("Done", G), "100%"], ["A-1001 Ground floor plan", ("In work", W), "72%"],
                   ["A-2001 Elevations", ("Due", I), "40%"], ["S-1001 Foundation plan", ("In work", W), "55%"]], ["1fr", "70px", "44px"])),
        group("Placing views · Phase 2 with Formcraft Flow",
              ro("Sheet Layout", "Align, distribute and smart crop come from Flow's Sheet Layout, driven by these rules", mono=False),
              note("Phase 1 creates sheets and fills title blocks; views are placed by people.", GR)),
        group("Before issue",
              checks("", [("Warn when a sheet has open review items", True, "1 sheet", W), ("Hand the set to Ready to issue", True)]),
              note("Issuing happens in the Issue section, after the readiness check.", I)),
        author("e.g. 'Permit set: municipality wants site plan at 1:200 and a separate drainage sheet.'"))
dl = (dialog("d_splan", "Sheets for G3 · PERMIT",
              tbl("", ["Sheet", "Name", "Action"], [["Z-0001", "Cover and index", ("Exists", GR)], ["A-1002", "First floor plan", ("New", G)],
                  ["A-3001", "Sections A–A, B–B", ("New", G)], ["A-1001", "Ground floor plan", ("Duplicate skipped", W)], ["A-9001", "Old option B", ("Retire", W)]],
                  ["58px", "1fr", "110px"]),
              note("Retired sheets leave the issue set; nothing is deleted.", I), primary="Create 2 sheets (dry run)", done_msg="Dry run: 2 sheets to create."),
      dialog("d_reg", "Sync with the register",
              tbl("", ["Sheet", "Register", "Model", "Use"], [["S-1001", "Foundation plan", "Foundations", "Register"], ["A-1002", "First floor plan", "—", "Create"]], ["54px", "1fr", "1fr", "64px"]),
              note("Nothing is overwritten without a choice in the Use column.", W), primary="Apply choices", done_msg="Register and model now match (sample)."))
sh = pane("Sheets", WIP, G, body, [btn("Plan", opens="d_splan"), btn("Create", True, opens="d_splan"), btn("Sync register", opens="d_reg")], "61 sheets · 3 differences", dialogs="".join(dl))
board("PaneSheets.dc.html", "Sheets pane", "Pane · Sheets Manager", "The right sheets for the stage, matched to the register",
      "Pick the stage and issue set. Sheets are created from the register with a duplicate check, differences are shown both ways, and the set goes to Ready to issue when it is done.",
      sh,
      [("Stage, issue set, roles", "Dropdowns, chips", "Which sheets should exist", "STD 2.4"),
       ("Register sync", "Two-way, with a rule", "Who wins when model and register disagree", "Review"),
       ("Planned vs model", "Table", "Missing, extra, wrongly named sheets", "Review"),
       ("Completeness", "Table", "How far each sheet has come", "SHT-039"),
       ("Placing views", "Phase 2", "Through Formcraft Flow's Sheet Layout", "Family"),
       ("Before issue", "Checks", "Open reviews warned; set handed to Ready to issue", "Roadmap 0.9")],
      callout("Sheet numbers follow the register", "Numbers like A-1001 come from the Sheet Register and the series rule, never typed by hand."))

# ======================= ANNOTATE =======================
PENS = [("1", "0.10", "Hatch, hidden"), ("2", "0.13", "Fine detail"), ("3", "0.18", "Annotation, beyond"), ("4", "0.25", "Light cut, projection"),
        ("5", "0.35", "Medium cut"), ("6", "0.50", "Heavy cut, sheet frame"), ("7", "0.70", "Very heavy cut"), ("8", "1.00", "Site boundary, ground sections")]
pen_rows = "".join(f'<div style="display: grid; grid-template-columns: 34px 54px 1fr 60px; gap: 6px; align-items: center; min-height: 22px; padding: 0 6px; border-top: 1px solid #EEF0F3; font-size: 11.5px">'
                   f'<span>Pen {p}</span><span style="{MONO}; font-size: 11px">{w} mm</span><span>{E(u)}</span><span style="display: block; height: {max(1, round(float(w) * 4))}px; background: #1A1D21"></span></div>' for p, w, u in PENS)
body = (group("Annotation standard · FMC_Annotation_Standard",
              ro("File", "Z:\\00_Standards\\03_Master_Data\\FMC_Annotation_Standard.json · v1.0 · from STD 6, MAN 9.14 and the Graphics tab", mono=False),
              seg("Show", ["Lines", "Text", "Dimensions", "Tags", "Symbols", "Colours"], 0),
              '<div style="border: 1px solid #DDE1E6; border-radius: 4px; overflow: hidden"><div style="display: grid; grid-template-columns: 34px 54px 1fr 60px; gap: 6px; padding: 4px 6px; background: #F1F3F5; font-size: 10.5px; color: #5B6270; text-transform: uppercase; letter-spacing: 0.5px"><span>Pen</span><span>Width</span><span>Used for</span><span>Sample</span></div>' + pen_rows + '</div>',
              ro("Line patterns", "FMC_Dash · FMC_DashDot · FMC_DashDotDot · FMC_Dot · FMC_CentreLine · FMC_Boundary", mono=False),
              note("Dimension styles, leader rules and tag offsets are not in the standard yet. Proposed values show amber until the BIM Manager approves them.", W),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Open the full standard", opens="d_std") + btn("Print as A3 sheet", msg="Prints the annotation standard as an A3 reference sheet for the office wall.") + btn("Propose a change", msg="Opens a change request for the annotation standard.") + '</div>'),
        group("Where",
              sel("Scope", ["Current view", "Views on the current sheet", "All plan views of this role", "Selected tags only"], 0),
              sel("Level of detail", ["From the stage: G3 detailed / permit", "Light", "Full"], 0)),
        group("Check against the standard",
              checks("", [("Text types (FMC_Arial_1.8 to 7.0_Bold only)", True, "3 others", W), ("Line weights outside pens 1–8", True, "0", G),
                          ("Line patterns not FMC_", True, "2", W), ("Dimension types not FMC_", True, "4", W), ("Tags not FMC_TAG_[Role]_[Subject]", True, "1", W),
                          ("Tags showing typed text, not parameters", True, "0", G), ("Symbols without 'Keep readable'", True, "2", W)]),
              note("Report only: click a row, then Zoom. Swapping types to the standard is a safe fix after a dry run.", I)),
        group("Missing tags · report",
              tbl("", ["Category", "Untagged", "Tag family"],
                  [["Doors", "6", "FMC_TAG_A_Door"], ["Windows", "2", "FMC_TAG_A_Window"], ["Rooms", "0", "FMC_TAG_A_Room"], ["Electrical fixtures", "14", "FMC_TAG_E_Device"]],
                  ["1fr", "60px", "1.2fr"])),
        group("Neat tags · Formcraft Flow (Tag Tidy and Tag Assist)",
              chips("Tidy actions", ["Align in a row", "Align in a column", "Distribute evenly", "Leaders never cross", "Straight or one elbow", "Clear of geometry and dimension text",
                                     "Same offset from the element", "Leader only when away from the element", "Keep text horizontal", "Pull in from crop edges",
                                     "Remove duplicate tags", "Room tags at room centre"],
                    {"Align in a row", "Leaders never cross", "Straight or one elbow", "Clear of geometry and dimension text", "Remove duplicate tags"}),
              chips("Speed", ["Tag one, tag all of that type in the view", "Copy a neat layout to typical floors", "Match tag type to view scale", "Re-tidy after model changes"],
                    {"Tag one, tag all of that type in the view", "Copy a neat layout to typical floors"}),
              seg("Moves", ["Only tags the plugin placed", "Also tags I select now"], 0),
              note("Tags a person placed are never moved unless that person selects them for tidying now. Every move is previewed and can be undone in one step.", I)),
        group("Placing tags · Phase 2 via Tag Assist",
              checks("", [("Only add missing tags", True), ("One view first, then the set", True), ("Mark placed tags FMC_AutoPlaced", True, "fixed", I)]),
              note("Live shared models: Leads and Admins, own discipline, after a preview. Moving existing tags in bulk: test copy only.", W)),
        group("Dimensions",
              note("Dimension styles come from the standard once approved. Automatic dimension strings are deferred.", GR)),
        author("e.g. 'Door tags outside the swing. Keep a clear 5 mm around grid bubbles.'"))
dl = (dialog("d_std", "FMC_Annotation_Standard · full view",
              seg("Section", ["Lines", "Text", "Dimensions", "Tags", "Symbols", "Colours"], 1),
              tbl("Text types", ["Type", "Height", "Used for"], [["FMC_Arial_1.8", "1.8 mm", "Container name strip"], ["FMC_Arial_2.5", "2.5 mm", "Notes, tags, dimensions"],
                  ["FMC_Arial_3.5", "3.5 mm", "View titles"], ["FMC_Arial_5.0_Bold", "5.0 mm", "Sheet titles"], ["FMC_Arial_7.0_Bold", "7.0 mm", "Cover headings"]], ["1.2fr", "60px", "1fr"]),
              tbl("Symbols and colours", ["Rule", "Source"], [["MEP device symbols print 5 mm, 'Keep readable'", "STD 6.2"], ["Electrical symbols IEC 60617; safety signs ISO 7010", "STD 6.2"],
                  ["MEP colours by filter: cold water blue, hot red, soil brown, vent green dashed", "STD 6.2"], ["One tag per job; no typed text in tags", "STD 6.2"]], ["1.6fr", "60px"]),
              ro("Proposed (amber)", "Dimension style FMC_Linear: Arial 2.5, tick 45°, witness gap and rounding to approve", mono=False),
              primary="Close", done_msg="Standard closed."),
      dialog("d_missing", "Missing tags · A_FP_L00_General",
              tbl("", ["Element", "Category", ""], [["D-014", "Door", "Zoom"], ["D-015", "Door", "Zoom"], ["W-003", "Window", "Zoom"], ["SKT-21", "Electrical fixture", "Zoom"]], ["70px", "1fr", "50px"]),
              note("Report only in Phase 1.", I), primary="Save report", done_msg="Missing-tag report saved."),
      dialog("d_tidy", "Tidy tags · A_FP_L01_General (preview)",
              tbl("", ["Change", "Tags"], [["Aligned in rows", "18"], ["Leaders straightened or one elbow", "11"], ["Crossing leaders fixed", "4"], ["Duplicates removed", "3"], ["Hand-placed tags left alone", "9"]], ["1fr", "60px"]),
              note("Before and after shown side by side in the view; one Undo restores everything.", I),
              primary="Tidy", done_msg="36 tags tidied; 9 hand-placed tags untouched."))
an = pane("Annotate", WIP, G, body, [btn("Check", True, opens="d_missing"), btn("Tidy tags", opens="d_tidy"), btn("Standard", opens="d_std"), btn("Undo auto-placed")], "22 untagged · 12 off-standard", dialogs="".join(dl))
board("PaneAnnotate.dc.html", "Annotate pane", "Pane · Annotation",
      "One annotation standard file, checks against it, and neat tags through Formcraft Flow",
      "The annotation standard (line weights, patterns, text, dimensions, tags, symbols, colours) lives in one file the plugin reads. The pane checks views against it, lists missing tags, and Tag Tidy makes tags neat without touching a person's work.",
      an,
      [("Annotation standard", "File + tabs", "Pens 1–8, patterns, text, dimensions, tags, symbols, colours in one place", "STD 6.2, 6.3, MAN 9.14"),
       ("Proposed values", "Amber", "Dimension styles, leaders, offsets wait for approval", "Rulebook gap"),
       ("Check against the standard", "Checks, zoom", "Text, lines, patterns, dimension types, tags, symbols", "TPL-020, 021"),
       ("Missing tags", "Report", "Untagged elements by category", "Roadmap 0.9"),
       ("Tidy actions", "Chips", "Align, distribute, leaders never cross, clear of geometry, duplicates", "Formcraft Flow"),
       ("Speed", "Chips", "Tag all of a type, copy a layout to typical floors, match scale", "Formcraft Flow"),
       ("Moves", "Segmented", "Only plugin-placed tags, or tags you select now", "Decision 3"),
       ("Placing tags", "Phase 2", "Through Tag Assist, one view first", "Decision 3")],
      callout("One file, read everywhere", "The same annotation standard drives the template builder, the audit, this pane and Tag Tidy, and prints as an A3 sheet for the office wall.")
      + callout("Neat, not bossy", "Tag Tidy fixes leaders, alignment and clashes, but a tag a person placed only moves when that person selects it."))

# ======================= QA =======================
body = (group("Run",
              sel("Gate", ["WIP → Shared (Discipline Lead)", "Shared → Published (PIM)", "Weekly health"], 0),
              checks("Checks", [("Names", True, "3 fail", B), ("Shared parameter bindings", True, "Pass", G), ("Keynotes and codes", True, "12 fail", B),
                                ("Links and coordinates", True, "Pass", G), ("Sheets", True, "2 warnings", W), ("IDS (IFC)", False, "not checked", GR)])),
        group("Results",
              seg("Show", ["Fail", "Warning", "Not applicable", "Not checked"], 0),
              tbl("", ["Rule", "What", "Sev.", "Where"],
                  [["NAM-012", "View name pattern", ("Must", B), "3 views"], ["QA-011", "Type without a code", ("Must", B), "12 types"],
                   ["SHT-022", "Sheet parameter empty", ("Should", W), "2 sheets"]], ["58px", "1fr", "56px", "62px"]),
              note("Click a row, then Zoom: the failing elements are selected.", I)),
        group("Trend",
              tbl("", ["Run", "New", "Recurring", "Resolved"], [["13 Oct", "2", "15", "6"], ["06 Oct", "8", "13", "4"], ["29 Sep", "17", "0", "0"]], ["1fr", "50px", "70px", "70px"])),
        group("Safe fixes",
              checks("", [("Rename 3 views to A_FP_Lxx_Purpose", True, "safe", G), ("Fill FMC_Sheet_Status on 2 sheets", True, "safe", G), ("Code 12 types", False, "needs a person", W)]),
              note("Only data fixes (names, empty values) are offered. Geometry is never touched.", I)),
        group("Health alerts",
              tbl("Amber / red", ["Metric", "Amber", "Red"],
                  [["Warnings (total)", "100", "300"], ["In-place families", "5", "15"], ["Survey Point drift (mm)", "1", "10"]], ["1fr", "50px", "50px"]),
              note("Alerts, not a quality score: one missing Must rule matters more than 50 small warnings.", W)),
        author("e.g. 'Ignore warnings from the linked survey model.'"))
dl = (dialog("d_qa", "QA results · WIP → Shared",
              checks("", [("41 checks ran", True, "36 pass", G), ("Failed", True, "2 rules", B), ("Not applicable", True, "3", GR), ("Not checked", True, "IDS", GR)]),
              ro("Report", "06_QA\\Health\\FMC_QA_A-0001_20261013-1042.md"), primary="Save report", done_msg="Report saved to 06_QA."),
      dialog("d_fix", "Safe fixes: plan",
              tbl("", ["Element", "Now", "After"], [["View 12", "Level 1 plan", "A_FP_L01_General"], ["Sheet A-1003", "(empty)", "S2"]], ["1fr", "1fr", "1fr"]),
              note("Re-checked after fixing; the log keeps before and after.", I), primary="Fix (dry run)", done_msg="Dry run: 5 data fixes ready."),
      dialog("d_explain", "What the report means",
              ro("Summary", "Two Must rules block the move to Shared: 12 types have no element code and 3 views break the name pattern.", mono=False),
              primary="Copy fix list", done_msg="Fix list copied.", ai=True))
qa = pane("QA", WIP, G, body, [btn("Run QA", True, opens="d_qa"), btn("Safe fixes", opens="d_fix"), btn("Explain", ai=True, opens="d_explain")], "2 Must · 1 Should", dialogs="".join(dl))
board("PaneQA.dc.html", "QA pane", "Pane · QA and model health", "Pass, fail, not applicable or not checked, with every problem one click away",
      "Results are ranked by severity, each tied to a rule. QA tracks new, recurring and resolved issues, offers safe data fixes only, and treats warning counts as alerts.",
      qa,
      [("Gate", "Dropdown", "Which checklist runs", "MAN 14.3"),
       ("Results", "Filter + table", "Pass, fail, not applicable, not checked; by severity", "Roadmap 0.2"),
       ("Zoom", "Row click", "Failing elements selected in Revit", "Review"),
       ("Trend", "Table", "New, recurring, resolved per run", "Roadmap 0.7"),
       ("Safe fixes", "Checks + dry run", "Names and empty values only", "Review"),
       ("Health alerts", "Thresholds", "Amber 100, red 300; alerts, not a score", "MAN 14.2"),
       ("Explain", "AI button · Phase 2", "Plain-language summary", "ClaudeUse")],
      callout("Works on every model", "Checking only reads, so it runs on live and shared models too."))

# ======================= LINKS & SYNC =======================
body = (group("Coordinates",
              sel("Coordinate system", ["Arc 1960 / UTM zone 36N (EPSG:21096)", "Arc 1960 / UTM zone 36S (EPSG:21036)", "Other: surveyor states it"], 0),
              '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px">' + ro("Easting", "[E]") + ro("Northing", "[N]") + ro("Elevation", "[MSL]") + '</div>',
              note("From the coordinate record. Survey Point drift: 0 mm.", G)),
        group("Links",
              inp("Link from", "D:\\Projects\\F26001_Pilot\\02_Shared", mono=True, browse="Browse…"),
              ro("Positioning", "Auto – By Shared Coordinates", hint="Fixed by the Manual."),
              tbl("Linked models", ["Model", "Coords", "Pinned"],
                  [["…-M3-S-0001.rvt", ("Shared", G), ("Yes", G)], ["…-M3-M-0001.rvt", ("Shared", G), ("No", W)], ["…-M3-Z-0001.rvt", ("Shared", G), ("Yes", G)]],
                  ["1fr", "64px", "52px"]),
              ro("Link workset", "Z_Links_<Role>")),
        group("Coordinate changes (guided)",
              sel("Change", ["Acquire coordinates from the Z model", "Publish coordinates to a link", "Move a link to shared coordinates"], 0),
              ro("Approval", "Lead or Admin, recorded in the log", mono=False),
              '<div style="display: flex; gap: 6px">' + btn("Preview change", opens="d_coord") + '</div>',
              note("Never by Claude and never on a schedule. The preview shows what moves before anyone approves.", W)),
        group("Sync master data and keynotes",
              inp("Master data", "Z:\\00_Standards\\03_Master_Data\\FMC_Master_Data.json", mono=True, browse="Browse…"),
              inp("Keynote file", "Z:\\00_Standards\\02_Keynotes\\FMC_Keynotes.txt", mono=True, browse="Browse…"),
              ro("Last sync", "Today 09:10 · 214 types · 0 invalid codes")),
        author("e.g. 'Consultant MEP model arrives Fridays; link it read-only and never acquire coordinates from it.'"))
dl = (dialog("d_link", "Link models from 02_Shared",
              checks("Models", [("F26001-FMC-ZZ-ZZ-M3-S-0001.rvt", True, "S1", I), ("F26001-FMC-ZZ-ZZ-M3-M-0001.rvt", True, "S1", I), ("F26001-FMC-ZZ-ZZ-M3-E-0001.rvt", False, "S0", GR)]),
              ro("Positioning", "Auto – By Shared Coordinates"), ro("Workset", "Z_Links_<Role>"),
              toggle("Pin after linking", True), primary="Link 2 models", done_msg="2 models linked by shared coordinates and pinned."),
      dialog("d_coord", "Acquire coordinates: preview",
              ro("From", "F26001-FMC-ZZ-ZZ-M3-Z-0001.rvt (site and coordination)"),
              tbl("", ["Item", "Now", "After"], [["Survey Point E", "[E]", "[E] (same)"], ["Survey Point N", "[N]", "[N] (same)"], ["Angle to true north", "0.00°", "12.50°"], ["Shared site", "Internal", "Site A"]], ["1fr", "70px", "80px"]),
              sel("Approved by", ["[NAME E] · BIM Coordinator (Lead)", "[NAME A] · Admin"], 0),
              ta("Reason (goes in the log)", "", "e.g. survey issued 12 Oct", rows=2),
              note("All linked models will move with the new coordinates. Tell the other disciplines before they next reload.", W),
              primary="Apply with approval", done_msg="Coordinates acquired; approval and before/after values logged."),
      dialog("d_sync", "Sync preview",
              tbl("", ["Type", "Field", "Before", "After"], [["EXT_Blk200_Pls20", "Unit rate", "46,000", "48,000"], ["SLAB_RC150", "Carbon factor", "—", "0.32"],
                  ["INT_Blk100_Pls15", "Description", "100 blockwork", "100 mm Class A blockwork"]], ["1fr", "70px", "64px", "1fr"]),
              note("214 types checked · 3 change · 0 invalid codes. A CSV change log is written.", I), primary="Apply changes", done_msg="3 types updated; log written."))
lk = pane("Links", WIP, G, body, [btn("Link", opens="d_link"), btn("Pin all"), btn("Audit"), btn("Sync preview", opens="d_sync"), btn("Apply", True, opens="d_sync")], "3 links", dialogs="".join(dl))
board("PaneLinks.dc.html", "Links and sync pane", "Pane · Links and sync", "Every model on one coordinate system, every type on the master data",
      "Link discipline models by shared coordinates, pin them, audit them, and push master data and keynotes into types with a preview first.",
      lk,
      [("Coordinate system", "Dropdown", "FMC_CRS in Project Information", "MAN 8.2"),
       ("Survey Point values", "Read-only", "From the coordinate record", "MAN 8.3"),
       ("Link from", "Path", "Models in 02_Shared", "MAN 7.4"),
       ("Positioning", "Read-only", "Always by shared coordinates", "MAN 8.5"),
       ("Link workset", "Read-only", "Z_Links_<Role>", "MAN 4.6"),
       ("Master data, keynote file", "Paths", "Values written into types", "MAN 6.5"),
       ("Coordinate changes", "Dropdown + preview", "Acquire or publish coordinates with approval by a Lead or Admin", "Roadmap: automation"),
       ("Sync", "Preview, Apply", "Dry run first; CSV change log", "MAN 17.2")],
      callout("Coordinates move only with approval", "Acquiring or publishing coordinates is a guided action: preview what moves, a Lead or Admin approves, the log keeps the before and after values. Claude never moves coordinates."))

# ======================= RULES =======================
body = (group("Browse",
              sel("Rulebook", ["Annotation (35)", "Naming (39)", "Templates (33)", "SharedParameters (21)", "Families (43)", "ProjectStart (24)",
                               "Sheets (40)", "QA (31)", "LinksAndCoordinates (27)", "Sync (24)", "ClaudeUse (27)"], 0),
              seg("Severity", ["All", "Must", "Should", "Advice"], 0),
              seg("Source", ["All", "From standards", "Proposed"], 0),
              inp("Search rules", "", "Words or a clause, e.g. 9.14")),
        group("Rules",
              tbl("", ["ID", "Rule", "Sev.", "Status"],
                  [["ANN-003", "Notes are Arial 2.5 mm", ("Must", B), ("Standard", G)], ["ANN-011", "Keynote legend filtered by sheet", ("Should", W), ("Standard", G)],
                   ["ANN-030", "Tags never overlap", ("Should", W), ("Proposed", I)], ["ANN-034", "Tags on live models: Leads only", ("Must", B), ("Plugin", I)]],
                  ["58px", "1fr", "56px", "70px"])),
        group("Selected rule · ANN-034",
              ro("Rule", "On a live shared model, only Leads and Admins add missing tags, in their own discipline, after a preview.", mono=False),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + ro("Severity", "Must") + ro("Scope", "All disciplines · all stages", mono=False) + '</div>',
              ro("Test", "Role from the team file + discipline of the view + preview shown", mono=False),
              ro("Fix hint", "Ask your discipline lead, or run on a test copy", mono=False),
              ro("Version", "v0.2 · changed 13 Oct · Decision 3", mono=False),
              ro("Why it exists", "Tags on live models change sheets other people are printing.", mono=False),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Approve (BIM Manager)", opens="d_approve") + btn("Change request", opens="d_cr") + btn("History") + '</div>'),
        group("Exceptions in force",
              tbl("", ["Rule", "Where", "Approved", "Until"], [["SHT-022", "A-2001", "[NAME A]", "C03"]], ["58px", "1fr", "70px", "44px"]),
              note("Every exception has an approver, a reason and an end.", I)),
        group("Decisions",
              checks("", [("Stages: gates and issue sets drive; RIBA a label", True, "decided", G), ("Status and revision codes: Manual 4.4", True, "decided", G),
                          ("Tagging on live models: Leads, own discipline, preview", True, "decided", G), ("Plugin may sync when the admin allows; Claude never", True, "decided", G),
                          ("Rename the gates in the Manual (G1 clash)", False, "change request", W), ("Correct STD 3.1 status list", False, "change request", W)])))
dl = (dialog("d_approve", "Approve a proposed rule",
              ro("ANN-030", "Tags never overlap other tags or dimension text.", mono=False),
              sel("Severity", ["Should", "Must", "Advice"], 0),
              sel("Approved by", ["BIM Manager", "Head of Modelling"], 0), ta("Comment", "", "Optional", rows=2),
              note("The impact report lists the checks and projects this rule will touch.", I), primary="Approve rule", done_msg="ANN-030 approved; rulebook version bumped."),
      dialog("d_cr", "Change request",
              ro("Rule", "ANN-030 · Tags never overlap", mono=False),
              ta("Proposed wording", "Tags never overlap other tags or dimension text; leaders may cross walls.", rows=2),
              ta("Why", "", "What went wrong, or what the client asked", rows=2),
              primary="Send change request", done_msg="Change request F26001-CR-0007 sent (sample)."))
rb = pane("Rules", WIP, G, body, [btn("Approve", opens="d_approve"), btn("Change request", opens="d_cr"), btn("Impact report")], "25 proposed", dialogs="".join(dl))
board("PaneRules.dc.html", "Rulebooks pane", "Pane · Rulebooks", "Every rule with its severity, scope, test, fix and history",
      "Rule schema v1: each rule says how serious it is, where it applies, how it is tested, how to fix it and when it changed. Exceptions are recorded with an approver and an end.",
      rb,
      [("Rulebook, severity, source", "Dropdown, filters", "Find rules fast", "Rule schema v1"),
       ("Rules", "Table", "ID, rule, severity, status", "Each rulebook"),
       ("Severity, scope, test, fix hint", "Read-only", "What QA and Ready to issue use", "Roadmap 0.1"),
       ("Version, why", "Read-only", "Change log and plain reason", "Review"),
       ("Approve", "BIM Manager only", "Turns a proposed rule on; impact report first", "MAN 18.4"),
       ("Exceptions", "Table", "Approver, reason and end date", "Review"),
       ("Decisions", "Checklist", "Settled decisions and the two change requests left", "Roadmap")],
      callout("Change the standard first", "To change a rule that comes from your Manual, change the Manual through the change process; the rulebook follows."))

WS_SCRIPT = """class Component extends DCLogic {
constructor(props) {
super(props);
this.state = { sel: 'A' };
}
renderVals() {
const ok = ['#E6F4EA', '#1E6B34'], warn = ['#FFF4E0', '#6B4100'], grey = ['#EEF0F3', '#4A515C'];
const D = {
A: { disc: 'Architecture', model: 'F26001-FMC-ZZ-ZZ-M3-A-0001', users: 3, sync: '12 min', late: false, open: '2 (1 as lead)',
  people: [['[NAME A]', 'Discipline Lead', '3'], ['[NAME B]', 'Modeller', '2'], ['[NAME C]', 'Junior Modeller', '1']],
  worksets: [['A_Shell', 'B, C, A', 'C'], ['A_Interior', 'B', ''], ['A_Site', 'A', ''], ['Z_Grids_Levels', 'Coordinator', 'E (held)'], ['Z_Links_S', 'Coordinator', '']],
  activity: [['[NAME B]', '12 min', false, '34 changes', '0'], ['[NAME C]', '2 h 40', true, '410 changes', '12']] },
S: { disc: 'Structure', model: 'F26001-FMC-ZZ-ZZ-M3-S-0001', users: 2, sync: '40 min', late: false, open: '1 (lead)',
  people: [['[NAME F]', 'Discipline Lead', '3'], ['[NAME D]', 'Modeller', '2']],
  worksets: [['S_Frame', 'D, F', 'D'], ['S_Site', 'D', ''], ['Z_Grids_Levels', 'Coordinator', 'E (held)'], ['Z_Links_A', 'Coordinator', '']],
  activity: [['[NAME D]', '40 min', false, '8 changes', '3'], ['[NAME F]', '1 h 05', false, '2 changes', '0']] },
M: { disc: 'Mechanical', model: 'F26001-FMC-ZZ-ZZ-M3-M-0001', users: 1, sync: '3 h', late: true, open: '1',
  people: [['[NAME G]', 'Modeller', '2']],
  worksets: [['M_Supply', 'G', 'G'], ['M_Extract', 'G', ''], ['Z_Links_A', 'Coordinator', '']],
  activity: [['[NAME G]', '3 h 10', true, '96 changes', '5']] },
Z: { disc: 'Site and coordination', model: 'F26001-FMC-ZZ-ZZ-M3-Z-0001', users: 1, sync: '1 day', late: false, open: '0',
  people: [['[NAME E]', 'BIM Coordinator', '3']],
  worksets: [['Z_Grids_Levels', 'E', 'E'], ['Z_Links_A', 'E', ''], ['Z_Links_S', 'E', '']],
  activity: [['[NAME E]', '1 day', false, '0 changes', '0']] }
};
const sel = this.state.sel, d = D[sel];
const models = ['A', 'S', 'M', 'Z'].map((k) => {
const m = D[k], on = k === sel, c = m.late ? warn : ok;
return { name: m.model.replace('F26001-FMC-ZZ-ZZ-', '…-'), role: k, users: m.users, sync: m.sync, syncBg: c[0], syncFg: c[1],
  pressed: on ? 'true' : 'false', bg: on ? '#1B2532' : '#FFFFFF', fg: on ? '#FFFFFF' : '#1A1D21', weight: on ? '600' : '400',
  pick: () => this.setState({ sel: k }) };
});
const people = d.people.map((p) => ({ name: p[0], role: p[1], level: p[2] }));
const worksets = d.worksets.map((w) => { const c = w[2] ? (w[2].indexOf('held') >= 0 ? warn : ok) : grey; return { name: w[0], who: w[1], edit: w[2] || '—', bg: c[0], fg: c[1] }; });
const activity = d.activity.map((a) => { const c = a[2] ? warn : ok; return { name: a[0], sync: a[1], bg: c[0], fg: c[1], changes: a[3], borrowed: a[4] }; });
return { models, people, worksets, activity, discName: d.disc, modelName: d.model, selRole: sel, openItems: d.open };
}
}"""
# ======================= WORKSHARE =======================
body = (group("Discipline models",
              '<div style="font-size: 11px; color: #5B6270">Click a model: the sections below switch to that discipline.</div>'
              '<div style="border: 1px solid #DDE1E6; border-radius: 4px; overflow: hidden"><div style="display: grid; grid-template-columns: 1fr 30px 52px 36px 60px; gap: 6px; padding: 4px 6px; background: #F1F3F5; font-size: 10.5px; color: #5B6270; text-transform: uppercase; letter-spacing: 0.5px"><span>Model</span><span>Role</span><span>Central</span><span>In it</span><span>Last sync</span></div>'
              '<sc-for list="{{models}}" as="m" hint-placeholder-count="4"><button aria-pressed="{{m.pressed}}" onClick="{{m.pick}}" style="width: 100%; text-align: left; border: none; border-top: 1px solid #EEF0F3; font-size: 11.5px; background: {{m.bg}}; color: {{m.fg}}; font: inherit; font-size: 11.5px; font-weight: {{m.weight}}; cursor: pointer; display: grid; grid-template-columns: 1fr 30px 52px 36px 60px; gap: 6px; align-items: center; min-height: 28px; padding: 0 6px">'
              '<span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis">{{m.name}}</span><span>{{m.role}}</span><span><span style="font-size: 10.5px; padding: 1px 6px; border-radius: 9px; white-space: nowrap; background: #E3F2EF; color: #2C6B63">Docs</span></span><span>{{m.users}}</span>'
              '<span><span style="font-size: 10.5px; padding: 1px 6px; border-radius: 9px; white-space: nowrap; background: {{m.syncBg}}; color: {{m.syncFg}}">{{m.sync}}</span></span></button></sc-for></div>',
              ro("Where live models sit", "Option A: Revit Cloud Worksharing (from the BEP)", mono=False)),
        group("People and modelling roles · {{discName}}",
              '<div style="border: 1px solid #DDE1E6; border-radius: 4px; overflow: hidden"><div style="display: grid; grid-template-columns: 1fr 1fr 40px; gap: 6px; padding: 4px 6px; background: #F1F3F5; font-size: 10.5px; color: #5B6270; text-transform: uppercase; letter-spacing: 0.5px"><span>Person</span><span>Role</span><span>Level</span></div>'
              '<sc-for list="{{people}}" as="p" hint-placeholder-count="3"><div style="display: grid; grid-template-columns: 1fr 1fr 40px; gap: 6px; align-items: center; min-height: 26px; padding: 0 6px; border-top: 1px solid #EEF0F3; font-size: 11.5px"><span>{{p.name}}</span><span>{{p.role}}</span><span>{{p.level}}</span></div></sc-for></div>',
              '<div style="display: flex; gap: 6px">' + btn("Add person", opens="d_person") + btn("Import from BEP team list") + '</div>',
              note("Only people assessed for their role work on live models (Manual Part 18).", I)),
        group("Worksets · {{modelName}}",
              '<div style="border: 1px solid #DDE1E6; border-radius: 4px; overflow: hidden"><div style="display: grid; grid-template-columns: 1fr 1fr 74px; gap: 6px; padding: 4px 6px; background: #F1F3F5; font-size: 10.5px; color: #5B6270; text-transform: uppercase; letter-spacing: 0.5px"><span>Workset</span><span>Assigned to</span><span>Editing now</span></div>'
              '<sc-for list="{{worksets}}" as="w" hint-placeholder-count="4"><div style="display: grid; grid-template-columns: 1fr 1fr 74px; gap: 6px; align-items: center; min-height: 26px; padding: 0 6px; border-top: 1px solid #EEF0F3; font-size: 11.5px"><span style="font-family: \'IBM Plex Mono\', monospace; font-size: 11px">{{w.name}}</span><span>{{w.who}}</span>'
              '<span><span style="font-size: 10.5px; padding: 1px 6px; border-radius: 9px; white-space: nowrap; background: {{w.bg}}; color: {{w.fg}}">{{w.edit}}</span></span></div></sc-for></div>',
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("New workset", opens="d_wsnew") + btn("Create the standard set") + btn("Hold for coordinator") + '</div>',
              inp("New workset name", "", "[Role]_[Content], e.g. A_Facade", mono=True, hint="Checked live against the naming rule."),
              note("Revit has no workset permissions. The plugin records who is assigned, warns anyone else before they edit, and the coordinator can hold a workset by owning it.", W)),
        group("Team activity since last sync · {{discName}}",
              '<div style="border: 1px solid #DDE1E6; border-radius: 4px; overflow: hidden"><div style="display: grid; grid-template-columns: 1fr 64px 78px 58px; gap: 6px; padding: 4px 6px; background: #F1F3F5; font-size: 10.5px; color: #5B6270; text-transform: uppercase; letter-spacing: 0.5px"><span>Person</span><span>Last sync</span><span>Unsynced</span><span>Borrowed</span></div>'
              '<sc-for list="{{activity}}" as="a" hint-placeholder-count="2"><div style="display: grid; grid-template-columns: 1fr 64px 78px 58px; gap: 6px; align-items: center; min-height: 26px; padding: 0 6px; border-top: 1px solid #EEF0F3; font-size: 11.5px"><span>{{a.name}}</span>'
              '<span><span style="font-size: 10.5px; padding: 1px 6px; border-radius: 9px; white-space: nowrap; background: {{a.bg}}; color: {{a.fg}}">{{a.sync}}</span></span><span>{{a.changes}}</span><span>{{a.borrowed}}</span></div></sc-for></div>',
              '<div style="font-size: 11.5px; color: #3B424D">Open review items for this discipline: <b>{{openItems}}</b></div>',
              checks("", [("Remind anyone who has not synced for 2 hours", True), ("Warn before closing with borrowed elements", True)]),
              note("For helping people sync safely, not for ranking them (Manual 14.5). No scores or leaderboards.", I)),
        group("Sync preflight (advice, not a guarantee)",
              checks("Before you sync", [("Central model reachable", True, "OK", G), ("Nobody else syncing this model now", True, "1 in queue", W),
                                         ("Warnings added since your last sync", True, "+3", W), ("Elements you borrowed", True, "12", I),
                                         ("Relinquish everything after syncing", True)]),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Check before sync", opens="d_sync_check") + btn("Wait for my turn") + '</div>'),
        group("Automation · set by the admin",
              ro("Auto-save", "Not used: this model is workshared", mono=False),
              toggle("Scheduled sync", True, "Every 2 hours · next at 15:00 · turned on by the admin", locked=True),
              checks("Each scheduled sync", [("Preflight must pass first", True), ("Message filled from your session", True), ("60-second notice with Postpone", True)]),
              '<div style="display: flex; gap: 6px">' + btn("Preview the 15:00 notice", opens="d_auto") + '</div>',
              note("Claude never syncs. The plugin syncs on a schedule only when the admin has turned it on for this project.", I)),
        group("Sync message (required)",
              sel("Revision worked on", ["P02 · preliminary (sample)", "P01", "C01", "No revision: general modelling"], 0),
              chips("Review items worked on", ["ISS-0014", "ISS-0013", "ISS-0011", "+ pick"], {"ISS-0014"}),
              chips("New items raised", ["ISS-0015", "+ add"], {"ISS-0015"}),
              inp("What you did (required)", "Beam B12 reduced, corridor ceiling reset", hint="Short and plain. Sync stays disabled until this is filled."),
              ro("Filled in for you", "[NAME B] · {{selRole}} · worksets of the selected model · 34 changes", mono=False),
              ro("Message preview", "F26001 | {{selRole}} | P02 | Worked: ISS-0014 | New: ISS-0015 | Beam B12 reduced, corridor ceiling reset | [NAME B]"),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Sync with this message", True) + btn("Copy message") + '</div>',
              note("A person presses this button; Claude and the AI buttons can never sync. The message goes into Revit's sync comment and the project's sync log.", I)),
        group("Link to reviews",
              checks("", [("Send review items to the people assigned to the clouded elements' workset", True),
                          ("Also notify the element's last editor", True)])),
        author("e.g. 'Juniors stay on A_Interior until their G3 review passes. Coordinator holds grids and levels.'"))
dl = (dialog("d_wsnew", "New workset",
              ro("Model", "{{modelName}}"), inp("Name", "", "[Role]_[Content], e.g. A_Facade", mono=True),
              chips("Assign people", ["[NAME A]", "[NAME B]", "[NAME C]", "[NAME D]"], {"[NAME A]"}),
              toggle("Visible in all views by default", True),
              note("Assignment is recorded by the plugin; Revit itself does not lock worksets to people.", W),
              primary="Create (dry run)", done_msg="Workset created in a dry run; press Create worksets to apply."),
      dialog("d_person", "Add person",
              inp("Name", "", "[NAME]"), sel("Discipline", ["A", "I", "S", "M", "E", "P", "FP", "Z"], 0),
              sel("Modelling role", ["Junior Modeller", "Modeller", "Senior Modeller", "Discipline Lead", "BIM Coordinator"], 1),
              sel("Assessed level", ["1 Aware", "2 Practitioner", "3 Lead", "4 Owner"], 1),
              inp("Email for notifications", "", "name@company"),
              primary="Add person", done_msg="Person added (sample)."),
      dialog("d_auto", "Scheduled sync in 60 seconds",
              ro("Model", "{{modelName}}"),
              checks("Preflight", [("Central model reachable", True, "OK", G), ("Your turn in the queue", True, "Now", G), ("Elements you borrowed", True, "4", I)]),
              ro("Message (filled for you)", "F26001 | {{selRole}} | P02 | Worked: ISS-0014 | Scheduled sync | [NAME B]"),
              sel("If you are mid-command", ["Wait until I finish", "Postpone 15 minutes", "Skip this one"], 0),
              note("If the preflight fails, nothing syncs and you get a note saying why.", W),
              primary="Sync now", done_msg="Synced on schedule; message saved to the sync log."),
      dialog("d_sync_check", "Sync preflight",
              checks("", [("Central model reachable", True, "OK", G), ("Your turn in the queue", True, "Now", G), ("Warnings added", True, "+3", W), ("Elements you borrowed", True, "12, relinquished after sync", I)]),
              ro("Message", "F26001 | {{selRole}} | P02 | Worked: ISS-0014 | New: ISS-0015 | Beam B12 reduced, corridor ceiling reset | [NAME B]"),
              note("A person presses Sync; Claude never can.", I), primary="Sync with this message", done_msg="Synced with central; message saved to the sync log."))
ws = pane("Workshare", "{{modelName}} · workshared", W, body,
          [btn("Create worksets (dry run)", True), btn("Assign"), btn("Refresh"), btn("Sync reminder")], "7 people · 4 models", dialogs="".join(dl))
board("PaneWorkshare.dc.html", "Workshare pane", "Pane · Workshare",
      "Who is in which model, on which workset, and who needs to sync",
      "Track the discipline models and the people in them, give each person a modelling role, set up worksets in one go and assign people to them, and see who has unsynced work, so review items reach the right person.",
      ws,
      [("Discipline models", "Table", "Each model, its central, who is in it, last sync", "MAN 7.2"),
       ("People and roles", "Table + Add", "Role and competency level per discipline", "MAN 2.5, 18.2"),
       ("Worksets", "Table per model", "Workset, assigned people, who is editing", "MAN 9.10"),
       ("New workset", "Name + people", "Name checked to [Role]_[Content]", "MAN 4.6"),
       ("Create the standard set", "Button", "Z_Grids_Levels, Z_Links_<Role>, <Role>_Shell, _Interior, _Site", "MAN 9.10"),
       ("Hold for coordinator", "Button", "Coordinator owns a workset so others cannot edit it", "—"),
       ("Team activity", "Table", "Time since sync, unsynced changes, borrowed elements", "MAN 14.5"),
       ("Sync reminders", "Checkboxes", "Nudges before work is lost", "—"),
       ("Sync preflight", "Checklist + queue", "Known problems before a sync; advice, not a guarantee", "—"),
       ("Scheduled sync", "Locked switch, set in Admin", "Timed sync after a passing preflight, with a 60-second notice", "Roadmap: automation"),
       ("Sync message", "Revision, items, text", "Fixed format: project | role | revision | items | new | what | who", "Proposed"),
       ("Sync with this message", "Button, people only", "Syncs with the message after the safety check; Claude can never press it", "CLM 6"),
       ("Link to reviews", "Checkboxes", "Routes review items to assigned people", "—"),
       ("Runs on shared models", "Switch on Connect pane", "Setup tools need Claude in shared models on; Claude never syncs", "D1, CLM 6 (amended)")],
      callout("Assignment, not permission", "Revit worksets can't be locked to named people. The plugin gives you the next best thing: a register of who should work where, a warning to anyone outside it before they edit, and the option for the coordinator to hold a workset.")
      + callout("Activity, not ranking", "Your Manual (14.5) retired per-person volume counts because they reward speed over care. This view shows who is active and who has unsynced work, so the team can help each other, never a league table."), script=("sel: 'A'", WS_SCRIPT.split("renderVals() {", 1)[1].rsplit("}", 2)[0]))

# ======================= REVIEW =======================
body = (group("Add a review item",
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Add revision", True, msg="Drag a box on the view: the revision note opens beside the cloud, in the drawing (see the 'Revision on the drawing' board).") + btn("Add on selected elements") + '</div>',
              note("Click Add revision, then drag a box on the view. The plugin draws the revision cloud and opens this form.", I),
              ro("Cloud goes on", "Open review revision 'Review 07' · not issued, so clouds can be added", mono=False),
              seg("Type", ["Observation", "Instruction", "Query", "Clash"], 0),
              inp("Title", "Beam B12 too deep for the corridor ceiling at C/4"),
              ta("What you see, and what must change", "The 600 mm downstand leaves 2.25 m clear in the corridor. Needs a shallower beam or a local ceiling drop.", rows=3),
              chips("Disciplines affected (pick several)", ["A", "I", "S", "M", "E", "P", "FP", "C", "L"], {"A", "S"}),
              sel("Lead discipline (owns the fix)", ["S · Structure", "A · Architecture", "M · Mechanical", "E · Electrical", "P · Plumbing"], 0),
              sel("Owner (one person)", ["[NAME F] · Structure lead", "[NAME A] · Architecture lead", "[NAME E] · BIM Coordinator"], 0),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Priority", ["High", "Critical", "Medium", "Low"], 0) + inp("Due (required)", "2026-10-20", mono=True) + '</div>',
              checks("", [("Save a view snapshot", True), ("Link the elements inside the box", True, "3 found", I)])),
        group("Review register",
              seg("Show", ["My discipline", "All", "Overdue", "Closed"], 1),
              tbl("", ["ID", "Title", "Owner", "Due", "Status"],
                  [["ISS-0014", "Beam vs ceiling, C/4", "[NAME F]", "20 Oct", ("In progress", W)], ["ISS-0013", "Door swing into corridor", "[NAME A]", "22 Oct", ("Open", I)],
                   ["ISS-0012", "Riser too small, core 2", "[NAME G]", "18 Oct", ("Resolved", G)], ["ISS-0011", "Fire door rating, stair 1", "[NAME A]", "11 Oct", ("Overdue", B)]],
                  ["60px", "1fr", "58px", "44px", "70px"])),
        group("Selected: F26001-ISS-0014",
              tbl("Answers by discipline", ["Discipline", "Answer", "Status"],
                  [["S (lead)", "Beam cut to 450 mm deep", ("Done", G)], ["A", "Ceiling kept at 2.40 m", ("Done", G)]],
                  ["64px", "1fr", "60px"]),
              ta("Solution: what you changed", "Beam B12 reduced to 450 mm deep, approved by the structural engineer. Corridor clear height is now 2.40 m.", rows=3),
              drop("Before and after", "Snapshots taken automatically", "Same box, before and after the fix"),
              checks("", [("Link the changed elements", True, "2 linked", I)]),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Mark done and notify", True, opens="d_notify") + btn("Ask a question back") + btn("Go to cloud") + '</div>',
              note("Notifies the person who raised it and every affected discipline.", I)),
        group("Raiser's check",
              seg("Your verdict", ["Accept and close", "Reopen"], 0),
              inp("Comment", "", "Optional: why you reopened it")),
        group("Prints of this sheet",
              ro("Sheet", "A-1001 · Ground floor plan", mono=False),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Print for review", opens="d_print") + btn("Print as revised", True, opens="d_print") + '</div>',
              tbl("Print history", ["Date", "Print", "Rev", "Items"],
                  [["20 Oct", ("Revised", G), "P02", "3 done"], ["13 Oct", ("For review", W), "P02", "3 open"], ["06 Oct", ("Issue", GR), "P01", "—"]],
                  ["52px", "1fr", "40px", "56px"]),
              note("Every print is saved as a PDF with its list of items, so you can always see what a sheet looked like and why it changed.", I)),
        group("Issue",
              checks("", [("Clouds show on each sheet's revision schedule", True), ("Import BCF from consultants", True, "Phase 2", GR), ("Export BCF", True, "Phase 2", GR),
                          ("Raise a change request (cost, time or scope)", False, "Manual 16.5", W)]),
              note("Codes stay separate: company revision (P02), Revit revision, sheet status and approval.", GR)),
        author("e.g. 'Structural items also go to the engineer of record. Plain words, no abbreviations.'"))
dl = (dialog("d_notify", "Mark done and notify",
              ro("Item", "F26001-ISS-0014 · Beam vs ceiling, C/4", mono=False),
              checks("Notify", [("[NAME A] · raised it", True), ("Structure (lead)", True), ("Architecture", True), ("BIM Coordinator", False)]),
              ro("Message", "ISS-0014 done: beam B12 reduced to 450 mm; corridor clear height 2.40 m. Please check and accept.", mono=False),
              primary="Send", done_msg="Done and notified. Waiting for the raiser's check."),
      dialog("d_print", "Print sheets",
              seg("Print", ["For review", "As revised"], 0),
              chips("Sheets", ["A-1001", "A-1002", "A-3001", "S-1001"], {"A-1001"}),
              checks("Include", [("List of items on the sheet", True), ("Solutions and who accepted them", False), ("Before and after snapshots", False)]),
              sel("Paper", ["A3 reduced", "A1 full size"], 0),
              ro("Saved to", "06_QA\\Reviews\\A-1001\\<date>_<print>\\"),
              primary="Print", done_msg="Print saved and logged in the sheet's print history."),
      dialog("d_sum", "Review summary",
              ro("This week", "4 open items: 2 architectural, 1 structural lead, 1 fire. ISS-0014 is solved and waiting for the raiser. ISS-0011 (fire door rating) is overdue by 2 days.", mono=False),
              checks("Suggested next steps", [("Chase ISS-0011 with the fire lead", True), ("Close ISS-0012 after the raiser's check", True)]),
              primary="Copy summary", done_msg="Summary copied.", ai=True))
rv = pane("Review", WIP, G, body, [btn("Add revision", True, msg="Drag a box on the view: the revision note opens beside the cloud, in the drawing."), btn("Summarise", ai=True, opens="d_sum"), btn("BCF · P2"), btn("Register")], "4 open", dialogs="".join(dl))
board("PaneReview.dc.html", "Review pane", "Pane · Revisions and reviews",
      "Mark it on the drawing, say what is wrong, call in every discipline it touches",
      "Click Add revision, drag a box, write what you see. The plugin draws the revision cloud, files the item in the project's review register, and asks each affected discipline to answer.",
      rv,
      [("Add revision", "Button + drag a box", "A Revit revision cloud on the active view", "MAN 9.11"),
       ("Cloud goes on", "Read-only", "An open review revision: Revit only allows clouds on unissued revisions", "Revit API"),
       ("Owner, due date", "Person, date (required)", "One owner and a due date per item", "MAN 10.5"),
       ("Disciplines affected", "Chips, several", "Every discipline that must answer", "—"),
       ("Lead discipline", "Dropdown", "One owner per item, as the Manual asks", "MAN 10.5"),
       ("Priority", "Dropdown", "Default: Critical 3 working days, High 1 week", "MAN 10.5"),
       ("BCF", "Import, export · Phase 2", "Open format for consultants on other tools", "Review"),
       ("Review register", "Table with filters", "The project's review database", "MAN 10.5"),
       ("Answers, solution", "Per discipline + text + snapshots", "What the solver changed; notifies the raiser and disciplines", "—"),
       ("Raiser's check", "Accept or reopen", "Resolved by the solver, closed after the check", "MAN 10.5"),
       ("Print for review / as revised", "Two buttons", "PDF of open items to fix, or of closed items with solutions", "MAN 9.14"),
       ("Print history", "Table per sheet", "Every print, its revision and its items", "—"),
       ("Change request", "Checkbox", "Required when cost, time or scope change", "MAN 16.5")],
      '<div style="display: flex; gap: 0; align-items: stretch">' + "".join(
          f'<div style="flex: 1; padding: 8px 10px; background: {"#1B2532" if k == 0 else "#FFFFFF"}; color: {"#FFFFFF" if k == 0 else INK}; border: 1px solid #DDE1E6; '
          f'{"border-radius: 8px 0 0 8px;" if k == 0 else ("border-radius: 0 8px 8px 0;" if k == 4 else "")} border-left-width: {1 if k == 0 else 0}px">'
          f'<div style="font-size: 13.5px; font-weight: 600">{E(a)}</div><div style="margin-top: 2px; font-size: 12px; line-height: 1.4; color: {"#D5D9DF" if k == 0 else "#3B424D"}">{E(b)}</div></div>'
          for k, (a, b) in enumerate([("Raised", "Cloud drawn; print for review"), ("Assigned", "Lead + affected disciplines"),
                                      ("Solved", "Solution written; people notified"), ("Checked", "Raiser accepts or reopens"), ("Closed", "Shown on the revised print")])) + '</div>'
      + callout("One owner, many voices", "Your Manual gives every issue one owner. So each item has a lead discipline that owns the fix, and the other affected disciplines are called in to answer. An architect can flag a structural problem and pull in Structure as lead, with Architecture answering too.")
      + callout("Where the register lives", "A row per item in the project's review register (proposed: 06_QA\\Reviews), also stored on its cloud, so drawing and register always match."))

# ======================= REVIEW ON SHEET =======================
def scallops(x0, y0, w, h, r=14):
    nx, ny = max(1, round(w / (2 * r))), max(1, round(h / (2 * r)))
    sx, sy = w / nx, h / ny
    d = [f"M{x0} {y0}"]
    d += [f"a{sx/2:.1f} {sx/2:.1f} 0 0 1 {sx:.1f} 0" for _ in range(nx)]
    d += [f"a{sy/2:.1f} {sy/2:.1f} 0 0 1 0 {sy:.1f}" for _ in range(ny)]
    d += [f"a{sx/2:.1f} {sx/2:.1f} 0 0 1 {-sx:.1f} 0" for _ in range(nx)]
    d += [f"a{sy/2:.1f} {sy/2:.1f} 0 0 1 0 {-sy:.1f}" for _ in range(ny)]
    return " ".join(d) + " Z"

cloud = scallops(300, 200, 196, 140)
plan = (
    '<svg width="760" height="560" viewBox="0 0 760 560" role="img" aria-label="Sheet with a revision cloud around a beam over the corridor">'
    '<g stroke="#C9CED6" stroke-width="1" stroke-dasharray="6 4">'
    + "".join(f'<line x1="{x}" y1="40" x2="{x}" y2="520"></line>' for x in (120, 280, 440, 600))
    + "".join(f'<line x1="60" y1="{y}" x2="700" y2="{y}"></line>' for y in (100, 260, 420))
    + '</g><g fill="none" stroke="#3B424D" stroke-width="5">'
    '<rect x="120" y="100" width="480" height="320"></rect><line x1="280" y1="100" x2="280" y2="420"></line><line x1="120" y1="260" x2="600" y2="260"></line>'
    '</g><g fill="none" stroke="#3B424D" stroke-width="2"><line x1="280" y1="230" x2="600" y2="230"></line><line x1="280" y1="290" x2="600" y2="290"></line></g>'
    '<line x1="440" y1="100" x2="440" y2="420" stroke="#8A919C" stroke-width="3" stroke-dasharray="14 6"></line>'
    '<text x="452" y="160" font-size="12" fill="#5B6270">B12 600 deep</text><text x="300" y="250" font-size="12" fill="#5B6270">Corridor</text>'
    + "".join(f'<g><circle cx="{x}" cy="24" r="12" fill="#FFFFFF" stroke="#8A919C"></circle><text x="{x}" y="28" font-size="11" text-anchor="middle" fill="#3B424D">{t}</text></g>' for x, t in ((120, "A"), (280, "B"), (440, "C"), (600, "D")))
    + f'<path d="{cloud}" fill="none" stroke="#D93025" stroke-width="2.5"></path>'
    '<path d="M512 196 L528 168 L544 196 Z" fill="#FFFFFF" stroke="#D93025" stroke-width="2"></path><text x="528" y="191" font-size="12" font-weight="700" text-anchor="middle" fill="#D93025">2</text>'
    '<line x1="544" y1="186" x2="566" y2="170" stroke="#D93025" stroke-width="1.5"></line>'
    '</svg>')
pop = ('<div style="position: absolute; left: 584px; top: 60px; width: 236px; background: #FFFFFF; border: 1px solid ' + LINE + '; border-radius: 8px; box-shadow: 0 12px 32px rgba(26,29,33,0.16); overflow: hidden; font-size: 12.5px">'
       '<div style="padding: 8px 10px; background: #F1F3F5; font-weight: 600; display: flex; align-items: center; gap: 6px"><span style="color: #D93025">▲2</span> New review item · Review 07</div>'
       '<div style="height: 2px; background: ' + ORANGE + '"></div>'
       '<div style="padding: 10px; display: flex; flex-direction: column; gap: 8px">'
       + sel("Type", ["Observation", "Instruction", "Query", "Clash"], 0)
       + inp("Title", "Beam B12 too deep for the corridor ceiling")
       + ta("What must change", "Clear height drops to 2.25 m. Shallower beam or local ceiling drop.", rows=2)
       + chips("Disciplines", ["A", "S", "M", "E", "P"], {"A", "S"})
       + sel("Lead", ["S · Structure", "A · Architecture"], 0)
       + '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px">' + sel("Owner", ["[NAME F]", "[NAME A]"], 0) + inp("Due", "20 Oct", mono=True) + '</div>'
       + '<div style="display: flex; gap: 6px">' + btn("Save", True) + btn("Save + notify") + '</div></div></div>')
steps = "".join(f'<div style="display: flex; gap: 12px"><span style="width: 30px; height: 30px; flex-shrink: 0; border-radius: 50%; background: {NAVY}; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-weight: 700">{k}</span>'
                f'<div><div style="font-size: 17px; font-weight: 600">{E(a)}</div><div style="margin-top: 2px; font-size: 14px; line-height: 1.5; color: #3B424D">{E(b)}</div></div></div>'
                for k, (a, b) in enumerate([("Click Add revision", "In the Review section of the pane, or right-click on the view."),
                                            ("Drag a box on the drawing", "Works on a sheet or a view. The cloud goes on the open review revision: Revit allows clouds only on revisions not yet issued."),
                                            ("Write what you see", "Type, title, what must change. Elements inside the box are linked."),
                                            ("Call in the disciplines", "Pick every discipline it touches, one lead, one owner and a due date."),
                                            ("Answer and close", "Each discipline answers, the lead checks the model, the item closes and shows on the next issue.")], 1))
page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Revision on the drawing</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{{margin:0}}
a{{color:{NAVY}}}a:hover{{color:#2C6B63}}
</style>
</helmet>
<div style="position: relative; width: 1440px; height: 960px; box-sizing: border-box; padding: 48px 56px 40px; background: #F6F7F9; color: {INK}; font-family: 'IBM Plex Sans', sans-serif; display: flex; gap: 44px">
  <img src="{LOGO}" alt="Formcraft Design &amp; Construction" style="position: absolute; top: 12px; right: 24px; height: 22px; width: auto">
  <div style="position: relative; width: 920px; flex-shrink: 0; background: #FFFFFF; border: 1px solid {LINE}; border-radius: 8px; box-shadow: 0 12px 32px rgba(26,29,33,0.10); overflow: hidden">
    <div style="height: 32px; display: flex; align-items: center; gap: 10px; padding: 0 12px; background: #F1F3F5; border-bottom: 1px solid #D5D9DF; font-size: 12.5px">
      <span style="font-weight: 600">A-1001 · Ground floor plan</span><span style="color: {MUTED}">Sheet view</span>
      <span style="margin-left: auto; padding: 2px 8px; border-radius: 10px; background: {CHIP["warn"][0]}; color: {CHIP["warn"][1]}; font-size: 11px">Drag a box to place the cloud</span>
    </div>
    <div style="padding: 12px 20px">{plan}</div>
    {pop}
    <div style="position: absolute; right: 0; top: 32px; bottom: 0; width: 96px; border-left: 2px solid #3B424D; background: #FBFBFC; display: flex; flex-direction: column; justify-content: flex-end; padding: 10px; box-sizing: border-box; gap: 6px; font-size: 10.5px; color: #3B424D">
      <div style="font-weight: 600">Revisions</div><div>P01 · first issue</div><div style="color: #D93025">Review 07 · ▲2 beam C/4</div>
      <div style="margin-top: 8px; border-top: 1px solid #C9CED6; padding-top: 6px">FMC_TitleBlock</div>
    </div>
  </div>
  <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 20px; padding-top: 4px">
    <div>
      <div style="{MONO}; font-size: 15px; letter-spacing: 2px; text-transform: uppercase; color: #4A515C">Revisions and reviews</div>
      <h2 style="margin: 10px 0 0; font-size: 34px; line-height: 1.1; font-weight: 700; letter-spacing: -1px">Five clicks from seeing a problem to a tracked, shared item</h2>
    </div>
    {steps}
    <div style="margin-top: auto; {MONO}; font-size: 12px; color: {MUTED}">Planned design. Drawing and values are samples.</div>
  </div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":960}}}}'>
{take_script()}
</script>
</body>
</html>
'''
(ROOT / "ReviewOnSheet.dc.html").write_text(page, encoding="utf-8")

# ======================= SHEET PRINTS =======================
def mini_plan(color, tags, done):
    clouds = [(110, 70, 110, 80), (240, 190, 100, 70), (40, 200, 80, 70)]
    out = ['<svg width="440" height="330" viewBox="0 0 440 330" role="img" aria-label="Plan with three revision clouds">',
           '<g fill="none" stroke="#3B424D" stroke-width="4"><rect x="20" y="20" width="400" height="290"></rect><line x1="160" y1="20" x2="160" y2="310"></line><line x1="20" y1="170" x2="420" y2="170"></line></g>',
           '<g fill="none" stroke="#3B424D" stroke-width="1.5"><line x1="160" y1="150" x2="420" y2="150"></line><line x1="160" y1="190" x2="420" y2="190"></line></g>']
    for k, (x, y, w, h) in enumerate(clouds, 1):
        out.append(f'<path d="{scallops(x, y, w, h, 10)}" fill="none" stroke="{color}" stroke-width="2"></path>')
        tx, ty = x + w + 4, y - 6
        if done:
            out.append(f'<circle cx="{tx + 9}" cy="{ty + 8}" r="9" fill="#E6F4EA" stroke="#1E6B34" stroke-width="1.5"></circle>'
                       f'<path d="M{tx + 4} {ty + 8} l3 3 l6 -6" fill="none" stroke="#1E6B34" stroke-width="2"></path>')
        else:
            out.append(f'<path d="M{tx} {ty + 16} L{tx + 9} {ty} L{tx + 18} {ty + 16} Z" fill="#FFFFFF" stroke="{color}" stroke-width="1.5"></path>'
                       f'<text x="{tx + 9}" y="{ty + 14}" font-size="10" font-weight="700" text-anchor="middle" fill="{color}">{k}</text>')
    out.append('</svg>')
    return "".join(out)

def printed(stamp, stamp_bg, stamp_fg, color, done, heading, items):
    lis = "".join(f'<li style="margin-bottom: 6px"><b>{k}</b> {E(t)}<div style="color: {MUTED}">{E(m)}</div></li>' for k, (t, m) in enumerate(items, 1))
    return (f'<div style="width: 640px; height: 430px; flex-shrink: 0; background: #FFFFFF; border: 1px solid {LINE}; box-shadow: 0 8px 24px rgba(26,29,33,0.10); display: flex; position: relative">'
            f'<div style="flex: 1; padding: 20px 10px 10px">{mini_plan(color, None, done)}</div>'
            f'<div style="width: 170px; border-left: 2px solid #3B424D; padding: 10px; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; font-size: 10.5px; line-height: 1.35; color: #3B424D">'
            f'<div style="padding: 5px 6px; border-radius: 3px; background: {stamp_bg}; color: {stamp_fg}; font-weight: 700; font-size: 11px; letter-spacing: 1px; text-align: center">{E(stamp)}</div>'
            f'<div style="font-weight: 600; color: {INK}">{E(heading)}</div><ol style="margin: 0; padding-left: 0; list-style: none">{lis}</ol>'
            f'<div style="margin-top: auto; border-top: 1px solid {LINE}; padding-top: 6px">A-1001 · Ground floor plan<br>FMC_TitleBlock</div></div></div>')

open_items = [("Beam B12 too deep at C/4", "S lead · A"), ("Door swings into corridor", "A"), ("Riser too small, core 2", "M lead · P")]
done_items = [("Beam cut to 450 mm", "S · 20 Oct · accepted"), ("Door re-hung to swing in", "A · 18 Oct · accepted"), ("Riser widened to 900 mm", "M · 19 Oct · accepted")]
left = printed("FOR REVIEW · P02", CHIP["warn"][0], CHIP["warn"][1], "#D93025", False, "Items to fix", open_items)
right = printed("REVISED · P02", CHIP["good"][0], CHIP["good"][1], "#8A919C", True, "Changes made", done_items)
hist_rows = [("20 Oct", "Revised", G, "P02", "3 closed", "PIM"), ("13 Oct", "For review", W, "P02", "3 open", "Design Lead"), ("06 Oct", "Issue", GR, "P01", "—", "PIM")]
hist = "".join(f'<tr><td style="padding: 6px 8px; border-top: 1px solid #E3E6EA">{a}</td><td style="padding: 6px 8px; border-top: 1px solid #E3E6EA"><span style="font-size: 11.5px; padding: 1px 8px; border-radius: 9px; background: {CHIP[k][0]}; color: {CHIP[k][1]}">{b}</span></td>'
               f'<td style="padding: 6px 8px; border-top: 1px solid #E3E6EA; {MONO}; font-size: 12px">{c}</td><td style="padding: 6px 8px; border-top: 1px solid #E3E6EA">{d}</td><td style="padding: 6px 8px; border-top: 1px solid #E3E6EA">{e}</td>'
               f'<td style="padding: 6px 8px; border-top: 1px solid #E3E6EA; {MONO}; font-size: 11.5px; color: #2C6B63">06_QA\\Reviews\\A-1001\\{a.replace(" ", "")}_{b.replace(" ", "")}\\F26001-FMC-ZZ-00-DR-A-1001.pdf</td></tr>'
               for a, b, k, c, d, e in hist_rows)
page = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sheet prints</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{{margin:0}}
a{{color:{NAVY}}}a:hover{{color:#2C6B63}}
</style>
</helmet>
<div style="position: relative; width: 1440px; height: 960px; box-sizing: border-box; padding: 40px 56px; background: #F6F7F9; color: {INK}; font-family: 'IBM Plex Sans', sans-serif; display: flex; flex-direction: column; gap: 18px">
  <img src="{LOGO}" alt="Formcraft Design &amp; Construction" style="position: absolute; top: 12px; right: 24px; height: 22px; width: auto">
  <div>
    <div style="{MONO}; font-size: 15px; letter-spacing: 2px; text-transform: uppercase; color: #4A515C">Revisions and reviews · sheet prints</div>
    <h2 style="margin: 8px 0 0; font-size: 34px; line-height: 1.08; font-weight: 700; letter-spacing: -1px">Every sheet keeps two kinds of print: what to change, and what was changed</h2>
  </div>
  <div style="display: flex; gap: 48px">
    <div style="display: flex; flex-direction: column; gap: 8px">{left}<div style="font-size: 14px; line-height: 1.45; color: #3B424D"><b>Print for review.</b> Open clouds in red, numbered, with the list of what to fix and who owns it.</div></div>
    <div style="display: flex; flex-direction: column; gap: 8px">{right}<div style="font-size: 14px; line-height: 1.45; color: #3B424D"><b>Print as revised.</b> The same clouds ticked off, each with the solution, who did it and when it was accepted.</div></div>
  </div>
  <table style="width: 100%; border-collapse: collapse; font-size: 13px; background: #FFFFFF; border: 1px solid #DDE1E6">
    <thead><tr style="text-align: left; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: {MUTED}"><th style="padding: 7px 8px">Date</th><th style="padding: 7px 8px">Print</th><th style="padding: 7px 8px">Revision</th><th style="padding: 7px 8px">Items</th><th style="padding: 7px 8px">Printed by</th><th style="padding: 7px 8px">Saved as</th></tr></thead>
    <tbody>{hist}</tbody>
  </table>
  <div style="margin-top: auto; {MONO}; font-size: 12px; color: {MUTED}">Planned design. The file keeps its container name (Manual 4.1); revision and print type travel as metadata and in the title block. Paths, dates and items are samples.</div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":960}}}}'>
class Component extends DCLogic {{
renderVals() {{
return {{}};
}}
}}
</script>
</body>
</html>
'''
(ROOT / "SheetPrints.dc.html").write_text(page, encoding="utf-8")

# ======================= READY TO ISSUE =======================
body = (group("This issue",
              seg("Issue set", ["PERMIT", "TENDER", "CONSTRUCTION", "RECORD"], 2),
              sel("Purpose", ["For construction", "For approval", "For information"], 0),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + ro("Company revision", "C02") + ro("Revit revision", "Seq 4 · open") + ro("Sheet status", "A1") + ro("Approval", "Waiting: M lead", mono=False) + '</div>',
              chips("Disciplines", ["Z", "A", "S", "M", "E", "P"], {"Z", "A", "S", "M"}),
              note("Five separate fields, never merged: company revision, Revit revision, status, purpose, approval.", GR)),
        group("Result",
              '<div role="status" style="display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 6px; background: #FDECEA; color: #A50E0E">'
              '<span style="font-size: 18px; font-weight: 700">Blocked</span><span style="font-size: 12px; line-height: 1.4">2 mandatory rules fail on M-1001. Fix them, or record an approved exception.</span></div>',
              ro("Checked against", "Rulebooks v0.2 · FMC-BIM v2.2 · 13 Oct 14:20", mono=False)),
        group("Checklist",
              checks("", [("Sheets exist with valid numbers", True, "18 / 18", G), ("Title blocks filled", True, "17 / 18", W),
                          ("Mandatory rules pass", True, "2 fail", B), ("Open reviews on these sheets", True, "1, excepted", W),
                          ("Links and coordinates checked", True, "OK", G), ("Revision, status and purpose valid", True, "OK", G),
                          ("Approvals recorded", True, "3 of 4", W)])),
        group("Sheets in this issue",
              tbl("", ["Sheet", "Name", "Status"],
                  [("Z-0001", "Sheet index", ("Ready", G)), ("A-1001", "GA ground floor", ("Ready", G)), ("A-2001", "Elevations", ("Exception", W)),
                   ("S-1001", "Foundation plan", ("Ready", G)), ("M-1001", "Ventilation L00", ("Blocked", B))], ["60px", "1fr", "78px"]),
              note("Click a row, then Zoom to see the sheet; failing items open in the results list.", GR)),
        group("Approved exceptions",
              tbl("", ["Sheet", "Why", "Approved"], [("A-2001", "ISS-0014 open: façade colour", "[NAME A] · until C03")], ["60px", "1fr", "110px"]),
              '<div style="display: flex; gap: 6px">' + btn("Record exception…", opens="d_exc") + '</div>'),
        group("Issue manifest",
              checks("Outputs", [("PDF per sheet, named by container name", True), ("Drawing register (CSV)", True), ("Transmittal sheet", True), ("DWG", False), ("IFC of the models", False)]),
              inp("Send to", "", "Client, consultants (names or emails)"),
              ro("Written to", "01_WIP\\_Issue\\2026-10-13_C02 · you move it to 03_Published after authorisation", mono=False)),
        author("e.g. 'Construction issues: all four leads sign. Permit issues: architect only.'"))
dl = (dialog("d_exc", "Record an exception",
              sel("Item", ["A-2001 · open review ISS-0014", "A-1002 · title block field empty", "M-1001 · SHT-019 status"], 0),
              ta("Why it can go out anyway", "", "e.g. façade colour agreed by phone; drawing note added", rows=2),
              sel("Approved by", ["[NAME A] · Admin", "[NAME F] · Lead S"], 0),
              inp("Review by", "", "e.g. next revision C03"),
              note("Exceptions are listed on the readiness report and the transmittal.", I),
              primary="Record exception", done_msg="Exception recorded (sample); result recalculated."),
      dialog("d_report", "Readiness report",
              ro("Issue", "F26001 · CONSTRUCTION · C02 · 18 sheets", mono=False),
              checks("Ran", [("41 checks ran", True, "36 pass", G), ("2 failed", True, "M-1001", B), ("3 not applicable", True, "", GR), ("0 skipped", True, "", G)]),
              ro("Exceptions", "1 (A-2001, approved by [NAME A])", mono=False),
              note("Saved to 06_QA\\Issue with the rulebook version, so anyone can see later why this issue was allowed.", I),
              primary="Save report", done_msg="Readiness report saved to 06_QA (sample)."),
      dialog("d_issue", "Issue C02",
              ro("Result", "Ready with approved exceptions (after the M-1001 fix)", mono=False),
              ro("Sheets", "18 · PDF + register + transmittal", mono=False),
              toggle("Lock the Revit revision as issued", True, "Clouds can then no longer be added to it"),
              note("Files go to 01_WIP\\_Issue. A person moves them to 03_Published after authorisation; the plugin never writes there.", W),
              primary="Issue (dry run first)", done_msg="Dry run: 18 PDFs, register and transmittal ready to write."))
iss = pane("Issue", "Sheet set · CONSTRUCTION · C02", G, body,
           [btn("Run check", True), btn("Report", opens="d_report"), btn("Issue…", opens="d_issue")], "Blocked · 2 to fix", dialogs="".join(dl))
board("PaneIssue.dc.html", "Ready to issue pane", "Pane · Ready to issue",
      "One check before anything leaves the office: ready, ready with exceptions, or blocked",
      "Pick the issue set and purpose. The plugin checks every sheet against the rulebooks, open reviews, links and approvals, then writes an issue manifest and a readiness report you can show later.",
      iss,
      [("Issue set, purpose", "Tabs, dropdown", "PERMIT, TENDER, CONSTRUCTION, RECORD", "STD 2.4"),
       ("Codes", "Read-only fields", "Company revision, Revit revision, status, purpose, approval kept apart", "MAN 4.4"),
       ("Result", "Banner", "Ready, ready with approved exceptions, or blocked", "Review: readiness gate"),
       ("Checklist", "Checks", "Sheets, title blocks, mandatory rules, reviews, links, approvals", "Rulebooks"),
       ("Sheets", "Table, zoom", "Each sheet's state; click to see it", "—"),
       ("Exceptions", "Table + Record", "Who approved, why, until when", "Review: exceptions"),
       ("Issue manifest", "Outputs, recipients", "PDF by container name, register, transmittal", "MAN 9.11, 9.14"),
       ("Issue", "Button, dry run", "Writes to 01_WIP\\_Issue; people publish", "CLM 2")],
      callout("Why this matters", "All three outside reviews named a readiness check as the missing piece. It ties setup, rules, QA, sheets and reviews into one decision you can defend to a client later."))

# ======================= REPORTS =======================
body = (group("Make a report",
              sel("Report", ["Weekly project report", "Model health and QA", "Review register", "Sheet and issue status", "Sync log and workshare",
                             "Quantities (QTO) and BoQ export", "Ready to issue record", "Rule exceptions", "Activity log"], 0),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Project", ["F26001 Pilot", "F25014 Clinic"], 0) + sel("Period", ["Last 7 days", "Since last issue", "This month", "Whole project"], 0) + '</div>',
              chips("Disciplines", ["Z", "A", "S", "M", "E", "P"], {"Z", "A", "S", "M"}),
              seg("For", ["Team", "Client", "BIM Manager"], 1, hint="Client reports leave out names, logs and internal notes.")),
        group("What goes in · Weekly project report",
              checks("", [("Summary: what changed this week", True), ("QA results and trend (new, recurring, resolved)", True), ("Open review items by owner and due date", True),
                          ("Sheets: planned vs made, issue status", True), ("Syncs per model (counts, not people)", True), ("Ready to issue status", True),
                          ("Quantities from the QTO export", False), ("Rule exceptions in force", False)]),
              note("Every number comes from a saved file in 06_QA or 07_Cost with its date, so the report can be traced.", I)),
        group("Look and format",
              checks("Formats", [("PDF (branded)", True), ("Excel workbook", True), ("CSV for Power BI", False), ("Markdown for the project log", False)]),
              sel("Brand pack", ["Formcraft (internal)", "[CLIENT A] brand pack"], 0),
              sel("Cover", ["Formcraft lockup + project image", "Plain"], 0),
              ro("File name", "F26001-FMC-ZZ-ZZ-RP-Z-0007.pdf · from the container rules")),
        group("Send and schedule",
              inp("Send to", "", "Client, consultants, team (names or emails)"),
              toggle("Make it every week", True, "Fridays 16:00, after the last scheduled sync"),
              ro("Saved to", "06_QA\\Reports\\2026-10-16", mono=False),
              note("Scheduled reports run while Revit is open on the BIM manager's computer. Overnight runs without Revit are deferred.", GR)),
        group("Recent reports",
              tbl("", ["Report", "Date", "Status"],
                  [["Weekly project report", "09 Oct", ("Sent", G)], ["Model health and QA", "13 Oct", ("Saved", I)], ["Ready to issue record · C01", "02 Oct", ("Saved", I)],
                   ["Review register (client)", "06 Oct", ("Sent", G)]], ["1fr", "56px", "64px"])),
        group("Summary in plain words · Phase 2",
              ro("AI summary", "Claude writes the opening paragraph from the report's own numbers; you edit it before it is sent.", mono=False)),
        author("e.g. 'Client reports in plain English, no rule IDs. Put open structural items first.'"))
dl = (dialog("d_rprev", "Preview · Weekly project report",
              ro("Cover", "F26001 Pilot · Weekly report 16 Oct 2026 · for the client", mono=False),
              tbl("Contents", ["Section", "Source"], [["Summary", "This page"], ["QA: 2 Must, trend down", "06_QA\\Health"], ["7 open review items, 1 overdue", "Review register"],
                  ["Sheets: 54 of 61 made", "Sheet register"], ["Ready to issue C02: blocked", "06_QA\\Issue"]], ["1fr", "120px"]),
              note("Names, logs and internal notes are left out of client reports.", I),
              primary="Make PDF and Excel", done_msg="F26001-FMC-ZZ-ZZ-RP-Z-0007 saved to 06_QA\\Reports (sample)."),
      dialog("d_rnew", "New report template",
              inp("Name", "", "e.g. Monthly cost report"),
              chips("Sections", ["Summary", "QA", "Reviews", "Sheets", "Syncs", "Quantities", "Issue status", "Exceptions"], {"Summary", "Quantities"}),
              seg("For", ["Team", "Client", "BIM Manager"], 1),
              primary="Save template", done_msg="Report template saved (sample)."))
rp = pane("Reports", WIP, G, body, [btn("Preview", opens="d_rprev"), btn("Make report", True, opens="d_rprev"), btn("New template", opens="d_rnew")], "Next: Fri 16:00", dialogs="".join(dl))
board("PaneReports.dc.html", "Reports pane", "Pane · Reports",
      "One-click reports for the team, the client and the BIM manager, traced to their sources",
      "Pick a report, a period and who it is for. The plugin gathers QA, reviews, sheets, syncs, quantities and issue records, brands it, names it by the container rules, and can send it every week.",
      rp,
      [("Report", "Dropdown", "Weekly, health, reviews, sheets, syncs, quantities, issue record, exceptions, activity", "MAN 13, 14"),
       ("Project, period, disciplines", "Dropdowns, chips", "What the report covers", "—"),
       ("For", "Segmented", "Client reports leave out names, logs and internal notes", "MAN 14.5"),
       ("What goes in", "Checks", "Sections; every number traced to a dated file", "MAN 13.1"),
       ("Formats", "Checks", "Branded PDF, Excel, CSV for Power BI, Markdown", "MAN 13"),
       ("File name", "Read-only", "Report container name, e.g. …-RP-Z-0007", "MAN 4.1"),
       ("Schedule", "Switch", "Weekly while Revit is open; overnight runs deferred", "Roadmap"),
       ("AI summary", "Phase 2", "Opening paragraph from the report's own numbers, edited by you", "ClaudeUse")],
      callout("Traceable, not decorative", "Your Manual's dashboards read only validated files with a date. Reports follow the same rule, and the CSV option feeds the Power BI model directly.")
      + callout("Counts, not people", "Sync and activity sections count work per model and discipline, never rank people (Manual 14.5)."))

# ======================= SCRIPTS =======================
body = (group("Script library",
              seg("Show", ["All (12)", "Approved", "Testing", "Retired"], 0),
              tbl("", ["Script", "Type", "Class", "Status"],
                  [["FMC_CreateSheetsFromRegister", "pyRevit", ("Setup", W), ("Approved", G)], ["FMC_SheetQA", "pyRevit", ("Read", G), ("Approved", G)],
                   ["FMC_ModelHealth", "Dynamo", ("Read", G), ("Testing", I)], ["FMC_BindSharedParameters", "Dynamo", ("Setup", W), ("Testing", I)],
                   ["FMC_SyncMasterData", "Dynamo", ("Setup", W), ("Testing", I)], ["FMC_ExportQTO", "Dynamo", ("Read", G), ("Approved", G)],
                   ["FMC_UpdateProjectMetrics", "pyRevit", ("Setup", W), ("Testing", I)], ["FMC_SyncLinkedLoads", "pyRevit", ("Setup", W), ("Testing", I)],
                   ["1_SetupElectrical", "pyRevit", ("Setup", W), ("Replaced", GR)]], ["1fr", "56px", "52px", "70px"]),
              note("Click a script to see its details below. Kit scripts come from 05_Scripts; firm scripts can be added.", GR)),
        group("Selected · FMC_CreateSheetsFromRegister",
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + ro("Runs in", "pyRevit (FMC tab)", mono=False) + ro("Version", "v2.2 · in Git") + ro("Owner", "BIM Manager", mono=False) + ro("Human gate", "BIM Manager", mono=False) + '</div>',
              ro("Does", "Creates a role's sheets from FMC_Sheet_Register.csv; never deletes or renames", mono=False),
              ro("Tested on", "Revit 2025 pilot model · register reading tested", mono=False),
              ro("Replaced by", "Drawings › Sheets (Create) when Manage 0.4 ships · Decision D2 open", mono=False),
              ro("Last run", "13 Oct 09:40 · [NAME A] · 21 sheets · log 06_QA\\Scripts", mono=False)),
        group("Run",
              sel("Script", ["FMC_CreateSheetsFromRegister", "FMC_SheetQA", "FMC_ModelHealth", "FMC_ExportQTO"], 0),
              inp("IN[0] · Register file", "Z:\\00_Standards\\03_Master_Data\\FMC_Sheet_Register.csv", mono=True, browse="Browse…"),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("IN[1] · Role", ["A", "S", "M", "E", "P", "Z"], 0) + seg("IN[2] · Dry run", ["Yes", "No"], 0) + '</div>',
              note("Inputs are read from the script's header. The first run on any model is always a dry run.", I)),
        group("Automations · scripts in a row",
              tbl("", ["Automation", "Steps", "Runs"],
                  [["New project setup", "Bind parameters → sheets → master data → health", "By hand"], ["Before sync", "Sheet QA → model health", "Before each sync"],
                   ["Friday issue prep", "Sheet QA → QTO export → weekly report", "Fridays 15:00"]], ["1fr", "1.4fr", "90px"]),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("New automation…", opens="d_chain") + btn("Run selected", True, opens="d_run") + '</div>',
              note("Triggers: by hand, on a schedule while Revit is open, when a model opens, before a sync, or before Ready to issue. Each step stops the chain if it fails.", GR)),
        group("Script rules · every script must pass to be approved",
              checks("", [("Has a dry-run input; first run is a dry run", True, "MAN 17.2", I), ("Model changes in one transaction (one Undo)", True, "MAN 17.2", I),
                          ("Writes a CSV log: what, before, after", True, "MAN 17.2", I), ("Fails loudly: never skips silently", True, "MAN 17.2", I),
                          ("Writes only fields the master data owns; never geometry", True, "MAN 17.2", I), ("Versioned in Git; version noted in the BEP", True, "MAN 17.2", I),
                          ("Re-tested on the pilot model after each Revit or Dynamo upgrade", True, "MAN 17.2", I)])),
        group("Add a script",
              drop("Script file", "Drop a .py, .dyn or pyRevit button folder", "It is copied to staging, not run"),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Type", ["pyRevit", "Dynamo Player graph", "Python (CPython 3)", "C# macro"], 0) + sel("Lock class", ["Read", "Setup", "Model"], 0) + '</div>',
              sel("Human gate", ["BIM Manager", "Discipline Lead", "BIM Coordinator", "PIM"], 0),
              note("New scripts start as Testing. The BIM Manager approves after the pilot test; Model-class scripts never run on live projects.", W)),
        author("e.g. 'Run the QTO export only after the Friday sync. Dynamo graphs are rebuilt for each Revit version.'"))
dl = (dialog("d_run", "Run: New project setup (dry run)",
              checks("Steps", [("FMC_BindSharedParameters", True, "171 bound", G), ("FMC_CreateSheetsFromRegister", True, "21 sheets", G), ("FMC_SyncMasterData", True, "214 types", G), ("FMC_ModelHealth", True, "Amber", W)]),
              note("Dry run: nothing changed. The plan for each step is saved to 06_QA\\Scripts.", I),
              primary="Run for real", done_msg="Automation finished; 4 log rows written (sample)."),
      dialog("d_chain", "New automation",
              inp("Name", "", "e.g. Monthly cost export"),
              chips("Steps (in order)", ["FMC_SheetQA", "FMC_ModelHealth", "FMC_ExportQTO", "+ Formcraft action: weekly report"], {"FMC_ModelHealth", "FMC_ExportQTO"}),
              sel("Runs", ["By hand", "On a schedule (Revit open)", "When a model opens", "Before each sync", "Before Ready to issue"], 0),
              toggle("Stop the chain if a step fails", True, locked=True),
              primary="Save automation", done_msg="Automation saved (sample)."))
sc = pane("Scripts", WIP, G, body, [btn("Run (dry run)", True, opens="d_run"), btn("New automation", opens="d_chain"), btn("Open log")], "12 scripts · 3 automations", dialogs="".join(dl))
board("PaneScripts.dc.html", "Scripts and automation", "Pane · Check › Scripts (+Model: Dynamo, pyRevit, automation)",
      "Formcraft Model's automation: every Dynamo and pyRevit script in one library, tested, run with a dry run, chained",
      "Offline automation before AI. The kit's pyRevit and Dynamo scripts and the firm's own sit in one library with type, lock class, owner, version, test status and history. Run them with their inputs, chain them into automations, and see which ones a Formcraft feature replaces.",
      sc,
      [("Script library", "Filter + table", "Name, type, lock class, status", "MAN 17.1"),
       ("Selected script", "Details", "Runs in, version, owner, human gate, tested on, replaced by, last run", "MAN 17.1, D2"),
       ("Run", "Inputs from the header", "IN[0], IN[1]…; dry run first", "MAN 17.2, 17.3"),
       ("Automations", "Steps + trigger", "By hand, schedule, on open, before sync, before issue", "Roadmap"),
       ("Script rules", "Checklist", "The seven script rules from the Manual", "MAN 17.2"),
       ("Add a script", "Drop + type + class + gate", "Starts as Testing; BIM Manager approves", "MAN 17.2"),
       ("Lock class", "Read, Setup, Model", "Model-class scripts never run on live projects", "CLM 1")],
      callout("Offline first", "Scripts and automations run on the engine with no internet and no AI. Later, Claude can suggest an automation, but it runs through this same library and its rules.")
      + callout("Old scripts, new features", "Each kit script shows the Formcraft feature that will replace it. When the feature has proven itself, the script can retire (Decision D2)."))

# ======================= MODEL · SYSTEMS =======================
body = (group("System",
              seg("Discipline", ["Electrical", "ELV", "Fire", "Plumbing", "Mechanical", "Special"], 0),
              tbl("", ["System", "Done", "Status"],
                  [["Power distribution", "3 of 7", ("Partly", W)], ["Small power", "2 of 7", ("Partly", W)], ["Lighting", "1 of 7", ("Partly", W)], ["Generator and standby", "0 of 7", ("Planned", GR)]],
                  ["1fr", "60px", "70px"]),
              note("A system is covered only when all seven capabilities work end to end on a real client model.", GR)),
        group("Seven capabilities · Power distribution",
              checks("", [("1 Enrich: fill missing family data, flag every guess", True, "Built", G), ("2 Size: cables, breakers from the code pack", True, "Built", G),
                          ("3 Diagram: single-line in a drafting view", False, "Planned", GR), ("4 Calculate: pass, warn, fail on elements", True, "Partly", W),
                          ("5 Review calcs: formal report, traced", False, "Planned", GR), ("6 Quantities: counts and lengths, BOQ", False, "Planned", GR),
                          ("7 Document: coloured sheets, schedules, legends", True, "Partly", W)])),
        group("Run on this model",
              chips("Run", ["Enrich", "Size", "Calculate"], {"Enrich", "Size"}),
              sel("Linked models to include", ["This model only", "This model + linked ELE", "All linked MEP models"], 1),
              note("Every run is a dry run first and goes through the same control layer as Manage. Real data is kept; guesses are flagged.", I)),
        group("Board manager · Power distribution tools",
              tbl("", ["Board", "Load", "Feeder", "Check"], [["MDB", "[kVA]", "[cable]", ("Pass", G)], ["DB-L1", "[kVA]", "[cable]", ("Warn", W)], ["DB-MECH", "[kVA]", "[cable]", ("Pass", G)]], ["1fr", "60px", "70px", "56px"]),
              note("Values in brackets are placeholders until the code pack is loaded.", GR)),
        group("Hand-offs to Manage",
              checks("", [("Diagram sheets go to Drawings › Sheets", True), ("Calculation reports join Ready to issue", True), ("Quantities feed Check › Reports", True)])),
        author("e.g. 'Use the client's preferred cable sizes; never downsize below 2.5 mm² on socket circuits.'"))
dl = (dialog("d_mrun", "Enrich and size · dry run",
              tbl("", ["Item", "Result"], [["Families enriched", "42 · 6 guesses flagged"], ["Circuits sized", "18"], ["Feeder warnings", "1 (DB-L1 voltage drop)"]], ["1fr", "1fr"]),
              note("Nothing changed yet. Flagged guesses are listed for an engineer to confirm.", I), primary="Apply", done_msg="Applied (sample); log written."),)
ms = pane("Systems", "F26001-FMC-ZZ-ZZ-M3-E-0001 · electrical", G, body, [btn("Run (dry run)", True, opens="d_mrun"), btn("Diagram"), btn("Review report")], "Power distribution · 3 of 7", dialogs="".join(dl))
board("PaneModelSystems.dc.html", "Model systems pane", "Pane · Engineer › Systems (+Model)",
      "Formcraft Model inside the shared pane: pick a system, run its seven capabilities",
      "Model adds an Engineer group to the same Formcraft Browser. Each building system shows the seven capabilities with honest status, runs through the same dry run and control layer as Manage, and hands its diagrams, reports and quantities to Manage's sections.",
      ms,
      [("Discipline, system", "Tabs, table", "23 systems in six disciplines; status per system", "MEP Suite plan"),
       ("Seven capabilities", "Checklist with status", "Enrich, Size, Diagram, Calculate, Review calcs, Quantities, Document", "MEP Suite plan"),
       ("Run on this model", "Chips, links", "Dry run first; linked models included as chosen", "Control layer"),
       ("System tools", "Table", "e.g. Board manager for power distribution", "MEP Suite plan"),
       ("Hand-offs", "Checks", "Diagrams to Sheets, reports to Issue, quantities to Reports", "Bundle")],
      callout("No extra ribbon", "The MEP Suite plan had its own ribbon tab with a drop-down per system. In the bundle those tools live here, in one pane, and the ribbon stays neat."))

# ======================= SETTINGS · ONE TAB PER MODULE =======================
SET_TABS = ["General", "Manage", "Flow", "Model", "Build"]
def links(mod, rows):
    td = "padding: 6px 8px; border-top: 1px solid #E3E6EA; vertical-align: top; color: #3B424D"
    body = "".join(f'<tr><td style="{td}; font-weight: 600; color: {INK}; white-space: nowrap">{E(w)}</td><td style="{td}">{E(g)}</td><td style="{td}">{E(t)}</td></tr>' for w, g, t in rows)
    return (f'<div><div style="font-size: 16px; font-weight: 600; margin-bottom: 6px">How {mod} works with Core and the other modules</div>'
            f'<table style="width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.4; background: #FFFFFF; border: 1px solid #DDE1E6">'
            f'<thead><tr style="text-align: left; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: {MUTED}"><th style="padding: 7px 8px; width: 14%">With</th>'
            f'<th style="padding: 7px 8px">{mod} gives</th><th style="padding: 7px 8px">{mod} takes</th></tr></thead><tbody>{body}</tbody></table></div>')
def works_with(items):
    return group("Works with", checks("", items), note("A module that isn't licensed is simply skipped; nothing breaks.", GR))
def ribbon_pick(mod, opts, a, b):
    return group(f"{mod} · ribbon buttons",
                 ro("Big button", f"{mod} parts (fixed)", mono=False),
                 '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Small button 1", opts, a) + sel("Small button 2", opts, b) + '</div>',
                 note("Three tools per module on the ribbon, never more. Everything else is in the pane and Ctrl+K.", I))
def parts(mod, items, off=()):
    return group(f"{mod} · parts in the pane", chips("Show these parts", items, set(items) - set(off), hint=f"Same list as the {mod} parts switch on the ribbon. Saved for you, not the team."))

# ---- Manage ----
body = (group("Settings sections", seg("Show", SET_TABS, 1, hint="One Settings page. General is Core's; each licensed module adds a tab.")),
        parts("Manage", ["Setup", "Drawings", "Team", "Check"]),
        ribbon_pick("Manage", ["Run QA", "Raise issue", "Ready to issue", "Sync reminder"], 0, 1),
        group("Manage · sync and start-of-day card",
              sel("Remind me to sync after", ["2 hours", "1 hour", "Never"], 0),
              note("A reminder only: you synchronise with central in Revit. No tool saves or syncs a workshared model.", W),
              checks("Show on my card", [("Issues assigned to me", True), ("QA on this model", True), ("Ready to issue status", True), ("Links changed since reload", True)])),
        group("Manage · QA and issues",
              sel("Run QA", ["When I press Run QA", "On open and before issue"], 0),
              ro("QA reports", "06_QA\\Health\\"),
              seg("New issues go to", ["Me", "BIM Coordinator"], 1),
              ro("Issue IDs and statuses", "F26001-ISS-#### · Open, In progress, Resolved, Closed (Manual 10.5)", mono=False)),
        group("Manage · materials",
              sel("Material library", ["FMC Materials v1.0 · 00_Standards\\12_Materials", "Project copy"], 0),
              toggle("Show texture previews", True),
              ro("Library owner", "Visualisation Lead · names FMC_[Group]_[Description]", mono=False)),
        works_with([("Core: pane, Connect AI, log file, roles", True, "Always", I), ("Flow: sheet and annotation rules", True, "Licensed", G),
                    ("Model: families, materials, QA", False, "Not licensed", GR), ("Build: schedules and issues", True, "Licensed", G)]),
        author("e.g. 'Friday is issue day: Run QA before 15:00.'"))
board("PaneSettingsManage.dc.html", "Settings · Manage tab", "Pane · Settings › Manage",
      "Manage's settings, and how they connect to Core and the other modules",
      "The Manage tab of the one Settings page: which parts show in the pane, the two small ribbon buttons, sync reminders, QA and issues, and the material library.",
      pane("Settings", WIP, G, body, [btn("Save", True)], "Manage tab"),
      [("Parts in the pane", "Chips", "Show or hide Setup, Drawings, Team, Check; same list as the ribbon's Manage parts switch", "Ribbon"),
       ("Ribbon buttons", "Two dropdowns", "The two small buttons beside Manage parts", "Max 3"),
       ("Sync reminder", "Dropdown", "Reminds you; you sync in Revit", "CLAUDE.md 6"),
       ("QA and issues", "Dropdowns", "When QA runs; who new issues go to", "MAN 10.5"),
       ("Materials", "Dropdown, switch", "Library version and texture previews", "MAN 4.6"),
       ("Works with", "Status", "What Manage shares with Core and the other modules", "Bundle")],
      links("Manage", [("Core", "Log lines, QA and issue counts for the start-of-day card", "Pane, Connect AI, log file, licence, roles from Admin, theme and text size from General"),
                       ("Flow", "Sheet grid, title block guides, annotation standard, tag families", "Sheet Layout and Tag Tidy results for the Ready to issue check"),
                       ("Model", "Families, materials, templates and QA rules", "System and structural check results for QA and issues"),
                       ("Build", "Schedules, finishes and the issue list", "Progress status for the weekly report")]))

# ---- Flow ----
body = (group("Settings sections", seg("Show", SET_TABS, 2, hint="One Settings page.")),
        parts("Flow", ["Touch", "Sheet Layout", "Tags", "3D"]),
        ribbon_pick("Flow", ["Touch on", "Section box", "Tag Tidy", "Align"], 0, 1),
        group("Flow · touch",
              toggle("Touch on in this view", True, "Pan, zoom, orbit and select with fingers"),
              seg("Sensitivity", ["Gentle", "Normal", "Fast"], 1),
              chips("Touch on these view types", ["Plans", "3D", "Sections", "Sheets"], {"Plans", "3D"})),
        group("Flow · sheet layout and tags",
              sel("Align viewports to", ["Sheet grid from Manage", "Title block guides only"], 0),
              toggle("Ghost preview before moving", True),
              chips("Tag Tidy defaults", ["Leaders never cross", "One elbow", "Clear of geometry", "Keep text horizontal"], {"Leaders never cross", "One elbow", "Clear of geometry"})),
        group("Flow · 3D and shortcuts",
              sel("Section box offset", ["300 mm around the area", "500 mm", "1 m"], 0),
              ro("Shortcuts", "Formcraft Shortcuts v1.0 · applied 13 Oct · 1 clash to fix", mono=False),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Apply the standard", msg="Revit's own Keyboard Shortcuts import opens with the file ready (sample).") + btn("Fix the clash", msg="QQ is used by the firm set and by you: pick which to keep.") + '</div>'),
        works_with([("Core: pane, licence, log file", True, "Always", I), ("Manage: sheet grid, annotation standard", True, "Licensed", G),
                    ("Model: system tags and colours", False, "Not licensed", GR), ("Build: package views on sheets", True, "Licensed", G)]),
        author("e.g. 'Touch on for site meetings on the tablet.'"))
board("PaneSettingsFlow.dc.html", "Settings · Flow tab", "Pane · Settings › Flow",
      "Flow's settings, and how they connect to Core and the other modules",
      "The Flow tab: which Flow parts show in the pane, the two small ribbon buttons, touch, sheet layout, Tag Tidy, the section box offset and the shortcuts standard.",
      pane("Settings", WIP, G, body, [btn("Save", True)], "Flow tab"),
      [("Parts in the pane", "Chips", "Show or hide Touch, Sheet Layout, Tags, 3D; same list as the Flow parts switch", "Ribbon"),
       ("Ribbon buttons", "Two dropdowns", "Touch on and Section box by default", "Max 3"),
       ("Touch", "Switch, tabs, chips", "Per view, sensitivity, view types", "Flow"),
       ("Sheet layout and tags", "Dropdown, chips", "Align to Manage's sheet grid when licensed", "Manage"),
       ("Shortcuts", "Status, buttons", "Applied through Revit's own import", "Flow")],
      links("Flow", [("Core", "Log lines for every layout and tidy", "Pane, licence, log file, Ctrl+K search"),
                     ("Manage", "Layout and tag results for the Ready to issue check", "Sheet grid, title block guides, annotation standard, tag families"),
                     ("Model", "Touch and section box on system views", "System tag rules and colours"),
                     ("Build", "Section box and sheet layout for package and progress views", "Package and progress view filters")]))

# ---- Model ----
body = (group("Settings sections", seg("Show", SET_TABS, 3, hint="One Settings page.")),
        parts("Model", ["Systems", "Structural", "Quantities"]),
        ribbon_pick("Model", ["Check system", "Quantities", "Diagram"], 0, 1),
        group("Model · systems",
              sel("Electrical rules pack", ["Formcraft electrical pack (engineer-approved)", "Client pack…"], 0),
              note("Rules packs are data in the kit. An engineer approves a pack; demand factors stay the engineer's.", W),
              chips("Systems I work on", ["Power", "Small power", "Lighting", "Fire alarm", "ICT", "Cold water", "HVAC"], {"Power", "Small power", "Lighting"}),
              sel("Diagram detail", ["Boards and feeders", "Down to final circuits"], 0)),
        group("Model · structural",
              ro("Design basis", "Set per project by the Structural EoR (Manual 2.3)", mono=False),
              ro("Analysis", "Robot via the Autodesk link · results in FMC_FEA_*", mono=False),
              toggle("Section changes need SEoR approval", True, locked=True)),
        group("Model · enrich and links",
              toggle("Keep real data; only fill blanks", True, locked=True),
              toggle("Flag every guess for review", True, locked=True),
              chips("Include links from", ["ARC", "STR", "ELE", "PLB", "MEC", "ELV"], {"ARC", "STR", "ELE"})),
        works_with([("Core: pane, Connect AI, log file", True, "Always", I), ("Manage: families, materials, QA", True, "Licensed", G),
                    ("Flow: touch and section box", True, "Licensed", G), ("Build: quantities", True, "Licensed", G)]),
        author("e.g. 'Lighting: check emergency duration on every escape route.'"))
board("PaneSettingsModel.dc.html", "Settings · Model tab", "Pane · Settings › Model",
      "Model's settings, and how they connect to Core and the other modules",
      "The Model tab: which Model parts show, the two small ribbon buttons, electrical rules packs, structural (design basis and Robot), enrich and linked models.",
      pane("Settings", WIP, G, body, [btn("Save", True)], "Model tab"),
      [("Parts in the pane", "Chips", "Show or hide Systems, Structural, Quantities", "Ribbon"),
       ("Ribbon buttons", "Two dropdowns", "Check system and Quantities by default", "Max 3"),
       ("Electrical rules pack", "Dropdown", "Engineer-approved data; demand factors stay the engineer's", "AI-010"),
       ("Structural", "Read-only, locked", "Design basis per project; Robot link; SEoR approves sections", "MAN 12.4"),
       ("Enrich and links", "Locked switches, chips", "Keep real data, flag guesses; which links Model reads", "Model")],
      links("Model", [("Core", "Model statistics for Ask Claude; log lines", "Pane, Connect AI, log file, licence"),
                      ("Manage", "System and structural check results for QA and issues", "Families, materials, templates, QA rules"),
                      ("Flow", "System tag rules and colours", "Touch and section box on system views"),
                      ("Build", "Quantities by type and steel tonnage", "Nothing: Build never changes geometry")]))

# ---- Build ----
body = (group("Settings sections", seg("Show", SET_TABS, 4, hint="One Settings page.")),
        parts("Build", ["Views on the model", "BoQ", "Data package"]),
        group("Build · ribbon buttons",
              ro("On the ribbon", "Build parts · Workspace · Web app", mono=False),
              note("Everything else lives in the workspace window (in Revit) or the web app (for outsiders).", I)),
        group("Build · views on the model",
              seg("Colour the active view by", ["Nothing", "Progress", "Package"], 1),
              ro("Filters use", "FMC_Construction_Status · FMC_Trade_Package")),
        group("Build · BoQ and rates",
              ro("BoQ", "fmc_boq_build.py · MR-xxx rules · PKG-01 to PKG-14", mono=False),
              ro("Rates", "Rates sheet · Approved rows only, never typed", mono=False),
              toggle("Show rates", True, "Your role allows it", locked=True)),
        group("Build · 4D and web app",
              ro("4D link", "FMC_Task_ID + FMC_Zone · programme stays in P6 / MS Project", mono=False),
              ro("Web app", "[WEB APP ADDRESS] on the Formcraft CDE", mono=False),
              sel("Outsiders' accounts", ["Read only, expire after 30 days", "Off"], 0)),
        works_with([("Core: pane, Connect AI, log file, roles", True, "Always", I), ("Manage: schedules, finishes, issues", True, "Licensed", G),
                    ("Model: quantities", False, "Not licensed", GR), ("Flow: package views on sheets", True, "Licensed", G)]),
        author("e.g. 'Colour by package for Thursday's tender meeting.'"))
board("PaneSettingsBuild.dc.html", "Settings · Build tab", "Pane · Settings › Build",
      "Build's settings, and how they connect to Core and the other modules",
      "The Build tab: which Build parts show in the pane, view colours, BoQ and rates rules, the 4D link and the web app. The ribbon keeps only Build parts, Workspace and Web app.",
      pane("Settings", WIP, G, body, [btn("Save", True)], "Build tab"),
      [("Parts in the pane", "Chips", "Show or hide Views, BoQ, Data package", "Ribbon"),
       ("Ribbon buttons", "Fixed", "Build parts, Workspace, Web app", "Max 3"),
       ("Views", "Tabs", "Colour by FMC_Construction_Status or FMC_Trade_Package", "Kit"),
       ("BoQ and rates", "Read-only, locked", "fmc_boq_build.py; Approved rates only", "MAN 11.3"),
       ("4D and web app", "Read-only, dropdown", "Task link; outsiders' accounts expire", "MAN 11.6, 7.6")],
      links("Build", [("Core", "Log lines; nothing about who did what is used to rank people", "Pane, Connect AI, log file, licence, roles and rate permission from Admin"),
                      ("Manage", "Progress for the weekly report", "Schedules, finishes, issue list"),
                      ("Model", "Nothing back into geometry", "Quantities by type and steel tonnage"),
                      ("Flow", "Package and progress views to lay out on sheets", "Section box and Sheet Layout")]))

# ======================= MODEL · START FROM BRIEF =======================
body = (group("Model parts", seg("Show", ["Start from brief", "Systems", "Structural", "Quantities"], 0, hint="Brief to model is Model's first capability.")),
        group("Approved concept",
              ro("Concept Information Set", "F26001_CIS_R4.json · approved 13 Oct · client sign-off filed", mono=False),
              ro("New model", "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt · from FMC_A_Template_v2.2 · 01_WIP\\A", mono=False),
              note("Runs only on a new file. On a live model this part is locked.", I)),
        group("What will be created",
              checks("", [("Levels with standard names", True, "5", G), ("Project Information (plot, district, site area, FFL)", True, "9 values", G),
                          ("Rooms, unplaced, with programme data", True, "38", G), ("Materials from the library", True, "21", G),
                          ("Door and window families chosen on the F sheets", True, "14", G), ("Blank in the CIS: left blank", True, "6 values", GR)]),
              tbl("Rooms (first rows)", ["No.", "Name", "Target m²", "Finish set"], [["G01", "Genkan", "9.0", "FS-01"], ["G02", "Living", "42.0", "FS-03"], ["G03", "Dining", "24.0", "FS-03"], ["G04", "Kitchen", "21.0", "FS-05"]], ["44px", "1fr", "70px", "70px"])),
        group("After it runs",
              checks("", [("Place rooms once walls exist", False, "Modeller", I), ("Brief compliance check in Manage › QA", False, "After first stage", I)]),
              note("It never draws walls or other geometry, and never guesses a blank.", W)),
        author("e.g. 'Client wants the study kept at 12 m² minimum.'"))
dl = (dialog("d_brief", "Start from brief · dry run",
             tbl("", ["Will create", "Count"], [["Levels", "5"], ["Rooms (unplaced)", "38"], ["Materials loaded", "21"], ["Door and window types", "14"]], ["1fr", "60px"]),
             note("Nothing is written until you approve. One Undo, then a log line in FMC_MCP_FileLog.csv.", I), primary="Create", done_msg="Model set up from the brief (sample): 5 levels, 38 rooms, 21 materials, 14 types."),)
bp = pane("Systems", "New model · not saved yet", G, body, [btn("Dry run", True, opens="d_brief"), btn("Open CIS", msg="Opens the approved CIS from the CDE (sample).")], "CIS R4 · approved", dialogs="".join(dl))
board("PaneModelBrief.dc.html", "Start from brief", "Pane · Model › Start from brief (+Model)",
      "Model starts where the information starts: the approved concept",
      "Reads the Concept Information Set approved with the concept booklet and sets up a new model: levels, Project Information, the room programme as unplaced rooms, library materials and the chosen door and window families.",
      bp,
      [("Approved concept", "Read-only", "The CIS version and the new file it will set up", "Update notes"),
       ("What will be created", "Checks, table", "Levels, Project Information, rooms, materials, families", "Kit parameters"),
       ("Dry run", "Dialog", "Counts before anything is written; one Undo, log line", "17.2"),
       ("After it runs", "Checks", "Place rooms; brief compliance check in Manage › QA", "Manage")],
      callout("Never geometry", "Brief to model fills information only. Walls, floors and roofs are modelled by people; blanks in the CIS stay blank."))

# ======================= FLOW · TOUCH =======================
body = (group("Touch views",
              toggle("Touch on", True, "Master switch · also Ctrl+Shift+T and the quick tools strip"),
              tbl("On screen", ["View", "Type", "Touch"], [["Level 1 - GA Plan", "Plan · active", ("On", G)], ["{3D} Coordination", "3D", ("On", G)], ["A-101 - Ground Floor", "Sheet", ("Off", GR)]], ["1fr", "80px", "50px"]),
              tbl("In background tabs", ["View", "Type", "Touch"], [["Level 2 - GA Plan", "Plan", ("Off", GR)], ["Section 1 - North", "Section", ("Off", GR)]], ["1fr", "80px", "50px"]),
              '<div style="display: flex; gap: 6px">' + btn("All on") + btn("All off") + '</div>'),
        group("Gestures",
              seg("Select elements with", ["Long press", "Tap"], 0),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Single tap", ["Nothing", "Click"], 0) + sel("Two-finger tap", ["Right-click menu", "Nothing"], 0) + sel("Double tap", ["Zoom to fit", "Double-click", "Nothing"], 0) + sel("One-finger drag in 3D", ["Orbit", "Pan", "Nothing"], 0) + '</div>',
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + inp("Zoom sensitivity", "1.4×", num=True) + inp("Orbit speed", "1.0×", num=True) + '</div>',
              toggle("Invert pinch zoom", False)),
        group("On the view",
              checks("", [("Thin Studio Green frame on views TouchKit handles", True), ("Ring that fills while holding to select", True), ("'Touch on' badge in the view corner", True)]),
              note("Moving a finger while holding turns the press into a pan, so nothing is selected by accident.", I)),
        group("Section Box",
              sel("Offset around the dragged area", ["300 mm", "500 mm", "1 m"], 0),
              toggle("Level-aware: box from the level below to the level above", True)),
        author("e.g. 'On the site tablet: touch on in 3D only.'"))
dl = (dialog("d_treset", "Reset touch settings",
              note("Puts gestures and sensitivity back to the defaults on this computer.", W), primary="Reset", done_msg="Touch settings reset."),)
ft = pane("Settings", "Level 1 - GA Plan · touch on", G, body, [btn("Done", True), btn("Reset", opens="d_treset"), btn("Export")], "Touch on in 2 views", dialogs="".join(dl))
board("PaneFlowTouch.dc.html", "Flow touch pane", "Pane · Settings › Flow › Touch (opened from Quick tools)",
      "TouchKit in the shared pane: per-view touch, gestures and on-view feedback",
      "The TouchKit panel and its separate settings window become one place: the Touch button in the quick tools strip opens Settings › Flow › Touch. Per-view switches, gestures, sensitivity, on-view feedback and the Section Box offset sit together.",
      ft,
      [("Touch on", "Master switch", "Also a shortcut and the quick tools strip", "TouchKit 0.3"),
       ("Touch views", "Tables with switches", "Per view, on screen and in background tabs", "TouchKit 0.3"),
       ("Gestures", "Tabs, dropdowns, numbers", "Select, taps, 3D drag, zoom and orbit speed", "TouchKit 0.3"),
       ("On the view", "Checks", "Green frame, hold ring, badge", "TouchKit 0.3"),
       ("Section Box", "Dropdown, switch", "Offset and level-aware box", "Flow")],
      callout("One window less", "TouchKit 0.3 had its own panel and settings window. In the bundle both live in the shared pane, so touch feels like the rest of Formcraft."))


# ======================= ASK CLAUDE =======================
def _bubble(who, text, mine=False, meta=None):
    bg, bd = ("#F1F3F5", "#DDE1E6") if mine else ("#FFFFFF", "#FFAE61")
    m = f'<div style="font-size: 10.5px; color: #5B6270; margin-top: 4px">{meta}</div>' if meta else ""
    return (f'<div style="align-self: {"flex-end" if mine else "flex-start"}; max-width: 92%; background: {bg}; border: 1px solid {bd}; border-radius: 6px; padding: 6px 9px">'
            f'<div style="font-size: 10.5px; font-weight: 600; color: #4A515C">{who}</div><div style="font-size: 12px; line-height: 1.45; white-space: pre-line">{text}</div>{m}</div>')
conv = ('<div style="display: flex; flex-direction: column; gap: 6px">'
        + _bubble("You", "how many sheets and views are in this model?", True)
        + _bubble("Claude", "21 sheets and 64 views (38 plans, 12 sections, 9 3D, 5 schedules). 3 views are not on any sheet: Level 2 - Lighting, Section 4, {3D - j.okello}.",
                  meta="Read: document_info, model_statistics · 2,140 tokens · claude-sonnet-5-5")
        + _bubble("You", "which sockets on level 1 have no circuit?", True)
        + _bubble("Claude", "I can see 46 electrical fixtures in this view. 4 have an empty circuit number: 512338, 512341, 512402, 512407. I can't assign circuits from here; use Electrical in Revit, then ask me again to check.",
                  meta="Read: view_elements · 3,880 tokens")
        + '</div>')
body = (group("Ask Claude · test build",
              conv,
              inp("Ask", "", "ask … or ? … (Enter to send)"),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Send", True, msg="Sent to Claude with read-only tools (sample).") + btn("ask reset", msg="Follow-up memory cleared.") + '</div>',
              note("Claude can read the open model but not change it. Changes go through the buttons and their dry run.", "info")),
        group("What Claude can read",
              checks("", [("Open documents (title, workshared, family or project)", True, "Read", "good"), ("Active view", True, "Read", "good"),
                          ("Selected elements", True, "Read", "good"), ("Elements in the view, by category", True, "Read", "good"),
                          ("Model statistics", True, "Read", "good"), ("Material quantities", True, "Read", "good"),
                          ("Change, create or delete anything", False, "Not in this build", "grey")])),
        group("Key and budget (admin)",
              ro("API key", "Saved on this PC · %APPDATA%\\Formcraft\\anthropic_api_key.txt · never logged", mono=False),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Model", ["claude-sonnet-5-5 (default)", "claude-haiku-5-5 (cheaper)", "claude-opus-5-5 (hardest questions)"], 0)
              + inp("Tokens per day on this PC", "200000", num=True) + '</div>',
              ro("Used today", "18,420 of 200,000 tokens · 7 questions", mono=False),
              note("Billed per token on the key's Claude Console account (Max and Team plans include monthly API credits once linked). Not the Claude app plan or its usage credits.", "warn")),
        group("Log",
              tbl("FMC_Ask_Log.csv · tools and tokens only, never the text", ["Time", "Read", "Tokens"],
                  [["10:42", "model_statistics", "2,140"], ["10:44", "view_elements", "3,880"], ["11:05", "selected_elements", "1,210"]], ["60px", "1fr", "60px"])))
ak = pane("Ask", "F26001-FMC-ZZ-ZZ-M3-E-0001 · live project", "bad", body, [btn("Send", True), btn("Open log")], "Read-only · 181,580 tokens left today")
board("PaneAsk.dc.html", "Ask Claude pane", "Pane · Ask Claude (test build, read-only)",
      "Ask questions about the open model, right in the pane",
      "Type ask or ? in the command box. Claude answers using six read-only Revit tools and the firm's own API key. It cannot change the model in this build; every answer says what it read and what it cost.",
      ak,
      [("Conversation", "Bubbles", "Question, answer, what was read, tokens, model", "Test build"),
       ("What Claude can read", "Checklist", "Six read-only tools; changes not in this build", "ask.ts ASK_TOOLS"),
       ("Key and budget", "Admin", "Key file, model, tokens per day, used today", "ASK_CLAUDE.md"),
       ("Log", "Table", "Tools and tokens, never the question or answer", "Manual 14.5")],
      callout("Phase 2 next", "Claude proposes a change; the pane turns it into the normal dry run, approve, run, verify, log. Claude still never saves, syncs or moves coordinates."))

# ======================= MODEL · STRUCTURAL =======================
body = (group("System",
              seg("Discipline", ["Structural", "Electrical", "ELV", "Fire", "Plumbing", "Mechanical"], 0),
              tbl("", ["Structural system", "Done", "Status"],
                  [["Foundations (pads, strips, ground beams)", "0 of 7", ("Planned", GR)], ["RC frame (columns, beams, slabs)", "0 of 7", ("Planned", GR)],
                   ["Steel frame (UB, UC, purlins)", "0 of 7", ("Planned", GR)], ["Roof (timber and steel trusses)", "0 of 7", ("Planned", GR)], ["Stairs and walls", "0 of 7", ("Planned", GR)]],
                  ["1fr", "60px", "70px"]),
              note("A structural system is covered only when all seven steps work end to end on a real client model.", GR)),
        group("Seven steps · RC frame",
              checks("", [("1 Enrich: grades, exposure class, member marks (kit parameters)", False, "Planned", GR),
                          ("2 Analytical check: members joined, supports, releases, offsets", False, "Planned", GR),
                          ("3 Loads: cases and combinations present (set by the engineer)", False, "Planned", GR),
                          ("4 Hand-off: send the analytical model to the engineer's analysis software", False, "Planned", GR),
                          ("5 Results back: sizes and utilisation, differences listed", False, "Planned", GR),
                          ("6 Quantities: concrete m³ by grade, steel t, rebar BBS", False, "Planned", GR),
                          ("7 Document: S sheet set, schedules, BBS", False, "Planned", GR)])),
        group("Analytical model check · this run",
              tbl("", ["Check", "Found", "Result"],
                  [["Members not joined at nodes", "3", ("Warn", W)], ["Columns without a support or footing below", "1", ("Fail", B)],
                   ["Physical and analytical out by > 50 mm", "0", ("Pass", G)], ["Members missing FMC_Concrete_Grade", "12", ("Warn", W)],
                   ["Load cases defined", "None yet", ("Engineer", GR)]], ["1fr", "60px", "64px"]),
              note("Model reports these; the engineer fixes or accepts them. Load cases and combinations are set per project by the engineer (Manual Part 12).", I)),
        group("Results back from analysis",
              tbl("", ["Member", "Model", "Analysis", "Util."],
                  [["B-1-07", "230x450", "230x600", ("1.12", B)], ["C-G-03", "300x300", "300x300", ("0.81", G)], ["B-1-12", "230x450", "230x450", ("0.94", W)]],
                  ["1fr", "70px", "70px", "50px"]),
              note("Section changes are the engineer's decision. Model lists the differences; the engineer applies them in Revit. Claude never changes a structural section.", W)),
        group("Hand-offs to Manage",
              checks("", [("S sheets and schedules go to Drawings › Sheets", True), ("Design basis and calc summary join Ready to issue", True), ("Quantities and BBS feed Check › Reports", True)])),
        author("e.g. 'Exposure XC3 for all external members; check covers against S-0002.'"))
dl = (dialog("d_srun", "Analytical check · dry run",
              tbl("", ["Item", "Result"], [["Members checked", "214"], ["Warnings", "15 (3 not joined, 12 missing grade)"], ["Fails", "1 column without support"]], ["1fr", "1fr"]),
              note("Read only: nothing changed. The list is saved to 06_QA for the engineer.", I), primary="Save the list", done_msg="Saved to 06_QA (sample)."),)
ss = pane("Systems", "F26001-FMC-ZZ-ZZ-M3-S-0001 · structural", G, body, [btn("Check (read only)", True, opens="d_srun"), btn("Send to analysis"), btn("Quantities")], "Structural · planned", dialogs="".join(dl))
board("PaneModelStructural.dc.html", "Structural in the Systems pane", "Pane · Engineer › Systems › Structural (+Model)",
      "Structural engineering in the same pane: prepare, check, hand off, bring back, document",
      "Structural joins the Systems list as its own discipline. Model prepares and checks the structural model, hands the analytical model to the engineer's analysis software, brings results back as a list of differences, and documents with the kit's S sheet set. Design decisions stay with the engineer.",
      ss,
      [("Discipline, system", "Tabs, table", "Foundations, RC frame, steel frame, roof, stairs and walls", "Kit S families"),
       ("Seven steps", "Checklist with status", "Enrich, analytical check, loads, hand-off, results back, quantities, document", "Model"),
       ("Analytical check", "Table", "Joins, supports, offsets, missing grades, load cases", "Read only"),
       ("Results back", "Table", "Model size vs analysis size, utilisation; engineer applies", "CLAUDE.md rule 5"),
       ("Hand-offs", "Checks", "S sheets, design basis, quantities and BBS", "Bundle")],
      callout("Engineer decides", "Formcraft Model never sizes or changes a structural member. It prepares, checks, hands off and reports; the registered engineer designs and signs."))

# ======================= MATERIALS =======================
def _sw(c, label, tex=None):
    pat = (f'background: {c}; background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.18) 0 3px, transparent 3px 8px);' if tex == "hatch"
           else f'background: {c}; background-image: radial-gradient(rgba(0,0,0,0.12) 1px, transparent 1.5px); background-size: 6px 6px;' if tex == "dots"
           else f'background: {c};')
    return (f'<div style="display: flex; flex-direction: column; gap: 3px; min-width: 0"><div style="height: 46px; border-radius: 5px; border: 1px solid #DDE1E6; {pat}"></div>'
            f'<div style="font-size: 10.5px; line-height: 1.2; color: #1A1D21; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{label}</div></div>')
swatches = ('<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px">'
            + _sw("#B9B6AE", "FMC_Concrete_C25-30", "dots") + _sw("#C8B79A", "FMC_Block_Hollow_230", "hatch") + _sw("#EDEAE3", "FMC_Paint_Int_Matt_White")
            + _sw("#8C5A3C", "FMC_Timber_Mvule", "hatch") + _sw("#6E7378", "FMC_Steel_S275") + _sw("#D8D2C4", "FMC_Tile_Porcelain_600", "dots")
            + _sw("#A9C4D6", "FMC_Glass_Clear_6mm") + _sw("#9E4A2F", "FMC_Roof_Clay_Tile", "hatch") + '</div>')
body = (group("Formcraft material database",
              ro("Database", "Z:\\00_Standards\\07_Materials\\FMC_Materials.json · v1.3 · 214 materials", mono=False),
              seg("Class", ["All", "Concrete", "Masonry", "Finishes", "Metals", "Timber", "Glass", "MEP"], 0),
              inp("Search", "", "e.g. porcelain, C25, mvule…"),
              swatches,
              note("Each material carries graphics, an appearance with textures, identity data, a keynote and a cost code for Build.", I)),
        group("Selected · FMC_Tile_Porcelain_600",
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + ro("Class", "Finishes · floor", mono=False) + ro("Keynote", "F.TIL_02") + ro("Cost code (Build)", "M.20.04") + ro("Supplier", "[SUPPLIER]", mono=False) + '</div>',
              tbl("Appearance and textures", ["Map", "File", "Size"], [["Colour", "tile_porc_600_col.jpg", "600 mm"], ["Bump", "tile_porc_600_bmp.jpg", "600 mm"], ["Roughness", "—", "—"]], ["80px", "1fr", "60px"]),
              ro("Graphics", "Shaded #D8D2C4 · surface 600x600 grid · cut none", mono=False)),
        group("Assign to elements · dry run first",
              sel("Assign to", ["Selected elements' types", "Every type in a category", "By rule (type name contains …)", "Family material parameters"], 2),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + sel("Category", ["Floors", "Walls", "Ceilings", "Roofs", "Doors"], 0) + inp("Type name contains", "Porcelain") + '</div>',
              sel("Material parameter", ["Structure: finish layer", "Type material", "Family parameter: Finish"], 0),
              note("Setup class: runs on templates and new projects; on a shared model only with Claude in shared models on. Geometry never changes.", W)),
        group("Audit this model",
              tbl("", ["Check", "Found", "Result"],
                  [["Materials not in the database", "17", ("Warn", W)], ["Duplicates (\"Concrete (1)\", \"Default\")", "6", ("Warn", W)],
                   ["Broken texture paths", "4", ("Fail", B)], ["Unused materials", "38", ("Info", I)], ["Names not FMC_ standard", "11", ("Warn", W)]],
                  ["1fr", "56px", "56px"]),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Fix texture paths", opens="d_mtex") + btn("Merge duplicates", opens="d_mtex") + btn("Purge unused", opens="d_mtex") + '</div>'),
        group("Visualise and schedule",
              checks("", [("Finish colour view: colour floors, walls, ceilings by material, with legend", True), ("Material takeoff schedule from template (m², m³ by class)", True),
                          ("Room finishes schedule (floor, skirting, wall, ceiling)", True), ("Send quantities and cost codes to Build", False, "Build", GR)]),
              sel("Visual style for reviews", ["Realistic with textures", "Shaded with material colours", "Consistent colours"], 0)),
        group("Database changes",
              note("A material made in a project is never added to the database directly: it goes to the BIM Manager as a change request with its textures.", GR),
              '<div style="display: flex; gap: 6px">' + btn("Request new material", msg="Change request drafted for the BIM Manager (sample).") + btn("Check for database updates", msg="v1.3 → v1.4 available: 6 changed, 3 new (sample).") + '</div>'),
        author("e.g. 'All wet areas: porcelain floor, ceramic wall tile to 2.1 m.'"))
dl = (dialog("d_mass", "Assign FMC_Tile_Porcelain_600 · dry run",
              tbl("", ["Type", "Elements", "Change"], [["Floor - Porcelain 600 on screed", "38", "finish layer → FMC_Tile_Porcelain_600"], ["Floor - Porcelain 600 wet area", "12", "finish layer → FMC_Tile_Porcelain_600"]], ["1fr", "60px", "1.3fr"]),
              note("Plan only: nothing changed. One Undo when applied; the log records before and after.", I), primary="Apply", done_msg="Assigned to 2 types, 50 elements (sample)."),
      dialog("d_mtex", "Material clean-up · dry run",
              checks("", [("Re-point 4 texture paths to Z:\\00_Standards\\07_Materials\\Textures", True, "Fix", G), ("Merge 6 duplicates into their FMC_ material", True, "Merge", W), ("Purge 38 unused materials", False, "Optional", GR)]),
              note("Merging changes which material elements use; the list of affected elements is saved first.", W), primary="Run", done_msg="Clean-up done; log written (sample)."))
mt = pane("Materials", WIP, G, body, [btn("Assign (dry run)", True, opens="d_mass"), btn("Audit"), btn("Finish view")], "214 in database · 17 not in it", dialogs="".join(dl))
board("PaneMaterials.dc.html", "Materials pane", "Pane · Setup › Materials",
      "Materials, textures and visualisation from one Formcraft material database",
      "Browse the firm's material database with swatches, assign materials to element types by selection, category or rule with a dry run, audit duplicates and broken textures, and produce finish colour views and material schedules. Quantities and cost codes flow to Build.",
      mt,
      [("Database", "Path, version, class tabs, search, swatches", "FMC_Materials.json and its texture library", "Kit"),
       ("Selected material", "Details", "Keynote, cost code, supplier, texture maps with real-world size, graphics", "Kit"),
       ("Assign", "Target, category, rule, parameter", "Dry run, one Undo, log; Setup class", "Control layer"),
       ("Audit", "Table + fixes", "Not in database, duplicates, broken textures, unused, names", "Rulebook"),
       ("Visualise and schedule", "Checks", "Finish colour view, material takeoff, room finishes, to Build", "Templates"),
       ("Database changes", "Buttons", "New material requests and database updates", "BIM Manager")],
      callout("One source of truth", "Projects take materials from the database; they never invent their own. New ones go to the BIM Manager as change requests, so every project looks and schedules the same."))

# ======================= BUILD (pane) =======================
body = (group("Build workspace",
              note("Build's main screen is the workspace window beside the model. The pane keeps quick controls.", I),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Open workspace", True, msg="Workspace window opens beside the model (sample).") + btn("On second monitor", msg="Workspace moves to the second monitor (sample).") + '</div>'),
        group("Views on the model",
              seg("Colour the active view by", ["Nothing", "Progress", "Package", "BOQ bill"], 1),
              tbl("Progress legend", ["Status", "Elements"], [[("Done", G), "1,204"], [("In progress", W), "386"], [("Late", B), "41"], [("Not started", GR), "2,118"]], ["1fr", "70px"]),
              note("Uses view filters on FMC_Status and FMC_Package, so the view zooms, prints and goes on sheets.", GR)),
        group("BOQ and quantities",
              tbl("", ["Bill", "Items", "Changed"], [["2 Substructure", "48", "3"], ["3 Frame", "61", "0"], ["5 Electrical", "112", "6"]], ["1fr", "50px", "60px"]),
              note("Quantities come from Model and Materials; the QS prices in the workspace. Rates are hidden from roles without permission.", W)),
        group("Data package",
              ro("Package", "F26001 · v14 · exported 13 Oct 10:40", mono=False),
              checks("Waiting for approval", [("Site: 12 status changes (P03 Frame)", False, "Review", I), ("Client: 1 comment on Level 2", False, "Read", GR)]),
              '<div style="display: flex; gap: 6px">' + btn("Review changes", opens="d_bpkg") + btn("Export package", msg="Package v15 exported (sample).") + '</div>'),
        author("e.g. 'Colour by package for Thursday's tender meeting.'"))
dl = (dialog("d_bpkg", "Site changes · preview",
              tbl("", ["Elements", "Status", "From"], [["24 columns, Level 2", "In progress → Done", "Site · 13 Oct"], ["6 beams, Level 2", "Not started → In progress", "Site · 13 Oct"]], ["1fr", "1.2fr", "90px"]),
              note("Approving writes FMC_Status with one Undo, then re-checks.", I), primary="Approve", done_msg="12 changes applied (sample)."),)
bp = pane("Build", "F26001-FMC-ZZ-ZZ-M3-A-0001 · shared", W, body, [btn("Open workspace", True), btn("Review changes", opens="d_bpkg")], "v14 · 12 changes waiting", dialogs="".join(dl))
board("PaneBuild.dc.html", "Build in the pane", "Pane · Build (+Build)",
      "Quick Build controls in the shared pane; the workspace window does the heavy work",
      "For QSs and managers in Revit: open the workspace, colour the active view by progress, package or BOQ bill, see which bills changed, and review site changes from the data package before they reach the model.",
      bp,
      [("Workspace", "Buttons", "Open beside the model or on a second monitor", "Build"),
       ("Views on the model", "Tabs, legend", "View filters on FMC_Status, FMC_Package, FMC_BOQ_Item", "Kit change request"),
       ("BOQ and quantities", "Table", "Items and changes per bill", "Model, Materials"),
       ("Data package", "Checks, preview", "Site and client changes wait for approval", "Control layer")],
      callout("QS works in Revit", "In the firm, Build lives in Revit. The pane and the workspace window are the QS's daily tools; the web workspace is for people outside the firm."))

# ======================= ACCOUNT, LICENCE, FIRST RUN (Oct 13) =======================
def gate_shell(status, status_kind, body, footer, foot_note, dialogs=""):
    """The pane before sign-in or setup: same frame and header, no navigation."""
    REG["foot"] = foot_note
    bg, fg = CHIP[status_kind]
    return (f'<div style="position: relative; width: 440px; flex-shrink: 0; background: #FFFFFF; border: 1px solid {LINE}; border-radius: 8px; box-shadow: 0 12px 32px rgba(26,29,33,0.10); '
            f'display: flex; flex-direction: column; overflow: hidden; font-size: 12.5px">'
            f'<div style="height: 34px; display: flex; align-items: center; gap: 6px; padding: 0 10px; background: #F1F3F5; font-weight: 600; font-size: 13px"><span>Formcraft</span>'
            f'<span style="display: inline-flex; align-items: center; gap: 5px; min-height: 22px; padding: 0 8px; border-radius: 11px; background: {bg}; color: {fg}; font-size: 11px; font-weight: 500">{E(status)}</span>'
            f'<span style="margin-left: auto">{btn("?", msg="Help: opens the getting-started guide.")}</span></div>'
            f'<div style="height: 2px; background: {ORANGE}"></div>'
            f'<div style="flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain">{body}</div>'
            f'<div style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 5px 8px; border-top: 1px solid #E3E6EA; background: #F8F9FA">{"".join(footer)}'
            f'<span role="status" style="margin-left: auto; font-size: 11px; color: {MUTED}; max-width: 100%">{{{{v.foot}}}}</span></div>{dialogs}</div>')

# ---- Sign in ----
body = (group("Sign in to Formcraft",
              note("One Formcraft account per person. Your organisation's licence decides which modules you get.", I),
              inp("Work email", "", "name@company.com"),
              inp("Password", "", "••••••••", pwd=True),
              toggle("Keep me signed in on this PC", True),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Sign in", True, opens="d_2fa") + btn("Sign in with Microsoft", msg="Opens the Microsoft sign-in page in your browser, then returns here (sample).") + btn("Sign in with Google", msg="Opens the Google sign-in page in your browser, then returns here (sample).") + '</div>',
              '<div style="display: flex; gap: 10px; font-size: 11.5px">' + btn("Forgot password", msg="A reset link goes to your email (sample).") + btn("No account? Ask your admin", msg="Your Formcraft admin invites you from Admin › Licences and seats.") + '</div>'),
        group("No internet on this PC",
              note("Ask your admin for an offline licence file. It works for 30 days, then needs a check-in.", GR),
              drop("Offline licence file", "Drop FMC_Licence_<PC>.lic here", "Made by your admin in Admin › Licences and seats")),
        group("What signing in does",
              checks("", [("Checks your seat and modules", True, "", I), ("Registers this PC (name only)", True, "", I), ("Loads your settings", True, "", I), ("Never reads or sends model content", True, "", G)])))
dl = (dialog("d_2fa", "Check your phone",
             inp("6-digit code", "", "123 456", mono=True),
             note("Two-step sign-in is on for your organisation.", I), primary="Verify", done_msg="Signed in as [NAME A]. Licence checked: Manage, Flow, Build; Model trial (sample)."),)
sp = gate_shell("Not signed in", "grey", body, [btn("Sign in", True, opens="d_2fa"), btn("Work offline", msg="Without a seat only Connect, Log file and Help are available.")], "Revit 2025 · Formcraft 0.3.1", dialogs="".join(dl))
board("PaneSignIn.dc.html", "Sign in", "Pane · Core · sign in (first open)", "Sign in once; your organisation's licence unlocks the modules",
      "The first thing the pane shows on a new PC. Email and password, or Microsoft or Google sign-in through the browser, with two-step sign-in when the organisation requires it. PCs with no internet use an offline licence file.",
      sp,
      [("Account", "Email, password, SSO", "One Formcraft account per person", "Core"),
       ("Two-step sign-in", "Code dialog", "When the organisation turns it on", "Security"),
       ("Offline licence", "File drop", "30 days, then a check-in", "Licensing"),
       ("Privacy", "Checks", "Never reads or sends model content", "MAN 7.7")],
      callout("Payments are not in Revit", "Buying, renewing and invoices happen on the Formcraft account website. The pane only signs in and checks the licence."))

# ---- First-run setup ----
body = (group("Set up this PC · step 2 of 4",
              seg("Steps", ["1 Sign in", "2 Kit folder", "3 Your role", "4 Your parts"], 1),
              inp("Formcraft kit folder", "Z:\\00_Standards", mono=True, browse="Browse…", hint="Your BIM Manager gives you this path."),
              checks("Kit check", [("FMC Kit v2.2 found", True, "OK", G), ("Shared parameters file", True, "OK", G), ("Rulebooks v0.2", True, "OK", G), ("Write folders (01_WIP, _Staging)", True, "OK", G)])),
        group("Your role and disciplines",
              sel("Role", ["BIM Coordinator", "Modeller", "QS / Commercial", "Planner", "Engineer", "Visualisation Lead"], 0, hint="Set by Admin; shown here to confirm."),
              chips("Disciplines I model", ["A", "I", "S", "M", "E", "P", "FP", "L"], {"A", "I"})),
        group("Parts to show in the pane",
              chips("Manage", ["Setup", "Drawings", "Team", "Check"], {"Setup", "Drawings", "Team", "Check"}),
              chips("Flow", ["Touch", "Sheet Layout", "Tags", "3D"], {"Sheet Layout", "Tags", "3D"}),
              chips("Build", ["Views", "BoQ", "Data package"], {"Views", "BoQ"}),
              note("The same lists as each module's parts switch on the ribbon. Change them any time.", GR)),
        group("Then",
              toggle("Show the 2-minute tour", True),
              toggle("Apply the Formcraft shortcuts (opens Revit's import)", False)))
sp = gate_shell("Signed in · setting up", "info", body, [btn("Back", msg="Back to step 1."), btn("Next", True, msg="Step 3: your role.")], "Step 2 of 4")
board("PaneWelcome.dc.html", "First-run setup", "Pane · Core · first-run setup", "Four short steps the first time someone opens the pane",
      "After sign-in: point to the kit, confirm role and disciplines, pick which parts of each module to show, then the tour. Everything here can be changed later in Settings.",
      sp,
      [("Kit folder", "Path, checks", "Kit, parameters, rulebooks, write folders", "Kit"),
       ("Role", "Read-only dropdown", "Set by Admin; shown to confirm", "Admin"),
       ("Parts to show", "Chips", "Same lists as the ribbon parts switches", "Ribbon"),
       ("Tour and shortcuts", "Switches", "Tour now; shortcuts through Revit's own import", "Flow")],
      callout("Fast to build", "The shell, these steps and every pane are front-end work that can be built and tested before the tools behind them exist."))

# ---- Account and licence (Settings) ----
body = (group("Settings sections", seg("Show", ["Account", "General", "Manage", "Flow", "Model", "Build"], 0, hint="Account and licence sit first in Settings.")),
        group("You",
              ro("Name and email", "[NAME A] · name@formcraft.co.ug", mono=False),
              ro("Organisation", "Formcraft Design & Construction · Team plan", mono=False),
              ro("Role", "BIM Coordinator (set by Admin)", mono=False)),
        group("Your modules",
              tbl("", ["Module", "Status", "Until"], [["Core", ("Included", G), "Always"], ["Manage", ("Active", G), "31 Dec 2026"], ["Flow", ("Active", G), "31 Dec 2026"],
                                                     ["Model", ("Trial · 9 days", W), "22 Oct 2026"], ["Build", ("Not on your licence", GR), "Ask your admin"]], ["1fr", "130px", "100px"]),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Request Build", msg="Request sent to your admin (sample).") + btn("Enter a licence key", opens="d_key") + '</div>'),
        group("This PC",
              ro("Seat", "crafty27 · registered 9 Oct", mono=False),
              checks("Licence check", [("Last checked online", True, "13 Oct 10:02", G), ("Works offline for", True, "14 days", I)]),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Check now", msg="Licence checked: nothing changed (sample).") + btn("Release this seat", opens="d_release") + btn("Sign out", msg="Signed out. The pane shows the sign-in screen.") + '</div>'),
        group("Ask Claude in the pane",
              ro("Key", "Organisation key set by Admin · billed on the Claude Console", mono=False),
              ro("Today on this PC", "18,400 of 200,000 tokens", mono=False)))
dl = (dialog("d_key", "Enter a licence key", inp("Licence key", "", "FMC-XXXX-XXXX-XXXX", mono=True), note("Keys come from the Formcraft account website or your admin.", I), primary="Activate", done_msg="Key accepted: Model active until 31 Dec 2026 (sample)."),
      dialog("d_release", "Release this seat", note("Frees your seat so someone else can use it. You'll need to sign in again here.", W), primary="Release", done_msg="Seat released (sample)."))
sp = pane("Settings", WIP, G, body, [btn("Save", True)], "Account", dialogs="".join(dl))
board("PaneAccount.dc.html", "Account and licence", "Pane · Settings › Account", "Who you are, which modules you have, and how long this PC works offline",
      "The first tab of Settings. Module status with trial and renewal dates, a request button for modules you don't have, licence keys, this PC's seat and offline grace, and today's Ask Claude use.",
      sp,
      [("You", "Read-only", "Name, organisation, plan, role", "Admin"),
       ("Your modules", "Table, buttons", "Active, trial, not licensed; request or enter a key", "Licensing"),
       ("This PC", "Checks, buttons", "Seat, last check, offline days; release, sign out", "Licensing"),
       ("Ask Claude", "Read-only", "Organisation key; today's tokens on this PC", "ASK_CLAUDE.md")],
      callout("Honest about money", "The plugin shows status and dates. Prices, payments and invoices live on the account website, never inside Revit."))

# ---- Licences and seats (Admin) ----
body = (group("Subscription",
              ro("Plan", "Formcraft Revit Tools · Team · renews 31 Dec 2026", mono=False),
              ro("Billing contact", "[NAME B] · on the account website", mono=False),
              btn("Open the account website", msg="Opens the Formcraft account website: plan, invoices, payment (sample).")),
        group("Seats by module",
              tbl("", ["Module", "Used", "Seats"], [["Core", "9", "Unlimited"], ["Manage", "7", "8"], ["Flow", "9", "10"], ["Model", "2", "2 trial"], ["Build", "0", "0"]], ["1fr", "60px", "80px"])),
        group("People",
              tbl("", ["Person", "Role", "Modules", "Last check"], [["[NAME A]", "BIM Coordinator", "M F Mo", "Today"], ["[NAME C]", "Modeller", "M F", "Today"], ["[NAME D]", "QS / Commercial", "M B (requested)", "Yesterday"]], ["1fr", "1fr", "90px", "70px"]),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Invite a person", opens="d_invite") + btn("Assign seats", msg="Pick people and modules, then save (sample).") + btn("Make offline licence file", msg="FMC_Licence_<PC>.lic saved; valid 30 days (sample).") + '</div>'),
        group("Requests",
              checks("", [("[NAME D] asks for Build", False, "Approve", W)])),
        group("Rules",
              note("Seat lists show who holds a licence. They are never used to rank people (Manual 14.5).", GR),
              toggle("Require two-step sign-in", True),
              sel("Claude in the pane", ["Organisation key, 200,000 tokens per PC per day", "Off"], 0)))
dl = (dialog("d_invite", "Invite a person", inp("Email", "", "name@company.com"), sel("Role", ["Modeller", "BIM Coordinator", "QS / Commercial", "Planner", "Engineer"], 0),
             chips("Modules", ["Manage", "Flow", "Model", "Build"], {"Manage", "Flow"}), primary="Send invite", done_msg="Invite sent; a seat is held for 7 days (sample)."),)
sp = pane("Admin", WIP, G, body, [btn("Save", True)], "Licences and seats", dialogs="".join(dl))
board("PaneSeats.dc.html", "Licences and seats", "Pane · Admin › Licences and seats", "Admins see the subscription, seats per module, people and requests",
      "For the firm's admin: plan and renewal, seats used per module, who holds which modules, invites, offline licence files and module requests. Payments stay on the account website.",
      sp,
      [("Subscription", "Read-only, link", "Plan, renewal, billing contact", "Account website"),
       ("Seats by module", "Table", "Used against bought", "Licensing"),
       ("People", "Table, buttons", "Invite, assign, offline licence file", "Admin"),
       ("Requests", "Checks", "Approve module requests", "Admin"),
       ("Rules", "Switches", "Two-step sign-in, Claude key policy", "MAN 7.6, 14.5")],
      callout("Built on a licence service", "Seats and keys need a licence server behind them: a licensing service or the Autodesk App Store's entitlement check if sold there. The pane is the same either way."))

# ---- Shell states ----
body = (group("Model › Systems",
              note("Formcraft Model isn't on your licence.", W),
              ro("What it adds", "Start from brief, MEP systems, structural checks, quantities", mono=False),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Start a 14-day trial", True, msg="Trial requested; your admin approves it (sample).") + btn("Ask your admin", msg="Request sent (sample).") + btn("See what it does", msg="Opens the Model page of the guide.") + '</div>'),
        group("Other states the pane must show",
              tbl("", ["State", "What the pane says", "What still works"], [
                  ["Offline", "Licence checked 3 days ago · 11 days left", "Everything"],
                  ["Grace over", "Sign in to keep using Formcraft", "Connect, Log, Help"],
                  ["Revit not connected", "Start the Claude service: Core › Connect AI", "Pane, settings"],
                  ["Kit not found", "Point to the kit folder in Settings", "Connect, Settings"],
                  ["Live model", "Live project: Claude reads and reports", "Read-only tools"],
                  ["Revit busy", "Waiting for Revit to finish…", "Nothing new starts"]], ["90px", "1.3fr", "1fr"])),
        group("Rules for every state",
              checks("", [("Say what happened and what to do next", True, "", I), ("Keep working parts working", True, "", I), ("Never lose typed input", True, "", I)])))
sp = pane("Systems", "F26001-FMC-ZZ-ZZ-M3-E-0001.rvt · 01_WIP", G, body, [btn("Start a trial", True, msg="Trial requested (sample).")], "Model not licensed")
board("PaneStates.dc.html", "Locked and offline states", "Pane · Core · states", "What the pane shows when a module isn't licensed, the PC is offline or Revit isn't ready",
      "A module that isn't on the licence shows what it adds, with a trial or a request. The table lists the other states the shell must handle, what each says and what keeps working.",
      sp,
      [("Not licensed", "Message, buttons", "What it adds; trial or request", "Licensing"),
       ("Offline and grace", "Banner", "Days left; what still works", "Licensing"),
       ("Not connected, kit missing", "Banner", "One next step each", "Core"),
       ("Live model, Revit busy", "Banner", "Read-only or wait", "Lock, 17.2")],
      callout("States are part of the shell", "Building these first means every later feature drops into a shell that already handles sign-in, licences, offline and errors."))

# ---- Updates and about ----
body = (group("Formcraft for Revit",
              ro("Installed", "0.3.1 · Core, Manage, Flow, Model (trial), Build · Revit 2025", mono=False),
              ro("Kit", "FMC Kit v2.2 · rulebooks v0.2 · update r3", mono=False),
              seg("Update channel", ["Stable", "Beta (testers)"], 0)),
        group("Update available",
              ro("0.3.2", "Fixes Tag Tidy on rotated views; Search finds settings · passed release gates R1–R3", mono=False),
              checks("Before updating", [("Close Revit or the update waits until it closes", True, "", I), ("Your settings are kept", True, "", G), ("Previous version kept for rollback", True, "", G)]),
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Update when Revit closes", True, msg="0.3.2 installs when Revit closes (sample).") + btn("Release notes", msg="Opens the 0.3.2 notes.") + btn("Roll back to 0.3.0", msg="Rolls back at next Revit start (sample).") + '</div>'),
        group("Help and support",
              '<div style="display: flex; gap: 6px; flex-wrap: wrap">' + btn("Guide", msg="Opens the guide.") + btn("Replay the tour", msg="Starts the tour.") + btn("Send a support report", msg="Report with versions and today's log rows (no model content) ready to send (sample).") + '</div>'),
        group("Legal", ro("Licence terms and privacy", "Formcraft terms · Data Protection Act 2019 notice", mono=False)))
sp = pane("Settings", WIP, G, body, [btn("Check for updates", msg="You're on the latest stable version (sample).")], "Updates")
board("PaneUpdates.dc.html", "Updates and about", "Pane · Settings › Updates", "Version, updates that wait for Revit to close, rollback and support",
      "Shows what is installed (plugin, modules, kit), offers updates that passed the release gates, keeps the previous version for rollback, and makes a support report without model content.",
      sp,
      [("Installed", "Read-only", "Plugin, modules, kit, Revit version", "Core"),
       ("Update", "Buttons", "Installs when Revit closes; rollback kept", "MAN Part 19"),
       ("Support report", "Button", "Versions and log rows, no model content", "MAN 7.7"),
       ("Legal", "Read-only", "Terms and privacy notice", "Legal")],
      callout("Releases follow the gates", "Only versions that passed R1–R3 reach the stable channel; testers get beta first."))

# ======================= ADMIN =======================
PERM_W = ["1.3fr", "0.5fr", "0.5fr", "0.5fr", "0.5fr", "0.5fr"]
body = (group("You",
              ro("Signed in as", "j.okello · Revit user name matches the team file"),
              ro("Your role", "Admin · backup admin: s.nambi"),
              ro("Team file", "<project>\\FMC_Team.json · only admins can change it")),
        group("Team",
              tbl("", ["Person", "Revit user", "Role", "Disc."],
                  [("Joel O.", "j.okello", ("Admin", I), "Z A"), ("Sarah N.", "s.nambi", ("Lead", G), "A"),
                   ("Ruth A.", "r.achieng", ("Lead", G), "S M"), ("Peter K.", "p.kato", ("Modeller", GR), "A"),
                   ("Tester 1", "t.mugisha", ("Reviewer", W), "A S"), ("Client QS", "viewer01", ("Viewer", GR), "—")],
                  ["1fr", "1fr", "0.9fr", "0.6fr"]),
              '<div style="display: flex; gap: 6px">' + btn("Add person…", opens="d_add") + btn("Change role…", opens="d_role") + btn("Remove", msg="Remove: pick a row first. Their history stays in the audit log.") + '</div>'),
        group("Permissions by role",
              tbl("", ["Pane", "Adm", "Lead", "Mod", "Rev", "View"],
                  [("Project", "Full", "Read", "Read", "Read", "Read"), ("Templates", "Full", "Check", "Check", "—", "—"),
                   ("Families", "Full", "Disc.", "Own", "Read", "—"), ("Sheets", "Full", "Disc.", "Place", "Read", "Read"),
                   ("Annotate", "Full", "Live", "Own", "—", "—"), ("QA", "Full", "Fix", "Run", "Read", "Sum."),
                   ("Reviews", "Full", "Close", "Fix", "Check", "Read"), ("Workshare", "Full", "Disc.", "Sync", "Read", "—"),
                   ("AI buttons", "Caps", "Cap", "Cap", "Explain", "—")], PERM_W),
              note("Disc. = own discipline only. Own = views or families they own. — = hidden. Pick a row, then Edit.", GR),
              '<div style="display: flex; gap: 6px">' + btn("Edit permissions…", opens="d_perm") + btn("Reset to Formcraft defaults", msg="Reset: permissions go back to the Formcraft defaults (dry run first).") + '</div>'),
        group("Project settings",
              sel("Standard", ["Formcraft FMC-BIM v2.2", "Client standard (Phase 3)"], 0),
              seg("Stages shown", ["Gates and issue sets", "Also show RIBA"], 0, hint="Gate 1–3 and issue sets drive the plugin; RIBA is a label only."),
              ro("Sheet status", "Manual 4.4: S0–S4, S6, S7, A1…, B1…, CR"),
              ro("Revisions", "P01… preliminary · C01… contract")),
        group("AI",
              toggle("Claude in shared models", False, "Setup tools on workshared models (D1); admins only"),
              '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">' + inp("Cap per person (USD/month)", "10", num=True) + inp("Team cap (USD/month)", "40", num=True) + '</div>',
              ro("Spent this month", "$6.80 of $40 · highest: r.achieng $2.90", mono=False)),
        group("Automation",
              toggle("Auto-save files that are not workshared", True, "Every 15 minutes"),
              toggle("Scheduled sync for this project", False, "Off by default; preflight first, 60-second notice"),
              sel("Sync interval", ["Every 2 hours", "Every hour", "At 12:30 and 17:00"], 0),
              sel("Coordinate changes approved by", ["Lead or Admin", "Admin only"], 0),
              note("Claude can never save, sync or move coordinates. These switches are for the plugin only.", I)),
        group("Project data · version bridge (Phase 2)",
              ro("Shared data file", "<project>\\FMC_ProjectData · reviews, sync log, rules, registers, roster", mono=False),
              chips("Revit versions on this project", ["2025", "2026", "2027"], {"2025"}),
              note("Every version of Formcraft reads and writes the same project data, so reviews and sync history match across versions.", GR)),
        group("Modules and licences",
              tbl("", ["Module", "Seats", "Status"], [["Core", "All", ("Always", I)], ["Manage", "6 of 10", ("Licensed", G)], ["Flow", "6 of 10", ("Licensed", G)], ["Model", "—", ("Not yet", GR)]], ["1fr", "70px", "80px"]),
              note("One installer holds every module; the licence switches them on.", I)),
        group("Licences",
              ro("Seats", "6 of 10 used · beta, free", mono=False),
              toggle("Licence check", True, "On from 0.1; payment switches on at 1.0", locked=True)),
        group("Audit log",
              tbl("", ["When", "Who", "Change"],
                  [("13 Oct 10:42", "j.okello", "p.kato: Modeller → Lead (A)"), ("12 Oct 16:05", "j.okello", "Annotate: Lead may run on live"),
                   ("12 Oct 09:30", "j.okello", "Added t.mugisha as Reviewer"), ("10 Oct 14:12", "s.nambi", "Proposed rule SHT-039 approved")],
                  ["0.9fr", "0.8fr", "2fr"])),
        group("Handover",
              ro("Backup admin", "s.nambi"),
              '<div style="display: flex; gap: 6px">' + btn("Pass admin to…", opens="d_hand") + btn("Export team file", msg="Export: saves FMC_Team.json and the permissions as a copy for your records.") + '</div>'),
        author("Notes for the team, shown when someone's role changes, e.g. 'Leads: ask before tagging on Friday issue days.'"))
dl = (dialog("d_add", "Add person",
             inp("Name", "", "[NAME]"),
             inp("Revit user name", "", "as in Revit › Options › General", mono=True, hint="The plugin matches this name to decide what they can see."),
             sel("Role", ["Modeller", "Lead", "Reviewer", "Viewer", "Admin"], 0),
             chips("Disciplines", ["Z", "A", "S", "M", "E", "P", "FP", "C", "L"], {"A"}),
             note("They see only what their role allows the next time they open the model.", I),
             primary="Add", done_msg="Added (sample). Logged in the audit log."),
      dialog("d_role", "Change role",
             sel("Person", ["p.kato · Peter K.", "s.nambi · Sarah N.", "r.achieng · Ruth A.", "t.mugisha · Tester 1"], 0),
             seg("New role", ["Admin", "Lead", "Modeller", "Reviewer", "Viewer"], 1),
             chips("Disciplines", ["Z", "A", "S", "M", "E", "P"], {"A"}),
             ta("Reason (goes in the audit log)", "", "e.g. Leads architecture while Sarah is on leave", rows=2),
             primary="Change role", done_msg="Role changed (sample). Logged."),
      dialog("d_perm", "Edit permissions",
             seg("Role", ["Lead", "Modeller", "Reviewer", "Viewer"], 0),
             sel("Families", ["Full, own discipline", "Check and add parameters", "Read", "Hidden"], 0),
             sel("Sheets", ["Full, own discipline", "Place views", "Read", "Hidden"], 0),
             sel("Annotate", ["Run on live model, own discipline", "Own views only", "Hidden"], 0),
             sel("Reviews", ["Raise, assign and close", "Fix and write solution", "Raise and check", "Read"], 0),
             sel("Workshare", ["Worksets, own discipline", "Sync form and sync", "Read", "Hidden"], 0),
             toggle("Use AI buttons", True, "Within the cap per person"),
             note("Admin rights cannot be given here. Use Change role.", W),
             primary="Save permissions", done_msg="Permissions saved (sample). Logged."),
      dialog("d_hand", "Pass admin to someone else",
             sel("New admin", ["s.nambi · Sarah N.", "r.achieng · Ruth A."], 0),
             toggle("Keep me as backup admin", True),
             note("The new admin's computer gets the admin key when they accept. Until then you stay admin.", W),
             primary="Send handover", done_msg="Handover sent (sample). Waiting for them to accept."))
admin = pane("Admin", WIP, G, body, [btn("Save", True), btn("Open team file")], "Team file saved 10:42", dialogs="".join(dl))
board("PaneAdmin.dc.html", "Admin pane", "Pane · Admin",
      "Who is on the team, what each role can do, and who can change it",
      "Only admins see the Admin button in the pane header. The admin is a person, not a computer: the team file beside the central model says who is who, and the plugin shows each person only what their role allows.",
      admin,
      [("Team", "Table + Add, Change role", "People, Revit user names, roles, disciplines", "Roadmap: Admin"),
       ("Permissions", "Role × pane table, Edit", "What each role sees and can run", "Roadmap: Admin"),
       ("Project settings", "Dropdown, tabs", "Standard, stages, status and revision codes", "MAN 3.2, MAN 4.4"),
       ("AI", "Switch, caps", "Claude in shared models; spend per person and team", "D1, ClaudeUse"),
       ("Licences", "Seats, locked switch", "Seat count; licence check on from the beta", "Roadmap 0.1"),
       ("Audit log", "Table", "Every role, rule or setting change, with who and when", "—"),
       ("Handover", "Backup admin, Pass admin", "Never locked out; admin key moves on acceptance", "Roadmap: Admin")],
      callout("Honest limit", "The plugin hides and locks its own buttons by role, but it cannot stop someone using Revit's own tools. Real file protection comes from folder permissions or a common data environment. Roles guide the team; they are not a security wall."))

# ======================= RIBBON v2 =======================
PANELS = [("Connect", [("Connect", "Browser"), ("Claude", "Ask Claude")]), ("Project", [("Project", "New project")]),
          ("Templates", [("Templates", "Build")]), ("Families", [("Families", "Recipe"), ("Families", "Batch")]),
          ("Sheets", [("Sheets", "Sheets")]), ("Annotate", [("Annotate", "Annotate")]), ("Check", [("QA", "Run QA")]),
          ("Coordinate", [("Links", "Links"), ("Links", "Sync")]), ("Rules", [("Rules", "Rulebooks")]), ("Log", [("Activity", "Activity")])]
pan = []
for name, bts in PANELS:
    b = "".join(f'<div style="width: 58px; display: flex; flex-direction: column; align-items: center; gap: 4px"><span style="width: 34px; height: 34px; border-radius: 8px; '
                f'background: {NAVY if k == 0 else "#FFFFFF"}; border: 1px solid {NAVY}; display: flex; align-items: center; justify-content: center">{icon(ic, "#FFFFFF" if k == 0 else NAVY, 20)}</span>'
                f'<span style="font-size: 11px; text-align: center; line-height: 1.2">{E(lab)}</span></div>' for k, (ic, lab) in enumerate(bts))
    pan.append(f'<div style="display: flex; flex-direction: column; align-items: center; padding: 0 8px; border-right: 1px solid #E3E6EA"><div style="display: flex; gap: 2px">{b}</div>'
               f'<div style="margin-top: 6px; font-size: 11px; color: {MUTED}">{E(name)}</div></div>')
cards = [("Connect", "Connect pane: Claude, API key, kit, folders, safety"), ("Project", "Project pane: the new-project form"),
         ("Templates", "Templates pane: build a client's templates"), ("Families", "Families pane: recipe, inject, batch"),
         ("Sheets", "Sheets pane: sets, layout, issue"), ("Annotate", "Annotate pane: tags, dimensions, keynotes"),
         ("Check", "QA pane: gates, health, report"), ("Coordinate", "Links and sync pane"),
         ("Rules", "Rulebooks pane: rules and decisions"), ("Log", "Activity: every action and Claude call")]
cg = "".join(f'<div style="background: #FFFFFF; border: 1px solid #DDE1E6; border-top: 3px solid {ORANGE}; border-radius: 8px; padding: 10px 12px">'
             f'<div style="font-size: 15px; font-weight: 600">{E(a)}</div><div style="margin-top: 3px; font-size: 13px; line-height: 1.45; color: #3B424D">{E(b)}</div></div>' for a, b in cards)
ribbon = f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Formcraft ribbon</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
body{{margin:0}}
a{{color:{NAVY}}}a:hover{{color:#2C6B63}}
</style>
</helmet>
<div style="position: relative; width: 1440px; height: 810px; box-sizing: border-box; padding: 40px 56px; background: #F6F7F9; color: {INK}; font-family: 'IBM Plex Sans', sans-serif; display: flex; flex-direction: column; gap: 20px">
  <img src="{LOGO}" alt="Formcraft Design &amp; Construction" style="position: absolute; top: 12px; right: 24px; height: 22px; width: auto">
  <div>
    <div style="{MONO}; font-size: 15px; letter-spacing: 2px; text-transform: uppercase; color: #4A515C">Ribbon</div>
    <h2 style="margin: 8px 0 0; font-size: 36px; line-height: 1.08; font-weight: 700; letter-spacing: -1px">One Formcraft tab: a panel for every feature</h2>
  </div>
  <div style="background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 10px; overflow: hidden">
    <div style="display: flex; gap: 2px; padding: 6px 12px 0; background: #EEF0F3; font-size: 13px; color: {MUTED}">
      <span style="padding: 5px 10px">Architecture</span><span style="padding: 5px 10px">Systems</span><span style="padding: 5px 10px">Annotate</span><span style="padding: 5px 10px">View</span><span style="padding: 5px 10px">Manage</span>
      <span style="padding: 5px 12px; background: #FFFFFF; color: {NAVY}; font-weight: 600; border-radius: 6px 6px 0 0; box-shadow: inset 0 -2px 0 {ORANGE}">Formcraft</span>
    </div>
    <div style="display: flex; padding: 12px 4px 8px; overflow: hidden">{"".join(pan)}</div>
  </div>
  <div style="display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px">{cg}</div>
  <div style="font-size: 14px; line-height: 1.5; color: #3B424D">Every button opens the Formcraft Browser pane at its section, so there is one pane to learn. The filled button in each panel is the main action; the outlined one is the second. Revit's own tabs are untouched.</div>
  <div style="margin-top: auto; {MONO}; font-size: 12px; color: {MUTED}">Planned design.</div>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":1440,"height":810}}}}'>
class Component extends DCLogic {{
renderVals() {{
return {{}};
}}
}}
</script>
</body>
</html>
'''
(ROOT / "Ribbon.dc.html").write_text(ribbon, encoding="utf-8")

# ======================= canvas.json (only when updating an existing canvas folder) =======================
if (ROOT / "canvas.json").exists():
    cj = json.loads((ROOT / "canvas.json").read_text(encoding="utf-8"))
    new = ["PaneConnect", "PaneProject", "PaneTemplates", "PaneFamilies", "PaneSheets", "PaneAnnotate", "PaneQA", "PaneLinks", "PaneRules"]
    titles = ["Pane: Connect (main)", "Pane: Project", "Pane: Templates", "Pane: Families", "Pane: Sheets Manager",
              "Pane: Annotation Master", "Pane: QA and health", "Pane: Links and sync", "Pane: Rulebooks"]
    y0 = 8460
    for k, (n, t) in enumerate(zip(new, titles)):
        key = n + ".dc.html"
        cj["boards"][key] = {"x": 0 if k % 2 == 0 else 1520, "y": y0 + (k // 2) * 1360, "w": 1440, "h": 1240, "title": t}
        if key not in cj["order"]:
            cj["order"].append(key)
    cj["boards"]["PaneReview.dc.html"] = {"x": 1520, "y": 13900, "w": 1440, "h": 1240, "title": "Pane: Revisions and reviews"}
    cj["boards"]["ReviewOnSheet.dc.html"] = {"x": 0, "y": 15260, "w": 1440, "h": 960, "title": "Revision on the drawing"}
    cj["boards"]["PaneWorkshare.dc.html"] = {"x": 0, "y": 16340, "w": 1440, "h": 1240, "title": "Pane: Workshare"}
    cj["boards"]["SheetPrints.dc.html"] = {"x": 1520, "y": 15260, "w": 1440, "h": 960, "title": "Sheet prints: for review and revised"}
    for key in ("PaneReview.dc.html", "ReviewOnSheet.dc.html", "SheetPrints.dc.html", "PaneWorkshare.dc.html"):
        if key not in cj["order"]:
            cj["order"].append(key)
    cj["notes"]["panes"] = {"kind": "title1", "x": 0, "y": 8160, "text": "Plugin UI: the ribbon and every pane", "maxW": 2960}
    (ROOT / "canvas.json").write_text(json.dumps(cj, indent=1, ensure_ascii=False), encoding="utf-8")
    print("ok", len(new), "panes")
