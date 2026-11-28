import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { KIT_REGISTER_NAME, SHEET_REGISTER_NOT_FOUND, kitRegisterPath, registerMissingBody, resolveRegister } from "./sheetregister.js";
import { FMC_SHEETS_SHAPE, runFmcSheets } from "../tools/fmc_sheets.js";
import { FMC_ISSUE_SHAPE, runFmcIssue } from "../tools/fmc_issue.js";
import { FMC_TREE_SHAPE, TREE_NONE, noTreeBody, runFmcTree } from "../tools/fmc_tree.js";

const cfg = { specs_path: "Z:\\00_Standards\\03_Master_Data\\FMC_Family_Specs.json" };
const KIT = "Z:\\00_Standards\\03_Master_Data\\FMC_Sheet_Register.csv";

test("(ii) the default register is the kit's FMC_Sheet_Register.csv beside the family specs", () => {
  assert.equal(kitRegisterPath(cfg), KIT);
  assert.equal(KIT.endsWith(KIT_REGISTER_NAME), true);
});

test("(ii) resolveRegister: a passed register wins; none passed uses the kit default; blank counts as none", () => {
  const all = () => true, none = () => false;
  assert.deepEqual(resolveRegister("C:\\P\\reg.xlsx", cfg, all), { file: "C:\\P\\reg.xlsx", source: "argument", exists: true });
  assert.deepEqual(resolveRegister(undefined, cfg, all), { file: KIT, source: "kit default", exists: true });
  assert.deepEqual(resolveRegister("   ", cfg, none), { file: KIT, source: "kit default", exists: false });
  assert.deepEqual(resolveRegister("C:\\P\\gone.csv", cfg, none), { file: "C:\\P\\gone.csv", source: "argument", exists: false });
});

test("(ii) registerMissingBody names the path and a code, never an empty path", () => {
  const body = registerMissingBody({ file: KIT, source: "kit default", exists: false });
  assert.equal(body.code, SHEET_REGISTER_NOT_FOUND);
  assert.equal(body.register, KIT);
  assert.match(body.reasons[0], /FMC-SHEET-REGISTER-NOT-FOUND/);
  assert.ok(body.reasons[0].includes(KIT));
  assert.match(body.reasons[0], /No register was passed/);
  assert.doesNotMatch(body.reasons[0], /not found: \./);
  assert.match(registerMissingBody({ file: "C:\\x.csv", source: "argument", exists: false }).reasons[0], /you passed/);
});

test("(ii) fmc_sheets compare and fmc_issue check without a register refuse with the expected path (no kit register here)", async () => {
  const sheets = await runFmcSheets(z.object(FMC_SHEETS_SHAPE).parse({ action: "compare" }));
  assert.equal(sheets.isError, true);
  const sb = JSON.parse(sheets.content[0].text);
  assert.equal(sb.code, "FMC-SHEET-REGISTER-NOT-FOUND");
  assert.ok(String(sb.register).endsWith("FMC_Sheet_Register.csv"), sb.register);
  assert.equal(sb.register_source, "kit default");

  const issue = await runFmcIssue(z.object(FMC_ISSUE_SHAPE).parse({ action: "check" }));
  assert.equal(issue.isError, true);
  const ib = JSON.parse(issue.content[0].text);
  assert.equal(ib.code, "FMC-SHEET-REGISTER-NOT-FOUND");
  assert.ok(String(ib.register).endsWith("FMC_Sheet_Register.csv"), ib.register);
});

test("(ii) a register that was passed but is missing is named as such", async () => {
  const r = await runFmcSheets(z.object(FMC_SHEETS_SHAPE).parse({ action: "compare", register: path.join("/nonexistent", "reg.csv") }));
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.register_source, "argument");
  assert.ok(body.reasons[0].includes("reg.csv"));
});

test("(iii) fmc_tree show with no tree says how to create one, with a code", async () => {
  const body = noTreeBody("C:\\P\\01_WIP\\_Tree\\FMC_Recipe_Tree.json", "C:\\P");
  assert.equal(body.code, TREE_NONE);
  assert.equal(body.code, "FMC-TREE-NONE");
  assert.equal(body.create.length, 2);
  assert.match(body.create[0], /"action":"init"/);
  assert.match(body.create[1], /"action":"brief"/);
  assert.ok(body.create.every((c) => c.includes('"project_folder":"C:\\\\P"')));
  const res = await runFmcTree(z.object(FMC_TREE_SHAPE).parse({ action: "show", project_folder: "C:\\NoSuchProject" }));
  assert.equal(res.isError, true);
  const got = JSON.parse(res.content[0].text);
  assert.equal(got.code, "FMC-TREE-NONE");
  assert.ok(got.create.length === 2);
});

// (i) is on the Revit side: no C# test host without the Revit API, so pin the source.
test("(i) fmc_issue_facts handles per-sheet revision numbering instead of throwing", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.resolve(here, "..", "..", "..", "commandset", "Services", "Fmc", "FmcIssueEventHandler.cs"), "utf8");
  assert.match(src, /RevisionSettings\.GetRevisionSettings\(doc\)\.RevisionNumbering == RevisionNumbering\.PerSheet/);
  assert.match(src, /GetRevisionNumberOnSheet/, "per-sheet numbers come from the sheet");
  assert.match(src, /\["revision_numbering"\] = perSheet \? "per_sheet" : "per_project"/);
  assert.match(src, /catch \(InvalidOperationException\)/, "GetCurrentRevision's per-sheet exception is handled");
  // the project-wide calls are only reached when numbering is per project
  const current = src.slice(src.indexOf("private static string CurrentRevisionNumber"), src.indexOf("private static JObject Facts"));
  assert.match(current, /if \(!perSheet\)[\s\S]*GetCurrentRevision\(\)/);
  const facts = src.slice(src.indexOf("private static JObject Facts"), src.indexOf("private JObject Export"));
  assert.doesNotMatch(facts, /\(doc\.GetElement\(s\.GetCurrentRevision\(\)\)/, "Facts no longer calls GetCurrentRevision directly");
  assert.doesNotMatch(facts, /\["number"\] = r\.RevisionNumber/, "the project revision number is read through SafeNumber");
  assert.match(facts, /catch \(Exception\) \{ current = ""; \}/, "one sheet never fails the read");
});
