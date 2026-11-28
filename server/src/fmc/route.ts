/**
 * Constraint-aware MEP routing (MEP item 1, owner-approved 28 Nov): a pure solver with no Revit dependency.
 *
 * The space is a grid of cells grid_mm apart inside bounds. A route is a chain of one-cell moves along x, y or z.
 * The search is A* over a constraint state (cell, elevation, direction, length so far, bends so far). A move that
 * breaks a constraint (an obstacle, the bounds, the elevation band, the length budget, the fall budget, the bend
 * budget) is pruned, and a goal that is reached at the wrong elevation is rejected, so the search backs up and tries
 * the next best partial route instead of failing on the first dead end.
 *
 * flow "gravity" (drainage, condensate): every horizontal move falls at the minimum slope, vertical moves only drop,
 * and the run may be regraded evenly between slope.min and slope.max at the end. flow "pressure" (supply pipe, duct,
 * conduit): horizontal moves are level and vertical moves rise or fall.
 *
 * The result is a preview only. It never writes to a model: it returns the run polylines, each segment's slope, and
 * the fitting points (corner, tee, joint, open_end) a connector tool can place later. When no route exists the reply
 * is a code and a plain reason, found by relaxing one constraint at a time.
 *
 * Units: millimetres. Coordinates are the caller's (host model coordinates); z is the run's centreline.
 */

export type Vec3 = [number, number, number];

export interface RouteBox {
  id?: string;
  kind?: string;
  min: Vec3;
  max: Vec3;
}

export type SlopeInput = number | string;

export interface RouteRequest {
  start: Vec3;
  goal: Vec3;
  /** Further ends that join the network (trunk first, then earlier branches) at a tee. Each flows into the network. */
  branches?: Vec3[];
  bounds: { min: Vec3; max: Vec3 };
  grid_mm?: number;
  /** Outside diameter or width of the run; half of it is kept clear of every obstacle. */
  size_mm?: number;
  /** Extra clear distance from every obstacle (insulation, access, code minimum). */
  clearance_mm?: number;
  obstacles?: RouteBox[];
  flow?: "gravity" | "pressure";
  /** Rise over run: a fraction (0.025), "1:40" or "2.5%". gravity needs min > 0. max defaults to min (a required slope). */
  slope?: { min: SlopeInput; max?: SlopeInput };
  max_length_mm?: number;
  max_bends?: number;
  z_min_mm?: number;
  z_max_mm?: number;
  allow_vertical?: boolean;
  bend_penalty_mm?: number;
  /** Stock length of pipe or duct: a joint (coupling) is placed every this far along a straight piece. 0 places none. */
  stock_length_mm?: number;
  tolerance_mm?: number;
  max_states?: number;
}

export type FittingType = "corner" | "tee" | "joint" | "open_end";

export interface RouteFitting {
  type: FittingType;
  at: Vec3;
  run: string;
  /** corner: the angle between the two pieces; tee: the branch run; open_end: start, end or branch_start. */
  angle_deg?: number;
  branch?: string;
  role?: "start" | "end" | "branch_start";
  note?: string;
}

export interface RouteSegment {
  from: Vec3;
  to: Vec3;
  length_mm: number;
  vertical: boolean;
  /** Fall per unit run for a horizontal piece (positive is downhill in the run's direction). Absent on a vertical piece. */
  slope?: number;
  slope_ratio?: string;
}

export interface RouteRun {
  id: string;
  joins?: string;
  points_mm: Vec3[];
  length_mm: number;
  segments: RouteSegment[];
  regraded?: boolean;
}

export interface SearchStats {
  expanded: number;
  backtracks: number;
  goal_rejections: number;
  pruned: Record<PruneReason, number>;
}

export type PruneReason = "obstacle" | "bounds" | "elevation" | "max_length" | "fall" | "bends";

export interface RouteOk {
  ok: true;
  read_only: true;
  dry_run: true;
  writes: 0;
  flow: "gravity" | "pressure";
  runs: RouteRun[];
  fittings: RouteFitting[];
  totals: { length_mm: number; bends: number; fittings: Record<FittingType, number> };
  search: SearchStats;
  warnings: string[];
}

export interface RouteFail {
  ok: false;
  read_only: true;
  dry_run: true;
  writes: 0;
  code: "FMC-ROUTE-NONE" | "FMC-ROUTE-LIMIT" | "FMC-ROUTE-INPUT";
  /** The constraint that rules every route out. */
  blocking?: PruneReason | "start_blocked" | "goal_blocked" | "enclosed";
  reason: string;
  run?: string;
  search?: SearchStats;
  hint?: string;
  warnings: string[];
}

export type RouteResult = RouteOk | RouteFail;

const EPS = 1e-6;
// +x, -x, +y, -y, down, up
const DIRS: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1]];
const OPPOSITE = [1, 0, 3, 2, 5, 4];
const NO_DIR = -1;

/** Parses 0.025, "0.025", "1:40" or "2.5%" into a fraction. */
export function parseSlope(value: SlopeInput | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const text = value.trim();
  let m = text.match(/^1\s*:\s*(\d+(?:\.\d+)?)$/);
  if (m) return 1 / Number(m[1]);
  m = text.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (m) return Number(m[1]) / 100;
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

export function slopeRatio(slope: number): string {
  if (Math.abs(slope) < 1e-9) return "level";
  const r = 1 / Math.abs(slope);
  const text = `1:${Math.round(r * 10) / 10}`;
  return slope < 0 ? `${text} (uphill)` : text;
}

interface Ctx {
  flow: "gravity" | "pressure";
  g: number;
  origin: Vec3;
  nx: number;
  ny: number;
  bmin: Vec3;
  bmax: Vec3;
  boxes: { min: Vec3; max: Vec3 }[];
  sMin: number;
  sMax: number;
  maxLength: number;
  maxBends: number;
  zMin: number;
  zMax: number;
  vertical: boolean;
  bendPenalty: number;
  tol: number;
  maxStates: number;
}

interface Goal { ix: number; iy: number; z: number; point: Vec3; run?: string }

interface Node {
  ix: number;
  iy: number;
  z: number;
  dir: number;
  len: number;
  horiz: number;
  bends: number;
  usedVertical: boolean;
  cost: number;
  f: number;
  parent: Node | null;
}

interface Found {
  points: Vec3[];
  regraded: boolean;
  goal: Goal;
  bends: number;
}

type LegResult = { ok: true; found: Found; stats: SearchStats } | { ok: false; limit: boolean; stats: SearchStats };

function emptyStats(): SearchStats {
  return { expanded: 0, backtracks: 0, goal_rejections: 0, pruned: { obstacle: 0, bounds: 0, elevation: 0, max_length: 0, fall: 0, bends: 0 } };
}

class Heap {
  private items: Node[] = [];
  get size() { return this.items.length; }
  push(n: Node) {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[p], a[i])) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): Node | undefined {
    const a = this.items;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop() as Node;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && less(a[l], a[m])) m = l;
        if (r < a.length && less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

function less(a: Node, b: Node): boolean {
  if (Math.abs(a.f - b.f) > EPS) return a.f < b.f;
  return a.len > b.len; // deeper first on ties
}

function inflate(box: RouteBox, by: number): { min: Vec3; max: Vec3 } {
  const lo: Vec3 = [Math.min(box.min[0], box.max[0]), Math.min(box.min[1], box.max[1]), Math.min(box.min[2], box.max[2])];
  const hi: Vec3 = [Math.max(box.min[0], box.max[0]), Math.max(box.min[1], box.max[1]), Math.max(box.min[2], box.max[2])];
  return { min: [lo[0] - by, lo[1] - by, lo[2] - by], max: [hi[0] + by, hi[1] + by, hi[2] + by] };
}

/** True when the segment p-q passes through the inside of the box (touching a face is clear). */
export function segmentHitsBox(p: Vec3, q: Vec3, box: { min: Vec3; max: Vec3 }): boolean {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const lo = box.min[k] + EPS, hi = box.max[k] - EPS;
    const d = q[k] - p[k];
    if (Math.abs(d) < 1e-12) {
      if (p[k] <= lo || p[k] >= hi) return false;
      continue;
    }
    let a = (lo - p[k]) / d, b = (hi - p[k]) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 >= t1) return false;
  }
  return t1 - t0 > 1e-9;
}

function pointInBox(p: Vec3, box: { min: Vec3; max: Vec3 }): boolean {
  return p.every((v, k) => v > box.min[k] + EPS && v < box.max[k] - EPS);
}

function hits(ctx: Ctx, p: Vec3, q: Vec3): boolean {
  for (const box of ctx.boxes) if (segmentHitsBox(p, q, box)) return true;
  return false;
}

function at(ctx: Ctx, ix: number, iy: number, z: number): Vec3 {
  return [ctx.origin[0] + ix * ctx.g, ctx.origin[1] + iy * ctx.g, z];
}

function hxy(ctx: Ctx, ix: number, iy: number, goal: Goal): number {
  return (Math.abs(ix - goal.ix) + Math.abs(iy - goal.iy)) * ctx.g;
}

function heuristic(ctx: Ctx, n: { ix: number; iy: number; z: number }, goals: Goal[]): number {
  let best = Infinity;
  for (const goal of goals) {
    const h = hxy(ctx, n.ix, n.iy, goal);
    const v = ctx.flow === "pressure" ? Math.abs(n.z - goal.z) : 0;
    if (h + v < best) best = h + v;
  }
  return best;
}

/** The lowest fall still needed from here to the nearest-reachable goal (gravity). */
function fallFeasible(ctx: Ctx, n: { ix: number; iy: number; z: number }, goals: Goal[]): boolean {
  for (const goal of goals) if (n.z - ctx.sMin * hxy(ctx, n.ix, n.iy, goal) >= goal.z - ctx.tol) return true;
  return false;
}

function key(ctx: Ctx, n: Node): string {
  return `${n.ix},${n.iy},${Math.round(n.z * 10)},${n.dir}${Number.isFinite(ctx.maxBends) ? "," + n.bends : ""}`;
}

function pathOf(ctx: Ctx, n: Node): Vec3[] {
  const out: Vec3[] = [];
  for (let c: Node | null = n; c; c = c.parent) out.push(at(ctx, c.ix, c.iy, c.z));
  return out.reverse();
}

function pathClear(ctx: Ctx, pts: Vec3[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++) if (hits(ctx, pts[i], pts[i + 1])) return false;
  return true;
}

/** A goal cell is reached: accept the route as it is, regraded, or with a final vertical piece, or reject it. */
function acceptAtGoal(ctx: Ctx, n: Node, goal: Goal): Found | null {
  const d = n.z - goal.z;
  const pts = pathOf(ctx, n);
  if (Math.abs(d) <= ctx.tol) {
    pts[pts.length - 1] = [pts[pts.length - 1][0], pts[pts.length - 1][1], goal.z];
    return { points: pts, regraded: false, goal, bends: n.bends };
  }
  if (ctx.flow === "gravity") {
    if (d < 0) return null;
    // Regrade evenly between slope.min and slope.max when the run is all horizontal.
    if (!n.usedVertical && n.horiz > EPS && ctx.sMax > ctx.sMin + EPS) {
      const z0 = pts[0][2];
      const s = (z0 - goal.z) / n.horiz;
      if (s <= ctx.sMax + EPS) {
        const regraded: Vec3[] = [];
        let run = 0;
        for (let i = 0; i < pts.length; i++) {
          if (i > 0) run += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          regraded.push([pts[i][0], pts[i][1], z0 - s * run]);
        }
        const zs = regraded.map((p) => p[2]);
        if (pathClear(ctx, regraded) && Math.min(...zs) >= ctx.zMin - EPS && Math.max(...zs) <= ctx.zMax + EPS) {
          regraded[regraded.length - 1][2] = goal.z;
          return { points: regraded, regraded: true, goal, bends: n.bends };
        }
      }
    }
  }
  // pressure, or gravity arriving high: a final vertical piece into the goal.
  if (ctx.vertical && (ctx.flow === "pressure" || d > 0)) {
    const last = pts[pts.length - 1];
    const end: Vec3 = [last[0], last[1], goal.z];
    if (!hits(ctx, last, end)) {
      const turned = n.dir !== NO_DIR && n.dir < 4 ? 1 : 0;
      if (n.bends + turned <= ctx.maxBends) return { points: [...pts, end], regraded: false, goal, bends: n.bends + turned };
    }
  }
  return null;
}

function searchLeg(ctx: Ctx, from: Vec3, goals: Goal[]): LegResult {
  const stats = emptyStats();
  const six = Math.round((from[0] - ctx.origin[0]) / ctx.g), siy = Math.round((from[1] - ctx.origin[1]) / ctx.g);
  const start: Node = { ix: six, iy: siy, z: from[2], dir: NO_DIR, len: 0, horiz: 0, bends: 0, usedVertical: false, cost: 0, f: 0, parent: null };
  start.f = heuristic(ctx, start, goals);
  const open = new Heap();
  open.push(start);
  const best = new Map<string, number>();
  best.set(key(ctx, start), 0);
  const goalAt = new Map<string, Goal[]>();
  for (const goal of goals) {
    const k = `${goal.ix},${goal.iy}`;
    goalAt.set(k, [...(goalAt.get(k) ?? []), goal]);
  }
  while (open.size) {
    const n = open.pop() as Node;
    if ((best.get(key(ctx, n)) ?? Infinity) < n.cost - EPS) continue;
    stats.expanded++;
    if (stats.expanded > ctx.maxStates) return { ok: false, limit: true, stats };
    const here = goalAt.get(`${n.ix},${n.iy}`);
    if (here) {
      const ranked = [...here].sort((a, b) => Math.abs(n.z - a.z) - Math.abs(n.z - b.z));
      for (const goal of ranked) {
        const found = acceptAtGoal(ctx, n, goal);
        if (found) return { ok: true, found, stats };
      }
      stats.goal_rejections++;
      stats.backtracks++;
    }
    let children = 0;
    for (let d = 0; d < 6; d++) {
      if (n.dir !== NO_DIR && d === OPPOSITE[n.dir]) continue;
      const horizontal = d < 4;
      if (!horizontal && !ctx.vertical) continue;
      if (d === 5 && ctx.flow === "gravity") continue; // drainage never rises
      const ix = n.ix + DIRS[d][0], iy = n.iy + DIRS[d][1];
      const z = horizontal ? n.z - (ctx.flow === "gravity" ? ctx.sMin * ctx.g : 0) : n.z + DIRS[d][2] * ctx.g;
      const p = at(ctx, n.ix, n.iy, n.z), q = at(ctx, ix, iy, z);
      if (ix < 0 || iy < 0 || ix > ctx.nx || iy > ctx.ny || z < ctx.bmin[2] - EPS || z > ctx.bmax[2] + EPS) { stats.pruned.bounds++; continue; }
      if (z < ctx.zMin - EPS || z > ctx.zMax + EPS) { stats.pruned.elevation++; continue; }
      const turned = n.dir !== NO_DIR && d !== n.dir ? 1 : 0;
      const bends = n.bends + turned;
      if (bends > ctx.maxBends) { stats.pruned.bends++; continue; }
      const step = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      const len = n.len + step;
      const child: Node = {
        ix, iy, z, dir: d, len, horiz: n.horiz + (horizontal ? ctx.g : 0), bends, usedVertical: n.usedVertical || !horizontal,
        cost: n.cost + step + turned * ctx.bendPenalty, f: 0, parent: n,
      };
      const h = heuristic(ctx, child, goals);
      if (len + h > ctx.maxLength + ctx.tol) { stats.pruned.max_length++; continue; }
      if (ctx.flow === "gravity" && !fallFeasible(ctx, child, goals)) { stats.pruned.fall++; continue; }
      if (hits(ctx, p, q)) { stats.pruned.obstacle++; continue; }
      const k = key(ctx, child);
      if ((best.get(k) ?? Infinity) <= child.cost + EPS) continue;
      best.set(k, child.cost);
      child.f = child.cost + h;
      open.push(child);
      children++;
    }
    if (children === 0) stats.backtracks++;
  }
  return { ok: false, limit: false, stats };
}

function addStats(a: SearchStats, b: SearchStats): SearchStats {
  const pruned = { ...a.pruned };
  for (const k of Object.keys(b.pruned) as PruneReason[]) pruned[k] += b.pruned[k];
  return { expanded: a.expanded + b.expanded, backtracks: a.backtracks + b.backtracks, goal_rejections: a.goal_rejections + b.goal_rejections, pruned };
}

function simplify(points: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) {
    if (out.length && dist(out[out.length - 1], p) < EPS) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      const u = unit(sub(b, a)), v = unit(sub(p, b));
      if (Math.abs(u[0] - v[0]) < 1e-6 && Math.abs(u[1] - v[1]) < 1e-6 && Math.abs(u[2] - v[2]) < 1e-6) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dist(a: Vec3, b: Vec3): number { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function unit(v: Vec3): Vec3 { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function round(v: Vec3): Vec3 { return v.map((x) => Math.round(x * 10) / 10) as Vec3; }
function same(a: Vec3, b: Vec3): boolean { return dist(a, b) < 0.5; }

function angleDeg(a: Vec3, b: Vec3): number {
  const u = unit(a), v = unit(b);
  const dot = Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
  return Math.round(Math.acos(dot) * 180 / Math.PI * 10) / 10;
}

function segmentsOf(points: Vec3[]): RouteSegment[] {
  const out: RouteSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const vertical = run < EPS;
    const seg: RouteSegment = { from: round(a), to: round(b), length_mm: Math.round(dist(a, b) * 10) / 10, vertical };
    if (!vertical) {
      seg.slope = Math.round(((a[2] - b[2]) / run) * 1e6) / 1e6;
      seg.slope_ratio = slopeRatio(seg.slope);
    }
    out.push(seg);
  }
  return out;
}

/** Splits a polyline at a point that lies on it (a tee), so the tee is a vertex. */
function insertVertex(points: Vec3[], p: Vec3): Vec3[] {
  for (const q of points) if (same(q, p)) return points;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const ab = dist(a, b), ap = dist(a, p), pb = dist(p, b);
    if (Math.abs(ap + pb - ab) < 0.5) return [...points.slice(0, i + 1), p, ...points.slice(i + 1)];
  }
  return points;
}

function fittingsOf(runs: RouteRun[], tees: { at: Vec3; run: string; branch: string }[], stock: number): RouteFitting[] {
  const out: RouteFitting[] = [];
  const joinedEnds = new Set<string>();
  for (const tee of tees) {
    const host = runs.find((r) => r.id === tee.run) as RouteRun;
    const first = host.points_mm[0], last = host.points_mm[host.points_mm.length - 1];
    if (same(tee.at, first) || same(tee.at, last)) {
      // A branch meeting the open end of an earlier run: an elbow or a coupling there, not a tee.
      joinedEnds.add(`${tee.run}:${same(tee.at, first) ? "start" : "end"}`);
      const branch = runs.find((r) => r.id === tee.branch) as RouteRun;
      const bp = branch.points_mm;
      const into = sub(bp[bp.length - 1], bp[bp.length - 2]);
      const hp = host.points_mm;
      const onward = same(tee.at, first) ? sub(hp[1], hp[0]) : sub(hp[hp.length - 2], hp[hp.length - 1]);
      const angle = angleDeg(into, same(tee.at, first) ? onward : [-onward[0], -onward[1], -onward[2]] as Vec3);
      out.push(angle < 1
        ? { type: "joint", at: round(tee.at), run: tee.run, branch: tee.branch, note: "a branch continues the run's open end in line" }
        : { type: "corner", at: round(tee.at), run: tee.run, branch: tee.branch, angle_deg: angle, note: "a branch meets the run's open end" });
      continue;
    }
    const hp = host.points_mm;
    const k = hp.findIndex((q, i) => i > 0 && i < hp.length - 1 && same(q, tee.at));
    const corner = k > 0 && angleDeg(sub(hp[k], hp[k - 1]), sub(hp[k + 1], hp[k])) >= 1;
    out.push({ type: "tee", at: round(tee.at), run: tee.run, branch: tee.branch, ...(corner ? { note: "at a corner of the run: no straight-through leg" } : {}) });
  }
  for (const run of runs) {
    const pts = run.points_mm;
    const startRole = run.joins ? "branch_start" : "start";
    out.push({ type: "open_end", at: round(pts[0]), run: run.id, role: startRole });
    if (!run.joins && !joinedEnds.has(`${run.id}:end`)) out.push({ type: "open_end", at: round(pts[pts.length - 1]), run: run.id, role: "end" });
    if (joinedEnds.has(`${run.id}:start`)) out.splice(out.findIndex((f) => f.type === "open_end" && f.run === run.id && f.role === startRole), 1);
    const teeHere = tees.filter((t) => t.run === run.id).map((t) => t.at);
    for (let i = 1; i + 1 < pts.length; i++) {
      const angle = angleDeg(sub(pts[i], pts[i - 1]), sub(pts[i + 1], pts[i]));
      if (angle >= 1 && !teeHere.some((t) => same(t, pts[i]))) out.push({ type: "corner", at: round(pts[i]), run: run.id, angle_deg: angle });
    }
    if (stock > 0) {
      // Joints every stock length along each straight piece; a corner or a tee starts a new piece.
      let carried = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1], l = dist(a, b);
        const station = i > 0 && (angleDeg(sub(a, pts[i - 1]), sub(b, a)) >= 1 || teeHere.some((t) => same(t, a)));
        if (station) carried = 0;
        let s = stock - carried;
        while (s < l - 1) {
          const t = s / l;
          out.push({ type: "joint", at: round([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]), run: run.id, note: "stock length" });
          s += stock;
        }
        carried = (carried + l) % stock;
      }
    }
  }
  return out;
}

function fail(code: RouteFail["code"], reason: string, extra: Partial<RouteFail> = {}): RouteFail {
  return { ok: false, read_only: true, dry_run: true, writes: 0, code, reason, warnings: [], ...extra };
}

function makeCtx(req: RouteRequest, warnings: string[]): Ctx | RouteFail {
  const g = req.grid_mm ?? 100;
  if (!(g > 0)) return fail("FMC-ROUTE-INPUT", "grid_mm must be more than 0.");
  const bmin = req.bounds.min.map((v, k) => Math.min(v, req.bounds.max[k])) as Vec3;
  const bmax = req.bounds.min.map((v, k) => Math.max(v, req.bounds.max[k])) as Vec3;
  const flow = req.flow ?? "pressure";
  const sMin = parseSlope(req.slope?.min) ?? 0;
  const sMax = parseSlope(req.slope?.max) ?? sMin;
  if (!Number.isFinite(sMin) || !Number.isFinite(sMax)) return fail("FMC-ROUTE-INPUT", "slope must be a fraction (0.025), a ratio (1:40) or a percentage (2.5%).");
  if (flow === "gravity" && !(sMin > 0)) return fail("FMC-ROUTE-INPUT", "A gravity run needs slope.min more than 0, for example 1:40.");
  if (sMax < sMin - EPS) return fail("FMC-ROUTE-INPUT", "slope.max is less than slope.min.");
  if (flow === "pressure" && req.slope) warnings.push("slope is ignored on a pressure run: its horizontal pieces are level.");
  const r = (req.size_mm ?? 0) / 2 + (req.clearance_mm ?? 0);
  return {
    flow, g, origin: bmin,
    nx: Math.floor((bmax[0] - bmin[0]) / g + EPS), ny: Math.floor((bmax[1] - bmin[1]) / g + EPS),
    bmin, bmax,
    boxes: (req.obstacles ?? []).map((b) => inflate(b, r)),
    sMin: flow === "gravity" ? sMin : 0, sMax: flow === "gravity" ? sMax : 0,
    maxLength: req.max_length_mm ?? Infinity,
    maxBends: req.max_bends ?? Infinity,
    zMin: req.z_min_mm ?? -Infinity, zMax: req.z_max_mm ?? Infinity,
    vertical: req.allow_vertical ?? true,
    bendPenalty: req.bend_penalty_mm ?? 2 * g,
    tol: req.tolerance_mm ?? 1,
    maxStates: req.max_states ?? 200000,
  };
}

function snap(ctx: Ctx, p: Vec3, label: string, warnings: string[]): { ix: number; iy: number; point: Vec3 } {
  const ix = Math.round((p[0] - ctx.origin[0]) / ctx.g), iy = Math.round((p[1] - ctx.origin[1]) / ctx.g);
  const point = at(ctx, ix, iy, p[2]);
  const off = Math.hypot(point[0] - p[0], point[1] - p[1]);
  if (off > ctx.tol) warnings.push(`${label} is ${Math.round(off)} mm off the ${ctx.g} mm grid; it was moved to the nearest grid point.`);
  return { ix, iy, point };
}

/** When a leg has no route, relax one constraint at a time to say which one rules it out. */
function diagnose(req: RouteRequest, ctx: Ctx, from: Vec3, goals: Goal[], run: string, stats: SearchStats, warnings: string[]): RouteFail {
  const base = { run, search: stats, warnings };
  const nearest = goals.reduce((a, b) => (hxy(ctx, Math.round((from[0] - ctx.origin[0]) / ctx.g), Math.round((from[1] - ctx.origin[1]) / ctx.g), a) <= hxy(ctx, Math.round((from[0] - ctx.origin[0]) / ctx.g), Math.round((from[1] - ctx.origin[1]) / ctx.g), b) ? a : b));
  const plan = Math.abs(nearest.point[0] - from[0]) + Math.abs(nearest.point[1] - from[1]);
  if (ctx.flow === "gravity") {
    const fall = from[2] - nearest.z;
    const need = ctx.sMin * plan;
    if (fall < need - ctx.tol) {
      return fail("FMC-ROUTE-NONE", `Not enough fall: at ${slopeRatio(ctx.sMin)} even the shortest ${Math.round(plan)} mm run needs ${Math.round(need)} mm of fall, and the start is ${Math.round(fall)} mm above the end.`, {
        ...base, blocking: "fall", hint: "Start higher, end lower, or accept a smaller minimum slope if the standard allows it.",
      });
    }
  }
  const relaxations: { blocking: PruneReason; change: Partial<Ctx>; say: (r: Found) => string; hint: string }[] = [];
  if (Number.isFinite(ctx.maxLength)) relaxations.push({
    blocking: "max_length", change: { maxLength: Infinity, bendPenalty: 0 },
    say: (r) => `Every route clear of the obstacles is longer than max_length_mm ${ctx.maxLength}: the shortest is ${Math.round(polylineLength(r.points))} mm.`,
    hint: "Raise max_length_mm, move the start or end, or clear an obstacle.",
  });
  if (Number.isFinite(ctx.maxBends)) relaxations.push({
    blocking: "bends", change: { maxBends: Infinity },
    say: (r) => `Every route needs more than max_bends ${ctx.maxBends}: the best one has ${r.bends}.`,
    hint: "Allow more bends.",
  });
  if (Number.isFinite(ctx.zMin) || Number.isFinite(ctx.zMax)) relaxations.push({
    blocking: "elevation", change: { zMin: -Infinity, zMax: Infinity },
    say: () => `Every route leaves the elevation band ${Number.isFinite(ctx.zMin) ? ctx.zMin : "-"} to ${Number.isFinite(ctx.zMax) ? ctx.zMax : "-"} mm.`,
    hint: "Widen the band (for example a deeper ceiling void) or start higher.",
  });
  for (const r of relaxations) {
    const tried = searchLeg({ ...ctx, ...r.change }, from, goals);
    if (tried.ok) return fail("FMC-ROUTE-NONE", r.say(tried.found), { ...base, blocking: r.blocking, hint: r.hint });
  }
  if (ctx.flow === "gravity" && !ctx.vertical) {
    const tried = searchLeg({ ...ctx, vertical: true }, from, goals);
    if (tried.ok) return fail("FMC-ROUTE-NONE", `The run arrives too high at ${slopeRatio(ctx.sMax)} and no vertical drop is allowed.`, { ...base, blocking: "fall", hint: "Allow a vertical drop, raise slope.max, or lower the start." });
  }
  return fail("FMC-ROUTE-NONE", "The obstacles close off every path between the ends at this size and clearance.", {
    ...base, blocking: "enclosed", hint: "Check the obstacle list and the clearance, widen the bounds, or allow vertical moves.",
  });
}

function polylineLength(points: Vec3[]): number {
  let l = 0;
  for (let i = 0; i + 1 < points.length; i++) l += dist(points[i], points[i + 1]);
  return l;
}

/** The solver entry point: a dry-run route preview. Never writes. */
export function routePreview(req: RouteRequest): RouteResult {
  const warnings: string[] = [];
  const made = makeCtx(req, warnings);
  if ("ok" in made) return made;
  const ctx = made;
  const s = snap(ctx, req.start, "start", warnings);
  const e = snap(ctx, req.goal, "goal", warnings);
  for (const [label, p] of [["start", s.point], ["goal", e.point]] as const) {
    if (ctx.boxes.some((b) => pointInBox(p, b))) return fail("FMC-ROUTE-NONE", `The ${label} is inside an obstacle (with the size and clearance added).`, { blocking: label === "start" ? "start_blocked" : "goal_blocked", warnings });
  }
  const runs: RouteRun[] = [];
  const tees: { at: Vec3; run: string; branch: string }[] = [];
  let stats = emptyStats();
  let bends = 0;

  const trunkGoal: Goal = { ix: e.ix, iy: e.iy, z: e.point[2], point: e.point };
  const leg = searchLeg(ctx, s.point, [trunkGoal]);
  stats = addStats(stats, leg.stats);
  if (!leg.ok) {
    if (leg.limit) return fail("FMC-ROUTE-LIMIT", `The search stopped at max_states ${ctx.maxStates} without a route.`, { run: "trunk", search: stats, warnings, hint: "Use a coarser grid_mm, tighter bounds, or raise max_states." });
    return diagnose(req, ctx, s.point, [trunkGoal], "trunk", stats, warnings);
  }
  bends += leg.found.bends;
  runs.push(runOf("trunk", leg.found));

  const branches = req.branches ?? [];
  for (let i = 0; i < branches.length; i++) {
    const id = `branch_${i + 1}`;
    const bs = snap(ctx, branches[i], id, warnings);
    if (ctx.boxes.some((box) => pointInBox(bs.point, box))) return fail("FMC-ROUTE-NONE", `The start of ${id} is inside an obstacle (with the size and clearance added).`, { blocking: "start_blocked", run: id, warnings });
    // The goals are every grid point already on the network.
    const goals: Goal[] = [];
    for (const run of runs) for (const p of densify(run.points_mm, ctx.g)) {
      const ix = Math.round((p[0] - ctx.origin[0]) / ctx.g), iy = Math.round((p[1] - ctx.origin[1]) / ctx.g);
      const grid = at(ctx, ix, iy, p[2]);
      if (Math.abs(grid[0] - p[0]) < 0.5 && Math.abs(grid[1] - p[1]) < 0.5) goals.push({ ix, iy, z: p[2], point: p, run: run.id });
    }
    const bl = searchLeg(ctx, bs.point, goals);
    stats = addStats(stats, bl.stats);
    if (!bl.ok) {
      if (bl.limit) return fail("FMC-ROUTE-LIMIT", `The search stopped at max_states ${ctx.maxStates} without a route for ${id}.`, { run: id, search: stats, warnings });
      return diagnose(req, ctx, bs.point, goals, id, stats, warnings);
    }
    bends += bl.found.bends;
    const host = bl.found.goal.run as string;
    const hostRun = runs.find((r) => r.id === host) as RouteRun;
    hostRun.points_mm = insertVertex(hostRun.points_mm, bl.found.goal.point);
    hostRun.segments = segmentsOf(hostRun.points_mm);
    const branch = runOf(id, bl.found);
    branch.joins = host;
    runs.push(branch);
    tees.push({ at: bl.found.goal.point, run: host, branch: id });
  }

  const fittings = fittingsOf(runs, tees, req.stock_length_mm ?? 6000);
  const count = { corner: 0, tee: 0, joint: 0, open_end: 0 } as Record<FittingType, number>;
  for (const f of fittings) count[f.type]++;
  const out: RouteRun[] = runs.map((r) => ({ ...r, points_mm: r.points_mm.map(round) }));
  return {
    ok: true, read_only: true, dry_run: true, writes: 0, flow: ctx.flow, runs: out, fittings,
    totals: { length_mm: Math.round(runs.reduce((a, r) => a + r.length_mm, 0) * 10) / 10, bends, fittings: count },
    search: stats, warnings,
  };
}

function runOf(id: string, found: Found): RouteRun {
  const points = simplify(found.points);
  return { id, points_mm: points, length_mm: Math.round(polylineLength(points) * 10) / 10, segments: segmentsOf(points), ...(found.regraded ? { regraded: true } : {}) };
}

/** The grid points along a polyline (so a branch can join anywhere on it). */
function densify(points: Vec3[], g: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (run < EPS) { out.push(a); continue; }
    const n = Math.round(run / g);
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
