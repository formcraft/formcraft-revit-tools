import { test } from "node:test";
import assert from "node:assert/strict";
import { OPS, familyRoots, opsProblems, profileLoopProblems, resolveFamilyPath, resolveFamilyPaths, runningPlanes, splitProblems } from "./ops.js";
import { SpParam } from "./specs.js";
import { parseMaterialDb } from "./materials.js";

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
  assert.match(all, /give points, lines or arc/);
  assert.match(all, /a plane is named twice/);
  assert.match(all, /isn't inside the kit's families folder/);
  assert.match(all, /name must be "S\/Left"/);
  assert.throws(() => OPS.parse([{ op: "add_subcategory", name: "X", line_weight_projection: 17 }]));
});

test("profile_lines: a closed loop of lines and one arc passes; open, zero-length, in-line arcs and crossings are refused", () => {
  const good = OPS.parse([
    { op: "add_subcategory", name: "Profile" },
    { op: "profile_lines", name: "Architrave", start: [0, 0], subcategory: "Profile",
      segments: [{ to: [70, 0] }, { to: [70, 15] }, { to: [50, 20], through: [62, 19] }, { to: [0, 20] }, { to: [0, 0] }] },
  ]);
  assert.deepEqual(opsProblems(good, dict), []);
  // A half-round: one line and one arc close the loop.
  assert.deepEqual(profileLoopProblems([0, 0], [{ to: [40, 0] }, { to: [0, 0], through: [20, 20] }]), []);
  assert.match(profileLoopProblems([0, 0], [{ to: [10, 0] }, { to: [10, 10] }])[0], /isn't closed/);
  assert.deepEqual(profileLoopProblems([0, 0], [{ to: [10, 0] }, { to: [10, 10] }, { to: [0, 0.005] }]), []); // within 0.01 mm
  assert.match(profileLoopProblems([0, 0], [{ to: [0, 0] }, { to: [10, 0] }, { to: [0, 10] }, { to: [0, 0] }]).join(), /segment 1 has no length/);
  assert.match(profileLoopProblems([0, 0], [{ to: [10, 0] }, { to: [20, 0], through: [15, 0] }, { to: [0, 10] }, { to: [0, 0] }]).join(), /in line/);
  // A bow tie crosses itself.
  assert.match(profileLoopProblems([0, 0], [{ to: [10, 10] }, { to: [10, 0] }, { to: [0, 10] }, { to: [0, 0] }]).join(), /crosses or touches itself/);
  // An arc that bulges back across the base line crosses it.
  assert.match(profileLoopProblems([0, 0], [{ to: [40, 0] }, { to: [40, 10] }, { to: [0, 10], through: [20, -5] }, { to: [0, 0] }]).join(), /crosses/);
  // Out and back on the same line has no area.
  assert.match(profileLoopProblems([0, 0], [{ to: [10, 0] }, { to: [0, 0] }]).join(), /no area/);
  const open = OPS.parse([{ op: "profile_lines", name: "P", start: [0, 0], segments: [{ to: [10, 0] }, { to: [10, 10] }] }]);
  assert.equal(splitProblems(opsProblems(open, dict)).errors.length, 1);
});

test("set_visible_param: a solid's Visible from a Yes/No parameter added earlier", () => {
  const sp = new Map(dict).set("FMC_Design_Movement", { name: "FMC_Design_Movement", guid: "2222-BBBB", datatype: "INTEGER", group: "FMC_Design" });
  const b = OPS.parse([
    { op: "add_shared_param", name: "FMC_Design_Movement", guid: "2222-BBBB", instance: true },
    { op: "add_family_param", name: "Show M7", type: "YesNo" },
    { op: "set_formula", name: "Show M7", formula: "FMC_Design_Movement = 7" },
    { op: "sweep", name: "Track M7", path: [[0, 0], [1000, 0]], profile: [[0, 0], [10, 0], [10, 10]] },
    { op: "set_visible_param", name: "Track M7/Visible", solid: "Track M7", param: "Show M7" },
  ]);
  assert.deepEqual(opsProblems(b, sp), []);
  const bad = OPS.parse([
    { op: "add_family_param", name: "Width", type: "Length" },
    { op: "set_visible_param", name: "Body/Visible", solid: "Body", param: "Width" },
    { op: "set_visible_param", name: "wrong", solid: "Body", param: "In the file" },
  ]);
  const { errors, notes } = splitProblems(opsProblems(bad, dict));
  assert.match(errors.join(" | "), /"Width" is Length: Visible takes a Yes\/No parameter/);
  assert.match(errors.join(" | "), /name must be "Body\/Visible"/);
  assert.equal(notes.length, 3); // Body twice and "In the file": they may exist in the file
  // A Yes/No kit shared parameter counts as Yes/No.
  const yn = new Map(dict).set("FMC_Prefabricated", { name: "FMC_Prefabricated", guid: "3333", datatype: "YESNO", group: "x" });
  const b2 = OPS.parse([{ op: "add_shared_param", name: "FMC_Prefabricated", guid: "3333" },
    { op: "extrusion", name: "Box", points: [[0, 0], [1, 0], [1, 1]] }, { op: "set_visible_param", name: "Box/Visible", solid: "Box", param: "FMC_Prefabricated" }]);
  assert.deepEqual(opsProblems(b2, yn), []);
});

test("add_material: only materials in the kit's library, and a Material parameter", () => {
  const materials = parseMaterialDb({ version: "1", materials: [{ name: "FMC_Timber_Mvule", class: "Timber" }] });
  const b = OPS.parse([
    { op: "add_family_param", name: "Frame Material", type: "Material", group: "Materials" },
    { op: "add_material", name: "FMC_Timber_Mvule", param: "Frame Material" },
  ]);
  assert.deepEqual(opsProblems(b, dict, undefined, materials), []);
  assert.deepEqual(opsProblems(b, dict), []); // no kit (tests): the name isn't checked
  const unknown = OPS.parse([{ op: "add_material", name: "FMC_Timber_Teak" }]);
  assert.match(opsProblems(unknown, dict, undefined, materials)[0], /isn't in the kit's material library \(07_Materials\\FMC_Materials\.json\)/);
  assert.match(opsProblems(unknown, dict, undefined, null)[0], /isn't readable/);
  const wrongType = OPS.parse([{ op: "add_family_param", name: "Width", type: "Length" }, { op: "add_material", name: "FMC_Timber_Mvule", param: "Width" }]);
  assert.match(opsProblems(wrongType, dict, undefined, materials).join(), /"Width" is Length: add_material sets a Material parameter/);
});

// ---- parametric sweep paths (path_planes) and relative family paths ---------------------------------------------------

const opening = [
  { op: "add_ref_plane", name: "Wall Centre", from: [-2000, 0], to: [2000, 0] },
  { op: "add_ref_plane", name: "Trim Face Ext", from: [-2000, -130], to: [2000, -130] },
  { op: "add_family_param", name: "Frame Inset", type: "Length" },
  { op: "add_family_param", name: "Show_Greek", type: "YesNo" },
  { op: "load_family", name: "FMC_Profile_Architrave_Greek", path: "_Profiles\\FMC_Profile_Architrave_Greek.rfa" },
];

test("path_planes: a trim on Left, Right, Head and Sill passes; it needs no fixed path; offsets by mm or a Length parameter", () => {
  const b = OPS.parse([...opening,
    { op: "sweep", name: "Surround Greek Ext", path_planes: [["Left", "Sill"], ["Left", "Head"], ["Right", "Head"], ["Right", "Sill"]],
      path_host: "Trim Face Ext", path_plane: "front", profile_family: "FMC_Profile_Architrave_Greek", profile_type: "110x22" },
    { op: "sweep", name: "Frame", path_planes: [["Left", "Ref. Level"], ["Left", "Head"], ["Right", "Head"], ["Right", "Ref. Level"]],
      path_offsets: [20, "-Frame Inset", -20], path_host: "Wall Centre", path_plane: "front", profile: [[-20, -50], [20, -50], [20, 50], [-20, 50]] },
  ]);
  const door = ["Left", "Right", "Head", "Sill", "Ref. Level"];
  assert.deepEqual(opsProblems(b, dict, "D:\\Kit\\04_Families", undefined, { templatePlanes: door }), []);
  // Without the template's planes (a bare fmc_doc apply), the template planes are notes, never errors.
  const { errors, notes } = splitProblems(opsProblems(b, dict, "D:\\Kit\\04_Families"));
  assert.deepEqual(errors, []);
  assert.ok(notes.length > 0 && notes.every((n) => /reference plane "(Left|Right|Head|Sill)"/.test(n)), notes.join(" | "));
  assert.deepEqual(runningPlanes([["Left", "Sill"], ["Left", "Head"], ["Right", "Head"], ["Right", "Sill"]]), ["Left", "Head", "Right"]);
});

test("path_planes: bad corners, offsets and unknown planes are refused (no silent fixed geometry)", () => {
  const sweep = (o: object) => ({ op: "sweep", name: "S", path_plane: "front", profile_family: "FMC_Profile_Architrave_Greek", ...o });
  const tpl = { templatePlanes: ["Left", "Right", "Head", "Sill"] };
  const run = (o: object) => splitProblems(opsProblems(OPS.parse([...opening, sweep(o)]), dict, undefined, undefined, tpl)).errors.join(" | ");
  assert.match(run({}), /give path_planes \(corners on named planes\) or path/);
  assert.match(run({ path: [[0, 0], [1, 0]], path_planes: [["Left", "Sill"], ["Left", "Head"]] }), /give path_planes or path, not both/);
  assert.match(run({ path_planes: [["Left", "Left"], ["Left", "Head"]] }), /corner 1 \[Left, Left\] names one plane twice/);
  assert.match(run({ path_planes: [["Left", "Sill"], ["Right", "Head"]] }), /segment 1 from \[Left, Sill\] to \[Right, Head\] doesn't run along one plane/);
  assert.match(run({ path_planes: [["Left", "Sill"], ["Left", "Head"], ["Right", "Head"]], path_offsets: [10] }), /path_offsets has 1 entries for 2 segments/);
  assert.match(run({ path_planes: [["Left", "Sill"], ["Left", "Head"], ["Right", "Head"]], path_offsets: [10, "Show_Greek"] }),
    /segment 2's offset "Show_Greek" is YesNo: an offset takes a Length parameter/);
  assert.match(run({ path_planes: [["Left", "Sill"], ["Left", "Head"], ["Left", "Sill"]], path_offsets: [10, 20] }), /both run along Left with different offsets/);
  assert.match(run({ path_planes: [["Left", "Sill"], ["Left", "Jamb Top"]] }),
    /reference plane "Jamb Top" isn't made earlier in this batch or one of the template's planes \(Left, Right, Head, Sill\)/);
  assert.match(run({ path_planes: [["Left", "Sill"], ["Left", "Head"]], path_host: "Nowhere" }), /reference plane "Nowhere" isn't made earlier/);
  assert.match(run({ path: [[0, 0], [1, 0]], path_host: "Wall Centre" }), /path_offsets and path_host go with path_planes/);
  // The schema keeps corners to two names (arrays with a length, never a tuple) and a path to two corners or more.
  assert.throws(() => OPS.parse([sweep({ path_planes: [["Left"], ["Left", "Head"]] })]));
  assert.throws(() => OPS.parse([sweep({ path_planes: [["Left", "Sill"]] })]));
});

test("load_family: a path relative to the family roots passes and resolves on this PC; an absolute path outside them names the fix", () => {
  const ok = OPS.parse([{ op: "load_family", name: "P", path: "_Profiles\\P.rfa" }, { op: "load_family", name: "Q", path: "D:\\Kit\\04_Families\\_Staging\\_Profiles\\Q.rfa" },
    { op: "load_family", name: "R", path: "E:\\Lib\\_Chain\\R.rfa" }]);
  assert.deepEqual(opsProblems(ok, dict, "D:\\Kit\\04_Families", undefined, { libraryRoots: ["E:\\Lib"] }), []);
  const bad = OPS.parse([{ op: "load_family", name: "Z", path: "Z:\\00_Standards\\04_Families\\_Staging\\_Profiles\\FMC_Profile_Architrave_Greek.rfa" },
    { op: "load_family", name: "U", path: "..\\..\\Users\\x.rfa" }]);
  const e = opsProblems(bad, dict, "D:\\Kit\\04_Families").join(" | ");
  assert.match(e, /isn't inside the kit's families folder \(D:\\Kit\\04_Families\)\. Write it relative to the family staging root, e\.g\. _Profiles\\FMC_Profile_Architrave_Greek\.rfa/);
  assert.match(e, /climbs out of its folder/);

  const roots = familyRoots("D:\\Kit\\04_Families\\_Staging\\", ["D:\\Kit\\04_Families\\_ChainTests", "Z:\\Projects\\*\\01_WIP"]);
  assert.deepEqual(roots, ["D:\\Kit\\04_Families\\_Staging", "D:\\Kit\\04_Families", "D:\\Kit\\04_Families\\_ChainTests"]);
  const on = new Set(["D:\\Kit\\04_Families\\_Profiles\\P.rfa"]);
  assert.deepEqual(resolveFamilyPath("_Profiles\\P.rfa", roots, (f) => on.has(f)), { path: "D:\\Kit\\04_Families\\_Profiles\\P.rfa", found: true, root: "D:\\Kit\\04_Families" });
  assert.equal(resolveFamilyPath("_Profiles/Q.rfa", roots, () => false).path, "D:\\Kit\\04_Families\\_Staging\\_Profiles\\Q.rfa");
  const r = resolveFamilyPaths(OPS.parse([{ op: "load_family", name: "Q", path: "_Profiles\\Q.rfa" }, { op: "add_type", name: "T" }]), roots, () => false);
  assert.equal((r.ops[0] as { path?: string }).path, "D:\\Kit\\04_Families\\_Staging\\_Profiles\\Q.rfa");
  assert.match(r.notes[0], /load_family Q: D:\\Kit\\04_Families\\_Staging\\_Profiles\\Q\.rfa isn't on this PC \(looked in .*\): build the profile first/);
});

test("array: copies by default, tied to an Integer count; linear takes exactly one way to space", () => {
  const b = OPS.parse([
    { op: "add_family_param", name: "Blade Count", type: "Integer" },
    { op: "extrusion", name: "Blade", points: [[0, 0], [600, 0], [600, 20]], start: 100, end: 110 },
    { op: "array", name: "Blades", solid: "Blade", direction: "z", count_param: "Blade Count", spacing_mm: 80 },
    { op: "set_subcategory", name: "Blade #3", subcategory: "Frame" },
  ]);
  const { errors, notes } = splitProblems(opsProblems(b, dict));
  assert.deepEqual(errors, []);
  assert.equal(notes.length, 1); // the Frame subcategory; "Blade #3" is a copy the array makes
  const a = b.find((o) => o.op === "array") as any;
  assert.equal(a.mode, "copies");
  assert.equal(a.max, 12);
  const bad = OPS.parse([
    { op: "add_family_param", name: "Gap", type: "Length" },
    { op: "array", name: "A", solid: "S", direction: "x", count_param: "Gap", spacing_param: "Gap" },
    { op: "array", name: "B", solid: "S", direction: "x", count_param: "N", mode: "linear", spacing_mm: 50, between: ["P1", "P2"] },
    { op: "array", name: "C", solid: "C", direction: "y", count_param: "N", spacing_mm: 0 },
  ]);
  const all = splitProblems(opsProblems(bad, dict)).errors.join(" | ");
  assert.match(all, /"Gap" is Length, not Integer/);
  assert.match(all, /copies need spacing_mm/);
  assert.match(all, /spacing_param needs mode "linear"/);
  assert.match(all, /linear takes exactly one of spacing_mm, spacing_param or between/);
  assert.match(all, /spacing_mm can't be 0/);
  assert.match(all, /its own name, not the solid's/);
  assert.throws(() => OPS.parse([{ op: "array", name: "A", solid: "S", direction: "w", count_param: "N" }]));
  assert.throws(() => OPS.parse([{ op: "array", name: "A", solid: "S", direction: "x", count_param: "N", max: 51 }]));
});

test("symbolic_lines: the fixed form still works; plane ends, a labelled radius and per-leaf repeats are checked", () => {
  const fixed = OPS.parse([{ op: "add_subcategory", name: "Plan Swing" },
    { op: "symbolic_lines", name: "Swing", points: [[0, 0], [0, 900]], arc: { center: [0, 0], radius: 900, start_deg: 0, end_deg: 90 }, subcategory: "Plan Swing" }]);
  assert.deepEqual(opsProblems(fixed, dict), []);
  const leaves = OPS.parse([
    { op: "add_subcategory", name: "Plan Swing" },
    { op: "add_family_param", name: "Leaf Count", type: "Integer" },
    { op: "add_family_param", name: "Leaf Width", type: "Length" },
    { op: "add_ref_plane", name: "Leaf 1 Free", from: [0, -1000], to: [0, 1000] },
    { op: "add_ref_plane", name: "Leaf 2 Free", from: [450, -1000], to: [450, 1000] },
    { op: "add_ref_plane", name: "Swing", from: [-1000, 500], to: [1000, 500] },
    { op: "add_ref_plane", name: "Face", from: [-1000, 0], to: [1000, 0] },
    { op: "symbolic_lines", name: "Fold", subcategory: "Plan Swing", repeat: { count_param: "Leaf Count", max: 2 },
      lines: [{ from: { planes: ["Leaf {k} Free", "Face"] }, to: { planes: ["Leaf {k} Free", "Swing"] } }],
      arc: { center: { planes: ["Leaf {k} Free", "Face"] }, radius: 450, radius_param: "Leaf Width", start_deg: 90, end_deg: 180 } },
  ]);
  assert.deepEqual(opsProblems(leaves, dict), []);
  const bad = OPS.parse([
    { op: "add_family_param", name: "Leaf Count", type: "Length" },
    { op: "symbolic_lines", name: "A", subcategory: "S", repeat: { count_param: "Leaf Count", max: 3 }, lines: [{ from: [0, 0], to: [0, 0] }] },
    { op: "symbolic_lines", name: "B", subcategory: "S", lines: [{ from: { planes: ["P {k}", "Q"] }, to: { planes: ["Q", "P {k}"] } }] },
    { op: "symbolic_lines", name: "C", subcategory: "S", arc: { center: { planes: ["P", "P"] }, radius: 10, start_deg: 0, end_deg: 90 } },
  ]);
  const all = splitProblems(opsProblems(bad, dict)).errors.join(" | ");
  assert.match(all, /a repeat needs \{k\} in a plane name/);
  assert.match(all, /repeat: "Leaf Count" is Length, not Integer/);
  assert.match(all, /line 1 has no length/);
  assert.match(all, /\{k\} in a plane name needs repeat/);
  assert.match(all, /starts and ends on the same two planes/);
  assert.match(all, /names the plane "P" twice/);
  // With a repeat, each leaf's planes are expected: Leaf 3 Free isn't made, so it's a note.
  const three = OPS.parse([{ op: "add_subcategory", name: "S" }, { op: "add_family_param", name: "N", type: "Integer" },
    { op: "add_ref_plane", name: "Leaf 1 Free", from: [0, -1], to: [0, 1] }, { op: "add_ref_plane", name: "Leaf 2 Free", from: [1, -1], to: [1, 1] },
    { op: "symbolic_lines", name: "F", subcategory: "S", repeat: { count_param: "N", max: 3 }, lines: [{ from: { planes: ["Leaf {k} Free", "Center (Front/Back)"] }, to: [5, 5] }] }]);
  assert.deepEqual(splitProblems(opsProblems(three, dict)).notes.map((n) => n.match(/"([^"]+)"/)![1]), ["Leaf 3 Free"]);
});

test("delete_template_element: by kind, subcategory or name, never everything, never by id", () => {
  const ok = OPS.parse([
    { op: "delete_template_element", name: "Template frame", kind: "solid", subcategory: "Frame/Mullion" },
    { op: "delete_template_element", name: "Swing lines", subcategory: "Plan Swing" },
    { op: "delete_template_element", name: "Old voids", kind: "void" },
  ]);
  assert.deepEqual(opsProblems(ok, dict), []);
  assert.equal((ok[0] as any).max, 10);
  const all = OPS.parse([{ op: "delete_template_element", name: "Everything", category: "Doors" }]);
  assert.match(splitProblems(opsProblems(all, dict)).errors[0], /say what goes/);
  assert.throws(() => OPS.parse([{ op: "delete_template_element", name: "X", kind: "by_id" }]));
  assert.equal("element_id" in OPS.parse([{ op: "delete_template_element", name: "X", kind: "solid", element_id: 1234 }])[0], false);
});

test("set_default_size: Length values before planes; a plane drawn first in a sized batch is a warning (F-026)", () => {
  const good = OPS.parse([
    { op: "set_default_size", name: "Default size", type: "0900x2100", values: { Width: 900, Height: 2100 } },
    { op: "add_ref_plane", name: "Head Inner", from: [-500, 2060], to: [500, 2060], view: "Front" },
    { op: "add_dimension", name: "Height", between: ["Ref. Level", "Head Inner"], label: "Height", view: "Front" },
  ]);
  assert.deepEqual(opsProblems(good, dict), []);
  const late = OPS.parse([
    { op: "add_ref_plane", name: "Head Inner", from: [-500, 2060], to: [500, 2060], view: "Front" },
    { op: "set_default_size", name: "Default size", values: { Width: 900, Height: 2100 } },
    { op: "set_type_value", name: "T/Height", type: "T", param: "Height", value: 2400 },
  ]);
  const { errors, notes } = splitProblems(opsProblems(late, dict));
  assert.deepEqual(errors, []);
  assert.match(notes.join(), /op 1 \(add_ref_plane Head Inner\): warning: \(F-026\) this plane is drawn before set_default_size \(op 2\)/);
  const wrong = OPS.parse([{ op: "add_family_param", name: "Leaf Count", type: "Integer" },
    { op: "set_default_size", name: "S", values: { "Leaf Count": 2, "Frame Depth": 100 } }]);
  const p = splitProblems(opsProblems(wrong, dict));
  assert.match(p.errors.join(), /"Leaf Count" is Integer: set_default_size sets Length parameters/);
  assert.match(p.notes.join(), /parameter "Frame Depth"/);
  assert.throws(() => OPS.parse([{ op: "set_default_size", name: "S", values: { Width: -5 } }]));
});

test("load_family: released or staged families, shared nested hardware flagged", () => {
  const b = OPS.parse([
    { op: "add_family_param", name: "Hardware Material", type: "Material" },
    { op: "load_family", name: "FMC_A_Hardware_Lever", path: "D:\\Kit\\04_Families\\A\\FMC_A_Hardware_Lever.rfa", shared: true },
    { op: "load_family", name: "FMC_A_Hardware_Hinge", path: "D:\\Kit\\04_Families\\_Staging\\A\\FMC_A_Hardware_Hinge.rfa", shared: true },
    { op: "place_nested", name: "Lever", family: "FMC_A_Hardware_Lever", type: "Standard", params: { "Hardware Material": "Hardware Material" } },
  ]);
  assert.deepEqual(opsProblems(b, dict, "D:\\Kit\\04_Families"), []);
  assert.equal((b[1] as any).shared, true);
});

test("set_type_image takes a png or jpg inside the kit's families folder", () => {
  const ok = OPS.parse([{ op: "add_type", name: "60_O2" }, { op: "set_type_image", name: "Type image", path: "D:\\Kit\\04_Families\\_Staging\\P\\_Images\\FMC_P_X.png", type: "60_O2" }]);
  assert.deepEqual(splitProblems(opsProblems(ok, dict, "D:\\Kit\\04_Families")).errors, []);
  const bad = OPS.parse([{ op: "set_type_image", name: "Type image", path: "C:\\Users\\Someone\\Downloads\\x.gif" }]);
  const all = splitProblems(opsProblems(bad, dict, "D:\\Kit\\04_Families")).errors.join(" | ");
  assert.match(all, /takes a \.png or \.jpg/);
  assert.match(all, /isn't inside the kit's families folder/);
});
