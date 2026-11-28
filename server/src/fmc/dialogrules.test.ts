import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WRITE_COMMANDS } from "./policy.js";
import { describeInstance } from "./httpservice.js";
import { dialogFor } from "./notidle.js";
import { collectJobs } from "./jobs.js";
import { retryWhileBusy } from "./busy.js";
import {
  DIALOG_BLOCKING, DialogBlockingError, SAVE_REMINDER_ID, SYNC_REMINDER_ID, addRule, blockingDialog, blockingForJob,
  decide, defaultRules, dialogAlerts, dialogCounts, neverAuto, readRules, setRuleEnabled, unsafeReminderAnswer,
} from "./dialogrules.js";

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "commandset", "Bridge", "DialogRuleEngine.cs");
const session = path.resolve(path.dirname(engine), "FmcDialogSession.cs");

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-dialog-rules-"));
  const env = { APPDATA: dir, FMC_DIALOG_RULES: path.join(dir, "Formcraft", "fmc_dialog_rules.json") } as NodeJS.ProcessEnv;
  fs.mkdirSync(path.join(dir, "Formcraft"), { recursive: true });
  return { dir, env };
}

test("default rules dismiss the reminders without saving or syncing, and only during jobs for the rest", () => {
  const rules = defaultRules();
  const row = (id: string) => rules.find((rule) => rule.dialog_id === id)!;
  assert.equal(row("Dialog_Revit_AccessingFile").answer, "log");
  assert.equal(row("Dialog_Revit_AccessingFile").scope, "always");
  assert.equal(row(SAVE_REMINDER_ID).answer, "CommandLink3");
  assert.equal(row(SAVE_REMINDER_ID).scope, "always");
  assert.equal(row(SYNC_REMINDER_ID).answer, "CommandLink3");
  assert.equal(row(SYNC_REMINDER_ID).scope, "always");
  assert.equal(row("Dialog_Revit_DocWarnDialog").answer, "Ok");
  assert.equal(row("Dialog_Revit_DocWarnDialog").scope, "ai_jobs");
  assert.equal(row("Dialog_Revit_PasteSimilarSymbolsPaste").answer, "Ok");
  assert.equal(row("Dialog_Revit_ExtendedErrorDialog").answer, "Cancel");
  assert.equal(row("Dialog_Revit_SelectElement").answer, "Cancel");

  const save = decide(rules, SAVE_REMINDER_ID, "You have not saved your project recently", "", false);
  assert.equal(save.act, true);
  assert.equal(save.code, 1003);
  const sync = decide(rules, SYNC_REMINDER_ID, "have not been synchronized", "Hostel", false);
  assert.equal(sync.code, 1003);
  const warn = decide(rules, "Dialog_Revit_DocWarnDialog", "warning", "", false);
  assert.equal(warn.act, false);
  const warnJob = decide(rules, "Dialog_Revit_DocWarnDialog", "warning", "", true);
  assert.equal(warnJob.code, 1);
  const access = decide(rules, "Dialog_Revit_AccessingFile", "Reading central", "", false);
  assert.equal(access.act, false);
  assert.match(access.reason, /^logged only/);
});

test("never-auto dialogs cannot be answered from a rule, including a save or sync button on a reminder", () => {
  for (const id of [
    "TaskDialog_Save_File", "Dialog_Revit_RevitSaveOptions", "Dialog_Revit_PartitionsSaveToCentral",
    "TaskDialog_Worksets_Errors", "TaskDialog_Changes_Not_Saved", "TaskDialog_Fatal_Error_Occured",
    "Serious_Error_Recoverable", "TaskDialog_Local_Changes_Not_Synchronized_With_Central",
  ]) assert.equal(neverAuto(id), true, id);
  assert.equal(neverAuto(SAVE_REMINDER_ID), false);
  assert.equal(neverAuto(SYNC_REMINDER_ID), false);
  assert.equal(neverAuto("Dialog_Revit_ExtendedErrorDialog"), false);
  assert.equal(unsafeReminderAnswer(SAVE_REMINDER_ID, 1001), true);
  assert.equal(unsafeReminderAnswer(SAVE_REMINDER_ID, 1003), false);
  assert.equal(unsafeReminderAnswer(SYNC_REMINDER_ID, 1002), true);
  assert.equal(unsafeReminderAnswer(SYNC_REMINDER_ID, 8), false);

  const planted = decide([{
    id: "bad", enabled: true, dialog_id: "TaskDialog_Save_File", message: "", document: "", answer: "No", scope: "always", note: "",
  }], "TaskDialog_Save_File", "Save changes?", "", true);
  assert.equal(planted.act, false);
  assert.equal(planted.never_auto, true);
  assert.match(planted.reason, /left for a person/);

  const { env } = home();
  const refused = addRule({ dialog_id: "TaskDialog_Save_File", answer: "No", scope: "always" }, env, false);
  assert.equal(refused.refused, true);
  assert.match(refused.reason ?? "", /never auto/);
  assert.equal(fs.existsSync(env.FMC_DIALOG_RULES!), false);
  const syncButton = addRule({ dialog_id: SYNC_REMINDER_ID, answer: "CommandLink1", scope: "always" }, env, true);
  assert.equal(syncButton.refused, true);
  assert.match(syncButton.reason ?? "", /synchronises/);
});

test("a rule matches dialog id, message and document, and add is a dry run until asked to write", () => {
  const rules = [{
    id: "walls", enabled: true, dialog_id: "Dialog_Revit_DocWarnDialog", message: "wall", document: "Hostel",
    answer: "Close", scope: "ai_jobs" as const, note: "",
  }];
  const hit = decide(rules, "dialog_revit_docwarndialog", "Walls overlap", "Hostel L1", true);
  assert.equal(hit.code, 8);
  assert.equal(decide(rules, "Dialog_Revit_DocWarnDialog", "Walls overlap", "School", true).matched, false);
  assert.equal(decide(rules, "Dialog_Revit_DocWarnDialog", "Rooms", "Hostel", true).matched, false);
  assert.equal(decide(rules, "Dialog_Revit_DocWarnDialog", "Walls", "Hostel", false).act, false);

  const { env } = home();
  const proposed = addRule({ dialog_id: "Dialog_Revit_SelectElement", answer: "Cancel", scope: "ai_jobs", message: "Select" }, env, true);
  assert.equal(proposed.dry_run, true);
  assert.equal(proposed.refused, false);
  assert.equal(fs.existsSync(env.FMC_DIALOG_RULES!), false);
  const written = addRule({ id: "pick", dialog_id: "Dialog_Revit_SelectElement", answer: "Cancel", scope: "ai_jobs" }, env, false);
  assert.equal(written.dry_run, false);
  const loaded = readRules(env);
  assert.equal(loaded.source, "file");
  assert.equal(loaded.rules[0].id, "pick");
  assert.equal(loaded.rules.length, defaultRules().length + 1);
  const off = setRuleEnabled("pick", false, env, false);
  assert.equal(off.rule?.enabled, false);
  assert.equal(readRules(env).rules.find((rule) => rule.id === "pick")?.enabled, false);
  const missing = setRuleEnabled("nope", true, env, true);
  assert.equal(missing.refused, true);
});

test("history counts dialogs, alerts name never-auto ids, and a blocking dialog stops a retry", async () => {
  const lines = [
    { event: "dialog", dialog_id: "Dialog_Revit_AccessingFile", answer: "logged only: accessing-file", message: "Reading" },
    { event: "dialog", dialog_id: "Dialog_Revit_AccessingFile", answer: "logged only: accessing-file", message: "Reading" },
    { event: "dialog", dialog_id: "TaskDialog_Save_File", answer: "left for a person (never auto)", message: "Save changes to Project1?" },
    { event: "dialog", dialog_id: SYNC_REMINDER_ID, answer: "answered: sync-reminder CommandLink3 (1003)", message: "not synchronized" },
  ];
  const counts = dialogCounts(lines);
  assert.equal(counts.find((row) => row.dialog_id === "Dialog_Revit_AccessingFile")?.count, 2);
  const alerts = dialogAlerts(lines);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].dialog_id, "TaskDialog_Save_File");

  const { dir, env } = home();
  fs.writeFileSync(path.join(dir, "Formcraft", "FMC_Jobs_Revit.jsonl"), JSON.stringify({
    at: "2026-11-22T08:00:00Z", job: "job1", event: "dialog", dialog_id: "TaskDialog_Fatal_Error_Occured",
    message: "A fatal error occurred", answer: "left for a person (never auto)",
  }) + "\n");
  const jobs = collectJobs(env);
  assert.equal(jobs[0].state, "waiting_for_dialog");
  assert.match(jobs[0].summary, /FMC-DIALOG-BLOCKING/);
  assert.match(jobs[0].summary, /TaskDialog_Fatal_Error_Occured/);

  fs.writeFileSync(env.FMC_DIALOG_RULES!.replace("fmc_dialog_rules.json", "fmc_dialog_open.json"), JSON.stringify({
    open: true, dialog_id: "TaskDialog_Changes_Not_Saved", message: "What do you want to do?", answer: "left for a person",
    job: "busy1", pid: 42, at: new Date().toISOString(), alert: true, addin: "fmc_dialog_rules",
  }));
  const open = blockingDialog(env, { job: "busy1", pid: 42 });
  assert.equal(open.open, true);
  assert.equal(open.source, "add-in");
  assert.equal(open.dialog_id, "TaskDialog_Changes_Not_Saved");
  const named = dialogFor(42, "busy1", env, []);
  assert.equal(named, "TaskDialog_Changes_Not_Saved: What do you want to do?");

  const err = await retryWhileBusy(async () => {
    throw new Error("[FMC-BRIDGE-BUSY] Revit is still running fmc_doc_apply since 2026-11-22 08:00:00 (job busy1)");
  }, {
    command: "fmc_doc_apply", ceilingMs: 10_000, pollMs: 10, heartbeatMs: () => Date.now(),
    blocking: (job) => {
      const hit = blockingForJob(job, env, 42);
      return hit ? new DialogBlockingError(hit.dialog_id, hit.message, job) : null;
    },
  }).catch((error: unknown) => error);
  assert.ok(err instanceof DialogBlockingError);
  assert.equal((err as DialogBlockingError).code, DIALOG_BLOCKING);
  assert.match((err as Error).message, /Do not retry/);
  assert.match((err as Error).message, /TaskDialog_Changes_Not_Saved/);

  const row = describeInstance({ pid: 42, port: 1, revit: "2025" }, "ok", [], Date.now(), named);
  assert.equal(row.busy, null);
  const flightLines = [{ at: new Date().toISOString(), job: "busy1", command: "fmc_doc_apply", pid: 42, event: "heartbeat", started: new Date(Date.now() - 5000).toISOString() }];
  const waiting = describeInstance({ pid: 42, port: 1, revit: "2025" }, "reset", flightLines, Date.now(), named);
  assert.equal(waiting.busy?.dialog, "TaskDialog_Changes_Not_Saved: What do you want to do?");
});

test("fmc_dialog_rules does not call Revit or read the guard, and the add-in engine does not either", async () => {
  assert.equal(WRITE_COMMANDS.has("fmc_dialog_rules"), false);
  const { dir, env } = home();
  fs.writeFileSync(path.join(dir, "Formcraft", "fmc_guard.json"), "{\"dialogs\":{\"allow\":[\"delete\"]}}");
  const { runFmcDialogRules } = await import("../tools/fmc_dialog_rules.js");
  const listed = await runFmcDialogRules({ action: "list", limit: 5 }, env);
  const body = JSON.parse(listed.content[0].text);
  assert.equal(body.read_only, true);
  assert.equal(body.changes_model, false);
  assert.equal(body.source, "default");
  assert.equal(body.file_exists, false);
  assert.equal(body.blocking.open, false);
  assert.equal(body.blocking.available, false);
  assert.ok(body.defaults.some((rule: { dialog_id: string; answer: string; scope: string }) =>
    rule.dialog_id === SAVE_REMINDER_ID && rule.answer === "CommandLink3" && rule.scope === "always"));
  const tool = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "tools", "fmc_dialog_rules.ts"), "utf8");
  assert.equal(/sendCommand\(/.test(tool), false);
  assert.equal(/fmc_guard/.test(tool), false);
  const src = fs.readFileSync(engine, "utf8") + fs.readFileSync(session, "utf8");
  assert.equal(/fmc_guard/.test(src), false);
  for (const word of ["save_file", "revitsaveoptions", "partitionssavetocentral", "worksets_errors", "changes_not_saved", "fatal_error", "serious_error", "relinquish", "upgrade", "recover"]) {
    assert.match(src, new RegExp(word));
  }
  assert.match(src, /TaskDialog_Project_Not_Saved_Recently/);
  assert.match(src, /Do not save the project/);
  assert.match(src, /Do not synchronize/);
});

// ---------- research tool 34: remove and test ----------
import { removeRule, testDialog } from "./dialogrules.js";
import { runFmcDialogRules } from "../tools/fmc_dialog_rules.js";

test("remove is a dry run until dry_run false, and refuses an unknown id", () => {
  const { env } = home();
  addRule({ id: "warn-ok", dialog_id: "TaskDialog_Some_Warning", answer: "Ok" }, env, false);
  const before = readRules(env).rules.length;
  const dry = removeRule("warn-ok", env);
  assert.equal(dry.refused, false);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.rules.some((r) => r.id === "warn-ok"), false);
  assert.equal(readRules(env).rules.length, before, "a dry run writes nothing");
  const real = removeRule("warn-ok", env, false);
  assert.equal(real.refused, false);
  assert.equal(readRules(env).rules.some((r) => r.id === "warn-ok"), false);
  assert.equal(readRules(env).rules.length, before - 1);
  assert.equal(removeRule("nope", env).refused, true);
});

test("test says whether a dialog would be answered, during a job and between jobs, without writing", () => {
  const { env } = home();
  addRule({ id: "warn-always", dialog_id: "TaskDialog_Some_Warning", answer: "Ok", scope: "always", message: "duplicate" }, env, false);
  addRule({ id: "jobs-only", dialog_id: "TaskDialog_Job_Thing", answer: "Close" }, env, false);
  const file = readRules(env).file;
  const stamp = fs.statSync(file).mtimeMs;
  const hit = testDialog({ dialog_id: "TaskDialog_Some_Warning", message: "a duplicate mark" }, env);
  assert.ok(!("refused" in hit));
  if ("refused" in hit) return;
  assert.equal(hit.during_ai_job.act, true);
  assert.equal(hit.during_ai_job.rule_id, "warn-always");
  assert.equal(hit.between_jobs.act, true);
  const noText = testDialog({ dialog_id: "TaskDialog_Some_Warning", message: "other text" }, env);
  if (!("refused" in noText)) assert.equal(noText.during_ai_job.act, false);
  const jobs = testDialog({ dialog_id: "TaskDialog_Job_Thing" }, env);
  if (!("refused" in jobs)) { assert.equal(jobs.during_ai_job.act, true); assert.equal(jobs.between_jobs.act, false); }
  const save = testDialog({ dialog_id: "TaskDialog_Save_File" }, env);
  if (!("refused" in save)) { assert.equal(save.during_ai_job.never_auto, true); assert.equal(save.during_ai_job.act, false); }
  assert.equal("refused" in testDialog({}, env), true);
  assert.equal(fs.statSync(file).mtimeMs, stamp, "test never writes the rules file");
});

test("fmc_dialog_rules test and remove actions", () => {
  const { env } = home();
  addRule({ id: "warn-ok", dialog_id: "TaskDialog_Some_Warning", answer: "Ok" }, env, false);
  const tested = JSON.parse(runFmcDialogRules({ action: "test", dialog_id: "TaskDialog_Some_Warning" }, env).content[0].text);
  assert.equal(tested.read_only, true);
  assert.equal(tested.during_ai_job.rule_id, "warn-ok");
  const missing = runFmcDialogRules({ action: "test" }, env);
  assert.equal(missing.isError, true);
  const dry = JSON.parse(runFmcDialogRules({ action: "remove", rule_id: "warn-ok" }, env).content[0].text);
  assert.equal(dry.dry_run, true);
  assert.equal(readRules(env).rules.some((r) => r.id === "warn-ok"), true);
  runFmcDialogRules({ action: "remove", rule_id: "warn-ok", dry_run: false }, env);
  assert.equal(readRules(env).rules.some((r) => r.id === "warn-ok"), false);
});
