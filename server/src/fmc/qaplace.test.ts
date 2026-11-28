import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type GuardConfig } from "./policy.js";
import { QA_DOCUMENT_MISMATCH, QA_PROJECT_FOLDER_REFUSED, qaDocumentMismatch, qaEvaluated, qaReportPlace } from "./qaplace.js";
import { qaFacts, runQa, mergeRulebooks } from "./rules.js";

const cfg = {
  ...DEFAULT_CONFIG, reports_dir: "C:\\Users\\USER\\FMC_Reports", write_roots: ["C:\\Users\\USER\\agent-tools", "C:\\Users\\USER\\FMC_Reports"], blocked_segments: ["05_published"],
} as GuardConfig;
const name = "FMC_QA_architectural_USER_20261128-0930.md";

test("fmc_qa run: the document asked for must be the one Revit answered for", () => {
  assert.equal(qaDocumentMismatch(undefined, "plumbing_USER"), null, "no document named: the active one answers");
  assert.equal(qaDocumentMismatch("", "plumbing_USER"), null);
  assert.equal(qaDocumentMismatch("plumbing_USER", "plumbing_USER"), null);
  assert.equal(qaDocumentMismatch("C:\\Users\\USER\\Documents\\plumbing_USER.rvt", "plumbing_USER"), null, "a full path names the same document as its title");
  assert.equal(qaDocumentMismatch("PLUMBING_user", "plumbing_USER"), null);
  const bad = qaDocumentMismatch("electrical_USER", "plumbing_USER");
  assert.equal(bad?.code, QA_DOCUMENT_MISMATCH);
  assert.equal(bad?.code, "FMC-QA-DOCUMENT-MISMATCH");
  assert.match(bad!.message, /electrical_USER.*plumbing_USER/);
  assert.equal(qaDocumentMismatch("C:\\x\\architectural_USER.rvt", "Project1")?.code, QA_DOCUMENT_MISMATCH);
});

test("fmc_qa run says what it evaluated, so identical counts on different models can be told apart", () => {
  const a = qaFacts({ model: "plumbing_USER", views: [{}, {}], sheets: [{}], types: [{}, {}, {}], families: [], links: [], warnings: 4 });
  const b = qaFacts({ model: "Project1", views: [{}], sheets: [], types: [], families: [{}], links: [{}], warnings: 0 });
  assert.deepEqual(qaEvaluated(a), { model: "plumbing_USER", views: 2, sheets: 1, types: 3, families: 0, links: 0, warnings: 4 });
  assert.deepEqual(qaEvaluated(b), { model: "Project1", views: 1, sheets: 0, types: 0, families: 1, links: 1, warnings: 0 });
  // and the rules are applied to each document's own facts: different facts, different results
  const books = mergeRulebooks([{ name: "r.json", json: { rules: [
    { id: "R1", rule: "few warnings", severity: "Must", status: "Active", gates: [], check: { kind: "max_count", metric: "warnings", max: 2 } },
  ] } }]);
  const ra = runQa(books, a, "wip_to_shared", "2026-11-28");
  const rb = runQa(books, b, "wip_to_shared", "2026-11-28");
  assert.equal(ra.model, "plumbing_USER");
  assert.equal(rb.model, "Project1");
  assert.deepEqual([ra.fail, ra.pass], [1, 0], "plumbing_USER has 4 warnings");
  assert.deepEqual([rb.fail, rb.pass], [0, 1], "Project1 has none");
});

test("project_folder is honoured when the guard allows it: <project_folder>\\06_QA\\Health", () => {
  const place = qaReportPlace("C:\\Users\\USER\\agent-tools\\Ogala", cfg, name);
  assert.equal(place.report, `C:\\Users\\USER\\agent-tools\\Ogala\\06_QA\\Health\\${name}`);
  assert.deepEqual(place.project_folder, { requested: "C:\\Users\\USER\\agent-tools\\Ogala", honoured: true });
  assert.match(place.location, /project_folder/);
});

test("project_folder the guard refuses is said out loud, with FMC-QA-PROJECT-FOLDER-REFUSED and the reasons, not dropped", () => {
  for (const folder of ["D:\\Fomcraft\\Ogala", "C:\\Users\\USER\\agent-tools\\P\\05_Published", "relative\\folder"]) {
    const place = qaReportPlace(folder, cfg, name);
    assert.equal(place.report, `C:\\Users\\USER\\FMC_Reports\\QA\\${name}`, folder);
    assert.equal(place.project_folder?.honoured, false, folder);
    assert.equal(place.project_folder?.code, QA_PROJECT_FOLDER_REFUSED);
    assert.equal(place.project_folder?.requested, folder);
    assert.ok((place.project_folder?.reasons ?? []).length > 0, folder);
    assert.match(place.location, /project_folder refused/);
  }
});

test("with no project_folder the report goes to the reports folder and says so", () => {
  for (const folder of [undefined, "", "   "]) {
    const place = qaReportPlace(folder, cfg, name);
    assert.equal(place.report, `C:\\Users\\USER\\FMC_Reports\\QA\\${name}`);
    assert.equal(place.project_folder, undefined);
    assert.match(place.location, /no project_folder given/);
  }
});

test("fmc_qa run uses them: refuses a mismatch, reports evaluated, document and where the report went", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.resolve(here, "..", "..", "src", "tools", "fmc_qa.ts"), "utf8");
  assert.match(src, /documentTarget\.getStore\(\)/);
  assert.match(src, /qaDocumentMismatch\(requested, facts\.model\)/);
  assert.match(src, /qaReportPlace\(args\.project_folder, config, name\)/);
  assert.match(src, /evaluated: qaEvaluated\(facts\)/);
  assert.match(src, /\.\.\.where/);
  assert.doesNotMatch(src, /win\.join\(args\.project_folder/, "no silent fallback any more");
});
