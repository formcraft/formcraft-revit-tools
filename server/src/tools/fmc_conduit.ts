import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { loadConfig, type GuardConfig } from "../fmc/policy.js";
import { batchLease } from "../fmc/target.js";
import { batchBoard } from "../fmc/batchline.js";
import { writeGuard } from "../fmc/opencopy.js";
import { traceEntriesFromStandards, type TraceBankEntry } from "../fmc/trace_bank.js";
import { conduitLimits, fittingCovered, JUNCTION_FAMILY, nearestSize, pairEnds, sizeComment, type ConduitEnd, type SizeRequest } from "../fmc/conduitplan.js";
import { writeReport } from "../fmc/localreport.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_CONDUIT_DESCRIPTION =
  "Formcraft conduit ends. Actions: scan (free ends, the nearest end within tolerance, aligned or offset, same or different size), " +
  "fix (elbow, union or transition, or extend and trim; dry_run defaults to true), " +
  "sizes (add nominal sizes to the conduit size table, for example 20 and 25 mm, and report whether the type's fittings are set for them), " +
  "fittings (set the conduit type elbow, union, tee, cross and transition from loaded families). " +
  "Each fitting is its own subtransaction, so one lookup failure at commit does not roll the batch back. " +
  "resize_fallback sets the nearest size in the table and writes Comments 'nominal 20 mm PVC'. " +
  "junction true places FMC_E_ElecFixture_JunctionBox 75x75_Galv when that family is loaded. " +
  "A missing fitting type is FMC-NO-FITTING-TYPE. DirectShapes are skipped. " +
  "dry_run false needs batch_lease. Pass document when more than one document is open. " +
  "HEBERT HOSTELS, a central and protected_paths are refused. Tolerances are the trace.* keys. A missing key is PROVISIONAL. " +
  "The reply is counts and a capped id list. The full list is JSON under %LOCALAPPDATA%\\Formcraft\\conduit. No pictures. " +
  "Cable tray open ends are reported by fmc_trace domain tray. This tool fixes conduit, and tray when domain is tray or both.";

const size = z.object({ nominal_mm: z.number().positive(), id_mm: z.number().positive(), od_mm: z.number().positive(), bend_mm: z.number().positive().optional() });

const shape = {
  action: z.enum(["scan", "fix", "sizes", "fittings"]),
  document: z.string().optional().default(""),
  dry_run: z.boolean().optional().default(true),
  batch_lease: z.string().optional().default(""),
  domain: z.enum(["conduit", "tray", "both"]).optional().default("conduit"),
  near_mm: z.number().optional(),
  touch_mm: z.number().optional(),
  size_mm: z.number().optional(),
  direction_deg: z.number().optional(),
  junction: z.boolean().optional().default(false),
  junction_family: z.string().optional().default(JUNCTION_FAMILY),
  resize_fallback: z.boolean().optional().default(false),
  comment_material: z.string().optional().default("PVC"),
  type_name: z.string().optional().default(""),
  standard_name: z.string().optional().default(""),
  sizes: z.array(size).optional().default([]),
  elbow: z.string().optional().default(""),
  union: z.string().optional().default(""),
  tee: z.string().optional().default(""),
  cross: z.string().optional().default(""),
  transition: z.string().optional().default(""),
  ids: z.array(z.number().int()).optional(),
  sample_limit: z.number().int().min(1).max(100).optional().default(40),
};

export type FmcConduitArgs = z.infer<z.ZodObject<typeof shape>>;

export interface ConduitSnapshot {
  model?: string;
  resolved_document?: { title?: string; path?: string };
  is_central?: boolean;
  ends?: ConduitEnd[];
  sizes_mm?: number[];
  fittings?: { elbow?: boolean; union?: boolean; tee?: boolean; cross?: boolean; transition?: boolean };
  fitting_types_loaded?: string[];
  skipped_non_family?: { count?: number; ids?: number[] };
}

export interface ConduitIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  bank?: Record<string, TraceBankEntry>;
  guard?: GuardConfig;
  env?: NodeJS.ProcessEnv;
  /** Test hook: the lease board's holder of a document. */
  holder?: (document: string) => { lease: string; client: string } | null;
}

function fail(code: string, message: string, hint: string) {
  return reply({ ok: false, code, message: `[${code}] ${message}`, hint }, true);
}

function bankOf(io: ConduitIo): Record<string, TraceBankEntry> {
  if (io.bank) return io.bank;
  try {
    const { config } = loadConfig();
    const file = path.win32.join(path.win32.dirname(kitPaths(config).recipesDir), "FMC_Standards_Building.json");
    const kit = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { standards?: Record<string, unknown> };
    return traceEntriesFromStandards(kit.standards);
  } catch {
    return {};
  }
}

function guard(snapshot: ConduitSnapshot, io: ConduitIo, named = ""): string | null {
  const config = io.guard ?? loadConfig().config;
  const title = snapshot.resolved_document?.title || snapshot.model || "";
  const file = snapshot.resolved_document?.path || "";
  if (/hebert hostels/i.test(`${title} ${file} ${named}`)) return "HEBERT HOSTELS is not written by fmc_conduit.";
  if (snapshot.is_central) return "A central model is not written by fmc_conduit.";
  const pathName = file.replace(/\//g, "\\").toLowerCase();
  for (const root of config.protected_paths ?? []) {
    const norm = root.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    if (norm && (pathName === norm || pathName.startsWith(norm + "\\"))) return `The document is under a protected path (${root}).`;
  }
  // B6: the shared write guard too (protected_roots, the forbidden-project floor, save_exclude).
  const shared = writeGuard({ title, path: file, isFamily: false, isWorkshared: snapshot.is_central === true, isActive: false } as any, "fmc_conduit_apply", { dry_run: false }, config);
  if (!shared.ok) return shared.reasons.join(" ");
  return null;
}

export async function runFmcConduit(args: FmcConduitArgs, io: ConduitIo = {}) {
  const bank = bankOf(io);
  const limits = conduitLimits(bank, { near_mm: args.near_mm, touch_mm: args.touch_mm, size_mm: args.size_mm, direction_deg: args.direction_deg });
  let snapshot: ConduitSnapshot = {};
  try {
      const body = { mode: "snapshot", document: args.document, domain: args.domain, type_name: args.type_name };
      snapshot = ((io.read ? await io.read(body) : await withRevitConnection((client) => client.sendRaw("fmc_conduit", body, 300000))) ?? {}) as ConduitSnapshot;
  } catch (error) {
    // B6: fail closed for every action. sizes and fittings used to carry on with an empty snapshot, so the guard saw
    // no document (no central, no path) and the write went ahead.
    const message = error instanceof Error ? error.message : String(error);
    if (args.action === "scan" || args.action === "fix") {
      return reply({ tool: "fmc_conduit", read_only: true, error: message }, true);
    }
    return fail("FMC-CONDUIT-SNAPSHOT", `The model could not be read (${message}), so the guard cannot check it. Nothing was changed.`, "Check that the document is open and the add-in answers, then run again.");
  }
  const ends = (snapshot.ends ?? []).filter((end) => !args.ids || args.ids.includes(end.element_id));
  const paired = pairEnds(ends, limits, { junction: args.junction });
  const table = snapshot.sizes_mm ?? [];
  const coverage = (args.sizes ?? []).map((row) => ({ ...row, ...fittingCovered(row.nominal_mm, table, snapshot.fittings ?? {}), nearest: nearestSize(row.nominal_mm, table), comment: sizeComment(row.nominal_mm, args.comment_material) }));
  const sample = args.sample_limit;
  const report = writeReport("conduit", args.action, { limits, pairs: paired.pairs, free: paired.free.length, coverage, skipped: paired.skipped }, io.env);
  if (args.action === "scan") {
    return reply({
      tool: "fmc_conduit", read_only: true, action: "scan", document: snapshot.resolved_document ?? { title: snapshot.model ?? args.document, path: "" },
      limits, provisional: limits.provisional, free: paired.free.length, pairs: paired.pairs.length,
      sample: paired.pairs.slice(0, sample).map((pair) => ({ a: pair.a.element_id, b: pair.b.element_id, gap_mm: pair.gap_mm, alignment: pair.alignment, same_size: pair.same_size, op: pair.op, confidence: pair.confidence })),
      skipped: paired.skipped.slice(0, sample), ids: { count: paired.free.length, ids: paired.free.slice(0, sample).map((end) => end.element_id), capped: paired.free.length > sample },
      report, skipped_non_family: snapshot.skipped_non_family ?? { count: 0, ids: [] },
    });
  }
  if (!(snapshot.resolved_document?.title || snapshot.resolved_document?.path || snapshot.model))
    return fail("FMC-CONDUIT-SNAPSHOT", "The snapshot named no document, so the guard cannot check it. Nothing was changed.", "Pass document and run again.");
  const refusal = guard(snapshot, io, args.document);
  if (refusal) return fail("FMC-CONDUIT-GUARD", refusal, "This model is not written by fmc_conduit.");
  const ops = paired.pairs.filter((pair) => pair.op !== "report").map((pair) => ({
    op: pair.op, a: pair.a.element_id, ai: pair.a.index, b: pair.b.element_id, bi: pair.b.index,
    size_mm: pair.a.size_mm, confidence: pair.confidence, detail: pair.detail,
  }));
  if (args.dry_run !== false) {
    return reply({
      tool: "fmc_conduit", dry_run: true, read_only: true, action: args.action, limits, provisional: limits.provisional,
      document: snapshot.resolved_document ?? { title: snapshot.model ?? "", path: "" },
      ops: args.action === "fix" ? ops.slice(0, sample) : undefined,
      op_count: ops.length,
      sizes: args.sizes, coverage, fittings: { elbow: args.elbow, union: args.union, tee: args.tee, cross: args.cross, transition: args.transition, type_name: args.type_name },
      junction_family: args.junction ? args.junction_family : undefined,
      report,
      next: "Apply with dry_run false and batch_lease. Each fitting is its own subtransaction.",
    });
  }
  const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "");
  if (!lease) return fail("FMC-BATCH-LOCKED", "This write needs batch_lease from fmc_batch request. Nothing was changed.", "fmc_batch request, then pass batch_lease.");
  // B6: a real lease check: the lease passed must be the one held on this document, not just a non-empty string.
  const leaseDoc = snapshot.resolved_document?.path || snapshot.resolved_document?.title || snapshot.model || args.document;
  let holder: { lease: string; client: string } | null = null;
  try {
    const holderOf = io.holder ?? ((d: string) => batchBoard().activeHolder(d));
    holder = holderOf(leaseDoc) ?? (snapshot.resolved_document?.title ? holderOf(snapshot.resolved_document.title) : null);
  } catch { holder = null; }
  if (!holder || holder.lease !== lease)
    return fail("FMC-BATCH-LOCKED", `${!holder ? `Nobody holds the lease on ${leaseDoc}.` : `Lease ${lease} is not the one held on ${leaseDoc}.`} Nothing was changed.`, "fmc_batch request on this document, then pass that batch_lease.");
  const missing = [args.elbow, args.union, args.tee, args.cross, args.transition].filter(Boolean).filter((name) => !(snapshot.fitting_types_loaded ?? []).some((loaded) => loaded.toLowerCase() === name.toLowerCase()));
  if (args.action === "fittings" && missing.length) {
    return fail("FMC-NO-FITTING-TYPE", `Not loaded: ${missing.join(", ")}.`, "Load the kit fitting families, then run fittings again.");
  }
  const body = {
    mode: args.action, document: args.document, domain: args.domain, ops: args.action === "fix" ? ops : [],
    sizes: args.sizes as SizeRequest[], standard_name: args.standard_name, type_name: args.type_name,
    elbow: args.elbow, union: args.union, tee: args.tee, cross: args.cross, transition: args.transition,
    junction: args.junction, junction_family: args.junction_family, resize_fallback: args.resize_fallback, comment_material: args.comment_material,
  };
  try {
    const applied = (io.apply ? await io.apply(body) : await withRevitConnection((client) => client.sendCommand("fmc_conduit_apply", body, 300000))) as Record<string, unknown>;
    return reply({ tool: "fmc_conduit", dry_run: false, ...applied, planned: ops.length, report, provisional: limits.provisional }, applied?.applied !== true);
  } catch (error) {
    return reply({ tool: "fmc_conduit", error: error instanceof Error ? error.message : String(error) }, true);
  }
}

export function registerFmcConduitTool(server: McpServer) {
  server.tool("fmc_conduit", FMC_CONDUIT_DESCRIPTION, shape, (args) => runFmcConduit(args));
}
