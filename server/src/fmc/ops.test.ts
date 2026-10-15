import { test } from "node:test";
import assert from "node:assert/strict";
import { OPS, opsProblems, splitProblems } from "./ops.js";
import { SpParam } from "./specs.js";

const dict = new Map<string, SpParam>([["FMC_Keynote_Code", { name: "FMC_Keynote_Code", guid: "1111-AAAA", datatype: "TEXT", group: "FMC_Identity" }]]);

const batch = OPS.parse([
  { op: "set_category", name: "Generic Models" },
  { op: "add_ref_plane", name: "Left", from: [-300, -1000], to: [-300, 1000], is_reference: "Left" },
  { op: "add_ref_plane", name: "Right", from: [300, -1000], to: [300, 1000], is_reference: "Right" },
  { op: "add_family_param", name: "Width", type: "Length" },
  { op: "add_shared_param", name: "FMC_Keynote_Code", guid: "1111-aaaa" },
  { op: "add_type", name: "0600x0600" },
  { op: "set_type_value", name: "0600x0600/Width", type: "0600x0600", param: "Width", value: 600 },
  { op: "add_dimension", name: "Width", between: ["Left", "Right"], label: "Width" },
]);

test("a clean batch has no problems; defaults fill in (instance false, group Dimensions, offset 300)", () => {
  assert.deepEqual(opsProblems(batch, dict), []);
  const p = batch.find((o) => o.op === "add_family_param")!;
  assert.equal((p as any).instance, false);
  assert.equal((p as any).group, "Dimensions");
});

test("shared parameters only from the dictionary, by GUID and name", () => {
  const bad = OPS.parse([{ op: "add_shared_param", name: "FMC_Keynote_Code", guid: "9999" }, { op: "add_shared_param", name: "Wrong", guid: "1111-AAAA" },
    { op: "add_family_param", name: "FMC_Keynote_Code", type: "Text" }]);
  const p = opsProblems(bad, dict);
  assert.match(p[0], /isn't in FMC_SharedParameters\.txt/);
  assert.match(p[1], /names 1111-AAAA "FMC_Keynote_Code"/);
  assert.match(p[2], /add it with add_shared_param/);
});

test("duplicates, degenerate planes and dimensions: errors vs notes", () => {
  const b = OPS.parse([{ op: "add_type", name: "T" }, { op: "add_type", name: "t" }, { op: "add_ref_plane", name: "P", from: [0, 0], to: [0, 0] },
    { op: "add_dimension", name: "D", between: ["P", "Existing in file"] }]);
  const { errors, notes } = splitProblems(opsProblems(b, dict));
  assert.equal(errors.length, 2);
  assert.equal(notes.length, 1);
  assert.throws(() => OPS.parse([{ op: "delete_element", name: "x" }]));
});

test("B1c geometry: a box between four planes, locked, with its material and visibility", () => {
  const b = OPS.parse([
    { op: "add_ref_plane", name: "Left", from: [-300, -1000], to: [-300, 1000] },
    { op: "add_ref_plane", name: "Right", from: [300, -1000], to: [300, 1000] },
    { op: "add_family_param", name: "Body Material", type: "Material" },
    { op: "extrusion", name: "Body", rect: ["Left", "Right", "Front", "Back"], end: 900 },
    { op: "set_material_param", name: "Body", param: "Body Material" },
    { op: "set_visibility", name: "Body", coarse: false },
  ]);
  const { errors, notes } = splitProblems(opsProblems(b, dict));
  assert.deepEqual(errors, []);
  assert.equal(notes.length, 2); // Front and Back are expected in the file
  const bad = OPS.parse([{ op: "void_extrusion", name: "Cut", start: 500, end: 100 }]);
  assert.equal(splitProblems(opsProblems(bad, dict)).errors.length, 2);
});

test("LOD 400 pack: subcategories, a profile sweep, a revolution, swing lines, locks, EQ and a nested part", () => {
  const b = OPS.parse([
    { op: "add_ref_plane", name: "Left", from: [-450, -1000], to: [-450, 1000] },
    { op: "add_ref_plane", name: "Right", from: [450, -1000], to: [450, 1000] },
    { op: "add_family_param", name: "Leaf Width", type: "Length" },
    { op: "add_subcategory", name: "Frame", line_weight_projection: 2, line_weight_cut: 4 },
    { op: "add_subcategory", name: "Plan Swing", line_weight_projection: 1, color: [0, 0, 0] },
    { op: "load_family", name: "FMC_Profile_A_DoorFrame", path: "D:\\Kit\\04_Families\\_Profiles\\FMC_Profile_A_DoorFrame.rfa" },
    { op: "sweep", name: "Frame", path: [[-450, 0], [-450, 2100], [450, 2100], [450, 0]], path_plane: "front",
      profile_family: "FMC_Profile_A_DoorFrame", profile_type: "50x100", subcategory: "Frame" },
    { op: "revolution", name: "Handle rose", profile: [[0, 0], [25, 0], [25, 8], [0, 8]], axis_at: [380, 0] },
    { op: "symbolic_lines", name: "Swing plan", arc: { center: [-450, 0], radius: 900, start_deg: 0, end_deg: 90 }, subcategory: "Plan Swing", coarse: false },
    { op: "set_subcategory", name: "Handle rose", subcategory: "Frame" },
    { op: "lock_face", name: "Frame/Left", solid: "Frame", plane: "Left" },
    { op: "add_eq_dimension", name: "EQ width", planes: ["Left", "Center (Left/Right)", "Right"] },
    { op: "load_family", name: "FMC_A_Hardware_Lever", path: "D:\\Kit\\04_Families\\_Staging\\A\\FMC_A_Hardware_Lever.rfa" },
    { op: "place_nested", name: "Lever", family: "FMC_A_Hardware_Lever", type: "Standard", at: [380, 0, 1000], params: { Width: "Leaf Width" } },
  ]);
  const { errors, notes } = splitProblems(opsProblems(b, dict, "D:\\Kit\\04_Families"));
  assert.deepEqual(errors, []);
  assert.deepEqual(notes, []);
  const sweep = b.find((o) => o.op === "sweep") as any;
  assert.equal(sweep.at, 0);
  assert.deepEqual((b.find((o) => o.op === "place_nested") as any).at, [380, 0, 1000]);
});

test("LOD 400 pack: bad input is refused", () => {
  const b = OPS.parse([
    { op: "sweep", name: "S", path: [[0, 0], [100, 0]] },
    { op: "revolution", name: "R", profile: [[-5, 0], [5, 0], [5, 5]], start_deg: 0, end_deg: 0 },
    { op: "blend", name: "B", base: [[0, 0], [1, 0], [1, 1]], top: [[0, 0], [1, 0], [1, 1]], start: 10, end: 5 },
    { op: "symbolic_lines", name: "L", subcategory: "Plan Swing" },
    { op: "add_eq_dimension", name: "E", planes: ["A", "A", "B"] },
    { op: "load_family", name: "X", path: "C:\\Users\\Someone\\Downloads\\x.rfa" },
    { op: "lock_face", name: "wrong", solid: "S", plane: "Left" },
  ]);
  const { errors } = splitProblems(opsProblems(b, dict, "D:\\Kit\\04_Families"));
  const all = errors.join(" | ");
  assert.match(all, /give profile \(points\) or profile_family/);
  assert.match(all, /start_deg and end_deg are the same/);
  assert.match(all, /can't cross its axis/);
  assert.match(all, /end \(5\) must be above start \(10\)/);
  assert.match(all, /give points or arc/);
  assert.match(all, /a plane is named twice/);
  assert.match(all, /isn't inside the kit's families folder/);
  assert.match(all, /name must be "S\/Left"/);
  assert.throws(() => OPS.parse([{ op: "add_subcategory", name: "X", line_weight_projection: 17 }]));
});
