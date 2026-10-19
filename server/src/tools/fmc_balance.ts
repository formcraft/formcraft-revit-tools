import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { ledgerDir, projectOf } from "../fmc/ledger.js";
import { backlog, backlogTable, callsTable, inScope, inventory, lastWeeks, summary } from "../fmc/balance.js";
import { ledgerEvents, loadFeatures, loadHomes } from "../fmc/balance_io.js";
import { kitScripts } from "./fmc_scripts.js";

const win = path.win32;

function log(cfg: GuardConfig, action: string, dryRun: boolean, target: string, result: string, detail: string) {
  try {
    const dir = expandEnv(cfg.reports_dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = win.join(dir, "FMC_MCP_FileLog.csv");
    if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "action", "dry_run", "target", "result", "detail"]));
    fs.appendFileSync(file, csvLine([new Date().toISOString(), action, dryRun, target, result, detail]));
  } catch {
    // logging must never block the work
  }
}

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_BALANCE_DESCRIPTION =
  "Formcraft automation balance (Check › Automation; reads only, except export). Every call to this server is recorded in a local ledger " +
    "(%APPDATA%\\Formcraft\\ledger: tool, action, ok, time, project, who started it: ai, pane, job, schedule or cli; never model " +
    "content or people's names), and outside scripts add a line through a one-line hook. summary: shares by kind (AI code = " +
    "send_code_to_revit; plugin tools; saved add-ons; external automation: pyRevit, Dynamo, Python, Grasshopper, JS…) and by " +
    "who started them, per project and overall, with a trend by week (default the last 4 weeks). backlog: the move list, the " +
    "AI-code calls grouped by purpose or code hash, ranked by count and time, each with a suggested home and its status. " +
    "inventory: the kit's 05_Scripts beside how often each ran. export (dry run first): tidy CSVs for Power BI into " +
    "<project>\\01_WIP\\_Exchange\\Balance or the reports folder. Pass `purpose` to send_code_to_revit so its calls group. Never ranks people.";

export const FMC_BALANCE_SHAPE = {
  action: z.enum(["summary", "backlog", "inventory", "export"]),
  weeks: z.number().int().min(1).max(104).optional().default(4).describe("the last N whole weeks, up to today"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("instead of weeks: the first day (YYYY-MM-DD)"),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("the last day (default today)"),
  project: z.string().optional().default("").describe("only this project's calls (its code, e.g. KISIC); blank: every project"),
  project_folder: z.string().optional().default("").describe("export: write into <project>\\01_WIP\\_Exchange\\Balance (and only that project's calls)"),
  kit_folder: z.string().optional().default("").describe("inventory: the Formcraft kit folder (its 05_Scripts)"),
  limit: z.number().int().min(1).max(200).optional().default(20).describe("backlog: how many groups"),
  tracker_file: z.string().optional().default("").describe("docs/tracker/features.json, for the homes' status (found beside the build when blank)"),
  dry_run: z.boolean().optional().default(true).describe("export: false writes the CSVs"),
};

export type FmcBalanceArgs = z.infer<z.ZodObject<typeof FMC_BALANCE_SHAPE>>;

export async function runFmcBalance(args: FmcBalanceArgs) {
  const { config } = loadConfig();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const to = args.to ?? today;
    const from = args.from ?? lastWeeks(to, args.weeks).from;
    const folder = args.project_folder.trim() ? expandEnv(args.project_folder.trim()) : "";
    const project = args.project.trim() || (args.action === "export" && folder ? projectOf({ project_folder: folder }) : "");
    const events = inScope(ledgerEvents(from, to), from, to, project);
    const where = { ledger: ledgerDir(), from, to, project: project || "all" };

    if (args.action === "summary") return reply({ ...where, ...summary(events, { from, to, project }) });

    if (args.action === "backlog") {
      const tracker = loadFeatures(args.tracker_file);
      const items = backlog(events, loadHomes(), tracker.features);
      const ai = events.filter((e) => e.kind === "ai_code");
      return reply({ ...where, ai_calls: ai.length, without_purpose: ai.filter((e) => !e.purpose).length, groups: items.length,
        items: items.slice(0, args.limit), tracker: tracker.file || "not found: statuses come from the mapping",
        note: "The top of the list is what to move first into a tool, an add-on or the kit. Never ranks people." });
    }

    if (args.action === "inventory") {
      const kit = expandEnv(args.kit_folder.trim());
      if (!kit || !fs.existsSync(win.join(kit, "05_Scripts"))) return reply({ refused: true, reasons: [`No 05_Scripts in the kit folder: ${kit || "(not set)"}`] }, true);
      const inv = inventory(kitScripts(kit), events);
      return reply({ ...where, kit: win.join(kit, "05_Scripts"), ...inv,
        hooks: "A script counts once it records its runs: docs/AUTOMATION_BALANCE.md and resources/hooks" });
    }

    // export: tidy CSVs for Power BI
    const dir = folder ? win.join(folder, "01_WIP", "_Exchange", "Balance") : win.join(expandEnv(config.reports_dir), "Balance");
    const files = { calls: win.join(dir, "FMC_Balance_Calls.csv"), backlog: win.join(dir, "FMC_Balance_Backlog.csv") };
    const v = checkWritePath(files.calls, config, { checkName: false });
    if (!v.ok) return reply({ refused: true, reasons: v.reasons }, true);
    const calls = callsTable(events);
    const items = backlog(events, loadHomes(), loadFeatures(args.tracker_file).features);
    if (args.dry_run !== false)
      return reply({ dry_run: true, ...where, would_write: [files.calls, files.backlog], rows: { calls: calls.length - 1, backlog: items.length },
        next: "Run again with dry_run=false to write them (an older export goes to Balance\\_Archive)" });
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const f of Object.values(files)) {
      if (fs.existsSync(f)) {
        fs.mkdirSync(win.join(dir, "_Archive"), { recursive: true });
        fs.renameSync(f, win.join(dir, "_Archive", `${stamp}_${win.basename(f)}`));
      }
    }
    fs.writeFileSync(files.calls, calls.map((r) => csvLine(r)).join(""));
    fs.writeFileSync(files.backlog, backlogTable(items).map((r) => csvLine(r)).join(""));
    log(config, "balance_export", false, dir, "done", `${calls.length - 1} call rows, ${items.length} backlog rows, ${from} to ${to}`);
    return reply({ done: true, ...where, files: [files.calls, files.backlog], rows: { calls: calls.length - 1, backlog: items.length } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "balance_" + args.action, args.dry_run !== false, args.project_folder || args.project, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcBalanceTool(server: McpServer) {
  server.tool("fmc_balance", FMC_BALANCE_DESCRIPTION, FMC_BALANCE_SHAPE, (args) => runFmcBalance(args));
}
