import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, configPath, expandEnv, loadConfig } from "../fmc/policy.js";
import {
  DEFAULT_ID_CAP, filterRows, hasFilter, historyFile, isReviewPath, readHistory, snapshotOf, ticketDrafts, trend, triage, warningKey, warningsCsv, writeHistory,
  type Filter, type WarningRow,
} from "../fmc/warnings.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_WARNINGS_DESCRIPTION =
  "Formcraft, read-only: Revit's warnings of ONE named model, triaged and trended. document is required. Rows come from " +
  "Document.GetWarnings (no transaction; nothing is changed or deleted) with the failure definition id (GUID), severity, and the " +
  "level, workset and owner of the elements (owner = who has the element checked out; include_creator adds who made it). " +
  "Returns groups by failure id, level, workset and owner (a warning counts once per distinct value). Every group has a warning " +
  "count, failing_count and additional_count, and failing_ids and additional_ids capped at ids_per_group (default 20). " +
  "Also advice, and a trend against the PREVIOUS snapshot of the same model: total change, new and resolved warnings, and the " +
  "change per failure id, level, workset and owner. Filters failure_id, level, workset, owner, severity narrow the triage " +
  "(a filtered run is never saved or compared). top = groups per list (default 15). " +
  "Writes only small local files, never into the model and never to a review register or the network: the snapshot goes to " +
  "<project_folder>\\06_QA\\Warnings where the guard allows it, else <reports_dir>\\Warnings (save_snapshot false skips it). " +
  "csv true also writes a long-format CSV (one row per warning and element, for Power BI to import) to the project folder's " +
  "06_QA\\Warnings only, and only where the guard allows it. ticket_drafts true returns review-ticket drafts for the biggest " +
  "failure groups as text for a person to confirm; it never raises a ticket and never touches the review folder. " +
  "A read that fails or returns nothing readable is an error, never 'no warnings'. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, project_folder D:\\Projects\\F26901, top 10, ticket_drafts true.";

export const FMC_WARNINGS_SHAPE = {
  document: z.string().min(1).describe("The model's title or full path. Required."),
  project_folder: z.string().optional().default("").describe("The project folder, for the snapshot and CSV in 06_QA\\Warnings where the guard allows"),
  top: z.number().int().min(1).max(100).optional().default(15),
  ids_per_group: z.number().int().min(0).max(200).optional().default(DEFAULT_ID_CAP),
  failure_id: z.string().optional(),
  level: z.string().optional(),
  workset: z.string().optional(),
  owner: z.string().optional(),
  severity: z.string().optional(),
  include_creator: z.boolean().optional().default(false),
  trend: z.boolean().optional().default(true),
  save_snapshot: z.boolean().optional().default(true),
  csv: z.boolean().optional().default(false),
  ticket_drafts: z.boolean().optional().default(false),
  ticket_top: z.number().int().min(1).max(20).optional().default(5),
  max_rows: z.number().int().min(1).max(50000).optional().default(10000),
};

export type FmcWarningsArgs = z.infer<z.ZodObject<typeof FMC_WARNINGS_SHAPE>>;

export interface WarningsIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  now?: () => Date;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-WARNINGS";
  return reply({ tool: "fmc_warnings", read_only: true, model_changed: false, refused: true, code, message }, true);
}

function rowsOf(raw: unknown): { rows: WarningRow[]; body: Record<string, unknown> } {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  if (!body || !Array.isArray(body.warnings)) throw new Error("[FMC-WARNINGS-BAD-REPLY] Revit's reply had no warnings list. That is an error, not 'no warnings'.");
  const rows: WarningRow[] = body.warnings.map((w, i) => {
    const r = w as Record<string, unknown>;
    if (!r || typeof r !== "object") throw new Error(`[FMC-WARNINGS-BAD-REPLY] warning ${i} is not an object.`);
    return {
      failure_id: String(r.failure_id ?? "unknown"), severity: String(r.severity ?? "Warning"), description: String(r.description ?? ""),
      element_count: typeof r.element_count === "number" ? r.element_count : undefined,
      elements: Array.isArray(r.elements) ? r.elements as WarningRow["elements"] : [],
    };
  });
  if (typeof body.total === "number" && body.truncated !== true && body.total !== rows.length)
    throw new Error(`[FMC-WARNINGS-BAD-REPLY] Revit says ${body.total} warnings but sent ${rows.length}, and did not say it was cut short.`);
  return { rows, body };
}

/** <project>\06_QA\Warnings if the guard allows a write there (and it is not a review folder), else why not. */
function projectDir(project: string, config: GuardConfig): { dir?: string; why?: string } {
  const p = project.trim();
  if (!p) return { why: "no project_folder was given" };
  const dir = win.join(p, "06_QA", "Warnings");
  if (isReviewPath(dir)) return { why: "that is a review folder" };
  const verdict = checkWritePath(win.join(dir, "FMC_Warnings_probe.json"), config, { checkName: false });
  return verdict.ok ? { dir } : { why: verdict.reasons.join("; ") };
}

export async function runFmcWarnings(args: FmcWarningsArgs, io: WarningsIo = {}) {
  const env = io.env ?? process.env;
  try {
    const document = (args.document ?? "").trim();
    if (!document) return reply({ tool: "fmc_warnings", read_only: true, model_changed: false, refused: true, code: "FMC-DOC-REQUIRED", message: "document is required: name the model (title or full path)." }, true);
    const config = io.guard ?? loadConfig(configPath(env)).config;
    const readBody = { document, max_rows: args.max_rows, include_creator: args.include_creator };
    const raw = io.read ? await io.read(readBody) : await withRevitConnection((client) => client.sendCommand("fmc_warnings", readBody, 240000));
    const { rows: all, body } = rowsOf(raw);
    const filter: Filter = { failure_id: args.failure_id, level: args.level, workset: args.workset, owner: args.owner, severity: args.severity };
    const filtered = hasFilter(filter);
    const rows = filtered ? filterRows(all, filter) : all;
    const title = String(body.title ?? document);
    const docPath = String(body.path ?? "");
    const at = (io.now ? io.now() : new Date()).toISOString();
    const problems: string[] = [];
    const truncated = body.truncated === true;
    if (truncated) problems.push(`Revit holds ${String(body.total)} warnings; only the first ${all.length} rows were read (max_rows ${args.max_rows}). The counts are of those rows.`);
    const rp = body.read_problems as Record<string, unknown> | undefined;
    if (rp && (Number(rp.elements_unread) > 0 || Number(rp.failure_id_missing) > 0))
      problems.push(`Some details could not be read: ${Number(rp.elements_unread) || 0} element(s) unread, ${Number(rp.failure_id_missing) || 0} warning(s) without a failure id.`);
    const whole = !filtered && !truncated;

    // where the files go: the project's 06_QA\Warnings if the guard allows, else the reports folder (snapshots only)
    const project = projectDir(args.project_folder, config);
    const snapDir = project.dir ?? win.join(expandEnv(config.reports_dir, env), "Warnings");
    let trendBody: unknown;
    let snapshotFile = "";
    let saved = false;
    if (args.trend || args.save_snapshot) {
      const file = historyFile(snapDir, title, docPath);
      const prior = readHistory(file);
      if (prior.problem) problems.push(prior.problem);
      const snap = snapshotOf(rows, at);
      const keys = rows.map(warningKey);
      if (args.trend && whole) trendBody = trend(prior.history, snap, keys, { top: args.top });
      else if (args.trend) trendBody = { has_previous: false, total_after: rows.length, series: [], advice: [filtered ? "A filtered run is not compared or saved: the trend is of the whole model." : "A cut-short read is not compared or saved."] };
      if (args.save_snapshot && whole) {
        try { writeHistory(file, title, prior.history, snap, keys); saved = true; snapshotFile = file; }
        catch (e) { problems.push(`The snapshot could not be saved: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    if (args.project_folder.trim() && !project.dir && (args.save_snapshot || args.csv)) problems.push(`Not written to the project folder: ${project.why}. Snapshots use the reports folder; the CSV is skipped.`);

    let csv: Record<string, unknown> | undefined;
    if (args.csv) {
      if (!project.dir) csv = { written: false, reason: `CSV goes to the project folder only: ${project.why}` };
      else {
        try {
          const name = `FMC_Warnings_${title.replace(/\.rvt$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60)}_${at.slice(0, 10)}.csv`;
          const file = win.join(project.dir, name);
          if (isReviewPath(file)) throw new Error("that is a review folder");
          fs.mkdirSync(project.dir, { recursive: true });
          fs.writeFileSync(file, "\uFEFF" + warningsCsv(rows, title, at));
          csv = { written: true, file, rows: rows.reduce((n, r) => n + Math.max(1, r.elements.length), 0), note: "Local file only. Import it in Power BI Desktop (Get data > Text/CSV); nothing is sent anywhere." };
        } catch (e) { csv = { written: false, reason: e instanceof Error ? e.message : String(e) }; }
      }
    }

    const t = triage(rows, { top: args.top, id_cap: args.ids_per_group });
    return reply({
      tool: "fmc_warnings", read_only: true, model_changed: false, deleted_warnings: 0,
      document: title, is_workshared: body.is_workshared === true, revit_total: typeof body.total === "number" ? body.total : all.length,
      filtered, filter: filtered ? filter : undefined, problems,
      triage: t, trend: trendBody, snapshot: saved ? snapshotFile : undefined, csv,
      ticket_drafts: args.ticket_drafts ? ticketDrafts(t, title, args.ticket_top) : undefined,
      ticket_note: args.ticket_drafts ? "Drafts only: nothing was raised and no review register was written. A person confirms the lead and owner, then raises each with fmc_review." : undefined,
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcWarningsTool(server: McpServer) {
  server.tool("fmc_warnings", FMC_WARNINGS_DESCRIPTION, FMC_WARNINGS_SHAPE, async (args) => runFmcWarnings(args as FmcWarningsArgs));
}