/**
 * Shared plumbing for the family editor tools (fmc_fam_nested, fmc_fam_hosting, fmc_fam_connector; Plugin Bot's family
 * editor proposal, canvas 11ee5a5f). Family documents only: every call names an open family document (an fmc_doc
 * session's document or a family open in Revit), and the add-in refuses a project. Every reply has a run id (also in the
 * file log). Reads go through the read path; the dry run of a change is the real change rolled back (read path, one
 * transaction); the real change needs dry_run=false with confirm=true and goes through the write path (live-model lock).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "./policy.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";

export type RevitSend = (command: string, payload: object, dry: boolean, ms: number) => Promise<unknown>;
export interface FamEditIo { config?: { config: GuardConfig; problem: string }; revit?: RevitSend; exists?: (file: string) => boolean }
export type Reply = { content: Array<{ type: "text"; text: string }>; isError: boolean };

/** FE-<yyyyMMddTHHmmss>-<6 hex>: one per call. */
export function newRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `FE-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${crypto.randomBytes(3).toString("hex")}`;
}

/** One row in <reports_dir>\FMC_MCP_FileLog.csv; logging never blocks the work. */
export function famLog(cfg: GuardConfig, dry: boolean, target: string, result: string, detail: string, action: string, runId: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dry, target, result, `run ${runId}: ${detail}`]));
  } catch { /* logging never blocks the work */ }
}

/** The default Revit route: the read path for reads and dry runs, the write path (live-model lock) for real changes. */
export const defaultSend: RevitSend = (command, payload, dry, ms) =>
  withRevitConnection((c) => dry ? c.sendRaw(command, payload, ms) : c.sendCommand(command, payload, ms));

export interface FamCtx {
  tool: string;
  config: GuardConfig;
  problem: string;
  dry: boolean;
  confirm: boolean;
  document: string;
  run_id: string;
  send: RevitSend;
  exists: (file: string) => boolean;
  reply: (body: object, isError?: boolean) => Reply;
}

export function makeCtx(tool: string, args: { document?: string; dry_run?: boolean; confirm?: boolean }, io: FamEditIo): FamCtx {
  const { config, problem } = io.config ?? loadConfig();
  const run_id = newRunId();
  const document = String(args.document ?? "").trim();
  const reply = (body: object, isError = false): Reply =>
    ({ content: [{ type: "text" as const, text: JSON.stringify({ run_id, tool, document, ...body }, null, 2) }], isError });
  return { tool, config, problem: problem ?? "", dry: args.dry_run !== false, confirm: args.confirm === true, document, run_id,
    send: io.revit ?? defaultSend, exists: io.exists ?? ((f) => fs.existsSync(f)), reply };
}

/** Reasons a call can't reach Revit at all, and reasons a real change is refused before the add-in is called. */
export function gateProblems(ctx: FamCtx, change: boolean, what: string): string[] {
  const reasons: string[] = [];
  if (!ctx.document) reasons.push("Name the family document: document is the title or path of an open family (an fmc_doc session's document or a family open in Revit). Projects are refused");
  else if (/\.(rvt|rte)$/i.test(ctx.document)) reasons.push(`${ctx.document} is a project file; the family editor tools work on family documents only`);
  if (change && !ctx.dry) {
    if (ctx.problem) reasons.push(ctx.problem);
    if (!ctx.confirm) reasons.push(`dry_run=false ${what}: show the person the dry run first, then call again with confirm=true`);
  }
  return reasons;
}

/** The add-in's read for a tool: <tool>_read through the read path. */
export async function readFamily<T>(ctx: FamCtx, command: string, extra: object = {}): Promise<T> {
  return await ctx.send(command, { document: ctx.document, ...extra }, true, 120000) as T;
}

export interface ApplyResult { dry_run?: boolean; rolled_back?: boolean; failed?: boolean; results?: Array<{ error?: string } & Record<string, unknown>>; warnings?: string[]; errors?: string[] }

/** Sends <tool>_apply: one transaction in the add-in; the dry run (and any failed step) rolls it back. */
export async function applyFamily(ctx: FamCtx, command: string, payload: object, summary: string, action: string): Promise<{ result: ApplyResult; outcome: string }> {
  const result = await ctx.send(command, { document: ctx.document, ...payload, dry_run: ctx.dry, run_id: ctx.run_id }, ctx.dry, 300000) as ApplyResult;
  const outcome = ctx.dry ? "dry run" : (result?.failed || result?.rolled_back ? "rolled back" : "done");
  famLog(ctx.config, ctx.dry, ctx.document, outcome, summary, action, ctx.run_id);
  return { result, outcome };
}

export function nextStep(ctx: FamCtx, outcome: string): string {
  if (ctx.dry) return "Show the person the dry run (the real change rolled back); then dry_run=false with confirm=true makes it in one Undo";
  if (outcome === "rolled back") return "A step failed, so nothing was kept (one transaction); fix the step and run the dry run again";
  return "Done in one transaction (one Undo). The family isn't saved: save it with fmc_doc save (staging only) when the person is happy";
}

export function errorText(e: unknown): string { return e instanceof Error ? e.message : String(e); }
