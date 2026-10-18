/**
 * Jobs (F-030 and F-036, issues #122 and #128; docs/BRIDGE.md).
 *
 * Every call to Revit is a job: its id is the JSON-RPC request id. A call that passes the bridge's answer limit
 * (FMC_SOFT_TIMEOUT_MS, 50 s: the MCP client cuts a call at about 60 s) answers "still running" with its job id, and
 * everything after that is kept in three append-only files in %APPDATA%\Formcraft, which fmc_job reads:
 *
 * - FMC_Jobs.jsonl: this server's record (running, cancel_requested, gave_up), one JSON line each;
 * - FMC_LateResults.jsonl: the final answer of a job that answered after its tool had replied (with `job`);
 * - FMC_Jobs_Revit.jsonl: what Revit itself saw (running, finished, dialog, cancelled), written by the add-in.
 *
 * F-064: Revit writes a "heartbeat" line every minute while a job runs, and writes a long job's result to the late-results
 * file itself. A job keeps "running" while its heartbeats come, even after this server stopped waiting for it, and the
 * server keeps waiting past its limit while they are fresh.
 *
 * Cancel is a request, never a kill: a file %APPDATA%\Formcraft\jobs\cancel\<job> that the add-in checks before the job
 * starts, at its cancel checks and before send_code commits. Revit is never closed or interrupted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function formcraftHome(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(base, "Formcraft");
}

export function jobFiles(env: NodeJS.ProcessEnv = process.env) {
  const dir = formcraftHome(env);
  return {
    server: path.join(dir, "FMC_Jobs.jsonl"),
    late: path.join(dir, "FMC_LateResults.jsonl"),
    revit: path.join(dir, "FMC_Jobs_Revit.jsonl"),
    cancelDir: path.join(dir, "jobs", "cancel"),
  };
}

export type JobEvent = { at?: string; job: string; event: string; command?: string; [k: string]: unknown };

/** One line in this server's job record; never throws (logging must never block the work). */
export function appendJobEvent(ev: JobEvent, env: NodeJS.ProcessEnv = process.env) {
  try {
    const file = jobFiles(env).server;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...ev }) + "\n");
  } catch {
    // never block the work
  }
}

/** The last `max` JSON lines of a file (bad lines skipped). */
export function readJsonLines(file: string, max = 3000): any[] {
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const out: any[] = [];
  for (const l of lines.slice(-max)) {
    try { out.push(JSON.parse(l.replace(/^﻿/, ""))); } catch { /* a torn line */ }
  }
  return out;
}

export type JobState = "running" | "waiting_for_dialog" | "finished" | "failed" | "cancelled" | "no_answer";

export interface JobView {
  job: string;
  command: string;
  port?: number;
  started: string;
  state: JobState;
  /** One line a person can read. */
  summary: string;
  cancel_requested?: string;
  revit?: { running_since?: string; heartbeat_at?: string; finished?: string; ms?: number; ok?: boolean; error?: string };
  /** The same times in this PC's local time with its offset, for a person reading them beside other logs (F-064). */
  local?: { started?: string; heartbeat?: string; finished?: string; result?: string };
  dialogs: Array<{ at: string; dialog_id: string; message: string; answer: string }>;
  result_at?: string;
  has_result: boolean;
}

interface Acc extends JobView { result?: unknown; gave_up?: string; revit_cancelled?: string; past_limit?: boolean }

function errorText(result: any): { code?: string; message?: string } | null {
  if (!result || typeof result !== "object") return null;
  if (result.error) return { message: String(result.error.message ?? result.error) };
  const r = result.result;
  if (r && typeof r === "object" && r.success === false) return { code: r.errorCode, message: r.errorMessage };
  return null;
}

/** Every job the three files know, newest first. Pure apart from reading the files. */
export function collectJobs(env: NodeJS.ProcessEnv = process.env): JobView[] {
  const files = jobFiles(env);
  const jobs = new Map<string, Acc>();
  const get = (id: string, at: string, command = ""): Acc => {
    let j = jobs.get(id);
    if (!j) { j = { job: id, command, started: at, state: "running", summary: "", dialogs: [], has_result: false }; jobs.set(id, j); }
    if (!j.command && command) j.command = command;
    if (at && at < j.started) j.started = at;
    return j;
  };

  for (const e of readJsonLines(files.server)) {
    if (typeof e?.job !== "string") continue;
    const j = get(e.job, String(e.started ?? e.at ?? ""), e.command);
    if (typeof e.port === "number") j.port = e.port;
    if (e.event === "running") j.past_limit = true;
    if (e.event === "cancel_requested") j.cancel_requested = String(e.at ?? "");
    if (e.event === "gave_up") j.gave_up = String(e.at ?? "");
  }
  for (const e of readJsonLines(files.revit)) {
    if (typeof e?.job !== "string" || !e.job) continue;
    const j = get(e.job, String(e.started ?? e.at ?? ""), e.command);
    j.revit ??= {};
    if (e.event === "running") j.revit.running_since = String(e.started ?? e.at ?? "");
    if (e.event === "heartbeat" || e.event === "running") j.revit.heartbeat_at = String(e.at ?? "");
    if (e.event === "finished") Object.assign(j.revit, { finished: String(e.at ?? ""), ms: e.ms, ok: e.ok, error: e.error });
    if (e.event === "cancelled") j.revit_cancelled = String(e.at ?? "");
    if (e.event === "dialog") j.dialogs.push({ at: String(e.at ?? ""), dialog_id: String(e.dialog_id ?? ""), message: String(e.message ?? ""), answer: String(e.answer ?? "") });
  }
  for (const e of readJsonLines(files.late)) {
    const id = typeof e?.job === "string" ? e.job : typeof e?.id === "string" ? e.id : "";
    if (!id) continue;
    const j = get(id, String(e.at ?? ""), e.command);
    j.result = e.result;
    j.result_at = String(e.at ?? "");
    j.has_result = true;
  }

  for (const j of jobs.values()) {
    const err = j.has_result ? errorText(j.result) : null;
    const cancelled = /CANCELLED/.test(`${err?.code ?? ""} ${err?.message ?? ""}`) || (!!j.revit_cancelled && !j.has_result);
    const last = j.dialogs[j.dialogs.length - 1];
    const openDialog = !!last && /^(left for a person|not answered)/.test(last.answer);
    if (cancelled) { j.state = "cancelled"; j.summary = `Cancelled: ${err?.message ?? "Revit stopped it at a cancel check"}`; }
    else if (j.has_result && err) { j.state = "failed"; j.summary = `Failed${err.code ? ` [${err.code}]` : ""}: ${err.message ?? "see result"}`; }
    else if (j.has_result) { j.state = "finished"; j.summary = `Finished at ${j.result_at}; ask fmc_job result for the answer`; }
    else if (j.revit?.finished && !j.past_limit) {
      j.state = j.revit.ok === false ? "failed" : "finished";
      j.summary = `Revit ended it in ${Math.round((j.revit.ms ?? 0) / 1000)} s, within the answer limit: its tool showed the answer` +
        (j.revit.ok === false ? ` (failed: ${j.revit.error ?? ""})` : "");
    }
    else if (j.revit?.finished) {
      j.state = j.revit.ok === false ? "failed" : "finished";
      j.summary = `Revit ended it at ${j.revit.finished} (${j.revit.ok === false ? `failed: ${j.revit.error ?? ""}` : "answered"}), ` +
        "but this server didn't receive the answer (the MCP server was restarted?): check the model or the staging folder before running it again";
    }
    else if (j.gave_up && j.revit?.heartbeat_at && j.revit.heartbeat_at > j.gave_up) {
      j.state = "running";
      j.summary = `Still running in Revit: last heartbeat at ${j.revit.heartbeat_at} (this server stopped waiting at ${j.gave_up}; Revit keeps the answer)`;
    }
    else if (j.gave_up) { j.state = "no_answer"; j.summary = `No answer from Revit by ${j.gave_up}: Revit may still be busy, or blocked by a dialog`; }
    else if (openDialog) { j.state = "waiting_for_dialog"; j.summary = `Revit shows a dialog waiting for a person: ${last.dialog_id} "${last.message}"`; }
    else {
      j.state = "running";
      j.summary = `Still running in Revit since ${j.revit?.running_since ?? j.started}` +
        (j.revit?.heartbeat_at ? `, last heartbeat ${j.revit.heartbeat_at}` : "") + (j.cancel_requested ? " (cancel requested)" : "");
    }
    j.local = { started: localIso(j.started), heartbeat: localIso(j.revit?.heartbeat_at), finished: localIso(j.revit?.finished), result: localIso(j.result_at) };
  }
  return [...jobs.values()].sort((a, b) => (b.started || "").localeCompare(a.started || "")).map(view);
}

/** An ISO time in this PC's local time with its offset, e.g. 2026-10-18T09:03:47+03:00 (undefined in, undefined out). */
export function localIso(iso: string | undefined, offsetMinutes?: number): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const off = offsetMinutes ?? -new Date(t).getTimezoneOffset();
  const d = new Date(t + off * 60000);
  const p = (n: number) => String(n).padStart(2, "0");
  const sign = off >= 0 ? "+" : "-", a = Math.abs(off);
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` +
    `${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

/** When Revit last said this job is alive (a running or heartbeat line), in ms since 1970; 0 when it never did. */
export function lastHeartbeatMs(job: string, env: NodeJS.ProcessEnv = process.env): number {
  let last = 0;
  for (const e of readJsonLines(jobFiles(env).revit, 2000)) {
    if (e?.job !== job || (e.event !== "heartbeat" && e.event !== "running")) continue;
    const t = Date.parse(String(e.at ?? ""));
    if (Number.isFinite(t) && t > last) last = t;
  }
  return last;
}

function view(j: Acc): JobView {
  const { result: _r, gave_up: _g, revit_cancelled: _c, past_limit: _p, ...rest } = j;
  return rest;
}

export function findJob(id: string, env: NodeJS.ProcessEnv = process.env): JobView | null {
  return collectJobs(env).find((j) => j.job === id) ?? null;
}

/** The job's final answer as the late-results file holds it, cut at `maxChars`. */
export function jobResult(id: string, env: NodeJS.ProcessEnv = process.env, maxChars = 30000): { found: boolean; at?: string; command?: string; result?: unknown; truncated?: boolean } {
  let hit: any = null;
  for (const e of readJsonLines(jobFiles(env).late)) if (e?.job === id || (!e?.job && e?.id === id)) hit = e;
  if (!hit) return { found: false };
  const text = JSON.stringify(hit.result);
  if (text && text.length > maxChars) return { found: true, at: hit.at, command: hit.command, result: text.slice(0, maxChars), truncated: true };
  return { found: true, at: hit.at, command: hit.command, result: hit.result };
}

/** Writes the cancel request the add-in checks; returns the file. */
export function requestCancel(id: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!JOB_ID.test(id)) throw new Error(`Not a job id: ${id}`);
  const dir = jobFiles(env).cancelDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id);
  fs.writeFileSync(file, new Date().toISOString());
  appendJobEvent({ job: id, event: "cancel_requested" }, env);
  return file;
}
