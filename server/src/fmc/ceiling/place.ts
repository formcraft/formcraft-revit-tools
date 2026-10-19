/**
 * Ceiling placement plan (Engineer › Ceilings, step CL2, docs/PLAN_CEILINGS.md). Pure: turns an engine design into what
 * the Revit commands fmc_ceiling_place / fmc_ceiling_edit build, every position in model mm (the room's corner moved to
 * the origin the person gives):
 *  - ceilings: one per connected part of each zone (field, bulkhead soffit, raft, coffers, coffer beams), its boundary
 *    loops (outer first, counter-clockwise; holes clockwise) and its height above the level;
 *  - lines: the vertical faces at each step (bulkhead, raft and coffer sides), the cove line, the cornice along the walls
 *    and the coffer mouldings, for line-based families the kit may hold (the command reports the roles it can't place);
 *  - marks: the fixtures' positions (fan, downlights, detectors, AC grilles, hatch, sprinklers) as marks only. Lights and
 *    fans are never placed as fixtures here: the electrical engineer designs them (rule 5; the owner's question in the
 *    plan is open, so CL2 takes the safe default).
 */
import { Pt, Rect, Seg, componentAt, edgeStats, inRegion } from "./geometry.js";
import { CeilingInput, Design, Zone } from "./engine.js";

const EPS = 1e-6;
const r1 = (v: number) => Math.round(v * 10) / 10;
const uniq = (v: number[]) => [...new Set(v.map((n) => Math.round(n * 1e6) / 1e6))].sort((a, b) => a - b);

// ---------- loops ----------

/** The connected parts of a region (rectangles that share an edge, not just a corner). */
export function regionComponents(rs: Rect[]): Rect[][] {
  const left = rs.map((r) => ({ ...r }));
  const out: Rect[][] = [];
  while (left.length) {
    const r = left[0];
    const part = componentAt(left, [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]);
    out.push(part);
    for (const p of part) left.splice(left.indexOf(p), 1);
  }
  return out;
}

/** Twice the signed area: positive for a counter-clockwise loop. */
export function signedArea(loop: Pt[]): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const [a, b] = [loop[i], loop[(i + 1) % loop.length]];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Drops corners that sit on a straight run. */
function simplify(loop: Pt[]): Pt[] {
  const out: Pt[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const p = loop[(i + n - 1) % n], c = loop[i], q = loop[(i + 1) % n];
    const cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
    if (Math.abs(cross) > EPS) out.push(c);
  }
  return out;
}

/**
 * The boundary loops of one connected region: the outer loop counter-clockwise first, then each hole clockwise. Traced
 * on the region's own grid with the region on the left; at a pinch the walk turns left, so loops never cross.
 */
export function regionLoops(rs: Rect[]): { outer: Pt[]; holes: Pt[][] } {
  const xs = uniq(rs.flatMap((r) => [r.x0, r.x1])), ys = uniq(rs.flatMap((r) => [r.y0, r.y1]));
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i + 1 < xs.length && j + 1 < ys.length &&
    inRegion([(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2], rs);
  const key = (p: Pt) => `${p[0]}|${p[1]}`;
  const edges: Array<{ a: Pt; b: Pt; used: boolean }> = [];
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    if (!inside(i, j)) continue;
    const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
    if (!inside(i, j - 1)) edges.push({ a: [x0, y0], b: [x1, y0], used: false });
    if (!inside(i + 1, j)) edges.push({ a: [x1, y0], b: [x1, y1], used: false });
    if (!inside(i, j + 1)) edges.push({ a: [x1, y1], b: [x0, y1], used: false });
    if (!inside(i - 1, j)) edges.push({ a: [x0, y1], b: [x0, y0], used: false });
  }
  const from = new Map<string, typeof edges>();
  for (const e of edges) (from.get(key(e.a)) ?? from.set(key(e.a), []).get(key(e.a))!).push(e);
  const loops: Pt[][] = [];
  for (const start of edges) {
    if (start.used) continue;
    const loop: Pt[] = [];
    let e = start;
    while (!e.used) {
      e.used = true;
      loop.push(e.a);
      const dir: Pt = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
      const next = (from.get(key(e.b)) ?? []).filter((x) => !x.used);
      if (!next.length) break;
      // the sharpest left turn first (cross product of the incoming and outgoing directions)
      next.sort((p, q) => {
        const cp = dir[0] * (p.b[1] - p.a[1]) - dir[1] * (p.b[0] - p.a[0]);
        const cq = dir[0] * (q.b[1] - q.a[1]) - dir[1] * (q.b[0] - q.a[0]);
        return cq - cp;
      });
      e = next[0];
    }
    const s = simplify(loop);
    if (s.length >= 3) loops.push(s);
  }
  const outer = loops.filter((l) => signedArea(l) > 0).sort((a, b) => signedArea(b) - signedArea(a));
  return { outer: outer[0] ?? [], holes: [...outer.slice(1), ...loops.filter((l) => signedArea(l) < 0)] };
}

// ---------- segments ----------

export interface Run { a: Pt; b: Pt }

/** Joins collinear segments end to end, each group by its own tag (zones, heights). Directions are normalised. */
export function mergeRuns<T extends Run>(segs: T[], tag: (s: T) => string): T[] {
  const norm = segs.map((s) => (s.a[0] > s.b[0] + EPS || (Math.abs(s.a[0] - s.b[0]) < EPS && s.a[1] > s.b[1])) ? { ...s, a: s.b, b: s.a } : { ...s });
  const groups = new Map<string, T[]>();
  for (const s of norm) {
    const vertical = Math.abs(s.a[0] - s.b[0]) < EPS;
    const k = `${vertical ? "v" : "h"}|${vertical ? s.a[0] : s.a[1]}|${tag(s)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
  }
  const out: T[] = [];
  for (const [k, list] of groups) {
    const v = k.startsWith("v");
    list.sort((p, q) => (v ? p.a[1] - q.a[1] : p.a[0] - q.a[0]));
    let cur = { ...list[0] };
    for (const s of list.slice(1)) {
      const touches = v ? Math.abs(s.a[1] - cur.b[1]) < EPS : Math.abs(s.a[0] - cur.b[0]) < EPS;
      if (touches) cur = { ...cur, b: s.b }; else { out.push(cur); cur = { ...s }; }
    }
    out.push(cur);
  }
  return out.sort((p, q) => p.a[1] - q.a[1] || p.a[0] - q.a[0] || p.b[1] - q.b[1] || p.b[0] - q.b[0]);
}

const len = (s: Run) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);

export function zoneAt(d: Design, p: Pt): Zone | undefined {
  return d.zones.find((z) => inRegion(p, z.rects)) ?? d.zones.find((z) => inRegion(p, z.rects, true));
}

/** The step segments between zones at different heights, merged: the line, the zones, the top and bottom heights. */
export function steps(d: Design): Array<Run & { zones: [string, string]; bottom_mm: number; top_mm: number }> {
  const h = new Map(d.zones.map((z) => [z.id, z.height]));
  const raw = edgeStats(d.zones).steps.map((s) => {
    const [ha, hb] = [h.get(s.zones[0])!, h.get(s.zones[1])!];
    const zones = [...s.zones].sort() as [string, string];
    return { a: s.a, b: s.b, zones, bottom_mm: Math.min(ha, hb), top_mm: Math.max(ha, hb) };
  });
  return mergeRuns(raw, (s) => `${s.zones.join("/")}|${s.bottom_mm}|${s.top_mm}`);
}

/** The wall segments (zone to outside), merged, each with the zone and ceiling height against it. */
export function walls(d: Design): Array<Run & { zone: string; height_mm: number }> {
  const raw: Array<Run & { zone: string; height_mm: number }> = [];
  for (const w of edgeStats(d.zones).walls as Seg[]) {
    const m: Pt = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    const vertical = Math.abs(w.a[0] - w.b[0]) < EPS;
    const probes: Pt[] = vertical ? [[m[0] - 1, m[1]], [m[0] + 1, m[1]]] : [[m[0], m[1] - 1], [m[0], m[1] + 1]];
    const z = probes.map((p) => zoneAt(d, p)).find((x) => x && inRegion(probes[0], x.rects) !== inRegion(probes[1], x.rects)) ?? probes.map((p) => zoneAt(d, p)).find(Boolean);
    if (z) raw.push({ a: w.a, b: w.b, zone: z.id, height_mm: z.height });
  }
  return mergeRuns(raw, (s) => `${s.zone}|${s.height_mm}`);
}

// ---------- the plan ----------

export const LINE_ROLES = ["face", "cove", "cornice", "coffer_moulding"] as const;
export type LineRole = (typeof LINE_ROLES)[number];
export const MARK_KINDS = ["fan", "downlight", "detector", "ac_grille", "hatch", "sprinkler"] as const;
export type MarkKind = (typeof MARK_KINDS)[number];

export interface CeilingOp { key: string; zone: string; kind: string; height_mm: number; area_m2: number; loops: Pt[][] }
export interface LineOp { key: string; role: LineRole; zones: string; from: Pt; to: Pt; z_mm: number; drop_mm: number; length_mm: number }
export interface MarkOp { key: string; kind: MarkKind; x: number; y: number; z_mm: number; label: string; size_mm?: number; width_mm?: number; depth_mm?: number; sweep_mm?: number }
export interface PlacePlan {
  ceilings: CeilingOp[];
  lines: LineOp[];
  marks: MarkOp[];
  problems: string[];
  summary: { ceilings: number; heights_mm: number[]; lines_m: Record<LineRole, number>; marks: Record<string, number> };
}

const at = (o: { x: number; y: number }, p: Pt): Pt => [r1(o.x + p[0]), r1(o.y + p[1])];

/**
 * The placement plan for a design. origin: where the room's corner (0, 0) is in the model, in mm. Heights are above the
 * room's level (the engine's heights are from the floor).
 */
export function placementPlan(d: Design, input: CeilingInput, origin: { x: number; y: number } = { x: 0, y: 0 }): PlacePlan {
  const problems: string[] = [];
  const ceilings: CeilingOp[] = [];
  for (const z of d.zones) {
    regionComponents(z.rects).forEach((part, i) => {
      const { outer, holes } = regionLoops(part);
      if (outer.length < 4) { problems.push(`${z.id} part ${i + 1}: no closed outline`); return; }
      const area = part.reduce((s, r) => s + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
      ceilings.push({ key: `ceiling:${z.id}:${i + 1}`, zone: z.id, kind: z.kind, height_mm: z.height, area_m2: Math.round(area / 1e4) / 100,
        loops: [outer, ...holes].map((l) => l.map((p) => at(origin, p))) });
    });
  }

  const lines: LineOp[] = [];
  const push = (role: LineRole, zones: string, s: Run, z: number, drop: number) =>
    lines.push({ key: `${role}:${lines.filter((l) => l.role === role).length + 1}`, role, zones, from: at(origin, s.a), to: at(origin, s.b), z_mm: z, drop_mm: drop, length_mm: Math.round(len(s)) });
  const st = steps(d);
  // the vertical face of each step, from the lower ceiling up to the higher one
  for (const s of st) push("face", s.zones.join("/"), s, s.bottom_mm, s.top_mm - s.bottom_mm);
  // the cove runs along the steps of a tray or raft, at the lower ceiling's edge
  if (d.cove) for (const s of st) push("cove", s.zones.join("/"), s, s.bottom_mm, s.top_mm - s.bottom_mm);
  if (d.kind === "coffer") for (const s of st.filter((x) => x.zones.includes("coffer"))) push("coffer_moulding", s.zones.join("/"), s, s.bottom_mm, s.top_mm - s.bottom_mm);
  if (d.cornice) for (const w of walls(d)) push("cornice", w.zone, w, w.height_mm, 0);

  const marks: MarkOp[] = [];
  const f = input.fixtures;
  const mark = (kind: MarkKind, p: { x: number; y: number }, label: string, extra: Partial<MarkOp> = {}) => {
    const z = zoneAt(d, [p.x, p.y]);
    const n = marks.filter((m) => m.kind === kind).length + 1;
    if (!z) { problems.push(`${label} at (${p.x}, ${p.y}) is outside the room: not marked`); return; }
    const [x, y] = at(origin, [p.x, p.y]);
    marks.push({ key: `mark:${kind}:${n}`, kind, x, y, z_mm: z.height, label, ...extra });
  };
  if (f.fan) mark("fan", f.fan, "Ceiling fan (position only)", { sweep_mm: f.fan.sweep_mm });
  f.downlights.forEach((p, i) => mark("downlight", p, `Downlight ${i + 1} (position only)`));
  f.detectors.forEach((p, i) => mark("detector", p, `Detector ${i + 1}: ${p.kind} (for the fire engineer)`));
  f.ac_grilles.forEach((p, i) => mark("ac_grille", p, `AC grille ${i + 1}`, { width_mm: p.width_mm, depth_mm: p.depth_mm }));
  if (f.hatch) mark("hatch", f.hatch, "Access hatch", { size_mm: f.hatch.size_mm });
  f.sprinklers.forEach((p, i) => mark("sprinkler", p, `Sprinkler ${i + 1} (for the fire engineer)`));

  const lines_m = Object.fromEntries(LINE_ROLES.map((r) => [r, Math.round(lines.filter((l) => l.role === r).reduce((s, l) => s + l.length_mm, 0) / 100) / 10])) as Record<LineRole, number>;
  const counts: Record<string, number> = {};
  for (const m of marks) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
  return { ceilings, lines, marks, problems,
    summary: { ceilings: ceilings.length, heights_mm: [...new Set(ceilings.map((c) => c.height_mm))].sort((a, b) => b - a), lines_m, marks: counts } };
}
