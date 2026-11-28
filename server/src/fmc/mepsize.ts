/**
 * fmc_mep_size, the part that does not need Revit (MEP gap tool A, plan in docs/tools/fmc_mep_size.md).
 *
 * Duct and pipe sizing by velocity and friction, pressure drop per segment (Darcy-Weisbach with the Swamee-Jain
 * friction factor, plus fitting K factors), the critical (index) path of a run tree, and voltage drop per circuit
 * from a cable table.
 *
 * Every result is a DRAFT for the engineer (CLAUDE.md rule 5: Formcraft never sizes or signs). Every value is tagged
 * with its source: standards:<key> (the standards bank), provisional:<key> (a bank default), engineer (passed on the
 * call), model:<id>, physics (a fluid property), or calc. A limit with no value is TBC, and a row that needs it is TBC.
 * Nothing here invents a limit, a size list or a cable table.
 */
import { citeLimit, type TraceBankEntry } from "./trace_bank.js";

export type Source = string;
export interface Tagged { value: number | string | null; unit?: string; source: Source }
export type Verdict = "pass" | "fail" | "TBC";

export interface MepSegment {
  id: string;
  kind: "duct" | "pipe";
  /** Design flow in L/s (air or water). */
  flow_l_s: number;
  length_m?: number;
  shape?: "round" | "rect";
  /** Round: the inside diameter. */
  size_mm?: number;
  w_mm?: number;
  h_mm?: number;
  roughness_mm?: number;
  /** Fitting loss factors on this segment (elbows, tees, dampers), summed. */
  k?: number[];
  /** The segment this one flows into or out of (towards the fan, pump or source). Empty for the root. */
  upstream?: string;
  /** Where the facts came from (for example model:123456). Defaults to engineer. */
  source?: string;
}

export interface Fluid { name: "air" | "water"; density_kg_m3: number; viscosity_m2_s: number; source: Source }

/** Physical properties at 20 °C, not design values. The call can pass its own. */
export const FLUIDS: Record<"air" | "water", Fluid> = {
  air: { name: "air", density_kg_m3: 1.204, viscosity_m2_s: 1.516e-5, source: "physics (air at 20 °C, 101.325 kPa)" },
  water: { name: "water", density_kg_m3: 998.2, viscosity_m2_s: 1.004e-6, source: "physics (water at 20 °C)" },
};

export interface MepLimitField { key: string; value: number | null; source: Source; clause: string }

export interface MepLimits {
  velocity_max_ms: MepLimitField;
  friction_max_pa_m: MepLimitField;
  roughness_mm: MepLimitField;
  vd_pct: MepLimitField;
  vd_pct_lighting: MepLimitField;
  provisional: boolean;
  tbc: string[];
}

export type LimitOverrides = Partial<Record<"velocity_max_ms" | "friction_max_pa_m" | "roughness_mm" | "vd_pct" | "vd_pct_lighting", number>>;

/** Bank keys per kind. A key the bank lacks is TBC (null), never a number from code. */
export const MEP_KEYS = {
  duct: { velocity: "mep.duct_velocity_max_ms", friction: "mep.duct_friction_max_pa_m", roughness: "mep.duct_roughness_mm" },
  pipe: { velocity: "mep.pipe_velocity_max_ms", friction: "mep.pipe_friction_max_pa_m", roughness: "mep.pipe_roughness_mm" },
  vd: "trace.voltage_drop_pct",
  vd_lighting: "mep.voltage_drop_pct_lighting",
} as const;

function field(key: string, bank: Record<string, TraceBankEntry> | undefined, override?: number): MepLimitField {
  if (typeof override === "number" && Number.isFinite(override)) return { key, value: override, source: "engineer", clause: "Passed on this call." };
  const cited = citeLimit(key, bank);
  if (cited.value == null) return { key, value: null, source: "TBC", clause: `TBC. ${cited.clause}` };
  if (cited.source === "standards") return { key, value: cited.value, source: `standards:${key}`, clause: cited.clause };
  return { key, value: cited.value, source: `provisional:${key}`, clause: `PROVISIONAL. ${cited.clause}` };
}

export function mepLimits(kind: "duct" | "pipe", bank?: Record<string, TraceBankEntry>, overrides: LimitOverrides = {}): MepLimits {
  const keys = MEP_KEYS[kind];
  const out = {
    velocity_max_ms: field(keys.velocity, bank, overrides.velocity_max_ms),
    friction_max_pa_m: field(keys.friction, bank, overrides.friction_max_pa_m),
    roughness_mm: field(keys.roughness, bank, overrides.roughness_mm),
    vd_pct: field(MEP_KEYS.vd, bank, overrides.vd_pct),
    vd_pct_lighting: field(MEP_KEYS.vd_lighting, bank, overrides.vd_pct_lighting),
  };
  const all = Object.values(out);
  return {
    ...out,
    provisional: all.some((f) => f.source.startsWith("provisional") || f.source === "TBC"),
    tbc: all.filter((f) => f.value == null).map((f) => f.key),
  };
}

export const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/** Area (m²) and hydraulic diameter (m) of a round or rectangular section given in mm. */
export function section(seg: Pick<MepSegment, "shape" | "size_mm" | "w_mm" | "h_mm">): { area_m2: number; dh_m: number } | null {
  if ((seg.shape ?? "round") === "rect") {
    const w = (seg.w_mm ?? 0) / 1000, h = (seg.h_mm ?? 0) / 1000;
    if (w <= 0 || h <= 0) return null;
    return { area_m2: w * h, dh_m: (2 * w * h) / (w + h) };
  }
  const d = (seg.size_mm ?? 0) / 1000;
  if (d <= 0) return null;
  return { area_m2: (Math.PI * d * d) / 4, dh_m: d };
}

export function velocity(flowLs: number, areaM2: number): number {
  return flowLs / 1000 / areaM2;
}

/** Darcy friction factor: 64/Re when laminar (Re < 2300), else Swamee-Jain (explicit Colebrook, within about 1 %). */
export function frictionFactor(re: number, roughnessM: number, dhM: number): number {
  if (re <= 0) return 0;
  if (re < 2300) return 64 / re;
  const term = roughnessM / (3.7 * dhM) + 5.74 / re ** 0.9;
  return 0.25 / Math.log10(term) ** 2;
}

export interface Flow { velocity_ms: number; re: number; f: number | null; friction_pa_m: number | null; dynamic_pa: number }

export function flowAt(flowLs: number, sec: { area_m2: number; dh_m: number }, fluid: Fluid, roughnessMm: number | null): Flow {
  const v = velocity(flowLs, sec.area_m2);
  const re = (v * sec.dh_m) / fluid.viscosity_m2_s;
  const dynamic = (fluid.density_kg_m3 * v * v) / 2;
  if (roughnessMm == null) return { velocity_ms: v, re, f: null, friction_pa_m: null, dynamic_pa: dynamic };
  const f = frictionFactor(re, roughnessMm / 1000, sec.dh_m);
  return { velocity_ms: v, re, f, friction_pa_m: (f / sec.dh_m) * dynamic, dynamic_pa: dynamic };
}

export interface SizeRow {
  id: string;
  kind: "duct" | "pipe" | "circuit";
  values: Record<string, Tagged>;
  verdict: Verdict;
  note?: string;
}

/**
 * The smallest standard round size whose velocity and friction are within the limits. The list of sizes must come
 * from the call (the type's size table or the engineer); without one only the minimum diameter by velocity is given.
 */
export function sizeRound(seg: MepSegment, limits: MepLimits, fluid: Fluid, sizes: number[]): SizeRow {
  const src = seg.source || "engineer";
  const vmax = limits.velocity_max_ms.value, fmax = limits.friction_max_pa_m.value, rough = limits.roughness_mm.value;
  const values: Record<string, Tagged> = {
    flow: { value: seg.flow_l_s, unit: "L/s", source: src },
    velocity_max: { value: vmax, unit: "m/s", source: limits.velocity_max_ms.source },
    friction_max: { value: fmax, unit: "Pa/m", source: limits.friction_max_pa_m.source },
  };
  if (!(seg.flow_l_s > 0)) return { id: seg.id, kind: seg.kind, values, verdict: "TBC", note: "No design flow." };
  if (vmax == null) return { id: seg.id, kind: seg.kind, values, verdict: "TBC", note: `Velocity limit TBC (${limits.velocity_max_ms.key}).` };
  const dMin = Math.sqrt((4 * (seg.flow_l_s / 1000)) / (Math.PI * vmax)) * 1000;
  values.min_diameter = { value: round(dMin, 0), unit: "mm", source: "calc" };
  const sorted = [...new Set(sizes.filter((s) => s > 0))].sort((a, b) => a - b);
  if (!sorted.length) return { id: seg.id, kind: seg.kind, values, verdict: "TBC", note: "No standard size list. Pass standard_sizes_mm from the type's size table." };
  for (const size of sorted) {
    const sec = section({ shape: "round", size_mm: size })!;
    const fl = flowAt(seg.flow_l_s, sec, fluid, rough);
    if (fl.velocity_ms > vmax + 1e-9) continue;
    if (fmax != null && fl.friction_pa_m != null && fl.friction_pa_m > fmax + 1e-9) continue;
    values.proposed_size = { value: size, unit: "mm", source: "calc" };
    values.velocity = { value: round(fl.velocity_ms, 2), unit: "m/s", source: "calc" };
    values.friction = { value: fl.friction_pa_m == null ? null : round(fl.friction_pa_m, 2), unit: "Pa/m", source: fl.friction_pa_m == null ? "TBC" : "calc" };
    const tbc = fmax == null || rough == null;
    return { id: seg.id, kind: seg.kind, values, verdict: tbc ? "TBC" : "pass", note: tbc ? "Velocity checked; friction TBC (no limit or no roughness)." : undefined };
  }
  return { id: seg.id, kind: seg.kind, values, verdict: "fail", note: `No size in the list up to ${sorted[sorted.length - 1]} mm meets the limits.` };
}

/** Check an existing segment: velocity, friction, friction loss, fitting loss and total loss. */
export function checkSegment(seg: MepSegment, limits: MepLimits, fluid: Fluid): SizeRow & { loss_pa: number | null } {
  const src = seg.source || "engineer";
  const sec = section(seg);
  const values: Record<string, Tagged> = { flow: { value: seg.flow_l_s, unit: "L/s", source: src } };
  if (!sec) return { id: seg.id, kind: seg.kind, values, verdict: "TBC", note: "No size.", loss_pa: null };
  const rough = seg.roughness_mm ?? limits.roughness_mm.value;
  const roughSrc = seg.roughness_mm != null ? src : limits.roughness_mm.source;
  const fl = flowAt(seg.flow_l_s, sec, fluid, rough);
  const sumK = (seg.k ?? []).reduce((a, b) => a + b, 0);
  const length = seg.length_m ?? 0;
  const frictionLoss = fl.friction_pa_m == null ? null : fl.friction_pa_m * length;
  const fittingLoss = sumK * fl.dynamic_pa;
  const loss = frictionLoss == null ? null : frictionLoss + fittingLoss;
  Object.assign(values, {
    size: (seg.shape ?? "round") === "rect" ? { value: `${seg.w_mm}x${seg.h_mm}`, unit: "mm", source: src } : { value: seg.size_mm ?? null, unit: "mm", source: src },
    length: { value: length, unit: "m", source: src },
    roughness: { value: rough, unit: "mm", source: roughSrc },
    velocity: { value: round(fl.velocity_ms, 2), unit: "m/s", source: "calc" },
    reynolds: { value: round(fl.re, 0), source: "calc" },
    friction: { value: fl.friction_pa_m == null ? null : round(fl.friction_pa_m, 3), unit: "Pa/m", source: fl.friction_pa_m == null ? "TBC" : "calc" },
    sum_k: { value: round(sumK, 3), source: src },
    fitting_loss: { value: round(fittingLoss, 1), unit: "Pa", source: "calc" },
    loss: { value: loss == null ? null : round(loss, 1), unit: "Pa", source: loss == null ? "TBC" : "calc" },
  });
  const vmax = limits.velocity_max_ms.value, fmax = limits.friction_max_pa_m.value;
  const fails: string[] = [];
  if (vmax != null && fl.velocity_ms > vmax + 1e-9) fails.push(`velocity ${round(fl.velocity_ms, 2)} > ${vmax} m/s`);
  if (fmax != null && fl.friction_pa_m != null && fl.friction_pa_m > fmax + 1e-9) fails.push(`friction ${round(fl.friction_pa_m, 2)} > ${fmax} Pa/m`);
  const tbc = vmax == null || fmax == null || fl.friction_pa_m == null;
  return { id: seg.id, kind: seg.kind, values, verdict: fails.length ? "fail" : tbc ? "TBC" : "pass", note: fails.join("; ") || undefined, loss_pa: loss };
}

export interface CriticalPath { path: string[]; loss_pa: number | null; tbc: string[]; problems: string[] }

/**
 * The index run: the root-to-leaf path with the largest summed loss. A segment's parent is `upstream`. A cycle or a
 * missing parent is reported, not guessed. A path with a TBC loss is listed in `tbc` and is never the critical path.
 */
export function criticalPath(segments: MepSegment[], losses: Map<string, number | null>): CriticalPath {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const problems: string[] = [];
  const children = new Set(segments.map((s) => s.upstream).filter((u): u is string => !!u));
  const leaves = segments.filter((s) => !children.has(s.id));
  let best: { path: string[]; loss: number } | null = null;
  const tbc: string[] = [];
  for (const leaf of leaves) {
    const path: string[] = [];
    const seen = new Set<string>();
    let at: MepSegment | undefined = leaf;
    let total = 0, unknown = false, broken = false;
    while (at) {
      if (seen.has(at.id)) { problems.push(`Cycle at ${at.id}.`); broken = true; break; }
      seen.add(at.id);
      path.push(at.id);
      const loss = losses.get(at.id);
      if (loss == null) unknown = true; else total += loss;
      if (!at.upstream) break;
      const next = byId.get(at.upstream);
      if (!next) { problems.push(`${at.id}: upstream ${at.upstream} is not in the list.`); broken = true; break; }
      at = next;
    }
    if (broken) continue;
    const ordered = path.reverse();
    if (unknown) { tbc.push(ordered.join(" > ")); continue; }
    if (!best || total > best.loss) best = { path: ordered, loss: total };
  }
  return { path: best?.path ?? [], loss_pa: best ? round(best.loss, 1) : null, tbc, problems: [...new Set(problems)] };
}

// ---------- voltage drop ----------

export interface CircuitIn {
  id: string;
  voltage_v: number | null;
  current_a: number | null;
  length_m: number | null;
  lighting?: boolean;
  cable_spec?: string;
  wire_size?: string;
  source?: string;
}

export interface CableRow {
  /** The cable product or type name, matched to the circuit's cable_spec when both are given. */
  spec?: string;
  size_mm2: number;
  mv_a_m: number;
  rating_a?: number;
  source?: string;
}

/** Conductor size in mm² from Revit's wire size text ("2#2.5mm², 1#2.5mm²", "3#16"); same rule as calc/volt_drop.ts. */
export function cableSize(wire: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*mm/i.exec(wire) ?? /#\s*(\d+(?:\.\d+)?)/.exec(wire) ?? /^\s*(\d+(?:\.\d+)?)\s*$/.exec(wire);
  return m ? Number(m[1]) : null;
}

/** VD (V) = ROUND(mV/A/m x Ib x L / 1000, 2) and VD % = ROUND(VD / V x 100, 2), as the kit's Calc_E_VoltDrop. */
export function vd(mvAm: number, currentA: number, lengthM: number, voltageV: number): { v: number; pct: number } {
  const v = round((mvAm * currentA * lengthM) / 1000, 2);
  return { v, pct: round((v / voltageV) * 100, 2) };
}

export function voltageDropRow(c: CircuitIn, cables: CableRow[], limits: MepLimits): SizeRow {
  const src = c.source || "engineer";
  const limit = c.lighting ? (limits.vd_pct_lighting.value != null ? limits.vd_pct_lighting : limits.vd_pct) : limits.vd_pct;
  const values: Record<string, Tagged> = {
    voltage: { value: c.voltage_v, unit: "V", source: c.voltage_v ? src : "TBC" },
    current: { value: c.current_a, unit: "A", source: c.current_a ? src : "TBC" },
    length: { value: c.length_m, unit: "m", source: c.length_m ? src : "TBC" },
    limit: { value: limit.value, unit: "%", source: limit.source },
    cable_spec: { value: c.cable_spec ?? null, source: c.cable_spec ? src : "TBC" },
  };
  if (!c.voltage_v || !c.current_a || !c.length_m) return finish("TBC", "Voltage, current or length is missing.");
  const spec = (c.cable_spec ?? "").trim().toLowerCase();
  const pool = cables.filter((k) => k.size_mm2 > 0 && k.mv_a_m > 0 && (!spec || !k.spec || k.spec.trim().toLowerCase() === spec));
  const existing = cableSize(c.wire_size ?? "");
  if (existing != null) values.wire_size = { value: existing, unit: "mm²", source: src };
  if (!pool.length) return finish("TBC", cables.length ? `No cable in the table matches ${c.cable_spec}.` : "No cable table (mV/A/m). Pass cables from the kit or the engineer.");
  const sorted = [...pool].sort((a, b) => a.size_mm2 - b.size_mm2);
  const atExisting = existing == null ? undefined : sorted.find((k) => k.size_mm2 === existing);
  if (atExisting) {
    const d = vd(atExisting.mv_a_m, c.current_a, c.length_m, c.voltage_v);
    values.vd_existing = { value: d.v, unit: "V", source: "calc" };
    values.vd_existing_pct = { value: d.pct, unit: "%", source: "calc" };
  }
  if (limit.value == null) return finish("TBC", `Voltage drop limit TBC (${limit.key}).`);
  for (const k of sorted) {
    if (k.rating_a != null && k.rating_a < c.current_a) continue;
    const d = vd(k.mv_a_m, c.current_a, c.length_m, c.voltage_v);
    if (d.pct > limit.value + 1e-9) continue;
    values.proposed_size = { value: k.size_mm2, unit: "mm²", source: k.source || "engineer" };
    values.mv_a_m = { value: k.mv_a_m, unit: "mV/A/m", source: k.source || "engineer" };
    values.vd = { value: d.v, unit: "V", source: "calc" };
    values.vd_pct = { value: d.pct, unit: "%", source: "calc" };
    const existingFails = values.vd_existing_pct?.value != null && Number(values.vd_existing_pct.value) > limit.value;
    const tooSmall = existing != null && existing < k.size_mm2;
    return finish(existingFails || tooSmall ? "fail" : "pass", existingFails || tooSmall ? `The modelled ${existing} mm² is below the proposed ${k.size_mm2} mm².` : undefined);
  }
  return finish("fail", "No cable in the table meets the limit and the current.");

  function finish(verdict: Verdict, note?: string): SizeRow {
    return { id: c.id, kind: "circuit", values, verdict, note };
  }
}

export function summary(rows: Array<{ verdict: Verdict }>): { pass: number; fail: number; tbc: number; result: Verdict | "no input" } {
  const pass = rows.filter((r) => r.verdict === "pass").length;
  const fail = rows.filter((r) => r.verdict === "fail").length;
  const tbc = rows.filter((r) => r.verdict === "TBC").length;
  return { pass, fail, tbc, result: !rows.length ? "no input" : fail ? "fail" : tbc ? "TBC" : "pass" };
}

export const DRAFT = "DRAFT for the engineer to check and sign. Formcraft does not size or sign (CLAUDE.md rule 5).";
