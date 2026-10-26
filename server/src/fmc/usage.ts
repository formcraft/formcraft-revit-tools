/**
 * Tool-call facts (owner 26 Oct): every MCP tool call is timed by the server itself, with no AI and no cost, so an AI
 * writing its own experience report can say what changed between builds ("approvals took 3 steps, now 1; placing doors
 * went from 41 s to 12 s"). The report is the AI's own words; these are only the facts. One JSON line per call in
 * %APPDATA%\Formcraft\ai_usage.jsonl, rotated at 5 MB. Recording never blocks or breaks a tool.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const win = path.win32;
export interface UsageLine { at: string; tool: string; action: string; ms: number; ok: boolean; build: string }

export const usageFile = (env: NodeJS.ProcessEnv = process.env) =>
  win.join(env.APPDATA || win.join(os.homedir(), "AppData", "Roaming"), "Formcraft", "ai_usage.jsonl");

export function recordUsage(line: UsageLine, env: NodeJS.ProcessEnv = process.env) {
  try {
    const f = usageFile(env);
    fs.mkdirSync(win.dirname(f), { recursive: true });
    try { if (fs.statSync(f).size > 5 * 1024 * 1024) fs.renameSync(f, f.replace(/\.jsonl$/, `.${Date.now()}.jsonl`)); } catch { /* new file */ }
    fs.appendFileSync(f, JSON.stringify(line) + "\n");
  } catch { /* the facts are a help, never a reason for a tool to fail */ }
}

export function readUsage(env: NodeJS.ProcessEnv = process.env): UsageLine[] {
  try {
    return fs.readFileSync(usageFile(env), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as UsageLine; } catch { return null; } }).filter((x): x is UsageLine => !!x);
  } catch { return []; }
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Calls, median time and failures per tool and action, per build (newest build first), since a time. */
export function summariseUsage(lines: UsageLine[], since?: string) {
  const rows = since ? lines.filter((l) => l.at >= since) : lines;
  const builds = [...new Set(rows.map((l) => l.build))];
  const lastSeen = (b: string) => rows.filter((l) => l.build === b).reduce((m, l) => (l.at > m ? l.at : m), "");
  builds.sort((a, b) => lastSeen(b).localeCompare(lastSeen(a)));
  return {
    calls: rows.length, since: since ?? rows[0]?.at ?? null,
    by_build: builds.map((b) => {
      const mine = rows.filter((l) => l.build === b);
      const keys = [...new Set(mine.map((l) => `${l.tool}${l.action ? " " + l.action : ""}`))];
      return {
        build: b, calls: mine.length, failures: mine.filter((l) => !l.ok).length, first: mine[0]?.at, last: lastSeen(b),
        tools: keys.map((k) => {
          const x = mine.filter((l) => `${l.tool}${l.action ? " " + l.action : ""}` === k);
          return { tool: k, calls: x.length, median_ms: median(x.map((l) => l.ms)), failures: x.filter((l) => !l.ok).length };
        }).sort((a, b) => b.calls - a.calls),
      };
    }),
  };
}
