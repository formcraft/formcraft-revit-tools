import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../policy.js";
import { CalcResult, CircuitFact, Facts, MepFacts, Row, kitRequests, listCalcs, round, runCalcs } from "./index.js";
import { tabsFromJson } from "./kit.js";
import { cableSize } from "./volt_drop.js";
import { DRAFT_HEADER, sheetCsv, sheetMarkdown, sheetPlan } from "./sheet.js";

// The kit's calculation tabs (FMC_Revit_Kit.xlsx v2.2, with its sample input rows). Each worked example below feeds the
// kit sheet's own sample inputs as model facts; the expected numbers are what the sheet's formulas give for them.
const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src/fmc/fixtures");
const tabs = tabsFromJson(JSON.parse(fs.readFileSync(path.join(FIX, "calc_kit_tabs.json"), "utf8")));

const facts = (mep: MepFacts, boards: Facts["boards"] = []): Facts => ({ mep, boards });
const one = (id: string, f: Facts, eng = {}) => runCalcs([id], f, tabs, eng).results[0];
const total = (r: CalcResult, item: string): Row => { const t = r.totals.find((x) => x.item === item); assert.ok(t, `total ${item}`); return t!; };
const rowOf = (r: CalcResult, item: string): Row => { const t = r.rows.find((x) => x.item.startsWith(item)); assert.ok(t, `row ${item}`); return t!; };

let cid = 100;
const circuit = (over: Partial<CircuitFact>): CircuitFact => ({
  id: cid++, board: "MDB", number: String(cid), load_name: "", classes: "", voltage_v: 240, current_a: null, true_load_w: null, apparent_load_va: null,
  length_m: null, wire_size: "", feeds_board: false, ...over,
});

test("CA-E-01: the kit's sample loads give the sheet's 93.3 kW, 109.8 kVA, 160 kVA transformer, 150 kVA generator, 17/17/16", () => {
  const loads: Array<[string, number]> = [["Lighting", 12], ["Power", 40], ["Water Heater", 150], ["HVAC", 10], ["Motor", 4], ["Emergency Lighting", 1], ["Site Lighting", 4]];
  const circuits = loads.map(([c, kw]) => circuit({ classes: c, true_load_w: kw * 1000, apparent_load_va: kw * 1000 }));
  circuits.push(circuit({ classes: "Power", true_load_w: 50000, apparent_load_va: 50000, feeds_board: true })); // a feeder: never counted twice
  const r = one("CA-E-01", facts({ circuits }, [{ id: 1, name: "MDB", connected_va: 221000, demand_va: 93300, fed_by: "" }]), { single_phase_units: 50 });
  assert.equal(total(r, "Building").values.demand_kw.value, 93.3);
  assert.equal(total(r, "Building").values.connected_kw.value, 221);
  assert.equal(total(r, "Maximum demand").values.kva.value, 109.8);
  assert.equal(total(r, "Maximum demand").values.power_factor.source, "kit:Calc_E_MaxDemand!B16");
  assert.equal(total(r, "Transformer selected").values.selected_kva.value, 160);
  assert.equal(total(r, "Generator selected").values.selected_kva.value, 150);
  const ph = total(r, "Phase balance").values;
  assert.deepEqual([ph.l1.value, ph.l2.value, ph.l3.value], [17, 17, 16]);
  assert.equal(rowOf(r, "MDB · Water Heater").values.demand_factor.source, "kit:Electrical_Settings!C12");
  assert.equal(rowOf(r, "MDB · Water Heater").values.demand_kw.value, 49.5);
  assert.equal(total(r, "Check against Revit (boards fed by no other board)").check?.result, "pass");
  assert.equal(r.result, "pass");
});

test("CA-E-01: a class with no kit demand factor is TBC for the engineer, never a made-up factor (rule 5)", () => {
  const r = one("CA-E-01", facts({ circuits: [circuit({ classes: "Kitchen", true_load_w: 9000 }), circuit({ classes: "Lighting; Power", true_load_w: 1000 })] }));
  assert.equal(rowOf(r, "MDB · Kitchen").values.demand_factor.value, null);
  assert.equal(rowOf(r, "MDB · Kitchen").values.demand_factor.source, "TBC");
  assert.equal(total(r, "Building").values.demand_kw.value, null);
  assert.ok(r.tbc.some((t) => t.item === 'demand factor for "Kitchen"' && t.kit_request && /engineer sets/.test(t.missing)));
  assert.ok(r.tbc.some((t) => /more than one load classification/.test(t.item) && !t.kit_request));
  assert.ok(r.tbc.some((t) => t.item === "single-phase units" && !t.kit_request));
  assert.equal(r.result, "TBC");
});

test("CA-E-02: the kit's sample circuits give its voltage drops; the kit has no mV/A/m table, so without the engineer's it is TBC", () => {
  const vd = [
    circuit({ board: "CU-01", number: "1", classes: "Lighting", current_a: 6, length_m: 25, wire_size: "2#1.5mm²", voltage_v: 240 }),
    circuit({ board: "CU-01", number: "3", classes: "Power", current_a: 20, length_m: 18, wire_size: "2#2.5mm²", voltage_v: 240 }),
    circuit({ board: "CU-01", number: "5", classes: "Water Heater", current_a: 12.5, length_m: 12, wire_size: "2#4mm²", voltage_v: 240 }),
    circuit({ board: "DB-G", number: "L1", classes: "", current_a: 63, length_m: 30, wire_size: "4#16", voltage_v: 415, feeds_board: true }),
    circuit({ board: "MTR-01", number: "tail", classes: "Other", current_a: 40, length_m: 35, wire_size: "10 mm²", voltage_v: 240 }),
  ];
  const mv = { "1.5": 29, "2.5": 18, "4": 11, "16": 2.4, "10": 4.4 };
  const r = one("CA-E-02", facts({ circuits: vd }), { mv_a_m: mv });
  const got = r.rows.map((x) => [x.item.split(" ")[0], x.values.vd_v.value, x.values.vd_pct.value, x.values.limit_pct.value, x.check?.result]);
  assert.deepEqual(got, [
    ["CU-01/1", 4.35, 1.81, 3, "pass"], ["CU-01/3", 6.48, 2.7, 5, "pass"], ["CU-01/5", 1.65, 0.69, 5, "pass"],
    ["DB-G/L1", 4.54, 1.09, 5, "pass"], ["MTR-01/tail", 6.16, 2.57, 5, "pass"],
  ]);
  assert.equal(r.rows[0].values.limit_pct.source, "kit:Calc_E_VoltDrop!A2");
  assert.equal(r.rows[0].values.mv_a_m.source, "engineer");
  assert.equal(r.result, "pass");

  const bare = one("CA-E-02", facts({ circuits: vd }));
  assert.equal(bare.rows[0].values.vd_pct.value, null);
  assert.equal(bare.rows[0].check?.result, "TBC");
  assert.ok(bare.tbc.some((t) => t.item === "mV/A/m for 1.5 mm2" && t.kit_request));

  const long = one("CA-E-02", facts({ circuits: [circuit({ classes: "Lighting", current_a: 10, length_m: 40, wire_size: "1.5 mm²" })] }), { mv_a_m: mv });
  assert.equal(long.rows[0].values.vd_pct.value, round(29 * 10 * 40 / 1000 / 240 * 100, 2));
  assert.equal(long.rows[0].check?.result, "fail");
  assert.equal(cableSize("3#2.5mm², 1#1.5mm²"), 2.5);
});

test("CA-P-01: the kit's sample population gives P 92, 8840 L/day, 17680 L, 2 tanks, septic 18560 L", () => {
  const rooms = [
    { id: 1, name: "Flats", level: "L1", area_m2: 2000, population: 80, occupancy: "Residential" },
    { id: 2, name: "Office", level: "L0", area_m2: 100, population: 12, occupancy: "Staff" },
    { id: 3, name: "Lobby", level: "L0", area_m2: 80, population: 24, occupancy: "Visitors" },
    { id: 4, name: "Store", level: "L0", area_m2: 10, population: null, occupancy: "" },
  ];
  const r = one("CA-P-01", facts({ rooms, tanks: [{ id: 9, family: "Tank", type: "10000 L", capacity_l: 10000 }, { id: 10, family: "Tank", type: "10000 L", capacity_l: 10000 }] }));
  assert.equal(total(r, "Design population P").values.persons.value, 92);
  assert.equal(total(r, "Daily demand").values.l_per_day.value, 8840);
  assert.equal(total(r, "Storage required").values.litres.value, 17680);
  assert.equal(total(r, "Tanks required").values.tanks.value, 2);
  assert.equal(total(r, "Septic tank capacity C").values.litres.value, 18560);
  assert.equal(total(r, "Storage modelled").check?.result, "pass");
  assert.equal(rowOf(r, "Residential").values.l_per_person_day.source, "kit:Calc_P_Water!D6");
  assert.ok(r.notes.some((n) => /1 room\(s\) have no FMC_Design_Population/.test(n)));
  assert.equal(r.result, "pass");

  const odd = one("CA-P-01", facts({ rooms: [{ id: 5, name: "Ward", level: "L0", area_m2: 50, population: 6, occupancy: "Hospital ward" }] }));
  assert.ok(odd.tbc.some((t) => /Hospital ward/.test(t.item) && t.kit_request));
  assert.equal(total(odd, "Daily demand").values.l_per_day.value, null);
});

test("CA-P-02: the kit's sample fixtures give sum DU 160.8 and Qww 6.34 L/s; a fixture's own FMC_Discharge_Units wins", () => {
  const fx: MepFacts["plumbing_fixtures"] = [];
  let id = 1000;
  const add = (family: string, n: number, du: number | null = null) => { for (let i = 0; i < n; i++) fx!.push({ id: id++, family, type: "Standard", du }); };
  add("FMC_P_WC_6L", 48); add("FMC_P_WashBasin", 48); add("FMC_P_Shower", 40); add("FMC_P_KitchenSink", 40); add("FMC_P_WashingMachine", 20); add("FMC_P_FloorGully_100", 8);
  const r = one("CA-P-02", facts({ plumbing_fixtures: fx }));
  assert.equal(total(r, "Sum of DU").values.sum_du.value, 160.8);
  assert.equal(total(r, "Qww = K x sqrt(sum DU)").values.qww.value, 6.34);
  assert.equal(total(r, "Qww = K x sqrt(sum DU)").values.k.source, "kit:Calc_P_Drainage!B14");
  assert.equal(total(r, "Design flow (not less than the largest DU)").values.design_flow.value, 6.34);
  assert.equal(rowOf(r, "Wash basin").values.count.value, 48);
  assert.equal(rowOf(r, "Washing machine").values.count.value, 20);
  assert.equal(r.result, "pass");

  const own = one("CA-P-02", facts({ plumbing_fixtures: [{ id: 1, family: "Slop sink", type: "S1", du: 2.5 }, { id: 2, family: "Odd thing", type: "X", du: null }] }));
  assert.equal(rowOf(own, "Slop sink: S1").values.du.source, "model:1");
  assert.ok(own.tbc.some((t) => t.item === "DU for Odd thing: X"));
  assert.equal(own.result, "TBC");
});

test("CA-FP-01: the kit's sample storeys need 33.8, 33.8 and 31.2 (3 x 13A each); modelled extinguishers are checked", () => {
  const rooms = [
    { id: 1, name: "G", level: "Ground", area_m2: 520, population: null, occupancy: "" },
    { id: 2, name: "F", level: "First", area_m2: 520, population: null, occupancy: "" },
    { id: 3, name: "S", level: "Second", area_m2: 480, population: null, occupancy: "" },
  ];
  const ext = (id: number, level: string, rating = "13A 55B") => ({ id, kind: "extinguisher", family: "FMC_FP_Extinguisher", type: "9L", level, rating, hose_length_m: null });
  const r = one("CA-FP-01", facts({ rooms, fire_devices: [ext(11, "Ground"), ext(12, "Ground"), ext(13, "Ground"), ext(14, "First"), ext(15, "First")] }));
  const by = (l: string) => r.rows.find((x) => x.item === l)!;
  assert.deepEqual(["Ground", "First", "Second"].map((l) => [by(l).values.required_rating.value, by(l).values.extinguishers_required.value]), [[33.8, 3], [33.8, 3], [31.2, 3]]);
  assert.equal(by("Ground").values.required_rating.source, "kit:Calc_FP_Extinguishers!A2");
  assert.equal(by("Ground").check?.result, "pass");
  assert.equal(by("First").check?.result, "fail");
  assert.equal(by("Second").check?.result, "fail");
  assert.equal(r.result, "fail");
});

test("CA-FP-02: hose reel radius = hose length + throw; the kit has no throw, so it is TBC until the engineer gives one", () => {
  const rooms = [
    { id: 1, name: "Near", number: "01", level: "L0", area_m2: 20, population: null, occupancy: "", x_mm: 20000, y_mm: 0 },
    { id: 2, name: "Far", number: "02", level: "L0", area_m2: 20, population: null, occupancy: "", x_mm: 40000, y_mm: 0 },
  ];
  const reel = { id: 7, kind: "hose_reel", family: "FMC_FP_HoseReel", type: "30m", level: "L0", rating: "", hose_length_m: 30, x_mm: 0, y_mm: 0 };
  const bare = one("CA-FP-02", facts({ rooms, fire_devices: [reel] }));
  assert.ok(bare.tbc.some((t) => t.item === "hose reel throw" && t.kit_request));
  assert.equal(bare.rows[0].check?.result, "TBC");
  const r = one("CA-FP-02", facts({ rooms, fire_devices: [reel] }), { hose_throw_m: 6 });
  assert.equal(r.totals[0].values.radius_m.value, 36);
  assert.deepEqual(r.rows.map((x) => x.check?.result), ["pass", "fail"]);
});

test("CA-LP-02: measured earth resistance against a target the kit doesn't give (TBC) or the engineer gives", () => {
  const lp = [
    { id: 1, family: "FMC_LP_EarthPit", type: "Rod", part: "Earth", mark: "EP-01", earth_resistance_ohm: 8 },
    { id: 2, family: "FMC_LP_EarthPit", type: "Rod", part: "Earth", mark: "EP-02", earth_resistance_ohm: null },
    { id: 3, family: "FMC_LP_AirRod", type: "1m", part: "Air", mark: "AT-01", earth_resistance_ohm: null },
  ];
  const bare = one("CA-LP-02", facts({ lp_parts: lp }));
  assert.equal(bare.rows.length, 2);
  assert.ok(bare.tbc.some((t) => t.item === "design earth resistance target" && t.kit_request));
  const r = one("CA-LP-02", facts({ lp_parts: lp }), { earth_target_ohm: 10 });
  assert.deepEqual(r.rows.map((x) => x.check?.result), ["pass", "TBC"]);
  assert.ok(r.tbc.some((t) => t.item === "earth pit EP-02" && /not measured/.test(t.missing)));
});

test("an empty model gives no input and no errors; kit change requests list only what the kit lacks", () => {
  const all = runCalcs([], facts({}), tabs).results;
  assert.equal(all.length, 7);
  for (const r of all) assert.equal(r.result, "no input", r.id);
  const withData = runCalcs(["CA-E-02", "CA-FP-02"], facts({ circuits: [circuit({ classes: "Power", current_a: 5, length_m: 10, wire_size: "2.5mm" })],
    fire_devices: [{ id: 1, kind: "hose_reel", family: "R", type: "R", level: "L0", rating: "", hose_length_m: 30 }] }), tabs).results;
  assert.deepEqual(kitRequests(withData).map((k) => k.item), ["mV/A/m for 2.5 mm2", "hose reel throw"]);
  assert.deepEqual(runCalcs(["CA-X-99"], facts({}), tabs).unknown, ["CA-X-99"]);
});

test("list: what the kit gives and lacks per calc, and the calcs the kit leaves to another tool", () => {
  const { calcs, elsewhere } = listCalcs(tabs);
  assert.deepEqual(calcs.map((c) => c.id), ["CA-E-01", "CA-E-02", "CA-P-01", "CA-P-02", "CA-FP-01", "CA-FP-02", "CA-LP-02"]);
  const e01 = calcs.find((c) => c.id === "CA-E-01")!;
  assert.ok(e01.kit_provides.some((k) => k.name === "demand factor lighting" && k.value === 0.8));
  assert.deepEqual(e01.kit_missing, []);
  assert.ok(calcs.find((c) => c.id === "CA-E-02")!.kit_missing.some((m) => /mV\/A\/m/.test(m)));
  assert.ok(calcs.find((c) => c.id === "CA-LP-02")!.kit_missing.includes("design earth resistance target (ohm)"));
  const by = (id: string) => elsewhere.find((e) => e.id === id)!.done_by;
  assert.equal(by("CA-E-03"), "DIALux (specialist tool), per kit");
  assert.equal(by("CA-M-01"), "Revit Systems Analysis, per kit");
  assert.equal(by("CA-M-02"), "Schedule calculated fields, per kit");
  assert.equal(by("CA-LP-01"), "the kit workbook's Calc_LP_Design sheet, per kit");
});

test("sheet: a draft header, every TBC with what is missing, and only into 01_WIP\\<Role>\\_Calcs, never over an earlier one", () => {
  const r = one("CA-LP-02", facts({ lp_parts: [{ id: 2, family: "Pit", type: "Rod", part: "Earth", mark: "EP-02", earth_resistance_ohm: null }] }));
  const md = sheetMarkdown(r, { model: "M", kit: "K", date: "2026-10-19", project: "D:\\Projects\\F26001" });
  assert.ok(md.includes(DRAFT_HEADER));
  assert.ok(md.includes("- design earth resistance target: not in the kit: the engineer gives it (inputs.earth_target_ohm) (kit change request)"));
  assert.ok(md.includes("- earth pit EP-02: not measured yet (FMC_Earth_Resistance_Ohm empty)"));
  assert.match(sheetCsv(r), /CA-LP-02,tbc,earth pit EP-02,missing/);

  const cfg = { ...DEFAULT_CONFIG, write_roots: ["D:\\Projects"] };
  const p = sheetPlan("D:\\Projects\\F26001", r, "2026-10-19", cfg, () => false);
  assert.equal(p.ok, true);
  assert.equal(p.files.md, "D:\\Projects\\F26001\\01_WIP\\LP\\_Calcs\\2026-10-19_CA-LP-02.md");
  const again = sheetPlan("D:\\Projects\\F26001", r, "2026-10-19", cfg, (f) => f.endsWith("2026-10-19_CA-LP-02.json"));
  assert.equal(again.files.csv, "D:\\Projects\\F26001\\01_WIP\\LP\\_Calcs\\2026-10-19_CA-LP-02_2.csv");
  assert.equal(sheetPlan("E:\\Elsewhere", r, "2026-10-19", cfg, () => false).ok, false);
  assert.equal(sheetPlan("", r, "2026-10-19", cfg, () => false).ok, false);
});
