/**
 * Other people may be in the same workshared central. Managed sync and bot edits account for that.
 *
 * Revit 2025: SynchronizeWithCentral already reloads latest and then saves local changes. A separate
 * ReloadLatest still runs first, so a locked or busy central is seen before this user's changes are pushed.
 * The API cannot tell that the central is busy until that call is made. RelinquishOptions only drops
 * ownership the current user holds. There is no API to list or grant incoming editing requests.
 */
import fs from "node:fs";
import path from "node:path";
import { ledgerDir } from "./ledger.js";

const win = path.win32;

export const CENTRAL_BUSY = "central busy";
export const OWNED_BY_OTHER = "FMC-ELEM-OWNED-BY-OTHER";
export const NOT_CURRENT = "FMC-ELEM-NOT-CURRENT";

/** Revit 2025 does not expose incoming editing requests, and nothing here grants one. */
export const EDITING_REQUESTS = {
  granted: false,
  pending: null as null,
  reason: "Revit 2025 has no API to list or grant incoming editing requests. They stay for the person.",
};

export function centralBusyReason(message: string | undefined): typeof CENTRAL_BUSY | null {
  if (!message) return null;
  if (/\[FMC-CENTRAL-BUSY\]/i.test(message)) return CENTRAL_BUSY;
  if (/Stop AI|AI is off|protected original|live-model lock|isn't workshared|not workshared|verification copy|\[FMC-DOC-BUSY\]|\[FMC-ELEM-/i.test(message)) return null;
  if (/central model contention|centralmodelcontention|currently being accessed|another user|central.*locked|locked by|model is locked|temporarily unavailable|server busy|central.*busy/i.test(message)) return CENTRAL_BUSY;
  return null;
}

export interface CurrencyRow {
  id: string;
  owner?: string;
  checkout?: string;
  updates?: string;
}

export interface SkippedElement {
  id: string;
  code: typeof OWNED_BY_OTHER | typeof NOT_CURRENT;
  owner: string;
}

/** Kept ids may be edited. The rest are named and not sent. Nothing here requests a checkout. */
export function splitCheckout(ids: string[], rows: CurrencyRow[]): { kept: string[]; skipped: SkippedElement[] } {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const kept: string[] = [];
  const skipped: SkippedElement[] = [];
  for (const id of ids) {
    const row = byId.get(String(id));
    if (!row) { kept.push(String(id)); continue; }
    const checkout = (row.checkout ?? "").toLowerCase();
    const updates = (row.updates ?? "").toLowerCase();
    if (checkout === "ownedbyotheruser" || checkout === "owned by other user") {
      skipped.push({ id: String(id), code: OWNED_BY_OTHER, owner: row.owner || "another user" });
    } else if (updates === "updatedincentral" || updates === "deletedincentral" || updates === "updated in central" || updates === "deleted in central") {
      skipped.push({ id: String(id), code: NOT_CURRENT, owner: row.owner || "" });
    } else kept.push(String(id));
  }
  return { kept, skipped };
}

const ID_KEYS = new Set(["ids", "elementIds", "element_ids"]);
const ONE_KEYS = new Set(["id", "host", "element_id"]);

/** Element ids a write names. Nested ops are included. type_id is not. */
export function namedElementIds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) namedElementIds(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (ID_KEYS.has(key) && Array.isArray(item)) {
      for (const id of item) if (id != null && String(id).trim()) out.push(String(id));
    } else if (ONE_KEYS.has(key) && (typeof item === "number" || typeof item === "string") && String(item).trim()) {
      out.push(String(item));
    } else namedElementIds(item, out);
  }
  return out;
}

/** A copy of params with the skipped ids removed. */
export function withoutIds(params: unknown, skipped: SkippedElement[]): unknown {
  const drop = new Set(skipped.map((row) => row.id));
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (ID_KEYS.has(key) && Array.isArray(item)) out[key] = item.filter((id) => !drop.has(String(id)));
      else if (ONE_KEYS.has(key) && drop.has(String(item))) out[key] = null;
      else out[key] = walk(item);
    }
    return out;
  };
  return walk(params);
}

export type ConflictKind = "central_busy" | "reload_conflict" | "sync_failed" | "owned_by_other" | "not_current";

export interface ConflictLine {
  at: string;
  document: string;
  kind: ConflictKind;
  detail: string;
  code?: string;
}

export function conflictLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return win.join(ledgerDir(env), "FMC_SyncConflicts.jsonl");
}

export function appendConflict(line: ConflictLine, env: NodeJS.ProcessEnv = process.env, write: (file: string, text: string) => void = appendLine): void {
  try { write(conflictLogPath(env), JSON.stringify(line) + "\n"); } catch { /* the log never blocks a sync */ }
}

function appendLine(file: string, text: string): void {
  fs.mkdirSync(win.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
}

export interface DocConflictCounts {
  document: string;
  central_busy: number;
  reload_conflict: number;
  sync_failed: number;
  owned_by_other: number;
  not_current: number;
}

export function conflictCounts(text: string): DocConflictCounts[] {
  const byDoc = new Map<string, DocConflictCounts>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: ConflictLine;
    try { row = JSON.parse(line) as ConflictLine; } catch { continue; }
    const document = (row.document || "").trim() || "(unknown)";
    let counts = byDoc.get(document);
    if (!counts) {
      counts = { document, central_busy: 0, reload_conflict: 0, sync_failed: 0, owned_by_other: 0, not_current: 0 };
      byDoc.set(document, counts);
    }
    if (row.kind in counts) counts[row.kind] += 1;
  }
  return [...byDoc.values()];
}

export function coordinationReport(env: NodeJS.ProcessEnv = process.env, read: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): {
  editing_requests: typeof EDITING_REQUESTS;
  conflicts: DocConflictCounts[];
} {
  let text = "";
  try { text = read(conflictLogPath(env)); } catch { text = ""; }
  return { editing_requests: EDITING_REQUESTS, conflicts: conflictCounts(text) };
}
