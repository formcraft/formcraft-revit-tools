/**
 * Run a library script or a Dynamo graph.
 * Preview rolls back and does not save. Apply keeps the model and does not save either:
 * the timer and the batch-end sync do that. DynamoCLI is offline only, and only with no Revit nodes.
 * Revit is never launched from here, and a journal is never replayed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { JobStillRunning } from "../utils/SocketClient.js";
import { documentTarget, batchLease, revitTarget } from "./target.js";
import { currentClient, documentDecision } from "./fairqueue.js";
import { readInstances } from "./connect.js";
import { leaseCoversAny, resolvedDocumentFrom, type ResolvedDocument } from "./docresolve.js";
import { inFlightJob, readRevitJobLines } from "./notidle.js";
import { batchBoard, documentsMatch, leaseHeldDocuments } from "./batchline.js";
import { jobResult, jobFiles } from "./jobs.js";
import { loadConfig, type GuardConfig } from "./policy.js";
import { waitWhileBusy } from "./batchstep.js";
import {
  approvedScriptPath, kitRootFrom, offlineDecision, outsideRootMessage, readDyn, type DynInspect,
} from "./dynamo.js";
import {
  INPUT_CAP, findScript, inputTooLarge, pythonSupported, refuseFullScan, refuseProtectedWrite, resolveEntry,
  screenLibrarySource, shapeDiff, withResolved, worksharedUnsafe, type ModelDiff, type ScriptManifest,
} from "./scriptlib.js";
import type { ScriptJob } from "./scriptjobs.js";
import { buildPlan, type GraphPlan } from "./graph/plan.js";
import { graphRunGate } from "./graph/rungate.js";
import { appendGraphRunLog, claimGraphApproval } from "./graph/approvals.js";
import { sha256File, sha256Text, stableJson, inputsHash } from "./graph/hash.js";

export interface RunContext {
  env?: NodeJS.ProcessEnv;
  cancelled?: () => boolean;
  log?: (line: string) => void;
  heartbeat?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

export function namedDocument(): string {
  return (documentTarget.getStore() ?? "").trim();
}

export function callDocument(command: string, env: NodeJS.ProcessEnv = process.env): { ok: true; document: ResolvedDocument | null } | { ok: false; code: string; message: string } {
  const named = namedDocument();
  let open: Array<{ title: string; path: string; family?: boolean }> = [];
  try {
    open = readInstances(env).flatMap((instance) => (instance.documents ?? []).map((doc) => ({
      title: doc.title ?? "", path: doc.path ?? "", family: doc.family === true,
    })));
  } catch { open = []; }
  const decision = documentDecision(command, open, named || undefined);
  if (!decision.ok) return { ok: false, code: decision.code, message: decision.message };
  return { ok: true, document: decision.document ?? (named ? resolvedDocumentFrom(named) : null) };
}

export function batchEndFields(document: string): { auto_saved: false; batch_end_sync: { status: "synced" | "deferred" | "skipped"; reason: string; pending: boolean } } {
  const skipped = { auto_saved: false as const, batch_end_sync: { status: "skipped" as const, reason: "Preview and apply do not save. Sync stays with the timer and the batch-end sync.", pending: false } };
  if (!document.trim()) return skipped;
  try {
    const syncs = batchBoard().snapshot().syncs as Array<{ document?: string; defer_reason?: string | null; pending_batch_end?: boolean }>;
    const key = document.trim().toLowerCase();
    const row = syncs.find((item) => (item.document ?? "").trim().toLowerCase() === key);
    if (row?.pending_batch_end || row?.defer_reason) {
      return { auto_saved: false, batch_end_sync: { status: "deferred", reason: row.defer_reason || "A batch-end sync is still owed.", pending: true } };
    }
  } catch { /* the queue still reports that this tool did not save */ }
  return skipped;
}

function outputPaths(inputs: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string" && (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\"))) found.push(value);
    else if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item);
    }
  };
  walk(inputs);
  return found;
}

export function protectedInputPaths(inputs: unknown, cfg: GuardConfig): string[] {
  return outputPaths(inputs).map((item) => refuseProtectedWrite({ path: item }, cfg)).filter((item): item is string => !!item);
}

export function dynamoCli(env: NodeJS.ProcessEnv = process.env): string {
  return (env.DYNAMO_CLI || env.FMC_DYNAMO_CLI || "").trim();
}

export function runDynamoCli(file: string, cli: string, run: (exe: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = spawnCli): Promise<Record<string, unknown>> {
  if (!cli) {
    return Promise.resolve({
      refused: true, code: "FMC-DYNAMO-UNAVAILABLE", offline: true,
      message: "[FMC-DYNAMO-UNAVAILABLE] DynamoCLI was not found. Set DYNAMO_CLI to DynamoCLI.exe. Revit was not launched.",
    });
  }
  return run(cli, ["-o", file]).then((result) => ({
    offline: true, cli, exit_code: result.code,
    stdout: result.stdout.slice(0, 4000), stderr: result.stderr.slice(0, 4000),
    inputs_applied: false,
    note: "DynamoCLI was started with -o only. Inputs stay as saved in the graph. Revit was not launched.",
  }));
}

function spawnCli(exe: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function sendWhenIdle(command: string, params: Record<string, unknown>, ctx: RunContext): Promise<unknown> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = ctx.log ?? (() => {});
  let waits = 0;
  for (;;) {
    if (ctx.cancelled?.()) return { cancelled: true, rolled_back: params.mode !== "apply", message: "Cancelled before Revit ran it." };
    const idle = await waitWhileBusy({
      isIdle: () => revitIsIdle(ctx.env),
      cancelled: () => ctx.cancelled?.() === true,
      sleep, log, heartbeat: ctx.heartbeat,
    });
    if (idle === "cancelled") return { cancelled: true, rolled_back: params.mode !== "apply", message: "Cancelled while Revit was not idle. Nothing was started." };
    try {
      return await withRevitConnection((client) => client.sendCommand(command, params, 12 * 60 * 60 * 1000));
    } catch (error) {
      if (error instanceof JobStillRunning) {
        log(error.message);
        ctx.heartbeat?.();
        return await pollRevitJob(error.job, command, ctx);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/FMC-REVIT-NOT-IDLE|FMC-BRIDGE-BUSY/.test(message)) {
        waits += 1;
        log(message);
        ctx.heartbeat?.();
        await sleep(Math.min(30_000, 5_000 * waits));
        continue;
      }
      throw error;
    }
  }
}

function revitIsIdle(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const lines = readRevitJobLines(env);
    return !readInstances(env).some((instance) => inFlightJob(lines, instance.pid));
  } catch {
    return true;
  }
}

async function pollRevitJob(job: string, command: string, ctx: RunContext): Promise<unknown> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const env = ctx.env ?? process.env;
  for (let attempt = 0; attempt < 10_000; attempt++) {
    if (ctx.cancelled?.()) {
      writeCancel(job, env);
      return { cancelled: true, job, rolled_back: true, message: "Cancelled. The add-in rolls the transaction back at its next check." };
    }
    const found = jobResult(job, env);
    if (found.found) return found.result;
    ctx.heartbeat?.();
    await sleep(Math.min(30_000, 5_000 * (attempt + 1)));
    ctx.log?.(`fmc_job ${job} for ${command} is still running`);
  }
  return { status: "running", job, message: `Still running. fmc_job status ${job}` };
}

export function writeCancel(jobId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) return;
  const dir = jobFiles(env).cancelDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, jobId), "cancel\n");
}

function leaseProblem(mode: string, document: string): string | null {
  if (mode !== "apply") return null;
  const lease = (batchLease.getStore() ?? "").trim();
  if (!lease) return "[FMC-BATCH-LOCKED] mode apply needs batch_lease for this document.";
  const held = (() => { try { return leaseHeldDocuments(lease); } catch { return []; } })();
  if (held.length && !leaseCoversAny(held, { title: document, path: document }, documentsMatch)) {
    return `[FMC-BATCH-LOCKED] Lease ${lease} is for ${held.join(", ")}, not ${document}.`;
  }
  return null;
}

export async function executeDynamo(args: {
  file: string;
  mode: "preview" | "apply" | "offline";
  inputs?: unknown;
  jobId?: string;
  cfg: GuardConfig;
  kit: string;
  /** A person's approval for this exact plan (fmc_graph_guard request_approval). Needed for apply, offline and any Python graph. */
  approvalId?: string;
}, ctx: RunContext = {}): Promise<Record<string, unknown>> {
  const doc = callDocument("fmc_dynamo", ctx.env);
  if (!doc.ok) return withResolved({ refused: true, code: doc.code, message: doc.message }, null);
  if (!approvedScriptPath(args.file, args.kit)) {
    return withResolved({ refused: true, code: "FMC-SCRIPT-ROOT", message: outsideRootMessage(args.file, args.kit) }, doc.document);
  }
  const blocked = protectedInputPaths(args.inputs, args.cfg);
  if (blocked.length) return withResolved({ refused: true, reasons: blocked }, doc.document);
  const limit = inputTooLarge(args.inputs);
  if (limit) return withResolved({ refused: true, code: "FMC-SCRIPT-LIMIT", message: limit }, doc.document);
  const parsed = readDyn(args.file);
  if (!parsed.ok) return withResolved({ refused: true, code: "FMC-DYNAMO-PARSE", message: parsed.message }, doc.document);
  // R-1, R-7, X-05: bind inputs by name (refuse unknown names), scan, package check, lock, jail, then plan_hash.
  const planned = buildPlan({
    file: args.file, inputs: (args.inputs ?? {}) as Record<string, unknown>, mode: args.mode,
    document: doc.document ? { title: doc.document.title ?? "", path: doc.document.path ?? "" } : null,
    kit: args.kit, cfg: args.cfg, env: ctx.env,
  });
  if (!planned.ok) return withResolved({ refused: true, code: planned.code, message: planned.message, reasons: planned.reasons }, doc.document);
  const plan = planned.plan;
  if (args.mode === "offline") {
    // R-3, DT-60: DynamoCLI never reaches sendCommand, so it goes through the graph gate here (a person's approval).
    const offline = offlineDecision(parsed.inspect);
    if (!offline.ok) return withResolved({ refused: true, code: offline.code, message: offline.message, inspect: parsed.inspect }, doc.document);
    const gate = graphRunGate(plan, args.approvalId, ctx.env, new Date(), "fmc_dynamo offline");
    if (!gate.ok) return withResolved({ refused: true, code: gate.code, message: gate.message, needs_approval: gate.needs_approval, plan: planSummary(plan) }, doc.document);
    return withResolved({ ...(await runOffline(args.file, parsed.inspect, ctx.env)), plan: planSummary(plan), approval_id: gate.approval?.id ?? null }, doc.document);
  }
  const lease = leaseProblem(args.mode, doc.document?.title || doc.document?.path || namedDocument());
  if (lease) return withResolved({ refused: true, code: "FMC-BATCH-LOCKED", message: lease }, doc.document);
  const gate = graphRunGate(plan, args.approvalId, ctx.env);
  if (!gate.ok) return withResolved({ refused: true, code: gate.code, message: gate.message, needs_approval: gate.needs_approval, plan: planSummary(plan) }, doc.document);
  const preview = args.mode === "preview";
  const response = await sendWhenIdle("fmc_dynamo", {
    action: "run", path: args.file, inputs: plan.inputs_by_id, mode: args.mode,
    // R-1: the add-in sets inputs by node id and refuses a key it cannot set. R-2: it refuses when Dynamo's document
    // is not this target. DT-66: it checks the kit root as path segments and the file's SHA-256.
    input_names: plan.input_binding, graph_sha256: plan.graph_sha256, kit_root: args.kit,
    target_document: doc.document?.path || doc.document?.title || namedDocument(),
    plan_hash: plan.plan_hash, approval_id: gate.approval?.id ?? "",
    dry_run: preview, report_diff: true, fmc_caller: "fmc_dynamo", script_job: args.jobId ?? "",
  }, ctx) as Record<string, unknown>;
  return { ...stampRun(response, doc.document, args.mode, parsed.inspect), plan: planSummary(plan), approval_id: gate.approval?.id ?? null };
}

/** The plan fields a caller needs, without the package folder list. */
export function planSummary(plan: GraphPlan): Record<string, unknown> {
  return {
    graph: { id: plan.graph_id, path: plan.graph, sha256: plan.graph_sha256 },
    inputs_by_id: plan.inputs_by_id,
    input_meta: plan.input_meta,
    plan_hash: plan.plan_hash, graph_sha256: plan.graph_sha256, inputs_hash: plan.inputs_hash, input_binding: plan.input_binding,
    mode: plan.mode, document: plan.document, scan_hash: plan.scan_hash, allowlist_version: plan.allowlist_version, lock: plan.lock,
    python: plan.python, findings: plan.findings, needs_approval: plan.needs_approval, approval_why: plan.approval_why,
    approval_kind: plan.approval_kind, packages: { ok: plan.packages.ok, missing: plan.packages.missing, older: plan.packages.older, not_allowed: plan.packages.not_allowed },
  };
}

async function runOffline(file: string, inspect: DynInspect, env?: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const decision = offlineDecision(inspect);
  if (!decision.ok) return { refused: true, code: decision.code, message: decision.message, inspect };
  const cli = await runDynamoCli(file, dynamoCli(env));
  return { ...cli, inspect: { name: inspect.name, inputs: inspect.inputs, outputs: inspect.outputs, packages: inspect.packages } };
}

function stampRun(response: Record<string, unknown>, doc: ResolvedDocument | null, mode: string, inspect?: DynInspect): Record<string, unknown> {
  const resolved = resolvedDocumentFrom(response.resolved_document) ?? resolvedDocumentFrom(response.document) ?? doc;
  const diff = shapeDiff(response);
  const care = batchEndFields(resolved?.title || resolved?.path || "");
  return withResolved({
    ...response,
    mode,
    dry_run: mode !== "apply",
    diff,
    outputs: response.outputs ?? response.result ?? null,
    inspect: inspect ? { name: inspect.name, inputs: inspect.inputs, outputs: inspect.outputs } : response.inspect,
    ...care,
    auto_saved: false,
  }, resolved);
}

export function prepareScript(kit: string, id: string, cfg: GuardConfig, allowFullScan: unknown): 
  { ok: true; manifest: ScriptManifest; file: string; source: string } | { ok: false; body: Record<string, unknown> } {
  const entry = findScript(kit, id);
  if (!entry) return { ok: false, body: { refused: true, code: "FMC-SCRIPT-NOT-FOUND", message: `No library script ${id}.` } };
  if (!entry.manifest || entry.problems.length) {
    return { ok: false, body: { refused: true, id, problems: entry.problems.length ? entry.problems : ["The manifest is not valid."] } };
  }
  const file = resolveEntry(kit, entry.manifest_path, entry.manifest.entry);
  if (!file.ok) return { ok: false, body: { refused: true, code: "FMC-SCRIPT-ROOT", message: file.message } };
  const scan = refuseFullScan(allowFullScan);
  if (scan) return { ok: false, body: { refused: true, code: "FMC-SEND-CODE-UNSCOPED", message: scan } };
  let source = "";
  try { source = fs.readFileSync(file.file, "utf8"); }
  catch (error) { return { ok: false, body: { refused: true, message: error instanceof Error ? error.message : String(error) } }; }
  if (entry.manifest.workshared_safe) {
    const unsafe = worksharedUnsafe(source);
    if (unsafe) {
      return { ok: false, body: { refused: true, code: "FMC-WORKSHARED-SAFE", message: `[FMC-WORKSHARED-SAFE] ${id} is marked workshared_safe and its source calls ${unsafe}.` } };
    }
  }
  if (entry.manifest.runner === "csharp") {
    const problem = screenLibrarySource(source);
    if (problem) return { ok: false, body: { refused: true, code: problem.code, message: problem.message } };
  }
  return { ok: true, manifest: entry.manifest, file: file.file, source };
}

export async function executeScript(args: {
  id: string;
  mode: "preview" | "apply" | "offline";
  inputs?: unknown;
  jobId?: string;
  cfg: GuardConfig;
  kit: string;
  allowFullScan?: unknown;
  /** A person's approval (fmc_graph_guard request_approval kind script_python) for the python runner, or a graph's approval for the dynamo runner. */
  approvalId?: string;
}, ctx: RunContext = {}): Promise<Record<string, unknown>> {
  const doc = callDocument("fmc_script_run", ctx.env);
  if (!doc.ok) return withResolved({ refused: true, code: doc.code, message: doc.message }, null);
  const blocked = protectedInputPaths(args.inputs, args.cfg);
  if (blocked.length) return withResolved({ refused: true, reasons: blocked }, doc.document);
  const limit = inputTooLarge(args.inputs);
  if (limit) return withResolved({ refused: true, code: "FMC-SCRIPT-LIMIT", message: limit }, doc.document);
  const prepared = prepareScript(args.kit, args.id, args.cfg, args.allowFullScan);
  if (!prepared.ok) return withResolved(prepared.body, doc.document);
  const { manifest, file, source } = prepared;
  if (manifest.runner === "dynamo") {
    return executeDynamo({ file, mode: args.mode === "offline" ? "offline" : args.mode, inputs: args.inputs, jobId: args.jobId, cfg: args.cfg, kit: args.kit, approvalId: args.approvalId }, ctx);
  }
  if (manifest.runner === "pyrevit" || manifest.runner === "unavailable") {
    return withResolved({
      refused: true, code: "FMC-RUNNER-UNAVAILABLE",
      message: `[FMC-RUNNER-UNAVAILABLE] runner ${manifest.runner} is not hosted in this plugin.`,
    }, doc.document);
  }
  if (manifest.runner === "python") {
    const support = pythonSupported(source);
    if (!support.ok) return withResolved({ refused: true, code: support.code, message: support.message }, doc.document);
    const cli = (ctx.env ?? process.env).FMC_PYTHON || "";
    if (!cli.trim()) {
      return withResolved({
        refused: true, code: "FMC-PYTHON-UNAVAILABLE",
        message: "[FMC-PYTHON-UNAVAILABLE] Plain Python is supported when FMC_PYTHON names the interpreter. This entry does not use the Revit API. Nothing was started.",
      }, doc.document);
    }
    // R-3, DT-60: the python runner is a child process outside sendCommand. A person approves this exact file and inputs.
    const scriptPlan = scriptPythonPlan(file, args.inputs, doc.document);
    const claim = args.approvalId?.trim()
      ? claimGraphApproval(args.approvalId.trim(), scriptPlan.plan_hash, ctx.env)
      : { ok: false as const, code: "FMC-GRAPH-APPROVAL-NEEDED", message: `[FMC-GRAPH-APPROVAL-NEEDED] A library python script runs outside Revit's gate: a person approves every run. Call fmc_graph_guard request_approval with script_id ${manifest.id}, then run again with approval_id. Plan ${scriptPlan.plan_hash}.` };
    if (!claim.ok) return withResolved({ refused: true, code: claim.code, message: `${claim.message} Nothing was started.`, needs_approval: true, plan_hash: scriptPlan.plan_hash }, doc.document);
    appendGraphRunLog({ caller: "fmc_script_run python", graph: file, graph_sha256: scriptPlan.graph_sha256, plan_hash: scriptPlan.plan_hash, mode: args.mode, approval: claim.approval.id, approver: claim.approval.decided_by }, ctx.env);
    const ran = await spawnCli(cli.trim(), [file]);
    return withResolved({ ok: ran.code === 0, exit_code: ran.code, stdout: ran.stdout.slice(0, 4000), stderr: ran.stderr.slice(0, 4000), diff: emptyDiff() }, doc.document);
  }
  const preview = args.mode !== "apply";
  const lease = leaseProblem(args.mode, doc.document?.title || doc.document?.path || namedDocument());
  if (lease) return withResolved({ refused: true, code: "FMC-BATCH-LOCKED", message: lease }, doc.document);
  const response = await sendWhenIdle("send_code_to_revit", {
    code: source,
    parameters: [],
    transactionMode: preview ? "read_only" : "auto",
    purpose: `library ${manifest.id}`,
    report_diff: true,
    fmc_caller: "fmc_script_run",
    mode: preview ? "preview" : "apply",
    dry_run: preview,
    script_job: args.jobId ?? "",
    snapshot_ids: snapshotIds(args.inputs),
  }, ctx) as Record<string, unknown>;
  const diff = shapeDiff(response);
  const resolved = resolvedDocumentFrom(response.resolved_document) ?? doc.document;
  return withResolved({
    id: manifest.id, runner: "csharp", mode: preview ? "preview" : "apply", dry_run: preview,
    diff, outputs: response.result ?? null,
    compile_ms: response.compileMs, run_ms: response.runMs, job: response.job,
    success: response.success !== false && !response.errorCode,
    error: response.errorMessage || response.error,
    ...batchEndFields(resolved?.title || resolved?.path || ""),
    auto_saved: false,
  }, resolved);
}

function snapshotIds(inputs: unknown): number[] {
  const ids: number[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) ids.push(value);
    else if (value && typeof value === "object") {
      const row = value as Record<string, unknown>;
      if (typeof row.id === "number") ids.push(row.id);
      for (const item of Object.values(row)) if (item !== row.id) walk(item);
    }
  };
  walk(inputs);
  return [...new Set(ids)].slice(0, INPUT_CAP);
}

function emptyDiff(): ModelDiff {
  return shapeDiff({});
}

/** The plan of a library python script run: file hash, inputs hash and document. Bound to a script_python approval. */
export function scriptPythonPlan(file: string, inputs: unknown, document: ResolvedDocument | null): {
  plan_hash: string; graph: string; graph_sha256: string; inputs_hash: string; scan_hash: string; allowlist_version: string;
  mode: string; document: { title: string; path: string; state: string }; python: boolean;
} {
  let sha = "";
  try { sha = sha256File(file); } catch { sha = ""; }
  const ih = inputsHash(inputs ?? {});
  const docRow = { title: document?.title ?? "", path: document?.path ?? "", state: "" };
  const plan_hash = sha256Text(stableJson({ v: 1, kind: "script_python", sha, ih, doc: docRow.path.toLowerCase() || docRow.title }));
  return { plan_hash, graph: file, graph_sha256: sha, inputs_hash: ih, scan_hash: "", allowlist_version: "", mode: "offline", document: docRow, python: true };
}

export function kitNow(given = "", env: NodeJS.ProcessEnv = process.env): { kit: string; cfg: GuardConfig } {
  const { config } = loadConfig();
  return { kit: kitRootFrom(config, env, given), cfg: config };
}

export async function executeQueued(job: ScriptJob, ctx: RunContext): Promise<Record<string, unknown>> {
  const { kit, cfg } = kitNow("", ctx.env);
  const context: RunContext = {
    ...ctx,
    cancelled: () => ctx.cancelled?.() === true || false,
  };
  if (job.kind === "dynamo") {
    return executeDynamo({ file: job.graph, mode: job.mode, inputs: job.inputs, jobId: job.job_id, cfg, kit, approvalId: job.approval_id }, context);
  }
  return executeScript({ id: job.script_id, mode: job.mode, inputs: job.inputs, jobId: job.job_id, cfg, kit, approvalId: job.approval_id }, context);
}

export function runnerKey(): string {
  return (revitTarget.getStore() ?? "").trim() || "default";
}

export function runnerClient(): string {
  return currentClient();
}
