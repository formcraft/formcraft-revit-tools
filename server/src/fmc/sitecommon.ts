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
