/**
 * Who autosave may write.
 *
 * protected_roots (the check autoSave used to make on its own) is a folder-prefix list. isInside compares
 * path segments, case-insensitively, and "*" matches one folder. An empty list matches nothing, so a file
 * such as D:\Fomcraft\FMC_PROJECTS_27\THE OGALA RESIDENCE\01_WIP\S\....rvt is saved (owner 28 Nov: the AI works there;
 * /health warns that protected_roots is not set). It is not a title match and not a search for "Fomcraft" inside a
 * longer folder name. The forbidden-project floor (A-0001, HEBERT HOSTELS, plus forbidden_projects) is never saved or synced.
 *
 * Autosave skips save_exclude, sync_exclude and protected_paths together.
 * A listed title also covers a local of that model: "HEBERT HOSTELS" matches "HEBERT HOSTELS_USER".
 * protected_paths is a folder-prefix list. protected_roots is still checked as well.
 */
import { forbiddenProject, loadConfig, type GuardConfig } from "./policy.js";
import { underAny, protectedRoots } from "./opencopy.js";

/** Same key as sync_exclude: title, path, or file name, without .rvt. */
function documentKey(name: string): string {
  const norm = name.trim().toLowerCase().replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? norm;
  return base.replace(/\.rvt$/, "");
}

function nameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

/** Exact title or path, or a local whose name continues the listed title with _ or a space. */
function listed(name: string, list: string[]): boolean {
  const key = documentKey(name);
  if (!key) return false;
  return list.some((item) => {
    const want = documentKey(item);
    if (!want) return false;
    if (want === key) return true;
    const next = key[want.length];
    return key.startsWith(want) && (next === "_" || next === " ");
  });
}

function looksLikePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** "excluded" when autosave must leave this document alone. Null when it may be saved. */
export function saveSkipReason(doc: { title?: string; path?: string }, cfg: GuardConfig = loadConfig().config): "excluded" | null {
  const title = doc.title?.trim() ?? "";
  const file = doc.path?.trim() ?? "";
  const names = [title, file].filter(Boolean);
  if (names.some((name) => forbiddenProject(name, cfg))) return "excluded";
  if (names.some((name) => listed(name, [...nameList(cfg.save_exclude), ...nameList(cfg.sync_exclude)]))) return "excluded";
  const prefixes = [...nameList(cfg.protected_paths), ...protectedRoots(cfg)];
  const paths = names.filter(looksLikePath);
  if (paths.some((item) => underAny(item, prefixes))) return "excluded";
  return null;
}

/** True when sync_exclude names this document or the central it is a local of. */
export function excludedFromSync(doc: { title?: string; path?: string }, cfg: GuardConfig = loadConfig().config): boolean {
  const names = [doc.title?.trim() ?? "", doc.path?.trim() ?? ""].filter(Boolean);
  if (names.some((name) => forbiddenProject(name, cfg))) return true;
  return names.some((name) => listed(name, nameList(cfg.sync_exclude)));
}

/** Null when autosave may write this document. */
export function saveBlocked(doc: { title?: string; path?: string }, cfg: GuardConfig = loadConfig().config): string | null {
  if (saveSkipReason(doc, cfg) == null) return null;
  const title = doc.title?.trim() ?? "";
  const file = doc.path?.trim() ?? "";
  const names = [title, file].filter(Boolean);
  const forbidden = names.map((name) => forbiddenProject(name, cfg)).find(Boolean);
  if (forbidden) return `Forbidden project (${forbidden}): never written, saved or synced.`;
  if (names.some((name) => listed(name, nameList(cfg.sync_exclude)))) return "Excluded by sync_exclude.";
  if (names.some((name) => listed(name, nameList(cfg.save_exclude)))) return "Excluded by save_exclude.";
  return "Under a protected path. Autosave does not write it.";
}
