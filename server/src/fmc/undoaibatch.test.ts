import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { UNDO_AI_BATCH_DESCRIPTION, UNDO_AI_BATCH_SHAPE, undoAiBatchCall } from "../tools/modify_element.js";
import { READ_VIA_SEND_COMMAND, WRITE_COMMANDS } from "./policy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const shape = z.object(UNDO_AI_BATCH_SHAPE);

test("UB-1: undo_ai_batch with no arguments is a status read, never fmc_undo", () => {
  const args = shape.parse({});
  assert.equal(args.action, "status");
  assert.deepEqual(undoAiBatchCall(args), { command: "fmc_undo_status", params: {} });
  assert.equal(undoAiBatchCall({}).command, "fmc_undo_status");
  // batch_id or count without an action still only reads
  assert.equal(undoAiBatchCall(shape.parse({ batch_id: "b12" })).command, "fmc_undo_status");
  assert.equal(undoAiBatchCall(shape.parse({ count: 3 })).command, "fmc_undo_status");
});

test("UB-1: only an explicit undo or redo reaches fmc_undo (a write)", () => {
  assert.deepEqual(undoAiBatchCall(shape.parse({ action: "undo" })), { command: "fmc_undo", params: { action: "undo" } });
  assert.deepEqual(undoAiBatchCall(shape.parse({ action: "undo", batch_id: "b7", count: 2 })),
    { command: "fmc_undo", params: { action: "undo", batch_id: "b7", count: 2 } });
  assert.deepEqual(undoAiBatchCall(shape.parse({ action: "redo" })), { command: "fmc_undo", params: { action: "redo" } });
  assert.throws(() => shape.parse({ action: "Undo" }), "a typo is refused by the shape, not guessed");
  assert.throws(() => shape.parse({ action: "plan" }));
  assert.ok(WRITE_COMMANDS.has("fmc_undo"));
  assert.ok(!WRITE_COMMANDS.has("fmc_undo_status") && READ_VIA_SEND_COMMAND.has("fmc_undo_status"));
});

test("UB-1: the description says the default only reads", () => {
  assert.match(UNDO_AI_BATCH_DESCRIPTION, /With no action \(the default\) it only reads/);
  assert.match(UNDO_AI_BATCH_DESCRIPTION, /Nothing is undone unless you pass action undo/);
});

test("UB-1: the add-in's fmc_undo no longer defaults action to undo", () => {
  const cmds = fs.readFileSync(path.join(root, "commandset", "Commands", "Fmc", "FmcElementCommands.cs"), "utf8");
  assert.ok(!/_handler\.Parameters\["action"\]\s*=\s*"undo"/.test(cmds), "no default to undo");
  assert.match(cmds, /FMC-UNDO-ACTION\] action must be/);
  const undo = fs.readFileSync(path.join(root, "commandset", "Bridge", "FmcUndo.cs"), "utf8");
  assert.match(undo, /case "status": Result = FmcUndo\.Status\(doc\); break;/);
  assert.match(undo, /default: throw new InvalidOperationException\(\$"\[FMC-UNDO-ACTION\] Unknown action/);
});
