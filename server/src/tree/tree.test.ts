import { test } from "node:test";
import assert from "node:assert/strict";
import { TREE, findNode, planTree, recordBuilt, resolve, treeProblems } from "./tree.js";
import { ICU_BAY_SAMPLE } from "./samples.js";

const sample = () => TREE.parse(JSON.parse(JSON.stringify(ICU_BAY_SAMPLE)));

test("T0: children inherit their ancestors' inputs; a tool's ${var.x} takes the nearest value, keeping its type", () => {
  const ceiling = resolve(sample()).find((r) => r.node.id === "ICU-Bay-01.Ceiling")!;
  assert.deepEqual((ceiling.args as any).room, { name: "ICU bay", width_mm: 4200, depth_mm: 5000, structure_height_mm: 3300, structure: "slab" });
  assert.deepEqual(ceiling.path, ["Hospital", "L2", "ICU", "ICU-Bay-01", "ICU-Bay-01.Ceiling"]);
});

test("T0: a first plan builds everything; after a build nothing; a wider room rebuilds its ceiling and its ancestors only", () => {
  const t = sample();
  assert.ok(planTree(t, null).every((l) => l.state === "new"));
  const makers = resolve(t).filter((r) => r.node.make).map((r) => r.node.id);
  const built = recordBuilt(t, null, makers, new Date("2026-10-19T10:00:00Z"));
  assert.ok(planTree(t, built).every((l) => l.state === "unchanged"), "the ancestors count as built once everything under them is");
  findNode(t, "ICU-Bay-01")!.inputs!.width = 4500;
  const changed = planTree(t, built).filter((l) => l.state !== "unchanged").map((l) => l.id);
  assert.deepEqual(changed, ["Hospital", "L2", "ICU", "ICU-Bay-01", "ICU-Bay-01.Room", "ICU-Bay-01.Ceiling"], "the families don't use the width: they stay");
});

test("T0: the check finds duplicate ids, unknown tools, missing values and nodes that make nothing", () => {
  const t = sample();
  const bay = findNode(t, "ICU-Bay-01")!;
  bay.children!.push({ id: "ICU-Bay-01.Bed", kind: "family", make: { tool: "fmc_nope", args: {} } });
  bay.children!.push({ id: "X", kind: "assembly", make: { tool: "fmc_ceiling", args: { room: { width_mm: "${var.missing}" } } } });
  bay.children!.push({ id: "Y", kind: "system" });
  bay.children!.push({ id: "Z", kind: "system", make: { tool: "fmc_flow", args: {} } });
  const p = treeProblems(t, (tool) => tool !== "fmc_nope");
  assert.ok(p.some((x) => /the id ICU-Bay-01.Bed is used twice/.test(x)));
  assert.ok(p.some((x) => /no tool fmc_nope/.test(x)));
  assert.ok(p.some((x) => /\$\{var.missing\} has no value/.test(x)));
  assert.ok(p.some((x) => /Y: makes nothing/.test(x)));
  assert.ok(p.some((x) => /fmc_flow can't run in the tree/.test(x)));
  assert.throws(() => TREE.parse({ root: { id: "a", kind: "room", make: { tool: "rm", args: {} } } }), "only Formcraft tools");
});

test("T1: the room's inputs reach its build: the room recipe gets the bay's size, level and the project's wall type", () => {
  const room = resolve(sample()).find((r) => r.node.id === "ICU-Bay-01.Room")!;
  const a = (room.args as any).room;
  assert.equal(a.width, 4200);
  assert.equal(a.level, "Level 2");
  assert.equal(a.walls.type, "Generic - 200mm");
  assert.deepEqual(a.origin_mm, [0, 0]);
});
