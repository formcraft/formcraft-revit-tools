/**
 * F79 (E3): electrical enrich and sizing, folded into the one plugin through kit parameters. Pure planner: no Revit, no
 * file writes. Everything it returns is a DRAFT; the engineer's name stays empty and the engineer signs (rule 5).
 * Formcraft never picks a demand factor, a power factor, a cable table or a voltage-drop limit: they are inputs the
 * engineer (or the kit) supplies, and a missing one makes the row TBC, never a default.
 * Parameters come from the kit (rule 7). The 16 that FormCraft Electrical 0.1 writes are not in the kit yet, so they are
 * listed here as ASSUMED names for a kit change request; a parameter that the kit file lacks is never written.
 */
import fs from "node:fs";

export type Group = "enrich" | "size" | "control";
export interface ElecParam { name: string; group: Group; on: "device" | "circuit" | "both"; type: "Number" | "Text" | "Integer" | "YesNo"; unit?: string; about: string }

/** The 16 FMC_ parameters FormCraft Electrical 0.1 writes (docs/IDEAS.md). Names are ASSUMED until the kit adopts or renames them. */
export const ELEC_PARAMS: ElecParam[] = [
  { name: "FMC_E_Connected_VA", group: "enrich", on: "device", type: "Number", unit: "VA", about: "Connected apparent load of the device" },
  { name: "FMC_E_Power_Factor", group: "enrich", on: "device", type: "Number", about: "Power factor, from the manufacturer's data only" },
  { name: "FMC_E_Phases", group: "enrich", on: "device", type: "Integer", about: "1 or 3" },
  { name: "FMC_E_Voltage_V", group: "enrich", on: "both", type: "Number", unit: "V", about: "Nominal voltage" },
  { name: "FMC_E_Load_Class", group: "enrich", on: "device", type: "Text", about: "Load class used by the demand calculation (CA-E-01)" },
  { name: "FMC_E_Demand_Factor", group: "size", on: "circuit", type: "Number", about: "Engineer's demand factor; never defaulted" },
  { name: "FMC_E_Demand_VA", group: "size", on: "circuit", type: "Number", unit: "VA", about: "Connected load times the engineer's demand factor" },
  { name: "FMC_E_Design_Current_A", group: "size", on: "circuit", type: "Number", unit: "A", about: "Design current Ib" },
  { name: "FMC_E_Breaker_Rating_A", group: "size", on: "circuit", type: "Number", unit: "A", about: "Draft protective device rating In" },
  { name: "FMC_E_Cable_Size_mm2", group: "size", on: "circuit", type: "Number", unit: "mm2", about: "Draft conductor size" },
  { name: "FMC_E_Cable_Length_m", group: "size", on: "circuit", type: "Number", unit: "m", about: "Route length used for voltage drop" },
  { name: "FMC_E_VD_Percent", group: "size", on: "circuit", type: "Number", unit: "%", about: "Calculated voltage drop" },
  { name: "FMC_E_VD_Limit_Percent", group: "size", on: "circuit", type: "Number", unit: "%", about: "The limit the engineer or the kit set" },
  { name: "FMC_E_Sizing_Status", group: "control", on: "circuit", type: "Text", about: "Draft, TBC or Checked; Formcraft only writes Draft or TBC" },
  { name: "FMC_E_Engineer", group: "control", on: "circuit", type: "Text", about: "Signing engineer; Formcraft always leaves it empty" },
  { name: "FMC_E_Assumed", group: "control", on: "both", type: "YesNo", about: "Yes while any value rests on an assumption" },
];

/** Names in a Revit shared parameter file (PARAM lines: PARAM, guid, name, ...). */
export function sharedParameterNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split("\t");
    if (c[0] === "PARAM" && c[2]) out.push(c[2].trim());
  }
  return out;
}

export function readKitParameterNames(file: string): { names: string[]; problem: string } {
  try {
    if (!file) return { names: [], problem: "No shared parameter file given: every electrical parameter counts as missing from the kit." };
    return { names: sharedParameterNames(fs.readFileSync(file, "utf8")), problem: "" };
  } catch (e) { return { names: [], problem: `Cannot read the shared parameter file: ${(e as Error).message}` }; }
}

export function missingFromKit(kitNames: string[]): ElecParam[] {
  const have = new Set(kitNames.map((n) => n.toLowerCase()));
  return ELEC_PARAMS.filter((p) => !have.has(p.name.toLowerCase()));
}

/** The kit change request (rule 7): each missing parameter with its values marked "assumed". A person approves before any is used. */
export function kitChangeRequest(kitNames: string[]) {
  const missing = missingFromKit(kitNames);
  return {
    title: "Kit change request: electrical parameters for Enrich and Size (E3, F79)",
    status: "assumed",
    note: "All names and types below are assumed from FormCraft Electrical 0.1. A person approves the request (and may rename) before any value is written to a model.",
    total: ELEC_PARAMS.length, missing: missing.length,
    parameters: missing.map((p) => ({ name: p.name, group: p.group, applies_to: p.on, type: p.type, unit: p.unit ?? "", about: p.about, value_status: "assumed" })),
  };
}

export interface DeviceFact { id: number | string; name?: string; category?: string; va?: number | null; watts?: number | null; power_factor?: number | null; phases?: number | null; voltage_v?: number | null; load_class?: string | null }
export interface Write { element_id: string; parameter: string; value: string | number; source: string }
export interface Skip { element_id: string; parameter: string; reason: string }
export interface Tbc { element_id: string; item: string; missing: string }

const nz = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Enrich: derive load data on devices from facts that are on the model. A missing fact is TBC (no default). */
export function planEnrich(devices: DeviceFact[], kitNames: string[]) {
  const have = new Set(kitNames.map((n) => n.toLowerCase()));
  const writes: Write[] = []; const skipped: Skip[] = []; const tbc: Tbc[] = [];
  const put = (id: string, parameter: string, value: string | number, source: string) => {
    if (!have.has(parameter.toLowerCase())) skipped.push({ element_id: id, parameter, reason: "not in the kit's shared parameter file (kit change request)" });
    else writes.push({ element_id: id, parameter, value, source });
  };
  for (const d of devices) {
    const id = String(d.id);
    let va: number | null = nz(d.va) && d.va >= 0 ? d.va : null; let vaSource = "model: apparent power";
    if (va === null && nz(d.watts) && d.watts >= 0) {
      if (nz(d.power_factor) && d.power_factor > 0 && d.power_factor <= 1) { va = r2(d.watts / d.power_factor); vaSource = "calculated: watts / power factor"; }
      else tbc.push({ element_id: id, item: "FMC_E_Connected_VA", missing: "power factor (from the manufacturer; Formcraft does not assume one)" });
    } else if (va === null) tbc.push({ element_id: id, item: "FMC_E_Connected_VA", missing: "apparent power or watts" });
    if (va !== null) put(id, "FMC_E_Connected_VA", r2(va), vaSource);
    if (nz(d.power_factor) && d.power_factor > 0 && d.power_factor <= 1) put(id, "FMC_E_Power_Factor", d.power_factor, "model: power factor");
    if (d.phases === 1 || d.phases === 3) put(id, "FMC_E_Phases", d.phases, "model: phases");
    else if (d.phases !== undefined && d.phases !== null) tbc.push({ element_id: id, item: "FMC_E_Phases", missing: "phases must be 1 or 3" });
    if (nz(d.voltage_v) && d.voltage_v > 0) put(id, "FMC_E_Voltage_V", d.voltage_v, "model: voltage");
    if (typeof d.load_class === "string" && d.load_class.trim()) put(id, "FMC_E_Load_Class", d.load_class.trim(), "model: load class");
  }
  return { draft: true, engineer: "", writes, skipped, tbc, csv: writesCsv(writes) };
}

/** CSV with an ElementId column and one column per parameter: the layout fmc_params fill_csv reads. */
export function writesCsv(writes: Write[]): string {
  const cols = [...new Set(writes.map((w) => w.parameter))];
  const ids = [...new Set(writes.map((w) => w.element_id))];
  const q = (s: string | number) => { const t = String(s); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = ids.map((id) => [id, ...cols.map((c) => { const w = writes.find((x) => x.element_id === id && x.parameter === c); return w ? q(w.value) : ""; })].join(","));
  return [["ElementId", ...cols].join(","), ...rows].join("\n");
}

export interface CircuitFact { id: number | string; name?: string; connected_va: number; voltage_v: number; phases: 1 | 3; length_m?: number | null; demand_factor?: number | null; power_factor?: number | null }
export interface CableRow { size_mm2: number; rating_a: number; mv_per_a_m: number }
export interface SizingInputs {
  cable_table?: CableRow[];            // the kit's table or the engineer's: current rating and mV/A/m for the circuit's system
  breaker_ratings_a?: number[];        // the standard ratings the engineer allows
  vd_limit_percent?: number | null;    // the engineer's or kit's limit
  derating?: number | null;            // grouping and ambient factor, 0 < k <= 1; the engineer supplies it
  demand_factor?: number | null;       // fallback for circuits that carry none
}
export interface SizedCircuit {
  circuit: string; status: "Draft" | "TBC"; engineer: string; assumed: boolean;
  demand_va?: number; design_current_a?: number; breaker_a?: number; cable_mm2?: number; vd_percent?: number; vd_limit_percent?: number;
  missing: string[]; notes: string[];
}

/** Size: draft a breaker and cable for each circuit from the engineer's inputs. A missing input is TBC; nothing is defaulted. */
export function planSizing(circuits: CircuitFact[], inp: SizingInputs) {
  const table = [...(inp.cable_table ?? [])].filter((c) => nz(c.size_mm2) && nz(c.rating_a) && nz(c.mv_per_a_m)).sort((a, b) => a.size_mm2 - b.size_mm2);
  const breakers = [...(inp.breaker_ratings_a ?? [])].filter(nz).sort((a, b) => a - b);
  const rows: SizedCircuit[] = [];
  for (const c of circuits) {
    const out: SizedCircuit = { circuit: String(c.name ?? c.id), status: "TBC", engineer: "", assumed: false, missing: [], notes: [] };
    const df = nz(c.demand_factor) ? c.demand_factor : nz(inp.demand_factor) ? inp.demand_factor : null;
    if (df === null || df <= 0 || df > 1) out.missing.push("demand factor (engineer's, 0 to 1)");
    if (!table.length) out.missing.push("cable table (kit or engineer: size, current rating, mV/A/m)");
    if (!breakers.length) out.missing.push("breaker ratings allowed");
    if (!nz(inp.vd_limit_percent) || inp.vd_limit_percent <= 0) out.missing.push("voltage drop limit");
    if (!nz(inp.derating) || inp.derating <= 0 || inp.derating > 1) out.missing.push("derating factor (grouping, ambient)");
    if (!nz(c.length_m) || c.length_m <= 0) out.missing.push("route length");
    if (!nz(c.voltage_v) || c.voltage_v <= 0 || !nz(c.connected_va) || c.connected_va < 0 || (c.phases !== 1 && c.phases !== 3)) out.missing.push("connected load, voltage and phases");
    if (out.missing.length) { rows.push(out); continue; }
    const demand = c.connected_va * (df as number);
    const ib = demand / (c.phases === 3 ? Math.sqrt(3) * c.voltage_v : c.voltage_v);
    const k = inp.derating as number;
    const inRating = breakers.find((b) => b >= ib);
    out.demand_va = r2(demand); out.design_current_a = r2(ib); out.vd_limit_percent = inp.vd_limit_percent as number;
    if (inRating === undefined) { out.missing.push("a breaker rating at or above the design current"); out.notes.push(`Design current ${r2(ib)} A is above the largest allowed rating.`); rows.push(out); continue; }
    out.breaker_a = inRating;
    const fit = table.filter((t) => t.rating_a * k >= inRating);
    let chosen: CableRow | undefined; let vd = 0;
    for (const t of fit) {
      vd = (t.mv_per_a_m * ib * (c.length_m as number)) / 1000 / c.voltage_v * 100;
      if (vd <= (inp.vd_limit_percent as number)) { chosen = t; break; }
    }
    if (!chosen) { out.missing.push(fit.length ? "a cable in the table that keeps voltage drop within the limit" : "a cable in the table that carries the breaker rating after derating"); rows.push(out); continue; }
    out.cable_mm2 = chosen.size_mm2; out.vd_percent = r2(vd); out.status = "Draft"; out.assumed = false;
    out.notes.push("Draft for the engineer to check and sign. Formcraft does not size or sign.");
    rows.push(out);
  }
  const tbc = rows.filter((r) => r.status === "TBC").length;
  return { draft: true, engineer: "", circuits: rows, totals: { circuits: rows.length, draft: rows.length - tbc, tbc }, header: "Draft for the engineer to check and sign — Formcraft does not size or sign" };
}

/** Turn sized circuits into parameter writes, only for parameters the kit has. Status is Draft or TBC; the engineer stays empty. */
export function sizingWrites(rows: SizedCircuit[], ids: Record<string, string>, kitNames: string[]) {
  const have = new Set(kitNames.map((n) => n.toLowerCase()));
  const writes: Write[] = []; const skipped: Skip[] = [];
  for (const r of rows) {
    const id = ids[r.circuit]; if (!id) continue;
    const vals: Array<[string, string | number | undefined]> = [
      ["FMC_E_Demand_VA", r.demand_va], ["FMC_E_Design_Current_A", r.design_current_a], ["FMC_E_Breaker_Rating_A", r.breaker_a],
      ["FMC_E_Cable_Size_mm2", r.cable_mm2], ["FMC_E_VD_Percent", r.vd_percent], ["FMC_E_VD_Limit_Percent", r.vd_limit_percent],
      ["FMC_E_Sizing_Status", r.status],
    ];
    for (const [parameter, value] of vals) {
      if (value === undefined) continue;
      if (!have.has(parameter.toLowerCase())) skipped.push({ element_id: id, parameter, reason: "not in the kit's shared parameter file (kit change request)" });
      else writes.push({ element_id: id, parameter, value, source: "draft sizing (engineer signs)" });
    }
  }
  return { writes, skipped, csv: writesCsv(writes) };
}