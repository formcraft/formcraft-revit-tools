import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { readInstances } from "../fmc/connect.js";
import { inFlightJob, readRevitJobLines } from "../fmc/notidle.js";
import { onMemoryHard } from "../fmc/memory.js";
import {
  HONESTY, advise, applyGraphicsText, autoFreeIfHard, autosaveWouldSave, buildScan, dedicatedGpu,
  defaultIniPath, graphicsPlan, gpuPreferencePlan, loadGuard, memoryReport, planFree, primeHardwareScan,
  readGraphics, runOffloadJobs, type HwIo, type OpenDoc,
} from "../fmc/hw.js";
import { batchLease } from "../fmc/target.js";
import { documentsMatch, leaseHeldDocuments } from "../fmc/batchline.js";
import { loadAiConfig } from "../fmc/aiuse_io.js";
import { checkHwApproval, iniFacts, useHwApproval, writeIniAtomic, type HwApprovalKind, type HwBinding } from "../fmc/hwapproval.js";
import { probeDirectMl, type GpuRunner } from "../fmc/hwgpu.js";

export const FMC_HW_DESCRIPTION =
  "Formcraft hardware and memory. One tool. The GPU cannot replace system RAM, and the Revit API runs on the CPU. " +
  "Video memory is for views. The model database, regeneration and transactions stay on the CPU and in RAM. " +
  "actions: scan (GPUs, RAM, page file, disks, CPU, the Revit process, which GPU Revit is on, hardware acceleration; cached at startup and shown on /health hw), " +
  "gpu_prefer (Windows high-performance GPU for Revit.exe; dry_run true unless you pass false; a real change needs confirm:true and a person's hw_gpu_prefer approval in the pane (FMC-HW-APPROVAL otherwise); next Revit start; never writes Revit.ini), " +
  "memory (per-document estimate, working-set trend, open views, links, images, undo when known, and the soft or hard pause), " +
  "free (close non-active, non-pinned views beyond keep, drop plugin image buffers; a save only when the existing autosave would save; dry_run true by default; " +
  "a real free needs confirm:true, document, this session's batch lease on it, and a person's hw_free approval, and goes through the live-model lock, the AI gate and Stop AI like any model change), " +
  "advice (a short list, each with the effect you should expect), " +
  "offload (report graphics settings and recommend hardware acceleration, the dedicated GPU, GPU anti-aliasing and optimize-view-navigation; " +
  "apply those ini keys only with confirm:true and a person's hw_offload approval, after a timestamped Revit.ini.<stamp>.bak and an atomic replace, effective at the next Revit start; run point, clash and ray/voxel samples on the CPU, " +
  "or on an optional GPU library when it matches the CPU). " +
  "Soft pause (FMC-MEMORY-SOFT) keeps reads and small writes and queues heavy writes, Dynamo and scripts. " +
  "Hard pause (FMC-MEMORY-HARD) waits on every model-changing call. Reads still run. Thresholds are the existing ram_pause_free_mb and its 1.5× resume line. " +
  "The token is never printed.";

export const FMC_HW_SHAPE = {
  action: z.enum(["scan", "gpu_prefer", "memory", "free", "advice", "offload"]).describe("What to do."),
  dry_run: z.boolean().optional().default(true).describe("For gpu_prefer, free and offload. True returns the plan and changes nothing."),
  confirm: z.boolean().optional().default(false).describe("Required with dry_run false before gpu_prefer, free or offload changes anything."),
  document: z.string().optional().default("").describe("free with dry_run false: the one open document (title or full path) whose spare views close."),
  keep: z.number().int().min(1).max(20).optional().default(2).describe("free: how many views to leave open on a document, never closing the last one."),
  purge_undo: z.boolean().optional().default(false).describe("free: ask for a save only where autosave would already save. A local save does not clear Revit's undo list."),
  points: z.array(z.array(z.number())).max(200).optional().describe("offload: sample points, millimetres. Omitted: a built-in sample, not the open model."),
  boxes: z.array(z.array(z.number())).max(200).optional().describe("offload: axis-aligned boxes as six numbers, min then max."),
  rays: z.array(z.object({ origin: z.array(z.number()).length(3), direction: z.array(z.number()).length(3) })).max(50).optional(),
  batch_lease: z.string().optional().default("").describe("Real free, gpu_prefer or offload with a Revit model open: this session's batch lease on the document."),
};

export type FmcHwArgs = {
  action: "scan" | "gpu_prefer" | "memory" | "free" | "advice" | "offload";
  dry_run?: boolean;
  confirm?: boolean;
  document?: string;
  keep?: number;
  purge_undo?: boolean;
  points?: number[][];
  boxes?: number[][];
  rays?: Array<{ origin: number[]; direction: number[] }>;
  batch_lease?: string;
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

/** FINAL 2.2 item 3: the Stop AI wording of aiuse.ts. A stopped switch refuses before anything changes. */
const STOP_AI = "AI-assisted modeller: Stop AI is on: every AI change is refused until it is switched off.";

function stopAiOn(io: HwIo): boolean {
  if (io.stopAi) return io.stopAi();
  try { return loadAiConfig(loadGuard(io), io.env ?? process.env)?.stop === true; } catch { return false; }
}

function stopRefusal(io: HwIo, action: string): Record<string, unknown> | null {
  if (!stopAiOn(io)) return null;
  return { tool: "fmc_hw", action, refused: true, code: "FMC-AI-STOP", dry_run: true, applied: false, message: `${STOP_AI} Nothing was changed.`, honesty: HONESTY };
}

const callerLease = (args: FmcHwArgs) => (args.batch_lease ?? "").trim() || (batchLease.getStore() ?? "").trim();

/** FINAL 2.2 item 1: a real AI write needs this session's lease covering the document (FMC-BATCH-LOCKED wording). */
function leaseRefusal(io: HwIo, args: FmcHwArgs, document: string): Record<string, unknown> | null {
  const lease = callerLease(args);
  const held = io.leaseDocuments ? io.leaseDocuments() : leaseHeldDocuments(lease);
  if (held.some((name) => documentsMatch(name, document))) return null;
  return {
    tool: "fmc_hw", action: args.action, refused: true, code: "FMC-BATCH-LOCKED", dry_run: true, applied: false,
    message: `[FMC-BATCH-LOCKED] A real fmc_hw ${args.action} needs this session's batch lease on ${document} (fmc_batch begin, then pass batch_lease). ` +
      (held.length ? `Lease ${lease} is for ${held.join(", ")}.` : "This session holds no lease on it.") + " Nothing was changed.",
    honesty: HONESTY,
  };
}

/** The gated write runs under the caller's lease so sendCommand's batch admission sees it. */
function underLease<T>(args: FmcHwArgs, fn: () => Promise<T>): Promise<T> {
  const lease = callerLease(args);
  return lease ? batchLease.run(lease, fn) : fn();
}

function approvalRefusal(action: string, check: { id: string; message: string }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tool: "fmc_hw", action, refused: true, code: "FMC-HW-APPROVAL", dry_run: true, applied: false, approval_id: check.id, message: check.message, ...extra, honesty: HONESTY };
}

function approve(kind: HwApprovalKind, binding: HwBinding, io: HwIo, now: number) {
  return checkHwApproval(kind, binding, io.env ?? process.env, new Date(now));
}

/**
 * gpu_prefer and offload write a machine setting, not a model (FINAL 2.2 item 2). With a Revit model open they still
 * need a named document when two or more project documents are open, this session's lease on it, and the
 * live-model lock and AI gate on it (fmc_hw_host: a gate-only write that sends nothing to Revit). With no Revit open
 * there is no model to gate; Stop AI and the person's approval still apply.
 */
async function hostGate(io: HwIo, args: FmcHwArgs): Promise<Record<string, unknown> | null> {
  const stop = stopRefusal(io, args.action);
  if (stop) return stop;
  let docs: OpenDoc[] = [];
  if (io.revit) {
    try {
      const raw = await io.revit("memory", {}) as { documents?: OpenDoc[] };
      docs = Array.isArray(raw?.documents) ? raw.documents : [];
    } catch { docs = []; }
  }
  const projects = docs.filter((doc) => !doc.family);
  const named = (args.document ?? "").trim();
  if (!projects.length && !named) return null;
  const target = named ? docs.find((doc) => sameDoc(doc, named)) : projects.length === 1 ? projects[0] : undefined;
  if (!target) {
    return {
      tool: "fmc_hw", action: args.action, refused: true, code: "FMC-DOC-REQUIRED", dry_run: true, applied: false,
      message: named ? `${named} is not open. Nothing was changed.` : "Several project documents are open. Pass document: one open document's title or path. Nothing was changed.",
      open: docs.map((doc) => doc.path || doc.title), honesty: HONESTY,
    };
  }
  const name = target.path || target.title;
  const lease = leaseRefusal(io, args, name);
  if (lease) return lease;
  if (!io.revitWrite) throw new Error("[FMC-HW] No gated Revit write was given, so nothing was changed.");
  await underLease(args, () => io.revitWrite!("fmc_hw_host", { document: name, host_action: args.action }));
  return null;
}

const sameDoc = (doc: OpenDoc, name: string) => {
  const key = name.trim().toLowerCase();
  return (doc.title ?? "").toLowerCase() === key || (doc.path ?? "").toLowerCase() === key;
};

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-HW";
  return reply({ tool: "fmc_hw", refused: true, code, message, honesty: HONESTY }, true);
}

let runnerMemo: Promise<GpuRunner | null> | null = null;

function defaultIo(over: HwIo = {}): HwIo {
  return {
    now: () => Date.now(),
    readIni: () => {
      const file = over.iniPath ?? defaultIniPath(over.env);
      try { return file ? fs.readFileSync(file, "utf8") : null; } catch { return null; }
    },
    revit: (action, body) => withRevitConnection((client) => client.sendRaw("fmc_hw", { action, ...body }, 120000)),
    revitWrite: (command, body) => withRevitConnection((client) => client.sendCommand(command, body, 120000)),
    savedAt: (file) => {
      try { return fs.statSync(file).mtimeMs; } catch { return null; }
    },
    ...over,
  };
}

async function runnerOf(io: HwIo): Promise<GpuRunner | null> {
  if (io.gpuRunner !== undefined) return io.gpuRunner;
  runnerMemo ??= probeDirectMl();
  return runnerMemo;
}

export async function runFmcHw(args: FmcHwArgs, io: HwIo = {}) {
  const full = defaultIo(io);
  const now = full.now?.() ?? Date.now();
  try {
    if (args.action === "scan") {
      const scan = await buildScan(full, true);
      return reply({ tool: "fmc_hw", action: "scan", ...scan, advice: advise(scan, now), memory: memoryReport() });
    }
    if (args.action === "advice") {
      const scan = await buildScan(full, true);
      return reply({ tool: "fmc_hw", action: "advice", advice: advise(scan, now), honesty: HONESTY });
    }
    if (args.action === "gpu_prefer") {
      const scan = await buildScan(full, false);
      const dry = args.dry_run !== false;
      if (dry || args.confirm !== true) {
        const body = await gpuPreferencePlan(scan, full, { dry_run: dry, confirm: args.confirm === true });
        return reply({ tool: "fmc_hw", ...body, honesty: HONESTY }, body.refused === true);
      }
      const preview = await gpuPreferencePlan(scan, full, { dry_run: true, confirm: false });
      const planned = preview.planned as { exe: string; value: string };
      const gate = await hostGate(full, args);
      if (gate) return reply({ ...gate, planned }, true);
      const check = approve("hw_gpu_prefer", {
        target: planned.exe, plan: { exe: planned.exe, value: planned.value },
        model: "this PC: Windows GPU preference", details: [`Set ${planned.value} for ${planned.exe} (HKCU UserGpuPreferences).`],
      }, full, now);
      if (!check.ok) return reply(approvalRefusal("gpu_prefer", check, { planned }), true);
      const body = await gpuPreferencePlan(scan, full, { dry_run: false, confirm: true });
      useHwApproval(check.id, full.env ?? process.env, new Date(now));
      return reply({ tool: "fmc_hw", ...body, approval: { id: check.id, by: check.by }, honesty: HONESTY });
    }
    if (args.action === "memory") {
      let docs: OpenDoc[] = [];
      let addin: string | null = null;
      if (full.revit) {
        try {
          const raw = await full.revit("memory", {}) as { documents?: OpenDoc[] };
          docs = Array.isArray(raw?.documents) ? raw.documents : [];
        } catch (error) {
          addin = error instanceof Error ? error.message : String(error);
        }
      }
      return reply({ tool: "fmc_hw", action: "memory", ...memoryReport(undefined, docs), addin });
    }
    if (args.action === "free") {
      const view = memoryReport();
      // FINAL 3.3: soft is not a reason to set memory_pause; a soft-tier free still skips the active document.
      const pause = view.tier === "hard" || view.paused === true;
      let docs: OpenDoc[] = [];
      if (full.revit) {
        try {
          const raw = await full.revit("memory", {}) as { documents?: OpenDoc[] };
          docs = Array.isArray(raw?.documents) ? raw.documents : [];
        } catch (error) {
          return reply({
            tool: "fmc_hw", action: "free", dry_run: true, applied: false,
            message: error instanceof Error ? error.message : String(error),
            honesty: HONESTY,
          }, true);
        }
      }
      const cfg = loadGuard(full);
      const plan = planFree({
        documents: docs,
        keep: args.keep ?? 2,
        memory_pause: pause,
        purge_undo: args.purge_undo === true,
        autosave_due: (doc) => autosaveWouldSave(doc, cfg, now, doc.path && full.savedAt ? full.savedAt(doc.path) : null),
      });
      if (args.dry_run !== false) {
        return reply({ tool: "fmc_hw", action: "free", dry_run: true, applied: false, memory: view, plan, honesty: HONESTY });
      }
      if (args.confirm !== true) {
        return reply({
          tool: "fmc_hw", action: "free", refused: true, code: "FMC-HW-CONFIRM", dry_run: true, applied: false, memory: view, plan,
          message: "Pass confirm:true and document to close these views (a person's yes first). Nothing was closed.",
          honesty: HONESTY,
        }, true);
      }
      const named = (args.document ?? "").trim();
      const target = named ? docs.find((doc) => sameDoc(doc, named)) : undefined;
      if (!target) {
        return reply({
          tool: "fmc_hw", action: "free", refused: true, code: "FMC-DOC-REQUIRED", dry_run: true, applied: false,
          message: named ? `${named} is not open. Nothing was closed.` : "free with dry_run false needs document: one open document's title or path. Nothing was closed.",
          open: docs.map((doc) => doc.path || doc.title),
          honesty: HONESTY,
        }, true);
      }
      const name = target.path || target.title;
      const close = plan.close.filter((row) => row.document === name);
      const saves = plan.saves.filter((row) => row === name);
      const stop = stopRefusal(full, "free");
      if (stop) return reply(stop, true);
      const lease = leaseRefusal(full, args, name);
      if (lease) return reply(lease, true);
      const keep = args.keep ?? 2;
      const purge = args.purge_undo === true;
      const check = approve("hw_free", {
        target: name,
        plan: { close: close.map((row) => ({ view_id: row.view_id, view: row.view })), saves, keep, purge_undo: purge },
        model: target.title || name,
        details: [`Close ${close.length} view${close.length === 1 ? "" : "s"} in ${name}: ${close.map((row) => `${row.view} (${row.view_id})`).join(", ") || "none"}.`, `keep ${keep}, purge_undo ${purge}`],
      }, full, now);
      if (!check.ok) return reply(approvalRefusal("free", check, { document: name, plan: { ...plan, close, saves } }), true);
      if (!full.revitWrite) throw new Error("[FMC-HW] No gated Revit write was given, so nothing was closed.");
      // fmc_hw_free is a write: batch lease, live-model lock and AI gate (it is exempt only from the memory hold).
      const result = await underLease(args, () => full.revitWrite!("fmc_hw_free", { document: name, dry_run: false, memory_pause: pause, keep, close, saves }));
      useHwApproval(check.id, full.env ?? process.env, new Date(now));
      return reply({ tool: "fmc_hw", action: "free", dry_run: false, applied: true, document: name, memory: view, plan: { ...plan, close, saves }, result, approval: { id: check.id, by: check.by }, honesty: HONESTY });
    }
    const scan = await buildScan(full, true);
    const ini = full.readIni ? full.readIni() : null;
    const graphics = scan.graphics ?? (ini != null ? readGraphics(ini, "revit.ini") : null);
    const plan = graphicsPlan(graphics);
    const runner = await runnerOf(full);
    const jobs = runOffloadJobs({
      points: args.points,
      boxes: args.boxes,
      rays: args.rays,
      runner,
      use_gpu: dedicatedGpu(scan),
    });
    const dry = args.dry_run !== false;
    if (!dry && args.confirm !== true) {
      return reply({
        tool: "fmc_hw", action: "offload", refused: true, code: "FMC-HW-CONFIRM", dry_run: true, applied: false,
        message: "Pass confirm:true to write the graphics keys. They take effect the next time Revit starts. Revit.ini was not changed.",
        graphics, planned_writes: plan.writes, recommended: plan.recommended, jobs: jobs.jobs,
        moved_to_gpu: jobs.moved_to_gpu, cannot_move: jobs.cannot_move, sample: jobs.sample,
        honesty: HONESTY,
      }, true);
    }
    let applied = false;
    let written: string[] = [];
    let backup: string | null = null;
    let approval: Record<string, unknown> | undefined;
    if (!dry && args.confirm === true && plan.writes.length) {
      const file = full.iniPath ?? defaultIniPath(full.env);
      if (!file) throw new Error("[FMC-HW] Revit.ini path is not set. Nothing was written.");
      const facts = iniFacts(file);
      if (!facts || ini == null) throw new Error(`[FMC-HW] Revit.ini was not found (${file}). Nothing was written.`);
      const gate = await hostGate(full, args);
      if (gate) return reply({ ...gate, graphics, planned_writes: plan.writes, recommended: plan.recommended }, true);
      const check = approve("hw_offload", {
        target: file,
        plan: { sha256: facts.sha256, size: facts.size, mtime: facts.mtime, writes: plan.writes.map((row) => ({ section: row.section, key: row.key, value: row.value })) },
        model: "this PC: Revit.ini",
        details: [`Write ${plan.writes.map((row) => `${row.section}/${row.key}=${row.value}`).join(", ")} to ${file}.`, `sha256 ${facts.sha256.slice(0, 12)}…, ${facts.size} bytes`],
      }, full, now);
      if (!check.ok) return reply(approvalRefusal("offload", check, { graphics, planned_writes: plan.writes, recommended: plan.recommended }), true);
      backup = writeIniAtomic(file, applyGraphicsText(ini, plan.writes), new Date(now), full.iniFs).backup;
      useHwApproval(check.id, full.env ?? process.env, new Date(now));
      applied = true;
      approval = { id: check.id, by: check.by };
      written = plan.writes.map((row) => `${row.section}/${row.key}=${row.value}`);
    }
    return reply({
      tool: "fmc_hw", action: "offload", dry_run: dry, applied,
      graphics, planned_writes: plan.writes, recommended: plan.recommended, written,
      ...(backup ? { backup } : {}), ...(approval ? { approval } : {}),
      takes_effect: "next Revit start. An open Revit may rewrite Revit.ini when it closes, so close Revit before relying on the file.",
      jobs: jobs.jobs.map((job) => ({
        ...job,
        where: job.kind === "pressure_test"
          ? "fmc_joins pressure_test walks the envelope on the CPU. This ray/voxel sample did not replace that walk and did not read a model."
          : job.kind === "coord_points"
            ? "fmc_coord point distances. The 4×4 transform stays on the CPU."
            : job.kind.startsWith("trace")
              ? "fmc_trace numeric sample. Collecting elements stays on the Revit API."
              : job.kind,
      })),
      view_export: {
        backend: graphics?.use_hardware_acceleration === "1" ? "revit_graphics" : "cpu",
        moved_to_gpu: false,
        note: "see_view, screenshots and ExportImage are Revit API calls. They run on the CPU. The GPU draws the view only when hardware acceleration is on. There is no plugin compute shader for the picture.",
      },
      moved_to_gpu: jobs.moved_to_gpu,
      cannot_move: jobs.cannot_move,
      sample: jobs.sample,
      not_the_open_model: jobs.sample === "built-in",
      optional_gpu: runner ? { id: runner.id, available: runner.available, detail: runner.detail } : { id: "cpu", available: false, detail: "onnxruntime-node is not installed. Formcraft.Gpu.dll is optional and is not required to build the add-in." },
      revit_vram: scan.revit_vram,
      honesty: HONESTY,
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcHwTool(server: McpServer) {
  server.tool("fmc_hw", FMC_HW_DESCRIPTION, FMC_HW_SHAPE, (args) => runFmcHw(args));
}

function revitIdle(): boolean {
  try {
    const lines = readRevitJobLines();
    const now = Date.now();
    return !readInstances().some((instance) => inFlightJob(lines, instance.pid, now));
  } catch {
    return false;
  }
}

let hooked = false;
function hookAutoFree(): void {
  if (hooked) return;
  hooked = true;
  onMemoryHard(() => {
    void autoFreeIfHard({
      idle: revitIdle,
      // System action (FINAL section 4): sendRaw on the session command fmc_hw, never the gated AI free path.
      revit: (action, body) => withRevitConnection((client) => client.sendRaw("fmc_hw", { action, ...body }, 120000)),
      savedAt: () => null,
    }).catch(() => { /* a missed free must not take down the server */ });
  });
}

hookAutoFree();

export async function warmHardwareCache(): Promise<void> {
  await primeHardwareScan().catch(() => undefined);
}
