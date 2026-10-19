import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardConfig, checkWritePath, csvLine, expandEnv, loadConfig } from "../fmc/policy.js";
import { KitScript, STEPS, StepId, readDynamo, readPyRevit, readTool, stepSummary } from "../fmc/scripts.js";
import {
  AddonFile, AddonHeader, StepOutcome, addonCall, addonDir, addonStep, addonSummary, checkJob, jobResultFile, parseJob,
  readAddons, runJob, validateAddonParams,
} from "../fmc/addons.js";
import { documentTarget } from "../fmc/target.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { JobStillRunning } from "../utils/SocketClient.js";
import { FMC_SELFTEST_SHAPE, runFmcSelftest } from "./fmc_selftest.js";
import { FMC_QA_SHAPE, runFmcQa } from "./fmc_qa.js";
import { FMC_LINKS_SHAPE, runFmcLinks } from "./fmc_links.js";
import { FMC_WORKSHARE_SHAPE, runFmcWorkshare } from "./fmc_workshare.js";
import { FMC_ANNOTATE_SHAPE, runFmcAnnotate } from "./fmc_annotate.js";
import { FMC_REVIEW_SHAPE, runFmcReview } from "./fmc_review.js";
import { FMC_REPORT_SHAPE, runFmcReport } from "./fmc_report.js";

const win = path.win32;

/** An add-on run may take minutes (exports): the hard limit for one run. Over MCP the 50 s answer limit still gives a job id. */
const ADDON_TIMEOUT_MS = 30 * 60 * 1000;

function log(cfg: GuardConfig, action: string, target: string, result: string, detail: string, dryRun = false) {
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
  "Formcraft scripts, saved add-ons and automations (Check › Scripts). list (read-only) reads the kit's 05_Scripts " +
    "(Dynamo Python nodes, pyRevit buttons, Python tools) from their own headers; Formcraft doesn't run kit scripts. " +
    "addon_list (read-only) lists Formcraft's saved add-ons: versioned, tested C# that does a Revit job from a short JSON " +
    "of parameters (name, what it does, parameters with defaults, required ones, whether it writes the model). " +
    "addon_run {name, params, dry_run} runs one through the code bridge: dry run by default (model changes rolled back, " +
    "the answer says what would happen); dry_run false only after the person's yes. It runs where send_code_to_revit may " +
    "run (live-model lock). Prefer an add-on to writing code. job {job | job_file} runs a list of {addon, params} in " +
    "order, stops at the first failure and saves results\\<job>_<date>.json in the reports folder (dry_run false in the " +
    "job is the yes). run runs an automation: Formcraft's read-only checks and the weekly report (selftest, qa, links, " +
    "workshare, annotate, review, report) and saved add-ons (\"addon:<name>\", parameters in addon_params, dry run " +
    "unless dry_run false), stopping at the first that fails; each step is logged.";

const STEP = z.string().refine((s) => s in STEPS || addonStep(s) !== null, {
  message: `a step is one of ${Object.keys(STEPS).join(", ")} or "addon:<name>"`,
});
const JSONISH = z.union([z.record(z.unknown()), z.string()]);

export const FMC_SCRIPTS_SHAPE = {
  action: z.enum(["list", "run", "addon_list", "addon_run", "job"]),
  kit_folder: z.string().optional().default("").describe("list: the Formcraft kit folder"),
  name: z.string().optional().default("Automation").describe("run: the automation's name, for the log. addon_run: the add-on's name"),
  steps: z.array(STEP).optional().default([]).describe("run: the steps in order; \"addon:<name>\" runs a saved add-on"),
  project_folder: z.string().optional().default("").describe("run: the project folder (QA report, review register, weekly report)"),
  project_code: z.string().optional().default(""),
  gate: z.enum(["wip_to_shared", "shared_to_published", "weekly"]).optional().default("wip_to_shared").describe("run: the QA step's gate"),
  params: JSONISH.optional().describe("addon_run: the add-on's parameters (a JSON object); missing ones take the add-on's defaults"),
  addon_params: z.record(JSONISH).optional().default({}).describe("run: parameters per add-on step, e.g. {\"qa_orphans\": {\"limit\": 20}}"),
  dry_run: z.boolean().optional().default(true).describe("addon_run and add-on steps: true (default) rolls the model back; false after the person's yes"),
  job: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional().describe("job: {name, dry_run, steps: [{addon, params}]} or the steps alone"),
  job_file: z.string().optional().default("").describe("job: a job file (JSON) instead of job"),
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
  }
}

// ------------------------------------------------------------------ saved add-ons (docs/ADDONS.md)

function addonsByName(files: AddonFile[]): Map<string, AddonHeader> {
  const m = new Map<string, AddonHeader>();
  for (const f of files) if (f.addon && f.problems.length === 0) m.set(f.addon.name, f.addon);
  return m;
}

/** The folders an add-on writes files to must pass the same folder rules as any write (rule 2). */
function pathProblems(addon: AddonHeader, params: Record<string, unknown>, cfg: GuardConfig): string[] {
  const out: string[] = [];
  for (const k of addon.paths) {
    const v = params[k];
    if (typeof v !== "string" || !v.trim()) continue;
    const verdict = checkWritePath(v, cfg, { checkName: false });
    if (!verdict.ok) out.push(...verdict.reasons.map((r) => `${k}: ${r}`));
  }
  return out;
}

/** One add-on run in Revit through the send_code bridge (send_code_to_revit is a WRITE_COMMAND: the live-model lock applies). */
async function runAddonInRevit(file: AddonFile, params: Record<string, unknown>, dryRun: boolean): Promise<StepOutcome & { running?: boolean }> {
  const t0 = Date.now();
  try {
    const call = addonCall(file.addon!, file.code, params, dryRun);
    const response = await withRevitConnection((c) => c.sendCommand("send_code_to_revit", call, ADDON_TIMEOUT_MS));
    const ms = Date.now() - t0;
    const extra = {
      warnings: response?.warnings?.length ? response.warnings : undefined,
      failures: response?.failures?.length ? response.failures : undefined,
      dialogs: response?.dialogs?.length ? response.dialogs : undefined,
      txLeak: response?.txLeak?.length ? response.txLeak : undefined,
    };
    if (!response || typeof response !== "object") return { ok: false, error: "No answer from Revit", ms };
    if (response.success === false) {
      return { ok: false, ms, error: response.errorMessage || `[${response.errorCode || "FMC-CODE-INTERNAL"}]`,
        result: { errorCode: response.errorCode, error: response.error, ...extra } };
    }
    let result: unknown = response.result;
    if (typeof result === "string") { try { result = JSON.parse(result); } catch { /* keep the text */ } }
    return { ok: true, ms, result: extra.warnings || extra.failures || extra.dialogs ? { ...(result as object), revit: extra } : result };
  } catch (error) {
    if (error instanceof JobStillRunning) return { ok: false, running: true, job: error.job, error: error.message, ms: Date.now() - t0 };
    return { ok: false, error: error instanceof Error ? error.message : String(error), ms: Date.now() - t0 };
  }
}

function addonList() {
  const dir = addonDir();
  const files = readAddons(dir);
  return reply({
    folder: dir, count: files.filter((f) => f.addon && !f.problems.length).length,
    addons: files.filter((f) => f.addon).map((f) => ({
      name: f.addon!.name, version: f.addon!.version, does: f.addon!.does, writes: f.addon!.writes, dry_run: f.addon!.dryrun,
      params: f.addon!.params, required: f.addon!.required, returns: f.addon!.returns,
      problems: f.problems.length ? f.problems : undefined,
    })),
    unreadable: files.filter((f) => !f.addon).map((f) => ({ file: f.file, problems: f.problems })),
    next: "fmc_scripts addon_run {name, params} (a dry run first)",
  });
}

async function addonRun(args: FmcScriptsArgs, cfg: GuardConfig) {
  const name = args.name.trim();
  const files = readAddons(addonDir());
  const file = files.find((f) => f.addon?.name === name);
  if (!file || name === "Automation") {
    return reply({ refused: true, reasons: [`No add-on "${name}". Saved add-ons: ${files.map((f) => f.addon?.name).filter(Boolean).join(", ") || "none"}`] }, true);
  }
  if (file.problems.length) return reply({ refused: true, reasons: file.problems.map((p) => `${name}: ${p}`) }, true);
  const addon = file.addon!;
  const v = validateAddonParams(addon, args.params);
  const reasons = [...v.problems, ...pathProblems(addon, v.params, cfg)];
  if (reasons.length) return reply({ refused: true, addon: name, reasons, params: addon.params, required: addon.required }, true);
  const out = await runAddonInRevit(file, v.params, args.dry_run);
  log(cfg, "addon_run", `${name} ${addon.version}`, out.ok ? (args.dry_run ? "dry run" : "done") : out.running ? "running" : "failed",
    out.ok ? addonSummary(out.result) : out.error ?? "", args.dry_run);
  if (out.running) {
    return reply({ addon: name, status: "running", job: out.job, message: out.error, next: [`fmc_job status ${out.job}`, `fmc_job result ${out.job}`] });
  }
  return reply({
    addon: name, version: addon.version, dry_run: args.dry_run, ok: out.ok, ms: out.ms, result: out.result, error: out.error,
    next: !out.ok ? "Read the error; fix the parameters (or the model) and dry-run again"
      : args.dry_run && addon.writes === "model" ? "Show the person this dry run; after a clear yes, run again with dry_run false"
      : args.dry_run ? "Dry run: nothing written. Run with dry_run false to write the files" : "Done",
  }, !out.ok);
}

/** A job: steps in order, stop at the first failure, results saved. FMC_STARTED_BY=job while it runs (the call ledger, F74). */
async function jobRun(args: FmcScriptsArgs, cfg: GuardConfig) {
  let input: unknown = args.job;
  if (args.job_file.trim()) {
    try { input = JSON.parse(fs.readFileSync(args.job_file.trim(), "utf8").replace(/^﻿/, "")); } catch (e) {
      return reply({ refused: true, reasons: [`Can't read the job file ${args.job_file}: ${e instanceof Error ? e.message : String(e)}`] }, true);
    }
  }
  if (input === undefined) return reply({ refused: true, reasons: ["Give the job (job) or a job file (job_file)"] }, true);
  const parsed = parseJob(input);
  if (!parsed.job) return reply({ refused: true, reasons: parsed.problems }, true);
  const job = parsed.job;
  const files = readAddons(addonDir());
  const addons = addonsByName(files);
  const checked = checkJob(job, addons);
  const reasons = [...checked.problems];
  job.steps.forEach((s, i) => { const a = addons.get(s.addon); if (a) reasons.push(...pathProblems(a, checked.params[i], cfg).map((p) => `Step ${i + 1} (${s.addon}): ${p}`)); });
  if (reasons.length) return reply({ refused: true, job: job.name, reasons }, true);

  const byName = new Map(files.filter((f) => f.addon).map((f) => [f.addon!.name, f]));
  const before = process.env.FMC_STARTED_BY;
  if (before !== "schedule") process.env.FMC_STARTED_BY = "job";
  let result;
  try {
    const go = () => runJob(job, addons, (a, p, dry) => runAddonInRevit(byName.get(a.name)!, p, dry));
    result = job.document.trim() ? await documentTarget.run(job.document.trim(), go) : await go();
  } finally {
    if (before === undefined) delete process.env.FMC_STARTED_BY; else process.env.FMC_STARTED_BY = before;
  }
  const dir = job.results_dir.trim() || win.join(expandEnv(cfg.reports_dir), "results");
  let saved = "";
  try {
    fs.mkdirSync(dir, { recursive: true });
    saved = jobResultFile(dir, job.name, new Date(result.started));
    fs.writeFileSync(saved, JSON.stringify(result, null, 2));
  } catch (e) {
    saved = `not saved: ${e instanceof Error ? e.message : String(e)}`;
  }
  log(cfg, "addon_job", job.name, result.done ? (job.dry_run ? "dry run" : "done") : "stopped",
    result.steps.map((s) => `${s.addon}: ${s.ok ? "ok" : "failed"}`).join(" | "), job.dry_run);
  return reply({ ...result, results_file: saved,
    next: result.done ? (job.dry_run ? "Dry run done. Set \"dry_run\": false in the job to run it for real" : "Done")
      : `Stopped at ${result.stopped_at}: the steps after it didn't run` }, !result.done);
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
    if (args.action === "addon_list") return addonList();
    if (args.action === "addon_run") return await addonRun(args, config);
    if (args.action === "job") return await jobRun(args, config);

    if (!args.steps.length) return reply({ refused: true, reasons: ["An automation needs at least one step"] }, true);
    const needsFolder = args.steps.filter((s) => s === "review" || s === "report");
    if (needsFolder.length && !args.project_folder.trim()) return reply({ refused: true, reasons: [`${needsFolder.join(" and ")} need the project folder`] }, true);
    // Add-on steps are checked before anything runs.
    const files = readAddons(addonDir());
    const addons = addonsByName(files);
    const addonParams: Record<string, Record<string, unknown>> = {};
    const problems: string[] = [];
    for (const s of args.steps) {
      const n = addonStep(s);
      if (!n) continue;
      const a = addons.get(n);
      if (!a) { problems.push(`No add-on ${n}`); continue; }
      const v = validateAddonParams(a, args.addon_params[n]);
      problems.push(...v.problems.map((p) => `${n}: ${p}`), ...pathProblems(a, v.params, config).map((p) => `${n}: ${p}`));
      addonParams[n] = v.params;
    }
    if (problems.length) return reply({ refused: true, reasons: problems }, true);

    const results: Array<{ step: string; title: string; ok: boolean; summary: string }> = [];
    for (const step of args.steps) {
      const n = addonStep(step);
      if (n) {
        const file = files.find((f) => f.addon?.name === n)!;
        const out = await runAddonInRevit(file, addonParams[n], args.dry_run);
        results.push({ step, title: `Add-on ${n} ${file.addon!.version}${args.dry_run ? " (dry run)" : ""}`, ok: out.ok,
          summary: out.ok ? addonSummary(out.result) : out.error ?? "failed" });
        if (!out.ok) break;
        continue;
      }
      const id = step as StepId;
      let body: any = null, ok = false;
      try {
        const r = await stepRunner(id, args)();
        body = JSON.parse(r.content[0]?.text ?? "{}");
        ok = !r.isError;
      } catch (e) { body = { error: e instanceof Error ? e.message : String(e) }; }
      // The self-test's "Fix first" stops the chain too: the next steps would fail for the same reason.
      if (id === "selftest" && body?.result === "Fix first") ok = false;
      results.push({ step, title: STEPS[id], ok, summary: stepSummary(id, body) });
      if (!ok) break;
    }
    const failed = results.find((r) => !r.ok);
    const skipped = args.steps.slice(results.length).map((s) => (s in STEPS ? STEPS[s as StepId] : s));
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
