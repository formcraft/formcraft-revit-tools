/**
 * What fmc_memory may close, and the purge plan. Thresholds stay 1024 / 1536.
 * Revit 2025 has no API that clears the undo stack. The plan says so.
 */
import { DEFAULT_PAUSE_MB } from "./memory.js";

export const MEMORY_PAUSE_MB = DEFAULT_PAUSE_MB;
export const MEMORY_RESUME_MB = Math.round(DEFAULT_PAUSE_MB * 1.5);

export interface MemoryDoc {
  title: string;
  path: string;
  family?: boolean;
  workshared?: boolean;
  active?: boolean;
  modified?: boolean;
}

export interface FreePlan {
  close: MemoryDoc[];
  kept: string[];
  api_limits: string[];
  dry_run: boolean;
  open_question?: string;
}

const UNDO_LIMIT = "Revit 2025 has no API to clear the undo stack. GC.Collect runs after the closes. A save is not added.";

/** Open question for the owner (Emlyn), flagged and not decided here: should a never-saved document such as Project1 be a sandbox? */
export const NEVER_SAVED_QUESTION = "A never-saved document (no file, e.g. Project1) is kept: closing it would discard it with nothing to reopen. Whether such a document may be used as a sandbox is the owner's call (Emlyn), not decided here.";

/** Unmodified family documents, then unmodified non-active non-workshared documents. Never the last document, never a document with no file. */
export function planFree(docs: MemoryDoc[], dryRun = true): FreePlan {
  const open = docs.filter((doc) => (doc.title || doc.path));
  const kept: string[] = [];
  const candidates: MemoryDoc[] = [];
  for (const doc of open) {
    if (doc.modified) { kept.push(`${doc.title || doc.path}: modified`); continue; }
    // "Unmodified" means nothing for a document that was never saved: closing it loses it.
    if (!(doc.path ?? "").trim()) { kept.push(`${doc.title}: never saved (no file to reopen)`); continue; }
    if (doc.active) { kept.push(`${doc.title || doc.path}: active`); continue; }
    if (doc.family) { candidates.push(doc); continue; }
    if (doc.workshared) { kept.push(`${doc.title || doc.path}: workshared`); continue; }
    candidates.push(doc);
  }
  const close: MemoryDoc[] = [];
  let left = open.length;
  for (const doc of candidates) {
    if (left <= 1) { kept.push(`${doc.title || doc.path}: last document`); break; }
    close.push(doc);
    left -= 1;
  }
  const neverSaved = open.some((doc) => !(doc.path ?? "").trim());
  return { close, kept, api_limits: [UNDO_LIMIT], dry_run: dryRun, ...(neverSaved ? { open_question: NEVER_SAVED_QUESTION } : {}) };
}

export interface PurgePlan {
  document: string;
  /** Categories that are never deleted (the shape's categories, as its description always said). */
  keep_categories: string[];
  /** When set, only these categories may be deleted. Empty means every category the rules list. */
  only_categories: string[];
  dry_run: boolean;
  api: "PerformanceAdviser";
  note: string;
}

const clean = (list: string[] | undefined) => (list ?? []).map((item) => item.trim()).filter(Boolean);

export function planPurge(document: string, keep: string[] = [], dryRun = true, only: string[] = []): PurgePlan {
  return {
    document: document.trim(),
    keep_categories: clean(keep),
    only_categories: clean(only),
    dry_run: dryRun,
    api: "PerformanceAdviser",
    note: "The add-in runs PerformanceAdviser rules whose name contains unused or purge, then deletes those elements when dry_run is false. " +
      "keep_categories (categories) are never deleted; only_categories, when set, limits the delete to those. There is no separate Purge Unused command in the Revit 2025 API.",
  };
}
