/**
 * Dialog rules for unattended Revit. The add-in answers from %APPDATA%\Formcraft\fmc_dialog_rules.json.
 * This module is the server side of the same rules: it does not read or write the guard file, and it does not
 * send a command to Revit (a modal dialog would not run one). An older add-in simply never writes the open-dialog
 * file; the job log is the fallback.
 *
 * Button ids, from Revit journals and the task-dialog catalogue (Revit 2022–2027):
 * - TaskDialog_Project_Not_Saved_Recently: 1001 Save the project, 1002 Save and set the reminder interval,
 *   1003 Do not save the project. Cancel (2) and Close (8) also do not save.
 * - TaskDialog_Changes_Not_Synchronized_With_Central: 1001 and 1002 synchronize, 1003 Do not synchronize.
 *   Close (8) and Cancel (2) also do not synchronize. This is the periodic reminder, not Changes_Not_Saved on close.
 */
import fs from "node:fs";
import path from "node:path";
import { dialogBusyReason } from "./busyreason.js";
import { formcraftHome, readJsonLines, jobFiles } from "./jobs.js";

export const SAVE_REMINDER_ID = "TaskDialog_Project_Not_Saved_Recently";
export const SYNC_REMINDER_ID = "TaskDialog_Changes_Not_Synchronized_With_Central";
export const RULES_FILE = "fmc_dialog_rules.json";
export const OPEN_FILE = "fmc_dialog_open.json";
export const DIALOG_BLOCKING = "FMC-DIALOG-BLOCKING";

/** Case-insensitive substrings. The two reminders are exempt by exact id. */
export const NEVER_AUTO_FRAGMENTS = [
  "save_file", "revitsaveoptions", "saveoptions", "partitionssavetocentral",
  "worksets_errors", "changes_not_saved", "fatal_error", "serious_error",
  "relinquish", "upgrade", "recover", "corrupt",
  "save as", "save-as", "saveas", "synchron", "sync", "save",
];

const EXEMPT = new Set([SAVE_REMINDER_ID.toLowerCase(), SYNC_REMINDER_ID.toLowerCase()]);

export const ANSWER_CODES: Record<string, number | null> = {
  log: null, pass: null, none: null,
  ok: 1, cancel: 2, no: 7, close: 8,
  commandlink1: 1001, commandlink2: 1002, commandlink3: 1003, commandlink4: 1004,
};

export interface DialogRule {
  id: string;
  enabled: boolean;
  dialog_id: string;
  message: string;
  document: string;
  answer: string;
  scope: "ai_jobs" | "always";
  note: string;
}

export interface DialogDecision {
  matched: boolean;
  never_auto: boolean;
  act: boolean;
  code: number | null;
  answer: string;
  rule_id: string;
  reason: string;
}

export interface OpenDialog {
  open: boolean;
  dialog_id: string;
  message: string;
  answer: string;
  job: string;
  pid: number;
  at: string;
  alert: boolean;
  addin: string;
}

export class DialogBlockingError extends Error {
  readonly code = DIALOG_BLOCKING;
  constructor(readonly dialogId: string, readonly text: string, readonly job: string) {
    super(`[${DIALOG_BLOCKING}] Revit is waiting on a person. Dialog ${dialogId || "(no id)"}: ${JSON.stringify(trim(text, 400))}. Job ${job}. Do not retry. Tell a person; this dialog was not answered. busy_reason: ${dialogBusyReason(text || dialogId || "untitled")}.`);
    this.name = "DialogBlockingError";
  }
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function norm(id: string): string {
  return (id ?? "").trim().toLowerCase();
}

export function neverAuto(dialogId: string): boolean {
  const id = norm(dialogId);
  if (!id) return false;
  if (EXEMPT.has(id)) return false;
  return NEVER_AUTO_FRAGMENTS.some((fragment) => id.includes(fragment));
}

export function neverAutoReason(dialogId: string): string {
  if (!neverAuto(dialogId)) return "";
  return "never auto: a save, sync, relinquish, upgrade, recover, fatal or serious-error dialog stays for a person";
}

export function answerOf(answer: string): { ok: true; code: number | null; name: string } | { ok: false } {
  const text = (answer ?? "").trim();
  if (!text) return { ok: false };
  const key = text.toLowerCase().replace(/[\s_]/g, "");
  if (key in ANSWER_CODES) {
    const code = ANSWER_CODES[key];
    return { ok: true, code, name: code == null ? "log" : answerName(code) };
  }
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    if (!Number.isInteger(n) || n <= 0 || n > 2000) return { ok: false };
    return { ok: true, code: n, name: answerName(n) };
  }
  return { ok: false };
}

export function answerName(code: number): string {
  switch (code) {
    case 1: return "Ok";
    case 2: return "Cancel";
    case 7: return "No";
    case 8: return "Close";
    case 1001: return "CommandLink1";
    case 1002: return "CommandLink2";
    case 1003: return "CommandLink3";
    case 1004: return "CommandLink4";
    default: return String(code);
  }
}

/** True when this button would save or synchronize one of the two reminders. */
export function unsafeReminderAnswer(dialogId: string, code: number | null): boolean {
  if (code == null) return false;
  const id = norm(dialogId);
  if (id !== SAVE_REMINDER_ID.toLowerCase() && id !== SYNC_REMINDER_ID.toLowerCase()) return false;
  return code !== 1003 && code !== 2 && code !== 8;
}

function rule(id: string, dialogId: string, answer: string, scope: "ai_jobs" | "always", note: string): DialogRule {
  return { id, enabled: true, dialog_id: dialogId, message: "", document: "", answer, scope, note };
}

export function defaultRules(): DialogRule[] {
  return [
    rule("accessing-file", "Dialog_Revit_AccessingFile", "log", "always",
      "Informational file access. Logged only; no button is pressed."),
    rule("save-reminder", SAVE_REMINDER_ID, "CommandLink3", "always",
      "Do not save the project (CommandLink3, 1003). 1001 saves. 1002 saves and opens the reminder interval. Cancel (2) and Close (8) also do not save."),
    rule("sync-reminder", SYNC_REMINDER_ID, "CommandLink3", "always",
      "Do not synchronize (CommandLink3, 1003). 1001 and 1002 synchronize with central. Close (8) and Cancel (2) also do not synchronize. This is the periodic reminder, not Changes_Not_Saved on close."),
    rule("doc-warn", "Dialog_Revit_DocWarnDialog", "Ok", "ai_jobs",
      "OK dismisses the warning during an AI job. Close is the alternative on a Close-only box."),
    rule("paste-similar", "Dialog_Revit_PasteSimilarSymbolsPaste", "Ok", "ai_jobs",
      "OK keeps the destination's types. Nothing is deleted."),
    rule("extended-error", "Dialog_Revit_ExtendedErrorDialog", "Cancel", "ai_jobs",
      "Cancel during an AI job. The error is not accepted."),
    rule("select-element", "Dialog_Revit_SelectElement", "Cancel", "ai_jobs",
      "Cancel during an AI job. No element is picked for the tool."),
  ];
}

function patternOk(pattern: string): boolean {
  const p = (pattern ?? "").trim();
  if (!p) return true;
  try { new RegExp(p, "i"); return true; } catch { return false; }
}

function regexOk(pattern: string, text: string): boolean {
  const p = (pattern ?? "").trim();
  if (!p) return true;
  try { return new RegExp(p, "i").test(text ?? ""); } catch { return false; }
}

export function ruleError(input: Partial<DialogRule>): string {
  const dialogId = String(input.dialog_id ?? "").trim();
  if (!dialogId) return "a rule needs dialog_id";
  const answer = answerOf(String(input.answer ?? ""));
  if (!answer.ok) return `${dialogId}: unknown answer`;
  const scope = String(input.scope ?? "ai_jobs").trim().toLowerCase();
  if (scope !== "always" && scope !== "ai_jobs") return `${dialogId}: scope must be ai_jobs or always`;
  if (!patternOk(String(input.message ?? "")) || !patternOk(String(input.document ?? ""))) return `${dialogId}: message or document regex is invalid`;
  if (neverAuto(dialogId)) return `${dialogId}: ${neverAutoReason(dialogId)}`;
  if (unsafeReminderAnswer(dialogId, answer.code)) return `${dialogId}: that button saves or synchronises`;
  return "";
}

export function normalizeRule(input: Partial<DialogRule>, fallbackId = ""): DialogRule {
  const answer = answerOf(String(input.answer ?? ""));
  const scope = String(input.scope ?? "ai_jobs").trim().toLowerCase() === "always" ? "always" : "ai_jobs";
  const dialogId = String(input.dialog_id ?? "").trim();
  const id = String(input.id ?? "").trim() || fallbackId || dialogId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "rule";
  return {
    id, enabled: input.enabled !== false, dialog_id: dialogId,
    message: String(input.message ?? ""), document: String(input.document ?? ""),
    answer: answer.ok ? (answer.code == null ? "log" : answer.name) : String(input.answer ?? ""),
    scope, note: String(input.note ?? ""),
  };
}

export function decide(rules: DialogRule[], dialogId: string, message: string, document: string, executing: boolean): DialogDecision {
  if (neverAuto(dialogId)) {
    return { matched: false, never_auto: true, act: false, code: null, answer: "", rule_id: "", reason: `left for a person (${neverAutoReason(dialogId)})` };
  }
  for (const rule of rules) {
    if (!rule?.enabled) continue;
    if (norm(rule.dialog_id) !== norm(dialogId)) continue;
    if (!regexOk(rule.message, message ?? "")) continue;
    if (!regexOk(rule.document, document ?? "")) continue;
    const answer = answerOf(rule.answer);
    if (!answer.ok) continue;
    if (unsafeReminderAnswer(dialogId, answer.code)) continue;
    if (rule.scope !== "always" && rule.scope !== "ai_jobs") continue;
    if (rule.scope === "ai_jobs" && !executing) continue;
    if (answer.code == null) {
      return { matched: true, never_auto: false, act: false, code: null, answer: "log", rule_id: rule.id, reason: `logged only: ${rule.id}` };
    }
    const note = rule.note ? ` — ${trim(rule.note, 160)}` : "";
    return {
      matched: true, never_auto: false, act: true, code: answer.code, answer: answer.name, rule_id: rule.id,
      reason: `answered: ${rule.id} ${answer.name} (${answer.code})${note}`,
    };
  }
  return { matched: false, never_auto: false, act: false, code: null, answer: "", rule_id: "", reason: "left for a person" };
}

export function rulesPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.FMC_DIALOG_RULES ?? "").trim();
  if (override) return override;
  return path.join(formcraftHome(env), RULES_FILE);
}

export function openDialogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(formcraftHome(env), OPEN_FILE);
}

function asRule(value: unknown): DialogRule | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<DialogRule>;
  if (ruleError(item)) return null;
  return normalizeRule(item);
}

export function readRules(env: NodeJS.ProcessEnv = process.env): {
  rules: DialogRule[]; source: "file" | "default"; file: string; file_exists: boolean; error: string; ignored: string[];
} {
  const file = rulesPath(env);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); }
  catch {
    return { rules: defaultRules(), source: "default", file, file_exists: false, error: "", ignored: [] };
  }
  try {
    const root = JSON.parse(text.replace(/^\uFEFF/, "")) as { rules?: unknown };
    if (!Array.isArray(root.rules)) return { rules: defaultRules(), source: "default", file, file_exists: true, error: "rules must be an array", ignored: [] };
    const ignored: string[] = [];
    const rules: DialogRule[] = [];
    for (const item of root.rules) {
      const why = ruleError((item ?? {}) as Partial<DialogRule>);
      if (why) { ignored.push(why); continue; }
      const rule = asRule(item);
      if (rule) rules.push(rule);
    }
    return { rules, source: "file", file, file_exists: true, error: ignored.join("; "), ignored };
  } catch (error) {
    return { rules: defaultRules(), source: "default", file, file_exists: true, error: error instanceof Error ? error.message : "invalid rules file", ignored: [] };
  }
}

export function writeRules(rules: DialogRule[], env: NodeJS.ProcessEnv = process.env): string {
  const file = rulesPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, rules }, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

export interface RuleChange {
  dry_run: boolean;
  refused: boolean;
  reason?: string;
  rule?: DialogRule;
  file: string;
  rules: DialogRule[];
}

export function addRule(input: Partial<DialogRule>, env: NodeJS.ProcessEnv = process.env, dryRun = true): RuleChange {
  const why = ruleError(input);
  const current = readRules(env);
  const file = current.file;
  if (why) return { dry_run: dryRun, refused: true, reason: why, file, rules: current.rules };
  const rule = normalizeRule(input);
  const rules = [rule, ...current.rules.filter((item) => item.id !== rule.id)];
  if (!dryRun) writeRules(rules, env);
  return { dry_run: dryRun, refused: false, rule, file, rules };
}

export function setRuleEnabled(id: string, enabled: boolean, env: NodeJS.ProcessEnv = process.env, dryRun = true): RuleChange {
  const current = readRules(env);
  const hit = current.rules.find((item) => item.id === id);
  if (!hit) return { dry_run: dryRun, refused: true, reason: `no rule ${id}`, file: current.file, rules: current.rules };
  const rules = current.rules.map((item) => item.id === id ? { ...item, enabled } : item);
  if (!dryRun) writeRules(current.file_exists ? rules : rules, env);
  return { dry_run: dryRun, refused: false, rule: { ...hit, enabled }, file: current.file, rules };
}

export interface DialogLine {
  at?: string;
  event?: string;
  dialog_id?: string;
  message?: string;
  answer?: string;
  job?: string;
  alert?: boolean;
}

export function leftForPerson(answer: string): boolean {
  return /^(left for a person|not answered)/i.test(answer ?? "");
}

export function dialogCounts(lines: DialogLine[]): Array<{ dialog_id: string; answer: string; count: number }> {
  const map = new Map<string, { dialog_id: string; answer: string; count: number }>();
  for (const line of lines) {
    if (line?.event !== "dialog") continue;
    const dialog_id = String(line.dialog_id ?? "");
    const answer = String(line.answer ?? "");
    const key = dialog_id + "\n" + answer;
    const row = map.get(key) ?? { dialog_id, answer, count: 0 };
    row.count += 1;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.dialog_id.localeCompare(b.dialog_id));
}

export function dialogAlerts(lines: DialogLine[]): Array<{ dialog_id: string; message: string; count: number; reason: string }> {
  const map = new Map<string, { dialog_id: string; message: string; count: number; reason: string }>();
  for (const line of lines) {
    if (line?.event !== "dialog") continue;
    const dialog_id = String(line.dialog_id ?? "");
    if (!neverAuto(dialog_id) || !leftForPerson(String(line.answer ?? ""))) continue;
    const row = map.get(dialog_id) ?? { dialog_id, message: String(line.message ?? ""), count: 0, reason: neverAutoReason(dialog_id) };
    row.count += 1;
    if (line.message) row.message = String(line.message);
    map.set(dialog_id, row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export function readOpenDialog(env: NodeJS.ProcessEnv = process.env): OpenDialog | null {
  try {
    const raw = JSON.parse(fs.readFileSync(openDialogPath(env), "utf8").replace(/^\uFEFF/, "")) as Partial<OpenDialog>;
    if (!raw || typeof raw !== "object") return null;
    return {
      open: raw.open === true,
      dialog_id: String(raw.dialog_id ?? ""),
      message: String(raw.message ?? ""),
      answer: String(raw.answer ?? ""),
      job: String(raw.job ?? ""),
      pid: Number(raw.pid ?? 0),
      at: String(raw.at ?? ""),
      alert: raw.alert === true,
      addin: String(raw.addin ?? ""),
    };
  } catch {
    return null;
  }
}

export interface BlockingDialog {
  open: boolean;
  available: boolean;
  source: "add-in" | "log" | "none";
  dialog_id: string;
  message: string;
  job: string;
  pid: number;
  at: string;
  alert: boolean;
  note: string;
}

const OPEN_FRESH_MS = 10 * 60 * 1000;

export function blockingDialog(env: NodeJS.ProcessEnv = process.env, opts: { job?: string; pid?: number; now?: number } = {}): BlockingDialog {
  const now = opts.now ?? Date.now();
  const note = "The add-in writes fmc_dialog_open.json while a dialog is up. An older add-in does not; the job log is used instead.";
  const live = readOpenDialog(env);
  if (live?.open) {
    const at = Date.parse(live.at);
    const fresh = Number.isFinite(at) && now - at <= OPEN_FRESH_MS;
    const pidOk = opts.pid == null || !live.pid || opts.pid === live.pid;
    const samePid = opts.pid != null && live.pid !== 0 && opts.pid === live.pid;
    const sameJob = !opts.job || !live.job || live.job === opts.job;
    // A modal on this Revit blocks the next call even when the dialog was shown under another job id.
    if (fresh && pidOk && (sameJob || samePid)) {
      return {
        open: true, available: true, source: "add-in", dialog_id: live.dialog_id, message: live.message,
        job: live.job || opts.job || "", pid: live.pid, at: live.at, alert: live.alert || neverAuto(live.dialog_id), note,
      };
    }
  }
  if (opts.job) {
    const lines = readJsonLines(jobFiles(env).revit, 800) as DialogLine[];
    const row = unansweredDialog(lines, opts.job);
    if (row) {
      return {
        open: true, available: live != null, source: "log", dialog_id: row.dialog_id, message: row.message,
        job: opts.job, pid: opts.pid ?? 0, at: row.at, alert: neverAuto(row.dialog_id), note,
      };
    }
  }
  return {
    open: false, available: live != null, source: live ? "add-in" : "none", dialog_id: "", message: "",
    job: opts.job ?? "", pid: opts.pid ?? live?.pid ?? 0, at: live?.at ?? "", alert: false, note,
  };
}

export function unansweredDialog(lines: DialogLine[], job: string): { dialog_id: string; message: string; at: string } | null {
  let hit: { dialog_id: string; message: string; at: string } | null = null;
  for (const line of lines) {
    if (!line || line.job !== job || line.event !== "dialog") continue;
    if (leftForPerson(String(line.answer ?? ""))) {
      hit = { dialog_id: String(line.dialog_id ?? ""), message: String(line.message ?? ""), at: String(line.at ?? "") };
    } else hit = null;
  }
  return hit;
}

export function formatDialog(dialogId: string, message: string): string {
  const id = (dialogId ?? "").trim();
  const text = (message ?? "").trim();
  if (id && text) return `${id}: ${text}`;
  return id || text;
}

export function blockingForJob(job: string, env: NodeJS.ProcessEnv = process.env, pid?: number): { dialog_id: string; message: string } | null {
  const hit = blockingDialog(env, { job, pid });
  if (!hit.open) return null;
  return { dialog_id: hit.dialog_id, message: hit.message };
}

// ---------- research tool 34: remove a rule, and ask whether a dialog would be answered ----------

/** Removes one rule by id. A dry run (the default) only shows the result. Removing can only make fewer dialogs answered. */
export function removeRule(id: string, env: NodeJS.ProcessEnv = process.env, dryRun = true): RuleChange {
  const current = readRules(env);
  const hit = current.rules.find((item) => item.id === id);
  if (!hit) return { dry_run: dryRun, refused: true, reason: `no rule ${id}`, file: current.file, rules: current.rules };
  const rules = current.rules.filter((item) => item.id !== id);
  if (!dryRun) writeRules(rules, env);
  return { dry_run: dryRun, refused: false, rule: hit, file: current.file, rules };
}

export interface DialogTest {
  dialog_id: string;
  message: string;
  document: string;
  /** Both cases: during an AI job, and between jobs (a person working). */
  during_ai_job: DialogDecision;
  between_jobs: DialogDecision;
  source: "file" | "default";
}

/** Would this dialog be answered, and by which rule? Read-only: it runs the same decide() the server uses, on the rules in force. */
export function testDialog(input: { dialog_id?: string; message?: string; document?: string }, env: NodeJS.ProcessEnv = process.env): DialogTest | { refused: true; reason: string } {
  const dialogId = String(input.dialog_id ?? "").trim();
  if (!dialogId) return { refused: true, reason: "test needs dialog_id" };
  const loaded = readRules(env);
  const message = String(input.message ?? "");
  const document = String(input.document ?? "");
  return {
    dialog_id: dialogId, message, document, source: loaded.source,
    during_ai_job: decide(loaded.rules, dialogId, message, document, true),
    between_jobs: decide(loaded.rules, dialogId, message, document, false),
  };
}
