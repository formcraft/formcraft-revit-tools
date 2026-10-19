/**
 * CA-E-02 Voltage drop per circuit and feeder (kit: Calc_E_VoltDrop).
 * VD (V) = ROUND(mV/A/m x Ib x L / 1000, 2); VD % = ROUND(VD / nominal V x 100, 2); limit from the kit (lighting / other).
 * The kit gives the method and the limits but no mV/A/m table (it depends on the cable and installation method), so
 * mV/A/m is the engineer's input or TBC; it is never taken from the kit's sample rows.
 */
import { CalcDef, KitItem, result } from "./common.js";
import { Tabs, textMatch } from "./kit.js";
import { classesOf } from "./max_demand.js";
import { CircuitFact, Row, Tbc, addTbc, round, tbcVal, val } from "./types.js";

const TAB = "Calc_E_VoltDrop";

/** The kit's limits: "Limits 3% lighting, 5% other" (Calc_E_VoltDrop) or "against 3% lighting and 5% other" (Calculations). */
export function vdLimits(tabs: Tabs): { lighting: number; other: number; source: string } | null {
  const re = /([\d.]+)\s*%\s*lighting,?\s*(?:and\s*)?([\d.]+)\s*%\s*other/i;
  const t = textMatch(tabs, TAB, re) ?? textMatch(tabs, "Calculations", re);
  return t ? { lighting: Number(t.m[1]), other: Number(t.m[2]), source: t.source } : null;
}

/** A kit tab with mV/A/m by cable size, if the kit ever adds one (none in v2.2). */
function kitMvTable(tabs: Tabs): { table: Map<number, number>; source: string } | null {
  for (const [name, rows] of tabs) {
    if (!/mv.?a.?m|cable_data|cable_vd/i.test(name)) continue;
    const table = new Map<number, number>();
    rows.forEach((r) => { const s = Number(r?.[0]), v = Number(r?.[1]); if (Number.isFinite(s) && Number.isFinite(v) && r?.[0] !== "" && r?.[1] !== "") table.set(s, v); });
    if (table.size) return { table, source: `kit:${name}` };
  }
  return null;
}

/** Conductor size in mm2 from Revit's wire size text ("2#2.5mm², 1#2.5mm²", "3#16"). */
export function cableSize(wire: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*mm/i.exec(wire) ?? /#\s*(\d+(?:\.\d+)?)/.exec(wire) ?? /^\s*(\d+(?:\.\d+)?)\s*$/.exec(wire);
  return m ? Number(m[1]) : null;
}

export const voltDrop: CalcDef = {
  id: "CA-E-02",
  role: "E",
  inputs: ["power circuits and feeders (voltage, current, length, wire size, load classification)"],
  kit(tabs) {
    const l = vdLimits(tabs), mv = kitMvTable(tabs);
    const provided: KitItem[] = [], missing: string[] = [];
    if (l) provided.push({ name: "limit % lighting", value: l.lighting, source: l.source }, { name: "limit % other", value: l.other, source: l.source });
    else missing.push("voltage drop limits (lighting, other)");
    if (mv) provided.push({ name: "mV/A/m by cable size", value: [...mv.table].map(([s, v]) => `${s}: ${v}`).join(", "), source: mv.source });
    else missing.push("mV/A/m by cable size and installation method (BS 7671 Appendix 4 or the cable maker)");
    return { provided, missing };
  },
  run(facts, tabs, eng) {
    const limits = vdLimits(tabs), kitMv = kitMvTable(tabs);
    const engMv = new Map(Object.entries(eng.mv_a_m ?? {}).map(([s, v]) => [Number(s), Number(v)] as [number, number]).filter(([s, v]) => Number.isFinite(s) && Number.isFinite(v)));
    const rows: Row[] = [], tbc: Tbc[] = [], notes: string[] = [];
    if (!limits) addTbc(tbc, { item: "voltage drop limits", missing: `not in the kit (${TAB})`, kit_request: true });
    const circuits = [...(facts.mep.circuits ?? [])].sort((a, b) => `${a.board}/${a.number}`.localeCompare(`${b.board}/${b.number}`, undefined, { numeric: true }));
    for (const c of circuits) rows.push(row(c));
    if (!circuits.length) notes.push("No power circuits in the model.");
    notes.push("Length is Revit's circuit length (to the farthest device, as Revit routes it); the engineer confirms the route and the installation method.");
    return result(tabs, this.id, this.role, rows, [], tbc, notes);

    function row(c: CircuitFact): Row {
      const src = `model:${c.id}`;
      const size = cableSize(c.wire_size ?? "");
      const lighting = classesOf(c).length > 0 && classesOf(c).every((x) => /lighting/i.test(x));
      const use = c.feeds_board ? "Sub-main" : classesOf(c).join("; ") || "";
      const name = `${c.board || "(no board)"}/${c.number}`;
      const v: Row["values"] = {
        use: val(use || null, use ? src : "TBC"),
        nominal_v: c.voltage_v ? val(round(c.voltage_v, 0), src, "V") : tbcVal("V"),
        ib_a: c.current_a ? val(round(c.current_a, 2), src, "A") : tbcVal("A"),
        length_m: c.length_m ? val(round(c.length_m, 1), src, "m") : tbcVal("m"),
        cable_mm2: size !== null ? val(size, src, "mm2") : tbcVal("mm2"),
      };
      let mv: number | null = null, mvSrc = "TBC";
      if (size !== null && kitMv?.table.has(size)) { mv = kitMv.table.get(size)!; mvSrc = kitMv.source; }
      else if (size !== null && engMv.has(size)) { mv = engMv.get(size)!; mvSrc = "engineer"; }
      v.mv_a_m = mv === null ? tbcVal() : val(mv, mvSrc);
      if (!c.voltage_v) addTbc(tbc, { item: `circuit ${name}`, missing: "nominal voltage", kit_request: false });
      if (!c.current_a) addTbc(tbc, { item: `circuit ${name}`, missing: "design current Ib (no load on the circuit?)", kit_request: false });
      if (!c.length_m) addTbc(tbc, { item: `circuit ${name}`, missing: "circuit length (Revit has none: no path to the devices)", kit_request: false });
      if (size === null) addTbc(tbc, { item: `circuit ${name}`, missing: "cable size (wire size)", kit_request: false });
      else if (mv === null) addTbc(tbc, { item: `mV/A/m for ${size} mm2`, missing: "not in the kit: the engineer gives it for the cable and installation method (inputs.mv_a_m)", kit_request: true });
      let limit: number | null = null;
      if (limits && (use || c.feeds_board)) limit = lighting ? limits.lighting : limits.other;
      else if (limits) addTbc(tbc, { item: `circuit ${name}`, missing: "load classification (to choose the lighting or other limit)", kit_request: false });
      v.limit_pct = limit === null ? tbcVal("%") : val(limit, limits!.source, "%");
      let check: Row["check"] = { rule: "VD % <= limit", result: "TBC", source: limits?.source ?? "TBC" };
      if (mv !== null && c.current_a && c.length_m && c.voltage_v) {
        const vd = round(mv * c.current_a * c.length_m / 1000, 2);
        const pct = round(vd / c.voltage_v * 100, 2);
        v.vd_v = val(vd, "calc", "V");
        v.vd_pct = val(pct, "calc", "%");
        if (limit !== null) check = { rule: `VD % <= ${limit}`, result: pct <= limit ? "pass" : "fail", source: limits!.source };
      } else { v.vd_v = tbcVal("V"); v.vd_pct = tbcVal("%"); }
      return { item: name + (c.load_name ? ` ${c.load_name}` : ""), values: v, check };
    }
  },
};
