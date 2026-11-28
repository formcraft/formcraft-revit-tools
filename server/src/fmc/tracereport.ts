/**
 * Page a saved fmc_trace findings file. No Revit call.
 * A copy stays under %LOCALAPPDATA%\Formcraft or the HANDOFF folder, never D:.
 */
import fs from "node:fs";
import path from "node:path";
import { onDriveD } from "./clashscan.js";
import { traceReportHostDir } from "./trace.js";

export interface PagedFinding {
  code: string;
  id: number;
  check?: string;
  [key: string]: unknown;
}

export function flattenFindings(body: unknown): PagedFinding[] {
  const row = body && typeof body === "object" ? body as { checks?: Array<{ id?: string; findings?: Array<Record<string, unknown>> }>; findings?: Array<Record<string, unknown>> } : {};
  const out: PagedFinding[] = [];
  for (const check of row.checks ?? []) {
    for (const finding of check.findings ?? []) {
      out.push({ ...finding, code: String(finding.code ?? ""), id: Number(finding.id ?? 0), check: check.id });
    }
  }
  for (const finding of row.findings ?? []) out.push({ ...finding, code: String(finding.code ?? ""), id: Number(finding.id ?? 0) });
  return out;
}

export function pageFindings(findings: PagedFinding[], opts: { offset?: number; limit?: number; codes?: string[] }): { total: number; offset: number; limit: number; findings: PagedFinding[] } {
  const codes = new Set((opts.codes ?? []).map((code) => code.trim()).filter(Boolean));
  const filtered = codes.size ? findings.filter((finding) => codes.has(finding.code)) : findings;
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(500, Math.max(1, opts.limit ?? 50));
  return { total: filtered.length, offset, limit, findings: filtered.slice(offset, offset + limit) };
}

export function latestTraceFile(dir: string, document = ""): string | null {
  if (!fs.existsSync(dir)) return null;
  const want = document.trim().toLowerCase();
  const files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".json") && name.toLowerCase().startsWith("trace-"))
    .filter((name) => !want || name.toLowerCase().includes(want.replace(/\.rvt$/i, "").slice(0, 40)))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  if (!files.length) return null;
  return path.join(dir, files[files.length - 1].name);
}

export function handoffDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FMC_HANDOFF || "C:\\Users\\USER\\agent-tools\\HANDOFF";
}

export function copyAllowed(destDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dest = destDir.replace(/\//g, "\\");
  if (onDriveD(dest)) return "FMC-CLASH-PATH: a report is not copied onto D:.";
  const local = traceReportHostDir(env).replace(/\//g, "\\").toLowerCase();
  const formcraft = local.split("\\trace")[0];
  const hand = handoffDir(env).replace(/\//g, "\\").toLowerCase();
  const norm = dest.toLowerCase();
  if (norm.startsWith(formcraft) || norm.startsWith(hand) || norm === hand) return null;
  return "A copy stays under %LOCALAPPDATA%\\Formcraft or the HANDOFF folder.";
}

export function copyTraceFile(file: string, destDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const refused = copyAllowed(destDir, env);
  if (refused) throw new Error(refused);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(file));
  if (onDriveD(dest)) throw new Error("FMC-CLASH-PATH: a report is not copied onto D:.");
  fs.copyFileSync(file, dest);
  return dest;
}
