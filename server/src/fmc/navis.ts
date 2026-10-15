/**
 * Track N (Navisworks Manage): the client for the Formcraft bridge inside Navisworks (connectors/navisworks). One JSON
 * request per line to 127.0.0.1:<port>, one JSON reply per line. The bridge writes its port to %APPDATA%\Formcraft\navis.json.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface NavisState { port: number; pid: number; started: string }

export function stateFile(): string {
  return path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"), "Formcraft", "navis.json");
}

export function readState(file = stateFile()): NavisState | null {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return Number.isInteger(s.port) && s.port > 0 ? s : null;
  } catch {
    return null;
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

let nextId = 1;

/** One request to the bridge; rejects with the bridge's error text, or when Navisworks doesn't answer in time. */
export function navisCall(port: number, method: string, params: object = {}, timeoutMs = 120000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const sock = net.connect({ host: "127.0.0.1", port });
    let buf = "";
    const done = (fn: () => void) => { clearTimeout(timer); sock.destroy(); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error(`Navisworks didn't answer ${method} within ${Math.round(timeoutMs / 1000)} s`))), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id, method, params }) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        if (reply.error) done(() => reject(new Error(String(reply.error))));
        else done(() => resolve((reply.result ?? {}) as Record<string, unknown>));
      } catch {
        done(() => reject(new Error("The bridge's reply isn't JSON")));
      }
    });
    sock.on("error", (e) => done(() => reject(new Error(`Can't reach the Formcraft bridge in Navisworks on port ${port}: ${e.message}`))));
  });
}

export interface ClashItem { name: string; category: string; revit_id: string; source: string }
export interface ClashRow { name: string; status: string; distance_mm: number; item1: ClashItem; item2: ClashItem }

/**
 * Clashes grouped by the pair of source models and categories, largest first: what a coordination meeting reads first.
 * A clash inside one model is its author's alone; between two models it needs both disciplines.
 */
export function groupClashes(rows: ClashRow[]) {
  const file = (s: string) => path.win32.basename(s || "(unknown model)");
  const groups = new Map<string, { models: string[]; categories: string[]; count: number; deepest_mm: number; within_one_model: boolean }>();
  for (const r of rows) {
    const a = { m: file(r.item1?.source), c: r.item1?.category || "?" }, b = { m: file(r.item2?.source), c: r.item2?.category || "?" };
    const [x, y] = `${a.m}|${a.c}` <= `${b.m}|${b.c}` ? [a, b] : [b, a];
    const key = `${x.m}|${x.c}|${y.m}|${y.c}`;
    const g = groups.get(key) ?? { models: [x.m, y.m], categories: [x.c, y.c], count: 0, deepest_mm: 0, within_one_model: x.m === y.m };
    g.count++;
    g.deepest_mm = Math.min(g.deepest_mm, Number.isFinite(r.distance_mm) ? r.distance_mm : 0);
    groups.set(key, g);
  }
  return [...groups.values()].sort((p, q) => q.count - p.count || p.deepest_mm - q.deepest_mm);
}
