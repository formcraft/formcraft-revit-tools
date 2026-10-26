import { newBook } from "../fmc/projectbook.js";
import { bookPaths, projectFolderFrom, saveBook } from "../fmc/projectbook_io.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { ProjectInput, planProject, projectInfo } from "../fmc/project.js";
import { readRulebooks } from "./fmc_qa.js";

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

export const FMC_PROJECT_DESCRIPTION =
  "Formcraft: start a project in a folder the user created (decision D5). plan checks the folder (must exist and be " +
    "empty), the project code, the naming codes and a template per discipline, and lists the folder tree, the models " +
    "(one per role, named by Manual 4.1, in 01_WIP\\<Role>) and the manifest. start makes them: dry_run (default) " +
    "shows the plan, dry_run=false builds the tree, writes 01_WIP\\FMC_Project.json and creates each model from its " +
    "template with Project Information filled in. Show the user the dry run before running it for real.";

export const FMC_PROJECT_SHAPE = {
  action: z.enum(["plan", "start"]),
  project_folder: z.string().describe("Absolute path of the empty folder the user created"),
  code: z.string().describe("Project code, 2-6 characters A-Z/0-9, e.g. F26001"),
  originator: z.string().optional().default("FMC"),
  volume: z.string().optional().default("ZZ"),
  level: z.string().optional().default("ZZ"),
  type: z.string().optional().default("M3"),
  roles: z.array(z.string()).describe("Discipline models to make, by role code: A, S, M, E, P…"),
  templates: z.record(z.string(), z.string()).optional().default({}).describe("Template (.rte) per role code"),
  details: z.record(z.string(), z.string()).optional().default({}).describe("Project Information: kit parameter name → value"),
  stage: z.string().optional(),
  issue_set: z.string().optional(),
  standard: z.string().optional(),
  dry_run: z.boolean().optional().default(true),
};

export type FmcProjectArgs = z.infer<z.ZodObject<typeof FMC_PROJECT_SHAPE>>;

const realFs = {
  exists: (p: string) => fs.existsSync(p),
  isDirectory: (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
  list: (p: string) => { try { return fs.readdirSync(p); } catch { return []; } },
};

export async function runFmcProject(args: FmcProjectArgs) {
  const { config, problem } = loadConfig();
  const input: ProjectInput = { ...args, project_folder: args.project_folder, templates: args.templates ?? {}, details: args.details ?? {} };
  // F-019: the tree comes from the kit's rulebook (PST-002), rule 7.
  const pst = readRulebooks(config.rulebooks_dir).rules.find((r) => r.id === "PST-002");
  const kitTree = Array.isArray(pst?.kit_params?.folders) ? (pst!.kit_params!.folders as unknown[]).map(String) : null;
  const plan = planProject(input, config, realFs, new Date(), kitTree);
  const dry = args.action === "plan" || args.dry_run !== false;
  const summary = { folders: plan.folders, models: plan.models, manifest_path: plan.manifest_path, manifest: plan.manifest };
  if (!plan.ok) {
    log(config, "project_start", dry, args.project_folder, "refused", plan.reasons.join(" | "));
    return reply({ refused: true, reasons: plan.reasons, config_problem: problem, plan: summary }, true);
  }
  if (dry) return reply({ dry_run: true, would_do: summary, next: "Run start again with dry_run=false" });

  const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
  try {
    for (const f of plan.folders) fs.mkdirSync(f, { recursive: true });
    steps.push({ step: "Folder tree", ok: true, detail: `${plan.folders.length} folders` });
    fs.writeFileSync(plan.manifest_path, JSON.stringify(plan.manifest, null, 2));
    steps.push({ step: "Project manifest", ok: true, detail: plan.manifest_path });
    // The project book (docs/PROJECT_BOOK.md): team, decisions, progress and checklists, from the first day.
    const folder = projectFolderFrom(plan.manifest_path);
    const made = saveBook(config, folder, newBook(plan.manifest as { project: string; stage?: string }, plan.manifest_path, process.env.USERNAME || "unknown"),
      { at: new Date().toISOString(), by: process.env.USERNAME || "unknown", kind: "person", action: "create" });
    steps.push({ step: "Project book", ok: made.ok, detail: made.ok ? bookPaths(folder).book : made.reason ?? "" });
    log(config, "project_start", false, plan.manifest_path, "done", `${plan.folders.length} folders and the manifest`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "project_start", false, args.project_folder, "error", msg);
    return reply({ error: msg, steps }, true);
  }

  const info = projectInfo(input);
  for (const m of plan.models) {
    try {
      const r = await withRevitConnection((c) => c.sendRaw("fmc_create_document",
        { kind: "project", template_path: m.template, save_path: m.path, close_after: true, project_info: info }));
      const missing = (r?.projectInfoMissing ?? []) as string[];
      steps.push({ step: `Model ${m.role}`, ok: true, detail: m.name + (missing.length ? ` · not in the template: ${missing.join(", ")}` : "") });
      log(config, "create_from_template", false, m.path, "done", JSON.stringify(r));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      steps.push({ step: `Model ${m.role}`, ok: false, detail: msg });
      log(config, "create_from_template", false, m.path, "error", msg);
    }
  }
  const failed = steps.filter((s) => !s.ok).length;
  return reply({ done: failed === 0, steps, next: ["Link models", "Project families", "First QA run"] }, failed > 0);
}

export function registerFmcProjectTool(server: McpServer) {
  server.tool("fmc_project", FMC_PROJECT_DESCRIPTION, FMC_PROJECT_SHAPE, (args) => runFmcProject(args));
}
