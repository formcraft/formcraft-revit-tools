/**
 * Family editor tools (fmc_fam_param, fmc_fam_type, fmc_fam_ref; Plugin Bot 28 Nov, from Emlyn's call at 13:35 EAT).
 * Each tool is a thin wrapper: it turns its action into fmc_doc ops (ops.ts) and runs them through fmc_doc apply.
 *
 * Deletes need a person (param_remove, type_delete, plane_delete):
 *  1. a dry run (the default) is the real run rolled back, so its plan is what Revit would do, including what goes with
 *     the deleted item (dimensions, labels, formulas); it answers a confirm token bound to the session and the exact ops;
 *  2. apply (dry_run false) with that token never runs the delete itself: it puts the batch in the pane's approval queue
 *     (%APPDATA%\Formcraft\ai_queue, the AI-assisted modeller's queue). A person approves it in the pane (Approvals),
 *     and approving runs it. Approving is pane-only (fmc/cli.ts ai_approve); no MCP tool can approve, and testing-mode
 *     auto_approve doesn't apply, because this queue item never goes through the AI gate;
 *  3. the add-in refuses a real run of a delete op unless the queue holds a person's approval for exactly that batch and
 *     token (FmcFamEdit.cs), so neither fmc_doc apply nor a replay can delete on an AI's say-so.
 * No file is deleted: the ops change a family document open in an fmc_doc session; saving stays fmc_doc save.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FAM_DELETE_OPS, Op, planeKey } from "./ops.js";

const win = path.win32;

/** Proposals expire after this long: the person approves what was planned today, not last week. */
export const TOKEN_HOURS = 24;
/** The add-in command a person's approval runs. */
export const DELETE_COMMAND = "fmc_doc_apply";

export const deleteOpsIn = <T extends { op: string }>(ops: T[]): T[] => ops.filter((o) => FAM_DELETE_OPS.has(o.op));

/** A stable text for ops (keys sorted), so the token doesn't change with key order. */
export function stableJson(v: unknown): string {
  const s = (x: unknown): unknown => Array.isArray(x) ? x.map(s)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x as object).filter(([, y]) => y !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, y]) => [k, s(y)]))
    : x;
  return JSON.stringify(s(v));
}

/** The confirm token: the session and the exact ops, hashed. A changed batch gets a different token. */
export function confirmToken(session: string, ops: unknown[]): string {
  return crypto.createHash("sha256").update(session.trim() + "|" + stableJson(ops)).digest("hex").slice(0, 16);
}

export interface DeleteProposal {
  token: string; session: string; document: string; created: string; ops: unknown[];
  /** What the dry run said for each delete op (Revit's own words: what goes with it). */
  plan: Array<{ op: string; name: string; result: string; detail: string }>;
}

export const proposalsDir = (reportsDir: string) => win.join(reportsDir, "FamEdit");
const proposalFile = (reportsDir: string, token: string) => win.join(proposalsDir(reportsDir), token.replace(/[^0-9a-f]/gi, "") + ".json");

/** Plain lines a person reads in the pane before approving. */
export function deleteLines(ops: Array<Record<string, unknown> & { op: string }>, plan: DeleteProposal["plan"] = []): string[] {
  return deleteOpsIn(ops).map((o) => {
    const what = o.op === "param_remove" ? `Remove family parameter "${o.name}"`
      : o.op === "type_delete" ? `Delete family type "${o.name}"`
      : `Delete reference plane ${planeKey(o as { name?: string; id?: number })}`;
    const p = plan.find((x) => x.op === o.op && (x.name === o.name || x.name === planeKey(o as { name?: string; id?: number })));
    return p?.detail ? `${what}: ${p.detail}` : what;
  });
}

export function saveProposal(reportsDir: string, p: DeleteProposal, write: (f: string, t: string) => void = (f, t) => { fs.mkdirSync(win.dirname(f), { recursive: true }); fs.writeFileSync(f, t); }) {
  write(proposalFile(reportsDir, p.token), JSON.stringify(p, null, 2));
}

export function readProposal(reportsDir: string, token: string, read: (f: string) => string | null = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } }): DeleteProposal | null {
  const t = read(proposalFile(reportsDir, token));
  try { return t ? JSON.parse(t) as DeleteProposal : null; } catch { return null; }
}

/** Why a real run of a delete batch can't go to the person yet (empty: it can be queued). */
export function confirmProblems(p: DeleteProposal | null, token: string, session: string, ops: unknown[], now: Date): string[] {
  const t = token.trim();
  if (!t) return ["A delete needs a person: run it as a dry run first (dry_run true, the default); it answers a confirm_token for the plan"];
  if (!p) return [`No plan for confirm_token ${t}: run the dry run again`];
  const r: string[] = [];
  if (p.session !== session.trim()) r.push(`confirm_token ${t} is for session ${p.session}, not ${session.trim()}`);
  if (confirmToken(session, ops) !== t) r.push(`confirm_token ${t} is for other ops: the batch changed since the dry run, so run the dry run again`);
  const age = (now.getTime() - Date.parse(p.created)) / 3600000;
  if (!(age >= 0 && age <= TOKEN_HOURS)) r.push(`confirm_token ${t} is older than ${TOKEN_HOURS} h: run the dry run again`);
  return r;
}

// ---- the tools' op builders (pure, tested) --------------------------------------------------------------------------

export type Built = { ops: Op[] } | { refused: string[] };
const need = (v: unknown, what: string, out: string[]) => { if (v === undefined || v === null || (typeof v === "string" && !v.trim())) out.push(`give ${what}`); };

export interface ParamArgs { action: string; name?: string; new_name?: string; group?: string; on?: boolean; formula?: string | null }
export function paramOps(a: ParamArgs): Built {
  const r: string[] = [];
  need(a.name, "name (the family parameter)", r);
  switch (a.action) {
    case "rename": need(a.new_name, "new_name", r); return r.length ? { refused: r } : { ops: [{ op: "param_rename", name: a.name!, new_name: a.new_name! } as Op] };
    case "regroup": need(a.group, "group", r); return r.length ? { refused: r } : { ops: [{ op: "param_regroup", name: a.name!, group: a.group } as Op] };
    case "reporting": if (typeof a.on !== "boolean") r.push("give on: true (reporting) or false (driving)"); return r.length ? { refused: r } : { ops: [{ op: "param_set_reporting", name: a.name!, on: a.on! } as Op] };
    case "formula": if (a.formula === undefined) r.push("give formula (or null to clear it)"); return r.length ? { refused: r } : { ops: [{ op: "param_set_formula", name: a.name!, formula: a.formula ?? null } as Op] };
    case "remove": return r.length ? { refused: r } : { ops: [{ op: "param_remove", name: a.name! } as Op] };
    default: return { refused: [`unknown action ${a.action}`] };
  }
}

export interface TypeArgs { action: string; name?: string; new_name?: string; params?: string[]; ranges?: Record<string, { low: number; high: number; steps?: number }>; types?: string[] }
export function typeOps(a: TypeArgs): Built {
  const r: string[] = [];
  switch (a.action) {
    case "rename": need(a.name, "name (the type)", r); need(a.new_name, "new_name", r); return r.length ? { refused: r } : { ops: [{ op: "type_rename", name: a.name!, new_name: a.new_name! } as Op] };
    case "delete": need(a.name, "name (the type)", r); return r.length ? { refused: r } : { ops: [{ op: "type_delete", name: a.name! } as Op] };
    case "flex_matrix":
      if (!a.params?.length) r.push("give params (the parameters to flex)");
      if (!a.ranges || !Object.keys(a.ranges).length) r.push("give ranges: { \"<param>\": { low, high, steps? } }");
      if (r.length) return { refused: r };
      return { ops: [{ op: "type_flex_matrix", name: "flex matrix", params: a.params!,
        ranges: Object.fromEntries(Object.entries(a.ranges!).map(([k, v]) => [k, { low: v.low, high: v.high, steps: v.steps ?? 3 }])),
        ...(a.types?.length ? { types: a.types } : {}) } as Op] };
    default: return { refused: [`unknown action ${a.action}`] };
  }
}

export interface RefArgs { action: string; name?: string; id?: number; new_name?: string; offset_mm?: number }
export function refOps(a: RefArgs): Built {
  const r: string[] = [];
  const who = { name: (a.name ?? "").trim(), ...(a.id !== undefined ? { id: a.id } : {}) };
  if (!who.name && a.id === undefined) r.push("give name or id (the reference plane)");
  switch (a.action) {
    case "rename": need(a.new_name, "new_name", r); return r.length ? { refused: r } : { ops: [{ op: "plane_rename", ...who, new_name: a.new_name! } as Op] };
    case "move": if (typeof a.offset_mm !== "number") r.push("give offset_mm (along the plane's normal)"); return r.length ? { refused: r } : { ops: [{ op: "plane_move", ...who, offset_mm: a.offset_mm! } as Op] };
    case "delete": return r.length ? { refused: r } : { ops: [{ op: "plane_delete", ...who } as Op] };
    default: return { refused: [`unknown action ${a.action}`] };
  }
}

/** The flex matrix as a person reads it: per type, each parameter's failing values. */
export function matrixSummary(m: { types?: Array<{ type: string; runs?: Array<{ param: string; value: number; ok: boolean; errors?: string[] }> }> }): { ok: boolean; failing: string[] } {
  const failing: string[] = [];
  for (const t of m.types ?? []) for (const run of t.runs ?? []) if (!run.ok) failing.push(`${t.type}: ${run.param} = ${run.value}${run.errors?.length ? ` (${run.errors[0]})` : ""}`);
  return { ok: failing.length === 0, failing };
}
