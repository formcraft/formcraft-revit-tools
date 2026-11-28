// G011 (L001 build plan 43, L003-F368): polygon outlines and revolution profiles / axes on planes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPS, opsProblems, planeLoopProblems, splitProblems } from "./ops.js";
import { RECIPE, solidPlanes } from "./recipes.js";
import { recipeTwins } from "../hub/recipe2rhino.js";

const plan = (name: string, x1: number, y1: number, x2: number, y2: number) => ({ op: "add_ref_plane", name, from: [x1, y1], to: [x2, y2] });
const planes = [plan("Left", -500, -900, -500, 900), plan("Right", 500, -900, 500, 900), plan("Notch", 0, -900, 0, 900),
  plan("Front", -900, -300, 900, -300), plan("Back", -900, 300, 900, 300), plan("Mid", -900, 0, 900, 0)];
const L = [["Left", "Front"], ["Right", "Front"], ["Right", "Mid"], ["Notch", "Mid"], ["Notch", "Back"], ["Left", "Back"]];

test("planeLoopProblems: an L loop is fine and each edge is along the plane its corners share", () => {
  const r = planeLoopProblems(L);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.along, ["Front", "Right", "Mid", "Notch", "Back", "Left"]);
  // a repeated closing corner is dropped
  assert.deepEqual(planeLoopProblems([...L, ["Left", "Front"]]).problems, []);
});

test("planeLoopProblems: too few corners, neighbours on no or two planes, two edges on one plane", () => {
  assert.ok(planeLoopProblems([["A", "B"], ["A", "C"]]).problems.length > 0);
  assert.ok(planeLoopProblems([["Left", "Front"], ["Right", "Back"], ["Left", "Back"]]).problems.some((p) => /share/.test(p)));
  assert.ok(planeLoopProblems([["Left", "Front"], ["Left", "Front"], ["Right", "Back"]]).problems.length > 0);
  assert.ok(planeLoopProblems([["Left", "Front"], ["Notch", "Front"], ["Right", "Front"], ["Right", "Back"], ["Left", "Back"]]).problems.length > 0);
});

test("extrusion outline_planes: checks clean; one of rect / outline_planes / points; a plane not made earlier is a note, a broken loop an error", () => {
  const ok = splitProblems(opsProblems(OPS.parse([...planes, { op: "extrusion", name: "L slab", outline_planes: L, start: 0, end: 200 }]), null));
  assert.deepEqual(ok.errors, []);
  const both = splitProblems(opsProblems(OPS.parse([...planes, { op: "extrusion", name: "X", rect: ["Left", "Right", "Front", "Back"], outline_planes: L }]), null));
  assert.ok(both.errors.some((e) => /exactly one|one of/i.test(e)), both.errors.join("\n"));
  const missing = splitProblems(opsProblems(OPS.parse([...planes, { op: "extrusion", name: "X", outline_planes: [["Left", "Front"], ["Ghost", "Front"], ["Ghost", "Back"], ["Left", "Back"]] }]), null));
  assert.ok(missing.notes.some((e) => /"Ghost" isn't made earlier/.test(e)), missing.notes.join("\n"));
  const broken = splitProblems(opsProblems(OPS.parse([...planes, { op: "extrusion", name: "X", outline_planes: [["Left", "Front"], ["Right", "Back"], ["Left", "Back"]] }]), null));
  assert.ok(broken.errors.some((e) => /share/.test(e)), broken.errors.join("\n"));
});

test("revolution profile_planes / axis_planes: parse without a fixed profile; profile or profile_planes, not both", () => {
  const front = (name: string, x: number) => ({ op: "add_ref_plane", name, from: [x, 0], to: [x, 1000], view: "Front" });
  const level = (name: string, z: number) => ({ op: "add_ref_plane", name, from: [-900, z], to: [900, z], view: "Front" });
  const base = [front("Axis", 0), front("Knob Radius", 40), level("Knob Base", 100), level("Knob Top", 160), plan("Centre FB", -900, 0, 900, 0)];
  const prof = [["Axis", "Knob Base"], ["Knob Radius", "Knob Base"], ["Knob Radius", "Knob Top"], ["Axis", "Knob Top"]];
  const ops = OPS.parse([...base, { op: "revolution", name: "Knob", profile_planes: prof, axis_planes: ["Axis", "Centre FB"] }]);
  assert.deepEqual(splitProblems(opsProblems(ops, null)).errors, []);
  const both = splitProblems(opsProblems(OPS.parse([...base, { op: "revolution", name: "K", profile: [[0, 0], [40, 0], [40, 60]], profile_planes: prof }]), null));
  assert.ok(both.errors.some((e) => /not both|either/i.test(e)), both.errors.join("\n"));
  const none = splitProblems(opsProblems(OPS.parse([...base, { op: "revolution", name: "K" }]), null));
  assert.ok(none.errors.length > 0);
  const noAxis = splitProblems(opsProblems(OPS.parse([...base, { op: "revolution", name: "K", profile_planes: prof }]), null));
  assert.ok(noAxis.notes.some((n) => /axis_planes/.test(n)), noAxis.notes.join("\n"));

  // the planes it's locked to count for Gate A's follow checks, and Rhino leaves it native (a fixed twin wouldn't flex)
  const recipe = RECIPE.parse({ schema: "fmc-recipe/0.1", family: "FMC_E_X_Knob", template: "Metric Generic Model.rft", ops: [...base,
    { op: "revolution", name: "Knob", profile_planes: prof, axis_planes: ["Axis", "Centre FB"] },
    { op: "extrusion", name: "L slab", outline_planes: [["Axis", "Knob Base"], ["Knob Radius", "Knob Base"], ["Knob Radius", "Knob Top"]], start_plane: "Knob Base", end: 10 }] });
  const sp = solidPlanes(recipe);
  assert.ok(["Axis", "Knob Radius", "Knob Base", "Knob Top", "Centre FB"].every((p) => sp.get("Knob")?.has(p)), JSON.stringify([...(sp.get("Knob") ?? [])]));
  assert.ok(sp.get("L slab")?.has("Knob Radius"));
  const tw = recipeTwins(recipe.ops as any);
  assert.ok(tw.kept.some((k) => k.solid === "Knob" && /planes/.test(k.why)), JSON.stringify(tw.kept));
});
