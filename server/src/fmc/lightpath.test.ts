import { test } from "node:test";
import assert from "node:assert/strict";
import { LIGHT_PATHS, lightPathOps } from "./lightpath.js";
import { OP } from "./ops.js";

const light = [
  { op: "add_family_param", name: "Second Light Head", type: "YesNo", group: "Constraints" },
  { op: "revolution", name: "Lens Main", axis_at: [900, 0], profile: [[0, 1052], [328, 1052], [328, 1060], [0, 1060]] },
  { op: "revolution", name: "Lens Satellite", axis_at: [-850, 0], profile: [[0, 1002], [278, 1002], [278, 1010], [0, 1010]] },
  { op: "add_type", name: "700_Single" },
];

test("lighting families show their light path: a beam from each lens to the light field, on its own switch and subcategory", () => {
  const r = lightPathOps(light, LIGHT_PATHS.FMC_E_LightFixture_OperatingLight_Ceiling_Detailed);
  const beam = r.ops.find((o) => o.op === "revolution" && o.name === "Lens Main Light Path")!;
  assert.deepEqual(beam.axis_at, [900, 0], "on the lens's own axis");
  assert.deepEqual(beam.profile, [[0, 1060], [328, 1060], [125, 2060], [0, 2060]], "from the lens face to a 250 mm field 1 m away");
  assert.ok(r.ops.some((o) => o.op === "set_subcategory" && o.name === "Lens Main Light Path" && o.subcategory === "Light Path"));
  assert.equal(r.ops.find((o) => o.op === "set_visible_param" && o.solid === "Lens Main Light Path")!.param, "Show Light Path");
  assert.equal(r.ops.find((o) => o.op === "set_formula" && o.name === "Show Light Path Second Light Head")!.formula, "and(Show Light Path, Second Light Head)",
    "the satellite's beam only with the second head");
  assert.ok(r.ops.some((o) => o.op === "set_type_value" && o.param === "Show Light Path" && o.value === true), "shown by default");
  assert.equal(r.values["Light Path Distance"].source_status, "assumed", "rule 5: an engineer confirms the distance and field");
  for (const o of r.ops) assert.equal(OP.safeParse(o).success, true, JSON.stringify(o).slice(0, 80));
  assert.deepEqual(lightPathOps([...light, ...r.ops], LIGHT_PATHS.FMC_E_LightFixture_OperatingLight_Ceiling_Detailed).ops, [], "never added twice");
});
