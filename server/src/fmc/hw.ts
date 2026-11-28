/**
 * Hardware scan, graphics recommendations, and the memory-relief plan for fmc_hw.
 * Parsers take mock WMI, DXGI and process output. Nothing here prints a token.
 *
 * The GPU draws views. It does not hold the Revit model, and it does not run the Revit API.
 */
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { memoryGate, type MemoryView } from "./memory.js";
import { saveBlocked } from "./savepolicy.js";
import { loadConfig, type GuardConfig } from "./policy.js";
import { parseConfig } from "./aiuse.js";
import {
  clashPairs, dispatchJob, nearestPointMm, pointBoxDistanceMm, probeDirectMl, rayVoxelHits,
  type GpuRunner, type JobRun, type Ray,
} from "./hwgpu.js";

export const HONESTY = [
  "Revit's model database stays in system RAM. Video memory does not hold it and cannot replace that RAM.",
  "Regeneration runs on the CPU.",
  "Transactions run on the CPU.",
  "The Revit API runs on the CPU. A plugin cannot move those calls onto the GPU.",
  "The GPU is used for view drawing, anti-aliasing and view navigation when those graphics settings are on, and for an optional sampling kernel when that kernel matches the CPU result.",
] as const;

const SECRET_KEY = /^(token|authorization|password|secret|api_key|apikey)$/i;

const VRAM_NOTE = "Per-process video memory is the Windows GPU process memory counter (Dedicated Usage), the process view of DXGI QueryVideoMemoryInfo. Adapter size uses DXGI dedicated video memory when the collector has it, otherwise Win32_VideoController.AdapterRAM, which Windows often caps.";

export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripSecrets(item);
  }
  return out as T;
}

export interface GpuAdapter {
  name: string;
  vendor: string;
  dedicated_vram_mb: number | null;
  vram_source: "dxgi" | "wmi" | "unknown";
  driver_version: string | null;
  driver_date: string | null;
  luid: string | null;
  kind: "dedicated" | "integrated" | "basic" | "unknown";
}

export interface PageFileRow {
  path: string;
  allocated_mb: number | null;
  current_mb: number | null;
  initial_mb: number | null;
  maximum_mb: number | null;
  drive: string | null;
}

export interface DiskRow {
  drive: string;
  free_mb: number | null;
  total_mb: number | null;
}

export interface RevitProcessMemory {
  pid: number;
  path: string | null;
  working_set_mb: number | null;
  private_mb: number | null;
  commit_mb: number | null;
}

export interface HardwareScan {
  status: "ready" | "pending";
  cached_at: string | null;
  platform: string;
  gpus: GpuAdapter[];
  ram: { total_mb: number; free_mb: number; source: string };
  page_files: PageFileRow[];
  disks: DiskRow[];
  cpu: { name: string; cores: number; logical: number };
  revit: RevitProcessMemory[];
  revit_vram: { dedicated_mb: number | null; adapters: Array<{ luid: string | null; usage_mb: number | null; budget_mb: number | null; available_mb: number | null }>; note: string };
  gpu_preference: { exe: string | null; value: string | null; parsed: "high_performance" | "power_saving" | "unspecified" | "unknown" };
  revit_gpu: { name: string | null; kind: string; on_integrated_while_dedicated_exists: boolean };
  graphics: GraphicsReading | null;
  honesty: readonly string[];
}

export interface GraphicsReading {
  source: string;
  use_hardware_acceleration: string | null;
  antialiasing: string | null;
  optimize_view_navigation: string | null;
  disable_optimized_view_navigation: string | null;
  /** Revit has no separate published switch. Views follow UseHardwareAcceleration. */
  view_hardware_acceleration: string | null;
  view_hardware_note: string;
}

export interface AdviceItem {
  id: string;
  text: string;
  effect: string;
}

export interface HostRaw {
  adapters?: unknown;
  memory?: { total_mb?: number; free_mb?: number; source?: string };
  pagefiles?: unknown;
  disks?: unknown;
  cpu?: { name?: string; cores?: number; logical?: number };
  processes?: unknown;
  gpu_engines?: unknown;
  video_memory?: unknown;
  gpu_preference?: { exe?: string; value?: string } | null;
  platform?: string;
  token?: string;
}

const cache: { at: string; scan: HardwareScan } = {
  at: "",
  scan: emptyScan("pending"),
};

function emptyScan(status: HardwareScan["status"]): HardwareScan {
  return {
    status,
    cached_at: null,
    platform: process.platform,
    gpus: [],
    ram: { total_mb: 0, free_mb: 0, source: "none" },
    page_files: [],
    disks: [],
    cpu: { name: "", cores: 0, logical: 0 },
    revit: [],
    revit_vram: { dedicated_mb: null, adapters: [], note: VRAM_NOTE },
    gpu_preference: { exe: null, value: null, parsed: "unknown" },
    revit_gpu: { name: null, kind: "unknown", on_integrated_while_dedicated_exists: false },
    graphics: null,
    honesty: HONESTY,
  };
}

export function hwHealth(): HardwareScan {
  return cache.scan;
}

export function rememberScan(scan: HardwareScan, at = new Date().toISOString()): HardwareScan {
  const stored = { ...scan, status: "ready" as const, cached_at: at };
  cache.at = at;
  cache.scan = stored;
  return stored;
}

export function hostFromOs(): HostRaw {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    adapters: [],
    memory: { total_mb: Math.round(os.totalmem() / 1048576), free_mb: Math.round(os.freemem() / 1048576), source: "os" },
    pagefiles: [],
    disks: [],
    cpu: { name: cpus[0]?.model ?? "", cores: cpus.length, logical: cpus.length },
    processes: [],
    gpu_engines: [],
    video_memory: [],
    gpu_preference: null,
  };
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function mbFromBytes(value: unknown): number | null {
  const n = num(value);
  if (n == null || n < 0) return null;
  return Math.round(n / 1048576);
}

export function parseDriverDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  const slash = /\/Date\((-?\d+)\)\//.exec(text);
  if (slash) {
    const t = Number(slash[1]);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
  }
  const wmi = /^(\d{4})(\d{2})(\d{2})/.exec(text);
  if (wmi) return `${wmi[1]}-${wmi[2]}-${wmi[3]}`;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function classifyGpu(name: string, dedicatedMb: number | null): GpuAdapter["kind"] {
  const n = name.toLowerCase();
  if (/basic display|microsoft basic/.test(n)) return "basic";
  if (/(uhd|iris|hd graphics)/.test(n) && (dedicatedMb == null || dedicatedMb < 512)) return "integrated";
  if (/nvidia|geforce|quadro|rtx|radeon|\brx\b|arc a/.test(n) && (dedicatedMb == null || dedicatedMb >= 512)) return "dedicated";
  if (dedicatedMb != null && dedicatedMb >= 1024) return "dedicated";
  if (/intel/.test(n) && (dedicatedMb == null || dedicatedMb < 512)) return "integrated";
  if (dedicatedMb != null && dedicatedMb > 0 && dedicatedMb < 512) return "integrated";
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((row): row is Record<string, unknown> => row != null);
}

export function parsePreference(value: string | null | undefined): HardwareScan["gpu_preference"]["parsed"] {
  if (value == null || value === "") return "unknown";
  if (/GpuPreference\s*=\s*2/i.test(value)) return "high_performance";
  if (/GpuPreference\s*=\s*1/i.test(value)) return "power_saving";
  if (/GpuPreference\s*=\s*0/i.test(value)) return "unspecified";
  return "unknown";
}

export function parseHost(raw: HostRaw): HardwareScan {
  const clean = stripSecrets(raw);
  const adapters = asList(clean.adapters).map((row) => {
    const dxgi = mbFromBytes(row.dxgi_dedicated_bytes ?? row.dedicated_video_memory);
    const wmi = mbFromBytes(row.wmi_ram_bytes ?? row.AdapterRAM ?? row.adapter_ram_bytes);
    const name = String(row.name ?? row.Name ?? "Unknown GPU");
    const dedicated = dxgi ?? wmi;
    return {
      name,
      vendor: String(row.vendor ?? row.AdapterCompatibility ?? row.vendor_id ?? ""),
      dedicated_vram_mb: dedicated,
      vram_source: dxgi != null ? "dxgi" as const : wmi != null ? "wmi" as const : "unknown" as const,
      driver_version: row.driver_version != null || row.DriverVersion != null ? String(row.driver_version ?? row.DriverVersion) : null,
      driver_date: parseDriverDate(row.driver_date ?? row.DriverDate),
      luid: row.luid != null ? String(row.luid) : null,
      kind: classifyGpu(name, dedicated),
    };
  });
  const processes = asList(clean.processes).slice(0, 8).map((row) => ({
    pid: Math.round(num(row.pid) ?? 0),
    path: row.path != null ? String(row.path) : null,
    working_set_mb: num(row.working_set_mb) ?? mbFromBytes(row.working_set_bytes),
    private_mb: num(row.private_mb) ?? mbFromBytes(row.private_bytes),
    commit_mb: num(row.commit_mb) ?? mbFromBytes(row.commit_bytes),
  }));
  const engines = asList(clean.gpu_engines);
  const videos = asList(clean.video_memory).map((row) => ({
    luid: row.luid != null ? String(row.luid) : null,
    usage_mb: num(row.usage_mb) ?? mbFromBytes(row.current_usage_bytes),
    budget_mb: num(row.budget_mb) ?? mbFromBytes(row.budget_bytes),
    available_mb: num(row.available_mb) ?? mbFromBytes(row.available_for_reservation_bytes),
  }));
  const revitPids = new Set(processes.map((row) => row.pid));
  let revitVram = 0;
  let sawVram = false;
  const revitLuids = new Set<string>();
  for (const engine of engines) {
    const pid = Math.round(num(engine.pid) ?? 0);
    if (!revitPids.has(pid)) continue;
    if (engine.luid != null) revitLuids.add(String(engine.luid));
    const used = num(engine.dedicated_mb) ?? mbFromBytes(engine.dedicated_bytes);
    if (used != null) { revitVram += used; sawVram = true; }
  }
  const preference = clean.gpu_preference && typeof clean.gpu_preference === "object" ? clean.gpu_preference : null;
  const prefValue = preference?.value != null ? String(preference.value) : null;
  const using = adapters.find((gpu) => gpu.luid != null && revitLuids.has(gpu.luid)) ?? null;
  const dedicated = adapters.some((gpu) => gpu.kind === "dedicated");
  const parsedPref = parsePreference(prefValue);
  const onIntegrated = dedicated && (
    (using != null && using.kind === "integrated")
    || (using == null && parsedPref === "power_saving")
  );
  const memory = clean.memory ?? {};
  const cpu = clean.cpu ?? {};
  return {
    status: "ready",
    cached_at: null,
    platform: String(clean.platform ?? process.platform),
    gpus: adapters,
    ram: {
      total_mb: Math.round(num(memory.total_mb) ?? 0),
      free_mb: Math.round(num(memory.free_mb) ?? 0),
      source: String(memory.source ?? "host"),
    },
    page_files: asList(clean.pagefiles).map((row) => {
      const path = String(row.name ?? row.path ?? "");
      const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? null;
      return {
        path,
        allocated_mb: num(row.allocated_mb),
        current_mb: num(row.current_mb),
        initial_mb: num(row.initial_mb),
        maximum_mb: num(row.maximum_mb),
        drive: drive ? drive.toUpperCase() : null,
      };
    }),
    disks: asList(clean.disks).map((row) => ({
      drive: String(row.drive ?? row.device ?? "").toUpperCase(),
      free_mb: num(row.free_mb),
      total_mb: num(row.total_mb),
    })),
    cpu: {
      name: String(cpu.name ?? ""),
      cores: Math.round(num(cpu.cores) ?? 0),
      logical: Math.round(num(cpu.logical) ?? num(cpu.cores) ?? 0),
    },
    revit: processes,
    revit_vram: { dedicated_mb: sawVram ? revitVram : null, adapters: videos, note: VRAM_NOTE },
    gpu_preference: {
      exe: preference?.exe != null ? String(preference.exe) : (processes[0]?.path ?? null),
      value: prefValue,
      parsed: parsedPref,
    },
    revit_gpu: {
      name: using?.name ?? null,
      kind: using?.kind ?? "unknown",
      on_integrated_while_dedicated_exists: onIntegrated,
    },
    graphics: null,
    honesty: HONESTY,
  };
}

export function parseIni(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {};
  let section = "";
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const head = /^\[(.+)\]$/.exec(trimmed);
    if (head) {
      section = head[1];
      sections[section] ??= {};
      continue;
    }
    if (!section || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    sections[section][trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return sections;
}

export function readGraphics(text: string, source: string): GraphicsReading {
  const ini = parseIni(text);
  const find = (key: string) => {
    for (const [section, rows] of Object.entries(ini)) {
      for (const [name, value] of Object.entries(rows)) {
        if (name.toLowerCase() === key.toLowerCase()) return { section, value };
      }
    }
    return null;
  };
  const accel = find("UseHardwareAcceleration");
  const alias = find("Antialiasing");
  const optimize = find("OptimizeViewNavigation");
  const disable = find("DisableOptimizedViewNavigation");
  const separate = find("UseHardwareAccelerationForViews");
  return {
    source,
    use_hardware_acceleration: accel?.value ?? null,
    antialiasing: alias?.value ?? null,
    optimize_view_navigation: optimize?.value ?? null,
    disable_optimized_view_navigation: disable?.value ?? null,
    view_hardware_acceleration: separate?.value ?? accel?.value ?? null,
    view_hardware_note: separate
      ? "The ini already has UseHardwareAccelerationForViews. Views also follow UseHardwareAcceleration."
      : "Revit.ini has no separate 'use hardware acceleration for views' key. View drawing follows UseHardwareAcceleration. This tool does not invent that key.",
  };
}

export function upsertIni(text: string, section: string, key: string, value: string): string {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  let inSection = false;
  let sectionEnd = lines.length;
  let keyLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const head = /^\[(.+)\]$/.exec(trimmed);
    if (head) {
      if (inSection) { sectionEnd = i; break; }
      if (head[1].toLowerCase() === section.toLowerCase()) inSection = true;
    } else if (inSection && !trimmed.startsWith(";") && !trimmed.startsWith("#")) {
      const eq = trimmed.indexOf("=");
      if (eq > 0 && trimmed.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) keyLine = i;
    }
  }
  if (keyLine >= 0) {
    lines[keyLine] = `${key}=${value}`;
    return lines.join(nl);
  }
  if (inSection) {
    lines.splice(sectionEnd, 0, `${key}=${value}`);
    return lines.join(nl);
  }
  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  lines.push(`[${section}]`, `${key}=${value}`);
  return lines.join(nl);
}

export interface GraphicsWrite { section: string; key: string; value: string; effect: string }

export function graphicsPlan(current: GraphicsReading | null): { writes: GraphicsWrite[]; recommended: string[] } {
  const writes: GraphicsWrite[] = [];
  const recommended = [
    "Options > Graphics: turn Use hardware acceleration on. That is UseHardwareAcceleration=1. It takes effect the next time Revit starts.",
    "Anti-aliasing of the view runs on the GPU when hardware acceleration is on. Antialiasing=1. It uses view memory. It does not move the model.",
    "Views use that same hardware-acceleration switch. There is no second API switch, and none is written unless the ini already has UseHardwareAccelerationForViews.",
    "Options > Graphics: turn on optimize view navigation so pan and zoom stay on the GPU. The ini key varies by build.",
  ];
  if (!current || current.use_hardware_acceleration !== "1") {
    writes.push({ section: "Graphics", key: "UseHardwareAcceleration", value: "1", effect: "View drawing can use the GPU after the next Revit start. The model stays in RAM." });
  }
  if (!current || current.antialiasing !== "1") {
    writes.push({ section: "Graphics", key: "Antialiasing", value: "1", effect: "Edge smoothing of views uses the GPU. It can raise view-memory use. It does not shrink the model." });
  }
  if (current?.disable_optimized_view_navigation != null && current.disable_optimized_view_navigation !== "0") {
    writes.push({ section: "Graphics", key: "DisableOptimizedViewNavigation", value: "0", effect: "Leaves optimize-view-navigation on, so navigation can stay on the GPU." });
  } else if (!current || current.optimize_view_navigation !== "1") {
    writes.push({ section: "Graphics", key: "OptimizeViewNavigation", value: "1", effect: "Asks Revit to keep view navigation on the GPU. If this build ignores the key, set the checkbox in Options after restart." });
  }
  if (current?.view_hardware_acceleration != null && current.view_hardware_note.startsWith("The ini already") && current.view_hardware_acceleration !== "1") {
    writes.push({ section: "Graphics", key: "UseHardwareAccelerationForViews", value: "1", effect: "The file already has this key. It is set to on. It is not created when it is absent." });
  }
  return { writes, recommended };
}

export function applyGraphicsText(text: string, writes: GraphicsWrite[]): string {
  let next = text;
  for (const write of writes) next = upsertIni(next, write.section, write.key, write.value);
  return next;
}

export const DRIVER_MAX_AGE_MONTHS = 18;
export const PAGEFILE_MIN_RATIO = 1.5;
export const PAGEFILE_DISK_FREE_MB = 20480;
export const PAGEFILE_DISK_FREE_RATIO = 0.1;

export function driverIsOld(date: string | null, now: number): boolean {
  if (!date) return false;
  const t = Date.parse(date);
  if (!Number.isFinite(t)) return false;
  return (now - t) / (1000 * 60 * 60 * 24 * 30.437) > DRIVER_MAX_AGE_MONTHS;
}

export function advise(scan: HardwareScan, now = Date.now()): AdviceItem[] {
  const items: AdviceItem[] = [{
    id: "cpu_and_ram",
    text: "Revit's model, regeneration, transactions and API stay on the CPU and in system RAM. The GPU cannot replace that RAM.",
    effect: "Closing views and turning on hardware acceleration frees view memory only. The model does not get smaller.",
  }];
  const total = scan.ram.total_mb;
  for (const page of scan.page_files) {
    const cap = page.maximum_mb ?? page.allocated_mb;
    if (cap == null || (total > 0 && cap < total * PAGEFILE_MIN_RATIO) || (cap != null && cap < 8192 && total >= 8192)) {
      items.push({
        id: "pagefile_small",
        text: `The page file ${page.path || "(unnamed)"} is ${cap ?? "unset"} MB. Physical RAM is ${total} MB.`,
        effect: "A larger page file gives Windows room when Revit commits more than physical RAM. It is disk, not GPU memory, and it is slower than RAM.",
      });
    }
    const disk = scan.disks.find((row) => page.drive && row.drive.startsWith(page.drive));
    if (disk && disk.free_mb != null && disk.total_mb != null && (disk.free_mb < PAGEFILE_DISK_FREE_MB || disk.free_mb / disk.total_mb < PAGEFILE_DISK_FREE_RATIO)) {
      items.push({
        id: "pagefile_disk",
        text: `The page file is on ${disk.drive}, which has ${disk.free_mb} MB free of ${disk.total_mb} MB.`,
        effect: "Windows cannot grow the page file on a full drive. Free space on that drive, or move the page file, before Revit asks for more commit.",
      });
    }
  }
  if (!scan.page_files.length && scan.platform === "win32") {
    items.push({
      id: "pagefile_missing",
      text: "No page file was reported.",
      effect: "Revit can fail a large open when commit has nowhere to go. Check the Windows page file. This is system RAM, not the GPU.",
    });
  }
  for (const gpu of scan.gpus) {
    if (driverIsOld(gpu.driver_date, now)) {
      items.push({
        id: "driver_old",
        text: `${gpu.name} driver ${gpu.driver_version ?? ""} is dated ${gpu.driver_date}, more than ${DRIVER_MAX_AGE_MONTHS} months ago.`,
        effect: "A current driver is what makes hardware acceleration use this GPU for views. It does not move the model onto the card.",
      });
    } else if (!gpu.driver_date && gpu.kind !== "basic") {
      items.push({
        id: "driver_unknown",
        text: `${gpu.name} did not report a driver date.`,
        effect: "Check the driver in Windows before relying on hardware acceleration.",
      });
    }
  }
  if (scan.revit_gpu.on_integrated_while_dedicated_exists) {
    items.push({
      id: "integrated_gpu",
      text: "A dedicated GPU is present, and Revit is on the integrated one or the Windows preference asks for power saving.",
      effect: "fmc_hw gpu_prefer with confirm:true sets the high-performance GPU for Revit.exe. It applies at the next Revit start. View drawing can then use the dedicated GPU. The model stays in RAM.",
    });
  }
  const graphics = scan.graphics;
  if (graphics && graphics.use_hardware_acceleration !== "1") {
    items.push({
      id: "hardware_acceleration",
      text: `Use hardware acceleration is ${graphics.use_hardware_acceleration ?? "unset"}.`,
      effect: "Turning it on lets Revit draw views on the GPU. Regeneration and the API stay on the CPU. Apply is fmc_hw offload with confirm:true, and it waits for the next Revit start.",
    });
  }
  if (graphics && graphics.antialiasing !== "1") {
    items.push({
      id: "antialiasing",
      text: `Antialiasing is ${graphics.antialiasing ?? "unset"}.`,
      effect: "On, with hardware acceleration, edge smoothing uses the GPU and some view memory. It does not store the model in VRAM.",
    });
  }
  if (graphics && graphics.optimize_view_navigation !== "1" && graphics.disable_optimized_view_navigation !== "0") {
    items.push({
      id: "optimize_navigation",
      text: "Optimize view navigation is not on in the ini keys this tool reads.",
      effect: "Turning it on keeps pan and zoom on the GPU. Check Options > Graphics after restart if the key name in this Revit build differs.",
    });
  }
  return items;
}

export interface OpenView { id: string; name: string; active: boolean; pinned: boolean }
export interface OpenDoc {
  title: string;
  path: string;
  active: boolean;
  person_working: boolean;
  elements?: number;
  open_views: OpenView[];
  links?: number;
  images?: number;
  undo_depth?: number | null;
  family?: boolean;
  workshared?: boolean;
  detached?: boolean;
  read_only?: boolean;
}

export function planFree(input: {
  documents: OpenDoc[];
  keep: number;
  memory_pause: boolean;
  purge_undo: boolean;
  autosave_due: (doc: { title: string; path: string }) => boolean;
}): {
  close: Array<{ document: string; view_id: string; view: string }>;
  skipped: Array<{ document: string; reason: string }>;
  saves: string[];
  save_skipped: Array<{ document: string; reason: string }>;
  caches: string[];
} {
  const keep = Math.max(1, Math.floor(input.keep));
  const close: Array<{ document: string; view_id: string; view: string }> = [];
  const skipped: Array<{ document: string; reason: string }> = [];
  const saves: string[] = [];
  const saveSkipped: Array<{ document: string; reason: string }> = [];
  for (const doc of input.documents) {
    const name = doc.path || doc.title;
    if (doc.person_working && !input.memory_pause) {
      skipped.push({ document: name, reason: "A person is working in this document. Views stay open unless the memory pause is active." });
    } else {
      const views = doc.open_views;
      const protectedCount = views.filter((view) => view.active || view.pinned).length;
      const spare = views.filter((view) => !view.active && !view.pinned);
      const room = Math.max(0, keep - protectedCount);
      const extras = spare.slice(room);
      let remaining = views.length;
      for (const view of extras) {
        if (remaining <= 1) {
          skipped.push({ document: name, reason: "The last open view is never closed." });
          break;
        }
        close.push({ document: name, view_id: view.id, view: view.name });
        remaining--;
      }
    }
    if (!input.purge_undo) {
      saveSkipped.push({ document: name, reason: "Undo purge was not asked for. No save was added." });
    } else if (input.memory_pause) {
      saveSkipped.push({ document: name, reason: "Autosave waits while the memory pause is active, so this is not an extra save. Revit also keeps the undo list after a local save." });
    } else if (!input.autosave_due(doc)) {
      saveSkipped.push({ document: name, reason: "The existing autosave policy would not save this document now. No extra save, and the undo list is left as it is." });
    } else {
      saves.push(name);
    }
  }
  return {
    close, skipped, saves, save_skipped: saveSkipped,
    caches: [
      "Drop plugin-side image buffers held by this add-in.",
      "There is no separate ExportImage bitmap cache. The PNG already written in the image folder is kept.",
    ],
  };
}

export function autosaveWouldSave(doc: { title?: string; path?: string; family?: boolean; detached?: boolean; read_only?: boolean }, cfg: GuardConfig, now: number, savedAt: number | null): boolean {
  const minutes = autosaveMinutes(cfg);
  if (!(minutes > 0) || !doc.path || doc.family || doc.detached || doc.read_only) return false;
  if (saveBlocked({ title: doc.title, path: doc.path }, cfg)) return false;
  if (savedAt != null && now - savedAt < minutes * 60_000) return false;
  return true;
}

export function autosaveMinutes(cfg: GuardConfig): number {
  const raw = (cfg as unknown as { ai_modeller?: unknown }).ai_modeller;
  const ai = parseConfig(raw);
  if (raw && typeof raw === "object" && typeof (raw as { auto_save_minutes?: unknown }).auto_save_minutes === "number") {
    return (raw as { auto_save_minutes: number }).auto_save_minutes;
  }
  return ai?.auto_save_minutes ?? (ai?.mode === "testing" ? 10 : 0);
}

export function shareEstimates(docs: OpenDoc[], workingSetMb: number | null) {
  const total = docs.reduce((sum, doc) => sum + (doc.elements ?? 0), 0);
  return docs.map((doc) => ({
    title: doc.title,
    path: doc.path,
    elements: doc.elements ?? null,
    estimate_mb: workingSetMb != null && total > 0 && doc.elements != null ? Math.round(workingSetMb * doc.elements / total) : null,
    method: workingSetMb != null && total > 0 ? "share of the Revit process working set by element count" : "counts only",
    not_a_measurement: true,
    contributors: [
      { name: "open views", count: doc.open_views.length },
      { name: "linked models", count: doc.links ?? null },
      { name: "images", count: doc.images ?? null },
      { name: "undo depth", count: doc.undo_depth ?? null, known: doc.undo_depth != null, note: doc.undo_depth == null ? "The Revit API does not expose undo depth." : "" },
    ],
  }));
}

const BUILTIN_BOXES = [[0, 0, 0, 10, 10, 10], [5, 5, 5, 15, 15, 15], [100, 100, 100, 110, 110, 110]];
const BUILTIN_POINTS = [[0, 0, 0], [3, 4, 0], [100, 0, 0]];
const BUILTIN_RAYS: Ray[] = [
  { origin: [0, 0, -10], direction: [0, 0, 1] },
  { origin: [0, 0, -10], direction: [0, 1, 0] },
];

export interface OffloadRequest {
  points?: number[][];
  boxes?: number[][];
  rays?: Ray[];
  graphics_text?: string | null;
  runner?: GpuRunner | null;
  use_gpu?: boolean;
}

export function runOffloadJobs(input: OffloadRequest): { jobs: JobRun<unknown>[]; sample: string; moved_to_gpu: string[]; cannot_move: string[] } {
  const boxes = input.boxes?.length ? input.boxes : BUILTIN_BOXES;
  const points = input.points?.length ? input.points : BUILTIN_POINTS;
  const rays = input.rays?.length ? input.rays : BUILTIN_RAYS;
  const sample = input.boxes?.length || input.points?.length || input.rays?.length ? "caller" : "built-in";
  const useGpu = input.use_gpu === true;
  const runner = input.runner ?? null;
  const jobs = [
    dispatchJob("trace_clash", () => clashPairs(boxes), runner, useGpu),
    dispatchJob("trace_points", () => points.map((point) => pointBoxDistanceMm(point, boxes[0] ?? [])), runner, useGpu),
    dispatchJob("coord_points", () => nearestPointMm(points), runner, useGpu),
    dispatchJob("pressure_test", () => rayVoxelHits(rays, boxes), runner, useGpu),
  ];
  return {
    jobs,
    sample,
    moved_to_gpu: jobs.filter((job) => job.moved_to_gpu).map((job) => job.kind),
    cannot_move: [
      "Revit model database",
      "regeneration",
      "transactions",
      "Revit API calls, including ExportImage and the view export",
      "fmc_trace verdicts (the element walk stays on the API; only this numeric sample can leave the CPU)",
      "fmc_coord transforms (the 4×4 stays on the CPU; only the point-distance sample can leave the CPU)",
    ],
  };
}

export function dedicatedGpu(scan: HardwareScan): boolean {
  return scan.gpus.some((gpu) => gpu.kind === "dedicated");
}

export interface HwIo {
  collect?: () => Promise<HostRaw>;
  now?: () => number;
  readIni?: () => string | null;
  writeIni?: (text: string) => void;
  writePreference?: (exe: string, value: string) => void;
  revit?: (action: string, body: Record<string, unknown>) => Promise<unknown>;
  /** A model-changing Revit call through sendCommand (lease, memory, live-model lock, AI gate). */
  revitWrite?: (command: string, body: Record<string, unknown>) => Promise<unknown>;
  gpuRunner?: GpuRunner | null;
  config?: GuardConfig;
  savedAt?: (file: string) => number | null;
  idle?: () => boolean;
}

let lastAutoFree = 0;

export async function collectDefault(): Promise<HostRaw> {
  if (process.platform !== "win32") return hostFromOs();
  try {
    const text = await runPowerShell(COLLECT_SCRIPT);
    const parsed = JSON.parse(text) as HostRaw;
    parsed.platform = "win32";
    return parsed;
  } catch {
    return hostFromOs();
  }
}

export async function buildScan(io: HwIo = {}, mergeRevit = false): Promise<HardwareScan> {
  const raw = await (io.collect ?? collectDefault)();
  const scan = parseHost(raw);
  const ini = io.readIni ? io.readIni() : null;
  if (ini != null) scan.graphics = readGraphics(ini, "revit.ini");
  if (mergeRevit && io.revit) {
    try {
      const extra = await io.revit("graphics", {}) as { graphics?: GraphicsReading; revit_gpu_name?: string };
      if (extra?.graphics) scan.graphics = { ...extra.graphics, source: extra.graphics.source || "add-in" };
      if (extra?.revit_gpu_name && !scan.revit_gpu.name) scan.revit_gpu = { ...scan.revit_gpu, name: extra.revit_gpu_name };
    } catch { /* the OS scan still stands when Revit is closed */ }
  }
  scan.honesty = HONESTY;
  return rememberScan(stripSecrets(scan));
}

export async function primeHardwareScan(io: HwIo = {}): Promise<HardwareScan> {
  try { return await buildScan(io, false); }
  catch { return rememberScan(parseHost(hostFromOs())); }
}

/** Revit.ini is replaced whole: the file as it was is kept beside it as Revit.ini.bak first. */
export function writeIniWithBackup(file: string, text: string): { backup: string | null } {
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    backup = `${file}.bak`;
    fs.copyFileSync(file, backup);
  }
  fs.writeFileSync(file, text, "utf8");
  return { backup };
}

export async function autoFreeIfHard(io: HwIo = {}): Promise<{ ran: boolean; reason: string }> {
  // Closing views with no person: only when a person turned it on for this PC (hw_auto_free in fmc_guard.json).
  if (loadGuard(io).hw_auto_free !== true) return { ran: false, reason: "hw_auto_free is off in fmc_guard.json. Auto free stays off; a person runs fmc_hw free." };
  const view = memoryGate.view();
  if (view.pause_below_mb <= 0) return { ran: false, reason: "ram_pause_free_mb is 0. Auto free stays off." };
  if (view.tier !== "hard") return { ran: false, reason: "Auto free runs only in the hard tier." };
  if (io.idle && !io.idle()) return { ran: false, reason: "Revit is not idle." };
  if (Date.now() - lastAutoFree < 60_000) return { ran: false, reason: "Auto free already ran in the last minute." };
  lastAutoFree = Date.now();
  if (!io.revit) return { ran: false, reason: "No Revit connection was given, so nothing was closed." };
  try {
    const snapshot = await io.revit("memory", {}) as { documents?: OpenDoc[] };
    const docs = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
    const plan = planFree({
      documents: docs,
      keep: 2,
      memory_pause: true,
      purge_undo: false,
      autosave_due: () => false,
    });
    await io.revit("free", { dry_run: false, memory_pause: true, keep: 2, close: plan.close, saves: [] });
    return { ran: true, reason: "Hard pause is on and Revit was idle. Non-active, non-pinned views beyond 2 were closed where the add-in allowed. No save was added." };
  } catch (error) {
    return { ran: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function memoryReport(view: MemoryView = memoryGate.view(), docs: OpenDoc[] = []): Record<string, unknown> {
  const working = view.revit_working_set_mb;
  return {
    tier: view.tier,
    code: view.code,
    reason: view.reason,
    paused: view.paused,
    free_mb: view.free_mb,
    total_mb: view.total_mb,
    pause_below_mb: view.pause_below_mb,
    resume_above_mb: view.resume_above_mb,
    revit_working_set_mb: working,
    trend_mb: view.trend_mb,
    documents: shareEstimates(docs, working),
    honesty: HONESTY,
  };
}

export async function gpuPreferencePlan(scan: HardwareScan, io: HwIo, args: { dry_run: boolean; confirm: boolean }): Promise<Record<string, unknown>> {
  const exe = scan.gpu_preference.exe || scan.revit[0]?.path || "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe";
  const planned = { exe, name: "GpuPreference", value: "GpuPreference=2;", meaning: "Windows high-performance GPU for this exe. It is read the next time Revit starts." };
  const current = scan.gpu_preference;
  if (args.dry_run || !args.confirm) {
    return {
      action: "gpu_prefer", dry_run: true, applied: false, planned, current,
      revit_ini: "not changed. Set Use hardware acceleration in Options, or use fmc_hw offload with confirm:true. gpu_prefer does not write Revit.ini.",
      refused: !args.dry_run && !args.confirm,
      code: !args.dry_run && !args.confirm ? "FMC-HW-CONFIRM" : undefined,
      message: !args.dry_run && !args.confirm ? "Pass confirm:true to write the Windows GPU preference. The default is a dry run." : undefined,
    };
  }
  if (io.writePreference) io.writePreference(exe, planned.value);
  else if (process.platform === "win32") await writePreferenceDefault(exe, planned.value);
  else throw new Error("[FMC-HW] The Windows GPU preference can be set only on Windows.");
  return {
    action: "gpu_prefer", dry_run: false, applied: true, planned, current,
    revit_ini: "not changed",
    effect: "Revit uses this preference the next time it starts. The open session is unchanged. The model still stays in system RAM.",
  };
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("hardware scan timed out")); }, 8000);
    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
  });
}

async function writePreferenceDefault(exe: string, value: string): Promise<void> {
  const script = `
    $path = 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences'
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
    New-ItemProperty -Path $path -Name ${JSON.stringify(exe)} -Value ${JSON.stringify(value)} -PropertyType String -Force | Out-Null
  `;
  await runPowerShell(script);
}

const COLLECT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$adapters = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; vendor = $_.AdapterCompatibility; wmi_ram_bytes = [int64]$_.AdapterRAM; driver_version = $_.DriverVersion; driver_date = $_.DriverDate; pnp = $_.PNPDeviceID }
})
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$pages = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object { [pscustomobject]@{ name = $_.Name; allocated_mb = [int]$_.AllocatedBaseSize; current_mb = [int]$_.CurrentUsage } })
$settings = @(Get-CimInstance Win32_PageFileSetting)
foreach ($page in $pages) {
  $set = $settings | Where-Object { $_.Name -eq $page.name } | Select-Object -First 1
  if ($set) { $page | Add-Member initial_mb ([int]$set.InitialSize) -Force; $page | Add-Member maximum_mb ([int]$set.MaximumSize) -Force }
}
$disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ drive = $_.DeviceID; free_mb = [int]($_.FreeSpace/1MB); total_mb = [int]($_.Size/1MB) } })
$procs = @()
Get-Process -Name Revit -ErrorAction SilentlyContinue | ForEach-Object {
  $commit = [int64]$_.PagedMemorySize64
  try {
    $sample = (Get-Counter ("\\Process(*)\\Page File Bytes")).CounterSamples | Where-Object { $_.InstanceName -match ('^Revit') } | Select-Object -First 1
    if ($sample) { $commit = [int64]$sample.CookedValue }
  } catch {}
  $procs += [pscustomobject]@{ name = 'Revit'; pid = [int]$_.Id; path = $_.Path; working_set_bytes = [int64]$_.WorkingSet64; private_bytes = [int64]$_.PrivateMemorySize64; commit_bytes = $commit }
}
$engines = @()
try {
  (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage').CounterSamples | ForEach-Object {
    if ($_.InstanceName -match 'pid_(\\d+)_luid_0x[0-9A-Fa-f]+_(0x[0-9A-Fa-f]+)') {
      $engines += [pscustomobject]@{ pid = [int]$Matches[1]; luid = $Matches[2]; dedicated_bytes = [int64]$_.CookedValue }
    }
  }
} catch {}
$videos = @()
try {
  (Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples | ForEach-Object {
    $luid = $null
    if ($_.InstanceName -match 'luid_0x[0-9A-Fa-f]+_(0x[0-9A-Fa-f]+)') { $luid = $Matches[1] }
    $videos += [pscustomobject]@{ luid = $luid; current_usage_bytes = [int64]$_.CookedValue }
  }
} catch {}
$pref = $null
$reg = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\DirectX\\UserGpuPreferences' -ErrorAction SilentlyContinue
if ($reg) {
  foreach ($proc in $procs) {
    $hit = $reg.PSObject.Properties | Where-Object { $_.Name -eq $proc.path } | Select-Object -First 1
    if ($hit) { $pref = [pscustomobject]@{ exe = $proc.path; value = [string]$hit.Value } }
  }
}
[pscustomobject]@{
  adapters = $adapters
  memory = [pscustomobject]@{ total_mb = [int]($os.TotalVisibleMemorySize/1024); free_mb = [int]($os.FreePhysicalMemory/1024); source = 'cim' }
  pagefiles = $pages
  disks = $disks
  cpu = [pscustomobject]@{ name = [string]$cpu.Name; cores = [int]$cpu.NumberOfCores; logical = [int]$cpu.NumberOfLogicalProcessors }
  processes = $procs
  gpu_engines = $engines
  video_memory = $videos
  gpu_preference = $pref
} | ConvertTo-Json -Depth 6 -Compress
`;

export function defaultIniPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.APPDATA || "";
  return base ? `${base}\\Autodesk\\Revit\\Autodesk Revit 2025\\Revit.ini` : "";
}

export function loadGuard(io: HwIo): GuardConfig {
  return io.config ?? loadConfig().config;
}
