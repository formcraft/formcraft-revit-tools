import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findingDrafts, powerDecision, runId, skipReason, summaryMarkdown } from "../fmc/testrun.js";
import {
  appRunning, loadScenarios, loadState, powerOverrideWord, readLock, readPower, readTestrunConfig, resultsDir, runForeground, runStatus, statePath, testrunHome,
} from "../fmc/testrun_runner.js";

function reply(body: object, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }], isError };
}

export const FMC_TESTRUN_DESCRIPTION =
  "Formcraft unattended Revit tests (F75): the scenarios in tests/revit (setup, CLI tool steps with checks, teardown) run " +
    "with no AI in a Revit 2025 the runner starts itself (never the person's), in scratch documents only, closed without " +
    "saving. list: the scenarios. plan (dry): what a run would do now (skips, the power state, the paths). run: a new run " +
    "(in the background unless foreground). resume: carry on the last unfinished run from its checkpoint (auto: or start a " +
    "new one when the last ended long ago; the scheduled task uses it). status: where a run is. report: its summary.md and " +
    "findings (scenario, step, expected, got) as drafts for test-finding issues; the runner never posts to GitHub. A run " +
    "pauses on battery saver or battery power and never keeps the PC awake; after sleep or shutdown it resumes.";

export const FMC_TESTRUN_SHAPE = {
  action: z.enum(["list", "plan", "run", "status", "resume", "report"]),
  run: z.string().optional().default("").describe("status, report, resume: the run (TR-yyyymmdd-hhmm); empty: the last one"),
  only: z.array(z.string()).optional().default([]).describe("run: just these scenario ids"),
  scenarios_dir: z.string().optional().default("").describe("The scenarios folder (default: tests/revit beside the server, or FMC_TESTRUN_SCENARIOS)"),
  foreground: z.boolean().optional().default(false).describe("run, resume: run in this process until the run ends (the scheduled task); otherwise start it in the background and answer at once"),
  auto: z.boolean().optional().default(false).describe("resume: when nothing is unfinished, start a new run if the last ended more than new_run_after_hours ago"),
};
export type FmcTestrunArgs = z.infer<z.ZodObject<typeof FMC_TESTRUN_SHAPE>>;

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fmc", "cli.js");

/** Starts the runner as its own process (below normal priority is set by the runner itself) and returns at once. */
function startDetached(input: Record<string, unknown>): number {
  const child = spawn(process.execPath, [CLI, "fmc_testrun"], { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  child.stdin!.end(JSON.stringify({ ...input, foreground: true }));
  child.unref();
  return child.pid ?? 0;
}

export async function runFmcTestrun(args: FmcTestrunArgs) {
  try {
    const cfg = readTestrunConfig();
    const dir = args.scenarios_dir.trim() || cfg.scenarios_dir;

    if (args.action === "list" || args.action === "plan") {
      const loaded = loadScenarios(dir);
      const running = appRunning();
      const scenarios = loaded.map((l) => l.scenario ? {
        id: l.scenario.id, title: l.scenario.title, features: l.scenario.features ?? [], needs: l.scenario.needs ?? [],
        revit: l.scenario.revit !== false, setup: l.scenario.setup.length, steps: l.scenario.steps.length, teardown: l.scenario.teardown.length,
        ...(args.action === "plan" ? {
          now: skipReason(l.scenario, running) ? `skipped: ${skipReason(l.scenario, running)}` : "runs",
          tools: [...new Set([...l.scenario.setup, ...l.scenario.steps, ...l.scenario.teardown].map((a) => a.tool ?? (a.revit ? `revit:${a.revit}` : a.runner ? `runner:${a.runner}` : "read_json")))],
        } : {}),
      } : { file: path.basename(l.file), problems: l.problems });
      if (args.action === "list") return reply({ scenarios_dir: dir, count: loaded.length, invalid: loaded.filter((l) => !l.scenario).length, scenarios });
      const power = readPower();
      return reply({
        dry_run: true, scenarios_dir: dir, scenarios,
        power: { status: power, decision: powerDecision(power, cfg), ...(powerOverrideWord() !== undefined ? { test_override: powerOverrideWord() } : {}) },
        revit_exe: { path: cfg.revit_exe, found: fs.existsSync(cfg.revit_exe) },
        project_template: { path: cfg.project_template, found: fs.existsSync(cfg.project_template) },
        checkpoint_dir: testrunHome(), results_dir: resultsDir("<run>"),
        rules: ["Starts its own Revit 2025 and talks only to it; a person's Revit is left alone", "Scratch documents only, closed without saving",
          "Pauses on battery saver (and on battery power, pause_on_battery); never keeps the PC awake", "Never posts to GitHub"],
        next: loaded.some((l) => !l.scenario) ? "Fix the scenario files with problems first" : "fmc_testrun run starts it (in the background)",
      }, loaded.some((l) => !l.scenario));
    }

    if (args.action === "status" || args.action === "report") {
      const s = loadState(args.run.trim() || undefined);
      if (!s) return reply({ refused: true, reasons: [args.run ? `No run ${args.run} in ${testrunHome()}` : "No run yet: fmc_testrun run starts one"] }, true);
      if (args.action === "status") return reply(runStatus(s));
      const titles = Object.fromEntries(loadScenarios(s.scenarios_dir).filter((l) => l.scenario).map((l) => [l.scenario!.id, l.scenario!.title]));
      const md = summaryMarkdown(s, titles);
      fs.mkdirSync(s.results_dir, { recursive: true });
      fs.writeFileSync(path.join(s.results_dir, "summary.md"), md);
      const drafts = findingDrafts(s);
      fs.writeFileSync(path.join(s.results_dir, "findings.json"), JSON.stringify({ run: s.run, findings: s.findings, drafts }, null, 2));
      return reply({ run: s.run, status: s.status, summary_file: path.join(s.results_dir, "summary.md"), summary: md, findings: s.findings.length, drafts,
        next: drafts.length ? "A person or the AI raises these as test-finding issues; the runner never posts" : "No findings" });
    }

    // run / resume
    const lock = readLock();
    if (!args.foreground) {
      if (lock && Date.now() - Date.parse(lock.beat) < 3 * 60 * 1000)
        return reply({ refused: true, reasons: [`A runner (pid ${lock.pid}) is already running ${lock.run}: fmc_testrun status`] }, true);
      const run = args.action === "run" ? runId(new Date()) : "";
      if (run && fs.existsSync(statePath(run))) return reply({ refused: true, reasons: [`Run ${run} exists; try again in a minute`] }, true);
      const pid = startDetached({ action: args.action, run: run || args.run, only: args.only, scenarios_dir: args.scenarios_dir, auto: args.auto });
      return reply({ started: true, pid, run: run || args.run || "(the last unfinished run)",
        next: "fmc_testrun status shows progress; report writes the summary. It runs in its own Revit, paused on battery saver or battery power" });
    }
    const r = await runForeground({
      mode: args.action === "run" ? "new" : args.auto ? "auto" : "resume", run: args.run.trim() || undefined,
      scenarios_dir: args.scenarios_dir.trim() || undefined, only: args.only,
    });
    if (!r.ran) return reply({ ran: false, reason: r.reason, run: r.run });
    return reply({ ran: true, ...runStatus(r.state), summary_file: r.summary });
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, true);
  }
}

export function registerFmcTestrunTool(server: McpServer) {
  server.tool("fmc_testrun", FMC_TESTRUN_DESCRIPTION, FMC_TESTRUN_SHAPE, (args) => runFmcTestrun(args));
}
