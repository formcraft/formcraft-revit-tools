import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { ModelSheet, compare, completeness, numberOk, parseRegister, planned } from "../fmc/sheets.js";
import { readXlsx } from "../fmc/xlsx.js";

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
    "create makes the missing sheets with a title block; rename gives sheets the register's names. create and rename are " +
    "dry runs unless dry_run is false and are refused on live projects. Sheet numbers come from the register, never typed.";

export const FMC_SHEETS_SHAPE = {
  action: z.enum(["compare", "create", "rename"]),
  register: z.string().describe("Absolute path of the project's sheet register (.xlsx or .csv)"),
  issue_set: z.string().optional().default("PERMIT"),
  roles: z.array(z.string()).optional().default([]),
  fields: z.array(z.string()).optional().describe("compare: sheet parameters to count as title block fields"),
  title_block: z.string().optional().describe("create: title block type name (default: the first loaded)"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcSheetsArgs = z.infer<z.ZodObject<typeof FMC_SHEETS_SHAPE>>;

export async function runFmcSheets(args: FmcSheetsArgs) {
  const { config } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    if (!fs.existsSync(args.register)) return reply({ refused: true, reasons: [`Sheet register not found: ${args.register}`] }, true);
    const reg = parseRegister(readRegisterFile(args.register));
    if (!reg.sheets.length) return reply({ refused: true, reasons: reg.problems.length ? reg.problems : ["The register lists no sheets"] }, true);
    const plan = planned(reg.sheets, args.issue_set, args.roles);
    const bad = plan.filter((p) => !numberOk(p.number)).map((p) => `${p.number} doesn't follow [Role]-[Series][Number]`);
    const fields = args.fields?.length ? args.fields : DEFAULT_FIELDS;
    const facts = await withRevitConnection((c) => c.sendRaw("fmc_sheet_facts", { fields }, 120000));
    const model = (facts?.sheets ?? []) as ModelSheet[];
    const diffs = compare(plan, model, args.roles);

    if (args.action === "compare")
      return reply({ model: facts?.model, register: args.register, planned: plan.length, in_model: model.length, differences: diffs,
        completeness: completeness(plan, model), title_blocks: facts?.title_blocks ?? [], problems: [...reg.problems, ...bad] });

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
