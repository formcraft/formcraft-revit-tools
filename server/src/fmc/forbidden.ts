/**
 * F134 (O6, FC-5 default): the projects no tool writes for. A built-in floor of two names, A-0001 and HEBERT HOSTELS,
 * matched on normalised words (case, spaces and underscores folded; a name only matches as a whole word, so
 * "A-00012" is not "A-0001") in the path as given and in its real path (a junction or subst drive can't hide it).
 * fmc_guard.json may only add names (forbidden_projects); it can't remove the floor. A-00012 is not blocked: that is
 * still an open decision.
 */
import fs from "node:fs";
import path from "node:path";
import type { GuardConfig } from "./policy.js";

const win = path.win32;

export const FORBIDDEN_PROJECT_FLOOR: readonly string[] = ["A-0001", "HEBERT HOSTELS"];

function words(s: string): string {
  return s.toLowerCase().replace(/[\\/]+/g, "/").replace(/[\s_]+/g, " ").trim();
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The floor plus the names fmc_guard.json adds (forbidden_projects). */
export function forbiddenNames(cfg?: Partial<GuardConfig> | null): string[] {
  const extra = (cfg as { forbidden_projects?: unknown } | null | undefined)?.forbidden_projects;
  const added = Array.isArray(extra) ? extra.map((x) => String(x).trim()).filter(Boolean) : [];
  return [...FORBIDDEN_PROJECT_FLOOR, ...added];
}

/** True when name appears in text as a whole word run (normalised). */
export function mentions(text: string, name: string): boolean {
  const want = words(name);
  if (!want) return false;
  const pattern = escape(want).replace(/ /g, " +");
  return new RegExp(`(^|[^a-z0-9])${pattern}($|[^a-z0-9])`).test(words(text));
}

/** The real path of target: the nearest existing folder resolved, the rest appended. Null when nothing resolves. */
export function realPathOf(target: string, realpath: (p: string) => string = (p) => fs.realpathSync.native(p), exists: (p: string) => boolean = fs.existsSync): string | null {
  let dir = target;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      if (exists(dir)) return rest.length ? win.join(realpath(dir), ...rest.reverse()) : realpath(dir);
    } catch { return null; }
    const up = win.dirname(dir);
    if (!up || up === dir) return null;
    rest.push(win.basename(dir));
    dir = up;
  }
  return null;
}

/** The forbidden project a path belongs to, or null. */
export function forbiddenProject(target: string, cfg?: Partial<GuardConfig> | null, real: (p: string) => string | null = (p) => realPathOf(p)): string | null {
  if (!target) return null;
  const paths = [target];
  const r = real(target);
  if (r && r !== target) paths.push(r);
  for (const name of forbiddenNames(cfg)) if (paths.some((p) => mentions(p, name))) return name;
  return null;
}
