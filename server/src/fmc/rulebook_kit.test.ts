import { test } from "node:test";
import assert from "node:assert/strict";
import { QaFacts, mergeRulebooks, neededParameters, runQa } from "./rules.js";

// Kit rulebook schema v0.1 (03_Master_Data\FMC_Rulebook), with rules as the kit writes them (F-017).
const kitBook = {
  feature: "Sample", rulebook_version: "0.1-draft", kit_version: "2.2", sources: [],
  rules: [
    { id: "NAM-021", title: "View name", rule: "Views are named [Role]_[ViewType]_[Level/Zone]_[Purpose].", applies_to: ["views"], stages: "all", severity: "warning",
      check: { type: "naming_regex", params: { regex: "^(?:A|S|Z)_[A-Za-z0-9]+_[A-Za-z0-9]+(_[A-Za-z0-9]+)*$", examples: ["A_FP_L01_General"] } }, auto_fix: false, clause: "MAN 4.3", status: "from_standard" },
    { id: "NAM-022", title: "Working view prefix", rule: "Working views not on sheets start with WIP_.", applies_to: ["views"], stages: "all", severity: "info",
      check: { type: "naming_regex", params: { regex: "^WIP_" } }, auto_fix: false, clause: "MAN 4.3", status: "from_standard" },
    { id: "SHT-001", title: "Sheet number pattern", rule: "Every sheet number is [Role]-[4 digits].", applies_to: ["sheets"], stages: "all", severity: "error",
      check: { type: "naming_regex", params: { regex: "^(Z|A|S)-\\d{4}$", roles: ["Z", "A", "S"] } }, auto_fix: false, clause: "STD 2.1", status: "from_standard" },
    { id: "SHT-022", title: "Sheet parameters", rule: "Each sheet fills FMC_Sheet_Role and FMC_Sheet_Status.", applies_to: ["sheets"], stages: "all", severity: "error",
      check: { type: "parameter_present", params: { required: ["FMC_Sheet_Role", "FMC_Sheet_Status"] } }, auto_fix: false, clause: "STD 2.4", status: "from_standard" },
    { id: "FAM-004", title: "Generic Model only as last resort", rule: "…", applies_to: ["OST_GenericModel"], stages: "all", severity: "warning",
      check: { type: "parameter_present", params: { required: ["Keynote"] } }, auto_fix: false, clause: "MAN 9.2", status: "from_standard" },
    { id: "QA-002", title: "Warnings", rule: "Amber at 100, red at 300.", applies_to: ["models"], stages: "all", severity: "warning",
      check: { type: "count_min", params: { metric: "warnings total", amber_at: 100, red_at: 300 } }, auto_fix: false, clause: "MAN 14.2", status: "from_standard" },
    { id: "LNK-013", title: "Acquire coordinates", rule: "…", applies_to: ["links"], stages: "all", severity: "error",
      check: { type: "human_gate", params: { owner: "Discipline Lead" } }, auto_fix: false, clause: "MAN 8.4", status: "from_standard" },
    { id: "ANN-001", title: "Arial only", rule: "…", applies_to: ["text"], stages: "all", severity: "error",
      check: { type: "text_style", params: { font: "Arial" } }, auto_fix: true, clause: "STD 3.3", status: "from_standard" },
    { id: "ANN-026", title: "Stage 2 density", rule: "…", applies_to: ["views"], stages: ["2"], severity: "info",
      check: { type: "count_min", params: { tags: ["OST_Rooms"] } }, auto_fix: true, clause: null, status: "proposed" },
    { id: "SHT-030", title: "Stage 4 set", rule: "…", applies_to: ["sheets"], stages: ["4", "5"], severity: "error",
      check: { type: "parameter_present", params: { parameter: "FMC_Issue_Set" } }, auto_fix: false, clause: null, status: "from_standard" },
  ],
};

const facts: QaFacts = {
  model: "Project1",
  views: [{ id: 1, name: "A_FP_L01_General", type: "FloorPlan", template: false }, { id: 2, name: "Level 1", type: "FloorPlan", template: false }],
  sheets: [{ id: 10, number: "A-1001", name: "GA", parameters: { FMC_Sheet_Role: "A", FMC_Sheet_Status: "S2", FMC_Issue_Set: "" } },
           { id: 11, number: "A101", name: "Old", parameters: { FMC_Sheet_Role: "", FMC_Sheet_Status: "S2", FMC_Issue_Set: "" } }],
  types: [{ id: 20, family: "Generic", name: "Box", category: "Generic Models", bic: "OST_GenericModel", parameters: { Keynote: "" } }],
  families: [], links: [], warnings: 120,
};

test("kit schema v0.1: severity error/warning/info, status, stages, feature and version read as the kit writes them", () => {
  const b = mergeRulebooks([{ name: "FMC_Rulebook_Sample.json", json: kitBook }]);
  assert.deepEqual(b.books, [{ name: "Sample", version: "0.1-draft", count: 10 }]);
  const by = Object.fromEntries(b.rules.map((r) => [r.id, r]));
  assert.equal(by["SHT-001"].severity, "Must");
  assert.equal(by["NAM-021"].severity, "Should");
  assert.equal(by["NAM-022"].severity, "Advice");
  assert.equal(by["ANN-026"].status, "Proposed");
  assert.deepEqual(by["SHT-030"].stages, ["4", "5"]);
  assert.deepEqual(by["NAM-021"].stages, []);
  assert.equal(by["NAM-021"].rule, "View name");
  assert.equal(by["SHT-001"].why, "STD 2.1");
});

test("check types bind only where the kit's data is unambiguous; the rest says why", () => {
  const by = Object.fromEntries(mergeRulebooks([{ name: "x.json", json: kitBook }]).rules.map((r) => [r.id, r]));
  assert.equal(by["NAM-021"].check?.kind, "view_name_pattern");
  assert.equal(by["NAM-022"].check, undefined);
  assert.match(by["NAM-022"].not_runnable!, /doesn't show what its pattern names/);
  assert.equal(by["SHT-001"].check?.kind, "sheet_number_pattern");
  assert.equal(by["SHT-022"].check?.kind, "sheet_parameters_filled");
  assert.deepEqual(by["FAM-004"].check?.categories, ["OST_GenericModel"]);
  assert.equal(by["QA-002"].check?.kind, "health_count");
  assert.equal(by["LNK-013"].human, true);
  assert.match(by["ANN-001"].not_runnable!, /check type "text_style"/);
  assert.deepEqual(neededParameters(Object.values(by)).sheet.sort(), ["FMC_Issue_Set", "FMC_Sheet_Role", "FMC_Sheet_Status"]);
});

test("QA runs the bound kit rules on the model", () => {
  const q = runQa(mergeRulebooks([{ name: "x.json", json: kitBook }]), facts, "wip_to_shared", "2026-10-14");
  const by = Object.fromEntries(q.results.map((r) => [r.id, r]));
  assert.equal(by["NAM-021"].state, "Fail");
  assert.deepEqual(by["NAM-021"].element_ids, [2]);
  assert.deepEqual(by["SHT-001"].element_ids, [11]);
  assert.deepEqual(by["SHT-022"].element_ids, [11]);
  assert.equal(by["FAM-004"].state, "Fail");
  assert.equal(by["QA-002"].state, "Warning");
  assert.equal(by["SHT-030"].state, "Not applicable");
  assert.equal(by["ANN-026"], undefined); // proposed: listed in Rules, never run
  assert.equal(q.verdict, "Blocked");
});

test("F-018: nothing checked, or Must rules not checked, is never a clear gate", () => {
  const onlyUnrunnable = { ...kitBook, rules: kitBook.rules.filter((r) => ["LNK-013", "ANN-001", "NAM-022"].includes(r.id)) };
  const none = runQa(mergeRulebooks([{ name: "x.json", json: onlyUnrunnable }]), facts, "wip_to_shared", "2026-10-14");
  assert.equal(none.verdict, "Not clear");
  assert.equal(none.clear, false);
  assert.match(none.summary, /^Not clear: nothing was checked/);

  const passing = { ...facts, views: [facts.views[0]], sheets: [facts.sheets[0]], types: [], warnings: 0 };
  const some = runQa(mergeRulebooks([{ name: "x.json", json: kitBook }]), passing, "wip_to_shared", "2026-10-14");
  assert.equal(some.verdict, "Not clear");
  assert.match(some.summary, /2 Must rules weren't checked \(1 need a person, 1 have no check the plugin runs yet\)/);

  const clearBook = { ...kitBook, rules: kitBook.rules.filter((r) => ["SHT-001", "SHT-022", "NAM-021"].includes(r.id)) };
  const clear = runQa(mergeRulebooks([{ name: "x.json", json: clearBook }]), passing, "wip_to_shared", "2026-10-14");
  assert.equal(clear.verdict, "Clear");
  assert.equal(clear.clear, true);
});

test("stage rules run at their stage only", () => {
  const q = runQa(mergeRulebooks([{ name: "x.json", json: kitBook }]), facts, "wip_to_shared", "2026-10-14", "4");
  assert.equal(q.results.find((r) => r.id === "SHT-030")!.state, "Fail");
});
