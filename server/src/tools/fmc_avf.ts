import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import type { GuardConfig } from "../fmc/policy.js";
import { siteProtectedRoots, siteReferenceProblems, siteWriteBlock } from "../fmc/sitecommon.js";
import { AVF_FIX, avfStats, checkAvfPoints, legendBands, planAvfPoints, readAvfCsvFile, writeAvfReport, type AvfPoint } from "../fmc/avf.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_AVF_DESCRIPTION =
  "Formcraft Analysis Visualization Framework display: point results (x, y, z, value) shown in one view as coloured markers with a legend. " +
  "read lists the graphical views, each view's analysis results (SpatialFieldManager schemas) and the analysis display styles. No transaction. " +
  "show takes points [{x, y, z, value}] or csv (columns x, y, z, value; comma, semicolon or tab), units mm, m or ft, coordinates internal or shared " +
  "(shared goes to internal with the fmc_coord matrix internal_to_shared), at most 20000 points. It reports the count, min, max, mean and the legend bands. " +
  "clear removes the Formcraft results from the view; with other results in the view it needs all true. " +
  "dry_run defaults to true and changes nothing. A write is fmc_avf_apply, one transaction for the display style and the view setting, then the transient AVF results, " +
  "and needs batch_lease plus references.kit, references.standards and references.rulebook. AVF results are not saved with the model. " +
  "Pass document and view. HEBERT HOSTELS, a central model and protected paths are refused. JSON under %LOCALAPPDATA%\\Formcraft\\avf. No pictures. " +
  "Example: action show, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, view {3D}, csv D:\\Jobs\\sun_hours.csv, units m, schema_name Sun hours, unit_name h, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

const pointShape = z.object({ x: z.number(), y: z.number(), z: z.number().optional(), value: z.number() });

export const FMC_AVF_SHAPE = {
  action: z.enum(["read", "show", "clear"]),
  document: z.string().optional().default(""),
  view: z.string().optional().default("").describe("View name or id. Required for show and clear."),
  points: z.array(pointShape).optional(),
  csv: z.string().optional().default("").describe("A CSV file of x, y, z, value."),
  units: z.enum(["mm", "m", "ft"]).optional().default("mm"),
  coordinates: z.enum(["internal", "shared"]).optional().default("internal"),
  value_scale: z.number().optional().default(1),
  schema_name: z.string().optional().default("FMC Analysis"),
  description: z.string().optional().default("Formcraft analysis results"),
  unit_name: z.string().optional().default(""),
  style_name: z.string().optional().default("FMC AVF Markers"),
  min_color: z.array(z.number().int().min(0).max(255)).length(3).optional().default([0, 90, 255]),
  max_color: z.array(z.number().int().min(0).max(255)).length(3).optional().default([255, 40, 0]),
  steps: z.number().int().min(2).max(20).optional().default(8),
  marker_size: z.number().positive().max(1).optional().default(0.01).describe("Marker size in Revit's own units (feet on the sheet scale)."),
  show_text: z.boolean().optional().default(false),
  replace: z.boolean().optional().default(true).describe("show: clear the earlier Formcraft result in the view first."),
  all: z.boolean().optional().default(false).describe("clear: also clear results other tools put in the view."),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
  sample_limit: z.number().int().min(1).max(100).optional().default(20),
};

export type FmcAvfArgs = z.infer<z.ZodObject<typeof FMC_AVF_SHAPE>>;

export interface AvfIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  readFile?: (file: string) => string;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function stamp(extra: Record<string, unknown> = {}) {
  return { tool: "fmc_avf", images: [] as [], saved: false, synced: false, transient_results: true, ...extra };
}

function refused(code: string, message?: string) {
  return reply({ ...stamp(), refused: true, code, message: message ?? AVF_FIX[code] ?? code }, true);
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-AVF";
  return reply({ ...stamp(), refused: true, code, message }, true);
}

type ViewRow = { id?: string; name?: string; type?: string; is_template?: boolean; can_show?: boolean; results?: string[]; style_name?: string };

function findView(views: ViewRow[], key: string): ViewRow | undefined {
  const k = key.trim().toLowerCase();
  return views.find((v) => String(v.id ?? "") === k) ?? views.find((v) => String(v.name ?? "").toLowerCase() === k);
}

export async function runFmcAvf(args: FmcAvfArgs, io: AvfIo = {}) {
  const env = io.env ?? process.env;
  try {
    const document = args.document.trim();
    if (!document) return refused("FMC-DOC-REQUIRED");
    const readBody = { document, schema_name: args.schema_name };
    const raw = io.read ? await io.read(readBody) : await withRevitConnection((client) => client.sendCommand("fmc_avf", readBody, 120000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return refused(String(body.code ?? "FMC-AVF"), String(body.message ?? "The read was refused."));
    const doc = { title: String(body.title ?? document), path: String(body.path ?? ""), is_central: body.is_central === true };
    const views = Array.isArray(body.views) ? body.views as ViewRow[] : [];
    const styles = Array.isArray(body.styles) ? body.styles as Array<{ id?: string; name?: string }> : [];
    const sample = args.sample_limit;
    if (args.action === "read") {
      const withResults = views.filter((v) => Array.isArray(v.results) && v.results.length);
      return reply(stamp({
        action: "read", read_only: true, document: doc.title,
        views: (args.view.trim() ? views.filter((v) => v === findView(views, args.view)) : views.filter((v) => v.can_show)).slice(0, sample),
        views_count: views.length,
        views_with_results: withResults.slice(0, sample),
        styles: styles.slice(0, sample),
      }));
    }
    const view = findView(views, args.view);
    if (!args.view.trim() || !view || view.is_template || view.can_show === false) return refused("FMC-AVF-VIEW", `${args.view || "(none)"}: ${AVF_FIX["FMC-AVF-VIEW"]}`);
    const results = Array.isArray(view.results) ? view.results.map(String) : [];
    const dry = args.dry_run !== false;
    let summary: Record<string, unknown>;
    let applyExtra: Record<string, unknown>;
    if (args.action === "clear") {
      const ours = results.filter((name) => name === args.schema_name);
      const others = results.filter((name) => name !== args.schema_name);
      if (!results.length) return refused("FMC-AVF-NOTHING");
      if (others.length && !args.all) return refused("FMC-AVF-OTHERS", `The view also holds ${others.join(", ")}. Pass all true to clear every result in it.`);
      summary = stamp({ action: "clear", dry_run: dry, read_only: dry, document: doc.title, view: { id: view.id, name: view.name }, would_clear: args.all ? results : ours });
      applyExtra = { action: "clear", all: args.all };
    } else {
      let points: AvfPoint[];
      if (args.csv.trim()) points = readAvfCsvFile(args.csv.trim(), io.readFile);
      else points = checkAvfPoints(args.points);
      points = checkAvfPoints(points);
      const placed = planAvfPoints(points, { units: args.units, coordinates: args.coordinates, value_scale: args.value_scale }, body.internal_to_shared as number[][]);
      const stats = avfStats(points.map((p, i) => ({ ...p, value: placed.values[i] })));
      const others = results.filter((name) => name !== args.schema_name);
      const styleExists = styles.some((s) => String(s.name ?? "").toLowerCase() === args.style_name.toLowerCase());
      const report = writeAvfReport(env, { document: doc.title, view, stats, points: placed }, io.reportDir);
      summary = stamp({
        action: "show", dry_run: dry, read_only: dry, document: doc.title,
        view: { id: view.id, name: view.name, type: view.type },
        schema_name: args.schema_name, unit_name: args.unit_name,
        style: { name: args.style_name, exists: styleExists },
        coordinates: args.coordinates, units: args.units,
        stats, legend: legendBands(stats, args.steps),
        sample_points_internal_mm: placed.xyz_mm.slice(0, Math.min(5, sample)),
        replaces: args.replace && results.includes(args.schema_name),
        ...(others.length && args.replace ? { note: `replace clears the view's analysis manager, which also holds ${others.join(", ")}.` } : {}),
        report,
      });
      applyExtra = {
        action: "show",
        schema_name: args.schema_name, description: args.description, unit_name: args.unit_name,
        style_name: args.style_name, min_color: args.min_color, max_color: args.max_color, steps: args.steps,
        marker_size: args.marker_size, show_text: args.show_text, replace: args.replace,
        xyz_mm: placed.xyz_mm, values: placed.values,
      };
    }
    if (dry) return reply({ ...summary, next: "Nothing was changed. Apply with dry_run false, batch_lease, and references. That call is fmc_avf_apply." });
    const guard = siteWriteBlock("fmc_avf", doc, io.guard, env);
    if (guard.reason) return refused("FMC-AVF-GUARD", guard.reason);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return refused("FMC-BATCH-LOCKED");
    const refsProblem = siteReferenceProblems(args.references, AVF_FIX["FMC-AVF-REFERENCES"]);
    if (refsProblem) return refused("FMC-AVF-REFERENCES", refsProblem);
    const roots = siteProtectedRoots(guard.config);
    const applyBody = { document, view_id: view.id, ...applyExtra, protected_roots: roots, _protected_roots: roots, references: args.references ?? {} };
    const applied = (io.apply
      ? await io.apply(applyBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_avf_apply", applyBody, 300000))) as Record<string, unknown>;
    return reply({ ...summary, read_only: false, dry_run: false, applied });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcAvfTool(server: McpServer) {
  server.tool("fmc_avf", FMC_AVF_DESCRIPTION, FMC_AVF_SHAPE, async (args) => runFmcAvf(args as FmcAvfArgs));
}
