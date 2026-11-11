import { AsyncLocalStorage } from "node:async_hooks";

/** Which MCP client a call belongs to. HTTP sets the session id; stdio is one client. */
export const queueClient = new AsyncLocalStorage<string>();

export function currentClient(): string {
  return queueClient.getStore() || "stdio";
}

/** Queue wait is not the Revit execution time. Past this, the call answers queued, not failed. */
export const DEFAULT_QUEUE_WAIT_MS = 10 * 60 * 1000;

export class StillQueued extends Error {
  readonly code = "FMC-QUEUED";
  constructor(readonly position: number, readonly ahead: number) {
    super(`[FMC-QUEUED] Waiting for Revit, position ${position} (${ahead} ahead). Not failed. fmc_queue shows the line. Send the call again if it has not started.`);
    this.name = "StillQueued";
  }
}

interface Job {
  client: string;
  label: string;
  enqueued: number;
  started: boolean;
  run: () => Promise<void>;
}

export interface QueueSnapshot {
  running: { client: string; label: string; since_ms: number } | null;
  waiting: number;
  clients: Array<{ client: string; waiting: number }>;
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
  private running: { client: string; label: string; at: number } | null = null;

  enqueue<T>(client: string, label: string, work: () => Promise<T>, queueWaitMs = DEFAULT_QUEUE_WAIT_MS): Promise<T> {
    const name = client || "stdio";
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const job: Job = {
        client: name,
        label,
        enqueued: Date.now(),
        started: false,
        run: async () => {
          if (timer) clearTimeout(timer);
          job.started = true;
          try { resolve(await work()); }
          catch (error) { reject(error); }
        },
      };
      timer = setTimeout(() => {
        if (job.started) return;
        this.drop(job);
        const ahead = this.aheadOf(name);
        reject(new StillQueued(ahead + 1, ahead));
      }, queueWaitMs);
      const lane = this.lanes.get(name);
      if (lane) lane.push(job);
      else { this.lanes.set(name, [job]); this.ring.push(name); }
      void this.drain();
    });
  }

  snapshot(): QueueSnapshot {
    const clients = [...this.lanes.entries()].map(([client, jobs]) => ({ client, waiting: jobs.length }));
    const waiting = clients.reduce((sum, row) => sum + row.waiting, 0);
    return {
      running: this.running ? { client: this.running.client, label: this.running.label, since_ms: Date.now() - this.running.at } : null,
      waiting,
      clients,
    };
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
        this.running = { client, label: job.label, at: Date.now() };
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
  // A new family from a .rft template (fmc_recipe / fmc_doc open). Opening an existing .rfa (`file`) still needs a name.
  if (command === "fmc_doc_open") {
    const template = (hints.template ?? "").trim();
    const file = (hints.file ?? "").trim();
    return template.length > 0 && file.length === 0;
  }
  return false;
}

export function documentRequired(command: string, openTitles: string[], named: string | undefined, hints?: string | DocumentRequiredHints): string | undefined {
  if (SESSION_COMMANDS.has(command) || openTitles.length <= 1) return undefined;
  const key = (named ?? "").trim();
  if (!key) {
    if (isFamilyCreate(command, hintsOf(hints))) return undefined;
    return `${openTitles.length} documents are open (${openTitles.join("; ")}). Pass document with a title or a full path on every call. Refusing to use the active document.`;
  }
  const hits = openTitles.filter((title) => title.toLowerCase().includes(key.toLowerCase()));
  if (hits.length > 1) return `"${key}" matches ${hits.length} documents (${hits.join("; ")}). Pass the full path.`;
  return undefined;
}
