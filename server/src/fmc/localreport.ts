/**
 * JSON reports for a tool. The directory is under the process LOCALAPPDATA, which tests point at a temp tree.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const win = path.win32;

export function reportHostDir(folder: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = folder.replace(/[^a-z0-9_-]/gi, "") || "fmc";
  if (process.platform === "win32") {
    const user = env.USERPROFILE || env.HOME || os.homedir();
    const local = env.LOCALAPPDATA || win.join(user, "AppData", "Local");
    return win.join(local, "Formcraft", safe);
  }
  const local = env.LOCALAPPDATA;
  if (local && !/^([a-zA-Z]:|\\\\)/.test(local)) return path.join(local, "Formcraft", safe);
  return path.join(os.tmpdir(), "Formcraft", safe);
}

export function writeReport(folder: string, prefix: string, body: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const dir = reportHostDir(folder, env);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${prefix}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

export function writeJsonl(folder: string, prefix: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = reportHostDir(folder, env);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${prefix}-${stamp}.jsonl`);
}
