/**
 * CA-FP-01 Portable extinguisher provision (kit: Calc_FP_Extinguishers): per storey, required Class A rating =
 * ROUND(factor x floor area, 1); extinguishers = MAX(minimum, ROUNDUP(required / rating of the chosen one)); factor and
 * minimum read from the kit's rule text. The model's extinguishers (FMC_Extinguisher_Rating) are checked against it.
 *
 * CA-FP-02 Hose reel coverage (kit method: coverage radius = hose length + throw). Hose length is the reel's
 * FMC_Hose_Length_m; the kit has no throw value, so it is the engineer's input or TBC. Each room's location point is
 * checked against the reels on its level; travel distances stay with the fire strategy.
 */
import { CalcDef, KitItem, registerEntry, result } from "./common.js";
import { Tabs, labelled, textMatch, wordNumber } from "./kit.js";
import { FireFact, RoomFact, Row, Tbc, addTbc, round, roundUp, tbcVal, val } from "./types.js";

const TAB = "Calc_FP_Extinguishers";

function extKit(tabs: Tabs) {
  const rule = textMatch(tabs, TAB, /rating\s*>=\s*([\d.]+)\s*x\s*floor area,?\s*and at least (\w+)/i)
    ?? textMatch(tabs, "Calculations", /rating\s*>=\s*([\d.]+)\s*x\s*floor area,?\s*(?:and\s*)?at least (\w+)/i);
  const min = rule ? wordNumber(rule.m[2]) : null;
  return {
    factor: rule ? { value: Number(rule.m[1]), source: rule.source } : null,
    min: rule && min !== null ? { value: min, source: rule.source } : null,
    chosen: labelled(tabs, TAB, /^rating of the chosen extinguisher/i),
  };
}

/** Class A number in a rating text: "13A 55B" → 13. */
export const classA = (rating: string): number | null => { const m = /(\d+(?:\.\d+)?)\s*A\b/i.exec(rating ?? ""); return m ? Number(m[1]) : null; };

/** Rooms if there are any, else spaces (never both: an MEP model's spaces mirror the linked rooms). */
export function roomsOnly(all: RoomFact[]): RoomFact[] {
  return all.some((r) => (r.kind ?? "room") === "room") ? all.filter((r) => (r.kind ?? "room") === "room") : all;
}

export const extinguishers: CalcDef = {
  id: "CA-FP-01",
  role: "FP",
  inputs: ["rooms (area per level)", "fire extinguishers (FMC_Extinguisher_Rating, level)"],
  kit(tabs) {
    const k = extKit(tabs);
    const provided: KitItem[] = [], missing: string[] = [];
    for (const [name, x] of [["Class A rating per m2 of floor area", k.factor], ["minimum extinguishers per storey", k.min], ["rating of the chosen extinguisher", k.chosen]] as const)
      x ? provided.push({ name, value: x.value, source: x.source }) : missing.push(name);
    return { provided, missing };
  },
  run(facts, tabs) {
    const k = extKit(tabs);
    const rows: Row[] = [], tbc: Tbc[] = [], notes: string[] = [];
    if (!k.factor) addTbc(tbc, { item: "Class A rating rule", missing: `not in the kit (${TAB})`, kit_request: true });
    if (!k.chosen) addTbc(tbc, { item: "rating of the chosen extinguisher", missing: `not in the kit (${TAB})`, kit_request: true });
    const rooms = roomsOnly(facts.mep.rooms ?? []);
    const ext = (facts.mep.fire_devices ?? []).filter((d) => d.kind === "extinguisher");
    const levels = [...new Set([...rooms.map((r) => r.level), ...ext.map((e) => e.level)].filter(Boolean))].sort();
    for (const level of levels) {
      const area = rooms.filter((r) => r.level === level).reduce((s, r) => s + (r.area_m2 ?? 0), 0);
      const here = ext.filter((e) => e.level === level);
      const v: Row["values"] = { floor_area_m2: val(round(area, 1), "model", "m2") };
      const required = k.factor ? round(k.factor.value * area, 1) : null;
      v.required_rating = required === null ? tbcVal() : val(required, k.factor!.source);
      v.extinguishers_required = required !== null && k.chosen && k.min ? val(Math.max(k.min.value, roundUp(required / k.chosen.value)), "calc", "nr") : tbcVal("nr");
      v.modelled = val(here.length, "model", "nr");
      const ratings = here.map((e) => classA(e.rating));
      const unrated = here.filter((_, i) => ratings[i] === null);
      for (const e of unrated) addTbc(tbc, { item: `extinguisher ${e.id} on ${level}`, missing: "FMC_Extinguisher_Rating (Class A)", kit_request: false });
      const provided = ratings.reduce<number>((s, r) => s + (r ?? 0), 0);
      v.rating_modelled = unrated.length ? tbcVal() : val(provided, "model");
      let check: Row["check"] = { rule: "rating modelled >= required, and the minimum per storey", result: "TBC", source: k.factor?.source ?? "TBC" };
      if (required !== null && k.min && !unrated.length) check = { ...check, result: provided >= required && here.length >= k.min.value ? "pass" : "fail" };
      rows.push({ item: level, values: v, check, note: here.length ? undefined : "no extinguisher modelled on this level" });
    }
    if (!levels.length) notes.push("No rooms or extinguishers in the model.");
    notes.push("Floor area is the sum of the rooms on each level (net); the engineer may use the gross area (Z12_Area_GFA) instead.",
      "Placement, travel distance and other fire classes (B, electrical) stay with the fire engineer.");
    return result(tabs, this.id, this.role, rows, [], tbc, notes);
  },
};

function throwKit(tabs: Tabs) {
  // Only a number the kit labels as the throw (none in v2.2)
  const t = textMatch(tabs, "Calculations", /throw\s*(?:=|of)\s*([\d.]+)\s*m/i);
  return t ? { value: Number(t.m[1]), source: t.source } : null;
}

const dist = (a: { x_mm?: number | null; y_mm?: number | null }, b: { x_mm?: number | null; y_mm?: number | null }) =>
  Math.hypot((a.x_mm ?? 0) - (b.x_mm ?? 0), (a.y_mm ?? 0) - (b.y_mm ?? 0)) / 1000;

export const hoseReels: CalcDef = {
  id: "CA-FP-02",
  role: "FP",
  inputs: ["hose reels (FMC_Hose_Length_m, location, level)", "rooms (location point, level)"],
  kit(tabs) {
    const t = throwKit(tabs), e = registerEntry(tabs, "CA-FP-02");
    const provided: KitItem[] = e.method ? [{ name: "method", value: e.method, source: e.method_source }] : [];
    const missing: string[] = [];
    if (t) provided.push({ name: "hose reel throw m", value: t.value, source: t.source }); else missing.push("hose reel throw (m)");
    missing.push("travel distance limits (the project's fire strategy)");
    return { provided, missing };
  },
  run(facts, tabs, eng) {
    const kitThrow = throwKit(tabs);
    const thr = kitThrow ?? (eng.hose_throw_m !== undefined ? { value: eng.hose_throw_m, source: "engineer" } : null);
    const rows: Row[] = [], totals: Row[] = [], tbc: Tbc[] = [], notes: string[] = [];
    const reels = (facts.mep.fire_devices ?? []).filter((d) => d.kind === "hose_reel");
    if (!reels.length) return result(tabs, this.id, this.role, rows, totals, tbc, ["No hose reels in the model."]);
    if (!thr) addTbc(tbc, { item: "hose reel throw", missing: "not in the kit: the engineer gives it (inputs.hose_throw_m)", kit_request: true });
    const radius = (r: FireFact) => (r.hose_length_m && thr ? r.hose_length_m + thr.value : null);
    for (const r of reels) {
      if (!r.hose_length_m) addTbc(tbc, { item: `hose reel ${r.id}`, missing: "FMC_Hose_Length_m", kit_request: false });
      const rad = radius(r);
      totals.push({ item: `Hose reel ${r.id} (${r.level})`, values: { hose_length_m: r.hose_length_m ? val(r.hose_length_m, `model:${r.id}`, "m") : tbcVal("m"),
        throw_m: thr ? val(thr.value, thr.source, "m") : tbcVal("m"), radius_m: rad === null ? tbcVal("m") : val(round(rad, 2), "calc", "m") } });
    }
    for (const room of roomsOnly(facts.mep.rooms ?? []).filter((x) => x.x_mm !== null && x.x_mm !== undefined)) {
      const here = reels.filter((r) => r.level === room.level);
      let best: { d: number; r: FireFact } | null = null;
      for (const r of here) { const d = dist(room, r); if (!best || d < best.d) best = { d, r }; }
      const rad = best ? radius(best.r) : null;
      const check: Row["check"] = !here.length ? { rule: "within a reel's coverage radius", result: "fail", source: "calc" }
        : rad === null ? { rule: "within a reel's coverage radius", result: "TBC", source: "TBC" }
        : { rule: "within a reel's coverage radius", result: best!.d <= rad ? "pass" : "fail", source: "calc" };
      rows.push({ item: `${room.number ? room.number + " " : ""}${room.name} (${room.level})`, values: {
        nearest_reel: best ? val(best.r.id, `model:${best.r.id}`) : tbcVal(), distance_m: best ? val(round(best.d, 2), "calc", "m") : tbcVal("m"),
        radius_m: rad === null ? tbcVal("m") : val(round(rad, 2), "calc", "m") }, check, note: here.length ? undefined : "no hose reel on this level" });
    }
    notes.push("Straight-line distance from the reel to the room's location point: walls and the hose route are the fire engineer's check.",
      "Travel distances are checked against the project's fire strategy, not here.");
    return result(tabs, this.id, this.role, rows, totals, tbc, notes);
  },
};
