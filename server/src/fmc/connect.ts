import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const win = path.win32;

/**
 * The AI connection's settings, shared with the Revit add-in: %APPDATA%\Formcraft\fmc_connect.json
 * ({ "start_with_revit": true, "port": 8080 }). The add-in listens on 127.0.0.1 only, so the server connects there.
 * REVIT_PORT overrides the file (for tests and odd setups).
 */
export const DEFAULT_PORT = 8080;
export const HOST = "127.0.0.1";

export function connectFile(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA || win.join(os.homedir(), "AppData", "Roaming");
  return win.join(appData, "Formcraft", "fmc_connect.json");
}

export function revitPort(env: NodeJS.ProcessEnv = process.env, read: (p: string) => string = (p) => fs.readFileSync(p, "utf8")): number {
  const ok = (n: number) => Number.isInteger(n) && n > 0 && n < 65536;
  const fromEnv = Number(env.REVIT_PORT);
  if (env.REVIT_PORT && ok(fromEnv)) return fromEnv;
  try {
    const port = Number(JSON.parse(read(connectFile(env)).replace(/^﻿/, "")).port);
    return ok(port) ? port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

/** What to tell the person (or the AI app) when nothing in Revit is listening. */
export function notListening(port: number): string {
  return `connect to revit client failed: nothing in Revit is listening on ${HOST}:${port}. ` +
    "In Revit, open a project, then on the Formcraft tab › Core click the button that reads \"AI: off\" (it turns to \"AI: on\"). " +
    "To have it on every time Revit starts, set start_with_revit to true in %APPDATA%\\Formcraft\\fmc_connect.json " +
    "(or Connect › \"Switch on when Revit starts\" in the Formcraft pane). Only one Revit window can hold the connection.";
}
