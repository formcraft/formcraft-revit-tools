import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SCHEDULE_SET, scheduleProblems } from "./schedules.js";

const kit = {
  FMC_Zone: { binding: "Instance", categories: ["OST_Doors", "OST_LightingFixtures"] },
  FMC_Procurement_Status: { binding: "Instance", categories: ["OST_Doors", "OST_LightingFixtures"] },
  FMC_Construction_Status: { binding: "Instance", categories: ["OST_Doors", "OST_LightingFixtures"] },
  FMC_Department: { binding: "Instance", categories: ["OST_Rooms"] },
  FMC_Target_Area: { binding: "Instance", categories: ["OST_Rooms"] },
  FMC_Finish_Set: { binding: "Instance", categories: ["OST_Rooms"] },
};

test("F60: the sample schedule set reads and passes its checks", () => {
  const set = SCHEDULE_SET.parse(JSON.parse(fs.readFileSync(new URL("../../../tests/schedules/FMC_Schedules_sample.json", import.meta.url), "utf8")));
  assert.equal(set.schedules.length, 3);
  assert.deepEqual(scheduleProblems(set, kit), { problems: [], warnings: [] });
  assert.equal(set.schedules[0].fields[0].hidden, false, "defaults filled in");
});

test("F60: an FMC_ field the kit lacks, a filter off the fields, a missing value and a repeated name are problems", () => {
  const set = SCHEDULE_SET.parse({ schema: "fmc-schedules/0.1", name: "x", schedules: [
    { name: "S1", discipline: "A", category: "OST_Doors", fields: [{ name: "Mark" }, { name: "FMC_Invented" }],
      filters: [{ field: "Level", op: "equals", value: "L1" }, { field: "Mark", op: "contains" }] },
    { name: "S1", discipline: "A", category: "OST_Rooms", fields: [{ name: "FMC_Zone" }], grand_totals: true },
  ] });
  const r = scheduleProblems(set, kit);
  assert.deepEqual(r.problems, [
    "S1: FMC_Invented isn't a kit parameter (a kit change request, rule 7)",
    "S1: Level is filtered or sorted on, and isn't one of its fields (add it, hidden if need be)",
    "S1: the filter on Mark (contains) needs a value",
    "The schedule name S1 is used twice",
  ]);
  assert.match(r.warnings.join(), /FMC_Zone isn't bound to OST_Rooms/);
  assert.match(r.warnings.join(), /grand totals on, and no field has a total/);
});
