/**
 * Timed local autosave and managed sync.
 * One pure schedule: when a document is due, when the whole session must wait, and the clocks that survive a restart.
 * At most one save or one sync runs on a tick. Documents are staggered so two of them are not due together.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const win = path.win32;

export const DOC_BUSY = "FMC-DOC-BUSY";

export interface DeferFacts {
  /** This document has a running or queued Revit job. */
  queueBusy: boolean;
  /** This document's own lease. Other documents do not count. */
  leasesHeld: number;
  /** A modal dialog is open (/health busy.dialog). */
  modalDialog: boolean;
  /** Free memory is under the pause line. */
  memoryPaused: boolean;
  /** The add-in says this document has an open transaction (FMC-DOC-BUSY). */
  docBusy: boolean;
}

/**
 * Skip this document and try again next tick. Null when it may save or sync.
 * leasesHeld and queueBusy are for this document only. A lease on another model does not defer it.
 */
export function deferReason(facts: DeferFacts): string | null {
  if (facts.queueBusy) return "A Revit job is running or queued on this document.";
  if (facts.leasesHeld > 0) return "A batch lease is held on this document.";
  if (facts.modalDialog) return "A modal dialog is open.";
  if (facts.memoryPaused) return "Memory pause is active.";
  if (facts.docBusy) return "The document has an open transaction or transaction group.";
  return null;
}

export function isDocBusyMessage(message: string | undefined): boolean {
  return typeof message === "string" && message.includes(DOC_BUSY);
}

/** index * (interval / count). Doc 0 has no offset. One document has no offset. */
export function staggerOffsetMs(index: number, count: number, intervalMs: number): number {
  if (count <= 1 || intervalMs <= 0 || index <= 0) return 0;
  const i = Math.min(index, count - 1);
  return Math.floor(i * intervalMs / count);
}

/**
 * First due time is startedAt plus the stagger offset.
 * After a save or sync, the next one is one full interval later, so the stagger is kept.
 */
export function nextActionAt(lastAt: number | null, startedAt: number, intervalMs: number, offsetMs: number): number {
  if (intervalMs <= 0) return startedAt + offsetMs;
  const origin = startedAt + offsetMs;
  if (lastAt == null) return origin;
  const earliest = lastAt + intervalMs;
  if (earliest <= origin) return origin;
  const steps = Math.ceil((earliest - origin) / intervalMs);
  return origin + steps * intervalMs;
}

export interface DueAction {
  kind: "save" | "sync" | "batch";
  document: string;
  at: number;
}

/** A due batch-end sync comes first. Otherwise the earliest action. Saves beat routine syncs that share a timestamp. */
export function pickOne(actions: DueAction[], now: number): DueAction | null {
  const due = actions.filter((action) => action.at <= now);
  const batch = (kind: DueAction["kind"]) => kind === "batch" ? 0 : 1;
  const save = (kind: DueAction["kind"]) => kind === "save" ? 0 : 1;
  due.sort((a, b) => batch(a.kind) - batch(b.kind) || a.at - b.at || save(a.kind) - save(b.kind) || a.document.localeCompare(b.document));
  return due[0] ?? null;
}

/** If the scheduled time is already past, step forward by whole intervals until it is ahead of now. */
export function nextOpenAt(at: number, now: number, intervalMs: number): number {
  if (intervalMs <= 0 || at > now) return at;
  const steps = Math.floor((now - at) / intervalMs) + 1;
  return at + steps * intervalMs;
}

export interface ScheduledDoc {
  title: string;
  path: string;
  family?: boolean;
  workshared?: boolean;
}

/** Project documents, stable order, so the stagger index does not jump between ticks. */
export function orderedProjects(docs: ScheduledDoc[]): ScheduledDoc[] {
  return docs.filter((doc) => !doc.family && (doc.title || doc.path)).slice().sort((a, b) => (a.path || a.title).localeCompare(b.path || b.title, undefined, { sensitivity: "base" }));
}

export interface DocClock {
  document: string;
  changedAt: number | null;
  lastSyncAt: number | null;
  lastSaveAt: number | null;
  lastError: string | null;
  /** A batch-end sync was deferred. The idle tick retries it until a sync succeeds. */
  pendingBatchEnd?: boolean;
  deferReason?: string | null;
}

export function clockKey(name: string): string {
  const norm = name.trim().toLowerCase().replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? norm;
  return base.replace(/\.rvt$/i, "");
}

export function syncStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA || win.join(os.homedir(), "AppData", "Roaming");
  return win.join(appData, "Formcraft", "fmc_sync_state.json");
}

export function loadSyncState(env: NodeJS.ProcessEnv = process.env, read: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): DocClock[] {
  try {
    const raw = JSON.parse(read(syncStatePath(env)).replace(/^\uFEFF/, "")) as { docs?: unknown };
    if (!Array.isArray(raw.docs)) return [];
    return raw.docs.map(asClock).filter((row): row is DocClock => row != null);
  } catch {
    return [];
  }
}

export function saveSyncState(docs: DocClock[], env: NodeJS.ProcessEnv = process.env, write: (file: string, text: string) => void = writeAtomic): void {
  write(syncStatePath(env), JSON.stringify({ docs }, null, 2));
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(win.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function asClock(value: unknown): DocClock | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const document = typeof row.document === "string" ? row.document.trim() : "";
  if (!document) return null;
  const at = (key: string) => (typeof row[key] === "number" && Number.isFinite(row[key] as number) ? row[key] as number : null);
  return {
    document,
    changedAt: at("changedAt"),
    lastSyncAt: at("lastSyncAt"),
    lastSaveAt: at("lastSaveAt"),
    lastError: typeof row.lastError === "string" ? row.lastError : null,
    ...(row.pendingBatchEnd === true ? { pendingBatchEnd: true } : {}),
    ...(typeof row.deferReason === "string" ? { deferReason: row.deferReason } : {}),
  };
}

/**
 * A workshared local with no clock is given changedAt = now, so the first managed sync has a time.
 * An excluded document is left out. A clock that already has a change or a sync is left as it is.
 */
export function seedWorksharedClocks(
  clocks: DocClock[],
  open: Array<{ title?: string; path?: string; workshared?: boolean; family?: boolean }>,
  now: number,
  excluded: (doc: { title?: string; path?: string }) => boolean,
): DocClock[] {
  const out = clocks.map((row) => ({ ...row }));
  for (const doc of open) {
    if (doc.workshared !== true || doc.family === true) continue;
    const name = (doc.title || doc.path || "").trim();
    if (!name || excluded({ title: doc.title, path: doc.path })) continue;
    const key = clockKey(name);
    const row = out.find((item) => clockKey(item.document) === key);
    if (!row) out.push({ document: doc.title || name, changedAt: now, lastSyncAt: null, lastSaveAt: null, lastError: null });
    else if (row.changedAt == null && row.lastSyncAt == null) row.changedAt = now;
  }
  return out;
}

/** An open document the add-in says is modified gets a changedAt when the clock has none. */
export function seedModified(clocks: DocClock[], open: Array<{ title?: string; path?: string; modified?: boolean }>, now: number): DocClock[] {
  const out = clocks.map((row) => ({ ...row }));
  for (const doc of open) {
    if (doc.modified !== true) continue;
    const name = (doc.title || doc.path || "").trim();
    if (!name) continue;
    const key = clockKey(name);
    const row = out.find((item) => clockKey(item.document) === key);
    if (!row) out.push({ document: doc.title || name, changedAt: now, lastSyncAt: null, lastSaveAt: null, lastError: null });
    else if (row.changedAt == null) row.changedAt = now;
  }
  return out;
}

export interface TickInput {
  now: number;
  startedAt: number;
  docs: ScheduledDoc[];
  clocks: DocClock[];
  saveIntervalMs: number;
  syncIntervalMs: number;
  /** Sync is off for this document (sync_exclude, not workshared, Stop AI, and the rest). */
  syncSkipped: (doc: ScheduledDoc) => boolean;
  /** Autosave is off for this document (family, protected, detached, Stop AI, and the rest). */
  saveSkipped: (doc: ScheduledDoc) => boolean;
  /** This document still owes a batch-end sync. It is due now and beats a routine save. */
  batchEnd?: (doc: ScheduledDoc) => boolean;
}

/** The one save or sync to run now, or null. */
export function planTick(input: TickInput): DueAction | null {
  const docs = orderedProjects(input.docs);
  const count = docs.length;
  const actions: DueAction[] = [];
  docs.forEach((doc, index) => {
    const name = doc.title || doc.path;
    const clock = input.clocks.find((row) => clockKey(row.document) === clockKey(name) || (doc.path && clockKey(row.document) === clockKey(doc.path)));
    const offset = staggerOffsetMs(index, count, Math.max(input.saveIntervalMs, input.syncIntervalMs));
    if (input.saveIntervalMs > 0 && !input.saveSkipped(doc)) {
      actions.push({ kind: "save", document: name, at: nextActionAt(clock?.lastSaveAt ?? null, input.startedAt, input.saveIntervalMs, offset) });
    }
    if (input.batchEnd?.(doc) && !input.syncSkipped(doc)) {
      actions.push({ kind: "batch", document: name, at: input.now });
    }
    const pending = clock?.changedAt != null && (clock.lastSyncAt == null || clock.changedAt > clock.lastSyncAt);
    if (input.syncIntervalMs > 0 && pending && !input.syncSkipped(doc)) {
      const anchor = clock?.lastSyncAt ?? clock?.changedAt ?? null;
      actions.push({ kind: "sync", document: name, at: nextActionAt(anchor, input.startedAt, input.syncIntervalMs, offset) });
    }
  });
  return pickOne(actions, input.now);
}
