/**
 * fmc_doc, the asset builder's engine (docs/PLAN_B1_ENGINE.md, B1a sessions). Pure checks.
 *
 * A session is a background document: new from a family template (.rft) in the template roots, or a family file in
 * the library roots (_Staging, _ChainTests). Never a project or a workshared model. Saves go only into the write roots,
 * under a name the naming rules accept, with a build report beside the file.
 */
import { createHash } from "node:crypto";
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

export interface SessionRecord { id: string; source: string; opened: string; ops: Array<{ op: string; name: string; result: string }> }

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
