/**
 * Read-only view of dialog tier 1. The add-in answers prompts; this module only reads the guard and the log.
 * The same hard deny is in commandset/Bridge/DialogPolicy.cs. Corrupt-model, sync, relinquish, delete and overwrite
 * stay for a person even when allow lists them.
 */
import fs from "node:fs";
import { readJsonLines, jobFiles } from "./jobs.js";
import { NEVER_AUTO_FRAGMENTS, RULES_FILE, rulesPath } from "./dialogrules.js";
import type { GuardConfig } from "./policy.js";

/** Bumped when the fmc_dialogs reply changes shape. 1: filters, counts, rules file status, list comparison. */
export const DIALOGS_SCHEMA_VERSION = 1;

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
export function recentDialogs(lines: DialogLogLine[], limit = 30, filter: DialogFilter = {}): Array<Record<string, unknown>> {
  const since = sinceMs(filter.since);
  const rows = lines.filter((line) => line && (line.event === "dialog" || line.event === "failure") && matches(line, filter, since));
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
    };
  });
}

export function readRecentDialogs(env: NodeJS.ProcessEnv = process.env, limit = 30, filter: DialogFilter = {}): Array<Record<string, unknown>> {
  const lines = readJsonLines(jobFiles(env).revit, 800) as DialogLogLine[];
  return recentDialogs(lines, limit, filter);
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

export function dialogStatus(cfg: GuardConfig | { dialogs?: DialogLists }, env: NodeJS.ProcessEnv = process.env, limit = 30, filter: DialogFilter = {}) {
  const lists = dialogLists(cfg);
  const recent = readRecentDialogs(env, limit, filter);
  const applied = Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined && v !== "" && v !== false));
  return {
    schema_version: DIALOGS_SCHEMA_VERSION,
    read_only: true,
    changes_model: false,
    ...lists,
    never_answered: ["corrupt-model", "sync", "relinquish", "delete", "overwrite"],
    lists_cover:
      "allow and deny here are fmc_guard.json dialogs.allow/deny (tier 1: guard prompts and failure warnings). " +
      "Dialog boxes are also answered from the rules file (fmc_dialog_rules); read both.",
    rules_file: rulesFileStatus(env),
    never_auto_lists: hardDenyComparison(),
    filter: applied,
    counts: dialogRowCounts(recent),
    recent,
  };
}
