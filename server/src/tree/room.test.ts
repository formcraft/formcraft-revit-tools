import { test } from "node:test";
import assert from "node:assert/strict";
import { planRoom } from "./room.js";

const bay = (over: any = {}) => ({
  name: "ICU bay", level: "Level 2", origin_mm: [0, 0], width: 4200, depth: 5000, height: 3300,
  walls: { type: "Generic - 200mm", thickness: 200 }, ceiling: { type: "Generic", height: 2900 },
  openings: [{ kind: "door", family: "D", type: "1026x2100_S", wall: "south", along: 900, width: 1026 }],
  items: [{ id: "Bed", family: "B", type: "1020x2200", at: { wall: "north", off: 150 }, size: [1020, 2200], clearance: 1200 },
    { id: "Light", family: "L", type: "700", at: { centre: true, dy: 600 }, host: "ceiling" }],
  ...over,
});

test("T1: a room plans into walls on their centre lines, openings on their walls, items in place, a ceiling and the room", () => {
  const p = planRoom(bay() as any);
  assert.deepEqual(p.problems, []);
  const walls = p.ops.filter((o) => o.op === "wall") as any[];
  assert.equal(walls.length, 4);
  assert.deepEqual(walls.find((w) => w.side === "south").start, [-100, -100], "on the centre line, half a thickness outside the inner face; the centre lines meet at the corner");
  assert.deepEqual(walls.find((w) => w.side === "south").end, [4300, -100]);
  const door = p.ops.find((o) => o.op === "opening") as any;
  assert.deepEqual(door.at, [900, 0, 0], "900 along the south wall from its left end seen from inside");
  const bed = p.ops.find((o) => o.op === "place" && (o as any).id === "Bed") as any;
  assert.deepEqual(bed.at, [2100, 4850, 0], "the middle of the north wall, 150 off it");
  assert.equal(bed.rotate_deg, -180, "its front faces into the room (south)");
  const light = p.ops.find((o) => o.op === "place" && (o as any).id === "Light") as any;
  assert.deepEqual(light.at, [2100, 3100, 2900], "on the ceiling, 600 north of the centre");
  assert.ok(p.ops.some((o) => o.op === "ceiling") && p.ops.some((o) => o.op === "room"));
});

test("T1: the checks: an opening that doesn't fit, an item outside, a clearance that can't fit, a ceiling above the structure", () => {
  const p = planRoom(bay({ depth: 3000, ceiling: { type: "Generic", height: 3400 },
    openings: [{ kind: "window", family: "W", type: "x", wall: "east", along: 200, width: 1200 }],
    items: [{ id: "Bed", family: "B", type: "x", at: { wall: "north", off: 150 }, size: [1020, 2200], clearance: 1200 }, { id: "Far", family: "F", type: "x", at: { x: 9000, y: 1000 } }] }) as any);
  assert.ok(p.problems.some((x) => /window x on the east wall: 1200 wide at 200 doesn't fit/.test(x)));
  assert.ok(p.problems.some((x) => /Far is outside the room/.test(x)));
  assert.ok(p.problems.some((x) => /Bed: its 1200 mm clearance reaches 3550 mm into a 3000 mm room/.test(x)));
  assert.ok(p.problems.some((x) => /ceiling at 3400 is at or above the structure/.test(x)));
});
