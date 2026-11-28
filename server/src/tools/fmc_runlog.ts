/**
 * Read-only summary of a Run-FmcBatch log or a folder of result JSON files.
 */
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatRows, summarisePath } from "../fmc/runlog.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_RUNLOG_DESCRIPTION =
  "Summarise a Run-FmcBatch log. path is RUN_ALL_log.txt, a result JSON file, or a folder of those. " +
  "The reply is one line per batch: batch id, ops, ok, failed, and FMC codes. Read-only. It does not change a model and does not take a lease. " +
  "A log section (\"==== job\", Batch label on document, Preview/Apply/Verify) is one batch; an op is one item of a reply's ops array or one tool call, and skipped counts replies that changed nothing. A reply that says FMC-JOB-RUNNING is running, not ok: the line reads RUNNING, never PASS. " +
  "The same summary is scripts/Run-FmcRunlog.mjs, which sits next to Run-FmcBatch.mjs. " +
  "Example: path C:\\\\Jobs\\\\_Staging\\\\RUN_ALL_log.txt.";

export const FMC_RUNLOG_SHAPE = {
  path: z.string().describe("RUN_ALL_log.txt, a result JSON file, or a folder of either."),
};

export type FmcRunlogArgs = z.infer<z.ZodObject<typeof FMC_RUNLOG_SHAPE>>;

export function runFmcRunlog(args: FmcRunlogArgs) {
  const target = args.path.trim();
  if (!target) return reply({ tool: "fmc_runlog", refused: true, code: "FMC-RUNLOG-PATH", message: "[FMC-RUNLOG-PATH] path is required." }, true);
  const summary = summarisePath(path.resolve(target));
  const failed = summary.rows.reduce((sum, row) => sum + row.failed, 0);
  // FMC-JOB-RUNNING is not a pass: the batch has not finished
  const running = summary.rows.reduce((sum, row) => sum + (row.running ?? 0), 0);
  return reply({
    tool: "fmc_runlog",
    read_only: true,
    path: target,
    batches: summary.rows,
    errors: summary.errors,
    text: formatRows(summary.rows),
    failed,
    running,
    ...(running > 0 ? { incomplete: true, note: "FMC-JOB-RUNNING counts as running, not as a pass: check fmc_job status, then read the log again." } : {}),
  }, summary.errors.length > 0 && summary.rows.length === 0);
}

export function registerFmcRunlogTool(server: McpServer) {
  server.tool("fmc_runlog", FMC_RUNLOG_DESCRIPTION, FMC_RUNLOG_SHAPE, (args) => runFmcRunlog(args));
}
