/**
 * fmc_doc, the asset builder's engine (docs/PLAN_B1_ENGINE.md, B1a sessions). Pure checks.
 *
 * A session is a background document: new from a family template (.rft) in the template roots, or a family file in
 * the library roots (_Staging, _ChainTests). Never a project or a workshared model. Saves go only into the write roots,
 * under a name the naming rules accept, with a build report beside the file.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GuardConfig, checkTemplatePath, checkWritePath, isInside } from "./policy.js";

const win = path.win32;

export function openProblems(q: { template?: string; file?: string }, cfg: GuardConfig): string[] {
  const t = (q.template ?? "").trim(), f = (q.file ?? "").trim();
  if (!t && !f) return ["open needs a family template (.rft) or a family file in staging (.rfa)"];
  if (t && f) return ["open takes a template or a file, not both"];
  if (t) {
    if (win.extname(t).toLowerCase() !== ".rft") return [`${win.basename(t)}: B1 opens family templates (.rft); project templates come in B5`];
    return checkTemplatePath(t, cfg).reasons;
  }
  if (win.extname(f).toLowerCase() !== ".rfa") return [`${win.basename(f)}: only family files (.rfa) open in a session`];
  if (!cfg.library_roots.some((r) => isInside(f, r))) return [`${f} isn't in the library roots (${cfg.library_roots.join("; ") || "none set"}): sessions open staging files only`];
  return [];
}

export function saveProblems(target: string, cfg: GuardConfig): string[] {
  const t = target.trim();
  if (!t) return ["save needs a target path"];
  if (win.extname(t).toLowerCase() !== ".rfa") return ["A family is saved as .rfa"];
  return checkWritePath(t, cfg).reasons;
}

/** A session in the server's ledger; used is the last call that worked on it (older entries have only opened). */
export interface SessionRecord { id: string; source: string; opened: string; used?: string; ops: Array<{ op: string; name: string; result: string }> }

// ---------- F-046 (issue #147): sessions time out ----------

export const LEDGER_FILE = "FMC_Doc_Sessions.json";
/** The ledger beside the reports (reports_dir, expanded). path.join is win32 on the pilot PC. */
export const ledgerPath = (reportsDir: string) => path.join(reportsDir, LEDGER_FILE);

export function readLedger(reportsDir: string): Record<string, SessionRecord> {
  try { return JSON.parse(fs.readFileSync(ledgerPath(reportsDir), "utf8")); } catch { return {}; }
}

export function writeLedger(reportsDir: string, l: Record<string, SessionRecord>) {
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(ledgerPath(reportsDir), JSON.stringify(l, null, 2));
}

/** The guard's idle limit in hours (session_idle_hours, default 12); a bad value falls back to 12. */
export function idleLimit(cfg: Partial<GuardConfig>): number {
  const h = Number(cfg.session_idle_hours);
  return Number.isFinite(h) && h > 0 ? h : 12;
}

/** Hours since a time (ISO, or the add-in's local "s" format), one decimal; null when the time can't be read. */
export function hoursSince(when: string | undefined, now: Date): number | null {
  if (!when) return null;
  const t = Date.parse(when);
  return Number.isFinite(t) ? Math.max(0, Math.round((now.getTime() - t) / 360000) / 10) : null;
}

export interface StaleMark { idle_hours: number | null; stale: boolean; stale_after_hours: number }

/** Marks each session with its idle time and whether it is stale (idle longer than the limit). Unknown idle is never stale. */
export function markStale<T extends { used?: string; opened?: string; idle_minutes?: number }>(sessions: T[], now: Date, limitHours: number): Array<T & StaleMark> {
  return sessions.map((s) => {
    const idle = typeof s.idle_minutes === "number" && Number.isFinite(s.idle_minutes) ? Math.round(s.idle_minutes / 6) / 10 : hoursSince(s.used || s.opened, now);
    return { ...s, idle_hours: idle, stale: idle != null && idle > limitHours, stale_after_hours: limitHours };
  });
}

/** The build report beside each saved file: the same ops on the same kit give the same file (plan B1). */
export function buildReport(s: SessionRecord, saved: string, report: Record<string, unknown>, kit: { kit?: string; revision?: string }, commit: string, now: Date) {
  const opsHash = createHash("sha256").update(JSON.stringify(s.ops.map((o) => [o.op, o.name]))).digest("hex").slice(0, 16);
  return {
    file: win.basename(saved), source: win.basename(s.source), saved_at: now.toISOString(),
    kit: `${kit.kit ?? "?"} ${kit.revision ?? ""}`.trim(), plugin: commit, ops_hash: opsHash, ops: s.ops,
    result: { category: report.category ?? "", parameters: Array.isArray(report.parameters) ? report.parameters.length : 0,
      types: Array.isArray(report.types) ? report.types.length : 0, solids: report.solids ?? 0, connectors: report.connectors ?? 0,
      dimensions: report.dimensions ?? 0, warnings: report.warnings ?? 0 },
  };
}
