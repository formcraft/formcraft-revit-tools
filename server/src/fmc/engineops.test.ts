import { test } from "node:test";
import assert from "node:assert/strict";
import { OPS, expandSkeletons, opsProblems, splitProblems } from "./ops.js";
import { followParams, parseRecipe } from "./recipes.js";

const skeleton = { op: "skeleton", name: "Box", width: { param: "Width", mm: 600 }, depth: { param: "Depth", mm: 400 }, height: { param: "Height", mm: 900 } };
const errorsOf = (ops: object[], opts = {}) => splitProblems(opsProblems(OPS.parse(ops), null, undefined, undefined, opts)).errors;

test("F-062: a skeleton is the parameters, default size, planes, labelled dimensions and equalities it stands for", () => {
  const ops = expandSkeletons(OPS.parse([skeleton]));
  const by = (op: string) => ops.filter((o) => o.op === op).map((o) => o.name);
  assert.deepEqual(by("add_family_param"), ["Width", "Depth", "Height"]);
  assert.equal(ops.findIndex((o) => o.op === "set_default_size") < ops.findIndex((o) => o.op === "add_ref_plane"), true, "size first (F-026)");
  assert.deepEqual(by("add_ref_plane"), ["Left", "Right", "Front", "Back", "Top"]);
  assert.deepEqual(by("add_dimension"), ["Width", "Depth", "Height"]);
  assert.deepEqual(by("add_eq_dimension"), ["Box EQ width", "Box EQ depth"]);
  const height = ops.find((o) => o.op === "add_dimension" && o.name === "Height") as any;
  assert.deepEqual(height.between, ["Ref. Level", "Top"]);
  assert.deepEqual((ops.find((o) => o.name === "Left") as any).from, [-300, -3000]);
  assert.deepEqual((ops.find((o) => o.name === "Top") as any).from, [-3000, 900]);
});

test("F-062: a mounting height adds an instance parameter and a Bottom plane; the solid on the skeleton validates", () => {
  const mounted = { ...skeleton, mounting: { param: "Mounting Height", mm: 1200 } };
  const ops = expandSkeletons(OPS.parse([mounted]));
  const mh = ops.find((o) => o.op === "add_family_param" && o.name === "Mounting Height") as any;
  assert.equal(mh.instance, true);
  assert.deepEqual((ops.find((o) => o.op === "add_dimension" && o.name === "Height") as any).between, ["Bottom", "Top"]);
  assert.deepEqual((ops.find((o) => o.name === "Top") as any).from, [-3000, 2100]);
  const recipe = [mounted, { op: "extrusion", name: "Body", rect: ["Left", "Right", "Front", "Back"], start: 1200, end: 2100, start_plane: "Bottom", end_plane: "Top" }];
  assert.deepEqual(errorsOf(recipe, { template: "Metric Generic Model.rft" }), []);
});

test("F-062: Gate A's follow check sees the skeleton's labelled Width, Depth and Height", () => {
  const raw = JSON.stringify({ schema: "fmc-recipe/0.1", family: "FMC_E_LightFixture_Box", template: "Metric Generic Model face based.rft",
    ops: [skeleton, { op: "add_type", name: "600x400" }, { op: "add_type", name: "1200x600" },
      { op: "set_type_value", name: "600x400/Width", type: "600x400", param: "Width", value: 600 }, { op: "set_type_value", name: "1200x600/Width", type: "1200x600", param: "Width", value: 1200 },
      { op: "set_type_value", name: "600x400/Depth", type: "600x400", param: "Depth", value: 400 }, { op: "set_type_value", name: "1200x600/Depth", type: "1200x600", param: "Depth", value: 600 }],
    values: {} });
  const { recipe, problems } = parseRecipe(raw);
  assert.deepEqual(problems, []);
  const params = followParams(recipe!).map((f) => f.param).sort();
  assert.ok(params.includes("Width") && params.includes("Depth"), params.join(","));
});

test("F-062: name_template_plane makes a plane a later op may use; ends on start_plane/end_plane count as on their planes", () => {
  const ops = [{ op: "name_template_plane", name: "Frame Head", axis: "z", at_mm: 2100 },
    { op: "add_dimension", name: "Head Gap", between: ["Frame Head", "Ref. Level"] }];
  assert.ok(!splitProblems(opsProblems(OPS.parse(ops), null)).notes.some((n) => /Frame Head/.test(n)), "Frame Head is known");
  // a lock to the plane an end is snapped to is never "no face to lock"
  const locked = [{ op: "add_ref_plane", name: "Top", from: [-3000, 28], to: [3000, 28], view: "Front" },
    { op: "extrusion", name: "Pad", points: [[0, 0], [100, 0], [100, 100], [0, 100]], start: 25, end: 45, end_plane: "Top" },
    { op: "lock_face", name: "Pad/Top", solid: "Pad", plane: "Top", view: "front" }];
  assert.deepEqual(errorsOf(locked), []);
  // a thin solid whose ends go onto planes isn't judged by its drawn numbers
  const thin = [{ op: "add_ref_plane", name: "B", from: [-3000, 10], to: [3000, 10], view: "Front" }, { op: "add_ref_plane", name: "T", from: [-3000, 13], to: [3000, 13], view: "Front" },
    { op: "extrusion", name: "Plate", points: [[0, 0], [10, 0], [10, 10], [0, 10]], start: 10, end: 10.5, start_plane: "B", end_plane: "T" }];
  assert.deepEqual(errorsOf(thin), []);
});
