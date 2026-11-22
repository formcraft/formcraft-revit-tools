import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { currentClient } from "../fmc/fairqueue.js";
import { BatchGateError, batchBoard } from "../fmc/batchline.js";
import { MAINTENANCE_REASON } from "../fmc/batchstore.js";

export const FMC_BATCH_DESCRIPTION =
  "The line for model-changing batches on one document. Several discipline bots share one Revit. request a lease, " +
  "wait until it is granted, then send that document's writes with batch_lease. heartbeat if you are not writing. " +
  "release with outcome ok or failed. A failure is not parked: the next request for the same label joins the tail, " +
  "with correction set to what you changed and different references. More than three attempts is marked struggling, " +
  "which only shows in fmc_queue. Reads never need a lease. " +
  "references is required: at least one id for the kit, the standards bank, and the rulebooks. " +
  "Actions: request, status, heartbeat, release, cancel, wait (timeout_s at most 60), drain, resume. " +
  "drain stops new grants (requests stay queued: maintenance: server update) and lets the active lease finish. " +
  "reserve puts a named bot's label at the head of a document. Only a name in batch_schedulers may do that, matched on the MCP client or the bot field. Hostel Building Bot is the scheduler. " +
  "The waiting line is saved and restored after a restart. An active lease is not still held after a restart: it is at the head of its line. " +
  "When free memory is below ram_pause_free_mb (default 1024), request stays queued and wait holds: paused for memory, not failed. " +
  "Workshared models sync from fmc_guard.json sync_minutes (default 15) and sync_on_batch_end (default true). " +
  "sync_exclude skips those documents, including the five HEBERT HOSTELS models when they are listed there. sync_documents, when set, is the only list that syncs. " +
  "A lease defers autosave and sync only for the document it holds. Other documents still save and sync. " +
  "The save and sync after release run only once that lease is dropped, and they are still recorded on that batch. " +
  "release does not take a document name. Save and sync use the lease's own document title. A name with `_USER` removed is never substituted. " +
  "When that title is not open and exactly one open document is the title plus `_USER`, the open local is used. " +
  "If that save or sync is deferred, it is retried on the next idle ticks until the sync succeeds. release reports batch_end_sync. " +
  "status shows last_save_at, next_save_at, last_sync_at, next_sync_at, last_error, excluded and defer_reason. " +
  "Autosave (auto_save_minutes, default 10) saves every open project locally, including a workshared local, and never writes the central file. " +
  "Autosave skips save_exclude, sync_exclude and protected_paths. A sync_exclude title also covers its local, so HEBERT HOSTELS covers HEBERT HOSTELS_USER. " +
  "protected_paths is a folder-prefix list autosave will not write under. " +
  "protected_roots is the same kind of prefix list and matches nothing while it is empty. " +
  "phase is optional. It is stored on the lease and fmc_phase batch_check reads it when its own phase is omitted.";

const shape = {
  action: z.enum(["request", "status", "heartbeat", "release", "cancel", "wait", "drain", "resume", "reserve"]),
  reason: z.string().max(200).optional().describe("drain: why grants are stopped. Default: maintenance: server update."),
  document: z.string().optional().describe("Title or full path of the open document this batch changes."),
  label: z.string().optional().describe("This batch's name. A retry of a failure sends the same label (and the same batch_id, if you set one)."),
  batch_id: z.string().optional().describe("Stable id for this unit of work. Defaults to label."),
  bot: z.string().optional().describe("Discipline bot name for the day's stats, for example structure. Defaults to label."),
  est_ops: z.number().int().positive().max(100000).optional().describe("How many model-changing calls you expect. Used only as an ETA hint."),
  references: z.record(z.array(z.string())).optional().describe(
    "Required on request. Ids this batch works from. Default categories: kit (family or template ids), " +
    "standards (standards-bank clauses or design values), rulebook (rule ids or keynote refs such as S.FND_01). " +
    "Each required category needs one non-empty id. A retry after a failure must change these ids."),
  correction: z.string().max(500).optional().describe("Required when retrying a failed batch: what you changed. The same references are refused."),
  lease: z.string().optional().describe("Lease id returned by request. status, heartbeat, release, cancel and wait take it."),
  outcome: z.enum(["ok", "failed"]).optional().describe("release: ok, or failed after you have undone the partial changes."),
  summary: z.string().max(500).optional().describe("Short note stored in the batch history."),
  error: z.string().max(1000).optional().describe("release failed: what went wrong. Kept in the history."),
  timeout_s: z.number().min(0).max(60).optional().describe("wait: seconds to block, at most 60. 0 returns the current status."),
  phase: z.string().optional().describe("request and reserve: the phase this batch works in. Stored on the lease for fmc_phase batch_check."),
};

function reply(body: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function failed(error: unknown) {
  if (error instanceof BatchGateError) return reply({ ok: false, code: error.code, message: error.message }, true);
  const message = error instanceof Error ? error.message : String(error);
  return reply({ ok: false, code: "FMC-BATCH-BAD", message }, true);
}

export async function runFmcBatch(args: {
  action: "request" | "status" | "heartbeat" | "release" | "cancel" | "wait" | "drain" | "resume" | "reserve";
  reason?: string;
  document?: string;
  label?: string;
  batch_id?: string;
  bot?: string;
  est_ops?: number;
  references?: Record<string, string[]>;
  correction?: string;
  lease?: string;
  outcome?: "ok" | "failed";
  summary?: string;
  error?: string;
  timeout_s?: number;
  phase?: string;
}, client = currentClient()) {
  const board = batchBoard();
  try {
    if (args.action === "request") {
      return reply(await board.request({
        document: args.document ?? "",
        label: args.label ?? "",
        estOps: args.est_ops,
        batchId: args.batch_id,
        bot: args.bot,
        references: args.references,
        correction: args.correction,
        phase: args.phase,
        client,
      }));
    }
    if (args.action === "reserve") {
      return reply(await board.reserve({
        document: args.document ?? "", label: args.label ?? "", bot: args.bot, client,
        references: args.references, batchId: args.batch_id, estOps: args.est_ops, correction: args.correction, phase: args.phase,
      }));
    }
    if (args.action === "drain") return reply(board.setMaintenance(true, args.reason || MAINTENANCE_REASON));
    if (args.action === "resume") return reply(board.setMaintenance(false));
    if (args.action === "status") return reply(board.status(args.lease, client));
    if (args.action === "heartbeat") {
      if (!args.lease) return reply({ ok: false, code: "FMC-BATCH-BAD", message: "[FMC-BATCH-BAD] heartbeat needs lease." }, true);
      return reply(board.heartbeat(args.lease, client));
    }
    if (args.action === "release") {
      if (!args.lease || !args.outcome) return reply({ ok: false, code: "FMC-BATCH-BAD", message: "[FMC-BATCH-BAD] release needs lease and outcome ok or failed." }, true);
      return reply(await board.releaseWithCare(args.lease, args.outcome, client, args.summary, args.error));
    }
    if (args.action === "cancel") {
      if (!args.lease) return reply({ ok: false, code: "FMC-BATCH-BAD", message: "[FMC-BATCH-BAD] cancel needs lease." }, true);
      return reply(board.cancel(args.lease, client));
    }
    if (!args.lease) return reply({ ok: false, code: "FMC-BATCH-BAD", message: "[FMC-BATCH-BAD] wait needs lease." }, true);
    return reply(await board.wait(args.lease, args.timeout_s ?? 30));
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcBatchTool(server: McpServer) {
  server.tool("fmc_batch", FMC_BATCH_DESCRIPTION, shape, (args) => runFmcBatch(args));
}
