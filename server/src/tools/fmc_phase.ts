import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { kitPaths } from "../fmc/context.js";
import { parseConfig } from "../fmc/aiuse.js";
import { batchBoard } from "../fmc/batchline.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import {
  PHASE_BANK_SHAPES, phaseEntriesFromStandards, citePhase, verdictFor,
  type PhaseBankEntry,
} from "../fmc/phase_bank.js";
import {
  appendRevisionLedger, auditPhase, categoriesFor, checkIssue, comparePhases, compareRevisions,
  findRevision, normalizeSnapshot, packIds, planBatchCheck, planClouds, readRevisionLedger,
  sheetIdsForSet, type PhaseSnapshot, type RevisionLedgerLine,
} from "../fmc/phase.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_PHASE_DESCRIPTION =
  "Formcraft phases and revisions. One tool. Pass document (exact title or full path) on every call. " +
  "A missing name is FMC-DOC-REQUIRED, a name that matches nothing is FMC-DOC-NOT-FOUND, and a name that matches two documents is FMC-DOC-AMBIGUOUS. " +
  "The active document is not a guess. " +
  "actions: phases (read-only list of phases, phase filters and revisions, with sequence and issued), " +
  "audit (demolished before created, demolition in Existing or the first phase, host versus hosted-family phase, rooms or spaces missing per phase, views with no or a suspicious phase filter; counts and ids), " +
  "batch_check (the batch's phase against created and demolished phases, and the view phase and phase filter so new work stays visible; dry_run defaults to true; dry_run false fixes the mismatches), " +
  "revision_open (create a revision or attach to an existing one), " +
  "revision_cloud (one cloud per sheet view or placed view around the changed elements' extents), " +
  "compare (added, removed and changed counts and ids by category, between two phases or two revisions in the ledger; for the handoff pack), " +
  "issue (bump a revision on a sheet set, check titleblock revision parameters and the revision schedule, mark issued when the checks pass), " +
  "unissue (set Issued back to false; nothing is deleted). " +
  "phase on fmc_batch request is stored on the lease. batch_check reads it when phase is omitted. " +
  "dry_run defaults to true. A write needs batch_lease, stays under 50 operations, and does not save or sync. " +
  "save_exclude, sync_exclude, protected_paths and auto_save_minutes come from fmc_guard.json. " +
  "Elements another user owns, or that are not current, are skipped. " +
  "Standards are phase.* and revision.* in FMC_Standards_Building.json. A missing key is PROVISIONAL and cannot PASS. " +
  "draft or approved with a clause can PASS. A null value is UNKNOWN, or the provisional default when one exists. " +
  "No images. The reply is counts and ids.";

export const FMC_PHASE_SHAPE = {
  action: z.enum(["phases", "audit", "batch_check", "revision_open", "revision_cloud", "compare", "issue", "unissue"]),
  document: z.string().optional().default("").describe("Exact title or full path of an open document. Required. The active document is not used."),
  phase: z.string().optional().default("").describe("batch_check: the phase this batch declares. Omitted: the phase stored on the fmc_batch lease."),
  ids: z.array(z.string()).optional().default([]).describe("Elements the batch creates, or the elements a cloud is drawn around."),
  demolish_ids: z.array(z.string()).optional().default([]).describe("batch_check: elements this batch demolishes in the declared phase."),
  view: z.string().optional().default("").describe("batch_check: one view, by id or name. Omitted: views already on the batch phase."),
  revision: z.string().optional().default("").describe("Revision id, sequence or description. revision_open attaches when it matches an unissued revision."),
  description: z.string().optional().default("").describe("Revision description. Omitted: the revision prefix plus the batch id."),
  date: z.string().optional().default("").describe("Revision date string. Omitted: Revit uses its default."),
  batch_id: z.string().optional().default("").describe("Batch id written on the revision ledger line."),
  batch_lease: z.string().optional().default("").describe("Lease id from fmc_batch request. Required when dry_run is false."),
  from: z.string().optional().default("").describe("compare: the earlier phase or revision."),
  to: z.string().optional().default("").describe("compare: the later phase or revision."),
  by: z.enum(["phase", "revision"]).optional().default("phase").describe("compare: two phases from the model, or two revisions from the ledger. Revision compare does not call Revit."),
  sheet_set: z.string().optional().default("").describe("issue: the sheet set to bump, by name."),
  dry_run: z.boolean().optional().default(true).describe("Return the plan unless false. A real apply needs batch_lease."),
  sample_limit: z.number().int().min(1).max(50).optional().default(50).describe("How many element ids the reply keeps per finding. The count is the full number."),
};

export type FmcPhaseArgs = z.infer<z.ZodObject<typeof FMC_PHASE_SHAPE>>;

export interface PhaseIo {
  readSnapshot?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  /** standards object, or the whole bank file's standards map. Skips the kit file. */
  bank?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  phaseOfLease?: (lease: string) => string;
  guard?: GuardConfig;
}

function bankOf(io: PhaseIo): Record<string, PhaseBankEntry> {
  if (io.bank) return phaseEntriesFromStandards(io.bank);
  return loadPhaseBank(io.env ?? process.env);
}

export function loadPhaseBank(env: NodeJS.ProcessEnv = process.env): Record<string, PhaseBankEntry> {
  const direct = (env.FMC_STANDARDS_FILE ?? "").trim();
  const read = (file: string) => {
    const kit = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { standards?: Record<string, unknown> };
    return phaseEntriesFromStandards(kit.standards);
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
    tool: "fmc_phase", refused: true, code: "FMC-DOC-REQUIRED",
    message: "[FMC-DOC-REQUIRED] fmc_phase needs document: a title or a full path. Refusing to use the active document.",
  }, true);
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-PHASE";
  return reply({ tool: "fmc_phase", refused: true, code, message }, true);
}

function leaseOf(args: FmcPhaseArgs): string {
  return args.batch_lease.trim() || (batchLease.getStore() ?? "");
}

function phaseName(args: FmcPhaseArgs, io: PhaseIo): string {
  if (args.phase.trim()) return args.phase.trim();
  const lease = leaseOf(args);
  if (!lease) return "";
  if (io.phaseOfLease) return io.phaseOfLease(lease).trim();
  try { return batchBoard().phaseOf(lease).trim(); } catch { return ""; }
}

function docOf(snapshot: PhaseSnapshot | undefined, named: string): { title: string; path: string } {
  if (snapshot?.resolved_document?.title || snapshot?.resolved_document?.path) {
    return { title: snapshot.resolved_document.title, path: snapshot.resolved_document.path };
  }
  if (/[\\/]/.test(named)) {
    const base = path.win32.basename(named).replace(/\.(rvt|rfa)$/i, "");
    return { title: base, path: named };
  }
  return { title: named, path: "" };
}

function autosaveMinutes(cfg: GuardConfig): number {
  const raw = (cfg as unknown as { ai_modeller?: { auto_save_minutes?: unknown; mode?: unknown } }).ai_modeller;
  if (raw && typeof raw.auto_save_minutes === "number") return raw.auto_save_minutes;
  const ai = parseConfig(raw);
  return ai?.auto_save_minutes ?? (ai?.mode === "testing" ? 10 : 0);
}

function guardState(doc: { title: string; path: string }, snapshot: PhaseSnapshot | undefined, io: PhaseIo) {
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(io.env ?? process.env));
  const minutes = autosaveMinutes(loaded.config);
  const blob = `${doc.title} ${doc.path}`;
  let reason: string | null = null;
  if (/hebert hostels/i.test(blob)) reason = "HEBERT HOSTELS is not written by fmc_phase.";
  else if (/[\\/]centrals[\\/]/i.test(doc.path)) reason = "A file under a Centrals folder is not written by fmc_phase.";
  else if (snapshot?.is_central) reason = "A central model is not written by fmc_phase.";
  else reason = saveBlocked(doc, loaded.config);
  if (!reason && loaded.problem) reason = loaded.problem;
  return {
    reason, auto_save_minutes: minutes, saved: false, synced: false,
    save_exclude: loaded.config.save_exclude ?? [],
    sync_exclude: loaded.config.sync_exclude ?? [],
    protected_paths: loaded.config.protected_paths ?? [],
  };
}

async function readModel(args: FmcPhaseArgs, scope: string, extra: Record<string, unknown>, io: PhaseIo): Promise<PhaseSnapshot> {
  const body = { document: args.document, scope, ...extra };
  if (io.readSnapshot) return normalizeSnapshot(await io.readSnapshot(body));
  const raw = await withRevitConnection((client) => client.sendCommand("fmc_phase", body, 180000));
  return normalizeSnapshot(raw);
}

async function applyModel(args: FmcPhaseArgs, action: string, ops: object[], cap: number, io: PhaseIo): Promise<Record<string, unknown>> {
  const ids = [...new Set(ops.flatMap((op) => {
    const row = op as { ids?: string[] };
    return Array.isArray(row.ids) ? row.ids.map((id) => String(id)) : [];
  }))];
  const body = { document: args.document, action, ops: ops.slice(0, cap), max_ops: cap, ids };
  if (io.apply) return (await io.apply(body)) as Record<string, unknown>;
  return await withRevitConnection((client) => client.sendCommand("fmc_phase_apply", body, 180000)) as Record<string, unknown>;
}

function needLease(args: FmcPhaseArgs) {
  if (args.dry_run !== false) return null;
  if (leaseOf(args)) return null;
  return reply({
    tool: "fmc_phase", refused: true, code: "FMC-BATCH-LOCKED", dry_run: true,
    message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was changed.",
  }, true);
}

function stamp(snapshot: PhaseSnapshot, extra: Record<string, unknown>) {
  return {
    tool: "fmc_phase",
    document: argsDocument(snapshot),
    ...(snapshot.resolved_document ? { resolved_document: snapshot.resolved_document } : {}),
    bank_shapes: PHASE_BANK_SHAPES,
    ...extra,
  };
}

function argsDocument(snapshot: PhaseSnapshot): string {
  return snapshot.resolved_document?.title || snapshot.resolved_document?.path || "";
}

function ledgerLine(args: FmcPhaseArgs, snapshot: PhaseSnapshot, action: string, revision: { id: string; sequence: number | null; description: string; issued: boolean | null }, elementIds: string[], clouds: RevisionLedgerLine["clouds"]): RevisionLedgerLine {
  const doc = docOf(snapshot, args.document);
  return {
    at: new Date().toISOString(), tool: "fmc_phase", action,
    batch_id: args.batch_id, revision_id: revision.id, revision_sequence: revision.sequence,
    revision_description: revision.description, document: doc,
    element_ids: elementIds, categories: categoriesFor(snapshot, elementIds), clouds, issued: revision.issued,
  };
}

export async function runFmcPhase(args: FmcPhaseArgs, io: PhaseIo = {}) {
  const missing = requireDocument(args.document);
  if (missing) return missing;
  const bank = bankOf(io);
  const env = io.env ?? process.env;
  try {
    if (args.action === "compare" && args.by === "revision") {
      if (!args.from.trim() || !args.to.trim()) {
        return reply({ tool: "fmc_phase", refused: true, code: "FMC-PHASE-UNKNOWN", message: "[FMC-PHASE-UNKNOWN] compare needs from and to." }, true);
      }
      const pack = compareRevisions(readRevisionLedger(env), args.from, args.to, docOf(undefined, args.document));
      return reply({ tool: "fmc_phase", action: "compare", read_only: true, server_only: true, revit: false, ...pack, bank_shapes: PHASE_BANK_SHAPES });
    }
    if (args.action === "phases") {
      const snapshot = await readModel(args, "phases", {}, io);
      return reply(stamp(snapshot, {
        action: "phases", read_only: true, revit: true,
        phases: snapshot.phases, filters: snapshot.filters,
        revisions: snapshot.revisions.map((revision) => ({
          id: revision.id, sequence: revision.sequence, description: revision.description,
          issued: revision.issued, date: revision.date,
        })),
        standards: ["phase.existing_name", "phase.new_work_name", "phase.visible_filters", "revision.sequence_step"].map((key) => citePhase(key, bank)),
      }));
    }
    if (args.action === "audit") {
      const snapshot = await readModel(args, "audit", {}, io);
      const result = auditPhase(snapshot, bank, args.sample_limit);
      const failedRows = result.findings.filter((row) => row.count > 0);
      return reply(stamp(snapshot, {
        action: "audit", read_only: true, revit: true,
        pass: failedRows.length === 0 && result.findings.every((row) => row.verdict === "PASS"),
        findings: result.findings, standards: result.standards,
        partial: snapshot.partial === true, element_total: snapshot.element_total,
      }));
    }
    if (args.action === "batch_check") {
      const phase = phaseName(args, io);
      if (!phase) return reply({ tool: "fmc_phase", refused: true, code: "FMC-PHASE-REQUIRED", message: "[FMC-PHASE-REQUIRED] batch_check needs phase, or a phase on the fmc_batch lease." }, true);
      const snapshot = await readModel(args, "batch", { ids: [...args.ids, ...args.demolish_ids], view: args.view, phase }, io);
      const planned = planBatchCheck(snapshot, { phase, ids: args.ids, demolish_ids: args.demolish_ids, view: args.view }, bank);
      if (!planned.ok) return reply({ tool: "fmc_phase", refused: true, code: planned.code, message: planned.message }, true);
      const mismatches = planned.plan.mismatches.map((row) => ({ code: row.code, ...packIds(row.ids, args.sample_limit) }));
      const preview = {
        ...stamp(snapshot, {
          action: "batch_check", phase: planned.plan.phase, mismatches, ops: planned.plan.ops,
          capped: planned.plan.capped, cap: planned.plan.cap, standards: planned.plan.standards,
          dry_run: args.dry_run !== false, saved: false, synced: false,
        }),
      };
      if (args.dry_run !== false) return reply({ ...preview, read_only: true, revit: true });
      const lease = needLease(args);
      if (lease) return lease;
      if (planned.plan.capped) {
        return reply({ ...preview, refused: true, code: "FMC-PHASE-CAP", message: `[FMC-PHASE-CAP] ${planned.plan.ops.length} operations exceed ${planned.plan.cap}. Split the batch. Nothing was changed.` }, true);
      }
      if (!planned.plan.ops.length) return reply({ ...preview, applied: false, read_only: false, message: "Nothing to fix." });
      const guard = guardState(docOf(snapshot, args.document), snapshot, io);
      if (guard.reason) return reply({ ...preview, refused: true, code: "FMC-PHASE-GUARD", message: guard.reason, guard }, true);
      const applied = await applyModel(args, "batch_check", planned.plan.ops, planned.plan.cap, io);
      return reply({ ...preview, read_only: false, revit: true, applied, guard });
    }
    if (args.action === "revision_open" || args.action === "revision_cloud") {
      const scope = args.action === "revision_cloud" ? "cloud" : "phases";
      const snapshot = await readModel(args, scope, { ids: args.ids, revision: args.revision }, io);
      const existing = findRevision(snapshot, args.revision);
      if (args.revision.trim() && !existing && args.action === "revision_cloud") {
        return reply({ tool: "fmc_phase", refused: true, code: "FMC-PHASE-REVISION", message: `[FMC-PHASE-REVISION] No revision "${args.revision}".` }, true);
      }
      if (existing?.issued) {
        return reply({ tool: "fmc_phase", refused: true, code: "FMC-PHASE-ISSUED", message: "[FMC-PHASE-ISSUED] That revision is issued. Open a new one. Nothing was changed." }, true);
      }
      const prefix = citePhase("revision.description_prefix", bank);
      const description = args.description.trim() || existing?.description || `${String(prefix.value ?? "FMC")} ${args.batch_id}`.trim();
      if (args.action === "revision_open") {
        const preview = stamp(snapshot, {
          action: "revision_open", dry_run: args.dry_run !== false, saved: false, synced: false,
          attach: !!existing, revision_id: existing?.id ?? "", description, date: args.date, standard: prefix,
          element_ids: packIds(args.ids, args.sample_limit),
        });
        if (args.dry_run !== false) return reply({ ...preview, read_only: true, revit: true });
        const lease = needLease(args);
        if (lease) return lease;
        const guard = guardState(docOf(snapshot, args.document), snapshot, io);
        if (guard.reason) return reply({ ...preview, refused: true, code: "FMC-PHASE-GUARD", message: guard.reason, guard }, true);
        const op = { op: "revision_open", ids: [] as string[], revision_id: existing?.id ?? "", description, date: args.date };
        const applied = await applyModel(args, "revision_open", [op], 1, io);
        if (applied.rolled_back === true || applied.applied === false) return reply({ ...preview, read_only: false, revit: true, applied, guard, ledger: "" }, true);
        const revisionId = String(applied.revision_id ?? existing?.id ?? "");
        const file = revisionId ? appendRevisionLedger(ledgerLine(args, snapshot, "revision_open", {
          id: revisionId, sequence: typeof applied.sequence === "number" ? applied.sequence : existing?.sequence ?? null,
          description, issued: false,
        }, args.ids, []), env) : "";
        return reply({ ...preview, read_only: false, revit: true, applied, ledger: file, guard });
      }
      const revisionId = existing?.id ?? "";
      const clouds = planClouds(snapshot, { revision_id: revisionId, element_ids: args.ids }, bank);
      const preview = stamp(snapshot, {
        action: "revision_cloud", dry_run: args.dry_run !== false, saved: false, synced: false,
        revision_id: revisionId, clouds: clouds.clouds.map((cloud) => ({ ...cloud, element_ids: packIds(cloud.element_ids, args.sample_limit) })),
        cloud_count: clouds.clouds.length, skipped_views: clouds.skipped_views, capped: clouds.capped, cap: clouds.cap, standard: clouds.standard,
      });
      if (args.dry_run !== false) return reply({ ...preview, read_only: true, revit: true });
      const lease = needLease(args);
      if (lease) return lease;
      if (clouds.capped) return reply({ ...preview, refused: true, code: "FMC-PHASE-CAP", message: `[FMC-PHASE-CAP] ${clouds.clouds.length} clouds exceed ${clouds.cap}. Nothing was changed.` }, true);
      if (!clouds.clouds.length) return reply({ ...preview, applied: false, message: "No sheet view or placed view shows these elements." });
      const guard = guardState(docOf(snapshot, args.document), snapshot, io);
      if (guard.reason) return reply({ ...preview, refused: true, code: "FMC-PHASE-GUARD", message: guard.reason, guard }, true);
      const ops = clouds.clouds.slice(0, clouds.cap).map((cloud) => ({
        op: "cloud", ids: [cloud.view_id], revision_id: revisionId, view_id: cloud.view_id, sheet_id: cloud.sheet_id,
        min_u_mm: cloud.min_u_mm, min_v_mm: cloud.min_v_mm, max_u_mm: cloud.max_u_mm, max_v_mm: cloud.max_v_mm,
      }));
      const applied = await applyModel(args, "revision_cloud", ops, clouds.cap, io);
      if (applied.rolled_back === true || applied.applied === false) return reply({ ...preview, read_only: false, revit: true, applied, guard, ledger: "" }, true);
      const made = Array.isArray(applied.clouds) ? applied.clouds as RevisionLedgerLine["clouds"] : [];
      const file = appendRevisionLedger(ledgerLine(args, snapshot, "revision_cloud", {
        id: revisionId, sequence: existing?.sequence ?? null, description: existing?.description ?? "", issued: false,
      }, args.ids, made), env);
      return reply({ ...preview, read_only: false, revit: true, applied, ledger: file, guard });
    }
    if (args.action === "compare") {
      if (!args.from.trim() || !args.to.trim()) {
        return reply({ tool: "fmc_phase", refused: true, code: "FMC-PHASE-UNKNOWN", message: "[FMC-PHASE-UNKNOWN] compare needs from and to." }, true);
      }
      const snapshot = await readModel(args, "compare", { from: args.from, to: args.to }, io);
      const result = comparePhases(snapshot, args.from, args.to);
      if (!result.ok) return reply({ tool: "fmc_phase", refused: true, code: result.code, message: result.message }, true);
      return reply(stamp(snapshot, { action: "compare", read_only: true, revit: true, server_only: false, ...result.pack }));
    }
    const snapshot = await readModel(args, "issue", { sheet_set: args.sheet_set, revision: args.revision, titleblock_params: citePhase("revision.titleblock_params", bank).value }, io);
    if (!args.sheet_set.trim() && args.action === "issue") {
      return reply({ tool: "fmc_phase", refused: true, code: "FMC-PHASE-SET", message: "[FMC-PHASE-SET] issue needs sheet_set." }, true);
    }
    if (args.action === "unissue") {
      const revision = findRevision(snapshot, args.revision);
      if (!revision) return reply({ tool: "fmc_phase", refused: true, code: "FMC-PHASE-REVISION", message: `[FMC-PHASE-REVISION] No revision "${args.revision}".` }, true);
      const preview = stamp(snapshot, { action: "unissue", dry_run: args.dry_run !== false, saved: false, revision_id: revision.id, issued: revision.issued });
      if (args.dry_run !== false) return reply({ ...preview, read_only: true, revit: true, would_set_issued: false });
      const lease = needLease(args);
      if (lease) return lease;
      const guard = guardState(docOf(snapshot, args.document), snapshot, io);
      if (guard.reason) return reply({ ...preview, refused: true, code: "FMC-PHASE-GUARD", message: guard.reason, guard }, true);
      const applied = await applyModel(args, "unissue", [{ op: "unissue", ids: [revision.id], revision_id: revision.id }], 1, io);
      if (applied.rolled_back === true || applied.applied === false) return reply({ ...preview, read_only: false, revit: true, applied, guard, ledger: "" }, true);
      const file = appendRevisionLedger(ledgerLine(args, snapshot, "unissue", { id: revision.id, sequence: revision.sequence, description: revision.description, issued: false }, [], []), env);
      return reply({ ...preview, read_only: false, revit: true, applied, ledger: file, guard });
    }
    const sheetIds = sheetIdsForSet(snapshot, args.sheet_set);
    if (!sheetIds.length) return reply({ tool: "fmc_phase", refused: true, code: "FMC-PHASE-SET", message: `[FMC-PHASE-SET] No sheet set "${args.sheet_set}".` }, true);
    const { cap } = { cap: Math.min(50, sheetIds.length) };
    const limited = sheetIds.slice(0, 50);
    const checked = checkIssue(snapshot, limited, bank);
    const governing = [checked.params, checked.schedule].sort((a, b) => {
      const rank: Record<string, number> = { unknown: 0, provisional: 1, standards: 2 };
      return (rank[a.source] ?? 0) - (rank[b.source] ?? 0);
    })[0];
    const verdict = verdictFor(checked.ok, governing);
    const existing = findRevision(snapshot, args.revision);
    const prefix = citePhase("revision.description_prefix", bank);
    const description = args.description.trim() || existing?.description || `${String(prefix.value ?? "FMC")} ${args.batch_id}`.trim();
    const preview = stamp(snapshot, {
      action: "issue", dry_run: args.dry_run !== false, saved: false, synced: false,
      sheet_set: args.sheet_set, sheet_ids: packIds(limited, args.sample_limit), capped: sheetIds.length > 50,
      checks: checked.checks, checks_ok: checked.ok, would_mark_issued: checked.ok, verdict,
      standards: [checked.params, checked.schedule, checked.step, prefix],
      revision_id: existing?.id ?? "", description,
    });
    if (args.dry_run !== false) return reply({ ...preview, read_only: true, revit: true });
    const lease = needLease(args);
    if (lease) return lease;
    if (sheetIds.length > 50) return reply({ ...preview, refused: true, code: "FMC-PHASE-CAP", message: "[FMC-PHASE-CAP] The sheet set has more than 50 sheets. Split it. Nothing was changed." }, true);
    if (!checked.ok) return reply({ ...preview, refused: true, code: "FMC-PHASE-ISSUE", message: "[FMC-PHASE-ISSUE] A titleblock revision parameter is missing or blank, or the revision schedule is missing. Nothing was changed." }, true);
    const guard = guardState(docOf(snapshot, args.document), snapshot, io);
    if (guard.reason) return reply({ ...preview, refused: true, code: "FMC-PHASE-GUARD", message: guard.reason, guard }, true);
    const op = {
      op: "issue", ids: limited, revision_id: existing?.id ?? "", description, date: args.date,
      titleblock_params: checked.params.value, schedule_required: checked.schedule.value !== false, mark_issued: checked.ok,
    };
    const applied = await applyModel(args, "issue", [op], cap, io);
    if (applied.rolled_back === true || applied.applied === false) return reply({ ...preview, read_only: false, revit: true, applied, guard, ledger: "" }, true);
    const revisionId = String(applied.revision_id ?? existing?.id ?? "");
    const file = revisionId ? appendRevisionLedger(ledgerLine(args, snapshot, "issue", {
      id: revisionId, sequence: typeof applied.sequence === "number" ? applied.sequence : existing?.sequence ?? null,
      description, issued: applied.issued === true,
    }, [], []), env) : "";
    return reply({ ...preview, read_only: false, revit: true, applied, ledger: file, guard });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcPhaseTool(server: McpServer) {
  server.tool("fmc_phase", FMC_PHASE_DESCRIPTION, FMC_PHASE_SHAPE, (args) => runFmcPhase(args));
}
