import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { checkWritePath, configPath, expandEnv, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { readXlsxSheets, writeXlsx } from "../fmc/xlsx.js";
import {
  applyList, asRead, diffEdits, editsFromCsv, editsFromTable, fieldEditable, projectRootOf, safeFileName, tableOf, toCsv, type EditRow,
} from "../fmc/schedule_data.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_SCHEDULE_DATA_DESCRIPTION =
  "Formcraft schedule data (GAP-06). read (read-only): a schedule's fields (with whether each can be written and why " +
  "not) and its rows by element id. export: the schedule as .csv or .xlsx (ElementId first, then each field) in the " +
  "project folder, default <project>\\01_WIP\\_Schedules; a dry run unless dry_run is false. diff (read-only): an edited " +
  "export (file) or edits [{id, values}] against the schedule now: the cell diff, and the cells refused. apply: the same " +
  "diff written back in one transaction. Only marks, comments and key-schedule values are written; calculated, formula, " +
  "percentage, count, combined and read-only fields are refused, and so are elements another user owns. dry_run " +
  "defaults to true and returns the diff; a real apply needs dry_run=false, a batch_lease, and no refused cells (or " +
  "skip_refused=true).";

export const FMC_SCHEDULE_DATA_SHAPE = {
  action: z.enum(["read", "export", "diff", "apply"]),
  document: z.string().optional().default("").describe("The document title or path (required)"),
  schedule: z.string().optional().default("").describe("The schedule's name or element id"),
  format: z.enum(["csv", "xlsx"]).optional().default("xlsx").describe("export"),
  out_folder: z.string().optional().default("").describe("export: a folder inside the project folder (default 01_WIP\\_Schedules)"),
  hidden: z.boolean().optional().default(false).describe("export: include hidden fields"),
  file: z.string().optional().default("").describe("diff, apply: the edited .csv or .xlsx (full path)"),
  edits: z.array(z.object({ id: z.union([z.string(), z.number()]).transform(String), values: z.record(z.string()) })).optional().default([]),
  skip_refused: z.boolean().optional().default(false).describe("apply: write the allowed cells even when some are refused"),
  limit: z.number().int().positive().max(50000).optional().default(10000),
  detail: z.enum(["summary", "full"]).optional().default("summary"),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
};

export type FmcScheduleDataArgs = z.infer<z.ZodObject<typeof FMC_SCHEDULE_DATA_SHAPE>>;

export interface ScheduleDataIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  /** file writes, for tests */
  writeFile?: (file: string, data: Buffer | string) => void;
}

const base = { tool: "fmc_schedule_data" };
const refused = (code: string, message: string, extra: object = {}) => reply({ ...base, refused: true, code, message, ...extra }, true);
const cap = <T>(list: T[], full: boolean, n = 50) => (full ? list : list.slice(0, n));

function readEdits(args: FmcScheduleDataArgs): { rows: EditRow[]; problems: string[] } {
  if (args.edits.length) return { rows: args.edits.map((e) => ({ id: String(e.id), values: e.values })), problems: [] };
  const file = expandEnv(args.file.trim());
  if (!file) return { rows: [], problems: ["diff and apply need file (an edited export) or edits"] };
  if (!fs.existsSync(file)) return { rows: [], problems: [`No file at ${file}`] };
  if (/\.csv$/i.test(file)) return editsFromCsv(fs.readFileSync(file, "utf8"));
  if (/\.xlsx$/i.test(file)) {
    const sheets = readXlsxSheets(fs.readFileSync(file));
    const first = [...sheets.values()][0] ?? [];
    return editsFromTable(first.map((r) => r.map((c) => String(c ?? ""))));
  }
  return { rows: [], problems: [`${file} isn't a .csv or .xlsx`] };
}

export async function runFmcScheduleData(args: FmcScheduleDataArgs, io: ScheduleDataIo = {}) {
  const env = io.env ?? process.env;
  try {
    const document = args.document.trim();
    if (!document) return refused("FMC-DOC-REQUIRED", "fmc_schedule_data needs document (a title or full path).");
    if (!args.schedule.trim()) return refused("FMC-SCHEDULE-REQUIRED", "Name the schedule (its name or element id).");
    const body = { document, schedule: args.schedule.trim(), limit: args.limit };
    const raw = (io.read ? await io.read(body) : await withRevitConnection((c) => c.sendRaw("fmc_schedule_data_read", body, 180000))) as Record<string, unknown>;
    const read = asRead(raw);
    if (!read) return refused("FMC-SCHEDULE-READ", String(raw?.message ?? "The schedule could not be read."));
    const full = args.detail === "full";
    const fields = read.fields.map((f) => ({ ...f, writable: fieldEditable(f, read.is_key).ok, why_not: fieldEditable(f, read.is_key).reason }));
    const head = { ...base, document: raw.title ?? document, schedule: read.schedule, schedule_id: read.schedule_id, is_key: read.is_key, rows_count: read.rows.length, truncated: raw.truncated === true };

    if (args.action === "read")
      return reply({ ...head, action: "read", read_only: true, fields, rows: cap(read.rows, full), ...(full ? {} : { rows_shown: Math.min(50, read.rows.length) }) });

    const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
    const docPath = String(raw.path ?? "");

    if (args.action === "export") {
      const root = projectRootOf(docPath);
      const folder = args.out_folder.trim() ? expandEnv(args.out_folder.trim()) : root ? win.join(root, "01_WIP", "_Schedules") : "";
      if (!root) return refused("FMC-SCHEDULE-NO-PROJECT", `The document isn't saved in a project folder (…\\01_WIP\\…): ${docPath || "(not saved)"}`);
      if (!win.normalize(folder).toLowerCase().startsWith(win.normalize(root).toLowerCase() + "\\"))
        return refused("FMC-SCHEDULE-OUTSIDE", `out_folder must be inside the project folder ${root}`);
      const file = win.join(folder, `${safeFileName(read.schedule)}.${args.format}`);
      const verdict = checkWritePath(file, loaded.config, { checkName: false });
      const table = tableOf(read, { hidden: args.hidden });
      const plan = { file, format: args.format, rows: table.length - 1, columns: table[0].length, exists: fs.existsSync(file) };
      if (!verdict.ok) return refused("FMC-SCHEDULE-GUARD", verdict.reasons.join(" | "), { plan });
      if (args.dry_run !== false) return reply({ ...head, action: "export", dry_run: true, plan, next: "Run again with dry_run=false to write the file" });
      const write = io.writeFile ?? ((f: string, d: Buffer | string) => { fs.mkdirSync(win.dirname(f), { recursive: true }); fs.writeFileSync(f, d); });
      const data = args.format === "csv" ? toCsv(table) : writeXlsx([{ name: safeFileName(read.schedule).slice(0, 31), rows: table, header: true }]);
      write(file, data);
      return reply({ ...head, action: "export", dry_run: false, written: plan, next: "Edit marks, comments or key values, keep ElementId, then fmc_schedule_data diff file=<this file>" });
    }

    // diff and apply
    const edits = readEdits(args);
    if (edits.problems.length && !edits.rows.length) return refused("FMC-SCHEDULE-EDITS", edits.problems.join(" | "));
    const diff = diffEdits(read, edits.rows);
    const problems = [...edits.problems, ...diff.problems];
    const summary = { ...head, action: args.action, changes_count: diff.changes.length, refused_count: diff.refused.length,
      changes: cap(diff.changes, full, 200), refused: cap(diff.refused, full, 200), unknown_ids: diff.unknown_ids, unknown_fields: diff.unknown_fields, problems };
    if (args.action === "diff") return reply({ ...summary, read_only: true });
    if (problems.length) return reply({ ...summary, refused: true, code: "FMC-SCHEDULE-PROBLEMS", dry_run: args.dry_run !== false }, true);
    if (diff.refused.length && !args.skip_refused)
      return reply({ ...summary, refused: true, code: "FMC-SCHEDULE-REFUSED-CELLS", message: "Some edited cells can't be written (see refused). Fix them, or set skip_refused=true to write only the rest.", dry_run: args.dry_run !== false }, true);
    if (args.dry_run !== false) return reply({ ...summary, dry_run: true, read_only: true, next: "Nothing was written. Run apply with dry_run=false and a batch_lease." });
    const doc = { title: String(raw.title ?? document), path: docPath };
    const blocked = saveBlocked(doc, loaded.config) || loaded.problem;
    if (blocked) return refused("FMC-SCHEDULE-GUARD", blocked, summary);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return refused("FMC-BATCH-LOCKED", "A real apply needs a batch_lease.", summary);
    const changes = applyList(diff.changes);
    if (!changes.length) return reply({ ...summary, dry_run: false, applied: { written: 0 }, next: "Nothing changed." });
    const applyBody = { document, schedule_id: read.schedule_id, changes, batch_lease: lease };
    const applied = io.apply ? await io.apply(applyBody) : await withRevitConnection((c) => c.sendCommand("fmc_schedule_data_apply", applyBody, 300000));
    return reply({ ...summary, dry_run: false, read_only: false, applied });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refused(message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-SCHEDULE", message);
  }
}

export function registerFmcScheduleDataTool(server: McpServer) {
  server.tool("fmc_schedule_data", FMC_SCHEDULE_DATA_DESCRIPTION, FMC_SCHEDULE_DATA_SHAPE, async (args) => runFmcScheduleData(args as FmcScheduleDataArgs));
}
