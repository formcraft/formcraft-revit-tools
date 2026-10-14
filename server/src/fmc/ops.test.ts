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
