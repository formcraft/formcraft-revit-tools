import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { expandEnv, loadConfig } from "../fmc/policy.js";
import {
  DEFAULTS, DirFact, FileFact, FsLike, History, Options, addSample, analyze, gather, historyKey, normalizeFacts, parseHistory,
} from "../fmc/centralhealth.js";

const win = path.win32;

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

/** Metadata only: size and modified time. No file is opened, read, copied, moved or written. */
export function realFs(): FsLike {
  const fact = (p: string, s: fs.Stats): FileFact => ({ path: p, name: win.basename(p), size_bytes: s.size, mtime_ms: s.mtimeMs });
  return {
    stat(p) {
      try {
        const s = fs.statSync(p);
        return s.isFile() ? fact(p, s) : null;
      } catch {
        return null;
      }
    },
    list(dir, recursive, max): DirFact {
      const files: FileFact[] = [];
      let truncated = false;
      try {
        if (!fs.statSync(dir).isDirectory()) return { dir, exists: false, files, truncated };
      } catch {
        return { dir, exists: false, files, truncated };
      }
      const stack = [dir];
      while (stack.length && !truncated) {
        const d = stack.pop() as string;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const full = win.join(d, e.name);
          if (e.isDirectory()) { if (recursive) stack.push(full); continue; }
          try {
            if (!e.isFile()) continue;
            files.push(fact(full, fs.statSync(full)));
          } catch { continue; }
          if (files.length >= max) { truncated = true; break; }
        }
      }
      return { dir, exists: true, files, truncated };
    },
  };
}

export const FMC_CENTRAL_HEALTH_DESCRIPTION =
  "Formcraft central model health, read-and-plan only. Reports the central file's size and its growth over time (from a small " +
  "history file this tool keeps), the central's backup folder (state, file count, total size, newest and oldest), stale local " +
  "copies (<central>_<user>.rvt not touched for stale_days), and borrowed worksets and elements by owner (from the open model's " +
  "workshare facts). It ends with a plan for a scheduled audit and compact, plus reviews of stale locals, backups and borrowed " +
  "worksets. The plan is for a person: every line says needs_person true and executed_by_tool false. This tool never runs an " +
  "audit, a compact, a sync or a relinquish, never deletes a backup, and never opens, copies or saves a model file (it reads file " +
  "size and date only). dry_run defaults to true: nothing is written. With record true and dry_run false it adds one size sample " +
  "to FMC_CentralHealth_History.json in the reports folder so growth can be judged on later days.";

export const FMC_CENTRAL_HEALTH_SHAPE = {
  central_path: z.string().optional().default("").describe("The central model file. Empty: read from the open workshared model in Revit"),
  backup_dir: z.string().optional().default("").describe("The backup folder. Empty: <central folder>\\<central name>_backup"),
  local_dirs: z.array(z.string()).optional().default([]).describe("Folders to look in for local copies (<central>_<user>.rvt); not searched recursively"),
  stale_days: z.number().optional().default(DEFAULTS.stale_days).describe("A local not touched for this many days is stale"),
  growth_warn_pct: z.number().optional().default(DEFAULTS.growth_warn_pct).describe("Warn when the central grew at least this % inside growth_window_days"),
  growth_window_days: z.number().optional().default(DEFAULTS.growth_window_days),
  central_warn_mb: z.number().optional().default(DEFAULTS.central_warn_mb),
  central_act_mb: z.number().optional().default(DEFAULTS.central_act_mb),
  backup_warn_gb: z.number().optional().default(DEFAULTS.backup_warn_gb),
  backup_warn_count: z.number().optional().default(DEFAULTS.backup_warn_count),
  backup_quiet_days: z.number().optional().default(DEFAULTS.backup_quiet_days),
  audit_every_days: z.number().optional().default(DEFAULTS.audit_every_days),
  compact_every_days: z.number().optional().default(DEFAULTS.compact_every_days),
  last_audit: z.string().optional().default("").describe("When a person last audited the central (ISO date). Blank: none on record"),
  last_compact: z.string().optional().default("").describe("When a person last compacted the central (ISO date). Blank: none on record"),
  use_revit: z.boolean().optional().default(true).describe("Read workset owners and the central path from the open model (read-only). false: file checks only"),
  record: z.boolean().optional().default(false).describe("Add today's size to the growth history. Only when dry_run is false"),
  dry_run: z.boolean().optional().default(true),
};

export type FmcCentralHealthArgs = z.infer<z.ZodObject<typeof FMC_CENTRAL_HEALTH_SHAPE>>;

export interface CentralHealthDeps {
  fsl?: FsLike;
  now?: () => number;
  /** Revit's workshare facts; the default asks the open model (read-only fmc_workshare_facts). */
  facts?: () => Promise<unknown>;
  /** Folder for the history file; the default is the guard config's reports_dir. */
  reportsDir?: string;
}

export async function runFmcCentralHealth(args: FmcCentralHealthArgs, deps: CentralHealthDeps = {}) {
  const dry = args.dry_run !== false;
  const nowMs = (deps.now ?? Date.now)();
  const fsl = deps.fsl ?? realFs();
  try {
    let rawFacts: unknown = null;
    if (args.use_revit !== false) {
      try {
        rawFacts = await (deps.facts ? deps.facts() : withRevitConnection((c) => c.sendRaw("fmc_workshare_facts", {}, 60000)));
      } catch {
        rawFacts = null; // Revit not reachable: the file checks still work
      }
    }
    const facts = normalizeFacts(rawFacts);

    const g = gather(fsl, { central_path: args.central_path, backup_dir: args.backup_dir, local_dirs: args.local_dirs }, facts);
    const reportsDir = deps.reportsDir ?? expandEnv(loadConfig().config.reports_dir);
    const historyFile = path.join(reportsDir, "FMC_CentralHealth_History.json"); // native: reports_dir is a Windows path on the PC
    let history: History = {};
    try { history = parseHistory(fs.readFileSync(historyFile, "utf8")); } catch { /* none yet */ }
    const key = historyKey(g.central_path);

    const options: Options = {
      stale_days: args.stale_days, growth_warn_pct: args.growth_warn_pct, growth_window_days: args.growth_window_days,
      central_warn_mb: args.central_warn_mb, central_act_mb: args.central_act_mb, backup_warn_gb: args.backup_warn_gb,
      backup_warn_count: args.backup_warn_count, backup_quiet_days: args.backup_quiet_days, audit_every_days: args.audit_every_days,
      compact_every_days: args.compact_every_days, last_audit: args.last_audit, last_compact: args.last_compact,
    };
    const report = analyze({ nowMs, gathered: g, facts, history: history[key] ?? [], options });

    // The one thing this tool can write: a size sample, only with record true and dry_run false.
    const sample = g.central ? { at: new Date(nowMs).toISOString(), size_bytes: g.central.size_bytes } : null;
    let history_record: Record<string, unknown>;
    if (!args.record) history_record = { requested: false, note: "Growth needs a history: run with record true and dry_run false now and on later days" };
    else if (!sample) history_record = { requested: true, recorded: false, reason: "No central file size to record" };
    else if (dry) history_record = { requested: true, dry_run: true, recorded: false, would_record: sample, file: historyFile, next: "Run again with dry_run=false" };
    else {
      const next = addSample(history, key, sample);
      if (!next.added) history_record = { requested: true, recorded: false, reason: "The last sample is the same size and under 6 hours old", file: historyFile };
      else {
        fs.mkdirSync(reportsDir, { recursive: true });
        fs.writeFileSync(historyFile, JSON.stringify(next.history, null, 2));
        history_record = { requested: true, recorded: true, sample, file: historyFile };
      }
    }

    return reply({ dry_run: dry, read_and_plan_only: true, ...report, history_record });
  } catch (error) {
    return reply({ refused: true, reasons: [error instanceof Error ? error.message : String(error)] }, true);
  }
}

export function registerFmcCentralHealthTool(server: McpServer) {
  server.tool("fmc_central_health", FMC_CENTRAL_HEALTH_DESCRIPTION, FMC_CENTRAL_HEALTH_SHAPE, (args) => runFmcCentralHealth(args as FmcCentralHealthArgs));
}
