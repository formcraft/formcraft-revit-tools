import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { DEFAULT_MAX, DEFAULT_WIPE_CATEGORIES, WIPE_CATEGORIES, WIPE_CATEGORY_HELP, asRows, planWipe, wipeGate } from "../fmc/wipe.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_WIPE_DESCRIPTION =
  "Formcraft model wipe (GAP-02): finds a project model's clutter and reports counts and element ids per category: " +
  Object.entries(WIPE_CATEGORY_HELP).map(([k, v]) => `${k} (${v})`).join("; ") + ". " +
  "scan is read-only. apply deletes only with dry_run=false AND confirm=true under a batch lease, at most max elements " +
  "(default 500); dry_run defaults to true. Elements another user owns and protected names (FMC_ kit templates and filters, " +
  "{3D} views, plus protect patterns) are skipped and listed. ids limits a delete to ones you picked from the scan. " +
  "Every element is checked again in Revit before it is deleted. Not for families (fmc_fam_purge) or materials (fmc_material_purge).";

export const FMC_WIPE_SHAPE = {
  action: z.enum(["scan", "apply"]),
  document: z.string().describe("The document title or full path"),
  categories: z.array(z.enum(WIPE_CATEGORIES)).optional().default(DEFAULT_WIPE_CATEGORIES),
  protect: z.array(z.string()).optional().default([]).describe("Extra name patterns (regular expressions) to keep"),
  ids: z.array(z.string()).optional().default([]).describe("apply: only these ids (from a scan)"),
  max: z.number().int().positive().optional().default(DEFAULT_MAX),
  confirm: z.boolean().optional().default(false),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
};

export type FmcWipeArgs = z.infer<z.ZodObject<typeof FMC_WIPE_SHAPE>>;

export interface WipeIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
}

const base = { tool: "fmc_wipe" };

export async function runFmcWipe(args: FmcWipeArgs, io: WipeIo = {}) {
  const env = io.env ?? process.env;
  try {
    const document = args.document.trim();
    if (!document) return reply({ ...base, refused: true, code: "FMC-DOC-REQUIRED", message: "fmc_wipe needs document (a title or full path)." }, true);
    const readBody = { document, categories: args.categories };
    const raw = (io.read ? await io.read(readBody) : await withRevitConnection((c) => c.sendRaw("fmc_wipe_scan", readBody, 300000))) as Record<string, unknown>;
    const plan = planWipe(asRows(raw), { categories: args.categories, protect: args.protect, onlyIds: args.action === "apply" ? args.ids : [] });
    const problems = [...plan.problems, ...((raw?.problems as string[]) ?? [])];
    const title = String(raw?.title ?? document);
    const summary = {
      ...base, action: args.action, document: title, counts: plan.counts, total: plan.items.length, ids: plan.ids,
      skipped: plan.skipped, skipped_count: plan.skipped.length, problems, warnings: (raw?.warnings as string[]) ?? [],
    };
    if (args.action === "scan") return reply({ ...summary, read_only: true, next: "To delete: action apply, dry_run=false, confirm=true and a batch_lease (optionally ids from this scan)." });

    const dry = args.dry_run !== false;
    const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    const blocked = saveBlocked({ title, path: String(raw?.path ?? "") }, loaded.config) || loaded.problem;
    const needs = wipeGate({ dry_run: false, confirm: args.confirm, lease, blocked, count: plan.items.length, max: args.max });
    if (dry) return reply({ ...summary, dry_run: true, read_only: true, would_delete: plan.items.length, needs_for_real_run: needs, next: "Nothing was deleted." });
    if (plan.problems.length) return reply({ ...summary, refused: true, code: "FMC-WIPE-IDS", dry_run: false }, true);
    if (needs.length) return reply({ ...summary, refused: true, code: needs.some((n) => n.includes("batch_lease")) ? "FMC-BATCH-LOCKED" : "FMC-WIPE-GATE", dry_run: false, needs_for_real_run: needs }, true);
    if (!plan.items.length) return reply({ ...summary, dry_run: false, deleted: [], deleted_count: 0, next: "Nothing to delete." });

    const body = { document, items: plan.items.map((i) => ({ id: i.id, category: i.category })), categories: args.categories, batch_lease: lease };
    const res = (io.apply ? await io.apply(body) : await withRevitConnection((c) => c.sendCommand("fmc_wipe_apply", body, 600000))) as Record<string, unknown>;
    const deleted = ((res?.deleted as unknown[]) ?? []).map(String);
    const revitSkipped = (res?.skipped as unknown[]) ?? [];
    return reply({
      ...summary, dry_run: false,
      deleted_count: deleted.length, deleted,
      cascade_count: Number(res?.cascade_count ?? 0), cascade_ids: res?.cascade_ids ?? [],
      skipped_in_revit: revitSkipped, skipped_in_revit_count: revitSkipped.length,
      transaction: res?.transaction ?? "Formcraft: wipe",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply({ ...base, refused: true, code: message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-WIPE", message }, true);
  }
}

export function registerFmcWipeTool(server: McpServer) {
  server.tool("fmc_wipe", FMC_WIPE_DESCRIPTION, FMC_WIPE_SHAPE, async (args) => runFmcWipe(args as FmcWipeArgs));
}
