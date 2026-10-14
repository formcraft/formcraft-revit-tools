import { test } from "node:test";
import assert from "node:assert/strict";
import { electricalChecks, structuralChecks, structuralFields, systemsReport } from "./systems.js";

test("structural fields are the kit's: a name the kit lacks is reported, not checked", () => {
  const kit = { FMC_Member_Mark: { categories: ["OST_StructuralColumns", "OST_StructuralFraming", "OST_StructuralFoundation"] },
    FMC_Concrete_Grade: { categories: ["OST_StructuralFoundation", "OST_StructuralColumns", "OST_Floors", "OST_Walls"] } };
  const { fields, not_in_kit } = structuralFields(kit);
  assert.deepEqual(fields.map((f) => f.name), ["FMC_Member_Mark", "FMC_Concrete_Grade"]);
  assert.deepEqual(fields[1].categories, ["OST_StructuralFoundation", "OST_StructuralColumns"]);
  assert.deepEqual(not_in_kit, ["FMC_Exposure_Class", "FMC_Steel_Grade", "FMC_Timber_Grade"]);
});

test("the structural check: nothing below fails, analytical problems warn, load cases are the engineer's", () => {
  const checks = structuralChecks({ no_analytical_count: 2, no_analytical: [1, 2], offset_count: 0, free_end_count: 3, free_ends: [4, 5, 6], free_ends_checked: true,
    nothing_below_count: 1, nothing_below: [7], load_cases: 0,
    fields: [{ name: "FMC_Concrete_Grade", applies: 12, missing: 12, ids: [8], in_model: true }, { name: "FMC_Steel_Grade", applies: 0, missing: 0, in_model: false },
      { name: "FMC_Member_Mark", applies: 20, missing: 20, in_model: false }] });
  const by = Object.fromEntries(checks.map((c) => [c.check, c]));
  assert.equal(by["Columns and beams without an analytical member"].state, "Warn");
  assert.equal(by["Physical and analytical out by more than 50 mm"].state, "Pass");
  assert.equal(by["Members not joined at nodes"].found, "3");
  assert.equal(by["Columns with nothing below (footing, beam, slab, wall or column)"].state, "Fail");
  assert.equal(by["Members missing FMC_Concrete_Grade"].found, "12");
  assert.equal(by["FMC_Member_Mark not loaded in this model"].state, "Warn");
  assert.ok(!checks.some((c) => c.check.includes("FMC_Steel_Grade")));
  assert.equal(by["Load cases and combinations"].state, "Engineer");
  assert.equal(by["Load cases and combinations"].found, "None yet");
});

test("electrical: boards with no circuits warn, one unfed board is the main board, loose devices warn", () => {
  const { boards, checks } = electricalChecks({ boards: [
    { id: 1, name: "MDB", circuits: 4, fed_by: "" }, { id: 2, name: "DB-L1", circuits: 0, fed_by: "MDB / 3" }],
    devices: { ElectricalFixtures: { with_power_connector: 40, on_no_circuit: 6 }, LightingFixtures: { with_power_connector: 12, on_no_circuit: 0 } }, circuits_without_board: 1 });
  assert.equal(boards[0].note, "Fed by no other board (the main board?)");
  assert.equal(boards[1].check, "Warn");
  const by = Object.fromEntries(checks.map((c) => [c.check, c]));
  assert.equal(by["Boards fed by no other board"].state, "Info");
  assert.equal(by["Electrical Fixtures on no circuit"].found, "6 of 40");
  assert.equal(by["Lighting Fixtures on no circuit"].state, "Pass");
  assert.equal(by["Circuits on no board"].state, "Warn");
});

test("the saved list says it was read-only and leaves design to the engineer", () => {
  const md = systemsReport("structural", "F26001-S", [{ check: "X", found: "1", state: "Fail", ids: [] }], ["- B-1-07 (230x450): utilisation 1.12"], new Date("2026-10-14T10:00:00Z"));
  assert.match(md, /read-only, nothing was changed/);
  assert.match(md, /\| X \| 1 \| Fail \|/);
  assert.match(md, /engineer's decision/);
});
