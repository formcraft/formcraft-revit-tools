import { test } from "node:test";
import assert from "node:assert/strict";
import { QaFacts, mergeRulebooks, neededParameters, parseRulebook, qaReport, runQa, runRule, trend } from "./rules.js";

const naming = {
  rulebook: "Naming", version: "0.2",
  rules: [
    { id: "NAM-012", rule: "View name pattern", severity: "Must", status: "Standard", gates: ["wip_to_shared"],
      fix_hint: "Rename to A_FP_Lxx_Purpose", check: { kind: "view_name_pattern", pattern: "^[A-Z]{1,2}_[A-Z]{2}_" , view_types: ["FloorPlan"] } },
    { id: "NAM-020", title: "Families follow the naming rule", severity: "should", source: "standard",
      check: { kind: "family_name_pattern", pattern: "^(FMC|[A-Z0-9]{2,6})_" } },
  ],
};
const qa = {
  rulebook: "QA", version: "0.2",
  rules: [
    { id: "QA-011", rule: "Type without a code", severity: "Must", check: { kind: "type_parameter_filled", parameter: "Keynote", categories: ["Doors"] } },
    { id: "SHT-022", rule: "Sheet parameter empty", severity: "Should", check: { kind: "sheet_parameter_filled", parameter: "FMC_Sheet_Status" } },
    { id: "QA-040", rule: "Warnings under 300", severity: "Should", gates: ["weekly"], check: { kind: "max_count", metric: "warnings", max: 300 } },
    { id: "QA-050", rule: "Coordinates shared", severity: "Must", check: { kind: "survey_point_shared" } },
    { id: "ANN-030", rule: "Tags never overlap", severity: "Should", status: "Proposed" },
    { id: "QA-060", rule: "Model reviewed by a lead", severity: "Advice" },
  ],
  exceptions: [{ rule: "SHT-022", where: "A-2001", approved_by: "[NAME A]", until: "2099-01-01", reason: "Issued sheet" }],
  decisions: [{ text: "Stages: gates and issue sets drive; RIBA a label", state: "decided" }],
};

const facts: QaFacts = {
  model: "F26001-FMC-ZZ-ZZ-M3-A-0001.rvt",
  views: [{ id: 1, name: "A_FP_L01_General", type: "FloorPlan", template: false }, { id: 2, name: "Level 1", type: "FloorPlan", template: false },
          { id: 3, name: "3D", type: "ThreeD", template: false }],
  sheets: [{ id: 10, number: "A-1001", name: "Plan", parameters: { FMC_Sheet_Status: "S2" } }, { id: 11, number: "A-2001", name: "Sections", parameters: { FMC_Sheet_Status: "" } }],
  types: [{ id: 20, family: "Door", name: "900", category: "Doors", parameters: { Keynote: "" } }, { id: 21, family: "Wall", name: "W1", category: "Walls", parameters: {} }],
  families: [{ id: 30, name: "FMC_A_Door_Single", in_place: false }, { id: 31, name: "Vendor door", in_place: false }],
  links: [], warnings: 120,
};

const books = mergeRulebooks([{ name: "FMC_Rules_Naming.json", json: naming }, { name: "FMC_Rules_QA.json", json: qa }]);

test("rulebooks read tolerantly: title, lower-case severity, source", () => {
  assert.equal(books.rules.length, 8);
  const r = books.rules.find((x) => x.id === "NAM-020")!;
  assert.equal(r.rule, "Families follow the naming rule");
  assert.equal(r.severity, "Should");
  assert.deepEqual(books.books.map((b) => `${b.name} ${b.count}`), ["Naming 2", "QA 6"]);
  assert.equal(books.decisions.length, 1);
});

test("a duplicated rule id is reported, not doubled", () => {
  const twice = mergeRulebooks([{ name: "a.json", json: naming }, { name: "b.json", json: naming }]);
  assert.equal(twice.rules.length, 2);
  assert.match(twice.problems.join(" "), /NAM-012 is in more than one rulebook/);
  assert.match(parseRulebook("x.json", { rules: [{ rule: "no id" }] }, twice.problems).name, /x/);
});

test("check kinds find the failing elements", () => {
  const r = (id: string) => runRule(books.rules.find((x) => x.id === id)!, facts);
  assert.deepEqual([r("NAM-012").state, r("NAM-012").element_ids], ["Fail", [2]]);
  assert.deepEqual([r("QA-011").state, r("QA-011").where], ["Fail", "1 types"]);
  assert.deepEqual(r("NAM-020").element_ids, [31]);
  assert.equal(r("QA-040").state, "Pass");
  assert.equal(r("QA-050").state, "Not checked");
  assert.equal(r("QA-060").state, "Not checked");
});

test("a gate runs its rules plus rules with no gate, never proposed ones; exceptions mark failures", () => {
  const q = runQa(books, facts, "wip_to_shared", "2026-10-14");
  const ids = q.results.map((x) => x.id);
  assert.ok(!ids.includes("QA-040"));
  assert.ok(!ids.includes("ANN-030"));
  assert.equal(q.results[0].state, "Fail");
  assert.deepEqual(q.blocking.sort(), ["NAM-012", "QA-011"]);
  assert.match(q.results.find((x) => x.id === "SHT-022")!.excepted!, /A-2001/);
  assert.match(q.summary, /2 Must rules block the move/);
  assert.match(qaReport(q, new Date("2026-10-14T10:42:00Z")), /\| NAM-012 \| View name pattern \| Must \| Fail \|/);
});

test("only the parameters the rules need are read", () => {
  assert.deepEqual(neededParameters(books.rules), { sheet: ["FMC_Sheet_Status"], type: ["Keynote"] });
});

test("trend: new, recurring and resolved against the last run", () => {
  assert.deepEqual(trend(["A", "B"], ["B", "C", "D"]), { new: 2, recurring: 1, resolved: 1 });
  assert.deepEqual(trend(null, ["A"]), { new: 1, recurring: 0, resolved: 0 });
});
