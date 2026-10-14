import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { GATES, QaFacts, Rulebooks, mergeRulebooks, neededParameters, qaReport, runQa, trend } from "../fmc/rules.js";

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

export function readRulebooks(dir: string): Rulebooks {
  const folder = expandEnv(dir);
  let files: string[] = [];
  try { files = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".json")).sort(); }
  catch { const r = mergeRulebooks([]); r.problems.push(`Rulebooks not readable at ${dir} (rulebooks_dir in fmc_guard.json)`); return r; }
  const parsed: Array<{ name: string; json: any }> = [];
  const problems: string[] = [];
  for (const f of files) {
    try { parsed.push({ name: f, json: JSON.parse(fs.readFileSync(win.join(folder, f), "utf8").replace(/^﻿/, "")) }); }
    catch { problems.push(`${f} is not valid JSON`); }
  }
  const books = mergeRulebooks(parsed);
  books.problems.unshift(...problems);
  // F-015: an empty folder must never read as "no rules apply".
  if (!files.length) books.problems.push(`No rulebook files (.json) in ${folder} (rulebooks_dir in fmc_guard.json)`);
  return books;
}

export const FMC_QA_DESCRIPTION =
  "Formcraft QA and rulebooks. rules lists every rule in the kit's rulebooks (severity, status, scope, test, fix hint, " +
    "version, why), the exceptions in force and the decisions. run checks the active model for a gate (wip_to_shared, " +
    "shared_to_published, weekly): it only reads, so it runs on live and shared models too; results are Fail, Warning, " +
    "Pass, Not applicable or Not checked per rule, with new/recurring/resolved against the last run and a saved report. " +
    "select selects elements in Revit (the Zoom on a result). request records an approval or change request for the BIM Manager.";

export const FMC_QA_SHAPE = {
  action: z.enum(["rules", "run", "select", "request"]),
  gate: z.enum(["wip_to_shared", "shared_to_published", "weekly"]).optional().default("wip_to_shared"),
  element_ids: z.array(z.number()).optional().describe("select: element ids from a result"),
  rule: z.string().optional().describe("request: the rule id"),
  kind: z.enum(["approve", "change"]).optional().describe("request: approve a proposed rule, or a change request"),
  text: z.string().optional().describe("request: proposed wording, reason or comment"),
  severity: z.enum(["Must", "Should", "Advice"]).optional().describe("request approve: severity to approve with"),
  project_folder: z.string().optional().describe("run: the project folder, for the report in 06_QA\\Health where the guard allows"),
  stage: z.string().optional().describe("run: the project's RIBA stage (e.g. 3); kit rules for other stages show Not applicable"),
};

export type FmcQaArgs = z.infer<z.ZodObject<typeof FMC_QA_SHAPE>>;

export async function runFmcQa(args: FmcQaArgs) {
  const { config, problem } = loadConfig();
  try {
    const books = readRulebooks(config.rulebooks_dir);
    switch (args.action) {
      case "rules":
        return reply({ ...books, gates: GATES, config_problem: problem });

      case "select": {
        const ids = args.element_ids ?? [];
        if (!ids.length) return reply({ refused: true, reasons: ["select needs element_ids"] }, true);
        const r = await withRevitConnection((c) => c.sendRaw("fmc_select_elements", { element_ids: ids }, 30000));
        return reply({ selected: r?.selected ?? ids.length });
      }

      case "request": {
        if (!args.rule || !args.kind) return reply({ refused: true, reasons: ["request needs rule and kind"] }, true);
        const file = win.join(expandEnv(config.reports_dir), "FMC_Rule_Requests.csv");
        fs.mkdirSync(win.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, csvLine(["timestamp", "rule", "kind", "severity", "text", "status"]));
        fs.appendFileSync(file, csvLine([new Date().toISOString(), args.rule, args.kind, args.severity ?? "", args.text ?? "", "requested"]));
        log(config, "rule_request", false, file, "done", `${args.kind} ${args.rule}`);
        return reply({ requested: args.rule, kind: args.kind, file,
          next: args.kind === "approve" ? "The BIM Manager approves it into the kit's rulebook (impact report first)" : "The change goes through the Manual's change process; the rulebook follows" });
      }
    }

    // run: facts from Revit (read-only), checks from the kit
    if (!books.rules.length) return reply({ refused: true, reasons: books.problems.length ? books.problems : ["The kit's rulebooks have no rules"] }, true);
    const facts = (await withRevitConnection((c) => c.sendRaw("fmc_qa_facts", neededParameters(books.rules), 300000))) as QaFacts;
    const today = new Date().toISOString().slice(0, 10);
    const result = runQa(books, facts, args.gate, today, (args.stage ?? "").trim());
    const failing = result.results.filter((x) => x.state === "Fail" || x.state === "Warning").map((x) => x.id);

    const historyFile = win.join(expandEnv(config.reports_dir), "FMC_QA_History.json");
    let history: Record<string, Array<{ at: string; failing: string[] }>> = {};
    try { history = JSON.parse(fs.readFileSync(historyFile, "utf8")); } catch { history = {}; }
    const key = `${facts.model}|${args.gate}`;
    const runs = history[key] ?? [];
    const t = trend(runs.length ? runs[runs.length - 1].failing : null, failing);
    runs.push({ at: new Date().toISOString(), failing });
    history[key] = runs.slice(-20);
    fs.mkdirSync(win.dirname(historyFile), { recursive: true });
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

    // The report goes in the project's 06_QA\Health when the guard allows it, otherwise in the reports folder.
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
    const name = `FMC_QA_${facts.model.replace(/\.rvt$/i, "")}_${stamp}.md`;
    let report = args.project_folder ? win.join(args.project_folder, "06_QA", "Health", name) : "";
    if (!report || !checkWritePath(report, config, { checkName: false }).ok) report = win.join(expandEnv(config.reports_dir), "QA", name);
    fs.mkdirSync(win.dirname(report), { recursive: true });
    fs.writeFileSync(report, qaReport(result, new Date()));
    log(config, "qa_run", false, facts.model, "done", `${result.gate}: ${result.fail} fail, ${result.warning} warnings · ${report}`);

    return reply({ ...result, trend: t, history: runs.slice(-4).map((r) => ({ at: r.at, failing: r.failing.length })), report, rulebook_problems: books.problems });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "qa_" + args.action, false, "", "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcQaTool(server: McpServer) {
  server.tool("fmc_qa", FMC_QA_DESCRIPTION, FMC_QA_SHAPE, (args) => runFmcQa(args));
}
