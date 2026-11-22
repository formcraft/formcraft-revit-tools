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
  fields: Array<{ key: string; value: number; provisional: boolean; clause: string }>;
}

function limit(key: string, fallback: number, bank?: Record<string, TraceBankEntry>, override?: number) {
  if (typeof override === "number" && Number.isFinite(override)) return { key, value: override, provisional: false, clause: "Passed on this call." };
  const cited = citeLimit(key, bank);
  if (cited.value == null || cited.source !== "standards") {
    return { key, value: cited.value ?? fallback, provisional: true, clause: cited.value == null ? `PROVISIONAL default ${fallback}. ${cited.clause}` : `PROVISIONAL. ${cited.clause}` };
  }
  return { key, value: cited.value, provisional: false, clause: cited.clause };
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
    const alignment = alignmentOf(candidate.a.direction, candidate.b.direction, limits.direction_deg);
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
