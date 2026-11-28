import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { DEFAULT_CONFIG, READ_VIA_SEND_COMMAND, WRITE_COMMANDS, type GuardConfig } from "./policy.js";
import {
  arrowRotationDeg, axisDistance, dominantAxis, gridInSet, gridSetKey, linkAngleDelta, roleOf,
  rotationToGrid, surveyDeltaMm, toAxisDeg, viewRotationVsTrueNorthDeg, wrap180,
} from "./northmath.js";
import { compareSnapshot, resolveNorthTolerances } from "./north.js";
import { FMC_NORTH_SHAPE, runFmcNorth, type FmcNorthArgs } from "../tools/fmc_north.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function args(partial: Record<string, unknown>): FmcNorthArgs {
  return z.object(FMC_NORTH_SHAPE).parse(partial);
}

function textOf(result: { content?: Array<{ text?: string }>; isError?: boolean }): Record<string, unknown> & { isError: boolean } {
  const body = JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  return { ...body, isError: result.isError === true };
}

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-north-"));
  const guard: GuardConfig = { ...DEFAULT_CONFIG, protected_paths: ["D:\\Live"], save_exclude: ["HEBERT HOSTELS"], sync_exclude: [], protected_roots: [] };
  const env = { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, FMC_NORTH_DIR: path.join(dir, "north"), FMC_STANDARDS_FILE: path.join(dir, "missing.json") } as NodeJS.ProcessEnv;
  return { dir, env, guard, reportDir: path.join(dir, "north") };
}

const survey = { easting_mm: 1000, northing_mm: 2000, elevation_mm: 10 };

function doc(partial: Record<string, unknown>) {
  return {
    title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
    path: "D:\\Jobs\\_Staging\\F26901-FMC-ZZ-ZZ-M3-A-0002_USER.rvt",
    site: "Site",
    angle_deg: 12,
    shared_basis_x_deg: 12,
    easting_mm: 1000, northing_mm: 2000, elevation_mm: 10,
    survey_point: survey,
    project_base_point: survey,
    is_central: false,
    grids: [
      { id: "1", name: "BQ1", angle_deg: 15 },
      { id: "2", name: "BQ2", angle_deg: 15 },
      { id: "3", name: "BQA", angle_deg: 105 },
    ],
    views: [
      { id: "10", name: "Level 1 BQ", is_plan: true, orientation: "Project North", orientation_param: "PLAN_VIEW_NORTH", crop_basis_x_deg: 0, crop_active: true },
      { id: "11", name: "Level 1", is_plan: true, orientation: "True North", orientation_param: "PLAN_VIEW_NORTH", crop_basis_x_deg: 12, crop_active: true },
    ],
    viewports: [
      { id: "20", view_id: "10", sheet_id: "30", sheet_number: "A-101", sheet_name: "Plans", center_mm: { x: 100, y: 100 }, outline_mm: { min: { x: 80, y: 80 }, max: { x: 140, y: 140 } } },
    ],
    links: [],
    arrows: [],
    ...partial,
  };
}

test("angle maths: view versus true north, arrow rotation, grid axis and tolerance", () => {
  assert.equal(wrap180(190), -170);
  assert.equal(wrap180(-180), 180);
  assert.equal(toAxisDeg(0), 0);
  assert.equal(toAxisDeg(90), 0);
  assert.equal(toAxisDeg(15), 15);
  assert.equal(toAxisDeg(105), 15);
  assert.equal(toAxisDeg(80), -10);
  assert.equal(toAxisDeg(-45), 45);
  assert.equal(arrowRotationDeg(30, 0), 30);
  assert.equal(arrowRotationDeg(30, 30), 0);
  assert.equal(arrowRotationDeg(10, -20), 30);
  assert.equal(viewRotationVsTrueNorthDeg(10, -20), arrowRotationDeg(10, -20, 0));
  assert.equal(arrowRotationDeg(0, 0, 90), 90);
  assert.equal(rotationToGrid(0, 80), -10);
  assert.equal(rotationToGrid(10, 100), 0);
  assert.equal(rotationToGrid(40, 0), -40);
  const dominant = dominantAxis([15, 15, 105, 10, 10, 80]);
  assert.equal(dominant?.angle_deg, 15);
  assert.equal(dominant?.count, 3);
  assert.ok(axisDistance(10, 80) > 2);
  assert.equal(gridSetKey("BQ1"), "BQ");
  assert.equal(gridSetKey("BQ-1"), "BQ");
  assert.equal(gridSetKey("BQA"), "BQA");
  assert.equal(gridSetKey("12"), "#");
  assert.equal(gridInSet("BQ1", "BQ"), true);
  assert.equal(gridInSet("BQ-A", "BQ"), true);
  assert.equal(gridInSet("BQA", "BQ"), false);
  assert.equal(roleOf("F26901-FMC-ZZ-ZZ-M3-A-0002_USER"), "A");
  assert.equal(surveyDeltaMm({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }).delta_mm, 5);
  assert.equal(linkAngleDelta(30, 10, 40), 0);
  assert.ok(linkAngleDelta(30, 10, 40.02) > 0.01);

  const provisional = resolveNorthTolerances(null, {});
  assert.equal(provisional.deg.value, 0.01);
  assert.equal(provisional.deg.source, "provisional");
  assert.equal(provisional.mm.value, 1);
  const near = compareSnapshot([
    doc({ title: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER" }) as never,
    doc({ title: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", angle_deg: 12.005 }) as never,
  ], provisional, false);
  assert.equal(near.findings.length, 0);
  assert.equal(near.status, "PROVISIONAL");
  const far = compareSnapshot([
    doc({ title: "A" }) as never,
    doc({ title: "P", angle_deg: 12.02, survey_point: { easting_mm: 1002, northing_mm: 2000, elevation_mm: 10 } }) as never,
  ], provisional, false);
  assert.ok(far.findings.some((row) => row.code === "FMC-NORTH-ANGLE-MISMATCH"));
  assert.ok(far.findings.some((row) => row.code === "FMC-NORTH-SURVEY-MISMATCH"));
  assert.equal(far.status, "FAIL");
  const approved = resolveNorthTolerances({
    "coord.tol_deg": { value: 0.01, status: "approved", clause: "STD 8.5" },
    "coord.tol_mm": { value: 1, status: "approved", clause: "STD 8.5" },
  }, {});
  const pass = compareSnapshot([doc({ title: "A" }) as never, doc({ title: "E" }) as never], approved, false);
  assert.equal(pass.status, "PASS");
  assert.equal(pass.findings.length, 0);
});

test("audit, compare and align_views use fakes and do not change project north", async () => {
  const io = temp();
  let sent = "";
  const read = async (body: Record<string, unknown>) => {
    sent = String(body.action);
    const a = doc({});
    const e = doc({ title: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", path: "D:\\Jobs\\_Staging\\E.rvt" });
    const p = doc({ title: "F26901-FMC-ZZ-ZZ-M3-P-0001_USER", path: "D:\\Jobs\\_Staging\\P.rvt", angle_deg: 12.02 });
    if (body.document) return { documents: [a] };
    return { documents: [a, e, p], project_north_changed: false };
  };
  const audit = textOf(await runFmcNorth(args({ action: "audit", document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER" }), { ...io, read, standards: null }));
  assert.equal(audit.isError, false);
  assert.equal(sent, "audit");
  assert.equal(audit.project_north_changed, false);
  const docs = audit.documents as Array<{ title: string; grid_sets: Array<{ name: string; angle_deg: number }> }>;
  assert.equal(docs[0].title, "F26901-FMC-ZZ-ZZ-M3-A-0002_USER");
  assert.equal(docs[0].grid_sets.find((set) => set.name === "BQ")?.angle_deg, 15);
  assert.equal(fs.existsSync(String(audit.report)), true);
  assert.ok(String(audit.report).includes(`${path.sep}north${path.sep}`) || String(audit.report).includes("/north/"));

  const compared = textOf(await runFmcNorth(args({
    action: "compare",
    documents: ["F26901-FMC-ZZ-ZZ-M3-A-0002_USER", "F26901-FMC-ZZ-ZZ-M3-E-0001_USER", "F26901-FMC-ZZ-ZZ-M3-P-0001_USER"],
  }), { ...io, read, standards: null }));
  assert.equal(compared.agree, false);
  const findings = compared.findings as Array<{ code: string }>;
  assert.ok(findings.some((row) => row.code === "FMC-NORTH-ANGLE-MISMATCH"));

  const align = textOf(await runFmcNorth(args({
    action: "align_views",
    document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
    grid_set: "BQ",
    mode: "crop",
    dry_run: true,
  }), { ...io, read, standards: null }));
  assert.equal(align.dry_run, true);
  assert.equal(align.project_north_changed, false);
  const views = align.views as Array<{ name: string; before_deg: number; delta_deg: number }>;
  assert.equal(views[0].name, "Level 1 BQ");
  assert.equal(views[0].before_deg, 0);
  assert.equal(views[0].delta_deg, 15);

  const locked = textOf(await runFmcNorth(args({
    action: "align_views", document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER", grid_set: "BQ", dry_run: false,
  }), { ...io, read, standards: null }));
  assert.equal(locked.isError, true);
  assert.equal(locked.code, "FMC-BATCH-LOCKED");

  const hosted = textOf(await runFmcNorth(args({
    action: "align_views", document: "HEBERT HOSTELS_USER", grid_set: "BQ", dry_run: true,
  }), {
    ...io, standards: null,
    read: async () => ({ documents: [doc({ title: "HEBERT HOSTELS_USER", path: "D:\\Live\\HEBERT HOSTELS_USER.rvt" })] }),
  }));
  assert.equal(hosted.code, "FMC-NORTH-GUARD");
});

test("north arrows report an unmatched viewport, and the add-in never sets project north", async () => {
  const io = temp();
  const arrow = textOf(await runFmcNorth(args({
    action: "north_arrows",
    document: "F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
    family: "FMC_North Arrow",
    sheets: ["A-101"],
    dry_run: true,
  }), {
    ...io, standards: null,
    read: async () => ({ documents: [doc({ arrows: [{ id: "9", family: "FMC_North Arrow", type_name: "True North", sheet_id: "99", on_sheet: true, x_mm: 0, y_mm: 0, rotation_deg: 0 }] })] }),
  }));
  assert.equal(arrow.unmatched_count, 1);
  const unmatched = arrow.unmatched as Array<{ code: string }>;
  assert.equal(unmatched[0].code, "FMC-NORTH-ARROW-UNMATCHED");

  const read = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcNorth.cs"), "utf8");
  const apply = fs.readFileSync(path.join(root, "commandset", "Services", "Fmc", "FmcNorthApply.cs"), "utf8");
  for (const source of [read, apply]) {
    assert.equal(source.includes("SetProjectPosition"), false);
    assert.equal(source.includes("AcquireCoordinates"), false);
  }
  assert.ok(READ_VIA_SEND_COMMAND.has("fmc_north"));
  assert.ok(WRITE_COMMANDS.has("fmc_north_apply"));
  assert.equal(WRITE_COMMANDS.has("fmc_north"), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "command.json"), "utf8")) as { commands: Array<{ commandName: string }> };
  const names = new Set(manifest.commands.map((row) => row.commandName));
  assert.ok(names.has("fmc_north") && names.has("fmc_north_apply"));
});
