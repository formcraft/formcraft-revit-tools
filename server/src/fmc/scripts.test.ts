import { test } from "node:test";
import assert from "node:assert/strict";
import { readDynamo, readPyRevit, readTool, stepSummary } from "./scripts.js";

const dyn = [
  "# FMC_ModelHealth  -  Dynamo Python Script node (CPython3 / PythonNet3)",
  "# Formcraft kit v2.2  |  Manual Part 14.2",
  "#",
  "# Measures the model against the BEP thresholds and writes one CSV row per",
  "# metric with a Red / Amber / Green result.",
  "#",
  "# Inputs (mark \"Is Input\" for Dynamo Player):",
  "#   IN[0]  String - output folder (project 03_QA\\Health)",
  "#   IN[1]  String - full path to FMC_Master_Data.json",
  "# Written for Revit 2025 / 2026 with Dynamo 3.x. Not yet run on a Formcraft build:",
  "import clr",
].join("\n");

test("a Dynamo node is read from its own header: name, what it does, inputs, status", () => {
  const s = readDynamo("K:\\05_Scripts\\Dynamo\\FMC_ModelHealth.py", dyn);
  assert.equal(s.name, "FMC_ModelHealth");
  assert.match(s.does, /^Measures the model against the BEP thresholds .* Green result\.$/);
  assert.equal(s.inputs.length, 2);
  assert.match(s.inputs[0], /^IN\[0\] String - output folder/);
  assert.equal(s.status, "Pilot test before production");
  assert.equal(s.manual, "Manual Part 14.2");
  assert.equal(s.changes_model, false);
  assert.equal(s.formcraft, "Check › QA");
});

test("a pyRevit button: bundle title, docstring, its status line, and whether it opens a Transaction", () => {
  const bundle = 'title: "Create Sheets from Register"\ntooltip: "Formcraft kit v2.2 - see FMC-BIM-STD-002. Always dry-run first."\n';
  const script = '"""FMC_CreateSheetsFromRegister - creates a role\'s Formcraft sheet set.\nFMC-BIM-STD-002 2 | kit v2.2 | Status: PILOT-TEST before production (Manual Part 17).\n\nFor each register row it creates a sheet.\n"""\nt = Transaction(doc, "x")\n';
  const s = readPyRevit("K:\\FMC.tab\\Standards.panel\\2_CreateSheets.pushbutton", bundle, script);
  assert.equal(s.name, "FMC_CreateSheetsFromRegister");
  assert.equal(s.status, "PILOT-TEST before production (Manual Part 17)");
  assert.equal(s.changes_model, true);
  assert.equal(s.runs_in, "pyRevit › FMC tab › Create Sheets from Register");
  assert.match(s.formcraft, /Drawings › Sheets/);
});

test("a tool without a status line says so instead of guessing", () => {
  const s = readTool("K:\\tools\\fmc_boq_build.py", '#!/usr/bin/env python3\n"""Formcraft BoQ builder  (Manual Part 11)\n\nTurns QTO CSVs into a workbook."""');
  assert.equal(s.does, "Formcraft BoQ builder  (Manual Part 11)");
  assert.equal(s.status, "Not stated in the file");
  assert.equal(s.manual, "Manual Part 11");
});

test("step summaries come from the tools' own replies", () => {
  assert.equal(stepSummary("selftest", { result: "Fix first", pass: 9, warn: 1, fail: 2 }), "Fix first: 9 pass, 1 warn, 2 fail");
  assert.equal(stepSummary("qa", { verdict: "Blocked", fail: 3, warning: 5 }), "Blocked: 3 fail, 5 warnings");
  assert.equal(stepSummary("review", { count: 7, overdue: 1 }), "7 open items, 1 overdue");
  assert.equal(stepSummary("links", { refused: true, reasons: ["No Revit"] }), "No Revit");
  assert.equal(stepSummary("annotate", { checks: [{ state: "Fail" }, { state: "Pass" }] }), "1 of 2 checks fail");
});
