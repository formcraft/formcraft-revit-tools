/**
 * A connect reset or a busy answer while Revit still heartbeats a job is not a dead listener.
 * ExternalEvent runs only when Revit's main thread is idle, so a dialog or a person in the UI
 * holds the job. The port is left alone and AI is not toggled.
 */
import { spawnSync } from "node:child_process";
import { jobFiles, readJsonLines } from "./jobs.js";
import { blockingDialog, formatDialog, leftForPerson } from "./dialogrules.js";

export const NOT_IDLE = "FMC-REVIT-NOT-IDLE";
export const NOT_IDLE_HINT = "Revit is busy or waiting on a dialog or an active command; finish or cancel it in Revit; do not toggle AI or kill anything.";

/** A heartbeat younger than this still counts as in flight (Revit writes one a minute). */
export const FLIGHT_FRESH_MS = 3 * 60 * 1000;

const LIVE = new Set(["heartbeat", "running", "queued", "bridge_busy", "dialog"]);
const DONE = new Set(["finished", "bridge_free", "cancelled"]);

export interface JobLine {
  at?: string;
  job?: string;
  command?: string;
  pid?: number;
  event?: string;
  started?: string;
  message?: string;
  dialog_id?: string;
  answer?: string;
}

export interface InFlightJob {
  job: string;
  command: string;
  pid: number;
  startedMs: number;
  heartbeatMs: number;
  age_s: number;
}

/** The newest job on this Revit whose last sign of life is still fresh. A finished job is not in flight. */
export function inFlightJob(lines: JobLine[], pid: number, now = Date.now(), freshMs = FLIGHT_FRESH_MS): InFlightJob | null {
  const jobs = new Map<string, InFlightJob & { live: boolean }>();
  for (const e of lines) {
    if (!e || e.pid !== pid || typeof e.job !== "string" || !e.job) continue;
    const at = Date.parse(String(e.at ?? ""));
    let row = jobs.get(e.job);
    if (!row) {
      row = { job: e.job, command: String(e.command ?? ""), pid, startedMs: Number.isFinite(at) ? at : now, heartbeatMs: 0, age_s: 0, live: false };
      jobs.set(e.job, row);
    }
    if (e.command) row.command = String(e.command);
    const started = Date.parse(String(e.started ?? ""));
    if (Number.isFinite(started)) row.startedMs = Math.min(row.startedMs, started);
    const event = String(e.event ?? "");
    if (DONE.has(event)) row.live = false;
    else if (LIVE.has(event)) {
      row.live = true;
      if (Number.isFinite(at)) row.heartbeatMs = Math.max(row.heartbeatMs, at);
    }
  }
  const live = [...jobs.values()].filter((row) => row.live && now - row.heartbeatMs <= freshMs);
  live.sort((a, b) => b.heartbeatMs - a.heartbeatMs);
  const hit = live[0];
  if (!hit) return null;
  return { job: hit.job, command: hit.command, pid: hit.pid, startedMs: hit.startedMs, heartbeatMs: hit.heartbeatMs, age_s: Math.max(0, Math.round((now - hit.startedMs) / 1000)) };
}

export function readRevitJobLines(env: NodeJS.ProcessEnv = process.env): JobLine[] {
  return readJsonLines(jobFiles(env).revit, 4000) as JobLine[];
}

/** The latest dialog left for a person on this job, named by id when the log has one. */
export function dialogFromLog(lines: JobLine[], job: string): string {
  let id = "";
  let message = "";
  let open = false;
  for (const e of lines) {
    if (e?.job !== job || e.event !== "dialog") continue;
    if (leftForPerson(String(e.answer ?? ""))) {
      id = String(e.dialog_id ?? "").trim();
      message = String(e.message ?? "").trim();
      open = true;
    } else open = false;
  }
  return open ? formatDialog(id, message) : "";
}

/** Age in words: "45 s" or "6 min". */
export function ageWords(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

export function notIdleMessage(job: InFlightJob, dialog = ""): string {
  const shown = dialog.trim();
  const who = `Job ${job.job} (${job.command || "a command"}) has been in flight for ${ageWords(job.age_s)}.`;
  const box = shown ? ` Dialog: ${JSON.stringify(shown)}.` : "";
  return `[${NOT_IDLE}] Revit pid ${job.pid} is not idle. ${who}${box} ${NOT_IDLE_HINT}`;
}

/** Read-only. A visible modal dialog (#32770) owned by this pid. Never clicked, never closed. */
let modalReader: (pid: number) => string = defaultModalReader;

export function setModalDialogReader(reader: ((pid: number) => string) | null): void {
  modalReader = reader ?? defaultModalReader;
}

export function modalDialogTitle(pid: number): string {
  try { return modalReader(pid).trim(); } catch { return ""; }
}

function defaultModalReader(pid: number): string {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return "";
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FmcModal {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  public static string Titles(uint want) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != want || !IsWindowVisible(h)) return true;
      var cls = new StringBuilder(32); GetClassName(h, cls, 32);
      if (cls.ToString() != "#32770") return true;
      var title = new StringBuilder(512); GetWindowText(h, title, 512);
      var text = title.ToString().Trim();
      if (text.Length > 0) found.Add(text);
      return true;
    }, IntPtr.Zero);
    return string.Join(" | ", found);
  }
}
"@
[FmcModal]::Titles(${pid})
`;
  try {
    const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 1500, encoding: "utf8", windowsHide: true,
    });
    return String(run.stdout ?? "").trim();
  } catch {
    return "";
  }
}

export function dialogFor(pid: number, job: string, env: NodeJS.ProcessEnv = process.env, lines?: JobLine[]): string {
  const live = blockingDialog(env, { job, pid });
  if (live.open && live.source === "add-in") return formatDialog(live.dialog_id, live.message);
  const fromLog = dialogFromLog(lines ?? readRevitJobLines(env), job);
  if (fromLog) return fromLog;
  return modalDialogTitle(pid);
}

/** The job id in a JOB-RUNNING, BUSY or NOT-IDLE answer, when this build's own chunk is the one Revit still holds. */
export function ownChunkJob(message: string): string | null {
  const text = message ?? "";
  const tagged = /\[FMC-JOB-RUNNING\]|\[FMC-BRIDGE-BUSY\]|\[FMC-REVIT-NOT-IDLE\]/.test(text);
  if (!tagged) return null;
  const job = /\b[Jj]ob ([A-Za-z0-9_-]{1,64})\b/.exec(text);
  return job ? job[1] : null;
}
