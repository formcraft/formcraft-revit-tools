/**
 * Ids a batch created, kept after a sync has cleared Revit's undo list.
 * One JSON line per id in %APPDATA%\Formcraft\ledger\FMC_Created.jsonl (FMC_CREATED_DIR in tests).
 * The line is the id, the batch, the document and a fingerprint when the batch recorded one.
 * It is not the call ledger, and it is not used to rank people.
 */
import fs from "node:fs";
import path from "node:path";
import { formcraftHome } from "./jobs.js";

export interface CreatedRow {
  at: string;
  batch_id: string;
  document: string;
  id: string;
  fingerprint?: string;
  category?: string;
  source: string;
}

export interface ElementFact {
  id: string;
  exists: boolean;
  editable: boolean;
  owner?: string;
  fingerprint?: string;
  code?: string;
  reason?: string;
}

export interface UndoItem {
  id: string;
  fingerprint?: string;
  unchanged: "same" | "not recorded";
}

export interface UndoSkip {
  id: string;
  reason: string;
  code?: string;
}

export function createdFile(env: NodeJS.ProcessEnv = process.env): string {
  const own = (env.FMC_CREATED_DIR ?? "").trim();
  const dir = own || path.join(formcraftHome(env), "ledger");
  return path.join(dir, "FMC_Created.jsonl");
}

export function appendCreated(rows: CreatedRow[], env: NodeJS.ProcessEnv = process.env): void {
  if (!rows.length) return;
  const file = createdFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

export function readCreated(env: NodeJS.ProcessEnv = process.env): CreatedRow[] {
  let text = "";
  try { text = fs.readFileSync(createdFile(env), "utf8"); } catch { return []; }
  const out: CreatedRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line.replace(/^\uFEFF/, "")) as CreatedRow;
      if (row && row.batch_id && row.id) out.push(row);
    } catch { /* a torn line */ }
  }
  return out;
}

export function createdFor(batchId: string, env: NodeJS.ProcessEnv = process.env): CreatedRow[] {
  const want = batchId.trim().toLowerCase();
  if (!want) return [];
  const byId = new Map<string, CreatedRow>();
  for (const row of readCreated(env)) {
    if (row.batch_id.trim().toLowerCase() !== want) continue;
    const prior = byId.get(row.id);
    if (!prior || (row.fingerprint && !prior.fingerprint)) byId.set(row.id, row);
  }
  return [...byId.values()];
}

function asId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

interface FoundId { id: string; fingerprint?: string; category?: string }

function takeIds(node: unknown, into: FoundId[], seen: Set<object>): void {
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) takeIds(item, into, seen);
    return;
  }
  const body = node as Record<string, unknown>;
  if (Array.isArray(body.created)) {
    for (const item of body.created) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const id = asId(row.id);
      if (id) into.push({ id, fingerprint: typeof row.fingerprint === "string" ? row.fingerprint : undefined, category: typeof row.category === "string" ? row.category : undefined });
    }
  }
  if (Array.isArray(body.created_ids)) {
    for (const item of body.created_ids) {
      const id = asId(item);
      if (id) into.push({ id });
    }
  }
  for (const value of Object.values(body)) {
    if (value && typeof value === "object") takeIds(value, into, seen);
  }
}

function documentOf(params: Record<string, unknown>, result: Record<string, unknown>): string {
  const named = params.document;
  if (typeof named === "string" && named.trim()) return named.trim();
  const doc = result.document;
  if (typeof doc === "string" && doc.trim()) return doc.trim();
  if (doc && typeof doc === "object") {
    const title = (doc as { title?: unknown }).title;
    if (typeof title === "string" && title.trim()) return title.trim();
  }
  return "";
}

/**
 * Record created ids from a Revit write result.
 * Dry runs and rolled-back batches are skipped. The lease id and the result batch_id are both keys.
 */
export function captureCreated(params: Record<string, unknown> | undefined, result: unknown, env: NodeJS.ProcessEnv = process.env, lease = ""): number {
  if (!result || typeof result !== "object") return 0;
  const body = result as Record<string, unknown>;
  if (params?.dry_run === true || body.dry_run === true || body.applied === false) return 0;
  const found: FoundId[] = [];
  takeIds(body, found, new Set());
  if (!found.length) return 0;
  const keys = [body.batch_id, params?.batch_id, params?.label, lease]
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  const batchIds = [...new Set(keys)];
  if (!batchIds.length) return 0;
  const document = documentOf(params ?? {}, body);
  const at = new Date().toISOString();
  const rows: CreatedRow[] = [];
  const seen = new Set<string>();
  for (const batch_id of batchIds) {
    for (const item of found) {
      const key = `${batch_id}\0${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        at, batch_id, document, id: item.id, source: "batch",
        ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}),
        ...(item.category ? { category: item.category } : {}),
      });
    }
  }
  appendCreated(rows, env);
  return new Set(found.map((item) => item.id)).size;
}

/**
 * Decide which created ids can be deleted.
 * A missing element, an element owned by someone else, or an element whose fingerprint changed is kept.
 * No recorded fingerprint means unchanged is not known, and the id can still be deleted.
 */
export function planUndo(recorded: CreatedRow[], facts: ElementFact[]): { delete: UndoItem[]; skipped: UndoSkip[]; kept: string[] } {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const del: UndoItem[] = [];
  const skipped: UndoSkip[] = [];
  const kept: string[] = [];
  for (const row of recorded) {
    const fact = byId.get(row.id);
    if (!fact || !fact.exists) {
      skipped.push({ id: row.id, reason: "The element is not in the model.", code: "FMC-UNDO-GONE" });
      continue;
    }
    if (!fact.editable) {
      skipped.push({ id: row.id, reason: fact.reason || "This user cannot edit the element.", code: fact.code || "FMC-ELEM-OWNED-BY-OTHER" });
      kept.push(row.id);
      continue;
    }
    if (row.fingerprint && fact.fingerprint && row.fingerprint !== fact.fingerprint) {
      skipped.push({ id: row.id, reason: "The element changed after the batch.", code: "FMC-UNDO-CHANGED" });
      kept.push(row.id);
      continue;
    }
    del.push({ id: row.id, ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}), unchanged: row.fingerprint ? "same" : "not recorded" });
  }
  return { delete: del, skipped, kept };
}
