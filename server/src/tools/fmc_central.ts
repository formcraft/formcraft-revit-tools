import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { expandEnv, loadConfig } from "../fmc/policy.js";
import { CentralBuilder, CentralInput, SelfTestResult, fileQueue, planCentral, runCentral } from "../fmc/central.js";
import { DEFAULT_TEMP_ROOT, csvLog, fileStore, realDrive, realReader, realTxFs } from "../fmc/centralports.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_CENTRAL_DESCRIPTION =
  "Formcraft: create a workshared CENTRAL file on the shared network drive at the ISO 19650 location " +
  "(<project>\\01_WIP\\<Role>\\[Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt). action=plan (always " +
  "first, rule 7) returns ask_user (path, worksets, any detach) and a plan_token: quote ask_user to the person and wait for " +
  "a clear yes (rule 1). action=create with dry_run=false, the same plan_token and confirmed_by (the person who said yes) " +
  "builds it in a local temp folder, self-tests it, moves it onto the share, self-tests again (read-only open, all worksets, " +
  "sync through a throwaway local that is discarded) and marks it ready, as one transaction. An existing central is never " +
  "overwritten: the default is a new _v2 name; overwrite=true needs override_reason and backs the old one up to _Archive. " +
  "Worksets default to Architecture, Structure, MEP. If another Revit session blocks the detach the job is queued " +
  "(queue_list, queue_run, queue_remove). Needs the project's FMC_Access.json (fmc_iso_folders) to list the user.";

export const FMC_CENTRAL_SHAPE = {
  action: z.enum(["plan", "create", "queue_list", "queue_run", "queue_remove"]),
  project_folder: z.string().optional().describe("The project's ISO 19650 folder on the shared drive"),
  project: z.string().optional(),
  originator: z.string().optional().default("FMC"),
  volume: z.string().optional().default("ZZ"),
  level: z.string().optional().default("ZZ"),
  type: z.string().optional().default("M3"),
  role: z.string().optional(),
  number: z.number().int().optional().default(1),
  template_path: z.string().optional().describe("Make the central from this .rte"),
  source_model: z.string().optional().describe("Or detach this .rvt into the new central (the source is not changed)"),
  detach: z.enum(["preserve", "discard"]).optional().default("preserve"),
  worksets: z.array(z.string()).optional().describe("Custom worksets; default Architecture, Structure, MEP"),
  overwrite: z.boolean().optional().default(false),
  override_reason: z.string().optional(),
  min_free_gb: z.number().optional(),
  robot_id: z.string().optional().describe("The robot making the call, if any: its rights.json must allow central_create"),
  plan_token: z.string().optional(),
  confirmed_by: z.string().optional().describe("Name of the person who said yes to the quoted ask_user"),
  job_id: z.string().optional(),
  dry_run: z.boolean().optional().default(true),
};

export type FmcCentralArgs = z.infer<z.ZodObject<typeof FMC_CENTRAL_SHAPE>>;

const LONG = 900000;

export const revitCentralBuilder: CentralBuilder = {
  build: async (req) => {
    await withRevitConnection((c) => c.sendRaw("fmc_central_build", {
      temp_path: req.temp_path, worksets: req.worksets, source_kind: req.source.kind, source_path: req.source.path, detach: req.source.detach ?? "",
    }, LONG));
  },
  selfTest: async (central, worksets, throwaway) =>
    await withRevitConnection((c) => c.sendRaw("fmc_central_selftest", { central_path: central, worksets, throwaway_dir: throwaway }, LONG)) as SelfTestResult,
  promote: async (temp, target) => {
    await withRevitConnection((c) => c.sendRaw("fmc_central_promote", { temp_path: temp, target_path: target }, LONG));
  },
};

function queueFile(reportsDir: string) { return win.join(expandEnv(reportsDir), "FMC_Central_Queue.json"); }

function toInput(args: FmcCentralArgs): CentralInput {
  return {
    project_folder: args.project_folder ?? "", project: args.project ?? "", originator: args.originator ?? "FMC", volume: args.volume ?? "ZZ",
    level: args.level ?? "ZZ", type: args.type ?? "M3", role: args.role ?? "", number: args.number ?? 1, template_path: args.template_path,
    source_model: args.source_model, detach: args.detach, worksets: args.worksets, overwrite: args.overwrite, override_reason: args.override_reason,
    min_free_gb: args.min_free_gb, user: os.userInfo().username, robot_id: args.robot_id,
  };
}

export async function runFmcCentral(args: FmcCentralArgs, builder: CentralBuilder = revitCentralBuilder) {
  const { config } = loadConfig();
  const queue = fileQueue(fileStore(queueFile(config.reports_dir)));
  const tempRoot = DEFAULT_TEMP_ROOT();
  if (args.action === "queue_list") return reply({ queue: queue.list().map((j) => ({ id: j.id, target: j.target, queued_at: j.queued_at, blocked_by: j.blocked_by })) });
  if (args.action === "queue_remove") return reply({ removed: queue.remove(args.job_id ?? "") });

  let input = toInput(args);
  let token = args.plan_token ?? "";
  let confirmedBy = args.confirmed_by ?? "";
  let jobId = "";
  if (args.action === "queue_run") {
    const job = queue.list().find((j) => !args.job_id || j.id === args.job_id);
    if (!job) return reply({ empty: true, detail: "Nothing is queued" });
    ({ input, plan_token: token, confirmed_by: confirmedBy } = job);
    jobId = job.id;
  }

  const plan = planCentral(input, config, realReader, realDrive, tempRoot);
  const view = { ask_user: plan.ask_user, target: plan.target, versioned: plan.versioned, existing: plan.existing, overwrite: plan.overwrite,
    worksets: plan.worksets, source: plan.source, warnings: plan.warnings, plan_token: plan.plan_token };
  if (!plan.ok) return reply({ refused: true, reasons: plan.reasons, plan: view }, true);
  if (args.action === "plan" || (args.action === "create" && args.dry_run !== false))
    return reply({ dry_run: true, would_do: view, next: "Quote ask_user to the person. After a clear yes: action=create, dry_run=false, plan_token, confirmed_by" });
  if (token !== plan.plan_token)
    return reply({ refused: true, reasons: ["Rule 7: plan_token doesn't match the current plan (something changed): plan again and quote it"] }, true);
  if (!confirmedBy.trim()) return reply({ refused: true, reasons: ["Rule 1: confirmed_by (the person who said yes) is required"] }, true);

  if (jobId) queue.remove(jobId);
  const outcome = await runCentral(plan, input, confirmedBy, {
    builder, fs: realTxFs(tempRoot), drive: realDrive, queue, log: csvLog(plan.log_path), now: () => new Date(),
  });
  return reply(outcome, outcome.status === "aborted");
}

export function registerFmcCentralTool(server: McpServer) {
  server.tool("fmc_central", FMC_CENTRAL_DESCRIPTION, FMC_CENTRAL_SHAPE, (args) => runFmcCentral(args));
}
