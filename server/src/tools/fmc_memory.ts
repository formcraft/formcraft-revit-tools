import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { memoryGate } from "../fmc/memory.js";
import { readInstances } from "../fmc/connect.js";
import { MEMORY_PAUSE_MB, MEMORY_RESUME_MB, planFree, planPurge, type MemoryDoc } from "../fmc/memoryplan.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_MEMORY_DESCRIPTION =
  "Memory guard. status: free MB, the Revit working set, and open documents including family documents. " +
  "The pause stays at 1024 MB and the resume line at 1536 MB. " +
  "free: close unmodified family documents and unmodified non-active non-workshared documents, then GC.Collect. " +
  "The last document and any never-saved document (no file, e.g. Project1) stay open. Revit 2025 cannot clear the undo stack from the API. " +
  "purge_unused {document, categories, only_categories}: PerformanceAdviser rules whose name contains unused or purge; categories are kept, only_categories limits the delete. " +
  "dry_run defaults to true. free and purge_unused with dry_run false need batch_lease. " +
  "The reply includes MB before and after. Revit calls stay on the API thread. " +
  "Example: {\"action\":\"free\",\"dry_run\":true}.";

const shape = {
  action: z.enum(["status", "free", "purge_unused"]),
  document: z.string().optional().default("").describe("purge_unused: exact title or full path"),
  categories: z.array(z.string()).optional().default([]).describe("purge_unused: category names to keep (never deleted). Empty keeps none."),
  only_categories: z.array(z.string()).optional().describe("purge_unused: when set, only these categories may be deleted. Empty or omitted means every category the rules name."),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
};

export type FmcMemoryArgs = z.infer<z.ZodObject<typeof shape>>;

export interface MemoryIo {
  status?: () => Promise<{ free_mb?: number; revit_working_set_mb?: number | null; documents?: MemoryDoc[] }>;
  apply?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  env?: NodeJS.ProcessEnv;
}

function fromInstances(env: NodeJS.ProcessEnv): MemoryDoc[] {
  const docs: MemoryDoc[] = [];
  for (const instance of readInstances(env)) {
    for (const doc of instance.documents ?? []) {
      docs.push({
        title: doc.title ?? "",
        path: doc.path ?? "",
        family: doc.family === true,
        workshared: doc.workshared === true,
        active: doc.active === true,
      });
    }
  }
  return docs;
}

async function statusOf(io: MemoryIo): Promise<{ free_mb: number; revit_working_set_mb: number | null; documents: MemoryDoc[] }> {
  const view = memoryGate.view();
  if (io.status) {
    const extra = await io.status();
    return {
      free_mb: extra.free_mb ?? view.free_mb,
      revit_working_set_mb: extra.revit_working_set_mb ?? view.revit_working_set_mb,
      documents: extra.documents ?? [],
    };
  }
  let documents = fromInstances(io.env ?? process.env);
  let working = view.revit_working_set_mb;
  try {
    const live = await withRevitConnection((client) => client.sendRaw("fmc_memory", { action: "status" }, 60000)) as {
      revit_working_set_mb?: number; documents?: MemoryDoc[];
    };
    if (Array.isArray(live?.documents) && live.documents.length) documents = live.documents;
    if (typeof live?.revit_working_set_mb === "number") working = live.revit_working_set_mb;
  } catch { /* the server sample still answers */ }
  return { free_mb: view.free_mb, revit_working_set_mb: working, documents };
}

export async function runFmcMemory(args: FmcMemoryArgs, io: MemoryIo = {}) {
  const before = await statusOf(io);
  const thresholds = { pause_below_mb: MEMORY_PAUSE_MB, resume_above_mb: MEMORY_RESUME_MB };
  if (args.action === "status") {
    return reply({
      tool: "fmc_memory", action: "status", read_only: true, ...thresholds,
      free_mb: before.free_mb, revit_working_set_mb: before.revit_working_set_mb,
      documents: before.documents, mb_before: before.free_mb,
    });
  }
  if (args.action === "free") {
    const plan = planFree(before.documents, args.dry_run !== false);
    if (args.dry_run !== false) {
      return reply({ tool: "fmc_memory", action: "free", ...plan, ...thresholds, mb_before: before.free_mb, mb_after: before.free_mb, read_only: true });
    }
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return reply({ tool: "fmc_memory", refused: true, code: "FMC-BATCH-LOCKED", message: "[FMC-BATCH-LOCKED] free needs batch_lease. Nothing was closed.", dry_run: true }, true);
    // An empty close list means "no filter" to an older add-in: never send it.
    if (!plan.close.length) {
      return reply({ tool: "fmc_memory", action: "free", dry_run: false, ...thresholds, mb_before: before.free_mb, mb_after: before.free_mb, plan, result: { closed: [], note: "Nothing to close. The add-in was not called." } });
    }
    const applied = io.apply
      ? await io.apply({ action: "free", close: plan.close.map((doc) => doc.path || doc.title) })
      : await withRevitConnection((client) => client.sendCommand("fmc_memory_apply", { action: "free", close: plan.close.map((doc) => doc.path || doc.title) }, 180000)) as Record<string, unknown>;
    const after = await statusOf(io);
    return reply({
      tool: "fmc_memory", action: "free", dry_run: false, ...thresholds,
      mb_before: before.free_mb, mb_after: after.free_mb,
      revit_working_set_mb_before: before.revit_working_set_mb, revit_working_set_mb_after: after.revit_working_set_mb,
      plan, result: applied,
    });
  }
  const purge = planPurge(args.document, args.categories, args.dry_run !== false, args.only_categories ?? []);
  if (!purge.document) return reply({ tool: "fmc_memory", refused: true, reasons: ["purge_unused needs document."] }, true);
  if (args.dry_run !== false) {
    return reply({ tool: "fmc_memory", action: "purge_unused", ...purge, ...thresholds, mb_before: before.free_mb, mb_after: before.free_mb, read_only: true });
  }
  const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
  if (!lease) return reply({ tool: "fmc_memory", refused: true, code: "FMC-BATCH-LOCKED", message: "[FMC-BATCH-LOCKED] purge_unused needs batch_lease. Nothing was deleted.", dry_run: true }, true);
  // purge_unused_v2: an older add-in does not know it and answers with status, so it can never delete the kept categories.
  const body = { action: "purge_unused_v2", document: purge.document, keep_categories: purge.keep_categories, only_categories: purge.only_categories };
  const applied = io.apply
    ? await io.apply(body)
    : await withRevitConnection((client) => client.sendCommand("fmc_memory_apply", body, 300000)) as Record<string, unknown>;
  const after = await statusOf(io);
  const known = typeof applied?.purged === "number";
  return reply({
    tool: "fmc_memory", action: "purge_unused", dry_run: false, ...thresholds,
    mb_before: before.free_mb, mb_after: after.free_mb, plan: purge, result: applied,
    ...(known ? {} : { refused: true, code: "FMC-MEMORY-ADDIN", message: "The add-in does not know purge_unused_v2 (an older build). Nothing was deleted." }),
  }, !known);
}

export function registerFmcMemoryTool(server: McpServer) {
  server.tool("fmc_memory", FMC_MEMORY_DESCRIPTION, shape, (args) => runFmcMemory(args));
}
