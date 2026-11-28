/**
 * fmc_queue list, cancel and purge_stale.
 * A queued job that never started must not sit in front of every later call with no reason.
 * Cancel removes a queued job. A running job is refused with FMC-JOB-RUNNING unless it is stale and Revit is idle.
 */
import fs from "node:fs";
import path from "node:path";
import { IDLE_BUSY, jobBusyReason, leaseBusyReason, pickBusyReason } from "./busyreason.js";
import { FairQueue, queueFor, type QueueJobRow } from "./fairqueue.js";
import { JOB_ID, appendJobEvent, collectJobs, jobFiles, requestCancel, type JobView } from "./jobs.js";
import { FLIGHT_FRESH_MS, QUEUE_ONLY_FRESH_MS } from "./notidle.js";

export interface QueueListRow {
  job_id: string;
  state: "queued" | "running";
  age_s: number;
  document: string;
  tool: string;
  lease_holder: string;
  caller: string;
  instance: string;
  source: "fair" | "revit" | "lease";
  stale: boolean;
  revit_idle: boolean;
  busy_reason: string;
}

export interface LeaseRow {
  lease: string;
  document: string;
  bot: string;
  client: string;
  label: string;
  since?: string;
}

export function ageSeconds(iso: string | undefined, now: number): number {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((now - t) / 1000));
}

export function revitIdle(heartbeatIso: string | undefined, now: number, freshMs = FLIGHT_FRESH_MS): boolean {
  const t = Date.parse(heartbeatIso ?? "");
  if (!Number.isFinite(t)) return true;
  return now - t > freshMs;
}

/** A queued-only job older than the short window is stale even if a running job's fresh window is longer. */
export function jobIsStale(state: "queued" | "running", ageS: number, idle: boolean, queuedOnly = false): boolean {
  if (!idle) return false;
  if (state === "queued" && (queuedOnly || ageS * 1000 >= QUEUE_ONLY_FRESH_MS)) return ageS * 1000 >= QUEUE_ONLY_FRESH_MS;
  return ageS * 1000 >= FLIGHT_FRESH_MS;
}

export function rowFromFair(job: QueueJobRow, instance: string, idle: boolean, holder = ""): QueueListRow {
  const stale = jobIsStale(job.state, job.age_s, idle, job.state === "queued");
  return {
    job_id: job.job_id,
    state: job.state,
    age_s: job.age_s,
    document: job.document,
    tool: job.tool,
    lease_holder: holder,
    caller: job.caller,
    instance,
    source: "fair",
    stale,
    revit_idle: idle,
    busy_reason: pickBusyReason({
      tool: job.tool,
      age_s: job.age_s,
      running: true,
      lease_holder: holder || undefined,
      document: job.document,
    }),
  };
}

export function rowFromRevit(job: JobView, now: number, holder = "", document = ""): QueueListRow {
  const state: "queued" | "running" = job.state === "queued" ? "queued" : "running";
  const age = ageSeconds(job.started, now);
  const idle = revitIdle(job.revit?.heartbeat_at, now);
  const queuedOnly = state === "queued";
  const stale = jobIsStale(state, age, idle, queuedOnly);
  return {
    job_id: job.job,
    state,
    age_s: age,
    document,
    tool: job.command,
    lease_holder: holder,
    caller: "",
    instance: job.port != null ? `port ${job.port}` : "",
    source: "revit",
    stale,
    revit_idle: idle,
    busy_reason: pickBusyReason({
      dialog: job.dialogs.at(-1)?.message,
      tool: job.command,
      age_s: age,
      running: true,
      lease_holder: holder || undefined,
      document,
    }),
  };
}

export function rowFromLease(lease: LeaseRow, now: number, instance = ""): QueueListRow {
  const age = ageSeconds(lease.since, now);
  return {
    job_id: lease.lease,
    state: "running",
    age_s: age,
    document: lease.document,
    tool: lease.label || "batch",
    lease_holder: lease.bot || lease.client,
    caller: lease.client,
    instance,
    source: "lease",
    stale: false,
    revit_idle: true,
    busy_reason: leaseBusyReason(lease.bot || lease.client, lease.document),
  };
}

/**
 * The reason the queue is busy now. Rows are sorted oldest first, so the first row is often a stale log entry
 * (a job that still says running days later while Revit is idle). Stale rows never make the queue busy:
 * the first live row names the reason, and with only stale rows (or none) the queue is not busy (null).
 */
export function queueBusyReason(rows: QueueListRow[]): string | null {
  const live = rows.find((row) => !(row.stale && row.revit_idle));
  return live ? live.busy_reason : null;
}

export interface CancelDecision {
  ok: boolean;
  code?: "FMC-JOB-RUNNING" | "FMC-QUEUE-UNKNOWN";
  busy_reason: string;
  message: string;
}

/**
 * Queued jobs can be cancelled. A running job is refused unless it is stale and Revit is idle:
 * the log still says running, but Revit has stopped heartbeating.
 */
export function decideCancel(row: QueueListRow | null, queueBusy: string | null = IDLE_BUSY): CancelDecision {
  if (!row) {
    return { ok: false, code: "FMC-QUEUE-UNKNOWN", busy_reason: queueBusy ?? "none: no live job (Revit idle)", message: "No queued or running job with that id. fmc_queue list shows them." };
  }
  if (row.state === "queued") {
    return { ok: true, busy_reason: row.busy_reason, message: `Cancel queued ${row.tool} (${row.job_id}). It has not started.` };
  }
  if (row.stale && row.revit_idle) {
    return {
      ok: true,
      busy_reason: row.busy_reason || IDLE_BUSY,
      message: `Cancel stale ${row.tool} (${row.job_id}). Revit is idle, so the log entry is not a live command.`,
    };
  }
  return {
    ok: false,
    code: "FMC-JOB-RUNNING",
    busy_reason: row.busy_reason || jobBusyReason(row.tool, row.age_s),
    message: `${row.tool} is running. Cancel is refused until it is stale and Revit is idle.`,
  };
}

export interface QueueFilter {
  document?: string;
  caller?: string;
  state?: "queued" | "running";
  only_live?: boolean;
  mine_only?: boolean;
  me?: string;
}

/** QU-6: a row is mine when its caller (or the lease holder) is this client. */
export function isMine(row: QueueListRow, me: string): boolean {
  const who = me.trim().toLowerCase();
  if (!who || who === "unknown") return false;
  return row.caller.trim().toLowerCase() === who || row.lease_holder.trim().toLowerCase() === who;
}

/** QU-4: list scoped by document (title, case-insensitive, part of it), caller, state, live only (not stale) and mine only. */
export function filterRows(rows: QueueListRow[], f: QueueFilter): QueueListRow[] {
  const doc = (f.document ?? "").trim().toLowerCase();
  const caller = (f.caller ?? "").trim().toLowerCase();
  return rows.filter((row) => (!doc || row.document.toLowerCase().includes(doc))
    && (!caller || row.caller.toLowerCase().includes(caller) || row.lease_holder.toLowerCase().includes(caller))
    && (!f.state || row.state === f.state)
    && (!f.only_live || !row.stale)
    && (!f.mine_only || isMine(row, f.me ?? "")));
}

/** QU-4: jobs per tool, so one small call says what is waiting. */
export function countByTool(rows: QueueListRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.tool || "(none)"] = (out[row.tool || "(none)"] ?? 0) + 1;
  return out;
}

/** QU-5: Revit log entries that say running while Revit is idle (the same stale rule as the list); not a live job. */
export function selectStaleRunning(rows: QueueListRow[]): QueueListRow[] {
  return rows.filter((row) => row.state === "running" && row.source === "revit" && row.stale && row.revit_idle);
}

export function selectStale(rows: QueueListRow[], olderThanMin: number): QueueListRow[] {
  const minS = Math.max(0, olderThanMin) * 60;
  return rows.filter((row) => row.state === "queued" && row.age_s >= minS);
}

export function cancelFair(id: string, port?: number): "cancelled" | "running" | "missing" {
  if (port != null) return queueFor(port).cancelQueued(id);
  return "missing";
}

export function purgeFair(olderThanMin: number, ports: number[], now = Date.now()): QueueJobRow[] {
  const ms = Math.max(0, olderThanMin) * 60 * 1000;
  const rows: QueueJobRow[] = [];
  for (const port of ports) rows.push(...queueFor(port).purgeQueued(ms, now));
  return rows;
}

/** Test hook: the fair queues are process-wide. */
export function fairQueue(port: number): FairQueue {
  return queueFor(port);
}

/** A cancelled line in Revit's job record, so a stale queued job stops counting as in flight. */
export function markRevitCancelled(id: string, command: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!JOB_ID.test(id)) throw new Error(`Not a job id: ${id}`);
  const file = jobFiles(env).revit;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), job: id, event: "cancelled", command }) + "\n");
  appendJobEvent({ job: id, event: "cancel_requested", command }, env);
  try { requestCancel(id, env); } catch { /* the log line is the unblock; the cancel file is best effort */ }
}

export function openRevitJobs(env: NodeJS.ProcessEnv, now: number): QueueListRow[] {
  return collectJobs(env)
    .filter((job) => job.state === "queued" || job.state === "running" || job.state === "waiting_for_dialog")
    .map((job) => rowFromRevit(job.state === "waiting_for_dialog" ? { ...job, state: "running" } : job, now));
}
