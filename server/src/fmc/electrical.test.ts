import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ELEC_PARAMS, kitChangeRequest, missingFromKit, planEnrich, planSizing, sharedParameterNames, sizingWrites, writesCsv } from "./electrical.js";
import { FMC_ELECTRICAL_SHAPE, runFmcElectrical, type FmcElectricalArgs } from "../tools/fmc_electrical.js";

const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const args = (a: object) => z.object(FMC_ELECTRICAL_SHAPE).parse(a) as FmcElectricalArgs;
const ALL = ELEC_PARAMS.map((p) => p.name);

test("F79 there are exactly 16 electrical parameters and all are assumed in the kit request", () => {
  assert.equal(ELEC_PARAMS.length, 16);
  assert.equal(new Set(ALL).size, 16);
  const req = kitChangeRequest([]);
  assert.equal(req.missing, 16);
  assert.ok(req.parameters.every((p) => p.value_status === "assumed"));
  assert.equal(kitChangeRequest(ALL).missing, 0);
  assert.equal(missingFromKit(["fmc_e_connected_va"]).length, 15);
});

test("F79 a shared parameter file is read for names only", () => {
  const text = "# x\nGROUP\t1\tG\nPARAM\tabc\tFMC_E_Connected_VA\tNUMBER\t\t1\t1\n*PARAM\tGUID\tNAME\nPARAM\tdef\tFMC_Code\tTEXT\t\t1\t1\n";
  assert.deepEqual(sharedParameterNames(text), ["FMC_E_Connected_VA", "FMC_Code"]);
});

test("F79 enrich: VA from watts and a given power factor, TBC without one, kit gate on every write", () => {
  const r = planEnrich([
    { id: 1, watts: 800, power_factor: 0.8, phases: 1, voltage_v: 230, load_class: "Power" },
    { id: 2, watts: 500 },
    { id: 3, va: 1200.456 },
  ], ["FMC_E_Connected_VA", "FMC_E_Phases"]);
  assert.equal(r.engineer, "");
  assert.deepEqual(r.writes.filter((w) => w.element_id === "1").map((w) => [w.parameter, w.value]), [["FMC_E_Connected_VA", 1000], ["FMC_E_Phases", 1]]);
  assert.equal(r.writes.find((w) => w.element_id === "3")?.value, 1200.46);
  assert.ok(r.tbc.some((t) => t.element_id === "2" && /power factor/.test(t.missing)));
  assert.ok(r.skipped.some((s) => s.parameter === "FMC_E_Voltage_V"));
  assert.ok(!r.writes.some((w) => w.element_id === "2"));
  assert.equal(r.csv.split("\n")[0], "ElementId,FMC_E_Connected_VA,FMC_E_Phases");
});

test("F79 enrich rejects a power factor outside 0 to 1 and writes nothing to a parameter the kit lacks", () => {
  const r = planEnrich([{ id: 9, watts: 100, power_factor: 1.4 }], ALL);
  assert.equal(r.writes.length, 0);
  assert.equal(r.tbc.length, 1);
  assert.equal(planEnrich([{ id: 9, va: 100 }], []).writes.length, 0);
});

const TABLE = [{ size_mm2: 1.5, rating_a: 17, mv_per_a_m: 29 }, { size_mm2: 2.5, rating_a: 24, mv_per_a_m: 18 }, { size_mm2: 4, rating_a: 32, mv_per_a_m: 11 }, { size_mm2: 6, rating_a: 41, mv_per_a_m: 7.3 }, { size_mm2: 10, rating_a: 57, mv_per_a_m: 4.4 }];
const INP = { cable_table: TABLE, breaker_ratings_a: [6, 10, 16, 20, 25, 32, 40], vd_limit_percent: 4, derating: 0.8 };

test("F79 size: a draft breaker, cable and voltage drop from the engineer's inputs", () => {
  const r = planSizing([{ id: 1, name: "S1", connected_va: 3000, voltage_v: 230, phases: 1, length_m: 25, demand_factor: 1 }], INP);
  const c = r.circuits[0];
  assert.equal(c.status, "Draft");
  assert.equal(c.engineer, "");
  assert.equal(c.design_current_a, 13.04);
  assert.equal(c.breaker_a, 16);
  assert.equal(c.cable_mm2, 2.5); // 24 A x 0.8 = 19.2 >= 16, 18 mV/A/m x 13.04 A x 25 m = 5.87 V = 2.55 %
  assert.equal(c.vd_percent, 2.55);
  assert.match(r.header, /does not size or sign/);
});

test("F79 size: a cable that fails voltage drop steps up; one that carries nothing is TBC", () => {
  const long = planSizing([{ id: 2, name: "S2", connected_va: 3000, voltage_v: 230, phases: 1, length_m: 80, demand_factor: 1 }], INP).circuits[0];
  assert.equal(long.cable_mm2, 6);
  assert.ok((long.vd_percent ?? 99) <= 4);
  const big = planSizing([{ id: 3, name: "S3", connected_va: 30000, voltage_v: 230, phases: 1, length_m: 10, demand_factor: 1 }], INP).circuits[0];
  assert.equal(big.status, "TBC");
  assert.ok(big.missing.some((m) => /breaker rating/.test(m)));
});

test("F79 size: three phase current, circuit demand factor beats the fallback", () => {
  const c = planSizing([{ id: 4, name: "T1", connected_va: 20000, voltage_v: 400, phases: 3, length_m: 20, demand_factor: 0.5 }], { ...INP, demand_factor: 1 }).circuits[0];
  assert.equal(c.demand_va, 10000);
  assert.equal(c.design_current_a, 14.43);
});

test("F79 size: nothing is defaulted; every missing input is named and the row is TBC", () => {
  const r = planSizing([{ id: 5, name: "X", connected_va: 1000, voltage_v: 230, phases: 1 }], {});
  const c = r.circuits[0];
  assert.equal(c.status, "TBC");
  for (const w of [/demand factor/, /cable table/, /breaker ratings/, /voltage drop limit/, /derating/, /route length/]) assert.ok(c.missing.some((m) => w.test(m)), String(w));
  assert.equal(c.breaker_a, undefined);
  assert.equal(r.totals.tbc, 1);
});

test("F79 sizing writes are kit gated, never carry an engineer and keep the status Draft or TBC", () => {
  const r = planSizing([{ id: 1, name: "S1", connected_va: 3000, voltage_v: 230, phases: 1, length_m: 25, demand_factor: 1 }], INP);
  const w = sizingWrites(r.circuits, { S1: "77" }, ["FMC_E_Breaker_Rating_A", "FMC_E_Sizing_Status", "FMC_E_Engineer"]);
  assert.deepEqual(w.writes.map((x) => x.parameter), ["FMC_E_Breaker_Rating_A", "FMC_E_Sizing_Status"]);
  assert.ok(w.skipped.length >= 5);
  assert.ok(!w.writes.some((x) => x.parameter === "FMC_E_Engineer"));
  assert.equal(w.writes[1].value, "Draft");
  assert.equal(writesCsv([]), "ElementId");
});

test("F79 the tool is read-only, needs inputs and reads a kit file", async () => {
  const none = await runFmcElectrical(args({ action: "enrich" }));
  assert.equal(body(none).code, "FMC-ELEC-INPUT");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-elec-"));
  const file = path.join(dir, "kit.txt");
  fs.writeFileSync(file, "PARAM\tg1\tFMC_E_Connected_VA\tNUMBER\t\t1\t1\n");
  const e = body(await runFmcElectrical(args({ action: "enrich", shared_parameter_file: file, devices: [{ id: 1, va: 500 }] })));
  assert.equal(e.read_only, true);
  assert.equal(e.writes.length, 1);
  assert.equal(e.saved, false);
  const k = body(await runFmcElectrical(args({ action: "kit_request", shared_parameter_file: file })));
  assert.equal(k.request.missing, 15);
  const missingFile = body(await runFmcElectrical(args({ action: "kit_request", shared_parameter_file: path.join(dir, "nope.txt") })));
  assert.equal(missingFile.request.missing, 16);
  assert.match(missingFile.notes[0], /Cannot read/);
  const s = body(await runFmcElectrical(args({ action: "size", circuits: [{ id: 1, name: "S1", connected_va: 3000, voltage_v: 230, phases: 1, length_m: 25, demand_factor: 1 }], inputs: INP })));
  assert.equal(s.circuits[0].breaker_a, 16);
  fs.rmSync(dir, { recursive: true, force: true });
});