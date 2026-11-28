import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { readInstances } from "../fmc/connect.js";
import { inFlightJob, readRevitJobLines } from "../fmc/notidle.js";
import { memoryGate, onMemoryHard } from "../fmc/memory.js";
import {
  HONESTY, advise, applyGraphicsText, autoFreeIfHard, autosaveWouldSave, backupIni, buildScan, dedicatedGpu,
  defaultIniPath, graphicsPlan, gpuPreferencePlan, loadGuard, memoryReport, planFree, primeHardwareScan,
  readGraphics, runOffloadJobs, type HwIo, type OpenDoc,
} from "../fmc/hw.js";
import { probeDirectMl, type GpuRunner } from "../fmc/hwgpu.js";

export const FMC_HW_DESCRIPTION =
  "Formcraft hardware and memory. One tool. The GPU cannot replace system RAM, and the Revit API runs on the CPU. " +
  "Video memory is for views. The model database, regeneration and transactions stay on the CPU and in RAM. " +
  "actions: scan (GPUs, RAM, page file, disks, CPU, the Revit process, which GPU Revit is on, hardware acceleration; cached at startup and shown on /health hw), " +
  "gpu_prefer (Windows high-performance GPU for Revit.exe; dry_run true unless you pass false; confirm:true to apply; next Revit start; never writes Revit.ini), " +
  "memory (per-document estimate, working-set trend, open views, links, images, undo when known, and the soft or hard pause), " +
  "free (close non-active, non-pinned views beyond keep, drop plugin image buffers; a save only when the existing autosave would save; dry_run true by default), " +
  "advice (a short list, each with the effect you should expect), " +
  "offload (report graphics settings and recommend hardware acceleration, the dedicated GPU, GPU anti-aliasing and optimize-view-navigation; " +
  "apply those ini keys only with confirm:true, effective at the next Revit start; run point, clash and ray/voxel samples on the CPU, " +
  "or on an optional GPU library when it matches the CPU). " +
  "Soft pause (FMC-MEMORY-SOFT) keeps reads and small writes and queues heavy writes, Dynamo and scripts. " +
  "Hard pause (FMC-MEMORY-HARD) waits on every model-changing call. Reads still run. Thresholds are the existing ram_pause_free_mb and its 1.5× resume line. " +
  "The token is never printed.";

export const FMC_HW_SHAPE = {
  action: z.enum(["scan", "gpu_prefer", "memory", "free", "advice", "offload"]).describe("What to do."),
  dry_run: z.boolean().optional().default(true).describe("For gpu_prefer, free and offload. True returns the plan and changes nothing."),
  confirm: z.boolean().optional().default(false).describe("Required with dry_run false before gpu_prefer or offload writes anything."),
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
  keep?: number;
  purge_undo?: boolean;
  points?: number[][];
  boxes?: number[][];
  rays?: Array<{ origin: number[]; direction: number[] }>;
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

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
      backupIni(file);
      fs.writeFileSync(file, text, "utf8");
    },
    revit: (action, body) => withRevitConnection((client) => client.sendRaw("fmc_hw", { action, ...body }, 120000)),
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
      const body = await gpuPreferencePlan(scan, full, { dry_run: args.dry_run !== false, confirm: args.confirm === true });
      const refused = body.refused === true;
      return reply({ tool: "fmc_hw", ...body, honesty: HONESTY }, refused);
    }
    if (args.action === "memory") {
      // Tool Research (fmc_hw): at 975 MB free the read took 37 s and the next two timed out. Free RAM and the pause
      // come from the server's own gate at once; Revit's per-document figures are added only if they arrive within
      // the budget, and are not asked for at all in the hard tier.
      const view = memoryGate.view();
      const budget = full.memoryBudgetMs ?? Number(process.env.FMC_HW_MEMORY_BUDGET_MS ?? 3000);
      let docs: OpenDoc[] = [];
      let addin: string | null = null;
      let stale = false;
      if (full.revit && (view.paused || view.tier === "hard")) {
        stale = true;
        addin = `Not asked: ${view.free_mb} MB free is in the hard tier, so Revit was spared a call. Per-document estimates are left out.`;
      } else if (full.revit) {
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), Math.max(0, budget)); });
        try {
          const raw = await Promise.race([full.revit("memory", {}), late]);
          if (raw === "late") {
            stale = true;
            addin = `Revit did not answer within ${Math.round(budget / 100) / 10} s: these are the server's own figures (free RAM, pause). Per-document estimates are left out.`;
          } else {
            const docsRaw = (raw as { documents?: OpenDoc[] })?.documents;
            docs = Array.isArray(docsRaw) ? docsRaw : [];
          }
        } catch (error) {
          addin = error instanceof Error ? error.message : String(error);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      const state = view.paused ? "paused" : view.tier;
      return reply({ tool: "fmc_hw", action: "memory", ...memoryReport(view, docs), state, stale, addin });
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
      const result = full.revit ? await full.revit("free", { dry_run: false, memory_pause: pause, keep: args.keep ?? 2, close: plan.close, saves: plan.saves }) : null;
      return reply({ tool: "fmc_hw", action: "free", dry_run: false, applied: true, memory: view, plan, result, honesty: HONESTY });
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
      revit: (action, body) => withRevitConnection((client) => client.sendRaw("fmc_hw", { action, ...body }, 120000)),
      savedAt: () => null,
    }).catch(() => { /* a missed free must not take down the server */ });
  });
}

hookAutoFree();

export async function warmHardwareCache(): Promise<void> {
  await primeHardwareScan().catch(() => undefined);
}
