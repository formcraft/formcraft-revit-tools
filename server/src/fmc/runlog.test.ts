import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
