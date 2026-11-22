/**
 * Who autosave may write.
 *
 * protected_roots (the check autoSave used to make on its own) is a folder-prefix list. isInside compares
 * path segments, case-insensitively, and "*" matches one folder. An empty list matches nothing, so a file
 * such as D:\Fomcraft\FMC_PROJECTS_27\THE OGALA RESIDENCE\01_WIP\S\....rvt is saved. It is not a title match
 * and not a search for "Fomcraft" inside a longer folder name.
 *
 * save_exclude is an exact title or path, matched the same way as sync_exclude.
 * protected_paths is an optional extra prefix list. Autosave refuses a file under either prefix list.
 */
import { loadConfig, type GuardConfig } from "./policy.js";
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

function listed(name: string, list: string[]): boolean {
  const key = documentKey(name);
  return key.length > 0 && list.some((item) => documentKey(item) === key);
}

function looksLikePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Null when autosave may write this document. */
export function saveBlocked(doc: { title?: string; path?: string }, cfg: GuardConfig = loadConfig().config): string | null {
  const title = doc.title?.trim() ?? "";
  const file = doc.path?.trim() ?? "";
  const names = [title, file].filter(Boolean);
  if (names.some((name) => listed(name, nameList(cfg.save_exclude)))) return "Excluded by save_exclude.";
  const prefixes = [...nameList(cfg.protected_paths), ...protectedRoots(cfg)];
  const paths = names.filter(looksLikePath);
  if (paths.some((item) => underAny(item, prefixes))) return "Under a protected path. Autosave does not write it.";
  return null;
}
