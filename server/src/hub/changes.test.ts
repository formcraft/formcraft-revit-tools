import { test } from "node:test";
import assert from "node:assert/strict";
import { familyChanges, flowChanges, treeChanges } from "./changes.js";

const T = (s: string) => Date.parse(`2026-10-19T${s}:00Z`);

test("X2: a changed Rhino part flags every family built before it, with one rebuild as a dry run", () => {
  const knob = "D:\\K\\_Rhino\\FMC_A_Part_BlindKnob\\Knob.3dm";
  const c = familyChanges([
    { family: "FMC_A_Window_A", built: T("08:00"), staged_revision: "r1", parts: [{ file: knob, modified: T("09:00") }] },
    { family: "FMC_A_Window_B", built: T("08:30"), staged_revision: "r2", parts: [{ file: knob, modified: T("09:00") }] },
    { family: "FMC_A_Window_C", built: T("10:00"), staged_revision: "r3", parts: [{ file: knob, modified: T("09:00") }] },
  ]);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "part");
  assert.deepEqual(c[0].affects, ["FMC_A_Window_A", "FMC_A_Window_B"], "C was built after the part changed");
  assert.deepEqual(c[0].update, { tool: "fmc_recipe", args: { action: "batch", rebuild: ["FMC_A_Window_A", "FMC_A_Window_B"], dry_run: true } });
});

test("X2: a recipe that differs from the staged one, a recipe never staged, and a missing part are flagged", () => {
  const c = familyChanges([
    { family: "Door", built: T("08:00"), staged_revision: "aaa", source_revision: "bbb", parts: [] },
    { family: "Same", built: T("08:00"), staged_revision: "ccc", source_revision: "ccc", parts: [] },
    { family: "New", staged_revision: null, source_revision: "ddd", parts: [] },
    { family: "Lost", built: T("08:00"), staged_revision: "e", parts: [{ file: "D:\\gone.3dm" }] },
  ]);
  assert.deepEqual(c.map((x) => `${x.kind}:${x.affects.join(",")}`), ["recipe:Door", "recipe:New", "part:Lost"]);
  assert.match(c[1].why, /isn't staged yet/);
  assert.equal(c[2].update, undefined, "a missing part has no dry run to offer: export it first");
});

test("X2: the tree's changes and stale exports; app results older than what was sent", () => {
  const t = treeChanges({ file: "t.json", modified: T("11:00"), last_build: T("09:00"), changed_nodes: ["ICU-Bay-01.Room"], exports: { powerbi: T("10:00"), navisworks: T("12:00") } });
  assert.deepEqual(t.map((x) => `${x.kind}:${x.affects.join(",")}`), ["tree:ICU-Bay-01.Room", "export:powerbi"], "the Navisworks sets are newer than the tree");
  const f = flowChanges([
    { from: "revit", to: "robot", created: "2026-10-19T10:00:00Z", what: "Analytical model" },
    { from: "robot", to: "revit", created: "2026-10-19T09:00:00Z", what: "Forces" },
    { from: "revit", to: "navisworks", created: "2026-10-19T08:00:00Z", what: "NWC" },
    { from: "navisworks", to: "revit", created: "2026-10-19T09:00:00Z", what: "Clashes" },
    { from: "hub", to: "powerbi", created: "2026-10-19T07:00:00Z", what: "Recipe tree quantities" },
  ]);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].affects, ["robot"]);
  assert.match(f[0].why, /Forces.*older than what was last sent/);
});
