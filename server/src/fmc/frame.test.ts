import { test } from "node:test";
import assert from "node:assert/strict";
import { Facts } from "./loads.js";
import { cluster, letters, planFrame, wallDirections } from "./frame.js";

const STD: Record<string, any> = {
  "loads.unit_weights": [["concrete", 25], ["screed", 22], ["block", 15]], "loads.imposed_floor": 1.5, "loads.services_and_ceilings": 0.5,
  "structure.rc_beam_depth_ratio": "span/12", "structure.rc_column_min": [230, 230], "foundations.min_depth": 1000, "slabs.span_depth_solid": { continuous: 26 },
};
const std = (k: string) => STD[k];
const W = (id: number, a: [number, number], b: [number, number], base = "GF", top = "FF") =>
  ({ id, type: "Block", thickness_mm: 200, length_mm: Math.hypot(b[0] - a[0], b[1] - a[1]), height_mm: 3000, base_level: base, top_level: top,
     start_mm: [a[0], a[1], 0] as [number, number, number], end_mm: [b[0], b[1], 0] as [number, number, number], layers: [{ function: "Structure", thickness_mm: 200, material: "Block" }] });
// an 8 m x 5 m box: four walls, one floor slab on top
const facts: Facts = {
  levels: [{ name: "GF", elevation_mm: 0 }, { name: "FF", elevation_mm: 3000 }],
  walls: [W(1, [0, 0], [8000, 0]), W(2, [8000, 0], [8000, 5000]), W(3, [8000, 5000], [0, 5000]), W(4, [0, 5000], [0, 0])],
  floors: [{ id: 10, type: "FF Slab 200 RC", level: "FF", area_m2: 40, thickness_mm: 200, layers: [{ function: "Structure", thickness_mm: 200, material: "Concrete" }],
    outline_mm: [[[0, 0, 3000], [8000, 0, 3000], [8000, 5000, 3000], [0, 5000, 3000]]] }],
  roofs: [], rooms: [{ id: 1, number: "1", name: "Room", level: "FF", area_m2: 40, at_mm: [4000, 2500, 3000] }],
};

test("Frame (owner 27 Oct): directions, clusters and grid names", () => {
  assert.deepEqual(wallDirections(facts.walls), [0]);
  assert.deepEqual(cluster([{ v: 0, w: 1 }, { v: 100, w: 1 }, { v: 5000, w: 1 }], 300), [50, 5000]);
  assert.equal(letters(8), "J");   // no I
});

test("Frame: corner columns, one more where the 8 m wall passes 6 m, beams at the floor and ground beams, pads, ops", () => {
  const p = planFrame(facts, std);
  assert.equal(p.grids.list.length, 2 + 2);
  assert.equal(p.columns.length, 6, "four corners + midpoints of the two 8 m walls");
  assert.ok(p.columns.every((c) => c.size_mm[0] === 230));
  assert.equal(p.beams.count, 12, "six spans at FF and six ground beams");
  assert.equal(p.beams.ground, 6);
  assert.ok(p.beams.list.every((b) => b.size_mm[1] >= 300));
  assert.equal(p.pads.length, 6);
  const total = p.columns.reduce((a, c) => a + c.n_uls_kn, 0);
  assert.ok(total > 1.35 * 40 * 5 && total < 1.35 * 40 * 8 + 1.5 * 40 * 1.5 + 400, `column loads add up to the slab and walls (${total})`);
  assert.ok(p.ops.some((o) => o.op === "grid") && p.ops.some((o) => o.op === "isolated_foundation" && o.size_mm.length === 3));
  assert.match(p.status, /PRELIMINARY/);
});
