import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { batchBoard } from "../fmc/batchline.js";
import { IDLE_BUSY, withBusy } from "../fmc/busyreason.js";
import { queueFor, queueSnapshots } from "../fmc/fairqueue.js";
import { readInstances } from "../fmc/connect.js";
import { inFlightJob, readRevitJobLines } from "../fmc/notidle.js";
import { queueBusyReason,
  decideCancel, markRevitCancelled, openRevitJobs, purgeFair, rowFromFair, rowFromLease, selectStale,
  type LeaseRow, type QueueListRow,
} from "../fmc/queueops.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_QUEUE_DESCRIPTION =
  "The Revit waiting line, per instance. list: every queued or running job with its age, document, tool, lease holder and caller, " +
  "and a busy_reason (job running X for N s, lease held by Y on doc Z, modal dialog title, RAM gate, transaction open, or Revit not idle). " +
  "cancel {job_id}: a queued job only. A running job is refused with FMC-JOB-RUNNING unless it is stale and Revit is idle. " +
  "purge_stale {older_than_min}: drop queued jobs older than that many minutes. dry_run defaults to true and changes nothing. " +
  "A stale queued job is not left blocking the next call with no reason. /health carries the same busy_reason. " +
  "Reads are not blocked. Cancel never closes Revit.";

const shape = {
  action: z.enum(["list", "cancel", "purge_stale"]).optional().default("list"),
  job_id: z.string().optional().default("").describe("cancel: the job id from list"),
  older_than_min: z.number().min(0).optional().default(5).describe("purge_stale: queued jobs older than this many minutes"),
  dry_run: z.boolean().optional().default(true).describe("purge_stale: true lists them and removes nothing"),
};

export type FmcQueueArgs = z.infer<z.ZodObject<typeof shape>>;

function holders(): LeaseRow[] {
  const snap = batchBoard().snapshot() as { documents?: Array<Record<string, unknown>> };
  const rows: LeaseRow[] = [];
  for (const doc of snap.documents ?? []) {
    const holder = doc.holder as { lease?: string; bot?: string; client?: string; label?: string; since?: string } | null;
    if (!holder?.lease) continue;
    rows.push({
      lease: String(holder.lease),
      document: String(doc.document ?? ""),
      bot: String(holder.bot ?? ""),
      client: String(holder.client ?? ""),
      label: String(holder.label ?? ""),
      since: holder.since,
    });
  }
  return rows;
}

function holderFor(document: string): string {
  const row = holders().find((item) => item.document && document && item.document.toLowerCase() === document.toLowerCase());
  return row ? (row.bot || row.client) : "";
}

export function listQueue(env: NodeJS.ProcessEnv = process.env, now = Date.now()): QueueListRow[] {
  const lines = readRevitJobLines(env);
  const instances = readInstances(env);
  const idleByPort = new Map<number, boolean>();
  for (const instance of instances) idleByPort.set(instance.port, inFlightJob(lines, instance.pid, now) == null);
  const rows: QueueListRow[] = [];
  for (const snap of queueSnapshots()) {
    const idle = idleByPort.get(snap.port) !== false;
    for (const job of snap.jobs) rows.push(rowFromFair(job, `port ${snap.port}`, idle, holderFor(job.document)));
  }
  for (const job of openRevitJobs(env, now)) {
    if (rows.some((row) => row.job_id === job.job_id)) continue;
    rows.push(job);
  }
  for (const lease of holders()) {
    if (rows.some((row) => row.job_id === lease.lease)) continue;
    rows.push(rowFromLease(lease, now));
  }
  return rows.sort((a, b) => b.age_s - a.age_s);
}

function findRow(id: string, rows: QueueListRow[]): QueueListRow | null {
  return rows.find((row) => row.job_id === id) ?? null;
}

function portOf(instance: string): number | undefined {
  const match = /port (\d+)/.exec(instance);
  return match ? Number(match[1]) : undefined;
}

export async function runFmcQueue(args: FmcQueueArgs, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const rows = listQueue(env, now);
  // Not rows[0]: the oldest row is often a stale log entry while Revit is idle (live test 23 Nov 2026).
  const busy = queueBusyReason(rows);
  const staleCount = rows.filter((row) => row.stale && row.revit_idle).length;
  if (args.action === "list" || !args.action) {
    return reply({
      tool: "fmc_queue",
      action: "list",
      read_only: true,
      count: rows.length,
      jobs: rows,
      batches: batchBoard().snapshot(),
      busy_reason: busy,
      stale_count: staleCount,
      ...(staleCount ? { stale_note: `${staleCount} log entr${staleCount === 1 ? "y says" : "ies say"} running while Revit is idle. They are not live and do not block calls. fmc_queue cancel job_id clears one.` } : {}),
    });
  }
  if (args.action === "cancel") {
    const id = args.job_id.trim();
    if (!id) return reply({ tool: "fmc_queue", refused: true, code: "FMC-QUEUE-UNKNOWN", message: "cancel needs job_id.", busy_reason: IDLE_BUSY }, true);
    const row = findRow(id, rows);
    const decision = decideCancel(row, busy);
    if (!decision.ok) {
      return reply({
        tool: "fmc_queue", refused: true, code: decision.code, job_id: id, job: row,
        message: withBusy(`[${decision.code}] ${decision.message}`, decision.busy_reason),
        busy_reason: decision.busy_reason,
      }, true);
    }
    const fair = portOf(row?.instance ?? "");
    let fairResult: "cancelled" | "running" | "missing" = "missing";
    if (fair != null) fairResult = queueFor(fair).cancelQueued(id, now);
    else {
      for (const snap of queueSnapshots()) {
        const hit = queueFor(snap.port).cancelQueued(id, now);
        if (hit !== "missing") { fairResult = hit; break; }
      }
    }
    if (fairResult === "running" && !(row?.stale && row.revit_idle)) {
      return reply({
        tool: "fmc_queue", refused: true, code: "FMC-JOB-RUNNING", job_id: id,
        message: withBusy(`[FMC-JOB-RUNNING] ${row?.tool ?? id} is running.`, decision.busy_reason),
        busy_reason: decision.busy_reason,
      }, true);
    }
    if (row?.source === "revit" || fairResult === "missing") {
      try { markRevitCancelled(id, row?.tool ?? "", env); } catch (error) {
        return reply({ tool: "fmc_queue", refused: true, message: error instanceof Error ? error.message : String(error), busy_reason: decision.busy_reason }, true);
      }
    }
    return reply({
      tool: "fmc_queue", action: "cancel", cancelled: true, job_id: id, state: row?.state, command: row?.tool,
      fair: fairResult, busy_reason: decision.busy_reason, message: decision.message,
    });
  }
  const older = args.older_than_min ?? 5;
  const stale = selectStale(rows, older);
  if (args.dry_run !== false) {
    return reply({
      tool: "fmc_queue", action: "purge_stale", dry_run: true, older_than_min: older,
      count: stale.length, jobs: stale, busy_reason: busy,
      next: "Purge with dry_run false. Queued jobs only. Running jobs stay.",
    });
  }
  const ports = [...new Set(queueSnapshots().map((snap) => snap.port))];
  const fair = purgeFair(older, ports, now);
  const revit: string[] = [];
  for (const row of stale) {
    if (row.source !== "revit") continue;
    if (fair.some((item) => item.job_id === row.job_id)) continue;
    try { markRevitCancelled(row.job_id, row.tool, env); revit.push(row.job_id); } catch { /* one bad id does not stop the rest */ }
  }
  return reply({
    tool: "fmc_queue", action: "purge_stale", dry_run: false, older_than_min: older,
    removed: { fair: fair.map((item) => item.job_id), revit },
    busy_reason: stale[0]?.busy_reason ?? null,
  });
}

export function registerFmcQueueTool(server: McpServer) {
  server.tool("fmc_queue", FMC_QUEUE_DESCRIPTION, shape, (args) => runFmcQueue(args));
}
