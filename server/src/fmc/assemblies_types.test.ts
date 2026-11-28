import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSpec, AssembliesSpec } from "./assemblies_spec.js";
import { applyPayload, planOps, ModelRead } from "./assemblies_plan.js";
import { EMPTY_MODEL, SAMPLE } from "./assemblies_testkit.js";

/** F59: curtain wall types and railing types, in the designs check and in the plan. */

const curtain = (over: object) => ({ ...SAMPLE.curtain_walls[0], ...over });
const railing = (over: object) => ({ ...SAMPLE.railings[0], ...over });
const only = (c: unknown[], r: unknown[]) => ({ curtain_walls: c, railings: r });
const specOf = (c: unknown[], r: unknown[]) => checkSpec(only(c, r)).spec as AssembliesSpec;

test("curtain wall designs: each grid layout and what its spacing needs", () => {
  for (const layout of ["fixed_distance", "maximum_spacing", "minimum_spacing"])
    assert.deepEqual(checkSpec(only([curtain({ vertical: { layout, spacing: 900 } })], [])).problems, [], layout);
  assert.deepEqual(checkSpec(only([curtain({ vertical: { layout: "fixed_number" }, horizontal: { layout: "none" } })], [])).problems, []);
  const bad = checkSpec(only([curtain({ vertical: { layout: "diagonal" }, horizontal: { layout: "fixed_distance", spacing: -5 }, mullion: { interior: 3 }, panel: "" })], []));
  assert.equal(bad.spec, null);
  for (const re of [/vertical.layout is none, fixed_distance/, /horizontal.spacing \(mm\) is needed for fixed_distance/, /mullion is \{interior\?, border\?\}/, /panel is a type name/])
    assert.ok(bad.problems.some((p) => re.test(p)), `${re}: ${bad.problems.join(" | ")}`);
});

test("railing designs: a base and a height in mm are needed; the top rail is optional", () => {
  assert.deepEqual(checkSpec(only([], [railing({ top_rail: undefined })])).problems, []);
  const bad = checkSpec(only([], [{ name: "FMC_RL_X", height: -1 }, railing({ name: "Rail", top_rail: 4 })]));
  for (const re of [/FMC_RL_X: base/, /FMC_RL_X: height \(mm\) is needed/, /Rail: the name starts FMC_/, /top_rail is a type name/])
    assert.ok(bad.problems.some((p) => re.test(p)), `${re}`);
  assert.ok(checkSpec(only([curtain({ name: "FMC_Same" })], [railing({ name: "fmc_same" })])).problems.some((p) => /is in the designs twice/.test(p)), "curtain wall and railing types share one name space");
});

test("curtain wall plan: a changed grid, mullion or panel is an update with each change listed", () => {
  const s = specOf([curtain({})], []);
  const have = { name: "FMC_CW_Glazed_1500", id: 7, vertical: { layout: "fixed_distance" as const, spacing: 1200 }, horizontal: { layout: "none" as const },
    mullion: { interior: "50 x 150mm" }, panel: "Glazed" };
  const model: ModelRead = { ...EMPTY_MODEL, curtain_types: [...EMPTY_MODEL.curtain_types, have] };
  const op = planOps(s, model).ops[0];
  assert.equal(op.action, "update");
  assert.deepEqual(op.changes, ["vertical spacing 1200 → 1500", "horizontal layout none → maximum_spacing", "horizontal spacing ? → 3000", "border mullion none → 50 x 150mm"]);
  assert.equal(op.payload!.id, 7);
  assert.equal(op.payload!.update, true);
  assert.deepEqual((op.payload!.vertical as { layout_code: number }).layout_code, 1);
});

test("curtain wall plan: every layout has Revit's code (none 0, fixed_distance 1, fixed_number 2, maximum 3, minimum 4)", () => {
  const layouts = [["none", 0], ["fixed_distance", 1], ["fixed_number", 2], ["maximum_spacing", 3], ["minimum_spacing", 4]] as const;
  const s = specOf(layouts.map(([layout], i) => curtain({ name: `FMC_CW_${i}`, vertical: layout === "none" || layout === "fixed_number" ? { layout } : { layout, spacing: 600 }, horizontal: { layout: "none" } })), []);
  const codes = applyPayload(planOps(s, EMPTY_MODEL).ops, true).curtain_walls.map((c) => (c.vertical as { layout_code: number }).layout_code);
  assert.deepEqual(codes, [0, 1, 2, 3, 4]);
});

test("curtain wall plan: a missing base blocks only when the type doesn't exist yet", () => {
  const s = specOf([curtain({ base: "Nope" })], []);
  assert.equal(planOps(s, EMPTY_MODEL).ops[0].action, "blocked");
  const exists: ModelRead = { ...EMPTY_MODEL, curtain_types: [{ name: "FMC_CW_Glazed_1500", id: 9, vertical: { layout: "fixed_distance", spacing: 1500 },
    horizontal: { layout: "maximum_spacing", spacing: 3000 }, mullion: { interior: "50 x 150mm", border: "50 x 150mm" }, panel: "Glazed" }] };
  assert.equal(planOps(s, exists).ops[0].action, "unchanged", "the type is there already, so its base isn't needed");
});

test("railing plan: create from the base with the height; update lists height and top rail; unchanged within half a mm", () => {
  const s = specOf([], [railing({})]);
  const create = planOps(s, EMPTY_MODEL).ops[0];
  assert.equal(create.action, "create");
  assert.deepEqual(create.payload, { name: "FMC_RL_Steel_1100", base: "Handrail - Rectangular", update: false, height: 1100, top_rail: "Rectangular - 50x50mm" });
  const model = (h: number, top?: string): ModelRead => ({ ...EMPTY_MODEL, railing_types: [...EMPTY_MODEL.railing_types, { name: "FMC_RL_Steel_1100", id: 5, height: h, top_rail: top }] });
  const upd = planOps(s, model(1000, "Circular - 40mm")).ops[0];
  assert.equal(upd.action, "update");
  assert.deepEqual(upd.changes, ["height 1000 → 1100", "top rail Circular - 40mm → Rectangular - 50x50mm"]);
  assert.equal(planOps(s, model(1100.4, "Rectangular - 50x50mm")).ops[0].action, "unchanged");
});

test("railing plan: a top rail type the model lacks blocks the railing and asks the kit; the others still go ahead", () => {
  const s = specOf([curtain({})], [railing({})]);
  const p = planOps(s, { ...EMPTY_MODEL, top_rail_types: [] });
  assert.deepEqual(p.ops.map((o) => o.action), ["create", "blocked"]);
  assert.deepEqual(p.kit_requests.map((k) => k.item), ["top rail type Rectangular - 50x50mm"]);
  const pay = applyPayload(p.ops, false);
  assert.deepEqual([pay.curtain_walls.length, pay.railings.length], [1, 0]);
});
