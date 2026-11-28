/**
 * Split a batch file into one sub-batch per document.
 * Documents are sorted by the batch line's document key so two files split the same way.
 * A sub-batch runs only after the previous document is released. They are not held together.
 */
import fs from "node:fs";
import { documentKey, sortDocumentNames } from "./batchline.js";

export interface BatchOp {
  op?: string;
  document?: string;
  [key: string]: unknown;
}

export interface SubBatch {
  document: string;
  key: string;
  ops: BatchOp[];
  count: number;
}

export interface SplitPlan {
  ok: true;
  batch_id: string;
  documents: string[];
  sub_batches: SubBatch[];
  mode: "one" | "sequence";
}

export { sortDocumentNames };

export function splitOps(ops: BatchOp[], fallback = ""): { documents: string[]; sub_batches: SubBatch[]; missing: number } {
  const groups = new Map<string, { document: string; ops: BatchOp[] }>();
  let missing = 0;
  for (const op of ops) {
    const named = String(op?.document ?? "").trim() || fallback.trim();
    if (!named) {
      missing += 1;
      continue;
    }
    const key = documentKey(named);
    const row = groups.get(key) ?? { document: named, ops: [] };
    row.ops.push(op);
    groups.set(key, row);
  }
  const documents = sortDocumentNames([...groups.values()].map((row) => row.document));
  const sub_batches = documents.map((document) => {
    const key = documentKey(document);
    const found = groups.get(key)?.ops ?? [];
    return { document, key, ops: found, count: found.length };
  });
  return { documents, sub_batches, missing };
}

export function readBatchOps(file: string): { batch_id: string; document: string; ops: BatchOp[] } {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return { batch_id: "", document: "", ops: parsed as BatchOp[] };
  if (!parsed || typeof parsed !== "object") throw new Error("[FMC-BATCH-BAD] The batch file is not a JSON object or an array of ops.");
  const body = parsed as Record<string, unknown>;
  const ops = Array.isArray(body.ops) ? body.ops as BatchOp[] : [];
  const batch_id = String(body.batch_id ?? body.batch ?? body.label ?? "").trim();
  const document = String(body.document ?? "").trim();
  return { batch_id, document, ops };
}

/** Read a batch file and group ops by op.document. One document is mode "one". Several are "sequence". */
export function splitBatchFile(file: string): SplitPlan | { ok: false; code: string; message: string } {
  let read: ReturnType<typeof readBatchOps>;
  try {
    read = readBatchOps(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = message.startsWith("[FMC-") ? message : `[FMC-BATCH-BAD] ${message}`;
    return { ok: false, code: "FMC-BATCH-BAD", message: text };
  }
  if (!read.ops.length) return { ok: false, code: "FMC-BATCH-BAD", message: "[FMC-BATCH-BAD] The batch file has no ops." };
  const split = splitOps(read.ops, read.document);
  if (split.missing) {
    return {
      ok: false,
      code: "FMC-BATCH-BAD",
      message: `[FMC-BATCH-BAD] ${split.missing} op(s) have no document. Set op.document or the file's document.`,
    };
  }
  return {
    ok: true,
    batch_id: read.batch_id,
    documents: split.documents,
    sub_batches: split.sub_batches,
    mode: split.documents.length > 1 ? "sequence" : "one",
  };
}
