import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FairQueue, StillQueued } from "./fairqueue.js";
import { inFlightJob } from "./notidle.js";
import { queueBusyReason, decideCancel, jobIsStale, markRevitCancelled, rowFromRevit, selectStale, type QueueListRow } from "./queueops.js";
import { findJob } from "./jobs.js";

const row = (over: Partial<QueueListRow>): QueueListRow => ({
  job_id: "job1", state: "queued", age_s: 120, document: "E-0001_USER", tool: "fmc_circuits",
  lease_holder: "", caller: "stdio", instance: "port 8080", source: "revit", stale: true, revit_idle: true,
  busy_reason: "job running fmc_circuits for 120 s",
  ...over,
});

test("a queued job can be cancelled, and a live running job is FMC-JOB-RUNNING", () => {
  const queued = decideCancel(row({}));
  assert.equal(queued.ok, true);
  assert.match(queued.busy_reason, /job running fmc_circuits for 120 s/);
  const running = decideCancel(row({ state: "running", stale: false, revit_idle: false, age_s: 40 }));
  assert.equal(running.ok, false);
  assert.equal(running.code, "FMC-JOB-RUNNING");
  assert.match(running.busy_reason, /job running/);
  const stale = decideCancel(row({ state: "running", stale: true, revit_idle: true, age_s: 400 }));
  assert.equal(stale.ok, true);
  assert.equal(decideCancel(null).code, "FMC-QUEUE-UNKNOWN");
});

test("purge_stale selects queued jobs older than the limit and leaves a fresh one", () => {
  const jobs = [
    row({ job_id: "old", age_s: 600 }),
    row({ job_id: "new", age_s: 20 }),
    row({ job_id: "run", state: "running", age_s: 900 }),
  ];
  const picked = selectStale(jobs, 5);
  assert.deepEqual(picked.map((item) => item.job_id), ["old"]);
});

test("a queued-only job older than a minute is not in flight, and a heartbeat still is", () => {
  const now = Date.now();
  const queued = [{ at: new Date(now - 90_000).toISOString(), job: "stuck", command: "fmc_doc_apply", pid: 7, event: "queued", started: new Date(now - 90_000).toISOString() }];
  assert.equal(inFlightJob(queued, 7, now), null);
  const fresh = [{ at: new Date(now - 10_000).toISOString(), job: "wait", command: "fmc_doc_apply", pid: 7, event: "queued", started: new Date(now - 10_000).toISOString() }];
  assert.equal(inFlightJob(fresh, 7, now)?.job, "wait");
  assert.equal(jobIsStale("queued", 90, true, true), true);
  assert.equal(jobIsStale("running", 40, false, false), false);
});

test("cancel of a fair-queue job that has not started rejects it, and a running one is refused", async () => {
  const queue = new FairQueue();
  let started = false;
  const blocker = queue.enqueue("arch", "fmc_model_edit", () => new Promise((resolve) => setTimeout(resolve, 80)), 5000, "A_USER");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const waiting = queue.enqueue("elec", "fmc_circuits", async () => { started = true; }, 5000, "E_USER");
  const snap = queue.snapshot();
  const queued = snap.jobs.find((job) => job.state === "queued");
  assert.ok(queued);
  assert.equal(queue.cancelQueued(queued!.job_id), "cancelled");
  await assert.rejects(waiting, (error: unknown) => error instanceof Error && /FMC-QUEUE-CANCELLED/.test(error.message) && /busy_reason:/.test(error.message));
  assert.equal(started, false);
  const running = snap.jobs.find((job) => job.state === "running");
  if (running) assert.equal(queue.cancelQueued(running.job_id), "running");
  await blocker;
});

test("a queue wait names the job that is running", async () => {
  const queue = new FairQueue();
  const blocker = queue.enqueue("arch", "fmc_model_edit", () => new Promise((resolve) => setTimeout(resolve, 80)));
  const waiting = queue.enqueue("struct", "fmc_docs", async () => 1, 30);
  await assert.rejects(waiting, (error: unknown) => {
    assert.ok(error instanceof StillQueued);
    assert.match(error.busy_reason, /job running fmc_model_edit|Revit not idle/);
    assert.match(error.message, /busy_reason:/);
    return true;
  });
  await blocker;
});

test("marking a stale revit job cancelled takes it out of the open list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-queue-"));
  const env = { APPDATA: dir } as NodeJS.ProcessEnv;
  const home = path.join(dir, "Formcraft");
  fs.mkdirSync(home, { recursive: true });
  const started = new Date(Date.now() - 120_000).toISOString();
  fs.writeFileSync(path.join(home, "FMC_Jobs_Revit.jsonl"), JSON.stringify({
    at: started, job: "abc123", command: "fmc_circuits", event: "queued", started,
  }) + "\n");
  const before = rowFromRevit(findJob("abc123", env)!, Date.now());
  assert.equal(before.state, "queued");
  markRevitCancelled("abc123", "fmc_circuits", env);
  assert.equal(findJob("abc123", env)?.state, "cancelled");
});

test("a stale running log entry while Revit is idle does not make the queue busy (live test 23 Nov 2026)", () => {
  const ghost = { job_id: "old", state: "running" as const, age_s: 1022517, document: "", tool: "send_code_to_revit", lease_holder: "", caller: "", instance: "port 8080", source: "revit" as const, stale: true, revit_idle: true, busy_reason: "job running send_code_to_revit for 1022517 s" };
  const live = { ...ghost, job_id: "new", age_s: 12, stale: false, revit_idle: false, tool: "fmc_trace", busy_reason: "job running fmc_trace for 12 s" };
  assert.equal(queueBusyReason([ghost]), null);
  assert.equal(queueBusyReason([]), null);
  assert.equal(queueBusyReason([ghost, live]), "job running fmc_trace for 12 s");
  const unknown = decideCancel(null, queueBusyReason([ghost]));
  assert.equal(unknown.code, "FMC-QUEUE-UNKNOWN");
  assert.doesNotMatch(unknown.busy_reason, /not idle|1022517/);
});

test("QU-4/QU-5/QU-6/QU-9: filter and count the list, mark mine, pick stale running log entries, wait until free", async () => {
  const { blockingRows, countByTool, filterRows, isMine, selectStaleRunning } = await import("./queueops.js");
  const { waitForQueue } = await import("../tools/fmc_queue.js");
  const rows = [
    row({ job_id: "a", document: "E-0001_USER", caller: "Builder 5", stale: false, revit_idle: false, state: "running", tool: "fmc_qa" }),
    row({ job_id: "b", document: "A-0001_USER", caller: "Other Bot", tool: "fmc_qa" }),
    row({ job_id: "c", document: "E-0001_USER", caller: "stdio", state: "running", stale: true, revit_idle: true, tool: "fmc_circuits" }),
  ];
  assert.deepEqual(filterRows(rows, { document: "e-0001" }).map((r) => r.job_id), ["a", "c"]);
  assert.deepEqual(filterRows(rows, { only_live: true }).map((r) => r.job_id), ["a"]);
  assert.deepEqual(filterRows(rows, { mine_only: true, me: "builder 5" }).map((r) => r.job_id), ["a"]);
  assert.deepEqual(filterRows(rows, { state: "queued" }).map((r) => r.job_id), ["b"]);
  assert.deepEqual(countByTool(rows), { fmc_qa: 2, fmc_circuits: 1 });
  assert.equal(isMine(rows[1], "unknown"), false);
  assert.deepEqual(selectStaleRunning(rows).map((r) => r.job_id), ["c"]);
  assert.deepEqual(blockingRows(rows, "E-0001").map((r) => r.job_id), ["a"]);

  let t = 0;
  let calls = 0;
  const free = await waitForQueue(5, "E-0001", { list: () => (++calls < 3 ? rows : rows.slice(1)), sleep: async (ms) => { t += ms; }, clock: () => t });
  assert.equal(free.free, true);
  assert.equal(free.waited_s, 2);
  t = 0;
  const busy = await waitForQueue(3, "E-0001", { list: () => rows, sleep: async (ms) => { t += ms; }, clock: () => t });
  assert.equal(busy.free, false);
  assert.equal(busy.waited_s, 3);
});
