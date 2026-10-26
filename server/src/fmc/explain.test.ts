import { test } from "node:test";
import assert from "node:assert/strict";
import { elementNames, explain, namesWanted } from "./explain.js";
import { batchSize } from "./aiuse.js";

const names = {
  types: { "101": "Window: 1200 x 1500", "202": "Basic Wall: Brick 230" },
  elements: elementNames([{ id: 15, category: "Rooms", name: "F15 Bedroom", level: "Level 1" }, { id: 77, category: "Roofs", type: "Generic 225", level: "Level 2" }]),
};

test("Approval details (owner 26 Oct): a person sees what approving lets AI do, by name", () => {
  const win = explain("create_point_based_element", { data: [{ typeId: 101 }, { typeId: 101 }, { typeId: 101, baseOffset: 900 }] }, names);
  assert.deepEqual(win, ["New doors / windows / components:", "2 × Window: 1200 x 1500", "Window: 1200 x 1500, sill 900 mm"]);

  const edit = explain("fmc_model_edit", { why: "Remove the replayed rooms", ops: [
    { op: "delete", ids: [15, 15] },
    { op: "create_roof", level: "Level 2", slopes_deg: [30, null, 30, null], outline_mm: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    { op: "attach", ids: [9], target: "$2", side: "top" },
    { op: "set_param", ids: [77], param: "Thickness", value_mm: 200, on_type: true },
  ] }, names);
  assert.equal(edit[0], "Why: Remove the replayed rooms");
  assert.match(edit[1], /^1\. DELETE 2 elements/);
  assert.equal(edit[2], "   2 × Rooms: F15 Bedroom (Level 1)");
  assert.match(edit[3], /Roof on Level 2.*4 edges, slopes 30°, end, 30°, end/);
  assert.match(edit[4], /Attach the top of 1 walls to what op 2 makes/);
  assert.match(edit.join("\n"), /ON THEIR TYPE/);
  assert.equal(edit.at(-1), "All or nothing; one Undo takes it all back.");

  const more = explain("fmc_model_edit", { ops: [{ op: "mirror", ids: [15], line_mm: [[0, 0], [0, 1000]] }, { op: "copy", ids: [15], vector_mm: [3000, 0, 0], count: 4 }] }, names);
  assert.match(more[0], /^1\. Mirror 1 elements about \(0, 0\) → \(0, 1000\) \(as copies\)/);
  assert.match(more[2], /^2\. Copy 1 elements 4 times, by 3000, 0, 0 mm/);
  assert.deepEqual(explain("fmc_post_command", { command: "RoofByExtrusion" }), ["Starts Revit's RoofByExtrusion command, as if clicked on the ribbon"]);

  const views = explain("fmc_model_edit", { ops: [{ op: "create_view", kind: "floor_plan", name: "FF Plan", level: "FF +3.40", scale: 50 },
    { op: "create_sheet", number: "A-101", name: "First floor" }, { op: "place_view", sheet: "$2", view: "$1" }] });
  assert.deepEqual(views.slice(0, 3), ['1. New floor plan "FF Plan" on FF +3.40, 1:50', "2. New sheet A-101 First floor", "3. Place $1 on sheet $2"]);

  const notes = explain("fmc_model_edit", { ops: [{ op: "tag", view: "FF Plan", ids: [15], tag_type: "Keynote Tag" }, { op: "text", view: "FF Plan", point_mm: [0, 0], text: "Void over" }] }, names);
  assert.deepEqual(notes.slice(0, 3), ["1. Tag 1 elements in FF Plan with Keynote Tag:", "   Rooms: F15 Bedroom (Level 1)", '2. Text in FF Plan: "Void over"']);

  const code = explain("send_code_to_revit", { code: "var w = doc.GetElement(id);\n\nw.Pinned = false;" });
  assert.deepEqual(code, ["Runs Revit API code (2 lines, in one transaction):", "   var w = doc.GetElement(id);", "   w.Pinned = false;"]);
  assert.ok(explain("delete_element", { elementIds: Array.from({ length: 40 }, (_, i) => i) }).length <= 14, "long lists are capped");
});

test("Names asked of Revit, and modify_model's batch size counts every element an op names", () => {
  const w = namesWanted({ ops: [{ op: "delete", ids: [1, 2, "$1"] }, { op: "attach", ids: [3], target: 4 }, { op: "change_type", ids: [5], type_id: 9 }] });
  assert.deepEqual(w, { typeIds: [9], elementIds: ["1", "2", "3", "4", "5"] });
  assert.equal(batchSize({ ops: [{ op: "delete", ids: Array.from({ length: 98 }, (_, i) => i) }, { op: "create_roof" }] }), 99);
});
