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
}

const UNDO_LIMIT = "Revit 2025 has no API to clear the undo stack. GC.Collect runs after the closes. A save is not added.";

/** Unmodified family documents, then unmodified non-active non-workshared documents. Never the last document. */
export function planFree(docs: MemoryDoc[], dryRun = true): FreePlan {
  const open = docs.filter((doc) => (doc.title || doc.path));
  const kept: string[] = [];
  const candidates: MemoryDoc[] = [];
  for (const doc of open) {
    if (doc.modified) { kept.push(`${doc.title || doc.path}: modified`); continue; }
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
  return { close, kept, api_limits: [UNDO_LIMIT], dry_run: dryRun };
}

export interface PurgePlan {
  document: string;
  categories: string[];
  dry_run: boolean;
  api: "PerformanceAdviser";
  note: string;
}

export function planPurge(document: string, categories: string[] = [], dryRun = true): PurgePlan {
  return {
    document: document.trim(),
    categories: categories.map((item) => item.trim()).filter(Boolean),
    dry_run: dryRun,
    api: "PerformanceAdviser",
    note: "The add-in runs PerformanceAdviser rules whose name contains unused or purge, then deletes those elements when dry_run is false. A category filter keeps only matching categories. There is no separate Purge Unused command in the Revit 2025 API.",
  };
}
