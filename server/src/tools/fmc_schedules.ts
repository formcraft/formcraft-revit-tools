import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { kitParams } from "../fmc/brief.js";
import { SCHEDULE_SET, scheduleProblems } from "../fmc/schedules.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch { /* logging never blocks the work */ }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_SCHEDULES_DESCRIPTION =
  "Formcraft schedules for every discipline (F60, docs/SCHEDULES.md). A schedule set (JSON, fmc-schedules/0.1: each " +
    "schedule's discipline, category, fields with headings, hidden and totals, filters, sorting and grouping, itemized, " +
    "grand totals, browser folder). check (no Revit): FMC_ fields must be kit parameters bound to the category (rule 7), " +
    "filters and sorts on its own fields. plan: in the open template or WIP model, what would be made, what updated (only " +
    "missing fields are added), which fields the category doesn't have; a dry run rolled back. apply (dry_run false): one " +
    "transaction, behind the live-model lock. It never deletes a schedule or a field a person added.";

export const FMC_SCHEDULES_SHAPE = {
  action: z.enum(["check", "plan", "apply"]),
  file: z.string().describe("The schedule set (.json)"),
  kit_folder: z.string().describe("The Formcraft kit folder (its master data checks the FMC_ fields)"),
  only: z.array(z.string()).optional().default([]).describe("Only these schedules (by name) or disciplines (by role code)"),
  dry_run: z.boolean().optional().default(true),
};
export type FmcSchedulesArgs = z.infer<z.ZodObject<typeof FMC_SCHEDULES_SHAPE>>;

export async function runFmcSchedules(args: FmcSchedulesArgs) {
  const { config } = loadConfig();
  const file = expandEnv(args.file.trim());
  try {
    if (!fs.existsSync(file)) return reply({ refused: true, reasons: [`No schedule set at ${file}`] }, true);
    const parsed = SCHEDULE_SET.safeParse(JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")));
    if (!parsed.success) return reply({ refused: true, reasons: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, true);
    const set = parsed.data;
    const only = new Set(args.only);
    const schedules = only.size ? set.schedules.filter((s) => only.has(s.name) || only.has(s.discipline)) : set.schedules;
    const master = win.join(expandEnv(args.kit_folder.trim()), "03_Master_Data", "FMC_Master_Data.json");
    if (!args.kit_folder.trim() || !fs.existsSync(master)) return reply({ refused: true, reasons: [`Kit master data not found: ${master}`] }, true);
    const kit = kitParams(JSON.parse(fs.readFileSync(master, "utf8").replace(/^﻿/, "")));
    const { problems, warnings } = scheduleProblems({ ...set, schedules }, kit);
    if (args.action === "check" || problems.length)
      return reply({ set: `${set.name} ${set.revision}`.trim(), schedules: schedules.length, by_discipline: schedules.reduce((m: Record<string, number>, s) => ({ ...m, [s.discipline]: (m[s.discipline] ?? 0) + 1 }), {}),
        problems, warnings, ...(problems.length ? { refused: args.action !== "check" } : {}), next: problems.length ? "Fix the set (or ask the kit for the parameters)" : "plan in the open template or WIP model" }, problems.length > 0 && args.action !== "check");
    const real = args.action === "apply" && args.dry_run === false;
    // the plan only reads (it is rolled back in Revit); the real run is a model write behind the live-model lock
    const params = { schedules, dry_run: !real };
    const r = await withRevitConnection((c) => real ? c.sendCommand("fmc_schedules_apply", params, 300000) : c.sendRaw("fmc_schedules_apply", params, 300000)) as Record<string, unknown>;
    if (real) log(config, "schedules_apply", false, file, "done", `${schedules.length} schedules`);
    return reply({ dry_run: !real, set: set.name, warnings, ...r, next: real ? "Check the schedules in Revit" : "Run apply with dry_run=false in the template or WIP model" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(config, "schedules_" + args.action, args.dry_run, file, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcSchedulesTool(server: McpServer) {
  server.tool("fmc_schedules", FMC_SCHEDULES_DESCRIPTION, FMC_SCHEDULES_SHAPE, (args) => runFmcSchedules(args));
}
