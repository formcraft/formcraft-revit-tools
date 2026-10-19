import { test } from "node:test";
import assert from "node:assert/strict";
import { Register } from "./review.js";
import { mark } from "./tickets.js";
import { parseNote, planFix } from "./noteparse.js";
import { applyProblems, applySteps, fixApplied, fixFailed, planHash } from "./applyfix.js";

const now = new Date("2026-10-19T09:00:00Z");
const door = { unique_id: "u-1", category: "Doors", type_name: "FMC Door 926 Single", params: { Width: 926, Height: 2100, "Sill Height": 0 },
  types: ["FMC Door 926 Single", "FMC Door 1026 Single"] };
const ticket = (text: string) => {
  const reg: Register = { project: "F26001", items: [] };
  return mark(reg, { to: "ai", title: "", text, priority: "High", raised_by: "Amina", model: "F26001-FMC-ZZ-02-M3-A-0001.rvt",
    where: { unique_ids: ["u-1"], view: "L2 - ICU" } }, now);
};

test("R6: a ready plan with a person's yes to these very steps can be applied", () => {
  const t = ticket("make it 1026 wide");
  const plan = planFix(parseNote("make it 1026 wide"), door, { materials: [] });
  const steps = applySteps(t, plan);
  assert.equal(steps[0].unique_id, "u-1");
  assert.deepEqual(applyProblems(t, plan), [], "the dry run's check");
  assert.deepEqual(applyProblems(t, plan, { approved_by: "Amina", plan_hash: planHash(steps) }), []);
});

test("R6: no yes, the AI's yes, or a yes to other steps is refused", () => {
  const t = ticket("make it 1026 wide");
  const plan = planFix(parseNote("make it 1026 wide"), door, { materials: [] });
  const hash = planHash(applySteps(t, plan));
  assert.match(applyProblems(t, plan, { approved_by: "", plan_hash: hash }).join(), /person's yes/);
  assert.match(applyProblems(t, plan, { approved_by: "AI modeller", plan_hash: hash }).join(), /isn't a person/);
  assert.match(applyProblems(t, plan, { approved_by: "Claude (via MCP)", plan_hash: hash }).join(), /isn't a person/);
  const wider = planFix(parseNote("make it 1200 wide"), door, { materials: [] });
  assert.match(applyProblems(t, wider, { approved_by: "Amina", plan_hash: hash }).join(), /plan changed/);
  assert.match(applyProblems(t, plan, { approved_by: "Amina", plan_hash: "" }).join(), /plan_hash/);
});

test("R6: the fingerprint ignores the wording and the old value, not the values that change the model", () => {
  const t = ticket("x");
  const a = applySteps(t, planFix(parseNote("make it 1026 wide"), door, { materials: [] }));
  const b = a.map((s) => ({ ...s, sentence: "reworded", was: 900 }));
  assert.equal(planHash(a), planHash(b as typeof a));
  assert.notEqual(planHash(a), planHash(applySteps(t, planFix(parseNote("make it 1100 wide"), door, { materials: [] }))));
});

test("R6: a plan from the note alone, or with something unclear, never reaches the model", () => {
  const t = ticket("make it 1026 wide");
  assert.match(applyProblems(t, planFix(parseNote("make it 1026 wide"), null, { materials: [] })).join(), /note alone/);
  const odd = planFix(parseNote("please sort this out"), door, { materials: [] });
  assert.ok(applyProblems(t, odd).length > 0);
  const done = { ...t, status: "Resolved" as const };
  assert.match(applyProblems(done, planFix(parseNote("make it 1026 wide"), door, { materials: [] })).join(), /already resolved/);
});

test("R6: applied, the ticket goes back to the raiser as Resolved; not applied, the thread says why", () => {
  const t = ticket("make it 1026 wide");
  const steps = applySteps(t, planFix(parseNote("make it 1026 wide"), door, { materials: [] }));
  fixApplied(t, "AI modeller", "Amina", steps, now);
  assert.equal(t.status, "Resolved");
  assert.match(t.solution!, /^Fixed: Set Width to 1026 mm/);
  assert.match(t.notes!.at(-1)!.text, /Fixed: check it.*approved by Amina/);
  const u = ticket("make it 1026 wide");
  fixFailed(u, "AI modeller", 1, "Width is read-only", now);
  assert.notEqual(u.status, "Resolved");
  assert.match(u.notes!.at(-1)!.text, /step 1: Width is read-only.*Nothing in the model changed/);
});
