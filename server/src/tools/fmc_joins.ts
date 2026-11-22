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
  JOINS_BANK_SHAPES, JOINS_DEFAULTS, joinsEntriesFromStandards,
  type JoinsBankEntry,
} from "../fmc/joins_bank.js";
import {
  auditFindings, auditKeys, catalogue, hasScope, hostingFindings, hostKeys, joinsDir,
  normalizeSnapshot, overallVerdict, planFixes, pressureResult, resolveJoinsLimits,
  roomFindings, roomKeys, standardsFor, summarizeFindings, writeJoinsReport,
  type JoinsFinding, type JoinsSnapshot, type JoinsValues, type ResolvedLimits,
} from "../fmc/joins.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_JOINS_DESCRIPTION =
  "Formcraft join audit and envelope pressure test. One tool. Pass document (exact title or full path) on every model call. " +
  "A missing name is FMC-DOC-REQUIRED, a name that matches nothing is FMC-DOC-NOT-FOUND, and a name that matches two documents is FMC-DOC-AMBIGUOUS. " +
  "The active document is not a guess. " +
  "actions: checks (catalogue, no Revit), limits (resolved joins.* tolerances and their sources, no Revit), " +
  "audit (wall end and corner joins, gaps, overlaps, wall-to-floor, wall-to-roof, wall-to-column and framing, curtain wall to wall, floor and slab edges, stair or railing to floor), " +
  "hosting (doors and windows outside the host or not cutting it, families floating off a level, face or host, fixtures not touching a wall or floor, unhosted families that should be hosted; category filters the rows), " +
  "pressure_test (exterior envelope of exterior walls, roofs, floors on grade, curtain walls, doors and windows counted as closed; leak paths by geometry, solid booleans and ray or voxel sampling; verdict SEALED, LEAKS or UNKNOWN; scope by level or by room or space; mode rooms checks every room closes), " +
  "rooms (room and space closure, walls that are not room-bounding, boundary gaps), " +
  "fix (plan joins, snaps, attaches and unambiguous re-hosts). " +
  "dry_run defaults to true and returns the plan. dry_run false applies those ops through fmc_joins_apply, one transaction, at most 50 operations, and needs batch_lease. " +
  "Pass the ops from the dry run. A fix does not scan again. " +
  "Collectors are scoped by level, category, bounding box, room, space or ids. An unscoped scan above joins.scan_cap is refused. " +
  "The reply is counts and ids per finding code, with location and size in the JSON file under %LOCALAPPDATA%\\Formcraft\\joins. Images are included only when images is true. " +
  "Tolerances are joins.* in FMC_Standards_Building.json. A missing key is a labelled PROVISIONAL default and cannot PASS. " +
  "draft or approved with a clause can PASS. A null status is UNKNOWN. A null value uses the labelled provisional default. " +
  "save_exclude, sync_exclude and protected_paths come from fmc_guard.json. " +
  "Pinned elements and elements another user owns, or that are not current, are reported and not moved. Ownership is never taken. " +
  "The tool does not save or sync. " +
  "Example: action audit, document F26901-FMC-ZZ-ZZ-M3-A-0001, level Level 1. Example: action pressure_test, document that model, mode rooms.";

const limit = (key: string) => z.number().optional().describe(`${key} override. The bank status still decides PASS.`);

export const FMC_JOINS_SHAPE = {
  action: z.enum(["checks", "limits", "audit", "hosting", "pressure_test", "rooms", "fix"]),
  document: z.string().optional().default("").describe("Exact title or full path of an open document. Required on a model call. The active document is not used."),
  level: z.string().optional().default("").describe("Level id or name. Scopes the collectors."),
  category: z.string().optional().default("").describe("Category name. Scopes the collectors, and filters hosting rows."),
  room: z.string().optional().default("").describe("Room id, number or name. Scopes the collectors."),
  space: z.string().optional().default("").describe("Space id, number or name. Scopes the collectors."),
  bbox: z.object({
    min: z.object({ x: z.number(), y: z.number(), z: z.number() }),
    max: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  }).optional().describe("Bounding box in millimetres. Scopes the collectors."),
  ids: z.array(z.string()).optional().default([]).describe("Element ids. Scopes the collectors."),
  mode: z.enum(["envelope", "rooms"]).optional().default("envelope").describe("pressure_test: envelope leak paths, or every room and space closing."),
  resolution_mm: z.number().positive().optional().describe("Voxel and edge step in millimetres. Omitted: joins.voxel_mm."),
  images: z.boolean().optional().default(false).describe("Export one PNG into the joins folder. Off unless you ask. The active view is restored if Revit switches it."),
  dry_run: z.boolean().optional().default(true).describe("fix: return the plan unless false. A real apply needs batch_lease and the ops from this plan."),
  batch_lease: z.string().optional().default("").describe("Lease id from fmc_batch request. Required when dry_run is false."),
  sample_limit: z.number().int().min(1).max(50).optional().default(20).describe("How many element ids the reply keeps per finding code. The count is the full number."),
  ops: z.array(z.object({
    op: z.string(),
    ids: z.array(z.string()).optional(),
    end: z.number().optional(),
    host: z.string().optional(),
    xyz: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
    offset_mm: z.number().optional(),
    move_mm: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
    code: z.string().optional(),
    reason: z.string().optional(),
  })).optional().default([]).describe("fix with dry_run false: the ops from the dry run. At most 50 are applied."),
  gap_mm: limit("joins.gap_mm"),
  overlap_mm: limit("joins.overlap_mm"),
  near_miss_mm: limit("joins.near_miss_mm"),
  leak_min_mm: limit("joins.leak_min_mm"),
  host_offset_mm: limit("joins.host_offset_mm"),
};

export type FmcJoinsArgs = z.infer<z.ZodObject<typeof FMC_JOINS_SHAPE>>;

export function parseJoinsArgs(input: unknown): FmcJoinsArgs {
  return z.object(FMC_JOINS_SHAPE).parse(input);
}

export interface JoinsIo {
  readSnapshot?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  bank?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function bankOf(io: JoinsIo): Record<string, JoinsBankEntry> {
  if (io.bank) return joinsEntriesFromStandards(io.bank);
  return loadJoinsBank(io.env ?? process.env);
}

export function loadJoinsBank(env: NodeJS.ProcessEnv = process.env): Record<string, JoinsBankEntry> {
  const direct = (env.FMC_STANDARDS_FILE ?? "").trim();
  const read = (file: string) => {
    const kit = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { standards?: Record<string, unknown> };
    return joinsEntriesFromStandards(kit.standards);
  };
  if (direct) {
    try { return read(direct); } catch { return {}; }
  }
  try {
    const loaded = loadConfig(configPath(env));
    const file = path.win32.join(path.win32.dirname(kitPaths(loaded.config).recipesDir), "FMC_Standards_Building.json");
    return read(file);
  } catch {
    return {};
  }
}

function requireDocument(document: string) {
  if (document.trim()) return null;
  return reply({
    tool: "fmc_joins", refused: true, code: "FMC-DOC-REQUIRED",
    message: "[FMC-DOC-REQUIRED] fmc_joins needs document: a title or a full path. Refusing to use the active document.",
  }, true);
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-JOINS";
  return reply({ tool: "fmc_joins", refused: true, code, message }, true);
}

function leaseOf(args: FmcJoinsArgs): string {
  return args.batch_lease.trim() || (batchLease.getStore() ?? "");
}

function overrides(args: FmcJoinsArgs): Partial<Record<keyof JoinsValues, number>> {
  const out: Partial<Record<keyof JoinsValues, number>> = {};
  const keys = ["gap_mm", "overlap_mm", "near_miss_mm", "leak_min_mm", "host_offset_mm"] as const;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number") out[key] = value;
  }
  if (typeof args.resolution_mm === "number") out.voxel_mm = args.resolution_mm;
  return out;
}

function docOf(snapshot: JoinsSnapshot | undefined, named: string): { title: string; path: string } {
  if (snapshot?.resolved_document?.title || snapshot?.resolved_document?.path) {
    return { title: snapshot.resolved_document.title, path: snapshot.resolved_document.path };
  }
  if (/[\\/]/.test(named)) return { title: path.win32.basename(named).replace(/\.(rvt|rfa)$/i, ""), path: named };
  return { title: named, path: "" };
}

function guardReason(doc: { title: string; path: string }, snapshot: JoinsSnapshot | undefined, io: JoinsIo): { reason: string | null; config: GuardConfig } {
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(io.env ?? process.env));
  const blob = `${doc.title} ${doc.path}`;
  let reason: string | null = null;
  if (/hebert hostels/i.test(blob)) reason = "HEBERT HOSTELS is not written by fmc_joins.";
  else if (/[\\/]centrals[\\/]/i.test(doc.path)) reason = "A file under a Centrals folder is not written by fmc_joins.";
  else if (snapshot?.is_central) reason = "A central model is not written by fmc_joins.";
  else reason = saveBlocked(doc, loaded.config);
  if (!reason && loaded.problem) reason = loaded.problem;
  return { reason, config: loaded.config };
}

async function readModel(args: FmcJoinsArgs, limits: ResolvedLimits, io: JoinsIo): Promise<JoinsSnapshot> {
  const body: Record<string, unknown> = {
    document: args.document,
    action: args.action === "fix" ? "fix" : args.action,
    level: args.level,
    category: args.category,
    room: args.room,
    space: args.space,
    ids: args.ids,
    mode: args.mode,
    images: args.images === true,
    scan_cap: limits.values.scan_cap,
    search_mm: limits.values.search_mm,
    resolution_mm: limits.values.voxel_mm,
    max_rays: limits.values.max_rays,
    max_pairs: limits.values.max_pairs,
    leak_min_mm: limits.values.leak_min_mm,
    gap_mm: limits.values.gap_mm,
    host_offset_mm: limits.values.host_offset_mm,
  };
  if (args.bbox) body.bbox = args.bbox;
  if (io.readSnapshot) return normalizeSnapshot(await io.readSnapshot(body));
  const raw = await withRevitConnection((client) => client.sendCommand("fmc_joins", body, 180000));
  return normalizeSnapshot(raw);
}

async function applyModel(args: FmcJoinsArgs, ops: object[], cap: number, io: JoinsIo, config: GuardConfig): Promise<Record<string, unknown>> {
  const ids = [...new Set(ops.flatMap((op) => {
    const row = op as { ids?: string[] };
    return Array.isArray(row.ids) ? row.ids.map((id) => String(id)) : [];
  }))];
  const roots = [...(config.protected_paths ?? []), ...protectedRoots(config)];
  const body = {
    document: args.document,
    action: "fix",
    ops: ops.slice(0, cap),
    max_ops: cap,
    ids,
    protected_roots: roots,
    _protected_roots: roots,
  };
  if (io.apply) return (await io.apply(body)) as Record<string, unknown>;
  return await withRevitConnection((client) => client.sendCommand("fmc_joins_apply", body, 180000)) as Record<string, unknown>;
}

function imagesOf(snapshot: JoinsSnapshot, asked: boolean): { path: string }[] {
  if (!asked) return [];
  return snapshot.images;
}

function report(io: JoinsIo, kind: string, body: unknown): string {
  const dir = io.reportDir || joinsDir(io.env ?? process.env);
  try { return writeJoinsReport(dir, kind, body); } catch (error) {
    return "";
  }
}

function stamp(snapshot: JoinsSnapshot, extra: Record<string, unknown>, askedImages: boolean) {
  return {
    tool: "fmc_joins",
    document: snapshot.resolved_document?.title || snapshot.resolved_document?.path || "",
    ...(snapshot.resolved_document ? { resolved_document: snapshot.resolved_document } : {}),
    read_only: true,
    saved: false,
    synced: false,
    images: imagesOf(snapshot, askedImages),
    active_unchanged: snapshot.active_unchanged !== false,
    bank_shapes: JOINS_BANK_SHAPES,
    ...extra,
  };
}

function summarized(findings: JoinsFinding[], citedKeys: string[], limits: ResolvedLimits, sample: number) {
  const standards = standardsFor(citedKeys, limits.cited);
  return {
    findings: summarizeFindings(findings, sample),
    verdict: overallVerdict(findings, standards),
    pass: overallVerdict(findings, standards) === "PASS",
    standards,
    counts: {
      findings: findings.length,
      codes: new Set(findings.map((item) => item.code)).size,
    },
  };
}

export async function runFmcJoins(args: FmcJoinsArgs, io: JoinsIo = {}) {
  const bank = bankOf(io);
  const limits = resolveJoinsLimits(overrides(args), bank);
  if (args.action === "checks") {
    return reply({
      ...catalogue(),
      bank_shapes: JOINS_BANK_SHAPES,
      defaults: JOINS_DEFAULTS,
      read_only: true,
    });
  }
  if (args.action === "limits") {
    return reply({
      tool: "fmc_joins",
      read_only: true,
      limits: limits.fields,
      cited: limits.cited,
      values: limits.values,
      bank_shapes: JOINS_BANK_SHAPES,
      defaults: JOINS_DEFAULTS,
      status: "provisional never PASS. draft or approved with a clause can PASS. A null status is UNKNOWN. A null value uses the labelled provisional default.",
    });
  }
  const missing = requireDocument(args.document);
  if (missing) return missing;
  if (args.action === "fix" && args.dry_run === false) return applyFix(args, limits, io);
  try {
    if (/hebert hostels/i.test(args.document) && args.action === "fix") {
      return reply({ tool: "fmc_joins", refused: true, code: "FMC-JOINS-GUARD", message: "HEBERT HOSTELS is not written by fmc_joins." }, true);
    }
    const snapshot = await readModel(args, limits, io);
    if (snapshot.refused) {
      return reply({
        tool: "fmc_joins", refused: true, code: snapshot.code || "FMC-JOINS-SCOPE",
        message: snapshot.message || "[FMC-JOINS-SCOPE] Name a level, category, bounding box, room, space or element ids. An unscoped scan above the cap is refused.",
        element_count: snapshot.element_count,
        scan_cap: limits.values.scan_cap,
        ...(snapshot.resolved_document ? { resolved_document: snapshot.resolved_document } : {}),
      }, true);
    }
    if (args.action === "fix") return planReply(args, snapshot, limits, io);
    return readReply(args, snapshot, limits, io);
  } catch (error) {
    return failed(error);
  }
}

function readReply(args: FmcJoinsArgs, snapshot: JoinsSnapshot, limits: ResolvedLimits, io: JoinsIo) {
  const sample = args.sample_limit;
  if (args.action === "audit") {
    const findings = auditFindings(snapshot, limits);
    const body = summarized(findings, auditKeys(), limits, sample);
    const file = report(io, "audit", { ...body, items: findings, resolved_document: snapshot.resolved_document });
    return reply(stamp(snapshot, { action: "audit", scoped: snapshot.scoped === true || hasScope(args), partial: snapshot.partial === true, element_count: snapshot.element_count, report: file, ...body }, args.images));
  }
  if (args.action === "hosting") {
    const findings = hostingFindings(snapshot, limits, args.category);
    const body = summarized(findings, hostKeys(), limits, sample);
    const file = report(io, "hosting", { ...body, items: findings, resolved_document: snapshot.resolved_document });
    return reply(stamp(snapshot, { action: "hosting", category: args.category, report: file, ...body }, args.images));
  }
  if (args.action === "rooms") {
    const findings = roomFindings(snapshot, limits);
    const body = summarized(findings, roomKeys(), limits, sample);
    const closure = pressureResult(snapshot, limits, "rooms");
    const file = report(io, "rooms", { ...body, closure, items: findings, resolved_document: snapshot.resolved_document });
    return reply(stamp(snapshot, { action: "rooms", closure: closure.verdict, closure_reason: closure.reason, standard_verdict: closure.standard_verdict, report: file, ...body }, args.images));
  }
  const pressure = pressureResult(snapshot, limits, args.mode);
  const body = summarized(pressure.leaks, roomKeys(), limits, sample);
  const file = report(io, "pressure", { pressure, items: pressure.leaks, resolved_document: snapshot.resolved_document, envelope: snapshot.envelope });
  return reply(stamp(snapshot, {
    action: "pressure_test",
    mode: args.mode,
    ...body,
    verdict: pressure.verdict,
    standard_verdict: pressure.standard_verdict,
    reason: pressure.reason,
    envelope: snapshot.envelope,
    report: file,
  }, args.images));
}

function planReply(args: FmcJoinsArgs, snapshot: JoinsSnapshot, limits: ResolvedLimits, io: JoinsIo) {
  const doc = docOf(snapshot, args.document);
  const guard = guardReason(doc, snapshot, io);
  if (guard.reason) {
    return reply({
      tool: "fmc_joins", refused: true, code: "FMC-JOINS-GUARD", dry_run: true, read_only: true,
      message: guard.reason,
      resolved_document: snapshot.resolved_document ?? doc,
      save_exclude: guard.config.save_exclude ?? [],
      sync_exclude: guard.config.sync_exclude ?? [],
      protected_paths: guard.config.protected_paths ?? [],
    }, true);
  }
  const findings = [...auditFindings(snapshot, limits), ...hostingFindings(snapshot, limits, args.category)];
  const plan = planFixes(findings, snapshot, limits);
  const summary = summarized(findings, [...auditKeys(), ...hostKeys()], limits, args.sample_limit);
  const file = report(io, "fix", { plan, items: findings, resolved_document: snapshot.resolved_document });
  return reply({
    ...stamp(snapshot, { action: "fix", report: file, ...summary }, args.images),
    dry_run: true,
    ops: plan.ops,
    skipped: plan.skipped,
    warnings: plan.warnings,
    capped: plan.capped,
    rule: plan.rule,
    next: "Show this plan. Apply with dry_run false, batch_lease, and these ops. That call is fmc_joins_apply, one transaction, at most 50 operations.",
  });
}

async function applyFix(args: FmcJoinsArgs, limits: ResolvedLimits, io: JoinsIo) {
  if (!leaseOf(args)) {
    return reply({
      tool: "fmc_joins", refused: true, code: "FMC-BATCH-LOCKED", dry_run: true,
      message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was changed.",
    }, true);
  }
  const named = (args.ops ?? []).slice(0, limits.values.max_ops);
  if (!named.length) {
    return reply({
      tool: "fmc_joins", refused: true, code: "FMC-JOINS-PLAN", dry_run: true,
      message: "[FMC-JOINS-PLAN] fix with dry_run false applies the ops from a dry run. Run dry_run true, then pass those ops. Nothing was changed.",
    }, true);
  }
  const doc = docOf(undefined, args.document);
  const guard = guardReason(doc, undefined, io);
  if (guard.reason) {
    return reply({
      tool: "fmc_joins", refused: true, code: "FMC-JOINS-GUARD", dry_run: true,
      message: guard.reason,
      save_exclude: guard.config.save_exclude ?? [],
      sync_exclude: guard.config.sync_exclude ?? [],
      protected_paths: guard.config.protected_paths ?? [],
    }, true);
  }
  try {
    const applied = await applyModel(args, named, limits.values.max_ops, io, guard.config);
    const resolved = applied.resolved_document && typeof applied.resolved_document === "object"
      ? applied.resolved_document as { title?: string; path?: string }
      : undefined;
    const file = report(io, "apply", { ops: named, applied });
    return reply({
      tool: "fmc_joins",
      action: "fix",
      dry_run: false,
      read_only: false,
      saved: false,
      synced: false,
      document: resolved?.title || doc.title || args.document,
      ...(resolved ? { resolved_document: { title: resolved.title ?? "", path: resolved.path ?? "" } } : {}),
      ops: named,
      applied,
      report: file,
      rule: "One transaction. At most 50 operations. Pinned elements and elements another user owns are skipped. Ownership is not taken. The model is not saved or synced.",
    });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcJoinsTool(server: McpServer) {
  server.tool("fmc_joins", FMC_JOINS_DESCRIPTION, FMC_JOINS_SHAPE, async (args) => runFmcJoins(args as FmcJoinsArgs));
}
