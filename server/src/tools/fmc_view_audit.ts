import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import { errorCode, gapReply, planHash, writeRefusal } from "../fmc/gapcommon.js";
import { DETAIL_LEVELS, DISCIPLINES, auditViews, planFixes, type ViewAuditRead, type ViewFix } from "../fmc/viewaudit.js";

export const FMC_VIEW_AUDIT_DESCRIPTION =
  "View and view template audit. The report comes first: views with no template, template parameters that are not controlled " +
  "(GetNonControlledTemplateParameterIds), unused templates and filters, views not on sheets, and view range, discipline, detail level, crop, " +
  "scope box and link override state. Optional fixes run in one batch: assign_template, control_template_params, set_detail_level, set_discipline, " +
  "set_crop, set_scope_box. dry_run defaults to true and returns the planned fixes and a plan_hash. A write needs dry_run false, confirm true, " +
  "that plan_hash and batch_lease. One transaction, one subtransaction per fix. Nothing is deleted: unused templates and filters are reported only. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, then fixes [{op: assign_template, view: Level 1, template: FMC_A_Plan}] with dry_run true.";

const FIX = z.discriminatedUnion("op", [
  z.object({ op: z.literal("assign_template"), view: z.string(), template: z.string() }),
  z.object({ op: z.literal("control_template_params"), template: z.string(), parameters: z.array(z.string()).optional().describe("Names to control. Empty controls every non-controlled parameter.") }),
  z.object({ op: z.literal("set_detail_level"), view: z.string(), level: z.enum(DETAIL_LEVELS) }),
  z.object({ op: z.literal("set_discipline"), view: z.string(), discipline: z.enum(DISCIPLINES) }),
  z.object({ op: z.literal("set_crop"), view: z.string(), crop_active: z.boolean().optional(), crop_visible: z.boolean().optional() }),
  z.object({ op: z.literal("set_scope_box"), view: z.string(), scope_box: z.string().describe("Scope box name. Empty removes the scope box.") }),
]);

export const FMC_VIEW_AUDIT_SHAPE = {
  document: z.string().optional().default(""),
  fixes: z.array(FIX).optional().default([]),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false).describe("Must be true for a write, after the person has seen the dry run."),
  plan_hash: z.string().optional().default("").describe("plan_hash from the dry run. A write with another hash is refused."),
  batch_lease: z.string().optional().default(""),
  limit: z.number().int().min(1).max(5000).optional().default(200).describe("Rows per list in the report."),
};

export type FmcViewAuditArgs = z.infer<z.ZodObject<typeof FMC_VIEW_AUDIT_SHAPE>>;

export interface ViewAuditIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  guard?: GuardConfig;
  env?: NodeJS.ProcessEnv;
}

export async function runFmcViewAudit(args: FmcViewAuditArgs, io: ViewAuditIo = {}) {
  const stamp = { tool: "fmc_view_audit", saved: false, synced: false, deleted: 0 };
  try {
    const document = args.document.trim();
    if (!document) return gapReply({ ...stamp, refused: true, code: "FMC-DOC-REQUIRED", message: "fmc_view_audit needs document, a title or a full path. The active document is not a guess." }, true);
    const body = { document };
    const raw = io.read ? await io.read(body) : await withRevitConnection((client) => client.sendCommand("fmc_view_audit_read", body, 600000));
    const read = (raw && typeof raw === "object" ? raw : {}) as ViewAuditRead;
    const full: ViewAuditRead = { ...read, views: read.views ?? [], templates: read.templates ?? [], filters: read.filters ?? [] };
    const report = auditViews(full, args.limit);
    const fixes = (args.fixes ?? []) as ViewFix[];
    const planned = planFixes(full, fixes);
    const hash = planHash({ path: String(read.path ?? document).toLowerCase(), ops: planned.ops });
    const dry = args.dry_run !== false;
    const summary = {
      ...stamp, document: read.title ?? document, dry_run: dry, read_only: dry, report,
      ...(fixes.length ? { fixes: { ops: planned.ops, skipped: planned.skipped, warnings: planned.warnings }, plan_hash: hash } : {}),
      ...(read.capped ? { note: "The read stopped at its view limit; counts are partial." } : {}),
    };
    if (dry) return gapReply({ ...summary, next: planned.ops.length ? "Nothing was changed. Show the report and the planned fixes to the person. To apply, call again with the same fixes, dry_run false, confirm true, this plan_hash and batch_lease." : "Report only. Add fixes to plan a batch." });
    if (!fixes.length) return gapReply({ ...summary, refused: true, read_only: true, code: "FMC-VIEWAUDIT-NO-FIXES", message: "dry_run false needs fixes." }, true);
    const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(io.env ?? process.env));
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    const doc = { title: String(read.title ?? document), path: String(read.path ?? ""), is_central: read.is_central === true };
    const refusal = writeRefusal("fmc_view_audit", { dry_run: false, confirm: args.confirm === true, plan_hash: args.plan_hash, lease }, hash, doc, loaded.config, loaded.problem);
    if (refusal) return gapReply({ ...summary, refused: true, read_only: true, ...refusal }, true);
    if (!planned.ops.length) return gapReply({ ...summary, read_only: true, applied: { ok: true, applied: [], failed: [] }, message: "Nothing to change." });
    const roots = [...(loaded.config.protected_paths ?? []), ...protectedRoots(loaded.config)];
    const applyBody = { document, ops: planned.ops, protected_roots: roots, _protected_roots: roots };
    const applied = io.apply ? await io.apply(applyBody) : await withRevitConnection((client) => client.sendCommand("fmc_view_audit_apply", applyBody, 600000));
    return gapReply({ ...summary, read_only: false, applied });
  } catch (error) {
    return gapReply({ ...stamp, refused: true, ...errorCode(error, "FMC-VIEWAUDIT") }, true);
  }
}

export function registerFmcViewAuditTool(server: McpServer) {
  server.tool("fmc_view_audit", FMC_VIEW_AUDIT_DESCRIPTION, FMC_VIEW_AUDIT_SHAPE, async (args) => runFmcViewAudit(args as FmcViewAuditArgs));
}
