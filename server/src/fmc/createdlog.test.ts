import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureCreated, createdFor, planUndo } from "./createdlog.js";

test("a batch records created ids, and undo keeps missing, borrowed and changed elements", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-created-"));
  const env = { ...process.env, FMC_CREATED_DIR: dir } as NodeJS.ProcessEnv;
  const skipped = captureCreated({ dry_run: true, document: "P" }, { applied: true, batch_id: "B09", created_ids: [1] }, env, "lease-1");
  assert.equal(skipped, 0);
  const wrote = captureCreated(
    { document: "Plumbing", dry_run: false },
    { applied: true, batch_id: "B09", created: [{ id: 11, fingerprint: "0,0,0|10,10,10" }, { id: 12, fingerprint: "0,0,0|1,1,1" }], created_ids: [11, 12] },
    env,
    "lease-9",
  );
  assert.equal(wrote, 2);
  assert.equal(createdFor("B09", env).length, 2);
  assert.equal(createdFor("lease-9", env).length, 2);
  const plan = planUndo(createdFor("B09", env), [
    { id: "11", exists: true, editable: true, fingerprint: "0,0,0|10,10,10" },
    { id: "12", exists: true, editable: false, code: "FMC-ELEM-OWNED-BY-OTHER", reason: "owned by Sam" },
    { id: "13", exists: false, editable: false },
  ]);
  assert.deepEqual(plan.delete.map((row) => row.id), ["11"]);
  assert.equal(plan.delete[0].unchanged, "same");
  assert.equal(plan.kept.includes("12"), true);
  assert.equal(plan.skipped.some((row) => row.code === "FMC-UNDO-CHANGED"), false);
  const changed = planUndo(createdFor("B09", env), [
    { id: "11", exists: true, editable: true, fingerprint: "9,9,9|9,9,9" },
  ]);
  assert.equal(changed.delete.length, 0);
  assert.equal(changed.skipped[0].code, "FMC-UNDO-CHANGED");
  assert.equal(fs.existsSync(path.join(dir, "FMC_Created.jsonl")), true);
});
