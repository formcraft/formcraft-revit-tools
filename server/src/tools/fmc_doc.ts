import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { SessionRecord, buildReport, openProblems, saveProblems } from "../fmc/doc.js";
import { serverBuild } from "./fmc_selftest.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, false, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

/** The sessions the server knows (each CLI call is its own process): source, opened, ops applied (B1b). */
function ledgerFile(cfg: GuardConfig) { return win.join(expandEnv(cfg.reports_dir), "FMC_Doc_Sessions.json"); }
function readLedger(cfg: GuardConfig): Record<string, SessionRecord> { try { return JSON.parse(fs.readFileSync(ledgerFile(cfg), "utf8")); } catch { return {}; } }
function writeLedger(cfg: GuardConfig, l: Record<string, SessionRecord>) {
  fs.mkdirSync(win.dirname(ledgerFile(cfg)), { recursive: true });
  fs.writeFileSync(ledgerFile(cfg), JSON.stringify(l, null, 2));
}

/** The kit's manifest (FMC_Kit.json) beside the specs, for the build report. */
function kitManifest(cfg: GuardConfig): { kit?: string; revision?: string } {
  let dir = win.dirname(expandEnv(cfg.specs_path));
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(fs.readFileSync(win.join(dir, "FMC_Kit.json"), "utf8").replace(/^﻿/, "")); } catch { dir = win.dirname(dir); }
  }
  return {};
}

export const FMC_DOC_DESCRIPTION =
  "Formcraft asset builder engine (plan B1), sessions. open: a background family from a family template (.rft) in the " +
    "template roots, or a family file in staging (_Staging, _ChainTests); returns a session id and what the document holds. " +
    "report: what an open session holds (category, parameters, types, reference planes, solids, connectors, warnings). " +
    "screenshot: PNGs of its 3D and front views to the reports folder. save: to an .rfa in the write roots under a name " +
    "the naming rules accept, with <name>.build.json beside it. close: discards unsaved changes. Never a project or " +
    "workshared model; sessions idle for 30 minutes close by themselves. The ops that build content come in B1b.";

export const FMC_DOC_SHAPE = {
  action: z.enum(["open", "report", "screenshot", "save", "close", "list"]),
  template: z.string().optional().default("").describe("open: a family template (.rft) in the template roots"),
  file: z.string().optional().default("").describe("open: a family file (.rfa) in the library roots"),
  session: z.string().optional().default(""),
  path: z.string().optional().default("").describe("save: the target .rfa (inside the write roots, named by the rules)"),
  overwrite: z.boolean().optional().default(false).describe("save: replace an existing file (a person decided)"),
};

export type FmcDocArgs = z.infer<z.ZodObject<typeof FMC_DOC_SHAPE>>;

export async function runFmcDoc(args: FmcDocArgs) {
  const { config } = loadConfig();
  try {
    const ledger = readLedger(config);
    if (args.action === "list") return reply({ sessions: Object.values(ledger) });

    if (args.action === "open") {
      const problems = openProblems(args, config);
      if (problems.length) return reply({ refused: true, reasons: problems }, true);
      const r = await withRevitConnection((c) => c.sendRaw("fmc_doc_open", { template: args.template.trim(), file: args.file.trim() }, 120000));
      const id = String(r?.session ?? "");
      ledger[id] = { id, source: args.template.trim() || args.file.trim(), opened: new Date().toISOString(), ops: [] };
      writeLedger(config, ledger);
      log(config, "doc_open", ledger[id].source, "done", id);
      return reply({ session: id, document: r });
    }

    if (!args.session.trim()) return reply({ refused: true, reasons: [`${args.action} needs the session id from open`] }, true);
    const s = ledger[args.session.trim()] ?? { id: args.session.trim(), source: "", opened: "", ops: [] };

    if (args.action === "report") return reply({ session: s.id, document: await withRevitConnection((c) => c.sendRaw("fmc_doc_report", { session: s.id }, 60000)) });

    if (args.action === "screenshot") {
      const folder = win.join(expandEnv(config.reports_dir), "Screenshots");
      const r = await withRevitConnection((c) => c.sendRaw("fmc_doc_screenshot", { session: s.id, folder }, 120000));
      return reply({ session: s.id, files: r?.files ?? [] });
    }

    if (args.action === "close") {
      const r = await withRevitConnection((c) => c.sendRaw("fmc_doc_close", { session: s.id }, 60000));
      delete ledger[s.id];
      writeLedger(config, ledger);
      return reply({ session: s.id, ...r });
    }

    // save
    const problems = saveProblems(args.path, config);
    if (problems.length) return reply({ refused: true, reasons: problems }, true);
    if (fs.existsSync(args.path) && !args.overwrite) return reply({ refused: true, reasons: [`${args.path} exists: a person decides to overwrite (overwrite: true)`] }, true);
    const saved = await withRevitConnection((c) => c.sendRaw("fmc_doc_save", { session: s.id, path: args.path.trim(), overwrite: args.overwrite, max_backups: config.max_backups }, 120000));
    const report = await withRevitConnection((c) => c.sendRaw("fmc_doc_report", { session: s.id }, 60000));
    const build = buildReport(s, args.path.trim(), report ?? {}, kitManifest(config), serverBuild().commit, new Date());
    const buildFile = args.path.trim().replace(/\.rfa$/i, ".build.json");
    fs.writeFileSync(buildFile, JSON.stringify(build, null, 2));
    log(config, "doc_save", args.path, "done", `${s.id} · ${build.ops.length} ops · ${build.ops_hash}`);
    return reply({ saved: saved?.saved ?? args.path, build_report: buildFile, build });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "doc_" + args.action, args.session || args.template || args.file, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcDocTool(server: McpServer) {
  server.tool("fmc_doc", FMC_DOC_DESCRIPTION, FMC_DOC_SHAPE, (args) => runFmcDoc(args));
}
