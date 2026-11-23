import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import {
  VIEWSTYLE_FIX, loadViewStyleSpec, planFilters, planRoomFill, planTemplates, referenceProblems, writeViewStyleReport,
  type ViewStyleAction,
} from "../fmc/viewstyle.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_VIEWSTYLE_DESCRIPTION =
  "View templates, parameter filters and room colour fills from the kit spec 03_Master_Data/FMC_ViewStyle.json. " +
  "A missing kit file uses the sample under server/data, whose colours are PROVISIONAL and cannot PASS. " +
  "templates creates a view template from from_view and can apply it. filters creates a parameter filter and a colour override. " +
  "room_fill binds a Rooms colour scheme to Department or Name and can place a legend. " +
  "Revit 2025 has no ColorFillScheme.Create. Apply duplicates an existing Rooms scheme, sets ParameterDefinition, adds entries, assigns the view, and places ColorFillLegend.Create. " +
  "A model with no Rooms scheme is FMC-VIEWSTYLE-NO-SCHEME. A parameter the scheme rejects is FMC-VIEWSTYLE-SCHEME-PARAM. " +
  "dry_run defaults to true. A write is fmc_viewstyle_apply, one transaction, and needs batch_lease plus references.kit, references.standards and references.rulebook. " +
  "JSON under %LOCALAPPDATA%\\Formcraft\\viewstyle. No pictures. " +
  "Example: action room_fill, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

export const FMC_VIEWSTYLE_SHAPE = {
  action: z.enum(["templates", "filters", "room_fill"]),
  document: z.string().optional().default(""),
  spec: z.string().optional().default("").describe("A spec JSON path. Empty uses the kit file, then the sample."),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
};

export type FmcViewStyleArgs = z.infer<z.ZodObject<typeof FMC_VIEWSTYLE_SHAPE>>;

export interface ViewStyleIo {
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
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-VIEWSTYLE";
  return reply({ tool: "fmc_viewstyle", refused: true, code, message, saved: false, synced: false }, true);
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_viewstyle",
    images: [] as [],
    saved: false,
    synced: false,
    cites: {
      kit: "03_Master_Data/FMC_ViewStyle.json",
      standards: "FMC-BIM-STD-002 view graphics",
      rulebook: "Colours marked PROVISIONAL are not the standard and cannot PASS.",
    },
    ...extra,
  };
}

function kitRootOf(io: ViewStyleIo): string {
  if (io.kitRoot != null) return io.kitRoot;
  try { return kitPaths(loadConfig(configPath(io.env ?? process.env)).config).root; } catch { return ""; }
}

export async function runFmcViewStyle(args: FmcViewStyleArgs, io: ViewStyleIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: VIEWSTYLE_FIX["FMC-DOC-REQUIRED"] }, true);
    const action = args.action as ViewStyleAction;
    let loaded;
    try {
      loaded = loadViewStyleSpec({
        file: args.spec,
        kitRoot: kitRootOf(io),
        env,
        ...(io.specText != null ? { read: () => io.specText as string } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply({ ...stamp(), refused: true, code: "FMC-VIEWSTYLE-SPEC", message }, true);
    }
    const readBody = { document: args.document.trim(), action };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_viewstyle", readBody, 180000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return reply({ ...stamp(), refused: true, code: String(body.code ?? "FMC-VIEWSTYLE"), message: String(body.message ?? "The read was refused.") }, true);
    const doc = { title: String(body.title ?? args.document), path: String(body.path ?? ""), is_central: body.is_central === true };
    const templates = Array.isArray(body.templates) ? body.templates.map(String) : [];
    const filters = Array.isArray(body.filters) ? body.filters.map(String) : [];
    const rooms = Array.isArray(body.rooms) ? body.rooms as Array<{ department?: string; name?: string }> : [];
    const planned = action === "templates"
      ? planTemplates(loaded.spec, templates)
      : action === "filters"
        ? planFilters(loaded.spec, filters)
        : planRoomFill(loaded.spec, rooms);
    const ops = "ops" in planned ? planned.ops : (planned.op ? [planned.op] : []);
    const provisional = loaded.provisional || planned.provisional;
    const report = writeViewStyleReport(env, action, { spec: loaded.path, source: loaded.source, planned }, io.reportDir);
    const dry = args.dry_run !== false;
    const summary = stamp({
      action,
      dry_run: dry,
      read_only: dry,
      document: doc.title,
      spec: loaded.path,
      spec_source: loaded.source,
      provisional,
      status: provisional ? "PROVISIONAL" : "PASS",
      can_pass: !provisional,
      ops,
      skipped: planned.skipped,
      report,
    });
    if (dry) return reply({ ...summary, next: "Nothing was created. Apply with dry_run false, batch_lease, and references. That call is fmc_viewstyle_apply, one transaction." });
    const blob = `${doc.title} ${doc.path}`;
    if (/hebert hostels/i.test(blob)) return reply({ ...stamp(), refused: true, code: "FMC-VIEWSTYLE-GUARD", message: "HEBERT HOSTELS is not written by fmc_viewstyle." }, true);
    if (doc.is_central) return reply({ ...stamp(), refused: true, code: "FMC-VIEWSTYLE-GUARD", message: "A central model is not written by fmc_viewstyle." }, true);
    const loadedCfg = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
    const blocked = saveBlocked(doc, loadedCfg.config) || loadedCfg.problem;
    if (blocked) return reply({ ...stamp(), refused: true, code: "FMC-VIEWSTYLE-GUARD", message: blocked }, true);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: VIEWSTYLE_FIX["FMC-BATCH-LOCKED"] }, true);
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-VIEWSTYLE-REFERENCES", message: refsProblem }, true);
    if (!ops.length) return reply({ ...summary, refused: true, read_only: true }, true);
    const roots = [...(loadedCfg.config.protected_paths ?? []), ...protectedRoots(loadedCfg.config)];
    const applyBody = { document: args.document.trim(), action, ops, protected_roots: roots, _protected_roots: roots, references: args.references ?? {} };
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_viewstyle_apply", applyBody, 180000)) as Record<string, unknown>;
    const appliedCode = typeof applied.code === "string" ? applied.code : "";
    return reply({ ...summary, read_only: false, dry_run: false, applied, ...(appliedCode ? { code: appliedCode, message: VIEWSTYLE_FIX[appliedCode] ?? "" } : {}) });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcViewStyleTool(server: McpServer) {
  server.tool("fmc_viewstyle", FMC_VIEWSTYLE_DESCRIPTION, FMC_VIEWSTYLE_SHAPE, async (args) => runFmcViewStyle(args as FmcViewStyleArgs));
}
