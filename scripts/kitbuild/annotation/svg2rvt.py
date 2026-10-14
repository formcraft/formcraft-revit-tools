"""Convert research SVG symbols (viewBox 0 0 40 24) to a line-based primitive list for the Revit symbol builder.
Units out: paper mm, origin at symbol centre, y up. Scale K mm per SVG unit."""
import json, math, re, sys
import xml.etree.ElementTree as ET

K = 0.35
TOL = 0.85  # mm, above Revit ShortCurveTolerance (~0.78 mm)
NS = '{http://www.w3.org/2000/svg}'


def P(x, y):
    return ((x - 20) * K, (12 - y) * K)


def f(v):
    return f"{v:.3f}".rstrip('0').rstrip('.')


def tok_path(d):
    for m in re.finditer(r'([MmLlHhVvZzAaQqTtCcSs])|(-?\d*\.?\d+(?:e-?\d+)?)', d):
        yield m.group(1) or float(m.group(2))


def parse_path(d):
    """Return list of subpaths; each is list of segments ('L',p0,p1) ('A',p0,p1,rx,ry,rot,large,sweep) ('Q',p0,c,p1) ('C',p0,c1,c2,p1) and closed flag."""
    toks = list(tok_path(d))
    i = 0; cmd = None; cur = (0, 0); start = (0, 0); subs = []; segs = None; lastc = None; lastcmd = None
    def num():
        nonlocal i
        v = toks[i]; i += 1; return v
    while i < len(toks):
        if isinstance(toks[i], str):
            cmd = toks[i]; i += 1
            if cmd in 'Zz':
                if segs is not None:
                    if math.dist(cur, start) > 1e-6: segs.append(('L', cur, start))
                    subs.append((segs, True)); segs = None
                cur = start; lastcmd = cmd; continue
        rel = cmd.islower(); c = cmd.upper()
        if c == 'M':
            x, y = num(), num()
            if rel: x += cur[0]; y += cur[1]
            if segs: subs.append((segs, False))
            segs = []; cur = start = (x, y); cmd = 'l' if rel else 'L'; lastcmd = 'M'; continue
        if segs is None: segs = []; start = cur
        if c == 'L':
            x, y = num(), num()
            if rel: x += cur[0]; y += cur[1]
            segs.append(('L', cur, (x, y))); cur = (x, y)
        elif c == 'H':
            x = num(); x = x + cur[0] if rel else x
            segs.append(('L', cur, (x, cur[1]))); cur = (x, cur[1])
        elif c == 'V':
            y = num(); y = y + cur[1] if rel else y
            segs.append(('L', cur, (cur[0], y))); cur = (cur[0], y)
        elif c == 'A':
            rx, ry, rot, la, sw, x, y = [num() for _ in range(7)]
            if rel: x += cur[0]; y += cur[1]
            segs.append(('A', cur, (x, y), rx, ry, rot, int(la), int(sw))); cur = (x, y)
        elif c == 'Q':
            cx, cy, x, y = [num() for _ in range(4)]
            if rel: cx += cur[0]; cy += cur[1]; x += cur[0]; y += cur[1]
            segs.append(('Q', cur, (cx, cy), (x, y))); lastc = (cx, cy); cur = (x, y)
        elif c == 'T':
            x, y = num(), num()
            if rel: x += cur[0]; y += cur[1]
            if lastcmd and lastcmd.upper() in 'QT' and lastc: cx, cy = 2 * cur[0] - lastc[0], 2 * cur[1] - lastc[1]
            else: cx, cy = cur
            segs.append(('Q', cur, (cx, cy), (x, y))); lastc = (cx, cy); cur = (x, y)
        elif c == 'C':
            a, b, cc, dd, x, y = [num() for _ in range(6)]
            if rel: a += cur[0]; b += cur[1]; cc += cur[0]; dd += cur[1]; x += cur[0]; y += cur[1]
            segs.append(('C', cur, (a, b), (cc, dd), (x, y))); lastc = (cc, dd); cur = (x, y)
        elif c == 'S':
            cc, dd, x, y = [num() for _ in range(4)]
            if rel: cc += cur[0]; dd += cur[1]; x += cur[0]; y += cur[1]
            a, b = (2 * cur[0] - lastc[0], 2 * cur[1] - lastc[1]) if lastcmd and lastcmd.upper() in 'CS' and lastc else cur
            segs.append(('C', cur, (a, b), (cc, dd), (x, y))); lastc = (cc, dd); cur = (x, y)
        lastcmd = cmd
    if segs: subs.append((segs, False))
    return subs


def arc_center(p0, p1, rx, ry, phi, fa, fs):
    """SVG endpoint arc -> centre param (circular only when rx==ry). Returns (cx,cy,r,t0,dt)."""
    rx, ry = abs(rx), abs(ry)
    phi = math.radians(phi); cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    x1 = cp * dx + sp * dy; y1 = -sp * dx + cp * dy
    lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry)
    if lam > 1: rx *= math.sqrt(lam); ry *= math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    den = rx * rx * y1 * y1 + ry * ry * x1 * x1
    co = math.sqrt(max(0, num / den)) if den else 0
    if fa == fs: co = -co
    cxp = co * rx * y1 / ry; cyp = -co * ry * x1 / rx
    cx = cp * cxp - sp * cyp + (p0[0] + p1[0]) / 2; cy = sp * cxp + cp * cyp + (p0[1] + p1[1]) / 2
    def ang(u, v): return math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1])
    t0 = ang((1, 0), ((x1 - cxp) / rx, (y1 - cyp) / ry))
    dt = ang(((x1 - cxp) / rx, (y1 - cyp) / ry), ((-x1 - cxp) / rx, (-y1 - cyp) / ry))
    if not fs and dt > 0: dt -= 2 * math.pi
    if fs and dt < 0: dt += 2 * math.pi
    return cx, cy, rx, ry, phi, t0, dt


def flatten(seg, n=None):
    """Points along a segment in SVG units (excluding start)."""
    t = seg[0]
    if t == 'L': return [seg[2]]
    if t == 'Q':
        p0, c, p1 = seg[1:]; n = n or 8
        return [((1 - s) ** 2 * p0[0] + 2 * (1 - s) * s * c[0] + s * s * p1[0], (1 - s) ** 2 * p0[1] + 2 * (1 - s) * s * c[1] + s * s * p1[1]) for s in [k / n for k in range(1, n + 1)]]
    if t == 'C':
        p0, a, b, p1 = seg[1:]; n = n or 10
        out = []
        for k in range(1, n + 1):
            s = k / n; u = 1 - s
            out.append((u ** 3 * p0[0] + 3 * u * u * s * a[0] + 3 * u * s * s * b[0] + s ** 3 * p1[0], u ** 3 * p0[1] + 3 * u * u * s * a[1] + 3 * u * s * s * b[1] + s ** 3 * p1[1]))
        return out
    if t == 'A':
        cx, cy, rx, ry, phi, t0, dt = arc_center(seg[1], seg[2], *seg[3:])
        n = n or max(4, int(abs(dt) / (math.pi / 8)))
        out = []
        for k in range(1, n + 1):
            a = t0 + dt * k / n
            x, y = rx * math.cos(a), ry * math.sin(a)
            out.append((cx + math.cos(phi) * x - math.sin(phi) * y, cy + math.sin(phi) * x + math.cos(phi) * y))
        out[-1] = seg[2]
        return out


def clean_poly(pts):
    """Paper-mm polygon with points closer than TOL dropped."""
    q = []
    for p in pts:
        if not q or math.dist(q[-1], p) > TOL: q.append(p)
    while len(q) > 2 and math.dist(q[-1], q[0]) <= TOL: q.pop()
    return q if len(q) >= 3 else None


class Out:
    def __init__(self): self.rows = []; self.skipped = 0

    def line(self, a, b, cls):
        a, b = P(*a), P(*b)
        if math.dist(a, b) <= TOL:
            self.skipped += 1; return
        self.rows.append(f"L|{f(a[0])}|{f(a[1])}|{f(b[0])}|{f(b[1])}|{cls}")

    def poly(self, pts, cls, closed=False):
        q = [P(*p) for p in pts]
        if closed: q.append(q[0])
        r = [q[0]]
        for p in q[1:]:
            if math.dist(r[-1], p) > TOL: r.append(p)
            elif p is q[-1] and len(r) > 1: r[-1] = p
        if len(r) < 2: self.skipped += 1; return
        for a, b in zip(r, r[1:]): self.rows.append(f"L|{f(a[0])}|{f(a[1])}|{f(b[0])}|{f(b[1])}|{cls}")

    def arc(self, seg, cls):
        cx, cy, rx, ry, phi, t0, dt = arc_center(seg[1], seg[2], *seg[3:])
        if abs(rx - ry) > 1e-6 * max(rx, 1) or rx * K < TOL / 2:
            self.poly([seg[1]] + flatten(seg), cls); return
        # split into <=180 deg pieces, emit 3-point arcs
        n = max(1, int(math.ceil(abs(dt) / math.pi * 1.0001)))
        prev = seg[1]
        for k in range(1, n + 1):
            am = t0 + dt * (k - 0.5) / n; ae = t0 + dt * k / n
            pm = (cx + rx * math.cos(am), cy + rx * math.sin(am)); pe = seg[2] if k == n else (cx + rx * math.cos(ae), cy + rx * math.sin(ae))
            a, m, b = P(*prev), P(*pm), P(*pe)
            if math.dist(a, b) <= TOL: self.skipped += 1
            else: self.rows.append(f"A|{f(a[0])}|{f(a[1])}|{f(m[0])}|{f(m[1])}|{f(b[0])}|{f(b[1])}|{cls}")
            prev = pe

    def circle(self, cx, cy, r, cls):
        c = P(cx, cy)
        if r * K * 2 <= TOL: self.skipped += 1; return
        self.rows.append(f"C|{f(c[0])}|{f(c[1])}|{f(r * K)}|{cls}")

    def fill(self, loops):
        good = []
        for lp in loops:
            l = clean_poly([P(*p) for p in lp])
            if l: good.append(l); continue
            # tiny dot: draw a short dash so it still prints
            x = sum(p[0] for p in lp) / len(lp); y = sum(p[1] for p in lp) / len(lp); c = P(x, y)
            self.rows.append(f"L|{f(c[0] - 0.45)}|{f(c[1])}|{f(c[0] + 0.45)}|{f(c[1])}|m")
        if good: self.rows.append("F|" + "|".join(";".join(f"{f(p[0])},{f(p[1])}" for p in l) for l in good))

    def text(self, x, y, size, anchor, bold, s):
        p = P(x, y)
        al = {'middle': 'c', 'end': 'r'}.get(anchor, 'l')
        self.rows.append(f"T|{f(p[0])}|{f(p[1])}|{size}|{al}|{1 if bold else 0}|{s.replace('|', '/')}")


def cls_of(st):
    w = float(st.get('stroke-width', 1))
    if st.get('stroke-dasharray', 'none') not in ('none', ''): return 'd'
    return 't' if w < 0.8 else ('m' if w <= 1.4 else 'h')


def is_on(v): return v not in (None, 'none', 'transparent')


def walk(el, st, out):
    st = dict(st)
    for k in ('stroke', 'fill', 'stroke-width', 'stroke-dasharray', 'font-size', 'text-anchor', 'font-weight'):
        if k in el.attrib: st[k] = el.attrib[k]
    if 'style' in el.attrib:
        for kv in el.attrib['style'].split(';'):
            if ':' in kv: k, v = kv.split(':', 1); st[k.strip()] = v.strip()
    if 'transform' in el.attrib: raise ValueError('transform not supported')
    tag = el.tag.replace(NS, '')
    stroke = is_on(st.get('stroke')); fill = is_on(st.get('fill', 'black')); cls = cls_of(st)
    a = lambda k, d=0: float(el.attrib.get(k, d))
    if tag == 'line':
        if stroke: out.line((a('x1'), a('y1')), (a('x2'), a('y2')), cls)
    elif tag == 'circle':
        cx, cy, r = a('cx'), a('cy'), a('r')
        loop = [(cx + r * math.cos(t * math.pi / 12), cy + r * math.sin(t * math.pi / 12)) for t in range(24)]
        if fill: out.fill([loop])
        if stroke: out.circle(cx, cy, r, cls)
    elif tag == 'rect':
        x, y, w, h, rx = a('x'), a('y'), a('width'), a('height'), a('rx', 0)
        rx = min(rx, w / 2, h / 2)
        if rx > 0:
            pts = []
            for (cx, cy, a0) in ((x + w - rx, y + rx, -90), (x + w - rx, y + h - rx, 0), (x + rx, y + h - rx, 90), (x + rx, y + rx, 180)):
                for k in range(4): t = math.radians(a0 + k * 30); pts.append((cx + rx * math.cos(t), cy + rx * math.sin(t)))
        else:
            pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        if fill: out.fill([pts])
        if stroke: out.poly(pts, cls, closed=True)
    elif tag == 'path':
        subs = parse_path(el.attrib['d'])
        if fill:
            loops = []
            for segs, closed in subs:
                pts = [segs[0][1]]
                for sg in segs: pts += flatten(sg)
                if len(pts) >= 3: loops.append(pts)
            if loops: out.fill(loops)
        if stroke:
            for segs, closed in subs:
                for sg in segs:
                    if sg[0] == 'L': out.line(sg[1], sg[2], cls)
                    elif sg[0] == 'A': out.arc(sg, cls)
                    else: out.poly([sg[1]] + flatten(sg), cls)
    elif tag == 'text':
        s = ''.join(el.itertext()).strip()
        if s:
            fs = float(st.get('font-size', 7))
            out.text(a('x'), a('y'), fs, st.get('text-anchor', 'start'), st.get('font-weight', '') in ('bold', '700', '600'), s)
        return
    for ch in el: walk(ch, st, out)


def fam_name(role, name):
    base = re.sub(r'\(.*?\)', lambda m: ' ' + m.group(0)[1:-1], name)
    base = base.replace('&', 'And').replace('+', 'Plus').replace('/', ' ').replace('-', ' ')
    words = re.findall(r'[A-Za-z0-9]+', base)
    desc = ''.join(w[:1].upper() + w[1:] for w in words)
    return f"FMC_SYM_{role}_{desc}"


def main(src, dst):
    d = json.load(open(src))
    rows = []; seen = set(); stats = {}
    for role, v in d.items():
        for s in v['symbols']:
            o = Out()
            root = ET.fromstring(s['svg'])
            walk(root, {'stroke-width': '1', 'fill': 'black'}, o)
            fam = fam_name(role, s['name'])
            n = 2
            while fam in seen: fam = fam_name(role, s['name']) + str(n); n += 1
            seen.add(fam)
            rows.append(f"S|{role}|{fam}|{s['name']}")
            rows += o.rows
            stats[fam] = (len(o.rows), o.skipped)
    open(dst, 'w', encoding='utf-8').write('\n'.join(rows) + '\n')
    print(len(seen), 'symbols;', sum(v[0] for v in stats.values()), 'prims;', sum(v[1] for v in stats.values()), 'skipped')
    big = sorted(stats.items(), key=lambda kv: -kv[1][0])[:5]; print('largest', big)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
