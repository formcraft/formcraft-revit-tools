import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { ModelSheet, compare, completeness, numberOk, parseRegister, planned } from "../fmc/sheets.js";
import { readXlsx } from "../fmc/xlsx.js";
import { FMC_SHEET_LAYOUT_FIELDS, runSheetLayout, type SheetLayoutArgs } from "./fmc_sheet_layout.js";
import { runSheetPack, type SheetPackArgs } from "./fmc_sheet_pack.js";
import { registerMissingBody, resolveRegister } from "../fmc/sheetregister.js";

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

/** A CSV line with quoted fields ("a, b" stays one field). */
export function csvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function readRegisterFile(file: string): string[][] {
  if (win.extname(file).toLowerCase() === ".xlsx") return readXlsx(fs.readFileSync(file));
  return fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).map(csvRow);
}

/** Sheet parameters the completeness check reads (filled or not). */
export const DEFAULT_FIELDS = ["Drawn By", "Checked By", "Approved By", "Sheet Issue Date", "FMC_Sheet_Status"];

export const FMC_SHEETS_DESCRIPTION =
  "Formcraft sheets against the project's sheet register (FMC_Sheet_Register.xlsx or .csv: Number, Name, Role, Issue " +
    "sets). compare (read-only) lists the sheets the register plans for an issue set and roles, what is missing, extra " +
    "or named differently in the active model, and how complete each sheet is (views placed, title block fields filled). " +
    "create makes the missing sheets with a title block; rename gives sheets the register's names. " +
    "pair places views on one sheet in the title block drawing area. arrange reflows the views on a sheet as grid, pair or stack. " +
    "park sets a browser-organization parameter, or FMC_Sheet_Status, to Parked. " +
    "pack arranges viewports in the FMC_TB_A0 or FMC_TB_A1 drawing area with no overlaps, at the largest standard scale that fits and is at least min_scale. " +
    "pair_small proposes small views from other sheets. Overflow is reported in millimetres and apply is refused. " +
    "create, rename, pair, arrange and park are dry runs unless dry_run is false. A layout write needs batch_lease and references. " +
    "Sheet numbers come from the register, never typed. " +
    "Example: action pair, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, sheet A-101, views [\"Level 1\",\"Level 2\"], dry_run true.";

export const FMC_SHEETS_SHAPE = {
  action: z.enum(["compare", "create", "rename", "pair", "arrange", "park", "pack"]),
  min_scale: z.number().int().positive().optional().default(1).describe("pack: smallest scale denominator. 50 means 1:50 or coarser."),
  pair_small: z.boolean().optional().default(true).describe("pack: propose small views from other sheets when they fit the leftover space."),
  register: z.string().optional().default("").describe("Absolute path of the project's sheet register (.xlsx or .csv) for compare, create and rename. Left out: the kit's 03_Master_Data\\FMC_Sheet_Register.csv."),
  document: z.string().optional().default("").describe("Title or full path. Required for pair, arrange and park."),
  sheet: FMC_SHEET_LAYOUT_FIELDS.sheet,
  views: FMC_SHEET_LAYOUT_FIELDS.views,
  layout: FMC_SHEET_LAYOUT_FIELDS.layout,
  sheets: FMC_SHEET_LAYOUT_FIELDS.sheets,
  target: FMC_SHEET_LAYOUT_FIELDS.target,
  batch_lease: FMC_SHEET_LAYOUT_FIELDS.batch_lease,
  references: FMC_SHEET_LAYOUT_FIELDS.references,
  issue_set: z.string().optional().default("PERMIT")
    .describe("The issue set; a sheet is in it when it is one of the sheet's sets (the register's PERMIT+TENDER+CONSTRUCTION is in PERMIT). Several (PERMIT+TENDER) take a sheet in any of them"),
  roles: z.array(z.string()).optional().default([]),
  fields: z.array(z.string()).optional().describe("compare: sheet parameters to count as title block fields"),
  full: z.boolean().optional().describe("compare: completeness for every planned sheet, missing ones too (default: only the sheets in the model)"),
  title_block: z.string().optional().describe("create: title block type name (default: the first loaded)"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcSheetsArgs = z.infer<z.ZodObject<typeof FMC_SHEETS_SHAPE>>;

export async function runFmcSheets(args: FmcSheetsArgs, io: Parameters<typeof runSheetLayout>[1] = {}) {
  if (args.action === "pack") return runSheetPack(args as SheetPackArgs, io);
  if (args.action === "pair" || args.action === "arrange" || args.action === "park") {
    return runSheetLayout(args as SheetLayoutArgs, io);
  }
  const { config } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    const found = resolveRegister(args.register, config);
    if (!found.exists) return reply(registerMissingBody(found), true);
    const registerFile = found.file;
    const reg = parseRegister(readRegisterFile(registerFile));
    if (!reg.sheets.length) return reply({ refused: true, reasons: reg.problems.length ? reg.problems : ["The register lists no sheets"] }, true);
    const plan = planned(reg.sheets, args.issue_set, args.roles);
    const bad = plan.filter((p) => !numberOk(p.number)).map((p) => `${p.number} doesn't follow [Role]-[Series][Number]`);
    const fields = args.fields?.length ? args.fields : DEFAULT_FIELDS;
    const facts = await withRevitConnection((c) => c.sendRaw("fmc_sheet_facts", { fields }, 120000));
    const model = (facts?.sheets ?? []) as ModelSheet[];
    const diffs = compare(plan, model, args.roles);

    if (args.action === "compare") {
      // Night test 26 Oct: a missing sheet was listed twice (as a difference and as a row of zeros); the short answer
      // gives completeness for the sheets that exist and counts by status (full true: every row)
      const all = completeness(plan, model);
      const inModel = new Set(model.map((m) => m.number));
      const byStatus = all.reduce((a, c) => ({ ...a, [c.status]: (a[c.status] ?? 0) + 1 }), {} as Record<string, number>);
      return reply({ model: facts?.model, register: registerFile, register_source: found.source, planned: plan.length, in_model: model.length, differences: diffs,
        completeness: args.full ? all : all.filter((c) => inModel.has(c.number)), status_counts: byStatus,
        title_blocks: facts?.title_blocks ?? [], problems: [...reg.problems, ...bad] });
    }

    const items = args.action === "create"
      ? diffs.filter((d) => d.difference === "Missing" && numberOk(d.number)).map((d) => ({ number: d.number, name: d.register_name }))
      : diffs.filter((d) => d.difference === "Name differs").map((d) => ({ id: d.id, number: d.number, name: d.register_name, from: d.model_name }));
    if (!items.length) return reply({ dry_run: dry, nothing: true, message: args.action === "create" ? "No missing sheets" : "No names differ" });
    const command = args.action === "create" ? "fmc_sheet_create" : "fmc_sheet_rename";
    const params = { sheets: items, title_block: args.title_block ?? "", dry_run: dry };
    // The plan only reads; the real run changes the model and goes through the live-model lock.
    const r = await withRevitConnection((c) => dry ? c.sendRaw(command, params, 120000) : c.sendCommand(command, params, 120000));
    if (!dry) log(config, "sheets_" + args.action, false, facts?.model ?? "", "done", `${(r?.sheets ?? []).length} sheets`);
    return reply(dry ? { dry_run: true, would: r?.sheets ?? items, title_block: r?.title_block, next: "Run again with dry_run=false" }
                     : { done: true, sheets: r?.sheets ?? [] });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "sheets_" + args.action, dry, args.register, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcSheetsTool(server: McpServer) {
  server.tool("fmc_sheets", FMC_SHEETS_DESCRIPTION, FMC_SHEETS_SHAPE, (args) => runFmcSheets(args));
}
