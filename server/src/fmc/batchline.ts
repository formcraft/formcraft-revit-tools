/**
 * Document leases for discipline bots that share one Revit.
 *
 * One active lease per document, FIFO. Different documents run at once; their Revit calls still take the fair queue.
 * A lease is bound to the MCP session that requested it, and every model-changing call must also pass that lease id.
 * Reads are never blocked (WRITE_COMMANDS in policy.ts, the same list reconnect.ts uses for single-retry).
 *
 * A failed batch is not put straight back. The bot's next request for the same label or batch id joins the tail
 * with attempt + 1. Attempts are unlimited. A retry must say what changed, and must not repeat the same references.
 * More than three attempts is marked struggling: visible, not blocking. Nothing here rolls the model back.
 * The waiting line is written to FMC_BatchLine.json. A restart restores it. An active lease does not stay held:
 * it is put back at the head of its line, and the bot asks for the same label again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WRITE_COMMANDS, loadConfig } from "./policy.js";
import { SYNC_NOT_RUN, batchCareReport, correctionHelp, type CorrectionHelp } from "./batchcare.js";
import { planSync, syncDocumentKey, syncSettings, syncSkip, type SyncRun } from "./batchsync.js";
import { memoryGate, onMemoryResume } from "./memory.js";
import { loadBatchLine, MAINTENANCE_REASON, readMaintenance, saveBatchLine, writeMaintenance, type StoredTicket } from "./batchstore.js";
import { batchLease, documentTarget } from "./target.js";
import { queueClient } from "./fairqueue.js";

const win = path.win32;

export const DEFAULT_IDLE_S = 120;
export const DEFAULT_MAX_S = 30 * 60;
export const DEFAULT_REQUIRED_REFERENCES = ["kit", "standards", "rulebook"] as const;
export const HISTORY_LIMIT = 20;
export const WAIT_MAX_S = 60;
const DONE_LIMIT = 200;

export class BatchGateError extends Error {
  readonly code: "FMC-BATCH-LOCKED" | "FMC-BATCH-NOREFS" | "FMC-BATCH-SAMEFIX" | "FMC-BATCH-BAD" | "FMC-BATCH-SCHEDULER";
  constructor(code: BatchGateError["code"], message: string) {
    super(message);
    this.name = "BatchGateError";
    this.code = code;
  }
}

export interface BatchReferences { [category: string]: string[] }

export interface ReferenceValidation { ok: boolean; message?: string }

/** Presence is checked first. This hook is for a later id check against the kit. The default accepts every id. */
export type BatchReferenceValidator = (
  refs: BatchReferences,
  ctx: { document: string; label: string; batchId: string; bot: string },
) => ReferenceValidation | Promise<ReferenceValidation>;

export interface BatchConfig {
  idleMs: number;
  maxMs: number;
  requiredReferences: string[];
}

export interface GrantNotice {
  client: string;
  lease: string;
  document: string;
  label: string;
  bot: string;
  attempt: number;
}

export type BatchEnd = "release" | "expired" | "max_duration" | "disconnect";

export type SaveStep = (ctx: { document: string; label: string; client: string; lease: string; summary: string }) => Promise<{ ran: boolean; ok: boolean; detail: string }>;

export interface BatchBoardOptions {
  now?: () => number;
  idleMs?: number;
  maxMs?: number;
  requiredReferences?: string[];
  autoSweep?: boolean;
  sweepEveryMs?: number;
  validator?: BatchReferenceValidator | null;
  log?: (line: string) => void;
  /** Runs while the lease is still held, before the next bot is granted. Production uses the existing auto-save. */
  saveStep?: SaveStep;
  /** Runs after a successful save, while the lease is still held. A failure does not fail the batch. */
  syncStep?: (ctx: { document: string; label: string; changedAt: number | null; lastSyncAt: number | null }) => Promise<SyncRun>;
  /** When true, a free document stays queued instead of being granted. */
  memoryPaused?: () => boolean;
  /** Shown on status. Null when this board is not the service. */
  memoryView?: () => Record<string, unknown> | null;
  /** batch.maintenance. Null when grants may proceed. Production reads the file. */
  readMaintenance?: () => string | null;
  /** Writes the file the updater and fmc_batch drain share. */
  writeMaintenance?: (reason: string | null) => void;
  /** Persists the waiting line. Production writes FMC_BatchLine.json. */
  persistLine?: (tickets: StoredTicket[]) => void;
}

const defaultValidator: BatchReferenceValidator = () => ({ ok: true });
let externalValidator: BatchReferenceValidator | null = null;

/** Install a reference-id check. Null restores the default, which does not call the kit. */
export function setBatchReferenceValidator(fn: BatchReferenceValidator | null): void {
  externalValidator = fn;
  board?.setValidator(fn);
}

export function serviceConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA || win.join(os.homedir(), "AppData", "Roaming");
  return win.join(appData, "Formcraft", "fmc_http.json");
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** fmc_http.json `batch` plus FMC_BATCH_* env overrides. Missing file means the defaults. */
export function loadBatchConfig(env: NodeJS.ProcessEnv = process.env, read?: (file: string) => string): BatchConfig {
  let fileBatch: Record<string, unknown> = {};
  try {
    const text = (read ?? ((p) => fs.readFileSync(p, "utf8")))(serviceConfigFile(env));
    const parsed = JSON.parse(String(text).replace(/^\uFEFF/, "")) as { batch?: Record<string, unknown> };
    if (parsed && typeof parsed.batch === "object" && parsed.batch) fileBatch = parsed.batch;
  } catch { /* defaults */ }
  const fromEnv = env.FMC_BATCH_REQUIRED_REFS;
  const fromFile = Array.isArray(fileBatch.required_references)
    ? (fileBatch.required_references as unknown[]).map((item) => String(item).trim()).filter(Boolean)
    : undefined;
  const required = (fromEnv ? fromEnv.split(",").map((item) => item.trim()).filter(Boolean) : fromFile) ?? [...DEFAULT_REQUIRED_REFERENCES];
  return {
    idleMs: positive(env.FMC_BATCH_IDLE_S ?? fileBatch.idle_s, DEFAULT_IDLE_S) * 1000,
    maxMs: positive(env.FMC_BATCH_MAX_S ?? fileBatch.max_s, DEFAULT_MAX_S) * 1000,
    requiredReferences: required,
  };
}

/** Title, path or file name, so "Architecture" and "D:\\Models\\Architecture.rvt" are one document. */
export function documentKey(name: string): string {
  return syncDocumentKey(name);
}

/** Names that may reserve the next slot. An absent setting is Hostel Building Bot. An empty list is nobody. */
export function schedulerNames(cfg: { batch_schedulers?: string[] } | undefined): string[] {
  if (!cfg || !Array.isArray(cfg.batch_schedulers)) return ["Hostel Building Bot"];
  return cfg.batch_schedulers.map((name) => String(name).trim()).filter(Boolean);
}

/** True when the MCP client or the bot field is a scheduler. */
export function isScheduler(client: string, bot: string, names: string[]): boolean {
  const want = new Set(names.map((name) => name.toLowerCase()));
  return want.has(client.trim().toLowerCase()) || want.has(bot.trim().toLowerCase());
}

export function documentsMatch(held: string, asked: string | undefined): boolean {
  if (!asked || !asked.trim()) return false;
  const a = documentKey(held);
  const b = documentKey(asked);
  return a.length > 0 && a === b;
}

export function normalizeReferences(input: unknown, required: readonly string[]): { refs: BatchReferences; missing: string[] } {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const refs: BatchReferences = {};
  const missing: string[] = [];
  const categories = [...required];
  for (const key of Object.keys(src)) if (!categories.includes(key)) categories.push(key);
  for (const category of categories) {
    const raw = src[category];
    const list = Array.isArray(raw)
      ? raw.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
      : [];
    if (list.length) refs[category] = list;
    else if (required.includes(category)) missing.push(category);
  }
  return { refs, missing };
}

interface Ticket {
  id: string;
  document: string;
  key: string;
  label: string;
  batchId: string;
  bot: string;
  client: string;
  estOps?: number;
  references: BatchReferences;
  referencesHash: string;
  correction: string;
  /** A scheduler placed this at the head. The named bot's next request takes the client. */
  reserved?: boolean;
  state: "queued" | "active";
  attempt: number;
  requestedAt: number;
  grantedAt?: number;
  lastBeat: number;
  ops: number;
  writesInFlight: number;
}

interface AttemptState {
  failures: number;
  lastError: string;
  referencesHash: string;
  lastCorrection: string;
  help?: CorrectionHelp;
  bot: string;
  label: string;
  batchId: string;
  document: string;
  references: BatchReferences;
}

interface HistoryRow {
  lease: string;
  document: string;
  label: string;
  batch_id: string;
  bot: string;
  attempt: number;
  outcome: "ok" | "failed";
  end: BatchEnd;
  summary: string;
  error?: string;
  ops: number;
  started: string;
  ended: string;
  duration_ms: number;
  wait_ms: number;
  references: BatchReferences;
  struggling?: boolean;
  correction?: CorrectionHelp;
  save?: { ran: boolean; ok: boolean; detail: string };
  sync?: { ran: boolean; detail: string; error?: string };
}

interface BotStat {
  bot: string;
  batches: number;
  failures: number;
  retries: number;
  waitMs: number;
  durationMs: number;
  finished: number;
  lastReferences: BatchReferences | null;
  lastDocument: string | null;
  lastLabel: string | null;
  lastClient: string | null;
}

interface DoneRow {
  state: "done";
  outcome: "ok" | "failed";
  end: BatchEnd;
  error?: string;
  summary: string;
  attempt: number;
  struggling?: boolean;
  document: string;
  label: string;
  batch_id: string;
  bot: string;
  ops: number;
  references: BatchReferences;
  correction?: CorrectionHelp;
}

export interface RequestInput {
  document: string;
  label: string;
  estOps?: number;
  batchId?: string;
  bot?: string;
  references?: unknown;
  correction?: string;
  client: string;
}

function copyRefs(refs: BatchReferences): BatchReferences {
  const out: BatchReferences = {};
  for (const [key, value] of Object.entries(refs)) out[key] = [...value];
  return out;
}

export class BatchBoard {
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxMs: number;
  private readonly required: string[];
  private validator: BatchReferenceValidator;
  private readonly sink: (line: string) => void;
  private readonly saveStep?: SaveStep;
  private readonly syncStep?: BatchBoardOptions["syncStep"];
  private readonly memoryPausedFn: () => boolean;
  private readonly memoryViewFn: () => Record<string, unknown> | null;
  private readonly readMaintenanceFn: () => string | null;
  private readonly watchMaintenance: boolean;
  private readonly writeMaintenanceFn: (reason: string | null) => void;
  private readonly persistLineFn: (tickets: StoredTicket[]) => void;
  /** Set while a hot-swap is draining. New leases stay queued. Active leases finish. */
  private maintenanceReason: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private stopMemory: () => void = () => {};
  private readonly tickets = new Map<string, Ticket>();
  private readonly syncState = new Map<string, { document: string; lastSyncAt: number | null; changedAt: number | null; lastError: string | null }>();
  private readonly lines = new Map<string, string[]>();
  private readonly holders = new Map<string, string>();
  private readonly names = new Map<string, string>();
  private readonly attempts = new Map<string, AttemptState>();
  private readonly history = new Map<string, HistoryRow[]>();
  private readonly bots = new Map<string, BotStat>();
  private readonly done = new Map<string, DoneRow>();
  private readonly doneOrder: string[] = [];
  private readonly listeners = new Set<(notice: GrantNotice) => void>();

  constructor(opts: BatchBoardOptions = {}) {
    const cfg = loadBatchConfig();
    this.now = opts.now ?? (() => Date.now());
    this.idleMs = opts.idleMs ?? cfg.idleMs;
    this.maxMs = opts.maxMs ?? cfg.maxMs;
    this.required = [...(opts.requiredReferences ?? cfg.requiredReferences)];
    this.validator = opts.validator === undefined ? (externalValidator ?? defaultValidator) : (opts.validator ?? defaultValidator);
    this.sink = opts.log ?? ((line) => console.error(line));
    this.saveStep = opts.saveStep;
    this.syncStep = opts.syncStep;
    this.memoryPausedFn = opts.memoryPaused ?? (() => false);
    this.memoryViewFn = opts.memoryView ?? (() => null);
    this.readMaintenanceFn = opts.readMaintenance ?? (() => null);
    this.watchMaintenance = opts.readMaintenance != null;
    this.writeMaintenanceFn = opts.writeMaintenance ?? (() => {});
    this.persistLineFn = opts.persistLine ?? (() => {});
    if (opts.autoSweep) {
      this.timer = setInterval(() => { try { this.sweep(); } catch (error) { this.emit(`sweep failed: ${error instanceof Error ? error.message : error}`); } }, opts.sweepEveryMs ?? 1000);
      this.timer.unref?.();
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.timer = undefined;
    this.syncTimer = undefined;
    this.stopMemory();
    this.stopMemory = () => {};
  }

  /** Production only: pause grants while memory is low, and sync idle workshared models. */
  bindService(): void {
    this.stopMemory();
    this.stopMemory = onMemoryResume(() => this.grantPaused());
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = setInterval(() => { void this.syncIdle().catch((error) => this.emit(`sync failed: ${error instanceof Error ? error.message : error}`)); }, 30_000);
    this.syncTimer.unref?.();
  }

  noteServiceStart(restored = 0): void {
    this.emit(restored > 0
      ? `service start. Restored ${restored} queued lease(s). An active lease is not still held; it is at the head of its line. Nothing was rolled back.`
      : "service start. Leases cleared. No queued leases on disk. Nothing was rolled back. Bots request a new lease.");
  }

  setValidator(fn: BatchReferenceValidator | null): void {
    this.validator = fn ?? defaultValidator;
  }

  listen(fn: (notice: GrantNotice) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  configView(): { idle_s: number; max_s: number; required_references: string[] } {
    return {
      idle_s: Math.round(this.idleMs / 1000),
      max_s: Math.round(this.maxMs / 1000),
      required_references: [...this.required],
    };
  }

  async request(input: RequestInput): Promise<Record<string, unknown>> {
    this.sweep();
    const document = input.document?.trim() ?? "";
    const label = input.label?.trim() ?? "";
    if (!document || !label) {
      throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] request needs document and label.");
    }
    const { refs, missing } = normalizeReferences(input.references, this.required);
    if (missing.length) {
      throw new BatchGateError("FMC-BATCH-NOREFS",
        `[FMC-BATCH-NOREFS] A batch must name what it works from. Missing: ${missing.join(", ")}. ` +
        `Each of ${this.required.join(", ")} needs at least one id in references.`);
    }
    const batchId = (input.batchId?.trim() || label);
    const bot = (input.bot?.trim() || label);
    const ctx = { document, label, batchId, bot };
    let verdict: ReferenceValidation;
    try {
      verdict = await this.validator(copyRefs(refs), ctx);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw new BatchGateError("FMC-BATCH-NOREFS", `[FMC-BATCH-NOREFS] The reference check failed: ${text}`);
    }
    if (!verdict.ok) {
      const text = verdict.message?.trim() || "The reference check refused this batch.";
      throw new BatchGateError("FMC-BATCH-NOREFS", text.startsWith("[FMC-") ? text : `[FMC-BATCH-NOREFS] ${text}`);
    }
    const key = documentKey(document);
    this.names.set(key, document);
    const attemptKey = this.attemptKey(key, batchId);
    const prior = this.attempts.get(attemptKey);
    if (prior && prior.failures > 0) {
      const note = (input.correction ?? "").trim();
      if (!note || note === prior.lastCorrection || referencesHash(refs) === prior.referencesHash) {
        throw new BatchGateError("FMC-BATCH-SAMEFIX",
          `[FMC-BATCH-SAMEFIX] This retry repeats the failed attempt. Pass correction (what you changed) and different references. ` +
          `It is not parked: change the kit, standards or rulebook ids and request again. Last error: ${prior.lastError}`);
      }
    }
    const existing = [...this.tickets.values()].find((ticket) => ticket.key === key && ticket.batchId.toLowerCase() === batchId.toLowerCase());
    if (existing) {
      if (existing.reserved && existing.bot.toLowerCase() === bot.toLowerCase()) {
        existing.client = input.client;
        existing.reserved = false;
        const head = (this.lines.get(key) ?? [])[0];
        if (existing.state !== "active" && head === existing.id && !this.holders.has(key) && !this.heldForMemory() && !this.maintenanceReason) this.grant(existing, false);
        this.persist();
        return this.ticketView(existing);
      }
      if (existing.client === input.client) return this.ticketView(existing);
      throw new BatchGateError("FMC-BATCH-BAD",
        `[FMC-BATCH-BAD] Batch "${label}" is already ${existing.state === "active" ? "running" : "in line"} on ${document} for another session. ` +
        `Wait, or use a new label for a different batch.`);
    }
    const attempt = (prior?.failures ?? 0) + 1;
    const ticket: Ticket = {
      id: randomUUID(),
      document, key, label, batchId, bot, client: input.client,
      estOps: input.estOps && input.estOps > 0 ? Math.floor(input.estOps) : undefined,
      references: copyRefs(refs),
      referencesHash: referencesHash(refs),
      correction: (input.correction ?? "").trim(),
      state: "queued",
      attempt,
      requestedAt: this.now(),
      lastBeat: this.now(),
      ops: 0,
      writesInFlight: 0,
    };
    this.pullMaintenance();
    this.tickets.set(ticket.id, ticket);
    const stat = this.botStat(bot);
    stat.lastReferences = copyRefs(refs);
    stat.lastDocument = document;
    stat.lastLabel = label;
    stat.lastClient = input.client;
    if (attempt > 1) stat.retries += 1;
    if (!this.holders.has(key) && !this.heldForMemory() && !this.maintenanceReason) this.grant(ticket, false);
    else {
      const line = this.lines.get(key) ?? [];
      line.push(ticket.id);
      this.lines.set(key, line);
      if (this.maintenanceReason) this.emit(`${this.maintenanceReason}; queued ${this.where(ticket)} position ${line.length}`);
      else if (this.heldForMemory()) this.emit(`paused for memory; queued ${this.where(ticket)} position ${line.length}`);
      else this.emit(`queued ${this.where(ticket)} position ${line.length} attempt ${attempt}`);
    }
    this.persist();
    return this.ticketView(ticket);
  }

  /**
   * A scheduler places a named bot's label at the head of the line (the next slot, not the lease that is running).
   * The named bot's own request takes that ticket.
   */
  async reserve(input: RequestInput): Promise<Record<string, unknown>> {
    this.pullMaintenance();
    const document = input.document?.trim() ?? "";
    const label = input.label?.trim() ?? "";
    const bot = (input.bot?.trim() || "");
    if (!document || !label || !bot) throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] reserve needs document, label and bot.");
    if (!isScheduler(input.client, bot, schedulerNames(loadConfig().config))) {
      throw new BatchGateError("FMC-BATCH-SCHEDULER",
        "[FMC-BATCH-SCHEDULER] reserve is only for a scheduler in batch_schedulers, matched on the MCP client or the bot field. Hostel Building Bot is the scheduler.");
    }
    const { refs, missing } = normalizeReferences(input.references, this.required);
    if (missing.length) {
      throw new BatchGateError("FMC-BATCH-NOREFS",
        `[FMC-BATCH-NOREFS] A batch must name what it works from. Missing: ${missing.join(", ")}.`);
    }
    const key = documentKey(document);
    this.names.set(key, document);
    const batchId = (input.batchId?.trim() || label);
    const existing = [...this.tickets.values()].find((ticket) => ticket.key === key && ticket.batchId.toLowerCase() === batchId.toLowerCase());
    if (existing) return this.ticketView(existing);
    const ticket: Ticket = {
      id: randomUUID(), document, key, label, batchId, bot, client: bot,
      estOps: input.estOps && input.estOps > 0 ? Math.floor(input.estOps) : undefined,
      references: copyRefs(refs), referencesHash: referencesHash(refs), correction: "",
      reserved: true, state: "queued", attempt: 1, requestedAt: this.now(), lastBeat: this.now(), ops: 0, writesInFlight: 0,
    };
    this.tickets.set(ticket.id, ticket);
    const line = this.lines.get(key) ?? [];
    line.unshift(ticket.id);
    this.lines.set(key, line);
    this.emit(`reserved ${this.where(ticket)} at the head for ${bot}`);
    this.persist();
    return this.ticketView(ticket);
  }

  status(lease?: string, client?: string): Record<string, unknown> {
    this.sweep();
    if (lease) return this.one(lease);
    const yours = [...this.tickets.values()].filter((ticket) => !client || ticket.client === client).map((ticket) => this.ticketView(ticket));
    return { yours, ...this.snapshot() };
  }

  heartbeat(lease: string, client: string): Record<string, unknown> {
    this.sweep();
    const ticket = this.tickets.get(lease);
    if (!ticket || ticket.client !== client) throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] heartbeat needs the lease this session holds or is waiting on.");
    if (ticket.state === "active") ticket.lastBeat = this.now();
    return this.ticketView(ticket);
  }

  release(lease: string, outcome: "ok" | "failed", client: string, summary?: string, error?: string): Record<string, unknown> {
    this.sweep();
    const ticket = this.tickets.get(lease);
    if (!ticket || ticket.client !== client) throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] release needs the lease this session holds.");
    if (ticket.state !== "active") throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] That lease is still queued. cancel leaves the line; release is for the batch you are running.");
    if (outcome !== "ok" && outcome !== "failed") throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] release needs outcome ok or failed.");
    const text = outcome === "failed" ? (error?.trim() || summary?.trim() || "failed") : undefined;
    return this.endActive(ticket, outcome, "release", text, summary?.trim() ?? "");
  }

  /** Save, if the existing auto-save says so, while this lease still holds the document. Then release. */
  async releaseWithCare(lease: string, outcome: "ok" | "failed", client: string, summary?: string, error?: string): Promise<Record<string, unknown>> {
    this.sweep();
    const ticket = this.tickets.get(lease);
    if (!ticket || ticket.client !== client) throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] release needs the lease this session holds.");
    if (ticket.state !== "active") throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] That lease is still queued. cancel leaves the line; release is for the batch you are running.");
    if (outcome !== "ok" && outcome !== "failed") throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] release needs outcome ok or failed.");
    let finalOutcome = outcome;
    let text = outcome === "failed" ? (error?.trim() || summary?.trim() || "failed") : undefined;
    let care: { save?: { ran: boolean; ok: boolean; detail: string }; sync?: { ran: boolean; detail: string; error?: string } } | undefined;
    if (outcome === "ok" && this.saveStep) {
      const held = this.beginCall(ticket.id, client);
      try {
        const save = await queueClient.run(client, () => batchLease.run(ticket.id, () => documentTarget.run(ticket.document, () =>
          this.saveStep!({ document: ticket.document, label: ticket.label, client, lease: ticket.id, summary: summary?.trim() ?? "" }))));
        care = { save, sync: { ran: false, detail: SYNC_NOT_RUN } };
        if (save.ran && !save.ok) {
          finalOutcome = "failed";
          text = save.detail;
        }
      } finally {
        held.finish();
      }
    }
    if (finalOutcome === "ok" && this.syncStep) {
      const held = this.beginCall(ticket.id, client);
      try {
        const sync = await queueClient.run(client, () => batchLease.run(ticket.id, () => documentTarget.run(ticket.document, () =>
          this.syncStep!({
            document: ticket.document,
            label: ticket.label,
            changedAt: this.syncState.get(ticket.key)?.changedAt ?? this.now(),
            lastSyncAt: this.syncState.get(ticket.key)?.lastSyncAt ?? null,
          }))));
        this.applySync(ticket.document, sync);
        const row = { ran: sync.ran, detail: sync.detail, ...(sync.error ? { error: sync.error } : {}) };
        care = care ? { ...care, sync: row } : { sync: row };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.applySync(ticket.document, { ran: true, ok: true, synced: false, detail: `Sync did not finish. The batch is not failed. ${message}`, error: message });
        const row = { ran: true, detail: `Sync did not finish. The batch is not failed. ${message}`, error: message };
        care = care ? { ...care, sync: row } : { sync: row };
      } finally {
        held.finish();
      }
    }
    return this.endActive(ticket, finalOutcome, "release", text, summary?.trim() ?? "", care);
  }

  cancel(lease: string, client: string): Record<string, unknown> {
    this.sweep();
    const ticket = this.tickets.get(lease);
    if (!ticket || ticket.client !== client) throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] cancel needs a queued lease from this session.");
    if (ticket.state === "active") throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] This lease is running. release it with outcome ok or failed.");
    const line = this.lines.get(ticket.key) ?? [];
    this.lines.set(ticket.key, line.filter((id) => id !== ticket.id));
    this.tickets.delete(ticket.id);
    this.rememberDone(ticket, { state: "done", outcome: "failed", end: "release", summary: "cancelled while queued", attempt: ticket.attempt, document: ticket.document, label: ticket.label, batch_id: ticket.batchId, bot: ticket.bot, ops: 0, references: ticket.references });
    this.wake(ticket.id);
    this.emit(`cancelled queued ${this.where(ticket)}`);
    this.persist();
    return { ok: true, state: "cancelled", lease: ticket.id, document: ticket.document, label: ticket.label, attempt: ticket.attempt };
  }

  /** Drop every ticket for a session. An active lease counts as failed. Nothing is rolled back. */
  disconnect(client: string): number {
    const owned = [...this.tickets.values()].filter((ticket) => ticket.client === client);
    for (const ticket of owned) {
      if (ticket.state === "active") {
        this.endActive(ticket, "failed", "disconnect", "Client disconnected while holding the lease. The model was not rolled back.");
      } else {
        const line = this.lines.get(ticket.key) ?? [];
        this.lines.set(ticket.key, line.filter((id) => id !== ticket.id));
        this.tickets.delete(ticket.id);
        this.rememberDone(ticket, {
          state: "done", outcome: "failed", end: "disconnect",
          summary: "disconnected while queued", attempt: ticket.attempt, document: ticket.document,
          label: ticket.label, batch_id: ticket.batchId, bot: ticket.bot, ops: 0, references: ticket.references,
        });
        this.wake(ticket.id);
        this.emit(`disconnect dropped queued ${this.where(ticket)}`);
      }
    }
    this.persist();
    return owned.length;
  }

  /** Expire leases with no heartbeat or write, and leases past the hard maximum. */
  sweep(at = this.now()): string[] {
    this.pullMaintenance();
    const expired: string[] = [];
    for (const id of [...this.holders.values()]) {
      const ticket = this.tickets.get(id);
      if (!ticket || ticket.client === "fmc-sync") continue;
      const hard = at - (ticket.grantedAt ?? ticket.requestedAt) >= this.maxMs;
      const idle = ticket.writesInFlight === 0 && at - ticket.lastBeat >= this.idleMs;
      if (hard) {
        this.endActive(ticket, "failed", "max_duration", "Lease reached the hard maximum. The model was not rolled back.");
        expired.push(id);
      } else if (idle) {
        this.endActive(ticket, "failed", "expired", `Lease expired after ${Math.round(this.idleMs / 1000)}s without a heartbeat or a write. The model was not rolled back.`);
        expired.push(id);
      }
    }
    return expired;
  }

  /**
   * The fair queue may hold a write before Revit runs it. That wait is still a write call:
   * idle expiry does not drop the lease while it is queued or running. A wrong session is not counted.
   */
  beginCall(lease: string, client: string): { finish: () => void } {
    const ticket = this.tickets.get(lease);
    if (!ticket || ticket.state !== "active" || ticket.client !== client) return { finish() {} };
    ticket.writesInFlight += 1;
    ticket.lastBeat = this.now();
    let finished = false;
    return {
      finish: () => {
        if (finished) return;
        finished = true;
        const current = this.tickets.get(lease);
        if (!current) return;
        current.writesInFlight = Math.max(0, current.writesInFlight - 1);
        current.lastBeat = this.now();
      },
    };
  }

  /**
   * A model-changing call. Reads never reach here. No active lease: the call is allowed.
   * An active lease requires this session and this lease id.
   */
  admit(document: string | undefined, lease: string | undefined, client: string): { finish: () => void } {
    this.sweep();
    const holder = this.holderFor(document);
    if (!holder) return { finish() {} };
    if (holder.client !== client || !lease || lease !== holder.id) {
      throw new BatchGateError("FMC-BATCH-LOCKED", this.lockedMessage(holder, client));
    }
    if (client !== "fmc-sync" && document) this.noteChange(document);
    holder.writesInFlight += 1;
    holder.lastBeat = this.now();
    holder.ops += 1;
    let finished = false;
    return {
      finish: () => {
        if (finished) return;
        finished = true;
        const current = this.tickets.get(holder.id);
        if (!current) return;
        current.writesInFlight = Math.max(0, current.writesInFlight - 1);
        current.lastBeat = this.now();
      },
    };
  }

  async wait(lease: string, timeoutS: number): Promise<Record<string, unknown>> {
    const cap = Math.min(WAIT_MAX_S, Math.max(0, timeoutS));
    const first = this.one(lease);
    if (first.state !== "queued" || cap === 0) return first;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, cap * 1000);
      const wrapped = () => done();
      const bucket = this.waiters(lease);
      bucket.add(wrapped);
      function done() {
        clearTimeout(timer);
        bucket.delete(wrapped);
        resolve();
      }
    });
    return this.one(lease);
  }

  snapshot(): Record<string, unknown> {
    const documents = [...new Set([...this.holders.keys(), ...this.lines.keys(), ...this.history.keys()])]
      .sort()
      .map((key) => this.documentView(key))
      .filter((row) => row.holder || (row.line as unknown[]).length || (row.history as unknown[]).length);
    const struggling = [...this.tickets.values()].filter((ticket) => ticket.attempt > 3).map((ticket) => ({
      document: ticket.document, label: ticket.label, batch_id: ticket.batchId, bot: ticket.bot,
      attempts: ticket.attempt, state: ticket.state === "active" ? "granted" : ticket.state, struggling: true,
    }));
    for (const row of this.attempts.values()) {
      if (row.failures <= 3) continue;
      if (struggling.some((item) => item.batch_id.toLowerCase() === row.batchId.toLowerCase() && documentKey(item.document) === documentKey(row.document))) continue;
      struggling.push({ document: row.document, label: row.label, batch_id: row.batchId, bot: row.bot, attempts: row.failures, state: "between retries", struggling: true });
    }
    const bots = [...this.bots.values()].sort((a, b) => a.bot.localeCompare(b.bot)).map((row) => ({
      bot: row.bot,
      batches: row.batches,
      failures: row.failures,
      retries: row.retries,
      avg_wait_ms: row.finished ? Math.round(row.waitMs / row.finished) : 0,
      avg_duration_ms: row.finished ? Math.round(row.durationMs / row.finished) : 0,
      last_references: row.lastReferences ? copyRefs(row.lastReferences) : null,
      last_document: row.lastDocument,
      last_label: row.lastLabel,
      last_client: row.lastClient,
    }));
    const memory = this.safeMemory();
    return {
      ...this.configView(), ...batchCareReport(), ...(memory ? { memory } : {}),
      maintenance: this.maintenanceReason != null,
      maintenance_reason: this.maintenanceReason,
      syncs: this.syncRows(), documents, struggling, bots,
    };
  }

  private holderFor(document: string | undefined): Ticket | undefined {
    const actives = [...this.holders.values()].map((id) => this.tickets.get(id)).filter((ticket): ticket is Ticket => !!ticket);
    if (document && document.trim()) return actives.find((ticket) => documentsMatch(ticket.document, document));
    if (actives.length === 1) return actives[0];
    if (actives.length > 1) {
      throw new BatchGateError("FMC-BATCH-LOCKED",
        `[FMC-BATCH-LOCKED] ${actives.length} documents are held (${actives.map((ticket) => ticket.document).join("; ")}). Pass document and batch_lease. Reads are still allowed.`);
    }
    return undefined;
  }

  private lockedMessage(holder: Ticket, client: string): string {
    const who = `${holder.bot} (${holder.label}, since ${new Date(holder.grantedAt ?? holder.requestedAt).toISOString()}, ${holder.ops} ops)`;
    const line = this.lines.get(holder.key) ?? [];
    const mine = line.findIndex((id) => this.tickets.get(id)?.client === client);
    let position: string;
    if (holder.client === client && holder.id) {
      position = leaseHint(holder);
    } else if (mine >= 0) {
      position = `You are position ${mine + 1} of ${line.length}.`;
    } else {
      position = "You are not in line. Call fmc_batch request for this document.";
    }
    const idNote = holder.client === client ? ` Your lease is ${holder.id}.` : "";
    return `[FMC-BATCH-LOCKED] ${holder.document} is held by ${who}. ${position}${idNote} Pass batch_lease on each model-changing call. Reads are still allowed.`;
  }

  /**
   * Stop granting. Requests stay queued with the reason. Active leases finish.
   * The reason is also the batch.maintenance file when this board is the service.
   */
  setMaintenance(on: boolean, reason = MAINTENANCE_REASON): Record<string, unknown> {
    const next = on ? (reason.trim() || MAINTENANCE_REASON) : null;
    this.maintenanceReason = next;
    try { this.writeMaintenanceFn(next); } catch (error) { this.emit(`maintenance file failed: ${error instanceof Error ? error.message : error}`); }
    if (!next) this.resumeGrants();
    this.persist();
    return this.snapshot();
  }

  /** Read batch.maintenance when the service wired a reader. */
  pullMaintenance(): void {
    if (!this.watchMaintenance) return;
    let reason: string | null;
    try { reason = this.readMaintenanceFn(); } catch { return; }
    if (reason === this.maintenanceReason) return;
    this.maintenanceReason = reason;
    if (!reason) this.resumeGrants();
  }

  private grant(ticket: Ticket, notify: boolean): void {
    ticket.state = "active";
    ticket.grantedAt = this.now();
    ticket.lastBeat = ticket.grantedAt;
    this.holders.set(ticket.key, ticket.id);
    const line = this.lines.get(ticket.key) ?? [];
    this.lines.set(ticket.key, line.filter((id) => id !== ticket.id));
    this.emit(`granted ${this.where(ticket)} attempt ${ticket.attempt}`);
    if (notify) {
      const notice: GrantNotice = { client: ticket.client, lease: ticket.id, document: ticket.document, label: ticket.label, bot: ticket.bot, attempt: ticket.attempt };
      for (const listener of this.listeners) {
        try { listener(notice); } catch (error) { this.emit(`grant notice failed: ${error instanceof Error ? error.message : error}`); }
      }
    }
    this.wake(ticket.id);
    this.persist();
  }

  private promote(key: string): void {
    if (this.maintenanceReason) {
      const line = this.lines.get(key) ?? [];
      this.emit(`${this.maintenanceReason}; ${line.length} queued lease(s) stay on ${this.names.get(key) ?? key}`);
      for (const id of line) this.wake(id);
      return;
    }
    if (this.heldForMemory()) {
      const line = this.lines.get(key) ?? [];
      this.emit(`paused for memory; ${line.length} queued lease(s) stay on ${this.names.get(key) ?? key}`);
      for (const id of line) this.wake(id);
      return;
    }
    const line = this.lines.get(key) ?? [];
    while (line.length) {
      const id = line.shift()!;
      const next = this.tickets.get(id);
      if (!next) continue;
      this.lines.set(key, line);
      this.grant(next, true);
      return;
    }
    this.holders.delete(key);
    this.lines.delete(key);
  }

  private endActive(ticket: Ticket, outcome: "ok" | "failed", end: BatchEnd, error?: string, summary = "", care?: { save?: { ran: boolean; ok: boolean; detail: string }; sync?: { ran: boolean; detail: string } }): Record<string, unknown> {
    const ended = this.now();
    const started = ticket.grantedAt ?? ended;
    const wait = Math.max(0, started - ticket.requestedAt);
    const duration = Math.max(0, ended - started);
    const row: HistoryRow = {
      lease: ticket.id, document: ticket.document, label: ticket.label, batch_id: ticket.batchId, bot: ticket.bot,
      attempt: ticket.attempt, outcome, end, summary, ...(error ? { error } : {}), ops: ticket.ops,
      started: new Date(started).toISOString(), ended: new Date(ended).toISOString(),
      duration_ms: duration, wait_ms: wait, references: copyRefs(ticket.references),
      ...(care?.save ? { save: care.save } : {}),
      ...(care?.sync ? { sync: care.sync } : {}),
    };
    const hist = this.history.get(ticket.key) ?? [];
    hist.unshift(row);
    this.history.set(ticket.key, hist.slice(0, HISTORY_LIMIT));
    const stat = this.botStat(ticket.bot);
    stat.finished += 1;
    stat.waitMs += wait;
    stat.durationMs += duration;
    stat.lastReferences = copyRefs(ticket.references);
    stat.lastDocument = ticket.document;
    stat.lastLabel = ticket.label;
    stat.lastClient = ticket.client;
    let help: CorrectionHelp | undefined;
    if (outcome === "ok") {
      stat.batches += 1;
      this.attempts.delete(this.attemptKey(ticket.key, ticket.batchId));
      this.emit(`released ok ${this.where(ticket)} ops ${ticket.ops} in ${duration}ms. Not rolled back.`);
    } else {
      stat.failures += 1;
      help = correctionHelp({ error: error || "failed", references: ticket.references, label: ticket.label, bot: ticket.bot });
      const key = this.attemptKey(ticket.key, ticket.batchId);
      const prior = this.attempts.get(key) ?? {
        failures: 0, lastError: "", referencesHash: ticket.referencesHash, lastCorrection: "", bot: ticket.bot,
        label: ticket.label, batchId: ticket.batchId, document: ticket.document, references: ticket.references,
      };
      prior.failures += 1;
      prior.lastError = error || "failed";
      prior.referencesHash = ticket.referencesHash;
      prior.lastCorrection = ticket.correction;
      prior.help = help;
      prior.references = copyRefs(ticket.references);
      prior.bot = ticket.bot;
      this.attempts.set(key, prior);
      this.emit(`failed ${this.where(ticket)} attempt ${ticket.attempt} (${end}). Next request for this label joins the tail with a different correction. The model was not rolled back.`);
    }
    if (help) row.correction = help;
    if (ticket.attempt > 3) row.struggling = true;
    const struggling = ticket.attempt > 3;
    const done: DoneRow = {
      state: "done", outcome, end, ...(error ? { error } : {}), summary, attempt: ticket.attempt, struggling,
      document: ticket.document, label: ticket.label, batch_id: ticket.batchId, bot: ticket.bot, ops: ticket.ops,
      references: copyRefs(ticket.references), ...(help ? { correction: help } : {}),
    };
    this.rememberDone(ticket, done);
    this.holders.delete(ticket.key);
    this.tickets.delete(ticket.id);
    this.wake(ticket.id);
    this.promote(ticket.key);
    this.persist();
    return { ok: true, ...done, lease: ticket.id };
  }

  private rememberDone(ticket: Ticket, row: DoneRow): void {
    this.done.set(ticket.id, row);
    this.doneOrder.push(ticket.id);
    while (this.doneOrder.length > DONE_LIMIT) {
      const old = this.doneOrder.shift();
      if (old) this.done.delete(old);
    }
  }

  private ticketView(ticket: Ticket): Record<string, unknown> {
    const line = this.lines.get(ticket.key) ?? [];
    const index = line.indexOf(ticket.id);
    const position = ticket.state === "active" ? 0 : index + 1;
    const eta = ticket.state === "queued" ? this.eta(ticket.key, position) : { eta_hint_s: 0, eta_basis: "granted" };
    const holderId = this.holders.get(ticket.key);
    const holder = holderId ? this.tickets.get(holderId) : undefined;
    return {
      ok: true,
      state: ticket.state === "active" ? "granted" : ticket.state,
      lease: ticket.id,
      document: ticket.document,
      label: ticket.label,
      batch_id: ticket.batchId,
      bot: ticket.bot,
      attempt: ticket.attempt,
      struggling: ticket.attempt > 3,
      position,
      ahead: ticket.state === "active" ? 0 : Math.max(0, position - 1) + (holder ? 1 : 0),
      ops: ticket.ops,
      est_ops: ticket.estOps ?? null,
      references: copyRefs(ticket.references),
      ...this.syncFields(ticket.key),
      ...this.memoryFields(ticket),
      ...eta,
      ...(holder && ticket.state === "queued" ? {
        holder: { label: holder.label, bot: holder.bot, since: new Date(holder.grantedAt ?? holder.requestedAt).toISOString(), ops: holder.ops },
      } : {}),
    };
  }

  private one(lease: string): Record<string, unknown> {
    const ticket = this.tickets.get(lease);
    if (ticket) return this.ticketView(ticket);
    const done = this.done.get(lease);
    if (done) return { ok: true, lease, ...done, references: copyRefs(done.references) };
    return { ok: false, state: "unknown", lease, message: "No batch with that lease. It may have been cleared when the service restarted." };
  }

  private eta(key: string, position: number): { eta_hint_s: number; eta_basis: string } {
    let ms = 0;
    let basis = "default";
    const holderId = this.holders.get(key);
    const holder = holderId ? this.tickets.get(holderId) : undefined;
    if (holder) {
      const avg = this.average(holder.bot);
      const elapsed = Math.max(0, this.now() - (holder.grantedAt ?? this.now()));
      if (holder.estOps && holder.estOps > holder.ops) {
        const per = holder.ops > 0 ? elapsed / holder.ops : 2000;
        ms += (holder.estOps - holder.ops) * per;
        basis = "est_ops";
      } else if (avg > 0) {
        ms += Math.max(0, avg - elapsed);
        basis = "history";
      } else {
        ms += 60_000;
      }
    }
    const line = this.lines.get(key) ?? [];
    for (let i = 0; i < position - 1 && i < line.length; i++) {
      const ahead = this.tickets.get(line[i]);
      if (!ahead) continue;
      const avg = this.average(ahead.bot);
      ms += avg || (ahead.estOps ? ahead.estOps * 2000 : 60_000);
      if (basis === "default" && avg) basis = "history";
    }
    return { eta_hint_s: Math.max(0, Math.round(ms / 1000)), eta_basis: basis };
  }

  private average(bot: string): number {
    const stat = this.bots.get(bot.toLowerCase());
    return stat && stat.finished ? stat.durationMs / stat.finished : 0;
  }

  private documentView(key: string): Record<string, unknown> {
    const holderId = this.holders.get(key);
    const holder = holderId ? this.tickets.get(holderId) : undefined;
    const line = [];
    for (const [index, id] of (this.lines.get(key) ?? []).entries()) {
      const ticket = this.tickets.get(id);
      if (!ticket) continue;
      line.push({
        position: index + 1, lease: ticket.id, label: ticket.label, batch_id: ticket.batchId, bot: ticket.bot,
        attempt: ticket.attempt, est_ops: ticket.estOps ?? null,
        waiting_s: Math.max(0, Math.round((this.now() - ticket.requestedAt) / 1000)),
        struggling: ticket.attempt > 3,
        references: copyRefs(ticket.references), client: ticket.client,
      });
    }
    return {
      document: this.names.get(key) ?? holder?.document ?? this.history.get(key)?.[0]?.document ?? key,
      holder: holder ? {
        lease: holder.id, label: holder.label, batch_id: holder.batchId, bot: holder.bot, attempt: holder.attempt,
        since: new Date(holder.grantedAt ?? holder.requestedAt).toISOString(), ops: holder.ops,
        est_ops: holder.estOps ?? null, struggling: holder.attempt > 3, references: copyRefs(holder.references), client: holder.client,
      } : null,
      line,
      ...this.syncFields(key),
      history: (this.history.get(key) ?? []).map((row) => ({ ...row, references: copyRefs(row.references) })),
    };
  }

  private botStat(bot: string): BotStat {
    const key = bot.toLowerCase();
    let stat = this.bots.get(key);
    if (!stat) {
      stat = { bot, batches: 0, failures: 0, retries: 0, waitMs: 0, durationMs: 0, finished: 0, lastReferences: null, lastDocument: null, lastLabel: null, lastClient: null };
      this.bots.set(key, stat);
    }
    stat.bot = bot;
    return stat;
  }

  private attemptKey(doc: string, batchId: string): string {
    return `${doc}\0${batchId.trim().toLowerCase()}`;
  }

  private where(ticket: Ticket): string {
    return `document=${ticket.document} label=${ticket.label} bot=${ticket.bot} lease=${ticket.id.slice(0, 8)}`;
  }

  private readonly waiterMap = new Map<string, Set<() => void>>();

  private waiters(id: string): Set<() => void> {
    let set = this.waiterMap.get(id);
    if (!set) { set = new Set(); this.waiterMap.set(id, set); }
    return set;
  }

  private wake(id: string): void {
    const set = this.waiterMap.get(id);
    if (!set) return;
    this.waiterMap.delete(id);
    for (const fn of set) fn();
  }

  private heldForMemory(): boolean {
    try { return this.memoryPausedFn(); }
    catch (error) { this.emit(`memory check failed: ${error instanceof Error ? error.message : error}`); return false; }
  }

  private safeMemory(): Record<string, unknown> | null {
    try { return this.memoryViewFn(); }
    catch { return null; }
  }

  private memoryFields(ticket: Ticket): Record<string, unknown> {
    const memory = this.safeMemory();
    const paused = ticket.state !== "active" && this.heldForMemory();
    const free = memory?.free_mb ?? "?";
    const below = memory?.pause_below_mb ?? 1024;
    const above = memory?.resume_above_mb ?? 1536;
    return {
      ...(memory ? { memory } : {}),
      ...(paused ? {
        paused_for_memory: true,
        message: `Paused for memory: ${free} MB free, below ${below} MB. This lease stays queued and is not failed. It grants when free memory is above ${above} MB. wait holds until then or timeout_s. Reads still work.`,
      } : {}),
      ...(this.maintenanceReason && ticket.state !== "active" ? {
        maintenance: true,
        reason: this.maintenanceReason,
        message: `${this.maintenanceReason}. This lease stays queued and is not failed. It grants when maintenance ends. An active lease finishes.`,
      } : {}),
    };
  }

  /**
   * After Revit is recovered: the lease that was running goes to the tail. Nothing is rolled back.
   * Call resumeAfterRecovery once the documents are open again.
   */
  requeueForRecovery(document?: string): { requeued: Array<{ lease: string; document: string; label: string; position: number }> } {
    const keys = document ? [documentKey(document)] : [...this.holders.keys()];
    const requeued: Array<{ lease: string; document: string; label: string; position: number }> = [];
    for (const key of keys) {
      const id = this.holders.get(key);
      if (!id) continue;
      const ticket = this.tickets.get(id);
      if (!ticket || ticket.client === "fmc-sync") continue;
      ticket.state = "queued";
      this.holders.delete(key);
      const line = this.lines.get(key) ?? [];
      line.push(ticket.id);
      this.lines.set(key, line);
      requeued.push({ lease: ticket.id, document: ticket.document, label: ticket.label, position: line.length });
      this.emit(`requeued after recovery ${this.where(ticket)} at position ${line.length}. The model was not rolled back.`);
      this.wake(ticket.id);
    }
    return { requeued };
  }

  /** Grant the head of each line once recovery has reopened the documents. */
  resumeAfterRecovery(): string[] {
    const granted: string[] = [];
    if (this.heldForMemory()) return granted;
    for (const key of [...this.lines.keys()]) {
      if (this.holders.has(key)) continue;
      const next = (this.lines.get(key) ?? [])[0];
      this.promote(key);
      if (next && this.holders.get(key) === next) granted.push(next);
    }
    return granted;
  }

  /** Grant heads that waited only because memory was low. */
  grantPaused(): void {
    if (this.heldForMemory()) return;
    for (const key of [...this.lines.keys()]) {
      if (this.holders.has(key)) continue;
      this.promote(key);
    }
  }

  private noteChange(document: string): void {
    const key = documentKey(document);
    const row = this.syncState.get(key) ?? { document, lastSyncAt: null, changedAt: null, lastError: null };
    row.document = this.names.get(key) ?? document;
    row.changedAt = this.now();
    this.syncState.set(key, row);
  }

  private applySync(document: string, sync: SyncRun): void {
    const key = documentKey(document);
    const row = this.syncState.get(key) ?? { document, lastSyncAt: null, changedAt: null, lastError: null };
    row.document = document;
    if (sync.synced) {
      row.lastSyncAt = this.now();
      row.lastError = null;
    } else if (sync.error) row.lastError = sync.error;
    else if (/Not workshared|is not synced|Protected original|Sync is off|Excluded by sync_exclude|Not in sync_documents/.test(sync.detail)) row.changedAt = row.lastSyncAt;
    this.syncState.set(key, row);
    this.emit(`sync ${document}: ${sync.detail}`);
  }

  private syncFields(key: string): { last_sync: string | null; next_sync: string | null; last_error: string | null; excluded: boolean } {
    const settings = syncSettings(loadConfig().config);
    const row = this.syncState.get(key);
    if (!row) return { last_sync: null, next_sync: null, last_error: null, excluded: syncSkip(key, settings) != null };
    const plan = planSync(
      { workshared: true, stopAi: false, aiOn: true },
      { now: this.now(), lastSyncAt: row.lastSyncAt, changedAt: row.changedAt, leaseHeld: this.holders.has(key), batchEnd: false },
      settings,
      row.document,
    );
    return { last_sync: plan.last_sync, next_sync: plan.next_sync, last_error: row.lastError, excluded: plan.excluded };
  }

  private syncRows(): Array<{ document: string; last_sync: string | null; next_sync: string | null; last_error: string | null; excluded: boolean }> {
    return [...this.syncState.entries()].map(([key, row]) => ({ document: row.document, ...this.syncFields(key) }));
  }

  /**
   * Hold the document so other writes queue, run fn, then let the line move.
   * Used for a sync that is not someone's batch. Undefined when a batch already holds it, or memory is paused.
   */
  async withServiceHold<T>(document: string, fn: () => Promise<T>): Promise<T | undefined> {
    const key = documentKey(document);
    if (this.holders.has(key) || this.heldForMemory()) return undefined;
    const now = this.now();
    const id = `sync-${randomUUID()}`;
    const ticket: Ticket = {
      id, document, key, label: "sync", batchId: "sync", bot: "sync", client: "fmc-sync",
      references: {}, referencesHash: "", correction: "", state: "active", attempt: 1,
      requestedAt: now, grantedAt: now, lastBeat: now, ops: 0, writesInFlight: 1,
    };
    this.tickets.set(id, ticket);
    this.holders.set(key, id);
    this.names.set(key, document);
    this.emit(`sync hold ${document}`);
    try {
      return await queueClient.run("fmc-sync", () => batchLease.run(id, () => documentTarget.run(document, fn)));
    } finally {
      if (this.holders.get(key) === id) this.holders.delete(key);
      this.tickets.delete(id);
      this.emit(`sync release ${document}`);
      this.promote(key);
    }
  }

  /** Between batches: sync workshared documents that are due. No-op when Revit has published none. */
  async syncIdle(): Promise<void> {
    if (this.heldForMemory()) return;
    const settings = syncSettings(loadConfig().config);
    if (settings.minutes <= 0) return;
    const { readInstances } = await import("./connect.js");
    const { productionSyncStep } = await import("./batchsync.js");
    const docs = readInstances().flatMap((instance) => instance.documents ?? []).filter((doc) => doc.workshared && doc.title);
    for (const doc of docs) {
      const key = documentKey(doc.title);
      if (syncSkip(doc.title, settings, doc.path)) continue;
      if (this.holders.has(key)) continue;
      const state = this.syncState.get(key);
      if (!state?.changedAt || (state.lastSyncAt != null && state.changedAt <= state.lastSyncAt)) continue;
      const anchor = state.lastSyncAt ?? state.changedAt;
      if (this.now() - anchor < settings.minutes * 60_000) continue;
      const ran = await this.withServiceHold(doc.title, () => productionSyncStep({
        document: doc.title, label: "idle", changedAt: state.changedAt, lastSyncAt: state.lastSyncAt, batchEnd: false,
      }));
      if (!ran) continue;
      this.applySync(doc.title, ran);
      if (!ran.synced && !ran.ran) {
        const row = this.syncState.get(key);
        if (row) row.changedAt = row.lastSyncAt;
      }
    }
  }

  /** Put a saved line back. Tickets stay queued until resumeGrants. */
  importLine(tickets: StoredTicket[]): number {
    let n = 0;
    for (const row of tickets) {
      if (this.tickets.has(row.id)) continue;
      const key = documentKey(row.document);
      const ticket: Ticket = {
        id: row.id, document: row.document, key, label: row.label, batchId: row.batchId, bot: row.bot, client: row.client,
        estOps: row.estOps, references: copyRefs(row.references), referencesHash: referencesHash(row.references),
        correction: row.correction ?? "", reserved: row.reserved === true, state: "queued", attempt: row.attempt || 1,
        requestedAt: row.requestedAt || this.now(), lastBeat: this.now(), ops: 0, writesInFlight: 0,
      };
      this.tickets.set(ticket.id, ticket);
      this.names.set(key, row.document);
      const line = this.lines.get(key) ?? [];
      line.push(ticket.id);
      this.lines.set(key, line);
      n += 1;
    }
    return n;
  }

  resumeGrants(): string[] {
    if (this.maintenanceReason || this.heldForMemory()) return [];
    const granted: string[] = [];
    for (const key of [...this.lines.keys()]) {
      if (this.holders.has(key)) continue;
      const next = (this.lines.get(key) ?? [])[0];
      this.promote(key);
      if (next && this.holders.get(key) === next) granted.push(next);
    }
    return granted;
  }

  private exportLine(): StoredTicket[] {
    const out: StoredTicket[] = [];
    const keys = new Set<string>([...this.holders.keys(), ...this.lines.keys()]);
    for (const key of keys) {
      const holderId = this.holders.get(key);
      const holder = holderId ? this.tickets.get(holderId) : undefined;
      const ordered: Ticket[] = [];
      if (holder && holder.client !== "fmc-sync") ordered.push(holder);
      for (const id of this.lines.get(key) ?? []) {
        const ticket = this.tickets.get(id);
        if (ticket) ordered.push(ticket);
      }
      for (const ticket of ordered) {
        out.push({
          id: ticket.id, document: ticket.document, label: ticket.label, batchId: ticket.batchId, bot: ticket.bot,
          client: ticket.client, references: copyRefs(ticket.references), correction: ticket.correction,
          attempt: ticket.attempt, requestedAt: ticket.requestedAt, ...(ticket.estOps ? { estOps: ticket.estOps } : {}),
          ...(ticket.reserved ? { reserved: true } : {}),
        });
      }
    }
    return out;
  }

  private persist(): void {
    try { this.persistLineFn(this.exportLine()); }
    catch (error) { this.emit(`batch line was not saved: ${error instanceof Error ? error.message : error}`); }
  }

  private emit(text: string): void {
    let line = text.startsWith("fmc batch:") ? text : `fmc batch: ${text}`;
    if (/bearer\s|mcp-http\.token|authorization:/i.test(line)) line = "fmc batch: log line dropped because it looked like a credential";
    try { this.sink(line); } catch { /* logging must not stop the line */ }
  }
}

function referencesHash(refs: BatchReferences): string {
  const text = Object.keys(refs).sort().map((key) => `${key}:${[...refs[key]].sort().join(",")}`).join("|");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function leaseHint(holder: Ticket): string {
  return `This session holds it.`;
}

let board: BatchBoard | undefined;

function productionBoard(opts: BatchBoardOptions): BatchBoard {
  const made = new BatchBoard({
    memoryPaused: () => memoryGate.leasesPaused(),
    memoryView: () => memoryGate.view() as unknown as Record<string, unknown>,
    saveStep: (ctx) => import("./batchsave.js").then((mod) => mod.productionSaveStep(ctx)),
    syncStep: (ctx) => import("./batchsync.js").then((mod) => mod.productionSyncStep(ctx)),
    readMaintenance,
    writeMaintenance,
    persistLine: (tickets) => { try { saveBatchLine(tickets); } catch { /* the next change tries again */ } },
    ...opts,
  });
  made.bindService();
  return made;
}

export function batchBoard(): BatchBoard {
  if (!board) board = productionBoard({ autoSweep: true });
  return board;
}

export function addGrantListener(fn: (notice: GrantNotice) => void): () => void {
  return batchBoard().listen(fn);
}

export function resetBatchBoard(opts: BatchBoardOptions = {}): BatchBoard {
  board?.close();
  const cfg = loadBatchConfig();
  board = new BatchBoard({
    idleMs: cfg.idleMs,
    maxMs: cfg.maxMs,
    requiredReferences: cfg.requiredReferences,
    autoSweep: false,
    ...opts,
  });
  return board;
}

/** Process start. In-memory leases do not survive a restart, and the model is not rolled back. */
export function logBatchRestart(): BatchBoard {
  board?.close();
  board = productionBoard({ ...loadBatchConfig(), autoSweep: true });
  const restored = board.importLine(loadBatchLine());
  board.pullMaintenance();
  if (!board.snapshot().maintenance) board.resumeGrants();
  board.noteServiceStart(restored);
  return board;
}

/**
 * Model-changing calls only. The write list is WRITE_COMMANDS, the same list a reset retry refuses to send twice.
 * Returns a finish() the caller runs when the Revit call returns, so a long write counts as liveness.
 */
export function admitBatchWrite(command: string, document: string | undefined, lease: string | undefined, client: string): { finish: () => void } {
  if (!WRITE_COMMANDS.has(command)) return { finish() {} };
  return batchBoard().admit(document, lease, client);
}

export async function notifyBatchGranted(send: (method: string, params: unknown) => Promise<void>, notice: GrantNotice): Promise<boolean> {
  try {
    await send("notifications/fmc/batch_granted", {
      lease: notice.lease, document: notice.document, label: notice.label, bot: notice.bot, attempt: notice.attempt, granted: true,
    });
    return true;
  } catch {
    return false;
  }
}
