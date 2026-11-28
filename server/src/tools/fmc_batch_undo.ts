/**
 * Delete elements a batch created, after a sync has cleared Revit's undo list.
 * The ids come from FMC_Created.jsonl. dry_run defaults to true. Apply needs confirm true.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { referenceProblems } from "../fmc/sheetlayout.js";
import { createdFor, planUndo, type ElementFact } from "../fmc/createdlog.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_BATCH_UNDO_DESCRIPTION =
  "Delete elements an AI batch created, after sync has cleared Revit's Undo. batch_id is the id recorded with those elements " +
  "(the modify_model batch_id, or the lease id when the write was recorded against the lease). " +
  "Each id must still exist, be editable by this user, and be unchanged when a fingerprint was stored. " +
  "dry_run defaults to true. Apply needs confirm true, batch_lease, and references.kit, references.standards and references.rulebook. " +
  "The apply is fmc_batch_undo_apply, one transaction. It does not check elements out and it does not undo a person's elements. " +
  "The reply lists deleted, kept and skipped. " +
  "Example: batch_id B09, document F26901-FMC-ZZ-ZZ-M3-P-0001_USER, dry_run true.";

export const FMC_BATCH_UNDO_SHAPE = {
  batch_id: z.string(),
  document: z.string().optional().default(""),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("Required, true, before an apply deletes anything."),
  batch_lease: z.string().optional().default(""),
  references: z.object({
    kit: z.array(z.string()).optional(),
    standards: z.array(z.string()).optional(),
    rulebook: z.array(z.string()).optional(),
  }).optional(),
};

export type FmcBatchUndoArgs = z.infer<z.ZodObject<typeof FMC_BATCH_UNDO_SHAPE>>;

export interface UndoIo {
  env?: NodeJS.ProcessEnv;
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
}

function factsOf(raw: unknown): ElementFact[] {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rows = Array.isArray(body.elements) ? body.elements : [];
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? "");
    if (!id) return [];
    const exists = row.exists !== false;
    const editable = row.editable === true || (exists && row.editable !== false && row.code == null);
    return [{
      id,
      exists,
      editable: exists && editable,
      owner: typeof row.owner === "string" ? row.owner : undefined,
      fingerprint: typeof row.fingerprint === "string" ? row.fingerprint : undefined,
      code: typeof row.code === "string" ? row.code : undefined,
      reason: typeof row.reason === "string" ? row.reason : undefined,
    }];
  });
}

export async function runFmcBatchUndo(args: FmcBatchUndoArgs, io: UndoIo = {}) {
  const env = io.env ?? process.env;
  const batch_id = args.batch_id.trim();
  if (!batch_id) return reply({ tool: "fmc_batch_undo", refused: true, code: "FMC-UNDO-BATCH", message: "[FMC-UNDO-BATCH] batch_id is required." }, true);
  const recorded = createdFor(batch_id, env);
  if (!recorded.length) {
    return reply({ tool: "fmc_batch_undo", refused: true, code: "FMC-UNDO-NONE", message: `[FMC-UNDO-NONE] No created ids are recorded for ${batch_id}.`, deleted: [], kept: [], skipped: [] }, true);
  }
  const document = args.document.trim() || recorded.find((row) => row.document)?.document || "";
  if (!document) return reply({ tool: "fmc_batch_undo", refused: true, code: "FMC-DOC-REQUIRED", message: "[FMC-DOC-REQUIRED] fmc_batch_undo needs document." }, true);
  const readBody = { document, ids: recorded.map((row) => row.id), fingerprints: recorded.map((row) => ({ id: row.id, fingerprint: row.fingerprint ?? "" })) };
  let raw: unknown;
  try {
    raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_batch_undo_read", readBody, 120000));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ tool: "fmc_batch_undo", refused: true, code: "FMC-UNDO", message }, true);
  }
  const plan = planUndo(recorded, factsOf(raw));
  const dry = args.dry_run !== false;
  const summary = {
    tool: "fmc_batch_undo",
    batch_id,
    document,
    dry_run: dry,
    read_only: dry,
    saved: false,
    synced: false,
    would_delete: plan.delete,
    deleted: [] as string[],
    kept: plan.kept,
    skipped: plan.skipped,
    cites: {
      kit: "Created ids are the batch's own elements",
      standards: "FMC-BIM-STD-002 worksharing: do not edit another user's elements",
      rulebook: "After sync, delete only ids this batch created that are still unchanged.",
    },
  };
  if (dry) return reply({ ...summary, next: "Apply with dry_run false and confirm true. That call is fmc_batch_undo_apply." });
  if (args.confirm !== true) {
    return reply({ ...summary, refused: true, code: "FMC-UNDO-CONFIRM", message: "[FMC-UNDO-CONFIRM] Apply needs confirm true. Nothing was deleted." }, true);
  }
  const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
  if (!lease) return reply({ ...summary, refused: true, code: "FMC-BATCH-LOCKED", message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was deleted." }, true);
  const refs = referenceProblems(args.references);
  if (refs) return reply({ ...summary, refused: true, code: "FMC-UNDO-REFERENCES", message: refs }, true);
  if (!plan.delete.length) return reply({ ...summary, refused: true, code: "FMC-UNDO-NONE", message: "[FMC-UNDO-NONE] Nothing left that this batch may delete." }, true);
  const applyBody = { document, ids: plan.delete.map((row) => row.id), fingerprints: plan.delete };
  try {
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_batch_undo_apply", applyBody, 120000)) as Record<string, unknown>;
    const deleted = Array.isArray(applied.deleted) ? applied.deleted.map((id) => String(id)) : plan.delete.map((row) => row.id);
    const skipped = [...plan.skipped, ...(Array.isArray(applied.skipped) ? applied.skipped as typeof plan.skipped : [])];
    return reply({ ...summary, dry_run: false, read_only: false, deleted, kept: plan.kept, skipped, applied });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ...summary, refused: true, code: "FMC-UNDO", message }, true);
  }
}

export function registerFmcBatchUndoTool(server: McpServer) {
  server.tool("fmc_batch_undo", FMC_BATCH_UNDO_DESCRIPTION, FMC_BATCH_UNDO_SHAPE, (args) => runFmcBatchUndo(args));
}
