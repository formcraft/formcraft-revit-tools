import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitRootFrom, outsideRootMessage, readDyn, approvedScriptPath } from "../fmc/dynamo.js";
import { inputTooLarge, withResolved } from "../fmc/scriptlib.js";
import { loadConfig } from "../fmc/policy.js";
import { documentTarget, batchLease } from "../fmc/target.js";
import { callDocument, executeDynamo, executeQueued, namedDocument, protectedInputPaths, runnerClient, runnerKey } from "../fmc/scriptexec.js";
import { scheduleJobs, scriptJobs, type ScriptJob } from "../fmc/scriptjobs.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_DYNAMO_DESCRIPTION =
  "Run a Dynamo graph from the kit (05_Scripts/library or 05_Scripts/Dynamo) in the open Revit, through Dynamo for Revit. " +
  "Not DynamoSandbox and not send_code. inspect reads the .dyn JSON (inputs, outputs, packages, nodes, Python nodes) and does not start Revit. " +
  "status with no job_id says whether Dynamo for Revit is loaded in this session, and its version. status with job_id, list, log and cancel are the background queue shared with fmc_script_run. " +
  "run and submit take mode preview (rolled back, never saved), apply (kept, needs batch_lease, does not save itself) or offline (DynamoCLI, only when inspect shows no Revit nodes; otherwise FMC-DYNAMO-NEEDS-REVIT). " +
  "If Dynamo for Revit is not loaded, the answer is FMC-DYNAMO-UNAVAILABLE. document is an exact title or path. dry_run defaults to true (preview). " +
  "submit returns {job_id, state:\"queued\", position} and does not block. One job runs at a time per Revit, and only when Revit is idle (FMC-REVIT-NOT-IDLE waits). " +
  "Results are under %LOCALAPPDATA%\\Formcraft\\jobs\\<job_id>\\ (result.json and log.txt). A server restart marks a running job interrupted and does not start it again.";

const MODE = z.enum(["preview", "apply", "offline"]);

export const FMC_DYNAMO_SHAPE = {
  action: z.enum(["inspect", "status", "run", "submit", "list", "log", "cancel"]),
  path: z.string().optional().default("").describe("inspect, run, submit: the .dyn file under 05_Scripts/library or 05_Scripts/Dynamo"),
  inputs: z.record(z.unknown()).optional().describe("Graph inputs by name. At most 50."),
  mode: MODE.optional().describe("preview rolls back. apply keeps changes and needs batch_lease. offline is DynamoCLI with no Revit nodes."),
  dry_run: z.boolean().optional().default(true).describe("Default true: preview. false is apply."),
  job_id: z.string().optional().default("").describe("status, log, cancel: the job id from submit"),
  tail: z.number().int().min(1).max(500).optional().describe("log: last lines. Default 80."),
  state: z.string().optional().default("").describe("list: queued, running, finished, failed, cancelled or interrupted"),
  priority: z.number().int().min(-100).max(100).optional().default(0).describe("submit: higher runs first. Default 0."),
  label: z.string().optional().default("").describe("submit: a short name for the job"),
  kit_folder: z.string().optional().default("").describe("Kit root. Default: the folder above the guard's specs_path, or FMC_KIT."),
  batch_lease: z.string().optional().describe("Required for apply. The lease id from fmc_batch request."),
};

export type FmcDynamoArgs = z.infer<z.ZodObject<typeof FMC_DYNAMO_SHAPE>>;

function modeOf(args: { mode?: "preview" | "apply" | "offline"; dry_run?: boolean }): "preview" | "apply" | "offline" {
  if (args.mode === "offline" || args.mode === "apply" || args.mode === "preview") return args.mode;
  return args.dry_run === false ? "apply" : "preview";
}

function queueOrError() {
  const queue = scriptJobs();
  if (!queue) return { queue: null as null, error: reply({ refused: true, code: "FMC-JOBS-DIR", message: "The job queue needs APPDATA and LOCALAPPDATA, or FMC_JOBS_QUEUE and FMC_LOCAL_JOBS." }, true) };
  return { queue, error: null };
}

function runBackground(job: ScriptJob): Promise<Record<string, unknown>> {
  const queue = scriptJobs();
  return executeQueued(job, {
    cancelled: () => queue?.cancelled(job.job_id) === true,
    log: (line) => queue?.append(job.job_id, line),
    heartbeat: () => { queue?.heartbeatAll(); },
  });
}

export async function runFmcDynamo(args: FmcDynamoArgs) {
  const { config } = loadConfig();
  const kit = kitRootFrom(config, process.env, args.kit_folder);
  const named = namedDocument();
  try {
    if (args.action === "inspect") {
      const doc = named ? callDocument("fmc_dynamo") : { ok: true as const, document: null };
      if (!doc.ok) return reply(withResolved({ refused: true, code: doc.code, message: doc.message }, null), true);
      if (!args.path.trim()) return reply(withResolved({ refused: true, message: "inspect needs path, the .dyn file." }, doc.document), true);
      if (!approvedScriptPath(args.path, kit)) return reply(withResolved({ refused: true, code: "FMC-SCRIPT-ROOT", message: outsideRootMessage(args.path, kit) }, doc.document), true);
      const parsed = readDyn(args.path);
      if (!parsed.ok) return reply(withResolved({ refused: true, code: "FMC-DYNAMO-PARSE", message: parsed.message }, doc.document), true);
      return reply(withResolved({ ...parsed.inspect, action: "inspect" }, doc.document));
    }
    if (args.action === "list") {
      const found = queueOrError();
      if (!found.queue) return found.error;
      const jobs = found.queue.list({ state: args.state, document: named || undefined }).map(publicJob);
      return reply({ jobs, ...found.queue.summary() });
    }
    if (args.action === "log") {
      const found = queueOrError();
      if (!found.queue) return found.error;
      const row = found.queue.log(args.job_id, args.tail);
      if (!row) return reply({ refused: true, code: "FMC-JOB-NOT-FOUND", message: `[FMC-JOB-NOT-FOUND] No script job ${args.job_id}.` }, true);
      return reply(row);
    }
    if (args.action === "cancel") {
      const found = queueOrError();
      if (!found.queue) return found.error;
      const row = found.queue.cancel(args.job_id);
      if (!row.ok) return reply({ refused: true, code: row.code, message: row.message }, true);
      return reply({ job_id: row.job.job_id, state: row.job.state, cancel_requested: row.job.cancel_requested });
    }
    if (args.action === "status" && args.job_id.trim()) {
      const found = queueOrError();
      if (!found.queue) return found.error;
      const job = found.queue.status(args.job_id.trim());
      if (!job) return reply({ refused: true, code: "FMC-JOB-NOT-FOUND", message: `[FMC-JOB-NOT-FOUND] No script job ${args.job_id}.` }, true);
      return reply(publicJob(job));
    }
    if (args.action === "status") {
      const doc = callDocument("fmc_dynamo");
      if (!doc.ok) return reply(withResolved({ refused: true, code: doc.code, message: doc.message }, null), true);
      try {
        const response = await withRevitConnection((client) => client.sendRaw("fmc_dynamo", { action: "status", fmc_caller: "fmc_dynamo" }, 20000)) as Record<string, unknown>;
        return reply(withResolved({ action: "status", ...response }, doc.document), response?.loaded === false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply(withResolved({
          loaded: false, code: "FMC-DYNAMO-UNAVAILABLE",
          message: `[FMC-DYNAMO-UNAVAILABLE] Dynamo for Revit is not available: ${message}`,
        }, doc.document), true);
      }
    }
    const mode = modeOf(args);
    const inputs = args.inputs ?? {};
    const tooMany = inputTooLarge(inputs);
    if (tooMany) return reply({ refused: true, code: "FMC-SCRIPT-LIMIT", message: tooMany }, true);
    const blocked = protectedInputPaths(inputs, config);
    if (blocked.length) return reply({ refused: true, reasons: blocked }, true);
    if (args.action === "submit") {
      const doc = callDocument("fmc_dynamo");
      if (!doc.ok) return reply(withResolved({ refused: true, code: doc.code, message: doc.message }, null), true);
      const found = queueOrError();
      if (!found.queue) return found.error;
      const made = found.queue.submit({
        kind: "dynamo", document: doc.document?.path || doc.document?.title || named,
        mode, priority: args.priority, label: args.label, batch_lease: (args.batch_lease ?? batchLease.getStore() ?? "").trim(),
        client: runnerClient(), revit_key: runnerKey(), graph: args.path, inputs,
      });
      if (!made.ok) return reply(withResolved({ refused: true, code: made.code, message: made.message }, doc.document), true);
      scheduleJobs(found.queue, runnerKey(), runBackground);
      return reply(withResolved({ job_id: made.job_id, state: made.state, position: made.position, result_ref: found.queue.status(made.job_id)?.result_ref }, doc.document));
    }
    const result = await executeDynamo({ file: args.path, mode, inputs, cfg: config, kit }, {});
    return reply(result, result.refused === true || result.success === false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ error: message, resolved_document: null }, true);
  }
}

function publicJob(job: ScriptJob) {
  return {
    job_id: job.job_id, kind: job.kind, state: job.state, document: job.document, mode: job.mode,
    priority: job.priority, label: job.label, position: job.state === "queued" ? undefined : 0,
    result_ref: job.result_ref, error: job.error || undefined, cancel_requested: job.cancel_requested || undefined,
    heartbeats: job.heartbeats, created_at: job.created_at, started_at: job.started_at || undefined, finished_at: job.finished_at || undefined,
  };
}

export function registerFmcDynamoTool(server: McpServer) {
  server.tool("fmc_dynamo", FMC_DYNAMO_DESCRIPTION, FMC_DYNAMO_SHAPE, (args) => runFmcDynamo(args));
}
