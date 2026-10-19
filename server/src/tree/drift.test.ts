import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOM, planRoom } from "./room.js";
import { adoptEdit, findEdits, opKeys, snapshot } from "./drift.js";

const bay = () => ({
  name: "ICU bay", level: "Level 2", origin_mm: [0, 0], width: 4200, depth: 5000, height: 3300,
  walls: { type: "Generic - 200mm", thickness: 200 }, ceiling: { type: "Generic", height: 2900 },
  openings: [{ kind: "door", family: "D", type: "1026x2100_S", wall: "south", along: 900, width: 1026 },
    { kind: "window", family: "W", type: "1200x900", wall: "east", along: 2500, width: 1200, sill: 900 }],
  items: [{ id: "Bed", family: "B", type: "1020x2200", at: { wall: "north", off: 150 }, size: [1020, 2200], clearance: 1200 },
    { id: "Light", family: "L", type: "700", at: { centre: true, dy: 600 }, host: "ceiling" }],
});

test("T3: every op has a key that names what made it, the same on every rebuild", () => {
  const keys = opKeys(planRoom(bay() as any).ops);
  assert.deepEqual(keys, ["wall:north", "wall:east", "wall:south", "wall:west", "door@south:D:1026x2100_S", "window@east:W:1200x900",
    "item:Bed", "item:Light", "ceiling", "room"]);
  assert.deepEqual(opKeys(planRoom(bay() as any).ops), keys);
});

const snaps = () => [
  snapshot("item:Bed", { unique_id: "u-bed", type_name: "1020x2200", point_mm: [2100, 4850, 0], params: { "Elevation from Level": 0, Comments: "x" } }),
  snapshot("door@south:D:1026x2100_S", { unique_id: "u-door", type_name: "1026x2100_S", point_mm: [900, -100, 0] }),
  snapshot("window@east:W:1200x900", { unique_id: "u-win", type_name: "1200x900", point_mm: [4300, 2500, 0], params: { "Sill Height": 900 } }),
  snapshot("wall:north", { unique_id: "u-wn", type_name: "Generic - 200mm", start_mm: [4300, 5100, 0], end_mm: [-100, 5100, 0] }),
  snapshot("item:Light", { unique_id: "u-light", type_name: "700", point_mm: [2100, 3100, 2900] }),
];

test("T3: hand edits are found (moved, retyped, a watched parameter, deleted); untouched elements and kept ones aren't", () => {
  assert.deepEqual(snaps()[0].params, { "Elevation from Level": 0 }, "only the watched parameters are kept");
  const live = new Map<string, any>([
    ["u-bed", { type_name: "1020x2200", point_mm: [2400, 4700.4, 0], params: { "Elevation from Level": 0 } }],
    ["u-door", { type_name: "1126x2100_S", point_mm: [900.3, -100, 0] }],
    ["u-win", { type_name: "1200x900", point_mm: [4300, 2500, 0], params: { "Sill Height": 1000 } }],
    ["u-wn", { type_name: "Generic - 200mm", start_mm: [4300, 5400, 0], end_mm: [-100, 5400, 0] }],
    ["u-light", null],
  ]);
  const e = findEdits(snaps(), live);
  assert.deepEqual(e.map((x) => `${x.key} ${x.kind}`), ["item:Bed moved", "door@south:D:1026x2100_S retyped", "window@east:W:1200x900 param", "wall:north moved", "item:Light deleted"]);
  assert.deepEqual(e[0].delta_mm, [300, -149.6, 0]);
  assert.equal(e[3].adoptable, false, "a moved wall reshapes the room: an override, or the room's inputs");
  assert.ok(e.filter((x) => x.key !== "wall:north").every((x) => x.adoptable));
  assert.deepEqual(findEdits(snaps(), live, new Set(["item:Bed", "wall:north"])).map((x) => x.key).includes("item:Bed"), false, "kept: the person's");
});

test("T3: adopting writes the change into the recipe as a delta; inherited sizes stay inherited", () => {
  const room: any = bay();
  room.width = "${var.width}";
  const sized = ROOM.parse(bay());
  const live = new Map<string, any>([
    ["u-bed", { type_name: "1020x2200", point_mm: [2400, 4700, 0], params: { "Elevation from Level": 0 } }],
    ["u-door", { type_name: "1126x2100_S", point_mm: [1100, -100, 0] }],
    ["u-win", { type_name: "1200x900", point_mm: [4300, 2500, 0], params: { "Sill Height": 1000 } }],
    ["u-wn", { type_name: "Generic - 200mm", start_mm: [4300, 5100, 0], end_mm: [-100, 5100, 0] }],
    ["u-light", null],
  ]);
  const said = findEdits(snaps(), live).map((e) => adoptEdit(room, sized, e));
  const bed = room.items.find((i: any) => i.id === "Bed");
  assert.deepEqual(bed.at, { wall: "north", off: 300, along: 1800 }, "300 east is 300 less along the north wall (seen from inside); 150 further off it");
  assert.equal(room.openings[0].along, 1100, "the door moved 200 along the south wall");
  assert.equal(room.openings[0].type, "1126x2100_S");
  assert.equal(room.openings[1].sill, 1000);
  assert.equal(room.items.some((i: any) => i.id === "Light"), false, "a deleted item adopted is out of the recipe");
  assert.equal(room.width, "${var.width}", "the room's size is still the tree's input");
  assert.equal(said.length, 5);
  assert.deepEqual(planRoom(ROOM.parse({ ...room, width: 4200 })).problems, [], "the adopted recipe still plans");
});

test("T3: what the recipe can't take says so (keep it as an override)", () => {
  const room: any = bay();
  room.items[1].at = { centre: true, dx: "${var.light_dx}", dy: 600 };
  const sized = ROOM.parse(bay());
  const [moved] = findEdits([snaps()[4]], new Map([["u-light", { type_name: "700", point_mm: [2200, 3100, 2900] }]]));
  assert.throws(() => adoptEdit(room, sized, moved), /inherited input/);
  const [wall] = findEdits([snaps()[3]], new Map([["u-wn", { type_name: "Generic - 300mm", start_mm: [4300, 5100, 0], end_mm: [-100, 5100, 0] }]]));
  assert.throws(() => adoptEdit(room, sized, wall), /override/);
});
