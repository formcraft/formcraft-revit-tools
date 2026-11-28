/**
 * The Windows process layer for fmc_recover_revit. Tests do not use this. They pass a mock.
 * Closing and starting Revit do nothing on any other OS.
 */
import { spawn } from "node:child_process";
import { jobIsStale } from "./queueops.js";
import fs from "node:fs";
import path from "node:path";
import { collectJobs } from "./jobs.js";
import { loadConfig } from "./policy.js";
import { probePort } from "./connect.js";
import { batchBoard } from "./batchline.js";
import { recoverySettings } from "./recover.js";
import type { JobHint, ObservedInstance, ObservedProcess, RecoveryInput, SyncHint } from "./recover.js";

export function readInstanceSnapshots(dir: string): ObservedInstance[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  const out: ObservedInstance[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.win32.join(dir, name), "utf8").replace(/^\uFEFF/, ""));
      out.push({
        pid: Number(raw.pid),
        port: Number(raw.port),
        revit: raw.revit,
        updated: raw.updated,
        documents: (raw.documents ?? []).map((d: { title?: string; path?: string; workshared?: boolean; family?: boolean; modified?: boolean }) => ({
          title: String(d.title ?? ""), path: String(d.path ?? ""), workshared: d.workshared === true, family: d.family === true,
          ...(typeof d.modified === "boolean" ? { modified: d.modified } : {}),
        })),
      });
    } catch { /* a torn instance file is skipped */ }
  }
  return out.filter((i) => Number.isInteger(i.pid) && i.pid > 0);
}

/** RV-8: PowerShell without blocking the server's event loop (spawnSync froze every other tool call for up to 8 s). */
function powershell(script: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") { resolve(""); return; }
    let out = "";
    let done = false;
    const finish = (text: string) => { if (!done) { done = true; resolve(text); } };
    try {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(""); }, timeoutMs);
      child.stdout?.on("data", (c) => { out += String(c); });
      child.on("close", (code) => { clearTimeout(timer); finish(code === 0 ? out : ""); });
      child.on("error", () => { clearTimeout(timer); finish(""); });
    } catch { finish(""); }
  });
}

let processCache: { at: number; rows: ObservedProcess[] } | null = null;
const PROCESS_CACHE_MS = 10000;

export function parseProcessRows(text: string): ObservedProcess[] {
  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row: { ProcessId?: number; Name?: string; CommandLine?: string; ExecutablePath?: string }) => ({
      pid: Number(row.ProcessId),
      name: String(row.Name ?? ""),
      commandLine: row.CommandLine,
      ...(row.ExecutablePath ? { exePath: String(row.ExecutablePath) } : {}),
      responding: undefined,
    })).filter((p: ObservedProcess) => p.pid > 0);
  } catch { return []; }
}

/** The process list, cached for 10 s so a plan right after another does not query Windows again. */
export async function listProcesses(now = Date.now()): Promise<ObservedProcess[]> {
  if (process.platform !== "win32") return [];
  if (processCache && now - processCache.at < PROCESS_CACHE_MS) return processCache.rows.map((p) => ({ ...p }));
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress";
  const rows = parseProcessRows(await powershell(script));
  if (rows.length) processCache = { at: now, rows };
  return rows.map((p) => ({ ...p }));
}

/** Responding is a second, lighter query. A missing answer is left unknown, which is not 'not responding'. */
export async function respondingFlags(pids: number[]): Promise<Map<number, boolean>> {
  const flags = new Map<number, boolean>();
  if (process.platform !== "win32" || !pids.length) return flags;
  const script = `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,Responding | ConvertTo-Json -Compress`;
  const text = await powershell(script);
  if (!text) return flags;
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) if (row && typeof row.Responding === "boolean") flags.set(Number(row.Id), row.Responding);
  } catch { /* unknown stays unknown */ }
  return flags;
}

/** Two samples: not responding only when both say so (a busy UI thread for one moment is not hung). */
export function combineSamples(first: Map<number, boolean>, second: Map<number, boolean>): Map<number, boolean> {
  const out = new Map<number, boolean>();
  for (const [pid, value] of first) {
    if (value) { out.set(pid, true); continue; }
    const again = second.get(pid);
    if (again === undefined) continue;   // no second answer: unknown, not hung
    out.set(pid, again);
  }
  return out;
}

function taskkill(pid: number, force: boolean): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") { resolve(force ? "kill only runs on Windows" : "graceful close only runs on Windows"); return; }
    const args = force ? ["/F", "/PID", String(pid)] : ["/PID", String(pid)];
    const child = spawn("taskkill", args, { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (c) => { out += String(c); });
    child.stderr?.on("data", (c) => { out += String(c); });
    child.on("close", (code) => resolve(`taskkill ${force ? "/F " : ""}exit ${code}: ${out.trim()}`));
    child.on("error", (error) => resolve(error.message));
  });
}

export const liveActions = {
  log(line: string) { console.error(line); },
  alive(pid: number) {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  },
  closeGraceful: (pid: number) => taskkill(pid, false),
  kill: (pid: number) => taskkill(pid, true),
  async startRevit(exe: string, files: string[]) {
    if (process.platform !== "win32") return "Revit is started only on Windows. Originals were not written.";
    try {
      const child = spawn(exe, files, { detached: true, stdio: "ignore", windowsHide: false });
      child.unref();
      return `started pid ${child.pid ?? "?"}. Workshared files are left for Revit to open as a new local. Originals were not written.`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
};

export async function liveInput(dir: string, now = Date.now()): Promise<RecoveryInput> {
  const cfg = loadConfig().config;
  const recovery = recoverySettings(cfg.recovery);
  const instances = readInstanceSnapshots(dir);
  const processes = await listProcesses(now);
  const first = await respondingFlags(instances.map((i) => i.pid));
  const slow = [...first.entries()].filter(([, ok]) => !ok).map(([pid]) => pid);
  let second = new Map<number, boolean>();
  if (slow.length) { await new Promise((r) => setTimeout(r, 2000)); second = await respondingFlags(slow); }
  const flags = combineSamples(first, second);
  for (const proc of processes) if (flags.has(proc.pid)) proc.responding = flags.get(proc.pid);
  // QU-5: the queue's stale rule, so a log entry that says running while Revit is idle is not counted as unsaved work.
  const jobs: JobHint[] = collectJobs().filter((j) => j.state === "running" || j.state === "queued").map((j) => {
    const state: "queued" | "running" = j.state === "queued" ? "queued" : "running";
    const beat = j.revit?.heartbeat_at ?? j.revit?.running_since ?? j.started;
    const age = Math.max(0, Math.round((now - Date.parse(j.started || "")) / 1000)) || 0;
    const idle = !Number.isFinite(Date.parse(beat ?? "")) || now - Date.parse(beat ?? "") > 120000;
    return { port: j.port, state: j.state, command: j.command, stale: jobIsStale(state, age, idle) };
  });
  const snap = batchBoard().snapshot() as { documents?: Array<{ document?: string; last_sync?: string | null; next_sync?: string | null }> };
  const syncs: SyncHint[] = (snap.documents ?? []).map((d) => ({ title: d.document, last_sync: d.last_sync ?? null, next_sync: d.next_sync ?? null }));
  const open = new Map<number, boolean>();
  for (const inst of instances) {
    if (!open.has(inst.port)) open.set(inst.port, (await probePort("127.0.0.1", inst.port, 300)) === "ok");
  }
  return {
    now,
    heartbeatS: recovery.heartbeatS,
    processes,
    instances,
    portOpen: (port) => open.get(port) === true,
    fileMtime: (path) => { try { return fs.statSync(path).mtime.toISOString(); } catch { return null; } },
    jobs,
    syncs,
    protectedRoots: cfg.protected_roots ?? [],
    documents: recovery.documents,
    exeExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  };
}
