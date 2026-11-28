import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./policy.js";
import { generalState, parseConfig } from "./aiuse.js";
import {
  clearRememberedProtected, planEnableCopy, planOpenCopy, samePath, writeGuard,
} from "./opencopy.js";

const live = "D:\\Fomcraft\\Ogala\\01_WIP\\S\\Ogala-S.rvt";
const arch = "D:\\Fomcraft\\Ogala\\01_WIP\\A\\Ogala-A.rvt";
const copy = "C:\\Users\\USER\\agent-tools\\ogala-R04\\Ogala-S.copy.rvt";
const cfg = { ...DEFAULT_CONFIG, protected_roots: ["D:\\Fomcraft"], copy_roots: ["C:\\Users\\USER\\agent-tools"] };

test("open_copy refuses the original, a live path and a cloud model, and never plans a write to the source", () => {
  clearRememberedProtected();
  const exists = (p: string) => samePath(p, live);
  const same = planOpenCopy({ source: live, copyTo: live, links: { mode: "unload" } }, cfg, exists);
  assert.equal(same.ok, false);
  assert.match(same.reasons.join(" "), /never modifies the original/);
  assert.equal(same.writes_source, false);

  const protectedCopy = planOpenCopy({ source: live, copyTo: "D:\\Fomcraft\\tmp\\x.rvt", links: { mode: "keep" } }, cfg, exists);
  assert.equal(protectedCopy.ok, false);
  assert.match(protectedCopy.reasons.join(" "), /protected original/);

  const liveAsCopy = planOpenCopy({ source: live, copyTo: arch, links: { mode: "keep" }, livePaths: [arch] }, cfg, exists);
  assert.equal(liveAsCopy.ok, false);
  assert.match(liveAsCopy.reasons.join(" "), /live path/);

  const cloud = planOpenCopy({ source: "BIM 360://project/model.rvt", copyTo: copy, links: { mode: "unload" } }, cfg, () => true);
  assert.equal(cloud.ok, false);
  assert.match(cloud.reasons.join(" "), /Cloud/);
});

test("open_copy accepts keep, unload and repath on a copy outside the protected roots", () => {
  clearRememberedProtected();
  const exists = (p: string) => samePath(p, live);
  for (const links of [
    { mode: "keep" as const },
    { mode: "unload" as const },
    { mode: "repath" as const, repath: [{ from: arch, to: "C:\\Users\\USER\\agent-tools\\ogala-R04\\A.rvt" }] },
  ]) {
    const plan = planOpenCopy({ source: live, copyTo: copy, links, protectedRoots: ["D:\\Fomcraft"] }, cfg, exists);
    assert.equal(plan.ok, true, plan.reasons.join(" | "));
    assert.equal(plan.writes_source, false);
    assert.equal(plan.saves, false);
    assert.equal(plan.syncs, false);
    assert.equal(plan.relinquishes, false);
    assert.equal(plan.reload_modifies, false);
    assert.equal(plan.detach, "preserve");
    assert.equal(plan.links.mode, links.mode);
  }
  const outside = planOpenCopy({ source: live, copyTo: "C:\\Temp\\x.rvt", links: { mode: "unload" } }, cfg, exists);
  assert.equal(outside.ok, false);
  assert.match(outside.reasons.join(" "), /copy_roots/);
  clearRememberedProtected();
});

test("writes are refused on a protected original and on a read-only copy, except a modify_model dry run", () => {
  clearRememberedProtected();
  const original = { title: "Ogala-S", path: live, isFamily: false, isWorkshared: true, isDetached: false, readOnly: false };
  const detached = { title: "Ogala-S.copy", path: copy, isFamily: false, isWorkshared: true, isDetached: true, readOnly: true, isActive: false };
  assert.equal(writeGuard(original, "fmc_model_edit", { dry_run: true }, cfg).ok, false);
  assert.equal(writeGuard(original, "fmc_revit_file", { action: "save" }, cfg).ok, false);
  assert.equal(writeGuard(original, "fmc_revit_file", { action: "sync" }, cfg).ok, false);
  assert.equal(writeGuard(original, "fmc_revit_file", { action: "relinquish" }, cfg).ok, false);
  assert.equal(writeGuard(detached, "fmc_model_edit", { dry_run: false }, cfg).ok, false);
  assert.equal(writeGuard(detached, "fmc_revit_file", { action: "save" }, cfg).ok, false);
  assert.equal(writeGuard(detached, "fmc_revit_file", { action: "reload_latest" }, cfg).ok, false);
  const dry = writeGuard(detached, "fmc_model_edit", { dry_run: true }, cfg);
  assert.equal(dry.ok, true, dry.reasons.join(" | "));
  const link = writeGuard({ ...detached, isLinked: true, path: arch }, "fmc_model_edit", { dry_run: true }, cfg);
  assert.equal(link.ok, false);
});

test("enable_copy is path scoped and does not turn the switch on for the live model", () => {
  clearRememberedProtected();
  const missing = planEnableCopy(copy, { ...DEFAULT_CONFIG, protected_roots: [] }, [], []);
  assert.equal(missing.ok, false);
  assert.match(missing.reasons.join(" "), /protected_roots/);
  const refused = planEnableCopy(live, cfg, [], [live]);
  assert.equal(refused.ok, false);
  const allowed = planEnableCopy(copy, cfg, [], [live, arch]);
  assert.equal(allowed.ok, true, allowed.reasons.join(" | "));

  const ai = parseConfig({ on: false, copies: { [allowed.path]: { general: true } }, projects: {} });
  assert.equal(generalState(ai, "Ogala-S.copy", allowed.path), "On");
  assert.equal(generalState(ai, "Ogala-S", live), "Off");
  const stopped = parseConfig({ on: false, stop: true, copies: { [allowed.path]: { general: true } } });
  assert.ok(stopped);
  assert.equal(stopped.stop, true);
  assert.equal(generalState(stopped, "Ogala-S.copy", allowed.path), "Stopped");
});
