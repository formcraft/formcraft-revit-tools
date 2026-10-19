import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { KitElectrical, SIZING_KEYS, circuitsPayload } from "./circuits.js";
import { WRITE_COMMANDS } from "./policy.js";
import { FMC_SYSTEMS_SHAPE } from "../tools/fmc_systems.js";
import { substitute } from "./testrun.js";

// The kit's Electrical_Settings as templatekit.electrical reads it (values as in FMC_Revit_Kit.xlsx, 19 Oct)
const kit: KitElectrical = {
  voltages: [{ name: "240 V", value: 240, min: 216, max: 264 }, { name: "415 V", value: 415, min: 374, max: 457 }],
  systems: [{ name: "DS_415-240V_3Ph_4W", phase: "Three", config: "Wye", wires: 4, ll: "415 V", lg: "240 V" },
    { name: "DS_240V_1Ph_2W", phase: "Single", config: "Undefined", wires: 2, ll: null, lg: "240 V" },
    { name: "DS_BAD", phase: "Three", config: "Wye", wires: 4, ll: "11 kV", lg: null }],
  loads: ["Lighting", "Power", "Other"],
};
const req = (over: Record<string, unknown> = {}) => ({ board: "uid-db", board_name: "DB-L0-01", distribution_system: "DS_415-240V_3Ph_4W",
  circuits: [{ elements: ["uid-s1", "uid-s2"], load_name: "Sockets" }, { elements: ["uid-l1"], load_name: "Lighting" }], dry_run: true, ...over });

test("MEP test model: create_circuits sends the board, the circuits and the kit's distribution system with only the voltages it names", () => {
  const { problems, payload } = circuitsPayload(req(), kit);
  assert.deepEqual(problems, []);
  assert.equal(payload!.board, "uid-db");
  assert.equal(payload!.dry_run, true);
  assert.deepEqual((payload!.distribution_system as any).name, "DS_415-240V_3Ph_4W");
  assert.deepEqual((payload!.voltages as any[]).map((v) => v.name).sort(), ["240 V", "415 V"]);
  assert.deepEqual((payload!.circuits as any[]).map((c) => c.elements.length), [2, 1]);
  // no distribution system named: the board's own stands, and the kit isn't needed
  const own = circuitsPayload(req({ distribution_system: "" }), null);
  assert.deepEqual(own.problems, []);
  assert.equal(own.payload!.distribution_system, undefined);
});

test("MEP test model: create_circuits never sizes (rule 5): no rating, wire size, demand factor or load in what it sends", () => {
  const { payload } = circuitsPayload(req({ circuits: [{ elements: ["a"], load_name: "x", rating: 32, wire_size: "2.5" } as any] }), kit);
  const text = JSON.stringify(payload);
  for (const k of SIZING_KEYS) assert.ok(!text.includes(`"${k}"`), `${k} must never be sent`);
  assert.ok(!("demand_factor" in (payload!.distribution_system as object)));
});

test("MEP test model: create_circuits refuses a missing board, no circuits, a device on two circuits and a system not in the kit", () => {
  const p = (over: Record<string, unknown>, k: KitElectrical | null = kit) => circuitsPayload(req(over), k).problems.join(" | ");
  assert.match(p({ board: " " }), /Name the board/);
  assert.match(p({ circuits: [] }), /at least one circuit/);
  assert.match(p({ circuits: [{ elements: ["a", "b"] }, { elements: ["b"] }] }), /b is on circuit 1 and circuit 2/);
  assert.match(p({ distribution_system: "DS_480V" }), /DS_480V isn't a distribution system in the kit's Electrical_Settings \(it has DS_415-240V_3Ph_4W/);
  assert.match(p({ distribution_system: "DS_BAD" }), /names voltage 11 kV/);
  assert.match(p({}, null), /Electrical_Settings isn't readable/);
  assert.equal(circuitsPayload(req({ board: "" }), kit).payload, undefined, "nothing is sent when anything is wrong");
});

test("MEP test model: fmc_circuits_create is a write (behind the live-model lock); the tool takes the arguments the scenario passes", () => {
  assert.ok(WRITE_COMMANDS.has("fmc_circuits_create"));
  const shape = z.object(FMC_SYSTEMS_SHAPE);
  const ok = shape.safeParse({ action: "create_circuits", board: "x", circuits: [{ elements: ["a"] }], distribution_system: "DS_415-240V_3Ph_4W", dry_run: false });
  assert.ok(ok.success);
  assert.equal(ok.success && ok.data.dry_run, false);
  assert.equal(shape.parse({ action: "create_circuits" }).dry_run, true, "a dry run by default");
  assert.equal(shape.safeParse({ action: "create_circuits", circuits: [{ elements: [] }] }).success, false, "a circuit holds a device");
});

test("MEP test model: a scenario placeholder picks a room build's element by its key", () => {
  const vars = { steps: { record: { elements: [{ key: "wall:north", unique_id: "w1" }, { key: "item:DB", unique_id: "db-1" }, { key: "item:S1", unique_id: "s-1" }] } } };
  assert.equal(substitute("{{steps.record.elements[key=item:DB].unique_id}}", vars), "db-1");
  assert.deepEqual(substitute({ elements: ["{{steps.record.elements[key=item:S1].unique_id}}"] }, vars), { elements: ["s-1"] });
  assert.equal(substitute("board {{steps.record.elements[key^=item:D].unique_id}}", vars), "board db-1");
  assert.throws(() => substitute("{{steps.record.elements[key=item:NONE].unique_id}}", vars), /Unresolved/);
});
