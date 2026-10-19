/**
 * CA-E-01 Maximum demand, transformer and generator (kit: Calc_E_MaxDemand, factors in Electrical_Settings).
 * Demand = connected load x demand factor per load classification; kVA = kW / power factor; plant = next standard size
 * at or above kVA x margin; single-phase units shared over L1-L3; the result against Revit's own demand within the kit's
 * tolerance. Demand factors come from the kit only: a class the kit has no factor for is TBC (rule 5).
 */
import { CalcDef, KitItem, result } from "./common.js";
import { Tabs, kitRef, labelled, labelledList, textMatch } from "./kit.js";
import { CircuitFact, Row, Tbc, addTbc, round, roundUp, tbcVal, val } from "./types.js";

const TAB = "Calc_E_MaxDemand";
const SETTINGS = "Electrical_Settings";

/** Load classification → demand factor, from Electrical_Settings (Item = Load classification). */
export function demandFactors(tabs: Tabs): Map<string, { value: number; source: string }> {
  const out = new Map<string, { value: number; source: string }>();
  (tabs.get(SETTINGS) ?? []).forEach((r, i) => {
    if (String(r?.[0] ?? "").trim().toLowerCase() !== "load classification") return;
    const name = String(r[1] ?? "").trim();
    const v = Number(String(r[2] ?? "").trim());
    if (name && String(r[2] ?? "").trim() && Number.isFinite(v)) out.set(name.toLowerCase(), { value: v, source: kitRef(SETTINGS, i, 2) });
  });
  return out;
}

function kitValues(tabs: Tabs) {
  return {
    factors: demandFactors(tabs),
    pf: labelled(tabs, TAB, /^power factor$/i),
    trMargin: labelled(tabs, TAB, /^transformer growth margin/i),
    genMargin: labelled(tabs, TAB, /^generator margin/i),
    trSizes: labelledList(tabs, TAB, /^transformer kva$/i),
    genSizes: labelledList(tabs, TAB, /^generator kva$/i),
    tolerance: (() => { const t = textMatch(tabs, TAB, /agree within\s*([\d.]+)\s*%/i, 0); return t ? { value: Number(t.m[1]), source: t.source } : null; })(),
  };
}

/** A circuit's classes ("Lighting; Power" → two). */
export const classesOf = (c: CircuitFact) => [...new Set(String(c.classes ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean))];

const nextSize = (sizes: number[], atLeast: number) => sizes.filter((s) => s >= atLeast).sort((a, b) => a - b)[0] ?? null;

export const maxDemand: CalcDef = {
  id: "CA-E-01",
  role: "E",
  inputs: ["boards (fmc_electrical_facts: connected and demand load, fed by)", "power circuits on each board (load classification, true and apparent load)"],
  kit(tabs) {
    const k = kitValues(tabs);
    const provided: KitItem[] = [...k.factors].map(([n, f]) => ({ name: `demand factor ${n}`, value: f.value, source: f.source }));
    const missing: string[] = [];
    const add = (name: string, x: { value: number; source: string } | null) => x ? provided.push({ name, value: x.value, source: x.source }) : missing.push(name);
    add("power factor", k.pf);
    add("transformer growth margin", k.trMargin);
    add("generator margin", k.genMargin);
    if (k.trSizes) provided.push({ name: "transformer standard sizes kVA", value: k.trSizes.values.join(", "), source: k.trSizes.source }); else missing.push("transformer standard sizes");
    if (k.genSizes) provided.push({ name: "generator standard sizes kVA", value: k.genSizes.values.join(", "), source: k.genSizes.source }); else missing.push("generator standard sizes");
    add("calculation and Revit agree within %", k.tolerance);
    if (!k.factors.size) missing.push("demand factors (Electrical_Settings, Load classification)");
    return { provided, missing };
  },
  run(facts, tabs, eng) {
    const k = kitValues(tabs);
    const rows: Row[] = [], totals: Row[] = [], tbc: Tbc[] = [], notes: string[] = [];
    const circuits = (facts.mep.circuits ?? []).filter((c) => !c.feeds_board);
    const boards = [...new Set(circuits.map((c) => c.board || "(no board)"))].sort();
    let connected = 0, demand = 0, demandVa = 0, partial = false;

    for (const board of boards) {
      const byClass = new Map<string, { w: number; va: number; ids: number[] }>();
      for (const c of circuits.filter((x) => (x.board || "(no board)") === board)) {
        const cls = classesOf(c);
        const key = cls.length === 1 ? cls[0] : cls.length ? "(mixed)" : "(none)";
        const e = byClass.get(key) ?? { w: 0, va: 0, ids: [] };
        e.w += c.true_load_w ?? 0; e.va += c.apparent_load_va ?? 0; e.ids.push(c.id);
        byClass.set(key, e);
      }
      let bConn = 0, bDem = 0, bPartial = false;
      for (const [cls, e] of [...byClass].sort(([a], [b]) => a.localeCompare(b))) {
        const kw = e.w / 1000;
        const src = e.ids.length === 1 ? `model:${e.ids[0]}` : "model";
        const f = cls.startsWith("(") ? undefined : k.factors.get(cls.toLowerCase());
        bConn += kw;
        if (!f) {
          bPartial = true;
          addTbc(tbc, cls.startsWith("(")
            ? { item: `${board}: ${e.ids.length} circuit(s) ${cls === "(mixed)" ? "with more than one load classification" : "with no load classification"}`, missing: "one load classification per circuit (the engineer splits the load)", kit_request: false }
            : { item: `demand factor for "${cls}"`, missing: `not in the kit's Electrical_Settings (Load classification): the engineer sets it`, kit_request: true });
          rows.push({ item: `${board} · ${cls}`, values: { connected_kw: val(round(kw, 3), src, "kW"), demand_factor: tbcVal(), demand_kw: tbcVal("kW") } });
          continue;
        }
        const d = kw * f.value;
        bDem += d; demandVa += e.va * f.value;
        rows.push({ item: `${board} · ${cls}`, values: { connected_kw: val(round(kw, 3), src, "kW"), demand_factor: val(f.value, f.source), demand_kw: val(round(d, 3), "calc", "kW") } });
      }
      totals.push({ item: `${board} total`, values: { connected_kw: val(round(bConn, 3), "calc", "kW"), demand_kw: bPartial ? tbcVal("kW") : val(round(bDem, 3), "calc", "kW") },
        note: bPartial ? `partial demand ${round(bDem, 3)} kW without the TBC classes` : undefined });
      connected += bConn; demand += bDem; partial ||= bPartial;
    }
    if (!circuits.length) return result(tabs, this.id, this.role, rows, totals, tbc, ["No power circuits in the model: nothing to add up."]);

    // Building: maximum demand, kVA and plant
    const building: Row = { item: "Building", values: { connected_kw: val(round(connected, 3), "calc", "kW"), demand_kw: partial ? tbcVal("kW") : val(round(demand, 3), "calc", "kW") } };
    totals.push(building);
    let kva: number | null = null;
    if (!k.pf) addTbc(tbc, { item: "power factor", missing: `not in the kit (${TAB})`, kit_request: true });
    else if (!partial) kva = round(demand / k.pf.value, 1);
    totals.push({ item: "Maximum demand", values: { power_factor: k.pf ? val(k.pf.value, k.pf.source) : tbcVal(), kva: kva === null ? tbcVal("kVA") : val(kva, "calc", "kVA") } });
    const plant = (name: string, margin: { value: number; source: string } | null, sizes: { values: number[]; source: string } | null) => {
      if (!margin) addTbc(tbc, { item: `${name} margin`, missing: `not in the kit (${TAB})`, kit_request: true });
      if (!sizes) addTbc(tbc, { item: `${name} standard sizes`, missing: `not in the kit (${TAB})`, kit_request: true });
      const need = kva !== null && margin ? kva * margin.value : null;
      const size = need !== null && sizes ? nextSize(sizes.values, need) : null;
      if (need !== null && sizes && size === null) addTbc(tbc, { item: `${name} size`, missing: `${round(need, 1)} kVA is above the kit's largest standard size: the engineer selects`, kit_request: false });
      totals.push({ item: `${name} selected`, values: { margin: margin ? val(margin.value, margin.source) : tbcVal(), required_kva: need === null ? tbcVal("kVA") : val(round(need, 2), "calc", "kVA"),
        selected_kva: size === null ? tbcVal("kVA") : val(size, sizes!.source, "kVA") } });
    };
    plant("Transformer", k.trMargin, k.trSizes);
    plant("Generator", k.genMargin, k.genSizes);

    // Phase balance of single-phase units (the number comes from the brief)
    const units = eng.single_phase_units;
    if (units === undefined) addTbc(tbc, { item: "single-phase units", missing: "the number of single-phase units from the brief (inputs.single_phase_units)", kit_request: false });
    else {
      const l1 = roundUp(units / 3), l2 = roundUp((units - l1) / 2);
      totals.push({ item: "Phase balance", values: { units: val(units, "engineer", "nr"), l1: val(l1, "calc", "nr"), l2: val(l2, "calc", "nr"), l3: val(units - l1 - l2, "calc", "nr") } });
    }

    // Against Revit's own demand on the boards fed by no other board (in VA: Revit's demand load is apparent)
    const top = facts.boards.filter((b) => !b.fed_by);
    const revitVa = top.reduce((s, b) => s + (b.demand_va ?? 0), 0);
    let check: Row["check"];
    if (!k.tolerance) { addTbc(tbc, { item: "agreement with Revit", missing: `tolerance not in the kit (${TAB})`, kit_request: true }); check = { rule: "calculation and Revit agree", result: "TBC", source: "TBC" }; }
    else if (partial || !top.length || !revitVa || !demandVa) check = { rule: `within ${k.tolerance.value}% of Revit`, result: "TBC", source: k.tolerance.source };
    else check = { rule: `within ${k.tolerance.value}% of Revit`, result: Math.abs(1 - revitVa / demandVa) <= k.tolerance.value / 100 + 1e-12 ? "pass" : "fail", source: k.tolerance.source };
    totals.push({ item: "Check against Revit (boards fed by no other board)", values: { revit_demand_va: top.length ? val(revitVa, "model", "VA") : tbcVal("VA"), calc_demand_va: partial ? tbcVal("VA") : val(round(demandVa, 0), "calc", "VA") }, check });
    if (!top.length) notes.push("Revit's board loads were not read (fmc_electrical_facts): the agreement check is TBC.");
    notes.push("Connected load is each circuit's true load (W); feeders to other boards are left out so nothing counts twice.",
      "Power factor, margins and standard sizes are the kit's assumptions: the engineer confirms them and the utility confirms sizes.");
    return result(tabs, this.id, this.role, rows, totals, tbc, notes);
  },
};
