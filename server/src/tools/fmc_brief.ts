import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { applyPayload, kitParams, parseCis, planBrief } from "../fmc/brief.js";

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

function rfaFiles(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = win.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && /\.rfa$/i.test(e.name)) out.push(full);
    }
  };
  walk(folder, 0);
  return out;
}

export const FMC_BRIEF_DESCRIPTION =
  "Formcraft Start from brief (Model). Reads an approved Concept Information Set (CIS, JSON schema fmc-cis/0.1: " +
    "levels, Project Information, the room programme, materials, door and window families) and sets up a NEW, unsaved " +
    "model: levels, Project Information values, rooms (unplaced, with their programme data) and the families. Every " +
    "parameter must be a kit parameter; blanks stay blank. plan (read-only) shows what would be created; apply is a dry " +
    "run in Revit (counts, then rolled back) unless dry_run is false. It never draws walls or other geometry, never " +
    "saves, and refuses a saved or workshared model.";

export const FMC_BRIEF_SHAPE = {
  action: z.enum(["plan", "apply"]),
  cis_file: z.string().describe("Path of the approved CIS .json"),
  kit_folder: z.string().describe("The Formcraft kit folder (FMC_Kit.json inside)"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcBriefArgs = z.infer<z.ZodObject<typeof FMC_BRIEF_SHAPE>>;

export async function runFmcBrief(args: FmcBriefArgs) {
  const { config } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    const cisFile = args.cis_file.trim();
    if (!cisFile || !fs.existsSync(cisFile)) return reply({ refused: true, reasons: [`CIS not found: ${cisFile || "(none chosen)"}`] }, true);
    const { cis, problems: cisProblems } = parseCis(fs.readFileSync(cisFile, "utf8"));
    if (!cis || cisProblems.length) return reply({ refused: true, reasons: cisProblems.map((p) => `CIS: ${p}`) }, true);
    const kit = args.kit_folder.trim();
    const master = win.join(kit, "03_Master_Data", "FMC_Master_Data.json");
    if (!kit || !fs.existsSync(master)) return reply({ refused: true, reasons: [`Kit master data not found: ${master}`] }, true);
    const params = kitParams(JSON.parse(fs.readFileSync(master, "utf8").replace(/^﻿/, "")));
    const plan = planBrief(cis, params, rfaFiles(win.join(kit, "04_Families")));
    const head = { cis: { file: cisFile, project: cis.project, revision: cis.revision, approved: cis.approved },
      counts: { levels: plan.levels.length, project_info: plan.project_info.length, rooms: plan.rooms.length, families: plan.families.length, blanks: plan.blanks.length } };

    if (args.action === "plan") {
      let model: any = null;
      try { model = (await withRevitConnection((c) => c.sendRaw("fmc_document_info", {})))?.active ?? null; } catch { /* Revit not reachable: the plan still reads */ }
      const modelProblem = !model ? "No model open in Revit" : model.isFamily ? "The active document is a family"
        : model.path ? "The active model is saved: Start from brief runs only on a new, unsaved model" : model.isWorkshared ? "The active model is workshared" : "";
      return reply({ ...head, plan, model: model ? { title: model.title, new: !model.path } : null, model_problem: modelProblem,
        next: plan.problems.length ? "Fix the CIS first" : modelProblem ? "Start a new model from the kit template, then apply" : "apply (a dry run first)" });
    }

    if (plan.problems.length) return reply({ refused: true, reasons: plan.problems }, true);
    const r = await withRevitConnection((c) => c.sendCommand("fmc_brief_apply", applyPayload(plan, dry), 300000));
    if (!dry) log(config, "brief_apply", false, cis.project, "done",
      `${r?.levels_created ?? 0} levels, ${r?.rooms_created ?? 0} rooms, ${r?.project_info_set ?? 0} project values, ${r?.families_loaded ?? 0} families`);
    return reply({ ...head, dry_run: dry, result: r, skipped: plan.skipped, blanks: plan.blanks,
      next: dry ? "Run again with dry_run=false to create it (one Undo)" : "Place the rooms once walls exist; brief compliance check in Manage › QA" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "brief_" + args.action, dry, args.cis_file, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcBriefTool(server: McpServer) {
  server.tool("fmc_brief", FMC_BRIEF_DESCRIPTION, FMC_BRIEF_SHAPE, (args) => runFmcBrief(args));
}
