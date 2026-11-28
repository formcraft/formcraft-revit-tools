/**
 * Curves in family outlines (owner 26 Oct: "picture to family builds with simple and complex curves" kept failing).
 * Extrusion, revolution, blend and sweep outlines were straight lines between points only, so a curve traced from a
 * photo became hundreds of tiny pieces: Revit refused pieces under its short-curve limit (about 0.8 mm), near-duplicate
 * points and slight self-crossings, and revolved bodies came out faceted.
 *
 * An outline is now a list of nodes: [x, y] (a straight line to it), { to, through } (a 3-point arc to `to`) or
 * { to, spline: [[x, y], ...] } (a smooth curve through those points to `to`). Before a build, outlines are cleaned
 * (points closer than 0.75 mm merged) and traced outlines (24 points or more) smoothed: corners stay corners, the smooth stretches between
 * them become splines. The add-in builds the same nodes (FmcCurves.cs).
 */
export type P2 = [number, number];
export type CurveNode = P2 | { to: P2; through?: P2; spline?: P2[] };

const TOL = 0.01;
// just under Revit's 0.78 mm short-curve tolerance: only pieces Revit refuses for sure are merged (88 families built with 0.78 mm edges)
export const MIN_SEGMENT_MM = 0.75;
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
export const endOf = (n: CurveNode): P2 => (Array.isArray(n) ? n : n.to);
const isPlain = (n: CurveNode): n is P2 => Array.isArray(n);

/** The points along a 3-point arc from a through m to b (16 pieces), or null when the three points are in a line. */
export function arcPoints(a: P2, m: P2, b: P2): P2[] | null {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  const scale = Math.max(dist(a, m), dist(m, b), dist(a, b));
  if (Math.abs(cross(a, m, b)) < 1e-9 * scale * scale || d === 0) return null;
  const sq = (p: P2) => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d;
  const cy = (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  const ang = (p: P2) => Math.atan2(p[1] - cy, p[0] - cx);
  const ccw = (from: number, to: number) => { let s = to - from; while (s < 0) s += 2 * Math.PI; while (s >= 2 * Math.PI) s -= 2 * Math.PI; return s; };
  const a0 = ang(a), toM = ccw(a0, ang(m)), toB = ccw(a0, ang(b));
  // Counter-clockwise from a reaches m before b: the arc runs counter-clockwise; otherwise clockwise.
  const sweep = toM < toB ? toB : toB - 2 * Math.PI;
  const out: P2[] = [];
  for (let k = 1; k <= 16; k++) { const t = a0 + (sweep * k) / 16; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  out[out.length - 1] = b;
  return out;
}

/** Proper or touching intersection of segments p1-p2 and q1-q2 (shared end points count as touching). */
export function segmentsMeet(p1: P2, p2: P2, q1: P2, q2: P2): boolean {
  const eps = 1e-9;
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
  if (((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))) return true;
  const on = (a: P2, b: P2, c: P2) => Math.abs(cross(a, b, c)) <= eps * Math.max(1, dist(a, b)) &&
    Math.min(a[0], b[0]) - TOL <= c[0] && c[0] <= Math.max(a[0], b[0]) + TOL && Math.min(a[1], b[1]) - TOL <= c[1] && c[1] <= Math.max(a[1], b[1]) + TOL;
  return on(q1, q2, p1) || on(q1, q2, p2) || on(p1, p2, q1) || on(p1, p2, q2);
}

/** A closed outline as a polygon (arcs in 16 pieces, splines through their points), for checks. */
export function flatten(nodes: CurveNode[]): P2[] {
  const out: P2[] = [];
  const n = nodes.length;
  for (let k = 0; k < n; k++) {
    const node = nodes[k], from = endOf(nodes[(k - 1 + n) % n]);
    if (isPlain(node)) { out.push(node); continue; }
    if (node.through) out.push(...(arcPoints(from, node.through, node.to) ?? [node.to]));
    else if (node.spline) out.push(...node.spline, node.to);
    else out.push(node.to);
  }
  return out;
}

/** Points closer than 0.75 mm to the one before are merged (Revit refuses pieces under 0.78 mm). */
export function cleanNodes(nodes: CurveNode[]): { nodes: CurveNode[]; merged: number } {
  const out: CurveNode[] = [];
  let merged = 0;
  for (const n of nodes) {
    const prev = out.length ? endOf(out[out.length - 1]) : null;
    if (prev && dist(prev, endOf(n)) < MIN_SEGMENT_MM && isPlain(n)) { merged++; continue; }
    if (!isPlain(n) && n.spline) n.spline = n.spline.filter((p, i, a) => dist(p, i ? a[i - 1] : (prev ?? p)) >= MIN_SEGMENT_MM || i === 0);
    out.push(n);
  }
  while (out.length > 3 && dist(endOf(out[out.length - 1]), endOf(out[0])) < MIN_SEGMENT_MM && isPlain(out[out.length - 1])) { out.pop(); merged++; }
  return { nodes: out, merged };
}

/** Ramer-Douglas-Peucker on a closed polygon: the points that matter within tol mm. */
export function simplify(pts: P2[], tol: number): P2[] {
  if (pts.length < 4) return pts;
  const far = pts.reduce((b, p, i) => (dist(p, pts[0]) > dist(pts[b], pts[0]) ? i : b), 0);
  const run = (a: P2[]): P2[] => {
    if (a.length < 3) return a;
    const s = a[0], e = a[a.length - 1];
    let worst = 0, at = 0;
    const len = dist(s, e) || 1;
    for (let i = 1; i < a.length - 1; i++) { const d = Math.abs(cross(s, e, a[i])) / len; if (d > worst) { worst = d; at = i; } }
    return worst <= tol ? [s, e] : [...run(a.slice(0, at + 1)).slice(0, -1), ...run(a.slice(at))];
  };
  const one = run(pts.slice(0, far + 1)), two = run([...pts.slice(far), pts[0]]);
  return [...one.slice(0, -1), ...two.slice(0, -1)];
}

const turn = (a: P2, b: P2, c: P2) => {
  const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
  const d = Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / d))) * 180 / Math.PI;
};

/**
 * A traced outline (many points) as a few clean curves: simplified within tol mm, corners (turning more than
 * cornerDeg) kept as corners, the smooth stretches between them as splines.
 */
export function smoothOutline(pts: P2[], tol = 0.5, cornerDeg = 35): CurveNode[] {
  const s = simplify(pts, tol);
  const n = s.length;
  if (n < 5) return s;
  const corner = s.map((p, i) => turn(s[(i - 1 + n) % n], p, s[(i + 1) % n]) > cornerDeg);
  if (!corner.some(Boolean)) corner[0] = true;
  const first = corner.indexOf(true);
  const order = [...s.slice(first), ...s.slice(0, first)];
  const isCorner = [...corner.slice(first), ...corner.slice(0, first)];
  // each node is the curve arriving at a corner; the last arrives back at the first corner, which closes the loop
  const out: CurveNode[] = [];
  let run: P2[] = [];
  for (let i = 1; i <= n; i++) {
    const p = order[i % n];
    if (i < n && !isCorner[i]) { run.push(p); continue; }
    const from = out.length ? endOf(out[out.length - 1]) : order[0];
    if (run.length >= 2) out.push({ to: p, spline: run });
    else if (run.length === 1 && arcPoints(from, run[0], p)) out.push({ to: p, through: run[0] });
    else out.push(...run, p);
    run = [];
  }
  return out;
}

/** What Revit will refuse in an outline, with where: too few points, crossings, no area, a revolution across its axis. */
export function outlineProblems(nodes: CurveNode[], kind: "outline" | "revolution" = "outline"): string[] {
  const p: string[] = [];
  if (nodes.length < 3 && !nodes.some((n) => !isPlain(n))) p.push("needs at least three points");
  nodes.forEach((n, k) => {
    if (!isPlain(n) && n.through && !arcPoints(endOf(nodes[(k - 1 + nodes.length) % nodes.length]), n.through, n.to))
      p.push(`node ${k + 1}: the arc's through point is in line with its ends (use a straight point, or move it)`);
  });
  const poly = flatten(nodes);
  const m = poly.length;
  let area = 0;
  for (let i = 0; i < m; i++) area += poly[i][0] * poly[(i + 1) % m][1] - poly[(i + 1) % m][0] * poly[i][1];
  if (Math.abs(area) / 2 < 0.01) p.push("has no area (all its points are in a line)");
  outer: for (let i = 0; i < m; i++)
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue;
      if (segmentsMeet(poly[i], poly[(i + 1) % m], poly[j], poly[(j + 1) % m])) { p.push(`crosses or touches itself near (${Math.round(poly[i][0])}, ${Math.round(poly[i][1])}) mm`); break outer; }
    }
  if (kind === "revolution" && poly.some((q) => q[0] < -TOL)) p.push("can't cross its axis (every r must be 0 or more)");
  return p;
}

/** Ops whose outlines are cleaned and, when traced (24 points or more, or smooth true), smoothed before a build. */
const OUTLINES: Record<string, string[]> = { extrusion: ["points"], void_extrusion: ["points"], revolution: ["profile"], blend: ["base", "top"], sweep: ["profile"], void_sweep: ["profile"] };

export function smoothOps<T extends { op: string }>(ops: T[]): T[] {
  return ops.map((o) => {
    const fields = OUTLINES[o.op];
    if (!fields) return o;
    const x = { ...(o as Record<string, any>) };
    for (const f of fields) {
      const v = x[f];
      if (!Array.isArray(v) || v.length === 0) continue;
      let nodes = cleanNodes(v as CurveNode[]).nodes;
      const plain = nodes.every(isPlain);
      if (x.smooth !== false && plain && (x.smooth === true || nodes.length >= 24)) nodes = smoothOutline(nodes as P2[], x.smooth_tolerance_mm ?? 0.5);
      x[f] = nodes;
    }
    return x as T;
  });
}
