import { test } from "node:test";
import assert from "node:assert/strict";
import { ICU_BAY_SAMPLE } from "./samples.js";
import { TREE, Tree, findNode, planTree, recordBuilt, resolve } from "./tree.js";
import { addVariant, chooseVariant, compareOptions, optionSheet, planSvg, withActive } from "./options.js";

const sample = (): Tree => TREE.parse(JSON.parse(JSON.stringify(ICU_BAY_SAMPLE)));

test("O0: a variant changes the node's inputs only while it is active; switching rebuilds that node and its ancestors only", () => {
  const t = sample();
  const built = recordBuilt(t, null, resolve(t).filter((r) => r.node.make).map((r) => r.node.id), new Date());
  const bay = findNode(t, "ICU-Bay-01")!;
  addVariant(bay, { id: "wide", name: "4.5 m bays", inputs: { width: 4500 } });
  assert.deepEqual(planTree(t, built).filter((l) => l.state !== "unchanged" && l.tool), [], "a variant that isn't active changes nothing");
  bay.active = "wide";
  const room = resolve(t).find((r) => r.node.id === "ICU-Bay-01.Room")!;
  assert.equal((room.args as any).room.width, 4500);
  const rebuild = planTree(t, built).filter((l) => l.state !== "unchanged" && l.tool).map((l) => l.id);
  assert.deepEqual(rebuild.sort(), ["ICU-Bay-01.Ceiling", "ICU-Bay-01.Room"], "the room and its ceiling design follow the width; the families don't");
  assert.throws(() => addVariant(bay, { id: "wide", inputs: { width: 4800 } }), /already/);
  assert.equal(findNode(withActive(t, "ICU-Bay-01", null), "ICU-Bay-01")!.active, undefined, "a copy without the variant");
  assert.equal(bay.active, "wide", "the tree itself is untouched");
});

test("O1: the node as it is and each variant are measured the same way, from the recipes; differences are named, nothing ranked", () => {
  const t = sample();
  const bay = findNode(t, "ICU-Bay-01")!;
  addVariant(bay, { id: "wide", name: "4.5 m bays", inputs: { width: 4500 } });
  addVariant(bay, { id: "deep", name: "5.5 m deep", inputs: { depth: 5500 } });
  const c = compareOptions(t, "ICU-Bay-01");
  assert.deepEqual(c.options.map((o) => o.variant), ["base", "wide", "deep"]);
  assert.deepEqual(c.options.map((o) => o.area_m2), [21, 22.5, 23.1]);
  assert.ok(c.differs.includes("area_m2") && c.differs.includes("walls_m2") && !c.differs.includes("doors"));
  const base = c.options[0];
  assert.equal(base.doors, 1);
  assert.equal(base.windows, 1);
  assert.equal(base.daylight_pct, null, "the sample's window has no height: no proxy rather than a guess");
  assert.match(base.daylight_note!, /height isn't in the recipe/);
  assert.equal(base.families["FMC_I_MedEq_Bed_ICU_Electric_Detailed : 1020x2200_Standard"], 1);
  assert.deepEqual(base.problems, []);
  const sheet = optionSheet(c, "ICU bay");
  assert.match(sheet, /\| Area \(m²\) \| 21 \| 22\.5 \| 23\.1 \|/);
  assert.match(sheet, /nothing is ranked/);
});

test("O1: with window heights the daylight proxy is glazing over floor area; a plan sketch is drawn per option", () => {
  const t = sample();
  const room = findNode(t, "ICU-Bay-01.Room")!;
  (room.make!.args as any).room.openings[1].height = 1200;
  const bay = findNode(t, "ICU-Bay-01")!;
  addVariant(bay, { id: "wide", inputs: { width: 4500 } });
  const c = compareOptions(t, "ICU-Bay-01");
  assert.equal(c.options[0].glazing_m2, 1.44);
  assert.equal(c.options[0].daylight_pct, 6.9, "1.44 m² of glazing over 21 m²");
  assert.equal(c.options[1].daylight_pct, 6.4);
  const svg = planSvg(withActive(t, "ICU-Bay-01", "wide"), "ICU-Bay-01");
  assert.match(svg, /^<svg /);
  assert.equal((svg.match(/<line /g) ?? []).length, 4, "four walls");
  assert.match(svg, /L2-ICU-01 ICU bay/);
});

test("O4: the chosen variant becomes the node; the node as it was is kept, so it can come back", () => {
  const t = sample();
  const bay = findNode(t, "ICU-Bay-01")!;
  addVariant(bay, { id: "wide", name: "4.5 m bays", inputs: { width: 4500 } });
  addVariant(bay, { id: "deep", inputs: { depth: 5500 } });
  bay.active = "wide";
  const kept = chooseVariant(bay, "wide", new Date("2026-10-19T10:00:00Z"));
  assert.equal(kept, "was-2026-10-19");
  assert.equal(bay.inputs!.width, 4500);
  assert.equal(bay.active, undefined);
  assert.deepEqual(bay.variants!.map((v) => v.id), ["deep", "was-2026-10-19"]);
  assert.deepEqual(bay.variants![1].inputs, { width: 4200 }, "the old width, ready to come back");
  bay.active = "was-2026-10-19";
  assert.equal((resolve(t).find((r) => r.node.id === "ICU-Bay-01.Room")!.args as any).room.width, 4200);
  assert.throws(() => chooseVariant(bay, "nope", new Date()), /no variant nope/);
});
