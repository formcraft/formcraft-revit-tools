import { test } from "node:test";
import assert from "node:assert/strict";
import { analyticalFindings, isLocalPath, planGbxmlExport, resolveCheckFile, sanitizeName, stampOf } from "./energyexport.js";

const now = new Date(2026, 10, 28, 9, 5);
const rvt = "D:\\Jobs\\F26901\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0001.rvt";
const folder = "D:\\Jobs\\F26901\\01_WIP\\A";

test("local paths, cloud paths and name sanitising", () => {
  assert.equal(isLocalPath(rvt), true);
  assert.equal(isLocalPath("\\\\srv\\share\\m.rvt"), true);
  assert.equal(isLocalPath("BIM 360://Project/m.rvt"), false);
  assert.equal(isLocalPath("Autodesk Docs://Hub/m.rvt"), false);
  assert.equal(isLocalPath("RSN://server/m.rvt"), false);
  assert.equal(isLocalPath("m.rvt"), false);
  assert.equal(isLocalPath(""), false);
  assert.equal(sanitizeName("..\\..\\Windows\\evil"), "Windows_evil");
  assert.equal(sanitizeName("../../x.xml"), "x");
  assert.equal(sanitizeName("C:\\temp\\a b.xml"), "C_temp_a_b");
  assert.equal(sanitizeName("..."), "");
  assert.equal(sanitizeName("a".repeat(200)).length, 120);
  assert.equal(stampOf(now), "20261128-0905");
});

test("the export goes beside the .rvt with a timestamped name, never over a file or the model", () => {
  const plan = planGbxmlExport(rvt, { now });
  assert.equal(plan.ok, true);
  assert.equal(plan.folder, folder);
  assert.equal(plan.file, `${folder}\\F26901-FMC-ZZ-ZZ-M3-A-0001_gbXML_20261128-0905.xml`);
  const taken = new Set([plan.file.toLowerCase()]);
  const next = planGbxmlExport(rvt, { now, exists: (f) => taken.has(f.toLowerCase()) });
  assert.equal(next.ok, true);
  assert.match(next.file, /_gbXML_20261128-0905-2\.xml$/);
  const all = planGbxmlExport(rvt, { now, exists: () => true });
  assert.equal(all.ok, false);
  assert.equal(all.code, "FMC-ENERGY-EXISTS");
  const asked = planGbxmlExport(rvt, { now, name: "energy run 1", exists: (f) => f.endsWith("energy_run_1.xml") });
  assert.equal(asked.code, "FMC-ENERGY-EXISTS");
  const traversal = planGbxmlExport(rvt, { now, name: "..\\..\\..\\Windows\\System32\\x" });
  assert.equal(traversal.ok, true);
  assert.equal(traversal.file, `${folder}\\Windows_System32_x.xml`);
  assert.equal(traversal.name_changed, true);
  assert.equal(planGbxmlExport(rvt, { name: "///" }).code, "FMC-ENERGY-NAME");
});

test("unsaved, cloud and non-project documents are refused", () => {
  assert.equal(planGbxmlExport("").code, "FMC-ENERGY-UNSAVED");
  assert.equal(planGbxmlExport("BIM 360://Hebert/A.rvt").code, "FMC-ENERGY-CLOUD");
  assert.equal(planGbxmlExport("Autodesk Docs://Hebert/A.rvt").code, "FMC-ENERGY-CLOUD");
  assert.equal(planGbxmlExport("D:\\Lib\\FMC_A_Door.rfa").code, "FMC-ENERGY-NOT-PROJECT");
});

test("a file to check must resolve inside the project folder and be .xml", () => {
  assert.deepEqual(resolveCheckFile(folder, "a.xml"), { ok: true, file: `${folder}\\a.xml` });
  assert.equal(resolveCheckFile(folder, "exports\\a.xml").ok, true);
  assert.equal(resolveCheckFile(folder, `${folder}\\a.xml`).ok, true);
  assert.equal(resolveCheckFile(folder, "..\\a.xml").ok, false);
  assert.equal(resolveCheckFile(folder, "..\\A-evil\\a.xml").ok, false);
  assert.equal(resolveCheckFile(folder, `${folder}-other\\a.xml`).ok, false);
  assert.equal(resolveCheckFile(folder, "C:\\Windows\\a.xml").ok, false);
  assert.equal(resolveCheckFile(folder, "a.rvt").ok, false);
  assert.equal(resolveCheckFile(folder, "").ok, false);
  assert.equal(resolveCheckFile("", "a.xml").ok, false);
  assert.equal(resolveCheckFile(folder, "file://host/a.xml").ok, false);
});

test("analytical findings: no model, warnings, and a clean model", () => {
  const none = analyticalFindings({ model: { exists: false }, rooms: { placed: 3 }, settings: { analysis_type: "BuildingElement" } });
  assert.equal(none.status, "NO_MODEL");
  assert.equal(none.findings.length, 0);
  const warn = analyticalFindings({
    settings: { analysis_type: "RoomsOrSpaces", ground_plane_missing: true },
    rooms: { placed: 0, not_placed: 2, not_placed_ids: ["1", "2"], unbounded: 1, missing_level: 0 },
    spaces: { placed: 0, unbounded: 0 },
    levels: 0,
    model: { exists: true, spaces: 0, surfaces_no_space: 4, interior_no_adjacent: 1 },
    warnings: { count: 5 },
  });
  assert.equal(warn.status, "WARN");
  assert.deepEqual(warn.findings.map((f) => f.code).sort(), [
    "GROUND_PLANE_MISSING", "MODEL_NO_SPACES", "NO_LEVELS", "NO_SPATIAL_ELEMENTS", "REVIT_WARNINGS", "ROOM_NOT_PLACED", "ROOM_UNBOUNDED", "SURFACE_NO_ADJACENT_SPACE", "SURFACE_NO_SPACE",
  ]);
  assert.deepEqual(warn.findings.find((f) => f.code === "ROOM_NOT_PLACED")!.sample, ["1", "2"]);
  const ok = analyticalFindings({ settings: { analysis_type: "RoomsOrSpaces" }, rooms: { placed: 4 }, spaces: { placed: 4 }, levels: 3, model: { exists: true, spaces: 4, surfaces_no_space: 0 }, warnings: { count: 0 } });
  assert.equal(ok.status, "OK");
});
