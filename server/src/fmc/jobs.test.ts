import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectJobs, findJob, jobFiles, jobResult, requestCancel } from "./jobs.js";
import { AIUSE_FILES, pickAiRulebook } from "./aiuse.js";
import { aiRulebookLine } from "./selftest.js";

// The bridge fixes from the Ogala Residence field review (15 Oct): F-030 jobs, F-033/F-034/F-035 send_code results,
// F-036 fmc_job reads the late results, F-041 the AI-use rulebook. docs/BRIDGE.md.

function home() {
  const appdata = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-jobs-"));
  const env = { ...process.env, APPDATA: appdata };
  fs.mkdirSync(path.join(appdata, "Formcraft"), { recursive: true });
  return env;
}
const line = (file: string, o: object) => fs.appendFileSync(file, JSON.stringify(o) + "\n");

test("F-030/F-036: a job's state comes from the server's record, Revit's record and the late results", () => {
  const env = home();
  const f = jobFiles(env);
  line(f.server, { at: "2026-10-15T09:13:50Z", job: "111", event: "running", command: "send_code_to_revit", started: "2026-10-15T09:13:00Z" });
  line(f.server, { at: "2026-10-15T09:20:50Z", job: "222", event: "running", command: "send_code_to_revit", started: "2026-10-15T09:20:00Z" });
  line(f.server, { at: "2026-10-15T09:30:50Z", job: "333", event: "running", command: "send_code_to_revit", started: "2026-10-15T09:30:00Z" });
  line(f.server, { at: "2026-10-15T09:40:50Z", job: "444", event: "running", command: "fmc_family", started: "2026-10-15T09:40:00Z" });
  line(f.late, { at: "2026-10-15T09:14:30Z", command: "send_code_to_revit", id: "111", job: "111",
    result: { jsonrpc: "2.0", id: "111", result: { success: true, result: "{\"loaded\":6}", compileMs: 900, runMs: 80000 } } });
  line(f.late, { at: "2026-10-15T09:21:30Z", command: "send_code_to_revit", id: "222", job: "222",
    result: { result: { success: false, errorCode: "FMC-CODE-ROLLED-BACK", errorMessage: "[FMC-CODE-ROLLED-BACK] Revit rolled the script's transaction back" } } });
  line(f.revit, { at: "2026-10-15T09:31:00Z", job: "333", event: "dialog", dialog_id: "TaskDialog_Cannot_Keep_Joined", message: "Can't keep elements joined", answer: "left for a person" });
  line(f.revit, { at: "2026-10-15T09:41:00Z", job: "444", command: "fmc_family", event: "finished", ms: 70000, ok: true });
  // 30 s in Revit, answered within the limit: Revit's record only.
  line(f.revit, { at: "2026-10-15T08:00:30Z", job: "050", command: "fmc_qa_facts", event: "finished", ms: 30000, ok: true, started: "2026-10-15T08:00:00Z" });
  // An F-022 line from before jobs: no job field, the id is the job.
  line(f.late, { at: "2026-10-14T10:00:00Z", command: "fmc_doc", id: "999", result: { error: { message: "boom" } } });

  const jobs = collectJobs(env);
  const by = Object.fromEntries(jobs.map((j) => [j.job, j]));
  assert.equal(jobs[0].job, "444", "newest first");
  assert.equal(by["111"].state, "finished");
  assert.equal(by["111"].has_result, true);
  assert.equal(by["222"].state, "failed");
  assert.match(by["222"].summary, /FMC-CODE-ROLLED-BACK/);
  assert.equal(by["333"].state, "waiting_for_dialog");
  assert.match(by["333"].summary, /Can't keep elements joined/);
  assert.equal(by["444"].state, "finished");
  assert.match(by["444"].summary, /didn't receive the answer/);
  assert.equal(by["999"].state, "failed");
  assert.equal(by["050"].state, "finished");
  assert.match(by["050"].summary, /within the answer limit/);

  assert.deepEqual(jobResult("111", env).result, { jsonrpc: "2.0", id: "111", result: { success: true, result: "{\"loaded\":6}", compileMs: 900, runMs: 80000 } });
  assert.equal(jobResult("nope", env).found, false);
  assert.equal(jobResult("111", env, 20).truncated, true);
});

test("F-030: cancel is a request file and a record line; a cancelled result reads as cancelled", () => {
  const env = home();
  const f = jobFiles(env);
  line(f.server, { at: "2026-10-15T10:00:50Z", job: "555", event: "running", command: "send_code_to_revit", started: "2026-10-15T10:00:00Z" });
  const file = requestCancel("555", env);
  assert.ok(fs.existsSync(file));
  assert.equal(path.basename(file), "555");
  assert.ok(findJob("555", env)!.cancel_requested);
  assert.match(findJob("555", env)!.summary, /cancel requested/);
  assert.throws(() => requestCancel("..\\evil", env), /Not a job id/);
  line(f.late, { at: "2026-10-15T10:01:30Z", command: "send_code_to_revit", job: "555",
    result: { result: { success: false, errorCode: "FMC-CODE-CANCELLED", errorMessage: "[FMC-CODE-CANCELLED] Job 555 was cancelled" } } });
  assert.equal(findJob("555", env)!.state, "cancelled");
});

test("fmc_job: list, status, result, and cancel with a dry run first", async () => {
  const { runFmcJob } = await import("../tools/fmc_job.js");
  const env = home();
  const f = jobFiles(env);
  line(f.server, { at: "2026-10-15T11:00:50Z", job: "777", event: "running", command: "send_code_to_revit", started: "2026-10-15T11:00:00Z" });
  const text = async (a: object) => JSON.parse((await runFmcJob({ action: "list", job: "", limit: 20, confirm: false, ...a } as any, env)).content[0].text);

  assert.equal((await text({})).jobs[0].state, "running");
  assert.equal((await text({ action: "status", job: "777" })).state, "running");
  assert.equal((await text({ action: "status", job: "888" })).state, "unknown");
  assert.equal((await text({ action: "result", job: "777" })).ready, false);
  assert.equal((await text({ action: "status", job: "" })).refused, true);

  const dry = await text({ action: "cancel", job: "777" });
  assert.equal(dry.dry_run, true);
  assert.equal(fs.existsSync(path.join(f.cancelDir, "777")), false, "the dry run writes nothing");
  const sent = await text({ action: "cancel", job: "777", confirm: true });
  assert.equal(sent.cancel_requested, true);
  assert.ok(fs.existsSync(path.join(f.cancelDir, "777")));

  line(f.late, { at: "2026-10-15T11:01:30Z", command: "send_code_to_revit", job: "777", result: { result: { success: true, result: "42" } } });
  const done = await text({ action: "result", job: "777" });
  assert.equal(done.ready, true);
  assert.equal(done.result.result.result, "42");
  assert.equal((await text({ action: "cancel", job: "777" })).refused, true, "a finished job has nothing to cancel");
});

test("F-030: a call past the answer limit says 'still running' with its job id, and its late answer is kept with the job id", async () => {
  const env = home();
  const before = { APPDATA: process.env.APPDATA, SOFT: process.env.FMC_SOFT_TIMEOUT_MS };
  process.env.APPDATA = env.APPDATA;
  process.env.FMC_SOFT_TIMEOUT_MS = "20";
  try {
    const { RevitClientConnection, JobStillRunning, enableSoftTimeout } = await import("../utils/SocketClient.js");
    enableSoftTimeout();
    const client = new RevitClientConnection("127.0.0.1", 1);
    client.isConnected = true;
    let id = "";
    (client.socket as any).write = (s: string) => { id = JSON.parse(s).id; return true; };
    const err = await client.sendRaw("send_code_to_revit", { code: "return 1;" }, 200).catch((e: unknown) => e);
    assert.ok(err instanceof JobStillRunning);
    assert.equal((err as InstanceType<typeof JobStillRunning>).job, id);
    assert.match((err as Error).message, /\[FMC-JOB-RUNNING\].*not failed.*fmc_job status/);
    assert.equal(findJob(id, env)!.state, "running");

    client.socket.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { success: true, result: "1", job: id } })));
    const late = fs.readFileSync(jobFiles(env).late, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(late[0].job, id);
    assert.equal(findJob(id, env)!.state, "finished");
    client.socket.destroy();
  } finally {
    process.env.APPDATA = before.APPDATA;
    if (before.SOFT === undefined) delete process.env.FMC_SOFT_TIMEOUT_MS; else process.env.FMC_SOFT_TIMEOUT_MS = before.SOFT;
  }
});

test("F-033/F-034: send_code results read in English with the code, the line and compile time apart from run time", async () => {
  const { formatCodeResult, SEND_CODE_SHAPE } = await import("../tools/send_code_to_revit.js");
  const ok = formatCodeResult({ success: true, result: "{\"walls\":12}", compileMs: 850, runMs: 40, job: "1", warnings: ["Highlighted walls overlap"] });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /compile 850 ms, run 40 ms/);
  assert.deepEqual(JSON.parse(ok.text.split("\n").slice(1).join("\n")).result, { walls: 12 });

  const bad = formatCodeResult({ success: false, errorCode: "FMC-CODE-RUNTIME", compileMs: 700, runMs: 3,
    errorMessage: "[FMC-CODE-RUNTIME] InvalidOperationException at line 4: The referenced object is not valid",
    error: { type: "Autodesk.Revit.Exceptions.InvalidOperationException", message: "The referenced object is not valid", line: 4 } });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /\[FMC-CODE-RUNTIME\] InvalidOperationException at line 4/);
  assert.doesNotMatch(bad.text, /[\u4e00-\u9fff]/, "no Chinese text");
  assert.doesNotMatch(bad.text, /target of an invocation/);

  // F-035: usings are namespaces only; the size limit is documented in the schema.
  const shape = (await import("zod")).z.object(SEND_CODE_SHAPE);
  assert.equal(shape.safeParse({ code: "return 1;", usings: ["System.IO", "using static System.Math;", "Arch = Autodesk.Revit.DB.Architecture"] }).success, true);
  assert.equal(shape.safeParse({ code: "return 1;", usings: ["System.IO; class X {}"] }).success, false);
  assert.equal(shape.safeParse({ code: "x".repeat(1_000_001) }).success, false);
});

test("F-041: the AI-modeller rulebook: AIUse first, then the kit's ClaudeUse; a missing section is a Fail with the fix", () => {
  const aiuse = JSON.stringify({ schema: "fmc-aiuse/0.1", default_involvement: 0, bands: [{ min: 0, max: 100, name: "All", groups: ["views"] }],
    groups: { views: { name: "Views", auto_allowed: false } }, limits: { batch_elements: 50, daily_elements: 500, failed_batches_per_day: 3 } });
  const claudeUse = JSON.stringify({ feature: "ClaudeUse", rulebook_version: "0.1-draft", rules: [{ id: "AI-001", title: "Live-model lock" }] });

  const none = pickAiRulebook([]);
  assert.equal(none.book, null);
  assert.match(none.problems[0], /Neither FMC_Rulebook_AIUse.json nor FMC_Rulebook_ClaudeUse.json/);

  const kitToday = pickAiRulebook([{ name: AIUSE_FILES[1], raw: claudeUse }]);
  assert.equal(kitToday.book, null);
  assert.equal(kitToday.file, "FMC_Rulebook_ClaudeUse.json", "says which file it read");
  assert.match(kitToday.problems[0], /FMC_Rulebook_ClaudeUse.json has no AI-modeller section/);

  const withSection = pickAiRulebook([{ name: "FMC_Rulebook_ClaudeUse.json", raw: JSON.stringify({ ...JSON.parse(claudeUse), ai_use: JSON.parse(aiuse) }) }]);
  assert.ok(withSection.book);
  assert.equal(withSection.section, "ai_use");

  const both = pickAiRulebook([{ name: "FMC_Rulebook_ClaudeUse.json", raw: claudeUse }, { name: "FMC_Rulebook_AIUse.json", raw: aiuse }]);
  assert.equal(both.file, "FMC_Rulebook_AIUse.json");
  assert.equal(both.section, "whole file");

  const fail = aiRulebookLine({ book: null, file: "Z:\\R\\FMC_Rulebook_ClaudeUse.json", section: "", problems: kitToday.problems }, "Z:\\R");
  assert.equal(fail.state, "Fail");
  assert.match(fail.detail, /Fix: add FMC_Rulebook_AIUse.json/);
  assert.match(fail.detail, /kit change request/);
  const pass = aiRulebookLine({ book: {}, file: "Z:\\R\\FMC_Rulebook_ClaudeUse.json", section: "ai_use", problems: [] }, "Z:\\R");
  assert.equal(pass.state, "Pass");
  assert.match(pass.detail, /Read FMC_Rulebook_ClaudeUse.json \(section ai_use\)/);
});

test("F-064: a job the server stopped waiting for stays running while Revit's heartbeats come; Revit's own result finishes it", async () => {
  const { lastHeartbeatMs } = await import("./jobs.js");
  const env = home();
  const f = jobFiles(env);
  line(f.server, { at: "2026-10-18T00:00:50Z", job: "777", event: "running", command: "send_code_to_revit", started: "2026-10-18T00:00:00Z" });
  line(f.revit, { at: "2026-10-18T00:00:20Z", job: "777", command: "send_code_to_revit", event: "running", started: "2026-10-18T00:00:00Z" });
  line(f.server, { at: "2026-10-18T00:35:00Z", job: "777", event: "gave_up", command: "send_code_to_revit", after_s: 2100 });
  line(f.revit, { at: "2026-10-18T02:10:00Z", job: "777", command: "send_code_to_revit", event: "heartbeat", ms: 7800000 });
  let j = findJob("777", env)!;
  assert.equal(j.state, "running", "heartbeats after the server gave up: still running, not no_answer");
  assert.match(j.summary, /last heartbeat at 2026-10-18T02:10:00Z \(this server stopped waiting at 2026-10-18T00:35:00Z; Revit keeps the answer\)/);
  assert.equal(lastHeartbeatMs("777", env), Date.parse("2026-10-18T02:10:00Z"));
  assert.equal(lastHeartbeatMs("nope", env), 0);
  // Revit writes the result itself when the job ends
  line(f.revit, { at: "2026-10-18T03:00:00Z", job: "777", command: "send_code_to_revit", event: "finished", ms: 10800000, ok: true });
  line(f.late, { at: "2026-10-18T03:00:00Z", job: "777", command: "send_code_to_revit", from: "revit", result: { result: { success: true, result: "{\"built\":590}" } } });
  j = findJob("777", env)!;
  assert.equal(j.state, "finished");
  assert.deepEqual(jobResult("777", env).result, { result: { success: true, result: "{\"built\":590}" } });
});

test("F-064: job times are shown in local time with the offset beside the UTC ones", async () => {
  const { localIso } = await import("./jobs.js");
  assert.equal(localIso("2026-10-18T06:03:47Z", 180), "2026-10-18T09:03:47+03:00");
  assert.equal(localIso("2026-10-18T22:30:00.000Z", 180), "2026-10-19T01:30:00+03:00");
  assert.equal(localIso("2026-10-18T06:03:47Z", -300), "2026-10-18T01:03:47-05:00");
  assert.equal(localIso(undefined), undefined);
  assert.equal(localIso("not a time"), undefined);
  const env = home();
  line(jobFiles(env).server, { at: "2026-10-18T00:00:50Z", job: "888", event: "running", command: "fmc_doc", started: "2026-10-18T00:00:00Z" });
  assert.match(findJob("888", env)!.local!.started!, /^2026-10-1[78]T\d\d:00:00[+-]\d\d:\d\d$/);
});
