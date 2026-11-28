/**
 * fmc_directshape: the actions. limits, create, list and remove. The server checks the whitelist, the spec, the lease and
 * confirm before anything reaches Revit; the add-in checks the document, the category and the owner again.
 * Reads are fmc_directshape (no transaction). Writes are fmc_directshape_apply (one transaction, all or nothing).
 */
import fs from "node:fs";
import path from "node:path";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "./target.js";
import { documentsMatch, leaseHeldDocuments } from "./batchline.js";
import { leaseCoversAny } from "./docresolve.js";
import { configPath, csvLine, expandEnv, loadConfig, type GuardConfig } from "./policy.js";
import { protectedRoots } from "./opencopy.js";
import { DS_APPLICATION_ID, DS_DATA_PREFIX, checkCategory, resolveWhitelist, type Whitelist } from "./directshape_cats.js";
import { DS_LIMITS, DS_PURPOSES, RUN_ID_PATTERN, newRunId, normaliseShapes, planHash, summarise, type DsShape, type RawShape } from "./directshape_spec.js";
import type { FmcDirectshapeArgs } from "./directshape_args.js";

type Body = Record<string, unknown>;

export interface DirectshapeIo {
  /** The read command, fmc_directshape. */
  read?: (body: Body) => Promise<unknown>;
  /** The write command, fmc_directshape_apply. */
  apply?: (body: Body) => Promise<unknown>;
  config?: GuardConfig;
  now?: () => Date;
  random?: () => string;
  /** The documents a lease covers. Default: this server's batch board. */
  heldDocuments?: (lease: string) => string[];
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.win32.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function leaseProblem(lease: string, document: string, held: (lease: string) => string[]): string | null {
  if (!lease) return "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was changed.";
  const docs = (() => { try { return held(lease); } catch { return []; } })();
  if (!docs.length) return `[FMC-BATCH-LOCKED] Lease ${lease} is not held by this server. Request one with fmc_batch for ${document}. Nothing was changed.`;
  if (!leaseCoversAny(docs, { title: document, path: document }, documentsMatch)) return `[FMC-BATCH-LOCKED] Lease ${lease} is for ${docs.join(", ")}, not ${document}. Nothing was changed.`;
  return null;
}

function rawShapes(args: FmcDirectshapeArgs): RawShape[] | string {
  const single = args.kind !== undefined || args.size_mm !== undefined || args.profile_mm !== undefined;
  if (single && args.shapes.length) return "Give one shape directly (kind, origin_mm, ...) or shapes, not both.";
  if (!single) return args.shapes as RawShape[];
  return [{
    kind: args.kind, name: args.name, category: args.category, purpose: args.purpose, mark: args.mark, level: args.level,
    origin_mm: args.origin_mm, size_mm: args.size_mm, profile_mm: args.profile_mm, height_mm: args.height_mm, rotation_deg: args.rotation_deg,
  }];
}

/** What the add-in gets for one shape: the category as Revit names it, and the spec. */
function wire(shape: DsShape, bic: string, name: string) {
  return { index: shape.index, name: shape.name, category: name, bic, purpose: shape.purpose, mark: shape.mark, level: shape.level, parts: shape.parts };
}

function wanted(whitelist: Whitelist) {
  return whitelist.allowed.map((c) => ({ name: c.name, bic: c.bic }));
}

export async function runFmcDirectshape(args: FmcDirectshapeArgs, io: DirectshapeIo = {}) {
  const config = io.config ?? loadConfig(configPath()).config;
  const whitelist = resolveWhitelist(config);
  const runId = newRunId(io.now?.(), io.random);
  const stamp = (extra: Body = {}): Body => ({ tool: "fmc_directshape", run_id: runId, action: args.action, application_id: DS_APPLICATION_ID, saved: false, synced: false, ...extra });
  const document = args.document.trim();
  const dry = args.dry_run !== false;
  const refuse = (code: string, message: string, extra: Body = {}) => {
    log(config, `fmc_directshape ${args.action}`, dry, document, `refused ${code}`, `${runId} ${message}`.slice(0, 300));
    return reply(stamp({ refused: true, code, message, dry_run: dry, ...extra }), true);
  };
  const protect = [...(config.protected_paths ?? []), ...protectedRoots(config)];
  const send = async (command: "fmc_directshape" | "fmc_directshape_apply", body: Body): Promise<Record<string, unknown>> => {
    const full = { ...body, document, run_id: runId, protected_roots: protect, _protected_roots: protect, whitelist: wanted(whitelist) };
    const io1 = command === "fmc_directshape" ? io.read : io.apply;
    if (io1) return (await io1(full)) as Record<string, unknown>;
    return (await withRevitConnection((client) => client.sendCommand(command, full, 180000))) as Record<string, unknown>;
  };
  try {
    if (args.action === "limits") {
      return reply(stamp({
        read_only: true,
        whitelist: { allowed: whitelist.allowed.map((c) => c.name), source: whitelist.source, ignored: whitelist.ignored, ...(whitelist.problem ? { problem: whitelist.problem } : {}) },
        limits: DS_LIMITS, purposes: DS_PURPOSES, data_id_format: `${DS_DATA_PREFIX}<run_id>|<n>`,
        lease: "A real create or remove needs batch_lease (fmc_batch request) for the document, confirm true, and dry_run false.",
      }));
    }
    if (!document) return refuse("FMC-DOC-REQUIRED", `[FMC-DOC-REQUIRED] fmc_directshape ${args.action} needs document. The active document is never used.`);

    if (args.action === "list") {
      if (args.of_run && !RUN_ID_PATTERN.test(args.of_run)) return refuse("FMC-DS-SELECT", `[FMC-DS-SELECT] of_run "${args.of_run}" is not a run_id from create (DS-yyyymmddHHMMSS-xxxx).`);
      const raw = await send("fmc_directshape", { mode: "list", of_run: args.of_run, ids: args.ids.map(String), limit: args.sample_limit });
      log(config, "fmc_directshape list", true, document, "listed", `${runId} count ${String(raw.count ?? "")}`);
      return reply(stamp({ read_only: true, document, ...raw }));
    }

    if (args.action === "remove") {
      if (args.of_run && !RUN_ID_PATTERN.test(args.of_run)) return refuse("FMC-DS-SELECT", `[FMC-DS-SELECT] of_run "${args.of_run}" is not a run_id from create (DS-yyyymmddHHMMSS-xxxx).`);
      if (!args.of_run && !args.ids.length && !args.all) return refuse("FMC-DS-SELECT", "[FMC-DS-SELECT] remove needs ids, of_run, or all true. Only shapes this tool made are ever removed.");
      const select = { of_run: args.of_run, ids: args.ids.map(String), all: args.all };
      if (dry) {
        const raw = await send("fmc_directshape", { mode: "list", ...select, limit: args.sample_limit });
        log(config, "fmc_directshape remove", true, document, "dry run", `${runId} would remove ${String(raw.count ?? "")}`);
        return reply(stamp({ dry_run: true, read_only: true, document, would_remove: raw, next: "Remove for real with dry_run false, confirm true and batch_lease. Only these shapes go." }));
      }
      const gate = writeGate(args, document, io);
      if (gate) return refuse(gate.code, gate.message);
      const raw = await send("fmc_directshape_apply", { mode: "remove", ...select });
      log(config, "fmc_directshape remove", false, document, "removed", `${runId} removed ${JSON.stringify(raw.removed ?? []).slice(0, 200)}`);
      return reply(stamp({ dry_run: false, read_only: false, document, applied: raw }));
    }

    // create
    const raw = rawShapes(args);
    if (typeof raw === "string") return refuse("FMC-DS-SPEC", `[FMC-DS-SPEC] ${raw}`);
    const norm = normaliseShapes(raw);
    if (norm.problems.length) return refuse("FMC-DS-SPEC", norm.problems[0].message, { problems: norm.problems });
    const wire1: ReturnType<typeof wire>[] = [];
    const cats: string[] = [];
    for (const shape of norm.shapes) {
      const c = checkCategory(shape.category, whitelist);
      if (!c.ok) return refuse(c.code, c.message, { shape: shape.index + 1, allowed: whitelist.allowed.map((x) => x.name) });
      cats.push(c.category.name);
      wire1.push(wire(shape, c.category.bic, c.category.name));
    }
    const hash = planHash(document, cats, norm.shapes);
    const summaries = norm.shapes.map((s, i) => ({ ...summarise(s), category: cats[i] }));
    const totals = { shapes: summaries.length, parts: summaries.reduce((n, s) => n + s.parts, 0), volume_m3: Math.round(summaries.reduce((n, s) => n + s.volume_m3, 0) * 1e6) / 1e6 };
    if (dry) {
      const check = await send("fmc_directshape", { mode: "check", shapes: wire1 });
      log(config, "fmc_directshape create", true, document, "dry run", `${runId} ${totals.shapes} shapes ${hash}`);
      return reply(stamp({ dry_run: true, read_only: true, document, would_create: summaries, totals, plan_hash: hash, revit: check, whitelist_source: whitelist.source,
        next: "Create for real with dry_run false, confirm true, batch_lease and this plan_hash. One transaction; if any shape fails nothing is made." }));
    }
    const gate = writeGate(args, document, io);
    if (gate) return refuse(gate.code, gate.message);
    if (args.plan_hash && args.plan_hash !== hash) return refuse("FMC-DS-PLAN-CHANGED", `[FMC-DS-PLAN-CHANGED] The spec is not the one the dry run hashed (${args.plan_hash} vs ${hash}). Run the dry run again. Nothing was changed.`, { plan_hash: hash });
    const applied = await send("fmc_directshape_apply", { mode: "create", shapes: wire1 });
    log(config, "fmc_directshape create", false, document, "created", `${runId} ${totals.shapes} shapes ${hash}`);
    return reply(stamp({ dry_run: false, read_only: false, document, plan_hash: hash, totals, created_from: summaries, applied }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse("FMC-DIRECTSHAPE", message);
  }
}

/** A real write: confirm first, then the lease. Null when both pass. */
function writeGate(args: FmcDirectshapeArgs, document: string, io: DirectshapeIo): { code: string; message: string } | null {
  if (args.confirm !== true) return { code: "FMC-DS-CONFIRM", message: `[FMC-DS-CONFIRM] A real ${args.action} needs confirm true, after a person said yes to the dry run. Nothing was changed.` };
  const lease = args.batch_lease.trim() || (batchLease.getStore() ?? "").trim();
  const problem = leaseProblem(lease, document, io.heldDocuments ?? leaseHeldDocuments);
  return problem ? { code: "FMC-BATCH-LOCKED", message: problem } : null;
}
