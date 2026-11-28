import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import type { GuardConfig } from "../fmc/policy.js";
import { roundTo, siteProtectedRoots, siteReferenceProblems, siteWriteBlock } from "../fmc/sitecommon.js";
import { SURVEY_FIX, parseSurveyCsv, planSurvey, readSurveyFile, surveyTag, writeSurveyReport } from "../fmc/survey.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_SURVEY_DESCRIPTION =
  "Formcraft survey to toposolid. read lists the toposolid types, the levels, existing toposolids and the fmc_coord matrix internal_to_shared. No transaction. " +
  "import reads a survey CSV (csv a file, or csv_text): a header with easting/x, northing/y, elevation/z (point and code optional), or with no header format PENZ, PNEZ, ENZ, NEZ or XYZ " +
  "(auto: 4+ columns PENZ, 3 columns ENZ). units m (default), mm, ft or usft. coordinates shared (default: survey east, north, elevation) go to internal with the fmc_coord matrix; internal is used as is. " +
  "Points in plan within duplicate_tol_mm are one point; a different height there is a conflict and the first row is kept. codes keeps only those point codes. " +
  "It builds a Delaunay TIN and, with design_elevation (same units and coordinates as the CSV), the cut and fill in cubic metres against that flat level. " +
  "dry_run defaults to true and changes nothing: the dry run is the whole report with no Revit transaction. " +
  "A write is fmc_survey_apply, one transaction: Toposolid.Create from the points with toposolid_type and level (defaults: the first type, the lowest level), Comments set to FMC_SURVEY <file>, " +
  "and needs batch_lease plus references.kit, references.standards and references.rulebook. The new toposolid's height range is read back (FMC-SURVEY-READBACK over 5 mm). " +
  "Pass document. HEBERT HOSTELS, a central model and protected paths are refused. JSON under %LOCALAPPDATA%\\Formcraft\\survey. No pictures. " +
  "Example: action import, document F26901-FMC-ZZ-ZZ-M3-C-0001_USER, csv D:\\Jobs\\F269\\survey.csv, units m, design_elevation 1652.5, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_SURVEY_SHAPE = {
  action: z.enum(["read", "import"]),
  document: z.string().optional().default(""),
  csv: z.string().optional().default(""),
  csv_text: z.string().optional().default(""),
  format: z.enum(["auto", "PENZ", "PNEZ", "ENZ", "NEZ", "XYZ"]).optional().default("auto"),
  units: z.enum(["m", "mm", "ft", "usft"]).optional().default("m"),
  coordinates: z.enum(["shared", "internal"]).optional().default("shared"),
  codes: z.array(z.string()).optional().default([]),
  duplicate_tol_mm: z.number().min(0).max(1000).optional().default(1),
  design_elevation: z.number().optional().describe("A flat design level for cut and fill, in the CSV's units and coordinates."),
  toposolid_type: z.string().optional().default(""),
  level: z.string().optional().default(""),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
  sample_limit: z.number().int().min(1).max(100).optional().default(20),
};

export type FmcSurveyArgs = z.infer<z.ZodObject<typeof FMC_SURVEY_SHAPE>>;

export interface SurveyIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  readFile?: (file: string) => string;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function stamp(extra: Record<string, unknown> = {}) {
  return { tool: "fmc_survey", images: [] as [], saved: false, synced: false, ...extra };
}

function refused(code: string, message?: string) {
  return reply({ ...stamp(), refused: true, code, message: message ?? SURVEY_FIX[code] ?? code }, true);
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-SURVEY";
  return reply({ ...stamp(), refused: true, code, message }, true);
}

type Named = { id?: string; name?: string; elevation_mm?: number };

function pick(rows: Named[], key: string): Named | undefined {
  const k = key.trim().toLowerCase();
  return rows.find((r) => String(r.id ?? "") === k) ?? rows.find((r) => String(r.name ?? "").toLowerCase() === k);
}

export async function runFmcSurvey(args: FmcSurveyArgs, io: SurveyIo = {}) {
  const env = io.env ?? process.env;
  try {
    const document = args.document.trim();
    if (!document) return refused("FMC-DOC-REQUIRED");
    const readBody = { document };
    const raw = io.read ? await io.read(readBody) : await withRevitConnection((client) => client.sendCommand("fmc_survey", readBody, 120000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return refused(String(body.code ?? "FMC-SURVEY"), String(body.message ?? "The read was refused."));
    const doc = { title: String(body.title ?? document), path: String(body.path ?? ""), is_central: body.is_central === true };
    const types = Array.isArray(body.toposolid_types) ? body.toposolid_types as Named[] : [];
    const levels = Array.isArray(body.levels) ? body.levels as Named[] : [];
    const existing = Array.isArray(body.toposolids) ? body.toposolids as unknown[] : [];
    const sample = args.sample_limit;
    if (args.action === "read") {
      return reply(stamp({
        action: "read", read_only: true, document: doc.title,
        toposolid_types: types.slice(0, sample), levels: levels.slice(0, sample),
        toposolids: existing.slice(0, sample), toposolids_count: existing.length,
        internal_to_shared: body.internal_to_shared ?? null,
      }));
    }
    const file = args.csv.trim();
    if (!file && !args.csv_text.trim()) return refused("FMC-SURVEY-CSV");
    const text = file ? readSurveyFile(file, io.readFile) : args.csv_text;
    const parsed = parseSurveyCsv(text, args.format);
    const plan = planSurvey(parsed, {
      units: args.units, coordinates: args.coordinates, duplicate_tol_mm: args.duplicate_tol_mm,
      design_elevation: args.design_elevation, codes: args.codes,
    }, body.internal_to_shared as number[][]);
    let type: Named | undefined;
    if (args.toposolid_type.trim()) {
      type = pick(types, args.toposolid_type);
      if (!type) return refused("FMC-SURVEY-TYPE", `${args.toposolid_type}: ${SURVEY_FIX["FMC-SURVEY-TYPE"]}`);
    } else type = types[0];
    let level: Named | undefined;
    if (args.level.trim()) {
      level = pick(levels, args.level);
      if (!level) return refused("FMC-SURVEY-LEVEL", `${args.level}: ${SURVEY_FIX["FMC-SURVEY-LEVEL"]}`);
    } else level = [...levels].sort((a, b) => Number(a.elevation_mm ?? 0) - Number(b.elevation_mm ?? 0))[0];
    const tag = surveyTag(file);
    const report = writeSurveyReport(env, { document: doc.title, csv: file || "inline", parsed: { format: parsed.format, skipped: parsed.skipped }, plan }, io.reportDir);
    const dry = args.dry_run !== false;
    const summary = stamp({
      action: "import", dry_run: dry, read_only: dry, document: doc.title,
      csv: file || "inline", format: parsed.format, units: args.units, coordinates: args.coordinates,
      rows_read: parsed.points.length, rows_skipped: parsed.skipped.slice(0, sample), rows_skipped_count: parsed.skipped.length,
      filtered_out_by_code: plan.filtered_out,
      points: plan.points.length,
      duplicates: plan.duplicates.slice(0, sample), duplicates_count: plan.duplicates.length,
      conflicts: plan.conflicts.slice(0, sample), conflicts_count: plan.conflicts.length,
      extent_internal_mm: plan.extent_mm,
      triangles: plan.triangles, plan_area_m2: plan.plan_area_m2,
      cut_fill: plan.cut_fill,
      toposolid_type: type ? { id: type.id, name: type.name } : null,
      level: level ? { id: level.id, name: level.name, elevation_mm: level.elevation_mm } : null,
      comments: tag,
      sample_points_internal_mm: plan.points.slice(0, Math.min(5, sample)),
      report,
    });
    if (dry) return reply({ ...summary, next: "Nothing was changed. Apply with dry_run false, batch_lease, and references. That call is fmc_survey_apply, one transaction." });
    if (!type) return refused("FMC-SURVEY-NO-TYPE");
    if (!level) return refused("FMC-SURVEY-LEVEL");
    const guard = siteWriteBlock("fmc_survey", doc, io.guard, env);
    if (guard.reason) return refused("FMC-SURVEY-GUARD", guard.reason);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return refused("FMC-BATCH-LOCKED");
    const refsProblem = siteReferenceProblems(args.references, SURVEY_FIX["FMC-SURVEY-REFERENCES"]);
    if (refsProblem) return refused("FMC-SURVEY-REFERENCES", refsProblem);
    const roots = siteProtectedRoots(guard.config);
    const applyBody = {
      document, type_id: type.id, level_id: level.id, comments: tag,
      xyz_mm: plan.points.map((p) => p.xyz_mm),
      protected_roots: roots, _protected_roots: roots, references: args.references ?? {},
    };
    const applied = (io.apply
      ? await io.apply(applyBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_survey_apply", applyBody, 300000))) as Record<string, unknown>;
    const box = applied.bbox_mm as Record<string, number> | undefined;
    let readback: Record<string, unknown> = { status: "UNKNOWN" };
    if (box && Number.isFinite(box.max_z) && Number.isFinite(box.min_z)) {
      const dTop = Math.abs(box.max_z - plan.extent_mm.max_z);
      readback = {
        status: dTop <= 5 ? "MATCH" : "MISMATCH",
        survey_max_z_mm: plan.extent_mm.max_z,
        toposolid_max_z_mm: box.max_z,
        delta_top_mm: roundTo(dTop, 3),
        ...(dTop > 5 ? { code: "FMC-SURVEY-READBACK", message: SURVEY_FIX["FMC-SURVEY-READBACK"] } : {}),
      };
    }
    return reply({ ...summary, read_only: false, dry_run: false, applied, readback, ...(readback.code ? { code: readback.code } : {}) });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcSurveyTool(server: McpServer) {
  server.tool("fmc_survey", FMC_SURVEY_DESCRIPTION, FMC_SURVEY_SHAPE, async (args) => runFmcSurvey(args as FmcSurveyArgs));
}
