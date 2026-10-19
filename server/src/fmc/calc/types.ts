/**
 * E1 MEP calculations: the shapes every calc shares. A calc is a pure function: facts read from the model plus the kit's
 * own values in, result rows out. Every value says where it came from:
 *   kit:<tab>!<cell>   a value in the kit workbook (FMC_Revit_Kit.xlsx), never one written in code (CLAUDE.md rule 7)
 *   model:<id>         read from the Revit element with that id ("model" alone: a sum over the model)
 *   engineer           given by the engineer in the call (inputs)
 *   calc               worked out here from the values above, with the kit's formula
 *   TBC                missing: the engineer sets it, or the kit adds it (rule 5: Formcraft never decides it)
 */
export type Source = string;
export type Verdict = "pass" | "fail" | "TBC";

export interface Val { value: number | string | null; unit?: string; source: Source }
export interface Check { rule: string; result: Verdict; source: Source }
export interface Row { item: string; values: Record<string, Val>; check?: Check; note?: string }
/** A missing value. kit_request: the kit lacks it (a kit change request); otherwise the model or the engineer does. */
export interface Tbc { item: string; missing: string; kit_request: boolean }

export interface CalcResult {
  id: string;
  title: string;
  role: string;
  method: string;
  method_source: Source;
  rows: Row[];
  totals: Row[];
  tbc: Tbc[];
  notes: string[];
  result: Verdict | "no input";
}

// ---------- facts from Revit (fmc_mep_facts and fmc_electrical_facts) ----------

export interface RoomFact { id: number; kind?: string; name: string; number?: string; level: string; area_m2: number; population: number | null; occupancy: string; x_mm?: number | null; y_mm?: number | null }
export interface FixtureFact { id: number; family: string; type: string; level?: string; room?: string; du: number | null; pipe_system?: string }
export interface TankFact { id: number; family: string; type: string; capacity_l: number | null }
export interface FireFact { id: number; kind: string; family: string; type: string; level: string; rating: string; hose_length_m: number | null; x_mm?: number | null; y_mm?: number | null }
export interface LpFact { id: number; family: string; type: string; part: string; mark: string; level?: string; earth_resistance_ohm: number | null }
export interface CircuitFact {
  id: number; board: string; number: string; load_name: string; classes: string; voltage_v: number | null; current_a: number | null;
  true_load_w: number | null; apparent_load_va: number | null; length_m: number | null; wire_size: string; rating_a?: number | null; poles?: number | null;
  feeds_board: boolean; cable_spec?: string;
}
export interface BoardFact { id: number; name: string; connected_va: number; demand_va: number; distribution?: string; fed_by?: string }

export interface MepFacts {
  model?: string;
  rooms?: RoomFact[];
  plumbing_fixtures?: FixtureFact[];
  pipe_systems?: Array<{ id: number; name: string; classification: string }>;
  tanks?: TankFact[];
  fire_devices?: FireFact[];
  lp_parts?: LpFact[];
  circuits?: CircuitFact[];
  counts?: Record<string, number>;
}
export interface Facts { mep: MepFacts; boards: BoardFact[] }

/** What the engineer may give in the call where the kit has no value (each is tagged "engineer"). */
export interface EngineerInputs {
  /** CA-E-02: mV/A/m by cable size in mm2 ("2.5": 18), for the installation method the engineer chose. */
  mv_a_m?: Record<string, number>;
  /** CA-FP-02: hose reel throw in m. */
  hose_throw_m?: number;
  /** CA-LP-02: design earth resistance target in ohm. */
  earth_target_ohm?: number;
  /** CA-E-01: single-phase units to share over L1-L3 (from the brief). */
  single_phase_units?: number;
}

// ---------- helpers ----------

export const val = (value: number | string | null, source: Source, unit?: string): Val => (unit ? { value, unit, source } : { value, source });
export const tbcVal = (unit?: string): Val => val(null, "TBC", unit);

/** Excel's ROUND (half away from zero), after taking off floating-point noise as Excel does (15 digits). */
export function round(x: number, digits = 0): number {
  const f = 10 ** digits;
  const clean = Number((Math.abs(x) * f).toPrecision(15));
  return (Math.sign(x) * Math.round(clean)) / f;
}

/** Excel's ROUNDUP to whole numbers (away from zero). */
export function roundUp(x: number): number {
  const clean = Number(Math.abs(x).toPrecision(15));
  return Math.sign(x) * Math.ceil(clean);
}

/** The calc's overall result: fail over TBC over pass; no rows is "no input". */
export function verdict(rows: Row[], totals: Row[], tbc: Tbc[]): CalcResult["result"] {
  const checks = [...rows, ...totals].map((r) => r.check?.result).filter(Boolean) as Verdict[];
  if (!rows.length && !totals.some((t) => Object.values(t.values).some((v) => v.value !== null))) return "no input";
  if (checks.includes("fail")) return "fail";
  if (checks.includes("TBC") || tbc.length) return "TBC";
  return "pass";
}

/** Add a TBC once (same item and missing text). */
export function addTbc(list: Tbc[], t: Tbc) {
  if (!list.some((x) => x.item === t.item && x.missing === t.missing)) list.push(t);
}

export const num = (s: unknown): number | null => {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  if (typeof s !== "string" || !s.trim()) return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};
