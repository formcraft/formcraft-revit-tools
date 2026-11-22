import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScriptJobQueue, jobSummary, resetScriptJobs } from "./scriptjobs.js";

function dirs(): { queueFile: string; resultsRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-jobs-"));
  return { queueFile: path.join(root, "queue.json"), resultsRoot: path.join(root, "results") };
}

function clock(start = 0): () => string {
  let n = start;
  return () => {
    n += 1;
    return `2026-11-22T00:00:${String(n).padStart(2, "0")}Z`;
  };
}

let seq = 0;
function ids(): string {
  seq += 1;
  return "sj" + String(seq).padStart(4, "0");
}

test("submit returns immediately, keeps order, and one job runs at a time", () => {
  seq = 0;
  const queue = ScriptJobQueue.open({ ...dirs(), now: clock(), ids });
  const first = queue.submit({ kind: "dynamo", document: "Architecture", mode: "preview", priority: 0, graph: "A.dyn" });
  const second = queue.submit({ kind: "script", document: "Architecture", mode: "preview", priority: 5, script_id: "sheets" });
  assert.equal(first.ok && first.state, "queued");
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.position, 1, "it was the only job when it was submitted");
  assert.equal(second.position, 1, "higher priority is ahead of the job already queued");
  const claimed = queue.claim("default");
  assert.equal(claimed?.job_id, second.job_id);
  assert.equal(queue.claim("default"), null, "one running job per Revit");
  queue.finish(second.job_id, "finished", { ok: true });
  assert.equal(queue.claim("default")?.job_id, first.job_id);
});

test("cancel removes a queued job and marks a running job to stop at the next safe point", () => {
  seq = 0;
  const cancelled: string[] = [];
  const queue = ScriptJobQueue.open({ ...dirs(), now: clock(), ids, onCancel: (job) => cancelled.push(job.job_id) });
  const queued = queue.submit({ kind: "dynamo", document: "A", mode: "preview", graph: "A.dyn" });
  assert.equal(queued.ok, true);
  if (!queued.ok) return;
  const gone = queue.cancel(queued.job_id);
  assert.equal(gone.ok, true);
  if (!gone.ok) return;
  assert.equal(gone.job.state, "cancelled");
  assert.equal(queue.claim("default"), null);
  const running = queue.submit({ kind: "dynamo", document: "A", mode: "preview", graph: "B.dyn" });
  assert.equal(running.ok, true);
  if (!running.ok) return;
  assert.ok(queue.claim("default"));
  const stop = queue.cancel(running.job_id);
  assert.equal(stop.ok, true);
  if (!stop.ok) return;
  assert.equal(stop.job.state, "running");
  assert.equal(stop.job.cancel_requested, true);
  assert.deepEqual(cancelled, [running.job_id]);
  queue.finish(running.job_id, "cancelled", { rolled_back: true, mode: "preview" });
  assert.equal(queue.status(running.job_id)?.state, "cancelled");
});

test("a restart keeps queued jobs and marks a running job interrupted", () => {
  seq = 0;
  const place = dirs();
  const now = clock();
  const first = ScriptJobQueue.open({ ...place, now, ids });
  const queued = first.submit({ kind: "script", document: "A", mode: "preview", script_id: "sheets" });
  const running = first.submit({ kind: "dynamo", document: "A", mode: "preview", priority: 1, graph: "A.dyn" });
  assert.equal(queued.ok && running.ok, true);
  if (!running.ok) return;
  first.claim("default");
  const again = ScriptJobQueue.open({ ...place, now, ids });
  assert.equal(again.status(running.job_id)?.state, "interrupted");
  assert.match(again.status(running.job_id)?.error ?? "", /not started again/);
  assert.equal(again.claim("default")?.job_id, queued.ok ? queued.job_id : "");
  const text = fs.readFileSync(place.queueFile, "utf8");
  assert.equal(text.includes("interrupted"), true);
  assert.equal(text.includes("%APPDATA%"), false);
});

test("apply needs a lease for that document, and the lease is heartbeated while queued and running", () => {
  seq = 0;
  const beats: string[] = [];
  const queue = ScriptJobQueue.open({
    ...dirs(), now: clock(), ids,
    leaseHeld: (lease) => (lease === "lease-a" ? "Architecture" : undefined),
    leaseCovers: (held, document) => held.toLowerCase() === document.toLowerCase(),
    onHeartbeat: (job) => beats.push(job.job_id),
  });
  const missing = queue.submit({ kind: "dynamo", document: "Architecture", mode: "apply", graph: "A.dyn" });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.code, "FMC-BATCH-LOCKED");
  const wrong = queue.submit({ kind: "dynamo", document: "Structure", mode: "apply", batch_lease: "lease-a", graph: "A.dyn" });
  assert.equal(wrong.ok, false);
  const preview = queue.submit({ kind: "dynamo", document: "Architecture", mode: "preview", graph: "A.dyn" });
  assert.equal(preview.ok, true);
  const apply = queue.submit({ kind: "script", document: "Architecture", mode: "apply", batch_lease: "lease-a", script_id: "sheets" });
  assert.equal(apply.ok, true);
  if (!apply.ok) return;
  assert.equal(queue.heartbeatAll(), 1);
  queue.claim("default");
  assert.equal(queue.heartbeatAll(), 1);
  assert.ok(beats.includes(apply.job_id));
  assert.ok((queue.status(apply.job_id)?.heartbeats ?? 0) >= 1);
  const result = path.join(queue.status(apply.job_id)!.result_ref, "result.json");
  queue.finish(apply.job_id, "finished", {
    diff: { created: [], modified: [], deleted: [] },
    outputs: {},
    resolved_document: { title: "Architecture", path: "D:\\A.rvt" },
    auto_saved: false,
    batch_end_sync: { status: "deferred", reason: "The lease is still held.", pending: true },
  });
  const body = JSON.parse(fs.readFileSync(result, "utf8")) as { auto_saved: boolean; batch_end_sync: { status: string }; resolved_document: { title: string } };
  assert.equal(body.auto_saved, false);
  assert.equal(body.batch_end_sync.status, "deferred");
  assert.equal(body.resolved_document.title, "Architecture");
});

test("job summary reads the queue file and does not require a live profile", () => {
  resetScriptJobs();
  const place = dirs();
  const env = { FMC_JOBS_QUEUE: place.queueFile, FMC_LOCAL_JOBS: place.resultsRoot };
  assert.deepEqual(jobSummary(env), { queued: 0, running: 0, last_finished: null });
  const queue = ScriptJobQueue.open({ ...place, now: clock(), ids: () => "sj0009" });
  const made = queue.submit({ kind: "dynamo", document: "A", mode: "preview", graph: "A.dyn" });
  assert.equal(made.ok, true);
  const summary = jobSummary(env);
  assert.equal(summary.queued, 1);
  assert.equal(summary.running, 0);
  assert.equal(JSON.stringify(summary).includes("AppData"), false);
});
