import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, isInside, loadConfig } from "../fmc/policy.js";
import { kitPaths } from "../fmc/context.js";
import { parseSharedParameters } from "../fmc/specs.js";
import { readXlsxSheets, writeXlsx } from "../fmc/xlsx.js";
import {
  ABOUT_SHEET, KIT_TABLES, KitTable, TableDef, aboutSheet, blocking, changeRequestMarkdown, compareTable, diffForReply,
  diffSummary, parseKitTable, pickSheet, readAbout, resolveTable, tableSheet, writeKitTable,
} from "../fmc/tables.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_TABLES_DESCRIPTION =
  "Formcraft kit tables by script (Excel ↔ the kit's CSV and JSON in 03_Master_Data; no AI, no Revit). tables lists the " +
    "known tables and their keys. compare (read-only) compares a workbook sheet with a kit table by its key: rows added, " +
    "removed and changed, cell by cell, and problems (duplicate or empty key, a parameter that isn't a kit parameter, a " +
    "value of the wrong type). export writes a kit table to .xlsx for people to edit (in staging or a project's WIP; a " +
    "dry run unless dry_run is false). import compares an edited .xlsx (a dry run: the diff) and, with dry_run false, " +
    "writes a proposed kit file and a kit change request in staging: never over the kit's file; a person publishes. " +
    "check (read-only) compares the kit's own Excel twins (FMC_Revit_Kit.xlsx, FMC_Master_Data.xlsx) with its tables. " +
    "pending (read-only) dry-runs every exported workbook in the staging folder.";

export const FMC_TABLES_SHAPE = {
  action: z.enum(["tables", "compare", "export", "import", "check", "pending"]),
  table: z.string().optional().default("").describe("a table id (fmc_tables tables), or a file in 03_Master_Data: FMC_X.csv or FMC_X.json#section; import reads it from the workbook's About sheet when not given"),
  key: z.string().optional().default("").describe("the key column(s) for a table not in the list: \"Name\" or \"A+B\""),
  workbook: z.string().optional().default("").describe("compare, import: the .xlsx (full path)"),
  sheet: z.string().optional().default("").describe("compare, import: the sheet; default the table's own sheet or the first"),
  columns: z.record(z.string()).optional().describe("workbook header → kit column, where the names differ"),
  kit_folder: z.string().optional().default("").describe("the kit folder (holds 03_Master_Data); default from specs_path in fmc_guard.json"),
  project_folder: z.string().optional().default("").describe("export, import, pending: write in <project>\\01_WIP\\_Tables instead of the kit's _Staging\\Tables"),
  out_folder: z.string().optional().default("").describe("export, import, pending: the staging folder itself (must be a write root)"),
  keep_removed: z.boolean().optional().default(false).describe("import: rows the sheet doesn't have stay (a filtered sheet); default they are removed"),
  reason: z.string().optional().default("").describe("import: why, for the kit change request"),
  detail: z.enum(["summary", "full"]).optional().default("summary").describe("summary (default): counts and the first rows of each list; full: every row"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcTablesArgs = z.infer<z.ZodObject<typeof FMC_TABLES_SHAPE>>;

interface Where { kit: string; master: string; staging: string; sharedParams: string }

function where(cfg: GuardConfig, a: FmcTablesArgs): Where {
  const k = kitPaths(cfg, []);
  const kit = a.kit_folder.trim() ? expandEnv(a.kit_folder.trim()) : k.root;
  const master = win.join(kit, "03_Master_Data");
  const own = win.join(kit, "01_Shared_Parameters", "FMC_SharedParameters.txt");
  const staging = a.out_folder.trim() ? expandEnv(a.out_folder.trim())
    : a.project_folder.trim() ? win.join(expandEnv(a.project_folder.trim()), "01_WIP", "_Tables")
    : win.join(kit, "_Staging", "Tables");
  return { kit, master, staging, sharedParams: a.kit_folder.trim() && fs.existsSync(own) ? own : k.sharedParams };
}

/** May a table file be written here? The write folders, and never inside the kit's own tables. */
function writable(file: string, w: Where, cfg: GuardConfig): string[] {
  const reasons = [...checkWritePath(file, cfg, { checkName: false }).reasons];
  if (isInside(file, w.master)) reasons.push(`Never into the kit's 03_Master_Data: tables go to staging, and a person publishes them`);
  if (!reasons.length) return [];
  if (!cfg.write_roots.some((r) => isInside(file, r)))
    reasons.push(`Add ${win.dirname(file)} to write_roots in fmc_guard.json (the BIM Manager), or give project_folder or out_folder`);
  return reasons;
}

function readKit(def: TableDef, w: Where): { kit?: KitTable; text?: string; file: string; problem?: string } {
  const file = win.join(w.master, def.file);
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { file, problem: `Kit table not readable: ${file}` }; }
  try { return { kit: parseKitTable(def, text), text, file }; }
  catch (e) { return { file, problem: `${file}: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** Every kit parameter (shared parameter file, master data params and deprecated ones), and the dictionary alone. */
function kitParameters(w: Where): { all: Set<string> | null; dictionary: Set<string> | null } {
  let dictionary: Set<string> | null = null;
  try { dictionary = new Set(parseSharedParameters(fs.readFileSync(w.sharedParams, "utf8")).keys()); } catch { dictionary = null; }
  let master: string[] = [];
  try {
    const m = JSON.parse(fs.readFileSync(win.join(w.master, "FMC_Master_Data.json"), "utf8").replace(/^﻿/, ""));
    master = [...Object.keys(m?.params ?? {}), ...Object.keys(m?.deprecated_params ?? {})];
  } catch { master = []; }
  if (!dictionary && !master.length) return { all: null, dictionary: null };
  return { all: new Set([...(dictionary ?? []), ...master]), dictionary };
}

function readWorkbook(file: string): { sheets?: Map<string, string[][]>; problem?: string } {
  if (!file.trim()) return { problem: "Name the workbook (a full path to the .xlsx)" };
  if (!/\.xlsx$/i.test(file)) return { problem: `${file} isn't an .xlsx (save it from Excel as .xlsx)` };
  try { return { sheets: readXlsxSheets(fs.readFileSync(expandEnv(file)), { rowNumbers: true }) }; }
  catch (e) { return { problem: `${file}: ${e instanceof Error ? e.message : String(e)}` }; }
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);

function archiveIfThere(file: string) {
  if (!fs.existsSync(file)) return "";
  const dir = win.join(win.dirname(file), "_Archive");
  fs.mkdirSync(dir, { recursive: true });
  const to = win.join(dir, `${stamp(new Date())}_${win.basename(file)}`);
  fs.renameSync(file, to);
  return to;
}

interface Compared { def: TableDef; kitFile: string; kitText: string; kit: KitTable; sheet: string; result: ReturnType<typeof compareTable> }

function compareWorkbook(a: FmcTablesArgs, w: Where, sheets: Map<string, string[][]>): { c?: Compared; problem?: string } {
  const about = readAbout(sheets);
  const tableName = a.table.trim() || about?.table || "";
  if (!tableName) return { problem: "Name the table (fmc_tables tables lists them); this workbook has no About sheet from an export" };
  const r = resolveTable(tableName, a.key || (a.table.trim() ? "" : about?.key ?? ""));
  if (!r.def) return { problem: r.problem };
  const k = readKit(r.def, w);
  if (!k.kit) return { problem: k.problem };
  const s = pickSheet(sheets, r.def, a.sheet);
  if (!s.name) return { problem: s.problem };
  const p = kitParameters(w);
  const result = compareTable(k.kit, sheets.get(s.name)!, { columns: a.columns, kitParameters: p.all, dictionary: p.dictionary, keepRemoved: a.keep_removed });
  return { c: { def: k.kit.def, kitFile: k.file, kitText: k.text!, kit: k.kit, sheet: s.name, result } };
}

export async function runFmcTables(args: FmcTablesArgs) {
  const { config, problem } = loadConfig();
  const w = where(config, args);
  const dry = args.dry_run !== false;
  try {
    switch (args.action) {
      case "tables":
        return reply({ master_data: w.master, staging: w.staging,
          tables: KIT_TABLES.map((d) => ({ table: d.id, title: d.title, file: d.file + (d.section ? "#" + d.section : ""), key: d.key.join(" + "),
            readable: fs.existsSync(win.join(w.master, d.file)), twin: d.twin ? `${d.twin.workbook} › ${d.twin.sheet}` : undefined })),
          other: "Any other table: table \"FMC_X.csv\" or \"FMC_X.json#section\" with its key" });

      case "compare": {
        const wb = readWorkbook(args.workbook);
        if (!wb.sheets) return reply({ refused: true, reasons: [wb.problem] }, true);
        const r = compareWorkbook(args, w, wb.sheets);
        if (!r.c) return reply({ refused: true, reasons: [r.problem] }, true);
        const d = r.c.result.diff;
        log(config, "tables_compare", true, args.workbook, "done", `${r.c.def.id}: ${diffSummary(d)}`);
        return reply({ kit_file: r.c.kitFile, workbook: args.workbook, sheet: r.c.sheet, summary: diffSummary(d),
          ...diffForReply(d, args.detail), next: "fmc_tables import (a dry run first) makes a proposed kit file and a kit change request" });
      }

      case "export": {
        const r = resolveTable(args.table, args.key);
        if (!r.def) return reply({ refused: true, reasons: [r.problem] }, true);
        const k = readKit(r.def, w);
        if (!k.kit) return reply({ refused: true, reasons: [k.problem] }, true);
        const file = win.join(w.staging, `FMC_Table_${r.def.id.replace(/[^A-Za-z0-9_-]+/g, "_")}.xlsx`);
        const reasons = writable(file, w, config);
        if (reasons.length) return reply({ refused: true, reasons }, true);
        const rows = k.kit.rows.length;
        if (dry) return reply({ dry_run: true, would_write: file, table: r.def.id, kit_file: k.file, rows, columns: k.kit.columns,
          replaces: fs.existsSync(file) ? `${file} (moved to _Archive first)` : undefined, next: "Run again with dry_run=false to write it" });
        const now = new Date();
        const buf = writeXlsx([
          { name: r.def.id.slice(0, 31).replace(/[[\]:*?/\\]/g, "_"), rows: tableSheet(k.kit), header: true },
          { name: ABOUT_SHEET, rows: aboutSheet(k.kit.def, k.file, rows, now) },
        ], now);
        fs.mkdirSync(w.staging, { recursive: true });
        const archived = archiveIfThere(file);
        fs.writeFileSync(file, buf);
        log(config, "tables_export", false, file, "done", `${r.def.id}: ${rows} rows`);
        return reply({ done: true, written: file, table: r.def.id, rows, archived: archived || undefined,
          next: "Edit the first sheet in Excel, save, then fmc_tables import (a dry run first)" });
      }

      case "import": {
        const wb = readWorkbook(args.workbook);
        if (!wb.sheets) return reply({ refused: true, reasons: [wb.problem] }, true);
        const r = compareWorkbook(args, w, wb.sheets);
        if (!r.c) return reply({ refused: true, reasons: [r.problem] }, true);
        const { def, kitFile, kitText, kit, sheet, result } = r.c;
        const d = result.diff;
        const now = new Date();
        const ext = win.extname(def.file);
        const id = `KCR-${stamp(now)}-${def.id.replace(/[^A-Za-z0-9_-]+/g, "_")}`;
        const proposed = win.join(w.staging, `${win.basename(def.file, ext)}_proposed_${stamp(now)}${ext}`);
        const request = win.join(w.staging, `${id}.md`);
        const reasons = [...writable(proposed, w, config)];
        const must = blocking(d);
        const nothing = !d.added.length && !d.removed.length && !d.changed.length;
        const body = { kit_file: kitFile, workbook: args.workbook, sheet, summary: diffSummary(d), ...diffForReply(d, args.detail) };
        if (dry) return reply({ dry_run: true, ...body, would_write: reasons.length ? undefined : { proposed, request },
          cannot_write: reasons.length ? reasons : undefined,
          blocked_by: must.length ? must.map((p) => p.detail) : undefined,
          next: nothing ? "Nothing to import: the sheet matches the kit"
            : must.length ? "Fix the problems marked blocking in the workbook, then run the dry run again"
            : "Run again with dry_run=false to write the proposed kit file and the kit change request" });
        if (nothing) return reply({ refused: true, reasons: ["Nothing to import: the sheet matches the kit"], ...body }, true);
        if (must.length) reasons.push(...must.map((p) => p.detail));
        if (reasons.length) return reply({ refused: true, reasons, ...body }, true);
        fs.mkdirSync(w.staging, { recursive: true });
        fs.writeFileSync(proposed, writeKitTable(kit, result.proposed, kitText, result.touched));
        const by = process.env.USERNAME || os.userInfo().username || "unknown";
        fs.writeFileSync(request, changeRequestMarkdown({ id, title: def.title, kitFile, proposedFile: proposed, workbook: args.workbook, sheet,
          by, at: now, reason: args.reason }, d));
        // The register of kit change requests, beside the other requests (FMC_Rule_Requests.csv, FMC_Material_Requests.csv).
        const reg = win.join(expandEnv(config.reports_dir), "FMC_Kit_Change_Requests.csv");
        fs.mkdirSync(win.dirname(reg), { recursive: true });
        if (!fs.existsSync(reg)) fs.writeFileSync(reg, csvLine(["timestamp", "request", "table", "kit_file", "proposed_file", "request_file", "added", "removed", "changed", "by", "reason", "status"]));
        fs.appendFileSync(reg, csvLine([now.toISOString(), id, def.id, kitFile, proposed, request, d.added.length, d.removed.length, d.changed.length, by, args.reason, "requested"]));
        log(config, "tables_import", false, proposed, "done", `${def.id}: ${diffSummary(d)} · ${id}`);
        return reply({ done: true, request: id, proposed, request_file: request, register: reg, table: def.id, summary: diffSummary(d),
          next: "A person checks the proposed file against the kit and publishes it into 03_Master_Data (no tool does)" });
      }

      case "check": {
        const p = kitParameters(w);
        const results = [];
        for (const def of KIT_TABLES.filter((t) => t.twin)) {
          const k = readKit(def, w);
          const wbFile = win.join(w.master, def.twin!.workbook);
          if (!k.kit) { results.push({ table: def.id, twin: `${def.twin!.workbook} › ${def.twin!.sheet}`, ok: false, summary: k.problem }); continue; }
          const wb = readWorkbook(wbFile);
          const rows = wb.sheets?.get(def.twin!.sheet);
          if (!rows) { results.push({ table: def.id, twin: `${def.twin!.workbook} › ${def.twin!.sheet}`, ok: false, summary: wb.problem ?? `No ${def.twin!.sheet} sheet in ${wbFile}` }); continue; }
          const d = compareTable(k.kit, rows, { kitParameters: p.all, dictionary: p.dictionary }).diff;
          const same = !d.added.length && !d.removed.length && !d.changed.length && !blocking(d).length;
          results.push({ table: def.id, twin: `${def.twin!.workbook} › ${def.twin!.sheet}`, ok: same, summary: diffSummary(d),
            columns_only_in_excel: d.workbook_only_columns.length ? d.workbook_only_columns : undefined,
            columns_only_in_table: d.kit_only_columns.length ? d.kit_only_columns : undefined,
            ...(args.detail === "full" ? { diff: d } : { first_changes: d.changed.slice(0, 5), problems: d.problems.slice(0, 5) }) });
        }
        const drift = results.filter((r) => !r.ok).length;
        log(config, "tables_check", true, w.master, drift ? "drift" : "same", results.map((r) => `${r.table}: ${r.summary}`).join(" | "));
        return reply({ master_data: w.master, tables: results.length, drift, results,
          note: "Read-only. Where the Excel twin and the table differ, the kit's build decides which is right (a kit change request)" });
      }

      case "pending": {
        let files: string[] = [];
        try { files = fs.readdirSync(w.staging).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith("~$")).map((f) => win.join(w.staging, f)); } catch { files = []; }
        const results = [];
        for (const f of files) {
          const wb = readWorkbook(f);
          if (!wb.sheets || !readAbout(wb.sheets)) continue; // not an export
          const r = compareWorkbook({ ...args, table: "", key: "", sheet: "", workbook: f }, w, wb.sheets);
          if (!r.c) { results.push({ workbook: f, ok: false, summary: r.problem }); continue; }
          const d = r.c.result.diff;
          results.push({ workbook: f, table: r.c.def.id, ok: !blocking(d).length, summary: diffSummary(d),
            ready: !blocking(d).length && !!(d.added.length + d.removed.length + d.changed.length) });
        }
        log(config, "tables_pending", true, w.staging, "done", `${results.length} workbooks`);
        return reply({ staging: w.staging, workbooks: results.length, results,
          next: results.some((r) => "ready" in r && r.ready) ? "fmc_tables import workbook=<file> (a dry run first, then dry_run=false) for each one ready"
            : results.length ? "Nothing ready to import" : "No exported workbooks in the staging folder (fmc_tables export makes one)" });
      }
    }
    return reply({ refused: true, reasons: ["Unknown action"] }, true);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "tables_" + args.action, dry, args.workbook || args.table, "error", msg);
    return reply({ error: msg, config_problem: problem }, true);
  }
}

export function registerFmcTablesTool(server: McpServer) {
  server.tool("fmc_tables", FMC_TABLES_DESCRIPTION, FMC_TABLES_SHAPE, (args) => runFmcTables(args));
}
