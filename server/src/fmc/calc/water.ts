/**
 * CA-P-01 Water demand, storage and septic tank (kit: Calc_P_Water).
 * Daily demand = persons x L/person/day per occupancy (the kit's table); storage = demand x days; tanks = ROUNDUP(storage /
 * tank size); septic C = a x P + b with a and b read from the kit's formula text, P without the occupancies the kit
 * leaves out of the septic tank (visitors). Persons come from each room's FMC_Design_Population.
 */
import { CalcDef, KitItem, labelWords, result, words } from "./common.js";
import { Tabs, kitRef, labelled, tableBelow, textMatch } from "./kit.js";
import { roomsOnly } from "./fire.js";
import { Row, Tbc, addTbc, num, round, roundUp, tbcVal, val } from "./types.js";

const TAB = "Calc_P_Water";

interface Occupancy { label: string; key: string[]; lpd: number; source: string; septic: boolean }

function kitValues(tabs: Tabs) {
  const excl = textMatch(tabs, TAB, /\((\w+)\s+excluded from septic\)/i);
  const excluded = excl ? excl.m[1].toLowerCase() : "";
  const occupancies: Occupancy[] = tableBelow(tabs, TAB, /^occupancy/i).map(({ cells, index }) => {
    const key = labelWords(cells[0]).filter((w) => !["units", "persons", "daily", "unit"].includes(w));
    return { label: cells[0], key, lpd: num(cells[3]) ?? NaN, source: kitRef(TAB, index, 3), septic: !(excluded && key.some((w) => w.startsWith(excluded.replace(/s$/, "")))) };
  }).filter((o) => Number.isFinite(o.lpd) && o.key.length);
  const septic = textMatch(tabs, TAB, /C\s*=\s*([\d.]+)\s*P\s*\+\s*([\d.]+)/) ?? textMatch(tabs, "Calculations", /C\s*=\s*([\d.]+)\s*P\s*\+\s*([\d.]+)/);
  return {
    occupancies, excluded: excl ? { value: excluded, source: excl.source } : null,
    days: labelled(tabs, TAB, /^days of storage/i),
    tank: labelled(tabs, TAB, /^tank size/i),
    septic: septic ? { a: Number(septic.m[1]), b: Number(septic.m[2]), source: septic.source } : null,
  };
}

export const water: CalcDef = {
  id: "CA-P-01",
  role: "P",
  inputs: ["rooms and spaces with FMC_Design_Population and their occupancy", "tanks with FMC_Tank_Capacity_L"],
  kit(tabs) {
    const k = kitValues(tabs);
    const provided: KitItem[] = k.occupancies.map((o) => ({ name: `L/person/day ${o.label}`, value: o.lpd, source: o.source }));
    const missing: string[] = [];
    if (!k.occupancies.length) missing.push("L/person/day per occupancy");
    for (const [name, x] of [["days of storage", k.days], ["tank size L", k.tank]] as const) x ? provided.push({ name, value: x.value, source: x.source }) : missing.push(name);
    if (k.septic) provided.push({ name: "septic C = a P + b", value: `${k.septic.a} P + ${k.septic.b}`, source: k.septic.source }); else missing.push("septic tank formula");
    if (k.excluded) provided.push({ name: "left out of the septic population", value: k.excluded.value, source: k.excluded.source });
    return { provided, missing };
  },
  run(facts, tabs) {
    const k = kitValues(tabs);
    const rows: Row[] = [], totals: Row[] = [], tbc: Tbc[] = [], notes: string[] = [];
    const rooms = roomsOnly(facts.mep.rooms ?? []);
    const withPop = rooms.filter((r) => r.population !== null && r.population !== undefined && r.population > 0);
    if (!withPop.length) {
      if (rooms.length) addTbc(tbc, { item: "design population", missing: "no room has FMC_Design_Population", kit_request: false });
      return result(tabs, this.id, this.role, rows, totals, tbc, rooms.length ? [] : ["No rooms or spaces in the model."]);
    }
    if (withPop.length < rooms.length) notes.push(`${rooms.length - withPop.length} room(s) have no FMC_Design_Population and are not counted.`);

    const groups = new Map<string, { occ: Occupancy | null; persons: number; ids: number[]; label: string }>();
    for (const r of withPop) {
      const w = words(r.occupancy ?? "");
      const occ = k.occupancies.filter((o) => o.key.every((x) => w.some((y) => y.startsWith(x.replace(/s$/, "")))))
        .sort((a, b) => b.key.length - a.key.length)[0] ?? null;
      const label = occ?.label ?? (r.occupancy?.trim() || "(no occupancy)");
      const g = groups.get(label) ?? { occ, persons: 0, ids: [], label };
      g.persons += r.population!; g.ids.push(r.id);
      groups.set(label, g);
    }
    let P = 0, daily = 0, partial = false;
    for (const g of groups.values()) {
      const src = g.ids.length === 1 ? `model:${g.ids[0]}` : "model";
      if (!g.occ) {
        partial = true;
        addTbc(tbc, { item: `L/person/day for "${g.label}"`, missing: "no matching occupancy in the kit's Calc_P_Water table: the engineer sets it", kit_request: true });
        rows.push({ item: g.label, values: { persons: val(g.persons, src), l_per_person_day: tbcVal("L"), l_per_day: tbcVal("L/day") } });
        continue;
      }
      const d = g.persons * g.occ.lpd;
      daily += d;
      if (g.occ.septic) P += g.persons;
      rows.push({ item: g.label, values: { persons: val(g.persons, src), l_per_person_day: val(g.occ.lpd, g.occ.source, "L"), l_per_day: val(d, "calc", "L/day") },
        note: g.occ.septic ? undefined : "left out of the septic population (kit)" });
    }
    totals.push({ item: "Design population P", values: { persons: val(P, "calc") }, note: partial ? "without the TBC occupancies" : undefined });
    totals.push({ item: "Daily demand", values: { l_per_day: partial ? tbcVal("L/day") : val(daily, "calc", "L/day") } });
    const storage = !partial && k.days ? daily * k.days.value : null;
    if (!k.days) addTbc(tbc, { item: "days of storage", missing: `not in the kit (${TAB})`, kit_request: true });
    totals.push({ item: "Storage required", values: { days: k.days ? val(k.days.value, k.days.source, "days") : tbcVal("days"), litres: storage === null ? tbcVal("L") : val(storage, "calc", "L") } });
    if (!k.tank) addTbc(tbc, { item: "tank size", missing: `not in the kit (${TAB})`, kit_request: true });
    totals.push({ item: "Tanks required", values: { tank_l: k.tank ? val(k.tank.value, k.tank.source, "L") : tbcVal("L"), tanks: storage !== null && k.tank ? val(roundUp(storage / k.tank.value), "calc", "nr") : tbcVal("nr") } });
    const tanks = (facts.mep.tanks ?? []).filter((t) => t.capacity_l);
    if (storage !== null) {
      const have = tanks.reduce((s, t) => s + (t.capacity_l ?? 0), 0);
      totals.push({ item: "Storage modelled", values: { litres: tanks.length ? val(have, "model", "L") : tbcVal("L") },
        check: tanks.length ? { rule: "modelled storage >= storage required", result: have >= storage ? "pass" : "fail", source: "calc" } : { rule: "modelled storage >= storage required", result: "TBC", source: "TBC" } });
      if (!tanks.length) addTbc(tbc, { item: "storage modelled", missing: "no tank with FMC_Tank_Capacity_L in the model", kit_request: false });
    }
    if (!k.septic) addTbc(tbc, { item: "septic tank formula", missing: `not in the kit (${TAB})`, kit_request: true });
    totals.push({ item: "Septic tank capacity C", values: { litres: k.septic && !partial ? val(round(k.septic.a * P + k.septic.b, 0), k.septic.source, "L") : tbcVal("L") } });
    notes.push("Persons are each room's FMC_Design_Population; the occupancy is matched to the kit's table by the room's Occupancy.",
      "L/person/day, days of storage and tank size are the kit's assumptions: the engineer confirms them per project.");
    return result(tabs, this.id, this.role, rows, totals, tbc, notes);
  },
};
