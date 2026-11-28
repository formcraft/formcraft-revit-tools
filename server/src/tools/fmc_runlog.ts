/**
 * Read-only summary of a Run-FmcBatch log or a folder of result JSON files.
 */
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { filterRuns, formatRows, rowStatus, summarisePath } from "../fmc/runlog.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_RUNLOG_DESCRIPTION =
  "Summarise a Run-FmcBatch log. path is RUN_ALL_log.txt, a result JSON file, or a folder of those. " +
  "The reply is one line per batch: status (PASS, FAIL, RUNNING for FMC-JOB-RUNNING / FMC-BRIDGE-BUSY / FMC-REVIT-NOT-IDLE, BLOCKED for a refusal such as FMC-REGISTER-STATUS or FMC-BATCH-LOCKED, " +
  "INCOMPLETE for a call with no reply, a section with no Result log or DONE line, or an empty result), batch id, ops, ok, failed, unknown and FMC codes. " +
  "Each row has at (when it ran); since filters by it and latest_per_job keeps the newest run of each job. In a folder a log section and its result JSON count once. " +
  "Unreadable or too large files (over 20 MB) are listed in skipped_files. A missing path says Not found with failed null. Read-only. It does not change a model and does not take a lease. " +
  "A log section (\"==== job\", Batch label on document, Preview/Apply/Verify) is one batch; an op is one item of a reply's ops array or one tool call, and skipped counts replies that changed nothing. " +
  "The same summary is scripts/Run-FmcRunlog.mjs, which sits next to Run-FmcBatch.mjs. " +
  "Example: path <your jobs folder>\\RUN_ALL_log.txt (the folder Run-FmcBatch writes its log to).";

export const FMC_RUNLOG_SHAPE = {
  path: z.string().describe("RUN_ALL_log.txt, a result JSON file, or a folder of either."),
  since: z.string().optional().default("").describe("Only batches that ran at or after this (YYYY-MM-DD or YYYY-MM-DDTHH:MM, local time)"),
  latest_per_job: z.boolean().optional().default(false).describe("Keep only the newest run of each job"),
};

export type FmcRunlogArgs = z.infer<z.ZodObject<typeof FMC_RUNLOG_SHAPE>>;

export function runFmcRunlog(args: FmcRunlogArgs) {
  const target = args.path.trim();
  if (!target) return reply({ tool: "fmc_runlog", refused: true, code: "FMC-RUNLOG-PATH", message: "[FMC-RUNLOG-PATH] path is required." }, true);
  // RN-5: the call never fails whole
  try {
    const summary = summarisePath(path.resolve(target));
    // P-fmc_runlog-01: a missing path is Not found, not "No batches" with 0 failed
    if (!summary.found) return reply({ tool: "fmc_runlog", read_only: true, path: target, found: false, batches: [], errors: summary.errors, text: `Not found: ${target}`, failed: null }, true);
    const rows = filterRuns(summary.rows, { since: args.since, latest_per_job: args.latest_per_job });
    const failed = rows.reduce((sum, row) => sum + row.failed, 0);
    const byStatus: Record<string, number> = {};
    for (const row of rows) { const s = row.status ?? rowStatus(row); byStatus[s] = (byStatus[s] ?? 0) + 1; }
    return reply({
      tool: "fmc_runlog",
      read_only: true,
      path: target,
      found: true,
      batches: rows,
      by_status: byStatus,
      errors: summary.errors,
      skipped_files: summary.skipped_files,
      duplicates_dropped: summary.duplicates_dropped,
      ...(args.since || args.latest_per_job ? { filtered_out: summary.rows.length - rows.length } : {}),
      text: formatRows(rows),
      failed,
    }, summary.errors.length > 0 && rows.length === 0);
  } catch (error) {
    return reply({ tool: "fmc_runlog", read_only: true, path: target, error: error instanceof Error ? error.message : String(error), failed: null }, true);
  }
}

export function registerFmcRunlogTool(server: McpServer) {
  server.tool("fmc_runlog", FMC_RUNLOG_DESCRIPTION, FMC_RUNLOG_SHAPE, (args) => runFmcRunlog(args));
}
