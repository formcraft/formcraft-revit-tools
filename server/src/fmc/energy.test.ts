import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";
import {
  bearingDeg, citeLimit, classOf, classSummary, envelopeFacts, knownU, sectorOf, shgcChecks, typeRows, typesCsv, uChecks, verdictOf,
  wwrBySector, wwrChecks, type CitedLimit, type EnergyFact, type EnvelopeClass,
} from "./energy.js";
import { FMC_ENERGY_SHAPE, runFmcEnergy, type FmcEnergyArgs } from "../tools/fmc_energy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function args(partial: Record<string, unknown>): FmcEnergyArgs {
  return z.object(FMC_ENERGY_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, unknown> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

// A 10 x 10 box: four 30 m2 net walls (U 0.30), 10 m2 of windows on the south (U 2.8, SHGC 0.6), 100 m2 roof (U 0.18),
// a ground floor with no thermal properties, and a first floor that is not envelope.
const wall = (id: string, normal: number[]): EnergyFact => ({ id, kind: "wall", type_id: "W1", type_name: "FMC_Wall_Block_230", area_m2: 30, u_value: 0.3, normal });
const facts: EnergyFact[] = [
  wall("1", [0, 1, 0]), wall("2", [1, 0, 0]), wall("3", [0, -1, 0]), wall("4", [-1, 0, 0]),
  { id: "10", kind: "window", type_id: "G1", type_name: "FMC_Window_1200x1500", area_m2: 5, u_value: 2.8, shgc: 0.6, normal: [0, -1, 0], host_id: "3", host_kind: "wall" },
  { id: "11", kind: "window", type_id: "G1", type_name: "FMC_Window_1200x1500", area_m2: 5, u_value: 2.8, shgc: 0.6, normal: [0, -1, 0], host_id: "3", host_kind: "wall" },
  { id: "20", kind: "roof", type_id: "R1", type_name: "FMC_Roof_Clay_Tile", area_m2: 100, u_value: 0.18, normal: [0, 0, 1] },
  { id: "30", kind: "floor", type_id: "F1", type_name: "FMC_Slab_150", area_m2: 100, u_value: 0, r_value: 0, level_elevation_mm: 0, layers_without_thermal: 2 },
  { id: "31", kind: "floor", type_id: "F1", type_name: "FMC_Slab_150", area_m2: 100, u_value: 0, level_elevation_mm: 3000 },
];

const limitsOf = (v: Partial<Record<EnvelopeClass, number>>): Record<EnvelopeClass, CitedLimit> => ({
  wall: citeLimit(null, "w", v.wall), roof: citeLimit(null, "r", v.roof), floor: citeLimit(null, "f", v.floor),
  glazing: citeLimit(null, "g", v.glazing), door: citeLimit(null, "d", v.door),
});

test("classes, known U and bearings", () => {
  assert.equal(classOf("curtain_wall"), "glazing");
  assert.equal(classOf("skylight"), "glazing");
  assert.equal(classOf("door"), "door");
  assert.equal(knownU({ u_value: 0.3 }), 0.3);
  assert.equal(knownU({ u_value: 0, r_value: 4 }), 0.25);
  assert.equal(knownU({ u_value: 0, r_value: 0 }), null);
  assert.equal(knownU({ u_value: null }), null);
  assert.equal(bearingDeg([0, 1, 0]), 0);
  assert.equal(bearingDeg([1, 0, 0]), 90);
  assert.equal(bearingDeg([0, -1, 0]), 180);
  assert.equal(bearingDeg([-1, 0, 0]), 270);
  assert.equal(bearingDeg([0, 0, 1]), null);
  assert.equal(bearingDeg(null), null);
  // Project to shared is a rotation by the angle about Z: +90 deg turns project east (x) to true north.
  assert.equal(bearingDeg([1, 0, 0], Math.PI / 2), 0);
  assert.equal(sectorOf(0), "N");
  assert.equal(sectorOf(44.9), "N");
  assert.equal(sectorOf(45), "E");
  assert.equal(sectorOf(180), "S");
  assert.equal(sectorOf(300), "W");
  assert.equal(sectorOf(315), "N");
  assert.equal(sectorOf(null), "H");
});

test("ground floors only by default, types merge, UA leaves out unknown U", () => {
  const { kept, floors_dropped } = envelopeFacts(facts);
  assert.equal(floors_dropped, 1);
  assert.equal(envelopeFacts(facts, "all").floors_dropped, 0);
  const rows = typeRows(kept);
  assert.deepEqual(rows.map((r) => r.class), ["wall", "glazing", "roof", "floor"]);
  const w = rows.find((r) => r.class === "wall")!;
  assert.equal(w.elements, 4);
  assert.equal(w.area_m2, 120);
  assert.equal(w.ua_w_k, 36);
  const floor = rows.find((r) => r.class === "floor")!;
  assert.equal(floor.u_value, null);
  assert.equal(floor.u_source, "unknown");
  const s = classSummary(rows);
  assert.equal(s.ua_total_w_k, 36 + 28 + 18);
  assert.equal(s.area_total_m2, 330);
  assert.equal(s.area_unknown_u_m2, 100);
  assert.equal(s.classes.find((c) => c.class === "floor")!.mean_u_w_m2k, null);
  assert.equal(s.classes.find((c) => c.class === "glazing")!.mean_u_w_m2k, 2.8);
});

test("WWR overall and by orientation, curtain-wall windows not added twice", () => {
  const r = wwrBySector(facts);
  assert.equal(r.overall.wall_m2, 120);
  assert.equal(r.overall.glazing_m2, 10);
  assert.equal(r.overall.wwr, Math.round((10 / 130) * 1000) / 1000);
  const south = r.sectors.find((s) => s.sector === "S")!;
  assert.equal(south.wwr, 0.25);
  assert.equal(r.sectors.find((s) => s.sector === "N")!.wwr, 0);
  const cw: EnergyFact[] = [
    { id: "40", kind: "curtain_wall", type_id: "CW", type_name: "CW", area_m2: 20, normal: [0, 1, 0] },
    { id: "41", kind: "window", type_id: "D", type_name: "CW door", area_m2: 2, normal: [0, 1, 0], host_kind: "curtain_wall" },
  ];
  assert.equal(wwrBySector(cw).overall.glazing_m2, 20);
  const checks = wwrChecks(r, citeLimit(null, "energy.max_wwr", 0.2), true);
  assert.equal(checks.failures.length, 1);
  assert.equal(checks.failures[0].sector, "S");
  assert.equal(wwrChecks(r, citeLimit(null, "energy.max_wwr", 0.2), false).failures.length, 0);
  const noLimit = wwrChecks(r, citeLimit(null, "energy.max_wwr", undefined), true);
  assert.equal(noLimit.failures.length, 0);
  assert.equal(verdictOf(noLimit.failures.length, noLimit.checked, citeLimit(null, "energy.max_wwr", undefined)), "NO_LIMIT");
});

test("U and SHGC checks: unknown U is never a PASS, no limit is NO_LIMIT", () => {
  const rows = typeRows(envelopeFacts(facts).kept);
  const u = uChecks(rows, limitsOf({ wall: 0.35, roof: 0.15, glazing: 2.2, floor: 0.25 }));
  assert.deepEqual(u.failures.map((f) => f.type_id).sort(), ["G1", "R1"]);
  assert.equal(u.unknown.length, 1);
  assert.equal(u.unknown[0].code, "U_UNKNOWN");
  assert.match(u.unknown[0].message, /2 layers without a thermal asset/);
  assert.equal(verdictOf(u.failed.wall, u.checked.wall, citeLimit(null, "w", 0.35)), "PASS");
  assert.equal(verdictOf(u.failed.floor, u.checked.floor, citeLimit(null, "f", 0.25)), "UNKNOWN");
  const none = uChecks(rows, limitsOf({}));
  assert.equal(none.failures.length, 0);
  assert.equal(verdictOf(0, 1, citeLimit(null, "w", undefined)), "NO_LIMIT");
  assert.equal(verdictOf(0, 1, { key: "w", value: 0.3, source: "provisional", clause: "", can_pass: false }), "PROVISIONAL");
  const sh = shgcChecks(rows, citeLimit(null, "energy.max_shgc", 0.4));
  assert.equal(sh.failures.length, 1);
  assert.equal(sh.failures[0].code, "SHGC_ABOVE_MAX");
  const csv = typesCsv(rows, limitsOf({ wall: 0.35 }));
  assert.match(csv, /^Class,Type,Type id/);
  assert.match(csv, /U unknown/);
  assert.match(csv, /No limit/);
});

test("limits: call, then standards bank with a clause, a bank value without a clause cannot PASS, no default", () => {
  const bank = { standards: { "energy.max_u_wall_w_m2k": { value: 0.35, status: "draft", clause: "KS 2949 Table 4" }, "energy.max_wwr": { value: 0.4 } } };
  assert.equal(citeLimit(bank, "energy.max_u_wall_w_m2k", undefined).source, "standards");
  assert.equal(citeLimit(bank, "energy.max_u_wall_w_m2k", 0.3).value, 0.3);
  assert.equal(citeLimit(bank, "energy.max_wwr", undefined).can_pass, false);
  assert.equal(citeLimit(bank, "energy.max_u_roof_w_m2k", undefined).value, null);
  assert.equal(citeLimit(null, "energy.max_u_roof_w_m2k", undefined).source, "none");
});

test("the tool is read-only, names the document, writes JSON and CSV, and the add-in starts no transaction", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-energy-"));
  const env = { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, FMC_ENERGY_DIR: path.join(dir, "energy"), FMC_STANDARDS_FILE: path.join(dir, "missing.json") } as NodeJS.ProcessEnv;
  const missing = textOf(await runFmcEnergy(args({}), { env, standards: null }));
  assert.equal(missing.code, "FMC-DOC-REQUIRED");
  assert.equal(missing.isError, true);

  const refused = textOf(await runFmcEnergy(args({ document: "X" }), { env, standards: null, read: async () => ({ refused: true, code: "FMC-DOC-NOT-FOUND", message: "no" }) }));
  assert.equal(refused.isError, true);
  assert.equal(refused.code, "FMC-DOC-NOT-FOUND");

  let sent: Record<string, unknown> = {};
  const body = textOf(await runFmcEnergy(args({ document: "F26901-FMC-ZZ-ZZ-M3-A-0001_USER", limits: { wall: 0.35, window: 2.2, wwr: 0.4 } }), {
    env,
    standards: null,
    read: async (b) => {
      sent = b;
      return {
        resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-A-0001_USER", path: "D:\\Jobs\\_Staging\\A.rvt" },
        true_north_angle_rad: 0,
        energy_settings: { building_type: "Office" },
        notes: [],
        elements: [...facts, { id: "99", kind: "furniture" }],
      };
    },
  }));
  assert.equal(sent.document, "F26901-FMC-ZZ-ZZ-M3-A-0001_USER");
  assert.equal(body.isError, false);
  assert.equal(body.read_only, true);
  assert.equal(body.transaction, false);
  assert.equal(body.elements, 8);
  assert.equal(body.types_count, 4);
  assert.equal(body.unknown_u_count, 1);
  const checks = body.checks as { u_value: Record<string, { status: string }>; shgc: { status: string }; wwr: { status: string } };
  assert.equal(checks.u_value.wall.status, "PASS");
  assert.equal(checks.u_value.glazing.status, "FAIL");
  assert.equal(checks.u_value.roof.status, "NO_LIMIT");
  assert.equal(checks.u_value.door.status, "NOT_APPLICABLE");
  assert.equal(checks.u_value.floor.status, "UNKNOWN");
  assert.equal(checks.shgc.status, "NO_LIMIT");
  assert.equal(checks.wwr.status, "PASS");
  assert.equal(body.failure_count, 1);
  const report = body.report as { json: string; csv: string };
  assert.ok(fs.existsSync(report.json));
  assert.match(fs.readFileSync(report.csv, "utf8"), /^Class,Type/);

  const source = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcEnergy.cs"), "utf8");
  assert.equal(source.includes("new Transaction"), false);
  assert.equal(source.includes("TransactionGroup"), false);
  assert.equal(source.includes("SubTransaction"), false);
  assert.equal(source.includes("RollBack"), false);
  assert.equal(source.includes("EnergyAnalysisDetailModel.Create"), false);
  assert.equal(/\.Set\(/.test(source.replace(/_done\.Set\(\)/g, "")), false);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_energy"));
  assert.equal(WRITE_COMMANDS.has("fmc_energy"), false);
  const commands = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.ok(commands.commands.some((c) => c.commandName === "fmc_energy"));
});

const guard = {
  write_roots: ["D:\\Jobs"], blocked_segments: ["03_published", "04_archive"], library_roots: [], template_roots: [], live_model_lock: true,
} as unknown as import("./policy.js").GuardConfig;
const docRead = (path: string, extra: Record<string, unknown> = {}) => async () => ({
  resolved_document: { title: "F26901-FMC-ZZ-ZZ-M3-A-0001_USER", path }, path, is_model_in_cloud: false, notes: [], ...extra,
});
const rvtPath = "D:\\Jobs\\F26901\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0001_USER.rvt";
const gbxml = `<gbXML lengthUnit="Meters"><Campus id="c"><Building id="b"><Space id="s1"/></Building>
<Surface id="su" surfaceType="ExteriorWall" constructionIdRef="k"><AdjacentSpaceId spaceIdRef="s1"/>
<RectangularGeometry><Width>4</Width><Height>3</Height></RectangularGeometry></Surface></Campus><Construction id="k"/></gbXML>`;

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-energy-modes-"));
  return { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, FMC_ENERGY_DIR: path.join(dir, "energy") } as NodeJS.ProcessEnv;
}

test("analytical mode is read-only and turns the report into findings", async () => {
  let sent: Record<string, unknown> = {};
  const body = textOf(await runFmcEnergy(args({ document: "A", mode: "analytical" }), {
    env: tempEnv(), standards: null,
    read: async (b) => { sent = b; return { resolved_document: { title: "A", path: rvtPath }, analytical: { model: { exists: true, spaces: 3, surfaces_no_space: 2 }, rooms: { placed: 3 } } }; },
  }));
  assert.deepEqual(sent.parts, ["analytical"]);
  assert.equal(body.isError, false);
  assert.equal(body.read_only, true);
  assert.equal(body.transaction, false);
  assert.equal(body.status, "WARN");
  assert.deepEqual((body.findings as Array<{ code: string }>).map((f) => f.code), ["SURFACE_NO_SPACE"]);
});

test("export: dry run plans beside the .rvt; a real export sends fmc_energy_export and checks the new file; refusals", async () => {
  const now = new Date(2026, 10, 28, 9, 5);
  const planned = "D:\\Jobs\\F26901\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0001_USER_gbXML_20261128-0905.xml";
  let sends = 0;
  const dry = textOf(await runFmcEnergy(args({ document: "A", mode: "export" }), {
    env: tempEnv(), guard, now, exists: () => false, read: docRead(rvtPath), send: async () => { sends++; return {}; },
  }));
  assert.equal(dry.isError, false);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.file, planned);
  assert.equal(sends, 0);

  let sent: Record<string, unknown> = {};
  const real = textOf(await runFmcEnergy(args({ document: "A", mode: "export", dry_run: false }), {
    env: tempEnv(), guard, now, exists: () => false, read: docRead(rvtPath),
    send: async (b) => { sent = b; return { file: planned, transaction_used: "none", new_files: [planned], is_modified_after: false }; },
    readFile: (f) => { assert.equal(f, planned); return gbxml; },
  }));
  assert.equal(real.isError, false);
  assert.equal(sent.file_name, "F26901-FMC-ZZ-ZZ-M3-A-0001_USER_gbXML_20261128-0905");
  assert.equal(sent.expected_folder, "D:\\Jobs\\F26901\\01_WIP\\A");
  assert.equal(real.read_only, false);
  assert.equal(real.saved, false);
  assert.equal(real.file_written, true);
  assert.equal((real.check as { status: string }).status, "PASS");

  const moved = textOf(await runFmcEnergy(args({ document: "A", mode: "export", dry_run: false }), {
    env: tempEnv(), guard, now, exists: () => false, read: docRead(rvtPath), send: async () => ({ file: "C:\\Windows\\x.xml" }), readFile: () => gbxml,
  }));
  assert.equal(moved.code, "FMC-ENERGY-PATH-MISMATCH");

  const refusals: Array<[string, () => Promise<unknown>, string]> = [
    ["unsaved", docRead(""), "FMC-ENERGY-UNSAVED"],
    ["cloud flag", docRead(rvtPath, { is_model_in_cloud: true }), "FMC-ENERGY-CLOUD"],
    ["cloud path", docRead("BIM 360://Hebert/A.rvt"), "FMC-ENERGY-CLOUD"],
    ["CDE gate", docRead("D:\\Jobs\\F26901\\03_PUBLISHED\\A.rvt"), "FMC-ENERGY-WRITE-REFUSED"],
    ["outside write roots", docRead("C:\\Temp\\A.rvt"), "FMC-ENERGY-WRITE-REFUSED"],
  ];
  for (const [label, read, code] of refusals) {
    const r = textOf(await runFmcEnergy(args({ document: "A", mode: "export", dry_run: false }), {
      env: tempEnv(), guard, now, exists: () => false, read, send: async () => { sends++; return {}; },
    }));
    assert.equal(r.isError, true, label);
    assert.equal(r.code, code, label);
  }
  const exists = textOf(await runFmcEnergy(args({ document: "A", mode: "export", dry_run: false, file_name: "run1" }), {
    env: tempEnv(), guard, now, exists: () => true, read: docRead(rvtPath), send: async () => { sends++; return {}; },
  }));
  assert.equal(exists.code, "FMC-ENERGY-EXISTS");
  assert.equal(sends, 0);
});

test("check mode reads only a gbXML inside the project folder", async () => {
  const ok = textOf(await runFmcEnergy(args({ document: "A", mode: "check", file: "run1.xml" }), {
    env: tempEnv(), read: docRead(rvtPath), readFile: () => gbxml,
  }));
  assert.equal(ok.isError, false);
  assert.equal(ok.read_only, true);
  assert.equal(ok.file, "D:\\Jobs\\F26901\\01_WIP\\A\\run1.xml");
  assert.equal((ok.check as { counts: { surface: number } }).counts.surface, 1);
  const outside = textOf(await runFmcEnergy(args({ document: "A", mode: "check", file: "..\\..\\secret.xml" }), {
    env: tempEnv(), read: docRead(rvtPath), readFile: () => { throw new Error("must not read"); },
  }));
  assert.equal(outside.code, "FMC-ENERGY-CHECK-PATH");
});

test("export is a model-changing command; the read and analytical add-in code starts no transaction; export never saves", () => {
  assert.ok(WRITE_COMMANDS.has("fmc_energy_export"));
  assert.equal(READ_VIA_SEND_COMMAND.has("fmc_energy_export"), false);
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_energy"));
  const commands = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  assert.ok(commands.commands.some((c) => c.commandName === "fmc_energy_export"));
  const analytical = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcEnergyAnalytical.cs"), "utf8");
  for (const banned of ["new Transaction", "TransactionGroup", "SubTransaction", "RollBack", "EnergyAnalysisDetailModel.Create", "Export("]) assert.equal(analytical.includes(banned), false, banned);
  const exporter = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcEnergyExport.cs"), "utf8");
  for (const banned of [".Save(", "SaveAs(", "SynchronizeWithCentral", "Assimilate(", "group.Commit(", "File.Delete", "File.Copy", "File.Move", "WriteAllText"]) assert.equal(exporter.includes(banned), false, banned);
  assert.ok(exporter.includes("group.RollBack()"));
  assert.ok(exporter.includes("File.Exists(file)"));
  assert.ok(exporter.includes("FMC-ENERGY-OUTSIDE"));
});
