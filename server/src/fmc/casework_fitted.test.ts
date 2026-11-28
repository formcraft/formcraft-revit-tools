import { test } from "node:test";
import assert from "node:assert/strict";
import { Run, Standards, compute, hardware, layoutAny, layoutRun, missingForKinds, partsFor } from "./casework.js";
import { FIX, call, done, kit } from "./casework_testkit.js";

/** Wardrobes and vanities: their own straight layouts, the kit's sizes (never defaulted), and the kitchen unchanged. */

const ROBE = { wardrobe: { height: 2100, depth: 600 }, vanity: { height: 800, depth: 450 }, shelves: { ...FIX.standards.shelves, wardrobe: 1, vanity: 1 } };
const S = { ...FIX.standards, ...ROBE } as Standards;

const wardrobe: Run = { kind: "wardrobe", modules: [1000, 500], walls: [{ name: "B1", length: 3200, openings: [{ kind: "door", offset: 2400, width: 800 }] }] };
const vanity: Run = { kind: "vanity", modules: [600, 400], walls: [{ name: "BT1", length: 2000, fixed: [{ kind: "basin", offset: 600, width: 600 }] }] };

test("a wardrobe run fills the wall up to the door with wardrobe units, WR marks, and no top or wall units", () => {
  const l = layoutAny(wardrobe, S);
  assert.deepEqual(l.problems, []);
  assert.deepEqual(l.units.map((u) => [u.mark, u.kind, u.width, u.offset, u.fronts]),
    [["WR01", "wardrobe", 1000, 0, "2door"], ["WR02", "wardrobe", 1000, 1000, "2door"]]);
  assert.deepEqual(l.fillers, [{ wall: "B1", layer: "base", offset: 2000, width: 400 }]);
  assert.deepEqual(l.worktop, []);
  assert.ok(!l.units.some((u) => u.layer === "wall"));
});

test("wardrobes keep windows clear; vanities may sit under them", () => {
  const w = layoutAny({ ...wardrobe, walls: [{ name: "B1", length: 2000, openings: [{ kind: "window", offset: 500, width: 1000 }] }] }, S);
  assert.deepEqual(w.units.map((u) => [u.offset, u.width]), [[0, 500], [1500, 500]]);
  const v = layoutAny({ ...vanity, walls: [{ name: "BT1", length: 1200, openings: [{ kind: "window", offset: 0, width: 1200 }] }] }, S);
  assert.deepEqual(v.units.map((u) => u.width), [600, 600]);
});

test("a vanity run: basins are fixed units, vanities fill round them, and the top runs over both", () => {
  const l = layoutAny(vanity, S);
  assert.deepEqual(l.problems, []);
  assert.deepEqual(l.units.map((u) => [u.mark, u.kind, u.width, u.offset, u.fronts]),
    [["V01", "vanity", 600, 0, "door"], ["V02", "basin", 600, 600, "2door"], ["V03", "vanity", 600, 1200, "door"]]);
  assert.deepEqual(l.fillers, [{ wall: "BT1", layer: "base", offset: 1800, width: 200 }]);
  assert.deepEqual(l.worktop, [{ wall: "BT1", from: 0, to: 2000, length: 2000 }]);
});

test("kitchen-only features and foreign fixed items are problems in a fitted run, and a basin in a kitchen is one too", () => {
  const w = layoutAny({ ...wardrobe, corner_width: 900, walls: [{ name: "B1", length: 2000, corner: "start", tall: { at: "end", width: 600 }, fixed: [{ kind: "sink", offset: 0, width: 600 }] }] }, S);
  for (const re of [/corner_width are kitchen-only/, /corner units are kitchen-only/, /tall units are kitchen-only/, /a sink doesn't go in a wardrobe run/])
    assert.ok(w.problems.some((p) => re.test(p)), `${re}: ${w.problems.join(" | ")}`);
  const k = layoutAny({ ...FIX.run, walls: [{ ...FIX.run.walls[0], fixed: [...(FIX.run.walls[0].fixed ?? []), { kind: "basin", offset: 0, width: 1 }] }, ...FIX.run.walls.slice(1)] }, S);
  assert.ok(k.problems.some((p) => /basin belongs in a vanity run/.test(p)));
  assert.ok(layoutAny({ ...vanity, walls: [{ name: "BT1", length: 1000, fixed: [{ kind: "basin", offset: 600, width: 600 }] }] }, S).problems.some((p) => /runs off the wall/.test(p)));
});

test("parts: a wardrobe has a full top and the kit's wardrobe box; a basin has the sink's top rails and no shelf", () => {
  const [robe] = layoutAny(wardrobe, S).units;
  const rp = partsFor(robe, S).parts;
  assert.equal(rp.find((p) => p.part === "Side")!.length, 2100);
  assert.equal(rp.find((p) => p.part === "Side")!.width, 600);
  assert.ok(rp.some((p) => p.part === "Top") && !rp.some((p) => p.part === "Top rail"));
  const basin = layoutAny(vanity, S).units[1];
  const bp = partsFor(basin, S).parts;
  assert.equal(bp.find((p) => p.part === "Top rail")!.qty, S.construction.sink_top_rails);
  assert.equal(bp.find((p) => p.part === "Side")!.length, 800);
  assert.ok(!bp.some((p) => /Shelf/.test(p.part)));
});

test("hardware: wardrobes add a hanging rail (inner widths) and brackets; a kitchen's list is exactly as before", () => {
  const units = layoutAny(wardrobe, S).units;
  const hw = Object.fromEntries(hardware(units, S).map((h) => [h.item, h.qty]));
  assert.equal(hw["Hanging rail"], Math.round((2 * (1000 - 2 * S.carcass_thickness)) / 100) / 10);
  assert.equal(hw["Rail brackets"], 4);
  assert.equal(hw.Hinges, 2 * 2 * S.hardware.hinges_per_tall_door);
  const kitchen = hardware(layoutRun(FIX.run, S).units, S);
  assert.ok(!kitchen.some((h) => /rail/i.test(h.item)));
  assert.equal(kitchen.find((h) => h.item === "Hinges")!.qty, 28, "the example kitchen's 28 hinges");
  assert.equal(compute(layoutRun(FIX.run, S).units, layoutRun(FIX.run, S), S).nests.reduce((a, n) => a + n.sheets.length, 0), 15);
});

test("the wardrobe and vanity sizes are never defaulted: a kit without them refuses, naming what's missing", async () => {
  assert.deepEqual(missingForKinds(FIX.standards, ["base", "sink"]), []);
  assert.deepEqual(missingForKinds(FIX.standards, ["wardrobe"]), ["wardrobe.height", "wardrobe.depth", "shelves.wardrobe"]);
  assert.deepEqual(missingForKinds(FIX.standards, ["basin"]), ["vanity.height", "vanity.depth", "shelves.vanity"]);
  const k = kit();
  try {
    const r = await call(k, { action: "units", run: wardrobe });
    assert.equal(r.isError, true);
    assert.deepEqual(r.body.missing, ["wardrobe.height", "wardrobe.depth", "shelves.wardrobe"]);
    const ok = await call(k, { action: "summary", run: wardrobe, standards: ROBE });
    assert.equal(ok.isError, false, JSON.stringify(ok.body));
    assert.equal(ok.body.units, 2);
    const kitchen = await call(k, { action: "summary", run: FIX.run });
    assert.equal(kitchen.isError, false, "a kitchen still needs nothing new from the kit");
  } finally { done(k); }
});

test("the tool takes run.kind and the new unit kinds", async () => {
  const k = kit({ revision: "r7", ...FIX.standards, ...ROBE });
  try {
    const r = await call(k, { action: "units", run: vanity });
    assert.equal(r.isError, false);
    assert.deepEqual(r.body.units.map((u: { kind: string }) => u.kind), ["vanity", "basin", "vanity"]);
    const u = await call(k, { action: "hardware", units: [{ mark: "WR01", kind: "wardrobe", width: 900, wall: "", offset: 0, fronts: "2door" }] });
    assert.equal(u.isError, false);
    assert.ok(u.body.hardware.some((h: { item: string }) => h.item === "Hanging rail"));
  } finally { done(k); }
});
