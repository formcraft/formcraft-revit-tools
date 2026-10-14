import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, boq, kitCodes, moved, quantityFor, statusLegend } from "./build.js";

const codes = kitCodes({ codes: {
  "B.200_00": { description: "200 mm blockwork", group: "B.200", unit: "m2", trade_package: "PKG-03-MASONRY", rate: 41000 },
  "C.COL_01": { description: "RC column C25/30", group: "C.COL", unit: "m3", trade_package: "PKG-02-CONCRETE" },
  "E.CAB_02": { description: "Cable tray", group: "E.CAB", unit: "m", trade_package: "PKG-09-ELECTRICAL" },
  "J.HRD_01": { description: "Door ironmongery set", group: "J.HRD", unit: "set", trade_package: "PKG-06-DOORS-JOINERY" },
} });
const facts = { codes: {
  "B.200_00": { count: 12, area_m2: 140.004, volume_m3: 28, length_m: 60, category: "Walls" },
  "C.COL_01": { count: 8, area_m2: 0, volume_m3: 3.6004, length_m: 0, category: "Structural Columns" },
  "J.HRD_01": { count: 9, area_m2: 0, volume_m3: 0, length_m: 0, category: "Doors" },
  "X.ZZZ_99": { count: 2, area_m2: 0, volume_m3: 0, length_m: 0, category: "Generic Models" },
}, unmapped: { Furniture: 14, Walls: 3 } };

test("the quantity follows the kit code's unit; other units are left for the QS", () => {
  assert.deepEqual(quantityFor("m2", { count: 1, area_m2: 1.234, volume_m3: 0, length_m: 0, category: "" }), { qty: 1.23 });
  assert.deepEqual(quantityFor("nr", { count: 5, area_m2: 0, volume_m3: 0, length_m: 0, category: "" }), { qty: 5 });
  assert.match(quantityFor("t", { count: 5, area_m2: 0, volume_m3: 0, length_m: 0, category: "" }).why!, /QS measures it/);
});

test("the BOQ joins the kit's codes, lists codes the kit lacks and elements with no code, and never returns rates", () => {
  const r = boq(facts, codes, null);
  assert.deepEqual(r.items.map((i) => [i.code, i.qty]), [["B.200_00", 140], ["C.COL_01", 3.6], ["J.HRD_01", null]]);
  assert.deepEqual(r.unknown, [{ code: "X.ZZZ_99", count: 2, category: "Generic Models" }]);
  assert.deepEqual(r.unmapped, [{ category: "Furniture", count: 14 }, { category: "Walls", count: 3 }]);
  assert.equal(r.unmeasured, 1);
  assert.ok(!JSON.stringify(r).includes("41000"));
});

test("changes since the baseline are flagged, including an item that left the model", () => {
  const base = { "B.200_00": 140, "C.COL_01": 3.2, "E.CAB_02": 25 };
  const r = boq(facts, codes, base);
  const by = Object.fromEntries(r.items.map((i) => [i.code, i]));
  assert.equal(by["B.200_00"].changed, false);
  assert.equal(by["C.COL_01"].changed, true);
  assert.equal(by["E.CAB_02"].qty, 0);
  assert.equal(by["E.CAB_02"].changed, true);
  assert.equal(by["J.HRD_01"].changed, true);
  assert.equal(r.bills.find((b) => b.bill === "C.COL")!.changed, 1);
  assert.equal(moved(100, 100.4), false);
  assert.equal(moved(100, 101), true);
  assert.deepEqual(baselineOf(boq(facts, codes, null).items), { "B.200_00": 140, "C.COL_01": 3.6, "J.HRD_01": null });
});

test("the progress legend puts the known states first", () => {
  assert.deepEqual(statusLegend({ "Not started": 20, Custom: 2, Done: 5, "(none)": 40, "In progress": 7 }).map((s) => s.value),
    ["Done", "In progress", "Not started", "(none)", "Custom"]);
});
