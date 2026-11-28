import { test } from "node:test";
import assert from "node:assert/strict";
import { DS_DEFAULT_WHITELIST, DS_UNIVERSE, checkCategory, resolveWhitelist } from "./directshape_cats.js";
import { DS_LIMITS, RUN_ID_PATTERN, newRunId, normaliseShapes, planHash, polygonArea, polygonProblem, summarise, type P2 } from "./directshape_spec.js";

test("whitelist: the default is Generic Models and Mass", () => {
  const w = resolveWhitelist(undefined);
  assert.deepEqual(w.allowed.map((c) => c.name), [...DS_DEFAULT_WHITELIST]);
  assert.equal(w.source, "default");
});

test("whitelist: the guard file can add from the fixed list, and names outside it are ignored", () => {
  const w = resolveWhitelist({ directshape_categories: ["mass", "Furniture", "Walls", "OST_Site", "mass"] });
  assert.deepEqual(w.allowed.map((c) => c.name), ["Mass", "Furniture", "Site"]);
  assert.deepEqual(w.ignored, ["Walls"]);
  assert.equal(w.source, "config");
});

test("whitelist: a broken list falls back to the default and never widens it", () => {
  for (const bad of [[], ["Walls", "Doors"], "Mass" as unknown as string[], [7 as unknown as string]]) {
    const w = resolveWhitelist({ directshape_categories: bad });
    assert.deepEqual(w.allowed.map((c) => c.name), [...DS_DEFAULT_WHITELIST]);
    assert.ok(w.problem);
  }
});

test("whitelist: the universe holds no wall, floor, roof, door, window, column, room or level", () => {
  for (const c of DS_UNIVERSE) assert.doesNotMatch(c.bic, /Walls|Floors|Roofs|Doors|Windows|Columns|Rooms|Levels|Grids|Stairs|Ceilings|Framing/);
});

test("category check: an alias works, empty means the first, and anything else is refused with the list", () => {
  const w = resolveWhitelist(undefined);
  const generic = checkCategory("generic", w);
  assert.ok(generic.ok && generic.category.bic === "OST_GenericModel");
  const empty = checkCategory("  ", w);
  assert.ok(empty.ok && empty.category.name === "Generic Models");
  const wall = checkCategory("Walls", w);
  assert.ok(!wall.ok && wall.code === "FMC-DS-CATEGORY");
  assert.match(!wall.ok ? wall.message : "", /Allowed here: Generic Models, Mass/);
  const furniture = checkCategory("Furniture", w);
  assert.ok(!furniture.ok);
  assert.match(!furniture.ok ? furniture.message : "", /whitelist/);
  assert.ok(checkCategory("Furniture", resolveWhitelist({ directshape_categories: ["Furniture"] })).ok);
});

test("spec: a box has its volume and bounding box, and a rotation turns the footprint", () => {
  const { shapes, problems } = normaliseShapes([{ kind: "box", name: "A", origin_mm: [1000, 2000, 0], size_mm: [2000, 1000, 3000] }]);
  assert.deepEqual(problems, []);
  const s = summarise(shapes[0]);
  assert.equal(s.volume_m3, 6);
  assert.deepEqual(s.bbox_mm, { min: [0, 1500, 0], max: [2000, 2500, 3000] });
  const turned = summarise(normaliseShapes([{ kind: "box", origin_mm: [0, 0, 0], size_mm: [2000, 1000, 100], rotation_deg: 90 }]).shapes[0]);
  assert.deepEqual(turned.bbox_mm, { min: [-500, -1000, 0], max: [500, 1000, 100] });
});

test("spec: an extrusion is stored counter-clockwise whichever way it was drawn", () => {
  const cw: P2[] = [[0, 0], [0, 1000], [1000, 1000], [1000, 0]];
  const { shapes, problems } = normaliseShapes([{ kind: "extrusion", profile_mm: cw, height_mm: 500 }]);
  assert.deepEqual(problems, []);
  const part = shapes[0].parts[0];
  assert.ok(part.kind === "extrusion" && polygonArea(part.profile_mm) > 0);
  assert.equal(summarise(shapes[0]).volume_m3, 0.5);
});

test("spec: bad polygons are refused, not repaired", () => {
  assert.match(polygonProblem([[0, 0], [1000, 1000], [1000, 0], [0, 500]]) ?? "", /cross/);
  assert.match(polygonProblem([[0, 0], [1000, 0]]) ?? "", /at least 3/);
  assert.match(polygonProblem([[0, 0], [1000, 0], [2000, 0]]) ?? "", /no area/);
  assert.match(polygonProblem([[0, 0], [1000, 1000], [1000, 0], [0, 1000]]) ?? "", /no area/, "a symmetric bow tie has no net area");
  assert.match(polygonProblem([[0, 0], [0.2, 0], [1000, 1000]]) ?? "", /shorter/);
  assert.equal(polygonProblem([[0, 0], [4000, 0], [4000, 1000], [1000, 1000], [1000, 3000], [0, 3000]]), null, "an L shape is fine");
  const many: P2[] = Array.from({ length: DS_LIMITS.max_vertices + 1 }, (_, i) => [Math.cos(i) * 1000, Math.sin(i) * 1000] as P2);
  assert.match(polygonProblem(many) ?? "", /most is 64/);
});

test("spec: the numbers are checked, with a message per problem", () => {
  const bad = (raw: object) => normaliseShapes([raw]).problems.map((p) => p.message).join(" | ");
  assert.match(bad({ kind: "box", size_mm: [0, 100, 100] }), /at least 1 mm/);
  assert.match(bad({ kind: "box", size_mm: [100, 100] }), /three numbers/);
  assert.match(bad({ kind: "box", size_mm: [100, 100, 600000] }), /outside/);
  assert.match(bad({ kind: "box", size_mm: [100, 100, 100], origin_mm: [Number.NaN, 0, 0] }), /three numbers/);
  assert.match(bad({ kind: "box", size_mm: [100, 100, 100], rotation_deg: Number.POSITIVE_INFINITY }), /rotation_deg/);
  assert.match(bad({ kind: "sphere" }), /box.*extrusion/);
  assert.match(bad({ kind: "extrusion", profile_mm: [[0, 0], [1000, 0], [1000, 1000]], height_mm: 0 }), /height_mm/);
  assert.match(bad({ kind: "box", size_mm: [100, 100, 100], purpose: "decor" }), /purpose/);
  assert.match(normaliseShapes([]).problems[0].message, /no shapes/);
  assert.match(normaliseShapes(Array.from({ length: 51 }, () => ({ kind: "box", size_mm: [1, 1, 1] }))).problems[0].message, /most in one call is 50/);
});

test("spec: parts make one shape, and defaults are filled in", () => {
  const { shapes } = normaliseShapes([{ name: "Two boxes", parts: [{ kind: "box", size_mm: [1000, 1000, 1000] }, { kind: "box", origin_mm: [2000, 0, 0], size_mm: [1000, 1000, 1000] }] }, { kind: "box", size_mm: [10, 10, 10] }]);
  assert.equal(shapes.length, 2);
  assert.equal(shapes[0].parts.length, 2);
  assert.equal(summarise(shapes[0]).volume_m3, 2);
  assert.equal(shapes[1].name, "FMC DirectShape 2");
  assert.equal(shapes[1].purpose, "other");
  assert.deepEqual(summarise(shapes[0]).bbox_mm, { min: [-500, -500, 0], max: [2500, 500, 1000] });
});

test("run id and plan hash", () => {
  const id = newRunId(new Date(Date.UTC(2026, 10, 28, 11, 5, 9)), () => "ab12");
  assert.equal(id, "DS-20261128110509-ab12");
  assert.match(id, RUN_ID_PATTERN);
  assert.match(newRunId(), RUN_ID_PATTERN);
  const a = normaliseShapes([{ kind: "box", size_mm: [100, 100, 100] }]).shapes;
  const b = normaliseShapes([{ kind: "box", size_mm: [100, 100, 101] }]).shapes;
  assert.equal(planHash("Doc", ["Mass"], a), planHash("doc", ["Mass"], a));
  assert.notEqual(planHash("Doc", ["Mass"], a), planHash("Doc", ["Mass"], b));
  assert.notEqual(planHash("Doc", ["Mass"], a), planHash("Doc", ["Generic Models"], a));
  assert.match(planHash("Doc", [], a), /^[0-9a-f]{12}$/);
});
