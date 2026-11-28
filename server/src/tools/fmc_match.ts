import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { batchLease } from "../fmc/target.js";
import { saveBlocked } from "../fmc/savepolicy.js";
import { configPath, loadConfig, type GuardConfig } from "../fmc/policy.js";
import { protectedRoots } from "../fmc/opencopy.js";
import { MATCH_MAX_TARGETS, MATCH_WHAT, applyProblems, normId, planMatch, type ElemSnap, type MatchWhat } from "../fmc/match.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_MATCH_DESCRIPTION =
  "Formcraft match (GAP-10): copy the type, instance parameters and a view's graphic overrides from one source element to target elements of the SAME category, like pyRevit Match. " +
  "Nothing is guessed: pass document (a title or full path; the active document is never used), source (element id) and targets (element ids, at most 200). " +
  "what is any of type, parameters, overrides (default type and parameters). overrides needs view (a view id) and copies that view's overrides for the source onto each target. " +
  "parameters narrows to those names; exclude_parameters leaves some out. Read-only and shared parameters are copied by their GUID, built-in ones by id; read-only, level, host, phase, workset, mark and family-and-type parameters are never copied. " +
  "dry_run defaults to true and returns a per-target diff (will_change, no_change or refused with reasons) and plan_hash. " +
  "A real change needs dry_run false, the plan_hash from the dry run, and batch_lease; the call plans again and refuses FMC-MATCH-PLAN-CHANGED when the model moved. " +
  "One transaction: any failure rolls everything back. Another user's elements, HEBERT HOSTELS, a central model, a protected path and family files are refused. The project is not saved or synced. " +
  "Example: document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, source 123456, targets [123457, 123458], what [type, parameters], dry_run true.";

const id = z.union([z.string(), z.number()]);

export const FMC_MATCH_SHAPE = {
  document: z.string().optional().default("").describe("Title or full path of the open project."),
  source: id.describe("Element id to copy from."),
  targets: z.array(id).min(1).describe(`Element ids to change, at most ${MATCH_MAX_TARGETS}.`),
  what: z.array(z.enum(MATCH_WHAT)).optional().default(["type", "parameters"]),
  view: id.optional().describe("View id. Needed when what includes overrides."),
  parameters: z.array(z.string()).optional().default([]).describe("Only these parameter names."),
  exclude_parameters: z.array(z.string()).optional().default([]).describe("Leave these parameter names out."),
  dry_run: z.boolean().optional().default(true),
  plan_hash: z.string().optional().default("").describe("From the dry run. Required to apply."),
  batch_lease: z.string().optional().default(""),
};

export type FmcMatchArgs = z.infer<z.ZodObject<typeof FMC_MATCH_SHAPE>>;

export interface MatchIo {
  read?: (body: Record<string, unknown>) => Promise<unknown>;
  apply?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  reportDir?: string;
}

function stamp(extra: Record<string, unknown> = {}) {
  return { tool: "fmc_match", saved: false, synced: false, images: [] as [], ...extra };
}

function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-MATCH";
  return reply(stamp({ refused: true, code, message }), true);
}

function guardReason(doc: { title: string; path: string }, central: boolean | undefined, io: MatchIo): string | null {
  const env = io.env ?? process.env;
  const loaded = io.guard ? { config: io.guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
  const blob = `${doc.title} ${doc.path}`;
  if (/hebert hostels/i.test(blob)) return "HEBERT HOSTELS is not written by fmc_match.";
  if (/[\\/]centrals[\\/]/i.test(doc.path)) return "A file under a Centrals folder is not written by fmc_match.";
  if (central) return "A central model is not written by fmc_match.";
  const blocked = saveBlocked({ title: doc.title, path: doc.path }, loaded.config);
  if (blocked) return blocked;
  return loaded.problem ?? null;
}

function reportDirOf(io: MatchIo): string {
  const env = io.env ?? process.env;
  if (io.reportDir) return io.reportDir;
  if ((env.FMC_MATCH_DIR ?? "").trim()) return env.FMC_MATCH_DIR!.trim();
  return path.join(env.LOCALAPPDATA || os.tmpdir(), "Formcraft", "match");
}

function writeReport(io: MatchIo, name: string, body: unknown): string {
  const dir = reportDirOf(io);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `match-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

export async function runFmcMatch(args: FmcMatchArgs, io: MatchIo = {}) {
  try {
    if (!args.document.trim()) return reply(stamp({ refused: true, code: "FMC-DOC-REQUIRED", message: "[FMC-DOC-REQUIRED] fmc_match needs document: a title or a full path. Refusing to use the active document." }), true);
    const source = normId(args.source);
    const targets = args.targets.map(normId);
    if (!source) return reply(stamp({ refused: true, code: "FMC-MATCH-SOURCE", message: "[FMC-MATCH-SOURCE] source must be an element id (digits)." }), true);
    if (targets.some((t) => !t)) return reply(stamp({ refused: true, code: "FMC-MATCH-TARGETS", message: "[FMC-MATCH-TARGETS] every target must be an element id (digits)." }), true);
    if (targets.length > MATCH_MAX_TARGETS) return reply(stamp({ refused: true, code: "FMC-MATCH-CAP", message: `[FMC-MATCH-CAP] At most ${MATCH_MAX_TARGETS} targets per call.` }), true);
    const what = args.what as MatchWhat[];
    const view = args.view === undefined ? "" : normId(args.view);
    if (what.includes("overrides") && !view) return reply(stamp({ refused: true, code: "FMC-MATCH-VIEW", message: "[FMC-MATCH-VIEW] overrides needs view: a view id." }), true);
    const readBody = { document: args.document, source, targets, what, view, parameters: args.parameters, exclude_parameters: args.exclude_parameters };
    const snap = (io.read ? await io.read(readBody) : await withRevitConnection((client) => client.sendCommand("fmc_match", readBody, 180000))) as Record<string, unknown>;
    if (snap.refused || (typeof snap.code === "string" && snap.code)) {
      return reply(stamp({ refused: true, code: snap.code || "FMC-MATCH", message: snap.message || "The read was refused." }), true);
    }
    const resolved = (snap.resolved_document ?? {}) as { title?: string; path?: string };
    const doc = { title: String(resolved.title || args.document), path: String(resolved.path || "") };
    const reason = guardReason(doc, snap.is_central === true, io);
    if (reason) return reply(stamp({ refused: true, code: "FMC-MATCH-GUARD", dry_run: true, document: doc.title, message: reason }), true);
    const plan = planMatch({
      source: (snap.source ?? null) as ElemSnap | null,
      targets: (Array.isArray(snap.targets) ? snap.targets : []) as ElemSnap[],
      what, view, parameters: args.parameters, exclude_parameters: args.exclude_parameters,
    });
    if (!plan.ok) return reply(stamp({ refused: true, code: plan.code, message: plan.message }), true);
    const body = stamp({
      document: doc.title, resolved_document: doc, source, what, view,
      view_note: snap.view_note ?? "",
      totals: plan.totals, targets: plan.targets, plan_hash: plan.plan_hash,
      dry_run: args.dry_run !== false,
    });
    if (args.dry_run !== false) {
      const report = writeReport(io, "dry", { ...body, steps: plan.steps });
      return reply({ ...body, read_only: true, report, next: "Show this diff. Apply with dry_run false, this plan_hash and batch_lease." });
    }
    if (!(args.batch_lease.trim() || (batchLease.getStore() ?? ""))) {
      return reply(stamp({ refused: true, code: "FMC-BATCH-LOCKED", dry_run: true, message: "[FMC-BATCH-LOCKED] This write needs batch_lease from fmc_batch request. Nothing was changed." }), true);
    }
    const problems = applyProblems(plan, args.plan_hash);
    if (problems.length) return reply(stamp({ refused: true, code: problems[0].match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-MATCH", message: problems.join(" "), plan_hash: plan.plan_hash }), true);
    const env = io.env ?? process.env;
    const loaded = io.guard ? { config: io.guard } : loadConfig(configPath(env));
    const roots = [...(loaded.config.protected_paths ?? []), ...protectedRoots(loaded.config)];
    const applyBody = { document: args.document, source, view, steps: plan.steps, plan_hash: plan.plan_hash, protected_roots: roots, _protected_roots: roots };
    const applied = (io.apply ? await io.apply(applyBody) : await withRevitConnection((client) => client.sendCommand("fmc_match_apply", applyBody, 300000))) as Record<string, unknown>;
    const report = writeReport(io, "apply", { ...body, applied });
    return reply({ ...body, read_only: false, dry_run: false, applied, report, saved: false, synced: false });
  } catch (error) {
    return failed(error);
  }
}

export function registerFmcMatchTool(server: McpServer) {
  server.tool("fmc_match", FMC_MATCH_DESCRIPTION, FMC_MATCH_SHAPE, async (args) => runFmcMatch(args as FmcMatchArgs));
}
