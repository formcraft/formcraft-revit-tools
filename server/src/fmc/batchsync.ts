/**
 * Sync workshared models with central between batches.
 * Settings live in fmc_guard.json (sync_minutes, sync_on_batch_end) and apply to every open workshared document.
 * A non-workshared model is left to the existing auto-save. Stop AI and the live-model lock still refuse a sync.
 * The save and the sync are the existing fmc_revit_file actions (save, then sync with relinquish).
 * Central being busy retries with backoff and does not fail the batch.
 */
import { generalState } from "./aiuse.js";
import { loadAiConfig } from "./aiuse_io.js";
import { loadConfig, type DocInfo, type GuardConfig } from "./policy.js";
import { underAny, protectedRoots } from "./opencopy.js";

export interface SyncSettings { minutes: number; onBatchEnd: boolean }

export function syncSettings(cfg: { sync_minutes?: number; sync_on_batch_end?: boolean } | undefined): SyncSettings {
  const raw = cfg?.sync_minutes;
  const minutes = raw == null ? 15 : Math.floor(Number(raw));
  const safeMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : 15;
  const onBatchEnd = cfg?.sync_on_batch_end == null ? true : cfg.sync_on_batch_end === true;
  return { minutes: safeMinutes, onBatchEnd };
}

export interface SyncFacts {
  workshared: boolean;
  detached?: boolean;
  linked?: boolean;
  readOnly?: boolean;
  family?: boolean;
  protected?: boolean;
  stopAi: boolean;
  aiOn: boolean;
}

export interface SyncTiming {
  now: number;
  lastSyncAt: number | null;
  changedAt: number | null;
  leaseHeld: boolean;
  batchEnd: boolean;
}

export interface SyncPlan {
  run: boolean;
  reason: string;
  last_sync: string | null;
  next_sync: string | null;
}

const iso = (t: number | null) => (t == null ? null : new Date(t).toISOString());

/** Whether this document should sync now. Pure. */
export function planSync(facts: SyncFacts, timing: SyncTiming, settings: SyncSettings): SyncPlan {
  const last_sync = iso(timing.lastSyncAt);
  const pending = timing.changedAt != null && (timing.lastSyncAt == null || timing.changedAt > timing.lastSyncAt);
  const interval = settings.minutes > 0 ? settings.minutes * 60_000 : 0;
  const anchor = timing.lastSyncAt ?? timing.changedAt;
  const next_sync = pending && interval > 0 && anchor != null ? iso(anchor + interval) : null;
  const skip = (reason: string): SyncPlan => ({ run: false, reason, last_sync, next_sync: null });
  if (!facts.workshared) return skip("Not workshared. Autosave only.");
  if (facts.family || facts.detached || facts.linked || facts.readOnly) return skip("A family, a detached copy, a link or a read-only copy is not synced.");
  if (facts.protected) return skip("Protected original. The live-model lock refuses sync.");
  if (facts.stopAi) return skip("Stop AI is on. Sync waits.");
  if (!facts.aiOn) return skip("AI is off for this model. The live-model lock still applies. Sync waits.");
  if (!pending) return { run: false, reason: "No changes since the last sync.", last_sync, next_sync: null };
  const dueByTime = interval > 0 && anchor != null && timing.now - anchor >= interval;
  const dueByBatch = timing.batchEnd && settings.onBatchEnd;
  if (dueByBatch) return { run: true, reason: "Batch ended. Sync with central.", last_sync, next_sync };
  if (timing.leaseHeld) return { run: false, reason: "A batch holds this document. Sync runs between batches.", last_sync, next_sync };
  if (dueByTime) return { run: true, reason: `${settings.minutes} minutes of changes. Sync with central.`, last_sync, next_sync };
  if (!settings.onBatchEnd && interval === 0) return skip("Sync is off (sync_minutes 0 and sync_on_batch_end false).");
  return { run: false, reason: "Not due yet.", last_sync, next_sync };
}

export interface SyncRun {
  ran: boolean;
  ok: true;
  synced: boolean;
  detail: string;
  error?: string;
}

export function centralBusy(message: string): boolean {
  if (/Stop AI|AI is off|protected original|live-model lock|isn't workshared|not workshared|verification copy|\[FMC-/i.test(message)) return false;
  return /central|busy|locked|another user|temporarily|timed out|timeout|conflict|unavailable|being accessed/i.test(message);
}

export interface SyncSend { (command: string, params: Record<string, unknown>): Promise<unknown> }

/**
 * Save the local file, then sync with central and relinquish the elements this user has borrowed.
 * A busy central retries. The result is never a batch failure.
 */
export async function runDocumentSync(document: string, send: SyncSend, opts?: {
  sleep?: (ms: number) => Promise<void>;
  delays?: number[];
}): Promise<SyncRun> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delays = opts?.delays ?? [2_000, 5_000, 15_000];
  let last = "";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await send("fmc_revit_file", { action: "save", document, batch_sync: true });
      await send("fmc_revit_file", { action: "sync", document, relinquish: true, comment: "Formcraft batch sync", batch_sync: true });
      const extra = attempt ? ` after ${attempt} ${attempt === 1 ? "retry" : "retries"}` : "";
      return { ran: true, ok: true, synced: true, detail: `Saved the local file and synced ${document} with central (borrowed elements relinquished)${extra}.` };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (!centralBusy(last) || attempt === delays.length) break;
      await sleep(delays[attempt]);
    }
  }
  return {
    ran: true, ok: true, synced: false,
    detail: `Sync did not finish for ${document}. The batch is not failed. ${last}`,
    error: last,
  };
}

export function factsFor(doc: DocInfo | undefined, cfg: GuardConfig, env: NodeJS.ProcessEnv = process.env): SyncFacts {
  const ai = loadAiConfig(cfg, env);
  const state = generalState(ai, doc?.title ?? "", doc?.path ?? "");
  let protectedPath = false;
  try { protectedPath = !!doc?.path && underAny(doc.path, protectedRoots(cfg)); } catch { protectedPath = false; }
  return {
    workshared: doc?.isWorkshared === true,
    detached: doc?.isDetached === true,
    linked: doc?.isLinked === true,
    readOnly: doc?.readOnly === true,
    family: doc?.isFamily === true,
    protected: protectedPath,
    stopAi: state === "Stopped" || ai?.stop === true,
    aiOn: state === "On",
  };
}

export interface SyncStepContext {
  document: string;
  label: string;
  changedAt: number | null;
  lastSyncAt: number | null;
  /** False for the idle timer. A batch release omits it and is treated as the end of a batch. */
  batchEnd?: boolean;
}

/** Batch-end sync. Skips a document the plan refuses. Never throws. */
export async function productionSyncStep(ctx: SyncStepContext, now = Date.now()): Promise<SyncRun> {
  const { withRevitConnection } = await import("../utils/ConnectionManager.js");
  const cfg = loadConfig().config;
  const settings = syncSettings(cfg);
  let active: DocInfo | undefined;
  try {
    const info = await withRevitConnection((client) => client.sendCommand("fmc_document_info", { document: ctx.document })) as { active?: DocInfo };
    active = info?.active;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ran: false, ok: true, synced: false, detail: `The document could not be read, so it was not synced. ${message}`, error: message };
  }
  const batchEnd = ctx.batchEnd !== false;
  const plan = planSync(factsFor(active, cfg), {
    now, lastSyncAt: ctx.lastSyncAt, changedAt: ctx.changedAt ?? (batchEnd ? now : null), leaseHeld: false, batchEnd,
  }, settings);
  if (!plan.run) return { ran: false, ok: true, synced: false, detail: plan.reason };
  try {
    return await runDocumentSync(ctx.document, (command, params) => withRevitConnection((client) => client.sendCommand(command, params)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ran: true, ok: true, synced: false, detail: `Sync did not finish for ${ctx.document}. The batch is not failed. ${message}`, error: message };
  }
}
