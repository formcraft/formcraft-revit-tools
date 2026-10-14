import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { AUDIENCES, KINDS, PERIODS, SECTIONS, Sources, buildReport, reportCsv, reportName } from "../fmc/report.js";
import { Register } from "../fmc/review.js";
import { csvRow } from "./fmc_sheets.js";

const win = path.win32;

function log(cfg: GuardConfig, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), "report", false, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

const readCsv = (file: string): string[][] => {
  try { return fs.readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).map(csvRow); } catch { return []; }
};
const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; } };

/** Everything a report reads: files the plugin already keeps, in the project and the reports folder. */
export function readSources(cfg: GuardConfig, projectFolder: string): Sources {
  const reports = expandEnv(cfg.reports_dir);
  const wip = win.join(projectFolder, "01_WIP");
  const issueDir = win.join(wip, "_Issue");
  let issueFolders: string[] = [];
  try { issueFolders = fs.readdirSync(issueDir).filter((f) => /^\d{4}-\d{2}-\d{2}_/.test(f)); } catch { issueFolders = []; }
  const exceptionsFile = [win.join(issueDir, "FMC_Issue_Exceptions.csv"), win.join(reports, "FMC_Issue_Exceptions.csv")].find((f) => fs.existsSync(f)) ?? "";
  const syncFile = [win.join(wip, "FMC_Sync_Log.csv"), win.join(reports, "FMC_Sync_Log.csv")].find((f) => fs.existsSync(f)) ?? "";
  return {
    qa: readJson(win.join(reports, "FMC_QA_History.json"), {}),
    reviews: readJson<Register | null>(win.join(wip, "_Reviews", "FMC_Review_Register.json"), null),
    // The sync log has a user column; reports never read it (counts per model, MAN 14.5).
    syncs: readCsv(syncFile).slice(1).map((r) => ({ at: r[0] ?? "", model: r[1] ?? "", message: r[3] ?? "" })),
    issues: issueFolders.map((f) => {
      const [date, revision] = [f.slice(0, 10), f.slice(11)];
      let result = "No readiness report";
      try {
        const md = fs.readdirSync(win.join(issueDir, f)).find((x) => /_Readiness_.*\.md$/i.test(x));
        if (md) result = /\*\*(Ready with exceptions|Ready|Blocked)\.\*\*/.exec(fs.readFileSync(win.join(issueDir, f, md), "utf8"))?.[1] ?? "See the report";
      } catch { /* folder unreadable */ }
      return { folder: f, date, revision, result };
    }),
    exceptions: readCsv(exceptionsFile).slice(1).map((r) => ({ recorded: r[0] ?? "", sheet: r[1] ?? "", item: r[2] ?? "", why: r[3] ?? "", approved_by: r[4] ?? "", until: r[5] ?? "" })),
    log: readCsv(win.join(reports, "FMC_MCP_FileLog.csv")).slice(1).map((r) => ({ at: r[0] ?? "", action: r[1] ?? "", result: r[4] ?? "" })),
  };
}

export const FMC_REPORT_DESCRIPTION =
  "Formcraft reports, traced to the plugin's own saved files (MAN 13.1): Weekly project report, Model health and QA, " +
    "Review register, Sync log and workshare, Ready to issue record, Rule exceptions, Activity log. Period: Last 7 days, " +
    "Since last issue, This month, Whole project. For Team, Client (names, logs and internal notes left out) or BIM " +
    "Manager. Syncs and activity are counted per model and action, never per person (MAN 14.5). make with dry_run (default) " +
    "returns the report's text; dry_run false writes Markdown and a tidy CSV for Power BI, named by the container rules " +
    "(…-RP-Z-NNNN), into <project>\\01_WIP\\_Reports\\<date>. list shows recent reports. Never reads or changes a model.";

export const FMC_REPORT_SHAPE = {
  action: z.enum(["make", "list"]),
  project_folder: z.string(),
  project_code: z.string().optional().default(""),
  originator: z.string().optional().default("FMC"),
  kind: z.enum(KINDS).optional().default("Weekly project report"),
  period: z.enum(PERIODS).optional().default("Last 7 days"),
  audience: z.enum(AUDIENCES).optional().default("Team"),
  disciplines: z.array(z.string()).optional().default([]),
  formats: z.array(z.enum(["markdown", "csv"])).optional().default(["markdown", "csv"]),
  dry_run: z.boolean().optional().default(true),
};

export type FmcReportArgs = z.infer<z.ZodObject<typeof FMC_REPORT_SHAPE>>;

export async function runFmcReport(args: FmcReportArgs) {
  const { config } = loadConfig();
  try {
    const folder = args.project_folder.trim();
    if (!folder) return reply({ refused: true, reasons: ["Set the project folder: reports read its files and are saved in its 01_WIP"] }, true);
    const root = win.join(folder, "01_WIP", "_Reports");
    if (args.action === "list") {
      const out: Array<{ file: string; date: string }> = [];
      try {
        for (const d of fs.readdirSync(root).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).sort().reverse().slice(0, 10))
          for (const f of fs.readdirSync(win.join(root, d)).filter((x) => x.endsWith(".md"))) out.push({ file: win.join(root, d, f), date: d });
      } catch { /* no reports yet */ }
      return reply({ reports: out.slice(0, 20) });
    }
    const code = args.project_code.trim().toUpperCase() || win.basename(folder).split("_")[0].toUpperCase();
    const today = new Date().toISOString().slice(0, 10);
    const built = buildReport(args.kind, readSources(config, folder), { project: code, period: args.period, audience: args.audience, disciplines: args.disciplines, today });
    if (args.dry_run !== false)
      return reply({ dry_run: true, title: built.title, sections: SECTIONS[args.kind], left_out: built.left_out, preview: built.markdown,
        next: "Run again with dry_run=false to save it" });

    const dir = win.join(root, today);
    const v = checkWritePath(win.join(dir, "x.md"), config, { checkName: false });
    if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
    let existing: string[] = [];
    try { existing = fs.readdirSync(root).flatMap((d) => { try { return fs.readdirSync(win.join(root, d)); } catch { return []; } }); } catch { existing = []; }
    const name = reportName(code, args.originator.trim().toUpperCase() || "FMC", existing);
    fs.mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    if (args.formats.includes("markdown")) { fs.writeFileSync(win.join(dir, name + ".md"), built.markdown + "\n"); files.push(win.join(dir, name + ".md")); }
    if (args.formats.includes("csv")) { fs.writeFileSync(win.join(dir, name + ".csv"), reportCsv(built.rows, csvLine)); files.push(win.join(dir, name + ".csv")); }
    log(config, dir, "done", `${args.kind} for ${args.audience}: ${name}`);
    return reply({ done: true, name, files, left_out: built.left_out });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, args.project_folder, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcReportTool(server: McpServer) {
  server.tool("fmc_report", FMC_REPORT_DESCRIPTION, FMC_REPORT_SHAPE, (args) => runFmcReport(args));
}
