/**
 * The Windows process layer for fmc_recover_revit. Tests do not use this. They pass a mock.
 * Closing and starting Revit do nothing on any other OS.
 */
import { spawn, spawnSync } from "node:child_process";
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
        documents: (raw.documents ?? []).map((d: { title?: string; path?: string; workshared?: boolean; family?: boolean }) => ({
          title: String(d.title ?? ""), path: String(d.path ?? ""), workshared: d.workshared === true, family: d.family === true,
        })),
      });
    } catch { /* a torn instance file is skipped */ }
  }
  return out.filter((i) => Number.isInteger(i.pid) && i.pid > 0);
}

export function listProcesses(): ObservedProcess[] {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 8000 });
  if (run.status !== 0 || !run.stdout) return [];
  try {
    const parsed = JSON.parse(run.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row: { ProcessId?: number; Name?: string; CommandLine?: string }) => ({
      pid: Number(row.ProcessId),
      name: String(row.Name ?? ""),
      commandLine: row.CommandLine,
      responding: undefined,
    })).filter((p: ObservedProcess) => p.pid > 0);
  } catch { return []; }
}

/** Responding is a second, lighter query. A missing answer is left unknown, which is not 'not responding'. */
export function respondingFlags(pids: number[]): Map<number, boolean> {
  const flags = new Map<number, boolean>();
  if (process.platform !== "win32" || !pids.length) return flags;
  const script = `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Select-Object Id,Responding | ConvertTo-Json -Compress`;
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 8000 });
  if (run.status !== 0 || !run.stdout) return flags;
  try {
    const parsed = JSON.parse(run.stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) if (row && typeof row.Responding === "boolean") flags.set(Number(row.Id), row.Responding);
  } catch { /* unknown stays unknown */ }
  return flags;
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
  const processes = listProcesses();
  const flags = respondingFlags(instances.map((i) => i.pid));
  for (const proc of processes) if (flags.has(proc.pid)) proc.responding = flags.get(proc.pid);
  const jobs: JobHint[] = collectJobs().filter((j) => j.state === "running" || j.state === "queued").map((j) => ({ port: j.port, state: j.state, command: j.command }));
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
  };
}
