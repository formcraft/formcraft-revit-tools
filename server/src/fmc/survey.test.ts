import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import { cutFillOfTriangle, delaunay, parseSurveyCsv, planSurvey, SURVEY_MAX_POINTS } from "./survey.js";
import { fromAngleMm } from "./coordmath.js";
import { FMC_SURVEY_SHAPE, runFmcSurvey, type FmcSurveyArgs } from "../tools/fmc_survey.js";

function args(partial: Record<string, unknown>): FmcSurveyArgs {
  return z.object(FMC_SURVEY_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, any> {
  return { ...(JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>), isError: result.isError === true };
}

const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const opts = { units: "m", coordinates: "internal" as const, duplicate_tol_mm: 1 };

test("CSV: a header in any order and separator, headerless PENZ and ENZ, bad rows skipped", () => {
  const h = parseSurveyCsv("Point;Northing;Easting;Elevation;Code\nP1;200;100;10;GS\nP2;200;110;11;GS\nP3;x;1;1;GS\n");
  assert.equal(h.format, "header");
  assert.equal(h.points.length, 2);
  assert.deepEqual([h.points[0].e, h.points[0].n, h.points[0].z, h.points[0].code], [100, 200, 10, "GS"]);
  assert.equal(h.skipped.length, 1);
  assert.equal(h.skipped[0].line, 4);
  const p = parseSurveyCsv("1,100,200,10,GS\n2,110,200,11\n");
  assert.equal(p.format, "PENZ");
  assert.equal(p.points[1].e, 110);
  const e = parseSurveyCsv("100\t200\t10\n");
  assert.equal(e.format, "ENZ");
  const n = parseSurveyCsv("1,200,100,10\n", "PNEZ");
  assert.equal(n.points[0].e, 100);
  assert.throws(() => parseSurveyCsv("\n# only a comment\n"), /FMC-SURVEY-CSV/);
  assert.throws(() => parseSurveyCsv("Name,Foo,Bar\nA,1,2\n"), /FMC-SURVEY-CSV|FMC-SURVEY-FEW/);
});

test("Delaunay: a square gives 2 triangles, a grid gives 2(n-1)^2, collinear gives none", () => {
  assert.equal(delaunay([[0, 0], [1, 0], [1, 1], [0, 1]]).length, 2);
  const grid: number[][] = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) grid.push([i * 1000 + 500000, j * 1000 + 9000000]);
  assert.equal(delaunay(grid).length, 32);
  assert.equal(delaunay([[0, 0], [1, 1], [2, 2]]).length, 0);
});

test("cut and fill: a flat pad, a sloped triangle crossing the level, and a 10 m square 1 m above the level", () => {
  const flat = cutFillOfTriangle([0, 0, 5], [1000, 0, 5], [0, 1000, 5], 3);
  assert.equal(Math.round(flat.cut), 500000 * 2);
  assert.equal(flat.fill, 0);
  // Heights -1, +1 at the base corners, 0 at the apex: cut and fill are equal by symmetry.
  const mixed = cutFillOfTriangle([-1000, 0, -1], [1000, 0, 1], [0, 1000, 0], 0);
  assert.ok(Math.abs(mixed.cut - mixed.fill) < 1e-6);
  assert.ok(mixed.cut > 0);
  const csv = "E,N,Z\n0,0,101\n10,0,101\n10,10,101\n0,10,101\n";
  const plan = planSurvey(parseSurveyCsv(csv), { ...opts, design_elevation: 100 }, identity);
  assert.equal(plan.triangles, 2);
  assert.equal(plan.plan_area_m2, 100);
  assert.equal(plan.cut_fill?.cut_m3, 100);
  assert.equal(plan.cut_fill?.fill_m3, 0);
  const below = planSurvey(parseSurveyCsv(csv), { ...opts, design_elevation: 101.5 }, identity);
  assert.equal(below.cut_fill?.fill_m3, 50);
  assert.equal(below.cut_fill?.net_m3, -50);
});

test("shared survey coordinates go to internal with the fmc_coord matrix; duplicates and conflicts are reported", () => {
  // Internal origin sits at E 250000 m, N 9850000 m (mm below), elevation 1600 m, project rotated 30 degrees.
  const its = fromAngleMm(250000000, 9850000000, 1600000, 30);
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  // Internal (10 m, 0, 2 m) in shared metres:
  const e = 250000 + 10 * c;
  const n = 9850000 + 10 * s;
  const csv = `P,E,N,Z\nA,250000,9850000,1600\nB,${e},${n},1602\nC,250000,9850010,1601\nD,250000.0004,9850000,1600\nF,250000,9850000.0002,1605\n`;
  const plan = planSurvey(parseSurveyCsv(csv), { units: "m", coordinates: "shared", duplicate_tol_mm: 1, design_elevation: 1600 }, its);
  assert.equal(plan.points.length, 3);
  assert.deepEqual(plan.points[0].xyz_mm.map((v) => Math.round(v)), [0, 0, 0]);
  assert.deepEqual(plan.points[1].xyz_mm.map((v) => Math.round(v)), [10000, 0, 2000]);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0].id, "D");
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].id, "F");
  assert.equal(plan.cut_fill?.design_internal_mm, 0);
  assert.throws(() => planSurvey(parseSurveyCsv("E,N,Z\n0,0,0\n1,1,1\n"), opts, identity), /FMC-SURVEY-FEW/);
  assert.throws(() => planSurvey(parseSurveyCsv("E,N,Z\n0,0,0\n1,1,1\n2,2,2\n"), opts, identity), /FMC-SURVEY-FEW/);
  assert.throws(() => planSurvey(parseSurveyCsv(csv), { ...opts, coordinates: "shared" }, []), /FMC-SITE-TRANSFORM/);
  const big = "E,N,Z\n" + Array.from({ length: SURVEY_MAX_POINTS + 1 }, (_, i) => `${i},0,0`).join("\n");
  assert.throws(() => planSurvey(parseSurveyCsv(big), opts, identity), /FMC-SURVEY-TOO-MANY/);
  const coded = planSurvey(parseSurveyCsv("P,E,N,Z,Code\n1,0,0,0,GS\n2,10,0,0,GS\n3,0,10,0,GS\n4,5,5,9,TREE\n"), { ...opts, codes: ["gs"] }, identity);
  assert.equal(coded.points.length, 3);
  assert.equal(coded.filtered_out, 1);
});

const readBody = {
  title: "C", path: "D:\\Jobs\\_Staging\\C.rvt", is_central: false,
  internal_to_shared: identity,
  toposolid_types: [{ id: "500", name: "Toposolid 1000mm" }, { id: "501", name: "Site Gravel" }],
  levels: [{ id: "30", name: "Level 1", elevation_mm: 0 }, { id: "29", name: "Ground", elevation_mm: -500 }],
  toposolids: [],
};
const csv = "E,N,Z\n0,0,1\n10,0,1\n10,10,2\n0,10,2\n5,5,1.5\n";

test("dry run changes nothing and reports the plan; a write needs the lease and references and reads the height back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-survey-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_SURVEY_DIR: path.join(dir, "out") } as NodeJS.ProcessEnv;
  let applied = 0;
  const read = async () => readBody;
  const base = { action: "import", document: "C", csv: "D:\\Jobs\\survey.csv", design_elevation: 1 };
  const dry = textOf(await runFmcSurvey(args(base), { read, readFile: () => csv, apply: async () => { applied += 1; return {}; }, env, guard }));
  assert.equal(dry.dry_run, true);
  assert.equal(dry.read_only, true);
  assert.equal(applied, 0);
  assert.equal(dry.points, 5);
  assert.equal(dry.level.name, "Ground");
  assert.equal(dry.toposolid_type.name, "Toposolid 1000mm");
  assert.equal(dry.comments, "FMC_SURVEY survey.csv");
  assert.equal(dry.cut_fill.fill_m3, 0);
  assert.ok(dry.cut_fill.cut_m3 > 0);
  assert.ok(fs.existsSync(dry.report));
  assert.equal(textOf(await runFmcSurvey(args({ ...base, dry_run: false }), { read, readFile: () => csv, env, guard })).code, "FMC-BATCH-LOCKED");
  assert.equal(textOf(await runFmcSurvey(args({ ...base, dry_run: false, batch_lease: "L" }), { read, readFile: () => csv, env, guard })).code, "FMC-SURVEY-REFERENCES");
  const refs = { kit: ["FMC-BIM-MAN-001"], standards: ["FMC-BIM-STD-002"], rulebook: ["FMC_Rulebook_AIUse"] };
  const done = textOf(await runFmcSurvey(args({ ...base, dry_run: false, batch_lease: "L", references: refs, toposolid_type: "Site Gravel", level: "Level 1" }), {
    read, readFile: () => csv, env, guard,
    apply: async (body) => {
      applied += 1;
      assert.equal(body.type_id, "501");
      assert.equal(body.level_id, "30");
      assert.equal((body.xyz_mm as number[][]).length, 5);
      return { ok: true, toposolid_id: "9001", bbox_mm: { min_z: -1000, max_z: 2000 } };
    },
  }));
  assert.equal(applied, 1);
  assert.equal(done.readback.status, "MATCH");
  const off = textOf(await runFmcSurvey(args({ ...base, dry_run: false, batch_lease: "L", references: refs }), {
    read, readFile: () => csv, env, guard, apply: async () => ({ ok: true, toposolid_id: "9002", bbox_mm: { min_z: -1500, max_z: 1500 } }),
  }));
  assert.equal(off.code, "FMC-SURVEY-READBACK");
});

test("refusals: no document, no CSV, an unknown type or level, and a guarded model", async () => {
  const guard: GuardConfig = { ...DEFAULT_CONFIG };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-survey-r-"));
  const env = { ...process.env, LOCALAPPDATA: dir, APPDATA: dir, FMC_SURVEY_DIR: dir } as NodeJS.ProcessEnv;
  const read = async () => readBody;
  assert.equal(textOf(await runFmcSurvey(args({ action: "read" }), { env, guard })).code, "FMC-DOC-REQUIRED");
  assert.equal(textOf(await runFmcSurvey(args({ action: "import", document: "C" }), { read, env, guard })).code, "FMC-SURVEY-CSV");
  assert.equal(textOf(await runFmcSurvey(args({ action: "import", document: "C", csv_text: csv, toposolid_type: "Nope" }), { read, env, guard })).code, "FMC-SURVEY-TYPE");
  assert.equal(textOf(await runFmcSurvey(args({ action: "import", document: "C", csv_text: csv, level: "Roof" }), { read, env, guard })).code, "FMC-SURVEY-LEVEL");
  assert.equal(textOf(await runFmcSurvey(args({ action: "import", document: "C", csv: "D:\\missing.csv" }), { read, readFile: () => { throw new Error("ENOENT"); }, env, guard })).code, "FMC-SURVEY-CSV");
  const hebert = async () => ({ ...readBody, title: "HEBERT HOSTELS site" });
  const refs = { kit: ["k"], standards: ["s"], rulebook: ["r"] };
  assert.equal(textOf(await runFmcSurvey(args({ action: "import", document: "C", csv_text: csv, dry_run: false, batch_lease: "L", references: refs }), { read: hebert, env, guard })).code, "FMC-SURVEY-GUARD");
  const listed = textOf(await runFmcSurvey(args({ action: "read", document: "C" }), { read, env, guard }));
  assert.equal(listed.read_only, true);
  assert.equal(listed.toposolid_types.length, 2);
});

test("the survey read is not a write and the apply is, and both are in command.json", () => {
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_survey"));
  assert.ok(WRITE_COMMANDS.has("fmc_survey_apply"));
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((row) => row.commandName));
  assert.ok(names.has("fmc_survey") && names.has("fmc_survey_apply"));
});
