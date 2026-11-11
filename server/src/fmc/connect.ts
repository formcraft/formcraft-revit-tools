import fs from "node:fs";
import net from "node:net";
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
/** What a short TCP probe of a Revit port found. `reset` is the half-closed listener that used to surface as ECONNRESET. */
export type ProbeVerdict = "ok" | "reset" | "refused" | "timeout";

export interface PortCheck {
  /** Already-known result for the port resolvePort selected. Production probes first, then passes the verdict in. */
  probe: (port: number) => ProbeVerdict;
  /** Drop a stale instance file so the next call does not keep using it. */
  forget?: (instance: RevitInstance) => void;
}

/** The error a caller sees instead of a raw ECONNRESET when the instance file names a port that is not accepting. */
export function stalePortMessage(port: number, verdict: ProbeVerdict, instance?: RevitInstance): string {
  const where = `${HOST}:${port}`;
  const who = instance
    ? `Revit pid ${instance.pid} advertises ${where} in its instance file`
    : `Port ${where} was selected`;
  const why = verdict === "reset"
    ? "the connection was reset (ECONNRESET). That file is stale: the listener was left half-closed."
    : verdict === "timeout"
      ? "it did not answer in time. That file is stale."
      : "nothing is accepting connections there. That file is stale.";
  return `${who}, but ${why} In Revit, on the Formcraft tab turn AI off and on so it listens again.`;
}

/** Delete one Revit's instance file. The port it advertised was not accepting. */
export function forgetInstance(instance: RevitInstance, env: NodeJS.ProcessEnv = process.env): void {
  realReader.remove(win.join(instancesFolder(env), `${instance.pid}.json`));
}

/**
 * Open a TCP connection to host:port. `ok` only if it stays open briefly. A listener that accepts and then
 * resets (the half-dead Revit socket) is `reset`, not success.
 */
export function probePort(host: string, port: number, timeoutMs = 400): Promise<ProbeVerdict> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    let connected = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = (verdict: ProbeVerdict) => {
      if (settled) return;
      settled = true;
      if (grace) clearTimeout(grace);
      socket.removeAllListeners();
      socket.destroy();
      resolve(verdict);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      connected = true;
      grace = setTimeout(() => finish("ok"), 80);
    });
    socket.on("timeout", () => finish(connected ? "reset" : "timeout"));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET") finish("reset");
      else finish(connected ? "reset" : "refused");
    });
    socket.on("close", () => { if (connected) finish("reset"); });
  });
}

export function resolvePort(target: string | undefined, instances: RevitInstance[], env: NodeJS.ProcessEnv, chosen: string | undefined, check?: PortCheck): number {
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
  const selected = (): number => {
    if (target && target.trim()) return pick(target);
    if (env.REVIT_PORT && Number.isInteger(Number(env.REVIT_PORT))) return Number(env.REVIT_PORT);
    if (chosen && chosen.trim()) return pick(chosen);
    if (instances.length === 1) return instances[0].port;
    if (instances.length > 1)
      throw new Error(`${instances.length} Revits are open: ${instances.map(label).join("; ")}. Say which one: pass revit (a project name, pid or port) to the tool, or call fmc_revit use.`);
    return revitPort(env);
  };
  return confirmPort(selected(), instances, check);
}

function confirmPort(port: number, instances: RevitInstance[], check: PortCheck | undefined): number {
  if (!check) return port;
  const verdict = check.probe(port);
  if (verdict === "ok") return port;
  const owner = instances.find((i) => i.port === port);
  if (owner) check.forget?.(owner);
  throw new Error(stalePortMessage(port, verdict, owner));
}
