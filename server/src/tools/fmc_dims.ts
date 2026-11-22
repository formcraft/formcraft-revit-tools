import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import { DIMS_FIX, planDims, referenceProblems, writeDimsReport, type DimCurve, type DimOpening, type DimTarget } from "../fmc/dims.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_DIMS_DESCRIPTION =
  "Dimension strings along grids and along exterior walls, with openings in the chain. " +
  "action auto. targets is grids, walls, openings, or a list of those. chain true makes one string per run; false makes a string per adjacent pair. " +
  "offset_mm is how far the dimension line sits off the references (default 600). " +
  "dry_run defaults to true and returns the planned references and the dimension line. It does not create a dimension. " +
  "A write is fmc_dims_apply, one transaction, one subtransaction per string, and needs batch_lease plus references.kit, references.standards and references.rulebook. " +
  "A missing reference is FMC-DIMS-NO-REFERENCE and that string is not created. Interior walls are skipped. " +
  "JSON under %LOCALAPPDATA%\\Formcraft\\dims. No pictures. " +
  "Example: action auto, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, view \"Level 1\", targets [\"grids\",\"walls\"], chain true, offset_mm 600, dry_run true.";

const refs = z.object({
  kit: z.array(z.string()).optional(),
  standards: z.array(z.string()).optional(),
  rulebook: z.array(z.string()).optional(),
}).optional();

const target = z.enum(["grids", "walls", "openings"]);

export const FMC_DIMS_SHAPE = {
  action: z.literal("auto").optional().default("auto"),
  document: z.string().optional().default(""),
  view: z.string().optional().default(""),
  targets: z.union([target, z.array(target).min(1)]).optional().default(["grids", "walls", "openings"]),
  chain: z.boolean().optional().default(true),
  offset_mm: z.number().positive().optional().default(600),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  references: refs,
};

export type FmcDimsArgs = z.infer<z.ZodObject<typeof FMC_DIMS_SHAPE>>;

export interface DimsIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-DIMS";
  return reply({ tool: "fmc_dims", refused: true, code, message, saved: false, synced: false }, true);
}

function stamp(extra: Record<string, unknown> = {}) {
  return {
    tool: "fmc_dims",
    action: "auto",
    images: [] as [],
    saved: false,
    synced: false,
    cites: {
      kit: "FMC-BIM-MAN-001 annotation",
      standards: "FMC-BIM-STD-002 dimensions",
      rulebook: "Dimension strings follow grids and exterior walls. Interior walls are left alone.",
    },
    ...extra,
  };
}

function asCurve(row: unknown): DimCurve | null {
  if (!row || typeof row !== "object") return null;
  const item = row as DimCurve;
  if (!item.id || [item.x0, item.y0, item.x1, item.y1].some((n) => typeof n !== "number")) return null;
  return item;
}

export async function runFmcDims(args: FmcDimsArgs, io: DimsIo = {}) {
  const env = io.env ?? process.env;
  try {
    if (!args.document.trim()) return reply({ ...stamp(), refused: true, code: "FMC-DOC-REQUIRED", message: DIMS_FIX["FMC-DOC-REQUIRED"] }, true);
    if (!args.view.trim()) return reply({ ...stamp(), refused: true, code: "FMC-DIMS-VIEW", message: DIMS_FIX["FMC-DIMS-VIEW"] }, true);
    const targets = (Array.isArray(args.targets) ? args.targets : [args.targets]) as DimTarget[];
    const readBody = { document: args.document.trim(), view: args.view.trim(), targets };
    const raw = io.read
      ? await io.read(readBody)
      : await withRevitConnection((client) => client.sendCommand("fmc_dims", readBody, 180000));
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (body.refused === true) return reply({ ...stamp(), refused: true, code: String(body.code ?? "FMC-DIMS"), message: String(body.message ?? "The read was refused.") }, true);
    const doc = { title: String(body.title ?? args.document), path: String(body.path ?? ""), is_central: body.is_central === true };
    const plan = planDims({
      grids: (Array.isArray(body.grids) ? body.grids : []).map(asCurve).filter((row): row is DimCurve => !!row),
      walls: (Array.isArray(body.walls) ? body.walls : []).map(asCurve).filter((row): row is DimCurve => !!row),
      openings: (Array.isArray(body.openings) ? body.openings : []) as DimOpening[],
      targets,
      chain: args.chain !== false,
      offset_mm: args.offset_mm,
    });
    const report = writeDimsReport(env, { document: doc.title, view: args.view, plan }, io.reportDir);
    const dry = args.dry_run !== false;
    const summary = stamp({
      dry_run: dry,
      read_only: dry,
      document: doc.title,
      view: String(body.view ?? args.view),
      targets,
      chain: args.chain !== false,
      offset_mm: args.offset_mm,
      strings: plan.strings,
      references: plan.strings.map((row) => row.references),
      skipped: plan.skipped,
      report,
    });
    if (dry) return reply({ ...summary, next: "Nothing was dimensioned. Apply with dry_run false, batch_lease, and references. That call is fmc_dims_apply, one transaction." });
    const blob = `${doc.title} ${doc.path}`;
    if (/hebert hostels/i.test(blob) || doc.is_central) return reply({ ...stamp(), refused: true, code: "FMC-DIMS-GUARD", message: "HEBERT HOSTELS and a central model are not written by fmc_dims." }, true);
    const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
    const blocked = saveBlocked(doc, loaded.config) || loaded.problem;
    if (blocked) return reply({ ...stamp(), refused: true, code: "FMC-DIMS-GUARD", message: blocked }, true);
    const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
    if (!lease) return reply({ ...stamp(), refused: true, code: "FMC-BATCH-LOCKED", message: DIMS_FIX["FMC-BATCH-LOCKED"] }, true);
    const refsProblem = referenceProblems(args.references);
    if (refsProblem) return reply({ ...stamp(), refused: true, code: "FMC-DIMS-REFERENCES", message: refsProblem }, true);
    if (!plan.strings.length) return reply({ ...summary, refused: true, code: "FMC-DIMS-NEED-PAIR", message: DIMS_FIX["FMC-DIMS-NEED-PAIR"] }, true);
    const roots = [...(loaded.config.protected_paths ?? []), ...protectedRoots(loaded.config)];
    const applyBody = { document: args.document.trim(), view: args.view.trim(), strings: plan.strings, protected_roots: roots, _protected_roots: roots, references: args.references ?? {} };
    const applied = io.apply
      ? await io.apply(applyBody) as Record<string, unknown>
      : await withRevitConnection((client) => client.sendCommand("fmc_dims_apply", applyBody, 180000)) as Record<string, unknown>;
    return reply({ ...summary, read_only: false, dry_run: false, applied });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcDimsTool(server: McpServer) {
  server.tool("fmc_dims", FMC_DIMS_DESCRIPTION, FMC_DIMS_SHAPE, async (args) => runFmcDims(args as FmcDimsArgs));
}
