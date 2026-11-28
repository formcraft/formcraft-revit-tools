import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { undoParams } from "../tools/modify_element.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");

test("undo_ai_batch status: the named document goes to fmc_undo_status", () => {
  assert.deepEqual(undoParams({ action: "status" }, "plumbing_USER"), { document: "plumbing_USER" });
  assert.deepEqual(undoParams({ action: "status" }, "  C:\\W\\plumbing_USER.rvt "), { document: "C:\\W\\plumbing_USER.rvt" });
});

test("undo_ai_batch status: no document means none is sent, and a status never carries batch_id or count", () => {
  assert.deepEqual(undoParams({ action: "status" }), {});
  assert.deepEqual(undoParams({ action: "status" }, "  "), {});
  assert.deepEqual(undoParams({ action: "status", batch_id: "a1", count: 3 } as never, "d"), { document: "d" });
});

test("undo_ai_batch undo/redo: action, batch_id, count and the document all go to fmc_undo", () => {
  assert.deepEqual(undoParams({ action: "undo", batch_id: "3a0112", count: 2 }, "plumbing_USER"), { action: "undo", batch_id: "3a0112", count: 2, document: "plumbing_USER" });
  assert.deepEqual(undoParams({ action: "redo" }, "plumbing_USER"), { action: "redo", document: "plumbing_USER" });
  assert.deepEqual(undoParams({ action: "undo" }), { action: "undo" });
});

// The bug was on the Revit side: FmcUndoStatusCommand threw the call's parameters away (new JObject { action = status }),
// so FmcTarget saw no document and refused with FMC-DOC-REQUIRED whenever several documents were open. There is no C#
// test host without the Revit API, so this reads the source: the status command must start from the call's parameters.
test("C# FmcUndoStatusCommand passes the call's parameters (document) to the handler", () => {
  const src = fs.readFileSync(path.join(repo, "commandset", "Commands", "Fmc", "FmcElementCommands.cs"), "utf8");
  const start = src.indexOf("class FmcUndoStatusCommand");
  assert.ok(start > 0, "FmcUndoStatusCommand not found");
  const end = src.indexOf("public class ", start + 10);
  const body = src.slice(start, end > 0 ? end : undefined);
  assert.doesNotMatch(body, /_handler\.Parameters\s*=\s*new JObject\s*\{\s*\["action"\]\s*=\s*"status"\s*\}/, "status must not replace the parameters with a bare action");
  assert.match(body, /parameters\.DeepClone\(\)/, "status copies the call's parameters");
  assert.match(body, /Remove\("batch_id"\)/);
  assert.match(body, /\["action"\]\s*=\s*"status"/);
  assert.match(body, /_handler\.Parameters\s*=\s*p\s*;/);
});
