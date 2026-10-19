import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { KitScript, STEPS, StepId, readDynamo, readPyRevit, readTool, stepSummary } from "../fmc/scripts.js";
import { FMC_SELFTEST_SHAPE, runFmcSelftest } from "./fmc_selftest.js";
import { FMC_QA_SHAPE, runFmcQa } from "./fmc_qa.js";
import { FMC_LINKS_SHAPE, runFmcLinks } from "./fmc_links.js";
import { FMC_WORKSHARE_SHAPE, runFmcWorkshare } from "./fmc_workshare.js";
import { FMC_ANNOTATE_SHAPE, runFmcAnnotate } from "./fmc_annotate.js";
import { FMC_REVIEW_SHAPE, runFmcReview } from "./fmc_review.js";
import { FMC_REPORT_SHAPE, runFmcReport } from "./fmc_report.js";
import { recorded, startedByFrom } from "../fmc/ledger.js";
import { FMC_TABLES_SHAPE, runFmcTables } from "./fmc_tables.js";

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

const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const list = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };

export function kitScripts(kit: string): KitScript[] {
  const root = win.join(kit, "05_Scripts");
  const out: KitScript[] = [];
  for (const e of list(win.join(root, "Dynamo"))) if (e.isFile() && /\.py$/i.test(e.name)) {
    const f = win.join(root, "Dynamo", e.name);
    out.push(readDynamo(f, read(f)));
  }
  const walk = (dir: string, depth: number) => {
    for (const e of list(dir)) {
      const full = win.join(dir, e.name);
      if (!e.isDirectory()) continue;
      if (/\.pushbutton$/i.test(e.name)) out.push(readPyRevit(full, read(win.join(full, "bundle.yaml")), read(win.join(full, "script.py"))));
      else if (depth < 4 && !/^(lib|__pycache__)$/i.test(e.name)) walk(full, depth + 1);
    }
  };
  walk(win.join(root, "pyRevit"), 0);
  for (const e of list(win.join(root, "tools"))) if (e.isFile() && /\.py$/i.test(e.name)) {
    const f = win.join(root, "tools", e.name);
    out.push(readTool(f, read(f)));
  }
  return out;
}

export const FMC_SCRIPTS_DESCRIPTION =
  "Formcraft scripts and automations (Check › Scripts). list (read-only) reads the kit's 05_Scripts (Dynamo Python " +
    "nodes, pyRevit buttons, Python tools) from their own headers: what each does, inputs, the status line, whether it " +
    "changes the model, where it runs and the Formcraft section that does the same job. Formcraft doesn't run kit " +
    "scripts (they pass the Manual 17 release gate in pyRevit or Dynamo). run runs an automation: Formcraft's own " +
    "read-only checks and the weekly report in a row (selftest, qa, links, workshare, annotate, review, report, tables: the " +
    "kit's Excel against its tables, tables_import: a dry run of the edited kit tables in staging), " +
    "stopping at the first that fails; each step is logged. No step changes the model.";

export const FMC_SCRIPTS_SHAPE = {
  action: z.enum(["list", "run"]),
  kit_folder: z.string().optional().default("").describe("list: the Formcraft kit folder"),
  name: z.string().optional().default("Automation").describe("run: the automation's name, for the log"),
  steps: z.array(z.enum(Object.keys(STEPS) as [StepId, ...StepId[]])).optional().default([]).describe("run: the steps in order"),
  project_folder: z.string().optional().default("").describe("run: the project folder (QA report, review register, weekly report)"),
  project_code: z.string().optional().default(""),
  gate: z.enum(["wip_to_shared", "shared_to_published", "weekly"]).optional().default("wip_to_shared").describe("run: the QA step's gate"),
};

export type FmcScriptsArgs = z.infer<z.ZodObject<typeof FMC_SCRIPTS_SHAPE>>;

type Reply = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/** Each step calls the tool it names with read-only arguments; the report step saves the plugin's own report files. */
function stepRunner(step: StepId, a: FmcScriptsArgs): () => Promise<Reply> {
  const folder = a.project_folder, code = a.project_code;
  switch (step) {
    case "selftest": return () => runFmcSelftest(z.object(FMC_SELFTEST_SHAPE).parse({ kit_folder: a.kit_folder || undefined }));
    case "qa": return () => runFmcQa(z.object(FMC_QA_SHAPE).parse({ action: "run", gate: a.gate, project_folder: folder || undefined }));
    case "links": return () => runFmcLinks(z.object(FMC_LINKS_SHAPE).parse({ action: "audit" }));
    case "workshare": return () => runFmcWorkshare(z.object(FMC_WORKSHARE_SHAPE).parse({ action: "facts", project_code: code, project_folder: folder }));
    case "annotate": return () => runFmcAnnotate(z.object(FMC_ANNOTATE_SHAPE).parse({ action: "check" }));
    case "review": return () => runFmcReview(z.object(FMC_REVIEW_SHAPE).parse({ action: "list", project_folder: folder, project_code: code, filter: "Open" }));
    case "report": return () => runFmcReport(z.object(FMC_REPORT_SHAPE).parse({ action: "make", project_folder: folder, project_code: code, dry_run: false }));
    case "tables": return () => runFmcTables(z.object(FMC_TABLES_SHAPE).parse({ action: "check", kit_folder: a.kit_folder }));
    case "tables_import": return () => runFmcTables(z.object(FMC_TABLES_SHAPE).parse({ action: "pending", kit_folder: a.kit_folder, project_folder: folder }));
  }
}

export async function runFmcScripts(args: FmcScriptsArgs) {
  const { config } = loadConfig();
  try {
    if (args.action === "list") {
      const kit = args.kit_folder.trim();
      if (!kit || !fs.existsSync(win.join(kit, "05_Scripts"))) return reply({ refused: true, reasons: [`No 05_Scripts in the kit folder: ${kit || "(not set)"}`] }, true);
      const scripts = kitScripts(kit);
      return reply({ folder: win.join(kit, "05_Scripts"), count: scripts.length, scripts, steps: STEPS,
        register: "The kit has no script register: status is the file's own status line" });
    }

    if (!args.steps.length) return reply({ refused: true, reasons: ["An automation needs at least one step"] }, true);
    const needsFolder = args.steps.filter((s) => s === "review" || s === "report");
    if (needsFolder.length && !args.project_folder.trim()) return reply({ refused: true, reasons: [`${needsFolder.join(" and ")} need the project folder`] }, true);
    const results: Array<{ step: StepId; title: string; ok: boolean; summary: string }> = [];
    for (const step of args.steps) {
      let body: any = null, ok = false;
      try {
        // F74: each step is a call started by a job (the automation), in the call ledger
        const r = await recorded(`fmc_${step}`, { project_folder: args.project_folder, project_code: args.project_code },
          startedByFrom(process.env, "ai") === "schedule" ? "schedule" : "job", stepRunner(step, args));
        body = JSON.parse(r.content[0]?.text ?? "{}");
        ok = !r.isError;
      } catch (e) { body = { error: e instanceof Error ? e.message : String(e) }; }
      // The self-test's "Fix first" stops the chain too: the next steps would fail for the same reason.
      if (step === "selftest" && body?.result === "Fix first") ok = false;
      results.push({ step, title: STEPS[step], ok, summary: stepSummary(step, body) });
      if (!ok) break;
    }
    const failed = results.find((r) => !r.ok);
    const skipped = args.steps.slice(results.length).map((s) => STEPS[s]);
    log(config, "automation_run", args.name, failed ? "stopped" : "done", results.map((r) => `${r.step}: ${r.ok ? "ok" : "failed"} (${r.summary})`).join(" | "));
    return reply({ name: args.name, done: !failed, stopped_at: failed?.title ?? null, results, skipped,
      next: failed ? `Fix ${failed.title} first; the steps after it didn't run` : "Every step ran" }, false);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(config, "scripts_" + args.action, args.name, "error", msg);
    return reply({ error: msg }, true);
  }
}

export function registerFmcScriptsTool(server: McpServer) {
  server.tool("fmc_scripts", FMC_SCRIPTS_DESCRIPTION, FMC_SCRIPTS_SHAPE, (args) => runFmcScripts(args));
}
