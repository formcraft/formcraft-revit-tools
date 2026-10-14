import { test } from "node:test";
import assert from "node:assert/strict";
import { qaDigest, rulebooksDigest, worstFamilies } from "./digest.js";
import { FamilyVerdict } from "./library.js";
import { RuleResult, mergeRulebooks } from "./rules.js";

test("F-009: a scan summary lists the worst families with only what they fail", () => {
  const v = (name: string, score: number, state: FamilyVerdict["state"]): FamilyVerdict => ({
    name, category: "Doors", from: "Loaded", score, state, next: "",
    checks: [{ check: "Name", state: score < 100 ? "fail" : "pass", detail: "x", fixable: true }, { check: "Keynote", state: "pass", detail: "", fixable: true }],
  });
  const all = [...Array.from({ length: 340 }, (_, i) => v(`OK${i}`, 100, "Compliant")),
    v("F90", 90, "Fixable"), v("F10", 10, "Needs a person"), v("F50", 50, "Fixable"), v("F20", 20, "Fixable"), v("F70", 70, "Fixable"), v("F30", 30, "Fixable")];
  const w = worstFamilies(all, 5);
  assert.equal(w.length, 5);
  assert.deepEqual(w.map((x) => x.score), [10, 20, 30, 50, 70]);
  assert.deepEqual(w[0].failing, ["Name: x"]);
  assert.ok(JSON.stringify(w).length < 2000);
});

test("F-009: a QA summary keeps what needs attention and groups why rules weren't checked", () => {
  const r = (id: string, state: RuleResult["state"], where = "", severity: RuleResult["severity"] = "Must"): RuleResult =>
    ({ id, rule: id, severity, state, where, element_ids: [1, 2], fix_hint: "" });
  const results = [r("A", "Fail", "2 views"), r("B", "Warning", "120 warnings", "Should"),
    ...Array.from({ length: 200 }, (_, i) => r(`N${i}`, "Not checked", i % 2 ? "A person confirms this (human gate)" : `The plugin doesn't run check type "other" yet`)),
    r("P", "Pass")];
  const d = qaDigest(results, 15);
  assert.deepEqual(d.attention.map((x) => x.id), ["A", "B"]);
  assert.equal(d.attention[0].elements, 2);
  assert.equal(d.not_checked_by_reason.length, 2);
  assert.equal(d.not_checked_by_reason[0].count, 100);
  assert.equal(d.not_checked_by_reason[0].examples.length, 5);
});

test("the rulebooks in brief", () => {
  const b = mergeRulebooks([{ name: "x.json", json: { feature: "X", rulebook_version: "0.1", rules: [
    { id: "A", severity: "error", status: "from_standard", check: { type: "human_gate", params: {} } },
    { id: "B", severity: "info", status: "proposed", check: { type: "other", params: {} } },
  ] } }]);
  const d = rulebooksDigest(b);
  assert.deepEqual(d.by_severity, { Must: 1, Advice: 1 });
  assert.deepEqual(d.runs, { "a person confirms": 1, "proposed (listed, not run)": 1 });
});
