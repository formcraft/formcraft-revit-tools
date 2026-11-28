import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, FORBIDDEN_PROJECTS_FLOOR, forbiddenProject, forbiddenProjects, type GuardConfig } from "./policy.js";
import { PROTECTED_ROOTS_UNSET, clearRememberedProtected, guardWarnings, noteProtectedRootsUnset, planEnableCopy, protectedRoots, writeGuard } from "./opencopy.js";
import { excludedFromSync, saveBlocked, saveSkipReason } from "./savepolicy.js";

const empty: GuardConfig = { ...DEFAULT_CONFIG, protected_roots: [], protected_paths: [], save_exclude: [], sync_exclude: [] };
const missing = (() => { const c = { ...empty } as Partial<GuardConfig>; delete c.protected_roots; return c as GuardConfig; })();
const doc = (title: string, p: string) => ({ title, path: p, isFamily: false, isWorkshared: false, isActive: true } as any);

test("RV-6 (owner 28 Nov): empty or missing protected_roots protects no tree: a normal D:\\Fomcraft project WIP write is allowed", () => {
  clearRememberedProtected();
  assert.deepEqual(protectedRoots(empty), []);
  assert.deepEqual(protectedRoots(missing), []);
  assert.deepEqual(protectedRoots({ ...empty, protected_roots: ["", "  "] }), []);
  const wip = "D:\\Fomcraft\\FMC_PROJECTS_27\\THE OGALA RESIDENCE\\01_WIP\\S\\F26901-FMC-ZZ-ZZ-M3-S-0001.rvt";
  for (const cfg of [empty, missing]) {
    assert.equal(writeGuard(doc("F26901-FMC-ZZ-ZZ-M3-S-0001", wip), "fmc_model_edit", { dry_run: false }, cfg).ok, true);
    assert.equal(writeGuard(doc("F26901-FMC-ZZ-ZZ-M3-S-0001", wip), "fmc_revit_file", { action: "save" }, cfg).ok, true);
    assert.equal(writeGuard(doc("F26901-FMC-ZZ-ZZ-M3-S-0001", wip), "fmc_revit_file", { action: "sync" }, cfg).ok, true);
    assert.equal(saveSkipReason({ title: "S", path: wip }, cfg), null);
    assert.equal(saveBlocked({ title: "S", path: wip }, cfg), null);
    assert.equal(excludedFromSync({ title: "S", path: wip }, cfg), false);
  }
  // the project floor still refuses the originals under the same tree
  const hebert = "D:\\Fomcraft\\FMC_PROJECTS_27\\HEBERT HOSTELS\\01_WIP\\A\\HEBERT HOSTELS_A.rvt";
  assert.equal(writeGuard(doc("HEBERT HOSTELS_A", hebert), "fmc_model_edit", {}, empty).ok, false);
  assert.match(saveBlocked({ title: "HEBERT HOSTELS_A", path: hebert }, empty) ?? "", /Forbidden project \(HEBERT HOSTELS\)/);
  assert.equal(writeGuard(doc("A-0001", "D:\\Fomcraft\\FMC_PROJECTS_27\\A-0001\\01_WIP\\A-0001.rvt"), "fmc_revit_file", { action: "sync" }, empty).ok, false);
});

test("RV-6: roots a person names still apply as before", () => {
  clearRememberedProtected();
  const cfg = { ...empty, protected_roots: ["D:\\Fomcraft"] };
  assert.deepEqual(protectedRoots(cfg), ["D:\\Fomcraft"]);
  const live = "D:\\Fomcraft\\Live\\A.rvt";
  const w = writeGuard(doc("A", live), "fmc_model_edit", {}, cfg);
  assert.equal(w.ok, false);
  assert.match(w.reasons.join(" "), /Protected original/);
  assert.match(saveBlocked({ title: "A", path: live }, cfg) ?? "", /protected path/);
  assert.equal(writeGuard(doc("X", "D:\\FomcraftOld\\X.rvt"), "fmc_model_edit", {}, cfg).ok, true);
  assert.equal(writeGuard(doc("X", "d:\\fomcraft\\a\\X.rvt"), "fmc_model_edit", {}, cfg).ok, false);
});

test("RV-6: /health warns, and the log says once, when protected_roots is not set", () => {
  assert.deepEqual(guardWarnings(empty), [PROTECTED_ROOTS_UNSET]);
  assert.deepEqual(guardWarnings(missing), [PROTECTED_ROOTS_UNSET]);
  assert.deepEqual(guardWarnings({ ...empty, protected_roots: ["Z:\\Live"] }), []);
  assert.match(PROTECTED_ROOTS_UNSET, /protected_roots is not set/);
  const lines: string[] = [];
  noteProtectedRootsUnset(undefined, true);
  noteProtectedRootsUnset((l) => lines.push(l));
  noteProtectedRootsUnset((l) => lines.push(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[FMC-GUARD\] protected_roots is not set/);
});

test("RV-6: enable_copy still needs a named protected_roots", () => {
  clearRememberedProtected();
  const plan = planEnableCopy("C:\\Copies\\A_copy.rvt", empty);
  assert.equal(plan.ok, false);
  assert.match(plan.reasons.join(" "), /name protected_roots/);
  assert.equal(planEnableCopy("D:\\Fomcraft\\Live.rvt", empty, ["D:\\Fomcraft"]).ok, false);
  assert.equal(planEnableCopy("C:\\Copies\\A_copy.rvt", empty, ["D:\\Fomcraft"]).ok, true);
  clearRememberedProtected();
});

test("RV-6: the forbidden-project floor (A-0001, HEBERT HOSTELS) is built in; config adds, never replaces", () => {
  assert.deepEqual([...FORBIDDEN_PROJECTS_FLOOR], ["A-0001", "HEBERT HOSTELS"]);
  assert.deepEqual(forbiddenProjects(empty), ["A-0001", "HEBERT HOSTELS"]);
  assert.deepEqual(forbiddenProjects({ ...empty, forbidden_projects: [] }), ["A-0001", "HEBERT HOSTELS"]);
  assert.deepEqual(forbiddenProjects(null), ["A-0001", "HEBERT HOSTELS"]);
  assert.deepEqual(forbiddenProjects({ ...empty, forbidden_projects: ["OGALA ANNEX"] }), ["A-0001", "HEBERT HOSTELS", "OGALA ANNEX"]);
  assert.equal(forbiddenProject("C:\\Jobs\\OGALA_ANNEX\\M.rvt", { ...empty, forbidden_projects: ["OGALA ANNEX"] }), "OGALA ANNEX");

  for (const hit of ["HEBERT HOSTELS", "HEBERT HOSTELS_USER", "HEBERT_HOSTELS", "hebert-hostels", "Hebert  Hostels", "HEBERT HOSTELS.",
    "C:\\Users\\USER\\Documents\\HEBERT HOSTELS_USER.rvt", "E:\\Copy of HEBERT HOSTELS\\A.rvt", "E:\\Jobs\\HEBERT~HOSTELS\\A.rvt"])
    assert.equal(forbiddenProject(hit, empty), "HEBERT HOSTELS", hit);
  for (const hit of ["A-0001", "A-0001-Legacy", "A-00012", "a_0001", "E:\\Jobs\\A-0001\\01_WIP\\M.rvt", "E:\\Jobs\\X\\A-0001.rvt"])
    assert.equal(forbiddenProject(hit, empty), "A-0001", hit);
  // ISO 19650 model names carry ...-M3-A-0001 as a role-number field: not the A-0001 project
  for (const miss of ["F26901-FMC-ZZ-ZZ-M3-A-0001", "E:\\Jobs\\F26901\\01_WIP\\A\\F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", "A-0003", "HEBERT HOSTEL", "C:\\WIP\\Sketch.rvt", "", undefined])
    assert.equal(forbiddenProject(miss as string, empty), null, String(miss));
});

test("RV-6: a forbidden project is refused for writes, saves and syncs, outside any protected root", () => {
  clearRememberedProtected();
  const cfg = { ...empty, protected_roots: ["Z:\\Live"] };
  const file = "C:\\Users\\USER\\Documents\\HEBERT_HOSTELS_USER.rvt";
  const w = writeGuard(doc("HEBERT_HOSTELS_USER", file), "fmc_model_edit", { dry_run: false }, cfg);
  assert.equal(w.ok, false);
  assert.match(w.reasons.join(" "), /Forbidden project \(HEBERT HOSTELS\)/);
  assert.equal(writeGuard(doc("A-0001", "C:\\WIP\\A-0001.rvt"), "fmc_revit_file", { action: "sync" }, cfg).ok, false);
  assert.equal(saveSkipReason({ title: "A-0001", path: "C:\\WIP\\A-0001.rvt" }, cfg), "excluded");
  assert.match(saveBlocked({ title: "A-0001", path: "C:\\WIP\\A-0001.rvt" }, cfg) ?? "", /Forbidden project \(A-0001\)/);
  assert.equal(excludedFromSync({ title: "HEBERT HOSTELS_USER" }, cfg), true);
  assert.equal(excludedFromSync({ title: "Sketch", path: "C:\\WIP\\Sketch.rvt" }, cfg), false);
  assert.equal(planEnableCopy("C:\\Copies\\HEBERT HOSTELS copy.rvt", cfg).ok, false);
});

test("RV-6: an existing path is also matched by its real path", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-rv6-"));
  const target = path.join(dir, "HEBERT HOSTELS");
  fs.mkdirSync(target);
  const link = path.join(dir, "Alpha");
  fs.symlinkSync(target, link, "junction");
  assert.equal(forbiddenProject(link, empty), "HEBERT HOSTELS");
});
test("RV-6 regression: an F26901-...-M3-A-0001 role-field model name is still writable, savable and syncable", () => {
  clearRememberedProtected();
  const title = "F26901-FMC-ZZ-ZZ-M3-A-0001";
  const file = "D:\\Fomcraft\\FMC_PROJECTS_27\\THE OGALA RESIDENCE\\01_WIP\\A\\F26901-FMC-ZZ-ZZ-M3-A-0001.rvt";
  for (const cfg of [empty, missing, { ...empty, forbidden_projects: ["OTHER JOB"] }]) {
    assert.equal(forbiddenProject(title, cfg), null);
    assert.equal(forbiddenProject(file, cfg), null);
    for (const params of [{ dry_run: false }, { action: "save" }, { action: "sync" }]) {
      const w = writeGuard(doc(title, file), params.dry_run === false ? "fmc_model_edit" : "fmc_revit_file", params, cfg);
      assert.equal(w.ok, true, w.reasons.join(" | "));
    }
    assert.equal(saveSkipReason({ title, path: file }, cfg), null);
    assert.equal(saveBlocked({ title, path: file }, cfg), null);
    assert.equal(excludedFromSync({ title, path: file }, cfg), false);
  }
  // while the A-0001 project itself stays refused
  assert.equal(writeGuard(doc("A-0001", "D:\\Fomcraft\\FMC_PROJECTS_27\\A-0001\\01_WIP\\A-0001.rvt"), "fmc_model_edit", {}, empty).ok, false);
});
