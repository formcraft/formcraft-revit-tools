import { AsyncLocalStorage } from "node:async_hooks";
import { jobBusyReason, withBusy } from "./busyreason.js";
import { DOC_REQUIRED, resolveOpenDocument, type DocResolveResult, type OpenDocRef } from "./docresolve.js";

/** Which MCP client a call belongs to. HTTP sets the session id; stdio is one client. */
export const queueClient = new AsyncLocalStorage<string>();

export function currentClient(): string {
  return queueClient.getStore() || "stdio";
}

/** Queue wait is not the Revit execution time. Past this, the call answers queued, not failed. */
export const DEFAULT_QUEUE_WAIT_MS = 10 * 60 * 1000;

export class StillQueued extends Error {
  readonly code = "FMC-QUEUED";
  readonly busy_reason: string;
  constructor(readonly position: number, readonly ahead: number, busyReason = "Revit not idle") {
    super(withBusy(
      `[FMC-QUEUED] Waiting for Revit, position ${position} (${ahead} ahead). Not failed. fmc_queue shows the line. Send the call again if it has not started.`,
      busyReason,
    ));
    this.name = "StillQueued";
    this.busy_reason = busyReason;
  }
}

/** A queued call was removed by fmc_queue cancel or purge_stale. It never started. */
export class QueueCancelled extends Error {
  readonly code = "FMC-QUEUE-CANCELLED";
  readonly busy_reason: string;
  constructor(readonly jobId: string, busyReason: string) {
    super(withBusy(`[FMC-QUEUE-CANCELLED] Queued job ${jobId} was removed before it started. Not failed.`, busyReason));
    this.name = "QueueCancelled";
    this.busy_reason = busyReason;
  }
}

interface Job {
  id: string;
  client: string;
  label: string;
  document: string;
  enqueued: number;
  started: boolean;
  settled: boolean;
  reject: (error: Error) => void;
  run: () => Promise<void>;
}

export interface QueueJobRow {
  job_id: string;
  state: "queued" | "running";
  tool: string;
  caller: string;
  document: string;
  age_s: number;
}

export interface QueueSnapshot {
  running: { job_id: string; client: string; label: string; document: string; since_ms: number } | null;
  waiting: number;
  clients: Array<{ client: string; waiting: number }>;
  jobs: QueueJobRow[];
}

/**
 * One Revit's calls, one at a time, round-robin across clients.
 * A client that enqueues a long batch takes one turn, then the next client runs.
 */
export class FairQueue {
  private readonly lanes = new Map<string, Job[]>();
  private ring: string[] = [];
  private cursor = 0;
  private draining = false;
  private seq = 0;
  private running: { id: string; client: string; label: string; document: string; at: number } | null = null;

  enqueue<T>(client: string, label: string, work: () => Promise<T>, queueWaitMs = DEFAULT_QUEUE_WAIT_MS, document = ""): Promise<T> {
    const name = client || "stdio";
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const job: Job = {
        id: `q${++this.seq}`,
        client: name,
        label,
        document,
        enqueued: Date.now(),
        started: false,
        settled: false,
        reject,
        run: async () => {
          if (timer) clearTimeout(timer);
          if (job.settled) return;
          job.started = true;
          try { resolve(await work()); }
          catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
          finally { job.settled = true; }
        },
      };
      timer = setTimeout(() => {
        if (job.started || job.settled) return;
        this.drop(job);
        job.settled = true;
        const ahead = this.aheadOf(name);
        const running = this.running;
        const reason = running
          ? jobBusyReason(running.label, Math.max(0, Math.round((Date.now() - running.at) / 1000)))
          : "Revit not idle";
        reject(new StillQueued(ahead + 1, ahead, reason));
      }, queueWaitMs);
      const lane = this.lanes.get(name);
      if (lane) lane.push(job);
      else { this.lanes.set(name, [job]); this.ring.push(name); }
      void this.drain();
    });
  }

  snapshot(now = Date.now()): QueueSnapshot {
    const clients = [...this.lanes.entries()].map(([client, jobs]) => ({ client, waiting: jobs.length }));
    const waiting = clients.reduce((sum, row) => sum + row.waiting, 0);
    const jobs: QueueJobRow[] = [];
    if (this.running) {
      jobs.push({
        job_id: this.running.id, state: "running", tool: this.running.label, caller: this.running.client,
        document: this.running.document, age_s: Math.max(0, Math.round((now - this.running.at) / 1000)),
      });
    }
    for (const lane of this.lanes.values()) {
      for (const job of lane) {
        if (job.started) continue;
        jobs.push({
          job_id: job.id, state: "queued", tool: job.label, caller: job.client, document: job.document,
          age_s: Math.max(0, Math.round((now - job.enqueued) / 1000)),
        });
      }
    }
    return {
      running: this.running
        ? { job_id: this.running.id, client: this.running.client, label: this.running.label, document: this.running.document, since_ms: now - this.running.at }
        : null,
      waiting,
      clients,
      jobs,
    };
  }

  /** Drop a job that has not started. A running job is left to the caller. */
  cancelQueued(id: string, now = Date.now()): "cancelled" | "running" | "missing" {
    if (this.running?.id === id) return "running";
    for (const lane of this.lanes.values()) {
      const job = lane.find((item) => item.id === id);
      if (!job) continue;
      if (job.started) return "running";
      this.drop(job);
      if (!job.settled) {
        job.settled = true;
        const running = this.running;
        const reason = running ? jobBusyReason(running.label, Math.max(0, Math.round((now - running.at) / 1000))) : "Revit not idle";
        job.reject(new QueueCancelled(id, reason));
      }
      return "cancelled";
    }
    return "missing";
  }

  /** Queued jobs older than olderThanMs. They have not started, so removing them does not interrupt Revit. */
  purgeQueued(olderThanMs: number, now = Date.now()): QueueJobRow[] {
    const min = Math.max(0, olderThanMs);
    const stale: Job[] = [];
    for (const lane of this.lanes.values()) {
      for (const job of lane) {
        if (job.started) continue;
        if (now - job.enqueued >= min) stale.push(job);
      }
    }
    const rows: QueueJobRow[] = [];
    for (const job of stale) {
      rows.push({
        job_id: job.id, state: "queued", tool: job.label, caller: job.client, document: job.document,
        age_s: Math.max(0, Math.round((now - job.enqueued) / 1000)),
      });
      this.drop(job);
      if (!job.settled) {
        job.settled = true;
        job.reject(new QueueCancelled(job.id, jobBusyReason(job.label, Math.max(0, Math.round((now - job.enqueued) / 1000)))));
      }
    }
    return rows;
  }

  private aheadOf(client: string): number {
    let n = this.running && this.running.client !== client ? 1 : 0;
    for (const name of this.ring) {
      if (name === client) break;
      n += 1;
    }
    return n;
  }

  private drop(job: Job): void {
    const lane = this.lanes.get(job.client);
    if (!lane) return;
    const index = lane.indexOf(job);
    if (index >= 0) lane.splice(index, 1);
    if (lane.length === 0) {
      this.lanes.delete(job.client);
      this.ring = this.ring.filter((name) => name !== job.client);
      if (this.cursor >= this.ring.length) this.cursor = 0;
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (this.ring.length === 0) return;
        if (this.cursor >= this.ring.length) this.cursor = 0;
        const client = this.ring[this.cursor];
        const lane = this.lanes.get(client);
        const job = lane?.shift();
        if (!lane || !job) {
          this.ring.splice(this.cursor, 1);
          continue;
        }
        if (lane.length === 0) {
          this.lanes.delete(client);
          this.ring.splice(this.cursor, 1);
        } else {
          this.cursor += 1;
        }
        this.running = { id: job.id, client, label: job.label, document: job.document, at: Date.now() };
        try { await job.run(); }
        finally { this.running = null; }
      }
    } finally {
      this.draining = false;
      if (this.ring.length > 0) void this.drain();
    }
  }
}

const byPort = new Map<number, FairQueue>();

export function queueFor(port: number): FairQueue {
  let queue = byPort.get(port);
  if (!queue) { queue = new FairQueue(); byPort.set(port, queue); }
  return queue;
}

export function queueSnapshots(): Array<{ port: number } & QueueSnapshot> {
  return [...byPort.entries()].map(([port, queue]) => ({ port, ...queue.snapshot() }));
}

/** Commands that describe the session, not one model. Every other call names its document when several are open. */
const SESSION_COMMANDS = new Set(["fmc_selftest_facts", "fmc_document_info", "fmc_revit", "fmc_doc_background"]);

/**
 * These commands may name a file that is not open yet (they open it, or they describe it from disk).
 * A path that matches no open document is not FMC-DOC-NOT-FOUND, and it is not the active document.
 */
const CLOSED_PATH_COMMANDS = new Set([
  "fmc_doc_open", "fmc_create_document", "fmc_family_new", "fmc_open_copy", "fmc_document_info",
  "fmc_family_inspect", "fmc_family_scan", "fmc_family_bring_in", "fmc_family_host_test",
  "fmc_qa_facts", "fmc_sheet_facts", "fmc_link_facts", "fmc_link_transmission", "fmc_material_facts", "fmc_workshare_facts",
  "fmc_build_facts", "fmc_annotation_facts", "fmc_missing_tags", "fmc_issue_facts", "fmc_issue_export",
  "fmc_analytical_export", "fmc_electrical_facts", "fmc_structural_facts", "fmc_mep_facts",
  "fmc_diagram_scan", "fmc_diagram_drawn", "fmc_find_elements",
]);

/** Optional hints for family-creation exemptions (kind for create_document; template/file for fmc_doc_open). A string is treated as kind, so existing callers stay valid. */
export type DocumentRequiredHints = { kind?: string; template?: string; file?: string };

function hintsOf(hints?: string | DocumentRequiredHints): DocumentRequiredHints {
  if (hints == null) return {};
  if (typeof hints === "string") return { kind: hints };
  return hints;
}

/** Family-document creation does not write an already-open project, so it may omit `document`. */
function isFamilyCreate(command: string, hints: DocumentRequiredHints): boolean {
  if (command === "fmc_family_new") return true;
  if (command === "fmc_create_document" && (hints.kind ?? "").trim().toLowerCase() === "family") return true;
  // A new family from a .rft template, or reopening an existing family file (.rfa). Opening a project (.rvt) still needs a name.
  if (command === "fmc_doc_open") {
    const template = (hints.template ?? "").trim();
    const file = (hints.file ?? "").trim();
    if (template.length > 0 && file.length === 0) return true;
    if (file.length > 0 && template.length === 0 && /\.rfa$/i.test(file)) return true;
    return false;
  }
  return false;
}

export function documentDecision(command: string, openTitles: Array<string | OpenDocRef>, named: string | undefined, hints?: string | DocumentRequiredHints): DocResolveResult {
  const key = (named ?? "").trim();
  const parsed = hintsOf(hints);
  // These never fall back to the active document, even when only one model is open.
  const force = !key && command === "fmc_new_local"
    ? `[${DOC_REQUIRED}] fmc_new_local needs document: the title of the open local to replace. Refusing to use the active document.`
    : !key && command === "fmc_grids_from_link"
      ? `[${DOC_REQUIRED}] fmc_grids_from_link needs document: the host model. Refusing to use the active document.`
      : !key && command === "fmc_coord_apply"
        ? `[${DOC_REQUIRED}] fmc_coord_apply needs document: a title or a full path. Refusing to use the active document.`
        : undefined;
  return resolveOpenDocument({
    named: key,
    open: openTitles,
    allowOmit: !force && (SESSION_COMMANDS.has(command) || isFamilyCreate(command, parsed)),
    allowClosedPath: CLOSED_PATH_COMMANDS.has(command),
    forceMessage: force,
  });
}

export function documentRequired(command: string, openTitles: Array<string | OpenDocRef>, named: string | undefined, hints?: string | DocumentRequiredHints): string | undefined {
  const decision = documentDecision(command, openTitles, named, hints);
  return decision.ok ? undefined : decision.message;
}
