/**
 * BS 8666 bar bending schedule maths, cover checks and bar spacing checks for fmc_rebar_schedule.
 * Pure functions: no Revit API, no file system, no transaction. The add-in only reads facts from the model.
 *
 * Unit masses are BS 8666:2020 Table 1. Minimum scheduling radii are BS 8666:2020 Table 2 (B500B, B500C).
 * Shape-code lengths are the "total length of bar (L) measured along the centre line" column of BS 8666:2020 Table 3,
 * where r is the minimum scheduling radius, d the nominal diameter and R a specified radius (shape 12).
 * Every scheduled length is also compared with Revit's own bar length, so a transcription slip shows up as a delta.
 */

export const BS8666_EDITION = "BS 8666:2020";

/** kg per metre, BS 8666 Table 1. */
export const BS8666_UNIT_MASS_KG_M: Readonly<Record<number, number>> = {
  6: 0.222, 8: 0.395, 10: 0.617, 12: 0.888, 16: 1.579, 20: 2.466, 25: 3.854, 32: 6.313, 40: 9.864, 50: 15.413,
};

/** Minimum scheduling radius r in mm, BS 8666 Table 2. */
export const BS8666_MIN_RADIUS_MM: Readonly<Record<number, number>> = {
  6: 12, 8: 16, 10: 20, 12: 24, 16: 32, 20: 70, 25: 87, 32: 112, 40: 140, 50: 175,
};

export const PREFERRED_SIZES = Object.keys(BS8666_UNIT_MASS_KG_M).map(Number);

export interface ShapeDims {
  A?: number | null; B?: number | null; C?: number | null; D?: number | null; E?: number | null; F?: number | null; R?: number | null;
}

type Dim = keyof ShapeDims;

interface ShapeRule {
  needs: Dim[];
  formula: string;
  length: (v: Required<Record<Dim, number>>, d: number, r: number) => number;
}

const SHAPES: Record<string, ShapeRule> = {
  "00": { needs: ["A"], formula: "A", length: (v) => v.A },
  "01": { needs: ["A"], formula: "A", length: (v) => v.A },
  "11": { needs: ["A", "B"], formula: "A + B - 0.5r - d", length: (v, d, r) => v.A + v.B - 0.5 * r - d },
  "12": { needs: ["A", "B", "R"], formula: "A + B - 0.43R - 1.2d", length: (v, d) => v.A + v.B - 0.43 * v.R - 1.2 * d },
  "13": { needs: ["A", "B", "C"], formula: "A + 0.57B + C - 1.6d", length: (v, d) => v.A + 0.57 * v.B + v.C - 1.6 * d },
  "14": { needs: ["A", "C"], formula: "A + C - 4d", length: (v, d) => v.A + v.C - 4 * d },
  "15": { needs: ["A", "C"], formula: "A + C", length: (v) => v.A + v.C },
  "21": { needs: ["A", "B", "C"], formula: "A + B + C - r - 2d", length: (v, d, r) => v.A + v.B + v.C - r - 2 * d },
  "22": { needs: ["A", "B", "C", "D"], formula: "A + B + C + D - 1.5r - 3d", length: (v, d, r) => v.A + v.B + v.C + v.D - 1.5 * r - 3 * d },
  "23": { needs: ["A", "B", "C"], formula: "A + B + C - r - 2d", length: (v, d, r) => v.A + v.B + v.C - r - 2 * d },
  "24": { needs: ["A", "B", "C"], formula: "A + B + C", length: (v) => v.A + v.B + v.C },
  "25": { needs: ["A", "B", "E"], formula: "A + B + E", length: (v) => v.A + v.B + v.E },
  "26": { needs: ["A", "B", "C"], formula: "A + B + C", length: (v) => v.A + v.B + v.C },
  "27": { needs: ["A", "B", "C"], formula: "A + B + C - 0.5r - d", length: (v, d, r) => v.A + v.B + v.C - 0.5 * r - d },
  "28": { needs: ["A", "B", "C"], formula: "A + B + C - 0.5r - d", length: (v, d, r) => v.A + v.B + v.C - 0.5 * r - d },
  "29": { needs: ["A", "B", "C"], formula: "A + B + C - r - 2d", length: (v, d, r) => v.A + v.B + v.C - r - 2 * d },
  "31": { needs: ["A", "B", "C", "D"], formula: "A + B + C + D - 1.5r - 3d", length: (v, d, r) => v.A + v.B + v.C + v.D - 1.5 * r - 3 * d },
  "32": { needs: ["A", "B", "C", "D"], formula: "A + B + C + D - 1.5r - 3d", length: (v, d, r) => v.A + v.B + v.C + v.D - 1.5 * r - 3 * d },
  "33": { needs: ["A", "B", "C"], formula: "2A + 1.7B + 2(C - 4d)", length: (v, d) => 2 * v.A + 1.7 * v.B + 2 * (v.C - 4 * d) },
  "34": { needs: ["A", "B", "C", "E"], formula: "A + B + C + E - 0.5r - d", length: (v, d, r) => v.A + v.B + v.C + v.E - 0.5 * r - d },
  "35": { needs: ["A", "B", "C", "E"], formula: "A + B + C + E - 0.5r - d", length: (v, d, r) => v.A + v.B + v.C + v.E - 0.5 * r - d },
  "36": { needs: ["A", "B", "C", "D"], formula: "A + B + C + D - r - 2d", length: (v, d, r) => v.A + v.B + v.C + v.D - r - 2 * d },
  "41": { needs: ["A", "B", "C", "D", "E"], formula: "A + B + C + D + E - 2r - 4d", length: (v, d, r) => v.A + v.B + v.C + v.D + v.E - 2 * r - 4 * d },
  "44": { needs: ["A", "B", "C", "D", "E"], formula: "A + B + C + D + E - 2r - 4d", length: (v, d, r) => v.A + v.B + v.C + v.D + v.E - 2 * r - 4 * d },
  "46": { needs: ["A", "B", "C", "E"], formula: "A + 2B + C + E", length: (v) => v.A + 2 * v.B + v.C + v.E },
  "47": { needs: ["A", "B", "C"], formula: "2A + B + 2C + 1.5r - 3d", length: (v, d, r) => 2 * v.A + v.B + 2 * v.C + 1.5 * r - 3 * d },
  "51": { needs: ["A", "B", "C"], formula: "2(A + B + C) - 2.5r - 5d", length: (v, d, r) => 2 * (v.A + v.B + v.C) - 2.5 * r - 5 * d },
  "52": { needs: ["A", "B", "C"], formula: "2(A + B + C) - 2.5r - 5d", length: (v, d, r) => 2 * (v.A + v.B + v.C) - 2.5 * r - 5 * d },
  "56": { needs: ["A", "B", "C", "D", "E"], formula: "A + B + C + D + 2E - 2.5r - 5d", length: (v, d, r) => v.A + v.B + v.C + v.D + 2 * v.E - 2.5 * r - 5 * d },
  "63": { needs: ["A", "B", "C"], formula: "2A + 3B + 2C - 3r - 6d", length: (v, d, r) => 2 * v.A + 3 * v.B + 2 * v.C - 3 * r - 6 * d },
  "64": { needs: ["A", "B", "C", "D", "E", "F"], formula: "A + B + C + 2D + E + F - 3r - 6d", length: (v, d, r) => v.A + v.B + v.C + 2 * v.D + v.E + v.F - 3 * r - 6 * d },
  "67": { needs: ["A"], formula: "A", length: (v) => v.A },
  "75": { needs: ["A", "B"], formula: "π(A - d) + B", length: (v, d) => Math.PI * (v.A - d) + v.B },
  "77": { needs: ["A", "C"], formula: "Cπ(A - d)", length: (v, d) => v.C * Math.PI * (v.A - d) },
  "98": { needs: ["A", "B", "C", "D"], formula: "A + 2B + C + D - 2r - 4d", length: (v, d, r) => v.A + 2 * v.B + v.C + v.D - 2 * r - 4 * d },
};

export const KNOWN_SHAPE_CODES = Object.keys(SHAPES);

/** "M_21", "BS8666 - 21", "21" and "Shape 21" all give "21". Anything else is "" (shape 99 / not a BS 8666 code). */
export function shapeCodeOf(name: string | null | undefined): string {
  const text = String(name ?? "").trim();
  if (!text) return "";
  const exact = text.match(/^(?:[A-Za-z]+[_\s-]*)?(\d{2})(?:[A-Za-z]?)$/);
  if (exact) return exact[1];
  const loose = text.match(/(?:^|[^0-9])(\d{2})(?:[^0-9]|$)/);
  return loose ? loose[1] : "";
}

export function unitMassKgPerM(diameterMm: number): { value: number; source: "BS8666 Table 1" | "formula" } {
  const d = Math.round(diameterMm);
  const table = BS8666_UNIT_MASS_KG_M[d];
  if (table !== undefined && Math.abs(d - diameterMm) < 0.05) return { value: table, source: "BS8666 Table 1" };
  // 7850 kg/m3 steel: pi d^2 / 4 x 7850 / 1e6 = 0.006165 d^2 kg/m, the basis of Table 1.
  return { value: Math.round(0.0061654 * diameterMm * diameterMm * 1000) / 1000, source: "formula" };
}

export function minRadiusMm(diameterMm: number): number {
  const d = Math.round(diameterMm);
  const table = BS8666_MIN_RADIUS_MM[d];
  if (table !== undefined) return table;
  return diameterMm <= 16 ? 2 * diameterMm : 3.5 * diameterMm;
}

export function roundUp(valueMm: number, stepMm: number): number {
  if (!(stepMm > 0)) return Math.round(valueMm);
  return Math.ceil(valueMm / stepMm - 1e-9) * stepMm;
}

export interface ShapeLength {
  code: string;
  formula: string;
  length_mm: number | null;
  missing: Dim[];
  known: boolean;
}

/** L for one bar from the shape code. null length when the code is not in the table or a dimension is missing. */
export function shapeLength(code: string, dims: ShapeDims, diameterMm: number, radiusMm?: number): ShapeLength {
  const rule = SHAPES[code];
  if (!rule) return { code, formula: "", length_mm: null, missing: [], known: false };
  const missing = rule.needs.filter((key) => typeof dims[key] !== "number" || !Number.isFinite(dims[key] as number));
  if (missing.length) return { code, formula: rule.formula, length_mm: null, missing, known: true };
  const v = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, R: 0 } as Required<Record<Dim, number>>;
  for (const key of Object.keys(v) as Dim[]) if (typeof dims[key] === "number") v[key] = dims[key] as number;
  const r = typeof radiusMm === "number" && radiusMm > 0 ? radiusMm : minRadiusMm(diameterMm);
  return { code, formula: rule.formula, length_mm: rule.length(v, diameterMm, r), missing: [], known: true };
}

/** One Rebar element (a set) as the add-in reads it. Lengths in millimetres, element ids as strings. */
export interface RebarFact {
  id: string;
  mark?: string;
  bar_type?: string;
  diameter_mm: number;
  quantity: number;
  bar_length_mm?: number | null;
  total_length_mm?: number | null;
  shape?: string;
  dims?: ShapeDims;
  layout?: string;
  spacing_mm?: number | null;
  host_id?: string;
  host_category?: string;
  host_mark?: string;
  host_type?: string;
  host_cover_mm?: { top?: number | null; bottom?: number | null; other?: number | null };
  /** Bar centre-line extents in model coordinates (mm), all bar positions. */
  centerline_min?: number[];
  centerline_max?: number[];
  /** Host bounding box (mm). */
  host_min?: number[];
  host_max?: number[];
  kind?: string;
}

export interface ScheduleRow {
  member: string;
  host_id: string;
  bar_mark: string;
  type_size: string;
  grade_letter: string;
  diameter_mm: number;
  no_of_members: number;
  no_in_each: number;
  total_no: number;
  length_mm: number;
  length_source: "shape" | "revit";
  revit_length_mm: number | null;
  length_delta_mm: number | null;
  shape_code: string;
  formula: string;
  A: number | null; B: number | null; C: number | null; D: number | null; E: number | null; R: number | null;
  unit_mass_kg_m: number;
  mass_kg: number;
  rebar_ids: string[];
  notes: string[];
}

export interface ScheduleOptions {
  /** Letter when the bar type name does not start with one (H, B, C or X). */
  grade_letter?: string;
  /** Scheduled lengths are rounded up to this step. 0 keeps the millimetre. */
  round_mm?: number;
  /** A shape length further than this from Revit's bar length is noted. */
  delta_note_mm?: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function gradeLetterOf(barType: string | undefined, fallback = "H"): string {
  const hit = String(barType ?? "").trim().match(/^([HBCXhbcx])\s*\d/);
  return hit ? hit[1].toUpperCase() : (fallback || "H").toUpperCase();
}

export function memberOf(fact: RebarFact): string {
  const parts = [fact.host_category || "", fact.host_mark || ""].map((p) => p.trim()).filter(Boolean);
  const head = parts.join(" ") || (fact.host_id ? `Host ${fact.host_id}` : "No host");
  return fact.host_type ? `${head} (${fact.host_type})` : head;
}

function dimOf(dims: ShapeDims | undefined, key: Dim): number | null {
  const v = dims?.[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/** One schedule line per bar mark per member. Sets with the same member, mark, size, shape, dims and length are merged. */
export function buildSchedule(facts: RebarFact[], options: ScheduleOptions = {}): ScheduleRow[] {
  const step = options.round_mm ?? 25;
  const tolerance = options.delta_note_mm ?? 25;
  const rows = new Map<string, ScheduleRow>();
  for (const fact of facts) {
    const d = Number(fact.diameter_mm);
    if (!(d > 0)) continue;
    const code = shapeCodeOf(fact.shape);
    const notes: string[] = [];
    const shape = code ? shapeLength(code, fact.dims ?? {}, d, typeof fact.dims?.R === "number" && code !== "12" ? (fact.dims!.R as number) : undefined) : null;
    const revit = typeof fact.bar_length_mm === "number" && Number.isFinite(fact.bar_length_mm) ? fact.bar_length_mm : null;
    let raw: number;
    let source: "shape" | "revit";
    if (shape && shape.length_mm != null && shape.length_mm > 0) { raw = shape.length_mm; source = "shape"; }
    else {
      raw = revit ?? 0; source = "revit";
      if (!code) notes.push(`Shape "${fact.shape ?? ""}" is not a BS 8666 code; shape 99 with Revit's bar length.`);
      else if (shape && !shape.known) notes.push(`Shape ${code} has no length formula here; Revit's bar length is used.`);
      else if (shape && shape.missing.length) notes.push(`Shape ${code} is missing ${shape.missing.join(", ")}; Revit's bar length is used.`);
    }
    const length = roundUp(raw, step);
    const delta = source === "shape" && revit != null ? r1(raw - revit) : null;
    if (delta != null && Math.abs(delta) > tolerance) notes.push(`Shape length differs from Revit's bar length by ${delta} mm.`);
    const letter = gradeLetterOf(fact.bar_type, options.grade_letter);
    const mass = unitMassKgPerM(d);
    if (mass.source === "formula") notes.push(`${d} mm is not a BS 8666 preferred size; mass from 0.006165 d².`);
    const quantity = Math.max(0, Math.round(Number(fact.quantity) || 0));
    const mark = (fact.mark ?? "").trim();
    if (!mark) notes.push("No bar mark.");
    const member = memberOf(fact);
    const dimsKey = (["A", "B", "C", "D", "E", "R"] as Dim[]).map((k) => dimOf(fact.dims, k) ?? "").join("|");
    const key = [member, fact.host_id ?? "", mark, letter, d, code, dimsKey, length].join("~");
    const prev = rows.get(key);
    if (prev) {
      prev.no_in_each += quantity;
      prev.total_no += quantity;
      prev.mass_kg = r3((prev.total_no * prev.length_mm * prev.unit_mass_kg_m) / 1000);
      prev.rebar_ids.push(String(fact.id));
      for (const n of notes) if (!prev.notes.includes(n)) prev.notes.push(n);
      continue;
    }
    rows.set(key, {
      member,
      host_id: fact.host_id ?? "",
      bar_mark: mark,
      type_size: `${letter}${Math.round(d)}`,
      grade_letter: letter,
      diameter_mm: d,
      no_of_members: 1,
      no_in_each: quantity,
      total_no: quantity,
      length_mm: length,
      length_source: source,
      revit_length_mm: revit == null ? null : r1(revit),
      length_delta_mm: delta,
      shape_code: code || "99",
      formula: shape?.formula ?? "",
      A: dimOf(fact.dims, "A"), B: dimOf(fact.dims, "B"), C: dimOf(fact.dims, "C"),
      D: dimOf(fact.dims, "D"), E: dimOf(fact.dims, "E"), R: dimOf(fact.dims, "R"),
      unit_mass_kg_m: mass.value,
      mass_kg: r3((quantity * length * mass.value) / 1000),
      rebar_ids: [String(fact.id)],
      notes,
    });
  }
  return [...rows.values()].sort((a, b) => a.member.localeCompare(b.member) || a.bar_mark.localeCompare(b.bar_mark, undefined, { numeric: true }));
}

export interface MassSummary {
  total_kg: number;
  by_size: Array<{ type_size: string; diameter_mm: number; bars: number; length_m: number; mass_kg: number }>;
}

export function massSummary(rows: ScheduleRow[]): MassSummary {
  const sizes = new Map<string, { type_size: string; diameter_mm: number; bars: number; length_m: number; mass_kg: number }>();
  for (const row of rows) {
    const s = sizes.get(row.type_size) ?? { type_size: row.type_size, diameter_mm: row.diameter_mm, bars: 0, length_m: 0, mass_kg: 0 };
    s.bars += row.total_no;
    s.length_m = r3(s.length_m + (row.total_no * row.length_mm) / 1000);
    s.mass_kg = r3(s.mass_kg + row.mass_kg);
    sizes.set(row.type_size, s);
  }
  const by_size = [...sizes.values()].sort((a, b) => a.diameter_mm - b.diameter_mm || a.type_size.localeCompare(b.type_size));
  return { total_kg: r3(by_size.reduce((sum, s) => sum + s.mass_kg, 0)), by_size };
}

export interface CheckFailure {
  check: "cover" | "spacing" | "mark";
  code: string;
  rebar_id: string;
  host_id: string;
  bar_mark: string;
  face?: string;
  value_mm: number | null;
  required_mm: number | null;
  detail: string;
}

/** A mark used for different sizes, shapes or lengths in one document cannot be scheduled. */
export function markConflicts(rows: ScheduleRow[]): CheckFailure[] {
  const seen = new Map<string, ScheduleRow>();
  const out: CheckFailure[] = [];
  for (const row of rows) {
    if (!row.bar_mark) continue;
    const sig = `${row.type_size}|${row.shape_code}|${row.length_mm}|${row.A}|${row.B}|${row.C}|${row.D}|${row.E}|${row.R}`;
    const first = seen.get(row.bar_mark);
    if (!first) { seen.set(row.bar_mark, row); continue; }
    const firstSig = `${first.type_size}|${first.shape_code}|${first.length_mm}|${first.A}|${first.B}|${first.C}|${first.D}|${first.E}|${first.R}`;
    if (firstSig !== sig) {
      out.push({
        check: "mark", code: "MARK_CONFLICT", rebar_id: row.rebar_ids[0], host_id: row.host_id, bar_mark: row.bar_mark,
        value_mm: null, required_mm: null,
        detail: `Mark ${row.bar_mark} is ${row.type_size} shape ${row.shape_code} ${row.length_mm} mm here and ${first.type_size} shape ${first.shape_code} ${first.length_mm} mm in ${first.member}.`,
      });
    }
  }
  return out;
}

export interface CoverOptions {
  /** A required minimum nominal cover in mm (from the call or the standards bank). */
  min_cover_mm?: number | null;
  /** Measured cover may sit this far under the requirement before it fails (bar placement, rounding). */
  tolerance_mm?: number;
}

function vec(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const n = value.slice(0, 3).map(Number);
  return n.every(Number.isFinite) ? n : null;
}

/**
 * Cover per face from the bar centre-line extents and the host box: gap minus half the bar.
 * Valid for hosts square to the project axes (beams, slabs, walls and columns on grid). The reply says so.
 */
export function measuredCover(fact: RebarFact): { top: number | null; bottom: number | null; sides: number | null } | null {
  const cmin = vec(fact.centerline_min), cmax = vec(fact.centerline_max), hmin = vec(fact.host_min), hmax = vec(fact.host_max);
  if (!cmin || !cmax || !hmin || !hmax) return null;
  const half = Number(fact.diameter_mm) / 2;
  const gap = (g: number) => (g >= -half ? r1(g - half) : null); // a bar leaving the host (starter, lap) has no cover on that face
  const sides = [cmin[0] - hmin[0], hmax[0] - cmax[0], cmin[1] - hmin[1], hmax[1] - cmax[1]].map(gap).filter((v): v is number => v != null);
  return {
    top: gap(hmax[2] - cmax[2]),
    bottom: gap(cmin[2] - hmin[2]),
    sides: sides.length ? Math.min(...sides) : null,
  };
}

export function coverChecks(facts: RebarFact[], options: CoverOptions = {}): { failures: CheckFailure[]; checked: number; unmeasured: string[] } {
  const tolerance = options.tolerance_mm ?? 2;
  const min = typeof options.min_cover_mm === "number" && options.min_cover_mm > 0 ? options.min_cover_mm : null;
  const failures: CheckFailure[] = [];
  const unmeasured: string[] = [];
  const seenHosts = new Set<string>();
  let checked = 0;
  for (const fact of facts) {
    const host = fact.host_cover_mm ?? {};
    const mark = fact.mark ?? "";
    const hostId = fact.host_id ?? "";
    if (min != null && hostId && !seenHosts.has(hostId)) {
      seenHosts.add(hostId);
      for (const face of ["top", "bottom", "other"] as const) {
        const set = host[face];
        if (typeof set === "number" && set + 1e-6 < min) {
          failures.push({
            check: "cover", code: "COVER_SETTING_BELOW_MIN", rebar_id: String(fact.id), host_id: hostId, bar_mark: mark, face,
            value_mm: r1(set), required_mm: min,
            detail: `Host ${hostId} ${face} cover setting is ${r1(set)} mm; the minimum is ${min} mm.`,
          });
        }
      }
    }
    const measured = measuredCover(fact);
    if (!measured) { unmeasured.push(String(fact.id)); continue; }
    checked++;
    const faces: Array<["top" | "bottom" | "sides", number | null, number | null | undefined]> = [
      ["top", measured.top, host.top],
      ["bottom", measured.bottom, host.bottom],
      ["sides", measured.sides, host.other],
    ];
    for (const [face, value, setting] of faces) {
      if (value == null) continue;
      const need = Math.max(min ?? 0, typeof setting === "number" ? setting : 0);
      if (need <= 0) continue;
      if (value + tolerance < need) {
        failures.push({
          check: "cover", code: "COVER_MEASURED_BELOW", rebar_id: String(fact.id), host_id: hostId, bar_mark: mark, face,
          value_mm: value, required_mm: r1(need),
          detail: `Bar set ${fact.id} (${mark || "no mark"}) has ${value} mm ${face} cover; ${r1(need)} mm is required (${min != null && min >= (setting ?? 0) ? "minimum" : "host cover setting"}).`,
        });
      }
    }
  }
  return { failures, checked, unmeasured };
}

/** Minimum clear distance between parallel bars: max(bar size, aggregate + 5 mm, 20 mm). */
export function minClearSpacingMm(diameterMm: number, aggregateMm: number): number {
  return Math.max(diameterMm, aggregateMm + 5, 20);
}

export function spacingChecks(facts: RebarFact[], aggregateMm: number): { failures: CheckFailure[]; checked: number } {
  const failures: CheckFailure[] = [];
  let checked = 0;
  for (const fact of facts) {
    const spacing = typeof fact.spacing_mm === "number" && Number.isFinite(fact.spacing_mm) ? fact.spacing_mm : null;
    if (spacing == null || spacing <= 0 || (Number(fact.quantity) || 0) < 2) continue;
    const layout = (fact.layout ?? "").toLowerCase();
    if (layout === "single") continue;
    checked++;
    const d = Number(fact.diameter_mm);
    const clear = r1(spacing - d);
    const need = minClearSpacingMm(d, aggregateMm);
    if (clear + 1e-6 < need) {
      failures.push({
        check: "spacing", code: "SPACING_BELOW_MIN", rebar_id: String(fact.id), host_id: fact.host_id ?? "", bar_mark: fact.mark ?? "",
        value_mm: clear, required_mm: need,
        detail: `Bar set ${fact.id} (${fact.mark || "no mark"}) is ${r1(spacing)} mm centres, ${clear} mm clear; max(${d}, ${aggregateMm} + 5, 20) = ${need} mm is required.`,
      });
    }
  }
  return { failures, checked };
}

export const SCHEDULE_COLUMNS = [
  "Member", "Bar mark", "Type and size", "No. of mbrs", "No. of bars in each", "Total no.", "Length of each bar (mm)",
  "Shape code", "A", "B", "C", "D", "E/R", "Mass (kg)",
];

function cell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function scheduleCsv(rows: ScheduleRow[]): string {
  const lines = [SCHEDULE_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push([
      row.member, row.bar_mark, row.type_size, row.no_of_members, row.no_in_each, row.total_no, row.length_mm,
      row.shape_code, row.A, row.B, row.C, row.D, row.E ?? row.R, row.mass_kg,
    ].map(cell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
