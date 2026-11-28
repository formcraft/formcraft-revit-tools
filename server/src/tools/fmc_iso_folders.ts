import os from "node:os";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../fmc/policy.js";
import { applyIsoFolders, planIsoFolders } from "../fmc/iso19650.js";
import { realTreeWriter } from "../fmc/centralports.js";
import { CallerCtx, approvalForIsoFolders } from "../fmc/centralguard.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_ISO_FOLDERS_DESCRIPTION =
  "Formcraft: make an ISO 19650 project folder tree in a NEW or empty folder: 00_Info (project info + Admin access " +
  "rules), 01_WIP, 02_Shared, 03_Published, 04_Archive (Archived), a WIP and Shared folder per role, and " +
  "robots\\<robot-id>\\ with rights.json, settings.json and logs\\. action=plan (always first) returns the tree and a " +
  "plan_token. action=create with dry_run=false and that plan_token builds it, after a person's approval in the " +
  "Formcraft pane (plan_token alone is not an approval). Existing project folders are never touched and no file is " +
  "overwritten. Show the user the planned tree before create.";

export const FMC_ISO_FOLDERS_SHAPE = {
  action: z.enum(["plan", "create"]),
  project_folder: z.string().describe("Absolute path of the new project folder (it may not exist yet; its parent must)"),
  code: z.string().describe("Project code, 2-6 characters A-Z/0-9"),
  name: z.string().optional(),
  roles: z.array(z.string()).describe("Role codes: A, S, M, E, P…"),
  robots: z.array(z.object({
    id: z.string(), roles: z.array(z.string()).optional(), read: z.array(z.string()).optional(), write: z.array(z.string()).optional(),
    central_create: z.boolean().optional(),
  })).optional().default([]),
  central_creators: z.array(z.string()).optional().default([]).describe("Windows user names allowed to create central files"),
  plan_token: z.string().optional().describe("The plan_token from action=plan; required by create, but not itself an approval"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcIsoFoldersArgs = z.infer<z.ZodObject<typeof FMC_ISO_FOLDERS_SHAPE>>;

export async function runFmcIsoFolders(args: FmcIsoFoldersArgs, ctx: CallerCtx = {}) {
  const { config } = loadConfig();
  const plan = planIsoFolders({ ...args, created_by: os.userInfo().username }, config, realTreeWriter);
  const view = { root: plan.root, tree: plan.tree, folders: plan.folders.length, files: plan.files.map((f) => f.path), plan_token: plan.plan_token };
  if (!plan.ok) return reply({ refused: true, reasons: plan.reasons, plan: view }, true);
  if (args.action === "plan" || args.dry_run !== false)
    return reply({ dry_run: true, would_create: view, next: "Show the user the tree. Then a person runs action=create, dry_run=false, plan_token, from the pane (or Approves it there). plan_token alone is not an approval." });
  if (args.plan_token !== plan.plan_token)
    return reply({ refused: true, reasons: ["The plan_token doesn't match the current plan: run action=plan again and show the user the tree"] }, true);
  const ok = approvalForIsoFolders(ctx, { tool: "fmc_iso_folders", action: "create", plan_token: plan.plan_token, root: plan.root, args: { ...args, dry_run: false, plan_token: plan.plan_token } }, plan.root,
    [`Create ISO 19650 folders at ${plan.root}`, `${plan.folders.length} folders, ${plan.files.length} files`]);
  if (!ok.ok) return reply({ refused: true, awaiting_person: true, approval_id: ok.id, reasons: [ok.message] }, true);
  if (!ok.claim()) return reply({ refused: true, reasons: [`Approval ${ok.id} was already used once`] }, true);
  const r = applyIsoFolders(plan, realTreeWriter);
  return reply({ done: r.ok, ...r, root: plan.root, approved_by: ok.by }, !r.ok);
}

export function registerFmcIsoFoldersTool(server: McpServer) {
  server.tool("fmc_iso_folders", FMC_ISO_FOLDERS_DESCRIPTION, FMC_ISO_FOLDERS_SHAPE, (args) => runFmcIsoFolders(args, { viaMcp: true }));
}
