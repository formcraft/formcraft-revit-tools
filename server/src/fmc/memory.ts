/**
 * Pause new batch leases and model-changing calls when this PC is short of free physical memory.
 * Reads keep running. The threshold is ram_pause_free_mb in fmc_guard.json (default 1024).
 * Resume is above 1.5× that (1536 when the pause is 1024), so a lease does not flap.
 * The sample is cached. On Windows a CIM poll also records the Revit working set.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { loadConfig } from "./policy.js";

export const DEFAULT_PAUSE_MB = 1024;

export interface MemorySample {
  freeMb: number;
  totalMb: number;
  revitWorkingSetMb: number | null;
  source: "os" | "cim";
}

export interface MemoryView {
  free_mb: number;
  total_mb: number;
  pause_below_mb: number;
  resume_above_mb: number;
  paused: boolean;
  revit_working_set_mb: number | null;
  source: "os" | "cim";
}

export interface MemoryLimits { pauseMb: number; resumeMb: number }

/** 0 disables the pause. Anything else resumes above 1.5× the pause threshold. */
export function memoryLimits(raw: unknown): MemoryLimits {
  if (raw == null || raw === "") return { pauseMb: DEFAULT_PAUSE_MB, resumeMb: Math.round(DEFAULT_PAUSE_MB * 1.5) };
  const pause = Math.floor(Number(raw));
  if (!Number.isFinite(pause) || pause < 0) return { pauseMb: DEFAULT_PAUSE_MB, resumeMb: Math.round(DEFAULT_PAUSE_MB * 1.5) };
  if (pause === 0) return { pauseMb: 0, resumeMb: 0 };
  return { pauseMb: pause, resumeMb: Math.round(pause * 1.5) };
}

const resumeListeners = new Set<() => void>();

export function onMemoryResume(fn: () => void): () => void {
  resumeListeners.add(fn);
  return () => resumeListeners.delete(fn);
}

function fireResumeListeners(): void {
  for (const fn of resumeListeners) {
    try { fn(); } catch { /* a listener must not stop the resume */ }
  }
}

export class MemoryGate {
  private paused = false;
  private cached: { at: number; sample: MemorySample } | null = null;

  constructor(
    private readonly sample: () => MemorySample,
    private readonly limits: () => MemoryLimits,
    private readonly log: (line: string) => void = () => {},
    private readonly cacheMs = 1000,
    /** Only the process-wide gate notifies batch boards. A test gate leaves this empty. */
    private readonly onResume: () => void = () => {},
  ) {}

  view(): MemoryView {
    const now = Date.now();
    if (!this.cached || now - this.cached.at >= this.cacheMs) {
      this.cached = { at: now, sample: this.sample() };
    }
    const sample = this.cached.sample;
    const { pauseMb, resumeMb } = this.limits();
    const was = this.paused;
    if (pauseMb <= 0) this.paused = false;
    else if (!this.paused && sample.freeMb < pauseMb) this.paused = true;
    else if (this.paused && sample.freeMb > resumeMb) this.paused = false;
    if (this.paused && !was) {
      this.log(`[FMC-RAM] paused: ${sample.freeMb} MB free, below ${pauseMb} MB. Writes and new leases wait. Reads still run. Resumes above ${resumeMb} MB.`);
    } else if (!this.paused && was) {
      this.log(`[FMC-RAM] resumed: ${sample.freeMb} MB free, above ${resumeMb} MB. Writes and leases continue.`);
      this.onResume();
    }
    return {
      free_mb: sample.freeMb,
      total_mb: sample.totalMb,
      pause_below_mb: pauseMb,
      resume_above_mb: resumeMb,
      paused: this.paused,
      revit_working_set_mb: sample.revitWorkingSetMb,
      source: sample.source,
    };
  }

  leasesPaused(): boolean {
    return this.view().paused;
  }

  /** Wait until writes may run. Throws when maxMs passes still paused; the model was not changed. */
  async holdWrites(maxMs: number): Promise<void> {
    if (!this.view().paused) return;
    const start = Date.now();
    const cap = Math.max(0, maxMs);
    while (this.view().paused) {
      if (Date.now() - start >= cap) {
        const view = this.view();
        throw new Error(
          `[FMC-RAM-PAUSE] Paused for memory: ${view.free_mb} MB free, below ${view.pause_below_mb} MB. ` +
          `Writes and new leases wait until free memory is above ${view.resume_above_mb} MB. ` +
          `This write was not sent and the model was not changed. Not a script failure. ` +
          `Retry; fmc_batch status and /health show memory.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

interface WindowsReading { at: number; freeMb: number; revitMb: number | null }

let windowsReading: WindowsReading | null = null;
let windowsStarted = false;

function sampleHost(): MemorySample {
  ensureWindowsPoll();
  const totalMb = Math.round(os.totalmem() / 1048576);
  if (process.platform === "win32" && windowsReading && Date.now() - windowsReading.at < 8000) {
    return { freeMb: windowsReading.freeMb, totalMb, revitWorkingSetMb: windowsReading.revitMb, source: "cim" };
  }
  return {
    freeMb: Math.round(os.freemem() / 1048576),
    totalMb,
    revitWorkingSetMb: windowsReading?.revitMb ?? null,
    source: "os",
  };
}

/** One light CIM poll: free physical memory and the Revit working set. Never throws. */
export function readWindowsMemory(run: (script: string) => Promise<string> = runPowerShell): void {
  if (process.platform !== "win32") return;
  const script = [
    "$os = Get-CimInstance -ClassName Win32_OperatingSystem",
    "$revit = Get-Process -Name Revit -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum",
    "@{ free_kb = [int64]$os.FreePhysicalMemory; revit_bytes = [int64]($revit.Sum) } | ConvertTo-Json -Compress",
  ].join("; ");
  void run(script).then((text) => {
    try {
      const parsed = JSON.parse(text) as { free_kb?: number; revit_bytes?: number };
      const free = Number(parsed.free_kb);
      if (!Number.isFinite(free)) return;
      const revit = Number(parsed.revit_bytes);
      windowsReading = {
        at: Date.now(),
        freeMb: Math.round(free / 1024),
        revitMb: Number.isFinite(revit) && revit > 0 ? Math.round(revit / 1048576) : null,
      };
    } catch { /* keep the last good sample, or os.freemem */ }
  }).catch(() => { /* os.freemem remains the sample */ });
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    child.unref?.();
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("memory poll timed out")); }, 4000);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
  });
}

function ensureWindowsPoll(): void {
  if (windowsStarted || process.platform !== "win32") return;
  windowsStarted = true;
  readWindowsMemory();
  const timer = setInterval(() => readWindowsMemory(), 5000);
  timer.unref?.();
}

export const memoryGate = new MemoryGate(
  sampleHost,
  () => memoryLimits(loadConfig().config.ram_pause_free_mb),
  (line) => console.error(line),
  1000,
  fireResumeListeners,
);
