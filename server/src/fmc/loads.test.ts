import { test } from "node:test";
import assert from "node:assert/strict";
import { Facts, imposedFor, inside, slabKind, takedown, unitWeight } from "./loads.js";

const STD: Record<string, any> = {
  "loads.unit_weights": [["concrete|rc ", 25], ["screed", 22], ["plaster|render", 20], ["stone", 24], ["block", 15], ["porcelain|tile", 22]],
  "loads.imposed_floor": 1.5, "loads.imposed_balconies": 2.5, "loads.imposed_stairs": 2.0, "loads.imposed_roof_inaccessible": 0.4,
  "loads.services_and_ceilings": 0.5, "loads.roof_build_up": { clay_tiles_and_battens: 0.65, rafters_and_purlins_timber: 0.15, ceiling_and_insulation: 0.2 },
};
const std = (k: string) => STD[k];
const L = (material: string, mm: number, fn = "Structure") => ({ function: fn, thickness_mm: mm, material });
const square: [number, number, number][][] = [[[0, 0, 3000], [6000, 0, 3000], [6000, 4000, 3000], [0, 4000, 3000]]];

const facts: Facts = {
  levels: [{ name: "GF", elevation_mm: 0 }, { name: "FF", elevation_mm: 3000 }],
  walls: [
    { id: 1, type: "EXT stone", thickness_mm: 235, length_mm: 6000, height_mm: 3000, base_level: "GF", top_level: "FF", start_mm: [0, 0, 0], end_mm: [6000, 0, 0], layers: [L("Render", 20, "Finish1"), L("Stone", 200), L("Plaster", 15, "Finish2")] },
    { id: 2, type: "EXT stone", thickness_mm: 235, length_mm: 6000, height_mm: 3000, base_level: "GF", top_level: "FF", start_mm: [0, 4000, 0], end_mm: [6000, 4000, 0], layers: [L("Render", 20, "Finish1"), L("Stone", 200), L("Plaster", 15, "Finish2")] },
    { id: 3, type: "INT stud", thickness_mm: 80, length_mm: 3000, height_mm: 2700, base_level: "FF", start_mm: [3000, 1000, 3000], end_mm: [3000, 3000, 3000], layers: [L("Plasterboard", 25, "Finish1")] },
  ],
  floors: [
    { id: 10, type: "FF Slab - 50 screed + 200 RC", level: "FF", area_m2: 24, thickness_mm: 250, layers: [L("Screed", 50, "Substrate"), L("Concrete - in-situ", 200)], outline_mm: square },
    { id: 11, type: "GF Slab on hardcore", level: "GF", area_m2: 24, thickness_mm: 350, layers: [L("Concrete", 150), L("Hardcore", 200, "Substrate")], outline_mm: square },
    { id: 12, type: "FIN 20 porcelain", level: "FF", area_m2: 24, thickness_mm: 20, layers: [L("Porcelain", 20, "Finish1")], outline_mm: square },
  ],
  roofs: [{ id: 20, type: "Roof - Clay tile on battens + rafters", level: "FF", area_m2: 30, layers: [] }],
  rooms: [{ id: 30, number: "F01", name: "Bedroom", level: "FF", area_m2: 12, at_mm: [1500, 2000, 3000] }, { id: 31, number: "F02", name: "Balcony", level: "FF", area_m2: 12, at_mm: [4500, 2000, 3000] }],
};

test("Loads (owner 27 Oct): unit weights from the kit by material name; slabs, ground slabs and finishes told apart", () => {
  assert.equal(unitWeight({ material: "OGL Stone - Machine-cut 200" }, std), 24);
  assert.equal(unitWeight({ material: "Anything", density_kg_m3: 2400 }, std), 23.54);
  assert.equal(unitWeight({ material: "Unobtainium" }, std), null);
  assert.equal(slabKind(facts.floors[0]), "suspended");
  assert.equal(slabKind(facts.floors[1]), "on_ground");
  assert.equal(slabKind(facts.floors[2]), "finish");
  assert.equal(imposedFor("Master balcony", std).q, 2.5);
  assert.ok(inside([1, 1], square) && !inside([7000, 1], square));
});

test("Loads: a slab's G is self + layers + finishes + services + partitions; Q by its rooms; walls carry it by length", () => {
  const t = takedown(facts, std);
  const s = t.slabs[0];
  assert.equal(s.g_self, 5); assert.equal(s.g_layers, 1.1); assert.equal(s.g_finishes, 0.44); assert.equal(s.g_services, 0.5);
  assert.ok(s.g_partitions > 0, "the stud wall on it");
  assert.equal(s.q, 2, "half bedroom 1.5, half balcony 2.5");
  assert.equal(t.on_ground.length, 1);
  const w = t.walls.find((x) => x.id === 1)!;
  assert.equal(w.bearing, true);
  assert.equal(t.walls.find((x) => x.id === 3)!.bearing, false);
  assert.equal(w.from_slabs_g_kn, s.total_g_kn / 2, "two equal walls share the slab");
  assert.equal(t.roofs[0].g, 1);
  assert.equal(t.totals.uls_kn, Math.round((1.35 * t.totals.g_kn + 1.5 * t.totals.q_kn) * 100) / 100);
  assert.match(t.status, /PRELIMINARY/);
});
