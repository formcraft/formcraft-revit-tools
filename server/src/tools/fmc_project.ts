import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { ProjectInput, detailsCheck, findKitTemplates, pickKitTemplate, planProject, projectInfo } from "../fmc/project.js";
import { kitParams } from "../fmc/brief.js";
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
    "template with Project Information filled in. Show the user the dry run before running it for real. " +
    "templates lists the kit's FMC_<Role>_Template_v*.rte under template_roots (released and _Staging); templates_from_kit true takes the newest " +
    "released one per role (else FMC_Base_Template; _Staging only with allow_staging true). models [{role, volume, level, type, number}] makes " +
    "several models per role instead of one per role. plan checks details keys: Revit's own fields, the kit's Project Information parameters, " +
    "and unknown names. after [\"links\", \"qa\"] returns the follow-up calls as dry runs to make next. After start the manifest records each model's status.";

export const FMC_PROJECT_SHAPE = {
  action: z.enum(["plan", "start", "templates"]),
  project_folder: z.string().optional().default("").describe("Absolute path of the empty folder the user created"),
  code: z.string().optional().default("").describe("Project code, 2-6 characters A-Z/0-9, e.g. F26001"),
  originator: z.string().optional().default("FMC"),
  volume: z.string().optional().default("ZZ"),
  level: z.string().optional().default("ZZ"),
  type: z.string().optional().default("M3"),
  roles: z.array(z.string()).optional().default([]).describe("Discipline models to make, by role code: A, S, M, E, P…"),
  models: z.array(z.object({
    role: z.string(), volume: z.string().optional(), level: z.string().optional(), type: z.string().optional(), number: z.number().int().min(1).max(9999).optional(),
  })).optional().default([]).describe("Several models: role plus its own volume, level, type and number. Overrides roles"),
  templates_from_kit: z.boolean().optional().default(false).describe("A role with no template named takes the kit's newest FMC_<Role>_Template"),
  allow_staging: z.boolean().optional().default(false).describe("templates_from_kit may use a template that is only in _Staging"),
  after: z.array(z.enum(["links", "qa"])).optional().default([]).describe("Return these follow-up steps as dry-run calls"),
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

/** The kit's Project Information parameter names, from FMC_Master_Data.json next to the rulebooks (null when not found). */
function kitProjectInfoNames(config: GuardConfig): string[] | null {
  try {
    const master = win.join(win.dirname(expandEnv(config.rulebooks_dir)), "FMC_Master_Data.json");
    if (!fs.existsSync(master)) return null;
    const params = kitParams(JSON.parse(fs.readFileSync(master, "utf8").replace(/^\uFEFF/, "")));
    return Object.entries(params).filter(([, p]) => /project information/i.test(p.binding) || p.categories.some((c) => /ProjectInformation/i.test(String(c)))).map(([name]) => name);
  } catch { return null; }
}

/** PJ-9: the follow-up steps as calls to make next, every one a dry run. */
export function afterCalls(after: string[], models: Array<{ role: string; name: string; path: string }>, projectFolder: string) {
  const calls: Array<{ step: string; tool: string; args: Record<string, unknown>; why: string }> = [];
  if (after.includes("links")) {
    for (const host of models) {
      calls.push({ step: `Links for ${host.role}`, tool: "fmc_links", args: { action: "audit", document: host.name.replace(/\.rvt$/i, "") },
        why: "Open the model, audit its links, then link the other disciplines (fmc_links link, a dry run first)." });
    }
  }
  if (after.includes("qa")) {
    for (const host of models) {
      calls.push({ step: `First QA run on ${host.role}`, tool: "fmc_qa", args: { action: "run", gate: "wip_to_shared", document: host.name.replace(/\.rvt$/i, ""), project_folder: projectFolder },
        why: "QA is read-only; the report goes to 06_QA\\Health where the guard allows." });
    }
  }
  return calls;
}

export async function runFmcProject(args: FmcProjectArgs) {
  const { config, problem } = loadConfig();
  if (args.action === "templates") {
    const list = findKitTemplates(config.template_roots ?? [], realFs);
    const roles = [...new Set(list.map((t) => t.role))].sort();
    return reply({
      read_only: true,
      template_roots: config.template_roots ?? [],
      templates: list,
      by_role: Object.fromEntries(roles.map((role) => {
        const pick = pickKitTemplate(list, role, args.allow_staging === true);
        return [role, { chosen: pick.template?.path ?? null, note: pick.note }];
      })),
      summary: `${list.length} template(s): ${list.filter((t) => !t.staging).length} released, ${list.filter((t) => t.staging).length} in _Staging; roles ${roles.join(", ") || "none"}.`,
    });
  }
  const input: ProjectInput = { ...args, project_folder: args.project_folder, templates: args.templates ?? {}, details: args.details ?? {} };
  // F-019: the tree comes from the kit's rulebook (PST-002), rule 7.
  const pst = readRulebooks(config.rulebooks_dir).rules.find((r) => r.id === "PST-002");
  const kitTree = Array.isArray(pst?.kit_params?.folders) ? (pst!.kit_params!.folders as unknown[]).map(String) : null;
  const plan = planProject(input, config, realFs, new Date(), kitTree);
  const dry = args.action === "plan" || args.dry_run !== false;
  const details = detailsCheck(args.details ?? {}, kitProjectInfoNames(config));
  const next_calls = afterCalls(args.after ?? [], plan.models, plan.manifest_path ? win.dirname(win.dirname(plan.manifest_path)) : "");
  const summary = { folders: plan.folders, models: plan.models, manifest_path: plan.manifest_path, manifest: plan.manifest, details_check: details,
    ...(next_calls.length ? { next_calls } : {}) };
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
      steps.push({ step: `Model ${m.role}`, ok: false, detail: `${m.name}: ${msg}` });
      log(config, "create_from_template", false, m.path, "error", msg);
    }
  }
  const failed = steps.filter((s) => !s.ok).length;
  // The manifest says which models were made (a partial start is visible in the project itself; resume is Builder 1's PJ-1).
  try {
    const manifest = plan.manifest as { models?: Array<Record<string, unknown>> };
    for (const entry of manifest.models ?? []) {
      const step = steps.find((s) => s.step === `Model ${entry.role}` && String(s.detail).startsWith(String(entry.name)));
      entry.status = step ? (step.ok ? "made" : "failed") : "not made";
      if (step && !step.ok) entry.error = step.detail;
    }
    fs.writeFileSync(plan.manifest_path, JSON.stringify(plan.manifest, null, 2));
  } catch { /* the steps already say what happened */ }
  return reply({ done: failed === 0, steps, details_check: details, next: ["Link models", "Project families", "First QA run"], ...(next_calls.length ? { next_calls } : {}) }, failed > 0);
}

export function registerFmcProjectTool(server: McpServer) {
  server.tool("fmc_project", FMC_PROJECT_DESCRIPTION, FMC_PROJECT_SHAPE, (args) => runFmcProject(args));
}
