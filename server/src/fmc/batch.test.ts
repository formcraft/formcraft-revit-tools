import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPS, opsProblems, splitProblems } from "./ops.js";
import { SpParam } from "./specs.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "..", "..", "tests", "doc", "FMC_P_MechEq_WaterHeater_Instant.ops.json");

test("B1d acceptance batch: 20+ ops for the instant water heater validate", () => {
  const batch = JSON.parse(fs.readFileSync(file, "utf8"));
  const ops = OPS.parse(batch.ops);
  assert.ok(ops.length >= 20, `${ops.length} ops`);
  // CI has no kit: the dictionary is the batch's own shared parameters (the server checks the real one at run time).
  const dict = new Map<string, SpParam>(ops.filter((o) => o.op === "add_shared_param")
    .map((o: any) => [o.name, { name: o.name, guid: o.guid, datatype: "TEXT", group: "x" }]));
  const { errors, notes } = splitProblems(opsProblems(ops, dict));
  assert.deepEqual(errors, []);
  assert.deepEqual(notes, []);
  assert.deepEqual(ops.filter((o) => o.op === "add_connector").map((o) => o.name), ["DCW", "DHW", "Power"]);
});

test("profile sample batch: a closed profile loop with one arc validates", () => {
  const batch = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "FMC_Profile_Sample.ops.json"), "utf8"));
  assert.equal(batch.template, "Metric Profile.rft");
  const ops = OPS.parse(batch.ops);
  const { errors, notes } = splitProblems(opsProblems(ops, new Map()));
  assert.deepEqual(errors, []);
  assert.deepEqual(notes, []);
  const loop = ops.find((o) => o.op === "profile_lines") as any;
  assert.equal(loop.segments.filter((s: any) => s.through).length, 1);
});
