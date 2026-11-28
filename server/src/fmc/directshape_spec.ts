/**
 * fmc_directshape: the solid spec. Pure code, no Revit. A shape is one DirectShape made of one or more parts; a part is a
 * box or a straight extrusion of a flat polygon. Units are millimetres, angles are degrees, Z is up.
 *   box        origin_mm = centre of the bottom face, size_mm = [along x, along y, up]
 *   extrusion  origin_mm = a point on the bottom face, profile_mm = vertices relative to it (x, y), height_mm = up
 * rotation_deg turns the part about the vertical through origin_mm.
 */
import crypto from "node:crypto";

export const DS_LIMITS = { max_shapes: 50, max_parts: 20, max_vertices: 64, min_mm: 1, max_mm: 500_000, coord_mm: 10_000_000 } as const;
export const DS_PURPOSES = ["clearance", "survey", "ifc_proxy", "other"] as const;
export type DsPurpose = (typeof DS_PURPOSES)[number];

export type P2 = [number, number];
export type P3 = [number, number, number];
export interface DsBox { kind: "box"; origin_mm: P3; size_mm: P3; rotation_deg: number }
export interface DsExtrusion { kind: "extrusion"; origin_mm: P3; profile_mm: P2[]; height_mm: number; rotation_deg: number }
export type DsPart = DsBox | DsExtrusion;

export interface DsShape {
  index: number;
  name: string;
  /** As the caller wrote it. Empty means the first whitelisted category. */
  category: string;
  purpose: DsPurpose;
  mark: string;
  /** A level name. Its elevation is added to every Z. */
  level: string;
  parts: DsPart[];
}

export interface DsProblem { index: number; code: string; message: string }

export interface RawPart {
  kind?: string; origin_mm?: number[]; size_mm?: number[]; profile_mm?: number[][]; height_mm?: number; rotation_deg?: number;
}
export interface RawShape extends RawPart {
  name?: string; category?: string; purpose?: string; mark?: string; level?: string; parts?: RawPart[];
}

const bad = (index: number, message: string): DsProblem => ({ index, code: "FMC-DS-SPEC", message: `[FMC-DS-SPEC] shape ${index + 1}: ${message}` });
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export function polygonArea(points: P2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function cross(a: P2, b: P2, c: P2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** True when two segments cross or touch. Segments that share an end point are not tested by the caller. */
function segmentsMeet(a: P2, b: P2, c: P2, d: P2): boolean {
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: P2, q: P2, r: P2) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (d1 === 0 && on(a, b, c)) || (d2 === 0 && on(a, b, d)) || (d3 === 0 && on(c, d, a)) || (d4 === 0 && on(c, d, b));
}

/** A simple polygon: at least three distinct vertices, no zero-length side, no side crossing another. */
export function polygonProblem(points: P2[]): string | null {
  const n = points.length;
  if (n < 3) return "profile_mm needs at least 3 vertices.";
  if (n > DS_LIMITS.max_vertices) return `profile_mm has ${n} vertices; the most is ${DS_LIMITS.max_vertices}.`;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < DS_LIMITS.min_mm) return `profile_mm side ${i + 1} is shorter than ${DS_LIMITS.min_mm} mm.`;
  }
  if (Math.abs(polygonArea(points)) < DS_LIMITS.min_mm ** 2) return "profile_mm encloses no area.";
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsMeet(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return `profile_mm sides ${i + 1} and ${j + 1} cross.`;
    }
  }
  return null;
}

function triple(v: unknown, label: string, positive: boolean): P3 | string {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) return `${label} must be three numbers [x, y, z] in mm.`;
  const t = v as P3;
  const limit = positive ? DS_LIMITS.max_mm : DS_LIMITS.coord_mm;
  if (t.some((n) => Math.abs(n) > limit)) return `${label} is outside ±${limit} mm.`;
  if (positive && t.some((n) => n < DS_LIMITS.min_mm)) return `${label} must be at least ${DS_LIMITS.min_mm} mm on every side.`;
  return t;
}

function normPart(raw: RawPart, index: number): DsPart | DsProblem {
  const kind = (raw.kind ?? "").trim().toLowerCase();
  const rotation = raw.rotation_deg ?? 0;
  if (!finite(rotation)) return bad(index, "rotation_deg must be a number.");
  const origin = triple(raw.origin_mm ?? [0, 0, 0], "origin_mm", false);
  if (typeof origin === "string") return bad(index, origin);
  if (kind === "box") {
    const size = triple(raw.size_mm, "size_mm", true);
    if (typeof size === "string") return bad(index, size);
    return { kind: "box", origin_mm: origin, size_mm: size, rotation_deg: round(rotation) };
  }
  if (kind === "extrusion" || kind === "mass") {
    const prof = raw.profile_mm;
    if (!Array.isArray(prof) || !prof.every((p) => Array.isArray(p) && p.length === 2 && p.every(finite))) return bad(index, "profile_mm must be a list of [x, y] vertices in mm.");
    const points = prof as P2[];
    if (points.some((p) => Math.abs(p[0]) > DS_LIMITS.max_mm || Math.abs(p[1]) > DS_LIMITS.max_mm)) return bad(index, `profile_mm is outside ±${DS_LIMITS.max_mm} mm.`);
    const why = polygonProblem(points);
    if (why) return bad(index, why);
    const h = raw.height_mm;
    if (!finite(h) || h < DS_LIMITS.min_mm || h > DS_LIMITS.max_mm) return bad(index, `height_mm must be between ${DS_LIMITS.min_mm} and ${DS_LIMITS.max_mm} mm.`);
    const ccw = polygonArea(points) > 0 ? points : [...points].reverse();
    return { kind: "extrusion", origin_mm: origin, profile_mm: ccw.map((p) => [p[0], p[1]] as P2), height_mm: h, rotation_deg: round(rotation) };
  }
  return bad(index, `kind must be "box" or "extrusion" (got "${raw.kind ?? ""}").`);
}

/** One list of shapes in, the validated shapes and every problem out. Nothing is guessed or repaired. */
export function normaliseShapes(raw: RawShape[]): { shapes: DsShape[]; problems: DsProblem[] } {
  const problems: DsProblem[] = [];
  const shapes: DsShape[] = [];
  if (!raw.length) return { shapes, problems: [bad(0, "no shapes. Give shapes, or kind with origin_mm and size_mm or profile_mm.")] };
  if (raw.length > DS_LIMITS.max_shapes) return { shapes, problems: [bad(0, `${raw.length} shapes; the most in one call is ${DS_LIMITS.max_shapes}.`)] };
  raw.forEach((r, index) => {
    const parts = r.parts && r.parts.length ? r.parts : [r];
    if (parts.length > DS_LIMITS.max_parts) { problems.push(bad(index, `${parts.length} parts; the most is ${DS_LIMITS.max_parts}.`)); return; }
    const purpose = (r.purpose ?? "other").trim().toLowerCase() as DsPurpose;
    if (!DS_PURPOSES.includes(purpose)) { problems.push(bad(index, `purpose must be one of ${DS_PURPOSES.join(", ")}.`)); return; }
    const done: DsPart[] = [];
    for (const p of parts) {
      const part = normPart(p, index);
      if ("code" in part) { problems.push(part); return; }
      done.push(part);
    }
    shapes.push({
      index, name: (r.name ?? "").trim() || `FMC DirectShape ${index + 1}`, category: (r.category ?? "").trim(), purpose,
      mark: (r.mark ?? "").trim(), level: (r.level ?? "").trim(), parts: done,
    });
  });
  return problems.length ? { shapes: [], problems } : { shapes, problems };
}

function corners(part: DsPart): P2[] {
  const base: P2[] = part.kind === "box"
    ? [[-part.size_mm[0] / 2, -part.size_mm[1] / 2], [part.size_mm[0] / 2, -part.size_mm[1] / 2], [part.size_mm[0] / 2, part.size_mm[1] / 2], [-part.size_mm[0] / 2, part.size_mm[1] / 2]]
    : part.profile_mm;
  const t = (part.rotation_deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return base.map(([x, y]) => [part.origin_mm[0] + x * c - y * s, part.origin_mm[1] + x * s + y * c] as P2);
}

export function partVolumeM3(part: DsPart): number {
  const mm3 = part.kind === "box" ? part.size_mm[0] * part.size_mm[1] * part.size_mm[2] : Math.abs(polygonArea(part.profile_mm)) * part.height_mm;
  return mm3 / 1e9;
}

export interface ShapeSummary {
  index: number; name: string; purpose: DsPurpose; parts: number; volume_m3: number;
  bbox_mm: { min: P3; max: P3 };
}

/** Counts and the box a shape fills, before any level offset. Parts that overlap are counted twice in volume_m3. */
export function summarise(shape: DsShape): ShapeSummary {
  const min: P3 = [Infinity, Infinity, Infinity], max: P3 = [-Infinity, -Infinity, -Infinity];
  let volume = 0;
  for (const part of shape.parts) {
    volume += partVolumeM3(part);
    const top = part.origin_mm[2] + (part.kind === "box" ? part.size_mm[2] : part.height_mm);
    for (const [x, y] of corners(part)) {
      min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
      min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
    }
    min[2] = Math.min(min[2], part.origin_mm[2]); max[2] = Math.max(max[2], top);
  }
  return {
    index: shape.index, name: shape.name, purpose: shape.purpose, parts: shape.parts.length, volume_m3: round(volume, 6),
    bbox_mm: { min: min.map((n) => round(n)) as P3, max: max.map((n) => round(n)) as P3 },
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** DS-yyyymmddHHMMSS-xxxx (UTC). One per create call. Stored on every shape it makes. */
export function newRunId(now: Date = new Date(), random: () => string = () => crypto.randomBytes(2).toString("hex")): string {
  return `DS-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}-${random()}`;
}

/** Twelve hex characters that change when the document, the categories or any geometry changes. The dry run returns it. */
export function planHash(document: string, categories: string[], shapes: DsShape[]): string {
  return crypto.createHash("sha256").update(JSON.stringify({ document: document.trim().toLowerCase(), categories, shapes })).digest("hex").slice(0, 12);
}

export const RUN_ID_PATTERN = /^DS-\d{14}-[0-9a-f]{4}$/;
