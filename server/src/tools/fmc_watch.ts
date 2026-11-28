import fs from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, configPath, expandEnv, loadConfig } from "../fmc/policy.js";
import {
  filterLedger, isReviewPath, joinLike, ledgerFileProblem, ledgerFilesFor, ledgerName, parseLedger, summarize, type Bucket, type LedgerFilter,
} from "../fmc/watch.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError };
}

export const FMC_WATCH_DESCRIPTION =
  "Formcraft: a change ledger for an open project model. start registers a read-only updater and a DocumentChanged hook on " +
  "ONE document (document is required) and appends every change to a JSONL ledger: time, user, element id, category, change " +
  "type (added, deleted, geometry, parameter, modified), transaction names and the undo operation. stop unregisters them " +
  "(also when the document closes) and returns a summary. status lists the running watches and the ledger files. read " +
  "returns ledger rows (newest last, limit 100, max 500) and summary groups them by user, category, change type, " +
  "transaction and time (bucket hour or day), both with since, until, user, category, change_type, element_id filters. " +
  "The model is never changed: no transaction, nothing saved or synchronised. The ledger goes to " +
  "<project_folder>\\06_QA\\Watch where the guard allows a write there, else <reports_dir>\\Watch (the same guard as " +
  "fmc_warnings), and never to a review folder or register, and nothing is sent over a network. scope model (default) " +
  "watches model categories plus levels, grids, rooms and areas; scope all adds annotation and view elements (noisy). " +
  "A deleted element's category is only known if it was seen after start, otherwise it shows as (unknown). " +
  "Example: action start, document F26901-FMC-ZZ-ZZ-M3-A-0002_USER, project_folder D:\\Projects\\F26901.";

export const FMC_WATCH_SHAPE = {
  action: z.enum(["start", "stop", "status", "read", "summary"]),
  document: z.string().optional().default("").describe("The model's title or full path. Required for start, stop (unless all), read and summary (unless file)."),
  project_folder: z.string().optional().default("").describe("The project folder, for the ledger in 06_QA\\Watch where the guard allows"),
  scope: z.enum(["model", "all"]).optional().default("model"),
  all: z.boolean().optional().default(false).describe("stop: every running watch"),
  file: z.string().optional().default("").describe("read, summary: a ledger file (.jsonl inside a Watch folder)"),
  since: z.string().optional(),
  until: z.string().optional(),
  user: z.string().optional(),
  category: z.string().optional(),
  change_type: z.string().optional(),
  element_id: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
  bucket: z.enum(["hour", "day"]).optional().default("hour"),
  top: z.number().int().min(1).max(100).optional().default(15),
};

export type FmcWatchArgs = z.infer<z.ZodObject<typeof FMC_WATCH_SHAPE>>;

export interface WatchIo {
  send?: (body: Record<string, unknown>) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  guard?: GuardConfig;
  now?: () => Date;
}

function refuse(code: string, message: string) {
  return reply({ tool: "fmc_watch", model_changed: false, refused: true, code, message }, true);
}

/** <project>\06_QA\Watch if the guard allows a write there (and it is not a review folder), else why not. */
function projectDir(project: string, config: GuardConfig): { dir?: string; why?: string } {
  const p = project.trim();
  if (!p) return { why: "no project_folder was given" };
  const dir = joinLike(p, "06_QA", "Watch");
  if (isReviewPath(dir)) return { why: "that is a review folder" };
  const verdict = checkWritePath(joinLike(dir, "FMC_Watch_probe.jsonl"), config, { checkName: false });
  return verdict.ok ? { dir } : { why: verdict.reasons.join("; ") };
}

function readDirs(project: string, config: GuardConfig, env: NodeJS.ProcessEnv): string[] {
  const dirs: string[] = [];
  if (project.trim()) { const d = joinLike(project.trim(), "06_QA", "Watch"); if (!isReviewPath(d)) dirs.push(d); }
  dirs.push(joinLike(expandEnv(config.reports_dir, env), "Watch"));
  return dirs;
}

function filterOf(args: FmcWatchArgs): LedgerFilter {
  return { since: args.since, until: args.until, user: args.user, category: args.category, change_type: args.change_type, element_id: args.element_id };
}

function ledgerFiles(args: FmcWatchArgs, config: GuardConfig, env: NodeJS.ProcessEnv): { files: string[]; problem?: string } {
  if (args.file.trim()) {
    const problem = ledgerFileProblem(args.file);
    return problem ? { files: [], problem } : { files: [args.file.trim()] };
  }
  if (!args.document.trim()) return { files: [], problem: "document is required (or name a ledger file)" };
  const files = readDirs(args.project_folder, config, env).flatMap((d) => ledgerFilesFor(d, args.document));
  return files.length ? { files } : { files: [], problem: `no ledger found for ${args.document} (start a watch first)` };
}

function load(files: string[]) {
  const rows: ReturnType<typeof parseLedger>["rows"] = [];
  let bad = 0;
  const unreadable: string[] = [];
  for (const f of files) {
    try {
      const r = parseLedger(fs.readFileSync(f, "utf8"));
      rows.push(...r.rows); bad += r.bad;
    } catch (e) { unreadable.push(`${f}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { rows, bad, unreadable };
}

export async function runFmcWatch(args: FmcWatchArgs, io: WatchIo = {}) {
  const env = io.env ?? process.env;
  try {
    const config = io.guard ?? loadConfig(configPath(env)).config;
    const send = io.send ?? ((body: Record<string, unknown>) => withRevitConnection((client) => client.sendCommand("fmc_watch", body, 60000)));
    const document = args.document.trim();

    if (args.action === "read" || args.action === "summary") {
      const found = ledgerFiles(args, config, env);
      if (found.problem) return refuse("FMC-WATCH-LEDGER", found.problem);
      const { rows, bad, unreadable } = load(found.files);
      if (unreadable.length && !rows.length) return refuse("FMC-WATCH-LEDGER", `The ledger could not be read: ${unreadable.join("; ")}`);
      const base = { tool: "fmc_watch", action: args.action, model_changed: false, files: found.files, bad_lines: bad, unreadable };
      if (args.action === "summary") return reply({ ...base, summary: summarize(rows, filterOf(args), { top: args.top, bucket: args.bucket as Bucket }) });
      const matching = filterLedger(rows, filterOf(args));
      return reply({ ...base, matching: matching.length, shown: Math.min(args.limit, matching.length), rows: matching.slice(-args.limit) });
    }

    if (args.action === "status") {
      const live = await send({ action: "status" }) as Record<string, unknown> | undefined;
      if (!live || typeof live !== "object" || !Array.isArray(live.watches)) return refuse("FMC-WATCH-BAD-REPLY", "Revit's reply had no watches list. That is an error, not 'nothing is watched'.");
      const ledgers = readDirs(args.project_folder, config, env).flatMap((d) => !fs.existsSync(d) ? [] : fs.readdirSync(d).filter((n) => /^FMC_Watch_.*\.jsonl$/i.test(n)).map((n) => {
        const f = joinLike(d, n);
        return { file: f, bytes: fs.statSync(f).size };
      }));
      return reply({ tool: "fmc_watch", action: "status", model_changed: false, watching: live.watching, watches: live.watches, ledgers });
    }

    if (args.action === "stop") {
      if (!args.all && !document) return refuse("FMC-DOC-REQUIRED", "document is required: name the model (title or full path), or pass all true.");
      const r = await send({ action: "stop", document, all: args.all }) as Record<string, unknown> | undefined;
      if (!r || typeof r !== "object") return refuse("FMC-WATCH-BAD-REPLY", "Revit's reply could not be read.");
      const files = args.all ? (Array.isArray(r.stopped) ? (r.stopped as Array<{ file?: string }>).map((s) => s.file ?? "") : []) : [String(r.file ?? "")];
      const summaries = files.filter((f) => f && !ledgerFileProblem(f) && fs.existsSync(f)).map((f) => ({ file: f, summary: summarize(parseLedger(fs.readFileSync(f, "utf8")).rows, {}, { top: args.top, bucket: args.bucket as Bucket }) }));
      return reply({ tool: "fmc_watch", model_changed: false, ...r, summaries });
    }

    // start
    if (!document) return refuse("FMC-DOC-REQUIRED", "document is required: name the model (title or full path).");
    const project = projectDir(args.project_folder, config);
    const dir = project.dir ?? joinLike(expandEnv(config.reports_dir, env), "Watch");
    const file = joinLike(dir, ledgerName(document, (io.now ? io.now() : new Date())));
    const problem = ledgerFileProblem(file);
    if (problem) return refuse("FMC-WATCH-FILE", problem);
    const r = await send({ action: "start", document, file, scope: args.scope }) as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object" || r.running !== true) return refuse("FMC-WATCH-BAD-REPLY", "Revit did not confirm the watch is running. Nothing is being recorded.");
    const notes: string[] = [];
    if (args.project_folder.trim() && !project.dir) notes.push(`Not written to the project folder: ${project.why}. The ledger is in the reports folder.`);
    return reply({ tool: "fmc_watch", model_changed: false, where: project.dir ? "project" : "reports", ...r, notes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refuse(message.match(/FMC-[A-Z0-9-]+/)?.[0] ?? "FMC-WATCH", message);
  }
}

export function registerFmcWatchTool(server: McpServer) {
  server.tool("fmc_watch", FMC_WATCH_DESCRIPTION, FMC_WATCH_SHAPE, async (args) => runFmcWatch(args as FmcWatchArgs));
}
