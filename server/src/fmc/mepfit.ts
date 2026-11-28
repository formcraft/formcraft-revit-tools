/**
 * Routing with fittings, the part that does not need Revit: turn a route preview (route.ts, fmc_trace route) into the
 * ops a write handler on the fmc_conduit pattern would run: one curve per piece (pieces split at corners, tees and
 * stock-length joints), then one fitting per fitting point (corner = elbow, tee = tee, joint = union, open end = cap
 * only when asked and a cap rule exists). A fitting whose routing group has no rule on the type is not planned: it is
 * listed as FMC-NO-FITTING-TYPE up front, so the write never depends on Revit failing at commit.
 * Pure: no Revit call, no write. Routing preferences are only read (fmc_mep_systems routing).
 */
import type { RouteOk, RouteFitting, Vec3 } from "./route.js";
import type { RoutingCoverage } from "./mepsystems.js";

export type FitOp = "elbow" | "tee" | "union" | "cap";
export const GROUP_OF: Record<FitOp, string> = { elbow: "Elbows", tee: "Junctions", union: "Unions", cap: "Caps" };

export interface PieceOp { run: string; index: number; from: Vec3; to: Vec3; length_mm: number }
export interface FittingOp { op: FitOp; at: Vec3; run: string; branch?: string; angle_deg?: number }
export interface Blocked { op: FitOp; at: Vec3; run: string; code: "FMC-NO-FITTING-TYPE" | "FMC-ANGLE"; reason: string }

export interface PlacementPlan {
  pieces: PieceOp[];
  fittings: FittingOp[];
  blocked: Blocked[];
  open_ends: Array<{ at: Vec3; run: string; role?: string }>;
  counts: Record<FitOp | "pieces" | "blocked" | "open_ends", number>;
}

const EPS = 1e-6;
const same = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[2] - b[2]) < 0.5;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Is p on the segment a-b (strictly inside, not at an end)? */
function inside(p: Vec3, a: Vec3, b: Vec3): boolean {
  const ab = dist(a, b), ap = dist(a, p), pb = dist(p, b);
  return ap > 0.5 && pb > 0.5 && Math.abs(ap + pb - ab) < 0.5 + EPS;
}

/** Split every segment at the joint and tee points that fall inside it, in order along the segment. */
export function splitPieces(route: RouteOk): PieceOp[] {
  const pieces: PieceOp[] = [];
  for (const run of route.runs) {
    const cuts = route.fittings.filter((f) => f.run === run.id && (f.type === "joint" || f.type === "tee")).map((f) => f.at);
    let index = 0;
    for (const seg of run.segments) {
      const points = [seg.from, ...cuts.filter((p) => inside(p, seg.from, seg.to)).sort((p, q) => dist(seg.from, p) - dist(seg.from, q)), seg.to];
      for (let i = 0; i + 1 < points.length; i++) {
        if (same(points[i], points[i + 1])) continue;
        pieces.push({ run: run.id, index: index++, from: points[i], to: points[i + 1], length_mm: Math.round(dist(points[i], points[i + 1])) });
      }
    }
  }
  return pieces;
}

export interface PlanOptions {
  /** The type's routing coverage from fmc_mep_systems routing. Without it every fitting is planned and Revit decides. */
  coverage?: RoutingCoverage;
  caps?: boolean;
  /** Elbow angles a fitting family can take, for example [90, 45]. Default: any. */
  angles_deg?: number[];
}

export function planPlacement(route: RouteOk, opts: PlanOptions = {}): PlacementPlan {
  const pieces = splitPieces(route);
  const fittings: FittingOp[] = [];
  const blocked: Blocked[] = [];
  const open_ends: PlacementPlan["open_ends"] = [];
  const missing = new Set(opts.coverage?.missing ?? []);
  const hasCaps = opts.coverage ? opts.coverage.caps : true;
  const want = (f: RouteFitting, op: FitOp, extra: Partial<FittingOp> = {}) => {
    if (missing.has(GROUP_OF[op]) || (op === "cap" && !hasCaps)) {
      blocked.push({ op, at: f.at, run: f.run, code: "FMC-NO-FITTING-TYPE", reason: `${opts.coverage?.name ?? "The type"} has no ${GROUP_OF[op]} rule.` });
      return;
    }
    fittings.push({ op, at: f.at, run: f.run, ...extra });
  };
  for (const f of route.fittings) {
    if (f.type === "corner") {
      const angle = f.angle_deg ?? 90;
      if (opts.angles_deg?.length && !opts.angles_deg.some((a) => Math.abs(a - angle) < 0.5)) {
        blocked.push({ op: "elbow", at: f.at, run: f.run, code: "FMC-ANGLE", reason: `No elbow for ${angle} degrees (allowed ${opts.angles_deg.join(", ")}).` });
        continue;
      }
      want(f, "elbow", { angle_deg: angle });
    } else if (f.type === "tee") want(f, "tee", { branch: f.branch });
    else if (f.type === "joint") want(f, "union");
    else if (f.type === "open_end") {
      if (opts.caps) want(f, "cap");
      else open_ends.push({ at: f.at, run: f.run, role: f.role });
    }
  }
  const count = (op: FitOp) => fittings.filter((f) => f.op === op).length;
  return {
    pieces, fittings, blocked, open_ends,
    counts: { pieces: pieces.length, elbow: count("elbow"), tee: count("tee"), union: count("union"), cap: count("cap"), blocked: blocked.length, open_ends: open_ends.length },
  };
}
