import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import { documentRequired } from "./fairqueue.js";
import {
  angDiff, angleDegOf, asTolerance, compose, deltaOf, fromAngleMm, identity, invert, judge, roundMm, rowVectorMatrix,
} from "./coordmath.js";
import {
  alignModelTarget, checkModels, checkSnapshot, coordAppDir, coordExportDir, emptyRecord, exportFiles, mergePoints,
  mergeSnapshot, parseCsvPoints, parseImport, planRecordWrite, poseOf, projectWriteBlock, readRecord, tolerancesFrom,
  writeExport, writeRecordFiles, type ControlPoint, type Snapshot,
} from "./coordrecord.js";
import { FMC_COORD_SHAPE, bindCoordRecord, explainItem, projectKeyFrom, rowIds, runFmcCoord, withExplain, type FmcCoordArgs } from "../tools/fmc_coord.js";

const approved = {
  "coord.tol_mm": { value: 5, unit: "mm", status: "approved", clause: "STD 8.5" },
  "coord.tol_deg": { value: 0.01, unit: "degrees", status: "approved", clause: "STD 8.5" },
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fmc-coord-"));
}

function envOf(dir: string): NodeJS.ProcessEnv {
  return {
    FMC_COORD_DIR: path.join(dir, "app"),
    FMC_COORD_EXPORT_DIR: path.join(dir, "out"),
    APPDATA: path.join(dir, "unread-appdata"),
    LOCALAPPDATA: path.join(dir, "unread-local"),
  } as NodeJS.ProcessEnv;
}

function guard(over: Partial<GuardConfig> = {}): GuardConfig {
  return { ...DEFAULT_CONFIG, save_exclude: [], sync_exclude: [], protected_paths: [], protected_roots: [], ...over };
}

function args(over: Record<string, unknown>): FmcCoordArgs {
  return z.object(FMC_COORD_SHAPE).parse(over);
}

function near(a: number[][], b: number[][], eps = 1e-8): boolean {
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (Math.abs(a[i][j] - b[i][j]) > eps) return false;
  return true;
}

function snap(title: string, tx: number, angle: number, point?: { name: string; x: number }): Snapshot {
  return {
    document: { title, path: `D:\\Jobs\\${title}.rvt` },
    model: {
      internal_to_shared: fromAngleMm(tx, 0, 0, angle),
      angle_deg: angle,
      true_north_angle_deg: angle,
      elevation_datum_mm: 10,
      survey_point: poseOf([tx, 0, 0], angle, "survey"),
      project_base_point: poseOf([0, 0, 0], 0, "project base"),
      shared_origin: poseOf([0, 0, 0], 0, "shared origin"),
      title,
      path: `D:\\Jobs\\${title}.rvt`,
    },
    control_points: point ? [{ ...poseOf([point.x, 20, 0], 0, point.name), name: point.name, kind: "grid" }] : [],
    objects: [{
      ...poseOf([tx + 100, 0, 0], angle, "door"),
      stable_id: "uid-1|D1", unique_id: "uid-1", id: 42, mark: "D1", category: "Doors",
    }],
    families: [{
      ...poseOf([0, 0, 0], 0, "FMC_Z_Marker"),
      name: "FMC_Z_Marker", stable_id: "FMC_Z_Marker", insertion_mm: [0, 0, 0], origin_mm: [0, 0, 0],
      reference_planes: [{ name: "Center (Left/Right)", origin_mm: [0, 0, 0], normal: [1, 0, 0] }],
    }],
  };
}

function body(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

test("matrix: compose then invert is the identity, and the angle round-trips", () => {
  const a = fromAngleMm(1000, -250.5, 30, 90);
  const b = fromAngleMm(0, 500, -4, -33.5);
  const both = compose(a, b);
  assert.ok(near(compose(invert(a), a), identity()));
  assert.ok(near(compose(a, invert(a)), identity()));
  assert.ok(near(compose(invert(both), both), identity()));
  assert.ok(near(multiplyCheck(both, invert(both)), identity()));
  for (const deg of [0, 33.5, -90, 45.25, 180, -180]) {
    const m = fromAngleMm(10.5, -3.25, 8, deg);
    assert.ok(angDiff(angleDegOf(m), deg) < 1e-6, `angle ${deg} came back as ${angleDegOf(m)}`);
    assert.ok(Math.abs(m[0][3] - 10.5) < 1e-9 && Math.abs(m[1][3] + 3.25) < 1e-9 && Math.abs(m[2][3] - 8) < 1e-9);
  }
});

function multiplyCheck(a: number[][], b: number[][]): number[][] {
  return compose(b, a);
}

test("matrix: millimetre rounding touches only the translation column", () => {
  const m = fromAngleMm(1.23456, -2.5, 0.0004, 10);
  const rounded = roundMm(m, 3);
  assert.equal(rounded[0][3], 1.235);
  assert.equal(rounded[1][3], -2.5);
  assert.equal(rounded[2][3], 0);
  assert.equal(rounded[0][0], m[0][0]);
  assert.equal(rounded[1][0], m[1][0]);
  const shifted = deltaOf(fromAngleMm(0, 0, 0, 0), fromAngleMm(3, 4, 0, 90));
  assert.equal(shifted.delta_mm, 5);
  assert.ok(Math.abs(shifted.delta_deg - 90) < 1e-6);
});

test("status: provisional never PASS, draft or approved with a clause can PASS, null is UNKNOWN", () => {
  const within = 1;
  const outside = 20;
  assert.equal(judge(within, asTolerance({ value: 5, status: "provisional", clause: "STD 8.5" })), "PROVISIONAL");
  assert.notEqual(judge(0, asTolerance({ value: 5, status: "Provisional", clause: "STD 8.5" })), "PASS");
  assert.equal(judge(outside, asTolerance({ value: 5, status: "provisional", clause: "STD 8.5" })), "FAIL");
  assert.equal(judge(within, asTolerance({ value: 5, status: "draft", clause: "STD 8.5" })), "PASS");
  assert.equal(judge(within, asTolerance({ value: 5, status: "approved", clause: "STD 8.5" })), "PASS");
  assert.equal(judge(outside, asTolerance({ value: 5, status: "approved", clause: "STD 8.5" })), "FAIL");
  assert.equal(judge(within, asTolerance({ value: 5, status: "draft" })), "UNKNOWN");
  assert.equal(judge(outside, asTolerance({ value: 5, status: "approved" })), "FAIL");
  assert.equal(judge(within, asTolerance({ value: 5, status: null })), "UNKNOWN");
  assert.equal(judge(outside, asTolerance({ value: 5, status: null, clause: "STD 8.5" })), "UNKNOWN");
  assert.equal(judge(within, asTolerance(null)), "UNKNOWN");
  const tols = tolerancesFrom(approved, "kit");
  const same = checkSnapshot(mergeSnapshot(emptyRecord("P", "t"), snap("A", 1000, 0, { name: "A/1", x: 10 }), "all", "t"), snap("A", 1000, 0, { name: "A/1", x: 10 }), tols, "all");
  assert.ok(same.items.every((item) => item.status === "PASS"), JSON.stringify(same.summary));
  const moved = checkSnapshot(mergeSnapshot(emptyRecord("P", "t"), snap("A", 0, 0, { name: "A/1", x: 0 }), "all", "t"), snap("A", 100, 2, { name: "A/1", x: 40 }), tols, "model");
  assert.equal(moved.items[0].status, "FAIL");
  assert.ok(moved.items[0].delta_mm > 5);
  const held = tolerancesFrom({
    "coord.tol_mm": { value: 5000, status: "provisional", clause: "x" },
    "coord.tol_deg": { value: 90, status: "provisional", clause: "x" },
  }, "kit");
  const soft = checkSnapshot(mergeSnapshot(emptyRecord("P", "t"), snap("A", 0, 0), "model", "t"), snap("A", 10, 1), held, "model");
  assert.equal(soft.items[0].status, "PROVISIONAL");
  assert.notEqual(soft.items[0].status, "PASS");
});

test("record I/O, check, import and export stay inside the temp dirs", () => {
  const dir = tmp();
  const env = envOf(dir);
  assert.equal(coordAppDir(env), path.join(dir, "app"));
  assert.equal(coordExportDir(env), path.join(dir, "out"));
  assert.equal(coordAppDir({ APPDATA: path.join(dir, "roam") } as NodeJS.ProcessEnv), path.join(dir, "roam", "Formcraft", "coord"));
  assert.equal(fs.existsSync(path.join(dir, "unread-appdata")), false);

  const cfg = guard();
  let record = mergeSnapshot(emptyRecord("Ogala", "2026-11-22T00:00:00Z"), snap("A-0001", 1000, 12, { name: "A/1", x: 5000 }), "all", "2026-11-22T00:00:00Z");
  record = mergeSnapshot(record, snap("S-0001", 1000, 12.2, { name: "B/1", x: 8000 }), "model", "2026-11-22T00:00:01Z");
  const plan = planRecordWrite(path.join(dir, "proj"), "Ogala", cfg, env);
  const wrote = writeRecordFiles(record, plan);
  assert.equal(wrote.length, 2);
  assert.ok(wrote.every((file) => file.startsWith(dir)));
  const back = readRecord(path.join(dir, "proj"), "Ogala", env);
  assert.equal(back.record?.project, "Ogala");
  assert.equal(back.record?.control_points.length, 2);
  assert.equal(back.record?.objects["uid-1|D1"].id, 42);
  assert.ok(back.record?.families["FMC_Z_Marker"].reference_planes?.length);

  const compared = checkModels(back.record!, "A-0001", "S-0001", tolerancesFrom(approved, "kit"));
  assert.equal(compared.items.length, 1);
  assert.equal(compared.summary.ids.length, 1);
  assert.ok(compared.items[0].delta_deg > 0.01);
  assert.equal(compared.items[0].status, "FAIL");

  const blocked = guard({ protected_paths: ["D:\\Live"], protected_roots: [] });
  assert.match(projectWriteBlock("D:\\Live\\Job\\FMC_Coord.json", blocked) ?? "", /protected/);
  const skipped = planRecordWrite("D:\\Live\\Job", "Ogala", blocked, env);
  assert.equal(skipped.project_file, null);
  assert.match(skipped.project_skipped ?? "", /protected/);
  assert.ok(skipped.app_file.startsWith(path.join(dir, "app")));

  const csv = "name,X,Y,Z,rotation\nCP-1,1000,2000,3,15\n";
  const points = parseCsvPoints(csv);
  assert.equal(points[0].xyz_mm[0], 1000);
  assert.ok(Math.abs(points[0].angle_deg - 15) < 1e-6);
  const imported = mergePoints(back.record!, points, "2026-11-22T01:00:00Z");
  const jsonPoints = parseImport(JSON.stringify({ transforms: [{ name: "CP-2", transform: fromAngleMm(8, 0, 0, 0) }] }), "in.json");
  assert.equal(jsonPoints[0].name, "CP-2");
  const withJson = mergePoints(imported, jsonPoints, "2026-11-22T01:00:01Z");
  writeRecordFiles(withJson, plan);

  const files = exportFiles(withJson, coordExportDir(env), "A-0001");
  writeExport(files);
  const names = files.map((file) => file.name).sort();
  assert.deepEqual(names, ["Ogala-archicad.txt", "Ogala-blender.json", "Ogala-ifcmap.txt", "Ogala-navis.json", "Ogala-points.csv"]);
  const ifc = fs.readFileSync(files[0].path, "utf8");
  assert.match(ifc, /IFCMAPCONVERSION/);
  assert.match(ifc, /1000/);
  assert.match(fs.readFileSync(path.join(coordExportDir(env), "Ogala-archicad.txt"), "utf8"), /ARCHICAD/);
  const navis = JSON.parse(fs.readFileSync(path.join(coordExportDir(env), "Ogala-navis.json"), "utf8")) as { matrix: number[][]; matrix_row_vector: number[][] };
  assert.equal(navis.matrix.length, 4);
  assert.deepEqual(navis.matrix_row_vector, rowVectorMatrix(navis.matrix));
  const blender = JSON.parse(fs.readFileSync(path.join(coordExportDir(env), "Ogala-blender.json"), "utf8")) as { matrix: number[][]; units: string };
  assert.equal(blender.units, "mm");
  assert.deepEqual(blender.matrix, navis.matrix);
  const table = fs.readFileSync(path.join(coordExportDir(env), "Ogala-points.csv"), "utf8");
  assert.match(table, /^name,X,Y,Z,rotation/m);
  assert.match(table, /CP-1,1000,2000,3,15/);
  assert.equal(alignModelTarget(withJson, "survey", "S-0001", "A-0001")?.angle_deg, 12.2);
});

test("fmc_coord: document errors, dry run, one Revit call, and no live appdata", async () => {
  const dir = tmp();
  const env = envOf(dir);
  const cfg = guard();
  const base = { env, guard: cfg, standards: approved, now: () => "2026-11-22T12:00:00Z" };
  const calls: Array<{ command: string; write: boolean; params: Record<string, unknown> }> = [];
  const revit = async (command: string, params: Record<string, unknown>, write: boolean) => {
    calls.push({ command, write, params });
    const shot = snap("A-0001", 1000, 12, { name: "A/1", x: 5000 });
    return { ...shot, resolved_document: shot.document, other: params.other ? snap("S-0001", 1000, 12, { name: "A/1", x: 5000 }) : undefined };
  };

  const missing = body(await runFmcCoord(args({ action: "publish" }), { ...base, revit }));
  assert.match(String(missing.error), /FMC-DOC-REQUIRED/);
  assert.equal(calls.length, 0);

  const open = [{ title: "A-0001", path: "D:\\Jobs\\A-0001.rvt" }, { title: "A-0001", path: "D:\\Jobs\\copy\\A-0001.rvt" }];
  assert.match(documentRequired("fmc_coord_apply", open, undefined) ?? "", /FMC-DOC-REQUIRED/);
  assert.match(documentRequired("fmc_coord_apply", [{ title: "Only", path: "D:\\Jobs\\Only.rvt" }], undefined) ?? "", /FMC-DOC-REQUIRED/);
  const ambiguous = body(await runFmcCoord(args({ action: "publish", document: "A-0001" }), { ...base, revit, open }));
  assert.match(String(ambiguous.error), /FMC-DOC-AMBIGUOUS/);
  const absent = body(await runFmcCoord(args({ action: "check", document: "Missing" }), { ...base, revit, open: [{ title: "A-0001", path: "D:\\a.rvt" }] }));
  assert.match(String(absent.error), /FMC-DOC-NOT-FOUND/);
  assert.equal(calls.length, 0);

  const dry = body(await runFmcCoord(args({ action: "publish", document: "A-0001", project: "Ogala", project_folder: path.join(dir, "proj"), level: "all" }), { ...base, revit }));
  assert.equal(dry.dry_run, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "fmc_coord_apply");
  assert.equal(calls[0].write, false);
  assert.equal(fs.existsSync(path.join(dir, "proj", "FMC_Coord.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "unread-appdata")), false);

  const published = body(await runFmcCoord(args({ action: "publish", document: "A-0001", project: "Ogala", project_folder: path.join(dir, "proj"), level: "all", dry_run: false }), { ...base, revit }));
  assert.equal(published.dry_run, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].write, false);
  assert.ok(fs.existsSync(path.join(dir, "proj", "FMC_Coord.json")));
  assert.ok(fs.existsSync(path.join(dir, "app", "Ogala.json")));
  const ledger = fs.readFileSync(path.join(dir, "app", "ledger.jsonl"), "utf8");
  assert.match(ledger, /"action":"publish"/);
  assert.doesNotMatch(ledger, /uid-1/);

  const read = body(await runFmcCoord(args({ action: "read", project: "Ogala", project_folder: path.join(dir, "proj") }), { ...base, revit }));
  assert.equal((read.summary as { objects: number }).objects, 1);
  assert.equal(calls.length, 2);

  const models = body(await runFmcCoord(args({ action: "check", project: "Ogala", project_folder: path.join(dir, "proj"), left: "A-0001", right: "A-0001" }), { ...base, revit }));
  assert.equal(models.server_only, true);
  assert.equal((models.summary as { pass: number }).pass, 1);
  assert.equal(calls.length, 2);

  const live = body(await runFmcCoord(args({ action: "check", document: "A-0001", project: "Ogala", project_folder: path.join(dir, "proj"), level: "all" }), { ...base, revit }));
  assert.equal((live.summary as { count: number }).count >= 1, true);
  assert.ok(Array.isArray((live.summary as { ids: string[] }).ids));
  assert.equal(calls.length, 3);
  assert.equal(calls[2].write, false);

  const preview = body(await runFmcCoord(args({ action: "export", project: "Ogala", project_folder: path.join(dir, "proj"), document: "A-0001" }), { ...base, revit }));
  assert.equal(preview.dry_run, true);
  assert.equal(fs.existsSync(path.join(dir, "out")), false);
  assert.match(JSON.stringify(preview.files), /IFCMAPCONVERSION/);
  const exported = body(await runFmcCoord(args({ action: "export", project: "Ogala", project_folder: path.join(dir, "proj"), document: "A-0001", dry_run: false }), { ...base, revit }));
  assert.equal(exported.dry_run, false);
  assert.match(fs.readFileSync(path.join(dir, "out", "Ogala-ifcmap.txt"), "utf8"), /IFCMAPCONVERSION/);

  const csvFile = path.join(dir, "in.csv");
  fs.writeFileSync(csvFile, "name,X,Y,Z,rotation\nN1,1,2,3,4\n");
  const importedDry = body(await runFmcCoord(args({ action: "import", project: "Ogala", project_folder: path.join(dir, "proj"), source: csvFile }), { ...base, revit }));
  assert.equal(importedDry.dry_run, true);
  assert.deepEqual(importedDry.would_add, ["N1"]);
  const imported = body(await runFmcCoord(args({ action: "import", project: "Ogala", project_folder: path.join(dir, "proj"), source: csvFile, dry_run: false }), { ...base, revit }));
  assert.equal(imported.imported, 1);
  assert.equal(calls.length, 3, "read, export and import do not call Revit");

  const align = body(await runFmcCoord(args({ action: "align", document: "A-0001", project: "Ogala", project_folder: path.join(dir, "proj"), dry_run: false, level: "model" }), { ...base, revit }));
  assert.equal(calls.length, 4);
  assert.equal(calls[3].write, true);
  assert.equal(calls[3].params.action, "align");
  assert.equal((calls[3].params.transform as number[][])[0][3], 1000);
  assert.equal(align.dry_run, false);

  calls.length = 0;
  const refused = body(await runFmcCoord(args({ action: "align", document: "HEBERT HOSTELS", project: "Ogala", project_folder: path.join(dir, "proj"), dry_run: false }), {
    ...base, revit, guard: guard({ sync_exclude: ["HEBERT HOSTELS"] }),
  }));
  assert.match(String(refused.error), /FMC-COORD-GUARD/);
  assert.match(String(refused.error), /sync_exclude/);
  assert.equal(calls.length, 0);

  const placed = body(await runFmcCoord(args({ action: "place", document: "A-0001", project: "Ogala", project_folder: path.join(dir, "proj"), name: "A/1", family: "FMC_Z_Marker", dry_run: true }), { ...base, revit }));
  assert.equal(placed.dry_run, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].write, false);
  assert.equal(calls[0].params.action, "place");
});

test("a control point kind survives import", () => {
  const points: ControlPoint[] = parseImport(JSON.stringify({ control_points: [{ name: "BM1", kind: "survey", xyz_mm: [1, 2, 3], angle_deg: 0 }] }), "p.json");
  assert.equal(points[0].kind, "survey");
});

test("fmc_coord read: an empty record is not an error and says where it looked (P-01, P-02)", async () => {
  const dir = tmp();
  const env = envOf(dir);
  const base = { env, guard: guard(), standards: approved, now: () => "2026-11-28T09:00:00Z" };
  const folder = path.join(dir, "Jobs", "Ogala");
  const empty = await runFmcCoord(args({ action: "read", project_folder: folder }), base);
  assert.equal(empty.isError, false);
  const b = body(empty);
  assert.equal(b.exists, false);
  assert.equal(b.project, "Ogala");
  assert.equal(b.project_key_from, "project_folder");
  assert.deepEqual(b.record_files, [path.join(folder, "FMC_Coord.json"), path.join(dir, "app", "Ogala.json")]);
  assert.equal(b.folder_has_01_wip, false);
  assert.match(String(b.key_warning), /project folder name/);
  assert.match(String(b.message), /FMC-COORD-EMPTY/);
  assert.equal((b.next as { args: { action: string; dry_run: boolean } }).args.action, "publish");
  assert.equal((b.next as { args: { action: string; dry_run: boolean } }).args.dry_run, true);
  assert.equal(b.error, undefined);

  const named = body(await runFmcCoord(args({ action: "read", project: "Ogala" }), base));
  assert.equal(named.project_key_from, "project");
  assert.equal(named.key_warning, undefined);
  assert.deepEqual(named.record_files, [path.join(dir, "app", "Ogala.json")]);

  const none = await runFmcCoord(args({ action: "read" }), base);
  assert.equal(none.isError, true);
  assert.match(String(body(none).error), /FMC-COORD-PROJECT/);
  assert.equal(projectKeyFrom("", "", "D:\\x\\A.rvt"), "document");
  assert.equal(projectKeyFrom("", "", ""), "none");
});

test("F99: read binds the record to the named document's project folder, not a sticky project_folder", async () => {
  const dir = tmp();
  const env = envOf(dir);
  const base = { env, guard: guard(), standards: approved, now: () => "2026-11-28T09:22:44Z" };
  const sticky = path.join(dir, "revit-tests", "out-files");
  fs.mkdirSync(sticky, { recursive: true });
  const house = path.join(dir, "FMC_PROJECTS", "F26902_TestHouse");
  const plumbing = path.join(house, "01_WIP", "P", "plumbing_USER.rvt");
  const electrical = path.join(house, "01_WIP", "E", "electrical_USER.rvt");
  fs.mkdirSync(path.dirname(plumbing), { recursive: true });
  fs.mkdirSync(path.dirname(electrical), { recursive: true });
  const open = [
    { title: "plumbing_USER", path: plumbing },
    { title: "electrical_USER", path: electrical },
    { title: "Project1", path: "" },
  ];

  const emptyA = await runFmcCoord(args({ action: "read", document: "plumbing_USER", project_folder: sticky }), { ...base, open });
  assert.equal(emptyA.isError, false);
  const a = body(emptyA);
  assert.equal(a.exists, false);
  assert.equal(a.project, "F26902_TestHouse");
  assert.equal(a.project_key_from, "document");
  assert.equal((a.record_files as string[])[0], path.join(house, "FMC_Coord.json"));
  assert.equal(a.folder_has_01_wip, true);
  assert.equal(a.ignored_project_folder, sticky);
  assert.match(String(a.key_warning), /document's project folder name/);
  assert.match(String(a.write_folder_note), /would still write/);

  const b = body(await runFmcCoord(args({ action: "read", document: "electrical_USER", project_folder: sticky }), { ...base, open }));
  assert.equal(b.project, "F26902_TestHouse");

  const c = body(await runFmcCoord(args({ action: "read", document: "Project1", project_folder: sticky }), { ...base, open }));
  assert.equal(c.project, "Project1");
  assert.equal(c.project_key_from, "document");
  assert.notEqual(c.project, "out-files");

  const d = body(await runFmcCoord(args({ action: "read", document: "plumbing_USER", project: "Ogala", project_folder: sticky }), { ...base, open }));
  assert.equal(d.project, "Ogala");
  assert.equal(d.project_key_from, "project");
  assert.equal(d.key_warning, undefined);
  assert.equal((d.record_files as string[])[0], path.join(house, "FMC_Coord.json"));

  const e = body(await runFmcCoord(args({ action: "read", project_folder: sticky }), base));
  assert.equal(e.project, "out-files");
  assert.equal(e.project_key_from, "project_folder");

  const bound = bindCoordRecord("", sticky, "plumbing_USER", open);
  assert.equal(bound.project, "F26902_TestHouse");
  assert.equal(bound.write_folder, sticky, "publish write path is unchanged");

  const shot = snap("plumbing_USER", 0, 0);
  const revit = async () => shot;
  const pub = body(await runFmcCoord(args({ action: "publish", document: "plumbing_USER", project_folder: sticky }), { ...base, open, revit }));
  assert.equal(pub.dry_run, true);
  assert.equal(pub.project, "F26902_TestHouse");
  assert.ok((pub.would_write as string[]).some((p) => p.includes("out-files")), "dry-run still plans to write next to the given folder");
  assert.match(String(pub.write_folder_note), /would still write/);
});

test("fmc_coord check explain, verdict, and moved/created ids", async () => {
  const fail = {
    kind: "object" as const, name: "door", id: "42", stable_id: "uid-1|D1", delta_mm: 12.5, delta_deg: 0,
    dxyz_mm: [12.5, 0, 0] as [number, number, number], position: "FAIL" as const, angle: "PASS" as const, status: "FAIL" as const,
  };
  assert.equal(explainItem(fail), "object door: position off by 12.5 mm (dx 12.5, dy 0, dz 0 mm)");
  assert.match(explainItem({ ...fail, position: "PASS", angle: "FAIL", delta_deg: 0.5 }), /angle off by 0.5 degrees/);
  const pass = { ...fail, id: "43", position: "PASS" as const, status: "PASS" as const };
  const out = withExplain({ items: [fail, pass], summary: { count: 2, pass: 1, fail: 1, provisional: 0, unknown: 0, ids: ["42", "43"] } });
  assert.deepEqual(out.verdict, { pass: 1, fail: 1, unknown: 0, provisional: 0, count: 2 });
  assert.match(String((out.items[0] as { explain?: string }).explain), /position off/);
  assert.equal((out.items[1] as { explain?: string }).explain, undefined);
  assert.equal(Object.keys(out)[0], "verdict");

  assert.deepEqual(rowIds([{ id: 7 }, { id: "" }, { name: "x" }, null, { id: "9" }]), ["7", "9"]);
  assert.deepEqual(rowIds(undefined), []);

  const dir = tmp();
  const env = envOf(dir);
  const base = { env, guard: guard(), standards: approved, now: () => "2026-11-28T09:00:00Z" };
  const folder = path.join(dir, "proj");
  const revit = async (_command: string, params: Record<string, unknown>) => {
    if (params.action === "align") return { ok: true, would: [], skipped: [], applied: [{ id: 42, model: true }] };
    if (params.action === "place") return { ok: true, placed: [{ id: 501, unique_id: "u-501", reference_point: true }] };
    return snap("A-0001", 1000, 12, { name: "A/1", x: 5000 });
  };
  await runFmcCoord(args({ action: "publish", document: "A-0001", project: "Ogala", project_folder: folder, level: "all", dry_run: false }), { ...base, revit });
  const found = body(await runFmcCoord(args({ action: "read", project: "Ogala", project_folder: folder }), { ...base, revit }));
  assert.equal(found.exists, true);
  const models = body(await runFmcCoord(args({ action: "check", project: "Ogala", project_folder: folder, left: "A-0001", right: "A-0001" }), { ...base, revit }));
  assert.equal((models.verdict as { pass: number }).pass, 1);
  const aligned = body(await runFmcCoord(args({ action: "align", document: "A-0001", project: "Ogala", project_folder: folder, dry_run: false }), { ...base, revit }));
  assert.deepEqual(aligned.moved_ids, ["42"]);
  const alignDry = body(await runFmcCoord(args({ action: "align", document: "A-0001", project: "Ogala", project_folder: folder }), { ...base, revit }));
  assert.equal(alignDry.moved_ids, undefined);
  const placed = body(await runFmcCoord(args({ action: "place", document: "A-0001", project: "Ogala", project_folder: folder, name: "A/1", reference_point: true, dry_run: false }), { ...base, revit }));
  assert.deepEqual(placed.created_ids, ["501"]);
});
