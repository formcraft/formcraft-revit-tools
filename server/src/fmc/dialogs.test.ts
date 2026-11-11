import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dialogBlocked, dialogLists, dialogStatus, recentDialogs } from "./dialogs.js";
import { WRITE_COMMANDS } from "./policy.js";

const toolFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools", "fmc_dialogs.ts");

test("fmc_dialogs is read-only and a sync, delete, overwrite, relinquish or corrupt prompt stays for a person", () => {
  assert.equal(WRITE_COMMANDS.has("fmc_dialogs"), false);
  const lists = dialogLists({});
  assert.equal(lists.allow_source, "default");
  assert.ok(lists.allow.includes("not saved recently"));
  assert.equal(dialogBlocked("TaskDialog_Save_Reminder", "The project has not been saved recently"), false);
  for (const prompt of [
    "Synchronize with Central?",
    "Relinquish elements?",
    "Delete these elements?",
    "Overwrite the file?",
    "TaskDialog_Corrupt_Model_Detected_On_Synchronize_With_Central",
  ]) {
    assert.equal(dialogBlocked("", prompt), true, prompt);
  }
  const custom = dialogLists({ dialogs: { allow: ["delete these"], deny: ["duplicate types"] } });
  assert.equal(custom.allow_source, "guard");
  assert.equal(dialogBlocked("", "Delete these elements?", custom.deny), true);
});

test("a prompt left for a person is logged as such, and an allowlisted answer is not", () => {
  const rows = recentDialogs([
    { at: "2026-11-11T06:00:00Z", event: "dialog", dialog_id: "TaskDialog_Sync", message: "Synchronize?", answer: "left for a person", job: "1" },
    { at: "2026-11-11T06:01:00Z", event: "dialog", dialog_id: "save", message: "not saved recently", answer: "answered: save reminder: Cancel, the model is not saved", job: "2" },
    { at: "2026-11-11T06:02:00Z", event: "running", message: "ignore" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].left_for_a_person, true);
  assert.equal(rows[1].left_for_a_person, false);
});

test("status reads the guard and the Revit job log without sending a command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dialogs-"));
  const home = path.join(dir, "Formcraft");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "FMC_Jobs_Revit.jsonl"), JSON.stringify({
    at: "2026-11-11T06:00:00Z", event: "dialog", dialog_id: "TaskDialog_Sync", message: "Synchronize with Central?", answer: "left for a person", job: "9",
  }) + "\n");
  const status = dialogStatus({ dialogs: { deny: ["extra"] } }, { APPDATA: dir } as NodeJS.ProcessEnv, 10);
  assert.equal(status.read_only, true);
  assert.equal(status.changes_model, false);
  assert.deepEqual(status.deny, ["extra"]);
  assert.equal(status.recent.length, 1);
  assert.equal(status.recent[0].left_for_a_person, true);
  const tool = fs.readFileSync(toolFile, "utf8");
  assert.equal(/sendCommand\(/.test(tool), false);
});
