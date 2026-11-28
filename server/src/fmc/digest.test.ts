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

test("F-010: the scan summary counts families a check couldn't run apart from passes", async () => {
  const { summarise } = await import("./library.js");
  const s = summarise([
    { name: "A", category: "Doors", from: "Loaded", score: 50, state: "Needs a person", next: "",
      checks: [{ check: "Required FMC parameters present (by GUID)", state: "na", detail: "", fixable: false }] },
    { name: "B", category: "Doors", from: "Loaded", score: 100, state: "Compliant", next: "",
      checks: [{ check: "Required FMC parameters present (by GUID)", state: "pass", detail: "", fixable: true }] },
  ]);
  const line = s.by_check.find((c) => c.check === "Required FMC parameters present (by GUID)")!;
  assert.deepEqual([line.fail, line.pass, line.not_checked], [0, 1, 1]);
});

test("QA-5/QA-6/QA-7: pick rules, compare with the last full run, name the fixing tool, order unlocks by Must rules", async () => {
  const { compareWithLast, fixTool, pickRules, unlockOrder } = await import("./qafix.js");
  const rule = (id: string, book: string, severity: "Must" | "Should" | "Advice", text: string, kind?: string) =>
    ({ id, rule: text, severity, status: "Active", book, scope: "", test: "", fix_hint: "", version: "", why: "", gates: [], stages: [], ...(kind ? { check: { kind } } : {}) });
  const books = { books: [], exceptions: [], decisions: [], problems: [], rules: [
    rule("NAM-020", "Naming", "Must", "Sheet numbers follow the pattern", "sheet_number_pattern"),
    rule("NAM-021", "Naming", "Should", "Keynotes use kit codes"),
    rule("LNK-001", "Links", "Must", "Links are pinned", "links_pinned"),
    rule("GEN-001", "General", "Advice", "Something with no tool"),
  ] } as any;
  assert.deepEqual(pickRules(books, { rules: ["nam-020"] }).books.rules.map((r: any) => r.id), ["NAM-020"]);
  assert.deepEqual(pickRules(books, { book: "naming", severity: "Should" }).books.rules.map((r: any) => r.id), ["NAM-021"]);
  assert.deepEqual(pickRules(books, { rules: ["XX-1"] }).unknown, ["XX-1"]);
  assert.equal(pickRules(books, {}).picked, false);
  assert.deepEqual(compareWithLast(["NAM-020", "LNK-001"], ["NAM-021"], ["NAM-020", "NAM-021"]), { last_run: true, fixed: ["NAM-020"], still_failing: [], new_failing: ["NAM-021"] });
  assert.equal(fixTool(books.rules[0]), "fmc_sheets");
  assert.equal(fixTool(books.rules[1]), "fmc_keynote_place");
  assert.equal(fixTool(books.rules[2]), "fmc_links");
  assert.equal(fixTool(books.rules[3]), null);
  const nc = (id: string, severity: "Must" | "Should", where: string) => ({ id, rule: "", severity, state: "Not checked" as const, where, element_ids: [], fix_hint: "" });
  const order = unlockOrder([nc("A", "Should", "doesn't read worksets"), nc("B", "Should", "doesn't read worksets"), nc("C", "Must", "doesn't read filters")]);
  assert.equal(order[0].reason, "doesn't read filters");
  assert.equal(order[0].must_unlocked, 1);
  assert.equal(order[1].rules_unlocked, 2);
});
