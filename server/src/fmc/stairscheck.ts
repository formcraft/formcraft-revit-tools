/**
 * Stair, ramp and handrail compliance against kit values. Read-only: this module only compares numbers the add-in read.
 * Every checked element gets a row, and every row has a status of pass, fail, not_applicable or provisional.
 * The numbers come from the standards bank (FMC_Standards_Building.json). A key that is missing from the bank is a
 * PROVISIONAL default, labelled as such, and it cannot PASS. Nothing here starts a transaction.
 */
import fs from "node:fs";
import path from "node:path";

export type CheckStatus = "pass" | "fail" | "not_applicable" | "provisional";
export type ElementKind = "stair" | "ramp" | "railing";

/** Length tolerance in millimetres. Revit stores feet as doubles. */
export const TOLERANCE_MM = 0.5;

export interface Cited {
  key: string;
  source: "standards" | "provisional" | "call";
  /** where the number came from before a call override */
  bank_source: "standards" | "provisional" | "unknown";
  clause: string;
  can_pass: boolean;
}

export type RuleKind = "max" | "min" | "range" | "count_min" | "inv_min" | "relative_min";

export interface Rule extends Cited {
  id: string;
  label: string;
  kind: RuleKind;
  unit: string;
  /** max, min, count, 1:N number, or the low end of a range. null for a relative rule that follows another measurement */
  value: number | null;
  value_max?: number;
  /** a kit key may hold a word such as "stair width". The word is kept here. */
  relative_to?: string;
}

export interface RuleOptions {
  use?: string;
  accessible?: boolean;
  overrides?: Partial<Record<OverrideName, number>>;
}

export const OVERRIDE_NAMES = [
  "riser_max_mm", "going_min_mm", "two_r_plus_g_min_mm", "two_r_plus_g_max_mm", "width_min_mm", "risers_per_flight_max",
  "landing_depth_min_mm", "stair_handrail_min_count", "handrail_height_min_mm", "handrail_height_max_mm", "guard_height_min_mm",
  "ramp_gradient_inv_min", "ramp_rise_max_mm", "ramp_handrail_min_count",
] as const;
export type OverrideName = (typeof OVERRIDE_NAMES)[number];

/**
 * Labelled defaults for a key the bank does not hold. They are NOT kit values and cite nothing.
 * Each is listed in BANK_SHAPE so the owner can add the key to the standards bank.
 */
export const PROVISIONAL_DEFAULTS: Record<string, { value: number; value_max?: number; unit: string; note: string }> = {
  "stairs.two_r_plus_g_mm": { value: 550, value_max: 700, unit: "mm", note: "PROVISIONAL default for 2 x riser + going. Not in the standards bank. Needs confirmation." },
  "stairs.handrail_min_count": { value: 1, unit: "count", note: "PROVISIONAL default: at least one handrail or guard on a stair. Not in the standards bank. Needs confirmation." },
  "ramps.handrail_min_count": { value: 1, unit: "count", note: "PROVISIONAL default: at least one handrail or guard on a ramp. Not in the standards bank. Needs confirmation." },
};

export const BANK_SHAPE = {
  "stairs.two_r_plus_g_mm": { value: 550, value_max: 700, unit: "mm", status: "provisional", clause: "", note: "Range for 2 x riser + going." },
  "stairs.handrail_min_count": { value: 1, unit: "count", status: "provisional", clause: "", note: "Handrails or guards a stair must have." },
  "ramps.handrail_min_count": { value: 1, unit: "count", status: "provisional", clause: "", note: "Handrails or guards a ramp must have." },
};

interface BankEntry {
  value?: unknown;
  status?: string;
  clause?: string;
  note?: string;
  uses?: Record<string, unknown>;
  range?: unknown;
}

function bag(standards: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!standards) return {};
  const inner = standards.standards;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) return inner as Record<string, unknown>;
  return standards;
}

function entryOf(standards: Record<string, unknown> | null | undefined, key: string): BankEntry | null {
  const raw = bag(standards)[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as BankEntry;
}

/** draft or approved (or no status) with a clause or note can pass. provisional, proposed, and no text cannot. */
function bankCite(entry: BankEntry): { can_pass: boolean; clause: string; bank_source: "standards" | "provisional" } {
  const status = (entry.status ?? "").trim().toLowerCase();
  const clause = (entry.clause || entry.note || "").trim();
  const okStatus = status === "" || status === "draft" || status === "approved";
  if (okStatus && clause) return { can_pass: true, clause, bank_source: "standards" };
  return { can_pass: false, clause: clause || "PROVISIONAL. The bank entry has no clause, so it cannot PASS.", bank_source: "provisional" };
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** "1:12" and "1 in 12" give 12. A bare number gives itself. */
export function parseInverseSlope(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^1\s*(?::|in)\s*([0-9]+(?:\.[0-9]+)?)$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 ? n : null;
}

function usesPick(entry: BankEntry, use: string | undefined): number | null {
  const uses = entry.uses && typeof entry.uses === "object" ? entry.uses : null;
  if (uses && use) {
    const key = Object.keys(uses).find((name) => name.toLowerCase() === use.trim().toLowerCase());
    if (key) {
      const picked = num(uses[key]);
      if (picked != null) return picked;
    }
  }
  return num(entry.value);
}

function subValue(entry: BankEntry, name: string): unknown {
  const value = entry.value;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined;
}

interface Source {
  key: string;
  value: number | null;
  value_max?: number;
  relative_to?: string;
  cited: { can_pass: boolean; clause: string; bank_source: "standards" | "provisional" | "unknown" };
}

function fromBank(
  standards: Record<string, unknown> | null | undefined,
  key: string,
  pick: (entry: BankEntry) => { value: number | null; value_max?: number; relative_to?: string },
): Source | null {
  const entry = entryOf(standards, key);
  if (!entry) return null;
  const got = pick(entry);
  if (got.value == null && !got.relative_to) return null;
  return { key, value: got.value, value_max: got.value_max, relative_to: got.relative_to, cited: bankCite(entry) };
}

function provisional(key: string): Source {
  const d = PROVISIONAL_DEFAULTS[key];
  return { key, value: d.value, value_max: d.value_max, cited: { can_pass: false, clause: d.note, bank_source: "unknown" } };
}

function makeRule(
  id: string, label: string, kind: RuleKind, unit: string, source: Source, override?: number, overrideMax?: number,
): Rule {
  const base: Rule = {
    id, label, kind, unit, key: source.key, value: source.value, value_max: source.value_max, relative_to: source.relative_to,
    source: source.cited.bank_source === "standards" ? "standards" : "provisional",
    bank_source: source.cited.bank_source, clause: source.cited.clause, can_pass: source.cited.can_pass,
  };
  if (typeof override === "number" && Number.isFinite(override)) {
    base.value = override;
    base.relative_to = undefined;
    base.source = source.cited.bank_source === "standards" ? "call" : base.source;
  }
  if (typeof overrideMax === "number" && Number.isFinite(overrideMax)) base.value_max = overrideMax;
  return base;
}

export interface RuleSet {
  stair: { riser: Rule; going: Rule; two_r_plus_g: Rule; width: Rule; risers_per_flight: Rule; landing_depth: Rule; handrail_count: Rule; handrail_height: Rule; guard_height: Rule; headroom: Rule; };
  ramp: { gradient: Rule; rise: Rule; width: Rule; handrail_count: Rule; handrail_height: Rule };
  railing: { handrail_height: Rule; guard_height: Rule };
  accessible: Rule[];
}

/** Resolve every number the checks use, with where it came from. */
export function resolveRules(standards: Record<string, unknown> | null | undefined, options: RuleOptions = {}): RuleSet {
  const use = options.use;
  const o = options.overrides ?? {};
  const accessible = options.accessible === true;

  const riser = fromBank(standards, "stairs.riser_max", (e) => ({ value: usesPick(e, use) }));
  const going = fromBank(standards, "stairs.going_min", (e) => ({ value: usesPick(e, use) }));
  const width = fromBank(standards, "stairs.width_min", (e) => ({ value: usesPick(e, use) }));
  const flight = fromBank(standards, "stairs.risers_per_flight_max", (e) => ({ value: usesPick(e, use) }));
  const landing = fromBank(standards, "stairs.landing_depth", (e) => {
    const n = num(e.value);
    if (n != null) return { value: n };
    return typeof e.value === "string" && /stair\s*width/i.test(e.value) ? { value: null, relative_to: "stair_width" } : { value: null };
  });
  const handrail = fromBank(standards, "stairs.handrail_height", (e) => {
    const r = Array.isArray(e.range) ? e.range.map(num) : [];
    if (r.length === 2 && r[0] != null && r[1] != null) return { value: r[0], value_max: r[1] };
    return { value: null };
  });
  const guard = fromBank(standards, "guards.stair_and_landing", (e) => ({ value: num(e.value) }));
  const headroom = fromBank(standards, "stairs.headroom", (e) => ({ value: num(e.value) }));
  const gradient = fromBank(standards, "accessibility.ramp_gradient_max", (e) => ({ value: parseInverseSlope(e.value) }));
  const rampBlock = (name: string) => fromBank(standards, "accessibility.ramp", (e) => ({ value: num(subValue(e, name)) }));
  const rampWidth = rampBlock("width_min_mm");
  const rampRise = rampBlock("rise_max_combined_mm");
  const rampHandrails = fromBank(standards, "accessibility.ramp", (e) => {
    const text = subValue(e, "handrails");
    return typeof text === "string" && /both\s+sides/i.test(text) ? { value: 2 } : { value: null };
  });

  const none = (key: string): Source => ({ key, value: null, cited: { can_pass: false, clause: "PROVISIONAL. No value in the standards bank and no default.", bank_source: "unknown" } });

  const stair = {
    riser: makeRule("riser_height", "Riser height", "max", "mm", riser ?? none("stairs.riser_max"), o.riser_max_mm),
    going: makeRule("going", "Going (tread depth)", "min", "mm", going ?? none("stairs.going_min"), o.going_min_mm),
    two_r_plus_g: makeRule("two_r_plus_g", "2 x riser + going", "range", "mm", provisional("stairs.two_r_plus_g_mm"), o.two_r_plus_g_min_mm, o.two_r_plus_g_max_mm),
    width: makeRule("run_width", "Run width", "min", "mm", width ?? none("stairs.width_min"), o.width_min_mm),
    risers_per_flight: makeRule("risers_per_flight", "Risers per flight", "max", "count", flight ?? none("stairs.risers_per_flight_max"), o.risers_per_flight_max),
    landing_depth: makeRule("landing_depth", "Landing depth", "relative_min", "mm", landing ?? none("stairs.landing_depth"), o.landing_depth_min_mm),
    handrail_count: makeRule("handrail_count", "Handrails or guards", "count_min", "count", provisional("stairs.handrail_min_count"), o.stair_handrail_min_count),
    handrail_height: makeRule("handrail_height", "Handrail height", "range", "mm", handrail ?? none("stairs.handrail_height"), o.handrail_height_min_mm, o.handrail_height_max_mm),
    guard_height: makeRule("guard_height", "Guard height on a stair", "min", "mm", guard ?? none("guards.stair_and_landing"), o.guard_height_min_mm),
    headroom: makeRule("headroom", "Headroom", "min", "mm", headroom ?? none("stairs.headroom")),
  };
  const ramp = {
    gradient: makeRule("ramp_gradient", "Ramp gradient (1:N, N at least)", "inv_min", "1:N", gradient ?? none("accessibility.ramp_gradient_max"), o.ramp_gradient_inv_min),
    rise: makeRule("ramp_rise", "Ramp rise", "max", "mm", rampRise ?? none("accessibility.ramp"), o.ramp_rise_max_mm),
    width: makeRule("ramp_width", "Ramp width", "min", "mm", rampWidth ?? none("accessibility.ramp")),
    handrail_count: makeRule("handrail_count", "Handrails or guards", "count_min", "count", rampHandrails ?? provisional("ramps.handrail_min_count"), o.ramp_handrail_min_count),
    handrail_height: stair.handrail_height,
  };
  const railing = { handrail_height: stair.handrail_height, guard_height: stair.guard_height };

  const extra: Rule[] = [];
  let finalStair = stair;
  if (accessible) {
    const accStairs = (name: string) => fromBank(standards, "accessibility.stair", (e) => ({ value: num(subValue(e, name)) }));
    const accRiser = accStairs("riser_max_mm");
    const accLanding = accStairs("landing_length_min_mm");
    const accHandrails = fromBank(standards, "accessibility.stair", (e) => {
      const text = subValue(e, "handrails");
      return typeof text === "string" && /both\s+sides/i.test(text) ? { value: 2 } : { value: null };
    });
    const accHandrail = fromBank(standards, "accessibility.handrail", (e) => {
      const h = subValue(e, "height_mm");
      const r = Array.isArray(h) ? h.map(num) : [];
      return r.length === 2 && r[0] != null && r[1] != null ? { value: r[0], value_max: r[1] } : { value: null };
    });
    extra.push(
      makeRule("riser_height_accessible", "Riser height, accessible stair", "max", "mm", accRiser ?? none("accessibility.stair")),
      makeRule("landing_length_accessible", "Landing length, accessible stair", "min", "mm", accLanding ?? none("accessibility.stair")),
    );
    finalStair = {
      ...stair,
      handrail_count: accHandrails ? makeRule("handrail_count", "Handrails (accessible: both sides)", "count_min", "count", accHandrails, o.stair_handrail_min_count) : stair.handrail_count,
      handrail_height: accHandrail ? makeRule("handrail_height", "Handrail height, accessible", "range", "mm", accHandrail, o.handrail_height_min_mm, o.handrail_height_max_mm) : stair.handrail_height,
    };
    ramp.handrail_height = finalStair.handrail_height;
    railing.handrail_height = finalStair.handrail_height;
  }
  return { stair: finalStair, ramp, railing, accessible: extra };
}

export interface StairRun { id: string; width_mm?: number | null; risers?: number | null; }
export interface StairLanding { id: string; width_mm?: number | null; depth_mm?: number | null; approximate?: boolean; }

interface Base { id: string; name?: string; type?: string; level?: string; source?: string; link?: string; }

export interface StairFacts extends Base {
  method?: "component" | "sketch" | string;
  riser_mm?: number | null;
  tread_mm?: number | null;
  risers?: number | null;
  runs?: StairRun[];
  landings?: StairLanding[];
  railing_ids?: string[];
}

export interface RampFacts extends Base {
  /** Maximum Incline (1/x) on the ramp. 12 means 1:12 */
  max_incline_inv?: number | null;
  rise_mm?: number | null;
  railing_ids?: string[];
}

export interface RailingFacts extends Base {
  host_id?: string;
  host_kind?: "stair" | "ramp" | "other" | string;
  handrail_height_mm?: number | null;
  top_rail_height_mm?: number | null;
}

export interface CheckRow {
  check: string;
  label: string;
  status: CheckStatus;
  measured: number | string | null;
  required: number | string | null;
  required_max?: number | null;
  unit: string;
  rule: RuleKind;
  key: string;
  rule_source: Rule["source"];
  clause: string;
  can_pass: boolean;
  /** true when the kit number is a PROVISIONAL default or the measurement is approximate */
  provisional_rule: boolean;
  approximate?: boolean;
  where?: string;
  note: string;
}

export interface ElementRow {
  id: string;
  kind: ElementKind;
  name: string;
  type: string;
  level: string;
  source: string;
  link: string;
  status: CheckStatus;
  checks: CheckRow[];
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface Measure { value: number | null; approximate?: boolean; where?: string; text?: string }

function row(rule: Rule, measure: Measure, naNote: string): CheckRow {
  const required = rule.value;
  const common = {
    check: rule.id, label: rule.label, unit: rule.unit, rule: rule.kind, key: rule.key, rule_source: rule.source,
    clause: rule.clause, can_pass: rule.can_pass, provisional_rule: !rule.can_pass,
  };
  const na = (note: string): CheckRow => ({
    ...common, status: "not_applicable", measured: measure.value == null ? null : round1(measure.value),
    required: required, required_max: rule.value_max ?? null, note,
  });
  if (measure.value == null) return na(naNote);
  if (required == null) return na("No required number: the standards bank has no value for " + rule.key + ".");
  const m = measure.value;
  let ok: boolean;
  switch (rule.kind) {
    case "max": ok = m <= required + TOLERANCE_MM; break;
    case "min": case "relative_min": case "count_min": ok = m >= required - TOLERANCE_MM; break;
    case "inv_min": ok = m >= required - 0.001; break;
    case "range": ok = m >= required - TOLERANCE_MM && m <= (rule.value_max ?? Number.POSITIVE_INFINITY) + TOLERANCE_MM; break;
    default: ok = false;
  }
  const approximate = measure.approximate === true;
  let status: CheckStatus;
  if (!ok) status = "fail";
  else status = rule.can_pass && !approximate ? "pass" : "provisional";
  const notes: string[] = [];
  if (!rule.can_pass) notes.push("The number is PROVISIONAL, so it cannot PASS. " + rule.clause);
  if (approximate) notes.push("The measurement is approximate, so it cannot PASS.");
  return {
    ...common, status,
    measured: measure.text ?? round1(m),
    required: required, required_max: rule.value_max ?? null,
    ...(approximate ? { approximate: true } : {}),
    ...(measure.where ? { where: measure.where } : {}),
    note: notes.join(" "),
  };
}

function elementStatus(checks: CheckRow[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "provisional")) return "provisional";
  if (checks.some((c) => c.status === "pass")) return "pass";
  return "not_applicable";
}

function head(kind: ElementKind, f: Base, checks: CheckRow[]): ElementRow {
  return {
    id: String(f.id), kind, name: f.name ?? "", type: f.type ?? "", level: f.level ?? "", source: f.source || "host", link: f.link ?? "",
    status: elementStatus(checks), checks,
  };
}

function minOf(values: Array<number | null | undefined>): number | null {
  const list = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return list.length ? Math.min(...list) : null;
}

function maxOf(values: Array<number | null | undefined>): number | null {
  const list = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return list.length ? Math.max(...list) : null;
}

export interface RailingIndex { byId: Map<string, RailingFacts>; }

/** Ids are only unique inside one document, so a host railing and a link railing can share an id. */
function railKey(owner: Base, id: string): string {
  return `${owner.source || "host"}|${owner.link ?? ""}|${id}`;
}

export function checkStair(stair: StairFacts, rules: RuleSet, railings: RailingIndex, accessible: boolean): ElementRow {
  const r = rules.stair;
  const checks: CheckRow[] = [];
  const riser = finite(stair.riser_mm);
  const tread = finite(stair.tread_mm);
  const runs = stair.runs ?? [];
  const component = runs.length > 0;
  checks.push(row(r.riser, { value: riser }, "Revit gave no actual riser height."));
  checks.push(row(r.going, { value: tread }, "Revit gave no actual tread depth."));
  checks.push(row(r.two_r_plus_g, { value: riser != null && tread != null ? 2 * riser + tread : null }, "Needs the riser height and the tread depth."));
  const widest = minOf(runs.map((run) => finite(run.width_mm)));
  checks.push(row(r.width, { value: widest, where: widest == null ? undefined : "narrowest run" },
    component ? "Revit gave no run width." : "Sketch-based stair: no component runs, so the run width is not read."));
  const flight = maxOf(runs.map((run) => finite(run.risers)));
  checks.push(row(r.risers_per_flight, { value: flight, where: flight == null ? undefined : "longest run" },
    component ? "Revit gave no riser count per run." : "Sketch-based stair: no component runs, so risers per flight are not read."));
  const landings = stair.landings ?? [];
  if (!landings.length) {
    checks.push(row({ ...r.landing_depth, value: r.landing_depth.value }, { value: null }, "The stair has no landing."));
  }
  for (const landing of landings) {
    const w = finite(landing.width_mm), d = finite(landing.depth_mm);
    const least = minOf([w, d]);
    const rule = landing.id ? { ...r.landing_depth } : r.landing_depth;
    if (rule.relative_to === "stair_width") rule.value = widest;
    const cell = row(rule, { value: least, approximate: landing.approximate === true, where: "landing " + landing.id },
      "Revit gave no landing size.");
    if (rule.relative_to === "stair_width" && widest == null) cell.note = "The kit asks for at least the stair width and no run width was read. " + cell.note;
    checks.push(cell);
    if (accessible) {
      const acc = rules.accessible.find((x) => x.id === "landing_length_accessible");
      if (acc) checks.push(row(acc, { value: least, approximate: landing.approximate === true, where: "landing " + landing.id }, "Revit gave no landing size."));
    }
  }
  if (accessible) {
    const acc = rules.accessible.find((x) => x.id === "riser_height_accessible");
    if (acc) checks.push(row(acc, { value: riser }, "Revit gave no actual riser height."));
  }
  const rail = (stair.railing_ids ?? []).map((id) => railings.byId.get(railKey(stair, String(id))) ?? null);
  checks.push(row(r.handrail_count, { value: (stair.railing_ids ?? []).length }, "No railing count."));
  const heights = rail.map((x) => (x ? finite(x.handrail_height_mm) : null)).filter((v): v is number => v != null);
  for (const [i, h] of heights.entries()) checks.push(row(r.handrail_height, { value: h, where: "handrail " + (i + 1) }, "No handrail height."));
  if (!heights.length) checks.push(row(r.handrail_height, { value: null }, "No handrail on the stair, or its height was not read."));
  checks.push(row(r.headroom, { value: null }, "Headroom is not measured by this tool. Run fmc_headroom, which reads the clear height under beams, ducts and soffits."));
  return head("stair", stair, checks);
}

export function checkRamp(ramp: RampFacts, rules: RuleSet, railings: RailingIndex): ElementRow {
  const r = rules.ramp;
  const checks: CheckRow[] = [];
  const inv = finite(ramp.max_incline_inv);
  checks.push(row(r.gradient, { value: inv, text: inv == null ? undefined : "1:" + round1(inv) },
    "The ramp has no Maximum Incline (1/x) value."));
  checks.push(row(r.rise, { value: finite(ramp.rise_mm), approximate: true, where: "bounding box height less thickness" }, "Revit gave no rise."));
  checks.push(row(r.width, { value: null }, "Revit stores no width on a sketched ramp. Check the ramp width on the plan."));
  const ids = ramp.railing_ids ?? [];
  checks.push(row(r.handrail_count, { value: ids.length }, "No railing count."));
  const heights = ids.map((id) => railings.byId.get(railKey(ramp, String(id)))).map((x) => (x ? finite(x.handrail_height_mm) : null)).filter((v): v is number => v != null);
  for (const [i, h] of heights.entries()) checks.push(row(r.handrail_height, { value: h, where: "handrail " + (i + 1) }, "No handrail height."));
  if (!heights.length) checks.push(row(r.handrail_height, { value: null }, "No handrail on the ramp, or its height was not read."));
  return head("ramp", ramp, checks);
}

export function checkRailing(railing: RailingFacts, rules: RuleSet): ElementRow {
  const r = rules.railing;
  const checks: CheckRow[] = [];
  const hand = finite(railing.handrail_height_mm);
  const top = finite(railing.top_rail_height_mm);
  checks.push(row(r.handrail_height, { value: hand }, "The railing type has no handrail."));
  const stairHost = (railing.host_kind ?? "") === "stair";
  checks.push(row(r.guard_height, { value: stairHost ? top : null },
    stairHost ? "The railing type has no top rail." : "Not hosted on a stair, so the kit stair guard height does not apply. Guard height depends on the use of the edge."));
  return head("railing", railing, checks);
}

export interface CheckInput {
  stairs?: StairFacts[];
  ramps?: RampFacts[];
  railings?: RailingFacts[];
}

export interface Summary {
  elements: number;
  by_kind: Record<ElementKind, number>;
  by_status: Record<CheckStatus, number>;
  checks: Record<CheckStatus, number>;
}

function keyOf(f: Base): string {
  return `${f.source || "host"}|${f.link ?? ""}|${f.id}`;
}

function assertNoDuplicates(kind: string, list: Base[]) {
  const seen = new Set<string>();
  for (const item of list) {
    const key = keyOf(item);
    if (seen.has(key)) throw new Error(`[FMC-STAIRS-DUPLICATE] ${kind} ${item.id} appears twice in the read. Duplicates are errors.`);
    seen.add(key);
  }
}

export function filterByLevels<T extends Base>(list: T[], levels: string[]): T[] {
  if (!levels.length) return list;
  const want = new Set(levels.map((x) => x.trim().toLowerCase()).filter(Boolean));
  return list.filter((x) => want.has((x.level ?? "").trim().toLowerCase()) || want.has(String(x.id).toLowerCase()));
}

export function runChecks(
  input: CheckInput, rules: RuleSet, options: { kinds?: ElementKind[]; levels?: string[]; accessible?: boolean } = {},
): ElementRow[] {
  const kinds = options.kinds?.length ? options.kinds : (["stair", "ramp", "railing"] as ElementKind[]);
  const levels = options.levels ?? [];
  const stairs = input.stairs ?? [], ramps = input.ramps ?? [], railList = input.railings ?? [];
  assertNoDuplicates("stair", stairs); assertNoDuplicates("ramp", ramps); assertNoDuplicates("railing", railList);
  const index: RailingIndex = { byId: new Map(railList.map((x) => [railKey(x, String(x.id)), x])) };
  const out: ElementRow[] = [];
  if (kinds.includes("stair")) for (const s of filterByLevels(stairs, levels)) out.push(checkStair(s, rules, index, options.accessible === true));
  if (kinds.includes("ramp")) for (const s of filterByLevels(ramps, levels)) out.push(checkRamp(s, rules, index));
  if (kinds.includes("railing")) for (const s of filterByLevels(railList, levels)) out.push(checkRailing(s, rules));
  const rank: Record<CheckStatus, number> = { fail: 0, provisional: 1, pass: 2, not_applicable: 3 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return out;
}

export function summarise(rows: ElementRow[]): Summary {
  const zero = (): Record<CheckStatus, number> => ({ pass: 0, fail: 0, not_applicable: 0, provisional: 0 });
  const summary: Summary = { elements: rows.length, by_kind: { stair: 0, ramp: 0, railing: 0 }, by_status: zero(), checks: zero() };
  for (const r of rows) {
    summary.by_kind[r.kind] += 1;
    summary.by_status[r.status] += 1;
    for (const c of r.checks) summary.checks[c.status] += 1;
  }
  return summary;
}

/** The overall verdict: FAIL if anything fails, PROVISIONAL if nothing fails but something cannot pass, PASS, or NOTHING when no element was found. */
export function overall(summary: Summary): "FAIL" | "PROVISIONAL" | "PASS" | "NO_ELEMENTS" {
  if (summary.elements === 0) return "NO_ELEMENTS";
  if (summary.checks.fail > 0) return "FAIL";
  if (summary.checks.provisional > 0) return "PROVISIONAL";
  return summary.checks.pass > 0 ? "PASS" : "PROVISIONAL";
}

export function stairsCheckDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_STAIRS_CHECK_DIR ?? "").trim()) return env.FMC_STAIRS_CHECK_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(path.sep, "tmp", "FormcraftLocal");
  return path.join(local, "Formcraft", "stairs_check");
}

export function writeStairsReport(env: NodeJS.ProcessEnv, body: unknown, dir = stairsCheckDir(env)): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `stairs-check-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

/** Every rule as the reply shows it, so a person can see each number and where it came from. */
export function rulesList(rules: RuleSet): Rule[] {
  const seen = new Set<Rule>();
  for (const group of [rules.stair, rules.ramp, rules.railing]) for (const rule of Object.values(group)) seen.add(rule);
  for (const rule of rules.accessible) seen.add(rule);
  return [...seen];
}