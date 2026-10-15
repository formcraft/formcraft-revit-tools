/**
 * Ceiling engine geometry (Engineer › Ceilings, step CL1). Pure: orthogonal regions as sets of disjoint axis-aligned
 * rectangles in mm. A room is a rectangle or a simple orthogonal polygon; a bulkhead is the room minus the room eroded
 * by the bulkhead width (square corners, so the erosion uses a square, not a circle).
 */
export type Pt = [number, number];
export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface Seg { a: Pt; b: Pt }

const EPS = 1e-6;
const uniq = (v: number[]) => [...new Set(v.map((n) => Math.round(n * 1e6) / 1e6))].sort((a, b) => a - b);

export const rectArea = (r: Rect) => (r.x1 - r.x0) * (r.y1 - r.y0);
export const area = (rs: Rect[]) => rs.reduce((s, r) => s + rectArea(r), 0);

export function bbox(rs: Rect[]): Rect {
  return rs.reduce((b, r) => ({ x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
}

/** What is wrong with an outline: too few points, a sloping edge, a zero-length edge, edges that cross. */
export function polygonProblems(poly: Pt[]): string[] {
  const out: string[] = [];
  if (poly.length < 4) return ["The outline needs at least 4 corners"];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [a, b] = [poly[i], poly[(i + 1) % n]];
    if (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS) out.push(`Corners ${i + 1} and ${(i + 1) % n + 1} are the same point`);
    else if (Math.abs(a[0] - b[0]) > EPS && Math.abs(a[1] - b[1]) > EPS) out.push(`Edge ${i + 1} is not square to the axes: the outline must be orthogonal`);
  }
  if (out.length) return out;
  // crossing edges (non-adjacent, one vertical and one horizontal crossing strictly inside both)
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const [p, q] = [poly[i], poly[(i + 1) % n]];
    const [r, s] = [poly[j], poly[(j + 1) % n]];
    const v1 = Math.abs(p[0] - q[0]) < EPS, v2 = Math.abs(r[0] - s[0]) < EPS;
    if (v1 === v2) continue;
    const [V, H] = v1 ? [[p, q], [r, s]] : [[r, s], [p, q]];
    const x = V[0][0], y = H[0][1];
    const inV = y > Math.min(V[0][1], V[1][1]) + EPS && y < Math.max(V[0][1], V[1][1]) - EPS;
    const inH = x > Math.min(H[0][0], H[1][0]) + EPS && x < Math.max(H[0][0], H[1][0]) - EPS;
    if (inV && inH) { out.push(`Edges ${i + 1} and ${j + 1} cross: the outline must be a simple polygon`); return out; }
  }
  return out;
}

/** Strict inside test by ray casting (cell centres never sit on an edge). */
export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Merge grid cells into fewer rectangles: rows first, then stack equal rows. */
export function mergeRects(cells: Rect[]): Rect[] {
  const rows = new Map<string, Rect[]>();
  for (const c of cells) {
    const k = `${c.y0}|${c.y1}`;
    (rows.get(k) ?? rows.set(k, []).get(k)!).push(c);
  }
  const strips: Rect[] = [];
  for (const list of rows.values()) {
    list.sort((a, b) => a.x0 - b.x0);
    let cur = { ...list[0] };
    for (const c of list.slice(1)) {
      if (Math.abs(c.x0 - cur.x1) < EPS) cur.x1 = c.x1;
      else { strips.push(cur); cur = { ...c }; }
    }
    strips.push(cur);
  }
  strips.sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
  const out: Rect[] = [];
  for (const s of strips) {
    const prev = out.find((o) => Math.abs(o.x0 - s.x0) < EPS && Math.abs(o.x1 - s.x1) < EPS && Math.abs(o.y1 - s.y0) < EPS);
    if (prev) prev.y1 = s.y1; else out.push({ ...s });
  }
  return out;
}

function cellsOf(xs: number[], ys: number[], keep: (c: Pt) => boolean): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    if (xs[i + 1] - xs[i] < EPS || ys[j + 1] - ys[j] < EPS) continue;
    if (keep([(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2])) out.push({ x0: xs[i], y0: ys[j], x1: xs[i + 1], y1: ys[j + 1] });
  }
  return mergeRects(out);
}

export function polyRects(poly: Pt[]): Rect[] {
  return cellsOf(uniq(poly.map((p) => p[0])), uniq(poly.map((p) => p[1])), (c) => pointInPoly(c, poly));
}

/** Strictly inside (cell centres) or, with inclusive, on the boundary too. */
export function inRegion(p: Pt, rs: Rect[], inclusive = false): boolean {
  const e = inclusive ? EPS : -EPS;
  return rs.some((r) => p[0] > r.x0 - e && p[0] < r.x1 + e && p[1] > r.y0 - e && p[1] < r.y1 + e);
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The region shrunk by d on every side (a square of half-size d fits wholly inside at every kept point). */
export function erode(rs: Rect[], d: number): Rect[] {
  if (d <= 0) return rs.map((r) => ({ ...r }));
  const xs = uniq(rs.flatMap((r) => [r.x0, r.x1, r.x0 + d, r.x1 - d, r.x0 - d, r.x1 + d]));
  const ys = uniq(rs.flatMap((r) => [r.y0, r.y1, r.y0 + d, r.y1 - d, r.y0 - d, r.y1 + d]));
  return cellsOf(xs, ys, (c) => {
    const sq = { x0: c[0] - d, y0: c[1] - d, x1: c[0] + d, y1: c[1] + d };
    return Math.abs(rs.reduce((s, r) => s + overlap(sq, r), 0) - 4 * d * d) < 1e-3;
  });
}

export function subtract(a: Rect[], b: Rect[]): Rect[] {
  const all = [...a, ...b];
  return cellsOf(uniq(all.flatMap((r) => [r.x0, r.x1])), uniq(all.flatMap((r) => [r.y0, r.y1])), (c) => inRegion(c, a) && !inRegion(c, b));
}

export function intersect(a: Rect[], b: Rect[]): Rect[] {
  const all = [...a, ...b];
  return cellsOf(uniq(all.flatMap((r) => [r.x0, r.x1])), uniq(all.flatMap((r) => [r.y0, r.y1])), (c) => inRegion(c, a) && inRegion(c, b));
}

/** Where a vertical line x (or horizontal, axis "y") crosses the region, edges included: merged intervals. */
export function lineIntervals(rs: Rect[], axis: "x" | "y", at: number): Array<[number, number]> {
  const iv = rs.filter((r) => axis === "x" ? at >= r.x0 - EPS && at <= r.x1 + EPS : at >= r.y0 - EPS && at <= r.y1 + EPS)
    .map((r) => (axis === "x" ? [r.y0, r.y1] : [r.x0, r.x1]) as [number, number]).sort((p, q) => p[0] - q[0]);
  const out: Array<[number, number]> = [];
  for (const i of iv) {
    const last = out[out.length - 1];
    if (last && i[0] <= last[1] + EPS) last[1] = Math.max(last[1], i[1]); else out.push([...i]);
  }
  return out;
}

/** Grid lines from the region's corner: origin, origin + cc, … and the far edge. */
export function gridPositions(from: number, to: number, cc: number): number[] {
  const out: number[] = [];
  for (let v = from; v < to - EPS; v += cc) out.push(v);
  out.push(to);
  return out;
}

export function distToSeg(p: Pt, s: Seg): number {
  const [ax, ay] = s.a, [bx, by] = s.b;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
}

export interface Labelled { id: string; height: number; rects: Rect[] }

/**
 * Edges of a set of zones on one grid: walls (zone to outside) and steps (zone to zone at a different height), with
 * their segments for distance checks.
 */
export function edgeStats(zones: Labelled[]) {
  const all = zones.flatMap((z) => z.rects);
  const xs = uniq(all.flatMap((r) => [r.x0, r.x1])), ys = uniq(all.flatMap((r) => [r.y0, r.y1]));
  const label = (i: number, j: number): number => {
    if (i < 0 || j < 0 || i + 1 >= xs.length || j + 1 >= ys.length) return -1;
    const c: Pt = [(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2];
    return zones.findIndex((z) => inRegion(c, z.rects));
  };
  const walls: Seg[] = [], steps: Array<Seg & { dh: number; zones: [string, string] }> = [];
  const visit = (p: number, q: number, seg: Seg) => {
    if (p === q) return;
    if (p < 0 || q < 0) { walls.push(seg); return; }
    const dh = Math.abs(zones[p].height - zones[q].height);
    if (dh > EPS) steps.push({ ...seg, dh, zones: [zones[p].id, zones[q].id] });
  };
  for (let i = -1; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++)
    if (i + 1 < xs.length) visit(label(i, j), label(i + 1, j), { a: [xs[i + 1], ys[j]], b: [xs[i + 1], ys[j + 1]] });
  for (let j = -1; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++)
    visit(label(i, j), label(i, j + 1), { a: [xs[i], ys[j + 1]], b: [xs[i + 1], ys[j + 1]] });
  const len = (s: Seg) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
  return {
    walls, steps,
    wall_mm: walls.reduce((s, w) => s + len(w), 0),
    step_mm: steps.reduce((s, w) => s + len(w), 0),
    face_mm2: steps.reduce((s, w) => s + len(w) * w.dh, 0),
  };
}

/** The connected part of a region that holds p (for "is the fan centred in its tray or coffer"). */
export function componentAt(rs: Rect[], p: Pt): Rect[] {
  const start = rs.findIndex((r) => inRegion(p, [r], true));
  if (start < 0) return [];
  const touch = (a: Rect, b: Rect) => a.x0 <= b.x1 + EPS && b.x0 <= a.x1 + EPS && a.y0 <= b.y1 + EPS && b.y0 <= a.y1 + EPS &&
    (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS || Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > EPS);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const k = queue.pop()!;
    rs.forEach((r, i) => { if (!seen.has(i) && touch(rs[k], r)) { seen.add(i); queue.push(i); } });
  }
  return [...seen].map((i) => rs[i]);
}
