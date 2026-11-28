import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sortDocumentNames, splitBatchFile, splitOps } from "./batchsplit.js";

test("ops split by document in a fixed order, and a file-level document fills the gap", () => {
  const split = splitOps([
    { op: "wall", document: "Electrical" },
    { op: "pipe", document: "Plumbing" },
    { op: "note" },
    { op: "light", document: "Electrical" },
  ], "Plumbing");
  assert.equal(split.missing, 0);
  assert.deepEqual(split.documents, sortDocumentNames(["Plumbing", "Electrical"]));
  assert.equal(split.sub_batches[0].count + split.sub_batches[1].count, 4);
  const electrical = split.sub_batches.find((row) => row.document === "Electrical");
  assert.equal(electrical?.count, 2);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fmc-split-")), "B09.json");
  fs.writeFileSync(file, JSON.stringify({
    batch_id: "B09",
    ops: [
      { op: "pipe", document: "F26901-FMC-ZZ-ZZ-M3-P-0001_USER" },
      { op: "light", document: "F26901-FMC-ZZ-ZZ-M3-E-0001_USER" },
    ],
  }));
  const plan = splitBatchFile(file);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.mode, "sequence");
  assert.equal(plan.batch_id, "B09");
  assert.equal(plan.sub_batches.length, 2);
  assert.deepEqual(plan.documents, sortDocumentNames(plan.documents));
});

test("a batch file with one document is not split, and a missing document is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-split-"));
  const one = path.join(dir, "one.json");
  fs.writeFileSync(one, JSON.stringify({ document: "Plumbing", ops: [{ op: "pipe" }, { op: "valve" }] }));
  const plan = splitBatchFile(one);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.mode, "one");
  assert.equal(plan.sub_batches[0].count, 2);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ ops: [{ op: "pipe" }] }));
  const refused = splitBatchFile(bad);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.code, "FMC-BATCH-BAD");
});
