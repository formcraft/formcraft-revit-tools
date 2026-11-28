/**
 * The verification copies the General AI switch is On for (fmc_ai enable_copy). They live in their own state file,
 * %APPDATA%\Formcraft\ai_copies.json, beside fmc_guard.json and never in it: fmc_guard.json is changed by a person (by hand,
 * or the pane's admin commands), not by an AI session. enable_copy used to write ai_modeller.copies into the guard file,
 * which let an AI session edit it (Emlyn 28 Nov 2026). loadAiConfig reads this file back into ai_modeller.copies.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath } from "./policy.js";

const win = path.win32;

export const GUARD_FILE_WRITE = "FMC-GUARD-FILE-WRITE";

export const copiesFile = (env: NodeJS.ProcessEnv = process.env) => win.join(env.APPDATA || win.join(os.homedir(), "AppData", "Roaming"), "Formcraft", "ai_copies.json");

/** True when the path is fmc_guard.json (the one this process reads, or any file with that name). */
export function isGuardFile(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const n = win.normalize(file).toLowerCase();
  return n === win.normalize(configPath(env)).toLowerCase() || win.basename(n) === "fmc_guard.json";
}

export function readCopies(env: NodeJS.ProcessEnv = process.env): Record<string, { general?: boolean }> {
  try {
    const raw = JSON.parse(fs.readFileSync(copiesFile(env), "utf8").replace(/^\uFEFF/, ""));
    const out: Record<string, { general?: boolean }> = {};
    for (const [k, v] of Object.entries((raw?.copies ?? {}) as Record<string, { general?: boolean }>))
      if (v && typeof v === "object" && v.general === true) out[win.normalize(k)] = { general: true };
    return out;
  } catch { return {}; }
}

/** Records the copy; never touches fmc_guard.json. */
export function addCopy(copyPath: string, env: NodeJS.ProcessEnv = process.env): { file: string } {
  const file = copiesFile(env);
  if (isGuardFile(file, env)) throw new Error(`[${GUARD_FILE_WRITE}] refusing to write ${file}: fmc_guard.json is not written by an AI session`);
  const copies = readCopies(env);
  copies[win.normalize(copyPath)] = { general: true };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ copies, changed: { at: new Date().toISOString(), what: `General AI switch On for verification copy ${win.normalize(copyPath)} only` } }, null, 2));
  return { file };
}
