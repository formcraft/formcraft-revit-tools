import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JOB_ID, collectJobs, findJob, jobEnded, jobFiles, jobResult, requestCancel, type JobState } from "../fmc/jobs.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_JOB_DESCRIPTION =
  "Jobs: every call to Revit is a job. A call still running when the bridge must answer (about 50 s) replies " +
    "[FMC-JOB-RUNNING] with a job id: it has not failed. list: recent long jobs, newest first (state: running, " +
    "queued, waiting_for_dialog, finished, failed, cancelled, no_answer). status: one job's state, times and any Revit dialog " +
    "it waits on. result: its final answer (from FMC_LateResults.jsonl). cancel: asks Revit to stop the job at its next " +
    "check (before it starts, at a cancel check, or instead of send_code's commit, which rolls back); shows what will " +
    "happen first, and sends the request with confirm: true. Cancel never closes or interrupts Revit. Read-only " +
    "otherwise: nothing in the model changes. " +
    "list filters: state (one or more), command (part of the name), since (ISO time); each job shows ended, duration_s, port and pid. " +
    "expired: the job's record ends at a dialog that no longer holds Revit (it came between jobs, the same Revit ended later work, " +
    "or 30 min passed with no heartbeat); check the model before running it again. result with wait_s waits up to 45 s for the answer.";

const STATES = ["queued", "running", "waiting_for_dialog", "finished", "failed", "cancelled", "no_answer", "expired"] as const;

export const FMC_JOB_SHAPE = {
  action: z.enum(["list", "status", "result", "cancel"]),
  job: z.string().optional().default("").describe("status, result, cancel: the job id from [FMC-JOB-RUNNING] or list"),
  limit: z.number().int().min(1).max(100).optional().default(20).describe("list: how many jobs"),
  state: z.union([z.enum(STATES), z.array(z.enum(STATES))]).optional().describe("list: only jobs in this state (or these states)"),
  command: z.string().optional().default("").describe("list: only jobs whose command contains this text"),
  since: z.string().optional().default("").describe("list: only jobs started at or after this ISO time"),
  wait_s: z.number().int().min(0).max(45).optional().default(0).describe("result: wait up to this many seconds for the answer while the job runs"),
  confirm: z.boolean().optional().default(false).describe("cancel: true sends the cancel request after the dry run"),
};

export type FmcJobArgs = z.infer<z.ZodObject<typeof FMC_JOB_SHAPE>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runFmcJob(args: FmcJobArgs, env: NodeJS.ProcessEnv = process.env, now: () => number = Date.now) {
  try {
    if (args.action === "list") {
      const all = collectJobs(env, now());
      const states = args.state == null ? null : new Set<JobState>(Array.isArray(args.state) ? args.state : [args.state]);
      const needle = (args.command ?? "").trim().toLowerCase();
      const since = (args.since ?? "").trim() ? Date.parse(args.since!.trim()) : NaN;
      if ((args.since ?? "").trim() && !Number.isFinite(since)) {
        return reply({ refused: true, reasons: [`since must be an ISO time, for example 2026-11-28T06:00:00Z (got "${args.since}")`] }, true);
      }
      const jobs = all.filter((j) => (!states || states.has(j.state))
        && (!needle || j.command.toLowerCase().includes(needle))
        && (!Number.isFinite(since) || (Date.parse(j.started) || 0) >= since));
      return reply({
        jobs: jobs.slice(0, args.limit).map((j) => {
          const ended = jobEnded(j);
          const start = Date.parse(j.revit?.running_since || j.started);
          const duration = ended && Number.isFinite(start) ? Math.max(0, Math.round((Date.parse(ended) - start) / 1000)) : undefined;
          return {
            job: j.job,
            command: j.command || "(not recorded: Revit's record of this job is only a dialog line)",
            started: j.started, state: j.state,
            ...(ended ? { ended } : {}), ...(duration != null ? { duration_s: duration } : {}),
            ...(j.port != null ? { port: j.port } : {}), ...(j.pid != null ? { pid: j.pid } : {}),
            summary: j.summary,
          };
        }),
        total: all.length,
        ...(jobs.length !== all.length ? { matched: jobs.length } : {}),
        files: jobFiles(env),
      });
    }

    const id = args.job.trim();
    if (!JOB_ID.test(id)) return reply({ refused: true, reasons: [`${args.action} needs a job id (from [FMC-JOB-RUNNING] or fmc_job list)`] }, true);
    let job = findJob(id, env, now());

    if (args.action === "status") {
      if (!job) return reply({ job: id, state: "unknown", summary: "No record of this job: it answered in time (its tool showed the result), or the id is wrong. fmc_job list shows the long ones." });
      return reply(job);
    }

    if (args.action === "result") {
      let r = jobResult(id, env);
      const deadline = Date.now() + (args.wait_s ?? 0) * 1000;
      // wait_s: poll the late-results file once a second while the job is still alive.
      while (!r.found && Date.now() < deadline) {
        const state = findJob(id, env, now())?.state;
        if (state !== "running" && state !== "queued") break;
        await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
        r = jobResult(id, env);
      }
      if ((args.wait_s ?? 0) > 0) job = findJob(id, env, now());
      if (!r.found) {
        return reply({ job: id, ready: false, state: job?.state ?? "unknown",
          summary: job?.summary ?? "No result recorded for this job: it answered in time, or the id is wrong." });
      }
      return reply({ job: id, ready: true, state: job?.state, at: r.at, command: r.command, result: r.result,
        ...(r.truncated ? { truncated: true, note: "Cut at 30,000 characters: ask the script for counts and summaries, not element dumps" } : {}) });
    }

    // cancel: dry run first (rule 3), then the request.
    if (!job) return reply({ refused: true, reasons: [`No running job ${id}: nothing to cancel (fmc_job list shows the jobs)`] }, true);
    if (job.state !== "running" && job.state !== "waiting_for_dialog") {
      return reply({ refused: true, reasons: [`Job ${id} is ${job.state}: nothing to cancel`], job }, true);
    }
    const what = {
      job: id, command: job.command, state: job.state,
      will: [
        "write a cancel request Revit checks; Revit is never closed or interrupted",
        "a send_code job, or an fmc_* tool job that resolves a document, not started yet is skipped (nothing changed); fmc_doc and fmc_recipe builds don't check it yet",
        "send_code in transactionMode 'auto': its transaction rolls back instead of committing",
        "a script that calls FmcScript.ThrowIfCancelled() stops there; transactions already committed stay",
        job.state === "waiting_for_dialog" ? "the dialog Revit shows still needs a person: cancel can't answer it" : undefined,
      ].filter(Boolean),
    };
    if (!args.confirm) return reply({ dry_run: true, ...what, next: `fmc_job cancel ${id} confirm: true` });
    const file = requestCancel(id, env);
    return reply({ cancel_requested: true, ...what, file, next: `fmc_job status ${id}` });
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcJobTool(server: McpServer) {
  server.tool("fmc_job", FMC_JOB_DESCRIPTION, FMC_JOB_SHAPE, (args) => runFmcJob(args));
}
