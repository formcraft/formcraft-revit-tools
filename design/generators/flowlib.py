import sys, html
from pathlib import Path
ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
E = lambda s: html.escape(str(s), quote=True)
LOGO = "/_blob/c0d01c2697f491e1308003dd48747c8b"
NAVY, ORANGE, INK, MUTED, LINE, TEAL = "#1B2532", "#FFAE61", "#1A1D21", "#5B6270", "#C9CED6", "#2C6B63"
MONO = "font-family: 'IBM Plex Mono', monospace"
CHIP = {"good": ("#E6F4EA", "#1E6B34"), "warn": ("#FFF4E0", "#6B4100"), "bad": ("#FDECEA", "#A50E0E"), "grey": ("#EEF0F3", "#4A515C"), "info": ("#E3F2EF", "#2C6B63")}

def chip(t, k="grey"):
    bg, fg = CHIP[k]
    return f'<span style="font-size: 11.5px; padding: 2px 8px; border-radius: 9px; background: {bg}; color: {fg}; white-space: nowrap">{E(t)}</span>'

def page(fname, title, eyebrow, headline, body, w=1440, h=810, foot=""):
    f = f'<div style="margin-top: auto; {MONO}; font-size: 12px; color: {MUTED}">{E(foot)}</div>' if foot else ""
    out = f'''<!doctype html>
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
a{{color:{NAVY}}}a:hover{{color:{TEAL}}}
</style>
</helmet>
<div style="position: relative; width: {w}px; height: {h}px; box-sizing: border-box; padding: 40px 56px; background: #F6F7F9; color: {INK}; font-family: 'IBM Plex Sans', sans-serif; display: flex; flex-direction: column; gap: 18px">
  <img src="{LOGO}" alt="Formcraft Design &amp; Construction" style="position: absolute; top: 10px; right: 24px; height: 22px; width: auto">
  <div>
    <div style="{MONO}; font-size: 15px; letter-spacing: 2px; text-transform: uppercase; color: #4A515C">{E(eyebrow)}</div>
    <h2 style="margin: 8px 0 0; font-size: 36px; line-height: 1.08; font-weight: 700; letter-spacing: -1px">{E(headline)}</h2>
  </div>
  {body}
  {f}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
class Component extends DCLogic {{
renderVals() {{
return {{}};
}}
}}
</script>
</body>
</html>
'''
    (ROOT / fname).write_text(out, encoding="utf-8")

def card(title, lines, top=NAVY, tag=None, tagk="grey", minh=0, fill="#FFFFFF"):
    t = f'<span style="margin-left: auto">{chip(tag, tagk)}</span>' if tag else ""
    li = "".join(f'<li>{E(x)}</li>' for x in lines)
    return (f'<div style="background: {fill}; border: 1px solid #DDE1E6; border-top: 4px solid {top}; border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; min-height: {minh}px; box-sizing: border-box">'
            f'<div style="display: flex; align-items: center; gap: 8px"><span style="font-size: 16px; font-weight: 700">{E(title)}</span>{t}</div>'
            f'<ul style="margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; font-size: 13.5px; line-height: 1.4; color: #2A3038">{li}</ul></div>')

def grid(items, cols, gap=16):
    return f'<div style="display: grid; grid-template-columns: repeat({cols}, minmax(0, 1fr)); gap: {gap}px">{"".join(items)}</div>'

def steps(items, accent_idx=()):
    arrow = '<div style="display: flex; align-items: center; justify-content: center; width: 22px; flex-shrink: 0"><svg width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><path d="M1 7h18 M14 2l5 5-5 5" fill="none" stroke="#5B6270" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"></path></svg></div>'
    out = []
    for k, (t, d) in enumerate(items):
        acc = k in accent_idx
        out.append(f'<div style="flex: 1; min-width: 0; background: {"#FFF4E0" if acc else "#FFFFFF"}; border: 1px solid {"#FFAE61" if acc else "#DDE1E6"}; border-radius: 8px; padding: 10px 12px">'
                   f'<div style="{MONO}; font-size: 12px; color: {MUTED}">{k + 1:02d}</div><div style="font-size: 15px; font-weight: 600; margin-top: 2px">{E(t)}</div>'
                   f'<div style="font-size: 12.5px; line-height: 1.4; color: #3B424D; margin-top: 4px">{E(d)}</div></div>')
    return f'<div style="display: flex; align-items: stretch; gap: 0">{arrow.join(out)}</div>'

def callouts(items, cols=None):
    cols = cols or len(items)
    return grid([f'<div style="border-top: 3px solid {c}; padding-top: 8px"><div style="font-size: 15px; font-weight: 600">{E(t)}</div><div style="margin-top: 3px; font-size: 13.5px; line-height: 1.5; color: #3B424D">{E(d)}</div></div>' for t, d, c in items], cols, 24)

def table(head, rows, widths):
    gc = " ".join(widths)
    h = "".join(f'<span>{E(x)}</span>' for x in head)
    body = ""
    for r in rows:
        cells = "".join((chip(*x) if isinstance(x, tuple) else f'<span>{E(x)}</span>') for x in r)
        body += f'<div style="display: grid; grid-template-columns: {gc}; gap: 10px; padding: 7px 10px; border-top: 1px solid #E3E6EA; font-size: 13px; align-items: center">{cells}</div>'
    return (f'<div style="background: #FFFFFF; border: 1px solid #DDE1E6; border-radius: 8px; overflow: hidden"><div style="display: grid; grid-template-columns: {gc}; gap: 10px; padding: 6px 10px; '
            f'background: #F1F3F5; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: {MUTED}">{h}</div>{body}</div>')


# ================= flowchart renderer =================
KIND = {
    "start": ("#1B2532", "#1B2532", "#FFFFFF", None, 22),
    "end":   ("#FFFFFF", "#1B2532", "#1A1D21", None, 22),
    "step":  ("#FFFFFF", "#C9CED6", "#1A1D21", None, 6),
    "auto":  ("#FFFFFF", "#C9CED6", "#1A1D21", "Engine", 6),
    "decide":("#FFF4E0", "#FFAE61", "#1A1D21", "?", 6),
    "gate":  ("#FFAE61", "#C77400", "#1A1D21", "Person", 6),
    "data":  ("#E3F2EF", "#7FC7BE", "#1A1D21", "Data", 6),
    "revit": ("#EEF0F3", "#9AA1AB", "#1A1D21", "Revit", 6),
    "stop":  ("#FDECEA", "#D93025", "#1A1D21", None, 6),
    "ai":    ("#FFFFFF", "#FFAE61", "#1A1D21", "AI · Phase 2", 6),
    "model": ("#FFFFFF", "#C9CED6", "#1A1D21", "Model", 6),
    "flow":  ("#FFFFFF", "#7FC7BE", "#1A1D21", "Flow", 6),
}
KIND_LABEL = {"start": "Start / trigger", "end": "Result", "step": "Step", "auto": "Engine step", "decide": "Decision", "gate": "Person decides",
              "data": "Data / file", "revit": "Inside Revit", "stop": "Stopped, nothing changed", "ai": "AI, Phase 2", "model": "Model step", "flow": "Flow step"}

class FC:
    def __init__(self, W, H, cw, rh, lanes=None, lw=0, nw=None, nh=None):
        self.W, self.H, self.cw, self.rh, self.lanes, self.lw = W, H, cw, rh, lanes or [], lw
        self.nw, self.nh = nw or cw - 26, nh or rh - 24
        self.n, self.e = {}, []
    def node(self, id, c, r, kind, title, sub="", span=1, w=None, h=None, dx=0, dy=0):
        w = w or (self.nw + (span - 1) * self.cw)
        h = h or self.nh
        x = self.lw + c * self.cw + (self.cw * span - w) / 2 + dx
        y = r * self.rh + (self.rh - h) / 2 + dy
        self.n[id] = dict(x=x, y=y, w=w, h=h, kind=kind, title=title, sub=sub)
        return self
    def edge(self, a, b, label="", mode="auto", off=22, lp=None):
        self.e.append((a, b, label, mode, off, lp)); return self
    def _pts(self, a, b, mode, off):
        A, B = self.n[a], self.n[b]
        acx, acy, bcx, bcy = A["x"] + A["w"] / 2, A["y"] + A["h"] / 2, B["x"] + B["w"] / 2, B["y"] + B["h"] / 2
        if mode == "auto":
            if abs(acy - bcy) < 2: mode = "h"
            elif abs(acx - bcx) < 2: mode = "v"
            elif bcy > acy: mode = "v"
            else: mode = "loopR"
        if mode == "h":
            if bcx > acx: x1, x2 = A["x"] + A["w"], B["x"]
            else: x1, x2 = A["x"], B["x"] + B["w"]
            if abs(acy - bcy) < 2: return [(x1, acy), (x2, bcy)]
            mx = (x1 + x2) / 2
            return [(x1, acy), (mx, acy), (mx, bcy), (x2, bcy)]
        if mode == "v":
            if bcy > acy: y1, y2 = A["y"] + A["h"], B["y"]
            else: y1, y2 = A["y"], B["y"] + B["h"]
            if abs(acx - bcx) < 2: return [(acx, y1), (bcx, y2)]
            my = (y1 + y2) / 2
            return [(acx, y1), (acx, my), (bcx, my), (bcx, y2)]
        if mode == "vh":
            y1 = A["y"] + A["h"] if bcy > acy else A["y"]
            x2 = B["x"] if bcx > acx else B["x"] + B["w"]
            return [(acx, y1), (acx, bcy), (x2, bcy)]
        if mode == "hv":
            x1 = A["x"] + A["w"] if bcx > acx else A["x"]
            y2 = B["y"] if bcy > acy else B["y"] + B["h"]
            return [(x1, acy), (bcx, acy), (bcx, y2)]
        if mode == "loopR":
            x = max(A["x"] + A["w"], B["x"] + B["w"]) + off
            return [(A["x"] + A["w"], acy), (x, acy), (x, bcy), (B["x"] + B["w"], bcy)]
        if mode == "loopL":
            x = min(A["x"], B["x"]) - off
            return [(A["x"], acy), (x, acy), (x, bcy), (B["x"], bcy)]
        if mode == "loopB":
            y = max(A["y"] + A["h"], B["y"] + B["h"]) + off
            return [(acx, A["y"] + A["h"]), (acx, y), (bcx, y), (bcx, B["y"] + B["h"])]
        if mode == "loopT":
            y = min(A["y"], B["y"]) - off
            return [(acx, A["y"]), (acx, y), (bcx, y), (bcx, B["y"])]
        raise ValueError(mode)
    def html(self):
        out = [f'<div style="position: relative; width: {self.W}px; height: {self.H}px; flex-shrink: 0">']
        for k, (lab, r0, r1) in enumerate(self.lanes):
            out.append(f'<div style="position: absolute; left: 0; right: 0; top: {r0 * self.rh}px; height: {(r1 - r0) * self.rh}px; background: {"#FFFFFF" if k % 2 == 0 else "#EEF0F3"}; border-top: 1px solid #DDE1E6"></div>'
                       f'<div style="position: absolute; left: 0; top: {r0 * self.rh}px; width: {self.lw - 10}px; height: {(r1 - r0) * self.rh}px; display: flex; align-items: center; padding-left: 10px; box-sizing: border-box; '
                       f'font-family: \'IBM Plex Mono\', monospace; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #4A515C; line-height: 1.3">{E(lab)}</div>')
        svg = [f'<svg width="{self.W}" height="{self.H}" style="position: absolute; left: 0; top: 0; overflow: visible" aria-hidden="true"><defs>'
               '<marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#5B6270"></path></marker>'
               '<marker id="ahg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#1E8E3E"></path></marker>'
               '<marker id="ahr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#D93025"></path></marker></defs>']
        labels = []
        for a, b, lab, mode, off, lp in self.e:
            p = self._pts(a, b, mode, off)
            l = lab.lower()
            col, mk, dash = "#5B6270", "ah", ""
            if l.startswith(("yes", "pass", "ok", "approve", "match", "found", "present", "accept", "all pass", "allowed", "within")): col, mk = "#1E8E3E", "ahg"
            if l.startswith(("no", "fail", "refuse", "reject", "mismatch", "clash", "over", "too", "blocked", "not ", "newer", "reopen")): col, mk, dash = "#D93025", "ahr", ' stroke-dasharray="5 4"'
            d = "M" + " L".join(f"{x:.0f} {y:.0f}" for x, y in p)
            svg.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="1.6"{dash} marker-end="url(#{mk})"></path>')
            if lab:
                if lp: lx, ly = lp
                else:
                    segs = [(p[i], p[i + 1]) for i in range(len(p) - 1)]
                    (x1, y1), (x2, y2) = max(segs, key=lambda s: abs(s[0][0] - s[1][0]) + abs(s[0][1] - s[1][1]))
                    lx, ly = (x1 + x2) / 2, (y1 + y2) / 2
                labels.append(f'<div style="position: absolute; left: {lx:.0f}px; top: {ly:.0f}px; transform: translate(-50%, -50%); padding: 1px 6px; border-radius: 8px; background: #FFFFFF; border: 1px solid {col}; '
                              f'font-size: 11px; line-height: 1.3; color: {col}; white-space: nowrap; font-weight: 500">{E(lab)}</div>')
        svg.append('</svg>')
        out.append("".join(svg))
        for id, n in self.n.items():
            bg, bd, fg, tag, rad = KIND[n["kind"]]
            bw = 2 if n["kind"] in ("end", "decide", "stop", "ai", "flow") else 1
            style = "dashed" if n["kind"] == "ai" else "solid"
            left = f"border-left: 4px solid #1B2532;" if n["kind"] == "auto" else (f"border-left: 4px solid #33465C;" if n["kind"] == "model" else "")
            tg = ""
            if tag == "?":
                tg = '<span style="flex-shrink: 0; width: 16px; height: 16px; border-radius: 50%; background: #FFAE61; color: #1A1D21; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center">?</span>'
            elif tag:
                tg = f'<span style="position: absolute; top: -8px; right: 8px; font-size: 9.5px; padding: 0 5px; border-radius: 3px; background: {"#1B2532" if n["kind"] != "gate" else "#FFFFFF"}; color: {"#FFFFFF" if n["kind"] != "gate" else "#6B4100"}; border: 1px solid {"#1B2532" if n["kind"] != "gate" else "#C77400"}; line-height: 14px">{tag}</span>'
            sub = f'<div style="font-size: 11.5px; line-height: 1.3; color: {"#C9D1DA" if n["kind"] == "start" else "#3B424D"}; margin-top: 2px">{E(n["sub"])}</div>' if n["sub"] else ""
            out.append(f'<div style="position: absolute; left: {n["x"]:.0f}px; top: {n["y"]:.0f}px; width: {n["w"]:.0f}px; height: {n["h"]:.0f}px; box-sizing: border-box; background: {bg}; border: {bw}px {style} {bd}; {left} '
                       f'border-radius: {rad}px; color: {fg}; padding: 6px 10px; display: flex; flex-direction: column; justify-content: center; {"align-items: center; text-align: center;" if n["kind"] in ("start", "end") else ""} box-shadow: 0 1px 2px rgba(26,29,33,0.06)">'
                       f'<div style="display: flex; align-items: center; gap: 6px; {"justify-content: center;" if n["kind"] in ("start", "end") else ""}">{tg if tag == "?" else ""}<span style="font-size: 13px; font-weight: 600; line-height: 1.25">{E(n["title"])}</span>'
                       f'</div>{sub}{tg if tag and tag != "?" else ""}</div>')
        out += labels
        out.append('</div>')
        return "".join(out)

def legend(kinds):
    it = []
    for k in kinds:
        bg, bd, fg, tag, rad = KIND[k]
        it.append(f'<span style="display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: #3B424D"><span style="width: 22px; height: 13px; border-radius: {min(rad, 7)}px; background: {bg}; border: 1.5px {"dashed" if k == "ai" else "solid"} {bd}"></span>{KIND_LABEL[k]}</span>')
    it.append('<span style="display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: #1E8E3E"><svg width="22" height="8" aria-hidden="true"><path d="M0 4h20" stroke="#1E8E3E" stroke-width="1.6"></path></svg>Yes / pass</span>')
    it.append('<span style="display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: #D93025"><svg width="22" height="8" aria-hidden="true"><path d="M0 4h20" stroke="#D93025" stroke-width="1.6" stroke-dasharray="5 4"></path></svg>No / fail</span>')
    return f'<div style="display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center">{"".join(it)}</div>'

def side(items):
    return (f'<div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 14px">'
            + "".join(f'<div style="border-top: 3px solid {c}; padding-top: 7px"><div style="font-size: 14.5px; font-weight: 600">{E(t)}</div><div style="margin-top: 3px; font-size: 13px; line-height: 1.45; color: #3B424D">{E(d)}</div></div>' for t, d, c in items)
            + '</div>')

def flowboard(fname, title, eyebrow, headline, fc, notes, kinds, h=900, foot=""):
    body = (legend(kinds) + f'<div style="display: flex; gap: 28px; flex-grow: 1; min-height: 0">{fc.html()}{side(notes)}</div>')
    page(fname, title, eyebrow, headline, body, h=h, foot=foot)
