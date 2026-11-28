import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { kitRootFrom } from "../fmc/dynamo.js";
import { inputTooLarge, withResolved } from "../fmc/scriptlib.js";
import { loadConfig } from "../fmc/policy.js";
import { batchLease } from "../fmc/target.js";
import { callDocument, executeQueued, executeScript, namedDocument, protectedInputPaths, runnerClient, runnerKey } from "../fmc/scriptexec.js";
import { scheduleJobs, scriptJobs, type ScriptJob } from "../fmc/scriptjobs.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_SCRIPT_RUN_DESCRIPTION =
  "Run one script from 05_Scripts/library by id. The manifest (index.json plus a manifest per script) must name references.kit, references.standards and references.rulebook. " +
  "runner csharp compiles through send_code_to_revit (the same compile, runtime, timeout and fmc_job behaviour). runner python runs only when the entry does not use the Revit API and FMC_PYTHON is set. " +
  "pyrevit and unavailable are refused. dry_run defaults to true: the script runs and the transaction rolls back. " +
  "The result is a diff: created, modified and deleted ids (capped, with counts) and parameter before and after for modified elements. " +
  "allow_full_scan is refused. An unscoped parameter walk is FMC-SEND-CODE-UNSCOPED. A workshared_safe script that calls CheckoutElements or handles an editing request is refused. " +
  "mode apply needs batch_lease and does not save. Preview never saves and does not trigger autosave. " +
  "submit, status, list, log and cancel use the same background queue as fmc_dynamo. submit returns immediately. " +
  "One job runs at a time per Revit, waiting while Revit is not idle instead of failing. Results are under %LOCALAPPDATA%\\Formcraft\\jobs\\<job_id>\\.";

export const FMC_SCRIPT_RUN_SHAPE = {
  action: z.enum(["run", "submit", "status", "list", "log", "cancel"]).optional().default("run"),
  id: z.string().optional().default("").describe("run, submit: the script id in 05_Scripts/library/index.json"),
  inputs: z.record(z.unknown()).optional().describe("Values for the manifest inputs. At most 50."),
  mode: z.enum(["preview", "apply", "offline"]).optional().describe("preview rolls back. apply keeps changes and needs batch_lease."),
  dry_run: z.boolean().optional().default(true),
  allow_full_scan: z.boolean().optional().describe("Refused. Scope the collector."),
  job_id: z.string().optional().default(""),
  tail: z.number().int().min(1).max(500).optional(),
  state: z.string().optional().default(""),
  priority: z.number().int().min(-100).max(100).optional().default(0),
  label: z.string().optional().default(""),
  kit_folder: z.string().optional().default(""),
  batch_lease: z.string().optional(),
  approval_id: z.string().optional().describe("run, submit: a person's approval (fmc_graph_guard request_approval). Needed for python scripts and for dynamo apply, offline or Python graphs."),
};

export type FmcScriptRunArgs = z.infer<z.ZodObject<typeof FMC_SCRIPT_RUN_SHAPE>>;

function modeOf(args: FmcScriptRunArgs): "preview" | "apply" | "offline" {
  if (args.mode === "offline" || args.mode === "apply" || args.mode === "preview") return args.mode;
  return args.dry_run === false ? "apply" : "preview";
}

function queueOrError() {
  const queue = scriptJobs();
  if (!queue) return { queue: null as null, error: reply({ refused: true, code: "FMC-JOBS-DIR", message: "The job queue needs APPDATA and LOCALAPPDATA, or FMC_JOBS_QUEUE and FMC_LOCAL_JOBS." }, true) };
  return { queue, error: null };
}

export async function runFmcScriptRun(args: FmcScriptRunArgs) {
  const { config } = loadConfig();
  const kit = kitRootFrom(config, process.env, args.kit_folder);
  const named = namedDocument();
  const action = args.action ?? "run";
  try {
    if (action === "list") {
      const found = queueOrError();
      if (!found.queue) return found.error;
      return reply({ jobs: found.queue.list({ state: args.state, document: named || undefined }).map(publicJob), ...found.queue.summary() });
    }
    if (action === "log") {
      const found = queueOrError();
      if (!found.queue) return found.error;
      const row = found.queue.log(args.job_id, args.tail);
      if (!row) return reply({ refused: true, code: "FMC-JOB-NOT-FOUND", message: `[FMC-JOB-NOT-FOUND] No script job ${args.job_id}.` }, true);
      return reply(row);
    }
    if (action === "cancel") {
      const found = queueOrError();
      if (!found.queue) return found.error;
      const row = found.queue.cancel(args.job_id);
      if (!row.ok) return reply({ refused: true, code: row.code, message: row.message }, true);
      return reply({ job_id: row.job.job_id, state: row.job.state, cancel_requested: row.job.cancel_requested });
    }
    if (action === "status") {
      const found = queueOrError();
      if (!found.queue) return found.error;
      const job = found.queue.status(args.job_id.trim());
      if (!job) return reply({ refused: true, code: "FMC-JOB-NOT-FOUND", message: `[FMC-JOB-NOT-FOUND] No script job ${args.job_id}.` }, true);
      return reply(publicJob(job));
    }
    if (!args.id.trim()) return reply({ refused: true, message: "run needs id, a script in the library index." }, true);
    const inputs = args.inputs ?? {};
    const tooMany = inputTooLarge(inputs);
    if (tooMany) return reply({ refused: true, code: "FMC-SCRIPT-LIMIT", message: tooMany }, true);
    const blocked = protectedInputPaths(inputs, config);
    if (blocked.length) return reply({ refused: true, reasons: blocked }, true);
    const mode = modeOf(args);
    if (action === "submit") {
      const doc = callDocument("fmc_script_run");
      if (!doc.ok) return reply(withResolved({ refused: true, code: doc.code, message: doc.message }, null), true);
      const found = queueOrError();
      if (!found.queue) return found.error;
      const made = found.queue.submit({
        kind: "script", document: doc.document?.path || doc.document?.title || named,
        mode, priority: args.priority, label: args.label, batch_lease: (args.batch_lease ?? batchLease.getStore() ?? "").trim(), approval_id: args.approval_id,
        client: runnerClient(), revit_key: runnerKey(), script_id: args.id.trim(), inputs,
      });
      if (!made.ok) return reply(withResolved({ refused: true, code: made.code, message: made.message }, doc.document), true);
      const queue = found.queue;
      scheduleJobs(queue, runnerKey(), (job) => executeQueued(job, {
        cancelled: () => queue.cancelled(job.job_id),
        log: (line) => queue.append(job.job_id, line),
        heartbeat: () => { queue.heartbeatAll(); },
      }));
      return reply(withResolved({ job_id: made.job_id, state: made.state, position: made.position, result_ref: queue.status(made.job_id)?.result_ref }, doc.document));
    }
    const result = await executeScript({ id: args.id.trim(), mode, inputs, cfg: config, kit, allowFullScan: args.allow_full_scan, approvalId: args.approval_id }, {});
    return reply(result, result.refused === true || result.success === false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ error: message, resolved_document: null }, true);
  }
}

function publicJob(job: ScriptJob) {
  return {
    job_id: job.job_id, kind: job.kind, state: job.state, document: job.document, mode: job.mode,
    priority: job.priority, label: job.label, result_ref: job.result_ref, error: job.error || undefined,
    cancel_requested: job.cancel_requested || undefined, heartbeats: job.heartbeats,
    created_at: job.created_at, started_at: job.started_at || undefined, finished_at: job.finished_at || undefined,
  };
}

export function registerFmcScriptRunTool(server: McpServer) {
  server.tool("fmc_script_run", FMC_SCRIPT_RUN_DESCRIPTION, FMC_SCRIPT_RUN_SHAPE, (args) => runFmcScriptRun(args));
}
