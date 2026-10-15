import { test } from "node:test";
import assert from "node:assert/strict";
import { Member, assemble, checkForm, mapResults, runRef } from "./robot.js";

const m = (id: number, kind: "column" | "beam", start: [number, number, number], end: [number, number, number], extra: Partial<Member> = {}): Member => ({
  id, kind, start, end, section: "C 300x300", b_mm: 300, h_mm: 300, material_class: "Concrete", concrete_grade: "C30/37", steel_grade: "B500", ...extra,
});

test("a two-storey frame: ends merge within 1 mm, supports are the ground columns only", () => {
  const model = assemble([
    m(1, "column", [0, 0, 0], [0, 0, 3000]),
    m(2, "column", [5000, 0, 0], [5000, 0, 3000]),
    m(3, "column", [0, 0, 3000.4], [0, 0, 6000]), // stacked on 1, 0.4 mm off
    m(4, "beam", [0.6, 0, 3000], [5000, 0, 2999.5], { section: "B 230x450", b_mm: 230, h_mm: 450 }),
  ]);
  assert.equal(model.nodes.length, 5);
  assert.equal(model.bars.length, 4);
  assert.deepEqual(model.supports, [1, 3]);
  assert.deepEqual(model.bars.map((b) => [b.start, b.end]), [[1, 2], [3, 4], [2, 5], [2, 4]]);
  assert.equal(model.bars[0].grade, "C30/37");
});

test("a column drawn top-down still supports at its bottom; steel takes the steel grade", () => {
  const model = assemble([m(7, "column", [0, 0, 4000], [0, 0, 0], { material_class: "Steel", steel_grade: "S275" })]);
  assert.deepEqual(model.supports, [2]);
  assert.equal(model.bars[0].grade, "S275");
});

test("a member whose ends meet is skipped, not sent", () => {
  const model = assemble([m(9, "beam", [0, 0, 0], [0.5, 0, 0])]);
  assert.equal(model.bars.length, 0);
  assert.deepEqual(model.skipped, [{ id: 9, why: "its two ends are the same point" }]);
});

test("the engineer's form has no defaults", () => {
  assert.ok(checkForm({}).problems.length >= 3);
  const noWeight = checkForm({ supports: "Fixed", engineer: "A. Engineer", cases: [{ name: "G", nature: "permanent" }] });
  assert.equal(noWeight.form, null);
  assert.match(noWeight.problems.join(" "), /self-weight/);
  const bad = checkForm({ supports: "Rollers", engineer: "A", cases: [{ name: "G", nature: "DEAD", self_weight: true }] });
  assert.equal(bad.problems.length, 2);
  const ok = checkForm({ supports: "Pinned", engineer: " A. Engineer ", cases: [{ name: "G", nature: "permanent", self_weight: true }, { name: "Q", nature: "EXPLOATATION", self_weight: false }] });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.form?.engineer, "A. Engineer");
  assert.equal(ok.form?.cases[0].nature, "PERMANENT");
});

test("the run reference is FEA-yyyymmdd-hhmm in local time", () => {
  assert.equal(runRef(new Date(2026, 9, 15, 8, 5)), "FEA-20261015-0805");
});

test("results map back only through the run's own bars", () => {
  const sent = [{ n: 1, id: 101 }, { n: 2, id: 102 }];
  const { rows, unknown } = mapResults(sent, [
    { n: 1, id: 101, ned_kn: 812.4, med_knm: 41.2 },
    { n: 2, id: 999, ned_kn: 10, med_knm: 1 },   // not this run's element
    { n: 3, id: 103, ned_kn: 10, med_knm: 1 },   // not sent
    { n: 2, id: 102, ned_kn: NaN, med_knm: 1 },  // no value
  ], "FEA-20261015-0805");
  assert.deepEqual(rows, [{ id: 101, ned_kn: 812.4, med_knm: 41.2, run: "FEA-20261015-0805" }]);
  assert.deepEqual(unknown, [2, 3, 2]);
});
