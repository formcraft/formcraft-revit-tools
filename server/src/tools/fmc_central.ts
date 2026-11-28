import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { expandEnv, loadConfig } from "../fmc/policy.js";
import { CentralBuilder, CentralInput, DrivePort, SelfTestResult, fileQueue, planCentral, runCentral } from "../fmc/central.js";
import { DEFAULT_TEMP_ROOT, csvLog, fileStore, realDrive, realReader, realTxFs } from "../fmc/centralports.js";
import {
  CallerCtx, centralLeaseProblem, isPerson, paneApproval, personForCentralWrite,
  promoteTargetProblems, tempPathProblems,
} from "../fmc/centralguard.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_CENTRAL_DESCRIPTION =
  "Formcraft: create a workshared CENTRAL file on the shared network drive at the ISO 19650 location " +
  "(<project>\\01_WIP\\<Role>\\[Project]-[Originator]-[Volume]-[Level]-[Type]-[Role]-[Number].rvt). action=plan (always " +
  "first, rule 7) returns ask_user (path, worksets, any detach) and a plan_token: quote ask_user to the person and wait for " +
  "a clear yes (rule 1). A real create (dry_run=false) is person-only: a person's click in the Formcraft pane, or their " +
  "Approve in the pane's Approvals list, which then runs the create (there is no AI path for save-as-central or the " +
  "self-test sync, pending an owner exception to rule 6). plan_token and confirmed_by are not an approval. The real run " +
  "also needs batch_lease from fmc_batch request. It builds in a local temp folder, self-tests, moves onto the share, " +
  "self-tests again and marks it ready, as one transaction. An existing central is never overwritten: the default is a " +
  "new _v2 name; overwrite=true needs override_reason and backs the old one up to _Archive. Worksets default to " +
  "Architecture, Structure, MEP. If another Revit session blocks the detach the job is queued (queue_list, queue_run, " +
  "queue_remove). queue_run needs a new person confirmation. Needs the project's FMC_Access.json (fmc_iso_folders) to list the user.";

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
  confirmed_by: z.string().optional().describe("Name of the person who was shown the dry run (not itself an approval)"),
  job_id: z.string().optional(),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().describe("Required for a real create, queue_run and queue_remove. The lease id from fmc_batch request."),
};

export type FmcCentralArgs = z.infer<z.ZodObject<typeof FMC_CENTRAL_SHAPE>>;

const LONG = 900000;

/** The Revit half. sendRaw is deliberate: sendCommand would apply the live-model lock to whatever model is open, which is the wrong document. The tool applies the lease, the person check and the AI gate first. */
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

/** Refuses a temp or target path that the add-in would also refuse, before any Revit call. */
export function guardedBuilder(inner: CentralBuilder, tempRoot: string, kind: (root: string) => "network" | "local" | "removable" | "unknown"): CentralBuilder {
  return {
    build: async (req) => {
      const p = tempPathProblems(req.temp_path, tempRoot, kind);
      if (p.length) throw new Error(p.join("; "));
      return inner.build(req);
    },
    selfTest: async (central, worksets, throwaway) => {
      const p = tempPathProblems(throwaway, tempRoot, kind);
      if (p.length) throw new Error("throwaway_dir: " + p.join("; "));
      return inner.selfTest(central, worksets, throwaway);
    },
    promote: async (temp, target) => {
      const reasons = [...tempPathProblems(temp, tempRoot, kind), ...promoteTargetProblems(target, tempRoot, kind)];
      if (reasons.length) throw new Error(reasons.join("; "));
      return inner.promote(temp, target);
    },
  };
}

export interface CentralRunCtx extends CallerCtx {
  queue?: ReturnType<typeof fileQueue>;
  tempRoot?: string;
  now?: () => Date;
  /** Tests pass a drive that treats the temp folder as local and the share as network. */
  drive?: DrivePort;
}

function leaseDoc(args: FmcCentralArgs): string {
  return (args.source_model ?? "").trim();
}

function writeGate(ctx: CentralRunCtx, args: FmcCentralArgs, kind: "create" | "queue_run" | "queue_remove", binding: Record<string, unknown>, docPath: string, details: string[]) {
  const locked = centralLeaseProblem(args.batch_lease, leaseDoc(args));
  if (locked) return reply({ refused: true, code: "FMC-BATCH-LOCKED", reasons: [locked] }, true);
  if (kind === "queue_remove") {
    if (isPerson(ctx)) return null;
    const ok = paneApproval({ command: "fmc_central_queue_remove", person: false, env: ctx.env ?? process.env, binding, docPath, elements: 1, details, now: ctx.now?.(), group: "central" });
    if (!ok.ok) return reply({ refused: true, awaiting_person: true, approval_id: ok.id, reasons: [ok.message] }, true);
    if (!ok.claim()) return reply({ refused: true, reasons: [`Approval ${ok.id} was already used once`] }, true);
    return null;
  }
  const person = personForCentralWrite(ctx, binding, docPath, 1, details, ctx.env, ctx.now?.());
  if (!person.ok) return reply({ refused: true, awaiting_person: true, approval_id: person.id, reasons: [person.message] }, true);
  return null;
}

export async function runFmcCentral(args: FmcCentralArgs, builder: CentralBuilder = revitCentralBuilder, ctx: CentralRunCtx = {}) {
  const { config } = loadConfig();
  const queue = ctx.queue ?? fileQueue(fileStore(queueFile(config.reports_dir)));
  const tempRoot = ctx.tempRoot ?? DEFAULT_TEMP_ROOT();
  const drive = ctx.drive ?? realDrive;
  const guarded = guardedBuilder(builder, tempRoot, drive.kind);
  if (args.action === "queue_list") return reply({ queue: queue.list().map((j) => ({ id: j.id, target: j.target, queued_at: j.queued_at, blocked_by: j.blocked_by })) });
  if (args.action === "queue_remove") {
    const gate = writeGate(ctx, args, "queue_remove", { tool: "fmc_central", action: "queue_remove", job_id: args.job_id ?? "" }, args.job_id || "central-queue", [`Remove queued central job ${args.job_id ?? ""}`]);
    if (gate) return gate;
    return reply({ removed: queue.remove(args.job_id ?? "") });
  }

  let input = toInput(args);
  let token = args.plan_token ?? "";
  let confirmedBy = args.confirmed_by ?? "";
  let jobId = "";
  if (args.action === "queue_run") {
    const job = queue.list().find((j) => !args.job_id || j.id === args.job_id);
    if (!job) return reply({ empty: true, detail: "Nothing is queued" });
    ({ input, plan_token: token } = job);
    confirmedBy = args.confirmed_by?.trim() || job.confirmed_by;
    jobId = job.id;
  }

  const plan = planCentral(input, config, realReader, drive, tempRoot);
  const view = { ask_user: plan.ask_user, target: plan.target, versioned: plan.versioned, existing: plan.existing, overwrite: plan.overwrite,
    worksets: plan.worksets, source: plan.source, warnings: plan.warnings, plan_token: plan.plan_token };
  if (!plan.ok) return reply({ refused: true, reasons: plan.reasons, plan: view }, true);
  if (args.action === "plan" || (args.action === "create" && args.dry_run !== false))
    return reply({ dry_run: true, would_do: view, next: "Quote ask_user to the person. A real create is a person's action in the Formcraft pane (or Approve there, which runs it). plan_token and confirmed_by are not an approval. Pass batch_lease." });
  if (token !== plan.plan_token)
    return reply({ refused: true, reasons: ["Rule 7: plan_token doesn't match the current plan (something changed): plan again and quote it"] }, true);

  const kind = args.action === "queue_run" ? "queue_run" as const : "create" as const;
  const binding = { tool: "fmc_central", action: kind, plan_token: plan.plan_token, target: plan.target,
    args: { ...args, action: kind === "queue_run" ? "queue_run" : "create", dry_run: false, plan_token: plan.plan_token, job_id: jobId || args.job_id, confirmed_by: confirmedBy } };
  const gate = writeGate(ctx, args, kind, binding, plan.target || input.project_folder, [
    `${kind} central ${plan.name} at ${plan.target}`,
    `worksets ${plan.worksets.join(", ")}`,
    plan.source.kind === "model" ? `detach ${plan.source.path} (${plan.source.detach})` : `template ${plan.source.path}`,
  ]);
  if (gate) return gate;

  if (jobId) queue.remove(jobId);
  const outcome = await runCentral(plan, input, confirmedBy || "person (pane)", {
    builder: guarded, fs: realTxFs(tempRoot, drive.kind), drive, queue, log: csvLog(plan.log_path), now: ctx.now ?? (() => new Date()),
  });
  return reply(outcome, outcome.status === "aborted");
}


/** The pane's Approve runs the stored create as a person. There is no AI path: viaMcp is forced off and FMC_CALLER=pane. */
export async function runCentralFromPane(
  params: unknown,
  ctx: CentralRunCtx = {},
  go: (args: FmcCentralArgs, builder: CentralBuilder | undefined, ctx: CentralRunCtx) => ReturnType<typeof runFmcCentral> = (a, _b, c) => runFmcCentral(a, revitCentralBuilder, c),
) {
  const raw = (params && typeof params === "object" ? params as Record<string, unknown> : {});
  const args = { ...((raw.args && typeof raw.args === "object" ? raw.args : raw) as FmcCentralArgs), dry_run: false };
  return go(args, undefined, { ...ctx, viaMcp: false, env: { ...(ctx.env ?? process.env), FMC_CALLER: "pane" } });
}

export function registerFmcCentralTool(server: McpServer) {
  server.tool("fmc_central", FMC_CENTRAL_DESCRIPTION, FMC_CENTRAL_SHAPE, (args) => runFmcCentral(args, revitCentralBuilder, { viaMcp: true }));
}
