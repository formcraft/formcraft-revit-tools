/**
 * The call ledger (F74, docs/AUTOMATION_BALANCE.md): one JSON line per tool call, so the balance between AI-written code
 * (send_code_to_revit) and saved automation (plugin tools, add-ons, pyRevit, Dynamo, …) can be measured.
 *
 *   %APPDATA%\Formcraft\ledger\calls-YYYY-MM.jsonl      every call to this server (MCP, the pane's CLI, flows, schedules)
 *   %APPDATA%\Formcraft\ledger\external-YYYY-MM.jsonl   runs outside the server, from the one-line hooks (resources/hooks)
 *
 * The folder is FMC_LEDGER_DIR when set (tests). A line holds the tool, its action, ok or error, the time it took, the
 * project and who started it (ai, pane, job, schedule, cli): never the model content, never the arguments, never a
 * person's name (rule 9: activity never ranks people). send_code_to_revit adds a short purpose, when the AI gives one,
 * and a hash of the code so repeats show. Writing a line never blocks or fails a call, and the ledger is never sent
 * anywhere: it stays on this PC.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formcraftHome } from "./jobs.js";

export const STARTED_BY = ["ai", "pane", "job", "schedule", "cli", "person"] as const;
export type StartedBy = (typeof STARTED_BY)[number];

/** One call to this server. */
export interface CallLine {
  at: string;
  tool: string;
  action: string;
  ok: boolean;
  ms: number;
  project: string;
  started_by: StartedBy;
  /** send_code_to_revit only: what the code is for (≤ 120 characters), when the AI says. */
  purpose?: string;
  /** send_code_to_revit only: the first 12 hex of the SHA-256 of the code, whitespace folded, so a re-send shows. */
  code_hash?: string;
  /** fmc_scripts addon_run only: the add-on's name. */
  addon?: string;
}

/** One run outside the server (pyRevit, Dynamo, Python, Grasshopper, JS, PowerShell, batch…), from a hook. */
export interface ExternalLine {
  at: string;
  kind: string;
  script: string;
  ok: boolean;
  ms: number;
  project?: string;
  started_by?: string;
}

export function ledgerDir(env: NodeJS.ProcessEnv = process.env): string {
  const own = (env.FMC_LEDGER_DIR ?? "").trim();
  return own || path.join(formcraftHome(env), "ledger");
}

export type LedgerKind = "calls" | "external";

/** calls-2026-10.jsonl: one file per month (UTC), so a file never grows past a month of calls. */
export function monthFile(dir: string, kind: LedgerKind, at: Date): string {
  return path.join(dir, `${kind}-${at.toISOString().slice(0, 7)}.jsonl`);
}

/** Who started the calls of this process: FMC_STARTED_BY when it names one, else the fallback (MCP stdio: ai; the CLI: cli). */
export function startedByFrom(env: NodeJS.ProcessEnv, fallback: StartedBy): StartedBy {
  const v = (env.FMC_STARTED_BY ?? "").trim().toLowerCase();
  return (STARTED_BY as readonly string[]).includes(v) ? (v as StartedBy) : fallback;
}

/**
 * The project a call is about, from its own arguments: project_code (or a code in `project`), else the code at the
 * front of project_folder's name (F26001_Kisasi → F26001), else the front of a document's name (KISIC-FMC-ZZ-… → KISIC). Blank when none says;
 * asking Revit for the active document would cost a round trip, and Revit may be busy.
 */
export function projectOf(args: Record<string, unknown>, document?: string): string {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const code = str(args.project_code) || (/^[A-Za-z0-9]{2,12}$/.test(str(args.project)) ? str(args.project) : "");
  if (code) return code.toUpperCase();
  const front = (p: string) => path.win32.basename(p.replace(/[\\/]+$/, "")).replace(/\.(rvt|rfa|rte|rft)$/i, "").split(/[_\-\s]/)[0].toUpperCase();
  const folder = str(args.project_folder);
  if (folder) return front(folder);
  const doc = str(document) || str(args.document);
  return doc ? front(doc) : "";
}

/** The code's fingerprint: whitespace folded, so a re-indented re-send has the same hash. */
export function codeHash(code: string): string {
  return crypto.createHash("sha256").update(code.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
}

/** A purpose as one short line: no line breaks, at most 120 characters. */
export function cleanPurpose(p: unknown): string {
  if (typeof p !== "string") return "";
  const s = p.replace(/\s+/g, " ").trim();
  return s.length > 120 ? s.slice(0, 119) + "…" : s;
}

/** The line for one call. Only the action, the project, and for send_code the purpose and hash are read from the arguments. */
export function callLine(tool: string, args: Record<string, unknown> | undefined, ok: boolean, ms: number, startedBy: StartedBy,
  at: Date, document?: string): CallLine {
  const a = args && typeof args === "object" ? args : {};
  const line: CallLine = {
    at: at.toISOString(), tool, action: typeof a.action === "string" ? a.action : "", ok, ms: Math.max(0, Math.round(ms)),
    project: projectOf(a, document), started_by: startedBy,
  };
  if (tool === "send_code_to_revit") {
    const purpose = cleanPurpose(a.purpose);
    if (purpose) line.purpose = purpose;
    if (typeof a.code === "string" && a.code) line.code_hash = codeHash(a.code);
  }
  if (tool === "fmc_scripts" && /^addon/.test(line.action) && typeof a.name === "string") line.addon = a.name.slice(0, 80);
  return line;
}

/** A tool's answer failed when it says isError (a refusal, a failed run) or it threw. */
export function resultOk(result: unknown): boolean {
  return !(result && typeof result === "object" && (result as { isError?: unknown }).isError === true);
}

/** Appends one line; never throws (logging must never block the work). */
export function appendLedger(kind: LedgerKind, line: object, env: NodeJS.ProcessEnv = process.env, at = new Date()): void {
  try {
    const dir = ledgerDir(env);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(monthFile(dir, kind, at), JSON.stringify(line) + "\n");
  } catch {
    // never block the work
  }
}

/** Runs one call and records it, whatever happens; the call's own answer or error is passed on untouched. */
export async function recorded<T>(tool: string, args: Record<string, unknown> | undefined, startedBy: StartedBy, run: () => T | Promise<T>,
  document?: string, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const t0 = Date.now();
  const started = new Date();
  try {
    const r = await run();
    safeRecord(tool, args, resultOk(r), Date.now() - t0, startedBy, started, document, env);
    return r;
  } catch (e) {
    safeRecord(tool, args, false, Date.now() - t0, startedBy, started, document, env);
    throw e;
  }
}

function safeRecord(tool: string, args: Record<string, unknown> | undefined, ok: boolean, ms: number, startedBy: StartedBy, at: Date,
  document: string | undefined, env: NodeJS.ProcessEnv) {
  try { appendLedger("calls", callLine(tool, args, ok, ms, startedBy, at, document), env, at); } catch { /* never block the work */ }
}

/** Months (YYYY-MM) from the month of `from` to the month of `to`, both included. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split("-").map(Number);
  const [ty, tm] = to.slice(0, 7).split("-").map(Number);
  if (!y || !m || !ty || !tm) return out;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
    if (out.length > 240) break;
  }
  return out;
}

/** Every line of one kind in the months from..to (bad lines skipped). Reads the whole folder when from is "". */
export function readLedger(kind: LedgerKind, from: string, to: string, env: NodeJS.ProcessEnv = process.env): any[] {
  const dir = ledgerDir(env);
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => new RegExp(`^${kind}-\\d{4}-\\d{2}\\.jsonl$`).test(f)); } catch { return []; }
  const months = from ? new Set(monthsBetween(from, to)) : null;
  const out: any[] = [];
  for (const f of files.sort()) {
    if (months && !months.has(f.slice(kind.length + 1, kind.length + 8))) continue;
    let text = "";
    try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    for (const l of text.split(/\r?\n/)) {
      if (!l.trim()) continue;
      try { const o = JSON.parse(l.replace(/^﻿/, "")); if (o && typeof o === "object") out.push(o); } catch { /* a torn line */ }
    }
  }
  return out;
}

/**
 * Wraps every tool registered as server.tool(name, description, shape, handler) so each call is recorded, in one place
 * (tools/register.ts). Install it after the Revit-target wrapper: the handler then runs inside the call's document target,
 * which names the project when no project argument does.
 */
export function withLedger(server: unknown, startedBy: StartedBy, documentOf: () => string | undefined = () => undefined) {
  const s = server as { tool: (...a: unknown[]) => unknown };
  const original = s.tool.bind(server);
  s.tool = (...a: unknown[]) => {
    if (a.length === 4 && typeof a[0] === "string" && typeof a[3] === "function") {
      const name = a[0];
      const handler = a[3] as (args: Record<string, unknown>, extra: unknown) => unknown;
      return original(a[0], a[1], a[2], (args: Record<string, unknown>, extra: unknown) =>
        recorded(name, args, startedBy, () => handler(args, extra), documentOf()));
    }
    return original(...a);
  };
}
