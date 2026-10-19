import { Tabs, calculationsRegister } from "./kit.js";
import { CalcResult, EngineerInputs, Facts, Row, Tbc, verdict } from "./types.js";

/** A value the kit gives (or doesn't) for a calc, as `list` shows it. */
export interface KitItem { name: string; value: string | number | null; source: string }

export interface CalcDef {
  id: string;
  role: string;
  /** What the calc reads from the model. */
  inputs: string[];
  /** The kit's values this calc uses: provided ones with their cell, and those the kit doesn't have. */
  kit(tabs: Tabs): { provided: KitItem[]; missing: string[] };
  run(facts: Facts, tabs: Tabs, eng: EngineerInputs): CalcResult;
}

/** Title and method from the kit's Calculations register. */
export function registerEntry(tabs: Tabs, id: string) {
  const r = calculationsRegister(tabs).find((x) => x.id === id);
  return { title: r?.title ?? id, method: r?.method ?? "", method_source: r ? r.source.replace(/!A(\d+)$/, "!C$1") : "TBC" };
}

export function result(tabs: Tabs, id: string, role: string, rows: Row[], totals: Row[], tbc: Tbc[], notes: string[]): CalcResult {
  return { id, role, ...registerEntry(tabs, id), rows, totals, tbc, notes, result: verdict(rows, totals, tbc) };
}

/** Lower-case words of a name: "FMC_P_WashBasin_600" → wash, basin, 600 (camelCase and _ split). */
export function words(s: string): string[] {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
}

/** The words of a kit label that name the thing (numbers and units dropped): "WC 6 L" → wc; "Floor gully 100" → floor, gully. */
export function labelWords(label: string): string[] {
  return words(label.replace(/\(.*?\)/g, "")).filter((w) => !/^[\d.]+$/.test(w) && !["l", "mm", "m", "nr", "of"].includes(w));
}
