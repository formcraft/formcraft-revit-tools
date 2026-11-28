import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import {
  LEGEND_FIX, loadLegendSpec, planLegend, referenceProblems, writeLegendReport, type LegendSheet,
  legendSpecNote,
} from "../fmc/keynotelegend.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_KEYNOTE_LEGEND_DESCRIPTION =
  "Create the FMC keynote legend, filter it by sheet, and place it on each sheet. " +
  "The dry run is plan-only: one Revit read and no transaction (read_only true, plan_only true); it writes only the local JSON report, so it is safe on any model. " +
  "spec_source sample means the kit legend file is missing: status is PROVISIONAL and can_pass false, with status_reason saying why. " +
  "Each planned point has zone_check: clear, overlaps (a viewport or schedule is under the legend box, size_mm in the spec), off_titleblock or not_checked. " +
  "sheets is a list of sheet numbers or names. With sheets omitted, role (default plan) selects the sheets. " +
  "filter_by_sheet defaults to true. The point is the title-block parameter FMC_Legend_Zone (text x,y millimetres) or FMC_Legend_X and FMC_Legend_Y. " +
  "Without that parameter the point is the kit zone: inset from the lower right of the title block (03_Master_Data/FMC_KeynoteLegend.json, or the provisional sample). " +
  "dry_run defaults to true. A write is fmc_keynote_legend_apply, one transaction, and needs batch_lease plus references.kit, references.standards and references.rulebook. " +
  "The answer is the legend id and the viewport id on each sheet. JSON under %LOCALAPPDATA%\\Formcraft\\keynote-legend. No pictures. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, role plan, filter_by_sheet true, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_KEYNOTE_LEGEND_SHAPE = {
  document: z.string().optional().default(""),
  sheets: z.array(z.string()).optional(),
  role: z.string().optional().default("plan"),
  filter_by_sheet: z.boolean().optional().default(true),
  spec: z.string().optional().default(""),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
};

export type FmcKeynoteLegendArgs = z.infer<z.ZodObject<typeof FMC_KEYNOTE_LEGEND_SHAPE>>;

export interface KeynoteLegendIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
  kitRoot?: string;
  specText?: string;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-KEYNOTE-LEGEND";
  return reply({ tool: "fmc_keynote_legend", refused: true, code, message, saved: false, synced: false }, true);
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_keynote_legend",
    images: [] as [],
    saved: false,
    synced: false,
    cites: {
      kit: "03_Master_Data/FMC_KeynoteLegend.json",
      standards: "FMC-BIM-STD-002 keynotes",
      rulebook: "One keynote legend, filtered by sheet, sits in the title-block legend zone.",
    },
    ...extra,
  };
}

function kitRootOf(io: KeynoteLegendIo): string {
  if (io.kitRoot != null) return io.kitRoot;
  try { return kitPaths(loadConfig(configPath(io.env ?? process.env)).config).root; } catch { return ""; }
}

export async function runFmcKeynoteLegend(args: FmcKeynoteLegendArgs, io: KeynoteLegendIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: LEGEND_FIX["FMC-DOC-REQUIRED"] }, true);
    let loaded;
    try {
      loaded = loadLegendSpec({
        file: args.spec,
        kitRoot: kitRootOf(io),
        env,
        ...(io.specText != null ? { read: () => io.specText as string } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply({ ...stamp(), refused: true, code: "FMC-KEYNOTE-LEGEND-SPEC", message }, true);
    }
    const readBody = { document: args.document.trim(), name: loaded.spec.name ?? "FMC Keynotes" };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_keynote_legend", readBody, 180000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return reply({ ...stamp(), refused: true, code: String(body.code ?? "FMC-KEYNOTE-LEGEND"), message: String(body.message ?? "The read was refused.") }, true);
    const doc = { title: String(body.title ?? args.document), path: String(body.path ?? ""), is_central: body.is_central === true };
    const sheets = Array.isArray(body.sheets) ? body.sheets as LegendSheet[] : [];
    const plan = planLegend(sheets, loaded.spec, {
      sheets: args.sheets,
      role: args.role,
      filter_by_sheet: args.filter_by_sheet !== false,
    });
    const provisional = loaded.provisional;
    const report = writeLegendReport(env, { document: doc.title, spec: loaded.path, plan }, io.reportDir);
    const dry = args.dry_run !== false;
    const fromSpec = plan.placements.filter((row) => row.source === "spec");
    const samePoint = fromSpec.length > 1 && new Set(fromSpec.map((row) => `${row.x},${row.y}`)).size === 1;
    const zoneProblems = plan.placements.filter((row) => row.zone_check === "overlaps" || row.zone_check === "off_titleblock").length;
    const summary = stamp({
      dry_run: dry,
      read_only: dry,
      plan_only: dry,
      transaction: false,
      zone: { problems: zoneProblems, size_mm: loaded.spec.size_mm ?? { width: 150, height: 100 }, ...(samePoint ? { same_point: { code: "FMC-KEYNOTE-LEGEND-SAME-POINT", sheets: fromSpec.length, message: LEGEND_FIX["FMC-KEYNOTE-LEGEND-SAME-POINT"] } } : {}) },
      document: doc.title,
      spec: loaded.path,
      spec_source: loaded.source,
      provisional,
      status: provisional ? "PROVISIONAL" : "PASS",
      can_pass: !provisional,
      status_reason: legendSpecNote(loaded.source, provisional),
      legend: { name: plan.name, filter_by_sheet: plan.filter_by_sheet },
      sheets: plan.placements,
      skipped: plan.skipped,
      report,
    });
    if (dry) return reply({ ...summary, next: "Nothing was placed. Apply with dry_run false, batch_lease, and references. That call is fmc_keynote_legend_apply, one transaction." });
    const blob = `${doc.title} ${doc.path}`;
    if (/hebert hostels/i.test(blob) || doc.is_central) return reply({ ...stamp(), refused: true, code: "FMC-KEYNOTE-LEGEND-GUARD", message: "HEBERT HOSTELS and a central model are not written by fmc_keynote_legend." }, true);
    const loadedCfg = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
    const blocked = saveBlocked(doc, loadedCfg.config) || loadedCfg.problem;
    if (blocked) return reply({ ...stamp(), refused: true, code: "FMC-KEYNOTE-LEGEND-GUARD", message: blocked }, true);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: LEGEND_FIX["FMC-BATCH-LOCKED"] }, true);
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-KEYNOTE-LEGEND-REFERENCES", message: refsProblem }, true);
    if (!plan.placements.length) return reply({ ...summary, refused: true, read_only: true }, true);
    const roots = [...(loadedCfg.config.protected_paths ?? []), ...protectedRoots(loadedCfg.config)];
    const applyBody = {
      document: args.document.trim(),
      name: plan.name,
      filter_by_sheet: plan.filter_by_sheet,
      placements: plan.placements,
      protected_roots: roots,
      _protected_roots: roots,
      references: args.references ?? {},
    };
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_keynote_legend_apply", applyBody, 180000)) as Record<string, unknown>;
    const appliedCode = typeof applied.code === "string" ? applied.code : "";
    const legendId = typeof applied.legend_id === "string" ? applied.legend_id : "";
    const viewports = Array.isArray(applied.viewports) ? applied.viewports : [];
    return reply({
      ...summary,
      read_only: false,
      dry_run: false,
      legend: { name: plan.name, filter_by_sheet: plan.filter_by_sheet, id: legendId },
      viewports,
      applied,
      ...(appliedCode ? { code: appliedCode, message: LEGEND_FIX[appliedCode] ?? "" } : {}),
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcKeynoteLegendTool(server: McpServer) {
  server.tool("fmc_keynote_legend", FMC_KEYNOTE_LEGEND_DESCRIPTION, FMC_KEYNOTE_LEGEND_SHAPE, async (args) => runFmcKeynoteLegend(args as FmcKeynoteLegendArgs));
}
