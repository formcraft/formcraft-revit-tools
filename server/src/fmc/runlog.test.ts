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
  // P-fmc_runlog-04: B03 and D1 are in the log and in their result JSON: counted once
  assert.equal(summary.rows.length, 4 + 3 - 2);
  assert.equal(summary.duplicates_dropped, 2);
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

test("RN-1/RN-2/RN-4/RN-6/RN-8: unknown calls are INCOMPLETE, a code-only reply fails, rows carry a time, running and blocked marks", async () => {
  const { rowStatus, parseRunTime, filterRuns } = await import("./runlog.js");
  const cut = ["==== B01_A Mon 11/23/2026  1:20:00.00", "Batch  runner-A-bq on X", "Preview:", "  -> modify_model", "  -> fmc_health"].join("\n");
  const [row] = summariseLog(cut, "RUN_ALL_log.txt");
  assert.equal(row.ok, 0);
  assert.equal(row.unknown, 2);
  assert.equal(row.status, "INCOMPLETE");
  assert.equal(row.at, "2026-11-23T01:20:00");
  assert.match(formatRows([row]), /1 batches, 1 incomplete/);
  const [blocked] = summariseResult({ label: "runner-R", steps: [{ tool: "fmc_register", result: { tool: "fmc_register", code: "FMC-REGISTER-STATUS", reason: "no status param" } }] }, "R1.result-20261124-020000.json");
  assert.equal(blocked.failed, 1);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.at, "2026-11-24T02:00:00");
  const [empty] = summariseResult({ label: "runner-E", steps: [] }, "E1.result-20261124-030000.json");
  assert.equal(empty.ops, 0);
  assert.equal(empty.status, "INCOMPLETE");
  assert.equal(rowStatus({ batch_id: "B09", ops: 1, ok: 0, failed: 0, codes: ["FMC-JOB-RUNNING"], source: "x" }), "RUNNING");
  assert.equal(parseRunTime("x"), "");
  const rows = [{ batch_id: "a", name: "J", at: "2026-11-23T01:00:00", ops: 1, ok: 1, failed: 0, codes: [], source: "1" }, { batch_id: "a", name: "J", at: "2026-11-24T01:00:00", ops: 1, ok: 1, failed: 0, codes: [], source: "2" }];
  assert.equal(filterRuns(rows, { since: "2026-11-24" }).length, 1);
  assert.equal(filterRuns(rows, { latest_per_job: true })[0].source, "2");
});

test("P-fmc_runlog-01/RN-5: a missing path is Not found with failed null, and an oversize file is skipped", async () => {
  const { runFmcRunlog } = await import("../tools/fmc_runlog.js");
  const missing = JSON.parse(runFmcRunlog({ path: path.join(os.tmpdir(), "no-such-runlog-dir", "x.txt"), since: "", latest_per_job: false }).content[0].text);
  assert.equal(missing.failed, null);
  assert.match(missing.text, /^Not found/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-runlog-big-"));
  fs.writeFileSync(path.join(dir, "RUN_ALL_log.txt"), "B01 PASS ops=1 ok=1 failed=0\n");
  const small = summarisePath(dir, 5);
  assert.equal(small.rows.length, 0);
  assert.equal(small.skipped_files.length, 1);
});
