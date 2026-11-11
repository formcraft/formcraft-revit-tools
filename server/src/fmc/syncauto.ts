/**
 * Auto-approve of a bot's own fmc_revit_file sync.
 * Off unless ai_modeller.auto_approve_sync is true, and that key does nothing unless mode is testing and
 * auto_approve is true. Relinquish on its own, and the batch line's own sync (batch_sync), are not this path.
 * Every decision this path makes is one line in FMC_SyncAutoApprove.jsonl.
 */
import fs from "node:fs";
import path from "node:path";
import { generalState, type AiModellerConfig } from "./aiuse.js";
import { formcraftDir } from "./aiuse_io.js";
import { syncDocumentKey } from "./batchsync.js";
import { jobFiles, readJsonLines } from "./jobs.js";
import { underAny, protectedRoots } from "./opencopy.js";
import type { DocInfo, GuardConfig } from "./policy.js";

const win = path.win32;

/** A corrupt-model dialog older than this is not a reason to keep the next sync manual. */
export const SYNC_DAMAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SyncHost extends DocInfo {
  isLocal?: boolean | null;
}

export interface SyncCaller {
  lease?: string;
  client: string;
}

export interface SyncHolder {
  lease: string;
  client: string;
}

export interface SyncDialog {
  at?: string;
  event?: string;
  dialog_id?: string;
  message?: string;
  document?: string;
  title?: string;
  path?: string;
  model?: string;
}

export interface SyncAutoFacts {
  now: number;
  holder: SyncHolder | null;
  caller: SyncCaller;
  ramPaused: boolean;
  dialogs: SyncDialog[];
  /** Titles or paths a person listed. Matched like sync_exclude. */
  damaged: string[];
  exclude: string[];
  protectedRoots: string[];
}

export interface SyncAutoDecision {
  /** True when this call is a direct sync and auto_approve_sync is set, so a line is written. */
  judged: boolean;
  approve: boolean;
  reason: string;
}

export function syncAutoLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return win.join(formcraftDir(env), "FMC_SyncAutoApprove.jsonl");
}

export function appendSyncAutoLog(env: NodeJS.ProcessEnv, row: Record<string, unknown>): void {
  try {
    const file = syncAutoLogPath(env);
    fs.mkdirSync(win.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n");
  } catch { /* the decision still stands */ }
}

export function readSyncAutoLog(env: NodeJS.ProcessEnv = process.env, max = 20): Array<Record<string, unknown>> {
  return readJsonLines(syncAutoLogPath(env), max);
}

export function damagedNames(cfg: GuardConfig, ai: AiModellerConfig | null): string[] {
  const top = Array.isArray(cfg.damaged_documents) ? cfg.damaged_documents : [];
  const nested = ai?.damaged_documents ?? [];
  return [...top, ...nested].map((item) => String(item).trim()).filter(Boolean);
}

function sameDoc(a: string, b: string): boolean {
  return syncDocumentKey(a).length > 0 && syncDocumentKey(a) === syncDocumentKey(b);
}

function listed(name: string, list: string[]): boolean {
  return list.some((item) => sameDoc(item, name));
}

/** The dialog Revit shows when Synchronize with Central finds a damaged model, and the same family of dialogs. */
export function isDamageDialog(dialogId: string, message: string): boolean {
  const text = `${dialogId} ${message}`;
  if (/TaskDialog_Corrupt_Model_Detected_On_Synchronize_With_Central/i.test(text)) return true;
  return /corrupt/i.test(text) && /synchron|central|model/i.test(text);
}

function dialogAbout(line: SyncDialog, title: string, path: string): "this" | "other" | "unnamed" {
  const named = [line.document, line.title, line.path, line.model].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (named.some((item) => sameDoc(item, title) || sameDoc(item, path))) return "this";
  if (named.length) return "other";
  const text = `${line.message ?? ""} ${line.dialog_id ?? ""}`.toLowerCase();
  const file = path.split(/[/\\]/).pop() ?? "";
  if (title && text.includes(title.toLowerCase())) return "this";
  if (file && text.includes(file.toLowerCase())) return "this";
  return "unnamed";
}

/** A recent corrupt-on-sync dialog for this document, or one that names no document at all. */
export function recentDamage(dialogs: SyncDialog[], title: string, path: string, now: number): string | null {
  for (const line of dialogs) {
    if (line.event && line.event !== "dialog") continue;
    const id = String(line.dialog_id ?? "");
    const message = String(line.message ?? "");
    if (!isDamageDialog(id, message)) continue;
    const at = Date.parse(String(line.at ?? ""));
    if (Number.isFinite(at) && now - at > SYNC_DAMAGE_WINDOW_MS) continue;
    const about = dialogAbout(line, title, path);
    if (about === "other") continue;
    const which = id || message || "corrupt model";
    if (about === "unnamed") return `A recent corrupt-model dialog does not name its document (${which}), so this sync stays manual.`;
    return `A recent corrupt-model dialog flagged this document (${which}).`;
  }
  return null;
}

/**
 * Whether a direct sync may run now. Relinquish and the batch line's own sync are not judged here.
 * auto_approve_sync false means the old rule: a person approves, and nothing is written.
 */
export function judgeDirectSync(
  action: string,
  batchSync: boolean,
  host: SyncHost,
  ai: AiModellerConfig | null,
  facts: SyncAutoFacts,
): SyncAutoDecision {
  if (batchSync || action !== "sync") return { judged: false, approve: false, reason: "" };
  if (ai?.auto_approve_sync !== true) return { judged: false, approve: false, reason: "" };
  const no = (reason: string): SyncAutoDecision => ({ judged: true, approve: false, reason });
  if (ai.mode !== "testing" || ai.auto_approve !== true) {
    return no("auto_approve_sync only applies when mode is testing and auto_approve is true.");
  }
  if (host.isFamily || /\.rfa$/i.test(host.path ?? "")) return no("A family document is not synced.");
  if (host.isDetached) return no("A detached copy is not synced.");
  if (host.isLinked || host.readOnly) return no("A linked document or a read-only copy is not synced.");
  if (!host.isWorkshared || host.isLocal !== true) return no("The target is not a workshared local. A central model is not synced from here.");
  if (host.path && underAny(host.path, facts.protectedRoots)) return no(`Protected original: ${host.path}.`);
  if (listed(host.title, facts.exclude) || (host.path && listed(host.path, facts.exclude))) return no("Excluded by sync_exclude.");
  if (facts.holder && (facts.holder.lease !== facts.caller.lease || facts.holder.client !== facts.caller.client)) {
    return no("Another lease is active on this document.");
  }
  if (listed(host.title, facts.damaged) || (host.path && listed(host.path, facts.damaged))) return no("Listed in damaged_documents.");
  const damage = recentDamage(facts.dialogs, host.title, host.path ?? "", facts.now);
  if (damage) return no(damage);
  if (facts.ramPaused) return no("The RAM gate is paused.");
  if (ai.stop || generalState(ai, host.title, host.path ?? "") === "Stopped") return no("Stop AI is on.");
  if (generalState(ai, host.title, host.path ?? "") !== "On") return no("AI is off for this model.");
  const lease = facts.holder ? "this session holds the lease" : "no other lease is active";
  return { judged: true, approve: true, reason: `Workshared local, ${lease}, not damaged, RAM is clear, and AI is on.` };
}

export function readDamageDialogs(env: NodeJS.ProcessEnv = process.env): SyncDialog[] {
  return readJsonLines(jobFiles(env).revit, 800).filter((line) => line && typeof line === "object") as SyncDialog[];
}
