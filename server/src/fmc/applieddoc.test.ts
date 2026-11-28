import { test } from "node:test";
import assert from "node:assert/strict";
import { WRITE_COMMANDS } from "./policy.js";
import { isAppliedResult, stampAppliedDocument } from "./applieddoc.js";

const file = { title: "P-F-V-00-M3-A-0001", path: "C:\\Jobs\\P\\01_WIP\\P-F-V-00-M3-A-0001.rvt" };

test("every applied write names the target file's title and path", () => {
  for (const command of WRITE_COMMANDS) {
    const stamped = stampAppliedDocument({ command, created: 1 }, file, { command }) as unknown as { document: { title: string; path: string } };
    assert.equal(stamped.document.title, file.title, command);
    assert.equal(stamped.document.path, file.path, command);
    assert.equal(isAppliedResult({ command }, { command, created: 1 }), true, command);
  }
});

test("a dry run, a refusal, and a rolled-back result are not given an apply stamp", () => {
  const made = { ops: [{ op: 1 }], document: { title: "already", path: "D:\\keep.rvt", is_workshared: true } };
  assert.equal(stampAppliedDocument(made, file, { dry_run: true }), made);
  const refused = { applied: false, reason: "no" };
  assert.equal(stampAppliedDocument(refused, file, {}), refused);
  const rolled = { dry_run: true, note: "rolled back" };
  assert.equal(stampAppliedDocument(rolled, file, {}), rolled);
  const kept = stampAppliedDocument(made, file, {});
  assert.equal(kept, made, "a reply that already has title and path is left as the handler wrote it");
});

test("a read-only script is not an applied change", () => {
  const body = { success: true, result: null };
  assert.equal(stampAppliedDocument(body, file, { transactionMode: "read_only" }), body);
});
