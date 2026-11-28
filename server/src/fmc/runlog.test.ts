import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatRows, summariseLog, summarisePath, summariseResult } from "./runlog.js";

test("a run log and a result folder become one pass/fail line per batch", () => {
  const lines = summariseLog([
    "B09 PASS ops=40 ok=40 failed=0",
    "B10 FAIL ops=12 ok=9 failed=3 code=FMC-BATCH-LOCKED",
    "noise",
  ].join("\n"), "RUN_ALL_log.txt");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].batch_id, "B09");
  assert.equal(lines[0].failed, 0);
  assert.equal(lines[1].codes.includes("FMC-BATCH-LOCKED"), true);
  const json = summariseResult({
    batch_id: "B11",
    ops: [{ op: "wall", ok: true }, { op: "door", ok: false, code: "FMC-SHEETS-NO-FIT" }],
  }, "B11.json");
  assert.equal(json[0].ops, 2);
  assert.equal(json[0].ok, 1);
  assert.equal(json[0].failed, 1);
  assert.deepEqual(json[0].codes, ["FMC-SHEETS-NO-FIT"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-runlog-"));
  fs.writeFileSync(path.join(dir, "RUN_ALL_log.txt"), "B09 PASS ops=4 ok=4 failed=0\n");
  fs.writeFileSync(path.join(dir, "B10.json"), JSON.stringify({ batch_id: "B10", ops: 2, ok: 1, failed: 1, codes: ["FMC-BATCH-LOCKED"] }));
  const summary = summarisePath(dir);
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.rows.length, 2);
  assert.match(formatRows(summary.rows), /PASS B09/);
  assert.match(formatRows(summary.rows), /FAIL B10/);
});
// F124 fix (28 Nov): the real RUN_ALL_log.txt is sectioned ("==== job"), not one line per batch, and a result JSON is
// { label, steps: [...] }. These read fixtures laid out like the 23 Nov F26901 night run.
const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/fmc/fixtures/runlog");

test("a sectioned RUN_ALL_log.txt gives one row per job with real op counts", () => {
  const text = fs.readFileSync(path.join(FIX, "RUN_ALL_log.sample.txt"), "utf8");
  const rows = summariseLog(text, "RUN_ALL_log.txt");
  assert.deepEqual(rows.map((r) => r.batch_id), ["runner-A-tags", "runner-E-keynotes-plugin", "runner-A-dims", "runner-export-pdfs"]);
  assert.deepEqual(rows.map((r) => r.name), ["B03_A_door_window_room_tags", "B02_E_keynote_tags_and_legend", "D1_A_dims_plans", "B09_export_PDFs_v2"]);
  // B03: preview send_code, apply send_code, verify fmc_health = 3 tool calls
  assert.deepEqual([rows[0].ops, rows[0].ok, rows[0].failed], [3, 3, 0]);
  assert.equal(rows[0].document, "F26901-FMC-ZZ-ZZ-M3-A-0002_USER");
  // B02: 2 ops in the preview, the apply replied applied:false with a reason (skipped), 1 op in the verify
  assert.deepEqual([rows[1].ops, rows[1].ok, rows[1].failed, rows[1].skipped], [4, 3, 0, 1]);
  // D1: one op in the apply carries an error and its code
  assert.deepEqual([rows[2].ops, rows[2].ok, rows[2].failed], [5, 4, 1]);
  assert.deepEqual(rows[2].codes, ["FMC-DIMS-NO-WALLS"]);
  // B09: a still-running job names its code and is not a failure
  assert.equal(rows[3].failed, 0);
  assert.deepEqual(rows[3].codes, ["FMC-JOB-RUNNING"]);
  // a document name is never reported as a code
  for (const row of rows) assert.equal(row.codes.some((c) => c.startsWith("FMC-ZZ-")), false);
  const out = formatRows(rows);
  assert.match(out, /^PASS runner-A-tags ops=3 ok=3 failed=0$/m);
  assert.match(out, /^FAIL runner-A-dims ops=5 ok=4 failed=1 FMC-DIMS-NO-WALLS$/m);
  assert.match(out, /skipped=1/);
});

test("a Run-FmcBatch result JSON counts its steps and ops instead of reporting 0", () => {
  const ok = JSON.parse(fs.readFileSync(path.join(FIX, "B03_A_door_window_room_tags.result-20261123-012558.json"), "utf8"));
  const [row] = summariseResult(ok, "B03_A_door_window_room_tags.result-20261123-012558.json");
  assert.equal(row.batch_id, "runner-A-tags");
  assert.equal(row.name, "B03_A_door_window_room_tags");
  assert.deepEqual([row.ops, row.ok, row.failed], [3, 3, 0]);
  const dims = JSON.parse(fs.readFileSync(path.join(FIX, "D1_A_dims_plans.result-20261123-012640.json"), "utf8"));
  const [d] = summariseResult(dims, "D1.json");
  assert.deepEqual([d.ops, d.ok, d.failed], [5, 4, 1]);
  assert.deepEqual(d.codes, ["FMC-DIMS-NO-WALLS"]);
  // a batch-level error object is a failure and its code is kept, even when every step replied
  const bad = JSON.parse(fs.readFileSync(path.join(FIX, "K1_P_keynote_place.result-20261123-012700.json"), "utf8"));
  const [b] = summariseResult(bad, "K1_P_keynote_place.result-20261123-012700.json");
  assert.equal(b.batch_id, "runner-P-keynotes");
  assert.deepEqual([b.ops, b.failed], [1, 1]);
  assert.deepEqual(b.codes, ["FMC-BATCH-LOCKED"]);
});

test("a folder of the log and its results reads both and skips the .cmd and README next to them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-runlog-real-"));
  for (const name of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, "RUN_ALL_UNATTENDED.cmd"), "@echo off\r\nB03 FAIL nonsense\r\n");
  fs.writeFileSync(path.join(dir, "README_RUN_BATCHES.md"), "B01 PASS ops=1 ok=1 failed=0\n");
  const summary = summarisePath(dir);
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.rows.length, 4 + 3);
  assert.equal(summarisePath(path.join(FIX, "RUN_ALL_log.sample.txt")).rows.length, 4);
  assert.equal(summarisePath(path.join(dir, "missing.txt")).errors.length, 1);
});

test("a log that was cut off mid-reply still counts the tool calls it started", () => {
  const cut = [
    "==== B01_A_BQ_plans_square Mon 11/23/2026  1:20:00.00 ",
    "Batch  runner-A-bq on F26901-FMC-ZZ-ZZ-M3-A-0002_USER",
    "Preview:",
    "  -> modify_model",
    "[",
    "  {",
    '    "tool": "modify_model",',
  ].join("\r\n");
  const [row] = summariseLog(cut, "RUN_ALL_log.txt");
  assert.equal(row.batch_id, "runner-A-bq");
  assert.equal(row.ops, 1);
});
