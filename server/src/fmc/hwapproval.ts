/**
 * P-fmc_hw-01 (FINAL 2026-11-28, sections 2.3 and 2.4): person-only, single-use approvals for the real fmc_hw writes,
 * and the timestamped backup plus atomic write of Revit.ini.
 *
 * Approvals use the existing approval queue (%APPDATA%\Formcraft\ai_queue, aiuse_io.ts): the pane is the only place a
 * person approves an item (setStatus is never an MCP tool). The record is content-bound: its id is batchKey(kind,
 * binding, target), so a changed close list, exe, value or ini hash is a different record. It is used once, and marked
 * used only after the write succeeded. Testing-mode auto-approve never approves these kinds (open item O1): a record
 * whose approver is empty or "auto..." is refused, and the AI gate's auto path never writes an hw_* record.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { batchKey } from "./aiuse.js";
import { enqueue, queueDir, readItem, type QueueItem } from "./aiuse_io.js";

export type HwApprovalKind = "hw_free" | "hw_gpu_prefer" | "hw_offload";
export const HW_APPROVAL_KINDS: readonly HwApprovalKind[] = ["hw_free", "hw_gpu_prefer", "hw_offload"];
/** An approval older than this is expired (FMC-HW-APPROVAL). */
export const HW_APPROVAL_TTL_MS = 30 * 60_000;

export interface HwBinding {
  /** The document path, the exe path, or the Revit.ini path: the record's target. */
  target: string;
  /** Everything the person approved; any change is a different record. Never a "document" key (batchKey drops it). */
  plan: Record<string, unknown>;
  /** Shown to the person in the pane. */
  model: string;
  details: string[];
}

export type HwApprovalCheck = { ok: true; id: string; by: string } | { ok: false; id: string; code: "FMC-HW-APPROVAL"; message: string };

const isAuto = (by: string | undefined) => !by || !by.trim() || /^auto/i.test(by.trim());

/** Checks the person's approval for exactly this plan. A missing record is queued for the pane (real calls only). */
export function checkHwApproval(kind: HwApprovalKind, binding: HwBinding, env: NodeJS.ProcessEnv = process.env, now = new Date()): HwApprovalCheck {
  const id = batchKey(kind, binding.plan, binding.target);
  const item = readItem(id, env) as (QueueItem & { used_at?: string }) | null;
  const fail = (message: string): HwApprovalCheck => ({ ok: false, id, code: "FMC-HW-APPROVAL", message: `[FMC-HW-APPROVAL] ${message} Nothing was changed.` });
  if (!item) {
    try { enqueue(kind, binding.plan, binding.target, binding.model, "hardware (a person approves; never auto)", 0, env, now, binding.details); } catch { /* the refusal stands */ }
    return fail(`${kind} needs a person's approval in the pane for exactly this plan (request ${id} is queued). confirm:true is not an approval.`);
  }
  if (item.command !== kind) return fail(`Approval ${id} is not a ${kind} approval.`);
  if (item.status === "used") return fail(`Approval ${id} was already used once. Ask the person to approve again.`);
  if (item.status !== "approved") return fail(`Approval ${id} is ${item.status}, not approved by a person.`);
  if (isAuto(item.by)) return fail(`Approval ${id} was not given by a person (${item.by || "no approver"}). Auto-approve never covers ${kind}.`);
  const at = Date.parse(item.at ?? "");
  if (!Number.isFinite(at) || now.getTime() - at > HW_APPROVAL_TTL_MS) return fail(`Approval ${id} has expired (older than ${HW_APPROVAL_TTL_MS / 60_000} minutes). Ask the person to approve again.`);
  return { ok: true, id, by: item.by ?? "" };
}

/** Marks the record used after the write succeeded. The approver stays on the record. */
export function useHwApproval(id: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): boolean {
  const file = path.win32.join(queueDir(env), id.replace(/[^0-9a-f]/gi, "") + ".json");
  try {
    const item = JSON.parse(fs.readFileSync(file, "utf8"));
    if (item.status !== "approved") return false;
    item.status = "used"; item.used_at = now.toISOString();
    fs.writeFileSync(file, JSON.stringify(item, null, 2));
    return true;
  } catch { return false; }
}

/** The binding facts of the current Revit.ini: sha256, size and mtime (HW-T09: a changed file is a different record). */
export function iniFacts(file: string, fsImpl: Pick<typeof fs, "readFileSync" | "statSync"> = fs): { path: string; sha256: string; size: number; mtime: number } | null {
  try {
    const bytes = fsImpl.readFileSync(file);
    const st = fsImpl.statSync(file);
    return { path: file, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch { return null; }
}

/** yyyyMMdd-HHmmss, the archivePlan stamp style (local time). */
export function iniStamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export interface IniFs {
  existsSync: (p: string) => boolean;
  copyFileSync: (from: string, to: string) => void;
  writeFileSync: (p: string, text: string, enc: "utf8") => void;
  renameSync: (from: string, to: string) => void;
  rmSync?: (p: string, opts: { force: true }) => void;
}

/**
 * Section 2.4: copy the live file to Revit.ini.<stamp>.bak (never the bare Revit.ini.bak), then write <file>.tmp and
 * rename it over the live file. A failed copy or replace is FMC-HW-BACKUP and leaves the live file as it was; a .bak
 * that was written is kept.
 */
export function writeIniAtomic(file: string, text: string, now: Date = new Date(), fsImpl: IniFs = fs as unknown as IniFs): { backup: string } {
  if (!file) throw new Error("[FMC-HW] Revit.ini path is not set. Nothing was written.");
  if (!fsImpl.existsSync(file)) throw new Error(`[FMC-HW] Revit.ini was not found (${file}). Nothing was written.`);
  let backup = `${file}.${iniStamp(now)}.bak`;
  for (let i = 2; fsImpl.existsSync(backup); i++) backup = `${file}.${iniStamp(now)}-${i}.bak`;
  try { fsImpl.copyFileSync(file, backup); }
  catch (error) { throw new Error(`[FMC-HW-BACKUP] Revit.ini could not be backed up (${error instanceof Error ? error.message : String(error)}). Revit.ini was not changed.`); }
  const tmp = `${file}.tmp`;
  try {
    fsImpl.writeFileSync(tmp, text, "utf8");
    fsImpl.renameSync(tmp, file);
  } catch (error) {
    try { fsImpl.rmSync?.(tmp, { force: true }); } catch { /* the temp file is harmless */ }
    throw new Error(`[FMC-HW-BACKUP] Revit.ini could not be replaced (${error instanceof Error ? error.message : String(error)}). The live file was not changed; the backup ${backup} is kept.`);
  }
  return { backup };
}