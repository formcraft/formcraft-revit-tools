/**
 * fmc_fabrication, the export side: run ids, the file log, the CSV/JSON report and where it may go. By default the
 * report goes to the tool's own folder (FMC_FABRICATION_DIR, else %LOCALAPPDATA%\Formcraft\fabrication). An output_path
 * is a project folder: it goes through checkWritePath, is a dry run until dry_run=false with confirm=true, is logged,
 * and the tool never writes a Revit file (.rvt, .rfa, .rte, .rft) or any file but its own two reports.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GuardConfig, checkWritePath, csvLine, expandEnv } from "./policy.js";
import { FabPart, FabRead, IssueKey, ancillarySummary, auditParts, configReport, partIssues, FabService } from "./fabrication.js";

export type OutFormat = "csv" | "json" | "both";

export function newRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `FB-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}T${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${crypto.randomBytes(3).toString("hex")}`;
}

export function log(cfg: GuardConfig, dry: boolean, target: string, result: string, detail: string, action: string, runId: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dry, target, result, `run ${runId}: ${detail}`]));
  } catch { /* logging never blocks the work */ }
}

export function localDir(env: NodeJS.ProcessEnv = process.env): string {
  if ((env.FMC_FABRICATION_DIR ?? "").trim()) return env.FMC_FABRICATION_DIR!.trim();
  const local = env.LOCALAPPDATA || path.join(path.sep, "tmp", "FormcraftLocal");
  return path.join(local, "Formcraft", "fabrication");
}

const REVIT_EXT = new Set([".rvt", ".rfa", ".rte", ".rft", ".rvf"]);

export const reportNames = (runId: string) => ({ csv: `FMC_Fabrication_${runId}.csv`, json: `FMC_Fabrication_${runId}.json` });

export const CSV_COLUMNS = [
  "id", "category", "level", "service", "specification", "material", "insulation", "product", "size", "alias", "item_number",
  "length_mm", "status", "validation", "hanger", "ends", "open_ends", "ancillaries", "ancillary_qty", "issues",
] as const;

export function csvText(parts: FabPart[], services: FabService[] | undefined, requireInsulation: boolean): string {
  const rows = [csvLine([...CSV_COLUMNS])];
  for (const p of parts) {
    const issues: IssueKey[] = partIssues(p, services, requireInsulation);
    rows.push(csvLine([
      p.id, p.category, p.level, p.service, p.spec, p.material, p.insulation, p.product, p.size, p.alias, p.item_number,
      Math.round(p.length_mm * 10) / 10, p.status, p.validation, p.hanger, p.ends, p.open_ends, p.anc.length,
      p.anc.reduce((n, a) => n + a.qty, 0), issues.join("; "),
    ]));
  }
  return rows.join("");
}

export function jsonText(read: FabRead, parts: FabPart[], opts: { require_insulation: boolean; sample_limit: number; run_id: string; document: string }): string {
  return JSON.stringify({
    run_id: opts.run_id, document: opts.document, generated: new Date().toISOString(),
    config: configReport(read),
    audit: auditParts(parts, read.services, opts),
    ancillaries: ancillarySummary(parts, opts.sample_limit),
    truncated: read.parts_truncated === true,
    parts,
  }, null, 2);
}

/** Which of the two report files an export makes. */
export function wantedFiles(format: OutFormat, runId: string): Array<{ kind: "csv" | "json"; name: string }> {
  const n = reportNames(runId);
  return ([["csv", n.csv], ["json", n.json]] as const).filter(([k]) => format === "both" || format === k).map(([kind, name]) => ({ kind, name }));
}

/** An output_path must be a project folder the guard allows. Returns the folder and the refusals (empty when fine). */
export function checkOutputFolder(output: string, config: GuardConfig, runId: string, format: OutFormat): { folder: string; reasons: string[] } {
  const folder = output.trim();
  const reasons: string[] = [];
  const ext = path.extname(folder).toLowerCase();
  if (REVIT_EXT.has(ext)) reasons.push(`output_path is a Revit file (${ext}); the tool never writes one. Give a folder.`);
  else if (ext) reasons.push(`output_path must be a folder, not a file (${path.basename(folder)}).`);
  if (!reasons.length) {
    for (const f of wantedFiles(format, runId)) {
      const v = checkWritePath(path.join(folder, f.name), config, { checkName: false });
      if (!v.ok) { reasons.push(...v.reasons); break; }
    }
  }
  return { folder, reasons };
}

export function writeReports(folder: string, files: Array<{ kind: "csv" | "json"; name: string }>, texts: { csv: string; json: string }): string[] {
  fs.mkdirSync(folder, { recursive: true });
  return files.map((f) => {
    const target = path.join(folder, f.name);
    fs.writeFileSync(target, f.kind === "csv" ? "\uFEFF" + texts.csv : texts.json, "utf8");
    return target;
  });
}
