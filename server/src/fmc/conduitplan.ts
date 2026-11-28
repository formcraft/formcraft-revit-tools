/**
 * fmc_conduit, the part that does not need Revit.
 * Free ends are paired with the nearest end inside the tolerance. A missing standards key is PROVISIONAL.
 */
import { citeLimit, type TraceBankEntry } from "./trace_bank.js";

export interface ConduitEnd {
  element_id: number;
  index: number;
  size_mm: number;
  origin: number[];
  direction: number[];
  level?: string;
  kind?: string;
  type_id?: number;
  type_name?: string;
  connected?: boolean;
  is_direct_shape?: boolean;
}

export interface ConduitPair {
  a: ConduitEnd;
  b: ConduitEnd;
  gap_mm: number;
  alignment: "aligned" | "corner" | "offset";
  same_size: boolean;
  op: "extend" | "union" | "elbow" | "transition" | "junction" | "report";
  confidence: number;
  detail: string;
}

export interface SizeRequest {
  nominal_mm: number;
  id_mm: number;
  od_mm: number;
  bend_mm?: number;
}

export interface ConduitLimits {
  near_mm: number;
  touch_mm: number;
  size_mm: number;
  direction_deg: number;
  provisional: boolean;
  fields: Array<{ key: string; value: number; provisional: boolean; clause: string; alias_used?: string }>;
}

const CONNECTION_KEY = "trace.connection_tolerance";
const NEAR_ALIAS: Record<string, string> = { "trace.near_miss_mm": "trace.near_miss_tolerance" };

/**
 * The bank entry that holds this key but has no number yet (P-fmc_conduit-02): the key itself, its alias, or the
 * field of trace.connection_tolerance with the same name. null when the bank has no such entry at all.
 */
export function nullBankEntry(key: string, bank?: Record<string, TraceBankEntry>): string | null {
  if (!bank) return null;
  const has = (name: string) => Object.prototype.hasOwnProperty.call(bank, name);
  if (has(key)) return bank[key]?.value == null ? key : null;
  const alias = NEAR_ALIAS[key];
  if (alias && has(alias)) return bank[alias]?.value == null ? alias : null;
  if (has(CONNECTION_KEY)) {
    const value = bank[CONNECTION_KEY]?.value as unknown;
    const field = key.replace(/^trace\./, "");
    if (value == null) return CONNECTION_KEY;
    if (typeof value === "object" && !Array.isArray(value)) {
      const row = value as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(row, field) && row[field] == null) return `${CONNECTION_KEY}.${field}`;
    }
  }
  return null;
}

function limit(key: string, fallback: number, bank?: Record<string, TraceBankEntry>, override?: number) {
  if (typeof override === "number" && Number.isFinite(override)) return { key, value: override, provisional: false, clause: "Passed on this call." };
  const cited = citeLimit(key, bank);
  const alias = cited.alias_used ? { alias_used: cited.alias_used } : {};
  if (cited.value == null || cited.source !== "standards") {
    const empty = nullBankEntry(key, bank);
    const why = empty ? `The bank has ${empty} but its value is null (not set yet).` : cited.clause;
    return { key, value: cited.value ?? fallback, provisional: true, ...alias, clause: cited.value == null || empty ? `PROVISIONAL default ${cited.value ?? fallback}. ${why}` : `PROVISIONAL. ${why}` };
  }
  return { key, value: cited.value, provisional: false, ...alias, clause: cited.clause };
}

export function conduitLimits(bank?: Record<string, TraceBankEntry>, overrides: Partial<Record<"near_mm" | "touch_mm" | "size_mm" | "direction_deg", number>> = {}): ConduitLimits {
  const fields = [
    limit("trace.near_miss_mm", 50, bank, overrides.near_mm),
    limit("trace.touch_mm", 10, bank, overrides.touch_mm),
    limit("trace.size_mismatch_mm", 2, bank, overrides.size_mm),
    limit("trace.direction_deg", 15, bank, overrides.direction_deg),
  ];
  return {
    near_mm: fields[0].value,
    touch_mm: fields[1].value,
    size_mm: fields[2].value,
    direction_deg: fields[3].value,
    provisional: fields.some((field) => field.provisional),
    fields,
  };
}

function dist(a: number[], b: number[]): number {
  if (a.length < 3 || b.length < 3) return Number.POSITIVE_INFINITY;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function dot(a: number[], b: number[]): number | null {
  if (a.length < 3 || b.length < 3) return null;
  const al = Math.hypot(a[0], a[1], a[2]);
  const bl = Math.hypot(b[0], b[1], b[2]);
  if (al < 1e-9 || bl < 1e-9) return null;
  return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (al * bl);
}

export function alignmentOf(a: number[], b: number[], directionDeg: number): "aligned" | "corner" | "offset" {
  const value = dot(a, b);
  if (value == null) return "offset";
  const rad = (directionDeg * Math.PI) / 180;
  if (value <= -Math.cos(rad)) return "aligned";
  if (Math.abs(value) <= Math.sin(rad)) return "corner";
  return "offset";
}

/** Corner and aligned pairs must really meet: for a corner the two axes must (nearly) intersect at a point
 * that lies ahead of both open ends, and for an aligned pair the axes must be (nearly) collinear.
 * Anything else is an offset pair and is only reported. */
export function endsMeet(a: ConduitEnd, b: ConduitEnd, alignment: "aligned" | "corner" | "offset", tolMm: number): boolean {
  if (alignment === "offset") return false;
  const p = a.origin, q = b.origin, u = a.direction, v = b.direction;
  const ul = Math.hypot(u[0], u[1], u[2]);
  const vl = Math.hypot(v[0], v[1], v[2]);
  if (ul < 1e-9 || vl < 1e-9) return false;
  const uu = [u[0] / ul, u[1] / ul, u[2] / ul];
  const vv = [v[0] / vl, v[1] / vl, v[2] / vl];
  const w = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const dotp = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const tol = Math.max(tolMm, 1);
  if (alignment === "aligned") {
    const along = dotp(w, uu);
    const lateral = Math.hypot(w[0] - along * uu[0], w[1] - along * uu[1], w[2] - along * uu[2]);
    return lateral <= tol && along >= -tol;
  }
  const c = dotp(uu, vv);
  const den = 1 - c * c;
  if (den < 1e-9) return false;
  const wu = dotp(w, uu);
  const wv = dotp(w, vv);
  const s = (wu - c * wv) / den;
  const t = (c * wu - wv) / den;
  const pa = [p[0] + s * uu[0], p[1] + s * uu[1], p[2] + s * uu[2]];
  const pb = [q[0] + t * vv[0], q[1] + t * vv[1], q[2] + t * vv[2]];
  const skew = Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
  return skew <= tol && s >= -tol && t >= -tol;
}

function keyOf(end: ConduitEnd): string {
  return `${end.element_id}:${end.index}`;
}

export function pairEnds(ends: ConduitEnd[], limits: ConduitLimits, opts: { junction?: boolean } = {}): { pairs: ConduitPair[]; free: ConduitEnd[]; skipped: Array<{ id: number; code: string; detail: string }> } {
  const skipped: Array<{ id: number; code: string; detail: string }> = [];
  const free = ends.filter((end) => {
    if (end.is_direct_shape) {
      skipped.push({ id: end.element_id, code: "FMC-DIRECTSHAPE", detail: "DirectShape skipped." });
      return false;
    }
    return end.connected !== true && end.origin.length >= 3;
  });
  const candidates: Array<{ a: ConduitEnd; b: ConduitEnd; gap: number }> = [];
  for (let i = 0; i < free.length; i++) {
    let best: { b: ConduitEnd; gap: number } | null = null;
    for (let j = 0; j < free.length; j++) {
      if (i === j || free[i].element_id === free[j].element_id) continue;
      const gap = dist(free[i].origin, free[j].origin);
      if (gap > limits.near_mm) continue;
      if (!best || gap < best.gap) best = { b: free[j], gap };
    }
    if (best) candidates.push({ a: free[i], b: best.b, gap: best.gap });
  }
  candidates.sort((a, b) => a.gap - b.gap);
  const claimed = new Set<string>();
  const pairs: ConduitPair[] = [];
  for (const candidate of candidates) {
    const ak = keyOf(candidate.a);
    const bk = keyOf(candidate.b);
    if (claimed.has(ak) || claimed.has(bk)) continue;
    claimed.add(ak);
    claimed.add(bk);
    const axisAlignment = alignmentOf(candidate.a.direction, candidate.b.direction, limits.direction_deg);
    const alignment = endsMeet(candidate.a, candidate.b, axisAlignment, limits.touch_mm) ? axisAlignment : "offset";
    const same = candidate.a.size_mm > 0 && candidate.b.size_mm > 0 && Math.abs(candidate.a.size_mm - candidate.b.size_mm) <= limits.size_mm;
    let op: ConduitPair["op"] = "report";
    let confidence = 0.4;
    let detail = `${alignment}, ${Math.round(candidate.gap)} mm, ${same ? "same size" : "different size"}`;
    if (opts.junction && alignment !== "offset") {
      op = "junction";
      confidence = 0.6;
      detail += ". Place a junction box on the open end.";
    } else if (alignment === "aligned" && same && candidate.gap <= limits.touch_mm) {
      op = "extend";
      confidence = 0.9;
      detail += ". Extend and trim, then connect.";
    } else if (alignment === "aligned" && same) {
      op = "union";
      confidence = 0.8;
      detail += ". Insert a union.";
    } else if (alignment === "aligned" && !same) {
      op = "transition";
      confidence = 0.75;
      detail += ". Insert a transition.";
    } else if (alignment === "corner") {
      op = "elbow";
      confidence = 0.7;
      detail += ". Insert an elbow.";
    } else {
      detail += ". Offset ends are reported and not forced.";
    }
    pairs.push({ a: candidate.a, b: candidate.b, gap_mm: Math.round(candidate.gap * 10) / 10, alignment, same_size: same, op, confidence, detail });
  }
  return { pairs, free, skipped };
}

export function nearestSize(nominal: number, available: number[]): { size_mm: number; delta_mm: number } | null {
  if (!available.length || !(nominal > 0)) return null;
  const size = available.reduce((best, item) => Math.abs(item - nominal) < Math.abs(best - nominal) ? item : best);
  return { size_mm: size, delta_mm: Math.round(Math.abs(size - nominal) * 10) / 10 };
}

export function sizeComment(nominal: number, material = "PVC"): string {
  return `nominal ${nominal} mm ${material}`;
}

export function fittingCovered(sizeMm: number, table: number[], fittings: { elbow?: boolean; union?: boolean; transition?: boolean }): { in_table: boolean; fittings_set: boolean; note: string } {
  const in_table = table.some((size) => Math.abs(size - sizeMm) < 0.2);
  const fittings_set = fittings.elbow === true && fittings.union === true && fittings.transition === true;
  const note = in_table && fittings_set
    ? "The size is in the conduit size table and the type has elbow, union and transition set. Revit still resolves the fitting family at commit."
    : "A size is covered only when it is in the size table and the conduit type has the fitting set. There is no separate routing-coverage API.";
  return { in_table, fittings_set, note };
}

export const JUNCTION_FAMILY = "FMC_E_ElecFixture_JunctionBox 75x75_Galv";
