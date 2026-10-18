import { test } from "node:test";
import assert from "node:assert/strict";
import { OPS, opsProblems, splitProblems } from "./ops.js";
import { MIN_EDGE_MM, geometryProblems, hostNeeds, hostTemplateProblem, templateHosting } from "./opsgeom.js";
import { skippedOps } from "./recipebuild.js";

const plane = (name: string, from: [number, number], to: [number, number], view?: string) => ({ op: "add_ref_plane", name, from, to, ...(view ? { view } : {}) });
const errorsOf = (ops: object[], opts = {}) => splitProblems(opsProblems(OPS.parse(ops), null, undefined, undefined, opts)).errors.filter((e) => !/shared parameter file/.test(e));
const notesOf = (ops: object[], opts = {}) => splitProblems(opsProblems(OPS.parse(ops), null, undefined, undefined, opts)).notes;

test("F-064: two planes closer than 1.5 mm can't be dimensioned; 1.5 mm and more is fine", () => {
  const close = [plane("A", [0, -500], [0, 500]), plane("B", [0.6, -500], [0.6, 500]), { op: "add_dimension", name: "Gap", between: ["A", "B"] }];
  assert.match(errorsOf(close).join(" | "), /"A" and "B" are 0\.6 mm apart: Revit can't dimension planes closer than 1\.5 mm/);
  const fine = [plane("A", [0, -500], [0, 500]), plane("B", [1.5, -500], [1.5, 500]), { op: "add_dimension", name: "Gap", between: ["A", "B"] }];
  assert.deepEqual(errorsOf(fine), []);
  // planes drawn in different kinds of view, or not parallel, aren't compared
  const crossing = [plane("A", [0, -500], [0, 500]), plane("B", [-500, 0.5], [500, 0.5]), { op: "add_dimension", name: "Gap", between: ["A", "B"] }];
  assert.deepEqual(errorsOf(crossing), []);
});

test("F-064: a solid thinner than Revit's short-curve tolerance is refused (the 17–18 Oct panel light diffuser, 0.5 mm)", () => {
  const thin = [{ op: "extrusion", name: "Diffuser", points: [[0, 0], [600, 0], [600, 600], [0, 600]], start: 10, end: 10.5 }];
  assert.match(errorsOf(thin).join(" | "), /make it 0\.5 mm thick, under Revit's 0\.78 mm short-curve tolerance/);
  assert.deepEqual(errorsOf([{ ...thin[0], end: 10.8 }]), []);
  assert.ok(Math.abs(MIN_EDGE_MM - 0.78) < 0.001);
});

test("F-064: a short outline edge is a warning, not an error (88 batch families built with them)", () => {
  const rounded = [{ op: "extrusion", name: "Stop", points: [[0, 0], [0.64, 0.44], [10, 0.44], [10, 20], [0, 20]], start: 0, end: 40 }];
  assert.deepEqual(errorsOf(rounded), []);
  assert.match(notesOf(rounded).join(" | "), /edge 1 .* is 0\.78 mm, under Revit's 0\.78 mm short-curve tolerance/);
});

test("F-064: lock_face with no face on the plane fails at any distance; a plane a labelled dimension drives only warns", () => {
  const base = [plane("Top", [-3000, 28], [3000, 28], "Front"),
    { op: "extrusion", name: "Pad", points: [[0, 0], [100, 0], [100, 100], [0, 100]], start: 25, end: 45 }];
  const lock = { op: "lock_face", name: "Pad/Top", solid: "Pad", plane: "Top", view: "front" };
  assert.match(errorsOf([...base, lock]).join(" | "), /neither end of "Pad" \(25 and 45 mm\) is on "Top" \(28 mm; the nearest is 3 mm off\), so Revit has no face to lock/);
  // on the plane: fine
  assert.deepEqual(errorsOf([plane("Top", [-3000, 25], [3000, 25], "Front"), base[1], lock]), []);
  // the soakpit case: the plane is driven by a labelled dimension, so the engine's regenerate may move it onto the face
  const driven = [base[0], plane("Floor", [-3000, 0], [3000, 0], "Front"),
    { op: "add_family_param", name: "Top Offset", type: "Length" }, { op: "add_dimension", name: "Top Offset", between: ["Floor", "Top"], label: "Top Offset", view: "Front" },
    base[1], lock];
  assert.deepEqual(errorsOf(driven), []);
  assert.match(notesOf(driven).join(" | "), /neither end of "Pad"/);
  // plan: an outline 0.6 mm off a reused plane (F-064 #7)
  const plan = [plane("Side", [50, -500], [50, 500]), { op: "extrusion", name: "Fin", points: [[0, 0], [49.4, 0], [49.4, 10], [0, 10]], start: 0, end: 100 },
    { op: "lock_face", name: "Fin/Side", solid: "Fin", plane: "Side" }];
  assert.match(errorsOf(plan).join(" | "), /no edge of "Fin" lies on "Side" \(the nearest is 0\.6 mm off\).*Snap the outline's points to the plane/);
});

test("F-064: a type value for a parameter the recipe never adds is an error when the template is known", () => {
  const ops = [{ op: "add_type", name: "T1" }, { op: "set_type_value", name: "T1/Lamp Count", type: "T1", param: "Lamp Count", value: 2 },
    { op: "set_type_value", name: "T1/Keynote", type: "T1", param: "Keynote", value: "E.LGT_01" }];
  assert.match(errorsOf(ops, { template: "Metric Generic Model face based.rft" }).join(" | "),
    /parameter "Lamp Count" isn't added in this recipe .* and Metric Generic Model face based\.rft doesn't have it/);
  // built-ins never fail; without the template it stays a "may exist" note
  assert.ok(!errorsOf(ops, { template: "Metric Generic Model face based.rft" }).some((e) => /Keynote/.test(e)));
  assert.deepEqual(errorsOf(ops), []);
  // Width on a door template is the template's; on a generic model it isn't
  const width = [{ op: "add_type", name: "T1" }, { op: "set_type_value", name: "T1/Width", type: "T1", param: "Width", value: 900 }];
  assert.deepEqual(errorsOf(width, { template: "Metric Door.rft" }), []);
  assert.match(errorsOf(width, { template: "Metric Generic Model.rft" }).join(" | "), /parameter "Width" isn't added/);
});

test("F-064: one name for two solids (an extrusion and a sweep) is refused", () => {
  const ops = [{ op: "extrusion", name: "Frame", points: [[0, 0], [10, 0], [10, 10], [0, 10]], start: 0, end: 10 },
    { op: "revolution", name: "Frame", profile: [[0, 0], [10, 0], [10, 10]], start_deg: 0, end_deg: 360 }];
  assert.match(errorsOf(ops).join(" | "), /solid name "Frame" is already used by op 1 \(extrusion\)/);
});

test("F-061: the register's Host decides whether the template must host", () => {
  assert.equal(templateHosting("Metric Generic Model face based.rft"), "face");
  assert.equal(templateHosting("Metric Door.rft"), "wall");
  assert.equal(templateHosting("Metric Electrical Fixture.rft"), "none");
  assert.deepEqual(hostNeeds("Wall face"), ["face", "wall"]);
  assert.deepEqual(hostNeeds("Wall or ceiling"), ["face"]);
  for (const h of ["Level", "Floor", "Work plane", "Pipe", "Level / wall", "Floor or toposolid", "-", "Ceiling void"]) assert.equal(hostNeeds(h), null, h);
  // the 14 Wave 1 families: a socket on an unhosted template
  assert.match(hostTemplateProblem("FMC_E_ElecFixture_Socket_13A_Twin", "Metric Generic Model.rft", "Wall face")!,
    /the register's host is "Wall face", but Metric Generic Model\.rft is unhosted, so it can't be placed there \(F-061\)\. Use a face based template/);
  assert.equal(hostTemplateProblem("FMC_E_ElecFixture_Socket_13A_Twin", "Metric Generic Model face based.rft", "Wall face"), null);
  assert.equal(hostTemplateProblem("FMC_A_Door_X", "Metric Door.rft", "Wall"), null);
  assert.equal(hostTemplateProblem("FMC_X", "Metric Generic Model.rft", null), null);
});

test("F-061: a build names each skipped op and why, numbered as in the recipe", () => {
  const reply = { ops: [{ op: "add_type", name: "T1", result: "create" }, { op: "add_ref_plane", name: "Left", result: "skip", detail: "" },
    { op: "add_material", name: "Steel", result: "skip", detail: "exists with another shape: left as it is (rename to redraw)" }] };
  assert.deepEqual(skippedOps(reply, 40), [
    { op: 42, name: "add_ref_plane Left", why: "already as asked (nothing to change)" },
    { op: 43, name: "add_material Steel", why: "exists with another shape: left as it is (rename to redraw)" },
  ]);
  assert.deepEqual(skippedOps({}, 0), []);
});
