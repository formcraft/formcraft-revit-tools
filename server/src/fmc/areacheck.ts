/**
 * fmc_area_check, the arithmetic and the judging. Pure: no file, no network, no Revit.
 *
 * The add-in returns facts in metres and square metres (areas, rooms and floors by level, the footprint outline, property
 * lines, named areas, Parking-category elements). This module picks the area source, computes GFA, plot area, plot coverage,
 * plot ratio, setbacks and parking, and judges them against planning values from a values file. It holds NO planning value:
 * a limit that is not in the file is "no limit configured", a limit the caller has not chosen from the file is "no limit
 * selected", and neither is ever a default or a pass.
 *
 * The status rule is strict: only an `approved` value with a source and a clause judges. A `draft` value judges only when
 * the caller passes allow_draft (the result is then labelled as DRAFT, not approved). `unbanked`, `provisional` and a blank
 * status never judge. The default is DEFAULT_ALLOW_DRAFT below.
 */

export type Result = "pass" | "fail" | "unknown";
type Pt = [number, number];

/**
 * THE ONE SWITCH. false: only `approved` values judge, and `draft` ones judge only when the call passes allow_draft: true.
 * true: a `draft` value with a source and a clause judges by default (the kit bank's joins/coord rule). The result of a draft
 * value is labelled "DRAFT, not approved: indicative" either way.
 */
export const DEFAULT_ALLOW_DRAFT = false;

export const DRAFT_LABEL = "DRAFT, not approved: indicative";

export const QUANTITIES = ["plot_coverage", "plot_ratio", "setback_front", "setback_side", "setback_rear", "parking"] as const;
export type Quantity = (typeof QUANTITIES)[number];

/** The file's key namespace for each quantity (candidates are the keys that start with these). */
export const QUANTITY_PREFIX: Record<Quantity, string> = {
  plot_coverage: "plot_coverage.", plot_ratio: "plot_ratio.", setback_front: "setback.front", setback_side: "setback.side",
  setback_rear: "setback.rear", parking: "parking.",
};
/** The exact keys used when the caller selects nothing (the first, simple schema). */
export const DEFAULT_KEYS: Record<Exclude<Quantity, "parking">, string> = {
  plot_coverage: "plot_coverage.max_pct", plot_ratio: "plot_ratio.max",
  setback_front: "setback.front_min_m", setback_side: "setback.side_min_m", setback_rear: "setback.rear_min_m",
};
export const PARKING_PREFIX = "parking.";
export const PARKING_BASES = ["per_dwelling_unit", "per_100_m2_gfa", "per_m2_gfa", "per_plot"] as const;
export const SCHEMA_ID = "fmc.planning_values/1";
const UNIT_OK: Record<Quantity, RegExp | null> = {
  plot_coverage: /^%$|percent|per cent/i, plot_ratio: /ratio|^far$|\(far\)/i,
  setback_front: /^m$|^metres?$|^meters?$/i, setback_side: /^m$|^metres?$|^meters?$/i, setback_rear: /^m$|^metres?$|^meters?$/i, parking: null,
};

export interface PlanningValue {
  key: string;
  /** the number, or null when the file's value is text, a list or an object (shown as text, never judged) */
  value: number | null;
  text: string;
  unit: string; source: string; clause: string; status: string;
  edition: string; zone_or_use: string; legal_character: string; quote: string;
  basis?: string; note?: string;
}
export interface ValuesDoc {
  zone: string; jurisdiction: string; authority: string; notice: string;
  values: Record<string, PlanningValue>; problems: string[]; application_notes: string[];
}

/** What the tool needs, for the report when a value is missing. */
export const NEEDED_VALUES: Array<{ key: string; quantity: Quantity; unit: string; meaning: string }> = [
  { key: "plot_coverage.max_pct", quantity: "plot_coverage", unit: "%", meaning: "maximum plot (site) coverage: building footprint / plot area" },
  { key: "plot_ratio.max", quantity: "plot_ratio", unit: "ratio", meaning: "maximum plot ratio / floor area ratio: GFA / plot area" },
  { key: "setback.front_min_m", quantity: "setback_front", unit: "m", meaning: "minimum distance from the building to the front boundary" },
  { key: "setback.side_min_m", quantity: "setback_side", unit: "m", meaning: "minimum distance to each side boundary" },
  { key: "setback.rear_min_m", quantity: "setback_rear", unit: "m", meaning: "minimum distance to the rear boundary" },
  { key: "parking.<use>", quantity: "parking", unit: "spaces per basis", meaning: "required parking for a use, with a basis (per_dwelling_unit, per_100_m2_gfa, per_m2_gfa or per_plot), or derived from the unit text ('per unit', 'per plot')" },
];

// ------------------------------------------------------------------ the values file

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** per_dwelling_unit or per_plot from the unit text, when the entry has no explicit basis. */
export function basisFromUnit(unit: string): string | undefined {
  if (/\bper\s+(dwelling\s+)?unit\b/i.test(unit)) return "per_dwelling_unit";
  if (/\bper\s+plot\b/i.test(unit)) return "per_plot";
  return undefined;
}

/**
 * Read a planning-values document: values under "values" (the first schema) or "keys" (Standards Bot's file). Every entry
 * with a value is kept, the key being whatever the file calls it; a number is a number, anything else is text and is shown
 * but never judged. Never throws; an entry that cannot be read is dropped and listed in problems.
 */
export function parseValues(raw: unknown): ValuesDoc {
  const out: ValuesDoc = { zone: "", jurisdiction: "", authority: "", notice: "", values: {}, problems: [], application_notes: [] };
  if (!isObj(raw)) { out.problems.push("the file is not a JSON object"); return out; }
  out.zone = str(raw.zone); out.jurisdiction = str(raw.jurisdiction); out.authority = str(raw.authority); out.notice = str(raw.notice);
  if (Array.isArray(raw.application_notes)) out.application_notes = raw.application_notes.filter((n): n is string => typeof n === "string");
  if (raw.schema !== undefined && raw.schema !== SCHEMA_ID) out.problems.push(`schema is "${String(raw.schema)}", expected "${SCHEMA_ID}"`);
  const table = isObj(raw.values) ? raw.values : isObj(raw.keys) ? raw.keys : null;
  if (!table) { out.problems.push('there is no "values" (or "keys") object'); return out; }
  for (const [key, e] of Object.entries(table)) {
    if (!key.trim()) { out.problems.push("an entry has an empty key (ignored)"); continue; }
    if (!isObj(e)) { out.problems.push(`${key}: not an object (ignored)`); continue; }
    if (!("value" in e) || e.value === null || e.value === undefined || e.value === "") { out.problems.push(`${key}: no value (ignored)`); continue; }
    let value: number | null = null; let text = "";
    if (typeof e.value === "number") {
      if (!Number.isFinite(e.value) || e.value < 0) { out.problems.push(`${key}: a number must be 0 or more (ignored)`); continue; }
      value = e.value;
    } else text = typeof e.value === "string" ? e.value.trim() : JSON.stringify(e.value);
    const entry: PlanningValue = {
      key, value, text, unit: str(e.unit), source: str(e.source), clause: str(e.clause), status: str(e.status).toLowerCase(),
      edition: str(e.edition), zone_or_use: str(e.zone_or_use), legal_character: str(e.legal_character), quote: str(e.quote),
    };
    if (typeof e.note === "string") entry.note = e.note;
    const explicit = str(e.basis);
    if (explicit) {
      if ((PARKING_BASES as readonly string[]).includes(explicit)) entry.basis = explicit;
      else out.problems.push(`${key}: basis "${explicit}" is not one of ${PARKING_BASES.join(", ")} (the basis is not used)`);
    } else if (key.startsWith(PARKING_PREFIX)) entry.basis = basisFromUnit(entry.unit);
    out.values[key] = entry;
  }
  return out;
}

/**
 * May this value decide pass or fail? Only approved, with a source and a clause; draft only when allowed (and then also
 * with a source and a clause). Unbanked, provisional and blank never.
 */
export function usable(e: PlanningValue, allowDraft: boolean = DEFAULT_ALLOW_DRAFT): { ok: boolean; why: string } {
  if (!e.status) return { ok: false, why: "the value has no status (it needs approved)" };
  if (e.status === "provisional") return { ok: false, why: "the value is provisional: a provisional value never passes or fails" };
  if (e.status === "unbanked") return { ok: false, why: "the value is unbanked: found in a source but not stored in the kit bank, so it never passes or fails" };
  if (e.status === "draft" && !allowDraft) return { ok: false, why: "the value is draft, not approved: it judges only when allow_draft is true" };
  if (e.status !== "draft" && e.status !== "approved") return { ok: false, why: `the status "${e.status}" is not approved` };
  if (!e.source) return { ok: false, why: "the value has no source" };
  if (!e.clause) return { ok: false, why: "the value has no clause" };
  return { ok: true, why: "" };
}

export interface LimitInfo {
  key: string; kind: "max" | "min"; value: number | null; text?: string; unit: string; source: string; clause: string; status: string;
  edition?: string; zone_or_use?: string; legal_character?: string; basis?: string; quote?: string;
}
export type LimitStatus = "ok" | "no_limit_configured" | "no_limit_selected" | "not_usable" | "not_numeric" | "no_value";
export interface Judged { result: Result; reason: string; limit: LimitInfo | null; limit_status: LimitStatus; indicative?: boolean }

const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

const limitOf = (e: PlanningValue, kind: "max" | "min", value: number | null = e.value): LimitInfo => ({
  key: e.key, kind, value, ...(e.value === null ? { text: trim(e.text, 400) } : {}), unit: e.unit, source: e.source, clause: e.clause, status: e.status,
  ...(e.edition ? { edition: e.edition } : {}), ...(e.zone_or_use ? { zone_or_use: e.zone_or_use } : {}),
  ...(e.legal_character ? { legal_character: e.legal_character } : {}), ...(e.basis ? { basis: e.basis } : {}), ...(e.quote ? { quote: trim(e.quote, 300) } : {}),
});

/** value against a max or a min limit. Missing limit: unknown, "no limit configured". */
export function judge(value: number | null, entry: PlanningValue | undefined, kind: "max" | "min", limitValue?: number, why = "", allowDraft: boolean = DEFAULT_ALLOW_DRAFT): Judged {
  if (!entry) return { result: "unknown", reason: `no limit configured${why ? ` (${why})` : ""}`, limit: null, limit_status: "no_limit_configured" };
  const limit = limitOf(entry, kind, limitValue ?? entry.value);
  const u = usable(entry, allowDraft);
  if (!u.ok) return { result: "unknown", reason: u.why, limit, limit_status: "not_usable" };
  if (limit.value === null) return { result: "unknown", reason: `the limit is text, not a number, so it is not judged: ${trim(entry.text, 200)}`, limit, limit_status: "not_numeric" };
  if (value === null || !Number.isFinite(value)) return { result: "unknown", reason: why || "the value could not be computed", limit, limit_status: "no_value" };
  const ok = kind === "max" ? value <= limit.value + 1e-9 : value >= limit.value - 1e-9;
  const draft = entry.status === "draft";
  const text = `${round(value)} ${kind === "max" ? "<=" : ">="} ${round(limit.value)} is ${ok ? "within" : "outside"} the ${kind === "max" ? "maximum" : "minimum"}`;
  return { result: ok ? "pass" : "fail", reason: draft ? `${DRAFT_LABEL}. ${text}` : text, limit, limit_status: "ok", ...(draft ? { indicative: true } : {}) };
}

export const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ------------------------------------------------------------------ choosing the limit

export interface Candidate { key: string; value: number | string; unit: string; zone_or_use: string; legal_character: string; status: string; source: string; clause: string; judges_when: string }
export interface ResolvedLimit {
  quantity: Quantity; entry?: PlanningValue; selected_by: "limits" | "default_key" | "none";
  problem?: Judged; candidates: Candidate[];
}

const CAP = 60;

export function candidatesFor(q: Quantity, values: Record<string, PlanningValue>, prefix?: string): Candidate[] {
  const p = prefix ?? QUANTITY_PREFIX[q];
  return Object.values(values).filter((v) => v.key.startsWith(p)).sort((a, b) => a.key.localeCompare(b.key)).slice(0, CAP).map((v) => ({
    key: v.key, value: v.value ?? trim(v.text, 120), unit: v.unit, zone_or_use: trim(v.zone_or_use, 160), legal_character: v.legal_character, status: v.status,
    source: trim(v.source, 80), clause: v.clause,
    judges_when: v.value === null ? "never (text)" : v.status === "approved" ? "yes" : v.status === "draft" ? "allow_draft" : "never",
  }));
}

/** The entry for a quantity: the caller's choice, else the plain default key, else nothing. The tool never chooses between rules. */
export function resolveLimit(q: Quantity, values: Record<string, PlanningValue>, limits: Partial<Record<Quantity, string>>, args: { use?: string } = {}): ResolvedLimit {
  const chosen = (limits[q] ?? "").trim();
  const useKey = q === "parking" ? (args.use ?? "").trim().toLowerCase() : "";
  const prefix = q === "parking" && useKey ? `${PARKING_PREFIX}${useKey}.` : undefined;
  const candidates = candidatesFor(q, values, prefix);
  const none = (reason: string, status: LimitStatus): ResolvedLimit => ({ quantity: q, selected_by: "none", candidates, problem: { result: "unknown", reason, limit: null, limit_status: status } });
  if (chosen) {
    const entry = values[chosen];
    if (!entry) return none(`the selected key "${chosen}" is not in the values file`, "no_limit_configured");
    return withUnit({ quantity: q, entry, selected_by: "limits", candidates: [] });
  }
  const dflt = q === "parking" ? (useKey ? PARKING_PREFIX + useKey : "") : DEFAULT_KEYS[q];
  if (dflt && values[dflt]) return withUnit({ quantity: q, entry: values[dflt], selected_by: "default_key", candidates: [] });
  if (candidates.length === 0) return none("no limit configured", "no_limit_configured");
  const how = q === "parking" && !useKey ? "pass use or limits.parking" : `pass limits.${q} with one of the keys in evidence.candidates`;
  return none(`no limit selected: the file has ${candidates.length} possible rule(s) and the tool does not choose between them (${how})`, "no_limit_selected");
}

function withUnit(r: ResolvedLimit): ResolvedLimit {
  const e = r.entry!;
  const ok = UNIT_OK[r.quantity];
  if (ok && e.unit && !ok.test(e.unit)) {
    return { ...r, problem: { result: "unknown", reason: `the unit "${e.unit}" is not what ${r.quantity.replace("_", " ")} is measured in, so the value is not used`, limit: limitOf(e, r.quantity === "plot_coverage" || r.quantity === "plot_ratio" ? "max" : "min"), limit_status: "not_usable" } };
  }
  return r;
}

/** Judge through a resolved limit; a selection problem comes back as unknown, never a pass. */
export function judgeResolved(r: ResolvedLimit, value: number | null, kind: "max" | "min", allowDraft: boolean, why = "", limitValue?: number): Judged {
  if (r.problem) return r.problem;
  return judge(value, r.entry, kind, limitValue, why, allowDraft);
}

/** How the rule binds, for the assumptions: binding or guideline, where it applies. */
export function applicability(e: PlanningValue | undefined): string[] {
  if (!e) return [];
  const out: string[] = [];
  if (e.legal_character) out.push(`The rule is a ${e.legal_character.replace(/_/g, " ")}${e.legal_character === "guideline" ? " (not statutory)" : ""}: ${e.source || "source not given"}${e.clause ? ", " + e.clause : ""}.`);
  if (e.zone_or_use) out.push(`Applies to: ${trim(e.zone_or_use, 240)}.`);
  if (/only in any area where no provision/i.test(e.zone_or_use + " " + e.quote)) out.push("This limit applies only where no provision has been made under the Physical Planning Act, 2010: where a physical development plan or other provision exists, that provision comes first. The tool cannot tell which applies to this plot.");
  return out;
}

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
  /** the exact values-file key to judge each check against; the tool never chooses between rules */
  limits?: Partial<Record<Quantity, string>>;
  /** a draft value judges only when true; default DEFAULT_ALLOW_DRAFT */
  allow_draft?: boolean;
}

export interface Check {
  check: string; title: string; value: number | string | null; unit: string;
  limit: LimitInfo | null; limit_status: string; result: Result; reason: string;
  evidence: Record<string, unknown>; assumptions: string[]; indicative?: boolean;
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

export interface Report {
  source: { used: SourceName | null; why: string[]; problem: string }; checks: Check[]; plot: { area_m2: number | null; from: string };
  classification: Record<string, unknown>; allow_draft: boolean; draft_judged: string[];
}

/** evidence plus the candidate rules when the caller still has to choose one */
function withCandidates(evidence: Record<string, unknown>, r: ResolvedLimit): Record<string, unknown> {
  return r.problem && r.candidates.length ? { ...evidence, candidates: r.candidates } : evidence;
}

export function buildChecks(facts: Facts, args: CheckArgs, values: Record<string, PlanningValue>): Report {
  const checks: Check[] = [];
  const allowDraft = args.allow_draft ?? DEFAULT_ALLOW_DRAFT;
  const limits = args.limits ?? {};
  const resolve = (q: Quantity) => resolveLimit(q, values, limits, { use: args.use });
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
  const cov = resolve("plot_coverage");
  if (footprint.area !== null && plotPlan.area) {
    const pct = (footprint.area / plotPlan.area) * 100;
    const j = judgeResolved(cov, pct, "max", allowDraft);
    checks.push(checkOf({ check: "plot_coverage", title: "Plot coverage (footprint / plot area)", value: round(pct), unit: "%", ...j,
      evidence: withCandidates({ footprint_area_m2: round(footprint.area), footprint_from: footprint.from, footprint_level: footprint.level, plot_area_m2: round(plotPlan.area), plot_area_from: plotPlan.from, footprint_element_ids: footprint.ids }, cov),
      assumptions: [...footprint.assumptions, ...plotPlan.assumptions, ...applicability(cov.entry)] }));
  } else {
    const j = judgeResolved(cov, null, "max", allowDraft, footprint.area === null ? footprint.problem : plotPlan.problem || "the plot area is missing");
    checks.push(checkOf({ check: "plot_coverage", title: "Plot coverage (footprint / plot area)", value: null, unit: "%", ...j, evidence: withCandidates({ footprint_from: footprint.from, plot_area_from: plotPlan.from }, cov), assumptions: [...footprint.assumptions, ...applicability(cov.entry)] }));
  }

  // --- plot ratio
  const rat = resolve("plot_ratio");
  if (gfa !== null && plotPlan.area) {
    const ratio = gfa / plotPlan.area;
    const j = judgeResolved(rat, ratio, "max", allowDraft);
    checks.push(checkOf({ check: "plot_ratio", title: "Plot ratio / FAR (GFA / plot area)", value: round(ratio, 3), unit: "ratio", ...j,
      evidence: withCandidates({ gfa_m2: round(gfa), gfa_source: src.used, plot_area_m2: round(plotPlan.area), plot_area_from: plotPlan.from }, rat),
      assumptions: [...(src.used ? [SOURCE_NOTE[src.used]] : []), ...plotPlan.assumptions, ...applicability(rat.entry)] }));
  } else {
    const j = judgeResolved(rat, null, "max", allowDraft, gfa === null ? "GFA could not be computed" : plotPlan.problem || "the plot area is missing");
    checks.push(checkOf({ check: "plot_ratio", title: "Plot ratio / FAR (GFA / plot area)", value: null, unit: "ratio", ...j, evidence: withCandidates({}, rat), assumptions: applicability(rat.entry) }));
  }

  // --- setbacks
  const classification: Record<string, unknown> = {};
  checks.push(...setbackChecks(facts, args, resolve, allowDraft, footprint, plotPlan, classification));

  // --- parking
  checks.push(parkingCheck(facts, args, resolve("parking"), allowDraft, gfa, src.used));

  return {
    source: src, checks, plot: { area_m2: plotPlan.area, from: plotPlan.from }, classification, allow_draft: allowDraft,
    draft_judged: checks.filter((c) => c.indicative && (c.result === "pass" || c.result === "fail")).map((c) => c.check),
  };
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

function setbackChecks(facts: Facts, args: CheckArgs, resolve: (q: Quantity) => ResolvedLimit, allowDraft: boolean, footprint: FootprintPlan, plot: PlotPlan, classification: Record<string, unknown>): Check[] {
  const lines = facts.property_lines?.lines ?? [];
  const parts: Array<["front" | "side" | "rear", Quantity]> = [["front", "setback_front"], ["side", "setback_side"], ["rear", "setback_rear"]];
  const pre = (reason: string): Check[] => parts.map(([name, q]) => {
    const r = resolve(q);
    const j = judgeResolved(r, null, "min", allowDraft, reason);
    return checkOf({ check: `setback_${name}`, title: `Setback: ${name}`, value: null, unit: "m", ...j, evidence: withCandidates({}, r), assumptions: applicability(r.entry) });
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
  for (const [name, q] of parts) {
    const r = resolve(q);
    const ns = (cls as Record<string, unknown>)[name] as number[];
    const mine = dists.filter((d) => ns.includes(d.n));
    const base = { evidence_all_lines: dists };
    if (mine.length === 0) {
      const j = judgeResolved(r, null, "min", allowDraft, `the ${name} boundary is not identified: ${cls.note}`);
      out.push(checkOf({ check: `setback_${name}`, title: `Setback: ${name}`, value: null, unit: "m", ...j, evidence: withCandidates({ lines: dists, ...base }, r), assumptions: [...assumptions, ...applicability(r.entry)] }));
      continue;
    }
    const min = Math.min(...mine.map((d) => d.min_distance_m));
    const j = judgeResolved(r, min, "min", allowDraft);
    out.push(checkOf({ check: `setback_${name}`, title: `Setback: ${name}`, value: round(min, 3), unit: "m", ...j,
      evidence: withCandidates({ boundary_segments: ns, boundary_element_ids: [...new Set(mine.map((d) => d.element_id))], per_segment_m: mine, classified_by: cls.inferred ? "inferred" : "input" }, r),
      assumptions: [...assumptions, ...(cls.inferred ? [cls.note] : []), ...applicability(r.entry)] }));
  }
  const overall = Math.min(...dists.map((d) => d.min_distance_m));
  out.push(noLimit("setback_overall", "Setback: nearest boundary (any segment)", round(overall, 3), "m",
    "no limit applies to the nearest boundary as such; the front, side and rear checks carry the limits",
    { per_segment_m: dists, segments_numbered_by: "n (the order the property-line curves were read); pass front_segments, side_segments, rear_segments with these numbers", footprint_points_outside_plot: outside },
    assumptions));
  return out;
}

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

function parkingCheck(facts: Facts, args: CheckArgs, r: ResolvedLimit, allowDraft: boolean, gfa: number | null, used: SourceName | null): Check {
  const useKey = args.use.trim().toLowerCase();
  const modelCount = facts.parking?.count ?? 0;
  const provided = args.parking_provided ?? modelCount;
  const providedFrom = args.parking_provided !== undefined ? "input" : "model (Parking category elements)";
  const evidence: Record<string, unknown> = {
    provided, provided_from: providedFrom, model_parking_count: modelCount, by_type: facts.parking?.by_type ?? [],
    element_ids: facts.parking?.element_ids ?? [], ids_truncated: !!facts.parking?.ids_truncated, use: useKey || null,
  };
  const assumptions = ["Each Parking-category element is counted as one space (a family that holds several bays, or a bay drawn in a different category, is miscounted). Accessible, loading and visitor bays are not separated."];
  const mk = (j: Judged, value: number | null, extra: Record<string, unknown> = {}) =>
    checkOf({ check: "parking", title: "Parking (provided against required)", value, unit: "spaces", ...j, evidence: withCandidates({ ...evidence, ...extra }, r), assumptions: [...assumptions, ...applicability(r.entry)] });
  const chosen = (args.limits?.parking ?? "").trim();
  if (!useKey && !chosen) {
    return mk({ result: "unknown", reason: "no use was given, so the required parking cannot be looked up (pass use or limits.parking)", limit: null, limit_status: r.candidates.length ? "no_limit_selected" : "no_limit_configured" }, provided);
  }
  if (r.problem) return mk(r.problem, provided);
  const entry = r.entry!;
  const first = judge(null, entry, "min", undefined, "", allowDraft);
  if (first.limit_status === "not_usable" || first.limit_status === "not_numeric") return mk(first, provided);
  let base: number | null = null; let baseName = "";
  if (entry.basis === "per_dwelling_unit") { base = args.units ?? null; baseName = "dwelling units (units)"; }
  else if (entry.basis === "per_100_m2_gfa") { base = gfa === null ? null : gfa / 100; baseName = "GFA / 100 m2"; }
  else if (entry.basis === "per_m2_gfa") { base = gfa; baseName = "GFA m2"; }
  else if (entry.basis === "per_plot") { base = 1; baseName = "plot"; }
  else return mk({ result: "unknown", reason: `the unit "${entry.unit}" does not say what the ${entry.value} spaces are counted per (per unit, per plot, per GFA), so the required parking cannot be computed`, limit: limitOf(entry, "min"), limit_status: "no_value" }, provided);
  if (base === null) return mk({ result: "unknown", reason: `the required parking is ${entry.value} ${entry.basis}, but ${baseName} is not known (${entry.basis === "per_dwelling_unit" ? "pass units" : "GFA could not be computed"})`, limit: limitOf(entry, "min"), limit_status: "no_value" }, provided);
  const required = Math.ceil((entry.value as number) * base - 1e-9);
  assumptions.push(`Required = ${entry.value} ${entry.basis} x ${round(base, 3)} ${baseName}, rounded UP to a whole space (${required}).${used && entry.basis !== "per_dwelling_unit" && entry.basis !== "per_plot" ? ` GFA is from ${used}.` : ""}`);
  const j = judge(provided, entry, "min", required, "", allowDraft);
  return mk(j, provided, { required, rate: entry.value, basis: entry.basis, base: round(base, 3) });
}

export function summarize(checks: Check[]) {
  const s = { pass: 0, fail: 0, unknown: 0 };
  for (const c of checks) s[c.result] += 1;
  return s;
}
