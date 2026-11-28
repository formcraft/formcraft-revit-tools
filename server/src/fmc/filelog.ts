/**
 * F10: the one writer of FMC_MCP_FileLog.csv. Before this, 35 tool files each carried a copy of the same log()
 * with `catch {}`, and none wrote who started the call, so the pane's Log window could not filter Pane or AI rows.
 *
 * - The first six columns are unchanged, so old files and old readers still work; `source` is a seventh column.
 *   A file that already has the six-column header gets seven-field rows; the Log window reads the extra field as
 *   the source (LogReader).
 * - `source`: "Pane" when the pane's node process set FMC_CALLER=pane (plugin/Fmc/ServerCli.cs), else the MCP
 *   client's name from initialize (fmc/caller.ts), else "Unknown". It is a label, not proof of origin: any process
 *   can set the variable.
 * - A row that cannot be written is never silent: the warning is returned, kept as lastFileLogWarning(), and
 *   written to stderr once per process (the MCP server's log). The tool's own work still goes on.
 * - No rotation here: the size cap and how readers follow a rotated file are a decision not taken yet.
 */
import fs from "node:fs";
import path from "node:path";
import { csvLine, expandEnv, type GuardConfig } from "./policy.js";
import { currentCaller } from "./caller.js";

export const FILE_LOG_NAME = "FMC_MCP_FileLog.csv";
export const FILE_LOG_HEADER = ["timestamp", "action", "dry_run", "target", "result", "detail", "source"];

const join = process.platform === "win32" ? path.win32.join : path.join;

let lastWarning: string | null = null;
let warned = false;

/** Who started this call, for the source column. */
export function logSource(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_CALLER ?? "").trim().toLowerCase() === "pane") return "Pane";
  const client = currentCaller().client.trim();
  return client && client !== "unknown" ? client.slice(0, 60) : "Unknown";
}

/** The file the rows go to for this guard config. */
export function fileLogPath(cfg: Pick<GuardConfig, "reports_dir">): string {
  return join(expandEnv(cfg.reports_dir), FILE_LOG_NAME);
}

/** The last write failure in this process, or null when the last row was written. */
export function lastFileLogWarning(): string | null {
  return lastWarning;
}

/** For tests: forget the last warning and allow the stderr line again. */
export function resetFileLogWarning(): void {
  lastWarning = null;
  warned = false;
}

/** Appends one row. Returns null when written, else the warning (never throws). */
export function writeFileLog(
  cfg: Pick<GuardConfig, "reports_dir">, action: string, dryRun: boolean, target: string, result: string, detail: string,
  now: Date = new Date(), env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    const file = fileLogPath(cfg);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(FILE_LOG_HEADER));
    fs.appendFileSync(file, csvLine([now.toISOString(), action, dryRun, target, result, detail, logSource(env)]));
    lastWarning = null;
    return null;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    lastWarning = `The file log row for ${action} was not written (${why}); the work itself was not affected.`;
    if (!warned) {
      warned = true;
      console.error(`[fmc] ${lastWarning}`);
    }
    return lastWarning;
  }
}
