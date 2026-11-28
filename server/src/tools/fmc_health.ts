import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { healthReport, type HealthReport } from "../fmc/httpservice.js";
import { healthView } from "../fmc/healthview.js";

const started = Date.now();

export const FMC_HEALTH_DESCRIPTION =
  "Formcraft health, read-only. The server build this process is running, the add-in build each open Revit announced, " +
  "whether each announced port accepts a connection, the open documents of each Revit (title and path), and when a Revit job is still heartbeating (waiting_for_idle, " +
  "with the job, its age and any blocking dialog, named by dialog id when the add-in or the job log has one) instead of calling that port dead. Also any tool module that failed to register, and the batch line " +
  "(holder, queue, history, struggling batches, per-bot stats), free memory, per-document sync, and background script jobs " +
  "(jobs.queued, jobs.running, jobs.last_finished). Nothing is changed. " +
  "ok is false when a warning is an error: a Revit not answering or held by a dialog, a hard memory pause, a sync error on an open document, " +
  "or a module that failed to register (server_ok covers registration alone). warnings[] says which. build_match is false when the server and the add-in were built from different commits. " +
  "summary:true returns only ok, warnings, builds, instances, memory, queue and open-document syncs (use it for a quick check; the full report is about 40 KB). " +
  "document narrows instances and syncs to that model. The sync list is shown once (open documents by default; closed ones are summarised as syncs_not_open). " +
  "A sync error for a document that is not open now is shown as stale_error, not a warning. Managed sync off is a warning. An empty hardware block is status partial, not ready.";

export const FMC_HEALTH_SHAPE = {
  summary: z.boolean().optional().default(false).describe("Short reply: ok, warnings, builds, instances, memory, queue, open-document syncs."),
  document: z.string().optional().default("").describe("Title or path of an open document: only its Revit and sync rows."),
};

export interface FmcHealthArgs { summary?: boolean; document?: string }

/** Same facts as HTTP GET /health, plus warnings. Does not send a model command. */
export async function runFmcHealth(args: FmcHealthArgs = {}, report?: () => Promise<HealthReport>) {
  const raw = report ? await report() : await healthReport("revit-bridge", started, process.env, { light: args.summary === true });
  const body = healthView(raw, { summary: args.summary === true, document: args.document ?? "" });
  // isError only when the server itself is broken (a module failed to register); a busy Revit is a warning, not a tool error.
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, args.summary ? 0 : 2) }], isError: body.server_ok !== true };
}

export function registerFmcHealthTool(server: McpServer) {
  server.tool("fmc_health", FMC_HEALTH_DESCRIPTION, FMC_HEALTH_SHAPE, (args) => runFmcHealth(args as FmcHealthArgs));
}
