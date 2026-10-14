import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { roleOf } from "../fmc/links.js";
import { WorksetFact, auditWorksets, missingFromSet, preflight, standardSet, syncMessage, worksetNameProblems } from "../fmc/workshare.js";

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

/** Warnings at the last preflight, per model, so the next one can say how many were added. */
function warningsFile(cfg: GuardConfig) { return win.join(expandEnv(cfg.reports_dir), "FMC_Workshare_State.json"); }

/** The sync log lives with the project (01_WIP), so the team reads one log; without a project, in the reports folder. */
export function syncLogFile(cfg: GuardConfig, projectFolder: string): string {
  const inProject = projectFolder ? win.join(projectFolder, "01_WIP", "FMC_Sync_Log.csv") : "";
  return inProject && checkWritePath(inProject, cfg, { checkName: false }).ok ? inProject : win.join(expandEnv(cfg.reports_dir), "FMC_Sync_Log.csv");
}

export const FMC_WORKSHARE_DESCRIPTION =
  "Formcraft workshare. facts (read-only): whether the model is workshared, its central model, every user workset " +
    "(owner, open, editable) with naming problems ([Role]_[Content], MAN 4.6), which worksets of the standard set " +
    "(Z_Grids_Levels, Z_Links_<Role>, <Role>_Shell/_Interior/_Site, MAN 9.10) are missing, and a sync preflight (central " +
    "reachable, warnings added since the last preflight, worksets you are editing). create makes worksets (named by the " +
    "rule; a dry run unless dry_run is false; refused on live projects). message composes the sync message in the fixed " +
    "format and, with record true, adds it to the sync log. This tool never synchronises or saves: a person syncs in Revit.";

export const FMC_WORKSHARE_SHAPE = {
  action: z.enum(["facts", "create", "message"]),
  names: z.array(z.string()).optional().default([]).describe("create: workset names; empty means the missing standard set"),
  linked_roles: z.array(z.string()).optional().default([]).describe("facts, create: roles this model links (for Z_Links_<Role>)"),
  project_code: z.string().optional().default(""),
  project_folder: z.string().optional().default(""),
  revision: z.string().optional().default(""),
  worked: z.array(z.string()).optional().default([]).describe("message: review items worked on"),
  raised: z.array(z.string()).optional().default([]).describe("message: review items raised"),
  what: z.string().optional().default("").describe("message: what you did (required)"),
  who: z.string().optional().default(""),
  record: z.boolean().optional().default(false).describe("message: add it to the sync log"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcWorkshareArgs = z.infer<z.ZodObject<typeof FMC_WORKSHARE_SHAPE>>;

export async function runFmcWorkshare(args: FmcWorkshareArgs) {
  const { config } = loadConfig();
  const dry = args.dry_run !== false;
  try {
    const facts = await withRevitConnection((c) => c.sendRaw("fmc_workshare_facts", {}, 60000));
    const model = String(facts?.model ?? "");
    const role = roleOf(model);
    const worksets = (facts?.worksets ?? []) as WorksetFact[];
    const set = standardSet(role || "Z", args.linked_roles);
    const missing = facts?.workshared ? missingFromSet(worksets.map((w) => w.name), set) : [];

    if (args.action === "message") {
      if (!args.what.trim()) return reply({ refused: true, reasons: ["Say what you did: the sync message needs it"] }, true);
      const message = syncMessage({ project: args.project_code, role, revision: args.revision, worked: args.worked, raised: args.raised,
        what: args.what, who: args.who || String(facts?.user ?? "") });
      if (!args.record) return reply({ message, next: "Paste it into Revit's Synchronize with Central comment; a person syncs" });
      const file = syncLogFile(config, args.project_folder);
      fs.mkdirSync(win.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "model", "user", "message"]));
      fs.appendFileSync(file, csvLine([new Date().toISOString(), model, String(facts?.user ?? ""), message]));
      log(config, "sync_message", false, file, "done", message);
      return reply({ message, recorded: file, next: "Paste it into Revit's Synchronize with Central comment; a person syncs" });
    }

    if (args.action === "facts") {
      const states: Record<string, number> = (() => { try { return JSON.parse(fs.readFileSync(warningsFile(config), "utf8")); } catch { return {}; } })();
      const warnings = Number(facts?.warnings ?? 0);
      const pre = preflight({ workshared: !!facts?.workshared, central: String(facts?.central ?? ""), central_reachable: facts?.central_reachable ?? null,
        cloud: !!facts?.cloud, warnings, last_warnings: model in states ? states[model] : null,
        mine: worksets.filter((w) => w.owner && w.owner === facts?.user).map((w) => w.name) });
      try { states[model] = warnings; fs.mkdirSync(win.dirname(warningsFile(config)), { recursive: true }); fs.writeFileSync(warningsFile(config), JSON.stringify(states, null, 2)); }
      catch { /* the next preflight just can't compare */ }
      return reply({ model, role, workshared: !!facts?.workshared, central: facts?.central ?? "", cloud: !!facts?.cloud, user: facts?.user ?? "",
        worksets: worksets.map((w) => ({ ...w, problem: worksetNameProblems(w.name)[0] ?? "" })), standard_set: set, missing, preflight: pre,
        naming: auditWorksets(worksets).filter((x) => x.problem) });
    }

    // create
    if (!facts?.workshared) return reply({ refused: true, reasons: ["This model isn't workshared: worksets come with worksharing (Collaborate › Worksets in Revit)"] }, true);
    const names = (args.names.length ? args.names : missing).map((n) => n.trim()).filter(Boolean);
    if (!names.length) return reply({ dry_run: dry, nothing: true, message: "The standard set is complete" });
    const bad = names.flatMap((n) => worksetNameProblems(n));
    if (bad.length) return reply({ refused: true, reasons: bad }, true);
    const existing = new Set(worksets.map((w) => w.name.toLowerCase()));
    const items = names.map((n) => ({ name: n, result: existing.has(n.toLowerCase()) ? "exists" : dry ? "would create" : "" }));
    if (dry) return reply({ dry_run: true, would: items, next: "Run again with dry_run=false" });
    const todo = names.filter((n) => !existing.has(n.toLowerCase()));
    const r = await withRevitConnection((c) => c.sendCommand("fmc_workset_create", { names: todo }, 60000));
    log(config, "workset_create", false, model, "done", todo.join(", "));
    return reply({ done: true, worksets: r?.worksets ?? [], next: "A person syncs to share the new worksets" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "workshare_" + args.action, dry, "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcWorkshareTool(server: McpServer) {
  server.tool("fmc_workshare", FMC_WORKSHARE_DESCRIPTION, FMC_WORKSHARE_SHAPE, (args) => runFmcWorkshare(args));
}
