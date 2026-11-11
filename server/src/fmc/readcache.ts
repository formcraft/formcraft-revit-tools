/**
 * Short-lived reads of one document: its info, levels, types and views.
 * A write to that document, or the release of its lease, drops the cache.
 * Replies are counts and ids unless the caller passes verbose: true.
 */
import { WRITE_COMMANDS } from "./policy.js";

export type ReadKind = "info" | "levels" | "types" | "views";

/** Commands whose answers are safe to reuse until the document changes. */
export const CACHED_READS: Record<string, ReadKind> = {
  fmc_document_info: "info",
  analyze_model_statistics: "levels",
  get_available_family_types: "types",
  fmc_type_facts: "types",
  get_current_view_info: "views",
};

interface Entry { value: unknown }

const buckets = new Map<string, Map<string, Entry>>();

export function readDocumentKey(name: string): string {
  const norm = name.trim().toLowerCase().replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? norm;
  return base.replace(/\.rvt$/, "") || "active";
}

function paramsKey(params: unknown): string {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "";
  const copy = { ...(params as Record<string, unknown>) };
  delete copy.verbose;
  delete copy._full;
  delete copy._fmcActivity;
  delete copy._protected_roots;
  const keys = Object.keys(copy).sort();
  return keys.map((key) => `${key}:${JSON.stringify(copy[key])}`).join("|");
}

export function readCacheKey(command: string, params: unknown, document: string): string {
  return `${CACHED_READS[command]}|${readDocumentKey(document)}|${paramsKey(params)}`;
}

export function takeCachedRead(command: string, params: unknown, document: string): unknown | undefined {
  if (!CACHED_READS[command]) return undefined;
  return buckets.get(readDocumentKey(document))?.get(readCacheKey(command, params, document))?.value;
}

export function putCachedRead(command: string, params: unknown, document: string, value: unknown): void {
  if (!CACHED_READS[command] || value == null) return;
  const doc = readDocumentKey(document);
  let bag = buckets.get(doc);
  if (!bag) { bag = new Map(); buckets.set(doc, bag); }
  bag.set(readCacheKey(command, params, document), { value });
}

/** Drop one document, or every document when the name is empty. */
export function invalidateReads(document?: string): void {
  if (!document || !document.trim()) { buckets.clear(); return; }
  buckets.delete(readDocumentKey(document));
}

export function resetReadCache(): void {
  buckets.clear();
}

function idOf(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const key of ["id", "Id", "name", "title", "path", "uniqueId"]) {
    const found = row[key];
    if (typeof found === "string" || typeof found === "number") return found;
  }
  return null;
}

/** Counts and ids. Scalar fields stay so a lock or a save can still read title and path. */
export function compactReply(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { count: value.length, ids: value.map(idOf).filter((id) => id != null).slice(0, 40) };
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = compactReply(item);
  return out;
}

export function wantsFull(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const row = params as Record<string, unknown>;
  return row.verbose === true || row._full === true;
}

/** A write drops the document it names. Reads do not. */
export function invalidateIfWrite(command: string, document?: string): void {
  if (WRITE_COMMANDS.has(command)) invalidateReads(document);
}
