import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WRITE_COMMANDS } from "./policy.js";
import {
  CLI_TOOLS, GAP_MS, MAX_INTERRUPTIONS, addFinding, READ_ONLY_REVIT, RunState, autoDecision, evalCheck, finishScenario, findingDrafts, getPath,
  interruptScenario, lockVerdict, newRun, nextScenario, parsePowerLine, parseScenario, powerDecision, resumeRun, skipReason,
  sleptBetween, startScenario, stepChecks, substitute, summaryMarkdown,
} from "./testrun.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "..", "src");
const SCENARIOS = path.resolve(HERE, "..", "..", "..", "tests", "revit");

const good = (over: Record<string, unknown> = {}) => JSON.stringify({
  schema: "fmc-testrun/0.1", id: "x_1", title: "A scenario",
  setup: [{ id: "new", tool: "fmc_file", args: { action: "list_open" } }, { runner: "open_in_revit", path: "{{scratch}}\\a.rvt" }],
  steps: [{ id: "facts", revit: "fmc_element_facts", params: { unique_ids: "{{steps.new.ids}}" }, checks: [{ path: "elements", at_least: 1 }] }],
  teardown: [{ runner: "close_revit" }],
  ...over,
});

test("F75: a scenario parses; tools, Revit commands, ids and checks are checked", () => {
  assert.deepEqual(parseScenario(good(), CLI_TOOLS).problems, []);
  const bad = (over: Record<string, unknown>) => parseScenario(good(over), CLI_TOOLS).problems.join(" | ");
  assert.match(bad({ steps: [{ tool: "fmc_nope", args: {} }] }), /not a CLI tool/);
  assert.match(bad({ steps: [{ tool: "fmc_room", args: { revit: "8080" } }] }), /no "revit" argument/);
  assert.match(bad({ steps: [{ revit: "send_code_to_revit", params: {} }] }), /read-only Revit commands/);
  assert.match(bad({ steps: [{ tool: "fmc_room", revit: "fmc_design_options" }] }), /exactly one of/);
  assert.match(bad({ steps: [{ id: "new", tool: "fmc_room" }] }), /used twice/);
  assert.match(bad({ steps: [{ tool: "fmc_room", checks: [{ path: "a" }] }] }), /says what to expect/);
  assert.match(bad({ steps: [{ tool: "fmc_room", checks: [{ equals: 1 }] }] }), /path to check/);
  assert.match(bad({ steps: [{ tool: "fmc_room", bogus: 1 }] }), /unknown key "bogus"/);
  assert.match(bad({ revit: false }), /revit false can't use Revit actions/);
  assert.match(bad({ needs: ["autocad"] }), /needs/);
  assert.match(parseScenario("{nope", CLI_TOOLS).problems[0], /Not JSON/);
});

test("F75: the direct Revit commands are reads, never writes, and the CLI list matches cli.ts", () => {
  for (const c of READ_ONLY_REVIT) assert.ok(!WRITE_COMMANDS.has(c), c);
  const cli = fs.readFileSync(path.join(SRC, "fmc", "cli.ts"), "utf8");
  const cases = [...cli.matchAll(/case "(fmc_[a-z_]+)":/g)].map((m) => m[1]).filter((c) => c !== "fmc_testrun");
  assert.deepEqual([...cases].sort(), [...CLI_TOOLS].sort());
});

test("F75: every scenario in tests/revit parses, and its arguments are the tool's own (none invented)", async () => {
  const files = fs.readdirSync(SCENARIOS).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 10, "the first set of scenarios");
  for (const f of files) {
    const r = parseScenario(fs.readFileSync(path.join(SCENARIOS, f), "utf8"), CLI_TOOLS);
    assert.deepEqual(r.problems, [], f);
    assert.equal(r.scenario!.id, f.replace(/\.json$/, ""), `${f}: the id is the file name`);
    for (const a of [...r.scenario!.setup, ...r.scenario!.steps, ...r.scenario!.teardown]) {
      if (!a.tool) continue;
      const mod = await import(`../tools/${a.tool}.js`);
      const shapeName = Object.keys(mod).find((k) => /^FMC_[A-Z_]+_SHAPE$/.test(k));
      assert.ok(shapeName, `${a.tool} exports its shape`);
      const shape = mod[shapeName!] as Record<string, z.ZodTypeAny>;
      for (const k of Object.keys(a.args ?? {})) assert.ok(k in shape || k === "document", `${f}: ${a.tool} has no argument "${k}"`);
      const action = (a.args ?? {}).action;
      if (typeof action === "string" && shape.action) assert.ok(shape.action.safeParse(action).success, `${f}: ${a.tool} has no action "${action}"`);
    }
  }
});

test("F75: placeholders fill strings, keep a whole value's type, and refuse unknown names", () => {
  const vars = { run: "TR-1", attempt: 2, steps: { build: { record: "C:\\r.json", made: ["a", "b"] } } };
  assert.equal(substitute("{{run}}-{{attempt}}", vars), "TR-1-2");
  assert.deepEqual(substitute({ ids: "{{steps.build.made}}", f: ["{{steps.build.record}}"] }, vars), { ids: ["a", "b"], f: ["C:\\r.json"] });
  assert.equal(substitute("x {{steps.build.made}}", vars), 'x ["a","b"]');
  assert.throws(() => substitute("{{steps.gone.x}}", vars), /Unresolved \{\{steps.gone.x\}\}/);
  assert.equal(getPath({ a: [{ b: 3 }] }, "a.0.b"), 3);
  assert.equal(getPath({ a: [1, 2] }, "a.length"), 2);
  assert.equal(getPath({ a: null }, "a.b"), undefined);
});

test("F75: a path picks a list item by a key: [key=value] whole, [key^=value] by its start", () => {
  const gate = { lines: [{ check: "Keynote set", state: "Pass" }, { check: "Hosts as the register says", state: "Not checked" },
    { check: "Host test", state: "Pass", n: 3 }] };
  assert.equal(getPath(gate, "lines[check^=Hosts].state"), "Not checked");
  assert.equal(getPath(gate, "lines[check=Host test].state"), "Pass");
  assert.equal(getPath(gate, "lines[n=3].check"), "Host test", "a number key compares as text");
  assert.equal(getPath(gate, "lines[check=Host].state"), undefined, "= is the whole value");
  assert.equal(getPath(gate, "lines[check=Nothing].state"), undefined);
  assert.equal(getPath({ a: { b: 1 } }, "a[b=1]"), undefined, "a selector needs a list");
  assert.equal(getPath({ a: [{ b: [{ c: "x" }] }] }, "a.0.b[c=x].c"), "x");
  for (const bad of ["lines[check", "lines..state", "lines.", "lines[=x]"]) assert.equal(getPath(gate, bad), undefined, bad);
  const r = evalCheck({ path: "lines[check^=Hosts].state", equals: "Pass" }, { exit: 0, body: gate });
  assert.deepEqual([r.ok, r.expected, r.got], [false, 'lines[check^=Hosts].state = "Pass"', '"Not checked"']);
});

test("F75: checks on a reply: no error, an error, equals, at least, at most, contains, matches, exists", () => {
  const ok = { exit: 0, body: { done: true, made: 6, notes: [], elements: [1, 2, 3], text: "Ready to test", verdict: "Pass" } };
  const refused = { exit: 1, body: { refused: true, reasons: ["No"] } };
  assert.ok(evalCheck({ no_error: true }, ok).ok);
  assert.ok(!evalCheck({ no_error: true }, refused).ok);
  assert.ok(!evalCheck({ no_error: true }, { exit: 0, body: { error: "x" } }).ok, "an error in the body counts");
  assert.ok(evalCheck({ is_error: true }, refused).ok);
  assert.ok(evalCheck({ path: "verdict", equals: "Pass" }, ok).ok);
  const r = evalCheck({ path: "verdict", equals: "Fail" }, ok);
  assert.deepEqual([r.ok, r.expected, r.got], [false, 'verdict = "Fail"', '"Pass"']);
  assert.ok(evalCheck({ path: "made", at_least: 6 }, ok).ok);
  assert.ok(evalCheck({ path: "elements", at_least: 3 }, ok).ok, "a list counts its items");
  assert.ok(evalCheck({ path: "notes", at_most: 0 }, ok).ok);
  assert.ok(!evalCheck({ path: "missing", at_least: 0 }, ok).ok, "a missing value never passes a size check");
  assert.ok(evalCheck({ path: "text", contains: "Ready" }, ok).ok);
  assert.ok(evalCheck({ path: "elements", contains: 2 }, ok).ok);
  assert.ok(evalCheck({ path: "text", matches: "^Ready" }, ok).ok);
  assert.ok(evalCheck({ path: "done", exists: true }, ok).ok && evalCheck({ path: "gone", exists: false }, ok).ok);
  assert.deepEqual(stepChecks({ tool: "fmc_file" }), [{ no_error: true }], "no checks: no error");
  assert.deepEqual(stepChecks({ tool: "fmc_file", expect_error: true }), [{ is_error: true }]);
});

test("F75: power: battery saver always pauses, battery power when set, unknown never", () => {
  assert.deepEqual(parsePowerLine("1 1 100 0"), { ac: 1, battery_flag: 1, percent: 100, system_status_flag: 0 });
  assert.equal(parsePowerLine("#< CLIXML"), null);
  const on = { pause_on_battery: true }, off = { pause_on_battery: false };
  assert.equal(powerDecision(parsePowerLine("1 1 100 1"), on).pause, true, "saver on, even on mains");
  assert.match(powerDecision(parsePowerLine("1 1 100 1"), off).reason, /battery saver/);
  assert.equal(powerDecision(parsePowerLine("0 0 80 0"), on).pause, true);
  assert.match(powerDecision(parsePowerLine("0 0 80 0"), on).reason, /on battery \(80%\)/);
  assert.equal(powerDecision(parsePowerLine("0 0 80 0"), off).pause, false);
  assert.equal(powerDecision(parsePowerLine("1 128 255 0"), on).pause, false, "a desktop with no battery runs");
  assert.equal(powerDecision(parsePowerLine("255 255 255 0"), on).pause, false, "unknown AC runs");
  assert.equal(powerDecision(null, on).pause, false);
});

const T0 = new Date("2026-10-19T20:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60000);
const run = () => newRun("TR-20261019-2300", ["a", "b", "c"], { scenarios_dir: "d", results_dir: "r" }, T0);

test("F75: the checkpoint: in order, a failure runs once more, then it is failed", () => {
  const s = run();
  assert.equal(nextScenario(s), "a");
  startScenario(s, "a", at(1));
  finishScenario(s, "a", "passed", "", at(2));
  assert.equal(nextScenario(s), "b");
  startScenario(s, "b", at(3));
  finishScenario(s, "b", "failed", "build: expected done", at(4));
  assert.equal(s.scenarios.b.status, "pending");
  assert.match(s.scenarios.b.reason!, /runs once more/);
  assert.equal(nextScenario(s), "b", "retried at once, from its setup");
  startScenario(s, "b", at(5));
  finishScenario(s, "b", "failed", "build: expected done", at(6));
  assert.equal(s.scenarios.b.status, "failed");
  assert.equal(s.scenarios.b.tries, 2);
  finishScenario(s, "c", "skipped", "needs navisworks, which isn't open", at(7));
  assert.equal(nextScenario(s), null);
});

test("F75: an interruption runs the scenario again without using its retry; too many fail it", () => {
  const s = run();
  startScenario(s, "a", at(1));
  interruptScenario(s, "a", "slept", at(2));
  assert.deepEqual([s.scenarios.a.status, s.scenarios.a.tries, s.scenarios.a.interruptions], ["pending", 0, 1]);
  for (let i = 1; i <= MAX_INTERRUPTIONS; i++) { startScenario(s, "a", at(2 + i)); interruptScenario(s, "a", "slept", at(3 + i)); }
  assert.equal(s.scenarios.a.status, "failed");
  assert.match(s.scenarios.a.reason!, /interrupted 4 times/);
});

test("F75: resume after sleep or shutdown: passed stay passed, the running one starts again, the gap is kept", () => {
  const s = run();
  startScenario(s, "a", at(1)); finishScenario(s, "a", "passed", "", at(2));
  startScenario(s, "b", at(3));
  s.pauses.push({ from: at(3).toISOString(), reason: "on battery (40%)" });
  const r = resumeRun(JSON.parse(JSON.stringify(s)) as RunState, at(4).toISOString(), at(4 + 9 * 60));
  assert.equal(r.scenarios.a.status, "passed");
  assert.equal(r.scenarios.b.status, "pending");
  assert.equal(r.scenarios.b.interruptions, 1);
  assert.equal(nextScenario(r), "b");
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].seconds, 9 * 3600);
  assert.ok(r.pauses[0].to, "an open pause is closed");
  assert.equal(resumeRun(JSON.parse(JSON.stringify(s)) as RunState, at(4).toISOString(), at(5)).gaps.length, 0, "a short stop isn't a gap");
});

test("F75: resume drops the findings of the try that was cut off (the process ended), keeps earlier tries' and other scenarios'", () => {
  const s = run();
  const f = (scenario: string, got: string) => ({ run: s.run, scenario, step: "steps: x", kind: "check" as const, expected: "= 1", got, at: at(1).toISOString() });
  startScenario(s, "a", at(1)); addFinding(s, f("a", "2"), 1); finishScenario(s, "a", "failed", "x", at(2));
  startScenario(s, "b", at(2)); addFinding(s, f("b", "3"), 1); finishScenario(s, "b", "failed", "x", at(3));
  // b's second try (attempt 2) finds the same and another thing, then the PC sleeps and the runner is gone
  startScenario(s, "b", at(3)); addFinding(s, f("b", "3"), 2); addFinding(s, f("b", "4"), 2);
  const r = resumeRun(JSON.parse(JSON.stringify(s)) as RunState, at(4).toISOString(), at(5));
  assert.deepEqual(r.findings.map((x) => [x.scenario, x.got, x.tries]), [["a", "2", [1]], ["b", "3", [1]]]);
  assert.deepEqual([r.scenarios.b.status, r.scenarios.b.tries, r.scenarios.b.interruptions], ["pending", 1, 1]);
});

test("F75: a jump in the clock is sleep; another live runner holds the lock; a stale one doesn't", () => {
  assert.ok(sleptBetween(0, GAP_MS + 1));
  assert.ok(!sleptBetween(0, 30000));
  const alive = (pid: number) => pid === 42;
  assert.equal(lockVerdict(null, alive, T0, 1), "free");
  assert.equal(lockVerdict({ pid: 42, beat: at(-1).toISOString() }, alive, T0, 1), "busy");
  assert.equal(lockVerdict({ pid: 42, beat: at(-10).toISOString() }, alive, T0, 1), "stale", "no heartbeat for 10 minutes: the PC slept");
  assert.equal(lockVerdict({ pid: 7, beat: at(-1).toISOString() }, alive, T0, 1), "stale", "the process is gone");
  assert.equal(lockVerdict({ pid: 1, beat: at(-1).toISOString() }, alive, T0, 1), "free", "its own lock");
});

test("F75: the scheduled start resumes, starts a new run after a while, or does nothing", () => {
  assert.equal(autoDecision(null, T0, 20).action, "new");
  const s = run();
  assert.equal(autoDecision(s, T0, 20).action, "resume");
  s.status = "done"; s.finished = at(-60).toISOString();
  assert.equal(autoDecision(s, T0, 20).action, "nothing");
  s.finished = at(-21 * 60).toISOString();
  assert.equal(autoDecision(s, T0, 20).action, "new");
});

test("F75: skips, the summary and the findings drafts", () => {
  assert.equal(skipReason({ skip: "not on main" }, () => true), "not on main");
  assert.equal(skipReason({ needs: ["navisworks", "rhino"] }, (a) => a === "rhino"), "needs navisworks, which isn't open");
  assert.equal(skipReason({ needs: ["robot"] }, () => true), "");
  const s = run();
  startScenario(s, "a", at(1)); finishScenario(s, "a", "passed", "", at(2));
  s.findings.push({ run: s.run, scenario: "b", step: "steps: build", kind: "check", expected: "made at least 6", got: "4", at: at(3).toISOString(), tries: [1] });
  addFinding(s, { run: s.run, scenario: "b", step: "steps: build", kind: "check", expected: "made at least 6", got: "4", at: at(5).toISOString() }, 2);
  addFinding(s, { run: s.run, scenario: "b", step: "steps: build", kind: "check", expected: "made at least 6", got: "5", at: at(5).toISOString() }, 2);
  assert.equal(s.findings.length, 2, "the same failure on the retry is one finding; a different one is its own");
  assert.deepEqual(s.findings[0].tries, [1, 2]);
  const md = summaryMarkdown(s, { a: "Self-test" });
  assert.match(md, /\| a \(Self-test\) \| passed \|/);
  assert.match(md, /\| b \| steps: build \| check \| made at least 6 \| 4 \| 1, 2 \|/);
  assert.match(md, /never posts/);
  assert.match(findingDrafts(s)[0].title, /Unattended test b: steps: build/);
});
