/**
 * Pause new batch leases and model-changing calls when this PC is short of free physical memory.
 * Reads keep running. The threshold is ram_pause_free_mb in fmc_guard.json (default 1024).
 * Resume is above 1.5× that (1536 when the pause is 1024), so a hard pause does not flap.
 *
 * Two tiers use those same two numbers. No new setting.
 * - soft: free memory is between the pause line and the resume line, and the hard latch is not on.
 *   Reads and small writes continue. Heavy writes, Dynamo and script jobs are queued, not failed.
 * - hard: free memory is below the pause line. It stays hard until free memory is above the resume line.
 *   Every model-changing call waits. Reads still run, so the pause can be seen and cleared.
 * ram_pause_free_mb 0 turns both tiers off.
 *
 * The sample is cached. On Windows a CIM poll also records the Revit working set.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { RAM_BUSY, withBusy } from "./busyreason.js";
import { loadConfig } from "./policy.js";

export const DEFAULT_PAUSE_MB = 1024;

export interface MemorySample {
  freeMb: number;
  totalMb: number;
  revitWorkingSetMb: number | null;
  source: "os" | "cim";
}

export type MemoryTier = "off" | "ok" | "soft" | "hard";

export interface MemoryView {
  free_mb: number;
  total_mb: number;
  pause_below_mb: number;
  resume_above_mb: number;
  /** True for the whole hard latch: from below the pause line until above the resume line. */
  paused: boolean;
  tier: MemoryTier;
  /** FMC-MEMORY-SOFT, FMC-MEMORY-HARD, or null when the pause is off or clear. */
  code: "FMC-MEMORY-SOFT" | "FMC-MEMORY-HARD" | null;
  reason: string;
  /** Recent Revit working-set samples, oldest first. Empty until a sample names one. */
  trend_mb: number[];
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
const hardListeners = new Set<() => void>();

export function onMemoryResume(fn: () => void): () => void {
  resumeListeners.add(fn);
  return () => resumeListeners.delete(fn);
}

/** Fires when the process-wide gate enters the hard tier. A test gate does not call this. */
export function onMemoryHard(fn: () => void): () => void {
  hardListeners.add(fn);
  return () => hardListeners.delete(fn);
}

function fireResumeListeners(): void {
  for (const fn of resumeListeners) {
    try { fn(); } catch { /* a listener must not stop the resume */ }
  }
}

function fireHardListeners(): void {
  for (const fn of hardListeners) {
    try { fn(); } catch { /* a listener must not stop the pause */ }
  }
}

const HEAVY_COMMANDS = new Set([
  "send_code_to_revit", "fmc_new_local", "fmc_grids_from_link", "fmc_recipe_batch",
  "fmc_model_edit", "fmc_diagram_draw", "fmc_diagram_sheet", "fmc_room_build",
  "fmc_casework_place", "fmc_casework_pack", "fmc_replace", "fmc_template_build",
  "fmc_build_families", "fmc_legend_chain",
  "fmc_dynamo", "fmc_script_run", "fmc_joins_apply",
]);

/** Dynamo, a long script, or a bulk model edit. Small writes are everything else. */
export function isHeavyWrite(command: string, params: unknown): boolean {
  if (HEAVY_COMMANDS.has(command) || /dynamo/i.test(command)) return true;
  if (!params || typeof params !== "object") return false;
  const record = params as Record<string, unknown>;
  if (record.dynamo != null || record.script != null) return true;
  return typeof record.code === "string" && (record.code.length > 8000 || /dynamo/i.test(record.code));
}

export class MemoryGate {
  private paused = false;
  private tier: MemoryTier = "ok";
  private trend: number[] = [];
  private cached: { at: number; sample: MemorySample } | null = null;

  constructor(
    private readonly sample: () => MemorySample,
    private readonly limits: () => MemoryLimits,
    private readonly log: (line: string) => void = () => {},
    private readonly cacheMs = 1000,
    /** Only the process-wide gate notifies batch boards. A test gate leaves this empty. */
    private readonly onResume: () => void = () => {},
    private readonly onHard: () => void = () => {},
  ) {}

  view(): MemoryView {
    const now = Date.now();
    if (!this.cached || now - this.cached.at >= this.cacheMs) {
      this.cached = { at: now, sample: this.sample() };
      const mb = this.cached.sample.revitWorkingSetMb;
      if (mb != null) {
        this.trend.push(mb);
        if (this.trend.length > 12) this.trend.shift();
      }
    }
    const sample = this.cached.sample;
    const limits = this.limits();
    const was = this.paused;
    const wasTier = this.tier;
    if (limits.pauseMb <= 0) this.paused = false;
    else if (!this.paused && sample.freeMb < limits.pauseMb) this.paused = true;
    else if (this.paused && sample.freeMb > limits.resumeMb) this.paused = false;
    const next = classifyTier(sample.freeMb, limits, this.paused);
    this.tier = next.tier;
    if (this.paused && !was) {
      this.log(`[FMC-RAM] paused: ${sample.freeMb} MB free, below ${limits.pauseMb} MB. Writes and new leases wait. Reads still run. Resumes above ${limits.resumeMb} MB. FMC-MEMORY-HARD.`);
      this.onHard();
    } else if (!this.paused && was) {
      this.log(`[FMC-RAM] resumed: ${sample.freeMb} MB free, above ${limits.resumeMb} MB. Writes and leases continue.`);
      this.onResume();
    } else if (wasTier !== "soft" && next.tier === "soft") {
      this.log(`[FMC-RAM] ${next.reason} FMC-MEMORY-SOFT.`);
    } else if (wasTier === "soft" && next.tier === "ok") {
      this.onResume();
    }
    return {
      free_mb: sample.freeMb,
      total_mb: sample.totalMb,
      pause_below_mb: limits.pauseMb,
      resume_above_mb: limits.resumeMb,
      paused: this.paused,
      tier: next.tier,
      code: next.code,
      reason: next.reason,
      trend_mb: [...this.trend],
      revit_working_set_mb: sample.revitWorkingSetMb,
      source: sample.source,
    };
  }

  /** The hard latch only. The same flag the old pause used. Soft does not set it. */
  leasesPaused(): boolean {
    return this.view().paused;
  }

  /** Hard latch, or the soft band. New batch leases wait in both. They are not failed. */
  blocksNewLeases(): boolean {
    const view = this.view();
    return view.tier === "hard" || view.tier === "soft" || view.paused;
  }

  /** Wait until writes may run. Throws when maxMs passes still paused; the model was not changed. */
  async holdWrites(maxMs: number): Promise<void> {
    if (!this.view().paused && this.view().tier !== "hard") return;
    const start = Date.now();
    const cap = Math.max(0, maxMs);
    while (this.view().paused || this.view().tier === "hard") {
      if (Date.now() - start >= cap) {
        const view = this.view();
        throw new Error(withBusy(
          `[FMC-RAM-PAUSE] [FMC-MEMORY-HARD] Paused for memory: ${view.free_mb} MB free, below ${view.pause_below_mb} MB. ` +
          `${view.reason} Writes and new leases wait until free memory is above ${view.resume_above_mb} MB. ` +
          `This write was not sent and the model was not changed. Not a script failure. ` +
          `Retry; fmc_batch status and /health show memory.`,
          RAM_BUSY,
        ));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /**
   * Soft tier only: wait, and if the wait expires say the job is queued, not failed.
   * A hard tier that arrives during the wait uses the hard message.
   */
  async holdHeavy(maxMs: number): Promise<void> {
    const first = this.view();
    if (first.tier !== "soft" && first.tier !== "hard") return;
    const start = Date.now();
    const cap = Math.max(0, maxMs);
    while (true) {
      const view = this.view();
      if (view.tier === "ok" || view.tier === "off") return;
      if (Date.now() - start >= cap) {
        if (view.tier === "hard" || view.paused) {
          throw new Error(withBusy(
            `[FMC-RAM-PAUSE] [FMC-MEMORY-HARD] Paused for memory: ${view.free_mb} MB free. ${view.reason} ` +
            `This write was not sent and the model was not changed. Not a script failure.`,
            RAM_BUSY,
          ));
        }
        throw new Error(withBusy(
          `[FMC-MEMORY-SOFT] Queued for memory, not failed: ${view.free_mb} MB free. ${view.reason} ` +
          `This heavy write was not sent and the model was not changed. Not a script failure. ` +
          `It runs when free memory is above ${view.resume_above_mb} MB. fmc_batch status and /health show memory.`,
          RAM_BUSY,
        ));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

export function classifyTier(freeMb: number, limits: MemoryLimits, paused: boolean): { tier: MemoryTier; code: MemoryView["code"]; reason: string } {
  if (limits.pauseMb <= 0) {
    return { tier: "off", code: null, reason: "ram_pause_free_mb is 0. The memory pause is off." };
  }
  if (paused || freeMb < limits.pauseMb) {
    const still = paused && freeMb >= limits.pauseMb;
    const reason = still
      ? `${freeMb} MB free. The hard pause stays until free memory is above ${limits.resumeMb} MB, because it was below ${limits.pauseMb} MB.`
      : `${freeMb} MB free, below ${limits.pauseMb} MB. Every model-changing call waits. Reads still run.`;
    return { tier: "hard", code: "FMC-MEMORY-HARD", reason };
  }
  if (freeMb <= limits.resumeMb) {
    return {
      tier: "soft",
      code: "FMC-MEMORY-SOFT",
      reason: `${freeMb} MB free, between ${limits.pauseMb} MB and ${limits.resumeMb} MB. Reads and small writes continue. Heavy writes, Dynamo and script jobs are queued, not failed.`,
    };
  }
  return { tier: "ok", code: null, reason: `${freeMb} MB free, above ${limits.resumeMb} MB.` };
}

/** Hard waits on every write. Soft waits on heavy writes only. A clear or disabled pause does not wait. */
export async function admitWrite(gate: MemoryGate, command: string, params: unknown, maxMs: number): Promise<void> {
  const view = gate.view();
  if (view.tier === "off" || view.tier === "ok") return;
  if (view.tier === "hard" || view.paused) {
    await gate.holdWrites(maxMs);
    return;
  }
  if (view.tier === "soft" && isHeavyWrite(command, params)) await gate.holdHeavy(maxMs);
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
  fireHardListeners,
);
