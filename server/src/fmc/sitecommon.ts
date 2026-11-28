/**
 * Shared pieces for the site and analysis tools (fmc_sun, fmc_avf, fmc_survey): the write guard, the references check
 * and the JSON report. Every path takes the env it was given. Nothing here talks to Revit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath, loadConfig, type GuardConfig } from "./policy.js";
import { saveBlocked } from "./savepolicy.js";
import { protectedRoots } from "./opencopy.js";
import { invert, isMat4 } from "./coordmath.js";

export interface SiteRefs { kit?: string[]; standards?: string[]; rulebook?: string[] }

export interface SiteDoc { title: string; path: string; is_central?: boolean }

/** null when references.kit, references.standards and references.rulebook each name at least one source. */
export function siteReferenceProblems(refs: SiteRefs | undefined, message: string): string | null {
  if (!refs) return message;
  for (const key of ["kit", "standards", "rulebook"] as const) {
    const list = refs[key];
    if (!Array.isArray(list) || !list.some((item) => String(item).trim())) return message;
  }
  return null;
}

/** The reason a write is refused, or null. HEBERT HOSTELS, a Centrals folder, a central model and protected paths. */
export function siteWriteBlock(tool: string, doc: SiteDoc, guard?: GuardConfig, env: NodeJS.ProcessEnv = process.env): { reason: string | null; config: GuardConfig } {
  const loaded = guard ? { config: guard, problem: undefined as string | undefined } : loadConfig(configPath(env));
  const blob = `${doc.title} ${doc.path}`;
  let reason: string | null = null;
  if (/hebert hostels/i.test(blob)) reason = `HEBERT HOSTELS is not written by ${tool}.`;
  else if (/[\\/]centrals[\\/]/i.test(doc.path)) reason = `A file under a Centrals folder is not written by ${tool}.`;
  else if (doc.is_central) reason = `A central model is not written by ${tool}.`;
  else reason = saveBlocked(doc, loaded.config) || loaded.problem || null;
  return { reason, config: loaded.config };
}

export function siteProtectedRoots(config: GuardConfig): string[] {
  return [...(config.protected_paths ?? []), ...protectedRoots(config)];
}

/** %LOCALAPPDATA%\Formcraft\<sub>, or the env override (tests). */
export function siteReportDir(env: NodeJS.ProcessEnv, override: string, sub: string): string {
  const direct = (env[override] ?? "").trim();
  if (direct) return direct;
  const local = env.LOCALAPPDATA || path.join(os.tmpdir(), "FormcraftLocal");
  return path.join(local, "Formcraft", sub);
}

export function writeSiteReport(dir: string, prefix: string, body: unknown): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${prefix}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

export function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  const out = Math.round(value * f) / f;
  return Object.is(out, -0) ? 0 : out;
}

/**
 * Shared (survey) coordinates to internal, millimetres, with the fmc_coord matrix (internal_to_shared, row-major 4x4,
 * translation in the last column). The inverse is coordmath.invert, the same one fmc_coord uses.
 */
export function sharedToInternalMm(points: Array<[number, number, number]>, internalToShared: number[][]): Array<[number, number, number]> {
  if (!isMat4(internalToShared)) throw new Error("[FMC-SITE-TRANSFORM] The document did not return internal_to_shared (a 4x4 matrix).");
  const inv = invert(internalToShared);
  return points.map(([x, y, z]) => [
    inv[0][0] * x + inv[0][1] * y + inv[0][2] * z + inv[0][3],
    inv[1][0] * x + inv[1][1] * y + inv[1][2] * z + inv[1][3],
    inv[2][0] * x + inv[2][1] * y + inv[2][2] * z + inv[2][3],
  ]);
}

export function internalToSharedMm(points: Array<[number, number, number]>, internalToShared: number[][]): Array<[number, number, number]> {
  if (!isMat4(internalToShared)) throw new Error("[FMC-SITE-TRANSFORM] The document did not return internal_to_shared (a 4x4 matrix).");
  const m = internalToShared;
  return points.map(([x, y, z]) => [
    m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3],
    m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3],
    m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3],
  ]);
}

/** One CSV line, quotes allowed. */
export function splitCsvLine(line: string, sep = ","): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((cell) => cell.trim());
}

/** Comma, semicolon or tab, whichever the first line holds most of. */
export function sniffSeparator(firstLine: string): string {
  const counts = [",", ";", "\t"].map((sep) => [sep, firstLine.split(sep).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ",";
}

export const UNIT_TO_MM: Record<string, number> = { mm: 1, m: 1000, ft: 304.8, usft: 304.8006096 };
