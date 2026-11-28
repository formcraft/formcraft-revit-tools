/**
 * Read-only view of dialog tier 1. The add-in answers prompts; this module only reads the guard and the log.
 * The same hard deny is in commandset/Bridge/DialogPolicy.cs. Corrupt-model, sync, relinquish, delete and overwrite
 * stay for a person even when allow lists them.
 */
import fs from "node:fs";
import { jobFiles, readJsonLines } from "./jobs.js";
import { NEVER_AUTO_FRAGMENTS, RULES_FILE, readOpenDialog, rulesPath } from "./dialogrules.js";
import type { GuardConfig } from "./policy.js";

/** Bumped when the fmc_dialogs reply changes shape. 2: now, log_file, lines_read, age_minutes, ignored_inputs, open_now. */
export const DIALOGS_SCHEMA_VERSION = 2;

/** Same window as dialogrules.blockingDialog: an open-file stamp older than this is not treated as still waiting. */
export const OPEN_DIALOG_FRESH_MS = 10 * 60 * 1000;

/** Never answered, even when dialogs.allow contains the words. Kept in step with DialogPolicy.HardDeny. */
export const DIALOG_HARD_DENY = [
  "delete", "unjoin", "overwrite", "relinquish", "sync",
  "save as", "save-as", "saveas",
  "upgrade", "license", "sign-in", "sign in", "signin",
  "corrupt",
];

/** Used when fmc_guard.json omits dialogs.allow. */
export const DIALOG_DEFAULT_ALLOW = [
  "not saved recently",
  "duplicate types",
  "following types already exist",
  "dialog_revit_pastesimilarsymbolspaste",
  "duplicate mark",
];

export interface DialogLists {
  allow?: string[];
  deny?: string[];
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export function dialogLists(cfg: { dialogs?: DialogLists } | null | undefined): {
  allow: string[];
  deny: string[];
  allow_source: "guard" | "default";
  hard_deny: string[];
} {
  const allow = names(cfg?.dialogs?.allow);
  const deny = names(cfg?.dialogs?.deny);
  const custom = Array.isArray(cfg?.dialogs?.allow);
  return {
    allow: custom ? allow : [...DIALOG_DEFAULT_ALLOW],
    deny,
    allow_source: custom ? "guard" : "default",
    hard_deny: [...DIALOG_HARD_DENY],
  };
}

function blob(id: string, text: string): string {
  return `${id} ${text}`.toLowerCase();
}

function hits(text: string, list: string[]): boolean {
  return list.some((item) => item.trim().length > 0 && text.includes(item.trim().toLowerCase()));
}

/** True when this prompt must stay up for a person. */
export function dialogBlocked(id: string, text: string, deny: string[] = []): boolean {
  const all = blob(id, text);
  return hits(all, DIALOG_HARD_DENY) || hits(all, deny);
}

export interface DialogLogLine {
  at?: string;
  event?: string;
  dialog_id?: string;
  message?: string;
  answer?: string;
  job?: string;
}

/** Optional filters on the recent lines. All are applied before `limit`. */
export interface DialogFilter {
  /** ISO time: only lines at or after it. A line whose `at` does not parse is left out when this is set. */
  since?: string;
  /** Only lines of this job id (exact match). */
  job?: string;
  /** Only lines whose answer does not start with "answered:". */
  only_left_for_person?: boolean;
}

function leftForAPerson(answer: unknown): boolean {
  return !/^answered:/i.test(String(answer ?? ""));
}

/** Throws on a `since` that is not a time, so a typo does not silently return everything. */
export function sinceMs(since: string | undefined): number | undefined {
  if (since === undefined || since.trim() === "") return undefined;
  const ms = Date.parse(since);
  if (Number.isNaN(ms)) throw new Error(`[FMC-DIALOGS-SINCE] since must be an ISO time such as 2026-11-28T06:00:00Z; got ${JSON.stringify(since)}.`);
  return ms;
}

function matches(line: DialogLogLine, filter: DialogFilter, since: number | undefined): boolean {
  if (filter.job !== undefined && filter.job !== "" && String(line.job ?? "") !== filter.job) return false;
  if (filter.only_left_for_person && !leftForAPerson(line.answer)) return false;
  if (since !== undefined) {
    const at = Date.parse(String(line.at ?? ""));
    if (Number.isNaN(at) || at < since) return false;
  }
  return true;
}

/** Recent dialog and failure lines. A line with no "answered:" prefix was left for a person. */
export function recentDialogs(lines: DialogLogLine[], limit = 30, filter: DialogFilter = {}, nowMs?: number): Array<Record<string, unknown>> {
  const since = sinceMs(filter.since);
  const rows = lines.filter((line) => line && (line.event === "dialog" || line.event === "failure") && matches(line, filter, since));
  const atNow = nowMs ?? Date.now();
  return rows.slice(-Math.max(1, limit)).map((line) => {
    const answer = String(line.answer ?? "");
    return {
      at: line.at ?? "",
      job: line.job ?? "",
      event: line.event ?? "",
      dialog_id: line.dialog_id ?? "",
      message: line.message ?? "",
      answer,
      left_for_a_person: leftForAPerson(answer),
      age_minutes: ageMinutes(line.at, atNow),
    };
  });
}

/** Minutes from a log stamp to `now`. null when the stamp is not a time (do not invent an age). */
export function ageMinutes(at: string | undefined, nowMs: number): number | null {
  const ms = Date.parse(String(at ?? ""));
  if (Number.isNaN(ms)) return null;
  return Math.round((nowMs - ms) / 6000) / 10;
}

/** Inputs this tool accepts but does not use. Empty values are omitted. */
export function ignoredInputs(args: { document?: string } | undefined): Record<string, unknown> {
  const document = typeof args?.document === "string" ? args.document.trim() : "";
  return document ? { document } : {};
}

export interface OpenNow {
  open_now: boolean | null;
  open_now_source: "add-in" | "none";
  open_now_note: string;
  open?: { dialog_id: string; message: string; job: string; at: string; age_minutes: number | null; pid: number };
}

/**
 * Whether a dialog is still on screen (P-fmc_dialogs-02). Only the add-in's fmc_dialog_open.json can say;
 * a job-log line with left_for_a_person is not enough. Stale or missing file: open_now is null, never a guess.
 */
export function openNowOf(env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): OpenNow {
  const live = readOpenDialog(env);
  if (!live) {
    return {
      open_now: null,
      open_now_source: "none",
      open_now_note:
        "The add-in writes fmc_dialog_open.json while a dialog is up. That file is not here, so this reply cannot say whether a dialog is still on screen. " +
        "A recent line with left_for_a_person only means it was left for a person at that time, not that it is still waiting. fmc_dialog_rules list reads the same file.",
    };
  }
  const age = ageMinutes(live.at, nowMs);
  const stale = age == null || age * 60_000 > OPEN_DIALOG_FRESH_MS;
  const open = { dialog_id: live.dialog_id, message: live.message, job: live.job, at: live.at, age_minutes: age, pid: live.pid };
  if (live.open && !stale) {
    return { open_now: true, open_now_source: "add-in", open_now_note: "The add-in reports a dialog is up (fmc_dialog_open.json, less than 10 minutes old).", open };
  }
  if (live.open && stale) {
    return {
      open_now: null, open_now_source: "add-in", open,
      open_now_note: `The add-in file still says a dialog is open, but its stamp is ${age ?? "unknown"} minutes old (freshness is 10 minutes), so this reply does not treat it as still waiting.`,
    };
  }
  if (stale) {
    return {
      open_now: null, open_now_source: "add-in",
      open_now_note: `The add-in file says no dialog is up, but its stamp is ${age ?? "unknown"} minutes old (freshness is 10 minutes), so this reply cannot confirm that.`,
    };
  }
  return { open_now: false, open_now_source: "add-in", open_now_note: "The add-in reports no dialog is up (fmc_dialog_open.json, less than 10 minutes old)." };
}

export function readRecentDialogs(env: NodeJS.ProcessEnv = process.env, limit = 30, filter: DialogFilter = {}, nowMs?: number): Array<Record<string, unknown>> {
  const lines = readJsonLines(jobFiles(env).revit, 800) as DialogLogLine[];
  return recentDialogs(lines, limit, filter, nowMs);
}

export function dialogLogMeta(env: NodeJS.ProcessEnv = process.env, limit = 30, filter: DialogFilter = {}, nowMs?: number) {
  const log_file = jobFiles(env).revit;
  const lines = readJsonLines(log_file, 800) as DialogLogLine[];
  const recent = recentDialogs(lines, limit, filter, nowMs);
  const ages = recent.map((row) => row.age_minutes).filter((n): n is number => typeof n === "number");
  return { log_file, lines_read: lines.length, recent, newest_age_minutes: ages.length ? ages[ages.length - 1] : null };
}

/** Counts over the returned rows, so a caller does not have to tally them. */
export function dialogRowCounts(rows: Array<Record<string, unknown>>): { dialog: number; failure: number; left_for_a_person: number } {
  return {
    dialog: rows.filter((r) => r.event === "dialog").length,
    failure: rows.filter((r) => r.event === "failure").length,
    left_for_a_person: rows.filter((r) => r.left_for_a_person === true).length,
  };
}

/**
 * The two "never answered automatically" lists side by side: this tool's hard deny (guard tier 1, also in
 * DialogPolicy.cs) and the dialog rules engine's never-auto fragments (dialogrules.ts). Report only: neither list
 * is changed here, so what the add-in does is unchanged.
 */
export function hardDenyComparison(): { hard_deny_only: string[]; rules_never_auto_only: string[] } {
  const a = new Set(DIALOG_HARD_DENY.map((s) => s.toLowerCase()));
  const b = new Set(NEVER_AUTO_FRAGMENTS.map((s) => s.toLowerCase()));
  return {
    hard_deny_only: [...a].filter((s) => !b.has(s)),
    rules_never_auto_only: [...b].filter((s) => !a.has(s)),
  };
}

/** Whether the dialog rules file (read by fmc_dialog_rules and the add-in) is there. Never read or written here. */
export function rulesFileStatus(env: NodeJS.ProcessEnv = process.env): { file: string; path: string; exists: boolean; read_by: string } {
  let p = "";
  try { p = rulesPath(env); } catch { /* no APPDATA */ }
  let exists = false;
  try { exists = p !== "" && fs.existsSync(p); } catch { /* unreadable: report false */ }
  return { file: RULES_FILE, path: p, exists, read_by: "fmc_dialog_rules list" };
}

export function dialogStatus(
  cfg: GuardConfig | { dialogs?: DialogLists },
  env: NodeJS.ProcessEnv = process.env,
  limit = 30,
  filter: DialogFilter = {},
  opts: { now?: number; ignored_inputs?: Record<string, unknown> } = {},
) {
  const lists = dialogLists(cfg);
  const nowMs = opts.now ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const log = dialogLogMeta(env, limit, filter, nowMs);
  const applied = Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined && v !== "" && v !== false));
  return {
    schema_version: DIALOGS_SCHEMA_VERSION,
    read_only: true,
    changes_model: false,
    now,
    scope: "machine-wide: the job log and the add-in open file, not a named document",
    log_file: log.log_file,
    lines_read: log.lines_read,
    newest_age_minutes: log.newest_age_minutes,
    ignored_inputs: opts.ignored_inputs ?? {},
    ...openNowOf(env, nowMs),
    ...lists,
    never_answered: ["corrupt-model", "sync", "relinquish", "delete", "overwrite"],
    lists_cover:
      "allow and deny here are fmc_guard.json dialogs.allow/deny (tier 1: guard prompts and failure warnings). " +
      "Dialog boxes are also answered from the rules file (fmc_dialog_rules); read both.",
    rules_file: rulesFileStatus(env),
    never_auto_lists: hardDenyComparison(),
    filter: applied,
    counts: dialogRowCounts(log.recent),
    recent: log.recent,
  };
}
