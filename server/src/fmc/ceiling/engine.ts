/**
 * Ceiling Design Assistant engine (Engineer › Ceilings, +Model; step CL1, docs/PLAN_CEILINGS.md). Pure computation:
 * designs from a room and a brief, checks before placing, a board set-out, quantities, a priced bill from the kit's
 * material library, and the pack's CSVs. Nothing here touches Revit or a file.
 *
 * Rule 5: the light level is an indicative lumen-method figure flagged "Engineer" (CA-E-03), never a pass; the
 * electrical engineer designs the lighting. Rule 7: set-out values come from the kit (standard.ts lists fallbacks).
 */
import {
  Labelled, Pt, Rect, Seg, area, bbox, componentAt, distToSeg, edgeStats, erode, gridPositions, inRegion, intersect,
  lineIntervals, polyRects, polygonProblems, subtract,
} from "./geometry.js";
import { CeilingKit, CeilingStandard, LibMaterial, ResolvedStandard, resolveStandard } from "./standard.js";

const EPS = 1e-6;

// ---------- inputs ----------

export const STYLES = ["flat", "tray", "bulkhead", "cove", "raft", "coffer", "cornice"] as const;
export type Style = (typeof STYLES)[number];
export const KINDS = ["tray", "raft", "coffer", "flat"] as const;
export type Kind = (typeof KINDS)[number];

export interface RoomIn {
  name: string;
  outline_mm?: Pt[];
  width_mm?: number;
  depth_mm?: number;
  /** Underside of the truss ties or slab above, from the floor */
  structure_height_mm: number;
  structure: "ties" | "slab";
  tie_spacing_mm?: number;
  /** The direction the ties run in plan */
  tie_direction: "x" | "y";
  tie_offset_mm: number;
}
export interface XY { x: number; y: number }
export interface FixturesIn {
  fan?: XY & { sweep_mm: number; drop_mm: number };
  downlights: XY[];
  detectors: Array<XY & { kind: string }>;
  ac_grilles: Array<XY & { width_mm: number; depth_mm: number; duct_height_mm: number }>;
  hatch?: XY & { size_mm: number };
  sprinklers: XY[];
}
export interface BriefIn {
  styles: Style[];
  /** The ceiling build-up: a kit keynote in I.CLG */
  board: string;
  field_height_mm?: number;
  bulkhead_width_mm: number;
  bulkhead_drop_mm: number;
  raft_drop_mm: number;
  raft?: XY & { width_mm: number; depth_mm: number };
  coffer_drop_mm: number;
  coffer_margin_mm: number;
  coffer_beam_mm: number;
  coffer_grid?: { nx: number; ny: number };
  paint_material?: string;
}
export interface CeilingInput { room: RoomIn; fixtures: FixturesIn; brief: BriefIn }

export function roomOutline(room: RoomIn): Pt[] {
  if (room.outline_mm && room.outline_mm.length) return room.outline_mm;
  const w = room.width_mm ?? 0, d = room.depth_mm ?? 0;
  return [[0, 0], [w, 0], [w, d], [0, d]];
}

export function inputProblems(input: CeilingInput): string[] {
  const out: string[] = [];
  const { room } = input;
  if (!(room.outline_mm && room.outline_mm.length) && !((room.width_mm ?? 0) > 0 && (room.depth_mm ?? 0) > 0))
    out.push("Give the room as outline_mm (orthogonal corners in mm) or width_mm and depth_mm");
  else out.push(...polygonProblems(roomOutline(room)));
  if (!(room.structure_height_mm > 0)) out.push("structure_height_mm (underside of the ties or slab) is needed");
  if (room.structure === "ties" && room.tie_spacing_mm !== undefined && !(room.tie_spacing_mm > 0)) out.push("tie_spacing_mm must be more than 0");
  return out;
}

// ---------- designs ----------

export interface Zone extends Labelled { kind: "field" | "bulkhead" | "raft" | "coffer" | "base" | "flat"; prefix: string }
export interface Design {
  kind: Kind;
  label: string;
  zones: Zone[];
  room: Rect[];
  cove: boolean;
  cornice: boolean;
  why: string;
}

const floorTo = (v: number, step: number) => Math.floor(v / step + EPS) * step;
const fieldHeight = (input: CeilingInput, std: CeilingStandard) => input.brief.field_height_mm ?? input.room.structure_height_mm - std.min_void_mm;
const has = (b: BriefIn, ...s: Style[]) => s.some((x) => b.styles.includes(x));

/** One design, or why it can't be made in this room. */
export function buildDesign(kind: Kind, input: CeilingInput, std: CeilingStandard): Design | { kind: Kind; skipped: string } {
  const room = polyRects(roomOutline(input.room));
  const b = input.brief;
  const H = fieldHeight(input, std);
  const cove = has(b, "cove") && (kind === "tray" || kind === "raft");
  const cornice = has(b, "cornice");
  const base = { kind, room, cove, cornice };
  if (kind === "flat")
    return { ...base, label: "Flat", why: "Simplest and lowest cost; AC ducts and drivers need their own box-outs.",
      zones: [{ id: "field", kind: "flat", prefix: "F", height: H, rects: room }] };
  if (kind === "tray") {
    const field = erode(room, b.bulkhead_width_mm);
    if (area(field) < EPS) return { kind, skipped: `The room is too small for a ${b.bulkhead_width_mm} bulkhead all round` };
    return { ...base, label: `Tray with ${b.bulkhead_width_mm} bulkhead${cove ? " and cove" : ""}`,
      why: `The bulkhead hides AC grilles and ducts${cove ? "; the cove gives soft light" : ""}; a fan hangs in the middle of the tray.`,
      zones: [
        { id: "field", kind: "field", prefix: "F", height: H, rects: field },
        { id: "bulkhead", kind: "bulkhead", prefix: "B", height: H - b.bulkhead_drop_mm, rects: subtract(room, field) },
      ] };
  }
  const bb = bbox(room);
  const W = bb.x1 - bb.x0, D = bb.y1 - bb.y0;
  if (kind === "raft") {
    const r = b.raft ?? { x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2, width_mm: floorTo(W / 2, 300), depth_mm: floorTo(D / 2, 300) };
    const raft: Rect[] = [{ x0: r.x - r.width_mm / 2, y0: r.y - r.depth_mm / 2, x1: r.x + r.width_mm / 2, y1: r.y + r.depth_mm / 2 }];
    if (r.width_mm <= 0 || r.depth_mm <= 0 || Math.abs(area(intersect(raft, room)) - area(raft)) > 1)
      return { kind, skipped: "The raft doesn't fit inside the room: give brief.raft (centre, width and depth)" };
    return { ...base, label: "Flat with a floating raft",
      why: `Lightest build; the raft (${r.width_mm} × ${r.depth_mm}) marks the seating${cove ? " with a cove round it" : ""}; AC ducts need a separate box-out.`,
      zones: [
        { id: "field", kind: "flat", prefix: "F", height: H, rects: subtract(room, raft) },
        { id: "raft", kind: "raft", prefix: "R", height: H - b.raft_drop_mm, rects: raft },
      ] };
  }
  // coffer: a grid of recesses up to the field height, the beams and margin dropped
  const inner = erode(room, b.coffer_margin_mm);
  if (area(inner) < EPS) return { kind, skipped: "The room is too small for coffers" };
  const ib = bbox(inner);
  const iw = ib.x1 - ib.x0, id = ib.y1 - ib.y0, beam = b.coffer_beam_mm;
  const nx = b.coffer_grid?.nx ?? Math.max(1, Math.round((iw + beam) / 1750));
  const ny = b.coffer_grid?.ny ?? Math.max(1, Math.round((id + beam) / 1750));
  const cw = (iw - (nx - 1) * beam) / nx, ch = (id - (ny - 1) * beam) / ny;
  const coffers: Rect[] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    // whole millimetres: the set-out and the installer work in mm
    const c = { x0: Math.round(ib.x0 + i * (cw + beam)), y0: Math.round(ib.y0 + j * (ch + beam)),
      x1: Math.round(ib.x0 + i * (cw + beam) + cw), y1: Math.round(ib.y0 + j * (ch + beam) + ch) };
    if (cw > 0 && ch > 0 && Math.abs(area(intersect([c], inner)) - area([c])) < 1) coffers.push(c);
  }
  if (!coffers.length) return { kind, skipped: "No coffer fits inside the room" };
  return { ...base, label: `Coffered ${nx} × ${ny}`,
    why: "Most formal; the coffer grid sets where the fan and lights can hang.",
    zones: [
      { id: "field", kind: "base", prefix: "F", height: H - b.coffer_drop_mm, rects: subtract(room, coffers) },
      { id: "coffer", kind: "coffer", prefix: "C", height: H, rects: coffers },
    ] };
}

/** The kinds to offer, the brief's first, up to three. */
export function designOrder(brief: BriefIn): Kind[] {
  const wanted: Kind[] = [];
  for (const s of brief.styles) {
    const k: Kind | null = s === "tray" || s === "bulkhead" ? "tray" : s === "raft" ? "raft" : s === "coffer" ? "coffer" : s === "flat" ? "flat" : null;
    if (k && !wanted.includes(k)) wanted.push(k);
  }
  for (const k of ["tray", "raft", "coffer"] as Kind[]) if (!wanted.includes(k)) wanted.push(k);
  return wanted.slice(0, 3);
}

// ---------- quantities ----------

export interface Quantities {
  zones: Array<{ zone: string; height_mm: number; area_m2: number }>;
  face_m2: number;
  board_m2: number;
  sheets: number;
  sheet: string;
  main_m: number;
  furring_m: number;
  hangers: number;
  cornice_m: number;
  cove_led_m: number;
  joint_tape_m: number;
  paint_m2: number;
  downlights: number;
  screws: number;
  hatches: number;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

function grids(d: Design, std: CeilingStandard) {
  const bb = bbox(d.room);
  const furring = gridPositions(bb.x0, bb.x1, std.furring_cc_mm).flatMap((x) => lineIntervals(d.room, "x", x).map(([a, b]) => ({ x, from: a, to: b })));
  const mains = gridPositions(bb.y0, bb.y1, std.main_channel_cc_mm).flatMap((y) => lineIntervals(d.room, "y", y).map(([a, b]) => ({ y, from: a, to: b })));
  const hangers: Pt[] = [];
  for (const x of gridPositions(bb.x0, bb.x1, std.hanger_grid_mm))
    for (const y of gridPositions(bb.y0, bb.y1, std.hanger_grid_mm)) if (inRegion([x, y], d.room, true)) hangers.push([x, y]);
  return { furring, mains, hangers };
}

export function quantities(d: Design, input: CeilingInput, std: CeilingStandard): Quantities {
  const es = edgeStats(d.zones);
  const plan = d.zones.reduce((s, z) => s + area(z.rects), 0);
  const board = (plan + es.face_mm2) / 1e6;
  const sheetM2 = (std.sheet_length_mm * std.sheet_width_mm) / 1e6;
  const g = grids(d, std);
  const furring = g.furring.reduce((s, l) => s + l.to - l.from, 0) + 2 * es.step_mm; // + studs/rails top and bottom of each face
  return {
    zones: d.zones.map((z) => ({ zone: z.id, height_mm: z.height, area_m2: r2(area(z.rects) / 1e6) })),
    face_m2: r2(es.face_mm2 / 1e6),
    board_m2: r2(board),
    sheets: Math.ceil(board * (1 + std.board_waste) / sheetM2 - 1e-9),
    sheet: `${std.sheet_length_mm} × ${std.sheet_width_mm}`,
    main_m: r1(g.mains.reduce((s, l) => s + l.to - l.from, 0) / 1000),
    furring_m: r1(furring / 1000),
    hangers: g.hangers.length,
    cornice_m: d.cornice ? r1(es.wall_mm / 1000) : 0,
    cove_led_m: d.cove ? r1(es.step_mm / 1000) : 0,
    joint_tape_m: r1((board / sheetM2) * ((std.sheet_length_mm + std.sheet_width_mm) / 1000) * std.joint_tape_factor),
    paint_m2: r1(board),
    downlights: input.fixtures.downlights.length,
    screws: Math.floor(board * std.screws_per_m2 + 1e-9),
    hatches: input.fixtures.hatch ? 1 : 0,
  };
}

/** Lumen method, indicative only (CA-E-03: the electrical engineer confirms). */
export function luxEstimate(d: Design, input: CeilingInput, std: CeilingStandard): { lux: number; basis: string } {
  const cove = d.cove ? edgeStats(d.zones).step_mm / 1000 : 0;
  const n = input.fixtures.downlights.length;
  const total = n * std.lumens_per_downlight + cove * std.cove_lumens_per_m;
  const lux = Math.round((total * std.utilisation_factor * std.maintenance_factor) / (area(d.room) / 1e6));
  return { lux, basis: `${n} downlights × ${std.lumens_per_downlight} lm${cove ? ` + ${r1(cove)} m cove × ${std.cove_lumens_per_m} lm/m` : ""}, UF ${std.utilisation_factor}, MF ${std.maintenance_factor}` };
}

// ---------- set-out ----------

export interface Board { id: string; row: number; x_mm: number; y_mm: number; width_mm: number; depth_mm: number; cut: boolean; sliver: boolean; pieces: Rect[] }
export interface ZoneSetout { zone: string; height_mm: number; setting_out_points: Pt[]; boards: Board[]; slivers: string[]; min_end_joint_stagger_mm: number | null }
export interface Setout {
  sheet: string;
  zones: ZoneSetout[];
  faces: Array<{ zones: [string, string]; from: Pt; to: Pt; height_mm: number }>;
  furring: Array<{ x: number; from: number; to: number }>;
  mains: Array<{ y: number; from: number; to: number }>;
  hangers: Pt[];
}

interface Piece { row: number; col: number; r: Rect; sliver: boolean; leftCut: boolean }

const ivMerge = (iv: Array<[number, number]>) => {
  iv.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const i of iv) { const l = out[out.length - 1]; if (l && i[0] <= l[1] + EPS) l[1] = Math.max(l[1], i[1]); else out.push([i[0], i[1]]); }
  return out;
};

function layoutAt(rs: Rect[], bb: Rect, ox: number, oy: number, std: CeilingStandard): Piece[] {
  const L = std.sheet_length_mm, S = std.sheet_width_mm, m = std.min_board_piece_mm;
  const out: Piece[] = [];
  for (let k = 0; ; k++) {
    const yk = bb.y0 - oy + k * S;
    if (yk >= bb.y1 - EPS) break;
    const lo = Math.max(yk, bb.y0), hi = Math.min(yk + S, bb.y1);
    if (hi - lo < EPS) continue;
    const ys = [...new Set([lo, hi, ...rs.flatMap((r) => [r.y0, r.y1]).filter((v) => v > lo + EPS && v < hi - EPS)])].sort((a, b) => a - b);
    const subs: Array<{ ya: number; yb: number; iv: Array<[number, number]> }> = [];
    for (let i = 0; i + 1 < ys.length; i++) {
      const mid = (ys[i] + ys[i + 1]) / 2;
      const iv = ivMerge(rs.filter((r) => r.y0 < mid && r.y1 > mid).map((r) => [r.x0, r.x1] as [number, number]));
      if (!iv.length) continue;
      const last = subs[subs.length - 1];
      if (last && Math.abs(last.yb - ys[i]) < EPS && JSON.stringify(last.iv) === JSON.stringify(iv)) last.yb = ys[i + 1];
      else subs.push({ ya: ys[i], yb: ys[i + 1], iv });
    }
    const jx0 = bb.x0 - ox - (k % 2 ? std.end_joint_stagger_mm : 0);
    for (const s of subs) for (const [a, b] of s.iv) {
      const edges = [a];
      for (let n = Math.floor((a - jx0) / L + EPS) + 1; jx0 + n * L < b - EPS; n++) edges.push(jx0 + n * L);
      edges.push(b);
      for (let i = 0; i + 1 < edges.length; i++) {
        const [p0, p1] = [edges[i], edges[i + 1]];
        const w = p1 - p0, h = s.yb - s.ya, mx = (p0 + p1) / 2;
        const leftCut = i > 0, rightCut = i + 2 < edges.length;
        const bottomJoint = Math.abs(s.ya - yk) < EPS && inRegion([mx, s.ya - 0.5], rs);
        const topJoint = Math.abs(s.yb - (yk + S)) < EPS && inRegion([mx, s.yb + 0.5], rs);
        out.push({ row: k, col: Math.floor((p0 - jx0) / L + EPS), r: { x0: p0, y0: s.ya, x1: p1, y1: s.yb }, leftCut,
          sliver: (w < m - EPS && (leftCut || rightCut)) || (h < m - EPS && (bottomJoint || topJoint)) });
      }
    }
  }
  return out;
}

/** Pieces of one sheet position that touch are one board (cut to an L round a notch); apart they are two. */
function groupBoards(pieces: Piece[]): Piece[][] {
  const groups: Piece[][] = [];
  const touch = (a: Rect, b: Rect) => a.x0 <= b.x1 + EPS && b.x0 <= a.x1 + EPS && a.y0 <= b.y1 + EPS && b.y0 <= a.y1 + EPS &&
    (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS || Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > EPS);
  for (const p of pieces) {
    const hits = groups.filter((g) => g[0].row === p.row && g[0].col === p.col && g.some((q) => touch(q.r, p.r)));
    if (!hits.length) { groups.push([p]); continue; }
    hits[0].push(p);
    for (const h of hits.slice(1)) { hits[0].push(...h); groups.splice(groups.indexOf(h), 1); }
  }
  return groups;
}

const lexLess = (a: number[], b: number[]) => {
  const i = a.findIndex((v, k) => v !== b[k]);
  return i >= 0 && a[i] < b[i];
};

/** One connected part: tries start offsets (a 50 mm step and every offset that puts a joint on one of its own edges)
 * and keeps the one with fewest slivers, then fewest boards, then the start nearest its corner. */
function layoutPart(rects: Rect[], std: CeilingStandard, step: number) {
  const bb = bbox(rects);
  let best: { score: number[]; pieces: Piece[]; ox: number; oy: number } | null = null;
  const L = std.sheet_length_mm, S = std.sheet_width_mm;
  const mod = (v: number, m: number) => Math.round((((v % m) + m) % m) * 1e3) / 1e3;
  const oys = new Set<number>(), oxs = new Set<number>();
  for (let v = 0; v < S - EPS; v += step) oys.add(v);
  for (let v = 0; v < L - EPS; v += step) oxs.add(v);
  for (const r of rects) {
    for (const e of [r.y0, r.y1]) oys.add(mod(bb.y0 - e, S));
    for (const e of [r.x0, r.x1]) { oxs.add(mod(bb.x0 - e, L)); oxs.add(mod(bb.x0 - std.end_joint_stagger_mm - e, L)); }
  }
  for (const oy of [...oys].sort((a, b) => a - b)) for (const ox of [...oxs].sort((a, b) => a - b)) {
    const pieces = layoutAt(rects, bb, ox, oy, std);
    const slivers = pieces.filter((p) => p.sliver).length;
    if (best && slivers > best.score[0]) continue;
    const score = [slivers, groupBoards(pieces).length, (ox ? 1 : 0) + (oy ? 1 : 0), ox + oy];
    if (!best || lexLess(score, best.score)) best = { score, pieces, ox, oy };
  }
  return { bb, ...best! };
}

function components(rs: Rect[]): Rect[][] {
  const out: Rect[][] = [];
  let left = rs.slice();
  while (left.length) {
    const c = componentAt(left, [(left[0].x0 + left[0].x1) / 2, (left[0].y0 + left[0].y1) / 2]);
    out.push(c);
    left = left.filter((r) => !c.includes(r));
  }
  return out.sort((a, b) => bbox(a).y0 - bbox(b).y0 || bbox(a).x0 - bbox(b).x0);
}

/** Lays one zone, each separate part (a coffer, a raft) from its own setting-out point; boards numbered row by row. */
export function layoutZone(z: Zone, std: CeilingStandard, step = 50): ZoneSetout {
  const rd = (v: number) => Math.round(v);
  const full = (g: Piece[]) => g.length === 1 && Math.abs(g[0].r.x1 - g[0].r.x0 - std.sheet_length_mm) < EPS && Math.abs(g[0].r.y1 - g[0].r.y0 - std.sheet_width_mm) < EPS;
  const boards: Board[] = [];
  const points: Pt[] = [];
  let stagger: number | null = null;
  for (const part of components(z.rects)) {
    const best = layoutPart(part, std, step);
    points.push([rd(best.bb.x0 - best.ox), rd(best.bb.y0 - best.oy)]);
    for (const g of groupBoards(best.pieces).sort((a, b) => a[0].row - b[0].row || a[0].r.x0 - b[0].r.x0)) {
      const b = bbox(g.map((p) => p.r));
      boards.push({ id: `${z.prefix}${boards.length + 1}`, row: g[0].row + 1, x_mm: rd(b.x0), y_mm: rd(b.y0), width_mm: rd(b.x1 - b.x0), depth_mm: rd(b.y1 - b.y0),
        cut: !full(g), sliver: g.some((p) => p.sliver), pieces: g.length > 1 ? g.map((p) => ({ x0: rd(p.r.x0), y0: rd(p.r.y0), x1: rd(p.r.x1), y1: rd(p.r.y1) })) : [] });
    }
    // end-joint stagger: the closest pair of end joints in neighbouring rows
    const cuts = new Map<number, number[]>();
    for (const p of best.pieces) if (p.leftCut) (cuts.get(p.row) ?? cuts.set(p.row, []).get(p.row)!).push(p.r.x0);
    for (const [row, xs] of cuts) for (const x of xs) for (const x2 of cuts.get(row + 1) ?? []) stagger = Math.min(stagger ?? Infinity, Math.abs(x - x2));
  }
  return { zone: z.id, height_mm: z.height, setting_out_points: points, boards,
    slivers: boards.filter((b) => b.sliver).map((b) => b.id), min_end_joint_stagger_mm: stagger === null ? null : rd(stagger) };
}

export function setout(d: Design, std: CeilingStandard): Setout {
  const es = edgeStats(d.zones);
  const g = grids(d, std);
  return {
    sheet: `${std.sheet_length_mm} × ${std.sheet_width_mm}, long edges across the furring`,
    zones: d.zones.map((z) => layoutZone(z, std)),
    faces: es.steps.map((s) => ({ zones: s.zones, from: s.a, to: s.b, height_mm: s.dh })),
    furring: g.furring, mains: g.mains, hangers: g.hangers,
  };
}

// ---------- checks ----------

export const RESULTS = ["Fail", "Decide", "Engineer", "Info", "OK", "N/A"] as const;
export type Result = (typeof RESULTS)[number];
export interface Check { id: string; check: string; result: Result; detail: string }

const worst = (rs: Result[]): Result => rs.reduce((w, r) => (RESULTS.indexOf(r) < RESULTS.indexOf(w) ? r : w), "N/A" as Result);
const mm = (v: number) => `${Math.round(v)}`;

function zoneAt(d: Design, p: Pt): Zone | undefined {
  return d.zones.find((z) => inRegion(p, z.rects)) ?? d.zones.find((z) => inRegion(p, z.rects, true));
}

export function checks(d: Design, input: CeilingInput, std: CeilingStandard, so: Setout = setout(d, std)): Check[] {
  const { room, fixtures } = input;
  const out: Check[] = [];
  const S = room.structure_height_mm;
  const what = room.structure === "slab" ? "slab" : "truss ties";
  const top = Math.max(...d.zones.map((z) => z.height)), low = Math.min(...d.zones.map((z) => z.height));
  const es = edgeStats(d.zones);
  const pt = (f: XY): Pt => [f.x, f.y];

  // 1 clearance
  const voidMm = S - top;
  out.push({ id: "clearance", check: `Clearance to the ${what}`, result: voidMm >= std.min_void_mm - EPS ? "OK" : "Fail",
    detail: voidMm >= std.min_void_mm - EPS
      ? `Highest ceiling at ${mm(top)}, ${what} at ${mm(S)}: ${mm(voidMm)} mm for mains and hangers`
      : `Highest ceiling at ${mm(top)}, ${what} at ${mm(S)}: ${mm(voidMm)} mm, less than the ${mm(std.min_void_mm)} mm mains and hangers need` });

  // 2 hangers
  const hangers = so.hangers;
  if (room.structure === "slab")
    out.push({ id: "hangers", check: "Hangers fix to the slab", result: "OK", detail: `${hangers.length} hangers on a ${std.hanger_grid_mm} grid, anchored to the slab` });
  else if (!room.tie_spacing_mm)
    out.push({ id: "hangers", check: "Hangers fix to the ties", result: "Info",
      detail: `${hangers.length} hangers on a ${std.hanger_grid_mm} grid; tie positions not given: check each lands on a tie or add noggins` });
  else {
    const sp = room.tie_spacing_mm, off = room.tie_offset_mm;
    const between = hangers.filter(([x, y]) => {
      const v = room.tie_direction === "x" ? y : x;
      const r = (((v - off) % sp) + sp) % sp;
      return Math.min(r, sp - r) > std.hanger_tie_tolerance_mm + EPS;
    }).length;
    out.push({ id: "hangers", check: "Hangers fix to the ties", result: between ? "Decide" : "OK",
      detail: `${hangers.length} hangers on a ${std.hanger_grid_mm} grid; ${between ? `${between} land between ties: add noggins` : "all land on a tie"}` });
  }

  // 3 AC supply
  if (!fixtures.ac_grilles.length) out.push({ id: "ac", check: "AC supply in the ceiling", result: "N/A", detail: "No AC grilles in this room" });
  else {
    const rows = fixtures.ac_grilles.map((g) => {
      const z = zoneAt(d, pt(g));
      if (!z) return { r: "Decide" as Result, t: `Grille at (${mm(g.x)}, ${mm(g.y)}) is outside the room` };
      const room_ = S - z.height - std.min_void_mm;
      const where = z.kind === "bulkhead" ? "the bulkhead" : z.kind === "raft" ? "the raft" : z.kind === "coffer" ? "a coffer" : "the ceiling";
      return room_ >= g.duct_height_mm - EPS
        ? { r: "OK" as Result, t: `Grille ${mm(g.width_mm)} × ${mm(g.depth_mm)} in ${where}; duct ${mm(g.duct_height_mm)} high fits the ${mm(room_)} mm below the framing zone` }
        : { r: "Decide" as Result, t: `Grille ${mm(g.width_mm)} × ${mm(g.depth_mm)} in ${where}: the duct (${mm(g.duct_height_mm)} high) has ${mm(Math.max(0, room_))} mm, so it shows: box it out or move it into a bulkhead` };
    });
    out.push({ id: "ac", check: "AC supply in the ceiling", result: worst(rows.map((x) => x.r)), detail: rows.map((x) => x.t).join("; ") });
  }

  // 4 fan
  const fan = fixtures.fan;
  if (!fan) out.push({ id: "fan", check: "Ceiling fan", result: "N/A", detail: "No fan in this room" });
  else {
    const p = pt(fan);
    const z = zoneAt(d, p);
    const parts: Array<{ r: Result; t: string }> = [];
    if (!z) parts.push({ r: "Fail", t: "The fan is outside the room" });
    else {
      if (d.kind === "coffer" && z.kind !== "coffer")
        parts.push({ r: "Fail", t: "Fan off-centre: it falls on the coffer grid (a beam), so it can't hang centred in a coffer; move the grid or the fan" });
      else {
        const c = bbox(componentAt(z.rects, p));
        const off = Math.max(Math.abs((c.x0 + c.x1) / 2 - fan.x), Math.abs((c.y0 + c.y1) / 2 - fan.y));
        const name = z.kind === "flat" || z.kind === "base" ? "room" : z.kind === "field" ? "tray" : z.kind;
        parts.push(off <= std.fan_centre_tolerance_mm + EPS ? { r: "OK", t: `Centred in the ${name}` } : { r: "Decide", t: `${mm(off)} mm off the centre of the ${name}` });
      }
      const blade = z.height - fan.drop_mm;
      parts.push(blade >= std.fan_min_blade_height_mm - EPS
        ? { r: "OK", t: `blades about ${(blade / 1000).toFixed(2)} m above the floor` }
        : { r: "Fail", t: `blades at ${(blade / 1000).toFixed(2)} m, under the ${(std.fan_min_blade_height_mm / 1000).toFixed(2)} m minimum` });
    }
    const rad = fan.sweep_mm / 2;
    const lights = fixtures.downlights.filter((l) => Math.hypot(l.x - fan.x, l.y - fan.y) < rad - EPS).length;
    parts.push(lights ? { r: "Decide", t: `${lights} downlight(s) within the sweep (strobing)` } : { r: "OK", t: "no downlight within the sweep" });
    const near = Math.min(...[...es.walls, ...es.steps].map((s) => distToSeg(p, s)));
    if (near < rad - EPS) parts.push({ r: "Decide", t: `the blades reach within ${mm(near)} mm of a wall or ceiling step (sweep ${mm(fan.sweep_mm)})` });
    out.push({ id: "fan", check: "Fan position, sweep and height", result: worst(parts.map((x) => x.r)), detail: cap(parts.map((x) => x.t).join("; ")) });
  }

  // 5 detectors
  if (!fixtures.detectors.length) out.push({ id: "detectors", check: "Detector placement", result: "Info", detail: "No detectors given: the fire alarm designer places them" });
  else {
    const rows = fixtures.detectors.map((det) => {
      const p = pt(det);
      const z = zoneAt(d, p);
      const issues: string[] = [];
      if (!z) issues.push("outside the room");
      else if (z.height < top - EPS) issues.push(`at ${mm(z.height)}, below the highest ceiling (${mm(top)}): smoke gathers there`);
      const wall = Math.min(...es.walls.map((s) => distToSeg(p, s)));
      if (wall < std.detector_wall_clearance_mm - EPS) issues.push(`${mm(wall)} mm from a wall`);
      if (es.steps.length) { const st = Math.min(...es.steps.map((s) => distToSeg(p, s))); if (st < std.detector_wall_clearance_mm - EPS) issues.push(`${mm(st)} mm from a ceiling step${d.cove ? " (cove)" : ""}`); }
      for (const g of fixtures.ac_grilles) {
        const dx = Math.max(0, Math.abs(det.x - g.x) - g.width_mm / 2), dy = Math.max(0, Math.abs(det.y - g.y) - g.depth_mm / 2);
        if (Math.hypot(dx, dy) < std.detector_grille_clearance_mm - EPS) issues.push(`${mm(Math.hypot(dx, dy))} mm from an AC supply grille`);
      }
      if (fan && Math.hypot(det.x - fan.x, det.y - fan.y) < fan.sweep_mm / 2 + std.detector_wall_clearance_mm - EPS) issues.push("in the fan's airflow");
      return { r: (issues.length ? "Decide" : "OK") as Result, t: issues.length ? `${det.kind} at (${mm(det.x)}, ${mm(det.y)}): ${issues.join(", ")}` : `${det.kind} at (${mm(det.x)}, ${mm(det.y)})` };
    });
    const r = worst(rows.map((x) => x.r));
    out.push({ id: "detectors", check: "Detector placement", result: r,
      detail: r === "OK" ? `${rows.map((x) => x.t).join("; ")}: at the highest ceiling, clear of walls, steps${d.cove ? " and the cove" : ""}, the fan airflow and AC grilles`
        : rows.filter((x) => x.r !== "OK").map((x) => x.t).join("; ") });
  }

  // 6 access to drivers
  const needs = [d.cove ? "cove LED drivers" : "", fixtures.downlights.length ? "downlight drivers" : "", fan ? "the fan box" : ""].filter(Boolean);
  if (!needs.length) out.push({ id: "access", check: "Access to drivers", result: "N/A", detail: "Nothing in the ceiling needs access" });
  else if (fixtures.hatch) out.push({ id: "access", check: "Access to drivers", result: "Info",
    detail: `${cap(list(needs))} reachable from the ${mm(fixtures.hatch.size_mm)} hatch at (${mm(fixtures.hatch.x)}, ${mm(fixtures.hatch.y)})` });
  else out.push({ id: "access", check: "Access to drivers", result: "Decide", detail: `No access hatch: add one for ${list(needs)}, or use fittings with drivers reachable through the cut-out` });

  // 7 light level: never a pass (rule 5, CA-E-03)
  const lx = luxEstimate(d, input, std);
  out.push({ id: "light", check: "Light level", result: "Engineer",
    detail: `About ${lx.lux} lx average (indicative lumen method: ${lx.basis}): the electrical engineer designs the lighting and confirms (CA-E-03)` });

  // 8 board joints
  const slivers = so.zones.flatMap((z) => z.slivers);
  const st = so.zones.map((z) => z.min_end_joint_stagger_mm).filter((v): v is number => v !== null);
  const minSt = st.length ? Math.min(...st) : null;
  const jointIssues: string[] = [];
  if (slivers.length) jointIssues.push(`${slivers.length} piece(s) under ${std.min_board_piece_mm} (${slivers.slice(0, 8).join(", ")}): the zone is too narrow for whole boards; fix them with an extra furring`);
  if (minSt !== null && minSt < std.end_joint_stagger_mm - EPS) jointIssues.push(`end joints only ${minSt} mm apart in neighbouring rows`);
  out.push({ id: "joints", check: "Board joints", result: jointIssues.length ? "Decide" : "OK",
    detail: jointIssues.length ? jointIssues.join("; ")
      : `Long edges across the furring; end joints staggered ${minSt ?? std.end_joint_stagger_mm}; no sliver under ${std.min_board_piece_mm}` });

  // 9 sprinklers
  out.push(fixtures.sprinklers.length
    ? { id: "sprinklers", check: "Sprinklers", result: "Info", detail: `${fixtures.sprinklers.length} head(s): the fire engineer sets them to the new ceiling heights` }
    : { id: "sprinklers", check: "Sprinklers", result: "N/A", detail: "None in this room" });

  // 10 headroom (kit value)
  out.push(std.min_ceiling_height_mm === null
    ? { id: "headroom", check: "Headroom", result: "Info", detail: `Lowest ceiling ${mm(low)}; the kit has no minimum ceiling height per room use yet (kit change request)` }
    : { id: "headroom", check: "Headroom", result: low >= std.min_ceiling_height_mm - EPS ? "OK" : "Fail",
      detail: `Lowest ceiling ${mm(low)}, kit minimum ${mm(std.min_ceiling_height_mm)}` });
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const list = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

export function tally(cs: Check[]): Record<Result, number> {
  const t = Object.fromEntries(RESULTS.map((r) => [r, 0])) as Record<Result, number>;
  for (const c of cs) t[c.result]++;
  return t;
}

// ---------- the whole answer for one room ----------

export interface Evaluated { id: string; design: Design; q: Quantities; checks: Check[]; lux: number; setout: Setout }

export function standardFor(input: CeilingInput, kit: CeilingKit): ResolvedStandard {
  const mat = boardMaterial(input.brief.board, kit.materials);
  const w = kit.codes?.[input.brief.board]?.waste;
  return resolveStandard(kit.standard, typeof w === "number" ? w : null, mat?.description ?? null);
}

export function evaluate(kind: Kind, input: CeilingInput, std: CeilingStandard, id = ""): Evaluated | { kind: Kind; skipped: string } {
  const d = buildDesign(kind, input, std);
  if ("skipped" in d) return d;
  const so = setout(d, std);
  return { id, design: d, q: quantities(d, input, std), checks: checks(d, input, std, so), lux: luxEstimate(d, input, std).lux, setout: so };
}

export function designs(input: CeilingInput, std: CeilingStandard) {
  const order = designOrder(input.brief);
  const made: Evaluated[] = [];
  const skipped: Array<{ kind: Kind; why: string }> = [];
  for (const k of order) {
    const e = evaluate(k, input, std, String.fromCharCode(65 + made.length));
    if ("skipped" in e) skipped.push({ kind: k, why: e.skipped }); else made.push(e);
  }
  const rec = made.find((e) => tally(e.checks).Fail === 0);
  return {
    options: made.map((e) => {
      const t = tally(e.checks);
      const hs = [...new Set(e.design.zones.map((z) => z.height))].sort((a, b) => b - a);
      return {
        id: e.id, kind: e.design.kind, label: e.design.label, recommended: e === rec,
        heights_mm: hs, board_m2: e.q.board_m2, sheets: e.q.sheets, light_lx_indicative: e.lux,
        checks: { fail: t.Fail, decide: t.Decide, engineer: t.Engineer, ok: t.OK },
        flags: e.checks.filter((c) => c.result === "Fail" || c.result === "Decide").map((c) => `${c.check}: ${c.detail}`),
        why: e.design.why,
      };
    }),
    skipped,
    note: "Light levels are indicative (lumen method, CA-E-03); the electrical engineer confirms the lighting design.",
  };
}

// ---------- bill of quantities ----------

export function boardMaterial(board: string, mats: LibMaterial[]): LibMaterial | undefined {
  const hits = mats.filter((m) => m.keynote === board);
  return hits.find((m) => /board/i.test(m.class)) ?? hits[0];
}

export interface BoqLine {
  item: string; qty: number; unit: string; keynote: string; material: string;
  rate_ugx: string; price_unit: string; price_date: string; price_source: string; price_status: string;
  total_ugx: number | null; note: string;
}

/** A library rate as a number, or null for a range or text. */
export function parseUgx(s: string): number | null {
  const t = s.replace(/[,\s]/g, "");
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

const UNIT_RX: Record<string, RegExp> = {
  board: /\bper\b[^;]*?\b(board|sheet)s?\b/i,
  m2: /\bper\s*(m2|m²|sq\.?\s*m|square met)/i,
  m: /\bper\s*(m|metre|meter|lm|linear met)(?![2²a-z])/i,
  no: /\bper\s*(no\.?|piece|unit|each|item)\b/i,
};

export function boq(e: Evaluated, input: CeilingInput, std: CeilingStandard, kit: CeilingKit): { lines: BoqLine[]; priced_total_ugx: number; price_needed: number; kit_change_requests: string[] } {
  const q = e.q;
  const kcr: string[] = [];
  const leafKeynotes = kit.keynotes.filter((k) => k.code.includes("_"));
  // interiors (I.*) first: "cornice" is also an external ornament (A.ORN)
  const findKey = (rx: RegExp) => leafKeynotes.find((k) => k.code.startsWith("I.") && rx.test(k.description)) ?? leafKeynotes.find((k) => rx.test(k.description));
  const lines: BoqLine[] = [];
  const add = (item: string, qty: number, unit: string, how: { code?: string; rx?: RegExp; material?: string; noPrice?: string; note?: string }) => {
    if (!(qty > 0)) return;
    const kn = how.code ? kit.keynotes.find((k) => k.code === how.code) : how.rx ? findKey(how.rx) : undefined;
    const keynote = kn?.code ?? (how.code ?? "");
    if (!kn && !how.noPrice) kcr.push(`Keynote for "${item}": none in the kit's FMC_Keynotes.txt${how.code ? ` (${how.code} not found)` : ""}`);
    let mat: LibMaterial | undefined;
    let note = how.note ?? "";
    if (how.material) mat = kit.materials.find((m) => m.name === how.material);
    if (!mat && kn && !how.noPrice) {
      const hits = kit.materials.filter((m) => m.keynote === kn.code);
      if (hits.length === 1 || how.code) mat = how.code ? boardMaterial(kn.code, kit.materials) : hits[0];
      else if (hits.length > 1) note = [note, `choose the material (${hits.map((m) => m.name).join(", ")})`].filter(Boolean).join("; ");
    }
    const line: BoqLine = { item, qty, unit, keynote: kn ? keynote : how.noPrice ? "" : "missing", material: mat?.name ?? "", rate_ugx: "", price_unit: "",
      price_date: "", price_source: "", price_status: "price needed", total_ugx: null, note };
    if (how.noPrice) line.note = [how.noPrice, note].filter(Boolean).join("; ");
    else if (mat?.price) {
      const p = mat.price;
      Object.assign(line, { rate_ugx: p.ugx, price_unit: p.unit, price_date: p.date, price_source: p.source, price_status: p.status || "secondary" });
      const rate = parseUgx(p.ugx);
      if (rate !== null && UNIT_RX[unit]?.test(p.unit)) line.total_ugx = Math.round(rate * qty);
      else line.note = [note, rate === null ? `library rate "${p.ugx}" is not one figure: no total` : `library price is per "${p.unit}", not per ${unit}: no total`].filter(Boolean).join("; ");
    }
    lines.push(line);
  };
  const b = input.brief;
  add(`${kit.keynotes.find((k) => k.code === b.board)?.description ?? b.board}, ${q.sheet} (${q.board_m2} m² + ${Math.round(std.board_waste * 100)} % waste)`, q.sheets, "board", { code: b.board });
  add(`Main channels at ${std.main_channel_cc_mm}`, q.main_m, "m", { rx: /main channel|ceiling channel/i });
  add(`Furring channels at ${std.furring_cc_mm} (+ studs and rails at the steps)`, q.furring_m, "m", { rx: /furring channel|furring section/i });
  add(`Hangers with fixings, ${std.hanger_grid_mm} grid`, q.hangers, "no", { rx: /\bhangers?\b/i });
  add("Drywall screws", q.screws, "no", { rx: /drywall screw|plasterboard screw/i });
  add("Joint tape and filler", q.joint_tape_m, "m", { rx: /joint(ing)? tape/i });
  add("Cornice", q.cornice_m, "m", { rx: /cornice/i });
  add("Cove LED strip and channel", q.cove_led_m, "m", { rx: /LED strip|cove light/i, note: "the electrical engineer specifies it" });
  add("Downlights", q.downlights, "no", { noPrice: "by the electrical engineer (rule 5): type, driver and price from the lighting design" });
  if (input.fixtures.hatch) add(`Access hatch ${input.fixtures.hatch.size_mm} × ${input.fixtures.hatch.size_mm}`, 1, "no", { rx: /access (hatch|panel)/i });
  add("Skim and emulsion, 2 coats", q.paint_m2, "m2", { rx: /internal emulsion/i, material: b.paint_material });
  const priced = lines.reduce((s, l) => s + (l.total_ugx ?? 0), 0);
  return { lines, priced_total_ugx: priced, price_needed: lines.filter((l) => l.total_ugx === null && !l.note.startsWith("by the")).length, kit_change_requests: kcr };
}

// ---------- CSVs for the pack ----------

export type Csv = Array<Array<string | number | boolean>>;

export function setoutCsv(so: Setout): Csv {
  const rows: Csv = [["kind", "id", "zone", "height_mm", "x_mm", "y_mm", "width_mm", "depth_mm", "row", "cut", "note"]];
  for (const z of so.zones) {
    z.setting_out_points.forEach((p, i) => rows.push(["setting_out_point", `${z.zone}-SOP${i + 1}`, z.zone, z.height_mm, p[0], p[1], "", "", "", "",
      "corner of the board grid: rows of sheets run from here"]));
    for (const b of z.boards)
      rows.push(["board", b.id, z.zone, z.height_mm, b.x_mm, b.y_mm, b.width_mm, b.depth_mm, b.row, b.cut, b.pieces.length ? `cut to shape: ${b.pieces.map((p) => `${p.x0},${p.y0}-${p.x1},${p.y1}`).join(" ")}` : b.sliver ? "sliver" : ""]);
  }
  so.mains.forEach((m, i) => rows.push(["main_channel", `M${i + 1}`, "", "", Math.round(m.from), Math.round(m.y), Math.round(m.to - m.from), "", "", "", "runs along x"]));
  so.furring.forEach((f, i) => rows.push(["furring", `FU${i + 1}`, "", "", Math.round(f.x), Math.round(f.from), "", Math.round(f.to - f.from), "", "", "runs along y"]));
  so.hangers.forEach((h, i) => rows.push(["hanger", `H${i + 1}`, "", "", Math.round(h[0]), Math.round(h[1]), "", "", "", "", ""]));
  so.faces.forEach((f, i) => rows.push(["face", `V${i + 1}`, f.zones.join("/"), f.height_mm, Math.round(f.from[0]), Math.round(f.from[1]),
    Math.round(f.to[0] - f.from[0]), Math.round(f.to[1] - f.from[1]), "", "", "vertical face between the zones"]));
  return rows;
}

export function boqCsv(lines: BoqLine[]): Csv {
  return [["item", "qty", "unit", "keynote", "material", "rate_ugx", "price_unit", "price_date", "price_source", "price_status", "total_ugx", "note"],
    ...lines.map((l) => [l.item, l.qty, l.unit, l.keynote, l.material, l.rate_ugx, l.price_unit, l.price_date, l.price_source, l.price_status, l.total_ugx ?? "", l.note])];
}

export function checksCsv(cs: Check[]): Csv {
  return [["id", "check", "result", "detail"], ...cs.map((c) => [c.id, c.check, c.result, c.detail])];
}

export const slug = (s: string) => s.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "Room";
