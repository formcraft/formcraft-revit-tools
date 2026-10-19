/**
 * CA-P-02 Drainage design flow (kit: Calc_P_Drainage). Qww = ROUND(K x sqrt(sum DU), 2); design flow not less than the
 * largest single DU. DU per fixture: the fixture's own FMC_Discharge_Units, else the kit's DU table matched by the
 * fixture's family and type name; K from the kit.
 */
import { CalcDef, KitItem, labelWords, result, words } from "./common.js";
import { Tabs, kitRef, labelled, tableBelow } from "./kit.js";
import { FixtureFact, Row, Tbc, addTbc, num, round, tbcVal, val } from "./types.js";

const TAB = "Calc_P_Drainage";

interface KitDu { label: string; key: string[]; du: number; source: string }

function kitValues(tabs: Tabs) {
  const table: KitDu[] = tableBelow(tabs, TAB, /^fixture/i)
    .map(({ cells, index }) => ({ label: cells[0], key: labelWords(cells[0]), du: num(cells[1]) ?? NaN, source: kitRef(TAB, index, 1) }))
    .filter((d) => Number.isFinite(d.du) && d.key.length);
  return { table, k: labelled(tabs, TAB, /^frequency factor k/i) };
}

/** The kit row whose words all appear in the fixture's family and type name (the most specific one). */
export function matchDu(table: KitDu[], f: Pick<FixtureFact, "family" | "type">): KitDu | null {
  const w = words(`${f.family} ${f.type}`);
  const has = (x: string) => w.some((y) => y === x || y.startsWith(x) && /^\d/.test(y.slice(x.length)) || y === x + "s");
  return table.filter((d) => d.key.every(has)).sort((a, b) => b.key.length - a.key.length)[0] ?? null;
}

export const drainage: CalcDef = {
  id: "CA-P-02",
  role: "P",
  inputs: ["plumbing fixtures (family, type, FMC_Discharge_Units)"],
  kit(tabs) {
    const k = kitValues(tabs);
    const provided: KitItem[] = k.table.map((d) => ({ name: `DU ${d.label}`, value: d.du, source: d.source }));
    const missing: string[] = [];
    if (!k.table.length) missing.push("discharge units per fixture");
    if (k.k) provided.push({ name: "frequency factor K", value: k.k.value, source: k.k.source }); else missing.push("frequency factor K");
    return { provided, missing };
  },
  run(facts, tabs) {
    const k = kitValues(tabs);
    const rows: Row[] = [], totals: Row[] = [], tbc: Tbc[] = [], notes: string[] = [];
    const fixtures = facts.mep.plumbing_fixtures ?? [];
    const groups = new Map<string, { du: number | null; source: string; ids: number[] }>();
    for (const f of fixtures) {
      let label: string, du: number | null, source: string;
      if (f.du !== null && f.du !== undefined && f.du > 0) { label = `${f.family}: ${f.type}`; du = f.du; source = `model:${f.id}`; }
      else {
        const m = matchDu(k.table, f);
        label = m ? m.label : `${f.family}: ${f.type}`; du = m?.du ?? null; source = m?.source ?? "TBC";
      }
      const key = `${label}|${du}`;
      const g = groups.get(key) ?? { du, source, ids: [] };
      g.ids.push(f.id);
      groups.set(key, g);
    }
    let sum = 0, largest = 0, partial = false;
    for (const [key, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const label = key.slice(0, key.lastIndexOf("|"));
      const count = val(g.ids.length, g.ids.length === 1 ? `model:${g.ids[0]}` : "model", "nr");
      if (g.du === null) {
        partial = true;
        addTbc(tbc, { item: `DU for ${label}`, missing: "set FMC_Discharge_Units on the type, or the kit's Calc_P_Drainage table adds the fixture", kit_request: false });
        rows.push({ item: label, values: { du: tbcVal("L/s"), count, total_du: tbcVal() } });
        continue;
      }
      const total = g.du * g.ids.length;
      sum += total; largest = Math.max(largest, g.du);
      rows.push({ item: label, values: { du: val(g.du, g.source, "L/s"), count, total_du: val(round(total, 3), "calc") } });
    }
    if (!fixtures.length) return result(tabs, this.id, this.role, rows, totals, tbc, ["No plumbing fixtures in the model."]);
    totals.push({ item: "Sum of DU", values: { sum_du: partial ? tbcVal("L/s") : val(round(sum, 3), "calc", "L/s") } });
    if (!k.k) addTbc(tbc, { item: "frequency factor K", missing: `not in the kit (${TAB})`, kit_request: true });
    const q = !partial && k.k ? round(k.k.value * Math.sqrt(sum), 2) : null;
    totals.push({ item: "Qww = K x sqrt(sum DU)", values: { k: k.k ? val(k.k.value, k.k.source) : tbcVal(), qww: q === null ? tbcVal("L/s") : val(q, "calc", "L/s") } });
    totals.push({ item: "Design flow (not less than the largest DU)", values: { design_flow: q === null ? tbcVal("L/s") : val(Math.max(q, largest), "calc", "L/s") } });
    notes.push("K is the kit's value for dwellings: the engineer confirms K and the system type (BS EN 12056-2) for other uses.",
      "One building total: the engineer splits it per stack or drain run.");
    return result(tabs, this.id, this.role, rows, totals, tbc, notes);
  },
};
