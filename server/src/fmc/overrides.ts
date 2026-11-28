/**
 * The project's standards overrides (01_WIP\FMC_Project_Standards.json): reading them without losing them.
 *
 * A missing file means no overrides yet. A file that is there but does not parse (a bad edit, a half-synced copy, not a
 * JSON object) is never treated as empty: `fmc_standards set` used to read it as null, build a new file from the one
 * key and write it over the top, so every other override was lost with no word. Now the write is refused and the
 * file is left exactly as it is.
 */
import fs from "node:fs";
import path from "node:path";

export const STANDARDS_OVERRIDES_PARSE = "FMC-STANDARDS-OVERRIDES-PARSE";

export type OverridesRead =
  | { state: "missing" }
  | { state: "ok"; data: Record<string, unknown> }
  | { state: "unparseable"; error: string };

/** Text of the file (null when there is no file) to what it holds. A leading BOM is ignored. Only a JSON object is accepted. */
export function parseOverrides(text: string | null): OverridesRead {
  if (text === null) return { state: "missing" };
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    return { state: "unparseable", error: e instanceof Error ? e.message : String(e) };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { state: "unparseable", error: `the file holds JSON ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}, not an object of overrides` };
  }
  return { state: "ok", data: value as Record<string, unknown> };
}

/** Reads the overrides file. A read error other than "no such file" (locked, no access) is reported, not read as empty. */
export function readOverridesFile(file: string): OverridesRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "missing" };
    return { state: "unparseable", error: `could not read the file: ${e instanceof Error ? e.message : String(e)}` };
  }
  return parseOverrides(text);
}

/** The isError body for a refused write. */
export function overridesParseRefusal(file: string, error: string) {
  return {
    refused: true,
    code: STANDARDS_OVERRIDES_PARSE,
    file,
    parse_error: error,
    message: `[${STANDARDS_OVERRIDES_PARSE}] ${file} is there but is not valid JSON (${error}). Nothing was written, so the other overrides in it are untouched. ` +
      "Fix or restore the file (a person, or from the project's backup), then set the value again.",
  };
}

export type SetOverrideResult =
  | { ok: true; set: string; value: unknown; file: string }
  | { ok: false; body: ReturnType<typeof overridesParseRefusal> };

/** Adds or replaces one override and writes the file. An unparseable file is refused and left untouched. */
export function setOverride(file: string, key: string, value: unknown, note?: string): SetOverrideResult {
  const current = readOverridesFile(file);
  if (current.state === "unparseable") return { ok: false, body: overridesParseRefusal(file, current.error) };
  const base = current.state === "ok" ? current.data : {};
  const next = { ...base, [key]: { value, ...(note ? { note } : {}), status: "project" } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return { ok: true, set: key, value, file };
}
