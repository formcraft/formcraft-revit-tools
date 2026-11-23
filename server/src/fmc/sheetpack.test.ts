import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseScale, packSheet, resolveZone, type PackMove } from "./sheetpack.js";

const zone = { min_x: 0, min_y: 0, max_x: 400, max_y: 300 };

function overlap(a: PackMove, b: PackMove): boolean {
  const ax0 = a.center_x_mm - a.width_mm / 2;
  const ax1 = a.center_x_mm + a.width_mm / 2;
  const ay0 = a.title_bottom_mm;
  const ay1 = a.center_y_mm + a.height_mm / 2;
  const bx0 = b.center_x_mm - b.width_mm / 2;
  const bx1 = b.center_x_mm + b.width_mm / 2;
  const by0 = b.title_bottom_mm;
  const by1 = b.center_y_mm + b.height_mm / 2;
  return ax0 < bx1 - 0.05 && bx0 < ax1 - 0.05 && ay0 < by1 - 0.05 && by0 < ay1 - 0.05;
}

test("the largest scale at or above the minimum is the one that fits the zone", () => {
  const view = { id: "1", name: "Plan", model_width_mm: 8000, model_height_mm: 4000, title_mm: 12 };
  assert.equal(chooseScale(view, 400, 300, 10), 20);
  assert.equal(chooseScale(view, 400, 300, 50), 50);
  assert.equal(chooseScale({ ...view, model_width_mm: 1e9, model_height_mm: 1e9 }, 400, 300, 1), null);
});

test("views pack without overlap, titles on a shelf share a baseline, and overflow is in millimetres", () => {
  const views = [
    { id: "a", name: "A", sheet: "A-101", model_width_mm: 1000, model_height_mm: 1000, title_mm: 12 },
    { id: "b", name: "B", sheet: "A-101", model_width_mm: 1000, model_height_mm: 1000, title_mm: 12 },
  ];
  const packed = packSheet({ views, zone, min_scale: 10, pair_small: false, gap_mm: 8, sheet: "A-101" });
  assert.equal(packed.overflow.length, 0);
  assert.equal(packed.moves.length, 2);
  assert.equal(packed.moves[0].title_bottom_mm, packed.moves[1].title_bottom_mm);
  assert.equal(packed.moves[0].scale, 10);
  assert.equal(overlap(packed.moves[0], packed.moves[1]), false);
  const huge = packSheet({
    views: [{ id: "z", name: "Huge", model_width_mm: 1e8, model_height_mm: 1e8 }],
    zone, min_scale: 50, pair_small: false,
  });
  assert.equal(huge.moves.length, 0);
  assert.ok(huge.overflow[0].shortfall_width_mm > 0);
  assert.equal(huge.overflow[0].zone_width_mm, 400);
});

test("pair_small proposes a small view from another sheet and a known title block supplies the zone", () => {
  const packed = packSheet({
    views: [{ id: "a", name: "A", sheet: "A-101", model_width_mm: 1000, model_height_mm: 1000, title_mm: 12 }],
    others: [{ id: "s", name: "Detail", sheet: "A-102", model_width_mm: 500, model_height_mm: 500, title_mm: 12 }],
    zone, min_scale: 10, pair_small: true, gap_mm: 8, sheet: "A-101",
  });
  assert.equal(packed.overflow.length, 0);
  assert.equal(packed.proposed_pairs.length, 1);
  assert.equal(packed.proposed_pairs[0].from_sheet, "A-102");
  assert.equal(overlap(packed.moves[0], packed.proposed_pairs[0]), false);
  const a1 = resolveZone({ family: "FMC_TB_A1" });
  assert.equal("zone" in a1, true);
  if (!("zone" in a1)) return;
  assert.equal(a1.source, "kit");
  assert.equal(a1.zone.max_x, 701);
  const params = resolveZone({ family: "FMC_TB_A0", params: { "Drawing Width": 900, "Drawing Height": 700 } });
  if (!("zone" in params)) return;
  assert.equal(params.source, "titleblock_param");
  assert.equal(params.zone.max_x, 920);
  const missing = resolveZone({ family: "Titleblock" });
  assert.equal("code" in missing && missing.code, "FMC-SHEETS-NO-FRAME");
});
