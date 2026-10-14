import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPayload, kitParams, parseCis, planBrief } from "./brief.js";

const params = kitParams({ params: {
  FMC_Project_Code: { binding: "Project Information", categories: ["OST_ProjectInformation"] },
  FMC_Plot_No: { binding: "Project Information", categories: ["OST_ProjectInformation"] },
  FMC_District: { binding: "Project Information", categories: ["OST_ProjectInformation"] },
  FMC_Target_Area: { binding: "Instance", categories: ["OST_Rooms"] },
  FMC_Finish_Set: { binding: "Instance", categories: ["OST_Rooms"] },
  FMC_Fire_Rating: { binding: "Type", categories: ["OST_Doors"] },
} });
const cis = (o: object) => JSON.stringify({ schema: "fmc-cis/0.1", project: "F26001", revision: "R4", approved: "2026-10-13",
  levels: [{ name: "00 Ground", elevation_mm: 0 }, { name: "01 First", elevation_mm: 3300 }],
  project_info: { FMC_Project_Code: "F26001", FMC_Plot_No: "112", FMC_District: "" },
  rooms: [{ number: "G01", name: "Genkan", params: { FMC_Target_Area: 9, FMC_Finish_Set: "FS-01" } }],
  materials: ["FMC_Concrete_Cast"], families: ["FMC_A_Door_Single", "FMC_A_Window_Casement"], ...o });
const kitFamilies = ["K\\04_Families\\A\\FMC_A_Door_Single.rfa", "K\\04_Families\\_Staging\\A\\FMC_A_Window_Casement.rfa"];

test("a good CIS plans levels, kit-checked values, rooms and approved families; blanks stay blank", () => {
  const { cis: c, problems } = parseCis(cis({}));
  assert.deepEqual(problems, []);
  const plan = planBrief(c!, params, kitFamilies);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.project_info.map((p) => p.name), ["FMC_Project_Code", "FMC_Plot_No"]);
  assert.deepEqual(plan.blanks, ["FMC_District"]);
  assert.deepEqual(plan.families.map((f) => f.name), ["FMC_A_Door_Single"]);
  assert.match(plan.skipped.join(" "), /FMC_A_Window_Casement: not approved/);
  assert.match(plan.skipped.join(" "), /no materials library/);
  const payload = applyPayload(plan, true);
  assert.deepEqual(payload.project_info, { FMC_Project_Code: "F26001", FMC_Plot_No: "112" });
  assert.deepEqual(payload.rooms[0].params, { FMC_Target_Area: "9", FMC_Finish_Set: "FS-01" });
});

test("parameters the kit doesn't have, or binds elsewhere, stop the run", () => {
  const { cis: c } = parseCis(cis({ project_info: { FMC_Client_Mood: "happy", FMC_Fire_Rating: "60" },
    rooms: [{ number: "G01", name: "Genkan", params: { FMC_Project_Code: "x" } }] }));
  const plan = planBrief(c!, params, []);
  assert.equal(plan.problems.length, 3);
  assert.match(plan.problems[0], /FMC_Client_Mood isn't a kit parameter/);
  assert.match(plan.problems[1], /Type parameter in the kit/);
  assert.match(plan.problems[2], /isn't bound to Rooms/);
});

test("a CIS that can't be read is refused, never guessed", () => {
  assert.match(parseCis("{half").problems[0], /Not JSON/);
  const bad = parseCis(cis({ schema: "other", levels: [{ name: "L1", elevation_mm: "x" }, { name: "l1", elevation_mm: 0 }],
    rooms: [{ number: "G01", name: "A" }, { number: "G01", name: "B" }, { name: "C" }] })).problems;
  assert.ok(bad.some((p) => /schema must be/.test(p)));
  assert.ok(bad.some((p) => /elevation_mm is not a number/.test(p)));
  assert.ok(bad.some((p) => /Level names repeat: l1/.test(p)));
  assert.ok(bad.some((p) => /Room numbers repeat: G01/.test(p)));
  assert.ok(bad.some((p) => /rooms\[2\]: number and name/.test(p)));
});
