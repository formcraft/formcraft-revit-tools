import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, FORBIDDEN_PROJECTS_FLOOR, PROTECTED_ROOTS_FLOOR, forbiddenProject, forbiddenProjects, type GuardConfig } from "./policy.js";
import { clearRememberedProtected, planEnableCopy, protectedRoots, writeGuard } from "./opencopy.js";
import { excludedFromSync, saveBlocked, saveSkipReason } from "./savepolicy.js";

const empty: GuardConfig = { ...DEFAULT_CONFIG, protected_roots: [], protected_paths: [], save_exclude: [], sync_exclude: [] };
const missing = (() => { const c = { ...empty } as Partial<GuardConfig>; delete c.protected_roots; return c as GuardConfig; })();
const doc = (title: string, p: string) => ({ title, path: p, isFamily: false, isWorkshared: false, isActive: true } as any);

test("RV-6: empty or missing protected_roots fails closed to D:\\Fomcraft, spelled exactly", () => {
  clearRememberedProtected();
  assert.deepEqual([...PROTECTED_ROOTS_FLOOR], ["D:\\Fomcraft"]);
  assert.deepEqual(protectedRoots(empty), ["D:\\Fomcraft"]);
  assert.deepEqual(protectedRoots(missing), ["D:\\Fomcraft"]);
  assert.deepEqual(protectedRoots({ ...empty, protected_roots: ["", "  "] }), ["D:\\Fomcraft"]);
  // a person naming the roots moves the protection (the guard file is person-edited)
  assert.deepEqual(protectedRoots({ ...empty, protected_roots: ["Z:\\Live"] }), ["Z:\\Live"]);

  const live = "D:\\Fomcraft\\FMC_PROJECTS_27\\THE OGALA RESIDENCE\\01_WIP\\S\\F26901-FMC-ZZ-ZZ-M3-S-0001.rvt";
  for (const cfg of [empty, missing]) {
    const w = writeGuard(doc("F26901-FMC-ZZ-ZZ-M3-S-0001", live), "fmc_model_edit", { dry_run: false }, cfg);
    assert.equal(w.ok, false);
    assert.match(w.reasons.join(" "), /Protected original/);
    assert.equal(saveSkipReason({ title: "S", path: live }, cfg), "excluded");
    assert.match(saveBlocked({ title: "S", path: live }, cfg) ?? "", /protected path/);
    const save = writeGuard(doc("S", live), "fmc_revit_file", { action: "save" }, cfg);
    const sync = writeGuard(doc("S", live), "fmc_revit_file", { action: "sync" }, cfg);
    assert.equal(save.ok, false);
    assert.equal(sync.ok, false);
  }
  // not a search for "Fomcraft" inside a longer name, and other drives are untouched
  assert.equal(writeGuard(doc("X", "D:\\FomcraftOld\\X.rvt"), "fmc_model_edit", {}, empty).ok, true);
  assert.equal(writeGuard(doc("X", "C:\\WIP\\X.rvt"), "fmc_model_edit", {}, empty).ok, true);
  assert.equal(saveBlocked({ title: "X", path: "C:\\WIP\\X.rvt" }, empty), null);
  // case-insensitive segments: d:\fomcraft is the same tree
  assert.equal(writeGuard(doc("X", "d:\\fomcraft\\a\\X.rvt"), "fmc_model_edit", {}, empty).ok, false);
});

test("RV-6: enable_copy still needs a named protected_roots; the floor does not count as naming it", () => {
  clearRememberedProtected();
  const plan = planEnableCopy("C:\\Copies\\A_copy.rvt", empty);
  assert.equal(plan.ok, false);
  assert.match(plan.reasons.join(" "), /name protected_roots/);
  assert.equal(planEnableCopy("D:\\Fomcraft\\Live.rvt", empty, ["Z:\\Other"]).ok, false);
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