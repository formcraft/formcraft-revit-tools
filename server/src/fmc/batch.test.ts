import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { batchId, planBatch, readBatchResults, recipeRevision } from "./batch.js";

test("F-063: a recipe's revision follows its template and ops, nothing else", () => {
  const a = { family: "FMC_A_X", template: "Metric Door.rft", ops: [{ op: "add_type", name: "T" }], values: {} };
  const sameOps = { ...a, values: { note: "changed" } };
  assert.equal(recipeRevision(a), recipeRevision(sameOps));
  assert.notEqual(recipeRevision(a), recipeRevision({ ...a, ops: [{ op: "add_type", name: "T2" }] }));
  assert.match(recipeRevision(a), /^[0-9a-f]{12}$/);
});

test("F-063: build what isn't staged, passed and current; rebuild forces", () => {
  const c = (family: string, staged: object) => ({ family, revision: "r1", staged: { exists: true, ...staged } });
  const cands = [
    { family: "FMC_A_New", revision: "r1", staged: { exists: false } },
    c("FMC_A_Done", { revision: "r1", verdict: "Pass" }),
    c("FMC_A_Changed", { revision: "r0", verdict: "Pass" }),
    c("FMC_A_Failed", { revision: "r1", verdict: "Fail" }),
    c("FMC_A_Ungated", { revision: "r1", verdict: null }),
  ];
  const plan = planBatch(cands);
  assert.deepEqual(plan.build, ["FMC_A_New", "FMC_A_Changed", "FMC_A_Failed", "FMC_A_Ungated"]);
  assert.deepEqual(plan.skip.map((s) => s.family), ["FMC_A_Done"]);
  assert.match(plan.skip[0].why, /already staged from this recipe revision \(r1\) and Gate A passed/);
  assert.deepEqual(planBatch(cands, ["FMC_A_Done"]).build.sort(), cands.map((x) => x.family).sort());
  assert.equal(planBatch(cands, true).skip.length, 0);
});

test("F-063: the results file keeps the last word per family (a later gate line joins its build line)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-batch-"));
  const file = path.join(dir, "B-20261018-0930.jsonl");
  fs.writeFileSync(file, [
    { family: "FMC_A_One", at: "2026-10-18T09:30:05+03:00", ok: true, saved: "D:\\K\\04_Families\\_Staging\\A\\FMC_A_One.rfa", s: 4.1 },
    { family: "FMC_A_Two", at: "2026-10-18T09:30:12+03:00", ok: false, error: "op 145 failed: Curve length is too small" },
    { family: "FMC_A_One", gate: "Pass", gate_fails: [] },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n{torn");
  const r = readBatchResults(file);
  assert.deepEqual([r.built, r.failed, r.gated, r.passed], [1, 1, 1, 1]);
  const one = r.lines.find((l) => l.family === "FMC_A_One")!;
  assert.equal(one.ok, true);
  assert.equal(one.gate, "Pass");
  assert.deepEqual(readBatchResults(path.join(dir, "none.jsonl")).lines, []);
});

test("F-063: a batch is named by its local start minute", () => {
  assert.equal(batchId(new Date(2026, 9, 18, 9, 5)), "B-20261018-0905");
});
