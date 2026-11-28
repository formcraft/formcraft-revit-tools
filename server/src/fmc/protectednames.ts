/**
 * Project titles that a tool never writes or saves (research tools 34-41: no hard-coded project name in each guard).
 *
 * The built-in list keeps today's protection (HEBERT HOSTELS). The guard file may add more with
 * never_write_titles: ["..."]; it can only add names, never remove a built-in one, so a config change can't widen access.
 * Matching is a case-insensitive substring test on the title, path and any named document.
 */
export const BUILTIN_NEVER_WRITE: readonly string[] = ["HEBERT HOSTELS"];

/** The names in force: built-ins first, then non-empty strings from guard.never_write_titles (de-duplicated). */
export function neverWriteNames(guard?: unknown): string[] {
  const extra = (guard && typeof guard === "object" ? (guard as { never_write_titles?: unknown }).never_write_titles : undefined);
  const list = Array.isArray(extra) ? extra.filter((name): name is string => typeof name === "string" && name.trim() !== "").map((name) => name.trim()) : [];
  const out: string[] = [];
  for (const name of [...BUILTIN_NEVER_WRITE, ...list]) if (!out.some((seen) => seen.toLowerCase() === name.toLowerCase())) out.push(name);
  return out;
}

/** The first protected name found in any of the parts (title, path, named document), or null. */
export function neverWriteMatch(parts: Array<string | undefined | null>, guard?: unknown): string | null {
  const blob = parts.filter((part) => typeof part === "string").join(" ").toLowerCase();
  if (!blob.trim()) return null;
  for (const name of neverWriteNames(guard)) if (blob.includes(name.toLowerCase())) return name;
  return null;
}
