/**
 * Read-only view of dialog tier 1. The add-in answers prompts; this module only reads the guard and the log.
 * The same hard deny is in commandset/Bridge/DialogPolicy.cs. Corrupt-model, sync, relinquish, delete and overwrite
 * stay for a person even when allow lists them.
 */
import { readJsonLines, jobFiles } from "./jobs.js";
import type { GuardConfig } from "./policy.js";

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

/** Recent dialog and failure lines. A line with no "answered:" prefix was left for a person. */
export function recentDialogs(lines: DialogLogLine[], limit = 30): Array<Record<string, unknown>> {
  const rows = lines.filter((line) => line && (line.event === "dialog" || line.event === "failure"));
  return rows.slice(-Math.max(1, limit)).map((line) => {
    const answer = String(line.answer ?? "");
    return {
      at: line.at ?? "",
      job: line.job ?? "",
      event: line.event ?? "",
      dialog_id: line.dialog_id ?? "",
      message: line.message ?? "",
      answer,
      left_for_a_person: !/^answered:/i.test(answer),
    };
  });
}

export function readRecentDialogs(env: NodeJS.ProcessEnv = process.env, limit = 30): Array<Record<string, unknown>> {
  const lines = readJsonLines(jobFiles(env).revit, 800) as DialogLogLine[];
  return recentDialogs(lines, limit);
}

export function dialogStatus(cfg: GuardConfig | { dialogs?: DialogLists }, env: NodeJS.ProcessEnv = process.env, limit = 30) {
  const lists = dialogLists(cfg);
  return {
    read_only: true,
    changes_model: false,
    ...lists,
    never_answered: ["corrupt-model", "sync", "relinquish", "delete", "overwrite"],
    recent: readRecentDialogs(env, limit),
  };
}
