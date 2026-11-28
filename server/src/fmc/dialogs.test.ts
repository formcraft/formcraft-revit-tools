import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIALOG_HARD_DENY, DIALOGS_SCHEMA_VERSION, ageMinutes, dialogBlocked, dialogLists, dialogRowCounts, dialogStatus, hardDenyComparison, ignoredInputs, openNowOf, recentDialogs, sinceMs } from "./dialogs.js";
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

test("status says what it covers: now, log file, ages, and a passed document is listed as ignored (P-fmc_dialogs-01)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dialogs-"));
  const home = path.join(dir, "Formcraft");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "FMC_Jobs_Revit.jsonl"), LOG.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const env = { APPDATA: dir } as NodeJS.ProcessEnv;
  const now = Date.parse("2026-11-28T07:19:00Z");
  const status = dialogStatus({}, env, 30, {}, { now, ignored_inputs: ignoredInputs({ document: "Project1" }) });
  assert.equal(status.schema_version, 2);
  assert.equal(status.now, "2026-11-28T07:19:00.000Z");
  assert.equal(status.log_file, path.join(home, "FMC_Jobs_Revit.jsonl"));
  assert.equal(status.lines_read, 5);
  assert.match(status.scope, /machine-wide/);
  assert.deepEqual(status.ignored_inputs, { document: "Project1" });
  assert.equal(ageMinutes("2026-11-28T07:00:00Z", now), 19);
  assert.equal(status.recent.find((r) => r.dialog_id === "dup")?.age_minutes, 19);
  assert.equal(status.recent.find((r) => r.dialog_id === "TaskDialog_Sync")?.age_minutes, 79);
  assert.equal(status.recent.find((r) => r.dialog_id === "x")?.age_minutes, null, "a bad stamp is not given an age");
  assert.equal(status.newest_age_minutes, 19, "newest parseable line, not the unparseable last one");
  assert.deepEqual(ignoredInputs({}), {});
  assert.deepEqual(ignoredInputs({ document: "  " }), {});

  const tool = JSON.parse(runFmcDialogs(
    { document: "architectural_USER", limit: 10 },
    env,
    () => ({ config: {} }),
    () => now,
  ).content[0].text);
  assert.deepEqual(tool.ignored_inputs, { document: "architectural_USER" });
  assert.equal(tool.recent.length, 4, "document does not filter the machine-wide log");
  const bare = JSON.parse(runFmcDialogs({ limit: 10 }, env, () => ({ config: {} }), () => now).content[0].text);
  assert.deepEqual(bare.ignored_inputs, {});
});

test("open_now is true or false only from a fresh add-in file, never guessed from the log (P-fmc_dialogs-02)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dialogs-"));
  const home = path.join(dir, "Formcraft");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "FMC_Jobs_Revit.jsonl"), JSON.stringify({
    at: "2026-11-28T06:00:00Z", event: "dialog", dialog_id: "TaskDialog_Sync", message: "Synchronize?", answer: "left for a person", job: "9",
  }) + "\n");
  const env = { APPDATA: dir } as NodeJS.ProcessEnv;
  const now = Date.parse("2026-11-28T08:55:00Z");

  const missing = openNowOf(env, now);
  assert.equal(missing.open_now, null);
  assert.equal(missing.open_now_source, "none");
  assert.match(missing.open_now_note, /cannot say whether a dialog is still on screen/);
  const statusMissing = dialogStatus({}, env, 30, {}, { now });
  assert.equal(statusMissing.open_now, null);
  assert.equal(statusMissing.recent[0].left_for_a_person, true, "the log still reports left-for-a-person; that is not open_now");

  const writeOpen = (over: Record<string, unknown>) => fs.writeFileSync(path.join(home, "fmc_dialog_open.json"), JSON.stringify({
    open: true, dialog_id: "TaskDialog_Save_Changes_To_Local_File", message: "Save?", job: "9", pid: 42, at: "2026-11-28T08:49:00Z", ...over,
  }));

  writeOpen({});
  const up = openNowOf(env, now);
  assert.equal(up.open_now, true);
  assert.equal(up.open_now_source, "add-in");
  assert.equal(up.open?.dialog_id, "TaskDialog_Save_Changes_To_Local_File");
  assert.equal(up.open?.age_minutes, 6);

  writeOpen({ open: false });
  assert.equal(openNowOf(env, now).open_now, false);
  assert.match(openNowOf(env, now).open_now_note, /no dialog is up/);

  writeOpen({ open: true, at: "2026-11-28T08:20:00Z" });
  const stale = openNowOf(env, now);
  assert.equal(stale.open_now, null, "a stale open file is not treated as still waiting");
  assert.match(stale.open_now_note, /35 minutes old/);

  writeOpen({ open: false, at: "2026-11-28T08:20:00Z" });
  assert.equal(openNowOf(env, now).open_now, null, "a stale closed file is also unknown");
});
