/**
 * CA-LP-02 Earth resistance record (kit method: measured resistance per pit against the design target). The measured
 * value is each earth pit's FMC_Earth_Resistance_Ohm; the kit has no design target, so it is the engineer's input or TBC.
 */
import { CalcDef, KitItem, registerEntry, result } from "./common.js";
import { Tabs, textMatch } from "./kit.js";
import { Row, Tbc, addTbc, tbcVal, val } from "./types.js";

function targetKit(tabs: Tabs) {
  for (const tab of ["Calculations", "Calc_LP_Design"]) {
    const t = textMatch(tabs, tab, /(?:target|not more than|<=)\s*([\d.]+)\s*(?:ohm|Ω)/i);
    if (t) return { value: Number(t.m[1]), source: t.source };
  }
  return null;
}

export const earth: CalcDef = {
  id: "CA-LP-02",
  role: "LP",
  inputs: ["earth pits (FMC_LP_Part Earth, FMC_Earth_Resistance_Ohm, Mark)"],
  kit(tabs) {
    const t = targetKit(tabs), e = registerEntry(tabs, "CA-LP-02");
    const provided: KitItem[] = e.method ? [{ name: "method", value: e.method, source: e.method_source }] : [];
    const missing: string[] = [];
    if (t) provided.push({ name: "design earth resistance target ohm", value: t.value, source: t.source }); else missing.push("design earth resistance target (ohm)");
    return { provided, missing };
  },
  run(facts, tabs, eng) {
    const kitT = targetKit(tabs);
    const target = kitT ?? (eng.earth_target_ohm !== undefined ? { value: eng.earth_target_ohm, source: "engineer" } : null);
    const rows: Row[] = [], tbc: Tbc[] = [];
    const pits = (facts.mep.lp_parts ?? []).filter((p) => /earth/i.test(p.part) || (p.earth_resistance_ohm !== null && p.earth_resistance_ohm !== undefined));
    if (!pits.length) return result(tabs, this.id, this.role, rows, [], tbc, ["No earth pits in the model (FMC_LP_Part = Earth)."]);
    if (!target) addTbc(tbc, { item: "design earth resistance target", missing: "not in the kit: the engineer gives it (inputs.earth_target_ohm)", kit_request: true });
    for (const p of pits.sort((a, b) => (a.mark || String(a.id)).localeCompare(b.mark || String(b.id), undefined, { numeric: true }))) {
      const measured = p.earth_resistance_ohm;
      if (measured === null || measured === undefined) addTbc(tbc, { item: `earth pit ${p.mark || p.id}`, missing: "not measured yet (FMC_Earth_Resistance_Ohm empty)", kit_request: false });
      const check: Row["check"] = measured === null || measured === undefined || !target ? { rule: "measured <= target", result: "TBC", source: target?.source ?? "TBC" }
        : { rule: `measured <= ${target.value} ohm`, result: measured <= target.value ? "pass" : "fail", source: target.source };
      rows.push({ item: p.mark || `${p.family}: ${p.type} (${p.id})`, values: {
        measured_ohm: measured === null || measured === undefined ? tbcVal("ohm") : val(measured, `model:${p.id}`, "ohm"),
        target_ohm: target ? val(target.value, target.source, "ohm") : tbcVal("ohm") }, check });
    }
    return result(tabs, this.id, this.role, rows, [], tbc, ["Measured values are the as-built test record (LP11_Earth_Test_Record): the engineer signs the record."]);
  },
};
