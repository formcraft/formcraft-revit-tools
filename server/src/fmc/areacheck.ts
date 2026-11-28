/**
 * fmc_area_check, the arithmetic and the judging. Pure: no file, no network, no Revit.
 *
 * The add-in returns facts in metres and square metres (areas, rooms and floors by level, the footprint outline, property
 * lines, named areas, Parking-category elements). This module picks the area source, computes GFA, plot area, plot coverage,
 * plot ratio, setbacks and parking, and judges them against planning values from a values file. It holds NO planning value:
 * a limit that is not in the file is "no limit configured", never a default and never a pass. Same status model as the
 * kit's standards bank: provisional never passes; draft or approved passes or fails only with a source and a clause.
 */

export type Result = "pass" | "fail" | "unknown";
type Pt = [number, number];

export const VALUE_KEYS = [
  "plot_coverage.max_pct", "plot_ratio.max", "setback.front_min_m", "setback.side_min_m", "setback.rear_min_m",
] as const;
export const PARKING_PREFIX = "parking.";
export const PARKING_BASES = ["per_dwelling_unit", "per_100_m2_gfa", "per_m2_gfa"] as const;
export const SCHEMA_ID = "fmc.planning_values/1";
export const USABLE_STATUSES = ["approved", "draft"];

export interface PlanningValue {
  key: string; value: number; unit: string; source: string; clause: string; status: string; basis?: string; note?: string;
}
export interface ValuesDoc {
  zone: string; jurisdiction: string; authority: string; notice: string;
  values: Record<string, PlanningValue>; problems: string[];
}

/** What the tool needs, for the report when a value is missing. */
export const NEEDED_VALUES: Array<{ key: string; unit: string; meaning: string }> = [
  { key: "plot_coverage.max_pct", unit: "%", meaning: "maximum plot (site) coverage: building footprint / plot area" },
  { key: "plot_ratio.max", unit: "ratio", meaning: "maximum plot ratio / floor area ratio: GFA / plot area" },
  { key: "setback.front_min_m", unit: "m", meaning: "minimum distance from the building to the front boundary" },
  { key: "setback.side_min_m", unit: "m", meaning: "minimum distance to each side boundary" },
  { key: "setback.rear_min_m", unit: "m", meaning: "minimum distance to the rear boundary" },
  { key: "parking.<use>", unit: "spaces per basis", meaning: "required parking for a use, with basis per_dwelling_unit, per_100_m2_gfa or per_m2_gfa (one key per use, e.g. parking.residential)" },
];

// ------------------------------------------------------------------ the values file

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** Read a planning-values document. Never throws; a bad entry is dropped and listed in problems. */
export function parseValues(raw: unknown): ValuesDoc {
  const out: ValuesDoc = { zone: "", jurisdiction: "", authority: "", notice: "", values: {}, problems: [] };
  if (!isObj(raw)) { out.problems.push("the file is not a JSON object"); return out; }
  out.zone = str(raw.zone); out.jurisdiction = str(raw.jurisdiction); out.authority = str(raw.authority); out.notice = str(raw.notice);
  if (raw.schema !== undefined && raw.schema !== SCHEMA_ID) out.problems.push(`schema is "${String(raw.schema)}", expected "${SCHEMA_ID}"`);
  if (!isObj(raw.values)) { out.problems.push('there is no "values" object'); return out; }
  for (const [key, e] of Object.entries(raw.values)) {
    const known = (VALUE_KEYS as readonly string[]).includes(key) || (key.startsWith(PARKING_PREFIX) && key.length > PARKING_PREFIX.length);
    if (!known) { out.problems.push(`${key}: not a key this tool uses (ignored)`); continue; }
    if (!isObj(e)) { out.problems.push(`${key}: not an object (ignored)`); continue; }
    if (typeof e.value !== "number" || !Number.isFinite(e.value) || e.value < 0) { out.problems.push(`${key}: value must be a number of 0 or more (ignored)`); continue; }
    const entry: PlanningValue = { key, value: e.value, unit: str(e.unit), source: str(e.source), clause: str(e.clause), status: str(e.status).toLowerCase() };
    if (typeof e.note === "string") entry.note = e.note;
    if (key.startsWith(PARKING_PREFIX)) {
      const basis = str(e.basis);
      if (!(PARKING_BASES as readonly string[]).includes(basis)) { out.problems.push(`${key}: basis must be one of ${PARKING_BASES.join(", ")} (ignored)`); continue; }
      entry.basis = basis;
    }
    out.values[key] = entry;
  }
  return out;
}

/** May this value decide pass or fail? Provisional never; draft or approved only with a source and a clause. */
export function usable(e: PlanningValue): { ok: boolean; why: string } {
  if (!e.status) return { ok: false, why: "the value has no status (it needs approved or draft)" };
  if (e.status === "provisional") return { ok: false, why: "the value is provisional: a provisional value never passes or fails" };
  if (!USABLE_STATUSES.includes(e.status)) return { ok: false, why: `the status "${e.status}" is not approved or draft` };
  if (!e.source) return { ok: false, why: "the value has no source" };
  if (!e.clause) return { ok: false, why: "the value has no clause" };
  return { ok: true, why: "" };
}

export interface LimitInfo { key: string; kind: "max" | "min"; value: number; unit: string; source: string; clause: string; status: string; basis?: string }
export interface Judged { result: Result; reason: string; limit: LimitInfo | null; limit_status: "ok" | "no_limit_configured" | "not_usable" | "no_value" }

const limitOf = (e: PlanningValue, kind: "max" | "min", value = e.value): LimitInfo =>
  ({ key: e.key, kind, value, unit: e.unit, source: e.source, clause: e.clause, status: e.status, ...(e.basis ? { basis: e.basis } : {}) });

/** value against a max or a min limit. Missing limit: unknown, "no limit configured". */
export function judge(value: number | null, entry: PlanningValue | undefined, kind: "max" | "min", limitValue?: number, why = ""): Judged {
  if (!entry) return { result: "unknown", reason: `no limit configured${why ? ` (${why})` : ""}`, limit: null, limit_status: "no_limit_configured" };
  const limit = limitOf(entry, kind, limitValue ?? entry.value);
  const u = usable(entry);
  if (!u.ok) return { result: "unknown", reason: u.why, limit, limit_status: "not_usable" };
  if (value === null || !Number.isFinite(value)) return { result: "unknown", reason: why || "the value could not be computed", limit, limit_status: "no_value" };
  const ok = kind === "max" ? value <= limit.value + 1e-9 : value >= limit.value - 1e-9;
  return { result: ok ? "pass" : "fail", reason: `${round(value)} ${kind === "max" ? "<=" : ">="} ${round(limit.value)} is ${ok ? "within" : "outside"} the ${kind === "max" ? "maximum" : "minimum"}`, limit, limit_status: "ok" };
}

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ------------------------------------------------------------------ geometry (plan, metres)

export function polygonArea(points: Pt[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) { const [x1, y1] = points[i]; const [x2, y2] = points[(i + 1) % points.length]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2;
}

function pointSegDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Smallest distance between two segments; 0 when they cross. */
export function segDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(pointSegDist(a, c, d), pointSegDist(b, c, d), pointSegDist(c, a, b), pointSegDist(d, a, b));
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface Line { n: number; element_id: string; curved: boolean; points: Pt[] }

const near = (a: Pt, b: Pt, tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

/** Join property-line curves end to end. Closed loops come back as point lists; curves that join nothing are counted. */
export function chainLines(lines: Line[], tol = 0.02): { loops: Pt[][]; members: number[][]; open: number[] } {
  const used = new Set<number>();
  const loops: Pt[][] = []; const members: number[][] = []; const open: number[] = [];
  for (const start of lines) {
    if (used.has(start.n) || start.points.length < 2) continue;
    used.add(start.n);
    let pts: Pt[] = [...start.points];
    const ids = [start.n];
    let grew = true;
    while (grew && !near(pts[0], pts[pts.length - 1], tol)) {
      grew = false;
      const end = pts[pts.length - 1];
      for (const l of lines) {
        if (used.has(l.n) || l.points.length < 2) continue;
        const first = l.points[0], last = l.points[l.points.length - 1];
        if (near(end, first, tol)) { pts = pts.concat(l.points.slice(1)); }
        else if (near(end, last, tol)) { pts = pts.concat([...l.points].reverse().slice(1)); }
        else continue;
        used.add(l.n); ids.push(l.n); grew = true; break;
      }
    }
    if (pts.length >= 4 && near(pts[0], pts[pts.length - 1], tol)) { loops.push(pts.slice(0, -1)); members.push(ids); }
    else open.push(...ids);
  }
  return { loops, members, open };
}

/** min distance from the footprint outline (all loops) to each property-line curve. */
export function lineDistances(footprint: Pt[][], lines: Line[]): Array<{ n: number; element_id: string; curved: boolean; min_distance_m: number }> {
  return lines.map((l) => {
    let best = Infinity;
    for (const loop of footprint) for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      for (let k = 0; k + 1 < l.points.length; k++) best = Math.min(best, segDist(a, b, l.points[k], l.points[k + 1]));
    }
    return { n: l.n, element_id: l.element_id, curved: l.curved, min_distance_m: round(best, 3) };
  });
}

// ------------------------------------------------------------------ facts

export interface LevelRow { level: string; level_id: string; elevation_m: number | null; area_m2: number; count: number; element_ids: string[]; ids_truncated?: boolean }
export interface Footprint { found: boolean; level?: string; area_m2?: number; loops?: Array<{ element_id: string; points: Pt[] }>; outline_truncated?: boolean; outline_problem?: string; problem?: string }
export interface SourceFacts {
  available: boolean; problem?: string; scheme?: string; levels?: LevelRow[]; total_m2?: number; count?: number;
  skipped_count?: number; skipped_ids?: string[]; footprint?: Footprint;
}
export interface Facts {
  document?: string; area_schemes?: string[];
  sources: { areas?: SourceFacts; rooms?: SourceFacts; floors?: SourceFacts };
  named_areas?: Array<{ id: string; name: string; scheme: string; level: string; placed: boolean; area_m2: number }>;
  property_lines?: { elements?: Array<{ id: string; name: string; curves: number }>; lines?: Line[]; truncated?: boolean };
  parking?: { count: number; by_type?: Array<{ type: string; count: number }>; element_ids?: string[]; ids_truncated?: boolean };
}

export interface CheckArgs {
  source: "auto" | "areas" | "rooms" | "floors";
  use: string; units?: number; parking_provided?: number;
  plot_area_m2?: number; plot_area_name: string; footprint_area_m2?: number;
  front_segments: number[]; side_segments: number[]; rear_segments: number[];
  zone: string;
}

export interface Check {
  check: string; title: string; value: number | string | null; unit: string;
  limit: LimitInfo | null; limit_status: string; result: Result; reason: string;
  evidence: Record<string, unknown>; assumptions: string[];
}

const SOURCE_ORDER = ["areas", "rooms", "floors"] as const;
type SourceName = (typeof SOURCE_ORDER)[number];

const SOURCE_NOTE: Record<SourceName, string> = {
  areas: "Gross areas from Area elements in the chosen area scheme; areas that are not placed or not enclosed have no area and are left out.",
  rooms: "NET room areas: wall thicknesses and spaces without a room are not counted, so this understates GFA. Used only because there are no areas.",
  floors: "The sum of Floor elements' computed areas: includes any floor (balconies, external slabs, plant decks) and is not a gross-area scheme. Used only because there are no areas or rooms.",
};

export function chooseSource(facts: Facts, pref: CheckArgs["source"]): { used: SourceName | null; why: string[]; problem: string } {
  const why: string[] = [];
  const get = (s: SourceName) => facts.sources[s];
  if (pref !== "auto") {
    const f = get(pref);
    if (f?.available) return { used: pref, why: [`${pref} was asked for`], problem: "" };
    return { used: null, why, problem: `The source ${pref} was asked for but has no data${f?.problem ? `: ${f.problem}` : ""}` };
  }
  for (const s of SOURCE_ORDER) {
    const f = get(s);
    if (f?.available) return { used: s, why: [...why, `${s} is the first source with data (order: areas, rooms, floors)`], problem: "" };
    why.push(`${s}: ${f?.problem ?? "no data"}`);
  }
  return { used: null, why, problem: "The model has no areas, rooms or floors with an area." };
}

const checkOf = (c: Partial<Check> & { check: string; title: string }): Check => ({
  value: null, unit: "", limit: null, limit_status: "no_limit_configured", result: "unknown", reason: "", evidence: {}, assumptions: [], ...c,
});

function noLimit(check: string, title: string, value: number | null, unit: string, reason: string, evidence: Record<string, unknown>, assumptions: string[]): Check {
  return checkOf({ check, title, value, unit, limit: null, limit_status: "no_limit_configured", result: "unknown", reason, evidence, assumptions });
}

// ------------------------------------------------------------------ the checks

export interface Report { source: { used: SourceName | null; why: string[]; problem: string }; checks: Check[]; plot: { area_m2: number | null; from: string }; classification: Record<string, unknown> }

export function buildChecks(facts: Facts, args: CheckArgs, values: Record<string, PlanningValue>): Report {
  const checks: Check[] = [];
  const src = chooseSource(facts, args.source);
  const sf = src.used ? facts.sources[src.used] : undefined;

  // --- GFA
  let gfa: number | null = null;
  if (sf && src.used) {
    gfa = sf.total_m2 ?? null;
    const skipped = sf.skipped_count ?? 0;
    checks.push(noLimit("gfa", "Gross floor area", gfa === null ? null : round(gfa), "m2", "GFA has no limit of its own here: it feeds plot ratio and parking",
      {
        source: src.used, scheme: sf.scheme ?? null, why_this_source: src.why, levels: sf.levels ?? [], element_count: sf.count ?? 0,
        skipped_without_area: skipped, skipped_ids: sf.skipped_ids ?? [],
        other_sources: Object.fromEntries(SOURCE_ORDER.filter((s) => s !== src.used).map((s) => [s, facts.sources[s]?.available ? { total_m2: facts.sources[s]!.total_m2 } : { available: false, problem: facts.sources[s]?.problem ?? "no data" }])),
      },
      [SOURCE_NOTE[src.used], ...(skipped ? [`${skipped} element(s) have no area (not placed or not enclosed) and are not counted.`] : []), "Design options and phases are not separated: every element in the model is counted."]));
  } else {
    checks.push(noLimit("gfa", "Gross floor area", null, "m2", src.problem, { why_this_source: src.why, area_schemes: facts.area_schemes ?? [] }, []));
  }

  // --- plot area
  const plotPlan = plotArea(facts, args);
  checks.push(noLimit("plot_area", "Plot area", plotPlan.area === null ? null : round(plotPlan.area), "m2",
    plotPlan.area === null ? plotPlan.problem : "the plot area has no limit of its own: it is the divisor for coverage and plot ratio",
    plotPlan.evidence, plotPlan.assumptions));

  // --- coverage
  const footprint = footprintOf(facts, src.used, args);
  const coverageEntry = values["plot_coverage.max_pct"];
  if (footprint.area !== null && plotPlan.area) {
    const pct = (footprint.area / plotPlan.area) * 100;
    const j = judge(pct, coverageEntry, "max");
    checks.push(checkOf({ check: "plot_coverage", title: "Plot coverage (footprint / plot area)", value: round(pct), unit: "%", ...j,
      evidence: { footprint_area_m2: round(footprint.area), footprint_from: footprint.from, footprint_level: footprint.level, plot_area_m2: round(plotPlan.area), plot_area_from: plotPlan.from, footprint_element_ids: footprint.ids },
      assumptions: [...footprint.assumptions, ...plotPlan.assumptions] }));
  } else {
    const j = judge(null, coverageEntry, "max", undefined, footprint.area === null ? footprint.problem : plotPlan.problem || "the plot area is missing");
    checks.push(checkOf({ check: "plot_coverage", title: "Plot coverage (footprint / plot area)", value: null, unit: "%", ...j, evidence: { footprint_from: footprint.from, plot_area_from: plotPlan.from }, assumptions: footprint.assumptions }));
  }

  // --- plot ratio
  const ratioEntry = values["plot_ratio.max"];
  if (gfa !== null && plotPlan.area) {
    const ratio = gfa / plotPlan.area;
    const j = judge(ratio, ratioEntry, "max");
    checks.push(checkOf({ check: "plot_ratio", title: "Plot ratio / FAR (GFA / plot area)", value: round(ratio, 3), unit: "ratio", ...j,
      evidence: { gfa_m2: round(gfa), gfa_source: src.used, plot_area_m2: round(plotPlan.area), plot_area_from: plotPlan.from },
      assumptions: [...(src.used ? [SOURCE_NOTE[src.used]] : []), ...plotPlan.assumptions] }));
  } else {
    const j = judge(null, ratioEntry, "max", undefined, gfa === null ? "GFA could not be computed" : plotPlan.problem || "the plot area is missing");
    checks.push(checkOf({ check: "plot_ratio", title: "Plot ratio / FAR (GFA / plot area)", value: null, unit: "ratio", ...j, evidence: {}, assumptions: [] }));
  }

  // --- setbacks
  const classification: Record<string, unknown> = {};
  checks.push(...setbackChecks(facts, args, values, footprint, plotPlan, classification));

  // --- parking
  checks.push(parkingCheck(facts, args, values, gfa, src.used));

  return { source: src, checks, plot: { area_m2: plotPlan.area, from: plotPlan.from }, classification };
}

interface PlotPlan { area: number | null; from: string; problem: string; evidence: Record<string, unknown>; assumptions: string[]; loop: Pt[] | null }

function plotArea(facts: Facts, args: CheckArgs): PlotPlan {
  const assumptions: string[] = [];
  const evidence: Record<string, unknown> = {};
  const lines = facts.property_lines?.lines ?? [];
  const chained = lines.length ? chainLines(lines) : { loops: [] as Pt[][], members: [] as number[][], open: [] as number[] };
  const lineArea = chained.loops.length === 1 && chained.open.length === 0 && !facts.property_lines?.truncated ? polygonArea(chained.loops[0]) : null;
  const named = (facts.named_areas ?? []).filter((a) => a.placed && a.area_m2 > 0);
  evidence.property_line_elements = (facts.property_lines?.elements ?? []).map((e) => e.id);
  if (lines.length) evidence.property_line_loops = { closed: chained.loops.length, curves_not_joined: chained.open, truncated: !!facts.property_lines?.truncated };
  if (lineArea !== null) evidence.property_line_area_m2 = round(lineArea);
  const loop = chained.loops.length === 1 && chained.open.length === 0 ? chained.loops[0] : null;
  const arcs = lines.some((l) => l.curved);
  if (arcs) assumptions.push("A curved property line is measured as straight pieces (tessellated), so its area and distances are approximate.");

  if (args.plot_area_m2 !== undefined) {
    evidence.input_m2 = args.plot_area_m2;
    if (lineArea !== null && Math.abs(lineArea - args.plot_area_m2) > 0.01 * args.plot_area_m2) assumptions.push(`The input plot area (${round(args.plot_area_m2)} m2) differs from the property-line area (${round(lineArea)} m2) by more than 1%; the input was used.`);
    assumptions.push("Plot area is the input value, as given (not checked against a title or survey).");
    return { area: args.plot_area_m2, from: "input", problem: "", evidence, assumptions, loop };
  }
  if (args.plot_area_name) {
    evidence.named_areas = (facts.named_areas ?? []).map((a) => ({ id: a.id, scheme: a.scheme, level: a.level, placed: a.placed, area_m2: a.area_m2 }));
    if (named.length === 1) {
      assumptions.push(`Plot area is the area named "${args.plot_area_name}" (${named[0].scheme} scheme, level ${named[0].level}).`);
      if (lineArea !== null && Math.abs(lineArea - named[0].area_m2) > 0.01 * named[0].area_m2) assumptions.push(`It differs from the property-line area (${round(lineArea)} m2) by more than 1%.`);
      return { area: named[0].area_m2, from: "named_area", problem: "", evidence, assumptions, loop };
    }
    return { area: null, from: "named_area", problem: named.length === 0 ? `No placed area named "${args.plot_area_name}" with an area` : `${named.length} placed areas are named "${args.plot_area_name}": use a unique name or pass plot_area_m2`, evidence, assumptions, loop };
  }
  if (lines.length) {
    if (lineArea !== null) {
      assumptions.push("Plot area is the area enclosed by the property line(s), measured in plan (not the surveyed or titled area).");
      return { area: lineArea, from: "property_line", problem: "", evidence, assumptions, loop };
    }
    const why = facts.property_lines?.truncated ? "the property-line outline was too large to return" : chained.loops.length > 1 ? `${chained.loops.length} closed loops were found: pass property_line_ids for the plot, or plot_area_m2` : `the property-line curves do not close into one loop (${chained.open.length} curve(s) are left open)`;
    return { area: null, from: "property_line", problem: `Plot area from the property line: ${why}`, evidence, assumptions, loop: null };
  }
  return { area: null, from: "none", problem: "No plot area: the model has no Property Line, and no plot_area_m2 or plot_area_name was given", evidence, assumptions, loop: null };
}

interface FootprintPlan { area: number | null; from: string; level: string; ids: string[]; loops: Pt[][]; problem: string; assumptions: string[]; outlineProblem: string }

function footprintOf(facts: Facts, used: SourceName | null, args: CheckArgs): FootprintPlan {
  const base: FootprintPlan = { area: null, from: "none", level: "", ids: [], loops: [], problem: "", assumptions: [], outlineProblem: "" };
  const fp = used ? facts.sources[used]?.footprint : undefined;
  if (fp?.found) {
    base.level = fp.level ?? "";
    base.ids = [...new Set((fp.loops ?? []).map((l) => l.element_id))];
    base.loops = (fp.loops ?? []).map((l) => l.points);
    if (fp.outline_truncated) base.outlineProblem = "the footprint outline was too large to return";
    else if (!base.loops.length) base.outlineProblem = fp.outline_problem || "no outline could be read from the footprint level";
  }
  if (args.footprint_area_m2 !== undefined) {
    return { ...base, area: args.footprint_area_m2, from: "input", assumptions: ["Footprint area is the input value, as given. Setbacks still use the outline from the model."] };
  }
  if (!used) return { ...base, problem: "there is no area source to take a footprint from (pass footprint_area_m2)" };
  if (!fp?.found) return { ...base, problem: fp?.problem ?? "the footprint level could not be found (pass footprint_level or footprint_area_m2)" };
  return {
    ...base, area: fp.area_m2 ?? null, from: used,
    assumptions: [
      `Footprint = the ${used} area on the level "${fp.level}"(${fp.area_m2 === undefined ? "?" : round(fp.area_m2)} m2). Without footprint_level this is the lowest level that has any ${used}: if that is a basement, or the building overhangs, pass footprint_level or footprint_area_m2.`,
      "Covered balconies, canopies and overhangs above the footprint level are not added; basements and plinths below it are not subtracted.",
    ],
  };
}

function setbackChecks(facts: Facts, args: CheckArgs, values: Record<string, PlanningValue>, footprint: FootprintPlan, plot: PlotPlan, classification: Record<string, unknown>): Check[] {
  const lines = facts.property_lines?.lines ?? [];
  const parts: Array<["front" | "side" | "rear", string]> = [["front", "setback.front_min_m"], ["side", "setback.side_min_m"], ["rear", "setback.rear_min_m"]];
  const pre = (reason: string): Check[] => parts.map(([name, key]) => {
    const j = judge(null, values[key], "min", undefined, reason);
    return checkOf({ check: `setback_${name}`, title: `Setback: ${name}`, value: null, unit: "m", ...j, evidence: {}, assumptions: [] });
  });
  if (!lines.length) return pre("the model has no Property Line, so there is no boundary to measure to");
  if (footprint.loops.length === 0) return pre(footprint.outlineProblem || footprint.problem || "no footprint outline");
  const dists = lineDistances(footprint.loops, lines);
  const assumptions = [...footprint.assumptions.filter((a) => a.startsWith("Footprint =")), "Distances are in plan, from the footprint outline (the finish boundary of the areas/rooms or the floor edge) to the property-line curve, ignoring levels and heights.", ...(lines.some((l) => l.curved) ? ["Curved property lines are measured as straight pieces."] : [])];
  const outside = plot.loop ? footprint.loops.flat().filter((p) => !pointInPolygon(p, plot.loop!)).length : null;
  if (outside && outside > 0) assumptions.push(`${outside} footprint outline point(s) lie outside the plot polygon: the footprint crosses or lies beyond the boundary.`);

  const cls = classify(lines, args);
  Object.assign(classification, { ...cls });
  const out: Check[] = [];
  for (const [name, key] of parts) {
    const ns = (cls as Record<string, unknown>)[name] as number[];
    const mine = dists.filter((d) => ns.includes(d.n));
    const base = { evidence_all_lines: dists };
    if (mine.length === 0) {
      const j = judge(null, values[key], "min", undefined, `the ${name} boundary is not identified: ${cls.note}`);
      out.push(checkOf({ check: `setback_${name}`, title: `Setback: ${name}`, value: null, unit: "m", ...j, evidence: { lines: dists, ...base }, assumptions }));
      continue;
    }
    const min = Math.min(...mine.map((d) => d.min_distance_m));
    const j = judge(min, values[key], "min");
    out.push(checkOf({ check: `setback_${name}`, title: `Setback: ${name}`, value: round(min, 3), unit: "m", ...j,
      evidence: { boundary_segments: ns, boundary_element_ids: [...new Set(mine.map((d) => d.element_id))], per_segment_m: mine, classified_by: cls.inferred ? "inferred" : "input" },
      assumptions: [...assumptions, ...(cls.inferred ? [cls.note] : [])] }));
  }
  const overall = Math.min(...dists.map((d) => d.min_distance_m));
  out.push(noLimit("setback_overall", "Setback: nearest boundary (any segment)", round(overall, 3), "m",
    "no limit applies to the nearest boundary as such; the front, side and rear checks carry the limits",
    { per_segment_m: dists, segments_numbered_by: "n (the order the property-line curves were read); pass front_segments, side_segments, rear_segments with these numbers", footprint_points_outside_plot: outside },
    assumptions));
  return out;
}

/** Front/side/rear segment numbers: as given; with only front given on a four-sided plot, rear is the opposite side and the other two are sides. */
export function classify(lines: Line[], args: Pick<CheckArgs, "front_segments" | "side_segments" | "rear_segments">): { front: number[]; side: number[]; rear: number[]; inferred: boolean; note: string } {
  const known = new Set(lines.map((l) => l.n));
  const clean = (a: number[]) => a.filter((n) => known.has(n));
  let front = clean(args.front_segments), side = clean(args.side_segments), rear = clean(args.rear_segments);
  const ignored = [...args.front_segments, ...args.side_segments, ...args.rear_segments].filter((n) => !known.has(n));
  const bad = ignored.length ? ` Segment numbers not found: ${ignored.join(", ")}.` : "";
  if (front.length && (side.length || rear.length)) return { front, side, rear, inferred: false, note: `classified by input.${bad}` };
  if (front.length && !side.length && !rear.length) {
    const chained = chainLines(lines);
    if (chained.loops.length === 1 && chained.open.length === 0 && lines.length === 4 && lines.every((l) => !l.curved && l.points.length === 2) && front.length === 1) {
      const f = lines.find((l) => l.n === front[0])!;
      const touches = (a: Line, b: Line) => a.points.some((p) => b.points.some((q) => near(p as Pt, q as Pt, 0.02)));
      const others = lines.filter((l) => l.n !== f.n);
      const opposite = others.filter((l) => !touches(l, f));
      if (opposite.length === 1) {
        rear = [opposite[0].n]; side = others.filter((l) => l.n !== opposite[0].n).map((l) => l.n);
        return { front, side, rear, inferred: true, note: `Rear and sides are INFERRED: the plot has four straight sides; the side opposite front segment ${front[0]} is taken as rear and the two adjoining sides as sides.${bad}` };
      }
    }
    return { front, side: [], rear: [], inferred: false, note: `only the front is given and the plot is not a four-sided figure of four straight segments, so side and rear cannot be inferred (pass side_segments and rear_segments).${bad}` };
  }
  if (!front.length && (side.length || rear.length)) return { front, side, rear, inferred: false, note: `front_segments is not given.${bad}` };
  return { front: [], side: [], rear: [], inferred: false, note: `no segments were classified: pass front_segments (and side_segments, rear_segments) using the segment numbers in setback_overall.${bad}` };
}

function parkingCheck(facts: Facts, args: CheckArgs, values: Record<string, PlanningValue>, gfa: number | null, used: SourceName | null): Check {
  const useKey = args.use.trim().toLowerCase();
  const available = Object.keys(values).filter((k) => k.startsWith(PARKING_PREFIX)).map((k) => k.slice(PARKING_PREFIX.length));
  const modelCount = facts.parking?.count ?? 0;
  const provided = args.parking_provided ?? modelCount;
  const providedFrom = args.parking_provided !== undefined ? "input" : "model (Parking category elements)";
  const evidence: Record<string, unknown> = {
    provided, provided_from: providedFrom, model_parking_count: modelCount, by_type: facts.parking?.by_type ?? [],
    element_ids: facts.parking?.element_ids ?? [], ids_truncated: !!facts.parking?.ids_truncated, use: useKey || null, uses_with_values: available,
  };
  const assumptions = ["Each Parking-category element is counted as one space (a family that holds several bays, or a bay drawn in a different category, is miscounted). Accessible, loading and visitor bays are not separated."];
  const mk = (j: Judged, value: number | null, extra: Record<string, unknown> = {}) =>
    checkOf({ check: "parking", title: "Parking (provided against required)", value, unit: "spaces", ...j, evidence: { ...evidence, ...extra }, assumptions });
  if (!useKey) return mk({ result: "unknown", reason: "no use was given, so the required parking cannot be looked up (pass use)", limit: null, limit_status: "no_value" }, provided);
  const entry = values[PARKING_PREFIX + useKey];
  if (!entry) return mk({ result: "unknown", reason: `no limit configured for parking for the use "${useKey}"`, limit: null, limit_status: "no_limit_configured" }, provided);
  let base: number | null = null; let baseName = "";
  if (entry.basis === "per_dwelling_unit") { base = args.units ?? null; baseName = "dwelling units (units)"; }
  else if (entry.basis === "per_100_m2_gfa") { base = gfa === null ? null : gfa / 100; baseName = "GFA / 100 m2"; }
  else if (entry.basis === "per_m2_gfa") { base = gfa; baseName = "GFA m2"; }
  if (base === null) return mk({ result: "unknown", reason: `the required parking is ${entry.value} ${entry.basis}, but ${baseName} is not known (${entry.basis === "per_dwelling_unit" ? "pass units" : "GFA could not be computed"})`, limit: limitOf(entry, "min"), limit_status: "no_value" }, provided);
  const required = Math.ceil(entry.value * base - 1e-9);
  assumptions.push(`Required = ${entry.value} ${entry.basis} x ${round(base, 3)} ${baseName}, rounded UP to a whole space (${required}).${used && entry.basis !== "per_dwelling_unit" ? ` GFA is from ${used}.` : ""}`);
  const j = judge(provided, entry, "min", required);
  return mk(j, provided, { required, rate: entry.value, basis: entry.basis, base: round(base, 3) });
}

export function summarize(checks: Check[]) {
  const s = { pass: 0, fail: 0, unknown: 0 };
  for (const c of checks) s[c.result] += 1;
  return s;
}
