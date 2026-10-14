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

// ---------- Two or more Revits at once ----------

/** One Revit with the AI connection on, as it announces itself in %APPDATA%\Formcraft\instances\<pid>.json. */
export interface RevitInstance {
  pid: number; port: number; revit: string; user: string; started: string; updated: string; build: string;
  documents: Array<{ title: string; path: string; active: boolean; family: boolean; workshared: boolean }>;
}

export function instancesFolder(env: NodeJS.ProcessEnv = process.env): string { return win.join(win.dirname(connectFile(env)), "instances"); }

export interface InstanceReader { list(dir: string): string[]; read(file: string): string; alive(pid: number): boolean; remove(file: string): void }

export const realReader: InstanceReader = {
  list: (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; } },
  read: (file) => fs.readFileSync(file, "utf8"),
  alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } },
  remove: (file) => { try { fs.unlinkSync(file); } catch { /* someone else cleaned it */ } },
};

/** The Revits that are open now, oldest first. Files of Revits that are gone are cleaned up. */
export function readInstances(env: NodeJS.ProcessEnv = process.env, reader: InstanceReader = realReader): RevitInstance[] {
  const dir = instancesFolder(env);
  const out: RevitInstance[] = [];
  for (const f of reader.list(dir)) {
    const file = win.join(dir, f);
    try {
      const i = JSON.parse(reader.read(file).replace(/^\uFEFF/, "")) as RevitInstance;
      if (!reader.alive(i.pid)) { reader.remove(file); continue; }
      out.push({ ...i, documents: i.documents ?? [] });
    } catch { /* a half-written file: read it next time */ }
  }
  return out.sort((a, b) => a.started.localeCompare(b.started));
}

/** How a Revit is named in messages: its active document (or Home) and port. */
export function label(i: RevitInstance): string {
  const active = i.documents.find((d) => d.active) ?? i.documents[0];
  return `${active ? active.title : "Home screen"} (Revit ${i.revit || "?"}, pid ${i.pid}, port ${i.port}${i.documents.length > 1 ? `, ${i.documents.length} documents` : ""})`;
}

/**
 * Which Revit a call goes to. In order: the call's own `revit` (a document or project name, a pid or a port), the
 * REVIT_PORT of the pane that ran it, the default chosen with fmc_revit use, the only Revit open. With two or more open
 * and nothing chosen it refuses and lists them, rather than guessing which model to change.
 */
export function resolvePort(target: string | undefined, instances: RevitInstance[], env: NodeJS.ProcessEnv, chosen: string | undefined): number {
  const pick = (t: string): number => {
    const q = t.trim().toLowerCase();
    const n = Number(q);
    if (q && Number.isInteger(n)) {
      const byNumber = instances.find((i) => i.pid === n || i.port === n);
      if (byNumber) return byNumber.port;
      if (n >= 1024 && n < 65536 && !instances.length) return n; // a port with no registry (an older add-in)
      throw new Error(`No open Revit has pid or port ${t}. Open: ${instances.map(label).join("; ") || "none"}`);
    }
    const hits = instances.filter((i) => i.documents.some((d) => d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q)));
    if (hits.length === 1) return hits[0].port;
    if (hits.length > 1) throw new Error(`"${t}" matches ${hits.length} Revits: ${hits.map(label).join("; ")}. Use the pid or port.`);
    throw new Error(`No open Revit has a document matching "${t}". Open: ${instances.map(label).join("; ") || "none"}`);
  };
  if (target && target.trim()) return pick(target);
  if (env.REVIT_PORT && Number.isInteger(Number(env.REVIT_PORT))) return Number(env.REVIT_PORT);
  if (chosen && chosen.trim()) return pick(chosen);
  if (instances.length === 1) return instances[0].port;
  if (instances.length > 1)
    throw new Error(`${instances.length} Revits are open: ${instances.map(label).join("; ")}. Say which one: pass revit (a project name, pid or port) to the tool, or call fmc_revit use.`);
  return revitPort(env);
}
