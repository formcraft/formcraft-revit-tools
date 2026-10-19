/**
 * E1 MEP calculations from the kit: the calcs ported to code, the ones the kit leaves to another tool, and running them.
 * Pure: facts and kit tabs in, results out. The tool (tools/fmc_calc.ts) reads Revit and the kit and writes the sheets.
 */
import { CalcDef, KitItem } from "./common.js";
import { Tabs, calculationsRegister } from "./kit.js";
import { maxDemand } from "./max_demand.js";
import { voltDrop } from "./volt_drop.js";
import { water } from "./water.js";
import { drainage } from "./drainage.js";
import { extinguishers, hoseReels } from "./fire.js";
import { earth } from "./earth.js";
import { CalcResult, EngineerInputs, Facts } from "./types.js";

export const CALCS: CalcDef[] = [maxDemand, voltDrop, water, drainage, extinguishers, hoseReels, earth];
export const CALC_IDS = CALCS.map((c) => c.id);

export interface CalcListing {
  id: string; title: string; role: string; method: string; inputs: string[];
  kit_provides: KitItem[]; kit_missing: string[];
}
export interface ElsewhereListing { id: string; title: string; done_by: string; source: string }

/** Every calc in the kit's register: those ported here (with what the kit gives and lacks) and those done elsewhere. */
export function listCalcs(tabs: Tabs): { calcs: CalcListing[]; elsewhere: ElsewhereListing[] } {
  const reg = calculationsRegister(tabs);
  const calcs = CALCS.map((c) => {
    const r = reg.find((x) => x.id === c.id);
    const k = c.kit(tabs);
    return { id: c.id, title: r?.title ?? c.id, role: c.role, method: r?.method ?? "", inputs: c.inputs, kit_provides: k.provided, kit_missing: k.missing };
  });
  const elsewhere = reg.filter((r) => !CALC_IDS.includes(r.id)).map((r) => ({
    id: r.id, title: r.title, source: r.source,
    done_by: /^Calc_/.test(r.tool) ? `the kit workbook's ${r.tool} sheet, per kit` : `${r.tool || "not named"}, per kit`,
  }));
  return { calcs, elsewhere };
}

/** Run the calcs asked for (all when none); an unknown id is reported, never guessed. */
export function runCalcs(ids: string[], facts: Facts, tabs: Tabs, eng: EngineerInputs = {}): { results: CalcResult[]; unknown: string[] } {
  const want = ids.length ? ids.map((i) => i.trim().toUpperCase()) : CALC_IDS;
  const unknown = want.filter((i) => !CALC_IDS.includes(i));
  const results = CALCS.filter((c) => want.includes(c.id)).map((c) => c.run(facts, tabs, eng));
  return { results, unknown };
}

/** The kit change requests a run points to: every TBC the kit itself would fill. */
export function kitRequests(results: CalcResult[]): Array<{ calc: string; item: string; missing: string }> {
  return results.flatMap((r) => r.tbc.filter((t) => t.kit_request).map((t) => ({ calc: r.id, item: t.item, missing: t.missing })));
}

export type { CalcDef } from "./common.js";
export * from "./types.js";
