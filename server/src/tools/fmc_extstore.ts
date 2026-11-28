import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import {
  EXTSTORE_FIELDS, EXTSTORE_SCHEMA_GUID, EXTSTORE_SCHEMA_NAME, EXTSTORE_SOURCES, asRows, auditRows, normalise, planWrites, type ExtRecord,
} from "../fmc/extstore.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_EXTSTORE_DESCRIPTION =
  "Formcraft Extensible Storage on elements (GAP-19): one fixed schema, FMC_ExtStore (" + EXTSTORE_SCHEMA_GUID + ", vendor " +
  "Formcraft), holding FmcId, BatchId, RecipeHash and Source. read (read-only): the record on the given element ids, or " +
  "every stamped element with all=true. audit (read-only): every stamped element, duplicate FmcIds, invalid values, counts " +
  "by batch and source, elements another user owns. write: records [{id, fmc_id, batch_id, recipe_hash, source}] planned " +
  "against what each element holds now (create, update, same, skip). dry_run defaults to true and only returns the plan. " +
  "A real write needs dry_run=false and a batch_lease; it is one transaction, never stamps an element another user owns, " +
  "never moves an FmcId that is already on another element, and keeps an element's existing FmcId unless reassign=true. " +
  "Source is one of " + EXTSTORE_SOURCES.join(", ") + ".";

const record = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  fmc_id: z.string(),
  batch_id: z.string(),
  recipe_hash: z.string().optional().default(""),
  source: z.string(),
});

export const FMC_EXTSTORE_SHAPE = {
  action: z.enum(["read", "write", "audit"]),
  document: z.string().optional().default("").describe("The document title or path (required)"),
  ids: z.array(z.union([z.string(), z.number()])).optional().default([]).describe("read: element ids"),
  all: z.boolean().optional().default(false).describe("read: every stamped element instead of ids"),
  records: z.array(record).optional().default([]).describe("write: the records to stamp"),
  reassign: z.boolean().optional().default(false).describe("write: let a record change an element's existing FmcId"),
  limit: z.number().int().positive().max(20000).optional().default(5000),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
};

export type FmcExtstoreArgs = z.infer<z.ZodObject<typeof FMC_EXTSTORE_SHAPE>>;

export interface ExtstoreIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
}

const base = { tool: "fmc_extstore", schema: { guid: EXTSTORE_SCHEMA_GUID, name: EXTSTORE_SCHEMA_NAME, fields: EXTSTORE_FIELDS } };

function refused(code: string, message: string, extra: object = {}) {
  return reply({ ...base, refused: true, code, message, ...extra }, true);
}

export async function runFmcExtstore(args: FmcExtstoreArgs, io: ExtstoreIo = {}) {
  const env = io.env ?? process.env;
  try {
    const document = args.document.trim();
    if (!document) return refused("FMC-DOC-REQUIRED", "fmc_extstore needs document (a title or full path).");
    const read = (body: Record<string, unknown>) => io.read
      ? io.read(body)
      : withRevitConnection((c) => c.sendRaw("fmc_extstore_read", body, 180000));

    if (args.action === "read") {
      const ids = args.ids.map(String);
      if (!args.all && !ids.length) return refused("FMC-EXTSTORE-IDS", "read needs ids, or all=true.");
      const raw = await read({ document, ids, all: args.all, limit: args.limit, schema_guid: EXTSTORE_SCHEMA_GUID }) as Record<string, unknown>;
      const rows = asRows(raw);
      return reply({ ...base, action: "read", read_only: true, document: raw?.title ?? document, schema_present: raw?.schema_present === true,
        count: rows.length, truncated: raw?.truncated === true, missing: raw?.missing ?? [], rows });
    }

    if (args.action === "audit") {
      const raw = await read({ document, ids: [], all: true, limit: args.limit, schema_guid: EXTSTORE_SCHEMA_GUID }) as Record<string, unknown>;
      const rows = asRows(raw);
      const audit = auditRows(rows);
      const clean = !audit.duplicate_fmc_ids.length && !audit.invalid.length;
      return reply({ ...base, action: "audit", read_only: true, document: raw?.title ?? document, schema_present: raw?.schema_present === true,
        truncated: raw?.truncated === true, clean, ...audit });
    }

    // write
    if (!args.records.length) return refused("FMC-EXTSTORE-RECORDS", "write needs records.");
    const records: ExtRecord[] = args.records.map((r) => normalise(r as ExtRecord));
    const raw = await read({ document, ids: records.map((r) => r.id), all: false, limit: args.limit, schema_guid: EXTSTORE_SCHEMA_GUID }) as Record<string, unknown>;
    const plan = planWrites(records, asRows(raw), { reassign: args.reassign });
    const missing = Array.isArray(raw?.missing) ? (raw.missing as unknown[]).map(String) : [];
    for (const row of plan.rows) if (missing.includes(row.id)) { row.action = "skip"; row.changes = []; row.reason = "no such element in the document"; }
    const counts = plan.rows.reduce((m: Record<string, number>, r) => ({ ...m, [r.action]: (m[r.action] ?? 0) + 1 }), {});
    const summary = { ...base, action: "write", document: raw?.title ?? document, counts, plan: plan.rows, problems: plan.problems };
    if (plan.problems.length) return reply({ ...summary, refused: true, code: "FMC-EXTSTORE-INVALID", dry_run: args.dry_run !== false }, true);
    const dry = args.dry_run !== false;
    if (dry) return reply({ ...summary, dry_run: true, read_only: true, next: "Nothing was written. Run again with dry_run=false and a batch_lease to stamp the create and update rows." });

    const doc = { title: String(raw?.title ?? document), path: String(raw?.path ?? "") };
    const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
    const blocked = saveBlocked(doc, loaded.config) || loaded.problem;
    if (blocked) return refused("FMC-EXTSTORE-GUARD", blocked, summary);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return refused("FMC-BATCH-LOCKED", "A real write needs a batch_lease (writes only under a batch lease).", summary);
    const toWrite = plan.rows.filter((r) => r.action === "create" || r.action === "update").map((r) => records.find((x) => x.id === r.id)!);
    if (!toWrite.length) return reply({ ...summary, dry_run: false, applied: { written: 0 }, next: "Nothing to write: every row is same or skipped." });
    const body = { document, records: toWrite, schema_guid: EXTSTORE_SCHEMA_GUID, batch_lease: lease, reassign: args.reassign };
    const applied = io.apply
      ? await io.apply(body)
      : await withRevitConnection((c) => c.sendCommand("fmc_extstore_write", body, 300000));
    return reply({ ...summary, dry_run: false, read_only: false, applied });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refused(message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-EXTSTORE", message);
  }
}

export function registerFmcExtstoreTool(server: McpServer) {
  server.tool("fmc_extstore", FMC_EXTSTORE_DESCRIPTION, FMC_EXTSTORE_SHAPE, async (args) => runFmcExtstore(args as FmcExtstoreArgs));
}
