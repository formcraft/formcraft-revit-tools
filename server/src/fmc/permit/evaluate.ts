/**
 * fmc_permit_check evaluators. Every threshold is read from the standards bank through cite(); a missing key gives
 * NOT_CHECKED. States: FAIL, PASS ("no exception found"), REVIEW, NOT_CHECKED, NOT_APPLICABLE, ADVICE, INFO.
 */
import { field, num, strings } from "./bank.js";
import type { Derived } from "./derive.js";
import type { PermitFacts } from "./facts.js";
import type { Ctx, Finding } from "./finding.js";
import { citeFor, make, missing } from "./finding.js";
import { evaluatePack } from "./pack.js";
import { isHabitable, roomUse } from "./roomuse.js";
import { PERMIT_RULES, ruleById } from "./rules.js";

export type Category = "A" | "B" | "C";

export interface PermitInput {
  /** The building's use as the caller states it (residential, commercial, public_assembly, education, healthcare, industrial ...). */
  use?: string;
  /** The category the caller expects; a different derived category is REVIEW. */
  category?: Category;
  /** Plot area and zone for plot coverage. zone: A-E (residential density zones in the bank) or "commercial". */
  plot?: { area_m2?: number; zone?: string };
}

/** Uses the Regulations put in category A whatever the size (public buildings, complexes). Formcraft's mapping, an assumption. */
export const CATEGORY_A_USES = ["public_assembly", "public", "education", "school", "healthcare", "hospital", "mall", "complex"];

export interface CategoryResult { derived: Category | null; boundary: string[]; reasons: string[] }

const EPS = 1e-6;

export function deriveCategory(ctx: Ctx, d: Derived, input: PermitInput): { result: CategoryResult; finding: Finding } {
  const rule = ruleById("CLASS.category");
  const cat = citeFor(ctx, rule, "permits.building_category");
  const minor = citeFor(ctx, rule, "permits.minor_works_definition");
  const multi = citeFor(ctx, rule, "permits.multistorey_definition");
  const maxArea = num(field(minor, "max_floor_area_m2"));
  const maxStoreys = num(field(minor, "storeys"));
  const maxHeight = num(field(multi, "height_more_than_m"));
  const cited = [cat, minor, multi];
  const result: CategoryResult = { derived: null, boundary: [], reasons: [] };
  if (maxArea === null || maxStoreys === null || maxHeight === null) {
    return { result, finding: missing(ctx, "CLASS.category", cited) };
  }
  const tolA = ctx.defaults.boundaryToleranceM2;
  const tolH = ctx.defaults.boundaryToleranceMm / 1000;
  const use = (input.use ?? "").trim().toLowerCase();
  const publicUse = !!use && CATEGORY_A_USES.some((u) => use.includes(u));
  const tall = d.height_m !== null && d.height_m > maxHeight + tolH;

  if (d.height_m !== null && Math.abs(d.height_m - maxHeight) <= tolH) result.boundary.push(`height ${d.height_m} m is at the ${maxHeight} m boundary`);
  if (Math.abs(d.gfa_m2 - maxArea) <= tolA) result.boundary.push(`floor area ${d.gfa_m2} m2 is at the ${maxArea} m2 boundary`);

  if (tall) { result.derived = "A"; result.reasons.push(`height ${d.height_m} m is over ${maxHeight} m`); }
  else if (publicUse) { result.derived = "A"; result.reasons.push(`use "${input.use}" is public or a complex`); }
  else if (d.gfa_m2 <= maxArea + EPS && d.storeys <= maxStoreys && d.gfa_source !== "none") { result.derived = "C"; result.reasons.push(`floor area ${d.gfa_m2} m2 and ${d.storeys} storey(s) are within minor works`); }
  else { result.derived = "B"; result.reasons.push(`floor area ${d.gfa_m2} m2, ${d.storeys} storey(s), height ${d.height_m ?? "unknown"} m`); }

  const review: string[] = [];
  if (result.boundary.length && ctx.defaults.boundaryReview) review.push(`${result.boundary.join("; ")} (the Act and the Regulations word this boundary differently; interim default Q10)`);
  if (!use && !tall) review.push("the building's use was not given, so a public or complex use (category A) cannot be ruled out");
  if (d.height_source === "none") review.push("the height could not be read from the model");
  if (d.gfa_source === "none") review.push("the floor area could not be read from the model");
  if (input.category && input.category !== result.derived) review.push(`the expected category ${input.category} differs from the derived ${result.derived}`);
  const base = `Derived category ${result.derived}: ${result.reasons.join("; ")}. Advisory only; the Building Committee classifies the application.`;
  return { result, finding: make(ctx, "CLASS.category", review.length ? "REVIEW" : "INFO", review.length ? `${base} Review: ${review.join("; ")}.` : base, cited) };
}

function evaluateClassAndSite(ctx: Ctx, d: Derived, category: CategoryResult): Finding[] {
  const out: Finding[] = [];
  const multi = citeFor(ctx, ruleById("CLASS.multistorey_docs"), "permits.multistorey_definition");
  const sub = citeFor(ctx, ruleById("CLASS.multistorey_docs"), "permits.multistorey_submission");
  const h = num(field(multi, "height_more_than_m"));
  const tolH = ctx.defaults.boundaryToleranceMm / 1000;
  if (h === null) out.push(missing(ctx, "CLASS.multistorey_docs", [multi, sub]));
  else if (d.height_m === null) out.push(make(ctx, "CLASS.multistorey_docs", "NOT_CHECKED", "The building height could not be read.", [multi, sub]));
  else if (Math.abs(d.height_m - h) <= tolH && ctx.defaults.boundaryReview) out.push(make(ctx, "CLASS.multistorey_docs", "REVIEW", `Height ${d.height_m} m is at the ${h} m boundary; whether the multi-storey submissions apply needs a decision.`, [multi, sub]));
  else if (d.height_m > h) out.push(make(ctx, "CLASS.multistorey_docs", "NOT_CHECKED", `Height ${d.height_m} m is over ${h} m: the application needs ${String(sub.value ?? "the multi-storey submissions")}. A model cannot show these documents.`, [multi, sub]));
  else out.push(make(ctx, "CLASS.multistorey_docs", "NOT_APPLICABLE", `Height ${d.height_m} m is not over ${h} m.`, [multi, sub]));

  const exc = citeFor(ctx, ruleById("SITE.excavation"), "site.deep_excavation_temporary_works");
  const trig = num(field(exc, "depth_trigger_m"));
  if (trig === null) out.push(missing(ctx, "SITE.excavation", [exc]));
  else if (d.basement_depth_m === null) out.push(make(ctx, "SITE.excavation", "NOT_APPLICABLE", "No occupied level below ground in the model.", [exc]));
  else if (d.basement_depth_m > trig) out.push(make(ctx, "SITE.excavation", "REVIEW", `The lowest level is ${d.basement_depth_m} m below ground (over ${trig} m): structural temporary works need approval unless shown on the approved plans. Excavation depth is taken from level elevations, not the foundations.`, [exc]));
  else out.push(make(ctx, "SITE.excavation", "PASS", `The lowest level is ${d.basement_depth_m} m below ground, not over ${trig} m (level elevations only).`, [exc]));

  // Documents to attach for the derived category.
  const docsRule = ruleById("DOCS.attach");
  const keys = category.derived === "C" ? ["permits.application_minor_works"]
    : category.derived === "B" ? ["permits.application_residential_commercial"]
    : category.derived === "A" ? ["permits.application_residential_commercial", "permits.application_complex_public_extra"] : [];
  for (const key of keys) {
    const c = citeFor(ctx, docsRule, key);
    if (!c.found) { out.push(missing(ctx, "DOCS.attach", [c])); continue; }
    for (const item of strings(c.value)) out.push(make(ctx, "DOCS.attach", "NOT_CHECKED", `Attach: ${item}.`, [c]));
  }
  if (!keys.length) out.push(make(ctx, "DOCS.attach", "NOT_CHECKED", "The category could not be derived, so the document list is not known.", []));
  return out;
}

const below = (area: number, min: number) => area + EPS < min;

function evaluateRooms(ctx: Ctx, f: PermitFacts): Finding[] {
  const out: Finding[] = [];
  const hab = ruleById("ROOMS.habitable");
  const first = citeFor(ctx, hab, "rooms.habitable_first_min");
  const add = citeFor(ctx, hab, "rooms.habitable_additional_min");
  const sleep = citeFor(ctx, hab, "rooms.sleeping_area_per_person");
  const kit = citeFor(ctx, ruleById("ROOMS.kitchen"), "rooms.kitchen_min");
  const kitSmall = citeFor(ctx, ruleById("ROOMS.kitchen"), "rooms.kitchen_min", "small_units");
  const bath = citeFor(ctx, ruleById("ROOMS.bathroom"), "rooms.bathroom_legal_min");
  const typ = ruleById("ROOMS.typical");
  const typical: Record<string, ReturnType<typeof citeFor>> = {
    bedroom: citeFor(ctx, typ, "rooms.bedroom_single_min"), living: citeFor(ctx, typ, "rooms.living_min"),
    bathroom: citeFor(ctx, typ, "rooms.bathroom_min"), wc: citeFor(ctx, typ, "rooms.wc_min"),
  };
  const firstV = num(first.value), addV = num(add.value), kitV = num(kit.value), bathV = num(bath.value);
  const small = kitSmall.found && kitSmall.value !== kit.value ? num(kitSmall.value) : null;
  const unmapped: string[] = [];
  let typicalHits = 0;

  for (const r of f.rooms) {
    const use = roomUse(r.name, r.department, r.occupancy);
    const label = `${r.number ? r.number + " " : ""}${r.name || "(no name)"} on ${r.level || "?"}, ${r.area_m2} m2`;
    if (use === "unmapped") { unmapped.push(r.id); continue; }
    if (isHabitable(use)) {
      if (addV === null || firstV === null) continue;
      if (below(r.area_m2, addV)) out.push(make(ctx, "ROOMS.habitable", "FAIL", `${label}: under the ${addV} m2 minimum for any habitable room.`, [add], [r.id]));
      else if (below(r.area_m2, firstV)) out.push(make(ctx, "ROOMS.habitable", "REVIEW", `${label}: under ${firstV} m2, so it cannot be the dwelling's first habitable room.`, [first, add], [r.id]));
      else out.push(make(ctx, "ROOMS.habitable", "PASS", `${label}: at least ${firstV} m2.`, [first], [r.id]));
    } else if (use === "kitchen") {
      if (kitV === null) continue;
      if (small !== null && below(r.area_m2, small)) out.push(make(ctx, "ROOMS.kitchen", "FAIL", `${label}: under the ${small} m2 small-unit minimum.`, [kitSmall], [r.id]));
      else if (below(r.area_m2, kitV)) out.push(make(ctx, "ROOMS.kitchen", "REVIEW",
        `${label}: under ${kitV} m2. Allowed only under the small-dwelling rule${small !== null ? ` (not under ${small} m2)` : " the bank gives in a note, not as a value"}.`, [kit], [r.id]));
      else out.push(make(ctx, "ROOMS.kitchen", "PASS", `${label}: at least ${kitV} m2.`, [kit], [r.id]));
    } else if (use === "bathroom" || use === "wc") {
      if (bathV === null) continue;
      if (below(r.area_m2, bathV)) out.push(make(ctx, "ROOMS.bathroom", "FAIL", `${label}: under the ${bathV} m2 legal minimum for a bathroom or cubicle.`, [bath], [r.id]));
      else out.push(make(ctx, "ROOMS.bathroom", "PASS", `${label}: at least ${bathV} m2.`, [bath], [r.id]));
    }
    const t = typical[use === "habitable" ? "" : use];
    const tv = t ? num(t.value) : null;
    if (t && tv !== null && below(r.area_m2, tv)) { typicalHits++; out.push(make(ctx, "ROOMS.typical", "ADVICE", `${label}: under Formcraft's typical ${tv} m2 (${t.key}; not law).`, [t], [r.id])); }
  }
  if (firstV === null || addV === null) out.push(missing(ctx, "ROOMS.habitable", [first, add]));
  if (kitV === null) out.push(missing(ctx, "ROOMS.kitchen", [kit]));
  if (bathV === null) out.push(missing(ctx, "ROOMS.bathroom", [bath]));
  out.push(make(ctx, "ROOMS.habitable", "NOT_CHECKED", `The extra ${num(sleep.value) ?? "?"} m2 per person sleeping in a room is not checked: the model does not say how many sleep in each room.`, [sleep]));
  if (unmapped.length) out.push(make(ctx, "ROOMS.habitable", "INFO", `${unmapped.length} room(s) have a name the room-use word list does not recognise; their areas were not checked.`, [], unmapped));
  if (f.rooms.length && !typicalHits) out.push(make(ctx, "ROOMS.typical", "INFO", "No room is under Formcraft's typical sizes.", Object.values(typical)));
  return out;
}

function evaluateEscapeFireSite(ctx: Ctx, f: PermitFacts, d: Derived, input: PermitInput): Finding[] {
  const out: Finding[] = [];
  // Stairs: Phase A does not read stair geometry; interim default Q3 holds each stair at stairsState.
  const st = ruleById("STAIRS.dims");
  const stairKeys = st.keys.map((k) => citeFor(ctx, st, k));
  for (const s of f.stairs) out.push(make(ctx, "STAIRS.dims", ctx.defaults.stairsState, `Stair ${s.type || s.id}: rise, going, width and headroom are not read in Phase A (Phase B: needs fmc_permit_facts), and the thresholds wait on dwelling vs other residential (Q3).`, stairKeys, [s.id]));
  if (!f.stairs.length) out.push(make(ctx, "STAIRS.dims", "NOT_CHECKED", "The model has no stairs.", stairKeys));

  const esc = citeFor(ctx, ruleById("ESCAPE.second_stair"), "escape.second_staircase");
  const so = num(field(esc, "storeys_over")), th = num(field(esc, "top_floor_height_over_m"));
  if (so === null || th === null) out.push(missing(ctx, "ESCAPE.second_stair", [esc]));
  else {
    const why: string[] = [];
    if (d.storeys > so) why.push(`${d.storeys} storeys (over ${so})`);
    if (d.top_floor_height_m !== null && d.top_floor_height_m > th) why.push(`top floor at ${d.top_floor_height_m} m (over ${th} m)`);
    if (!why.length) out.push(make(ctx, "ESCAPE.second_stair", "NOT_APPLICABLE", `${d.storeys} storey(s), top floor at ${d.top_floor_height_m ?? "?"} m: no second staircase trigger.`, [esc]));
    else if (f.stairs.length < 2) out.push(make(ctx, "ESCAPE.second_stair", "FAIL", `${why.join(" and ")}: a second staircase is required; the model has ${f.stairs.length}.`, [esc], f.stairs.map((s) => s.id)));
    else out.push(make(ctx, "ESCAPE.second_stair", "PASS", `${why.join(" and ")}: the model has ${f.stairs.length} stairs (whether each is a protected escape stair is not checked).`, [esc], f.stairs.map((s) => s.id)));
  }

  const comp = citeFor(ctx, ruleById("FIRE.compartment"), "fire.compartment_max_floor_area");
  const cm = num(comp.value);
  if (cm === null) out.push(missing(ctx, "FIRE.compartment", [comp]));
  else {
    const over = Object.entries(d.level_area_m2).filter(([, a]) => a > cm + EPS);
    for (const [lvl, a] of over) out.push(make(ctx, "FIRE.compartment", "REVIEW", `${lvl}: ${a} m2 of floor, over ${cm} m2. Compartments are not modelled; check the fire separation.`, [comp]));
    if (!over.length) out.push(make(ctx, "FIRE.compartment", "PASS", `No level has more than ${cm} m2 of floor.`, [comp]));
  }

  const plotRule = ruleById("SITE.plot_coverage");
  const zone = (input.plot?.zone ?? "").trim();
  const area = num(input.plot?.area_m2);
  if (!area || area <= 0 || !zone) out.push(make(ctx, "SITE.plot_coverage", "NOT_CHECKED", "Plot area and zone were not given (plot: { area_m2, zone }).", []));
  else {
    const commercial = /^commercial$/i.test(zone);
    const c = citeFor(ctx, plotRule, commercial ? "planning.commercial.plot_coverage_max" : "planning.residential.plot_coverage_max");
    const max = commercial ? num(c.value) : num(field(c, zone.toUpperCase()));
    if (!c.found) out.push(missing(ctx, "SITE.plot_coverage", [c]));
    else if (max === null) out.push(make(ctx, "SITE.plot_coverage", "NOT_CHECKED", `Zone "${zone}" is not in ${c.key}.`, [c]));
    else if (!d.footprint_m2) out.push(make(ctx, "SITE.plot_coverage", "NOT_CHECKED", "No floor on the ground level, so the footprint is unknown.", [c]));
    else {
      const cov = Math.round((d.footprint_m2 / area) * 1000) / 1000;
      out.push(make(ctx, "SITE.plot_coverage", cov > max + EPS ? "FAIL" : "PASS", `Ground-floor footprint ${d.footprint_m2} m2 on a ${area} m2 plot covers ${cov}; the zone ${zone} maximum is ${max}.`, [c]));
    }
  }
  return out;
}

export interface Evaluation { category: CategoryResult; findings: Finding[] }

export function evaluate(ctx: Ctx, f: PermitFacts, d: Derived, input: PermitInput): Evaluation {
  const { result, finding } = deriveCategory(ctx, d, input);
  const findings: Finding[] = [finding, ...evaluateClassAndSite(ctx, d, result), ...evaluatePack(ctx, f), ...evaluateRooms(ctx, f), ...evaluateEscapeFireSite(ctx, f, d, input)];
  for (const r of PERMIT_RULES) {
    if (r.phase === "A" || r.id === "STAIRS.dims" || r.id === "PACK.paper" || r.id === "PACK.other_sets") continue;
    findings.push(make(ctx, r.id, "NOT_CHECKED", r.phase === "B" ? `Phase B: needs fmc_permit_facts. ${r.summary}` : `Phase C: ${r.summary}`, []));
  }
  return { category: result, findings };
}

export function counts(findings: Finding[]): Record<string, number> {
  const c: Record<string, number> = { FAIL: 0, REVIEW: 0, PASS: 0, ADVICE: 0, NOT_CHECKED: 0, NOT_APPLICABLE: 0, INFO: 0 };
  for (const f of findings) c[f.state] = (c[f.state] ?? 0) + 1;
  return c;
}
