import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIALOG_HARD_DENY, DIALOGS_SCHEMA_VERSION, dialogBlocked, dialogLists, dialogRowCounts, dialogStatus, hardDenyComparison, recentDialogs, sinceMs } from "./dialogs.js";
import { NEVER_AUTO_FRAGMENTS } from "./dialogrules.js";
import { runFmcDialogs } from "../tools/fmc_dialogs.js";
import { WRITE_COMMANDS } from "./policy.js";

const toolFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools", "fmc_dialogs.ts");
const csPolicyFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "commandset", "Bridge", "DialogPolicy.cs");

const LOG = [
  { at: "2026-11-28T06:00:00Z", event: "dialog", dialog_id: "TaskDialog_Sync", message: "Synchronize?", answer: "left for a person", job: "7" },
  { at: "2026-11-28T06:05:00Z", event: "dialog", dialog_id: "save", message: "not saved recently", answer: "answered: Cancel", job: "7" },
  { at: "2026-11-28T07:00:00Z", event: "failure", dialog_id: "dup", message: "duplicate mark", answer: "left", job: "8" },
  { at: "not a time", event: "dialog", dialog_id: "x", message: "x", answer: "left", job: "8" },
  { at: "2026-11-28T07:10:00Z", event: "running", message: "ignore", job: "8" },
];

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

test("recent lines filter by job, by left-for-a-person and by since, before the limit", () => {
  assert.equal(recentDialogs(LOG).length, 4, "no filter: unchanged behaviour");
  assert.deepEqual(recentDialogs(LOG, 30, { job: "7" }).map((r) => r.dialog_id), ["TaskDialog_Sync", "save"]);
  assert.deepEqual(recentDialogs(LOG, 30, { only_left_for_person: true }).map((r) => r.dialog_id), ["TaskDialog_Sync", "dup", "x"]);
  // since drops earlier lines and lines whose time does not parse
  assert.deepEqual(recentDialogs(LOG, 30, { since: "2026-11-28T06:05:00Z" }).map((r) => r.dialog_id), ["save", "dup"]);
  // filters apply before the limit: the last matching line is kept, not the last line overall
  assert.deepEqual(recentDialogs(LOG, 1, { job: "7" }).map((r) => r.dialog_id), ["save"]);
  assert.deepEqual(recentDialogs(LOG, 30, { job: "" }).length, 4, "an empty job is no filter");
});

test("a since that is not a time is refused, not ignored", () => {
  assert.equal(sinceMs(undefined), undefined);
  assert.equal(sinceMs(""), undefined);
  assert.throws(() => sinceMs("yesterday"), /FMC-DIALOGS-SINCE/);
  assert.throws(() => recentDialogs(LOG, 30, { since: "yesterday" }), /FMC-DIALOGS-SINCE/);
});

test("counts tally dialog, failure and left-for-a-person rows", () => {
  assert.deepEqual(dialogRowCounts(recentDialogs(LOG)), { dialog: 3, failure: 1, left_for_a_person: 3 });
  assert.deepEqual(dialogRowCounts([]), { dialog: 0, failure: 0, left_for_a_person: 0 });
});

test("the reply carries schema_version, the rules file status, the list comparison and the applied filter", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dialogs-"));
  const home = path.join(dir, "Formcraft");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "FMC_Jobs_Revit.jsonl"), LOG.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const env = { APPDATA: dir } as NodeJS.ProcessEnv;
  const status = dialogStatus({}, env, 30, { job: "8" });
  assert.equal(status.schema_version, DIALOGS_SCHEMA_VERSION);
  assert.equal(status.rules_file.exists, false);
  assert.equal(status.rules_file.path, path.join(home, "fmc_dialog_rules.json"));
  assert.deepEqual(status.filter, { job: "8" });
  assert.deepEqual(status.counts, { dialog: 1, failure: 1, left_for_a_person: 2 });
  assert.match(status.lists_cover, /fmc_dialog_rules/);
  fs.writeFileSync(path.join(home, "fmc_dialog_rules.json"), "[]");
  assert.equal(dialogStatus({}, env).rules_file.exists, true);
  // the rules file is only checked for existence, never rewritten
  assert.equal(fs.readFileSync(path.join(home, "fmc_dialog_rules.json"), "utf8"), "[]");
});

test("the comparison names the words only one never-auto list has, and changes neither list", () => {
  const before = [...DIALOG_HARD_DENY];
  const cmp = hardDenyComparison();
  for (const w of cmp.hard_deny_only) assert.ok(DIALOG_HARD_DENY.includes(w) && !NEVER_AUTO_FRAGMENTS.includes(w), w);
  for (const w of cmp.rules_never_auto_only) assert.ok(NEVER_AUTO_FRAGMENTS.includes(w) && !DIALOG_HARD_DENY.includes(w), w);
  assert.ok(cmp.hard_deny_only.includes("delete"));
  assert.ok(cmp.rules_never_auto_only.includes("recover"));
  assert.deepEqual(DIALOG_HARD_DENY, before);
});

test("the TypeScript hard deny is the same list as DialogPolicy.HardDeny in the add-in", () => {
  const cs = fs.readFileSync(csPolicyFile, "utf8");
  const block = /HardDeny\s*=\s*\{([\s\S]*?)\};/.exec(cs);
  assert.ok(block, "HardDeny array not found in DialogPolicy.cs");
  const words = [...block![1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual([...words].sort(), [...DIALOG_HARD_DENY].sort());
});

test("the tool returns a structured error for a bad since", () => {
  const r = runFmcDialogs({ since: "soon" }, { APPDATA: fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dialogs-")) } as NodeJS.ProcessEnv, () => ({ config: {} }));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /FMC-DIALOGS-SINCE/);
});
