import { test } from "node:test";
import assert from "node:assert/strict";
import { OP } from "../fmc/ops.js";
import { RHINO_PART } from "./rhino.js";
import { partName, recipeTwins, to3d, withTwins } from "./recipe2rhino.js";

const recipe = [
  { op: "add_material", name: "FMC_Rubber_Black", param: "Rubber Material" },
  { op: "revolution", name: "Castor Wheel FL", axis: "x", axis_at: [-700, 62], profile: [[0, -352], [56, -352], [62, -346], [62, -314], [56, -308], [0, -308]] },
  { op: "set_subcategory", name: "Castor Wheel FL", subcategory: "Castor" },
  { op: "set_material_param", name: "Castor Wheel FL", param: "Rubber Material" },
  { op: "set_visibility", name: "Castor Wheel FL", coarse: false, medium: true, fine: true },
  { op: "sweep", name: "Side Rail Foot L", path_plane: "right", at: -488, path: [[-900, 570], [-900, 830], [-840, 890]], profile: [[14, 0], [0, 14], [-14, 0], [0, -14]] },
  { op: "extrusion", name: "Chassis Cover", sketch: "front", start: 10, end: 40, points: [[0, 0], [100, 0], [100, 50]] },
  { op: "extrusion", name: "Coarse Envelope", rect: ["Left", "Right", "Front", "Back"], start: 0, end: 1148 },
  { op: "extrusion", name: "Deck", rect: ["Left", "Right", "Front", "Back"], start: 500, end: 540 },
  { op: "revolution", name: "Light Head Satellite", axis_at: [-800, 0], profile: [[0, 700], [350, 700], [0, 850]] },
  { op: "set_visible_param", name: "Light Head Satellite/Visible", solid: "Light Head Satellite", param: "Second Light Head" },
  { op: "extrusion", name: "CN E Pad", sketch: "plan", start: 0, end: 5, points: [[0, 0], [10, 0], [10, 10]] },
  { op: "set_subcategory", name: "CN E Pad", subcategory: "Connector Pads" },
];

test("LOD 400: recipe points go to world millimetres the way the command set draws them", () => {
  assert.deepEqual(to3d("plan", [1, 2], 3), [1, 2, 3]);
  assert.deepEqual(to3d("front", [1, 2], 3), [1, 3, 2]);
  assert.deepEqual(to3d("right", [1, 2], 3), [3, 1, 2]);
  assert.equal(partName("Castor Wheel FL"), "Castor_Wheel_FL");
  assert.equal(partName("3-way Valve"), "P_3_way_Valve");
});

test("LOD 400: each native solid gets a smooth twin in place, with its subcategory, kit material and type switch", () => {
  const t = recipeTwins(recipe);
  assert.deepEqual(t.parts.map((p) => p.name), ["Castor_Wheel_FL", "Side_Rail_Foot_L", "Chassis_Cover", "Light_Head_Satellite"]);
  for (const p of t.parts) assert.equal(RHINO_PART.safeParse(p).success, true, p.name);
  const wheel = t.parts[0] as any;
  assert.equal(wheel.op, "revolve_loop");
  assert.deepEqual(wheel.origin, [0, -700, 62]);
  assert.deepEqual(wheel.axis, [1, 0, 0]);
  assert.deepEqual(wheel.loop[1], [-352, -644, 62], "axis x: [r, d] → (d, y + r, z)");
  assert.equal(wheel.material, "FMC_Rubber_Black", "the kit material behind the parameter, for the render");
  assert.equal(wheel.subcategory, "Castor");
  const rail = t.parts[1] as any;
  assert.deepEqual(rail.path[0], [-488, -900, 570], "right: (y, z) at x = at");
  const cover = t.parts[2] as any;
  assert.deepEqual(cover.points[1], [100, -10, 0], "front: depth toward the viewer, -y");
  assert.deepEqual(cover.vector, [0, -30, 0]);
  assert.equal(t.map[3].visible_param, "Second Light Head");
  assert.deepEqual(t.kept.map((k) => k.solid), ["Coarse Envelope", "Deck", "CN E Pad"], "envelope, a box between planes, a connector pad stay native");
});

test("LOD 400: the recipe gets import_part ops on Fine only, and each native solid becomes Medium only, edited in place", () => {
  const t = recipeTwins(recipe);
  const exported = new Map([
    ["Castor_Wheel_FL", { file: "D:\\K\\_Staging\\_Rhino\\FMC_I_Bed\\Castor_Wheel_FL.3dm", size_mm: [44, 124, 124] }],
    ["Light_Head_Satellite", { file: "D:\\K\\_Staging\\_Rhino\\FMC_I_Bed\\Light_Head_Satellite.3dm" }],
  ]);
  const { ops, twins } = withTwins(recipe, t.map, exported);
  assert.equal(twins, 2, "only exported twins: the rail and the cover failed their check, so they stay native on Fine");
  const vis = (n: string) => ops.filter((o) => o.op === "set_visibility" && o.name === n);
  assert.deepEqual(vis("Castor Wheel FL"), [{ op: "set_visibility", name: "Castor Wheel FL", coarse: false, medium: true, fine: false }], "edited, not repeated");
  assert.deepEqual(vis("Castor Wheel FL Fine")[0], { op: "set_visibility", name: "Castor Wheel FL Fine", coarse: false, medium: false, fine: true });
  assert.deepEqual(vis("Light Head Satellite")[0].fine, false, "a solid without its own visibility op gets one");
  const imp = ops.find((o) => o.op === "import_part" && o.name === "Castor Wheel FL Fine")!;
  assert.equal(OP.safeParse(imp).success, true);
  assert.deepEqual(imp.size_mm, [44, 124, 124]);
  assert.ok(ops.some((o) => o.op === "set_material_param" && o.name === "Castor Wheel FL Fine" && o.param === "Rubber Material"));
  assert.ok(ops.some((o) => o.op === "set_visible_param" && o.solid === "Light Head Satellite Fine" && o.param === "Second Light Head"));
  assert.equal(vis("Side Rail Foot L").length, 0, "not exported: untouched");
  const names = ops.filter((o) => o.op === "set_visibility").map((o) => o.name);
  assert.equal(new Set(names).size, names.length, "no solid's visibility is set twice");
});

test("LOD 400: import_part reads only .3dm parts from a _Rhino staging folder", () => {
  assert.equal(OP.safeParse({ op: "import_part", name: "X Fine", file: "D:\\K\\_Rhino\\F\\X.3dm" }).success, true);
});
