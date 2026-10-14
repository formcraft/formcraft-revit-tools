import { test } from "node:test";
import assert from "node:assert/strict";
import { Register, answer, defaultDue, filterItems, raise, raiseProblems, shownStatus, solve, verdict } from "./review.js";

const now = new Date("2026-10-14T09:00:00Z"); // a Wednesday
const base = { title: "Beam B12 too deep at C/4", description: "600 mm downstand leaves 2.25 m clear", disciplines: ["A", "s"], lead: "S",
  owner: "NAME F", priority: "High" as const, raised_by: "NAME A", model: "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt", view: "A_FP_L00_General", element_ids: [11, 12] };

test("due dates by priority (MAN 10.5): Critical counts working days", () => {
  assert.equal(defaultDue("Critical", now), "2026-10-19"); // Thu, Fri, Mon
  assert.equal(defaultDue("High", now), "2026-10-21");
  assert.equal(defaultDue("Low", now), "2026-11-11");
});

test("raising needs a title, what's wrong, a lead and one owner; ids follow the project", () => {
  assert.deepEqual(raiseProblems({ ...base, title: "", owner: "", due: "2026-10-01" }, "2026-10-14").length, 3);
  const reg: Register = { project: "F26001", items: [] };
  const a = raise(reg, base, now);
  const b = raise(reg, { ...base, title: "Door swing" }, now);
  assert.deepEqual([a.id, b.id], ["F26001-ISS-0001", "F26001-ISS-0002"]);
  assert.deepEqual(a.disciplines, ["S", "A"]);
  assert.equal(a.due, "2026-10-21");
});

test("answers, done by the solver, then the raiser's check closes or reopens", () => {
  const reg: Register = { project: "F26001", items: [] };
  const i = raise(reg, base, now);
  assert.throws(() => solve(i, "NAME F", "Beam cut to 450", now), /Waiting for S, A to answer/);
  answer(i, "S", "NAME F", "Beam cut to 450 mm deep", true, now);
  assert.equal(i.status, "In progress");
  answer(i, "A", "NAME A", "Ceiling kept at 2.40 m", true, now);
  solve(i, "NAME F", "Beam B12 reduced to 450 mm; corridor clear 2.40 m", now);
  assert.equal(i.status, "Resolved");
  assert.throws(() => verdict(i, "NAME A", false, "", now), /Say why/);
  verdict(i, "NAME A", false, "Still 2.30 m at the bulkhead", now);
  assert.equal(i.status, "In progress");
  solve(i, "NAME F", "Bulkhead lowered", now);
  verdict(i, "NAME A", true, "", now);
  assert.equal(i.status, "Closed");
  assert.throws(() => answer(i, "S", "x", "y", true, now), /closed/);
});

test("filters: my discipline, overdue, closed", () => {
  const reg: Register = { project: "F26001", items: [] };
  raise(reg, base, now);
  const late = raise(reg, { ...base, title: "Fire door rating", lead: "A", disciplines: ["FP"], due: "2026-10-15" }, now);
  assert.deepEqual(filterItems(reg, "Overdue", [], "2026-10-20").map((x) => x.id), [late.id]);
  assert.equal(shownStatus(late, "2026-10-20"), "Overdue");
  assert.deepEqual(filterItems(reg, "My discipline", ["FP"], "2026-10-14").map((x) => x.id), [late.id]);
  assert.deepEqual(filterItems(reg, "Closed", [], "2026-10-14"), []);
});

test("prints list the sheet's open items for review, solved ones as revised, with solutions", async () => {
  const { printItems, printList } = await import("./review.js");
  const reg: Register = { project: "F26001", items: [] };
  const open = raise(reg, { ...base, sheet: "A-1001" }, now);
  const done = raise(reg, { ...base, title: "Door swing", lead: "A", disciplines: [], sheet: "A-1001" }, now);
  raise(reg, { ...base, title: "Elsewhere", sheet: "S-1001" }, now);
  answer(done, "A", "NAME A", "Swing reversed", true, now);
  solve(done, "NAME A", "D12 now opens inward", now);
  assert.deepEqual(printItems(reg, "a-1001", "For review").map((i) => i.id), [open.id]);
  assert.deepEqual(printItems(reg, "A-1001", "As revised").map((i) => i.id), [done.id]);
  const md = printList("A-1001 Ground floor", "As revised", printItems(reg, "A-1001", "As revised"), now);
  assert.match(md, /Solution: D12 now opens inward/);
  assert.match(md, /- A: Swing reversed \(NAME A\)/);
});
