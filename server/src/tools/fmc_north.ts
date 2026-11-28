import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import {
  capFindings, compareSnapshot, coordPlan, gridSetsOf, normalizeNorth, planAlign, planArrows, prepareDoc,
  referenceProblems, resolveNorthTolerances, viewRotationRows, writeNorthReport, type NorthDoc, type NorthSnapshot,
} from "../fmc/north.js";
import { NORTH_FIX, roleOf } from "../fmc/northmath.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_NORTH_DESCRIPTION =
  "Formcraft true north and project north. fmc_coord keeps the coordination record and is the tool that may move a survey point. " +
  "fmc_north never calls SetProjectPosition and never acquires coordinates. " +
  "audit reads each named document, or every open project when all_open is true: project-north to true-north angle in degrees " +
  "(ProjectLocation.GetProjectPosition at the internal origin), the active site, shared east/north/elevation, the survey point and the project base point, " +
  "each view's Project North or True North setting, and each grid set's dominant angle. " +
  "compare checks open A, E, P and S models, or the documents you list, against north.tol_deg and north.tol_mm; on a mismatch it adds coord_plan, a ready fmc_coord plan (publish from the S or A model, then check and align each other model, all dry runs) " +
  "(else coord.tol_deg and coord.tol_mm; else the provisional 0.01 deg and 1 mm, which cannot PASS). " +
  "A linked instance is compared with GetTotalTransform against shared coordinates. Mismatches use FMC-NORTH-ANGLE-MISMATCH and FMC-NORTH-SURVEY-MISMATCH. " +
  "align_views rotates plan views square to a grid set by the crop region or a scope box. It does not change project north. dry_run defaults to true. " +
  "A real rotate is fmc_north_apply, one transaction, and needs batch_lease plus references.kit, references.standards and references.rulebook. " +
  "north_arrows sets a sheet north-arrow family's rotation from the project angle plus the view crop rotation. Unmatched viewports are reported. " +
  "The reply is a summary and a capped id list. The full JSON is under %LOCALAPPDATA%\\Formcraft\\north. No pictures. " +
  "Pass document on a write. A missing name is FMC-DOC-REQUIRED. The active document is not a guess. " +
  "HEBERT HOSTELS, a central model, and protected_paths are refused. " +
  "Example: action audit, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_NORTH_SHAPE = {
  action: z.enum(["audit", "compare", "align_views", "north_arrows"]),
  document: z.string().optional().default("").describe("Title or full path. Required for align_views and north_arrows."),
  documents: z.array(z.string()).optional().default([]).describe("audit or compare: these open documents. compare with an empty list uses open A, E, P and S models."),
  all_open: z.boolean().optional().default(false).describe("audit: every open project document. Not the active document alone."),
  roles: z.array(z.string()).optional().default(["A", "E", "P", "S"]),
  include_links: z.boolean().optional().describe("compare reads link transforms. Default true."),
  views: z.array(z.string()).optional().default([]).describe("Plan view names or ids. align_views with only grid_set uses plan views whose names contain the set."),
  sheets: z.array(z.string()).optional().default([]).describe("north_arrows: sheet numbers, names or ids. Omit to use every sheet that holds the chosen views."),
  grid_set: z.string().optional().default("").describe("Grid name prefix, for example BQ. Matches BQ1 and BQ-A, not BQA."),
  grid_names: z.array(z.string()).optional().default([]),
  grid_ids: z.array(z.string()).optional().default([]),
  mode: z.enum(["crop", "scope_box"]).optional().default("crop"),
  scope_box: z.string().optional().default("").describe("align_views mode scope_box: an existing scope box name or id."),
  family: z.string().optional().default("").describe("north_arrows: the north arrow family name."),
  type_name: z.string().optional().default(""),
  match_param: z.string().optional().default("").describe("A parameter on the arrow equal to the viewport id, the view id, the view name or the sheet number."),
  near_mm: z.number().positive().optional().default(150),
  arrow_zero_deg: z.number().optional().default(0).describe("Added when the family does not point up the sheet at rotation 0."),
  arrow_ids: z.array(z.string()).optional().default([]),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
  tol_deg: z.number().positive().optional(),
  tol_mm: z.number().positive().optional(),
  sample_limit: z.number().int().min(1).max(100).optional().default(20),
};

export type FmcNorthArgs = z.infer<z.ZodObject<typeof FMC_NORTH_SHAPE>>;

export interface NorthIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  standards?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-NORTH";
  return reply({ tool: "fmc_north", refused: true, code, message, project_north_changed: false, shared_coordinates_changed: false }, true);
}

function leaseOf(args: FmcNorthArgs): string {
  return args.batch_lease.trim() || (batchLease.getStore() ?? "");
}

function standardsOf(io: NorthIo): Record<string, unknown> | null {
  if (io.standards !== undefined) return io.standards;
  const env = io.env ?? process.env;
  const direct = (env.FMC_STANDARDS_FILE ?? "").trim();
  const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  if (direct) {
    try { return read(direct); } catch { return null; }
  }
  try {
    const loaded = loadConfig(configPath(env));
    return read(path.win32.join(path.win32.dirname(kitPaths(loaded.config).recipesDir), "FMC_Standards_Building.json"));
  } catch {
    return null;
  }
}

function guardOf(doc: { title: string; path: string }, central: boolean | undefined, io: NorthIo): { reason: string | null; config: GuardConfig } {
  const env = io.env ?? process.env;
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
  const blob = `${doc.title} ${doc.path}`;
  let reason: string | null = null;
  if (/hebert hostels/i.test(blob)) reason = "HEBERT HOSTELS is not written by fmc_north.";
  else if (/[\\/]centrals[\\/]/i.test(doc.path)) reason = "A file under a Centrals folder is not written by fmc_north.";
  else if (central) reason = "A central model is not written by fmc_north.";
  else reason = saveBlocked(doc, loaded.config);
  if (!reason && loaded.problem) reason = loaded.problem;
  return { reason, config: loaded.config };
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_north",
    read_only: true,
    project_north_changed: false,
    shared_coordinates_changed: false,
    images: [] as [],
    saved: false,
    synced: false,
    cites: {
      kit: "FMC-BIM-MAN-001",
      standards: "FMC-BIM-STD-002 north.tol_deg north.tol_mm coord.tol_deg coord.tol_mm",
      rulebook: "The AI modeller does not move the survey point, the project base point, or shared coordinates.",
    },
    ...extra,
  };
}

async function readModel(args: FmcNorthArgs, body: Record<string, unknown>, io: NorthIo): Promise<NorthSnapshot> {
  if (io.read) return normalizeNorth(await io.read(body));
  const raw = await withRevitConnection((client) => client.sendCommand("fmc_north", { ...body, document: body.document ?? args.document }, 180000));
  return normalizeNorth(raw);
}

function wantDocs(args: FmcNorthArgs): { document: string; documents: string[]; all_open: boolean; roles: string[] } {
  const roles = (args.roles.length ? args.roles : ["A", "E", "P", "S"]).map((r) => r.toUpperCase());
  if (args.action === "compare" && !args.document.trim() && !args.documents.length) {
    return { document: "", documents: [], all_open: true, roles };
  }
  if (args.action === "audit" && args.all_open && !args.document.trim() && !args.documents.length) {
    return { document: "", documents: [], all_open: true, roles: [] };
  }
  return { document: args.document.trim(), documents: args.documents, all_open: false, roles };
}

function filterDocs(docs: NorthDoc[], args: FmcNorthArgs, roles: string[]): NorthDoc[] {
  if (args.action !== "compare") return docs;
  if (args.document.trim() || args.documents.length) return docs;
  const want = new Set(roles);
  return docs.filter((doc) => want.has((doc.role || roleOf(doc.title)).toUpperCase()));
}

export async function runFmcNorth(args: FmcNorthArgs, io: NorthIo = {}) {
  const sample = args.sample_limit;
  const tols = resolveNorthTolerances(standardsOf(io), { tol_deg: args.tol_deg, tol_mm: args.tol_mm });
  const env = io.env ?? process.env;
  try {
    if ((args.action === "align_views" || args.action === "north_arrows") && !args.document.trim()) {
      return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: NORTH_FIX["FMC-DOC-REQUIRED"] }, true);
    }
    if (args.action === "audit" && !args.document.trim() && !args.documents.length && !args.all_open) {
      return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: NORTH_FIX["FMC-DOC-REQUIRED"] }, true);
    }
    if (args.action === "north_arrows" && !args.family.trim() && !args.arrow_ids.length) {
      return reply({ ...stamp(), refused: true, code: "FMC-NORTH-ARROW-UNMATCHED", message: "north_arrows needs family, the north arrow family name.", fix: NORTH_FIX["FMC-NORTH-ARROW-UNMATCHED"] }, true);
    }
    const target = wantDocs(args);
    if ((args.action === "audit" || args.action === "compare") && !target.document && !target.documents.length && !target.all_open) {
      return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: NORTH_FIX["FMC-DOC-REQUIRED"] }, true);
    }
    const includeLinks = args.action === "compare" && args.include_links !== false;
    const snapshot = await readModel(args, {
      action: args.action,
      document: target.document,
      documents: target.documents,
      all_open: target.all_open,
      include_links: includeLinks,
      family: args.family,
      type_name: args.type_name,
      match_param: args.match_param,
    }, io);
    if (snapshot.refused) {
      return reply({ ...stamp(), refused: true, code: snapshot.code || "FMC-NORTH", message: snapshot.message || "The read was refused." }, true);
    }
    const docs = filterDocs((snapshot.documents ?? []).map(prepareDoc), args, target.roles);
    const fileBody: Record<string, unknown> = { action: args.action, tolerances: tols, documents: docs };

    if (args.action === "audit" || args.action === "compare") {
      const compared = args.action === "compare" ? compareSnapshot(docs, tols, includeLinks) : null;
      const summaryDocs = docs.map((doc) => ({
        title: doc.title,
        path: doc.path ?? "",
        role: doc.role || roleOf(doc.title),
        site: doc.site ?? "",
        angle_deg: doc.angle_deg ?? null,
        shared_basis_x_deg: doc.shared_basis_x_deg ?? null,
        easting_mm: doc.easting_mm ?? null,
        northing_mm: doc.northing_mm ?? null,
        elevation_mm: doc.elevation_mm ?? null,
        survey_point: doc.survey_point ?? null,
        project_base_point: doc.project_base_point ?? null,
        is_central: doc.is_central === true,
        grid_sets: gridSetsOf(doc, sample),
        views: viewRotationRows(doc, sample),
      }));
      fileBody.summary = summaryDocs;
      if (compared) fileBody.findings = compared.findings;
      const report = writeNorthReport(env, args.action, fileBody, io.reportDir);
      return reply(stamp({
        action: args.action,
        tolerances: tols,
        documents: summaryDocs.map((doc) => ({
          ...doc,
          views: { count: doc.views.count, ids: doc.views.ids, truncated: doc.views.truncated },
        })),
        ...(compared ? {
          status: compared.status,
          agree: compared.status !== "FAIL",
          findings: capFindings(compared.findings, sample),
          ...((() => { const plan = coordPlan(summaryDocs, compared.findings, roleOf); return plan ? { coord_plan: plan } : {}; })()),
        } : {}),
        report,
        count: docs.length,
      }));
    }

    const doc = docs[0];
    if (!doc) return reply({ ...stamp(), refused: true, code: "FMC-DOC-NOT-FOUND", message: "The document was not in the read." }, true);
    const report = writeNorthReport(env, args.action, fileBody, io.reportDir);
    const guard = guardOf({ title: doc.title, path: doc.path ?? "" }, doc.is_central, io);
    if (guard.reason) {
      return reply({
        ...stamp(), refused: true, code: "FMC-NORTH-GUARD", dry_run: true, message: guard.reason,
        resolved_document: { title: doc.title, path: doc.path ?? "" },
        protected_paths: guard.config.protected_paths ?? [],
      }, true);
    }
    if (args.action === "align_views") {
      const plan = planAlign(doc, args);
      if (plan.code && !plan.ops.length) {
        return reply({ ...stamp(), refused: true, code: plan.code, message: plan.fix, fix: plan.fix, grid_angle_deg: plan.grid_angle_deg, report }, true);
      }
      const body = stamp({
        action: "align_views",
        dry_run: args.dry_run !== false,
        mode: args.mode,
        document: doc.title,
        grid_set: args.grid_set,
        grid_angle_deg: plan.grid_angle_deg,
        views: plan.ops.slice(0, sample),
        view_count: plan.ops.length,
        truncated: plan.ops.length > sample,
        scope_note: plan.scope_note,
        report,
        project_north_changed: false,
      });
      if (args.dry_run !== false) {
        return reply({ ...body, read_only: true, next: "Show this plan. Apply with dry_run false, batch_lease, and references. That call is fmc_north_apply, one transaction. Project north stays as it is." });
      }
      if (!leaseOf(args)) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: NORTH_FIX["FMC-BATCH-LOCKED"] }, true);
      const refsProblem = referenceProblems(args.references);
      if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-NORTH-REFERENCES", message: refsProblem }, true);
      const workable = plan.ops.filter((op) => op.delta_deg != null && !op.code);
      if (!workable.length) return reply({ ...stamp(), refused: true, code: "FMC-NORTH-PLAN", message: NORTH_FIX["FMC-NORTH-PLAN"], views: plan.ops }, true);
      const applied = await apply(args, doc, {
        action: "align_views",
        mode: args.mode,
        scope_box: args.scope_box,
        ops: workable,
      }, guard.config, io);
      return reply({ ...body, read_only: false, dry_run: false, applied, project_north_changed: applied.project_north_changed === true, shared_coordinates_changed: applied.shared_coordinates_changed === true });
    }

    const matches = planArrows(doc, args);
    const body = stamp({
      action: "north_arrows",
      dry_run: args.dry_run !== false,
      document: doc.title,
      family: args.family,
      type_name: args.type_name,
      matched: matches.filter((row) => row.arrow_id).slice(0, sample),
      unmatched: matches.filter((row) => row.code).slice(0, sample),
      matched_count: matches.filter((row) => row.arrow_id).length,
      unmatched_count: matches.filter((row) => row.code).length,
      report,
    });
    if (args.dry_run !== false) {
      return reply({ ...body, read_only: true, next: "Unmatched viewports are listed. Apply with dry_run false and batch_lease. The arrow rotation is project angle minus crop basis, plus arrow_zero_deg." });
    }
    if (!leaseOf(args)) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: NORTH_FIX["FMC-BATCH-LOCKED"] }, true);
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-NORTH-REFERENCES", message: refsProblem }, true);
    const workable = matches.filter((row) => row.arrow_id && row.target_deg != null);
    if (!workable.length) return reply({ ...body, refused: true, code: "FMC-NORTH-PLAN", message: NORTH_FIX["FMC-NORTH-PLAN"] }, true);
    const applied = await apply(args, doc, { action: "north_arrows", ops: workable }, guard.config, io);
    return reply({ ...body, read_only: false, dry_run: false, applied, project_north_changed: applied.project_north_changed === true });
  } catch (error) {
    return failed(error);
  }
}

async function apply(args: FmcNorthArgs, doc: NorthDoc, plan: Record<string, unknown>, config: GuardConfig, io: NorthIo): Promise<Record<string, unknown>> {
  const roots = [...(config.protected_paths ?? []), ...protectedRoots(config)];
  const body = {
    document: args.document || doc.title,
    ...plan,
    protected_roots: roots,
    _protected_roots: roots,
    references: args.references ?? {},
  };
  if (io.apply) return (await io.apply(body)) as Record<string, unknown>;
  return await withRevitConnection((client) => client.sendCommand("fmc_north_apply", body, 180000)) as Record<string, unknown>;
}

export function registerFmcNorthTool(server: McpServer) {
  server.tool("fmc_north", FMC_NORTH_DESCRIPTION, FMC_NORTH_SHAPE, async (args) => runFmcNorth(args as FmcNorthArgs));
}
