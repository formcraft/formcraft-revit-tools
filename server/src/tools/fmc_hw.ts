import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { currentPort, withRevitConnection } from "../utils/ConnectionManager.js";
import { readInstances } from "../fmc/connect.js";
import { inFlightJob, readRevitJobLines } from "../fmc/notidle.js";
import { onMemoryHard } from "../fmc/memory.js";
import {
  HONESTY, advise, applyGraphicsText, autoFreeIfHard, autosaveWouldSave, buildScan, dedicatedGpu,
  defaultIniPath, graphicsPlan, gpuPreferencePlan, loadGuard, memoryReport, planFree, primeHardwareScan,
  readGraphics, runOffloadJobs, writeIniWithBackup, type HwIo, type OpenDoc,
} from "../fmc/hw.js";
import { probeDirectMl, type GpuRunner } from "../fmc/hwgpu.js";

export const FMC_HW_DESCRIPTION =
  "Formcraft hardware and memory. One tool. The GPU cannot replace system RAM, and the Revit API runs on the CPU. " +
  "Video memory is for views. The model database, regeneration and transactions stay on the CPU and in RAM. " +
  "actions: scan (GPUs, RAM, page file, disks, CPU, the Revit process, which GPU Revit is on, hardware acceleration; cached at startup and shown on /health hw), " +
  "gpu_prefer (Windows high-performance GPU for Revit.exe; dry_run true unless you pass false; confirm:true to apply, and only when a person turned on hw_host_writes for this PC (FMC-HW-PERSON otherwise); next Revit start; never writes Revit.ini), " +
  "memory (per-document estimate, working-set trend, open views, links, images, undo when known, and the soft or hard pause), " +
  "free (close non-active, non-pinned views beyond keep, drop plugin image buffers; a save only when the existing autosave would save; dry_run true by default; " +
  "a real free needs confirm:true and document, and goes through the batch lease, the live-model lock and the AI gate like any model change), " +
  "advice (a short list, each with the effect you should expect), " +
  "offload (report graphics settings and recommend hardware acceleration, the dedicated GPU, GPU anti-aliasing and optimize-view-navigation; " +
  "apply those ini keys only with confirm:true and hw_host_writes on for this PC, keeping Revit.ini.bak, effective at the next Revit start; run point, clash and ray/voxel samples on the CPU, " +
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
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

/** Registry and Revit.ini are machine settings: a person decides them (hw_host_writes), never an AI call on its own. */
function hostWriteRefusal(io: HwIo, action: "gpu_prefer" | "offload"): Record<string, unknown> | null {
  if (loadGuard(io).hw_host_writes === true) return null;
  return {
    tool: "fmc_hw", action, refused: true, code: "FMC-HW-PERSON", dry_run: true, applied: false,
    message: `${action} changes a machine setting (${action === "gpu_prefer" ? "the Windows GPU preference" : "Revit.ini"}), not a model, so a person decides it: ` +
      "set it in Revit Options > Graphics or Windows Graphics settings, or a person turns on hw_host_writes in fmc_guard.json for this PC. Nothing was written.",
    honesty: HONESTY,
  };
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
      try { return fs.readFileSync(defaultIniPath(), "utf8"); } catch { return null; }
    },
    writeIni: (text) => {
      const file = defaultIniPath();
      if (!file) throw new Error("[FMC-HW] Revit.ini path is not set.");
      writeIniWithBackup(file, text);
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
      if (args.dry_run === false && args.confirm === true) {
        const stop = hostWriteRefusal(full, "gpu_prefer");
        if (stop) return reply(stop, true);
      }
      const scan = await buildScan(full, false);
      const body = await gpuPreferencePlan(scan, full, { dry_run: args.dry_run !== false, confirm: args.confirm === true });
      const refused = body.refused === true;
      return reply({ tool: "fmc_hw", ...body, honesty: HONESTY }, refused);
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
      const pause = view.tier === "hard" || view.tier === "soft" || view.paused === true;
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
      if (!full.revitWrite) throw new Error("[FMC-HW] No gated Revit write was given, so nothing was closed.");
      // fmc_hw_free is a write: batch lease, live-model lock and AI gate (it is exempt only from the memory hold).
      const result = await full.revitWrite("fmc_hw_free", { document: name, dry_run: false, memory_pause: pause, keep: args.keep ?? 2, close, saves });
      return reply({ tool: "fmc_hw", action: "free", dry_run: false, applied: true, document: name, memory: view, plan: { ...plan, close, saves }, result, honesty: HONESTY });
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
    if (!dry && args.confirm === true) {
      const stop = hostWriteRefusal(full, "offload");
      if (stop) return reply({ ...stop, graphics, planned_writes: plan.writes, recommended: plan.recommended }, true);
    }
    let applied = false;
    let written: string[] = [];
    if (!dry && args.confirm === true && ini != null && full.writeIni && plan.writes.length) {
      full.writeIni(applyGraphicsText(ini, plan.writes));
      applied = true;
      written = plan.writes.map((row) => `${row.section}/${row.key}=${row.value}`);
    }
    return reply({
      tool: "fmc_hw", action: "offload", dry_run: dry, applied,
      graphics, planned_writes: plan.writes, recommended: plan.recommended, written,
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
      // The documents of the Revit this call goes to (P-fmc_hw-02): each auto-free call names one of them.
      openDocuments: async () => {
        try {
          const port = await currentPort();
          return (readInstances().find((instance) => instance.port === port)?.documents ?? []) as Array<{ title?: string; path?: string; family?: boolean }>;
        } catch { return []; }
      },
      revit: (action, body) => withRevitConnection((client) => client.sendRaw("fmc_hw", { action, ...body }, 120000)),
      savedAt: () => null,
    }).catch(() => { /* a missed free must not take down the server */ });
  });
}

hookAutoFree();

export async function warmHardwareCache(): Promise<void> {
  await primeHardwareScan().catch(() => undefined);
}
