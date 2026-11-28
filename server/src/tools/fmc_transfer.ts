import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import { errorCode, gapReply, planHash, writeRefusal } from "../fmc/gapcommon.js";
import { TRANSFER_FIX, TRANSFER_KINDS, planTransfer, sameProject, type TransferDoc, type TransferKind } from "../fmc/transfer.js";

export const FMC_TRANSFER_DESCRIPTION =
  "GAP-13. Copy view templates, filters, legends, revisions and sheets from one open document to another of the same project " +
  "(both under the same project folder, same Project Number when both have one). dry_run defaults to true and lists what would be copied, " +
  "duplicates (same name, same signature) and conflicts (same name or sheet number, different) by name. Nothing in the target is overwritten. " +
  "A write needs dry_run false, confirm true, the plan_hash from the dry run, and batch_lease on the target. One transaction in the target. " +
  "Sheets are created empty with the same title block type when the target has it; views on the sheet are not copied. Revisions are created unissued. " +
  "Example: source F26901-FMC-ZZ-ZZ-M3-A-0001, target F26901-FMC-ZZ-ZZ-M3-A-0002_USER, kinds [view_templates, filters], dry_run true.";

export const FMC_TRANSFER_SHAPE = {
  source: z.string().describe("Title or full path of the open document to copy from."),
  target: z.string().describe("Title or full path of the open document to copy into. Only this document changes."),
  kinds: z.array(z.enum(TRANSFER_KINDS)).optional().default([...TRANSFER_KINDS]),
  names: z.array(z.string()).optional().default([]).describe("Only these names (sheet numbers for sheets). Empty means all of the chosen kinds."),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("Must be true for a write, after the person has seen the dry run."),
  plan_hash: z.string().optional().default("").describe("plan_hash from the dry run. A write with another hash is refused."),
  batch_lease: z.string().optional().default(""),
};

export type FmcTransferArgs = z.infer<z.ZodObject<typeof FMC_TRANSFER_SHAPE>>;

export interface TransferIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  guard?: GuardConfig;
  env?: NodeJS.ProcessEnv;
}

const stamp = (extra: Record<string, unknown> = {}) => ({ tool: "fmc_transfer", saved: false, synced: false, ...extra });

function docOf(raw: unknown, fallback: string): TransferDoc {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    title: String(row.title ?? fallback),
    path: String(row.path ?? ""),
    is_central: row.is_central === true,
    project_number: String(row.project_number ?? ""),
    items: Array.isArray(row.items) ? row.items as TransferDoc["items"] : [],
  };
}

export async function runFmcTransfer(args: FmcTransferArgs, io: TransferIo = {}) {
  try {
    const source = args.source.trim();
    const target = args.target.trim();
    if (!source || !target) return gapReply(stamp({ refused: true, code: "FMC-TRANSFER-DOCS", message: TRANSFER_FIX["FMC-TRANSFER-DOCS"] }), true);
    const kinds = (args.kinds.length ? args.kinds : [...TRANSFER_KINDS]) as TransferKind[];
    const readBody = { source, target, document: target, kinds };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_transfer_read", readBody, 180000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return gapReply(stamp({ refused: true, code: String(body.code ?? "FMC-TRANSFER"), message: String(body.message ?? "The read was refused.") }), true);
    const src = docOf(body.source, source);
    const dst = docOf(body.target, target);
    const project = sameProject(src, dst);
    if (!project.same) return gapReply(stamp({ refused: true, code: "FMC-TRANSFER-PROJECT", message: `${TRANSFER_FIX["FMC-TRANSFER-PROJECT"]} ${project.reason}`, source: src.title, target: dst.title }), true);
    const plan = planTransfer(src, dst, kinds, args.names);
    const hash = planHash({ source: src.path.toLowerCase(), target: dst.path.toLowerCase(), ops: plan.ops });
    const dry = args.dry_run !== false;
    const summary = stamp({
      dry_run: dry, read_only: dry, source: src.title, target: dst.title, project_folder: project.folder,
      kinds, counts: plan.counts, ops: plan.ops, duplicates: plan.duplicates, conflicts: plan.conflicts, warnings: plan.warnings, plan_hash: hash,
    });
    if (dry) return gapReply({ ...summary, next: plan.ops.length ? "Nothing was copied. Show this plan to the person. To copy, call again with dry_run false, confirm true, this plan_hash and batch_lease on the target." : "Nothing to copy." });
    const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(io.env ?? process.env));
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    const refusal = writeRefusal("fmc_transfer", { dry_run: false, confirm: args.confirm === true, plan_hash: args.plan_hash, lease }, hash, dst, loaded.config, loaded.problem);
    if (refusal) return gapReply({ ...summary, refused: true, read_only: true, ...refusal }, true);
    if (!plan.ops.length) return gapReply({ ...summary, read_only: true, applied: { ok: true, applied: [], skipped: [] }, message: "Nothing to copy." });
    const roots = [...(loaded.config.protected_paths ?? []), ...protectedRoots(loaded.config)];
    const applyBody = { source, target, document: target, ops: plan.ops, protected_roots: roots, _protected_roots: roots };
    const applied = io.apply
      ? await io.apply(applyBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_transfer_apply", applyBody, 600000));
    return gapReply({ ...summary, read_only: false, applied });
  } catch (error) {
    return gapReply(stamp({ refused: true, ...errorCode(error, "FMC-TRANSFER") }), true);
  }
}

export function registerFmcTransferTool(server: McpServer) {
  server.tool("fmc_transfer", FMC_TRANSFER_DESCRIPTION, FMC_TRANSFER_SHAPE, async (args) => runFmcTransfer(args as FmcTransferArgs));
}
