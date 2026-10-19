/**
 * Unattended Revit tests (F75): the runner. It starts its own Revit 2025 (never anyone else's), runs the scenarios in
 * tests/revit through the same CLI the pane uses (no AI), keeps a checkpoint in %APPDATA%\Formcraft\testrun, pauses on
 * battery saver or battery power, and never keeps the PC awake. See docs/TESTING.md, "Unattended Revit tests".
 *
 * - Its Revit: launched with FMC_UNATTENDED_TEST=1 and FMC_NO_KEEP_AWAKE=1 (the add-in then answers only the safe
 *   dialogs by rule and doesn't hold the PC awake), at below-normal priority. It is known by its pid and the process's
 *   start time; every call goes to that pid through the multi-Revit registry, so a person's Revit is never reached.
 *   At the end it is closed without saving (the process is ended: scratch documents only, nothing to save).
 * - Pausing: before each action, and every 60 s while paused, the power state is read (GetSystemPowerStatus). Paused
 *   means no new action starts; one already running finishes; Revit stays open.
 * - Sleep and shutdown stop the process with the PC. A heartbeat in runner.lock and the run's checkpoint let the next
 *   start resume: passed scenarios are skipped, the interrupted one runs again from its setup.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { expandEnv, loadConfig } from "./policy.js";
import { formcraftHome, jobFiles, readJsonLines } from "./jobs.js";
import { RevitInstance, readInstances } from "./connect.js";
import { revitTarget } from "./target.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { appStatuses, realProbe } from "../hub/apps.js";
import {
  Action, CLI_TOOLS, Finding, addFinding, GAP_MS, NeedsApp, PowerStatus, Reply, RunState, Scenario, autoDecision, evalCheck, finishScenario,
  findingDrafts, interruptScenario, lockVerdict, newRun, nextScenario, parsePowerLine, parseScenario, powerDecision, resumeRun,
  runId, skipReason, sleptBetween, startScenario, stepChecks, substitute, summaryMarkdown,
} from "./testrun.js";

const win = path.win32;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(HERE, "cli.js");

// ---------------------------------------------------------------- settings and files

export interface TestrunConfig {
  revit_exe: string;
  /** Pause while on battery power (battery saver always pauses). */
  pause_on_battery: boolean;
  power_poll_s: number;
  revit_start_timeout_s: number;
  step_timeout_s: number;
  /** The kit template a scratch project starts from ({{project_template}}). */
  project_template: string;
  /** The scheduled start (auto) begins a new run when the last one ended longer ago than this. */
  new_run_after_hours: number;
  scenarios_dir: string;
}

export function testrunHome(env: NodeJS.ProcessEnv = process.env): string { return win.join(formcraftHome(env), "testrun"); }

/** The kit's folders, from the guard's family staging root (<kit>\04_Families\_Staging). */
export function kitFolders() {
  const { config } = loadConfig();
  const staging = expandEnv(config.family_staging_root);
  const kit = win.dirname(win.dirname(staging));
  return {
    kit, staging, batch_dir: win.join(staging, "_Batch"), chaintests: win.join(win.dirname(staging), "_ChainTests"),
    templates: win.join(kit, "06_Templates", "_Staging"), reports: expandEnv(config.reports_dir),
  };
}

export function defaultScenariosDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FMC_TESTRUN_SCENARIOS || path.resolve(SERVER_ROOT, "..", "tests", "revit");
}

/** %APPDATA%\Formcraft\testrun\config.json over the defaults (a broken file is ignored, with the defaults used). */
export function readTestrunConfig(env: NodeJS.ProcessEnv = process.env): TestrunConfig {
  const k = kitFolders();
  const defaults: TestrunConfig = {
    revit_exe: "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe", pause_on_battery: true, power_poll_s: 60,
    revit_start_timeout_s: 600, step_timeout_s: 900, project_template: win.join(k.templates, "FMC_A_Template_v2.2.rte"),
    new_run_after_hours: 20, scenarios_dir: defaultScenariosDir(env),
  };
  try {
    const raw = JSON.parse(fs.readFileSync(win.join(testrunHome(env), "config.json"), "utf8").replace(/^\uFEFF/, ""));
    return { ...defaults, ...raw };
  } catch { return defaults; }
}

export const statePath = (run: string) => win.join(testrunHome(), `${run}.json`);
const lockPath = () => win.join(testrunHome(), "runner.lock");
const lastPath = () => win.join(testrunHome(), "last.json");
export const resultsDir = (run: string) => win.join(kitFolders().reports, "testrun", run);

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T; } catch { return null; }
}

export function saveState(s: RunState) { writeJson(statePath(s.run), s); writeJson(lastPath(), { run: s.run }); }
export function loadState(run?: string): RunState | null {
  const id = run || readJson<{ run: string }>(lastPath())?.run;
  return id ? readJson<RunState>(statePath(id)) : null;
}
export function readLock(): { pid: number; run: string; beat: string } | null { return readJson(lockPath()); }

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// ---------------------------------------------------------------- scenarios

export interface LoadedScenario { file: string; scenario: Scenario | null; problems: string[] }

export function loadScenarios(dir: string): LoadedScenario[] {
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json")).sort(); } catch { return []; }
  return files.map((f) => {
    const file = path.join(dir, f);
    const r = parseScenario(fs.readFileSync(file, "utf8"), CLI_TOOLS);
    if (r.scenario && path.basename(f, ".json") !== r.scenario.id) return { file, scenario: null, problems: [`id ${r.scenario.id} isn't the file name`] };
    return { file, ...r };
  });
}

export function appRunning(): (app: NeedsApp) => boolean {
  let st: ReturnType<typeof appStatuses> = [];
  try { st = appStatuses(realProbe(SERVER_ROOT)); } catch { /* nothing counts as running */ }
  return (app) => !!st.find((a) => a.id === app)?.running;
}

// ---------------------------------------------------------------- Windows: power, processes, priority

function powershell(script: string, timeoutMs = 30000): string {
  const enc = Buffer.from(script, "utf16le").toString("base64");
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", enc],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
}

const POWER_PS = "Add-Type -Namespace FmcTestrun -Name Power -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct S " +
  "{ public byte AC; public byte Bat; public byte Pct; public byte Flag; public int Life; public int Full; } " +
  "[DllImport(\"kernel32.dll\")] public static extern bool GetSystemPowerStatus(out S s);'; " +
  "$s = New-Object FmcTestrun.Power+S; [void][FmcTestrun.Power]::GetSystemPowerStatus([ref]$s); \"$($s.AC) $($s.Bat) $($s.Pct) $($s.Flag)\"";

/** Windows' GetSystemPowerStatus through PowerShell; null when it can't be read. */
export function readPower(): PowerStatus | null {
  try { return parsePowerLine(powershell(POWER_PS).trim().split(/\r?\n/).pop() ?? ""); } catch { return null; }
}

/** A process's name and start time (UTC, ISO), or null when it isn't running. */
export function processInfo(pid: number): { name: string; start: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = powershell(`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName + '|' + $p.StartTime.ToUniversalTime().ToString('o') }`).trim();
    const [name, start] = out.split("|");
    return name && start ? { name, start } : null;
  } catch { return null; }
}

function belowNormal(pid: number) {
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
}

function killTree(pid: number) {
  try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* already gone */ }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const norm = (p: string) => win.normalize(p).toLowerCase();

// ---------------------------------------------------------------- the runner's own Revit

/** Thrown when the PC slept (or the runner stopped) in the middle of a scenario: it runs again from its setup. */
class Interrupted extends Error {}

export class OwnRevit {
  constructor(private state: RunState, private cfg: TestrunConfig, private save: () => void, private log: (m: string) => void) {}

  get pid(): number { return this.state.revit?.pid ?? 0; }

  /** The scratch file this Revit was started with (normalised), if any: later actions keep it open. */
  get opened(): string | undefined { return this.state.revit?.opened; }

  /** True only for the Revit this run started: same pid, a Revit process, same start time. */
  isOurs(): boolean {
    const r = this.state.revit;
    if (!r) return false;
    const p = processInfo(r.pid);
    return !!p && /^revit$/i.test(p.name) && p.start === r.process_start;
  }

  instance(): RevitInstance & { unattended?: boolean } | null {
    return (readInstances().find((i) => i.pid === this.pid) as RevitInstance & { unattended?: boolean }) ?? null;
  }

  /** A read-only command to this Revit only (by its pid, through the registry: never another Revit). */
  async raw(command: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (!this.pid) throw new Error("The runner has no Revit of its own running");
    return revitTarget.run(String(this.pid), () => withRevitConnection((c) => c.sendRaw(command, params, timeoutMs)));
  }

  /** Its Revit, running and answering; started fresh (with `open` as its document) when needed. */
  async ensure(open?: string): Promise<void> {
    const want = open ? norm(open) : undefined;
    if (this.isOurs() && this.instance()?.port && (!want || this.state.revit?.opened === want)) return;
    await this.close();
    await this.launch(open);
  }

  private async launch(open?: string) {
    const want = open ? norm(open) : undefined;
    if (!fs.existsSync(this.cfg.revit_exe)) throw new Error(`Revit isn't at ${this.cfg.revit_exe} (set revit_exe in ${win.join(testrunHome(), "config.json")})`);
    if (open && !fs.existsSync(open)) throw new Error(`Nothing to open at ${open}`);
    this.log(`Starting Revit${open ? ` with ${open}` : ""}`);
    const child = spawn(this.cfg.revit_exe, open ? [open] : [], {
      detached: true, stdio: "ignore", windowsHide: false,
      env: { ...process.env, FMC_UNATTENDED_TEST: "1", FMC_NO_KEEP_AWAKE: "1" },
    });
    child.unref();
    const pid = child.pid ?? 0;
    if (!pid) throw new Error("Revit didn't start");
    belowNormal(pid);
    const info = processInfo(pid);
    this.state.revit = { pid, port: 0, process_start: info?.start ?? "", opened: want };
    this.save();
    const deadline = Date.now() + this.cfg.revit_start_timeout_s * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      if (!processAlive(pid)) throw new Error("Revit closed while starting (a licence or start-up dialog, or a crash)");
      const inst = this.instance();
      if (!inst?.port) continue;
      if (inst.unattended !== true)
        throw new Error("The add-in in this Revit is older than the runner (its registry entry has no unattended flag): install the latest build first");
      if (want && !inst.documents.some((d) => d.path && norm(d.path) === want)) continue;
      try {
        await this.raw("fmc_document_info", {}, 15000);
        this.state.revit!.port = inst.port;
        this.save();
        this.log(`Revit ${pid} answers on port ${inst.port}`);
        return;
      } catch { /* not answering yet */ }
    }
    throw new Error(`Revit ${pid} didn't answer within ${this.cfg.revit_start_timeout_s} s (the AI connection didn't start, or a start-up dialog waits)`);
  }

  /** Closes this run's Revit without saving: only scratch documents are in it. Never touches another Revit. */
  async close() {
    const r = this.state.revit;
    if (!r) return;
    if (this.isOurs()) {
      this.log(`Closing Revit ${r.pid} without saving`);
      killTree(r.pid);
      for (let i = 0; i < 30 && processAlive(r.pid); i++) await sleep(1000);
    }
    this.state.revit = undefined;
    this.save();
  }

  /** Dialogs this Revit recorded as waiting for a person since `since` (FMC_Jobs_Revit.jsonl lines carry the pid). */
  waitingDialogs(since: string): Array<{ job: string; dialog_id: string; message: string }> {
    return readJsonLines(jobFiles().revit, 800)
      .filter((e) => e?.pid === this.pid && e.event === "dialog" && String(e.at ?? "") >= since && /^(left for a person|not answered)/.test(String(e.answer ?? "")))
      .map((e) => ({ job: String(e.job ?? ""), dialog_id: String(e.dialog_id ?? ""), message: String(e.message ?? "") }));
  }

  /** Jobs this Revit started since `since`, for a cancel request. */
  jobsSince(since: string): string[] {
    const ids = new Set<string>();
    for (const e of readJsonLines(jobFiles().revit, 800))
      if (e?.pid === this.pid && String(e.at ?? "") >= since && typeof e.job === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(e.job)) ids.add(e.job);
    return [...ids];
  }

  /** fmc_job cancel's file: Revit stops the job at its next check and rolls back its transaction. */
  requestCancel(jobs: string[]) {
    const dir = jobFiles().cancelDir;
    for (const j of jobs) {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, j), `unattended test runner ${new Date().toISOString()}\n`); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------- running a run

export interface RunOptions {
  mode: "new" | "resume" | "auto";
  run?: string;
  scenarios_dir?: string;
  only?: string[];
  log?: (m: string) => void;
}

export type RunOutcome =
  | { ran: true; state: RunState; summary: string }
  | { ran: false; reason: string; run?: string };

export async function runForeground(opts: RunOptions): Promise<RunOutcome> {
  belowNormal(process.pid);
  const cfg = readTestrunConfig();
  fs.mkdirSync(testrunHome(), { recursive: true });
  // every line also goes to runner.log, so a background or scheduled run can be followed
  const log = opts.log ?? ((m: string) => {
    const line = `[testrun ${new Date().toISOString()}] ${m}`;
    console.error(line);
    try { fs.appendFileSync(win.join(testrunHome(), "runner.log"), line + "\n"); } catch { /* the log never stops the run */ }
  });
  const lock = readLock();
  if (lockVerdict(lock, processAlive, new Date(), process.pid) === "busy")
    return { ran: false, reason: `Another runner (pid ${lock!.pid}) is running ${lock!.run}`, run: lock!.run };

  const dir = opts.scenarios_dir || cfg.scenarios_dir;
  const loaded = loadScenarios(dir);
  const bad = loaded.filter((l) => !l.scenario);
  if (!loaded.length) return { ran: false, reason: `No scenarios in ${dir}` };
  if (bad.length) return { ran: false, reason: "Scenario files with problems: " + bad.map((b) => `${path.basename(b.file)}: ${b.problems.join("; ")}`).join(" | ") };
  const byId = new Map(loaded.map((l) => [l.scenario!.id, l.scenario!]));

  let state: RunState | null = null;
  const now = new Date();
  const last = loadState(opts.run);
  let mode = opts.mode;
  if (mode === "auto") {
    const d = autoDecision(last, now, cfg.new_run_after_hours);
    if (d.action === "nothing") return { ran: false, reason: d.reason, run: last?.run };
    mode = d.action;
    log(`Auto: ${d.action} (${d.reason})`);
  }
  if (mode === "resume") {
    if (!last) return { ran: false, reason: "No run to resume: start one with run" };
    if (last.status === "done") return { ran: false, reason: `Run ${last.run} is finished: start a new one with run`, run: last.run };
    state = resumeRun(last, lock?.run === last.run ? lock.beat : last.updated, now);
    for (const id of byId.keys()) if (!state.order.includes(id)) { state.order.push(id); state.scenarios[id] = { status: "pending", tries: 0, interruptions: 0 }; }
    log(`Resuming ${state.run}`);
  } else {
    const order = [...byId.keys()].filter((id) => !opts.only?.length || opts.only.includes(id));
    if (!order.length) return { ran: false, reason: `None of ${opts.only?.join(", ")} is a scenario` };
    let id = opts.run || runId(now);
    if (fs.existsSync(statePath(id))) id = `${id}-${Date.now() % 100000}`;
    state = newRun(id, order, { scenarios_dir: dir, results_dir: resultsDir(id) }, now);
    log(`New run ${id}: ${order.length} scenarios`);
  }
  const s = state;
  const save = () => { s.updated = new Date().toISOString(); saveState(s); };
  save();

  // heartbeat: the lock file every 30 s; a jump in the clock means the PC slept
  let prevTick = Date.now();
  let slept = false;
  const beat = () => {
    const t = Date.now();
    if (sleptBetween(prevTick, t)) {
      s.gaps.push({ from: new Date(prevTick).toISOString(), to: new Date(t).toISOString(), seconds: Math.round((t - prevTick) / 1000) });
      slept = true;
      save();
    }
    prevTick = t;
    try { writeJson(lockPath(), { pid: process.pid, run: s.run, beat: new Date(t).toISOString() }); } catch { /* next beat */ }
  };
  beat();
  const timer = setInterval(beat, 30000);

  const revit = new OwnRevit(s, cfg, save, log);
  const running = appRunning();
  const results = s.results_dir;
  fs.mkdirSync(results, { recursive: true });
  const k = kitFolders();

  const writeReports = () => {
    const titles = Object.fromEntries([...byId.values()].map((x) => [x.id, x.title]));
    fs.writeFileSync(path.join(results, "summary.md"), summaryMarkdown(s, titles));
    writeJson(path.join(results, "findings.json"), { run: s.run, findings: s.findings, drafts: findingDrafts(s) });
  };

  /** Paused: no new action starts until the power state allows it (checked every power_poll_s). */
  const waitWhilePaused = async () => {
    for (;;) {
      const d = powerDecision(readPower(), cfg);
      const open = s.pauses[s.pauses.length - 1];
      if (!d.pause) {
        if (open && !open.to) { open.to = new Date().toISOString(); s.status = "running"; save(); log(`Resumed: ${d.reason}`); }
        return;
      }
      if (!open || open.to) { s.pauses.push({ from: new Date().toISOString(), reason: d.reason }); s.status = "paused"; save(); log(`Paused: ${d.reason}`); }
      await sleep(Math.max(5, cfg.power_poll_s) * 1000);
      beat();
    }
  };

  try {
    for (let id = nextScenario(s); id; id = nextScenario(s)) {
      const sc = byId.get(id);
      if (!sc) { finishScenario(s, id, "skipped", "the scenario file is gone", new Date()); save(); continue; }
      const why = skipReason(sc, running);
      if (why) { finishScenario(s, id, "skipped", why, new Date()); save(); writeReports(); log(`${id}: skipped (${why})`); continue; }
      await waitWhilePaused();
      slept = false;
      startScenario(s, id, new Date());
      save();
      const st = s.scenarios[id];
      const attempt = st.tries + st.interruptions + 1;
      log(`${id}: try ${st.tries + 1}${st.interruptions ? ` (after ${st.interruptions} interruption(s))` : ""}`);
      const outcome = await runScenario(sc, attempt);
      if (outcome === "interrupted") interruptScenario(s, id, "the PC slept or the runner stopped", new Date());
      else finishScenario(s, id, outcome.ok ? "passed" : "failed", outcome.reason, new Date());
      save();
      writeReports();
      log(`${id}: ${s.scenarios[id].status}${s.scenarios[id].reason ? ` (${s.scenarios[id].reason})` : ""}`);
    }
    await revit.close();
    s.status = "done";
    s.finished = new Date().toISOString();
    save();
    writeReports();
    return { ran: true, state: s, summary: path.join(results, "summary.md") };
  } finally {
    clearInterval(timer);
    try { if (readLock()?.pid === process.pid) fs.unlinkSync(lockPath()); } catch { /* gone */ }
  }

  // ---------------------------------------------------------------- one scenario

  async function runScenario(sc: Scenario, attempt: number): Promise<{ ok: boolean; reason: string } | "interrupted"> {
    const scratch = win.join(k.chaintests, "_TestRun", s.run, `${sc.id}-${attempt}`);
    const steps: Record<string, unknown> = {};
    const vars: Record<string, unknown> = {
      run: s.run, scenario: sc.id, attempt, scratch, staging: k.staging, batch_dir: k.batch_dir, chaintests: k.chaintests,
      templates: k.templates, kit: k.kit, project_template: cfg.project_template, scenarios_dir: s.scenarios_dir, steps,
    };
    const record: { scenario: string; title: string; attempt: number; started: string; actions: unknown[]; ended?: string; result?: string } =
      { scenario: sc.id, title: sc.title, attempt, started: new Date().toISOString(), actions: [] };
    let failed = "";
    let interrupted = false;
    const add = (f: Omit<Finding, "run" | "scenario" | "at" | "tries">) =>
      addFinding(s, { run: s.run, scenario: sc.id, at: new Date().toISOString(), ...f }, attempt);

    const phases: Array<["setup" | "steps" | "teardown", Action[]]> = [["setup", sc.setup], ["steps", sc.steps], ["teardown", sc.teardown]];
    for (const [phase, actions] of phases) {
      for (const [i, a] of actions.entries()) {
        if ((failed || interrupted) && phase !== "teardown") break;
        const name = `${phase}: ${a.id ?? a.tool ?? a.revit ?? a.runner ?? "read_json"}${a.id ? "" : ` #${i + 1}`}`;
        if (phase !== "teardown") await waitWhilePaused();
        s.scenarios[sc.id].step = name;
        save();
        let ok = true;
        try {
          const r = await runAction(sc, a, vars, name, add, phase === "teardown");
          record.actions.push(r.record);
          if (a.id) steps[a.id] = r.reply?.body;
          ok = r.ok;
        } catch (e) {
          if (e instanceof Interrupted) { interrupted = true; continue; }
          const msg = e instanceof Error ? e.message : String(e);
          // a teardown step for something the setup never made (its {{steps…}} is empty) has nothing to undo
          if (phase === "teardown" && /^Unresolved \{\{/.test(msg)) { record.actions.push({ step: name, skipped: `nothing to undo (${msg})` }); continue; }
          add({ step: name, kind: phase === "setup" ? "setup" : "error", expected: "the action runs", got: msg });
          record.actions.push({ step: name, error: msg });
          ok = false;
        }
        if (slept && phase !== "teardown") interrupted = true;
        if (!ok && !failed) failed = `${name} failed`;
      }
    }
    record.ended = new Date().toISOString();
    const mine = s.findings.filter((f) => f.scenario === sc.id && f.tries.includes(attempt));
    if (interrupted) {
      // findings of an interrupted try aren't findings: the scenario runs again from its setup
      for (const f of mine) f.tries = f.tries.filter((t) => t !== attempt);
      s.findings = s.findings.filter((f) => f.tries.length > 0);
      record.result = "interrupted";
    } else record.result = failed ? "failed" : "passed";
    const file = path.join(results, `${sc.id}.json`);
    const prev = readJson<{ tries: unknown[] }>(file);
    writeJson(file, { scenario: sc.id, title: sc.title, features: sc.features ?? [], tries: [...(prev?.tries ?? []), record] });
    if (interrupted) return "interrupted";
    return failed ? { ok: false, reason: `${failed}${mine.length ? `: ${mine[0].expected}, got ${mine[0].got}`.slice(0, 300) : ""}` } : { ok: true, reason: "" };
  }

  async function runAction(sc: Scenario, a: Action, vars: Record<string, unknown>, name: string,
    add: (f: Omit<Finding, "run" | "scenario" | "at" | "tries">) => void, teardown: boolean) {
    const started = new Date().toISOString();
    if (a.when && !evalCheck(a.when, { exit: 0, body: { steps: vars.steps } }).ok)
      return { ok: true, reply: undefined as Reply | undefined, record: { step: name, skipped: "its condition (when) is false", when: a.when } };
    // teardown never starts a Revit just to close something in it: a Revit that is gone took its documents with it
    if (teardown && (a.tool || a.revit) && sc.revit !== false && !revit.isOurs())
      return { ok: true, reply: undefined as Reply | undefined, record: { step: name, skipped: "the runner's Revit is closed: nothing to undo" } };
    const timeoutMs = (a.timeout_s ?? cfg.step_timeout_s) * 1000;
    let reply: Reply = { exit: 0, body: {} };
    let input: unknown;
    const repeats = a.repeat_until?.max ?? 1;
    let n = 0;
    for (; n < repeats; n++) {
      if (n > 0) await waitWhilePaused();
      if (a.tool) {
        input = substitute(a.args ?? {}, vars);
        if (sc.revit !== false) await revit.ensure(revit.opened);
        reply = await runTool(a.tool, input as Record<string, unknown>, sc.revit !== false, timeoutMs, name, add);
      } else if (a.revit) {
        input = substitute(a.params ?? {}, vars);
        await revit.ensure(revit.opened);
        try { reply = { exit: 0, body: await revit.raw(a.revit, input as Record<string, unknown>, timeoutMs) }; }
        catch (e) { reply = { exit: 1, body: { error: e instanceof Error ? e.message : String(e) } }; }
      } else if (a.read_json !== undefined) {
        input = substitute(a.read_json, vars);
        const body = readJson<unknown>(String(input));
        reply = body === null ? { exit: 1, body: { error: `Can't read JSON at ${input}` } } : { exit: 0, body };
      } else if (a.runner === "open_in_revit") {
        input = substitute(a.path ?? "", vars);
        await revit.ensure(String(input));
        reply = { exit: 0, body: { opened: input, pid: revit.pid, port: s.revit?.port } };
      } else if (a.runner === "close_revit") {
        await revit.close();
        reply = { exit: 0, body: { closed: true } };
      }
      if (slept && !teardown) throw new Interrupted();
      if (!a.repeat_until || evalCheck(a.repeat_until.check, reply).ok) break;
    }
    const pngs = collectPngs(reply.body, `${sc.id}-${vars.attempt}`);
    const results = stepChecks(a).map((c) => ({ check: c, ...evalCheck(c, reply) }));
    if (a.repeat_until && n >= repeats) results.push({ check: a.repeat_until.check, ...evalCheck(a.repeat_until.check, reply), expected: `${evalCheck(a.repeat_until.check, reply).expected} within ${repeats} runs` });
    for (const r of results.filter((x) => !x.ok))
      add({ step: name, kind: r.check.no_error && /\[runner\] Revit showed a dialog/.test(r.got) ? "dialog" : r.check.no_error ? "error" : "check", expected: r.expected, got: r.got });
    return {
      ok: results.every((r) => r.ok), reply,
      record: { step: name, started, ended: new Date().toISOString(), input, runs: n + 1 > repeats ? repeats : n + 1, exit: reply.exit, reply: clip(reply.body), checks: results, pngs },
    };
  }

  /** One CLI call (node build/fmc/cli.js <tool>), sent to this run's Revit only, watched for dialogs, a dead Revit and its time. */
  async function runTool(tool: string, args: Record<string, unknown>, withRevit: boolean, timeoutMs: number, name: string,
    add: (f: Omit<Finding, "run" | "scenario" | "at" | "tries">) => void): Promise<Reply> {
    const since = new Date().toISOString();
    const input = withRevit ? { ...args, revit: String(revit.pid) } : args;
    const child = spawn(process.execPath, [CLI, tool], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, FMC_TESTRUN: s.run } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    child.stdin.end(JSON.stringify(input));
    const exited = new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
    const deadline = Date.now() + timeoutMs;
    let stop: string | null = null;
    let restartRevit = false;
    let reply: Reply | null = null;
    while (!reply) {
      const code = await Promise.race([exited, sleep(15000).then(() => null)]);
      if (code !== null) {
        if (stop) reply = { exit: 1, body: { error: stop } };
        else {
          try { reply = { exit: code, body: JSON.parse(out.trim() || "{}") }; }
          catch { reply = { exit: code || 1, body: { error: `The CLI's answer isn't JSON: ${out.slice(0, 500)}`, stderr: err.slice(-1000) } }; }
        }
        break;
      }
      if (stop) continue;
      if (withRevit && !revit.isOurs()) {
        stop = "[runner] Revit closed or crashed during the step";
        add({ step: name, kind: "revit", expected: "Revit stays open", got: "the runner's Revit process ended during the step" });
        killTree(child.pid ?? 0);
        continue;
      }
      const dialogs = withRevit ? revit.waitingDialogs(since) : [];
      if (dialogs.length) {
        const d = dialogs[0];
        stop = `[runner] Revit showed a dialog that no rule answers: ${d.dialog_id} "${d.message}"`;
        revit.requestCancel([...new Set(dialogs.map((x) => x.job).filter(Boolean))]);
        restartRevit = true;
        log(`${name}: dialog ${d.dialog_id}; cancel requested, the step stops`);
        // give Revit two minutes to stop the job; the dialog itself stays for a person, so the Revit is replaced after
        const done = await Promise.race([exited, sleep(120000).then(() => null)]);
        if (done === null) killTree(child.pid ?? 0);
        continue;
      }
      if (Date.now() > deadline) {
        stop = `[runner] No answer within ${Math.round(timeoutMs / 1000)} s`;
        add({ step: name, kind: "timeout", expected: `an answer within ${Math.round(timeoutMs / 1000)} s`, got: "no answer: the step was stopped and Revit asked to cancel it" });
        if (withRevit) { revit.requestCancel(revit.jobsSince(since)); restartRevit = true; }
        killTree(child.pid ?? 0);
      }
    }
    // a dialog left for a person, or a job that wouldn't stop: this Revit is replaced before the next action
    if (restartRevit) await revit.close();
    return reply;
  }

  /** PNGs a reply names (screenshots, pictures) copied into the run's folder. */
  function collectPngs(body: unknown, prefix: string): string[] {
    const found = new Set<string>();
    const walk = (v: unknown, depth: number) => {
      if (depth > 8) return;
      if (typeof v === "string") { if (/\.png$/i.test(v) && win.isAbsolute(v) && fs.existsSync(v)) found.add(v); return; }
      if (Array.isArray(v)) { for (const x of v.slice(0, 200)) walk(x, depth + 1); return; }
      if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
    };
    walk(body, 0);
    const out: string[] = [];
    const dir = path.join(results, "png");
    for (const f of found) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const to = path.join(dir, `${prefix}-${path.basename(f)}`);
        fs.copyFileSync(f, to);
        out.push(to);
      } catch { /* the picture stays where the tool put it */ }
    }
    return out;
  }
}

function clip(body: unknown, max = 200000): unknown {
  const text = JSON.stringify(body ?? null);
  return text.length <= max ? body : { clipped: true, chars: text.length, start: text.slice(0, max) };
}

/** The status of a run for the tool: counts, where it is, whether a runner is alive, pauses and gaps. */
export function runStatus(s: RunState) {
  const lock = readLock();
  const live = lock?.run === s.run && processAlive(lock.pid) && Date.now() - Date.parse(lock.beat) <= GAP_MS;
  const current = s.order.find((id) => s.scenarios[id].status === "running");
  const c = { passed: 0, failed: 0, skipped: 0, pending: 0, running: 0 };
  for (const id of s.order) c[s.scenarios[id].status]++;
  const pause = s.pauses[s.pauses.length - 1];
  return {
    run: s.run, status: s.status, runner: live ? { pid: lock!.pid, heartbeat: lock!.beat } : null,
    ...c, current: current ? { scenario: current, step: s.scenarios[current].step } : null,
    paused: pause && !pause.to ? pause : null, revit: s.revit ?? null, gaps: s.gaps.length, findings: s.findings.length,
    results: s.results_dir, scenarios: s.order.map((id) => ({ id, ...s.scenarios[id] })),
  };
}

