/**
 * One queue for Dynamo graphs and library scripts.
 * submit returns immediately. One job runs at a time for each Revit instance.
 * The queue file is %APPDATA%\Formcraft\jobs\queue.json. Results are %LOCALAPPDATA%\Formcraft\jobs\<job_id>\.
 * Tests pass FMC_JOBS_QUEUE and FMC_LOCAL_JOBS and never touch a live profile.
 * A job that was running when the process starts is marked interrupted and is not started again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { batchBoard, documentsMatch, leaseHeldDocument } from "./batchline.js";
import { leaseCovers } from "./docresolve.js";
import { currentClient } from "./fairqueue.js";
import { jobFiles } from "./jobs.js";

export const JOB_STATES = ["queued", "running", "cancelled", "finished", "failed", "interrupted"] as const;
export type ScriptJobState = (typeof JOB_STATES)[number];

export interface ScriptJob {
  job_id: string;
  kind: "dynamo" | "script";
  state: ScriptJobState;
  document: string;
  priority: number;
  label: string;
  mode: "preview" | "apply" | "offline";
  batch_lease: string;
  client: string;
  revit_key: string;
  graph: string;
  script_id: string;
  inputs: unknown;
  created_at: string;
  started_at: string;
  finished_at: string;
  result_ref: string;
  error: string;
  cancel_requested: boolean;
  heartbeats: number;
  last_heartbeat: string;
  log: string[];
}

export interface SubmitInput {
  kind: "dynamo" | "script";
  document: string;
  mode: "preview" | "apply" | "offline";
  priority?: number;
  label?: string;
  batch_lease?: string;
  client?: string;
  revit_key?: string;
  graph?: string;
  script_id?: string;
  inputs?: unknown;
}

export interface QueueOptions {
  queueFile: string;
  resultsRoot: string;
  now?: () => string;
  ids?: () => string;
  /** The document a lease is held for. Omit in a test that only checks the lease string is present. */
  leaseHeld?: (lease: string) => string | undefined;
  leaseCovers?: (held: string, document: string) => boolean;
  onHeartbeat?: (job: ScriptJob) => void;
  onCancel?: (job: ScriptJob) => void;
}

export interface JobSummary {
  queued: number;
  running: number;
  last_finished: string | null;
}

const EMPTY_SUMMARY: JobSummary = { queued: 0, running: 0, last_finished: null };

function rank(a: ScriptJob, b: ScriptJob): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0;
}

function summarize(jobs: ScriptJob[]): JobSummary {
  const done = jobs.filter((job) => job.finished_at && job.state !== "queued" && job.state !== "running");
  done.sort((a, b) => (a.finished_at < b.finished_at ? 1 : a.finished_at > b.finished_at ? -1 : 0));
  return {
    queued: jobs.filter((job) => job.state === "queued").length,
    running: jobs.filter((job) => job.state === "running").length,
    last_finished: done[0]?.finished_at || null,
  };
}

function positionOf(jobs: ScriptJob[], id: string): number {
  const queued = jobs.filter((job) => job.state === "queued").sort(rank);
  const index = queued.findIndex((job) => job.job_id === id);
  return index < 0 ? 0 : index + 1;
}

export function queueOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { queueFile: string; resultsRoot: string } | null {
  const queueFile = (env.FMC_JOBS_QUEUE ?? "").trim()
    || (env.APPDATA ? path.join(env.APPDATA, "Formcraft", "jobs", "queue.json") : "");
  const resultsRoot = (env.FMC_LOCAL_JOBS ?? "").trim()
    || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Formcraft", "jobs") : "");
  if (!queueFile || !resultsRoot) return null;
  return { queueFile, resultsRoot };
}

export class ScriptJobQueue {
  readonly queueFile: string;
  readonly resultsRoot: string;
  private jobs: ScriptJob[] = [];
  private readonly now: () => string;
  private readonly ids: () => string;
  private readonly leaseHeld?: (lease: string) => string | undefined;
  private readonly leaseCovers?: (held: string, document: string) => boolean;
  private readonly onHeartbeat?: (job: ScriptJob) => void;
  private readonly onCancel?: (job: ScriptJob) => void;

  private constructor(opts: QueueOptions, jobs: ScriptJob[]) {
    this.queueFile = opts.queueFile;
    this.resultsRoot = opts.resultsRoot;
    this.jobs = jobs;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.ids = opts.ids ?? (() => "sj" + crypto.randomBytes(8).toString("hex"));
    this.leaseHeld = opts.leaseHeld;
    this.leaseCovers = opts.leaseCovers;
    this.onHeartbeat = opts.onHeartbeat;
    this.onCancel = opts.onCancel;
  }

  /** Load the queue. A job left running by the previous process becomes interrupted and is not started again. */
  static open(opts: QueueOptions): ScriptJobQueue {
    const jobs = readJobs(opts.queueFile);
    const queue = new ScriptJobQueue(opts, jobs);
    let changed = false;
    for (const job of jobs) {
      if (job.state === "running") {
        job.state = "interrupted";
        job.error = "Server restarted while this job was running. It was not started again.";
        job.finished_at = queue.now();
        queue.appendLog(job, job.error);
        changed = true;
      }
    }
    if (changed) queue.save();
    return queue;
  }

  summary(): JobSummary {
    return summarize(this.jobs);
  }

  submit(input: SubmitInput): { ok: true; job_id: string; state: "queued"; position: number } | { ok: false; code: string; message: string } {
    const document = input.document.trim();
    if (!document) {
      return { ok: false, code: "FMC-DOC-REQUIRED", message: "[FMC-DOC-REQUIRED] Pass document with a title or a full path. Refusing to use the active document." };
    }
    const mode = input.mode;
    const lease = (input.batch_lease ?? "").trim();
    if (mode === "apply" && !lease) {
      return { ok: false, code: "FMC-BATCH-LOCKED", message: "[FMC-BATCH-LOCKED] mode apply needs batch_lease for this document." };
    }
    if (mode === "apply" && this.leaseHeld) {
      const held = this.leaseHeld(lease);
      if (!held) return { ok: false, code: "FMC-BATCH-LOCKED", message: `[FMC-BATCH-LOCKED] Lease ${lease} is not held.` };
      const covers = this.leaseCovers ? this.leaseCovers(held, document) : held.trim().toLowerCase() === document.toLowerCase();
      if (!covers) return { ok: false, code: "FMC-BATCH-LOCKED", message: `[FMC-BATCH-LOCKED] Lease ${lease} is for ${held}, not ${document}.` };
    }
    const job: ScriptJob = {
      job_id: this.ids(),
      kind: input.kind,
      state: "queued",
      document,
      priority: Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0,
      label: (input.label ?? "").trim(),
      mode,
      batch_lease: lease,
      client: (input.client ?? "").trim(),
      revit_key: (input.revit_key ?? "").trim() || "default",
      graph: (input.graph ?? "").trim(),
      script_id: (input.script_id ?? "").trim(),
      inputs: input.inputs ?? {},
      created_at: this.now(),
      started_at: "",
      finished_at: "",
      result_ref: "",
      error: "",
      cancel_requested: false,
      heartbeats: 0,
      last_heartbeat: "",
      log: [],
    };
    job.result_ref = path.join(this.resultsRoot, job.job_id);
    this.jobs.push(job);
    this.appendLog(job, `queued ${job.kind} ${job.mode} ${job.document}`);
    this.save();
    this.writeResultDir(job);
    return { ok: true, job_id: job.job_id, state: "queued", position: positionOf(this.jobs, job.job_id) };
  }

  status(jobId: string): ScriptJob | null {
    return this.jobs.find((job) => job.job_id === jobId) ?? null;
  }

  list(filter: { state?: string; document?: string } = {}): ScriptJob[] {
    const state = (filter.state ?? "").trim();
    const document = (filter.document ?? "").trim().toLowerCase();
    return this.jobs.filter((job) => {
      if (state && job.state !== state) return false;
      if (document && job.document.toLowerCase() !== document) return false;
      return true;
    });
  }

  log(jobId: string, tail?: number): { job_id: string; lines: string[] } | null {
    const job = this.status(jobId);
    if (!job) return null;
    const file = path.join(job.result_ref || path.join(this.resultsRoot, job.job_id), "log.txt");
    let lines = job.log.slice();
    try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.length > 0); } catch { /* the memory log */ }
    const keep = tail && tail > 0 ? tail : 80;
    return { job_id: jobId, lines: lines.slice(-keep) };
  }

  /**
   * A queued job is removed from the run line. A running job is cancelled at the next safe point.
   * The caller rolls a preview back. This does not kill Revit.
   */
  cancel(jobId: string): { ok: true; job: ScriptJob } | { ok: false; code: string; message: string } {
    const job = this.status(jobId);
    if (!job) return { ok: false, code: "FMC-JOB-NOT-FOUND", message: `[FMC-JOB-NOT-FOUND] No script job ${jobId}.` };
    if (job.state === "queued") {
      job.state = "cancelled";
      job.finished_at = this.now();
      job.error = "Cancelled while queued. It did not run.";
      this.appendLog(job, job.error);
      this.save();
      return { ok: true, job };
    }
    if (job.state === "running") {
      job.cancel_requested = true;
      this.appendLog(job, "Cancel requested. It stops at the next safe point. A preview rolls back.");
      this.save();
      try { this.onCancel?.(job); } catch { /* the cancel file is best effort */ }
      return { ok: true, job };
    }
    return { ok: false, code: "FMC-JOB-NOT-RUNNING", message: `[FMC-JOB-NOT-RUNNING] Job ${jobId} is ${job.state}.` };
  }

  /** Keep an apply lease alive for every queued or running apply job. */
  heartbeatAll(): number {
    let n = 0;
    for (const job of this.jobs) {
      if ((job.state !== "queued" && job.state !== "running") || job.mode !== "apply" || !job.batch_lease) continue;
      job.heartbeats += 1;
      job.last_heartbeat = this.now();
      n += 1;
      try { this.onHeartbeat?.(job); } catch { /* a missed beat is logged by the caller */ }
    }
    if (n) this.save();
    return n;
  }

  /** The next queued job for this Revit, or null when one is already running there. */
  claim(revitKey: string): ScriptJob | null {
    const key = revitKey.trim() || "default";
    if (this.jobs.some((job) => job.state === "running" && job.revit_key === key)) return null;
    const next = this.jobs.filter((job) => job.state === "queued" && job.revit_key === key).sort(rank)[0];
    if (!next) return null;
    next.state = "running";
    next.started_at = this.now();
    this.appendLog(next, "running");
    this.save();
    return next;
  }

  cancelled(jobId: string): boolean {
    return this.status(jobId)?.cancel_requested === true;
  }

  append(jobId: string, line: string): void {
    const job = this.status(jobId);
    if (!job) return;
    this.appendLog(job, line);
    this.save();
  }

  finish(jobId: string, state: "finished" | "failed" | "cancelled", result: Record<string, unknown>): ScriptJob | null {
    const job = this.status(jobId);
    if (!job) return null;
    job.state = state;
    job.finished_at = this.now();
    if (typeof result.error === "string") job.error = result.error;
    const dir = job.result_ref || path.join(this.resultsRoot, job.job_id);
    job.result_ref = dir;
    this.writeResultDir(job);
    const body = { ...result, job_id: job.job_id, state, result_ref: dir };
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(body, null, 2));
    this.appendLog(job, `${state} result_ref ${dir}`);
    this.save();
    return job;
  }

  hasQueued(revitKey?: string): boolean {
    return this.jobs.some((job) => job.state === "queued" && (!revitKey || job.revit_key === revitKey));
  }

  private appendLog(job: ScriptJob, line: string): void {
    const row = `${this.now()} ${line}`;
    job.log.push(row);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
    try {
      const dir = job.result_ref || path.join(this.resultsRoot, job.job_id);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "log.txt"), row + "\n");
    } catch { /* the memory log still has the line */ }
  }

  private writeResultDir(job: ScriptJob): void {
    try { fs.mkdirSync(job.result_ref, { recursive: true }); } catch { /* finish reports the failure */ }
  }

  private save(): void {
    const dir = path.dirname(this.queueFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.queueFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ jobs: this.jobs }, null, 2));
    fs.renameSync(tmp, this.queueFile);
  }
}

function readJobs(file: string): ScriptJob[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { jobs?: ScriptJob[] };
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

const live = new Map<string, ScriptJobQueue>();

/** The process queue. Opening it marks a leftover running job interrupted. No file is written when the queue is empty and missing. */
function productionHooks(env: NodeJS.ProcessEnv): Partial<QueueOptions> {
  return {
    leaseHeld: (lease) => leaseHeldDocument(lease),
    leaseCovers: (held, document) => leaseCovers(held, { title: document, path: document }, documentsMatch),
    onHeartbeat: (job) => {
      if (!job.batch_lease) return;
      batchBoard().heartbeat(job.batch_lease, job.client || currentClient());
    },
    onCancel: (job) => {
      const dir = jobFiles(env).cancelDir;
      fs.mkdirSync(dir, { recursive: true });
      if (/^[A-Za-z0-9_-]{1,64}$/.test(job.job_id)) fs.writeFileSync(path.join(dir, job.job_id), "cancel\n");
    },
  };
}

export function scriptJobs(env: NodeJS.ProcessEnv = process.env, extra: Partial<QueueOptions> = {}): ScriptJobQueue | null {
  const locs = queueOptionsFromEnv(env);
  if (!locs) return null;
  const key = locs.queueFile + "|" + locs.resultsRoot;
  const existing = live.get(key);
  if (existing) return existing;
  const queue = ScriptJobQueue.open({ ...productionHooks(env), ...locs, ...extra });
  live.set(key, queue);
  return queue;
}

/** First read after a restart marks a leftover running job interrupted. A missing file is left missing. */
export function noteRestart(env: NodeJS.ProcessEnv = process.env): JobSummary {
  const locs = queueOptionsFromEnv(env);
  if (!locs || !fs.existsSync(locs.queueFile)) return { ...EMPTY_SUMMARY };
  return scriptJobs(env)?.summary() ?? { ...EMPTY_SUMMARY };
}

const runners = new Map<string, (job: ScriptJob) => Promise<Record<string, unknown>>>();
const pumping = new Set<string>();

/** Run queued jobs one at a time for this Revit. submit returns before this finishes. */
export function scheduleJobs(queue: ScriptJobQueue, revitKey: string, run: (job: ScriptJob) => Promise<Record<string, unknown>>): void {
  const key = queue.queueFile + "|" + revitKey;
  runners.set(key, run);
  if (pumping.has(key)) return;
  pumping.add(key);
  void (async () => {
    try {
      for (;;) {
        queue.heartbeatAll();
        const job = queue.claim(revitKey);
        if (!job) break;
        try {
          const result = await run(job);
          const state = result.cancelled === true ? "cancelled" : result.refused === true ? "failed" : "finished";
          queue.finish(job.job_id, state, result);
        } catch (error) {
          const current = queue.status(job.job_id);
          if (current && current.state === "running") {
            queue.finish(job.job_id, "failed", { error: error instanceof Error ? error.message : String(error), auto_saved: false });
          }
        }
      }
    } finally {
      pumping.delete(key);
      if (queue.hasQueued(revitKey)) {
        const again = runners.get(key);
        if (again) scheduleJobs(queue, revitKey, again);
      }
    }
  })();
}

/** For tests that must not keep a queue across cases. */
export function resetScriptJobs(): void {
  live.clear();
}

export function jobSummary(env: NodeJS.ProcessEnv = process.env): JobSummary {
  const locs = queueOptionsFromEnv(env);
  if (!locs) return { ...EMPTY_SUMMARY };
  const key = locs.queueFile + "|" + locs.resultsRoot;
  const existing = live.get(key);
  if (existing) return existing.summary();
  if (!fs.existsSync(locs.queueFile)) return { ...EMPTY_SUMMARY };
  try {
    return summarize(readJobs(locs.queueFile));
  } catch {
    return { ...EMPTY_SUMMARY };
  }
}

export function unusedHome(): string {
  return path.join(os.tmpdir(), "formcraft-jobs-unused");
}
