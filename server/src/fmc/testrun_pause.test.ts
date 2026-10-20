// F75: the unattended runner's pause and resume paths, end to end: the real runner (node build/fmc/cli.js fmc_testrun,
// foreground) with the stand-in Revit (tests/e2e/fake_revit.mjs) as its "own Revit", a power state from a file instead
// of Windows', and a simulated sleep (the process ends mid-scenario). Everything lives in a temp folder: its own
// APPDATA (checkpoint, instance registry), guard file and reports. No real Revit, no %APPDATA%\Formcraft.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, ChildProcess } from "node:child_process";
import { powerDecision, powerOverride } from "./testrun.js";
import { powerOverrideWord } from "./testrun_runner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.js");
const REPO = path.resolve(HERE, "..", "..", "..");
const FAKE = path.join(REPO, "tests", "e2e", "fake_revit.mjs");

interface Bench {
  root: string; appdata: string; home: string; scenarios: string; power: string; calls: string; reports: string;
  env: NodeJS.ProcessEnv;
}

/** A temp world for one test: guard, kit folders, checkpoint home, scenarios, the power file and the fake's call log. */
function bench(name: string, config: Record<string, unknown>, scenarios: Record<string, unknown>[]): Bench {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `fmc-testrun-${name}-`));
  const appdata = path.join(root, "appdata");
  const home = path.join(appdata, "Formcraft", "testrun");
  const kit = path.join(root, "kit");
  const reports = path.join(root, "reports");
  const dir = path.join(root, "scenarios");
  for (const d of [home, path.join(kit, "04_Families", "_Staging"), reports, dir]) fs.mkdirSync(d, { recursive: true });
  const guard = path.join(root, "fmc_guard.json");
  fs.writeFileSync(guard, JSON.stringify({ family_staging_root: path.join(kit, "04_Families", "_Staging"), reports_dir: reports, write_roots: [], template_roots: [] }));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ revit_exe: path.join(root, "no-revit-here", "Revit.exe"), revit_start_timeout_s: 60, ...config }));
  for (const s of scenarios) fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify({ schema: "fmc-testrun/0.1", title: String(s.id), setup: [], teardown: [], ...s }));
  const power = path.join(root, "power.txt");
  const calls = path.join(root, "calls.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...process.env, APPDATA: appdata, FMC_GUARD_CONFIG: guard, FMC_TESTRUN_SCENARIOS: dir,
    FMC_TESTRUN_REVIT_STANDIN: FAKE, FAKE_LOG: calls, FMC_TESTRUN_POWER_FILE: power, FMC_TESTRUN_POLL_MS: "150",
  };
  delete env.FMC_TESTRUN_POWER; delete env.FMC_TESTRUN_STOP_AFTER_STEPS; delete env.REVIT_PORT;
  return { root, appdata, home, scenarios: dir, power, calls, reports, env };
}

/** The runner in the foreground, as fmc-testrun.ps1 starts it (the same JSON on stdin). */
function runner(b: Bench, input: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [CLI, "fmc_testrun"], { env: { ...b.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "", err = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { err = (err + d).slice(-20000); });
  child.stdin!.end(JSON.stringify({ foreground: true, scenarios_dir: b.scenarios, ...input }));
  const done = new Promise<{ code: number; body: any; err: string }>((resolve) => child.on("close", (code) => {
    let body: any = null;
    try { body = JSON.parse(out.trim() || "null"); } catch { body = { unparsed: out }; }
    resolve({ code: code ?? -1, body, err });
  }));
  return { child, done };
}

const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const runnerLog = (b: Bench) => read(path.join(b.home, "runner.log"));
const calls = (b: Bench): Array<{ method: string; params: any }> => read(b.calls).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const tags = (b: Bench) => calls(b).map((c) => c.params?.tag).filter(Boolean);
const lastState = (b: Bench) => {
  const last = JSON.parse(read(path.join(b.home, "last.json")));
  return JSON.parse(read(path.join(b.home, `${last.run}.json`)));
};
const instances = (b: Bench) => { try { return fs.readdirSync(path.join(b.appdata, "Formcraft", "instances")).filter((f) => f.endsWith(".json")); } catch { return []; } };

async function until(what: string, ok: () => boolean, ms = 60000, child?: ChildProcess) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    if (child && child.exitCode !== null) throw new Error(`the runner ended (exit ${child.exitCode}) before: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ends any stand-in Revit a test left (a simulated sleep leaves it open, like Revit after a real sleep) and the folder. */
function cleanup(b: Bench) {
  for (const f of instances(b)) {
    try { process.kill(JSON.parse(read(path.join(b.appdata, "Formcraft", "instances", f))).pid); } catch { /* gone */ }
  }
  try { fs.rmSync(b.root, { recursive: true, force: true }); } catch { /* a file still held: the OS's temp clean-up */ }
}

const doc = (tag: string, extra: Record<string, unknown> = {}) => ({ id: tag, revit: "fmc_document_info", params: { tag }, ...extra });

test("F75: the power override is test-only and exact: a known word, the file before the variable, else the real reading", () => {
  assert.deepEqual(powerDecision(powerOverride("saver")!, { pause_on_battery: false }).pause, true);
  assert.deepEqual(powerDecision(powerOverride("battery")!, { pause_on_battery: true }).pause, true);
  assert.deepEqual(powerDecision(powerOverride("battery")!, { pause_on_battery: false }).pause, false);
  assert.deepEqual(powerDecision(powerOverride("ac")!, { pause_on_battery: true }).pause, false);
  assert.equal(powerOverride("unknown"), null);
  assert.equal(powerOverride("plugged in"), undefined, "an unknown word is no override");
  assert.equal(powerOverride(undefined), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmc-power-"));
  const file = path.join(dir, "power.txt");
  assert.equal(powerOverrideWord({}), undefined, "nothing set: the real reading");
  assert.equal(powerOverrideWord({ FMC_TESTRUN_POWER: " Battery " }), "battery");
  assert.equal(powerOverrideWord({ FMC_TESTRUN_POWER: "ac", FMC_TESTRUN_POWER_FILE: file }), "ac", "no file yet: the variable");
  fs.writeFileSync(file, "saver\r\n");
  assert.equal(powerOverrideWord({ FMC_TESTRUN_POWER: "ac", FMC_TESTRUN_POWER_FILE: file }), "saver", "the file wins");
  fs.writeFileSync(file, "nonsense");
  assert.equal(powerOverrideWord({ FMC_TESTRUN_POWER_FILE: file }), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("F75: on battery mid-run (pause_on_battery on) the runner pauses before the next Revit step, then carries on on mains", async () => {
  const b = bench("battery", { pause_on_battery: true }, [
    { id: "p1", steps: [doc("a"), { id: "slow", revit: "fmc_element_facts", params: { tag: "slow" } }, doc("c")] },
  ]);
  try {
    fs.writeFileSync(b.power, "ac");
    const r = runner(b, { action: "run" }, { FAKE_DELAY: "fmc_element_facts:2000" });
    // the slow step has reached Revit: unplug while it runs
    await until("the slow step reaches Revit", () => tags(b).includes("slow"), 60000, r.child);
    fs.writeFileSync(b.power, "battery");
    await until("runner.log says paused", () => /Paused: on battery/.test(runnerLog(b)), 30000, r.child);
    const paused = lastState(b);
    assert.equal(paused.status, "paused", "the checkpoint says paused");
    assert.equal(paused.pauses.length, 1);
    assert.match(paused.pauses[0].reason, /on battery/);
    assert.equal(paused.pauses[0].to, undefined, "the pause is open");
    assert.equal(paused.scenarios.p1.step, "steps: slow", "the step that was running finished; the next didn't start");
    await pause(1500);
    assert.deepEqual(tags(b), ["a", "slow"], "nothing more is sent to Revit while paused");
    fs.writeFileSync(b.power, "ac");
    const end = await r.done;
    assert.equal(end.code, 0, end.err);
    assert.equal(end.body.ran, true);
    assert.equal(end.body.passed, 1);
    assert.deepEqual(tags(b), ["a", "slow", "c"], "each step once, the rest after the pause");
    assert.match(runnerLog(b), /Resumed: on mains power/);
    const s = lastState(b);
    assert.equal(s.status, "done");
    assert.equal(s.pauses.length, 1);
    assert.ok(s.pauses[0].to, "the pause is closed");
    assert.match(read(path.join(s.results_dir, "summary.md")), /## Pauses[\s\S]*on battery/);
  } finally { cleanup(b); }
});

test("F75: pause_on_battery off: battery saver still pauses (no Revit started), battery power alone doesn't", async () => {
  const b = bench("saver", { pause_on_battery: false }, [{ id: "q1", steps: [doc("q")] }]);
  try {
    fs.writeFileSync(b.power, "saver");
    const r = runner(b, { action: "run" });
    await until("runner.log says paused", () => /Paused: battery saver/.test(runnerLog(b)), 30000, r.child);
    await pause(1000);
    const paused = lastState(b);
    assert.equal(paused.status, "paused");
    assert.equal(paused.revit, undefined, "no Revit started while paused");
    assert.deepEqual(instances(b), [], "no Revit registered");
    assert.deepEqual(calls(b), [], "nothing sent");
    assert.equal(paused.scenarios.q1.status, "pending", "the scenario waits, not started");
    // battery saver off, still on battery: with pause_on_battery off that runs
    fs.writeFileSync(b.power, "battery");
    const end = await r.done;
    assert.equal(end.code, 0, end.err);
    assert.equal(end.body.passed, 1);
    assert.deepEqual(tags(b), ["q"]);
    assert.match(runnerLog(b), /Resumed: power fine/);
    assert.equal(lastState(b).pauses.length, 1, "one pause, for battery saver only");
  } finally { cleanup(b); }
});

test("F75: a run stopped mid-scenario (simulated sleep) is resumed by Mode auto: done ones stay done, the cut-off one restarts from its setup, findings once", async () => {
  const b = bench("sleep", { pause_on_battery: true }, [
    { id: "a_pass", steps: [doc("a")] },
    { id: "b_fail", setup: [doc("b_setup")], steps: [doc("b_step", { checks: [{ path: "active.title", equals: "Nope" }] })], teardown: [doc("b_teardown")] },
    { id: "c_last", steps: [doc("c")] },
  ]);
  try {
    fs.writeFileSync(b.power, "ac");
    // actions: a, b's setup, b's (failing) step; the PC "sleeps" as b's teardown is about to run
    const first = await runner(b, { action: "run" }, { FMC_TESTRUN_STOP_AFTER_STEPS: "3" }).done;
    assert.equal(first.code, 75, `the runner stopped as if the PC slept: ${first.err.slice(-2000)}`);
    assert.deepEqual(tags(b), ["a", "b_setup", "b_step"]);
    const cut = lastState(b);
    assert.equal(cut.status, "running", "the checkpoint is left as it was");
    assert.equal(cut.scenarios.a_pass.status, "passed");
    assert.equal(cut.scenarios.b_fail.status, "running");
    assert.equal(cut.scenarios.c_last.status, "pending");
    assert.equal(cut.findings.length, 1, "the cut-off try's finding is in the checkpoint");
    assert.ok(fs.existsSync(path.join(b.home, "runner.lock")), "the lock is left behind, as after a real sleep");

    // the scheduled start, Mode auto (fmc-testrun.ps1 sends resume + auto)
    const second = await runner(b, { action: "resume", auto: true }).done;
    assert.equal(second.code, 0, second.err);
    assert.equal(second.body.ran, true, JSON.stringify(second.body));
    const s = lastState(b);
    assert.equal(s.run, cut.run, "the same run, not a new one");
    assert.equal(s.status, "done");
    const t = tags(b);
    assert.equal(t.filter((x) => x === "a").length, 1, "the passed scenario isn't run again");
    assert.equal(t.filter((x) => x === "c").length, 1);
    // b: setup and step on the cut-off try, then from its setup again; it fails, so once more (an interruption isn't a try)
    assert.equal(t.filter((x) => x === "b_setup").length, 3, "the cut-off scenario restarts from its setup");
    assert.equal(t.filter((x) => x === "b_teardown").length, 2);
    assert.deepEqual([s.scenarios.b_fail.status, s.scenarios.b_fail.tries, s.scenarios.b_fail.interruptions], ["failed", 2, 1]);
    assert.deepEqual([s.scenarios.a_pass.status, s.scenarios.c_last.status], ["passed", "passed"]);
    // one finding for b's failure, on its two counted tries (attempts 2 and 3); the cut-off attempt 1 isn't one
    assert.equal(s.findings.length, 1, JSON.stringify(s.findings));
    assert.deepEqual(s.findings[0].tries, [2, 3], "the interrupted try's finding is dropped, as when the runner sees the sleep itself");
    const md = read(path.join(s.results_dir, "summary.md"));
    // the scenario table names each with its title ("| b_fail (b_fail) |"); the findings table names it bare
    for (const id of ["a_pass", "b_fail", "c_last"]) assert.equal(md.split("\n").filter((l) => l.startsWith(`| ${id} (${id}) |`)).length, 1, `${id} once in the summary`);
    assert.equal(md.split("\n").filter((l) => l.startsWith("| b_fail | ")).length, 1, "its finding once");
    assert.match(md, /2 passed, 1 failed, 0 skipped\./);
    assert.match(md, /## Findings \(1\)/);
    const findings = JSON.parse(read(path.join(s.results_dir, "findings.json")));
    assert.equal(findings.findings.length, 1);
    assert.equal(findings.drafts.length, 1);
    assert.equal(fs.existsSync(path.join(b.home, "runner.lock")), false, "the lock is released at the end");
    assert.equal(instances(b).length, 1, "the runner's Revit, still open after the sleep, is used again (known by pid and start time), not a second one");
    // its registry entry stays (the process is ended, as the runner ends Revit, with no clean-up); the process is gone
    for (const f of instances(b)) assert.equal(alive(JSON.parse(read(path.join(b.appdata, "Formcraft", "instances", f))).pid), false, "the runner's (stand-in) Revit is closed at the end");
    assert.equal(s.revit, undefined);

    // Mode auto again, minutes later: the last run ended under new_run_after_hours ago, so nothing new starts
    const runsBefore = fs.readdirSync(b.home).filter((f) => /^TR-.*\.json$/.test(f));
    const callsBefore = calls(b).length;
    const third = await runner(b, { action: "resume", auto: true }).done;
    assert.equal(third.code, 0, third.err);
    assert.equal(third.body.ran, false);
    assert.match(third.body.reason, /finished .* h ago \(a new one after 20 h\)/);
    assert.deepEqual(fs.readdirSync(b.home).filter((f) => /^TR-.*\.json$/.test(f)), runsBefore, "no new run");
    assert.equal(calls(b).length, callsBefore, "no Revit call");
    // Mode resume on a finished run: refused, nothing run
    const fourth = await runner(b, { action: "resume" }).done;
    assert.equal(fourth.body.ran, false);
    assert.match(fourth.body.reason, /is finished/);
  } finally { cleanup(b); }
});
