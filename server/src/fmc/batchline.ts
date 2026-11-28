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
import { loadAiConfig } from "./aiuse_io.js";
import { SYNC_NOT_RUN, batchCareReport, correctionHelp, type CorrectionHelp } from "./batchcare.js";
import { planSync, syncDocumentKey, syncSettings, syncSkip, type SyncRun } from "./batchsync.js";
import { memoryGate, onMemoryResume } from "./memory.js";
import { loadBatchLine, MAINTENANCE_REASON, readMaintenance, saveBatchLine, writeMaintenance, type StoredTicket } from "./batchstore.js";
import { invalidateReads } from "./readcache.js";
import { batchLease, documentTarget } from "./target.js";
import { resolveLeaseDocument } from "./docresolve.js";
import { queueClient, queueSnapshots } from "./fairqueue.js";
import { deferReason, isDocBusyMessage, loadSyncState, nextActionAt, nextOpenAt, orderedProjects, planTick, saveSyncState, seedModified, seedWorksharedClocks, staggerOffsetMs, type DocClock } from "./docschedule.js";
import { excludedFromSync, saveBlocked, saveSkipReason } from "./savepolicy.js";
import { dialogFor, inFlightJob, readRevitJobLines } from "./notidle.js";
import { readInstances } from "./connect.js";

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
  syncStep?: (ctx: { document: string; label: string; changedAt: number | null; lastSyncAt: number | null; batchEnd?: boolean }) => Promise<SyncRun>;
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
  /** Reloads changedAt, lastSyncAt and lastSaveAt. Production reads fmc_sync_state.json. */
  loadClocks?: () => DocClock[];
  /** Writes those clocks. Production writes fmc_sync_state.json. */
  saveClocks?: (rows: DocClock[]) => void;
  /**
   * True when a Revit job is running or queued. Production reads the fair queue.
   * A test board leaves this unset, so it never reads the live queue.
   */
  queueBusy?: () => boolean;
  /**
   * True when a modal dialog is open. Production reads the Revit job log.
   * A test board leaves this unset, so it never reads the live log.
   */
  modalDialog?: () => boolean;
  /** Open documents. Production reads the instance files. A test board leaves this unset. */
  readOpenDocs?: () => Array<{ title?: string; path?: string; family?: boolean; workshared?: boolean; modified?: boolean }>;
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

/**
 * True when the caller's own name is a scheduler. The bot field is not a credential (the caller writes it): a scheduler by bot name
 * is proven in the tool (botauth.ts schedulerVerdict) and arrives here as verifiedScheduler.
 */
export function isScheduler(client: string, names: string[]): boolean {
  const want = new Set(names.map((name) => name.toLowerCase()));
  return want.has(client.trim().toLowerCase());
}

/** Unique document names in document-key order, so two batches lock the same set in the same order. */
export function sortDocumentNames(names: string[]): string[] {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const raw of names) {
    const name = String(raw ?? "").trim();
    if (!name) continue;
    const key = documentKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(name);
  }
  rows.sort((a, b) => documentKey(a).localeCompare(documentKey(b)) || a.localeCompare(b));
  return rows;
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
  /** Every document this lease covers, sorted by document key. */
  documents: string[];
  /** documentKey of each name in documents, same order. */
  keys: string[];
  label: string;
  batchId: string;
  bot: string;
  client: string;
  estOps?: number;
  references: BatchReferences;
  referencesHash: string;
  correction: string;
  /** Phase this batch works in. Empty when the batch did not declare one. */
  phase?: string;
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
  /** Other documents this one lease must hold. Acquired with document, in document-key order, or not at all. */
  documents?: string[];
  label: string;
  estOps?: number;
  batchId?: string;
  bot?: string;
  references?: unknown;
  correction?: string;
  /** Optional phase fmc_phase batch_check reads from this lease. */
  phase?: string;
  client: string;
  /** Set by fmc_batch after botauth.ts schedulerVerdict: the caller is a scheduler by its registered identity. */
  verifiedScheduler?: boolean;
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
  private readonly loadClocksFn: () => DocClock[];
  private readonly saveClocksFn: (rows: DocClock[]) => void;
  private readonly queueBusyFn: () => boolean;
  private readonly modalDialogFn: () => boolean;
  private readonly readOpenDocsFn: () => Array<{ title?: string; path?: string; family?: boolean; workshared?: boolean; modified?: boolean }>;
  private readonly startedAt: number;
  private lastDefer: string | null = null;
  /** Set while a hot-swap is draining. New leases stay queued. Active leases finish. */
  private maintenanceReason: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private stopMemory: () => void = () => {};
  private readonly tickets = new Map<string, Ticket>();
  private readonly syncState = new Map<string, { document: string; lastSyncAt: number | null; changedAt: number | null; lastSaveAt: number | null; lastError: string | null; pendingBatchEnd?: boolean; deferReason?: string | null }>();
  private readonly lines = new Map<string, string[]>();
  private readonly holders = new Map<string, string>();
  /** Set after a lease is dropped and until its save and sync finish. Not a lease, so autosave is not deferred by it. New grants wait. */
  private readonly care = new Set<string>();
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
    this.loadClocksFn = opts.loadClocks ?? (() => []);
    this.saveClocksFn = opts.saveClocks ?? (() => {});
    this.queueBusyFn = opts.queueBusy ?? (() => false);
    this.modalDialogFn = opts.modalDialog ?? (() => false);
    this.readOpenDocsFn = opts.readOpenDocs ?? (() => []);
    this.startedAt = this.now();
    for (const row of this.loadClocksFn()) this.rememberClock(row);
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
    this.seedOpenChanges();
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
    const documents = sortDocumentNames([input.document ?? "", ...(input.documents ?? [])]);
    const document = documents[0] ?? "";
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
    const keys = documents.map((name) => documentKey(name));
    const key = keys[0];
    documents.forEach((name, index) => this.names.set(keys[index], name));
    const attemptKey = this.attemptKey(keys.join("|"), batchId);
    const prior = this.attempts.get(attemptKey);
    if (prior && prior.failures > 0) {
      const note = (input.correction ?? "").trim();
      if (!note || note === prior.lastCorrection || referencesHash(refs) === prior.referencesHash) {
        throw new BatchGateError("FMC-BATCH-SAMEFIX",
          `[FMC-BATCH-SAMEFIX] This retry repeats the failed attempt. Pass correction (what you changed) and different references. ` +
          `It is not parked: change the kit, standards or rulebook ids and request again. Last error: ${prior.lastError}`);
      }
    }
    const existing = [...this.tickets.values()].find((ticket) => this.sameKeys(ticket, keys) && ticket.batchId.toLowerCase() === batchId.toLowerCase());
    if (existing) {
      if (input.phase?.trim()) existing.phase = input.phase.trim();
      if (existing.reserved && existing.bot.toLowerCase() === bot.toLowerCase()) {
        existing.client = input.client;
        existing.reserved = false;
        const head = (this.lines.get(key) ?? [])[0];
        if (existing.state !== "active" && head === existing.id) this.settle(existing.id);
        this.persist();
        return this.ticketView(existing);
      }
      if (existing.client === input.client) {
        if (input.phase?.trim()) this.persist();
        return this.ticketView(existing);
      }
      throw new BatchGateError("FMC-BATCH-BAD",
        `[FMC-BATCH-BAD] Batch "${label}" is already ${existing.state === "active" ? "running" : "in line"} on ${document} for another session. ` +
        `Wait, or use a new label for a different batch.`);
    }
    const attempt = (prior?.failures ?? 0) + 1;
    const ticket: Ticket = {
      id: randomUUID(),
      document, key, documents, keys, label, batchId, bot, client: input.client,
      estOps: input.estOps && input.estOps > 0 ? Math.floor(input.estOps) : undefined,
      references: copyRefs(refs),
      referencesHash: referencesHash(refs),
      correction: (input.correction ?? "").trim(),
      phase: input.phase?.trim() || undefined,
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
    this.enqueue(ticket);
    this.settle(ticket.id);
    if (ticket.state !== "active") {
      const line = this.lines.get(key) ?? [];
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
    if (input.verifiedScheduler !== true && !isScheduler(input.client, schedulerNames(loadConfig().config))) {
      throw new BatchGateError("FMC-BATCH-SCHEDULER",
        "[FMC-BATCH-SCHEDULER] reserve is only for a scheduler in batch_schedulers, matched on the caller's registered client name or a bot name its client is registered for (bot_identities). The bot field alone is not enough.");
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
      id: randomUUID(), document, key, documents: [document], keys: [key], label, batchId, bot, client: bot,
      estOps: input.estOps && input.estOps > 0 ? Math.floor(input.estOps) : undefined,
      references: copyRefs(refs), referencesHash: referencesHash(refs), correction: "",
      phase: input.phase?.trim() || undefined,
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

  /** Who holds this document now. Null when the line is idle. */
  activeHolder(document: string): { lease: string; client: string } | null {
    this.sweep();
    const holder = this.holderFor(document);
    if (!holder) return null;
    return { lease: holder.id, client: holder.client };
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

  /**
   * Release the lease first. Save and sync run only after that, still recorded on this batch.
   * Only this document's own job, a dialog, low memory, or an open transaction defers them.
   * A lease on another document does not. A defer is retried on the next idle tick.
   */
  async releaseWithCare(lease: string, outcome: "ok" | "failed", client: string, summary?: string, error?: string): Promise<Record<string, unknown>> {
    this.sweep();
    const ticket = this.tickets.get(lease);
    if (!ticket || ticket.client !== client) throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] release needs the lease this session holds.");
    if (ticket.state !== "active") throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] That lease is still queued. cancel leaves the line; release is for the batch you are running.");
    if (outcome !== "ok" && outcome !== "failed") throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] release needs outcome ok or failed.");
    let finalOutcome = outcome;
    let text = outcome === "failed" ? (error?.trim() || summary?.trim() || "failed") : undefined;
    // The lease title, or the open `_USER` local of that title. Never a name with `_USER` removed.
    // A multi-document lease saves and syncs each document after the leases are dropped together.
    const cared = this.documentsOf(ticket).map((name) => ({ document: resolveLeaseDocument(name, this.visibleDocs()), key: documentKey(name) }));
    const document = cared[0]?.document ?? ticket.document;
    let care: { save?: { ran: boolean; ok: boolean; detail: string }; sync?: { ran: boolean; detail: string; error?: string } } | undefined;
    let deferredNow: string | null = null;
    let batchEndSync: { status: "synced" | "deferred" | "skipped"; reason: string; pending: boolean } = {
      status: "skipped", reason: outcome === "ok" ? "No batch-end sync." : "The batch did not finish ok.", pending: false,
    };
    const syncs: Array<{ document: string; batch_end_sync: { status: "synced" | "deferred" | "skipped"; reason: string; pending: boolean } }> = [];
    try {
    if (outcome === "ok" && (this.saveStep || this.syncStep)) {
      for (const row of cared) {
        if (this.holders.get(row.key) === ticket.id) this.holders.delete(row.key);
        this.care.add(row.key);
      }
      for (const row of cared) {
      const document = row.document;
      const docKey = row.key;
      let careOne: { save?: { ran: boolean; ok: boolean; detail: string }; sync?: { ran: boolean; detail: string; error?: string } } | undefined;
      let deferredNow: string | null = null;
      let batchEndSync: { status: "synced" | "deferred" | "skipped"; reason: string; pending: boolean } = {
        status: "skipped", reason: "No batch-end sync.", pending: false,
      };
      const deferred = this.docDefer(docKey);
      if (deferred) {
        deferredNow = deferred;
        this.noteDefer(document, deferred);
        this.markPendingBatchEnd(document);
        careOne = { save: { ran: false, ok: true, detail: deferred }, sync: { ran: false, detail: deferred } };
        batchEndSync = { status: "deferred", reason: deferred, pending: true };
      } else if (this.saveStep) {
        let save: { ran: boolean; ok: boolean; detail: string };
        try {
          save = await documentTarget.run(document, () => this.saveStep!({ document, label: ticket.label, client, lease: ticket.id, summary: summary?.trim() ?? "" }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          save = { ran: !isDocBusyMessage(message), ok: false, detail: message };
        }
        if (isDocBusyMessage(save.detail)) {
          deferredNow = save.detail;
          this.noteDefer(document, save.detail);
          this.markPendingBatchEnd(document);
          careOne = { save: { ran: false, ok: true, detail: save.detail }, sync: { ran: false, detail: save.detail } };
          batchEndSync = { status: "deferred", reason: save.detail, pending: true };
        } else {
          careOne = { save, sync: { ran: false, detail: SYNC_NOT_RUN } };
          if (save.ran && save.ok) this.noteSave(document);
          if (save.ran && !save.ok) {
            finalOutcome = "failed";
            text = save.detail;
          }
        }
      }
    if (finalOutcome === "ok" && this.syncStep && !deferredNow) {
      try {
        const sync = await documentTarget.run(document, () => this.syncStep!({
          document,
          label: ticket.label,
          changedAt: this.syncState.get(docKey)?.changedAt ?? this.syncState.get(documentKey(document))?.changedAt ?? this.now(),
          lastSyncAt: this.syncState.get(docKey)?.lastSyncAt ?? this.syncState.get(documentKey(document))?.lastSyncAt ?? null,
          batchEnd: true,
        }));
        if (sync.defer_reason || isDocBusyMessage(sync.detail) || isDocBusyMessage(sync.error)) {
          const why = sync.defer_reason || sync.detail;
          this.noteDefer(document, why);
          this.markPendingBatchEnd(document);
          const row = { ran: false, detail: sync.detail };
          careOne = careOne ? { ...careOne, sync: row } : { sync: row };
          batchEndSync = { status: "deferred", reason: why, pending: true };
        } else {
          this.applySync(document, sync);
          const row = { ran: sync.ran, detail: sync.detail, ...(sync.error ? { error: sync.error } : {}) };
          careOne = careOne ? { ...careOne, sync: row } : { sync: row };
          batchEndSync = sync.synced
            ? { status: "synced", reason: sync.detail, pending: false }
            : { status: "skipped", reason: sync.detail, pending: this.isPendingBatchEnd(docKey) };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isDocBusyMessage(message)) {
          this.noteDefer(document, message);
          this.markPendingBatchEnd(document);
          const row = { ran: false, detail: message };
          careOne = careOne ? { ...careOne, sync: row } : { sync: row };
          batchEndSync = { status: "deferred", reason: message, pending: true };
        } else {
          this.applySync(document, { ran: true, ok: true, synced: false, detail: `Sync did not finish. The batch is not failed. ${message}`, error: message });
          this.markPendingBatchEnd(document);
          const row = { ran: true, detail: `Sync did not finish. The batch is not failed. ${message}`, error: message };
          careOne = careOne ? { ...careOne, sync: row } : { sync: row };
          batchEndSync = { status: "deferred", reason: message, pending: true };
        }
      }
    }
      if (finalOutcome !== "ok" && batchEndSync.status !== "deferred") {
        batchEndSync = { status: "skipped", reason: text || "The batch did not finish ok.", pending: false };
      }
      syncs.push({ document, batch_end_sync: batchEndSync });
      if (!care) care = careOne;
      }
    }
    } finally {
      for (const row of cared) this.care.delete(row.key);
    }
    if (!syncs.length && finalOutcome !== "ok") {
      batchEndSync = { status: "skipped", reason: text || "The batch did not finish ok.", pending: false };
    } else if (syncs[0]) {
      batchEndSync = syncs[0].batch_end_sync;
    }
    const done = this.endActive(ticket, finalOutcome, "release", text, summary?.trim() ?? "", care);
    return {
      ...done,
      document: ticket.document,
      ...(cared.length > 1 ? { documents: cared.map((row) => row.document) } : {}),
      sync_document: document,
      batch_end_sync: batchEndSync,
      ...(syncs.length > 1 ? { batch_end_syncs: syncs } : {}),
    };
  }

  /** A lease, a save still finishing, low memory, or a drain. The save itself is not a lease. */
  private grantsPaused(key: string): boolean {
    return this.holders.has(key) || this.care.has(key) || this.heldForMemory() || this.maintenanceReason != null;
  }

  cancel(lease: string, client: string): Record<string, unknown> {
    this.sweep();
    const ticket = this.tickets.get(lease);
    if (!ticket || ticket.client !== client) throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] cancel needs a queued lease from this session.");
    if (ticket.state === "active") throw new BatchGateError("FMC-BATCH-BAD", "[FMC-BATCH-BAD] This lease is running. release it with outcome ok or failed.");
    this.unline(ticket);
    if (ticket.ops > 0) for (const name of this.documentsOf(ticket)) this.markPendingBatchEnd(name);
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
        this.unline(ticket);
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
    for (const id of [...new Set(this.holders.values())]) {
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
  /** The document a lease was granted for, when this process still has that lease. */
  heldDocument(lease: string): string | undefined {
    return this.heldDocuments(lease)[0];
  }

  /** Every document this lease covers. Empty when the lease is unknown. Includes a queued lease. */
  heldDocuments(lease: string): string[] {
    const id = lease.trim();
    if (!id) return [];
    const ticket = this.tickets.get(id);
    return ticket ? this.documentsOf(ticket) : [];
  }

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

  private unline(ticket: Ticket): void {
    for (const key of this.keysOf(ticket)) {
      const line = (this.lines.get(key) ?? []).filter((id) => id !== ticket.id);
      if (line.length) this.lines.set(key, line);
      else this.lines.delete(key);
    }
  }

  private holderFor(document: string | undefined): Ticket | undefined {
    const seen = new Set<string>();
    const actives: Ticket[] = [];
    for (const id of this.holders.values()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const ticket = this.tickets.get(id);
      if (ticket) actives.push(ticket);
    }
    if (document && document.trim()) return actives.find((ticket) => this.documentsOf(ticket).some((name) => documentsMatch(name, document)));
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
    return `[FMC-BATCH-LOCKED] ${holder.document} is held by ${who}. ${position}${idNote} Pass batch_lease on each model-changing call. Reads are still allowed. busy_reason: lease held by ${holder.bot} on doc ${holder.document}.`;
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

  private keysOf(ticket: Ticket): string[] {
    return ticket.keys?.length ? ticket.keys : [ticket.key];
  }

  private documentsOf(ticket: Ticket): string[] {
    return ticket.documents?.length ? ticket.documents : [ticket.document];
  }

  private sameKeys(ticket: Ticket, keys: string[]): boolean {
    const have = this.keysOf(ticket);
    return have.length === keys.length && have.every((key, index) => key === keys[index]);
  }

  private enqueue(ticket: Ticket): void {
    const names = this.documentsOf(ticket);
    this.keysOf(ticket).forEach((key, index) => {
      this.names.set(key, names[index] ?? ticket.document);
      const line = this.lines.get(key) ?? [];
      if (!line.includes(ticket.id)) line.push(ticket.id);
      this.lines.set(key, line);
    });
  }

  /** True when this ticket is the head of every document it needs and none of those documents is held or in care. */
  private ready(ticket: Ticket): boolean {
    for (const key of this.keysOf(ticket)) {
      if (this.care.has(key)) return false;
      const holder = this.holders.get(key);
      if (holder && holder !== ticket.id) return false;
      if (holder === ticket.id) continue;
      if ((this.lines.get(key) ?? [])[0] !== ticket.id) return false;
    }
    return this.keysOf(ticket).length > 0;
  }

  private canGrantNow(ticket: Ticket): boolean {
    if (this.maintenanceReason || this.heldForMemory()) return false;
    return this.ready(ticket);
  }

  /** The queue head this ticket is waiting on, when that wait is another queued ticket and not an active lease. */
  private waitFor(ticket: Ticket): Ticket | null {
    for (const key of this.keysOf(ticket)) {
      if (this.holders.has(key) && this.holders.get(key) !== ticket.id) return null;
      if (this.care.has(key)) return null;
      const head = (this.lines.get(key) ?? [])[0];
      if (head && head !== ticket.id) return this.tickets.get(head) ?? null;
    }
    return null;
  }

  private findCycle(start: Ticket): Ticket[] | null {
    const chain: Ticket[] = [];
    let current: Ticket | null = start;
    const guard = new Set<string>();
    while (current) {
      const again = chain.indexOf(current);
      if (again >= 0) return chain.slice(again);
      if (guard.has(current.id)) return null;
      guard.add(current.id);
      chain.push(current);
      current = this.waitFor(current);
    }
    return null;
  }

  /**
   * A cycle of multi-document heads cannot move. The ticket whose first document key sorts first
   * moves to the front of its own lines, and only past the other tickets in the cycle.
   */
  private breakCycles(): void {
    const seen = new Set<string>();
    for (const key of [...this.lines.keys()].sort()) {
      const id = (this.lines.get(key) ?? [])[0];
      if (!id || seen.has(id)) continue;
      const head = this.tickets.get(id);
      if (!head) continue;
      seen.add(id);
      if (this.ready(head)) continue;
      const cycle = this.findCycle(head);
      if (!cycle || cycle.length < 2) continue;
      const winner = [...cycle].sort((a, b) => {
        const ak = this.keysOf(a)[0] ?? "";
        const bk = this.keysOf(b)[0] ?? "";
        if (ak !== bk) return ak < bk ? -1 : 1;
        if (a.requestedAt !== b.requestedAt) return a.requestedAt - b.requestedAt;
        return a.id < b.id ? -1 : 1;
      })[0];
      const members = new Set(cycle.map((ticket) => ticket.id));
      for (const docKey of this.keysOf(winner)) {
        const line = [...(this.lines.get(docKey) ?? [])];
        const index = line.indexOf(winner.id);
        if (index <= 0) continue;
        if (!line.slice(0, index).every((item) => members.has(item))) continue;
        this.lines.set(docKey, [winner.id, ...line.filter((item) => item !== winner.id)]);
      }
    }
  }

  /** Grant every ready head. silentId is the request that is still in this call, so it does not notify itself. */
  private settle(silentId?: string): void {
    if (this.maintenanceReason || this.heldForMemory()) return;
    for (let pass = 0; pass < 32; pass++) {
      this.breakCycles();
      let granted = false;
      for (const key of [...this.lines.keys()].sort()) {
        if (this.holders.has(key) || this.care.has(key)) continue;
        const line = this.lines.get(key) ?? [];
        while (line.length && !this.tickets.has(line[0])) line.shift();
        if (!line.length) {
          this.lines.delete(key);
          continue;
        }
        this.lines.set(key, line);
        const next = this.tickets.get(line[0]);
        if (!next || !this.canGrantNow(next)) continue;
        this.grant(next, next.id !== silentId);
        granted = true;
        break;
      }
      if (!granted) return;
    }
  }

  private grant(ticket: Ticket, notify: boolean): void {
    ticket.state = "active";
    ticket.grantedAt = this.now();
    ticket.lastBeat = ticket.grantedAt;
    for (const key of this.keysOf(ticket)) {
      this.holders.set(key, ticket.id);
      const line = (this.lines.get(key) ?? []).filter((id) => id !== ticket.id);
      if (line.length) this.lines.set(key, line);
      else this.lines.delete(key);
    }
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
    if (this.care.has(key)) {
      const line = this.lines.get(key) ?? [];
      this.emit(`save or sync still finishing; ${line.length} queued lease(s) stay on ${this.names.get(key) ?? key}`);
      for (const id of line) this.wake(id);
      return;
    }
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
    this.settle();
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
    const stat = this.botStat(ticket.bot);
    stat.finished += 1;
    stat.waitMs += wait;
    stat.durationMs += duration;
    stat.lastReferences = copyRefs(ticket.references);
    stat.lastDocument = ticket.document;
    stat.lastLabel = ticket.label;
    stat.lastClient = ticket.client;
    let help: CorrectionHelp | undefined;
    const attemptDoc = this.keysOf(ticket).join("|");
    if (outcome === "ok") {
      stat.batches += 1;
      this.attempts.delete(this.attemptKey(attemptDoc, ticket.batchId));
      this.emit(`released ok ${this.where(ticket)} ops ${ticket.ops} in ${duration}ms. Not rolled back.`);
    } else {
      stat.failures += 1;
      help = correctionHelp({ error: error || "failed", references: ticket.references, label: ticket.label, bot: ticket.bot });
      const key = this.attemptKey(attemptDoc, ticket.batchId);
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
    for (const docKey of this.keysOf(ticket)) {
      const copy: HistoryRow = { ...row, document: this.names.get(docKey) ?? row.document, references: copyRefs(row.references) };
      const hist = this.history.get(docKey) ?? [];
      hist.unshift(copy);
      this.history.set(docKey, hist.slice(0, HISTORY_LIMIT));
    }
    const struggling = ticket.attempt > 3;
    const done: DoneRow = {
      state: "done", outcome, end, ...(error ? { error } : {}), summary, attempt: ticket.attempt, struggling,
      document: ticket.document, label: ticket.label, batch_id: ticket.batchId, bot: ticket.bot, ops: ticket.ops,
      references: copyRefs(ticket.references), ...(help ? { correction: help } : {}),
    };
    this.rememberDone(ticket, done);
    for (const docKey of this.keysOf(ticket)) {
      if (this.holders.get(docKey) === ticket.id) this.holders.delete(docKey);
    }
    this.tickets.delete(ticket.id);
    if ((end === "expired" || end === "max_duration" || end === "disconnect") && ticket.ops > 0 && ticket.client !== "fmc-sync") {
      for (const name of this.documentsOf(ticket)) this.markPendingBatchEnd(name);
    }
    for (const name of this.documentsOf(ticket)) invalidateReads(name);
    this.wake(ticket.id);
    this.settle();
    this.persist();
    return { ok: true, ...done, lease: ticket.id };
  }

  /** The phase stored on this lease. Empty when the batch did not declare one. */
  phaseOf(lease: string): string {
    return this.tickets.get(lease)?.phase?.trim() ?? "";
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
    let position = 0;
    let holder: Ticket | undefined;
    if (ticket.state !== "active") {
      position = 1;
      for (const key of this.keysOf(ticket)) {
        const index = (this.lines.get(key) ?? []).indexOf(ticket.id);
        position = Math.max(position, index < 0 ? 1 : index + 1);
        const holderId = this.holders.get(key);
        if (holderId && holderId !== ticket.id) holder = this.tickets.get(holderId) ?? holder;
      }
    }
    const eta = ticket.state === "queued" ? this.eta(ticket.key, position) : { eta_hint_s: 0, eta_basis: "granted" };
    const documents = this.documentsOf(ticket);
    return {
      ok: true,
      state: ticket.state === "active" ? "granted" : ticket.state,
      lease: ticket.id,
      document: ticket.document,
      ...(documents.length > 1 ? { documents } : {}),
      label: ticket.label,
      batch_id: ticket.batchId,
      bot: ticket.bot,
      attempt: ticket.attempt,
      struggling: ticket.attempt > 3,
      position,
      ahead: ticket.state === "active" ? 0 : Math.max(0, position - 1) + (holder ? 1 : 0),
      ops: ticket.ops,
      est_ops: ticket.estOps ?? null,
      ...(ticket.phase ? { phase: ticket.phase } : {}),
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
        message: `Paused for memory: ${free} MB free, pause below ${below} MB, resume above ${above} MB. ${tierCode(memory)} This lease stays queued and is not failed. It grants when free memory is above ${above} MB. wait holds until then or timeout_s. Reads still work.`,
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
    const wanted = document ? new Set([documentKey(document)]) : null;
    const seen = new Set<string>();
    const requeued: Array<{ lease: string; document: string; label: string; position: number }> = [];
    for (const [key, id] of [...this.holders.entries()]) {
      if (wanted && !wanted.has(key)) continue;
      if (seen.has(id)) continue;
      const ticket = this.tickets.get(id);
      if (!ticket || ticket.client === "fmc-sync") continue;
      seen.add(id);
      ticket.state = "queued";
      for (const docKey of this.keysOf(ticket)) {
        if (this.holders.get(docKey) === id) this.holders.delete(docKey);
        const line = this.lines.get(docKey) ?? [];
        if (!line.includes(id)) line.push(id);
        this.lines.set(docKey, line);
      }
      const position = (this.lines.get(ticket.key) ?? []).length;
      requeued.push({ lease: ticket.id, document: ticket.document, label: ticket.label, position });
      this.emit(`requeued after recovery ${this.where(ticket)} at position ${position}. The model was not rolled back.`);
      this.wake(ticket.id);
    }
    return { requeued };
  }

  /** Grant the head of each line once recovery has reopened the documents. */
  resumeAfterRecovery(): string[] {
    const granted: string[] = [];
    if (this.heldForMemory()) return granted;
    for (const key of [...this.lines.keys()]) {
      if (this.holders.has(key) || this.care.has(key)) continue;
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
      if (this.holders.has(key) || this.care.has(key)) continue;
      this.promote(key);
    }
  }

  private noteChange(document: string): void {
    const key = documentKey(document);
    const row = this.syncState.get(key) ?? { document, lastSyncAt: null, changedAt: null, lastSaveAt: null, lastError: null };
    row.document = this.names.get(key) ?? document;
    row.changedAt = this.now();
    this.syncState.set(key, row);
    this.persistClocks();
  }

  private noteSave(document: string): void {
    const key = documentKey(document);
    const row = this.syncState.get(key) ?? { document, lastSyncAt: null, changedAt: null, lastSaveAt: null, lastError: null };
    row.document = this.names.get(key) ?? document;
    row.lastSaveAt = this.now();
    this.syncState.set(key, row);
    this.persistClocks();
  }

  private rememberClock(row: DocClock): void {
    const key = documentKey(row.document);
    const prior = this.syncState.get(key);
    this.syncState.set(key, {
      document: row.document,
      changedAt: row.changedAt,
      lastSyncAt: row.lastSyncAt,
      lastSaveAt: row.lastSaveAt,
      lastError: row.lastError,
      ...(row.pendingBatchEnd || prior?.pendingBatchEnd ? { pendingBatchEnd: true } : {}),
      ...(row.deferReason || prior?.deferReason ? { deferReason: row.deferReason ?? prior?.deferReason ?? null } : {}),
    });
    this.names.set(key, row.document);
  }

  private persistClocks(): void {
    try {
      this.saveClocksFn([...this.syncState.values()].map((row) => ({
        document: row.document,
        changedAt: row.changedAt,
        lastSyncAt: row.lastSyncAt,
        lastSaveAt: row.lastSaveAt,
        lastError: row.lastError,
        ...(row.pendingBatchEnd ? { pendingBatchEnd: true } : {}),
        ...(row.deferReason ? { deferReason: row.deferReason } : {}),
      })));
    } catch (error) {
      this.emit(`sync clocks were not saved: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Take a newer timestamp from fmc_sync_state.json so /health matches the file after a restart or a hot-swap. */
  private refreshClocksFromDisk(): void {
    let clocks: DocClock[] = [];
    try { clocks = this.loadClocksFn(); } catch { return; }
    const newer = (a: number | null | undefined, b: number | null | undefined) => Math.max(a ?? 0, b ?? 0);
    for (const disk of clocks) {
      const key = documentKey(disk.document);
      const mem = this.syncState.get(key);
      if (!mem) {
        this.rememberClock(disk);
        continue;
      }
      const sync = newer(mem.lastSyncAt, disk.lastSyncAt);
      const save = newer(mem.lastSaveAt, disk.lastSaveAt);
      const changed = newer(mem.changedAt, disk.changedAt);
      if (sync > 0) mem.lastSyncAt = sync;
      if (save > 0) mem.lastSaveAt = save;
      if (changed > 0) mem.changedAt = changed;
      if (disk.pendingBatchEnd) mem.pendingBatchEnd = true;
      if (!mem.deferReason && disk.deferReason) mem.deferReason = disk.deferReason;
    }
  }

  private visibleDocs(): Array<{ title: string; path: string; family: boolean; workshared: boolean; modified: boolean }> {
    try {
      return this.readOpenDocsFn().map((doc) => ({
        title: doc.title ?? "", path: doc.path ?? "", family: doc.family === true, workshared: doc.workshared === true, modified: doc.modified === true,
      }));
    } catch {
      return [];
    }
  }

  /** Modified files, and every workshared local that is not in sync_exclude, get a clock. */
  private seedOpenChanges(): void {
    const open = this.visibleDocs();
    const cfg = loadConfig().config;
    const settings = syncSettings(cfg);
    let clocks: DocClock[] = [...this.syncState.values()].map((row) => ({
      document: row.document, changedAt: row.changedAt, lastSyncAt: row.lastSyncAt, lastSaveAt: row.lastSaveAt, lastError: row.lastError,
      ...(row.pendingBatchEnd ? { pendingBatchEnd: true } : {}),
      ...(row.deferReason ? { deferReason: row.deferReason } : {}),
    }));
    clocks = seedModified(clocks, open, this.now());
    clocks = seedWorksharedClocks(clocks, open, this.now(), (doc) =>
      excludedFromSync(doc, cfg) || syncSkip(doc.title ?? "", settings, doc.path ?? "") != null);
    let changed = clocks.length !== this.syncState.size;
    for (const row of clocks) {
      const prior = this.syncState.get(documentKey(row.document));
      if (!prior || prior.changedAt !== row.changedAt || prior.lastSyncAt !== row.lastSyncAt) changed = true;
      this.rememberClock(row);
    }
    if (changed) this.persistClocks();
  }

  /** A modal dialog or the memory pause blocks every document. A lease does not. */
  sessionDefer(): string | null {
    return this.sessionBlock();
  }

  /** Modal dialog or memory pause. These stop every document. */
  private sessionBlock(): string | null {
    let modalDialog = false;
    try { modalDialog = this.modalDialogFn(); } catch { modalDialog = false; }
    return deferReason({
      queueBusy: false,
      leasesHeld: 0,
      modalDialog,
      memoryPaused: this.memoryPausedFn(),
      docBusy: false,
    });
  }

  /** A write still inside this document's own lease. Another document's job does not count. */
  private docWritesInFlight(key: string): boolean {
    for (const ticket of this.tickets.values()) {
      if (ticket.client === "fmc-sync" || ticket.writesInFlight <= 0) continue;
      if (this.keysOf(ticket).includes(key)) return true;
    }
    return false;
  }

  /**
   * Defer this document only. Another document's lease is ignored.
   * A queued or running write on this document, a modal, the memory pause, or an open transaction does defer it.
   */
  private docDefer(key: string): string | null {
    const blocked = this.sessionBlock();
    if (blocked) return blocked;
    return deferReason({
      queueBusy: this.docWritesInFlight(key),
      leasesHeld: this.holders.has(key) ? 1 : 0,
      modalDialog: false,
      memoryPaused: false,
      docBusy: false,
    });
  }

  private noteDefer(document: string, reason: string): void {
    this.lastDefer = reason;
    const key = documentKey(document);
    const row = this.syncState.get(key) ?? { document, lastSyncAt: null, changedAt: null, lastSaveAt: null, lastError: null };
    row.document = this.names.get(key) ?? document;
    row.deferReason = reason;
    this.syncState.set(key, row);
    this.emit(`sync deferred ${row.document}: ${reason}`);
  }

  /** Remember a batch-end sync that did not run, and write it to fmc_sync_state.json. */
  private markPendingBatchEnd(document: string): void {
    const key = documentKey(document);
    const row = this.syncState.get(key) ?? { document, lastSyncAt: null, changedAt: null, lastSaveAt: null, lastError: null };
    row.document = this.names.get(key) ?? document;
    row.pendingBatchEnd = true;
    this.syncState.set(key, row);
    this.persistClocks();
  }

  private isPendingBatchEnd(key: string): boolean {
    return this.syncState.get(key)?.pendingBatchEnd === true;
  }

  private applySync(document: string, sync: SyncRun): void {
    const key = documentKey(document);
    const row = this.syncState.get(key) ?? { document, lastSyncAt: null, changedAt: null, lastSaveAt: null, lastError: null };
    row.document = document;
    const notApplicable = /Not workshared|is not synced|Protected original|Sync is off|Excluded by sync_exclude|Not in sync_documents/.test(sync.detail);
    if (sync.synced) {
      row.lastSyncAt = this.now();
      row.lastSaveAt = row.lastSaveAt ?? this.now();
      row.lastError = null;
      row.pendingBatchEnd = undefined;
      row.deferReason = null;
    } else if (isDocBusyMessage(sync.detail) || isDocBusyMessage(sync.error)) {
      this.lastDefer = sync.detail;
    } else if (sync.error) row.lastError = sync.error;
    else if (notApplicable) {
      row.changedAt = row.lastSyncAt;
      row.pendingBatchEnd = undefined;
    }
    this.syncState.set(key, row);
    this.persistClocks();
    this.emit(`sync ${document}: ${sync.detail}`);
  }

  private syncFields(key: string): { last_sync: string | null; last_sync_at: string | null; next_sync: string | null; next_sync_at: string | null; last_save: string | null; last_save_at: string | null; next_save_at: string | null; last_error: string | null; excluded: boolean; skip_reason: "excluded" | null; defer_reason: string | null; pending_batch_end: boolean } {
    const settings = syncSettings(loadConfig().config);
    const row = this.syncState.get(key);
    const iso = (t: number | null | undefined) => (t == null ? null : new Date(t).toISOString());
    const names = [...this.syncState.keys()].sort();
    const index = Math.max(0, names.indexOf(key));
    const count = Math.max(1, names.length);
    const saveMinutes = autosaveMinutes();
    const saveInterval = saveMinutes > 0 ? saveMinutes * 60_000 : 0;
    const syncInterval = settings.minutes > 0 ? settings.minutes * 60_000 : 0;
    const offset = staggerOffsetMs(index, count, Math.max(saveInterval, syncInterval));
    const label = row?.document ?? this.names.get(key) ?? key;
    const skip = saveSkipReason({ title: label });
    const ahead = (at: number | null) => (at == null ? null : nextOpenAt(at, this.now(), saveInterval > 0 ? saveInterval : syncInterval));
    const nextSave = skip || !(saveInterval > 0) ? null : iso(ahead((row?.lastSaveAt == null ? this.startedAt : row.lastSaveAt) + (row?.lastSaveAt == null ? offset : saveInterval)));
    const own = this.docDefer(key) ?? row?.deferReason ?? null;
    if (!row) return { last_sync: null, last_sync_at: null, next_sync: null, next_sync_at: null, last_save: null, last_save_at: null, next_save_at: nextSave, last_error: null, excluded: syncSkip(key, settings) != null || skip != null, skip_reason: skip, defer_reason: own ?? skip, pending_batch_end: false };
    const plan = planSync(
      { workshared: true, stopAi: false, aiOn: true },
      { now: this.now(), lastSyncAt: row.lastSyncAt, changedAt: row.changedAt, leaseHeld: this.holders.has(key), batchEnd: false },
      settings,
      row.document,
    );
    const saveAt = skip || !(saveInterval > 0) ? null : ahead(nextActionAt(row.lastSaveAt, this.startedAt, saveInterval, offset));
    const syncExcluded = plan.excluded || excludedFromSync({ title: row.document });
    const syncAnchor = row.lastSyncAt ?? row.changedAt;
    const syncAt = syncInterval > 0 && !syncExcluded && syncAnchor != null
      ? nextOpenAt(nextActionAt(syncAnchor, this.startedAt, syncInterval, offset), this.now(), syncInterval)
      : null;
    const lastSync = iso(row.lastSyncAt);
    const lastSave = iso(row.lastSaveAt);
    return {
      last_sync: lastSync, last_sync_at: lastSync, next_sync: iso(syncAt), next_sync_at: iso(syncAt),
      last_save: lastSave, last_save_at: lastSave, next_save_at: iso(saveAt) ?? nextSave,
      last_error: row.lastError, excluded: plan.excluded || skip != null, skip_reason: skip,
      defer_reason: own ?? skip, pending_batch_end: row.pendingBatchEnd === true,
    };
  }

  private syncRows(): Array<Record<string, unknown>> {
    this.refreshClocksFromDisk();
    this.seedOpenChanges();
    const keys = new Map<string, string>();
    for (const [key, row] of this.syncState) keys.set(key, row.document);
    try {
      for (const doc of orderedProjects(this.visibleDocs())) {
        const name = doc.title || doc.path;
        const key = documentKey(name);
        if (!keys.has(key)) keys.set(key, name);
      }
    } catch { /* no instance files in a test */ }
    return [...keys.entries()].map(([key, document]) => ({ document, ...this.syncFields(key) }));
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
      id, document, key, documents: [document], keys: [key], label: "sync", batchId: "sync", bot: "sync", client: "fmc-sync",
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

  /** Documents the idle tick may save or sync, including one that still owes a batch-end sync. */
  private scheduledDocs(): Array<{ title: string; path: string; family: boolean; workshared: boolean; modified: boolean }> {
    const docs = this.visibleDocs();
    const seen = new Set(docs.map((doc) => documentKey(doc.title || doc.path)));
    for (const row of this.syncState.values()) {
      if (!row.pendingBatchEnd) continue;
      const key = documentKey(row.document);
      if (seen.has(key)) continue;
      docs.push({ title: row.document, path: "", family: false, workshared: true, modified: true });
      seen.add(key);
    }
    return docs;
  }

  /** One save or one sync. A lease or an in-flight job skips only that document. A pending batch-end sync is retried until it succeeds. */
  async syncIdle(): Promise<void> {
    this.seedOpenChanges();
    const blocked = this.sessionBlock();
    if (blocked) {
      this.lastDefer = blocked;
      this.emit(`idle sync deferred: ${blocked}`);
      return;
    }
    const settings = syncSettings(loadConfig().config);
    const minutes = autosaveMinutes();
    const docs = this.scheduledDocs();
    const held = (doc: { title: string; path?: string }) => {
      const key = documentKey(doc.title || doc.path || "");
      return this.holders.has(key) || this.care.has(key) || this.docWritesInFlight(key);
    };
    const chosen = planTick({
      now: this.now(),
      startedAt: this.startedAt,
      docs,
      clocks: [...this.syncState.values()],
      saveIntervalMs: minutes > 0 ? minutes * 60_000 : 0,
      syncIntervalMs: settings.minutes > 0 ? settings.minutes * 60_000 : 0,
      saveSkipped: (doc) => doc.family === true || saveBlocked({ title: doc.title, path: doc.path }) != null || held(doc),
      syncSkipped: (doc) => !doc.workshared || syncSkip(doc.title, settings, doc.path) != null || held(doc),
      batchEnd: (doc) => this.isPendingBatchEnd(documentKey(doc.title || doc.path || "")) && !held(doc),
    });
    if (!chosen) {
      this.lastDefer = null;
      return;
    }
    if (chosen.kind === "save") {
      const { productionSaveStep } = await import("./batchsave.js");
      const save = await productionSaveStep({ document: chosen.document, label: "autosave" });
      if (isDocBusyMessage(save.detail)) { this.noteDefer(chosen.document, save.detail); return; }
      this.lastDefer = null;
      if (!(save.ran && !save.ok)) this.noteSave(chosen.document);
      return;
    }
    const batch = chosen.kind === "batch";
    const state = this.syncState.get(documentKey(chosen.document));
    const ran = await this.withServiceHold(chosen.document, () => this.syncStep?.({
      document: chosen.document, label: batch ? "batch-end" : "idle", changedAt: state?.changedAt ?? null, lastSyncAt: state?.lastSyncAt ?? null, batchEnd: batch,
    }) ?? Promise.resolve({ ran: false, ok: true as const, synced: false, detail: "No sync step.", error: undefined }));
    if (!ran || ran.defer_reason || isDocBusyMessage(ran.detail) || isDocBusyMessage(ran.error)) {
      const why = ran?.defer_reason || ran?.detail || "The document has an open transaction or transaction group.";
      this.noteDefer(chosen.document, why);
      if (batch) this.markPendingBatchEnd(chosen.document);
      return;
    }
    this.lastDefer = null;
    this.applySync(chosen.document, ran);
    if (!ran.synced && !ran.ran) {
      const row = this.syncState.get(documentKey(chosen.document));
      if (row && !batch) row.changedAt = row.lastSyncAt;
    }
  }

  /** Put a saved line back. Tickets stay queued until resumeGrants. */
  importLine(tickets: StoredTicket[]): number {
    let n = 0;
    for (const row of tickets) {
      const key = documentKey(row.document);
      if (!this.tickets.has(row.id)) {
        const documents = sortDocumentNames(row.documents?.length ? row.documents : [row.document]);
        const keys = documents.map((name) => documentKey(name));
        const ticket: Ticket = {
          id: row.id, document: documents[0] ?? row.document, key: keys[0] ?? key, documents, keys,
          label: row.label, batchId: row.batchId, bot: row.bot, client: row.client,
          estOps: row.estOps, references: copyRefs(row.references), referencesHash: referencesHash(row.references),
          correction: row.correction ?? "", phase: row.phase?.trim() || undefined, reserved: row.reserved === true, state: "queued", attempt: row.attempt || 1,
          requestedAt: row.requestedAt || this.now(), lastBeat: this.now(), ops: 0, writesInFlight: 0,
        };
        this.tickets.set(ticket.id, ticket);
        documents.forEach((name, index) => this.names.set(keys[index], name));
        n += 1;
      }
      this.names.set(key, row.document);
      const line = this.lines.get(key) ?? [];
      if (!line.includes(row.id)) line.push(row.id);
      this.lines.set(key, line);
    }
    return n;
  }

  resumeGrants(): string[] {
    if (this.maintenanceReason || this.heldForMemory()) return [];
    const granted: string[] = [];
    for (const key of [...this.lines.keys()]) {
      if (this.holders.has(key) || this.care.has(key)) continue;
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
          ...(ticket.phase ? { phase: ticket.phase } : {}),
          ...(ticket.reserved ? { reserved: true } : {}),
          ...(this.documentsOf(ticket).length > 1 ? { documents: this.documentsOf(ticket) } : {}),
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

function autosaveMinutes(): number {
  try {
    const ai = loadAiConfig(loadConfig().config);
    return ai?.auto_save_minutes ?? (ai?.mode === "testing" ? 10 : 0);
  } catch {
    return 0;
  }
}

function modalDialogOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const lines = readRevitJobLines(env);
    const now = Date.now();
    return readInstances(env).some((instance) => {
      const flight = inFlightJob(lines, instance.pid, now);
      return !!flight && dialogFor(instance.pid, flight.job, env, lines).length > 0;
    });
  } catch {
    return false;
  }
}

function tierCode(memory: Record<string, unknown> | null): string {
  const tier = typeof memory?.tier === "string" ? memory.tier : "";
  if (tier === "soft") return "FMC-MEMORY-SOFT.";
  if (tier === "hard" || memory?.paused === true || !tier) return "FMC-MEMORY-HARD.";
  return "FMC-MEMORY-HARD.";
}

function productionBoard(opts: BatchBoardOptions = {}, env: NodeJS.ProcessEnv = process.env): BatchBoard {
  const made = new BatchBoard({
    memoryPaused: () => memoryGate.blocksNewLeases(),
    memoryView: () => memoryGate.view() as unknown as Record<string, unknown>,
    queueBusy: () => {
      try { return queueSnapshots().some((row) => row.running != null || row.waiting > 0); } catch { return false; }
    },
    modalDialog: () => modalDialogOpen(env),
    readOpenDocs: () => readInstances(env).flatMap((instance) => instance.documents ?? []),
    saveStep: (ctx) => import("./batchsave.js").then((mod) => mod.productionSaveStep(ctx)),
    syncStep: (ctx) => import("./batchsync.js").then((mod) => mod.productionSyncStep(ctx)),
    readMaintenance: () => readMaintenance(env),
    writeMaintenance: (reason) => writeMaintenance(reason, env),
    persistLine: (tickets) => { try { saveBatchLine(tickets, env); } catch { /* the next change tries again */ } },
    loadClocks: () => loadSyncState(env),
    saveClocks: (rows) => { try { saveSyncState(rows, env); } catch { /* the next change tries again */ } },
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

/** Process start. In-memory leases do not survive a restart, and the model is not rolled back. Pass env in tests so the live batch line is not read. */
export function logBatchRestart(env: NodeJS.ProcessEnv = process.env): BatchBoard {
  board?.close();
  board = productionBoard({ ...loadBatchConfig(env), autoSweep: true }, env);
  const restored = board.importLine(loadBatchLine(env));
  board.pullMaintenance();
  if (!board.snapshot().maintenance) board.resumeGrants();
  board.noteServiceStart(restored);
  return board;
}

/**
 * Model-changing calls only. The write list is WRITE_COMMANDS, the same list a reset retry refuses to send twice.
 * Returns a finish() the caller runs when the Revit call returns, so a long write counts as liveness.
 */
export function leaseHeldDocument(lease: string | undefined): string | undefined {
  return leaseHeldDocuments(lease)[0];
}

/** Every document a lease covers. Empty when this process does not have that lease. */
export function leaseHeldDocuments(lease: string | undefined): string[] {
  const id = (lease ?? "").trim();
  if (!id) return [];
  return batchBoard().heldDocuments(id);
}

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
